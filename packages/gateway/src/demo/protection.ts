import type { Market } from './types.js';
/**
 * 通道 × 交易对的保护腿凭证(§9.31,2026-09-12)。
 *
 * 背景(Codex 复审):v3.11 的 `protection_verified:<backend>` 是一次性标记——一个月前验过的通道
 * 和昨天验过的在闸眼里一样,而且「从来没验证过」与「验过但最近一次真挂止损失败」是同一个处理。
 * 这里把它做成**有期限的凭证**:按 `通道 × 交易对` 存,默认 7 天(workflow.protection_ttl_days),
 * 过期或最近一次线上挂止损失败都会降级,由巡检自动重跑金丝雀续期。
 *
 * 存储:demo_kv 的一行 `protection_credentials`(JSON 数组)。单进程单写者,整行覆盖写,没有并发问题。
 * 时间一律 unix 毫秒,字段 snake_case。
 */

export const DAY_MS = 86_400_000;
/** 凭证默认有效期(天)。 */
export const PROTECTION_TTL_DAYS_DEFAULT = 7;
/** 界面可调范围。 */
export const PROTECTION_TTL_DAYS_BOUNDS = [1, 30] as const;
export const PROTECTION_CREDENTIALS_KEY = 'protection_credentials';
/** v3.11 的旧键(通道级、无期限),迁移后置空。 */
export const legacyProtectionKey = (channel: string): string => `protection_verified:${channel}`;

/**
 * 三态(外加 not_needed / verifying 两个非判定态):
 * - `never_verified`:该通道 × 交易对从没验过 → **阻断**开新仓(告警带「用最小仓验证止损」按钮);
 * - `verified_stale_or_probe_failed`:验过但过期,或最近一次线上真挂止损失败 → warn 不挡 + 自动重跑金丝雀;
 * - `verified`:放行。
 */
export type ProtectionState = 'not_needed' | 'verifying' | 'verified' | 'verified_stale_or_probe_failed' | 'never_verified';

export interface ProtectionCredential {
  market: Market;
  channel: string;
  /** null = 通道级凭证(v3.11 迁移来的),给还没有自己凭证的交易对兜底 */
  symbol: string | null;
  verified_at: number;
  /** 写入时按当时的 ttl 算的;**判定用的是按当前 ttl 现算的** `credentialExpiresAt()`,改短 ttl 立刻生效 */
  expires_at: number;
  /** 最近一次「真挂止损」的事实:金丝雀或线上开仓的保护腿 */
  last_probe_at: number | null;
  last_probe_ok: boolean | null;
  last_error: string | null;
  /** 上次自动金丝雀的时刻(节流:每通道 × 交易对每天最多一次) */
  last_auto_at: number | null;
}

export interface ProtectionKv {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
}

export interface ProtectionResolution {
  state: Exclude<ProtectionState, 'not_needed' | 'verifying'>;
  credential: ProtectionCredential | null;
  /** 凭证是这个交易对自己的,还是通道级兜底的 */
  source: 'symbol' | 'channel' | null;
  expires_at: number | null;
}

/** 判定用的过期时刻:按**当前** ttl 从 verified_at 现算,而不是信任写入时快照。 */
export function credentialExpiresAt(c: ProtectionCredential, ttlDays: number): number {
  return c.verified_at + Math.max(1, ttlDays) * DAY_MS;
}

const key = (channel: string, symbol: string | null): string => `${channel}\0${symbol ?? ''}`;

export class ProtectionCredentials {
  constructor(private readonly kv: ProtectionKv) {}

  list(channel?: string): ProtectionCredential[] {
    const raw = this.kv.kvGet(PROTECTION_CREDENTIALS_KEY);
    if (!raw) return [];
    let rows: ProtectionCredential[];
    try {
      rows = JSON.parse(raw) as ProtectionCredential[];
    } catch {
      return [];
    }
    if (!Array.isArray(rows)) return [];
    return rows.map(r => ({...r, market:r.market ?? 'perp'})).filter((r) => r && typeof r.channel === 'string' && typeof r.verified_at === 'number' && (channel === undefined || r.channel === channel));
  }

  private write(rows: ProtectionCredential[]): void {
    this.kv.kvSet(PROTECTION_CREDENTIALS_KEY, JSON.stringify(rows));
  }

  private upsert(next: ProtectionCredential): ProtectionCredential {
    const rows = this.list();
    const i = rows.findIndex((r) => key(r.channel, r.symbol ?? null) === key(next.channel, next.symbol) && r.market === next.market);
    if (i >= 0) rows[i] = next;
    else rows.push(next);
    this.write(rows);
    return next;
  }

