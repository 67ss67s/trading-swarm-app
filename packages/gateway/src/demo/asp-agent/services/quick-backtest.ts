/**
 * 「策略研究报告 · 快速回测」档:买方用一句话(或 JSON / 完整 StrategyIR)描述一个交易想法,
 * 我们把它映射成研究引擎的 StrategyIR,在单个资产上跑一次**带手续费/滑点的全窗口回测**,另以 2 倍手续费再跑一次做压力。
 *
 * 映射(确定性优先,零模型):
 *   文本 → 已知策略族(突破 / 均线交叉 / 均线趋势 / 回踩 / 均值回归 / SMC,与 batch/families.ts 同一套原语与订单块口径)+ 参数
 *   (回看根数、均线周期、RSI 阈值、ATR/百分比止损、R/百分比止盈、吊灯追踪、持仓上限)。
 *   JSON 里直接给 `strategy_ir` 的,只做 checkIR 校验后原样执行。
 *   族都认不出、且服务开了 nl_compile 时,才走注入的 `compile(text, timeframe)`(真实实现 = research/strategy.ts compileStrategy +
 *   brainForRole('research'),每次调用 1–3 次模型;测试里用桩)。没开 nl_compile 就在接单前拒单退款。
 * 执行:与全窗口回测报告同一执行核(backtest-report.ts 的 assetExecutorFor:带 order 块走订单周期执行核)与同一费用口径
 *   (现货 taker 0.1% + 5bps 滑点;永续 taker 0.05% / maker 0.02%),每笔 100% 可用资金、现货不加杠杆。
 *   不走 runBacktestReport:那条路会把结果落 research_backtests 并广播给策略对象监听器,买方的想法会被挂成我们库里的新策略。
 * 统计:analyzer.analyze(收益/夏普/回撤/胜率/笔数/持有基准)+ 按年收益 + 70/30 样本内外分段 + 2 倍费率压力。
 */
import type { ResearchBar, ResearchDataset, StrategyIR, StrategyPrimitive } from '@trading-swarm/contracts';
import { assetExecutorFor, tradingRange, WARMUP_BARS, type AssetPerpInput, type AssetRunOutput, type LoadedBars } from '../../research/backtest-report.js';
import { executionFor } from '../../research/improve/evaluate.js';
import { analyze, periodReturns, type ClosedTrade, type EquitySample } from '../../research/analyzer.js';
import { orderGateFor } from '../../research/order-gate.js';
import { checkIR, irHistoryBars, irWarmup, node, timeframeMillis } from '../../research/strategy.js';
import { hash } from '../../research/primitives.js';
import { freeText, jsonParams, normSymbol, positive, sideIn, symbolsIn, timeframeIn } from './params.js';
import { num, pct } from './render.js';
import { BANNED_WORDS } from '../publisher.js';
import { ServiceInputError, type PerCallJob, type ServiceDeps } from './types.js';

export const QUICK_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
export type QuickTimeframe = typeof QUICK_TIMEFRAMES[number];
/** 缺省回看天数(与 backtest-report DEFAULT_DAYS 同档)与上限(控制单次墙钟与取数量) */
export const QUICK_DEFAULT_DAYS: Record<QuickTimeframe, number> = { '15m': 180, '1h': 730, '4h': 2190, '1d': 3000 };
export const QUICK_MAX_DAYS: Record<QuickTimeframe, number> = { '15m': 365, '1h': 1095, '4h': 2190, '1d': 3000 };
export const QUICK_MIN_DAYS = 30;
export const STRESS_FEE_MULTIPLE = 2;
export const IN_SAMPLE_FRACTION = 0.7;
const PERP_TAKER = 0.0005, PERP_MAKER = 0.0002;

export type QuickFamily = 'breakout' | 'ema_cross' | 'ma_trend' | 'pullback' | 'mean_reversion' | 'smc';
export const QUICK_FAMILY_LABEL: Record<QuickFamily, string> = { breakout: '通道突破 breakout', ema_cross: '均线交叉 EMA cross', ma_trend: '均线趋势 MA trend', pullback: '回踩均线 pullback', mean_reversion: '均值回归 mean reversion', smc: 'SMC 结构突破' };
export type StopSpec = { kind: 'atr'; multiple: number } | { kind: 'pct'; pct: number } | { kind: 'none' };
export type TargetSpec = { kind: 'r'; r: number } | { kind: 'pct'; pct: number } | { kind: 'none' };
export interface TemplateIdea {
  source: 'template';
  family: QuickFamily;
  /** 族参数:lookback / fast / slow / ema / rsi_period / rsi_level / bb */
  args: Record<string, number>;
  /** 买方明确给的风控;null = 用族缺省 */
  stop: StopSpec | null;
  target: TargetSpec | null;
  trail: { multiple: number } | null;
  max_hold: number | null;
}
export type QuickIdea = TemplateIdea | { source: 'ir'; ir: StrategyIR } | { source: 'text' };
export interface QuickBacktestParams {
  symbol: string;
  timeframe: QuickTimeframe;
  market: 'spot' | 'perp';
  side: 'long' | 'short';
  days: number;
  idea: QuickIdea;
  /** 买方原话(截断),text 路径编译用,也写进报告 */
  text: string;
  notes: string[];
}

/** 快速档额外依赖(运行时在 deps 组装处接上;见文件末 quickBacktestLoader) */
export interface QuickBacktestDeps extends ServiceDeps {
  /**
   * 全窗口已收盘 K 线(升序,含窗口前借来的预热)。现货:okxLoader;永续:okxPerpLoader(必须带 perp:标记价/资金费/分档)。
   * 测试注入合成行情。
   */
  backtestBars?(symbol: string, timeframe: string, window: { from_ms: number; to_ms: number }, market: 'spot' | 'perp'): Promise<LoadedBars>;
  /** 自然语言 → StrategyIR(模型编译)。没接就只能做确定性映射。 */
  compile?(text: string, timeframe: string): Promise<{ ir: StrategyIR | null; unmapped: string[]; model?: string | null; usd?: string | null }>;
}

