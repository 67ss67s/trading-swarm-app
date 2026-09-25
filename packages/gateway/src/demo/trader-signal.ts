/**
 * 跟单 session 的**信号层**:bridge 结构化信号 → 内部 `TraderSignal`(纯函数归一化 + 状态机 + 存储)。
 * 设计:`docs/design/trader-follow-2026-09-12.md` §0/§2/§3;接口说明书 `docs/research/bridge-and-stats-api-2026-09-12.md` §A.4/§C.1。
 *
 * 硬规则:
 * - **归一化零模型**:全是字段映射与取值规则。bridge 的 `entry`/`stop_loss`/`take_profit` 是自由 dict,
 *   这里按「常见形状」取键并全部兜底,取不到就老实留 null,**不猜**。
 * - **外部文本一律当数据**:原文/解析理由过 `sanitizeText` 之后才落库、才进 prompt。
 * - **方向体检只对 open/add 生效**(bridge `schemas.py` 同款白名单):`stop_loss_update` 把止损移到保本时
 *   止损可能等于/高于入场价,那是正常语义,早年把方向校验套到所有 action 上出过 22 条信号解析报错的事故。
 * - `signal_id` 是业务幂等键;`record_id` 只是观测用,游标要用 bridge 响应的 `scanned_to_id`(见 trader-feed.ts)。
 * - 价格一律十进制字符串出库(`entry_prices` / `stop` / `tps`),内部几何运算用 number。
 */

import { redactSignalSecrets } from './trader-feed.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { DecisionReasonCode, Direction } from './types.js';

/**
 * 外部文本消毒(控制字符、@@/## 这类提示注入引子、空白折叠)。
 *
 * **这是 `info.ts::sanitizeUntrusted` 的一份刻意副本**,不是漏了复用:`workflow.ts` 要从
 * `trader-follow.ts` 拿默认设置,那条链会把 `info.ts` 拖进 workflow 的 import 图,而 info.ts 在
 * 模块顶层就把 `TG_DEMO_MARKET_BASE` / `TG_DEMO_FNG_URL` 读成 const —— 谁先 import 谁就把那两个
 * 常量钉死了,`test/demo/info.test.ts` 正是靠「先设 env 再动态 import」才拿到假服务器。
 * 两行正则的重复,换掉一条会让测试静悄悄连真网的 import 边,值。
 */
