/**
 * 订阅频道 market_brief:行情简报,每 4 小时一份(对齐 UTC 0/4/8/12/16/20 点的槽,event_id 用槽起点),所有订阅者共用一份。
 *
 * 内容全部来自代码计算:BTC/ETH 近 4 小时背景(OKX 公共接口:15m K 线区间与涨跌、持仓量 4h/24h 变化、资金费率折算每 8h + 年化)、
 * 清算(录制器)、日线 regime、每日全市场扫描、全市场资金费率极值(实时全量接口,折算每 8h;接口挂了退日快照 + 缓存的结算周期)。
 * 可选 summarize 钩子让便宜模型写两三句人话;缺省或返回 null 用确定性模板。只给分析和依据,不给买卖指令。
 * 某块数据取不到就写「暂缺」,不让整份失败。
 *
 * 数据时效:
 *   - BTC/ETH 现价 = OKX 永续盘口中间价(录制器,同一份简报只出现这一个价);没有盘口才退回实时行情 / 日快照 / 15m 收盘并标注。
 *   - 日线与扫描一天才变一次:和上一份同源时压成一行(仍列出标的),不写空洞的「unchanged」。
 * 所有提到的标的都按「资产 × 周期」服务同一口径过滤:只列 OKX 上有 USDT 永续的(tradable(symbol,'perp'))。
 * 推送正文全英文(OKX.AI 买家与审核是国际用户),不得出现中日韩字符;上游中文理由只保留能按结构翻成英文的,其余丢掉。
 * JSON 不拼进聊天正文(payload 完整保留)。每份推送显式带订阅信号行(【Futures】类型头、≤200 字)。
 */
import type { DailyRegime } from '../../types.js';
import type { UniverseAsset, UniverseScanSummary } from '../../universe-okx.js';
import { okxGet } from '../../market-okx.js';
import { BANNED_WORDS } from '../publisher.js';
import { infoSignal } from './broadcast.js';
import { bookStats, sumLiquidations, usd, type MicroSource } from './micro-source.js';
import { MAX_TEXT, clean, num, sha256Of } from './render.js';
import type { ChannelDeps, ChannelKey, ChannelPush, SubscriptionChannel } from './types.js';

// ---------------------------------------------------------------- 频道共用渲染

/** `2026-09-25 14:30 UTC` */
export function utcLabel(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
/** 数据时点的短写:与 ref 同一 UTC 日 → `14:30 UTC`,否则 `09-24 14:30 UTC` */
export function asOfLabel(ms: number, ref: number): string {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10) === new Date(ref).toISOString().slice(0, 10) ? `${iso.slice(11, 16)} UTC` : `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC`;
}
/** BTCUSDT → BTC */
export const baseOf = (symbol: string): string => symbol.replace(/-?USDT(-SWAP)?$/i, '');
export const price = (x: number | null | undefined): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : x >= 1000 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toPrecision(4);
/** 失衡 ±x.xx,绝对值太小的不写成 -0.00 */
export const imbalanceText = (x: number | null | undefined): string => { if (x === null || x === undefined || !Number.isFinite(x)) return '—'; const v = Math.abs(x) < 0.005 ? 0 : x; return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`; };
export const signedPct = (x: number | null | undefined, digits = 1): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`;
/** `1 liquidation` / `2 liquidations` */
export const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

/**
 * 订阅频道的英文免责声明(render.ts 的 DISCLAIMER 仍是中英双语,主线程之后统一收口;频道这边先自带英文版)
 */
export const CHANNEL_DISCLAIMER = 'Rule-based analysis of OKX market data. Not investment advice.';
export const CHANNEL_DISCLAIMER_AI = 'Includes AI-generated commentary on top of rule-based analysis of OKX market data. Not investment advice.';
/** 中日韩字符:推送正文里一个都不许有 */
export const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef\u3000-\u303f]/;

/** 模型人话 / 候选理由里不许出现操作指令(模板本身不写) */
export const INSTRUCTION_WORDS = new RegExp([
  '买入|卖出|做多|做空|开多|开空|开仓|平仓|加仓|减仓|抄底|追多|追空|止损|止盈|入场|离场',
  '\\b(?:buy|buying|sell|selling)\\b',
  '\\b(?:go|going|went)\\s+(?:long|short)\\b',
  '\\b(?:long|short)\\s+it\\b',
  '\\bentr(?:y|ies)\\b',
  '\\bstop[- ]?loss(?:es)?\\b',
  '\\btake[- ]?profits?\\b',
  '\\b(?:open|opening|close|closing|enter|entering|exit|exiting|add|adding|trim|trimming|reduce|reducing)\\s+(?:to\\s+)?(?:a\\s+|an\\s+|the\\s+|your\\s+)?(?:long|short|position|trade)s?\\b',
].join('|'), 'i');
/** 推荐 / 指令语气(不是买卖动词,但读起来像在叫人操作);只用于过滤理由类自由文本,不查整段(免责声明里有「投资建议」) */
export const ADVICE_WORDS = new RegExp([
  '首选|顺势|逆势|可盯|盯住|盯紧|可并列盯|建议|值得|机会|上车|埋伏|布局|介入|低吸|高抛|先不做|可以做|可做',
  '\\b(?:recommend\\w*|suggest\\w*|advis(?:e|able|ed)|should|must|ought)\\b',
  '\\b(?:top|best|first|strong)[- ]?(?:pick|choice|idea)s?\\b',
  '\\bopportunit(?:y|ies)\\b',
  '\\bworth\\w*\\b',
  '\\bconsider\\w*\\b',
  '\\b(?:keep an eye|watch (?:closely|for)|on (?:the|your) radar|don\'?t miss|jump in|get in)\\b',
  '\\b(?:accumulat\\w*|load(?:ing)? up|bottom[- ]?fish\\w*|dip[- ]?buy\\w*|buy(?:ing)? the dip|fade|fading|chase|chasing)\\b',
  '\\b(?:with|against) the trend\\b',
  '\\bstand aside\\b|\\bsit (?:this|it) out\\b',
].join('|'), 'i');
/**
 * 理由类文字的合规兜底:按句 / 分句(。;;!!??,,)切开,含指令词或推荐语气的分句整段删掉,剩下的拼回去。
 * 全被删掉返回空串(调用方把空理由丢掉)。
 */
export function scrubInstructions(s: string): string {
  // 中文标点直接切;英文标点后面跟空白才切(不切 0.86 这类小数)
  const parts = String(s).split(/(?<=[。;;!!??,,])|(?<=[.;!?,])(?=\s)/);
  return parts.filter((p) => !INSTRUCTION_WORDS.test(p) && !ADVICE_WORDS.test(p)).join('').replace(/[,,;;\s]+$/, '').replace(/^[,,;;。.\s]+/, '').trim();
}

/**
 * 内置策略 id → 英文名(与 strategies.ts BUILTIN_STRATEGIES 一一对应;扫描 / 雷达候选的 strategy_id 都来自那里或实验室自定义策略)。
 */