// ---------------------------------------------------------------- 解析

/** 指标/结构缩写不是币:EMA20、RSI14、ATR、SMC、BOS、FVG… 先剔掉再找币名 */
export const NOT_COIN = /(?<![A-Za-z0-9])(?:EMA|SMA|MA|WMA|RSI|ATR|ADX|BB|BOLL|MACD|DC|KDJ|CCI|SMC|BOS|CHOCH|FVG|OB|HH|HL|LH|LL|TP|SL|RR|R|FULL|QUICK|MATRIX|REPORT|BACKTEST|IR)\d*(?![A-Za-z0-9])/g;
const FAMILY_TESTS: [QuickFamily, RegExp][] = [
  ['smc', /\bsmc\b|聪明钱|\bbos\b|choch|订单块|order[\s-]?blocks?|\bfvg\b|公允价值缺口|结构突破/i],
  ['mean_reversion', /均值回归|超卖|超买|mean[\s-]?revers|oversold|overbought|布林(?:带)?(?:下|上)轨|bollinger|rsi\s*[(（]?\s*\d{0,2}\s*[)）]?\s*(?:<|>|低于|高于|跌破|升破|小于|大于|below|above|under|over)/i],
  ['pullback', /回踩|回调|回撤到|pull[\s-]?back|\bdip\b|buy the dip/i],
  ['breakout', /突破|跌破.{0,6}(?:低点|最低|新低|通道)|breakout|break[\s-]?out|breakdown|唐奇安|donchian|海龟|turtle|新高|新低|\d+\s*(?:根|日|天|周期|bars?|periods?|-bar|-day)?\s*(?:k\s*线)?\s*(?:的)?\s*(?:高点|最高价?|低点|最低价?|highs?|lows?)/i],
  ['ma_trend', /均线(?:之上|上方|多头|空头|趋势)|趋势跟随|trend[\s-]?follow|ma[\s-]?trend|(?:站上|站稳|位于|在)\s*(?:ema|ma|sma)\s*\d+\s*(?:之上|上方)/i],
  ['ema_cross', /金叉|死叉|均线交叉|上穿|下穿|golden[\s-]?cross|death[\s-]?cross|\bcross(?:over)?\b|(?:ema|sma|ma)\s*\d+\s*(?:[/,，与和&xX×]|and)\s*(?:ema|sma|ma)?\s*\d+/i],
];
const FAMILY_KEYS = FAMILY_TESTS.map(([k]) => k);
const N = String.raw`(\d+(?:\.\d+)?)`;
const firstNum = (text: string, res: RegExp[]): number | null => {
  for (const re of res) { const m = re.exec(text); if (m) { const v = m.slice(1).find((x) => x !== undefined); const n = v === undefined ? null : Number(v); if (n !== null && Number.isFinite(n) && n > 0) return n; } }
  return null;
};
const intIn = (v: number | null, lo: number, hi: number, code: string, what: string): number | null => {
  if (v === null) return null;
  if (!Number.isInteger(v) || v < lo || v > hi) throw new ServiceInputError(code, `${what} 必须是 ${lo}–${hi} 的整数 / ${code}`);
  return v;
};

export function familyIn(text: string): QuickFamily | null {
  for (const [k, re] of FAMILY_TESTS) if (re.test(text)) return k;
  return null;
}