function sanitizeText(s: string, max = 300): string {
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').replace(/[@#]{2}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** bridge `metadata.action_type` 的全集(`ai_client.py` 的解析 schema)。 */
export type TraderAction =
  | 'open'
  | 'add'
  | 'reduce'
  | 'close'
  | 'cancel'
  | 'stop_loss_update'
  | 'take_profit_update'
  | 'stopped_out'
  | 'analysis_only'
  | 'unknown';

export const TRADER_ACTIONS: readonly TraderAction[] = [
  'open', 'add', 'reduce', 'close', 'cancel', 'stop_loss_update', 'take_profit_update', 'stopped_out', 'analysis_only', 'unknown',
];

/**
 * 管理动作(8794 `MANAGEMENT_ACTIONS` 原样搬):路由到已关联线程,**不产生新触发**。
 * `add` 刻意不在这里:它在设计 §2 里有自己的分支(gated 当新 open、copy 只留人工)。
 */
export const MANAGEMENT_ACTIONS: readonly TraderAction[] = ['reduce', 'close', 'cancel', 'stop_loss_update', 'take_profit_update', 'stopped_out'];

/** 只有这两个动作能产生新触发(设计 §0)。 */
export const OPENING_ACTIONS: readonly TraderAction[] = ['open', 'add'];

export function isManagementAction(a: TraderAction): boolean {
  return MANAGEMENT_ACTIONS.includes(a);
}
export function isOpeningAction(a: TraderAction): boolean {
  return OPENING_ACTIONS.includes(a);
}

/**
 * 入场形态。**`zone` 与 `ladder` 是两件事**(P1-02):
 * - `zone` = 原文给的是一个区间(`{low, high}`),8794 的口径是**按方向取更容易成交的那一侧**,挂一张单;
 * - `ladder` = 原文给的是一串明确价位(`prices: [...]`),8794 的口径是**每档独立挂单、均分权重**。
 * 第一版把两者都塞进 `zone`,于是「阶梯」被当区间挂成一张单 —— 计划说分三档、场上只有一档。
 */
export type TraderEntryKind = 'market' | 'limit' | 'zone' | 'ladder' | 'unknown';

/**
 * 一条信号的处置状态。终态不再改(`applied`/`skipped`/`evidence`/`expired`/`dead`/`mgmt_applied`/`mgmt_orphan`);
 * `new` → `triggered` 只是「已经排进判断链路」的中间态。
 */
export type TraderSignalStatus =
  | 'new'
  | 'triggered'
  /** R4-03:人工 apply **已原子领取**、正在发送。领取失败 = 别人已经在处理这条。 */
  | 'applying'
  | 'applied'
  /** R4-03:人工 apply 发送失败(明确失败,不是不确定);可以由人再试。 */
  | 'apply_failed'
  | 'skipped'
  | 'evidence'
  | 'review_only'
  | 'expired'
  | 'dead'
  | 'mgmt_applied'
  | 'mgmt_orphan';

export const TRADER_SIGNAL_STATUSES: readonly TraderSignalStatus[] = [
  'new', 'triggered', 'applying', 'applied', 'apply_failed', 'skipped', 'evidence', 'review_only', 'expired', 'dead', 'mgmt_applied', 'mgmt_orphan',
];

/**
 * **唯一的「可执行前态」**(设计 §7):只有 `review_only` 的行可以 apply / skip。
 * 前端按钮不是服务端互斥 —— 服务端必须自己认这一条(R4-03)。
 */
export const EXECUTABLE_PRE_STATUS: TraderSignalStatus = 'review_only';

/** 三种跟单模式(设计 §0)。 */
/**
 * 订阅模式(2026-09-20 晚改道):
 *   - `book`:ASP Agent 把 order 信号归一化成候选点位,直接交给 Portfolio Manager 那条路
 *     (`openThreadFromProposal`:代码算仓位 + 基础闸 + 组合限额 + 风控哨兵),不问模型;
 *     订阅上的 `approval` 决定是生成待批意图(manual)还是直接执行(auto)。
 *   - `gated`:agent 判断同向才进待办(保留,不默认)。
 *   - `evidence`:只进判断账本。
 * `copy` 是旧名,读设置时统一映射成 `book`。
 */
export type FollowMode = 'book' | 'gated' | 'evidence';
export const FOLLOW_MODES: readonly FollowMode[] = ['book', 'gated', 'evidence'];
export type FollowApproval = 'manual' | 'auto';

export interface TraderTakeProfit {
  /** 十进制字符串。 */
  price: string;
  /** 这一档占多少份额(0–100);信号没给 → null,由 `remapTpShares` 均分。 */
  pct: number | null;
}

/** gated 那次 agent 判断的结论(首发的用途是**给人的依据**,不是执行许可)。 */
export interface TraderAgentVerdict {
  /** 与信号同向 / 反向 / 不入场。 */
  stance: 'agree' | 'disagree' | 'flat';
  action: string | null;
  direction: Direction | null;
  /** agent 自己那套几何里的止损(人工执行时可以参考「更紧的那个」)。 */
  stop: string | null;
  /** 那次判断被哪些闸拒了(空 = 全过)。 */
  blocked: string[];
}

/** 一条信号最终怎么处置的留痕(落在 `demo_trader_signal.decision`)。 */
export interface TraderDecision {
  codes: DecisionReasonCode[];
  /** 人能读的一句话(中文);不参与聚合。 */
  note: string;
  /** gated 模式那次判断的 episode id。 */
  episode_id?: string | null;
  /** 生效权重(`manual_weight × auto_mult`)。 */
  weight?: number | null;
  /** gated 的 agent 结论;copy / evidence 没有。 */
  agent?: TraderAgentVerdict | null;
  /**
   * 人工执行这条信号时要用的几何(`review_only` 才有):入场价、止损、第一档止盈、以及为什么是这个价。
   * 它是**计划值**,不是交易所已挂成功的证明。
   */
  plan?: { entry: string; intent: 'limit' | 'market'; stop: string | null; take_profits: string[]; reason: string } | null;
  at: number;
}

export interface TraderSignal {
  kind?: 'arbitrage';
  reason?: 'arbitrage_recorded_only';
  arbitrage?: {symbol:string; spot_side:'long'; perp_side:'short'; basis_pct:string|null; expected_apr:string|null};
  id: string;
  signal_id: string;
  record_id: number | null;
  trader: string;
  symbol: string;
  /** 管理动作可能没有方向(`close` 只说「平了」)→ null。 */
  side: Direction | null;
  action: TraderAction;
  entry_kind: TraderEntryKind;
  /** 归一化成数组:单价包一层,区间/多档原样(十进制字符串)。 */
  entry_prices: string[];
  stop: string | null;
  tps: TraderTakeProfit[];
  /** 带单员自称的仓位比重(如「2% 保证金 100 倍」里的 2);只留痕,仓位按 risk_pct × weight 自己算。 */
  size_pct: string | null;
  valid_until: number | null;
  published_at: number;
  ingested_at: number;
  raw_text: string;
  /** 原文对「哪一单」的引用(`metadata.target_order_ref`);关联线程的第一优先键。 */
  ref_order: string | null;
  /** `metadata.order_end_state`,原样透传(判断「这一条是不是结束一笔单子」)。 */
  order_end_state: string | null;
  market_type: string;
  /** 传输源(telegram/lark),不是带单员名。 */
  transport: string;
  subscription_job_id?: string;
  /** 启动补拉的信号一律 `review_only`,永远不自动开仓(8794 §1.1 第 10 条)。 */
  backfill: boolean;
  /**
   * R4-04:哪个 follow 会话把这条拉进来的。跨会话的旧行**按历史信号处理**(等同 backfill):
   * 我们停着/关着的那段时间里发生的事,对新会话来说全是历史。
   */
  session: string | null;
  /**
   * R4-03:这条信号处在「我们不知道交易所那边到底怎么样」的状态,需要人去对账。
   * `applying` 行在崩溃后被隔离成 `review_only` 时打上它,发送后出异常(`unknown`)也打 ——
   * **不自动重发**,而且 apply / skip 都要先人工 `reconcile` 清掉它才放行。
   */
  needs_reconcile: boolean;
  /**
   * R5-01 领取身份三件套。`applying` 期间非空。
   *
   * `claim_id` 是这一次操作的唯一 id:发送前回调与结果保存都要拿它跟库里比,不一致就**放弃保存**
   * (说明这次领取已经被别人接管/隔离掉了,旧快照不许覆盖新状态)。
   * `claim_owner` 是领取它的**进程 epoch** —— 启动恢复时据此判断「这是上个进程留下的」。
   */
  claim_id: string | null;
  claim_owner: string | null;
  claim_at: number | null;
  /**
   * R3-07:`valid_until` **在场但不可信**(解析不出 / 早于 `published_at`)。
   *
   * 这种信号**不许进入可执行状态**:期限是「这一单还算不算数」的唯一约束,
   * 把一个不可信的期限当成「没有期限」等于把约束删掉(第一版就是 `timestampOf` → null)。
   * 倒置的那种也不能靠「反正已经早于 now 了」碰巧被 `isExpired` 拦住 ——
   * `published_at=now+20s`(时钟偏差内)、`valid_until=now+10s` 时它并没有过期。
   */
  invalid_validity: boolean;
  status: TraderSignalStatus;
  mode_applied: FollowMode | null;
  thread_id: string | null;
  decision: TraderDecision | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------- 归一化

/**
 * 十进制字符串化:number/string 都收,非有限数 → null。指数记法(1e-7)展开,不进价格字段。
 *
 * **小数位钉在 8 位**:再多一位就把二进制浮点的噪声抄进价格字符串了(`60000 × 1.003`
 * 在 float 里是 `60179.999999999993`,toFixed(12) 会把这串 9 原样留下,然后这个价一路进订单)。
 * 币安最细的 tick 也在 1e-8 量级,8 位既够用又把噪声截掉;真正的网格对齐仍由 `alignLimitPrice` 做。
 */
export const DECIMAL_SCALE = 8;

export function decimalOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  const text = n.toFixed(DECIMAL_SCALE).replace(/0+$/, '').replace(/\.$/, '');
  return text === '' || text === '-' ? null : text;
}

/**
 * 允许的未来偏差(P1-12):bridge 与本机的时钟差、以及带单员客户端的时钟差,都在这个量级以内。
 * 超过它的「未来时间」是坏数据 —— 直接采信会让一条三天前的旧信号永远显示 0 秒龄、过掉新鲜度闸。
 */
export const MAX_CLOCK_SKEW_MS = 120_000;

/**
 * 时间戳归一化:unix 毫秒 / unix 秒 / ISO 字符串都收,认不出 → null。
 *
 * **无时区的字符串一律按 UTC 解析**(P1-12):`Date.parse('2026-09-13T08:00:00')` 按 ECMA-262
 * 走的是**本机时区**,在 Asia/Singapore 上会把 bridge 的 naive UTC 时间整整偏 8 小时 ——
 * 正时区把新信号判成 stale,负时区让旧信号过掉新鲜度闸。bridge 的 `created_at` 带 `+00:00`,
 * 但 metadata 里的原发时间字段是各解析器自己写的,naive 形状真实存在。
 */
export function timestampOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 秒 vs 毫秒:2001-09-09 之后的毫秒值都 > 1e12;小于它按秒解。
    return Math.round(v < 1e12 ? v * 1000 : v);
  }
  const raw = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return timestampOf(Number(raw));
  // 日期或日期时间、且**没有**时区后缀(Z / ±HH:MM)→ 补一个 Z 按 UTC 解。
  const naive = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(raw);
  const ms = Date.parse(naive ? `${raw.replace(' ', 'T')}Z` : raw);
  return Number.isFinite(ms) ? ms : null;
}

