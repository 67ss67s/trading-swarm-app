/**
 * 买方输入解析:service_params 优先按 JSON 读;不是 JSON 就和 description 一起当自由文本抽取。
 * 只做确定性抽取,不调模型;抽不出必填项就抛 ServiceInputError,让轮询方在 accept 前拒单退款。
 * 中英文关键词都认(平台审核会用中文下单);ServiceInputError 的 message 会回给买方,一律英文。
 */
import { ServiceInputError, type PerCallJob } from './types.js';

/**
 * 买方 agent 照着上架描述自己拼 JSON,字段名五花八门(stopLoss / take_profit / pair / interval …)。
 * 先把驼峰和连字符统一成下划线小写,再把常见别名收成服务读的那个名字;原名已经在就不覆盖。
 */
const KEY_ALIASES: Record<string, string> = {
  pair: 'symbol', inst_id: 'symbol', instid: 'symbol', instrument: 'symbol', coin: 'symbol', asset: 'symbol', ticker: 'symbol', token: 'symbol',
  pairs: 'symbols', coins: 'symbols', assets: 'symbols', tickers: 'symbols', tokens: 'symbols', instruments: 'symbols',
  interval: 'timeframe', tf: 'timeframe', bar: 'timeframe', candle: 'timeframe', chart_timeframe: 'timeframe', time_frame: 'timeframe',
  intervals: 'timeframes', time_frames: 'timeframes',
  entry_price: 'entry', entry_px: 'entry', open_price: 'entry', price: 'entry',
  stop_price: 'stop', sl: 'stop', sl_price: 'stop', stop_loss_price: 'stop', stoploss: 'stop',
  take_profit: 'targets', take_profit_price: 'targets', take_profit_prices: 'targets', tp: 'targets', tps: 'targets', target_price: 'targets', target_prices: 'targets', profit_target: 'targets', profit_targets: 'targets',
  question: 'templates', questions: 'templates',
  horizon: 'horizons', holding_period: 'horizons', term: 'horizons',
  top: 'top_n',
  lookback_days: 'days', window_days: 'days', period_days: 'days', lookback: 'days',
  position_side: 'side', trade_side: 'side',
  market_type: 'market', inst_type: 'market', instrument_type: 'market',
};
const snake = (k: string) => k.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
/** 服务直接按字段读的名字;其余字段(strategy / rules / note …)的值并进自由文本继续抽取,不丢 */
const STRUCTURED_KEYS = new Set(['symbol', 'symbols', 'timeframe', 'timeframes', 'side', 'sides', 'market', 'horizons', 'templates', 'families', 'family', 'top_n', 'days', 'tier',
  'horizon_bars', 'strategy_ir', 'entry', 'stop', 'stop_loss', 'targets', 'target', 'take_profits', 'compare_to', 'constant', 'indicator', 'max_hold_bars', 'direction']);