export function stopIn(text: string): StopSpec | null {
  if (/不设止损|不止损|无止损|不要止损|no[\s-]?stop(?:[\s-]?loss)?/i.test(text)) return { kind: 'none' };
  const atr = firstNum(text, [new RegExp(`${N}\\s*(?:倍|x|×)?\\s*atr\\s*(?:的)?\\s*(?:止损|stop|sl)`, 'i'), new RegExp(`(?:止损|stop(?:[\\s-]?loss)?|\\bsl\\b)[^,，。;；\\d]{0,8}${N}\\s*(?:倍|x|×)?\\s*atr`, 'i')]);
  if (atr !== null) { if (atr < 0.5 || atr > 10) throw new ServiceInputError('stop_invalid', 'ATR 止损倍数须在 0.5–10 / ATR stop multiple must be 0.5–10'); return { kind: 'atr', multiple: atr }; }
  const p = firstNum(text, [new RegExp(`(?:止损|stop(?:[\\s-]?loss)?|\\bsl\\b)[^,，。;；\\d]{0,8}${N}\\s*%`, 'i'), new RegExp(`${N}\\s*%\\s*(?:的)?\\s*(?:止损|stop)`, 'i')]);
  if (p !== null) { if (p < 0.2 || p > 30) throw new ServiceInputError('stop_invalid', '百分比止损须在 0.2%–30% / percent stop must be 0.2–30%'); return { kind: 'pct', pct: p / 100 }; }
  return null;
}
export function targetIn(text: string): TargetSpec | null {
  if (/不设止盈|不止盈|无止盈|不要止盈|no[\s-]?(?:take[\s-]?profit|target)/i.test(text)) return { kind: 'none' };
  const r = firstNum(text, [new RegExp(`${N}\\s*r(?![a-z])\\s*(?:的)?\\s*(?:止盈|目标|take|tp|target|exit)`, 'i'), new RegExp(`(?:止盈|目标|\\btp\\d?\\b|take[\\s-]?profit|target)[^,，。;；\\d%]{0,8}${N}\\s*r(?![a-z])`, 'i'), new RegExp(`(?:盈亏比|风险回报比|reward[\\s-]?to[\\s-]?risk|\\brr\\b)\\s*[:：=]?\\s*(?:1\\s*[:：]\\s*)?${N}`, 'i')]);
  if (r !== null) { if (r < 0.5 || r > 20) throw new ServiceInputError('target_invalid', 'R 止盈须在 0.5–20 / R target must be 0.5–20'); return { kind: 'r', r }; }
  const p = firstNum(text, [new RegExp(`(?:止盈|目标|\\btp\\d?\\b|take[\\s-]?profit|target)[^,，。;；\\d]{0,8}${N}\\s*%`, 'i'), new RegExp(`${N}\\s*%\\s*(?:的)?\\s*(?:止盈|take|target)`, 'i')]);
  if (p !== null) { if (p < 0.3 || p > 200) throw new ServiceInputError('target_invalid', '百分比止盈须在 0.3%–200% / percent target must be 0.3–200%'); return { kind: 'pct', pct: p / 100 }; }
  return null;
}
export function trailIn(text: string): { multiple: number } | null {
  if (/不(?:要|用|设|加)?\s*(?:追踪|跟踪|移动)止损|不(?:要|用|加)?\s*(?:吊灯|追踪|trail)/i.test(text)) return null;
  const m = /(?:吊灯|追踪止损|跟踪止损|移动止损|chandelier|trailing[\s-]?stop|trail)[^,，。;；\d]{0,8}(?:(\d+(?:\.\d+)?)\s*(?:倍|x|×)?\s*(?:atr)?)?/i.exec(text);
  if (!m) return null;
  const k = m[1] ? Number(m[1]) : 3;
  if (!(k >= 1 && k <= 10)) throw new ServiceInputError('trail_invalid', '追踪 ATR 倍数须在 1–10 / trailing ATR multiple must be 1–10');
  return { multiple: k };
}
function argsFor(family: QuickFamily, text: string, p: Record<string, unknown>): Record<string, number> {
  const given = (k: string) => (p[k] === undefined ? null : positive(p[k]));
  switch (family) {
    case 'breakout': {
      const look = given('lookback') ?? firstNum(text, [/(?:唐奇安|donchian|\bdc)\s*[(（]?\s*(\d{1,3})/i, /(\d{1,3})\s*(?:根|日|天|周期|bars?|periods?|-bar|-day)?\s*(?:k\s*线)?\s*(?:的)?\s*(?:高点|最高价?|低点|最低价?|highs?|lows?|通道|channel)/i, /(?:突破|跌破|breakout|breakdown)\s*(?:前|过去|最近|last|past)?\s*(\d{1,3})\s*(?:根|日|天|bars?|days?)/i]);
      return { lookback: intIn(look, 5, 300, 'lookback_invalid', '突破回看根数') ?? 20 };
    }
    case 'ema_cross': case 'ma_trend': {
      let fast = given('fast'), slow = given('slow');
      if (fast === null || slow === null) {
        const m = /(?:ema|sma|ma|均线)\s*(\d{1,3})\s*(?:[/,，与和&xX×-]|and|上穿|下穿|cross(?:es)?(?:\s+(?:above|below|over|under))?)\s*(?:ema|sma|ma|均线)?\s*(\d{1,3})/i.exec(text) ?? /(\d{1,3})\s*[/]\s*(\d{1,3})\s*(?:ema|sma|ma|均线)/i.exec(text);
        if (m) { fast = Number(m[1]); slow = Number(m[2]); }
      }
      if (fast !== null && slow !== null && fast > slow) [fast, slow] = [slow, fast];
      const f = intIn(fast, 2, 200, 'ma_invalid', '快均线周期') ?? 20, s = intIn(slow, 3, 400, 'ma_invalid', '慢均线周期') ?? (family === 'ema_cross' ? 50 : 100);
      if (f >= s) throw new ServiceInputError('ma_invalid', '快均线周期必须小于慢均线 / fast period must be below slow');
      return { fast: f, slow: s };
    }
    case 'pullback': {
      const ema = given('ema') ?? firstNum(text, [/(?:回踩|回调到?|回撤到|pull[\s-]?back\s*(?:to)?)\s*(?:ema|sma|ma|均线)?\s*(\d{1,3})/i]);
      return { ema: intIn(ema, 5, 200, 'ma_invalid', '回踩均线周期') ?? 20 };
    }
    case 'mean_reversion': {
      const m = /rsi\s*[(（]?\s*(\d{1,2})?\s*[)）]?\s*(?:<|>|低于|高于|跌破|升破|小于|大于|below|above|under|over)\s*(\d{1,2})/i.exec(text);
      const period = given('rsi_period') ?? (m?.[1] ? Number(m[1]) : null), level = given('rsi_level') ?? (m?.[2] ? Number(m[2]) : null);
      const bb = /布林|bollinger|\bbb\b/i.test(text) && !m ? 1 : 0;
      return { rsi_period: intIn(period, 2, 50, 'rsi_invalid', 'RSI 周期') ?? 14, rsi_level: intIn(level, 5, 95, 'rsi_invalid', 'RSI 阈值') ?? 0, bb };
    }
    case 'smc': return { swing: intIn(given('swing'), 2, 10, 'swing_invalid', '摆动点左右根数') ?? 3 };
  }
}

/** 接单前校验:解析 + 编译成 IR + checkIR,全部纯计算,不取数不花钱 */
export function validateQuick(job: PerCallJob, opts: { nl_compile?: boolean } = {}): QuickBacktestParams {
  const p = jsonParams(job) ?? {}, raw = freeText(job), text = raw.replace(/\s+/g, ' ').trim(), notes: string[] = [];
  // 币:JSON symbol/symbols 优先;文本里先剔掉指标缩写(EMA20 / RSI14 / SMC …)再找
  let symbol: string | null = null;
  const given = p['symbol'] ?? p['symbols'];
  if (given !== undefined && given !== null && given !== '') {
    const xs = Array.isArray(given) ? given : String(given).split(/[,，\s]+/).filter(Boolean);
    if (xs.length !== 1 || typeof xs[0] !== 'string') throw new ServiceInputError('symbols_too_many', '快速回测一次只测 1 个资产 / quick backtest takes exactly one symbol');
    symbol = normSymbol(xs[0]);
    if (!/^[A-Z0-9]{2,15}USDT$/.test(symbol)) throw new ServiceInputError('symbols_invalid', `无法识别的币名 / unknown symbol: ${xs[0]}`);
  } else {
    const found = symbolsIn(raw.replace(NOT_COIN, ' '), 3);
    if (found.length > 1) notes.push(`文本里出现多个资产(${found.join(', ')}),快速档只测第一个 ${found[0]} / only the first symbol is tested`);
    symbol = found[0] ?? null;
  }
  if (!symbol) throw new ServiceInputError('symbol_required', '请写明要回测的资产,例如 BTC / please name one asset, e.g. BTC');
  const timeframe = timeframeIn(p['timeframe'], raw, QUICK_TIMEFRAMES, '4h') as QuickTimeframe;
  // 方向与市场:做空只能在永续上做;明说现货又要做空 → 拒单
  const side = sideIn(p['side'], raw) ?? 'long';
  const pm = p['market'];
  if (pm !== undefined && pm !== null && pm !== '' && pm !== 'spot' && pm !== 'perp') throw new ServiceInputError('market_invalid', 'market 只能是 spot / perp');
  const wantsPerp = pm === 'perp' || (pm === undefined && /永续|合约|\bperp|\bswap\b|杠杆|leverage/i.test(raw));
  const wantsSpot = pm === 'spot' || (pm === undefined && /现货|\bspot\b/i.test(raw) && !wantsPerp);
  if (side === 'short' && wantsSpot) throw new ServiceInputError('sides_invalid', '现货不能做空 / spot cannot short');
  const market: 'spot' | 'perp' = side === 'short' || wantsPerp ? 'perp' : 'spot';
  // 窗口
  let days = p['days'] !== undefined ? positive(p['days']) : null;
  if (days === null) {
    const m = /(?:最近|过去|近|last|past)\s*(\d{1,4})\s*(天|日|个?月|年|days?|months?|years?)/i.exec(raw);
    if (m) days = Number(m[1]) * (/月|month/i.test(m[2]!) ? 30 : /年|year/i.test(m[2]!) ? 365 : 1);
  }
  if (days !== null && (!Number.isFinite(days) || days < QUICK_MIN_DAYS)) throw new ServiceInputError('days_invalid', `回测窗口至少 ${QUICK_MIN_DAYS} 天 / window must be ≥ ${QUICK_MIN_DAYS} days`);
  if (days !== null && days > QUICK_MAX_DAYS[timeframe]) { notes.push(`${timeframe} 回看上限 ${QUICK_MAX_DAYS[timeframe]} 天,已截到上限 / window capped`); days = QUICK_MAX_DAYS[timeframe]; }
  days = Math.round(days ?? QUICK_DEFAULT_DAYS[timeframe]);
  const base = { symbol, timeframe, market, side, days, text: text.slice(0, 600), notes };
  // 策略:完整 IR > JSON family > 文本族匹配 > 模型编译
  if (p['strategy_ir'] !== undefined) {
    const checked = checkIR(p['strategy_ir'], timeframe);
    if (!checked.ok || !checked.ir) throw new ServiceInputError('strategy_invalid', `strategy_ir 未通过检查 / invalid strategy_ir: ${checked.checks.filter((c) => !c.ok).map((c) => c.name).join(',')}`);
    const ir = checked.ir, irMarket = ir.order?.market ?? 'spot', irSide = ir.order?.direction === 'short' ? 'short' : 'long';
    if (ir.order?.direction === 'both') throw new ServiceInputError('sides_invalid', '快速回测不支持双向 IR / direction=both not supported');
    return { ...base, market: irMarket, side: irSide, idea: { source: 'ir', ir } };
  }
  let family: QuickFamily | null = null;
  if (p['family'] !== undefined) {
    if (!FAMILY_KEYS.includes(p['family'] as QuickFamily)) throw new ServiceInputError('family_invalid', `family 只能是 ${FAMILY_KEYS.join(' / ')}`);
    family = p['family'] as QuickFamily;
  } else family = familyIn(text);
  if (!family) {
    if (!opts.nl_compile) throw new ServiceInputError('strategy_unrecognized', `没认出策略类型;请写明入场规则(突破 N 根高点 / 均线交叉 / 回踩均线 / RSI 超卖均值回归 / SMC 结构突破)或直接给 strategy_ir / strategy not recognized: describe breakout, MA cross, pullback, RSI mean reversion or SMC, or pass strategy_ir`);
    return { ...base, idea: { source: 'text' } };
  }
  if (family === 'smc' && side === 'short') throw new ServiceInputError('sides_invalid', 'SMC 结构原语目前只有做多一侧 / SMC template is long-only');
  const idea: TemplateIdea = {
    source: 'template', family, args: argsFor(family, text, p), stop: stopIn(text), target: targetIn(text), trail: trailIn(text),
    max_hold: intIn(p['max_hold_bars'] !== undefined ? positive(p['max_hold_bars']) : firstNum(text, [/持(?:仓|有)\s*(?:不超过|最多|最长|上限)?\s*(\d{1,4})\s*根/, /max(?:imum)?[\s-]?hold(?:ing)?\s*(\d{1,4})\s*bars?/i]), 1, 2000, 'max_hold_invalid', '持仓上限根数'),
  };
  if (idea.stop?.kind === 'none' && side === 'short') throw new ServiceInputError('stop_invalid', '做空必须设止损 / shorts need a stop');
  const ir = buildIR(idea, { market, side, timeframe });
  const checked = checkIR(ir, timeframe);
  if (!checked.ok) throw new ServiceInputError('strategy_invalid', `规则组合未通过检查 / rule check failed: ${checked.checks.filter((c) => !c.ok).map((c) => `${c.name}:${c.message}`).join(';').slice(0, 300)}`);
  return { ...base, idea };
}

// ---------------------------------------------------------------- 族 → IR(原语与订单块口径同 batch/families.ts)

const sizing = node('equal_notional', { max_allocation: '1' });
const market = node('next_open_market', {});
/** 「不设止盈」的远端兜底:执行核要求至少一档止盈,50R 在实际行情里等于不会触发 */
const FAR_TP = node('fixed_r_target', { r: 50 });

export function buildIR(idea: TemplateIdea, o: { market: 'spot' | 'perp'; side: 'long' | 'short'; timeframe: string }): StrategyIR {
  const L = o.side === 'long', a = idea.args, userRisk = !!(idea.stop || idea.target || idea.trail);
  const atrStop = (k: number) => node('atr_stop', { atr_period: 14, multiple: k });
  let signal: StrategyPrimitive[], stop: StrategyPrimitive, exit: StrategyPrimitive[] = [], tp: StrategyPrimitive = FAR_TP, entry: NonNullable<StrategyIR['order']>['entry'] | undefined, hold: number | null = null, desc: string, minRr = 0;
  const cross = (f: number, s: number, direction: string) => ({ indicator: 'ema', args: { period: f }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: s }, direction });
  switch (idea.family) {
    case 'breakout':
      signal = [node('donchian_breakout', { lookback: a.lookback!, basis: 'close', ...(L ? {} : { direction: 'down' }) })];
      stop = atrStop(2); exit = [node('chandelier_trail', { atr_period: 22, multiple: 3 })];
      desc = `收盘${L ? '突破' : '跌破'}此前 ${a.lookback} 根${L ? '最高' : '最低'}`;
      break;
    case 'ema_cross':
      signal = [node('indicator_cross', cross(a.fast!, a.slow!, L ? 'cross_above' : 'cross_below'))];
      stop = L ? node('no_stop', {}) : atrStop(50); exit = [node('indicator_cross_exit', cross(a.fast!, a.slow!, L ? 'cross_below' : 'cross_above'))];
      desc = `EMA${a.fast} ${L ? '上穿' : '下穿'} EMA${a.slow} 入场,反穿离场`;
      break;
    case 'ma_trend':
      signal = [node('indicator_cross', cross(a.fast!, a.slow!, L ? 'above' : 'below'))];
      stop = atrStop(3); exit = [node('indicator_cross_exit', cross(a.fast!, a.slow!, L ? 'cross_below' : 'cross_above'))];
      desc = `EMA${a.fast} 在 EMA${a.slow} ${L ? '上方' : '下方'}时入场,反穿离场`;
      break;
    case 'pullback': {
      const slow = Math.max(50, a.ema! + 10);
      signal = [node('indicator_cross', cross(20, slow, L ? 'above' : 'below')), node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: L ? 'below' : 'above', threshold: 50 })];
      stop = atrStop(1.5); tp = node('fixed_r_target', { r: 2.5 }); hold = 120;
      entry = { type: 'limit', price: node('indicator_level', { indicator: 'ema', args: { period: a.ema! } }) };
      desc = `EMA20 ${L ? '>' : '<'} EMA${slow} 且 RSI14 ${L ? '<' : '>'} 50 时,限价挂 EMA${a.ema} 回踩`;
      break;
    }
    case 'mean_reversion': {
      const adx = node('indicator_threshold', { indicator: 'adx', args: { period: 14 }, operator: 'below', threshold: 20 });
      const lvl = a.rsi_level || (L ? 30 : 70);
      signal = a.bb
        ? [adx, node('indicator_cross', { indicator: 'price', compare_to: 'indicator', compare_indicator: 'bbands', compare_args: { period: 20, multiple: 2 }, compare_output: L ? 'lower' : 'upper', direction: L ? 'cross_below' : 'cross_above' })]
        : [adx, node('indicator_threshold', { indicator: 'rsi', args: { period: a.rsi_period! }, operator: L ? 'cross_below' : 'cross_above', threshold: lvl })];
      stop = atrStop(2); tp = node('indicator_level', { indicator: 'bbands', args: { period: 20, multiple: 2 }, output: 'middle' }); hold = 30;
      desc = a.bb ? `ADX<20 时收盘${L ? '跌破布林下轨' : '升破布林上轨'},止盈布林中轨` : `ADX<20 时 RSI${a.rsi_period} ${L ? '跌破' : '升破'} ${lvl},止盈布林中轨`;
      break;
    }
    case 'smc':
      signal = [node('structure_bos', { swing_length: a.swing! })];
      stop = node('order_blocks', { swing_length: a.swing! }); exit = [node('chandelier_trail', { atr_period: 22, multiple: 3 })];
      desc = `收盘突破确认结构高点(swing ${a.swing}),止损最近订单块下沿`;
      break;
  }
  // 买方给了风控:只用买方说的(信号离场类的族内离场保留),不再叠加族缺省的追踪/止盈
  if (userRisk) {
    if (idea.stop) stop = idea.stop.kind === 'atr' ? atrStop(idea.stop.multiple) : idea.stop.kind === 'pct' ? node('pct_offset_level', { pct: idea.stop.pct }) : node('no_stop', {});
    exit = exit.filter((x) => x.primitive === 'indicator_cross_exit');
    if (idea.trail) exit.push(node('chandelier_trail', { atr_period: 22, multiple: idea.trail.multiple }));
    if (idea.target) tp = idea.target.kind === 'r' ? node('fixed_r_target', { r: idea.target.r }) : idea.target.kind === 'pct' ? node('pct_offset_level', { pct: idea.target.pct }) : FAR_TP;
    else if (!idea.trail && !exit.length && idea.family !== 'pullback' && idea.family !== 'mean_reversion') exit.push(node('chandelier_trail', { atr_period: 22, multiple: 3 }));
  }
  if (idea.max_hold) hold = idea.max_hold;
  if (hold) exit.push(node('time_stop', { bars: hold }, true));
  const riskText = [
    `止损 ${stop.primitive === 'atr_stop' ? `${stop.params.multiple}×ATR14` : stop.primitive === 'pct_offset_level' ? `${Number(stop.params.pct) * 100}%` : stop.primitive === 'no_stop' ? '不设' : stop.primitive === 'order_blocks' ? '订单块下沿' : stop.primitive}`,
    `止盈 ${tp === FAR_TP ? '不设' : tp.primitive === 'fixed_r_target' ? `${tp.params.r}R` : tp.primitive === 'pct_offset_level' ? `${Number(tp.params.pct) * 100}%` : '布林中轨'}`,
    ...exit.filter((x) => x.primitive === 'chandelier_trail').map((x) => `吊灯追踪 ${x.params.multiple}×ATR22`),
    ...(hold ? [`持仓上限 ${hold} 根`] : []),
  ].join(',');
  return {
    version: 1, label: `ASP 快速回测·${QUICK_FAMILY_LABEL[idea.family]} ${o.market === 'spot' ? '现货多' : L ? '永续多' : '永续空'} ${o.timeframe}`.slice(0, 160),
    description: `${desc};${riskText};每笔 100% 可用资金`, signal, entry: market, risk: { stop, sizing }, exit,
    order: { direction: o.side, market: o.market, ...(o.market === 'perp' ? { leverage: 1 } : {}), ...(entry ? { entry } : {}), take_profits: [{ source: tp }], min_rr: minRr, on_new_signal: { unfilled: 'replace', filled: 'ignore' }, ...(hold ? { max_holding_bars: hold } : {}) },
  } as StrategyIR;
}

