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
import type { ResearchBar, ResearchDataset, StrategyIR, StrategyPrimitive } from '@trade-gate/contracts';
import { assetExecutorFor, tradingRange, WARMUP_BARS, type AssetPerpInput, type AssetRunOutput, type LoadedBars } from '../../research/backtest-report.js';
import { executionFor } from '../../research/improve/evaluate.js';
import { analyze, periodReturns, type ClosedTrade, type EquitySample } from '../../research/analyzer.js';
import { orderGateFor } from '../../research/order-gate.js';
import { checkIR, irHistoryBars, irWarmup, node, timeframeMillis } from '../../research/strategy.js';
import { hash } from '../../research/primitives.js';
import { freeText, jsonParams, normMarket, normSymbol, positive, sideIn, symbolsIn, timeframeIn } from './params.js';
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

export type QuickFamily = 'breakout' | 'ema_cross' | 'ma_trend' | 'pullback' | 'mean_reversion' | 'smc' | 'streak';
/** 族名(IR label 与交付正文共用,英文) */
export const QUICK_FAMILY_LABEL: Record<QuickFamily, string> = { breakout: 'Channel breakout', ema_cross: 'EMA crossover', ma_trend: 'MA trend', pullback: 'MA pullback', mean_reversion: 'Mean reversion', smc: 'SMC structure break', streak: 'Candle streak' };
/** 离场原因(执行核 OrderExitReason 及旧执行核的 reason)→ 英文 */
export const EXIT_REASON_TEXT: Record<string, string> = { sl: 'stop loss', tp: 'take profit', trail: 'trailing stop', breakeven: 'breakeven stop', signal_exit: 'signal exit', time: 'time exit', horizon: 'time exit', rolled: 'rolled', flipped: 'reversed', liquidation: 'liquidation', end_of_data: 'closed at window end', open: 'open at window end', stop: 'stop loss', target: 'take profit', agent_exit: 'exit', agent_reduce: 'reduce' };
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
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
/** 连续 N 根阳/阴线(复审 09-26:「3 consecutive green candles」被拒单) */
const STREAK_RE = /(\d{1,2})\s*(?:consecutive|straight|successive)?\s*(green|red|bullish|bearish|up|down|white|black)\s*(?:candles?|candlesticks?|bars?|k\s*线)|(?:consecutive|successive|in a row)\s*(green|red|bullish|bearish)|连续\s*(\d{1,2})\s*根\s*(阳|阴|上涨|下跌)|([二两三四五六七八九])连(阳|阴)/i;
const FAMILY_TESTS: [QuickFamily, RegExp][] = [
  ['streak', STREAK_RE],
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
  if (!Number.isInteger(v) || v < lo || v > hi) throw new ServiceInputError(code, `${what} must be an integer from ${lo} to ${hi}`);
  return v;
};

/** 描述里有没有「交易规则」的词(入场/离场动作、指标、价位、形态);模板认不出又没有这些词 → 接单前拒单 */
export const RULE_WORDS = /\b(?:buy|sell|long|short|enter|entry|exit|open|close|when|if|after|once|cross(?:es|over)?|above|below|break(?:s|out)?|rsi|macd|ema|sma|ma\d*|atr|bollinger|vwap|volume|candles?|pattern|support|resistance|trend|momentum|stoch(?:astic)?|kdj|cci|adx|signal|stop|target|funding|divergence|oversold|overbought)\b|买|卖|做多|做空|开仓|开多|开空|入场|进场|离场|出场|平仓|如果|之后|上穿|下穿|站上|跌破|突破|指标|均线|成交量|放量|支撑|阻力|形态|动量|趋势|止损|止盈|背离|资金费/i;

/** 交付 JSON 一律英文:含中日韩文字的字符串认得出的译成英文(warningLine),认不出的在数组里丢掉、在对象字段里换成占位说明 */
export function englishOnly<T>(v: T): T {
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return CJK.test(x) ? warningLine(x) : x;
    if (Array.isArray(x)) return x.map(walk).filter((y) => y !== null);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => { const w = walk(y); return [k, w === null && y !== null ? '(non-English text omitted)' : w]; }));
    return x;
  };
  return walk(v) as T;
}

export function familyIn(text: string): QuickFamily | null {
  for (const [k, re] of FAMILY_TESTS) if (re.test(text)) return k;
  return null;
}