export const STRATEGY_LABEL: Record<string, string> = {
  breakout_retest: 'Breakout retest', mtf_alignment: 'Multi-timeframe alignment', vol_compression_expansion: 'Volatility squeeze → expansion',
  funding_oi_extreme: 'Funding/OI extreme', range_mean_reversion: 'Range mean reversion',
  swing_breakout_retest: 'Swing breakout retest', position_breakout_retest: 'Long-term breakout retest',
};
/** 周期前缀的变体(swing_/position_/intraday_ + 内置 id)查不到全名时按前缀拼 */
const HORIZON_PREFIX_LABEL: Record<string, string> = { intraday: 'Intraday', swing: 'Swing', position: 'Long-term' };
/** 自定义 / 未知策略 id 不原样外露,统一写这个 */
export const CUSTOM_STRATEGY_LABEL = 'Custom strategy';
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
export const strategyName = (id: string | null | undefined): string | null => {
  if (!id) return null;
  const hit = STRATEGY_LABEL[id];
  if (hit) return hit;
  const m = /^(intraday|swing|position)_(.+)$/.exec(id);
  const inner = m ? STRATEGY_LABEL[m[2]!] : undefined;
  return m && inner ? `${HORIZON_PREFIX_LABEL[m[1]!]} ${lowerFirst(inner)}` : CUSTOM_STRATEGY_LABEL;
};
/** 策略族 key(research/batch/families.ts FamilyKey)→ 英文;未知族写 Other */
export const FAMILY_LABEL: Record<string, string> = {
  breakout: 'Channel breakout', ma_trend: 'MA trend', ema_cross: 'EMA crossover', pullback: 'Pullback to MA', mean_reversion: 'Mean reversion',
  smc: 'SMC structure break', xsmom: 'Cross-sectional momentum', carry: 'Funding carry',
};
export const familyName = (k: string): string => FAMILY_LABEL[k] ?? 'Other';
/** 日线状态 → 英文 */
export const REGIME_LABEL: Record<DailyRegime['regime'], string> = { bull: 'bullish', bear: 'bearish', range: 'ranging', volatile: 'volatile' };
/**
 * 扫描器写的「契合 0.86(6/7 条通过,1 条差一点)」→「Checklist 6/7 met (1 more close)」;
 * 只有分数没有条数时写「Checklist fit 0.77」。其余文字不动。
 */
export function fitReasonText(s: string): string {
  return String(s).replace(/契合\s*(\d+(?:\.\d+)?)(?:\s*[((](\d+)\/(\d+)\s*条通过(?:[,,]\s*(\d+)\s*条差一点)?[))])?/g,
    (_m, score: string, a?: string, b?: string, near?: string) => a && b ? `Checklist ${a}/${b} met${near ? ` (${near} more close)` : ''}` : `Checklist fit ${score}`);
}
/**
 * 扫描 / 雷达候选理由(上游多为中文)→ 英文:认得的句式按结构重写,其余不含中日韩字符的原样留,
 * 还含中日韩字符的整条丢掉(返回 null)。之后仍要过 scrubInstructions。
 */
export function englishReason(raw: string): string | null {
  const s = fitReasonText(String(raw).trim());
  let m: RegExpExecArray | null;
  if ((m = /^OKX\s*(永续|现货)\s*[,,]\s*24h\s*成交额第\s*(\S+)\s*\/\s*(\d+)$/.exec(s))) return `OKX ${m[1] === '永续' ? 'perp' : 'spot'}, #${m[2]} of ${m[3]} by 24h volume`;
  if ((m = /^近\s*(\d+)\s*天机械期望\s*(-?\d+(?:\.\d+)?)R\s*[,,]\s*(\d+)\s*笔$/.exec(s))) return `Rule-based expectancy ${m[2]}R over ${plural(Number(m[3]), 'trade')} (last ${m[1]} days)`;
  if ((m = /^还差\s*[::]\s*(.+)$/.exec(s))) return `${plural(m[1]!.split(/[;;]/).filter((x) => x.trim()).length, 'checklist condition')} not yet met`;
  return CJK.test(s) ? null : s;
}

/**
 * 频道推送渲染:标题 + 摘要 + 要点 + 免责声明 + 短校验码。JSON 不进聊天正文,完整结构化数据(含 sha256)在 payload。
 * 整段文字与 payload 过 BANNED_WORDS,命中直接抛错,不推。超长时从末尾砍要点行。
 */
export function channelPush(channel: ChannelKey, event_id: string, title: string, summary: string, lines: string[], body: Record<string, unknown>, opts: { ai?: boolean; signal?: string } = {}): ChannelPush {
  const payload = clean({ channel, event_id, source: 'trading-swarm', version: 1, ...body });
  const sha256 = sha256Of(payload);
  const tail = [opts.ai ? CHANNEL_DISCLAIMER_AI : CHANNEL_DISCLAIMER, `Checksum (sha256): ${sha256.slice(0, 16)}`];
  const full = [title, summary, ...lines, ...tail].join('\n');
  if (BANNED_WORDS.test(full) || BANNED_WORDS.test(summary) || BANNED_WORDS.test(JSON.stringify(payload)) || (opts.signal && BANNED_WORDS.test(opts.signal))) throw new Error(`${channel}_banned_words`);
  let text = full;
  for (let keep = lines.length - 1; text.length > MAX_TEXT && keep >= 0; keep--) text = [title, summary, ...lines.slice(0, keep), '(Truncated; the rest is in the structured data.)', ...tail].join('\n');
  // 订阅信号行(【Futures】类型头、≤200 字):频道显式给,扇出不再按 summary/payload 派生
  return { event_id, channel, summary, text, payload: { ...payload, sha256 }, ...(opts.signal ? { signal: opts.signal } : {}) };
}