function rawJson(job: PerCallJob): Record<string, unknown> | null {
  const raw = job.service_params?.trim();
  if (!raw || !/^[{[]/.test(raw)) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}
export function jsonParams(job: PerCallJob): Record<string, unknown> | null {
  const v = rawJson(job); if (!v) return null;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) { const key = snake(k); if (!(key in out)) out[key] = x; }
  for (const [k, x] of Object.entries(out)) {
    let to = KEY_ALIASES[k];
    // direction 在回测里另有含义(连阳/连阴),只有写的是多空时才当 side
    if (!to && k === 'direction' && typeof x === 'string' && /^(long|short|buy|sell|bullish|bearish)$/i.test(x.trim())) to = 'side';
    if (to && (out[to] === undefined || out[to] === null || out[to] === '')) out[to] = x;
  }
  return out;
}
const flat = (v: unknown): string => Array.isArray(v) ? v.map(flat).join(', ') : v && typeof v === 'object' ? JSON.stringify(v).slice(0, 600) : String(v ?? '');
/** JSON 以外的全部文字(自由文本 service_params + description);JSON 里服务不直接读的字段也按「key: value」并进来 */
export function freeText(job: PerCallJob): string {
  const v = rawJson(job);
  const extra = v ? Object.entries(v).filter(([k]) => { const key = snake(k); return !STRUCTURED_KEYS.has(KEY_ALIASES[key] ?? key); })
    .map(([k, x]) => `${snake(k).replace(/_/g, ' ')}: ${flat(x)}`) : [];
  return [v ? '' : job.service_params ?? '', job.description ?? '', ...extra].join('\n');
}

const NOT_SYMBOLS = new Set(['USDT', 'USD', 'USDC', 'PERP', 'SWAP', 'SPOT', 'LONG', 'SHORT', 'BUY', 'SELL', 'SL', 'TP', 'TP1', 'TP2', 'TP3', 'ATR', 'RSI', 'EMA', 'MA', 'MACD', 'OKX', 'AI', 'ASP', 'A2A', 'JSON', 'API', 'UTC', 'K', 'R', 'RR', 'PNL', 'ROI', 'KOL', 'CEX', 'DEX', 'ETF', 'THE', 'AND', 'FOR', 'ENTRY', 'STOP', 'TARGET', 'MID', 'SHORTTERM', 'H', 'D', 'M']);
/** 写全名的常见币(Bitcoin / ethereum)收成代码 */
const COIN_NAMES: Record<string, string> = { BITCOIN: 'BTC', ETHEREUM: 'ETH', ETHER: 'ETH', SOLANA: 'SOL', RIPPLE: 'XRP', DOGECOIN: 'DOGE', CARDANO: 'ADA', BINANCECOIN: 'BNB', TRON: 'TRX', LITECOIN: 'LTC', POLKADOT: 'DOT', CHAINLINK: 'LINK', AVALANCHE: 'AVAX', TONCOIN: 'TON', SUI: 'SUI', PEPE: 'PEPE', SHIBAINU: 'SHIB', POLYGON: 'POL' };
export function normSymbol(s: string): string {
  const u0 = s.trim().toUpperCase().replace(/[-_/\s]/g, '').replace(/SWAP$/, '').replace(/PERP$/, '').replace(/PERPETUAL$/, '');
  const u = COIN_NAMES[u0] ?? u0;
  if (u.endsWith('USDT')) return u;
  // BTCUSD / BTC-USD / BTCUSDC 这类计价写法按 USDT 永续/现货处理(复审 09-26:BTCUSD 被拼成 BTCUSD-USDT-SWAP,OKX 51001)
  const base = u.replace(/(?:USDC|BUSD|USD)$/, '');
  return `${base.length >= 2 ? base : u}USDT`;
}
const SYMBOL_OK = /^[A-Z0-9]{2,15}USDT$/;
/**
 * 文本里的币名:全大写的 BTC / BTC-USDT / BTC-USDT-SWAP,或任意大小写但带 USDT 后缀的 btcusdt / eth-usdt。
 * 普通英文单词(Please / recommend)大小写混排,不会被当成币;常见缩写和纯数字剔除。
 */
export function symbolsIn(text: string, max = 12): string[] {
  const out: string[] = [];
  const hits = [
    ...[...text.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,14})(?:[-_/]?USDT)?(?:[-_]?(?:SWAP|PERP))?(?![A-Za-z0-9])/g)].map((m) => ({ at: m.index, base: m[1]! })),
    ...[...text.matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,14}?)[-_/]?usdt(?:[-_]?(?:swap|perp))?(?![A-Za-z0-9])/gi)].map((m) => ({ at: m.index, base: m[1]!.toUpperCase() })),
  ].sort((a, b) => a.at - b.at);
  for (const m of hits) {
    const base = m.base.replace(/USDT$/, '');
    if (!base || NOT_SYMBOLS.has(base) || /^\d+$/.test(base) || /^TP\d$/.test(base)) continue;
    const sym = normSymbol(base);
    if (SYMBOL_OK.test(sym) && !out.includes(sym)) out.push(sym);
    if (out.length >= max) break;
  }
  return out;
}
export function symbolList(v: unknown, max: number): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const xs = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/) : null;
  if (!xs || xs.some((x) => typeof x !== 'string')) throw new ServiceInputError('symbols_invalid', 'symbols must be a list of coin names or a comma-separated string');
  const out = [...new Set((xs as string[]).filter(Boolean).map(normSymbol))];
  const bad = out.find((s) => !SYMBOL_OK.test(s));
  if (bad) throw new ServiceInputError('symbols_invalid', `Unknown symbol: ${bad}`);
  if (out.length > max) throw new ServiceInputError('symbols_too_many', `At most ${max} symbols per request`);
  return out;
}

/** futures / swap / perpetual / SPOT 这类写法收成 spot | perp;认不出返回 null */
export function normMarket(v: unknown): 'spot' | 'perp' | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s_-]+/g, '') : '';
  if (['spot', 'cash', '现货'].includes(s)) return 'spot';
  if (['perp', 'perps', 'perpetual', 'perpetuals', 'swap', 'swaps', 'futures', 'future', 'contract', 'contracts', 'derivatives', 'usdtperp', 'usdtswap', 'usdm', 'linear', '永续', '合约'].includes(s)) return 'perp';
  return null;
}
export function marketIn(v: unknown, text: string): 'spot' | 'perp' {
  const m = normMarket(v); if (m) return m;
  if (v !== undefined && v !== null && v !== '') throw new ServiceInputError('market_invalid', 'market must be spot or perp');
  return /现货|\bspot\b/i.test(text) && !/永续|合约|\bperp|swap\b/i.test(text) ? 'spot' : 'perp';
}