/** 时间戳 + 未来偏差体检:超过允许偏差的未来值当坏数据(返回 null)。 */
export function saneTimestampOf(v: unknown, now: number): { at: number | null; error: string | null } {
  const at = timestampOf(v);
  if (at === null) return { at: null, error: null };
  if (at > now + MAX_CLOCK_SKEW_MS) return { at: null, error: `时间戳 ${new Date(at).toISOString()} 在未来超过 ${MAX_CLOCK_SKEW_MS / 1000}s 允许偏差` };
  return { at, error: null };
}

/**
 * 原发时间的候选键(设计 §3:`published_at` **优先 metadata 里的原发时间**)。
 * bridge 的 `created_at` 是「信号入桥库的时刻」,解析/回补时它可能比原文发出晚几小时甚至几天;
 * 新鲜度闸判的是「带单员什么时候喊的」,所以原发时间优先。
 */
const PUBLISHED_AT_KEYS = ['published_at', 'source_timestamp', 'source_timestamp_ms', 'source_published_at', 'message_at', 'message_time', 'sent_at', 'origin_published_at'];

export function publishedAtFrom(metadata: Record<string, unknown>, fallbacks: readonly unknown[], now: number): { at: number | null; errors: string[] } {
  const errors: string[] = [];
  for (const key of PUBLISHED_AT_KEYS) {
    const raw = metadata[key];
    if (raw === null || raw === undefined || raw === '') continue;
    const r = saneTimestampOf(raw, now);
    if (r.at !== null) return { at: r.at, errors };
    // 复审 P1-12(二审):原发时间**在场但坏掉**(解析不出 / 在未来)时,**不许退回 created_at**。
    // 退回去等于把一条时间不可信的信号当成刚发的新信号(created_at 是我们刚拉到它的时刻附近),
    // 于是它以近似 0 秒龄过掉新鲜度闸。时间说不清的信号不能进自动链路,整条拒。
    errors.push(`metadata.${key} 在场但不可信:${r.error ?? '解析不出时间'};不退回 created_at`);
    return { at: null, errors };
  }
  for (const f of fallbacks) {
    const r = saneTimestampOf(f, now);
    if (r.error) errors.push(`created_at:${r.error}`);
    if (r.at !== null) return { at: r.at, errors };
  }
  return { at: null, errors };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * `entry` 自由 dict → `{prices, shape}`。`shape` 记住这串价位**是怎么给出来的**(P1-02):
 * `levels` = 明确的多档价位(prices/levels 数组);`range` = 区间(low/high 或 price_range/zone);
 * `single` = 一个价;`none` = 没有价。
 */
export function pricesFrom(node: unknown): { prices: string[]; shape: 'levels' | 'range' | 'single' | 'none' } {
  const rec = asRecord(node);
  const out: string[] = [];
  const push = (v: unknown): void => {
    const d = decimalOf(v);
    if (d !== null && Number(d) > 0 && !out.includes(d)) out.push(d);
  };
  let levels = 0;
  let range = 0;
  for (const key of ['prices', 'levels']) {
    const arr = rec[key];
    if (Array.isArray(arr)) for (const v of arr) (push(typeof v === 'object' ? asRecord(v)['price'] : v), levels++);
  }
  for (const key of ['price_range', 'zone']) {
    const arr = rec[key];
    if (Array.isArray(arr)) for (const v of arr) (push(typeof v === 'object' ? asRecord(v)['price'] : v), range++);
  }
  for (const key of ['price', 'selected_price']) push(rec[key]);
  for (const key of ['low', 'high', 'min', 'max', 'from', 'to']) if (rec[key] !== undefined) (push(rec[key]), range++);
  if (Array.isArray(node)) for (const v of node) (push(typeof v === 'object' ? asRecord(v)['price'] : v), levels++);
  if (typeof node === 'number' || typeof node === 'string') push(node);
  const prices = out.sort((a, b) => Number(a) - Number(b));
  const shape = !prices.length ? 'none' : prices.length === 1 ? 'single' : levels > 1 ? 'levels' : range > 1 ? 'range' : 'levels';
  return { prices, shape };
}

/** 只要价位数组的老调用点(止损/止盈都只关心价,不关心形状)。 */
export function priceListFrom(node: unknown): string[] {
  return pricesFrom(node).prices;
}

/** `stop_loss` 自由 dict → 单价。多个候选时按 `protectiveStopPrice` 的口径(离场更保守)取。 */
export function stopFrom(node: unknown, side: Direction | null): string | null {
  const prices = priceListFrom(node);
  if (!prices.length) return null;
  return protectiveStopPrice(prices, side);
}

/** `take_profit` 列表 → 多档止盈(保留信号给的顺序,不排序:第一档就是第一档)。 */
export function tpsFrom(node: unknown): TraderTakeProfit[] {
  if (!Array.isArray(node)) {
    const one = priceListFrom(node);
    return one.length ? [{ price: one[0]!, pct: null }] : [];
  }
  const out: TraderTakeProfit[] = [];
  for (const item of node) {
    const rec = asRecord(item);
    const price = decimalOf(rec['price'] ?? (typeof item === 'number' || typeof item === 'string' ? item : undefined));
    if (price === null || !(Number(price) > 0)) continue;
    const pctRaw = Number(rec['pct'] ?? rec['percent'] ?? rec['share'] ?? NaN);
    out.push({ price, pct: Number.isFinite(pctRaw) && pctRaw > 0 ? pctRaw : null });
  }
  return out;
}

/** bridge `side` → 内部方向。`close_long` 的方向是 long(它平的是多仓),关联线程时要用。 */
export function sideFrom(raw: unknown): Direction | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'long' || s === 'buy' || s === 'close_long') return 'long';
  if (s === 'short' || s === 'sell' || s === 'close_short') return 'short';
  return null;
}

export function actionFrom(raw: unknown): TraderAction {
  const s = String(raw ?? '').trim().toLowerCase();
  return (TRADER_ACTIONS as readonly string[]).includes(s) ? (s as TraderAction) : 'unknown';
}

export function entryKindFrom(node: unknown, read: { prices: readonly string[]; shape: 'levels' | 'range' | 'single' | 'none' }, action: TraderAction): TraderEntryKind {
  const type = String(asRecord(node)['type'] ?? '').trim().toLowerCase();
  if (type === 'market') return 'market';
  if (read.prices.length > 1) return read.shape === 'range' || type === 'zone' ? 'zone' : 'ladder';
  if (read.prices.length === 1) return 'limit';
  // 没有价、也没说 type:开仓类按市价意图处理(8794 `orders/adapter.rs` 同款「无有效入场价 = 市价意图」)。
  if (type === 'limit' || type === 'zone') return 'unknown';
  return isOpeningAction(action) ? 'market' : 'unknown';
}

export interface NormalizeOptions {
  /** 本机拉到这条的时刻。 */
  now: number;
  /** 启动补拉批次 → 一律 review_only。 */
  backfill?: boolean;
  /** 拉这一批的 follow 会话 id(R4-04)。 */
  session?: string | null;
  record_id?: number | null;
  /** 本地 id 生成器(测试注入,默认按 signal_id 派生,保证幂等)。 */
  makeId?: (signalId: string) => string;
}