/** 给一段取数加超时 + 兜底:失败返回 null 并记日志,不抛 */
export async function safely<T>(deps: Pick<ChannelDeps, 'log'>, name: string, fn: () => T | Promise<T>, timeout_ms = 20_000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${timeout_ms}ms`)), timeout_ms); }),
    ]);
  } catch (e) {
    deps.log('warn', `${name} 取数失败:${(e as Error).message}`);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}

/** OKX 可交易判定(可选依赖);没提供 → 不过滤;抛错 → 不过滤并记日志 */
export type TradableFn = (symbol: string, market?: 'spot' | 'perp') => boolean;
export function tradableCheck(deps: Pick<ChannelDeps, 'log'> & { tradable?: TradableFn }, symbol: string, markets: readonly ('spot' | 'perp')[]): boolean {
  if (!deps.tradable) return true;
  try { return markets.some((m) => deps.tradable!(symbol, m)); } catch (e) { deps.log('warn', `tradable ${symbol} 判定失败,按可交易处理:${(e as Error).message}`); return true; }
}

// ---------------------------------------------------------------- 简报

export interface BriefConfig {
  symbols: string[];
  scan_top: number;
  funding_top: number;
  /** 资金费率极值只看永续 24h 成交额够的,免得被没人交易的小币刷屏 */
  funding_min_perp_vol_usd: number;
  /** 清算统计窗口(默认 = 一个简报周期,两份之间不漏不重) */
  liq_window_ms: number;
  /** 录制器至少覆盖这么久才给清算数,否则写暂缺(0 可能只是没录到) */
  liq_min_covered_ms: number;
  book_band_pct: number;
  /** welcome 复用最近一份简报的时限 */
  welcome_reuse_ms: number;
  /** 单块取数超时 */
  block_timeout_ms: number;
}
export const BRIEF_EVERY_MS = 4 * 3_600_000;
export const BRIEF_DEFAULTS: BriefConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  scan_top: 5,
  funding_top: 3,
  funding_min_perp_vol_usd: 5_000_000,
  liq_window_ms: BRIEF_EVERY_MS,
  liq_min_covered_ms: 30 * 60_000,
  book_band_pct: 0.005,
  welcome_reuse_ms: 45 * 60_000,
  block_timeout_ms: 20_000,
};
/** broadcaster 检查频率:槽内重复 tick 直接回放同一份(不取数),槽起点后 5 分钟内出新一份 */
export const BRIEF_TICK_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------- 4 小时行情背景(OKX 公共接口)

/** 当期资金费率 + 结算周期(小时,= nextFundingTime − fundingTime);next_at = 本期结算时刻 */
export interface FundingPoint { rate: number; interval_h: number | null; next_at: number | null }
/** 折算到每 8 小时(OKX 永续有 1h/2h/4h/8h 结算周期,不折算没法横比);周期未知返回 null */
export const fundingPer8h = (f: Pick<FundingPoint, 'rate' | 'interval_h'>): number | null => f.interval_h && f.interval_h > 0 ? f.rate * 8 / f.interval_h : null;
/** 年化(单利,rate × 每年结算次数) */
export const fundingAnnualized = (f: Pick<FundingPoint, 'rate' | 'interval_h'>): number | null => f.interval_h && f.interval_h > 0 ? f.rate * (24 / f.interval_h) * 365 : null;

export interface MajorContext {
  funding: FundingPoint | null;
  /** 持仓量(美元);scope=usdt_perp 为该 USDT 永续,all_contracts 为该币全部合约(接口降级时) */
  oi: { usd: number; at: number; chg_4h_pct: number | null; chg_24h_pct: number | null; scope: 'usdt_perp' | 'all_contracts' } | null;
  /** 15 分钟 K 线算的近 4h / 24h 区间与涨跌 */
  range: { at: number; last: number; chg_4h_pct: number | null; chg_24h_pct: number | null; hi_4h: number; lo_4h: number; hi_24h: number; lo_24h: number } | null;
}
export interface BriefContext {
  at: number;
  majors: Record<string, MajorContext>;
  /** 全部 USDT 永续的当期资金费率(funding-rate?instId=ANY,一次请求);取不到为 null */
  funding: ({ symbol: string } & FundingPoint)[] | null;
}
export type OkxGetFn = <T>(path: string, timeoutMs?: number, retries?: number) => Promise<T>;

const instOf = (symbol: string): string => `${baseOf(symbol)}-USDT-SWAP`;
const symbolOfInst = (inst: string): string | null => { const m = /^([A-Z0-9]+)-USDT-SWAP$/.exec(inst); return m ? `${m[1]}USDT` : null; };
const pctChange = (cur: number, ref: number | null): number | null => ref !== null && ref > 0 && Number.isFinite(cur) ? (cur / ref - 1) * 100 : null;

export function fundingFromRaw(r: Record<string, unknown>): FundingPoint | null {
  const rate = Number(r['fundingRate']);
  if (r['fundingRate'] === '' || r['fundingRate'] === undefined || !Number.isFinite(rate)) return null;
  const ft = Number(r['fundingTime']), nft = Number(r['nextFundingTime']);
  const h = ft > 0 && nft > ft ? Math.round((nft - ft) / HOUR_MS) : null;
  return { rate, interval_h: h && h > 0 ? h : null, next_at: ft > 0 ? ft : null };
}
/** 新→旧的 [ts, value] 里,取 ts ≤ t 的最近一行 */
function valueAt(rows: [number, number][], t: number): number | null {
  for (const [ts, v] of rows) if (ts <= t) return v;
  return null;
}
/** OKX 持仓历史行 → 当前值 + 4h/24h 变化;cur 为实时持仓(没有就用最新一行) */
export function oiFromRows(rows: [number, number][], cur: { usd: number; at: number } | null, scope: 'usdt_perp' | 'all_contracts'): MajorContext['oi'] {
  const sorted = rows.filter(([ts, v]) => Number.isFinite(ts) && Number.isFinite(v) && v > 0).sort((a, b) => b[0] - a[0]);
  const now = cur ?? (sorted[0] ? { usd: sorted[0][1], at: sorted[0][0] } : null);
  if (!now) return null;
  return { usd: now.usd, at: now.at, chg_4h_pct: pctChange(now.usd, valueAt(sorted, now.at - 4 * HOUR_MS)), chg_24h_pct: pctChange(now.usd, valueAt(sorted, now.at - 24 * HOUR_MS)), scope };
}
/** 15 分钟 K 线(OKX 原始行,新→旧)→ 近 4h / 24h 区间与涨跌 */
export function rangeFromCandles(rows: unknown[][], now: number): MajorContext['range'] {
  const BAR = 15 * 60_000;
  const bars = rows.map((r) => ({ ts: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }))
    .filter((b) => [b.ts, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.ts <= now).sort((a, b) => a.ts - b.ts);
  const in4 = bars.filter((b) => b.ts + BAR > now - 4 * HOUR_MS);
  const in24 = bars.filter((b) => b.ts + BAR > now - 24 * HOUR_MS);
  if (!in4.length) return null;
  const last = bars[bars.length - 1]!;
  const hi = (xs: typeof bars): number => Math.max(...xs.map((b) => b.h));
  const lo = (xs: typeof bars): number => Math.min(...xs.map((b) => b.l));
  return {
    at: last.ts, last: last.c,
    chg_4h_pct: in4[0]!.ts <= now - 4 * HOUR_MS + BAR ? pctChange(last.c, in4[0]!.o) : null,
    // 24h 覆盖不全(新币 / 接口只回了一部分)就不给 24h 变化
    chg_24h_pct: in24[0]!.ts <= now - 24 * HOUR_MS + BAR ? pctChange(last.c, in24[0]!.o) : null,
    hi_4h: hi(in4), lo_4h: lo(in4), hi_24h: hi(in24), lo_24h: lo(in24),
  };
}

/**
 * 默认取数:OKX 公共 REST。一份简报 = 1 次全市场资金费率 + 每个主流币 3 次(实时持仓、1h 持仓历史、15m K 线);
 * 持仓历史失败退到该币全部合约的 1h 持仓(rubik open-interest-volume);全市场资金费率失败退到单币资金费率。
 * 任何一块失败只让那一块为 null。
 */
export async function okxBriefContext(symbols: string[], now: number, get: OkxGetFn = okxGet): Promise<BriefContext> {
  const soft = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const [allRaw, ...per] = await Promise.all([
    soft(get<Record<string, unknown>[]>('/api/v5/public/funding-rate?instId=ANY', 15_000)),
    ...symbols.map(async (s): Promise<[string, MajorContext]> => {
      const inst = instOf(s);
      const [cur, hist, candles] = await Promise.all([
        soft(get<Record<string, unknown>[]>(`/api/v5/public/open-interest?instType=SWAP&instId=${inst}`)),
        soft(get<unknown[][]>(`/api/v5/rubik/stat/contracts/open-interest-history?instId=${inst}&period=1H&limit=26`)),
        soft(get<unknown[][]>(`/api/v5/market/candles?instId=${inst}&bar=15m&limit=96`)),
      ]);
      const c0 = cur?.[0];
      const curUsd = c0 ? { usd: Number(c0['oiUsd']), at: Number(c0['ts']) } : null;
      const live = curUsd && Number.isFinite(curUsd.usd) && curUsd.usd > 0 && Number.isFinite(curUsd.at) ? curUsd : null;
      let oi: MajorContext['oi'] = null;
      if (hist?.length) oi = oiFromRows(hist.map((r) => [Number(r[0]), Number(r[3])]), live, 'usdt_perp');
      if (!oi) {
        const agg = await soft(get<unknown[][]>(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${baseOf(s)}&period=1H`));
        if (agg?.length) oi = oiFromRows(agg.map((r) => [Number(r[0]), Number(r[1])]), null, 'all_contracts');
      }
      return [s, { funding: null, oi, range: candles?.length ? rangeFromCandles(candles, now) : null }];
    }),
  ]);
  const funding = allRaw?.length
    ? allRaw.flatMap((r) => { const sym = symbolOfInst(String(r['instId'] ?? '')); const f = sym ? fundingFromRaw(r) : null; return sym && f ? [{ symbol: sym, ...f }] : []; })
    : null;
  const majors = Object.fromEntries(per);
  for (const s of symbols) {
    let f = funding?.find((x) => x.symbol === s) ?? null;
    if (!f) { const one = await soft(get<Record<string, unknown>[]>(`/api/v5/public/funding-rate?instId=${instOf(s)}`)); const p = one?.[0] ? fundingFromRaw(one[0]) : null; f = p ? { symbol: s, ...p } : null; }
    majors[s]!.funding = f ? { rate: f.rate, interval_h: f.interval_h, next_at: f.next_at } : null;
  }
  return { at: now, majors, funding: funding?.length ? funding : null };
}
/** 默认取数的进程内缓存:同一分钟内的 tick / welcome 复用一份,不重复打接口 */
let contextCache: { key: string; at: number; value: BriefContext } | null = null;
const CONTEXT_CACHE_MS = 60_000;
async function cachedOkxContext(symbols: string[], now: number): Promise<BriefContext> {
  const key = symbols.join(',');
  if (contextCache && contextCache.key === key && Math.abs(now - contextCache.at) < CONTEXT_CACHE_MS) return contextCache.value;
  const value = await okxBriefContext(symbols, now);
  contextCache = { key, at: now, value };
  return value;
}