// ---------------------------------------------------------------- 执行与统计

export interface QuickScore { trades: number; total_return: number; cagr: number | null; sharpe: number | null; max_drawdown: number; win_rate: number | null; profit_factor: number | null; expectancy: number | null; exposure: number; fees: number; benchmark_return: number | null; excess_return: number | null }
export interface QuickResult {
  ir: StrategyIR; ir_hash: string; ir_source: 'template' | 'ir' | 'model';
  compile: { model: string | null; usd: string | null; unmapped: string[] } | null;
  window: { from_ms: number; to_ms: number; bars: number }; data_source: string;
  fees: { taker: number; maker: number | null; slippage_bps: number; stress_multiple: number };
  full: QuickScore; stressed: QuickScore;
  segments: { name: 'in_sample' | 'out_of_sample'; from_ms: number; to_ms: number; score: QuickScore }[];
  yearly: { period: string; return: number; benchmark: number | null }[];
  exit_reasons: Record<string, number>;
  engine_version: string; warnings: string[];
}

const scoreOf = (samples: EquitySample[], trades: ClosedTrade[], fees: number): QuickScore => {
  const m = analyze(samples, trades, fees);
  return { trades: m.trades, total_return: m.total_return, cagr: m.cagr, sharpe: m.sharpe, max_drawdown: m.max_drawdown, win_rate: m.win_rate, profit_factor: m.profit_factor, expectancy: m.expectancy, exposure: m.exposure, fees: m.fees, benchmark_return: m.benchmark_return, excess_return: m.excess_return };
};
const fmt = (x: number) => x.toFixed(8).replace(/\.?0+$/, '') || '0';