export interface NormalizeResult {
  signal: TraderSignal | null;
  /** 归一化失败的原因(进 DLQ 观测);成功时空数组。 */
  errors: string[];
}

const MAX_RAW_TEXT = 2000;

/**
 * R4-06:`signal_id` 的合法形状。它是**业务身份**,既要能当幂等键又要能安全出站,
 * 所以不能像原文那样脱敏(mask 会让不同信号撞成同一个 id)—— 只能**在入口拒收**。
 *
 * bridge 侧签发的是 `sig_<hex>` 这类形状;这里放宽到字母数字加 `_ . : -`,长度 1–128
 * (与 bridge `StructuredSignal.signal_id` 的 1~128 对齐)。
 */
export const SIGNAL_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * 拒收带凭证形状的 signal_id(R4-06):一条 id 里贴着 `sbk_`/`sbs_` 的信号,
 * 它的 id 会原样进库、进 SSE、进 HTTP —— 而 id 不能脱敏。所以整条拒收进 DLQ。
 */
export function signalIdError(signalId: string): string | null {
  if (!SIGNAL_ID_RE.test(signalId)) return `signal_id 形状不合法(只允许字母数字与 _ . : -,长度 1–128)`;
  if (/sb[ks]_/i.test(signalId)) return 'signal_id 里带凭证形状(sbk_/sbs_),拒收';
  return null;
}

/**
 * bridge `envelope.payload`(`StructuredSignalResponse`)→ 内部 `TraderSignal`。
 * **不抛**:坏行返回 `{signal:null, errors:[...]}`,由调用方计进 DLQ —— 一条坏行不能打掉整批
 * (bridge 自己就是这么做的,历史上一条坏行让下游断流 3.5 小时而 health 全绿)。
 */
export function normalizeBridgeSignal(payloadIn: unknown, opts: NormalizeOptions): NormalizeResult {
  const errors: string[] = [];
  const payload = asRecord(payloadIn);
  // 有些调用方会把整个 envelope 递进来:自动下钻一层。
  const p = payload['payload'] !== undefined && asRecord(payload['payload'])['signal_id'] !== undefined ? asRecord(payload['payload']) : payload;
  const signal_id = typeof p['signal_id'] === 'string' && p['signal_id'].trim() ? p['signal_id'].trim() : '';
  if (!signal_id) errors.push('signal_id 缺失');
  else {
    const idError = signalIdError(signal_id);
    // R4-06:id 不合格 → 整条拒收(id 是幂等键,不能脱敏也不能改写)。
    if (idError) return { signal: null, errors: [...errors, idError] };
  }
  const metadata = { ...asRecord(p['metadata']), ...asRecord(p['signal_metadata']) };
  const trader = String(metadata['trader'] ?? '').trim();
  if (!trader) errors.push('metadata.trader 缺失');
  const symbol = String(p['symbol'] ?? '').trim().toUpperCase();
  if (!symbol) errors.push('symbol 缺失');
  const pub = publishedAtFrom(metadata, [p['created_at'], p['updated_at']], opts.now);
  errors.push(...pub.errors);
  const published_at = pub.at;
  if (published_at === null) errors.push('无法确定 published_at(或全部候选时间都在未来)');
  // published_at 是新鲜度闸的唯一输入:确定不了就**不能**当信号用(不然它会以 0 秒龄过闸)。
  if (published_at === null || !signal_id || !trader || !symbol) return { signal: null, errors };

  const action = actionFrom(metadata['action_type']);
  const side = sideFrom(p['side']);
  const entryRead = pricesFrom(p['entry']);
  const entry_prices = entryRead.prices;
  const entry_kind = entryKindFrom(p['entry'], entryRead, action);
  const stop = stopFrom(p['stop_loss'], side);
  const tps = tpsFrom(p['take_profit']);
  // ---- valid_until 体检(R3-07)。三种情形:
  //   1. 字段不在场 → 没有期限,正常。
  //   2. 在场且解析得出、且 >= published_at → 正常期限(落在过去 = 一到就过期,合法)。
  //   3. 在场但**解析不出**或**早于 published_at** → 期限不可信 → `invalid_validity=true`,
  //      这条信号**不许进入可执行状态**(判定层直接落 expired)。既不删约束,也不靠碰巧过期。
  const validUntilPresent = p['valid_until'] !== null && p['valid_until'] !== undefined && p['valid_until'] !== '';
  const validUntilRaw = validUntilPresent ? timestampOf(p['valid_until']) : null;
  let invalidValidity = false;
  if (validUntilPresent && validUntilRaw === null) {
    errors.push(`valid_until ${JSON.stringify(p['valid_until'])} 解析不出时间:期限不可信,隔离(不当成无期限)`);
    invalidValidity = true;
  } else if (validUntilRaw !== null && validUntilRaw < published_at) {
    errors.push(`valid_until ${new Date(validUntilRaw).toISOString()} 早于 published_at:期限不可信,隔离`);
    invalidValidity = true;
  }
  const validUntil: number | null = validUntilRaw;
  const rawText = [String(metadata['rationale'] ?? ''), String(p['raw_text'] ?? ''), String(metadata['raw_text'] ?? '')]
    .filter((t) => t.trim())
    .join(' / ');
  const now = opts.now;
  const signal: TraderSignal = {
    id: (opts.makeId ?? defaultSignalRowId)(signal_id),
    signal_id,
    record_id: opts.record_id ?? null,
    trader,
    symbol,
    side,
    action,
    entry_kind,
    entry_prices,
    stop,
    tps,
    size_pct: decimalOf(asRecord(p['risk_hint'])['size_pct'] ?? asRecord(p['risk_hint'])['margin_pct'] ?? metadata['size_pct']),
    valid_until: validUntil,
    published_at,
    ingested_at: now,
    raw_text: sanitizeText(rawText, MAX_RAW_TEXT),
    ref_order: typeof metadata['target_order_ref'] === 'string' && metadata['target_order_ref'].trim() ? metadata['target_order_ref'].trim() : null,
    order_end_state: typeof metadata['order_end_state'] === 'string' && metadata['order_end_state'].trim() ? metadata['order_end_state'].trim() : null,
    market_type: String(p['market_type'] ?? 'perpetual'),
    transport: String(p['source'] ?? '').trim().toLowerCase(),
    backfill: opts.backfill === true,
    session: opts.session ?? null,
    needs_reconcile: false,
    claim_id: null,
    claim_owner: null,
    claim_at: null,
    invalid_validity: invalidValidity,
    status: 'new',
    mode_applied: null,
    thread_id: null,
    decision: null,
    created_at: now,
    updated_at: now,
  };
  // 方向体检**只对 open/add**(bridge `validate_stop_loss_direction` 同一条白名单)。
  // 不合逻辑不丢信号,只记一条 error 供观测,并把止损清掉(后面按「无止损」降级成 evidence)。
  if (isOpeningAction(action) && stop !== null && side !== null && entry_prices.length) {
    const ref = entryPriceForSide(entry_prices, side);
    const ok = side === 'long' ? Number(stop) < Number(ref) : Number(stop) > Number(ref);
    if (!ok) {
      errors.push(`止损 ${stop} 在入场价 ${ref} 的错误一侧(${side})`);
      signal.stop = null;
    }
  }
  return { signal, errors };
}

