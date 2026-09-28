// OKX 符号与数量换算(docs/design/okx-atk-2026-09-20.md §2)。
//
// 全系统内部只认 `BTCUSDT` 这种规范符号;`BTC-USDT-SWAP` 和「合约张数」只活在这一层。
// 换算全部走十进制字符串(BigInt 缩放),不用浮点:0.1×3 这种噪声一旦进了 sz,交易所直接拒单。
//
// 这个文件是纯函数 + 一张进程内缓存表,不发网络请求;抓 instruments 的是 market-okx.ts
// (单向依赖 market-okx → instruments,避免环)。

import type { Market, SymbolInfo } from '../types.js';

/** OKX `/api/v5/public/instruments` 里我们用得到的字段(全是字符串,OKX 原样)。 */
export interface OkxInstrument {
  /** 规范符号,如 `BTCUSDT`。 */
  symbol: string;
  instId: string;
  instFamily: string;
  /** 一张合约多少币(linear USDT 永续:BTC 0.01)。 */
  ctVal: string;
  ctValCcy: string;
  /** 下单张数步进。 */
  lotSz: string;
  /** 最小张数。 */
  minSz: string;
  tickSz: string;
  state: string;
}

interface RawInstrument {
  instId?: string;
  instType?: string;
  instFamily?: string;
  ctType?: string;
  settleCcy?: string;
  ctVal?: string;
  ctValCcy?: string;
  lotSz?: string;
  minSz?: string;
  tickSz?: string;
  state?: string;
}

// ---------------------------------------------------------------- 十进制小工具

/** 小数位数:'0.001' → 3,'1' → 0,'1e-8' 这种科学计数法 OKX 不会给,按 0 处理。 */
export function decimalsOf(step: string): number {
  const dot = step.indexOf('.');
  if (dot < 0) return 0;
  return step.length - dot - 1;
}