export type Horizon = 'short' | 'mid' | 'long';
export function horizonsIn(v: unknown, text: string): Horizon[] | undefined {
  if (v !== undefined && v !== null && v !== '') {
    const xs = Array.isArray(v) ? v : String(v).split(/[,，\s]+/);
    const map: Record<string, Horizon> = { short: 'short', mid: 'mid', long: 'long', medium: 'mid', middle: 'mid', swing: 'mid', intraday: 'short', scalp: 'short', scalping: 'short', 短线: 'short', 中线: 'mid', 长线: 'long', 短期: 'short', 中期: 'mid', 长期: 'long' };
    // short-term / mid_term / Long Term 都去掉 term 再查
    const key = (x: unknown) => String(x).trim().toLowerCase().replace(/[\s_-]*term$/, '').replace(/[\s_-]+/g, '');
    const out = [...new Set(xs.filter((x) => String(x).trim()).map((x) => map[key(x)] ?? map[String(x).trim()]))];
    if (!out.length || out.some((x) => !x)) throw new ServiceInputError('horizons_invalid', 'horizons must be short, mid or long');
    return out as Horizon[];
  }
  const out: Horizon[] = [];
  if (/短线|日内|超短|scalp|intraday|short[\s-]?term/i.test(text)) out.push('short');
  if (/中线|波段|swing|mid[\s-]?term|medium/i.test(text)) out.push('mid');
  if (/长线|周线|长期|long[\s-]?term|position trad/i.test(text)) out.push('long');
  return out.length ? out : undefined;
}

export function sideIn(v: unknown, text: string): 'long' | 'short' | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (['long', 'buy', 'bullish', 'bull', '多', '做多', '多单'].includes(s)) return 'long';
  if (['short', 'sell', 'bearish', 'bear', '空', '做空', '空单'].includes(s)) return 'short';
  if (s) throw new ServiceInputError('side_invalid', 'side must be long or short');
  const long = /做多|开多|多单|\blong\b|\bbuy\b/i.test(text), short = /做空|开空|空单|\bshort\b|\bsell\b/i.test(text);
  return long === short ? null : long ? 'long' : 'short';
}

/** 正十进制数(字符串或数字),统一成 number;非法返回 null */
export function positive(v: unknown): number | null {
  // 「84,300」「$84300」「84300 USDT」都按 84300 读
  const t = typeof v === 'string' ? v.trim().replace(/^\$/, '').replace(/\s*(?:usdt|usdc|usd|u)$/i, '').replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1') : '';
  const n = typeof v === 'number' ? v : t && /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
const NUM = String.raw`(\d+(?:\.\d+)?)`;
/** 关键字后的第一个数(「入场 64200」「entry: 64200」「SL=63100」) */
export function numberAfter(text: string, keys: string): number | null {
  const m = new RegExp(`(?:${keys})\\s*[:：=@]?\\s*(?:价|价格|price)?\\s*[:：=]?\\s*${NUM}`, 'i').exec(text);
  return m ? positive(m[1]) : null;
}
/** 目标位:「止盈 65000 / 66000」「TP1 65000 TP2 66000」「targets: 65000, 66000」 */
/** 目标列表里的一个数:后面紧跟周期单位的不算(「target 86500, 1h」里的 1 是周期,不是第二个目标;上架示例原句就是这么写的) */
const TARGET_NUM = String.raw`(\d+(?:\.\d+)?)(?![\d.])(?!\s*(?:m|min|h|d)(?![a-z])|\s*(?:分钟|小时|天|日线))`;
export function targetsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(`(?:止盈|目标|target|take[\\s_-]*profit|tp\\d?)s?\\s*[:：=]?\\s*(${TARGET_NUM}(?:\\s*[,，/、]\\s*${TARGET_NUM})*)`, 'gi'))) {
    for (const x of m[1]!.split(/[,，/、]/)) { const n = positive(x.trim()); if (n !== null && !out.includes(n)) out.push(n); }
  }
  return out.slice(0, 5);
}
/** 买方常写的周期写法收成内部格式:「1H」「60m」「4 hours」「daily」→ 1h / 1h / 4h / 1d */
export function normTimeframe(v: string): string {
  const s = v.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return '';
  const alias: Record<string, string> = { hourly: '1h', hour: '1h', daily: '1d', day: '1d', d: '1d', h: '1h' };
  if (alias[s]) return alias[s]!;
  const m = /^(\d{1,4})(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(s);
  if (!m) return s;
  const n = Number(m[1]); const unit = m[2]![0];
  if (unit === 'm' && n >= 60 && n % 60 === 0) return n % 1440 === 0 ? `${n / 1440}d` : `${n / 60}h`;
  if (unit === 'h' && n >= 24 && n % 24 === 0) return `${n / 24}d`;
  return `${n}${unit}`;
}
export function timeframeIn(v: unknown, text: string, allowed: readonly string[], dflt: string): string {
  const s = normTimeframe(typeof v === 'string' ? v : '');
  if (s) { if (!allowed.includes(s)) throw new ServiceInputError('timeframe_invalid', `timeframe must be one of ${allowed.join(' / ')}`); return s; }
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\s*(m|min|分钟|h|小时|d|日线|天)(?![a-z])/gi)) {
    const unit = /^(m|min|分钟)$/i.test(m[2]!) ? 'm' : /^(h|小时)$/i.test(m[2]!) ? 'h' : 'd';
    const tf = `${Number(m[1])}${unit}`;
    if (allowed.includes(tf)) return tf;
  }
  return dflt;
}
