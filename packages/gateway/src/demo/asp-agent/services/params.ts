/**
 * 买方输入解析:service_params 优先按 JSON 读;不是 JSON 就和 description 一起当自由文本抽取。
 * 只做确定性抽取,不调模型;抽不出必填项就抛 ServiceInputError,让轮询方在 accept 前拒单退款。
 */
import { ServiceInputError, type PerCallJob } from './types.js';

export function jsonParams(job: PerCallJob): Record<string, unknown> | null {
  const raw = job.service_params?.trim();
  if (!raw || !/^[{[]/.test(raw)) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}
/** JSON 以外的全部文字(自由文本 service_params + description) */
export function freeText(job: PerCallJob): string {
  return [jsonParams(job) ? '' : job.service_params ?? '', job.description ?? ''].join('\n');
}

const NOT_SYMBOLS = new Set(['USDT', 'USD', 'USDC', 'PERP', 'SWAP', 'SPOT', 'LONG', 'SHORT', 'BUY', 'SELL', 'SL', 'TP', 'TP1', 'TP2', 'TP3', 'ATR', 'RSI', 'EMA', 'MA', 'MACD', 'OKX', 'AI', 'ASP', 'A2A', 'JSON', 'API', 'UTC', 'K', 'R', 'RR', 'PNL', 'ROI', 'KOL', 'CEX', 'DEX', 'ETF', 'THE', 'AND', 'FOR', 'ENTRY', 'STOP', 'TARGET', 'MID', 'SHORTTERM', 'H', 'D', 'M']);
export function normSymbol(s: string): string {
  const u = s.trim().toUpperCase().replace(/[-_/\s]/g, '').replace(/SWAP$/, '').replace(/PERP$/, '');
  return u.endsWith('USDT') ? u : `${u}USDT`;
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
  if (!xs || xs.some((x) => typeof x !== 'string')) throw new ServiceInputError('symbols_invalid', 'symbols 必须是币名数组或逗号分隔字符串 / symbols must be a list');
  const out = [...new Set((xs as string[]).filter(Boolean).map(normSymbol))];
  const bad = out.find((s) => !SYMBOL_OK.test(s));
  if (bad) throw new ServiceInputError('symbols_invalid', `无法识别的币名 / unknown symbol: ${bad}`);
  if (out.length > max) throw new ServiceInputError('symbols_too_many', `最多 ${max} 个币 / at most ${max} symbols`);
  return out;
}

export function marketIn(v: unknown, text: string): 'spot' | 'perp' {
  if (v === 'spot' || v === 'perp') return v;
  if (v !== undefined && v !== null && v !== '') throw new ServiceInputError('market_invalid', 'market 只能是 spot / perp');
  return /现货|\bspot\b/i.test(text) && !/永续|合约|\bperp|swap\b/i.test(text) ? 'spot' : 'perp';
}

export type Horizon = 'short' | 'mid' | 'long';
export function horizonsIn(v: unknown, text: string): Horizon[] | undefined {
  if (v !== undefined && v !== null && v !== '') {
    const xs = Array.isArray(v) ? v : String(v).split(/[,，\s]+/);
    const map: Record<string, Horizon> = { short: 'short', mid: 'mid', long: 'long', 短线: 'short', 中线: 'mid', 长线: 'long' };
    const out = [...new Set(xs.map((x) => map[String(x).trim().toLowerCase()] ?? map[String(x).trim()]))];
    if (!out.length || out.some((x) => !x)) throw new ServiceInputError('horizons_invalid', 'horizons 只能是 short / mid / long');
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
  if (['long', 'buy', '多', '做多'].includes(s)) return 'long';
  if (['short', 'sell', '空', '做空'].includes(s)) return 'short';
  if (s) throw new ServiceInputError('side_invalid', 'side 只能是 long / short');
  const long = /做多|开多|多单|\blong\b|\bbuy\b/i.test(text), short = /做空|开空|空单|\bshort\b|\bsell\b/i.test(text);
  return long === short ? null : long ? 'long' : 'short';
}

/** 正十进制数(字符串或数字),统一成 number;非法返回 null */
export function positive(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
const NUM = String.raw`(\d+(?:\.\d+)?)`;
/** 关键字后的第一个数(「入场 64200」「entry: 64200」「SL=63100」) */
export function numberAfter(text: string, keys: string): number | null {
  const m = new RegExp(`(?:${keys})\\s*[:：=@]?\\s*(?:价|价格|price)?\\s*[:：=]?\\s*${NUM}`, 'i').exec(text);
  return m ? positive(m[1]) : null;
}
/** 目标位:「止盈 65000 / 66000」「TP1 65000 TP2 66000」「targets: 65000, 66000」 */
export function targetsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(`(?:止盈|目标|target|tp\\d?)s?\\s*[:：=]?\\s*(${NUM}(?:\\s*[,，/、]\\s*${NUM})*)`, 'gi'))) {
    for (const x of m[1]!.split(/[,，/、]/)) { const n = positive(x.trim()); if (n !== null && !out.includes(n)) out.push(n); }
  }
  return out.slice(0, 5);
}
export function timeframeIn(v: unknown, text: string, allowed: readonly string[], dflt: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s) { if (!allowed.includes(s)) throw new ServiceInputError('timeframe_invalid', `timeframe 只能是 ${allowed.join(' / ')}`); return s; }
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\s*(m|min|分钟|h|小时|d|日线|天)(?![a-z])/gi)) {
    const unit = /^(m|min|分钟)$/i.test(m[2]!) ? 'm' : /^(h|小时)$/i.test(m[2]!) ? 'h' : 'd';
    const tf = `${Number(m[1])}${unit}`;
    if (allowed.includes(tf)) return tf;
  }
  return dflt;
}