/** 下一根 open 含滑点与 taker 费买入、之后按收盘 × (1−滑点) × (1−费率) 计清算价值;与 backtest-report 持有基准同式 */
function holdBenchmark(bars: ResearchBar[], start: number, end: number, cash: number, fee: number, slipBps: number): Map<number, number> {
  const out = new Map<number, number>(), slip = slipBps / 1e4;
  out.set(bars[start]!.close_time - 1, cash); out.set(bars[start]!.close_time, cash);
  const qty = cash / (Number(bars[start + 1]!.open) * (1 + slip) * (1 + fee));
  for (let i = start + 1; i <= end; i++) out.set(bars[i]!.close_time, qty * Number(bars[i]!.close) * (1 - slip) * (1 - fee));
  return out;
}

export async function runQuickBacktest(params: QuickBacktestParams, deps: QuickBacktestDeps, job: PerCallJob): Promise<QuickResult> {
  if (!deps.backtestBars) throw new Error('quick_backtest_unavailable:backtestBars 未接线');
  const warnings: string[] = [...params.notes];
  let ir: StrategyIR, ir_source: QuickResult['ir_source'], compile: QuickResult['compile'] = null;
  if (params.idea.source === 'template') { ir = buildIR(params.idea, params); ir_source = 'template'; }
  else if (params.idea.source === 'ir') { ir = params.idea.ir; ir_source = 'ir'; }
  else {
    if (!deps.compile) throw new Error('nl_compile_unavailable');
    const c = await deps.compile(params.text, params.timeframe);
    const checked = c.ir ? checkIR(c.ir, params.timeframe) : null;
    if (!checked?.ok || !checked.ir) throw new Error(`nl_compile_failed:${checked ? checked.checks.filter((x) => !x.ok).map((x) => x.name).join(',') : 'no_ir'}`);
    ir = checked.ir; ir_source = 'model'; compile = { model: c.model ?? null, usd: c.usd ?? null, unmapped: c.unmapped.slice(0, 12) };
    if (c.unmapped.length) warnings.push(`原话里没能映射的部分 / unmapped: ${c.unmapped.slice(0, 4).join(';')}`);
  }
  // 模型编译出来的 IR 以 IR 的订单块为准(市场/方向),其余路径与解析结果一致
  const mkt: 'spot' | 'perp' = ir.order?.market === 'perp' ? 'perp' : 'spot';
  const step = timeframeMillis(params.timeframe), now = deps.now();
  const to_ms = Math.floor(now / step) * step - 1, from_ms = to_ms - params.days * 86_400_000;
  const warmup = irWarmup(ir, step), history = irHistoryBars(ir, step);
  const borrow = Math.max(Math.min(5000, Math.max(WARMUP_BARS, warmup)), Math.min(60000, history));
  const loaded = await deps.backtestBars(params.symbol, params.timeframe, { from_ms: from_ms - borrow * step, to_ms }, mkt);
  const bars = loaded.bars.filter((b) => b.close_time <= to_ms);
  if (mkt === 'perp' && !loaded.perp) throw new Error('perp_data_missing:永续回测需要标记价/资金费/分档');
  const range = bars.length >= WARMUP_BARS + 3 ? tradingRange(bars, { from_ms, to_ms }, warmup) : null;
  if (!range) throw new Error(`data_missing:${params.symbol} ${params.timeframe} 只有 ${bars.length} 根已收盘 K 线,不够预热 ${Math.max(WARMUP_BARS, warmup)} 根${loaded.note ? ';' + loaded.note : ''}`);
  if (range.warning) warnings.push(range.warning);
  if (!range.borrowed) warnings.push(`窗口前数据不够预热,交易起点后移到 ${new Date(bars[range.start]!.close_time + 1).toISOString().slice(0, 10)}`);
  let perp: AssetPerpInput | undefined;
  if (loaded.perp) { const byOpen = new Map(loaded.bars.map((b, i) => [b.open_time, loaded.perp!.mark[i] ?? null])); perp = { mark: bars.map((b) => byOpen.get(b.open_time) ?? null), funding: loaded.perp.funding, tiers: loaded.perp.tiers, max_lever: loaded.perp.max_lever }; }
  const dataset: ResearchDataset = { venue: 'okx', market: mkt, symbol: params.symbol, timeframe_ms: step, source: loaded.source, retrieved_at: bars.at(-1)!.close_time + 1, bars };
  const base = executionFor(ir), executor = assetExecutorFor(ir), order_gate = orderGateFor(ir);
  const win = { from_ms: bars[range.start]!.close_time, to_ms: bars[range.end]!.close_time };
  const split = win.from_ms + Math.floor((win.to_ms - win.from_ms) * IN_SAMPLE_FRACTION);
  const cache = new Map() as Parameters<typeof executor>[0]['cache'];
  const taker = mkt === 'perp' ? PERP_TAKER : Number(base.fee_rate), maker = mkt === 'perp' ? PERP_MAKER : null, slip = Number(base.slippage_bps);
  const once = async (mult: number): Promise<AssetRunOutput> => {
    const fees = ir.order ? (mkt === 'perp' ? { taker: fmt(PERP_TAKER * mult), maker: fmt(PERP_MAKER * mult) } : { taker: fmt(Number(base.fee_rate) * mult) }) : undefined;
    return executor({ symbol: params.symbol, dataset, dataset_id: `asp_quick:${job.job_id}`, ir, execution: { ...base, fee_rate: fmt(Number(base.fee_rate) * mult) }, order_gate, timeframe: params.timeframe, from_ms: win.from_ms, to_ms: win.to_ms, cache, check: () => {}, ...(fees ? { fees } : {}), ...(perp ? { perp } : {}), segment_of: (t: number) => (t <= split ? 'in_sample' : 'out_of_sample') });
  };
  const run = await once(1), stress = await once(STRESS_FEE_MULTIPLE);
  if (run.status !== 'completed') throw new Error(`backtest_failed:${run.error ?? 'unknown'}`);
  warnings.push(...(run.warnings ?? []));
  const bench = holdBenchmark(bars, range.start, range.end, Number(base.initial_cash), taker, slip);
  const samplesOf = (o: AssetRunOutput): EquitySample[] => o.equity.map((e) => ({ at: e.at, equity: e.equity, exposure: e.exposure, benchmark: bench.get(e.at) ?? null }));
  const closedOf = (o: AssetRunOutput): ClosedTrade[] => o.trades.map((t) => ({ entry_at: t.entry_at, exit_at: t.exit_at, pnl: t.pnl, return_pct: t.return_pct, fees: t.fees, bars_held: t.bars_held, exit_reason: t.exit_reason, side: t.side }));
  const samples = samplesOf(run), closed = closedOf(run);
  const full = scoreOf(samples, closed, run.fees);
  const stressed = stress.status === 'completed' ? scoreOf(samplesOf(stress), closedOf(stress), stress.fees) : { ...full, total_return: NaN, sharpe: null };
  if (stress.status !== 'completed') warnings.push(`2 倍费率压力运行失败:${stress.error}`);
  const is = samples.filter((s) => s.at <= split), oos = [...is.slice(-1), ...samples.filter((s) => s.at > split)];
  const segments = ([['in_sample', is, closed.filter((t) => t.entry_at <= split), win.from_ms, split], ['out_of_sample', oos, closed.filter((t) => t.entry_at > split), split + 1, win.to_ms]] as const)
    .filter(([, ss]) => ss.length >= 2).map(([name, ss, ts, f, t]) => ({ name, from_ms: f, to_ms: t, score: scoreOf(ss, [...ts], ts.reduce((a, x) => a + x.fees, 0)) }));
  const exit_reasons = closed.reduce<Record<string, number>>((a, t) => { a[t.exit_reason] = (a[t.exit_reason] ?? 0) + 1; return a; }, {});
  if (full.trades < 30) warnings.push(`全窗口只有 ${full.trades} 笔平仓,低于 30 笔纪律线,结论只作观察 / fewer than 30 trades`);
  if (ir.order?.direction === 'short') warnings.push('做空策略的持有基准仍是买入持有(做多),超额收益里含方向差 / hold benchmark is long');
  if (mkt === 'perp') warnings.push('永续:1 倍杠杆逐仓,资金费按真实 8h 序列计入,维持保证金分档用 OKX 当前值');
  return {
    ir, ir_hash: hash(ir), ir_source, compile, window: { ...win, bars: range.end - range.start + 1 }, data_source: loaded.source,
    fees: { taker, maker, slippage_bps: slip, stress_multiple: STRESS_FEE_MULTIPLE }, full, stressed, segments,
    yearly: periodReturns(samples, 'year'), exit_reasons, engine_version: run.engine_version, warnings: [...new Set(warnings)].slice(0, 16),
  };
}