/**
 * 本地行 id:`tsig_` + sha1(signal_id) 前 24 位。按 signal_id 派生所以幂等,同时**抗碰撞**。
 *
 * 第一版是「去掉非法字符再截 48 位」:`abc.x` 与 `abcx` 会撞成同一个主键,前 48 位相同的两条也会撞;
 * 撞上之后 `ON CONFLICT(signal_id)` 那条 upsert 处理不了(冲突在 PRIMARY KEY 上),整页处理会被一条异常挡住。
 */
export function defaultSignalRowId(signalId: string): string {
  return `tsig_${createHash('sha1').update(signalId).digest('hex').slice(0, 24)}`;
}

// ---------------------------------------------------------------- 取价规则([8794] orders/adapter.rs)

/** 做空取入场价集合**最大值**,做多取**最小值**(各自更容易成交的一侧)。方向不明 → 第一个。 */
export function entryPriceForSide(prices: readonly string[], side: Direction | null): string | null {
  if (!prices.length) return null;
  if (side === null) return prices[0]!;
  const nums = prices.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  const pick = side === 'short' ? Math.max(...nums) : Math.min(...nums);
  return prices.find((p) => Number(p) === pick) ?? null;
}

/** 保护价:`long` 取候选集**最小值**,`short` 取**最大值**(离场更保守)。 */
export function protectiveStopPrice(prices: readonly string[], side: Direction | null): string | null {
  if (!prices.length) return null;
  if (side === null) return prices[0]!;
  const nums = prices.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  const pick = side === 'long' ? Math.min(...nums) : Math.max(...nums);
  return prices.find((p) => Number(p) === pick) ?? null;
}

/** 入场区多档阶梯:给了权重按其归一化到 100,没给且多档 → 均分,单价 → 100。 */
export function splitPercents(count: number, weights?: readonly number[]): number[] {
  if (count <= 0) return [];
  if (count === 1) return [100];
  if (weights && weights.length === count && weights.every((w) => Number.isFinite(w) && w > 0)) {
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map((w) => round2((w / sum) * 100));
  }
  const each = round2(100 / count);
  const out = new Array(count).fill(each) as number[];
  // 余数补到最后一档,合计恒 100(不然名义链会少/多几毛钱)。
  out[count - 1] = round2(100 - each * (count - 1));
  return out;
}