// ---------------------------------------------------------------- 事实收集

export interface BriefFacts {
  slot: number;
  generated_at: number;
  majors: {
    symbol: string;
    /** 现价:优先 OKX 永续盘口中间价 */
    price: number | null;
    price_source: 'book_mid' | 'ticker' | 'snapshot' | null;
    price_at: number | null;
    /** 24h 涨跌 %(0.38 = +0.38%) */
    change_24h_pct: number | null;
    change_source: 'ticker' | 'snapshot' | null;
    change_at: number | null;
    regime: { kind: DailyRegime['regime']; ret_20d_pct: number; ret_5d_pct: number; atr_pct: number; vol_pct_rank: number; ema_stack: string; as_of: number } | null;
    /** 4 小时背景:资金费率(含结算周期)、持仓量变化、近 4h/24h 区间;取不到为 null */
    ctx: MajorContext | null;
  }[];
  scan: { at: number | null; screen_id: string | null; scanned: number; untradable_dropped: number; top: { rank: number; symbol: string; strategy_id: string | null; score: number; reasons: string[] }[] } | null;
  /** 资金费率极值:source=live 为 OKX 实时全市场费率(updated_at = 取数时刻),snapshot 为全集日快照 + 缓存的结算周期 */
  funding: { updated_at: number | null; source: 'live' | 'snapshot'; highest: FundingRow[]; lowest: FundingRow[] } | null;
  books: Record<string, { at: number; mid: number; spread_bps: number; bid_depth_usd: number; ask_depth_usd: number; imbalance: number | null; visible_pct: number } | null>;
  /** 清算(OKX 永续);covered_ms < window_ms 表示录制器只覆盖了窗口的一部分 */
  liquidations: Record<string, { window_ms: number; covered_ms: number; long_usd: number; short_usd: number; total_usd: number; count: number } | null>;
  /** 取不到的块 */
  missing: string[];
}
/** rate = 单期费率(小数);rate_8h = 折算到每 8 小时;interval_h = 结算周期 */
export interface FundingRow { symbol: string; rate: number; interval_h: number; rate_8h: number; perp_quote_volume_24h: number | null }

export interface BriefDeps {
  /** runtime: dailyRegimeFor(symbol) */
  regime(symbol: string): Promise<DailyRegime | null>;
  /** runtime: latestUniverseScan(store.marketDb, { limit }) */
  scan(limit: number): UniverseScanSummary | Promise<UniverseScanSummary>;
  /** runtime: currentUniverse() */
  universe(): { updated_at: number | null; items: UniverseAsset[] } | null | Promise<{ updated_at: number | null; items: UniverseAsset[] } | null>;
  /** BTC/ETH 盘口 + 清算;没有录制器传 null */
  micro: MicroSource | null;
  /** 可选:OKX 上有没有对应市场(默认 perp);没提供不过滤 */
  tradable?: TradableFn;
  /** 可选:实时 24h 行情,change_24h 单位 %(0.38 = +0.38%);取不到的币不在返回里 */
  tickers?(symbols: string[]): Promise<Record<string, { last: number; change_24h: number }>>;
  /**
   * 可选:4 小时背景(资金费率 / 持仓量 / 区间)。缺省 = okxBriefContext(OKX 公共接口,带 1 分钟缓存;vitest 下不联网);
   * 传 null 关掉。
   */
  context?: ((symbols: string[], now: number) => Promise<BriefContext | null>) | null;
  /** 便宜模型写两三句人话;缺省/返回 null/抛错 → 确定性模板 */
  summarize?(facts: BriefFacts): Promise<string | null>;
  brief_config?: Partial<BriefConfig>;
}