export function stopIn(text: string): StopSpec | null {
  if (/不设止损|不止损|无止损|不要止损|no[\s-]?stop(?:[\s-]?loss)?/i.test(text)) return { kind: 'none' };
  const atr = firstNum(text, [new RegExp(`${N}\\s*(?:倍|x|×)?\\s*atr\\s*(?:的)?\\s*(?:止损|stop|sl)`, 'i'), new RegExp(`(?:止损|stop(?:[\\s-]?loss)?|\\bsl\\b)[^,，。;；\\d]{0,8}${N}\\s*(?:倍|x|×)?\\s*atr`, 'i')]);
  if (atr !== null) { if (atr < 0.5 || atr > 10) throw new ServiceInputError('stop_invalid', 'ATR stop multiple must be between 0.5 and 10'); return { kind: 'atr', multiple: atr }; }
  const p = firstNum(text, [new RegExp(`(?:止损|stop(?:[\\s-]?loss)?|\\bsl\\b)[^,，。;；\\d]{0,8}${N}\\s*%`, 'i'), new RegExp(`${N}\\s*%\\s*(?:的)?\\s*(?:止损|stop)`, 'i')]);
  if (p !== null) { if (p < 0.2 || p > 30) throw new ServiceInputError('stop_invalid', 'Percent stop must be between 0.2% and 30%'); return { kind: 'pct', pct: p / 100 }; }
  return null;
}
export function targetIn(text: string): TargetSpec | null {
  if (/不设止盈|不止盈|无止盈|不要止盈|no[\s-]?(?:take[\s-]?profit|target)/i.test(text)) return { kind: 'none' };
  const r = firstNum(text, [new RegExp(`${N}\\s*r(?![a-z])\\s*(?:的)?\\s*(?:profit\\s*|reward\\s*)?(?:止盈|目标|take|tp|target|exit)`, 'i'), new RegExp(`(?:止盈|目标|\\btp\\d?\\b|take[\\s-]?profit|target)[^,，。;；\\d%]{0,8}${N}\\s*r(?![a-z])`, 'i'), new RegExp(`(?:盈亏比|风险回报比|reward[\\s-]?to[\\s-]?risk|\\brr\\b)\\s*[:：=]?\\s*(?:1\\s*[:：]\\s*)?${N}`, 'i')]);
  if (r !== null) { if (r < 0.5 || r > 20) throw new ServiceInputError('target_invalid', 'R target must be between 0.5 and 20'); return { kind: 'r', r }; }
  const p = firstNum(text, [new RegExp(`(?:止盈|目标|\\btp\\d?\\b|take[\\s-]?profit|target)[^,，。;；\\d]{0,8}${N}\\s*%`, 'i'), new RegExp(`${N}\\s*%\\s*(?:的)?\\s*(?:止盈|take|target|profit|gain)`, 'i')]);
  if (p !== null) { if (p < 0.3 || p > 200) throw new ServiceInputError('target_invalid', 'Percent target must be between 0.3% and 200%'); return { kind: 'pct', pct: p / 100 }; }
  return null;
}
export function trailIn(text: string): { multiple: number } | null {
  if (/不(?:要|用|设|加)?\s*(?:追踪|跟踪|移动)止损|不(?:要|用|加)?\s*(?:吊灯|追踪|trail)/i.test(text)) return null;
  const m = /(?:吊灯|追踪止损|跟踪止损|移动止损|chandelier|trailing[\s-]?stop|trail)[^,，。;；\d]{0,8}(?:(\d+(?:\.\d+)?)\s*(?:倍|x|×)?\s*(?:atr)?)?/i.exec(text);
  if (!m) return null;
  const k = m[1] ? Number(m[1]) : 3;
  if (!(k >= 1 && k <= 10)) throw new ServiceInputError('trail_invalid', 'Trailing ATR multiple must be between 1 and 10');
  return { multiple: k };
}
function argsFor(family: QuickFamily, text: string, p: Record<string, unknown>): Record<string, number> {
  const given = (k: string) => (p[k] === undefined ? null : positive(p[k]));
  switch (family) {
    case 'breakout': {
      const look = given('lookback') ?? firstNum(text, [/(?:唐奇安|donchian|\bdc)\s*[(（]?\s*(\d{1,3})/i, /(\d{1,3})\s*(?:根|日|天|周期|bars?|periods?|-bar|-day)?\s*(?:k\s*线)?\s*(?:的)?\s*(?:高点|最高价?|低点|最低价?|highs?|lows?|通道|channel)/i, /(?:突破|跌破|breakout|breakdown)\s*(?:前|过去|最近|last|past)?\s*(\d{1,3})\s*(?:根|日|天|bars?|days?)/i]);
      return { lookback: intIn(look, 5, 300, 'lookback_invalid', 'Breakout lookback (bars)') ?? 20 };
    }
    case 'ema_cross': case 'ma_trend': {
      let fast = given('fast'), slow = given('slow');
      if (fast === null || slow === null) {
        const m = /(?:ema|sma|ma|均线)\s*(\d{1,3})\s*(?:[/,，与和&xX×-]|and|上穿|下穿|cross(?:es)?(?:\s+(?:above|below|over|under))?)\s*(?:ema|sma|ma|均线)?\s*(\d{1,3})/i.exec(text) ?? /(\d{1,3})\s*[/]\s*(\d{1,3})\s*(?:ema|sma|ma|均线)/i.exec(text);
        if (m) { fast = Number(m[1]); slow = Number(m[2]); }
      }
      if (fast !== null && slow !== null && fast > slow) [fast, slow] = [slow, fast];
      const f = intIn(fast, 2, 200, 'ma_invalid', 'Fast MA period') ?? 20, s = intIn(slow, 3, 400, 'ma_invalid', 'Slow MA period') ?? (family === 'ema_cross' ? 50 : 100);
      if (f >= s) throw new ServiceInputError('ma_invalid', 'Fast MA period must be below the slow MA period');
      return { fast: f, slow: s };
    }
    case 'pullback': {
      const ema = given('ema') ?? firstNum(text, [/(?:回踩|回调到?|回撤到|pull[\s-]?back\s*(?:to)?)\s*(?:ema|sma|ma|均线)?\s*(\d{1,3})/i]);
      return { ema: intIn(ema, 5, 200, 'ma_invalid', 'Pullback MA period') ?? 20 };
    }
    case 'mean_reversion': {
      const m = /rsi\s*[(（]?\s*(\d{1,2})?\s*[)）]?\s*(?:<|>|低于|高于|跌破|升破|小于|大于|below|above|under|over)\s*(\d{1,2})/i.exec(text);
      const period = given('rsi_period') ?? (m?.[1] ? Number(m[1]) : null), level = given('rsi_level') ?? (m?.[2] ? Number(m[2]) : null);
      const bb = /布林|bollinger|\bbb\b/i.test(text) && !m ? 1 : 0;
      return { rsi_period: intIn(period, 2, 50, 'rsi_invalid', 'RSI period') ?? 14, rsi_level: intIn(level, 5, 95, 'rsi_invalid', 'RSI threshold') ?? 0, bb };
    }
    case 'smc': return { swing: intIn(given('swing'), 2, 10, 'swing_invalid', 'Swing length (bars on each side)') ?? 3 };
    case 'streak': {
      const m = STREAK_RE.exec(text);
      const CN: Record<string, number> = { 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
      const raw = given('count') ?? (m?.[1] ? Number(m[1]) : m?.[4] ? Number(m[4]) : m?.[6] ? CN[m[6]] ?? null : null);
      const word = (m?.[2] ?? m?.[3] ?? m?.[5] ?? m?.[7] ?? '').toLowerCase();
      const down = p['direction'] === 'down' || /red|bearish|down|black|阴|下跌/.test(word);
      return { count: intIn(raw, 2, 20, 'streak_invalid', 'Consecutive candle count') ?? 3, down: down ? 1 : 0 };
    }
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
    if (xs.length !== 1 || typeof xs[0] !== 'string') throw new ServiceInputError('symbols_too_many', 'The quick backtest takes exactly one symbol');
    symbol = normSymbol(xs[0]);
    if (!/^[A-Z0-9]{2,15}USDT$/.test(symbol)) throw new ServiceInputError('symbols_invalid', `Unknown symbol: ${xs[0]}`);
  } else {
    const found = symbolsIn(raw.replace(NOT_COIN, ' '), 3);
    if (found.length > 1) notes.push(`Several assets in the request (${found.join(', ')}); the quick tier tests only the first one, ${found[0]}`);
    symbol = found[0] ?? null;
  }
  if (!symbol) throw new ServiceInputError('symbol_required', 'Please name one asset to backtest, e.g. BTC');
  const timeframe = timeframeIn(p['timeframe'], raw, QUICK_TIMEFRAMES, '4h') as QuickTimeframe;
  // 方向与市场:做空只能在永续上做;明说现货又要做空 → 拒单
  const side = sideIn(p['side'], raw) ?? 'long';
  const pm0 = p['market'], pm = normMarket(pm0) ?? pm0;
  if (pm !== undefined && pm !== null && pm !== '' && pm !== 'spot' && pm !== 'perp') throw new ServiceInputError('market_invalid', 'market must be spot or perp');
  const wantsPerp = pm === 'perp' || (pm === undefined && /永续|合约|\bperp|\bswap\b|杠杆|leverage/i.test(raw));
  const wantsSpot = pm === 'spot' || (pm === undefined && /现货|\bspot\b/i.test(raw) && !wantsPerp);
  if (side === 'short' && wantsSpot) throw new ServiceInputError('sides_invalid', 'Spot cannot be shorted');
  const market: 'spot' | 'perp' = side === 'short' || wantsPerp ? 'perp' : 'spot';
  // 窗口
  let days = p['days'] !== undefined ? positive(p['days']) : null;
  if (days === null) {
    const m = /(?:最近|过去|近|last|past)\s*(\d{1,4})\s*(天|日|个?月|年|days?|months?|years?)/i.exec(raw);
    if (m) days = Number(m[1]) * (/月|month/i.test(m[2]!) ? 30 : /年|year/i.test(m[2]!) ? 365 : 1);
  }
  if (days !== null && (!Number.isFinite(days) || days < QUICK_MIN_DAYS)) throw new ServiceInputError('days_invalid', `Backtest window must be at least ${QUICK_MIN_DAYS} days`);
  if (days !== null && days > QUICK_MAX_DAYS[timeframe]) { notes.push(`The ${timeframe} window is capped at ${QUICK_MAX_DAYS[timeframe]} days; the request was trimmed to the cap`); days = QUICK_MAX_DAYS[timeframe]; }
  days = Math.round(days ?? QUICK_DEFAULT_DAYS[timeframe]);
  const base = { symbol, timeframe, market, side, days, text: text.slice(0, 600), notes };
  // 策略:完整 IR > JSON family > 文本族匹配 > 模型编译
  if (p['strategy_ir'] !== undefined) {
    const checked = checkIR(p['strategy_ir'], timeframe);
    if (!checked.ok || !checked.ir) throw new ServiceInputError('strategy_invalid', `strategy_ir failed validation: ${checked.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
    const ir = checked.ir, irMarket = ir.order?.market ?? 'spot', irSide = ir.order?.direction === 'short' ? 'short' : 'long';
    if (ir.order?.direction === 'both') throw new ServiceInputError('sides_invalid', 'The quick backtest does not support direction=both');
    return { ...base, market: irMarket, side: irSide, idea: { source: 'ir', ir } };
  }
  let family: QuickFamily | null = null;
  if (p['family'] !== undefined) {
    // 大小写 / 连字符不同照认;不是模板名的(「breakout strategy」「RSI oversold」)按描述再匹配一次,还不行才拒
    const f = String(p['family']).trim().toLowerCase().replace(/[\s-]+/g, '_');
    family = FAMILY_KEYS.includes(f as QuickFamily) ? f as QuickFamily : familyIn(`${String(p['family'])} ${text}`);
    if (!family) throw new ServiceInputError('family_invalid', `family must be one of ${FAMILY_KEYS.join(' / ')}`);
  } else family = familyIn(text);
  if (!family) {
    if (!opts.nl_compile) throw new ServiceInputError('strategy_unrecognized', 'Strategy not recognized: describe the entry rule (N-bar high breakout, MA crossover, MA pullback, RSI oversold mean reversion or SMC structure break), or pass strategy_ir');
    // 有币名就接单(复审 09-27:审核员的测试单被拒会记负面);没有交易规则的描述在交付时直接给最接近模板的参考结果,不花模型钱
    return { ...base, idea: { source: 'text' } };
  }
  if (family === 'smc' && side === 'short') throw new ServiceInputError('sides_invalid', 'The SMC template is long-only');
  const idea: TemplateIdea = {
    source: 'template', family, args: argsFor(family, text, p), stop: stopIn(text), target: targetIn(text), trail: trailIn(text),
    max_hold: intIn(p['max_hold_bars'] !== undefined ? positive(p['max_hold_bars']) : firstNum(text, [/持(?:仓|有)\s*(?:不超过|最多|最长|上限)?\s*(\d{1,4})\s*根/, /max(?:imum)?[\s-]?hold(?:ing)?\s*(\d{1,4})\s*bars?/i]), 1, 2000, 'max_hold_invalid', 'Max holding bars'),
  };
  if (idea.stop?.kind === 'none' && side === 'short') throw new ServiceInputError('stop_invalid', 'Short strategies need a stop loss');
  const ir = buildIR(idea, { market, side, timeframe });
  const checked = checkIR(ir, timeframe);
  if (!checked.ok) throw new ServiceInputError('strategy_invalid', `Rule check failed: ${checked.checks.filter((c) => !c.ok).map((c) => !c.message || CJK.test(c.message) ? c.name : `${c.name}: ${c.message}`).join('; ').slice(0, 300)}`);
  return { ...base, idea };
}

// ---------------------------------------------------------------- 族 → IR(原语与订单块口径同 batch/families.ts)

const sizing = node('equal_notional', { max_allocation: '1' });
const market = node('next_open_market', {});
/** 「不设止盈」的远端兜底:执行核要求至少一档止盈,50R 在实际行情里等于不会触发 */
const FAR_TP = node('fixed_r_target', { r: 50 });
/** IR 描述末尾的资金口径(正文里单独写,渲染时剥掉) */
const FULL_CAPITAL = '100% of available capital per trade';

export function buildIR(idea: TemplateIdea, o: { market: 'spot' | 'perp'; side: 'long' | 'short'; timeframe: string }): StrategyIR {
  const L = o.side === 'long', a = idea.args, userRisk = !!(idea.stop || idea.target || idea.trail);
  const atrStop = (k: number) => node('atr_stop', { atr_period: 14, multiple: k });
  let signal: StrategyPrimitive[], stop: StrategyPrimitive, exit: StrategyPrimitive[] = [], tp: StrategyPrimitive = FAR_TP, entry: NonNullable<StrategyIR['order']>['entry'] | undefined, hold: number | null = null, desc: string, minRr = 0;
  const cross = (f: number, s: number, direction: string) => ({ indicator: 'ema', args: { period: f }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: s }, direction });
  switch (idea.family) {
    case 'breakout':
      signal = [node('donchian_breakout', { lookback: a.lookback!, basis: 'close', ...(L ? {} : { direction: 'down' }) })];
      stop = atrStop(2); exit = [node('chandelier_trail', { atr_period: 22, multiple: 3 })];
      desc = `Close ${L ? 'breaks above' : 'breaks below'} the prior ${a.lookback}-bar ${L ? 'high' : 'low'}`;
      break;
    case 'ema_cross':
      signal = [node('indicator_cross', cross(a.fast!, a.slow!, L ? 'cross_above' : 'cross_below'))];
      stop = L ? node('no_stop', {}) : atrStop(50); exit = [node('indicator_cross_exit', cross(a.fast!, a.slow!, L ? 'cross_below' : 'cross_above'))];
      desc = `Enter when EMA${a.fast} crosses ${L ? 'above' : 'below'} EMA${a.slow}, exit on the reverse cross`;
      break;
    case 'ma_trend':
      signal = [node('indicator_cross', cross(a.fast!, a.slow!, L ? 'above' : 'below'))];
      stop = atrStop(3); exit = [node('indicator_cross_exit', cross(a.fast!, a.slow!, L ? 'cross_below' : 'cross_above'))];
      desc = `Enter while EMA${a.fast} is ${L ? 'above' : 'below'} EMA${a.slow}, exit on the reverse cross`;
      break;
    case 'pullback': {
      const slow = Math.max(50, a.ema! + 10);
      signal = [node('indicator_cross', cross(20, slow, L ? 'above' : 'below')), node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: L ? 'below' : 'above', threshold: 50 })];
      stop = atrStop(1.5); tp = node('fixed_r_target', { r: 2.5 }); hold = 120;
      entry = { type: 'limit', price: node('indicator_level', { indicator: 'ema', args: { period: a.ema! } }) };
      desc = `When EMA20 ${L ? '>' : '<'} EMA${slow} and RSI14 ${L ? '<' : '>'} 50, place a limit order at the EMA${a.ema} pullback`;
      break;
    }
    case 'mean_reversion': {
      const adx = node('indicator_threshold', { indicator: 'adx', args: { period: 14 }, operator: 'below', threshold: 20 });
      const lvl = a.rsi_level || (L ? 30 : 70);
      signal = a.bb
        ? [adx, node('indicator_cross', { indicator: 'price', compare_to: 'indicator', compare_indicator: 'bbands', compare_args: { period: 20, multiple: 2 }, compare_output: L ? 'lower' : 'upper', direction: L ? 'cross_below' : 'cross_above' })]
        : [adx, node('indicator_threshold', { indicator: 'rsi', args: { period: a.rsi_period! }, operator: L ? 'cross_below' : 'cross_above', threshold: lvl })];
      stop = atrStop(2); tp = node('indicator_level', { indicator: 'bbands', args: { period: 20, multiple: 2 }, output: 'middle' }); hold = 30;
      desc = a.bb ? `With ADX<20, close ${L ? 'falls below the lower' : 'rises above the upper'} Bollinger band; target the middle band` : `With ADX<20, RSI${a.rsi_period} crosses ${L ? 'below' : 'above'} ${lvl}; target the middle Bollinger band`;
      break;
    }
    case 'streak': {
      const color = a.down ? 'red' : 'green';
      signal = [node('candle_streak', { count: a.count!, direction: a.down ? 'down' : 'up' })];
      stop = atrStop(2); tp = node('fixed_r_target', { r: 2 }); hold = 48;
      desc = `Enter ${L ? 'long' : 'short'} after ${a.count} consecutive ${color} candles (close vs open)`;
      break;
    }
    case 'smc':
      signal = [node('structure_bos', { swing_length: a.swing! })];
      stop = node('order_blocks', { swing_length: a.swing! }); exit = [node('chandelier_trail', { atr_period: 22, multiple: 3 })];
      desc = `Close breaks a confirmed structure high (swing ${a.swing}); stop at the nearest order block low`;
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
    `stop ${stop.primitive === 'atr_stop' ? `${stop.params.multiple}×ATR14` : stop.primitive === 'pct_offset_level' ? `${Number(stop.params.pct) * 100}%` : stop.primitive === 'no_stop' ? 'none' : stop.primitive === 'order_blocks' ? 'order block low' : stop.primitive}`,
    `target ${tp === FAR_TP ? 'none' : tp.primitive === 'fixed_r_target' ? `${tp.params.r}R` : tp.primitive === 'pct_offset_level' ? `${Number(tp.params.pct) * 100}%` : 'middle Bollinger band'}`,
    ...exit.filter((x) => x.primitive === 'chandelier_trail').map((x) => `chandelier trail ${x.params.multiple}×ATR22`),
    ...(hold ? [`max hold ${hold} bars`] : []),
  ].join(', ');
  return {
    version: 1, label: `ASP quick backtest · ${QUICK_FAMILY_LABEL[idea.family]} ${o.market === 'spot' ? 'spot long' : L ? 'perp long' : 'perp short'} ${o.timeframe}`.slice(0, 160),
    description: `${desc}; ${riskText}; ${FULL_CAPITAL}`, signal, entry: market, risk: { stop, sizing }, exit,
    order: { direction: o.side, market: o.market, ...(o.market === 'perp' ? { leverage: 1 } : {}), ...(entry ? { entry } : {}), take_profits: [{ source: tp }], min_rr: minRr, on_new_signal: { unfilled: 'replace', filled: 'ignore' }, ...(hold ? { max_holding_bars: hold } : {}) },
  } as StrategyIR;
}

// ---------------------------------------------------------------- 执行与统计

export interface QuickScore { trades: number; total_return: number; cagr: number | null; sharpe: number | null; max_drawdown: number; win_rate: number | null; profit_factor: number | null; expectancy: number | null; exposure: number; fees: number; benchmark_return: number | null; excess_return: number | null }
export interface QuickResult {
  ir: StrategyIR; ir_hash: string; ir_source: 'template' | 'ir' | 'model';
  compile: { model: string | null; usd: string | null; unmapped: string[] } | null;
  window: { from_ms: number; to_ms: number; bars: number }; data_source: string;
  /** 回测初始资金(USDT,执行核缺省),手续费与收益都以它为参照 */
  initial_cash: number;
  fees: { taker: number; maker: number | null; slippage_bps: number; stress_multiple: number };
  full: QuickScore; stressed: QuickScore;
  segments: { name: 'in_sample' | 'out_of_sample'; from_ms: number; to_ms: number; score: QuickScore }[];
  yearly: { period: string; return: number; benchmark: number | null }[];
  exit_reasons: Record<string, number>;
  engine_version: string; warnings: string[];
  /**
   * tested = 回测的就是买方的规则;not_mapped = 买方规则没映射上(编译失败 / 占位入场 / 0 笔),
   * 此时顶层数字是「最接近的支持模板」的参考结果,买方原规则与原因在 requested 里。
   */
  outcome: 'tested' | 'not_mapped';
  reference_family?: QuickFamily;
  requested?: { ir: StrategyIR | null; ir_hash: string | null; compile: QuickResult['compile']; reasons: string[]; closest_by_keywords: boolean };
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

/** 模型编译提示:让模型把标签 / 描述 / 未映射原因写成英文(对外一律英文);不含 strategy.ts 各原话正则会命中的词 */
export const COMPILE_ENGLISH_HINT = '\n(Write the label, description and every unmapped reason in English.)';
/** 编译器自己写的补全 / 更正说明(不是「买方原话没映射上」),按前缀认 */
const CODE_NOTE = /^(?:自动补全|自动更正|自动规整|按原话|原话|做空只能|模型误标|模型 \d+ 次输出)/;
/** 模型自报「入场条件表达不了、用了占位」 */
const PLACEHOLDER_NOTE = /占位|placeholder|dummy|无效信号|无法表达.{0,20}(?:入场|触发|信号|条件)|cannot (?:be )?express.{0,30}(?:entry|signal|trigger|condition)|no (?:primitive|rule) (?:for|to express) the entry/i;

/** 编译说明 → 英文未映射片段 + 编译器补全条数(中文原因不转述,只留买方原话里的英文片段) */
export function compileNotes(raw: readonly string[]): { unmapped: string[]; defaults: number } {
  const unmapped: string[] = []; let defaults = 0;
  for (const x of raw.slice(0, 24)) {
    const s = String(x).trim();
    if (!s) continue;
    if (CODE_NOTE.test(s)) { defaults++; continue; }
    if (!CJK.test(s)) { unmapped.push(`Not mapped: ${s.slice(0, 200)}`); continue; }
    const head = s.split(/[　-〿一-鿿＀-￯]/)[0]!.replace(/[\s:：,，(（]+$/, '').trim();
    unmapped.push(head ? `Not mapped: ${head.slice(0, 160)}` : 'A part of the request could not be mapped to a supported rule');
  }
  return { unmapped: unmapped.slice(0, 12), defaults };
}

/** 编译出来的入场条件是不是占位(不表达买方的条件):空信号、价格与 ≤0 常数比较、模型自报占位 */
export function degenerateReason(ir: StrategyIR, rawNotes: readonly string[]): string | null {
  if (!ir.signal?.length) return 'The compiled rule set has no entry condition';
  for (const s of ir.signal) {
    const p = s.params as Record<string, unknown>;
    if (p['compare_to'] === 'constant' && (p['indicator'] === 'price' || p['indicator'] === 'close') && !(Number(p['constant']) > 0)) return 'The compiled entry condition is a placeholder (price compared with zero) that does not express the requested entry rule';
  }
  if (rawNotes.some((x) => PLACEHOLDER_NOTE.test(String(x)))) return 'The compiler reported that the requested entry condition has no supported rule, so the compiled entry was only a placeholder';
  return null;
}

/** 认不出的想法 → 最接近的支持模板(关键词启发式,缺省通道突破) */
const CLOSEST: [QuickFamily, RegExp][] = [
  ['streak', /candle|candlestick|阳线|阴线|k\s*线形态|形态|pattern|engulf|吞没|doji|十字星|hammer|锤子|pin[\s-]?bar/i],
  ['mean_reversion', /\brsi\b|oversold|overbought|超卖|超买|stoch|kdj|\bcci\b|williams|revers|反转|抄底|bollinger|布林|panic|恐慌|fear|capitulat|dip/i],
  ['smc', /\bsmc\b|order[\s-]?block|订单块|liquidity|流动性|structure|结构/i],
  ['pullback', /pull[\s-]?back|回调|回踩|support|支撑|retrace/i],
  ['ema_cross', /\bmacd\b|cross|交叉|金叉|死叉/i],
  ['ma_trend', /trend|趋势|moving average|均线|\bema\b|\bsma\b|\bma\s*\d/i],
  ['breakout', /momentum|动量|break|突破|new high|新高|volume|放量|成交量|vwap|range|区间/i],
];
export function closestIdea(text: string, side: 'long' | 'short'): { idea: TemplateIdea; matched: boolean } {
  let family: QuickFamily = CLOSEST.find(([, re]) => re.test(text))?.[0] ?? 'breakout';
  const matched = CLOSEST.some(([, re]) => re.test(text));
  if (family === 'smc' && side === 'short') family = 'breakout';
  const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };
  let stop = safe(() => stopIn(text), null);
  if (stop?.kind === 'none' && side === 'short') stop = null;
  const idea: TemplateIdea = { source: 'template', family, args: safe(() => argsFor(family, text, {}), argsFor(family, '', {})), stop, target: safe(() => targetIn(text), null), trail: safe(() => trailIn(text), null), max_hold: null };
  return { idea, matched };
}

export async function runQuickBacktest(params: QuickBacktestParams, deps: QuickBacktestDeps, job: PerCallJob): Promise<QuickResult> {
  if (!deps.backtestBars) throw new Error('quick_backtest_unavailable: backtestBars not wired');
  if (params.idea.source === 'template') return replay(buildIR(params.idea, params), 'template', null, params, deps, job, [...params.notes]);
  if (params.idea.source === 'ir') return replay(params.idea.ir, 'ir', null, params, deps, job, [...params.notes]);
  if (!deps.compile) throw new Error('nl_compile_unavailable');
  // 描述里没有任何交易规则词(「BTC 4h 我觉得会涨」):不调模型(只会编出占位入场),直接交付解读说明 + 最接近模板的参考结果
  if (!RULE_WORDS.test(params.text)) return notMapped(params, deps, job, null, { model: null, usd: null, unmapped: [] }, ['The request names an asset but states no entry or exit rule, so there was no rule to compile or test']);
  // 模型编译:编译本身抛错(网络 / 超时)照常上抛让轮询重试;编译出来的东西没法用 → 不重试(重试只会再花模型钱),交付说明 + 最接近模板的参考结果
  const c = await deps.compile(params.text + COMPILE_ENGLISH_HINT, params.timeframe);
  const checked = c.ir ? checkIR(c.ir, params.timeframe) : null;
  const notes = compileNotes(c.unmapped ?? []);
  const compile = { model: c.model ?? null, usd: c.usd ?? null, unmapped: notes.unmapped };
  const reasons: string[] = [];
  let requested: StrategyIR | null = checked?.ir ? englishIR(checked.ir, params) : null;
  if (!checked?.ok || !checked.ir) reasons.push(`The request could not be compiled into a rule set that passes validation${checked ? ` (failed checks: ${checked.checks.filter((x) => !x.ok).map((x) => x.name).join(', ')})` : ''}`);
  else { const d = degenerateReason(checked.ir, c.unmapped ?? []); if (d) reasons.push(d); }
  if (!reasons.length && requested) {
    const warnings = [...params.notes];
    if (notes.unmapped.length) warnings.push(`${notes.unmapped.length} part${notes.unmapped.length === 1 ? '' : 's'} of the request could not be mapped to rules (see compile.unmapped in the JSON)`);
    if (notes.defaults) warnings.push(`${notes.defaults} default rule${notes.defaults === 1 ? ' was' : 's were'} filled in where the request was silent (see strategy_ir in the JSON)`);
    const r = await replay(requested, 'model', compile, params, deps, job, warnings);
    if (r.full.trades > 0) return r;
    reasons.push(`The compiled rules never triggered: 0 trades over ${r.window.bars} ${params.timeframe} bars (${params.days} days), so there is nothing to evaluate`);
  }
  return notMapped(params, deps, job, requested, compile, reasons);
}

/** 没映射上:跑最接近的支持模板做参考(明确标注不是买方的策略) */
async function notMapped(params: QuickBacktestParams, deps: QuickBacktestDeps, job: PerCallJob, requested: StrategyIR | null, compile: QuickResult['compile'], reasons: string[]): Promise<QuickResult> {
  const near = closestIdea(params.text, params.side), kwFamily = near.idea.family;
  // 参考结果本身也不能是 0 笔:带买方风控的模板 → 族缺省风控 → 通用通道突破,取第一个有成交的
  const plain = (i: TemplateIdea): TemplateIdea => ({ ...i, stop: null, target: null, trail: null, max_hold: null });
  const tries: { idea: TemplateIdea; note: string | null }[] = [{ idea: near.idea, note: null }];
  if (near.idea.stop || near.idea.target || near.idea.trail) tries.push({ idea: plain(near.idea), note: 'With the stop/target from your request the reference template never traded, so it is shown with its default risk rules' });
  if (near.idea.family !== 'breakout') tries.push({ idea: { source: 'template', family: 'breakout', args: { lookback: 20 }, stop: null, target: null, trail: null, max_hold: null }, note: 'The closest template never traded on this window, so the general channel-breakout template is shown' });
  let ref: QuickResult | null = null, used = tries[0]!;
  for (const t of tries) {
    const ir = buildIR(t.idea, params);
    if (!checkIR(ir, params.timeframe).ok) continue;
    ref = await replay(ir, 'template', null, params, deps, job, [...params.notes, ...(t.note ? [t.note] : [])]); used = t;
    if (ref.full.trades > 0) break;
  }
  if (!ref) { used = tries.at(-1)!; ref = await replay(buildIR(used.idea, params), 'template', null, params, deps, job, [...params.notes]); }
  near.idea = used.idea;
  return { ...ref, outcome: 'not_mapped', reference_family: near.idea.family, requested: { ir: requested, ir_hash: requested ? hash(requested) : null, compile, reasons, closest_by_keywords: near.matched && near.idea.family === kwFamily } };
}

/** 对外 IR 一律英文:模型写的中文标签 / 描述换成英文 */
function englishIR(ir: StrategyIR, params: QuickBacktestParams): StrategyIR {
  const out = { ...ir };
  if (CJK.test(out.label ?? '')) out.label = `Custom ${params.timeframe} strategy`;
  if (CJK.test(out.description ?? '')) out.description = `Model-compiled from the buyer's request${CJK.test(params.text) ? '' : `: ${params.text.slice(0, 200)}`}`;
  return out;
}

async function replay(ir: StrategyIR, ir_source: QuickResult['ir_source'], compile: QuickResult['compile'], params: QuickBacktestParams, deps: QuickBacktestDeps, job: PerCallJob, warnings: string[]): Promise<QuickResult> {
  // 模型编译出来的 IR 以 IR 的订单块为准(市场/方向),其余路径与解析结果一致
  const mkt: 'spot' | 'perp' = ir.order?.market === 'perp' ? 'perp' : 'spot';
  const step = timeframeMillis(params.timeframe), now = deps.now();
  const to_ms = Math.floor(now / step) * step - 1, from_ms = to_ms - params.days * 86_400_000;
  const warmup = irWarmup(ir, step), history = irHistoryBars(ir, step);
  const borrow = Math.max(Math.min(5000, Math.max(WARMUP_BARS, warmup)), Math.min(60000, history));
  const loaded = await deps.backtestBars!(params.symbol, params.timeframe, { from_ms: from_ms - borrow * step, to_ms }, mkt);
  const bars = loaded.bars.filter((b) => b.close_time <= to_ms);
  if (mkt === 'perp' && !loaded.perp) throw new Error('perp_data_missing: a perpetual backtest needs mark price, funding and margin tiers');
  const range = bars.length >= WARMUP_BARS + 3 ? tradingRange(bars, { from_ms, to_ms }, warmup) : null;
  if (!range) throw new Error(`data_missing: ${params.symbol} ${params.timeframe} has only ${bars.length} closed bars, not enough for a ${Math.max(WARMUP_BARS, warmup)}-bar warm-up${loaded.note ? '; ' + loaded.note : ''}`);
  if (range.warning) warnings.push(range.warning);
  if (!range.borrowed) warnings.push(`Not enough data before the window for warm-up; trading starts on ${new Date(bars[range.start]!.close_time + 1).toISOString().slice(0, 10)}`);
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
  if (stress.status !== 'completed') warnings.push(`The 2× fee stress run failed${stress.error && !CJK.test(stress.error) ? `: ${stress.error}` : ''}`);
  const is = samples.filter((s) => s.at <= split), oos = [...is.slice(-1), ...samples.filter((s) => s.at > split)];
  const segments = ([['in_sample', is, closed.filter((t) => t.entry_at <= split), win.from_ms, split], ['out_of_sample', oos, closed.filter((t) => t.entry_at > split), split + 1, win.to_ms]] as const)
    .filter(([, ss]) => ss.length >= 2).map(([name, ss, ts, f, t]) => ({ name, from_ms: f, to_ms: t, score: scoreOf(ss, [...ts], ts.reduce((a, x) => a + x.fees, 0)) }));
  const exit_reasons = closed.reduce<Record<string, number>>((a, t) => { a[t.exit_reason] = (a[t.exit_reason] ?? 0) + 1; return a; }, {});
  if (full.trades > 0 && full.trades < 30) warnings.push(`Only ${full.trades} closed trade${full.trades === 1 ? '' : 's'} over the full window, below the 30-trade minimum; treat the results as observational`);
  if (ir.order?.direction === 'short') warnings.push('Short strategy: the benchmark is still long buy-and-hold, so excess return includes the difference in direction');
  if (mkt === 'perp') warnings.push('Perpetual: 1× isolated margin; funding charged from the actual 8h funding series; maintenance margin tiers use current OKX values');
  return {
    ir, ir_hash: hash(ir), ir_source, compile, outcome: 'tested', window: { ...win, bars: range.end - range.start + 1 }, data_source: loaded.source, initial_cash: Number(base.initial_cash),
    fees: { taker, maker, slippage_bps: slip, stress_multiple: STRESS_FEE_MULTIPLE }, full, stressed, segments,
    yearly: periodReturns(samples, 'year'), exit_reasons, engine_version: run.engine_version, warnings: [...new Set(warnings)].slice(0, 16),
  };
}

// ---------------------------------------------------------------- 渲染(research-report.ts 调)

/** 买方可控的文字(IR 名称/描述、编译未映射片段)进人读正文前遮掉收益保证类词,免得整份交付被 BANNED_WORDS 拦下 */
const BANNED_G = new RegExp(BANNED_WORDS.source, 'gi');
export const scrub = (s: string): string => s.replace(BANNED_G, '***');

const nTrades = (n: number) => `${n} trade${n === 1 ? '' : 's'}`;
const money = (x: number | null | undefined): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: Math.abs(x) >= 1000 ? 0 : 2 });
/** 按年收益的年份标签:窗口首尾不满一整年的标「partial」并写明起止 */
export function yearLabel(period: string, from_ms: number, to_ms: number): string {
  const y = Number(period.slice(0, 4));
  if (!Number.isInteger(y)) return period;
  const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1) - 1, md = (t: number) => new Date(t).toISOString().slice(5, 10);
  const head = from_ms > start + 86_400_000 && from_ms <= end, tail = to_ms < end - 86_400_000 && to_ms >= start;
  if (head && tail) return `${y} (partial, ${md(from_ms)} to ${md(to_ms)})`;
  if (head) return `${y} (partial, from ${md(from_ms)})`;
  if (tail) return `${y} (partial, to ${md(to_ms)})`;
  return String(y);
}

/**
 * 外部模块(执行核 / 取数 / 窗口裁剪)写的中文注意事项 → 英文;认不出的中文注意只留在 JSON 的 warnings 里,不进正文。
 * 本文件自己写的注意事项已经是英文,原样返回。
 */
export function warningLine(w: string): string | null {
  if (!CJK.test(w)) return w;
  const hold = /^(\S+) 期末仍有持仓/.exec(w);
  if (hold) return `${hold[1]} still holds a position at the window end; it is marked to market at the last close and excluded from closed-trade stats`;
  const warm = /策略预热 (\d+) 根超过统一预热 (\d+) 根/.exec(w);
  if (warm) return `Strategy warm-up of ${warm[1]} bars exceeds the standard ${warm[2]} bars and there is not enough earlier data; the start is later than for other strategies and the benchmark shifts accordingly`;
  if (/持有基准仍是买入持有/.test(w)) return 'Short strategy: the benchmark is still long buy-and-hold, so excess return includes the difference in direction';
  if (/维持保证金分档/.test(w)) return 'Perpetual maintenance margin tiers use current OKX values, not historical ones';
  return null;
}

/** 支持的规则清单(没映射上时告诉买方可以直接下什么) */
export const SUPPORTED_RULES = 'Supported entry rules: N-bar high/low breakout, EMA crossover, MA trend (fast above slow), MA pullback limit entry, RSI or Bollinger mean reversion, SMC structure break, N consecutive green/red candles; risk: ATR or % stop, R-multiple or % target, chandelier trailing stop, max holding bars; or pass a full strategy_ir';
/** 每个族的一句可直接下单的示例(已验证能被 validateQuick 解析到同一族) */
export const FAMILY_EXAMPLE: Record<QuickFamily, (sym: string, tf: string, short: boolean) => string> = {
  breakout: (s, tf, sh) => `${s} ${tf}: ${sh ? 'short on a close below the prior 20-bar low' : 'go long on a close above the prior 20-bar high'}, 2 ATR stop, 3R target`,
  ema_cross: (s, tf, sh) => `${s} ${tf}: ${sh ? 'short when EMA20 crosses below EMA50' : 'go long when EMA20 crosses above EMA50'}, exit on the reverse cross`,
  ma_trend: (s, tf, sh) => `${s} ${tf}: MA trend, ${sh ? 'short while EMA20 is below EMA100' : 'long while EMA20 is above EMA100'}, 3 ATR stop`,
  pullback: (s, tf, sh) => `${s} ${tf}: ${sh ? 'short on a pullback to EMA20 in a downtrend' : 'buy the pullback to EMA20 in an uptrend'}, 1.5 ATR stop, 2.5R target`,
  mean_reversion: (s, tf, sh) => `${s} ${tf}: ${sh ? 'short when RSI14 crosses above 70' : 'go long when RSI14 drops below 30'}, target the middle Bollinger band`,
  smc: (s, tf) => `${s} ${tf}: SMC structure break (BOS) long, stop at the order block`,
  streak: (s, tf, sh) => `${s} ${tf}: ${sh ? 'short' : 'go long'} after 3 consecutive green candles, 2 ATR stop, 2R target`,
};

/** 回测数字行(测了的与参考模板共用) */
function metricLines(p: QuickBacktestParams, r: QuickResult): string[] {
  const f = r.full, day = (t: number) => new Date(t).toISOString().slice(0, 10), cash = r.initial_cash;
  const fees = `${r.ir.order?.market === 'perp' ? 'perpetual' : 'spot'} taker fee ${pct(r.fees.taker, 2)}${r.fees.maker !== null ? ` · maker fee ${pct(r.fees.maker, 2)}` : ''} · slippage ${r.fees.slippage_bps} bps`;
  const endEquity = Number.isFinite(cash) ? cash * (1 + f.total_return) : null;
  return [
    `Window: ${day(r.window.from_ms)} ~ ${day(r.window.to_ms)} · ${r.window.bars} ${p.timeframe} bars · data source ${r.data_source.slice(0, 80)}`,
    `Capital & costs: initial capital ${money(cash)} USDT, all available capital per trade, no leverage · ${fees} · the buy & hold benchmark pays the same fees`,
    `Full window: return ${pct(f.total_return)} (ending equity ${money(endEquity)} USDT) · CAGR ${pct(f.cagr)} · Sharpe ${num(f.sharpe)} · max drawdown ${pct(f.max_drawdown)} · win rate ${pct(f.win_rate)} · ${nTrades(f.trades)} · profit factor ${num(f.profit_factor)} · total fees ${money(f.fees)} USDT (${pct(Number.isFinite(cash) && cash > 0 ? f.fees / cash : null)} of initial capital)`,
    `Buy & hold: ${pct(f.benchmark_return)} · excess ${pct(f.excess_return)} · time in market ${pct(f.exposure)}`,
    ...r.segments.map((s) => `${s.name === 'in_sample' ? 'First 70%' : 'Last 30%'} (${day(s.from_ms)} ~ ${day(s.to_ms)}): return ${pct(s.score.total_return)}, buy & hold ${pct(s.score.benchmark_return)} · Sharpe ${num(s.score.sharpe)} · max drawdown ${pct(s.score.max_drawdown)} · ${nTrades(s.score.trades)}`),
    `By year: ${r.yearly.map((y) => `${yearLabel(y.period, r.window.from_ms, r.window.to_ms)} ${pct(y.return)} (hold ${pct(y.benchmark)})`).join(' · ') || '—'}`,
    `2× fee stress: return ${pct(r.stressed.total_return)} · Sharpe ${num(r.stressed.sharpe)} · max drawdown ${pct(r.stressed.max_drawdown)}`,
    ...(Object.keys(r.exit_reasons).length ? [`Exits: ${Object.entries(r.exit_reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${EXIT_REASON_TEXT[k] ?? k.replace(/_/g, ' ')} ${n}`).join(' · ')}`] : []),
  ];
}
const METHOD = 'Method: signals are evaluated on closed bars and filled at the next bar open; stops fill as stop-market orders and targets as limit orders, and the stop is checked first when both are hit in the same bar. One continuous full-window replay; the first 70% / last 30% split is a time label only, not an out-of-sample test after parameter tuning';
const ruleText = (r: QuickResult): string => {
  const rawDesc = (r.ir.description ?? r.ir.label).replace(/[;；]?\s*100% of available capital per trade/g, '').replace(/[;；]?\s*每笔 100% 可用资金/g, '');
  // 买方 / 模型给的 IR 描述可能是中文:正文不转述原文,只说明规则在 JSON 的 strategy_ir 里
  return CJK.test(rawDesc) || /^Model-compiled from the buyer's request/.test(rawDesc) ? 'custom rules (full definition in strategy_ir in the JSON)' : scrub(rawDesc.slice(0, 300));
};
const sideText = (r: QuickResult) => r.ir.order?.market !== 'perp' ? 'spot long' : r.ir.order.direction === 'short' ? 'perpetual short' : 'perpetual long';

export function quickLines(p: QuickBacktestParams, r: QuickResult): { summary: string; lines: string[] } {
  if (r.outcome === 'not_mapped') return notMappedLines(p, r);
  const f = r.full;
  const verdict = f.trades === 0 ? 'no trades triggered in the window'
    : `${f.total_return >= 0 ? 'net positive over the full window' : 'net loss over the full window'}${f.excess_return === null ? '' : f.excess_return >= 0 ? ', ahead of buy & hold' : ', behind buy & hold'}${Number.isFinite(r.stressed.total_return) && r.stressed.total_return <= 0 && f.total_return > 0 ? ', turns negative at 2× fees' : ''}`;
  const label = scrub(r.ir.label.slice(0, 40));
  const famName = r.ir_source === 'template' && p.idea.source === 'template' ? QUICK_FAMILY_LABEL[p.idea.family] : CJK.test(label) ? 'Custom strategy' : label;
  const summary = `${p.symbol.replace(/USDT$/, '')} ${p.timeframe} ${famName}: return ${pct(f.total_return)}, buy & hold ${pct(f.benchmark_return)} · Sharpe ${num(f.sharpe)} · max drawdown ${pct(f.max_drawdown)} · ${nTrades(f.trades)} (${verdict})`;
  const source = r.ir_source === 'template' ? 'deterministic template' : r.ir_source === 'ir' ? 'buyer-supplied IR' : `model-compiled${r.compile?.model ? ` (${r.compile.model})` : ''}`;
  const notes = [...new Set(r.warnings.map(warningLine).filter((x): x is string => !!x))];
  const unmapped = r.ir_source === 'model' ? (r.compile?.unmapped ?? []) : [];
  const heads = unmapped.filter((x) => x.startsWith('Not mapped: ')).map((x) => scrub(x.slice(12, 90)));
  const zero = f.trades === 0 && r.ir_source !== 'model'
    ? [`Why no trades: the entry condition never became true on ${p.symbol.replace(/USDT$/, '')} ${p.timeframe} over this window (for example a threshold that is too extreme or filters that never align). Loosen the entry threshold or try another timeframe; the numbers below are all zero for that reason`] : [];
  const lines = [
    `Strategy: ${ruleText(r)} (${sideText(r)}; rules from ${source})`,
    ...(unmapped.length ? [`Mapping: ${unmapped.length} part${unmapped.length === 1 ? '' : 's'} of the request had no supported rule and ${unmapped.length === 1 ? 'was' : 'were'} left out${heads.length ? ` (${heads.join('; ')})` : ''}; the results below cover only the mapped rules`] : []),
    ...zero,
    ...metricLines(p, r),
    ...notes.slice(0, 6).map((w) => `Note: ${scrub(w)}`),
    METHOD,
  ];
  return { summary, lines };
}

/** 买方的规则没映射上:明说没测、为什么,给最接近的支持模板的参考结果与可直接下单的改写 */
function notMappedLines(p: QuickBacktestParams, r: QuickResult): { summary: string; lines: string[] } {
  const f = r.full, fam = r.reference_family ?? 'breakout', sym = p.symbol.replace(/USDT$/, ''), rq = r.requested;
  const summary = `${sym} ${p.timeframe}: your rule could not be mapped to supported backtest rules, so it was not tested as described · reference (closest supported template, ${QUICK_FAMILY_LABEL[fam]}): return ${pct(f.total_return)}, buy & hold ${pct(f.benchmark_return)} · ${nTrades(f.trades)}`;
  const heads = (rq?.compile?.unmapped ?? []).map((x) => scrub(x.replace(/^Not mapped: /, '').slice(0, 120)));
  const short = r.ir.order?.direction === 'short';
  const lines = [
    `Status: NOT TESTED AS DESCRIBED. ${(rq?.reasons ?? []).map(scrub).join('. ')}`,
    ...(heads.length ? [`Could not map: ${heads.join('; ')}`] : []),
    `We did not deliver a 0-trade or placeholder backtest. Instead, below is a reference run of the closest supported template on the same asset, timeframe and window${rq?.closest_by_keywords ? ' (picked from keywords in your request)' : ' (no close match found; the general channel-breakout template is shown)'}. It is NOT your strategy`,
    `Reference strategy: ${ruleText(r)} (${sideText(r)}; deterministic template)`,
    ...metricLines(p, r),
    ...[...new Set(r.warnings.map(warningLine).filter((x): x is string => !!x))].slice(0, 4).map((w) => `Note: ${scrub(w)}`),
    SUPPORTED_RULES,
    `Next step: rephrase the entry as one supported rule and order again, e.g. "${FAMILY_EXAMPLE[fam](sym, p.timeframe, short)}". If this reference is not useful to you, you can reject this delivery`,
    METHOD,
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