  get(channel: string, symbol: string | null, market: Market = 'perp'): ProtectionCredential | null {
    return this.list(channel).find((r) => (r.symbol ?? null) === symbol && r.market === market) ?? null;
  }

  /** 交易对自己的凭证优先,没有就用通道级兜底;都没有 = 从没验过。 */
  resolve(channel: string, symbol: string, ttlDays: number, now: number, market: Market = 'perp'): ProtectionResolution {
    const own = this.get(channel, symbol.toUpperCase(), market);
    const fallback = own ? null : this.get(channel, null, market);
    const c = own ?? fallback;
    if (!c) return { state: 'never_verified', credential: null, source: null, expires_at: null };
    const expires_at = credentialExpiresAt(c, ttlDays);
    const stale = c.last_probe_ok === false || now >= expires_at;
    return { state: stale ? 'verified_stale_or_probe_failed' : 'verified', credential: c, source: own ? 'symbol' : 'channel', expires_at };
  }

  /** 金丝雀通过:写/续期这个通道 × 交易对的凭证。 */
  recordVerified(channel: string, symbol: string, now: number, ttlDays: number, market: Market = 'perp'): ProtectionCredential {
    const prev = this.get(channel, symbol.toUpperCase(), market);
    return this.upsert({
      channel, market,
      symbol: symbol.toUpperCase(),
      verified_at: now,
      expires_at: now + Math.max(1, ttlDays) * DAY_MS,
      last_probe_at: now,
      last_probe_ok: true,
      last_error: null,
      last_auto_at: prev?.last_auto_at ?? null,
    });
  }

  /**
   * 线上真挂止损的结果落到凭证上。失败**只降这一个交易对**,不作废整条通道
   * (v3.11 是把整条通道的记录清空,一个币的 -4130 能把所有币锁死)。
   * 没有任何凭证可降(从没验过)时返回 null:那本来就是 never_verified。
   */
  markProbe(channel: string, symbol: string, ok: boolean, error: string | null, now: number, ttlDays: number, market: Market = 'perp'): ProtectionCredential | null {
    const sym = symbol.toUpperCase();
    const own = this.get(channel, sym, market);
    const base = own ?? this.get(channel, null, market);
    if (!base) return null;
    return this.upsert({
      ...base,
      symbol: sym,
      // 真挂成功 = 比金丝雀更强的证据,顺手续期;失败只记事实,不动 verified_at。
      verified_at: ok ? now : base.verified_at,
      expires_at: ok ? now + Math.max(1, ttlDays) * DAY_MS : base.expires_at,
      last_probe_at: now,
      last_probe_ok: ok,
      last_error: ok ? null : error,
    });
  }

  /** 记一次自动金丝雀的发起时刻(节流用;成功与否由 recordVerified / markProbe 写)。 */
  markAutoAttempt(channel: string, symbol: string, now: number, market: Market = 'perp'): void {
    const sym = symbol.toUpperCase();
    const base = this.get(channel, sym, market) ?? this.get(channel, null, market);
    if (!base) return;
    this.upsert({ ...base, symbol: sym, last_auto_at: now });
  }

  /**
   * v3.11 → v3.12 迁移:旧的 `protection_verified:<channel>`(通道级、无期限)变成一条
   * 「通道级、无 symbol」的凭证,`verified_at` = 当初写入的时间,按当前 ttl 算过期
   * (一个月前验的读出来就是过期态,正是这次要修的东西)。迁移后旧键置空,只迁一次。
   */
  migrateLegacy(channel: string, ttlDays: number, now: number): ProtectionCredential | null {
    const raw = this.kv.kvGet(legacyProtectionKey(channel));
    if (!raw) return null;
    let at = now;
    try {
      const rec = JSON.parse(raw) as { at?: number };
      if (typeof rec.at === 'number' && rec.at > 0) at = rec.at;
    } catch {
      // 旧键里不是 JSON(比如作废时写的空串已在上面被过滤):按现在时间算
    }
    this.kv.kvSet(legacyProtectionKey(channel), '');
    if (this.get(channel, null)) return null;
    return this.upsert({
      channel, market: 'perp',
      symbol: null,
      verified_at: at,
      expires_at: at + Math.max(1, ttlDays) * DAY_MS,
      last_probe_at: at,
      last_probe_ok: true,
      last_error: null,
      last_auto_at: null,
    });
  }
}

// ---------------------------------------------------------------- 止损回执核验(09-12 P1-03)

export interface StopReceiptWant {
  /** 平仓方向(做多的止损是 SELL)。 */
  side: 'BUY' | 'SELL';
  /** 请求的触发价(十进制字符串)。 */
  stop_price: string;
  /** 请求用的 client order / algo id。 */
  client_order_id: string;
}