/** 把十进制字符串拆成 { 整数值(BigInt), 小数位数 }。 */
function scaled(s: string): { v: bigint; d: number } {
  const t = s.trim();
  const neg = t.startsWith('-');
  const body = neg ? t.slice(1) : t;
  const dot = body.indexOf('.');
  const digits = dot < 0 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const d = dot < 0 ? 0 : body.length - dot - 1;
  const v = BigInt(digits === '' ? '0' : digits);
  return { v: neg ? -v : v, d };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** 去掉尾部多余的 0 与孤立小数点;'1.2300' → '1.23','5.000' → '5'。 */
function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function fromScaled(v: bigint, d: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  if (d === 0) return `${neg ? '-' : ''}${abs.toString()}`;
  const s = abs.toString().padStart(d + 1, '0');
  return trimZeros(`${neg ? '-' : ''}${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`);
}

/** 精确乘法(结果保留 a、b 小数位之和,再去尾零)。 */
export function mulDec(a: string, b: string): string {
  const x = scaled(a);
  const y = scaled(b);
  return fromScaled(x.v * y.v, x.d + y.d);
}

/** 十进制加法(结算里累加手续费/资金费:0.1+0.2 这种浮点噪声不能进账本)。 */
export function addDec(a: string, b: string): string {
  const x = scaled(a);
  const y = scaled(b);
  const d = Math.max(x.d, y.d);
  return fromScaled(x.v * pow10(d - x.d) + y.v * pow10(d - y.d), d);
}

/**
 * 十进制取负,**保留符号**。OKX 的 `fee` 负数 = 扣费、正数 = 返佣,内部口径
 * `realized - commission + funding` 要的是 `commission = -fee`(codex-review #12)。
 */
export function negDec(a: string): string {
  const x = scaled(a);
  return fromScaled(-x.v, x.d);
}

/**
 * 把 `value` 向下取整到 `step` 的整数倍。两者都按十进制精确算:
 * 0.29 / 0.01 在浮点下是 28.999999…,直接 Math.floor 会少一张。
 */
export function floorToStep(value: string, step: string): string {
  const s = scaled(step);
  if (s.v <= 0n) return trimZeros(value);
  const v = scaled(value);
  const d = Math.max(v.d, s.d);
  const vv = v.v * pow10(d - v.d);
  const ss = s.v * pow10(d - s.d);
  let n = vv / ss;
  if (vv < 0n && n * ss !== vv) n -= 1n; // BigInt 除法是向零截断,负数要再往下推一格
  return fromScaled(n * ss, d);
}

/** 精确除法,保留 `places` 位小数(向下截断)。 */
export function divDec(a: string, b: string, places: number): string {
  const x = scaled(a);
  const y = scaled(b);
  if (y.v === 0n) return '0';
  // (x / 10^xd) / (y / 10^yd) * 10^places
  const num = x.v * pow10(y.d + places);
  const den = y.v * pow10(x.d);
  return fromScaled(num / den, places);
}

// ---------------------------------------------------------------- 符号映射

/** `BTC-USDT-SWAP` / `BTC-USDT` → `BTCUSDT`。 */
export function instIdToSymbol(instIdOrFamily: string): string {
  const fam = instIdOrFamily.endsWith('-SWAP') ? instIdOrFamily.slice(0, -'-SWAP'.length) : instIdOrFamily;
  return fam.replace(/-/g, '');
}

/**
 * `BTCUSDT` → `BTC-USDT-SWAP`。优先查缓存表(1000PEPEUSDT 这种带数字前缀的只能靠表),
 * 查不到就按「去掉尾部 USDT = BASE」硬拼——比抛错好:调用方拿到的 instId 顶多被 OKX 拒。
 */
export function symbolToInstId(symbol: string, market: Market = 'perp'): string {
  const hit = bySymbol.get(`${market}:${symbol}`);
  if (hit) return hit.instId;
  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  return `${base}-USDT${market === 'spot' ? '' : '-SWAP'}`;
}

// ---------------------------------------------------------------- 进程内缓存表

let bySymbol = new Map<string, OkxInstrument>();
let byInstId = new Map<string, OkxInstrument>();
let loadedAt: Record<Market, number> = { perp: 0, spot: 0 };
/** instruments 缓存 10 分钟(§2)。 */
export const INSTRUMENTS_TTL_MS = 10 * 60_000;

/** 只收录 SWAP + linear + USDT 结算 + live 的合约(§2)。 */
export function parseInstruments(raw: unknown): OkxInstrument[] {
  const rows = Array.isArray(raw) ? (raw as RawInstrument[]) : [];
  const out: OkxInstrument[] = [];
  for (const r of rows) {
    if (r.instType !== 'SWAP' || r.ctType !== 'linear' || r.settleCcy !== 'USDT') continue;
    if (r.state !== 'live') continue;
    const instId = String(r.instId ?? '');
    if (!instId) continue;
    const family = String(r.instFamily || instId.replace(/-SWAP$/, ''));
    out.push({
      symbol: instIdToSymbol(family),
      instId,
      instFamily: family,
      ctVal: String(r.ctVal ?? '1'),
      ctValCcy: String(r.ctValCcy ?? ''),
      lotSz: String(r.lotSz ?? '1'),
      minSz: String(r.minSz ?? r.lotSz ?? '1'),
      tickSz: String(r.tickSz ?? '0.1'),
      state: String(r.state ?? ''),
    });
  }
  return out;
}

export function parseSpotInstruments(raw: unknown): OkxInstrument[] {
  return (Array.isArray(raw) ? raw : []).filter(r => r.instType === 'SPOT' && r.quoteCcy === 'USDT' && r.state === 'live').map(r => ({
    symbol: instIdToSymbol(r.instId), instId: r.instId, instFamily: r.instId, ctVal: '1', ctValCcy: r.baseCcy,
    lotSz: String(r.lotSz), minSz: String(r.minSz), tickSz: String(r.tickSz), state: r.state,
  }));
}
export function setInstruments(rows: OkxInstrument[], at = Date.now(), market: Market = 'perp'): void {
  for (const [k, v] of bySymbol) if (k.startsWith(`${market}:`)) { bySymbol.delete(k); byInstId.delete(v.instId); }
  for (const r of rows) { bySymbol.set(`${market}:${r.symbol}`, r); byInstId.set(r.instId, r); }
  loadedAt[market] = at;
}
export function instrumentsFresh(now = Date.now(), market: Market = 'perp'): boolean {
  return cachedInstruments(market).length > 0 && now - loadedAt[market] < INSTRUMENTS_TTL_MS;
}
export function cachedInstruments(market: Market = 'perp'): OkxInstrument[] {
  return [...bySymbol.entries()].filter(([k]) => k.startsWith(`${market}:`)).map(([,v]) => v);
}
export function instrumentOf(symbol: string, market: Market = 'perp'): OkxInstrument | null {
  return bySymbol.get(`${market}:${symbol}`) ?? byInstId.get(symbol) ?? null;
}
export function resetInstruments(): void {
  bySymbol.clear(); byInstId.clear(); loadedAt = { perp: 0, spot: 0 };
}

// ---------------------------------------------------------------- 张数 ↔ 币

/**
 * 币的数量 → 合约张数:qty / ctVal,再向下取整到 lotSz(§2)。
 * 向下取整而不是四舍五入:多下一张就是超风控敞口,少一张只是少赚。
 */
export function qtyToContracts(qty: string | number, inst: OkxInstrument): string {
  const q = typeof qty === 'number' ? numToDec(qty) : qty;
  // 先除到足够的精度(lotSz 小数位 + 8 位余量),再向下取整到 lotSz。
  const raw = divDec(q, inst.ctVal, decimalsOf(inst.lotSz) + 8);
  return floorToStep(raw, inst.lotSz);
}

/** 合约张数 → 币的数量:sz × ctVal。 */
export function contractsToQty(sz: string | number, inst: OkxInstrument): string {
  const s = typeof sz === 'number' ? numToDec(sz) : sz;
  return mulDec(s, inst.ctVal);
}

/** Number → 十进制字符串(绕开 1e-7 这种指数写法,BigInt 解析不了)。 */
export function numToDec(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (!/e/i.test(String(n))) return String(n);
  return trimZeros(n.toFixed(20));
}

// ---------------------------------------------------------------- SymbolInfo

/**
 * 合约规格 → 内部 SymbolInfo(§2 的表)。`last` 是最新价,只用来算 min_notional
 * (OKX 没有独立的最小名义门槛,用 ctVal×minSz×价 当保守下限);拿不到价就退回 '5'。
 */
export function symbolInfoOf(inst: OkxInstrument, last?: string | null): SymbolInfo {
  const step = mulDec(inst.ctVal, inst.lotSz);
  const minQty = mulDec(inst.ctVal, inst.minSz);
  const minNotional = last && Number(last) > 0 ? mulDec(minQty, last) : '5';
  return {
    symbol: inst.symbol,
    status: inst.state === 'live' ? 'TRADING' : inst.state,
    price_precision: decimalsOf(inst.tickSz),
    qty_precision: decimalsOf(step),
    step_size: step,
    tick_size: inst.tickSz,
    min_qty: minQty,
    min_notional: minNotional === '0' ? '5' : minNotional,
  };
}

/** SymbolRules 的四件套(gates.ts 的 SymbolRules 结构,这里避免反向依赖不导入类型)。 */
export function rulesOf(inst: OkxInstrument, last?: string | null): { step_size: string; tick_size: string; min_qty: string; min_notional: string } {
  const info = symbolInfoOf(inst, last);
  return { step_size: info.step_size, tick_size: info.tick_size, min_qty: info.min_qty, min_notional: info.min_notional };
}

// ---------------------------------------------------------------- clOrdId

/**
 * 内部 CID → OKX clOrdId(§4):OKX 只收字母数字且 ≤32 位。
 * 内部 CID 形如 `tgd-<12 位 hex>-e1`,去掉连字符后 = `tgd` + 12 hex + leg + seq,
 * 三段都是定长/定位的,所以这个映射在现有生成器的字符集内是单射(见单测里的反证)。
 * 需要反查时不反解,而是对同一个内部 CID 再算一次。
 */
export function toClOrdId(cid: string): string {
  return cid.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}