export const slotOf = (ms: number): number => Math.floor(ms / BRIEF_EVERY_MS) * BRIEF_EVERY_MS;
const numOrNull = (s: string | number | null | undefined): number | null => { if (s === null || s === undefined || s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

/** 结算周期缓存(全市场费率接口失败时,日快照的单期费率靠它折算) */
const INTERVALS_KEY = 'brief:funding_intervals';
function loadIntervals(deps: ChannelDeps): Record<string, number> {
  try { const raw = deps.state.get(INTERVALS_KEY); return raw ? JSON.parse(raw) as Record<string, number> : {}; } catch { return {}; }
}

function contextFn(deps: BriefDeps): ((symbols: string[], now: number) => Promise<BriefContext | null>) | null {
  if (deps.context !== undefined) return deps.context;
  return process.env['VITEST'] ? null : cachedOkxContext;
}

export async function collectBriefFacts(deps: ChannelDeps & BriefDeps, now: number): Promise<BriefFacts> {
  const cfg = { ...BRIEF_DEFAULTS, ...deps.brief_config };
  const missing: string[] = [];
  const t = cfg.block_timeout_ms;
  const ctxFn = contextFn(deps);
  const [universe, scan, tickers, ctx] = await Promise.all([
    safely(deps, 'universe', () => deps.universe(), t),
    safely(deps, 'scan', () => deps.scan(cfg.scan_top * 4), t),
    deps.tickers ? safely(deps, 'tickers', () => deps.tickers!(cfg.symbols), t) : Promise.resolve(null),
    ctxFn ? safely(deps, 'context', () => ctxFn(cfg.symbols, now), t) : Promise.resolve(null),
  ]);
  const items = universe?.items ?? [];
  if (!items.length) missing.push('universe');
  const snapAt = universe?.updated_at ?? null;

  // 盘口在前:BTC/ETH 现价取盘口中间价
  const books: BriefFacts['books'] = {};
  const liquidations: BriefFacts['liquidations'] = {};
  const micro = deps.micro;
  for (const symbol of cfg.symbols) {
    books[symbol] = null; liquidations[symbol] = null;
    if (!micro || !micro.symbols().includes(symbol)) { missing.push(`book:${symbol}`, `liq:${symbol}`); continue; }
    const book = await safely(deps, `book ${symbol}`, () => micro.book(symbol, now), t);
    const st = book ? bookStats(book, { band_pct: cfg.book_band_pct }) : null;
    if (book && st) books[symbol] = { at: book.at, mid: st.mid, spread_bps: st.spread_bps, bid_depth_usd: st.bid_depth_usd, ask_depth_usd: st.ask_depth_usd, imbalance: st.imbalance, visible_pct: st.visible_pct };
    else missing.push(`book:${symbol}`);
    // 清算:录制器要活着(最新一帧 5 分钟内)且至少覆盖 liq_min_covered_ms;只覆盖一部分窗口就按覆盖段算并标注
    const cov = await safely(deps, `coverage ${symbol}`, () => micro.coverage(symbol, now), t);
    const from = cov ? Math.max(now - cfg.liq_window_ms, cov.from_ms) : now;
    const covered = cov && cov.to_ms >= now - 5 * 60_000 ? now - from : 0;
    const liqs = covered >= Math.min(cfg.liq_min_covered_ms, cfg.liq_window_ms) ? await safely(deps, `liq ${symbol}`, () => micro.liquidations(symbol, from, now), t) : null;
    if (liqs) { const s = sumLiquidations(liqs); liquidations[symbol] = { window_ms: cfg.liq_window_ms, covered_ms: covered, long_usd: s.long_usd, short_usd: s.short_usd, total_usd: s.total_usd, count: s.count }; }
    else missing.push(`liq:${symbol}`);
  }

  const majors = await Promise.all(cfg.symbols.map(async (symbol) => {
    const r = await safely(deps, `regime ${symbol}`, () => deps.regime(symbol), t);
    if (!r) missing.push(`regime:${symbol}`);
    const a = items.find((x) => x.symbol === symbol);
    const tk = tickers?.[symbol];
    const tkLast = numOrNull(tk?.last), tkChg = numOrNull(tk?.change_24h);
    const b = books[symbol];
    const snapLast = numOrNull(a?.last), snapChg = numOrNull(a?.change_24h);
    const snapTime = snapAt ?? a?.updated_at ?? null;
    const [px, pxSrc, pxAt]: [number | null, BriefFacts['majors'][number]['price_source'], number | null] = b ? [b.mid, 'book_mid', b.at]
      : tkLast !== null ? [tkLast, 'ticker', now]
      : snapLast !== null ? [snapLast, 'snapshot', snapTime] : [null, null, null];
    const [chg, chgSrc, chgAt]: [number | null, BriefFacts['majors'][number]['change_source'], number | null] = tkChg !== null ? [tkChg, 'ticker', now]
      : snapChg !== null ? [snapChg, 'snapshot', snapTime] : [null, null, null];
    const c = ctx?.majors[symbol] ?? null;
    const mc = c && (c.funding || c.oi || c.range) ? c : null;
    if (!mc) missing.push(`ctx:${symbol}`);
    return {
      symbol, price: px, price_source: pxSrc, price_at: pxAt, change_24h_pct: chg, change_source: chgSrc, change_at: chgAt,
      regime: r ? { kind: r.regime, ret_20d_pct: r.ret_20d_pct, ret_5d_pct: r.ret_5d_pct, atr_pct: r.atr_pct, vol_pct_rank: r.vol_pct_rank, ema_stack: r.ema_stack, as_of: r.as_of } : null,
      ctx: mc,
    };
  }));

  // 扫描前列:与「资产 × 周期」服务同一口径 —— 只列 OKX 上有 USDT 永续的(只有现货的也不列)
  let scanFacts: BriefFacts['scan'] = null;
  if (scan && scan.ready && scan.candidates.length) {
    const sorted = [...scan.candidates].sort((a, b) => a.rank - b.rank);
    const seen = new Set<string>();
    const ok = sorted.filter((c) => { if (seen.has(c.symbol)) return false; seen.add(c.symbol); return tradableCheck(deps, c.symbol, ['perp']); });
    const top = ok.slice(0, cfg.scan_top).map((c) => ({
      rank: c.rank, symbol: c.symbol, strategy_id: c.strategy_id ?? null, score: c.score,
      // 上游理由多为中文:能按结构翻成英文的留下,其余丢;再删指令 / 推荐语气分句
      reasons: c.reasons.map((r) => scrubInstructions(englishReason(r) ?? '')).filter(Boolean).slice(0, 2),
    }));
    // 列满了只数名次在最后一名之前被略去的;没列满说明后面全被略去,全数
    const lastRank = top.length >= cfg.scan_top ? top[top.length - 1]!.rank : Infinity;
    const distinctUpTo = new Set(sorted.filter((c) => c.rank <= lastRank).map((c) => c.symbol)).size;
    scanFacts = { at: scan.at, screen_id: scan.screen_id, scanned: scan.scanned, untradable_dropped: distinctUpTo - top.length, top };
    if (!top.length) { scanFacts = null; missing.push('scan'); }
  } else missing.push('scan');

  // 资金费率极值:一律折算到每 8 小时再排序(1h 结算的 0.1% 和 8h 结算的 0.1% 不是一回事)
  let funding: BriefFacts['funding'] = null;
  const bySym = new Map(items.map((a) => [a.symbol, a]));
  const eligible = (a: UniverseAsset | undefined): a is UniverseAsset => !!a && !a.excluded && (numOrNull(a.perp_quote_volume_24h) ?? 0) >= cfg.funding_min_perp_vol_usd && tradableCheck(deps, a.symbol, ['perp']);
  let rows: FundingRow[] = [];
  let source: 'live' | 'snapshot' = 'live';
  let fundAt: number | null = ctx?.at ?? null;
  if (ctx?.funding?.length) {
    const intervals: Record<string, number> = { ...loadIntervals(deps) };
    for (const f of ctx.funding) if (f.interval_h) intervals[f.symbol] = f.interval_h;
    try { deps.state.set(INTERVALS_KEY, JSON.stringify(intervals)); } catch { /* 缓存写不进只影响降级路径 */ }
    rows = ctx.funding.flatMap((f) => {
      const a = bySym.get(f.symbol); const r8 = fundingPer8h(f);
      return eligible(a) && r8 !== null && f.interval_h ? [{ symbol: f.symbol, rate: f.rate, interval_h: f.interval_h, rate_8h: r8, perp_quote_volume_24h: numOrNull(a.perp_quote_volume_24h) }] : [];
    });
  } else {
    source = 'snapshot'; fundAt = snapAt;
    const intervals = loadIntervals(deps);
    rows = items.flatMap((a) => {
      const rate = numOrNull(a.funding_rate), h = intervals[a.symbol];
      return eligible(a) && rate !== null && h ? [{ symbol: a.symbol, rate, interval_h: h, rate_8h: rate * 8 / h, perp_quote_volume_24h: numOrNull(a.perp_quote_volume_24h) }] : [];
    });
  }
  if (rows.length) {
    const sorted = [...rows].sort((a, b) => b.rate_8h - a.rate_8h || a.symbol.localeCompare(b.symbol));
    const n = Math.min(cfg.funding_top, Math.floor(sorted.length / 2) || 1);
    funding = { updated_at: fundAt, source, highest: sorted.slice(0, n), lowest: sorted.slice(-n).reverse() };
  } else missing.push('funding');

  return { slot: slotOf(now), generated_at: now, majors, scan: scanFacts, funding, books, liquidations, missing };
}

// ---------------------------------------------------------------- 渲染

/** 上一份简报的要点(判断「同上」与写变化用);v2 起多了日线数据时点与扫描标的(旧状态缺这些字段时按「变了」处理) */
export interface BriefRef {
  slot: number;
  generated_at: number;
  prices: Record<string, number | null>;
  regimes: Record<string, DailyRegime['regime'] | null>;
  scan_id: string | null;
  scan_leader: string | null;
  funding_at: number | null;
  regime_at?: number | null;
}
export function briefRef(f: BriefFacts): BriefRef {
  return {
    slot: f.slot, generated_at: f.generated_at,
    prices: Object.fromEntries(f.majors.map((m) => [m.symbol, m.price])),
    regimes: Object.fromEntries(f.majors.map((m) => [m.symbol, m.regime?.kind ?? null])),
    scan_id: f.scan?.screen_id ?? null, scan_leader: f.scan?.top[0]?.symbol ?? null, funding_at: f.funding ? f.funding.updated_at : null,
    regime_at: f.majors.find((m) => m.regime)?.regime?.as_of ?? null,
  };
}

function liqWindowText(ms: number): string {
  return ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)} min`;
}
/** 资金费率短写:每 8 小时的百分比 */
const per8Text = (rate8: number, digits = 3): string => `${signedPct(rate8 * 100, digits)}/8h`;
/** 平静期门槛:价格变化、4h 持仓量变化都很小且日线没翻 */
const QUIET_MOVE_PCT = 0.5, QUIET_OI_PCT = 1.5;

/**
 * 确定性摘要:和上一份相比变了什么(价格变化、4h 持仓量变化、日线状态切换、扫描首位更换)+ 本期清算合计;
 * 整体很平静时开头直接写「Quiet 4h」一句带过。没有上一份时写日线状态。只陈述状态,不给操作。
 */
export function templateSummary(f: BriefFacts, base: BriefRef | null = null): string {
  const parts: string[] = [];
  const oiMoves = f.majors.flatMap((m) => m.ctx?.oi?.chg_4h_pct != null ? [{ b: baseOf(m.symbol), v: m.ctx.oi.chg_4h_pct }] : []);
  const oiText = oiMoves.length ? `open interest over 4h ${oiMoves.map((x) => `${x.b} ${signedPct(x.v, 1)}`).join(', ')}` : null;
  if (base && base.slot < f.slot) {
    const moves = f.majors.flatMap((m) => {
      const p0 = base.prices[m.symbol];
      return m.price !== null && p0 ? [{ b: baseOf(m.symbol), v: (m.price / p0 - 1) * 100 }] : [];
    });
    const switched = f.majors.flatMap((m) => {
      const k0 = base.regimes[m.symbol];
      return m.regime && k0 && k0 !== m.regime.kind ? [`${baseOf(m.symbol)} daily regime flipped from ${REGIME_LABEL[k0]} to ${REGIME_LABEL[m.regime.kind]}`] : [];
    });
    const leader = f.scan?.top[0]?.symbol ?? null;
    const quiet = moves.length > 0 && !switched.length && moves.every((x) => Math.abs(x.v) < QUIET_MOVE_PCT) && oiMoves.every((x) => Math.abs(x.v) < QUIET_OI_PCT);
    const lead: string[] = [];
    if (moves.length) lead.push(moves.map((x) => `${x.b} ${signedPct(x.v, 2)}`).join(', '));
    if (oiText) lead.push(oiText);
    lead.push(switched.length ? switched.join(', ') : 'daily regimes unchanged');
    if (leader && base.scan_leader && leader !== base.scan_leader) lead.push(`scan leader changed from ${baseOf(base.scan_leader)} to ${baseOf(leader)}`);
    parts.push(`${quiet ? 'Quiet 4h since' : 'Since'} the ${asOfLabel(base.slot, f.slot)} brief: ${lead.join('; ')}.`);
  } else {
    parts.push(`Daily regime: ${f.majors.map((m) => `${baseOf(m.symbol)} ${m.regime ? REGIME_LABEL[m.regime.kind] : 'unavailable'}`).join(', ')}${oiText ? `; ${oiText}` : ''}.`);
  }
  const liqs = Object.values(f.liquidations).filter((x): x is NonNullable<typeof x> => !!x);
  if (liqs.length) {
    const long = liqs.reduce((s, x) => s + x.long_usd, 0), short = liqs.reduce((s, x) => s + x.short_usd, 0);
    const w = liqWindowText(liqs[0]!.window_ms);
    parts.push(long + short === 0 ? `No BTC/ETH liquidations on OKX perps in the last ${w}.` : `BTC/ETH liquidations on OKX perps in the last ${w}: ${usd(long + short)}, mostly ${long >= short ? 'longs' : 'shorts'}.`);
  }
  return parts.join(' ');
}

const MISSING_LABEL = (k: string): string => {
  const [kind, sym] = k.split(':');
  const b = sym ? baseOf(sym) : '';
  switch (kind) {
    case 'universe': return 'OKX universe snapshot';
    case 'scan': return 'daily scan';
    case 'funding': return 'funding rates';
    case 'regime': return `${b} daily regime`;
    case 'book': return `${b} price`;
    case 'liq': return `${b} liquidations`;
    case 'ctx': return `${b} 4h context (funding, open interest, range)`;
    default: return k.replace(/_/g, ' ');
  }
};

/** 行情行:现价 · 4h / 24h 涨跌 · 近 4h 区间与现价位置 · 近 24h 区间 */
function priceLine(m: BriefFacts['majors'][number], ref: number): string {
  const b = baseOf(m.symbol);
  const r = m.ctx?.range ?? null;
  const segs: string[] = [];
  if (m.price === null && r) segs.push(`${price(r.last)} (OKX 15m close)`);
  if (m.price !== null) segs.push(`${price(m.price)}${m.price_source === 'ticker' ? ` (OKX ticker ${asOfLabel(m.price_at ?? ref, ref)})` : m.price_source === 'snapshot' && m.price_at ? ` (snapshot as of ${asOfLabel(m.price_at, ref)})` : ''}`);
  if (r?.chg_4h_pct != null) segs.push(`4h ${signedPct(r.chg_4h_pct, 2)}`);
  if (m.change_24h_pct !== null) segs.push(`24h ${signedPct(m.change_24h_pct, 2)}${m.change_source === 'snapshot' && m.change_at ? ` (snapshot as of ${asOfLabel(m.change_at, ref)})` : ''}`);
  if (r) {
    const p = m.price ?? r.last;
    const where = p > r.hi_4h ? 'price above the 4h high' : p < r.lo_4h ? 'price below the 4h low' : r.hi_4h > r.lo_4h ? `price at ${Math.round((p - r.lo_4h) / (r.hi_4h - r.lo_4h) * 100)}% of range` : null;
    segs.push(`4h range ${price(r.lo_4h)}–${price(r.hi_4h)}${where ? ` (${where})` : ''}`);
    segs.push(`24h range ${price(r.lo_24h)}–${price(r.hi_24h)}`);
  }
  return segs.length ? `${b} ${segs.join(' · ')}` : `${b} price unavailable`;
}
/** 衍生品行:资金费率(折算每 8h + 年化 + 结算周期)· 持仓量与 4h/24h 变化 */
function derivLine(m: BriefFacts['majors'][number]): string | null {
  const c = m.ctx; if (!c) return null;
  const b = baseOf(m.symbol);
  const segs: string[] = [];
  const f = c.funding, r8 = f ? fundingPer8h(f) : null, ann = f ? fundingAnnualized(f) : null;
  if (f && r8 !== null) segs.push(`funding ${per8Text(r8, 4)} (${signedPct((ann ?? 0) * 100, 1)} annualized; settles every ${f.interval_h}h)`);
  if (c.oi) {
    const chg = [c.oi.chg_4h_pct != null ? `4h ${signedPct(c.oi.chg_4h_pct, 2)}` : null, c.oi.chg_24h_pct != null ? `24h ${signedPct(c.oi.chg_24h_pct, 2)}` : null].filter(Boolean);
    segs.push(`open interest ${usd(c.oi.usd)}${c.oi.scope === 'all_contracts' ? ' across all OKX contracts' : ''}${chg.length ? ` (${chg.join(', ')})` : ''}`);
  }
  return segs.length ? `${b} ${segs.join(' · ')}` : null;
}
function regimeLine(m: BriefFacts['majors'][number]): string {
  const b = baseOf(m.symbol);
  if (!m.regime) return `${b} daily regime unavailable`;
  const r = m.regime;
  return `${b} ${REGIME_LABEL[r.kind]} · 20d ${signedPct(r.ret_20d_pct)} · 5d ${signedPct(r.ret_5d_pct)} · ATR ${num(r.atr_pct)}% · Vol percentile ${Math.round(r.vol_pct_rank * 100)}%`;
}
const fundItem = (r: FundingRow): string => `${baseOf(r.symbol)} ${per8Text(r.rate_8h)}${r.interval_h !== 8 ? ` (${r.interval_h}h cycle)` : ''}`;

/** 订阅信号行(【Futures】类型头、≤200 字):两个主流币的现价 / 4h 涨跌 / 4h 持仓变化 + 本期清算合计 */
export const BRIEF_SIGNAL_HEAD = '【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP | Market brief';
export function briefSignal(f: BriefFacts): string {
  const majors = f.majors.map((m) => {
    const r = m.ctx?.range, oi = m.ctx?.oi;
    return `${baseOf(m.symbol)} ${price(m.price ?? r?.last ?? null)}${r?.chg_4h_pct != null ? ` 4h ${signedPct(r.chg_4h_pct, 2)}` : ''}${oi?.chg_4h_pct != null ? ` OI ${signedPct(oi.chg_4h_pct, 1)}` : ''}`;
  });
  const liqs = Object.values(f.liquidations).filter((x): x is NonNullable<typeof x> => !!x);
  const liq = liqs.length ? ` · Liq 4h ${usd(liqs.reduce((s, x) => s + x.total_usd, 0))}` : '';
  const kinds = f.majors.map((m) => m.regime?.kind ?? null);
  const regimes = kinds.every((k) => k) ? ` · Daily ${new Set(kinds).size === 1 ? `both ${REGIME_LABEL[kinds[0]!]}` : f.majors.map((m) => `${baseOf(m.symbol)} ${REGIME_LABEL[m.regime!.kind]}`).join(', ')}` : '';
  return infoSignal(BRIEF_SIGNAL_HEAD, `${majors.join(' · ')}${liq}${regimes}`);
}

/**
 * 渲染一份简报。base = 上一份的要点:日线 / 扫描与上一份同源时压成一行(仍列出标的,不写空洞的「unchanged」);
 * full=true(欢迎包)不压缩。
 */
export function renderBrief(f: BriefFacts, summaryText: string, opts: { base?: BriefRef | null; full?: boolean; ai?: boolean } = {}): ChannelPush {
  const ref = f.generated_at;
  const base = opts.full ? null : opts.base && opts.base.slot < f.slot ? opts.base : null;
  const lines: string[] = [];

  // 1) 近 4 小时:现价、区间、资金费率、持仓量
  const mids = f.majors.filter((m) => m.price_source === 'book_mid');
  lines.push(`— BTC & ETH, last 4h (OKX USDT perps${mids.length ? `; prices are order-book mids at ${asOfLabel(Math.min(...mids.map((m) => m.price_at ?? ref)), ref)}` : ''})`);
  for (const m of f.majors) { lines.push(priceLine(m, ref)); const d = derivLine(m); if (d) lines.push(d); }

  // 2) 清算
  const anyLiq = Object.values(f.liquidations).find((x) => !!x);
  lines.push(`— Liquidations, last ${liqWindowText(anyLiq?.window_ms ?? BRIEF_DEFAULTS.liq_window_ms)} (OKX perps)`);
  for (const s of Object.keys(f.liquidations)) {
    const l = f.liquidations[s];
    const partial = l && l.covered_ms < l.window_ms ? `; recorder covers only the last ${(l.covered_ms / 3_600_000).toFixed(1)}h` : '';
    lines.push(l ? `${baseOf(s)} longs ${usd(l.long_usd)} / shorts ${usd(l.short_usd)} (${plural(l.count, 'liquidation')}${partial})` : `${baseOf(s)} unavailable`);
  }

  // 3) 日线状态:日线一天才变一次,和上一份同一根日线且状态没变就压成一行
  const regAt = f.majors.find((m) => m.regime)?.regime?.as_of ?? null;
  const regDay = regAt !== null ? new Date(regAt).toISOString().slice(5, 10) : null;
  const sameDaily = !!base && regAt !== null && base.regime_at === regAt && f.majors.every((m) => m.regime && base.regimes[m.symbol] === m.regime.kind);
  if (sameDaily) {
    lines.push(`— Daily regime (daily candles as of ${regDay}, same as the ${asOfLabel(base!.slot, f.slot)} brief): ${f.majors.map((m) => `${baseOf(m.symbol)} ${REGIME_LABEL[m.regime!.kind]} (20d ${signedPct(m.regime!.ret_20d_pct)}, ATR ${num(m.regime!.atr_pct)}%)`).join(' · ')}`);
  } else {
    lines.push(`— Daily regime${regDay ? ` (daily candles as of ${regDay})` : ''}`);
    for (const m of f.majors) lines.push(regimeLine(m));
  }

  // 4) 每日全市场扫描前列(只列有 OKX USDT 永续的)
  const scanAt = f.scan?.at ? `as of ${asOfLabel(f.scan.at, ref)}, updated daily` : 'updated daily';
  if (f.scan && base && base.scan_id && f.scan.screen_id === base.scan_id) {
    lines.push(`— Daily scan leaders (${scanAt}; same scan as the ${asOfLabel(base.slot, f.slot)} brief): ${f.scan.top.map((c) => baseOf(c.symbol)).join(' · ')}`);
  } else {
    lines.push(`— Daily scan leaders (OKX USDT perps, market-wide, ${scanAt})`);
    if (f.scan) {
      // 连续编号(剔除没有 OKX 永续的标的后顺延);原扫描名次在 payload 的 rank
      f.scan.top.forEach((c, i) => {
        const strat = strategyName(c.strategy_id);
        const why = c.reasons.map(fitReasonText).join('; ');
        lines.push(`${i + 1}. ${c.symbol}${strat ? ` · ${strat}` : ''}${why ? ` — ${why.slice(0, 140)}` : ''}`);
      });
      if (f.scan.untradable_dropped > 0) lines.push(`(${plural(f.scan.untradable_dropped, 'symbol')} without an OKX USDT perp omitted; numbering continues)`);
    } else lines.push('Unavailable');
  }

  // 5) 资金费率极值:全部折算到每 8 小时
  const fundSrc = f.funding?.source === 'live'
    ? `live at ${asOfLabel(f.funding.updated_at ?? ref, ref)}`
    : f.funding?.updated_at ? `daily snapshot as of ${asOfLabel(f.funding.updated_at, ref)}` : 'daily snapshot';
  lines.push(`— Funding rate extremes (OKX USDT perps with 24h volume ≥ ${usd(BRIEF_DEFAULTS.funding_min_perp_vol_usd)}; all rates normalized to per-8h; ${fundSrc})`);
  if (f.funding) {
    lines.push(`Highest: ${f.funding.highest.map(fundItem).join(' · ')}`);
    lines.push(`Lowest: ${f.funding.lowest.map(fundItem).join(' · ')}`);
  } else lines.push('Unavailable');

  // 盘口缺了但现价已从行情 / 快照补上(行情行有标注)就不算缺;连现价都没有才写「X price」
  const noPrice = new Set(f.majors.filter((m) => m.price === null).map((m) => m.symbol));
  const missing = f.missing.filter((k) => !k.startsWith('book:') || noPrice.has(k.slice(5)));
  if (missing.length) lines.push(`Data unavailable: ${[...new Set(missing.map(MISSING_LABEL))].join(', ')}`);

  const summary_line = f.majors.map((m) => `${baseOf(m.symbol)} ${m.regime ? REGIME_LABEL[m.regime.kind] : 'n/a'}`).join(' · ')
    + (f.scan?.top[0] ? ` · scan leader ${baseOf(f.scan.top[0].symbol)}` : '');
  // 标题时间 = 内容时间:欢迎包(full)或晚于槽起点 10 分钟以上才生成的,标题写生成时刻并注明所属 4 小时期;准点的写槽起点
  const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
  const useGen = opts.full || f.generated_at - f.slot > 10 * 60_000;
  const when = useGen ? `${utcLabel(f.generated_at)} (period ${hhmm(f.slot)}–${hhmm(f.slot + BRIEF_EVERY_MS)} UTC)` : utcLabel(f.slot);
  return channelPush('market_brief', `brief:${f.slot}`, `Market Brief · ${when}`, summaryText, lines,
    { kind: 'market_brief', slot: f.slot, generated_at: f.generated_at, summary_line, facts: f }, { ai: !!opts.ai, signal: briefSignal(f) });
}

/** lang/v:推送改版前存下的状态(中文版、没有 4h 背景的 v1)不认,免得同一槽回放旧格式 */
interface Stored { lang: 'en'; v: 2; push: ChannelPush; full: ChannelPush; ref: BriefRef; base: BriefRef | null; generated_at: number; slot: number }
const STATE_KEY = 'brief:last';
function loadLast(deps: ChannelDeps): Stored | null {
  try {
    const raw = deps.state.get(STATE_KEY);
    const v = raw ? JSON.parse(raw) as Stored : null;
    return v && v.lang === 'en' && v.v === 2 && v.ref && v.full && v.push ? v : null;
  } catch { return null; }
}
/** 旧版状态里的 ref 仍可作比较基准(价格 / 日线 / 扫描 id 字段一致) */
function loadBaseRef(deps: ChannelDeps): { slot: number; ref: BriefRef; base: BriefRef | null } | null {
  try {
    const raw = deps.state.get(STATE_KEY);
    const v = raw ? JSON.parse(raw) as Partial<Stored> : null;
    return v && v.lang === 'en' && v.ref && typeof v.slot === 'number' ? { slot: v.slot, ref: v.ref, base: v.base ?? null } : null;
  } catch { return null; }
}

async function build(deps: ChannelDeps & BriefDeps, now: number): Promise<Stored> {
  const facts = await collectBriefFacts(deps, now);
  const last = loadBaseRef(deps);
  // 同一槽重算(欢迎包超出复用时限)时沿用那一份的比较基准
  const base = last ? (last.slot === facts.slot ? last.base : last.slot < facts.slot ? last.ref : null) : null;
  let text: string | null = null;
  if (deps.summarize) {
    text = await safely(deps, 'summarize', () => deps.summarize!(facts), (deps.brief_config?.block_timeout_ms ?? BRIEF_DEFAULTS.block_timeout_ms));
    if (text !== null) {
      text = text.replace(/\s+/g, ' ').trim().slice(0, 400);
      // 推送正文全英文:模型写了中文也退回模板
      if (!text || BANNED_WORDS.test(text) || INSTRUCTION_WORDS.test(text) || ADVICE_WORDS.test(text) || CJK.test(text)) { deps.log('warn', 'market_brief 模型摘要为空、含指令/红线词或不是英文,改用模板'); text = null; }
    }
  }
  const summary = text ?? templateSummary(facts, base);
  const ai = text !== null;
  const stored: Stored = {
    lang: 'en', v: 2,
    push: renderBrief(facts, summary, { base, ai }),
    full: renderBrief(facts, summary, { full: true, ai }),
    ref: briefRef(facts), base, generated_at: now, slot: facts.slot,
  };
  deps.state.set(STATE_KEY, JSON.stringify(stored));
  return stored;
}

export const marketBriefChannel: SubscriptionChannel<BriefDeps> = {
  key: 'market_brief',
  every_ms: BRIEF_TICK_MS,
  /** 同一个 4 小时槽只算一次;重复 tick 回放同一份(同 event_id、同内容),由 broadcaster 按 event_id 判重 */
  async tick(deps) {
    const now = deps.now();
    const last = loadLast(deps);
    if (last && last.slot === slotOf(now)) return last.push;
    return (await build(deps, now)).push;
  },
  /** 欢迎包:复用时限内给最近一份的完整版(不压缩),否则现算 */
  async welcome(deps) {
    const now = deps.now();
    const reuse = deps.brief_config?.welcome_reuse_ms ?? BRIEF_DEFAULTS.welcome_reuse_ms;
    const last = loadLast(deps);
    if (last && now - last.generated_at <= reuse && now >= last.generated_at) return last.full;
    return (await build(deps, now)).full;
  },
};