// ---------------------------------------------------------------- 渲染(research-report.ts 调)

/** 买方可控的文字(IR 名称/描述、编译未映射片段)进人读正文前遮掉收益保证类词,免得整份交付被 BANNED_WORDS 拦下 */
const BANNED_G = new RegExp(BANNED_WORDS.source, 'gi');
export const scrub = (s: string): string => s.replace(BANNED_G, '***');

export function quickLines(p: QuickBacktestParams, r: QuickResult): { summary: string; lines: string[] } {
  const f = r.full, day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const verdict = f.trades === 0 ? '窗口内没有触发交易 / no trades triggered'
    : `${f.total_return >= 0 ? '跑出正收益' : '净亏损'}${f.excess_return === null ? '' : f.excess_return >= 0 ? ',跑赢同期持有' : ',跑输同期持有'}${r.stressed.total_return <= 0 && f.total_return > 0 ? ',2 倍费率下转负' : ''}`;
  const summary = `${p.symbol.replace(/USDT$/, '')} ${p.timeframe} ${r.ir_source === 'template' && p.idea.source === 'template' ? QUICK_FAMILY_LABEL[p.idea.family] : scrub(r.ir.label.slice(0, 40))}:收益 ${pct(f.total_return)} vs 持有 ${pct(f.benchmark_return)} · 夏普 ${num(f.sharpe)} · 回撤 ${pct(f.max_drawdown)} · ${f.trades} 笔(${verdict})`;
  const lines = [
    `策略 / Strategy: ${scrub((r.ir.description ?? r.ir.label).slice(0, 300))}(${r.ir.order?.market !== 'perp' ? '现货多 spot long' : r.ir.order.direction === 'short' ? '永续空 perp short' : '永续多 perp long'};规则来源 ${r.ir_source === 'template' ? '确定性模板 deterministic template' : r.ir_source === 'ir' ? '买方 IR' : `模型编译 model-compiled ${r.compile?.model ?? ''}`})`,
    `窗口 / Window: ${day(r.window.from_ms)} ~ ${day(r.window.to_ms)} · ${r.window.bars} 根 ${p.timeframe} · 数据 ${r.data_source.slice(0, 80)}`,
    `费用 / Costs: taker ${pct(r.fees.taker, 2)}${r.fees.maker !== null ? ` · maker ${pct(r.fees.maker, 2)}` : ''} · 滑点 ${r.fees.slippage_bps} bps · 每笔 100% 可用资金,不加杠杆`,
    `全窗口 / Full: 收益 ${pct(f.total_return)} · 年化 ${pct(f.cagr)} · 夏普 ${num(f.sharpe)} · 最大回撤 ${pct(f.max_drawdown)} · 胜率 ${pct(f.win_rate)} · ${f.trades} 笔 · 盈亏因子 ${num(f.profit_factor)} · 手续费 ${num(f.fees)} USDT`,
    `同期持有 / Buy & hold: ${pct(f.benchmark_return)} · 超额 ${pct(f.excess_return)} · 平均敞口 ${pct(f.exposure)}`,
    ...r.segments.map((s) => `${s.name === 'in_sample' ? '前 70% / First 70%' : '后 30% / Last 30%'}: 收益 ${pct(s.score.total_return)} vs 持有 ${pct(s.score.benchmark_return)} · 夏普 ${num(s.score.sharpe)} · 回撤 ${pct(s.score.max_drawdown)} · ${s.score.trades} 笔`),
    `按年 / By year: ${r.yearly.map((y) => `${y.period} ${pct(y.return)}(持有 ${pct(y.benchmark)})`).join(' · ') || '—'}`,
    `2 倍费率压力 / 2× fee stress: 收益 ${pct(r.stressed.total_return)} · 夏普 ${num(r.stressed.sharpe)} · 回撤 ${pct(r.stressed.max_drawdown)}`,
    ...(Object.keys(r.exit_reasons).length ? [`离场原因 / Exits: ${Object.entries(r.exit_reasons).map(([k, n]) => `${k} ${n}`).join(' · ')}`] : []),
    ...r.warnings.slice(0, 6).map((w) => `注意 / Note: ${scrub(w)}`),
    '方法 / Method: 信号在已收盘 K 线判定,下一根开盘成交;止损 stop-market、止盈限价,同根先止损;全窗口一次连续回放,前 70%/后 30% 只是标注,不是参数优化后的样本外检验',
  ];
  return { summary, lines };
}

/**
 * 运行时取数的缺省实现:现货 = okxLoader(读 research_datasets 已存行情 + 补拉 OKX 公共 K 线,只读不写),
 * 永续 = okxPerpLoader(OKX SWAP 成交价 + 标记价 + 资金费 + 分档,本地 sqlite 缓存)。
 * 用法(deps 组装处):`backtestBars: quickBacktestLoader(new ResearchStore(rt.store.marketDb))`
 */
export function quickBacktestLoader(store: import('../../research/store.js').ResearchStore): NonNullable<QuickBacktestDeps['backtestBars']> {
  let spot: ReturnType<typeof import('../../research/backtest-report.js').okxLoader> | null = null, perp: ReturnType<typeof import('../../research/backtest-report.js').okxPerpLoader> | null = null;
  return async (symbol, timeframe, window, mkt) => {
    const m = await import('../../research/backtest-report.js');
    if (mkt === 'perp') return (perp ??= m.okxPerpLoader())(symbol, timeframe, window);
    return (spot ??= m.okxLoader({ store } as Parameters<typeof m.okxLoader>[0]))(symbol, timeframe, window);
  };
}