export interface StopReceiptCheck {
  /** 回执**证明**了交易所收下的就是我们请求的那张止损。 */
  proved: boolean;
  /** 真的核到的字段。 */
  checked: string[];
  /** 回执里有、但和请求不一致的字段。 */
  mismatch: string[];
  reason: string;
}

const TRIGGER_KEYS = ['stopprice', 'triggerprice', 'stop_price', 'trigger_price', 'activationprice'];
const CID_KEYS = ['clientorderid', 'clientalgoid', 'client_order_id', 'client_algo_id', 'newclientorderid', 'origclientorderid'];
const CLOSE_KEYS = ['closeposition', 'close_position'];

/** 回执(可能嵌着 raw / receipt / order / data)里所有出现过的这些键,扁平收集;深度上限 4 层。 */
function collect(node: unknown, out: Map<string, unknown>, depth = 0): void {
  if (depth > 4 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) collect(v, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (v !== null && typeof v === 'object') collect(v, out, depth + 1);
    else if (!out.has(key)) out.set(key, v);
  }
}

/**
 * 09-12 P1-03:`outcome === 'submitted'` 只说明**某个**写调用被接受了,不说明交易所收下的那张单
 * 就是我们请求的止损(方向/触发价/closePosition 都没核过)。凭证续期是「这条通道真的挂得上保护腿」
 * 的证明,所以只认**回执里能核到、且与请求一致**的事实:
 *  - 触发价必须核到且相符(经济上决定性的那一个),否则不算证明;
 *  - 回执里出现的方向 / closePosition / client id / 单型,任一与请求不符 = 不算证明(那是另一张单);
 *  - 什么都核不到(只回了一个 ok/order_id)也不算证明 —— 宁可让 TTL 过期去跑金丝雀。
 */
export function verifyStopReceipt(receipt: unknown, want: StopReceiptWant): StopReceiptCheck {
  const fields = new Map<string, unknown>();
  collect(receipt, fields);
  if (!fields.size) return { proved: false, checked: [], mismatch: [], reason: '回执里没有可核验的订单参数' };
  const checked: string[] = [];
  const mismatch: string[] = [];

  const triggerKey = TRIGGER_KEYS.find((k) => fields.has(k) && fields.get(k) !== null && fields.get(k) !== '');
  if (triggerKey) {
    const got = Number(fields.get(triggerKey));
    const wantNum = Number(want.stop_price);
    if (Number.isFinite(got) && Number.isFinite(wantNum) && wantNum > 0 && Math.abs(got - wantNum) / wantNum < 1e-6) checked.push('触发价');
    else mismatch.push(`触发价 ${String(fields.get(triggerKey))} ≠ ${want.stop_price}`);
  }

  const side = fields.has('side') ? String(fields.get('side')).toUpperCase() : null;
  if (side) {
    if (side === want.side) checked.push('方向');
    else mismatch.push(`方向 ${side} ≠ ${want.side}`);
  }

  const closeKey = CLOSE_KEYS.find((k) => fields.has(k));
  if (closeKey) {
    const raw = fields.get(closeKey);
    const on = raw === true || String(raw).toLowerCase() === 'true';
    const reduceOnly = fields.get('reduceonly') === true || String(fields.get('reduceonly')).toLowerCase() === 'true';
    if (on || reduceOnly) checked.push(on ? 'closePosition' : 'reduceOnly');
    else mismatch.push('closePosition/reduceOnly 都不是 true(这不是一条只减仓的保护腿)');
  }

  const cidKey = CID_KEYS.find((k) => fields.has(k) && fields.get(k));
  if (cidKey) {
    if (String(fields.get(cidKey)) === want.client_order_id) checked.push('client id');
    else mismatch.push(`client id ${String(fields.get(cidKey))} ≠ ${want.client_order_id}`);
  }

  const type = fields.has('type') ? String(fields.get('type')).toUpperCase() : fields.has('order_type') ? String(fields.get('order_type')).toUpperCase() : null;
  if (type) {
    if (type.includes('STOP')) checked.push('单型');
    else mismatch.push(`单型 ${type} 不是止损`);
  }

  if (mismatch.length) return { proved: false, checked, mismatch, reason: `回执与请求不符:${mismatch.join(';')}` };
  if (!checked.includes('触发价')) return { proved: false, checked, mismatch, reason: '回执里没有触发价,核不出收下的是不是这张止损' };
  return { proved: true, checked, mismatch, reason: `回执核对一致(${checked.join('/')})` };
}