/** 多档止盈份额:信号给了 pct 按其归一化,没给 → 均分。 */
export function remapTpShares(tps: readonly TraderTakeProfit[]): number[] {
  const weights = tps.map((t) => t.pct).filter((p): p is number => p !== null && p > 0);
  return splitPercents(tps.length, weights.length === tps.length ? weights : undefined);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- 市价意图与限价闸([8794])

/** 滑点上限:BTC/ETH 0.3%,其余 0.5%。 */
export const SLIPPAGE_CAP_MAJOR_PCT = 0.3;
export const SLIPPAGE_CAP_DEFAULT_PCT = 0.5;
/** 限价距 mark 超过这个百分比拒。 */
export const MAX_PRICE_DEVIATION_PCT = 0.55;
/** 限价不得比 mark 更激进超过这个百分比。 */
export const MAX_AGGRESSIVE_LIMIT_PCT = 0.05;

const MAJORS = new Set(['BTCUSDT', 'ETHUSDT']);

export function slippageCapPct(symbol: string): number {
  return MAJORS.has(symbol.toUpperCase()) ? SLIPPAGE_CAP_MAJOR_PCT : SLIPPAGE_CAP_DEFAULT_PCT;
}

/**
 * 市价意图 → 「顶着偏离上限的限价」(8794 `orders/adapter.rs:242-272`)。**不发裸市价、不追价**:
 * 超过这个价不成交就让它过期。做多向上顶、做空向下顶。
 */
export function marketableLimitPrice(mark: number, side: Direction, symbol: string): string | null {
  if (!(mark > 0)) return null;
  const cap = slippageCapPct(symbol) / 100;
  const px = side === 'long' ? mark * (1 + cap) : mark * (1 - cap);
  return decimalOf(px);
}

export interface LimitPriceCheck {
  ok: boolean;
  /** 不 ok 时的原因(中文,一句)。 */
  reason: string;
  deviation_pct: number;
}

/**
 * 限价体检。**两种意图两套尺子**(P1-03):
 *
 * - `intent: 'limit'`(默认,带单员给了具体价):距 mark 不得超 `max_deviation_pct`(0.55%),
 *   且不得比 mark 更激进超过 `max_aggressive_pct`(0.05%)—— 两条都是 8794 的原闸。
 * - `intent: 'market'`(市价意图翻出来的「顶着滑点上限的限价」):它**天生就是激进的**,
 *   激进度恰好等于滑点上限(BTC/ETH 0.3%、其余 0.5%)。拿 0.05% 的激进度闸去量它必然拒 ——
 *   于是所有市价意图信号一条都跟不了。这种单按**滑点上限**验收:不超过本品种的 cap 就放行,
 *   超了才拒(等价于 8794 的「顶着上限下 IOC,超限过期不追」)。
 *
 * 注意这不是把闸放松:市价意图的成交价上界仍然被 cap 钉死,只是换了把对的尺子。
 */
export function checkLimitPrice(
  price: number,
  mark: number,
  side: Direction,
  opts: { max_deviation_pct?: number; max_aggressive_pct?: number; intent?: 'limit' | 'market'; symbol?: string } = {},
): LimitPriceCheck {
  if (!(price > 0) || !(mark > 0)) return { ok: false, reason: '限价或标记价不可用', deviation_pct: 0 };
  const dev = ((price - mark) / mark) * 100;
  // 「更激进」= 多头挂得比 mark 高 / 空头挂得比 mark 低(等于主动往对手价上贴)。
  const aggressive = side === 'long' ? dev : -dev;
  if (opts.intent === 'market') {
    const cap = slippageCapPct(opts.symbol ?? '');
    // 容差 1e-9:限价是 toFixed(8) 之后的十进制字符串,和 mark×(1+cap) 的浮点值差在末位。
    if (aggressive > cap + 1e-9) return { ok: false, reason: `市价意图限价比标记价激进 ${aggressive.toFixed(3)}%,超过 ${opts.symbol ?? ''} 的滑点上限 ${cap}%`, deviation_pct: dev };
    if (aggressive < -cap - 1e-9) return { ok: false, reason: `市价意图限价比标记价保守 ${(-aggressive).toFixed(3)}%,不是顶着上限的价`, deviation_pct: dev };
    return { ok: true, reason: '', deviation_pct: dev };
  }
  const maxDev = opts.max_deviation_pct ?? MAX_PRICE_DEVIATION_PCT;
  const maxAggr = opts.max_aggressive_pct ?? MAX_AGGRESSIVE_LIMIT_PCT;
  if (Math.abs(dev) > maxDev) return { ok: false, reason: `限价 ${price} 距标记价 ${mark} 偏离 ${dev.toFixed(3)}%,超过上限 ${maxDev}%`, deviation_pct: dev };
  if (aggressive > maxAggr) return { ok: false, reason: `限价比标记价更激进 ${aggressive.toFixed(3)}%,超过上限 ${maxAggr}%`, deviation_pct: dev };
  return { ok: true, reason: '', deviation_pct: dev };
}

// ---------------------------------------------------------------- 止损收紧判定(管理动作用)

/**
 * 新止损是不是**收紧**(设计 §2:只自动收紧,放松要人批)。
 * 「移到保本」= 收紧到入场价,按收紧处理(多头 newStop ≥ oldStop 即收紧,含等于入场价那一档)。
 */
export function stopTightens(side: Direction, oldStop: number | null, newStop: number): boolean {
  if (!(newStop > 0)) return false;
  if (oldStop === null || !(oldStop > 0)) return true; // 从没有止损到有止损:永远算收紧
  return side === 'long' ? newStop > oldStop : newStop < oldStop;
}

/** 原文里的「保本/回本」口径(8794 `COST_BASIS_TOKENS`)。识别到 = 目标价是「本策略自己的成交成本」。 */
export const COST_BASIS_TOKENS = ['breakeven', 'break_even', 'break even', 'entry', 'cost', '保本', '成本', '入场', '开仓价', '回本', '回到本'];

export function mentionsCostBasis(text: string): boolean {
  const low = text.toLowerCase();
  return COST_BASIS_TOKENS.some((t) => low.includes(t));
}

// ---------------------------------------------------------------- 状态机

const TERMINAL: readonly TraderSignalStatus[] = ['applied', 'skipped', 'evidence', 'expired', 'dead', 'mgmt_applied', 'mgmt_orphan'];

export function isTerminalSignalStatus(s: TraderSignalStatus): boolean {
  return TERMINAL.includes(s);
}

/** 合法迁移表。`review_only` 不是终态:人可以在界面上 apply/skip 它。 */
const TRANSITIONS: Record<TraderSignalStatus, readonly TraderSignalStatus[]> = {
  new: ['triggered', 'applied', 'skipped', 'evidence', 'review_only', 'expired', 'dead', 'mgmt_applied', 'mgmt_orphan'],
  // `triggered` 只能被隔离成 review_only(等人核对)或走完自己那次执行;不许被 skip 抹掉
  // (R4-03:apply 正在发送时 skip 会把「已发出」这个事实擦掉,崩溃后 resume 就不会隔离它了)。
  triggered: ['applied', 'apply_failed', 'review_only', 'evidence', 'expired', 'dead'],
  // 领取之后只有三个去处:成功、明确失败、或崩溃后被 resume 隔离回 review_only。
  applying: ['applied', 'apply_failed', 'review_only'],
  review_only: ['applying', 'skipped', 'expired', 'evidence'],
  apply_failed: ['applying', 'skipped'],
  applied: ['dead'],
  skipped: [],
  evidence: [],
  expired: [],
  dead: [],
  mgmt_applied: [],
  mgmt_orphan: ['mgmt_applied'],
};

export function canTransition(from: TraderSignalStatus, to: TraderSignalStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** 迁移一条信号的状态;非法迁移**原样返回**(状态机不是判定,不能把一条已终态的信号改回去)。 */
export function transition(sig: TraderSignal, to: TraderSignalStatus, patch: Partial<Pick<TraderSignal, 'mode_applied' | 'thread_id' | 'decision'>> = {}, now = Date.now()): TraderSignal {
  if (!canTransition(sig.status, to)) return sig;
  return { ...sig, ...patch, status: to, updated_at: now };
}

/** 信号过期:`valid_until` 已过。 */
export function isExpired(sig: TraderSignal, now: number): boolean {
  return sig.valid_until !== null && sig.valid_until <= now;
}

/** 信号年龄(秒)。 */
export function ageSeconds(sig: TraderSignal, now: number): number {
  return Math.max(0, Math.round((now - sig.published_at) / 1000));
}

// ---------------------------------------------------------------- 存储

export interface TraderSignalQuery {
  job_id?: string | null;
  trader?: string | null;
  symbol?: string | null;
  status?: TraderSignalStatus | null;
  action?: TraderAction | null;
  since?: number | null;
  limit?: number;
}

export class TraderSignalStore {
  constructor(private readonly db: DatabaseSync) {}

  save(sig: TraderSignal): void {
    // 入库脱敏覆盖 raw_text / ref_order / decision 等所有文本,但 id / signal_id 是主键与查找键,保持原样(出站另有 redactSignal)。
    sig = { ...redactSignalSecrets(sig), id: sig.id, signal_id: sig.signal_id };
    this.db
      .prepare(
        `INSERT INTO demo_trader_signal(id, signal_id, record_id, trader, symbol, side, action, entry_kind, entry_prices,
           stop, tps, size_pct, valid_until, published_at, ingested_at, raw_text, ref_order, order_end_state,
           market_type, transport, backfill, session, needs_reconcile, claim_id, claim_owner, claim_at,
           invalid_validity, status, mode_applied, thread_id, decision, created_at, updated_at, subscription_job_id, kind, reason, arbitrage_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(signal_id) DO UPDATE SET
           record_id = COALESCE(excluded.record_id, demo_trader_signal.record_id),
           status = excluded.status, mode_applied = excluded.mode_applied, thread_id = excluded.thread_id,
           decision = excluded.decision, stop = excluded.stop, tps = excluded.tps,
           backfill = excluded.backfill, session = excluded.session, needs_reconcile = excluded.needs_reconcile,
           claim_id = excluded.claim_id, claim_owner = excluded.claim_owner, claim_at = excluded.claim_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        sig.id, sig.signal_id, sig.record_id, sig.trader, sig.symbol, sig.side, sig.action, sig.entry_kind,
        JSON.stringify(sig.entry_prices), sig.stop, JSON.stringify(sig.tps), sig.size_pct, sig.valid_until,
        sig.published_at, sig.ingested_at, sig.raw_text, sig.ref_order, sig.order_end_state,
        sig.market_type, sig.transport, sig.backfill ? 1 : 0, sig.session, sig.needs_reconcile ? 1 : 0,
        sig.claim_id, sig.claim_owner, sig.claim_at,
        sig.invalid_validity ? 1 : 0,
        sig.status, sig.mode_applied, sig.thread_id,
        sig.decision ? JSON.stringify(sig.decision) : null, sig.created_at, sig.updated_at, sig.subscription_job_id ?? 'unknown', sig.kind ?? null, sig.reason ?? null, sig.arbitrage ? JSON.stringify(sig.arbitrage) : null,
      );
  }

  /**
   * 幂等插入。已经有同 `signal_id` 的行时:
   *
   * - **终态行不动**(它已经处置过了)。
   * - **还没处置完的行(`new`)要合并历史标记**(R4-04):`backfill` 取「或」、`session` 用新的那次。
   *   原来这里直接返回库里的旧行,于是「补拉又拉到同一条」「上个会话留下的 new 行」这两种情况里,
   *   调用方传进来的 `backfill:true` 被丢掉 —— 旧信号仍按实时处理,gated 还会去花模型钱。
   * - 其余非终态(`triggered`/`applying`)原样返回,由调用方走隔离路径。
   */
  capture(sig: TraderSignal): { signal: TraderSignal; created: boolean } {
    // Transport-independent boundary: persisted rows and returned/SSE values are both safe.
    // 入库脱敏覆盖 raw_text / ref_order / decision 等所有文本,但 id / signal_id 是主键与查找键,保持原样(出站另有 redactSignal)。
    sig = { ...redactSignalSecrets(sig), id: sig.id, signal_id: sig.signal_id };
    const existing = this.bySignalId(sig.signal_id);
    if (!existing) {
      this.save(sig);
      return { signal: sig, created: true };
    }
    if (existing.status === 'new') {
      const merged: TraderSignal = {
        ...existing,
        backfill: existing.backfill || sig.backfill,
        session: sig.session ?? existing.session,
        updated_at: Date.now(),
      };
      if (merged.backfill !== existing.backfill || merged.session !== existing.session) this.save(merged);
      return { signal: merged, created: false };
    }
    return { signal: existing, created: false };
  }

  /**
   * **原子领取**一条 `review_only` 信号去执行(人工 apply)。
   *
   * 条件更新 `WHERE status='review_only'`,并写下**领取身份**(R5-01):
   * `claim_id`(这一次操作的唯一 id)、`claim_owner`(进程 epoch)、`claim_at`。
   * 返回 `null` = 没抢到(别人已经在处理 / 状态不对),调用方回 409。
   */
  claimForApply(idOrSignalId: string, owner: string, claimId: string, now = Date.now()): TraderSignal | null {
    const row = this.find(idOrSignalId);
    if (!row || row.kind === 'arbitrage') return null;
    const r = this.db
      .prepare(
        `UPDATE demo_trader_signal SET status = 'applying', claim_id = ?, claim_owner = ?, claim_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('review_only','apply_failed')`,
      )
      .run(claimId, owner, now, now, row.id);
    if (Number(r.changes) !== 1) return null;
    return this.get(row.id);
  }

  /**
   * 这次领取**还是不是我的**(R5-01)。发送前回调要问一次:
   * 不是了就说明它已经被隔离 / 被别人接管,这次发送必须放弃。
   */
  claimStillOwned(id: string, claimId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM demo_trader_signal WHERE id = ? AND status = 'applying' AND claim_id = ?`)
      .get(id, claimId) as { ok: number } | undefined;
    return row !== undefined;
  }

  /**
   * 按领取身份保存结果(R5-01)。条件更新 `WHERE status='applying' AND claim_id=?`;
   * 返回 false = 这次领取已经不归我了,**放弃保存**(调用方记日志,不覆盖当前状态)。
   */
  saveIfOwned(sig: TraderSignal, claimId: string): boolean {
    // 入库脱敏覆盖 raw_text / ref_order / decision 等所有文本,但 id / signal_id 是主键与查找键,保持原样(出站另有 redactSignal)。
    sig = { ...redactSignalSecrets(sig), id: sig.id, signal_id: sig.signal_id };
    const r = this.db
      .prepare(
        `UPDATE demo_trader_signal SET status = ?, mode_applied = ?, thread_id = ?, decision = ?,
           needs_reconcile = ?, claim_id = NULL, claim_owner = NULL, claim_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'applying' AND claim_id = ?`,
      )
      .run(sig.status, sig.mode_applied, sig.thread_id, sig.decision ? JSON.stringify(sig.decision) : null,
        sig.needs_reconcile ? 1 : 0, sig.updated_at, sig.id, claimId);
    return Number(r.changes) === 1;
  }

  /**
   * **上个进程**留下的 `applying` 行(启动恢复用)。判据是 `claim_owner !== 当前 epoch` ——
   * 本进程正在执行中的领取绝不能被当成「崩溃遗留」(R5-01)。
   */
  abandonedApplying(currentOwner: string, limit = 50): TraderSignal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM demo_trader_signal WHERE status = 'applying' AND (claim_owner IS NULL OR claim_owner != ?)
          ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(currentOwner, Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map((r) => this.row(r)!).filter(Boolean);
  }

  /** 人工「已核对」:只清 `needs_reconcile`,不动钱、不改状态(R5-01)。 */
  clearNeedsReconcile(idOrSignalId: string, now = Date.now()): TraderSignal | null {
    const row = this.find(idOrSignalId);
    if (!row) return null;
    this.db.prepare(`UPDATE demo_trader_signal SET needs_reconcile = 0, updated_at = ? WHERE id = ?`).run(now, row.id);
    return this.get(row.id);
  }

  /**
   * 人工待办:库里所有 `review_only` **与 `apply_failed`**(R5-02:明确失败也要醒目地摆在待办里)。
   * 不靠内存列表,重启后照样完整。
   */
  pendingReview(limit = 200): TraderSignal[] {
    const rows = this.db
      .prepare(`SELECT * FROM demo_trader_signal WHERE status IN ('review_only','apply_failed') ORDER BY published_at DESC LIMIT ?`)
      .all(Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map((r) => this.row(r)!).filter(Boolean);
  }

  /** 待办总数(R5-04 披露用:`pendingReview` 有上限,前端要能知道有没有被截断)。 */
  pendingReviewCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM demo_trader_signal WHERE status IN ('review_only','apply_failed')`)
      .get() as { n: number };
    return Number(row.n);
  }

  private row(r: Record<string, unknown> | undefined): TraderSignal | null {
    if (!r) return null;
    return {
      ...(r['kind'] === 'arbitrage' ? {kind:'arbitrage' as const, reason:'arbitrage_recorded_only' as const, arbitrage:JSON.parse(String(r['arbitrage_json']))} : {}),
      id: String(r['id']),
      signal_id: String(r['signal_id']),
      record_id: r['record_id'] === null ? null : Number(r['record_id']),
      trader: String(r['trader']),
      symbol: String(r['symbol']),
      side: (r['side'] as Direction | null) ?? null,
      action: r['action'] as TraderAction,
      entry_kind: r['entry_kind'] as TraderEntryKind,
      entry_prices: JSON.parse(String(r['entry_prices'])) as string[],
      stop: r['stop'] === null ? null : String(r['stop']),
      tps: JSON.parse(String(r['tps'])) as TraderTakeProfit[],
      size_pct: r['size_pct'] === null ? null : String(r['size_pct']),
      valid_until: r['valid_until'] === null ? null : Number(r['valid_until']),
      published_at: Number(r['published_at']),
      ingested_at: Number(r['ingested_at']),
      raw_text: String(r['raw_text']),
      ref_order: r['ref_order'] === null || r['ref_order'] === undefined ? null : String(r['ref_order']),
      order_end_state: r['order_end_state'] === null || r['order_end_state'] === undefined ? null : String(r['order_end_state']),
      market_type: String(r['market_type'] ?? 'perpetual'),
      transport: String(r['transport'] ?? ''),
      subscription_job_id: String(r['subscription_job_id'] ?? 'unknown'),
      backfill: Number(r['backfill'] ?? 0) === 1,
      session: r['session'] === null || r['session'] === undefined ? null : String(r['session']),
      needs_reconcile: Number(r['needs_reconcile'] ?? 0) === 1,
      claim_id: r['claim_id'] === null || r['claim_id'] === undefined ? null : String(r['claim_id']),
      claim_owner: r['claim_owner'] === null || r['claim_owner'] === undefined ? null : String(r['claim_owner']),
      claim_at: r['claim_at'] === null || r['claim_at'] === undefined ? null : Number(r['claim_at']),
      invalid_validity: Number(r['invalid_validity'] ?? 0) === 1,
      status: r['status'] as TraderSignalStatus,
      mode_applied: (r['mode_applied'] as FollowMode | null) ?? null,
      thread_id: r['thread_id'] === null ? null : String(r['thread_id']),
      decision: r['decision'] === null ? null : (JSON.parse(String(r['decision'])) as TraderDecision),
      created_at: Number(r['created_at']),
      updated_at: Number(r['updated_at']),
    };
  }

  get(id: string): TraderSignal | null {
    return this.row(this.db.prepare('SELECT * FROM demo_trader_signal WHERE id = ?').get(id) as Record<string, unknown> | undefined);
  }
  bySignalId(signalId: string): TraderSignal | null {
    return this.row(this.db.prepare('SELECT * FROM demo_trader_signal WHERE signal_id = ?').get(signalId) as Record<string, unknown> | undefined);
  }
  /** 路由用:`id` 或 `signal_id` 都认(前端拿到的是哪个都能 apply)。 */
  find(idOrSignalId: string): TraderSignal | null {
    return this.get(idOrSignalId) ?? this.bySignalId(idOrSignalId);
  }

  list(q: TraderSignalQuery = {}): TraderSignal[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.job_id) (where.push('subscription_job_id = ?'), args.push(q.job_id));
    if (q.trader) (where.push('trader = ?'), args.push(q.trader));
    if (q.symbol) (where.push('symbol = ?'), args.push(q.symbol.toUpperCase()));
    if (q.status) (where.push('status = ?'), args.push(q.status));
    if (q.action) (where.push('action = ?'), args.push(q.action));
    if (q.since !== null && q.since !== undefined) (where.push('published_at >= ?'), args.push(q.since));
    const limit = Math.min(500, Math.max(1, q.limit ?? 100));
    const rows = this.db
      .prepare(`SELECT * FROM demo_trader_signal ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY published_at DESC, id DESC LIMIT ?`)
      .all(...args, limit) as Record<string, unknown>[];
    return rows.map((r) => this.row(r)!).filter(Boolean);
  }

  /**
   * inbox 里还没处置完的行,**按因果顺序(published_at 升序)**取最旧的一批(R2-02)。
   *
   * 第一版是「按 published_at **降序** LIMIT 20,再在内存里升序排」——那只是「最新 20 条内部的先后」:
   * 一条旧 open 落在窗口外、它的 close 落在窗口内时,close 会先被处理(落孤儿),open 后处理。
   * 这里直接在 SQL 里升序取最旧的,拿到的就是全局最早那几条。
   */
  pendingInbox(limit = 20): TraderSignal[] {
    const rows = this.db
      .prepare(`SELECT * FROM demo_trader_signal WHERE status IN ('new','triggered') ORDER BY published_at ASC, record_id ASC, id ASC LIMIT ?`)
      .all(Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map((r) => this.row(r)!).filter(Boolean);
  }

  /** 某人某币最近一条**开仓类**信号(重复开仓判定用)。 */
  lastOpening(trader: string, symbol: string): TraderSignal | null {
    const rows = this.db
      .prepare(`SELECT * FROM demo_trader_signal WHERE trader = ? AND symbol = ? AND action IN ('open','add') ORDER BY published_at DESC LIMIT 1`)
      .all(trader, symbol.toUpperCase()) as Record<string, unknown>[];
    return rows.length ? this.row(rows[0]) : null;
  }

  /**
   * 这个带单员今天用掉了几次「信号处理额度」(R4-05)。
   *
   * 两条口径都和第一版不同:
   * 1. **按实际处理时刻计数**(`updated_at`),不是 `published_at`。按发布时刻数会两头错:
   *    补拉今天 6 条昨天的信号能把今天的额度耗光;而午夜后处理的昨晚信号花的是今天的模型钱、
   *    却记在昨天的账上。
   * 2. **只数真的花了东西的**:`review_only`(gated 调过模型 / copy 生成了计划等人)与
   *    `applying`/`applied`/`apply_failed`/`triggered`。补拉与 `evidence` 不计 ——
   *    它们在判定早期就退出了,没调模型、也没进人工队列。
   *
   * 它是**信号处理额度**,不是模型预算的替代品:全局模型预算由 `daily_judgment_cap` 在
   * gated 入队/出队各查一次(见 runtime 的 `judgeTraderSignal`)。
   */
  openingsSince(trader: string, sinceAt: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM demo_trader_signal
          WHERE trader = ? AND updated_at >= ? AND action IN ('open','add')
            AND mode_applied IS NOT NULL AND backfill = 0
            AND status IN ('review_only','triggered','applying','applied','apply_failed')`,
      )
      .get(trader, sinceAt) as { n: number };
    return Number(row.n);
  }

  /** 每人一行的本地统计(触发数 / 跟了几单 / 各状态分布)。 */
  perTrader(sinceAt: number | null = null): { trader: string; signals: number; applied: number; skipped: number; evidence: number; review_only: number; mgmt_applied: number; mgmt_orphan: number }[] {
    const rows = this.db
      .prepare(
        `SELECT trader,
                COUNT(*) AS signals,
                SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
                SUM(CASE WHEN status = 'evidence' THEN 1 ELSE 0 END) AS evidence,
                SUM(CASE WHEN status = 'review_only' THEN 1 ELSE 0 END) AS review_only,
                SUM(CASE WHEN status = 'mgmt_applied' THEN 1 ELSE 0 END) AS mgmt_applied,
                SUM(CASE WHEN status = 'mgmt_orphan' THEN 1 ELSE 0 END) AS mgmt_orphan
         FROM demo_trader_signal ${sinceAt === null ? '' : 'WHERE published_at >= ?'} GROUP BY trader ORDER BY signals DESC`,
      )
      .all(...(sinceAt === null ? [] : [sinceAt])) as Record<string, number | string>[];
    return rows.map((r) => ({
      trader: String(r['trader']),
      signals: Number(r['signals'] ?? 0),
      applied: Number(r['applied'] ?? 0),
      skipped: Number(r['skipped'] ?? 0),
      evidence: Number(r['evidence'] ?? 0),
      review_only: Number(r['review_only'] ?? 0),
      mgmt_applied: Number(r['mgmt_applied'] ?? 0),
      mgmt_orphan: Number(r['mgmt_orphan'] ?? 0),
    }));
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM demo_trader_signal').get() as { n: number }).n);
  }
}
