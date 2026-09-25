/**
 * 跟单 session 的**拉取层**:Signal Bridge 订阅者 Agent Pull 客户端。
 * 设计 `docs/design/trader-follow-2026-09-12.md` §1;协议 `docs/research/bridge-and-stats-api-2026-09-12.md` §A。
 *
 * 硬规则:
 * - **对 bridge 只读**:只打 `GET /me` 与 `GET /signals`,再加投递回执 `POST /agent-deliveries`(那是游标 ack,
 *   不改桥上任何业务数据)。不建 target、不改 parser、不碰别的订阅者。
 * - **游标要用响应的 `scanned_to_id`**,不是 `items[-1].record_id` —— 被过滤掉的记录也算扫过了,
 *   用最后一条 item 的 id 会在有白名单的订阅者上永远重扫同一段。游标存 kv `follow.cursor`。
 * - **凭证不进代码、不进日志**:env `TG_FOLLOW_BRIDGE_KEY` / `TG_FOLLOW_BRIDGE_SECRET` 优先,
 *   其次 kv `follow.credentials`;对外(API / 日志)一律 `maskSecret`。
 * - **自定义 UA**:默认 UA 会被 Cloudflare error 1010 拦(8794 `subscription.rs` 踩过)。
 * - **退避**:连续失败 `base × 2^(n-1)`,封顶 60s;恢复立刻回到正常节奏。
 * - **启动补拉一律 review_only**:标记在**拉取那一刻**打好(`backfill: true`),不让消费端猜
 *   (8794 §1.1 移植清单第 10 条)。
 * - 网络请求全部可注入(`deps.fetch`),测试不连网。
 */

import { normalizeBridgeSignal, type TraderSignal } from './trader-signal.js';

export const FOLLOW_USER_AGENT = 'trading-swarm-follow/0.1';
export const FOLLOW_AGENT_ID = 'trading-swarm-follow';
/** 指数退避封顶(8794 `MAX_TARGET_BACKOFF_SECONDS`)。 */
export const FOLLOW_MAX_BACKOFF_MS = 60_000;
export const FOLLOW_BASE_BACKOFF_MS = 5_000;
/** 长轮询等待(bridge clamp 0–30s)。 */
export const FOLLOW_WAIT_SECONDS = 10;
export const FOLLOW_REQUEST_TIMEOUT_MS = 35_000;
/** 启动补拉默认条数(设计 §5 验收用 500)。 */
export const FOLLOW_BACKFILL_DEFAULT = 200;

export const FOLLOW_CURSOR_KEY = 'follow.cursor';
export const FOLLOW_DLQ_KEY = 'follow.dlq';
/** 补拉阶段的持久化水位(P1-07):`{ target, done }`。进程重启后接着补,不会「以为补完了」。 */
export const FOLLOW_BACKFILL_KEY = 'follow.backfill';

/** 连续第 n 次失败该等多久(n 从 1 起)。 */
export function backoffMs(failures: number, base = FOLLOW_BASE_BACKOFF_MS, cap = FOLLOW_MAX_BACKOFF_MS): number {
  if (failures <= 0) return 0;
  const raw = base * 2 ** (failures - 1);
  return Math.min(cap, Number.isFinite(raw) ? raw : cap);
}

export interface FollowCredentials {
  api_key: string;
  secret_token: string;
}

/** 脱敏:只留前缀和最后 4 位(`sbk_…abcd`)。空值 → null。 */
export function maskSecret(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v);
  const prefix = /^(sbk_|sbs_)/.exec(s)?.[1] ?? '';
  const tail = s.slice(-4);
  return `${prefix}***${tail}`;
}

/** 一条坏行的留痕(DLQ)。原文不进这里,只留 id 与原因。 */
export interface FollowDlqEntry {
  at: number;
  signal_id: string | null;
  record_id: number | null;
  error: string;
  /** `bridge` = 桥自己逐条容错跳过的;`normalize` = 我们这边归一化失败的。 */
  stage: 'bridge' | 'normalize';
}

export interface FollowDlq {
  count: number;
  /** 最近若干条(上限 50);观测用,不是重放队列。 */
  recent: FollowDlqEntry[];
}

export interface FollowKv {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
}

/** 注入点:只要求 `fetch` 的那一小块形状,测试给个假的就行。 */
export type FollowFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface TraderFeedDeps {
  kv: FollowKv;
  fetch: FollowFetch;
  /** bridge 基址(不带尾斜杠);来自 `workflow.follow.bridge_url`。 */
  baseUrl: () => string;
  credentials: () => FollowCredentials | null;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  instanceId?: string;
}

export interface PullResult {
  /** 归一化成功的信号(已按 `backfill` 标记好)。 */
  signals: TraderSignal[];
  /** 请求时用的游标。 */
  cursor: number;
  /**
   * 这一页扫到哪了 —— **调用方把这一页安全落库之后**才调 `commitCursor(next_cursor)`(复审 P1-06)。
   * 第一版在返回前就把游标推进了:落库失败或进程崩在中间,下一轮从新游标起,整页信号永久丢失
   * (管理离场指令丢一条就是一笔仓没人平)。
   */
  next_cursor: number;
  /** 桥跳过的坏行数 + 我们归一化失败的行数。 */
  dropped: number;
  /** 这一页里被隔离的 record_id(全是坏行的一页也要能安全前进,不然会反复读同一坏页)。 */
  quarantined: number[];
  waited: boolean;
  /** 本次请求出错时的原因;成功为 null。 */
  error: string | null;
}

export interface FeedStatus {
  connected: boolean;
  cursor: number;
  last_ok_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  failures: number;
  next_attempt_at: number | null;
  dlq: FollowDlq;
  credentials: { configured: boolean; source: 'env' | null; api_key: string | null; secret_token: string | null };
  backfilled: boolean;
}

/**
 * 凭证**只从 env 读**(复审 P1-14)。
 *
 * 原来还有一条 kv 路径(`follow.credentials`,由 `POST /api/follow` 写进 state.sqlite)。那条路径已删:
 * AGENTS.md 第 1 条的字面规矩是「TS 进程里不得出现 API key/secret」。bridge 的订阅 key 不是交易所 key,
 * 但把它落进 gateway 自己的库 = 在 TS 侧**持密**,和那条硬边界直接冲突;env 至少是进程边界外注入、
 * 不落我们的盘、不进备份、不会被任何一条读 kv 的路由顺手带出去。
 *
 * 两个字段都要有才算配上(只配一半 = 没配,不是「半配」)。
 */
export function readCredentials(_kv: FollowKv | null, env: Record<string, string | undefined> = process.env): { creds: FollowCredentials | null; source: 'env' | null } {
  const envKey = (env['TG_FOLLOW_BRIDGE_KEY'] ?? '').trim();
  const envSecret = (env['TG_FOLLOW_BRIDGE_SECRET'] ?? '').trim();
  if (envKey && envSecret) return { creds: { api_key: envKey, secret_token: envSecret }, source: 'env' };
  return { creds: null, source: null };
}

/**
 * 从任意文本里抹掉 bridge 凭证(复审 P1-14)。
 *
 * bridge 的错误正文、`skipped[].error`、fetch 抛出的异常都可能把我们发过去的 key/secret 原样回显,
 * 而这些字符串会进 `last_error`、DLQ、日志、`GET /api/follow`、SSE。专用字段上的 `maskSecret`
 * 覆盖不到这些路径,所以**所有**对外字符串都过这一层。除了当前凭证,还按前缀兜住任何
 * `sbk_`/`sbs_` 形状的串(换过的旧 key、别的订阅者的 key)。
 */
/**
 * **递归**脱敏任意输出对象(R5-03)。
 *
 * 五审点得对:按字段逐个列的做法必然漏 —— `signal_id`、`decision` 里的整棵子树
 * (`note`/`plan.reason`/`agent.blocked[]`)、DLQ 的 id、以及旧库里入口脱敏之前落下的行,
 * 都从「列举法」的缝里漏出去过。所以出口这一层改成**遍历所有字符串**:
 * 对象、数组、Map 之外的一切原样;字符串一律过 `redactSecrets`。
 *
 * 它只用在**出站边界**(HTTP 响应、SSE、日志、人工待办),不改库里的业务值 ——
 * 幂等键(`signal_id`)在库里必须保持原样,否则同一条信号会变成两条。
 */
export function redactDeep<T>(value: T, creds: FollowCredentials | null = null): T {
  if (typeof value === 'string') return redactSecrets(value, creds) as unknown as T;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, creds)) as unknown as T;
  if (typeof value === 'object') {
    // Date / RegExp 这类内建对象原样返回(它们没有要脱敏的自有字符串字段)。
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, creds);
    return out as unknown as T;
  }
  return value;
}

/**
 * 一条信号的出站脱敏。**直接走 `redactDeep`**(R5-03):
 * 逐字段列举那版漏掉了 `signal_id`、`decision` 整棵子树、`session` 等。
 */
export function redactSignalSecrets(sig: TraderSignal, creds: FollowCredentials | null = null): TraderSignal {
  return redactDeep(sig, creds);
}

export function redactSecrets(text: string, creds: FollowCredentials | null = null): string {
  let out = String(text ?? '');
  for (const v of [creds?.api_key, creds?.secret_token, process.env['TG_FOLLOW_BRIDGE_KEY'], process.env['TG_FOLLOW_BRIDGE_SECRET']]) {
    const t = (v ?? '').trim();
    if (t.length >= 8) out = out.split(t).join(maskSecret(t) ?? '***');
  }
  // R5-03:**不要求词边界、不区分大小写**。`sig_sbk_abcdef123456` 里 `sbk` 前面是下划线,
  // `\b` 匹配不上 —— 于是「别人的 key / 旧 key 嵌在 id 里」这种形状兜不住。
  return out.replace(/(sbk|sbs)_[A-Za-z0-9_-]{8,}/gi, (m) => maskSecret(m) ?? '***');
}

export class TraderFeed {
  private failures = 0;
  private lastOkAt: number | null = null;
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private nextAttemptAt: number | null = null;
  private backfilled = false;

  constructor(private readonly deps: TraderFeedDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  cursor(): number {
    const raw = this.deps.kv.kvGet(FOLLOW_CURSOR_KEY);
    const n = Number(raw ?? 0);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }

  /**
   * 提交游标 —— **只在这一页已经安全落库之后调**(P1-06)。
   * 游标只前进:并发/重放时一个更小的 scanned_to_id 不能把它拽回去(那会重灌一整段)。
   */
  commitCursor(after: number): void {
    if (!Number.isInteger(after) || after < 0) return;
    if (after <= this.cursor()) return;
    this.deps.kv.kvSet(FOLLOW_CURSOR_KEY, String(after));
  }

  /** 起步游标(补拉定的那个水位):可以往回设,只在补拉起点用。 */
  resetCursor(to: number): void {
    if (!Number.isInteger(to) || to < 0) return;
    this.deps.kv.kvSet(FOLLOW_CURSOR_KEY, String(to));
  }

  dlq(): FollowDlq {
    const raw = this.deps.kv.kvGet(FOLLOW_DLQ_KEY);
    if (!raw) return { count: 0, recent: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<FollowDlq>;
      return { count: Number(parsed.count ?? 0), recent: Array.isArray(parsed.recent) ? (parsed.recent as FollowDlqEntry[]).slice(0, 50) : [] };
    } catch {
      return { count: 0, recent: [] };
    }
  }

  private pushDlq(entries: FollowDlqEntry[]): void {
    if (!entries.length) return;
    const cur = this.dlq();
    const next: FollowDlq = { count: cur.count + entries.length, recent: [...entries, ...cur.recent].slice(0, 50) };
    this.deps.kv.kvSet(FOLLOW_DLQ_KEY, JSON.stringify(next));
    this.deps.log?.('warn', `跟单信号有 ${entries.length} 条坏行(累计 ${next.count});这是「数据需要人工看」的信号,不是可以忽略的噪声`, { stages: entries.map((e) => e.stage) });
  }

  status(): FeedStatus {
    const { creds, source } = this.credentialView();
    return {
      connected: this.lastOkAt !== null && this.failures === 0,
      cursor: this.cursor(),
      last_ok_at: this.lastOkAt,
      last_error: this.lastError,
      last_error_at: this.lastErrorAt,
      failures: this.failures,
      next_attempt_at: this.nextAttemptAt,
      dlq: this.dlq(),
      credentials: {
        configured: creds !== null,
        source,
        api_key: maskSecret(creds?.api_key),
        secret_token: maskSecret(creds?.secret_token),
      },
      backfilled: this.backfilled,
    };
  }

  private credentialView(): { creds: FollowCredentials | null; source: 'env' | null } {
    const creds = this.deps.credentials();
    return creds ? { creds, source: 'env' } : { creds: null, source: null };
  }

  /** 现在可不可以再打一次(退避窗口内 → false)。 */
  ready(now = this.now()): boolean {
    return this.nextAttemptAt === null || now >= this.nextAttemptAt;
  }

  private headers(creds: FollowCredentials): Record<string, string> {
    return {
      'X-API-Key': creds.api_key,
      'X-Secret-Token': creds.secret_token,
      'User-Agent': FOLLOW_USER_AGENT,
      accept: 'application/json',
    };
  }

  private onOk(): void {
    this.failures = 0;
    this.lastOkAt = this.now();
    this.lastError = null;
    this.nextAttemptAt = null;
  }

  private onFail(messageRaw: string): void {
    this.failures += 1;
    const now = this.now();
    // 凭证可能在 bridge 的错误正文里被原样回显;last_error 会进 GET /api/follow 和日志。
    const message = redactSecrets(messageRaw, this.deps.credentials());
    this.lastError = message;
    this.lastErrorAt = now;
    this.nextAttemptAt = now + backoffMs(this.failures);
    this.deps.log?.('warn', `跟单拉取失败(第 ${this.failures} 次,退避 ${Math.round(backoffMs(this.failures) / 1000)}s):${message}`);
  }

  private async request(path: string, query: Record<string, string | number>): Promise<Record<string, unknown>> {
    const creds = this.deps.credentials();
    if (!creds) throw new Error('bridge 凭证未配置(env TG_FOLLOW_BRIDGE_KEY/TG_FOLLOW_BRIDGE_SECRET 或设置里填)');
    const base = this.deps.baseUrl().replace(/\/+$/, '');
    if (!base) throw new Error('follow.bridge_url 未配置');
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))).toString();
    const url = `${base}/api/v1/subscriber/${path}${qs ? `?${qs}` : ''}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FOLLOW_REQUEST_TIMEOUT_MS);
    try {
      const res = await this.deps.fetch(url, { method: 'GET', headers: this.headers(creds), signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`bridge ${path} HTTP ${res.status}:${redactSecrets(text.slice(0, 200), creds)}`);
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object') throw new Error(`bridge ${path} 返回体不是对象`);
      return parsed as Record<string, unknown>;
    } catch (e) {
      // fetch / JSON 抛出的异常消息里也可能带着 URL 或 header 里的凭证。
      throw new Error(redactSecrets((e as Error).message, creds));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 新装机起步游标:`GET /me?recent=N` 的 `recent_after_id` 是「按本订阅者可见口径往前数满 N 条」的安全起点。
   * **不要**拿全库 max−N 做算术(带过滤的订阅者会永久漏掉本该收到的历史)。
   */
  async me(recent: number): Promise<{ recent_after_id: number | null; cursor: number | null }> {
    const body = await this.request('me', { recent: Math.max(0, Math.min(5000, Math.round(recent))) });
    const n = Number(body['recent_after_id']);
    // 全库游标水位:字段名各版本叫法不同,按优先级找**第一个真的是整数**的。
    // R3-04:不能先 `map(Number)` —— `cursor: null` 会变成 0,而 0 排在后面那些有效候选前面,
    // 于是「水位 0」被当成合法边界,第一页就算补完(游标 >= 0 恒真)。
    // R4-04:**严格类型** —— 只认真的 number(整数、非负)。
    // `Number(raw)` 会把 `[]`、`''`、`' '`、`true` 都变成 0/1;水位是「历史边界」,
    // 一个假的 0 会让第一页就算补完,后面整段历史被当 live 处理。
    let wm: number | null = null;
    for (const raw of [body['cursor'], body['latest_record_id'], body['max_record_id'], body['scanned_to_id']]) {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) continue;
      wm = raw;
      break;
    }
    return { recent_after_id: Number.isInteger(n) && n >= 0 ? n : null, cursor: wm };
  }

  /**
   * 启动补拉:把游标退到「最近 N 条」的起点,然后一路拉完。这一批的每条信号都带 `backfill: true`,
   * 消费端一律 `review_only` —— 补拉永远不自动开仓。
   */
  /**
   * 补拉阶段的持久化状态(P1-07 + R2-03)。
   *
   * `target` = **本次会话**定下的历史边界水位;`session` = 定它的那个会话 id(进程 epoch)。
   * **`done` 只在同一个会话内有效**:重启、或把 follow 关掉再打开,都算新会话 ——
   * 停机/停跟期间入桥的那些信号对新会话来说全是历史,必须重新定边界再判断追上没有。
   * 第一版把 `done=true` 跨会话沿用:重启后第一页就按 live 处理,一条停机期间的 close
   * 只要没超过 300 秒新鲜度就会去动现仓(二审 R2-03 的确定路径)。
   */
  backfillState(): { target: number | null; done: boolean; session: string | null } {
    const raw = this.deps.kv.kvGet(FOLLOW_BACKFILL_KEY);
    if (!raw) return { target: null, done: false, session: null };
    try {
      const p = JSON.parse(raw) as { target?: number; done?: boolean; session?: string };
      return { target: Number.isInteger(p.target) ? p.target! : null, done: p.done === true, session: typeof p.session === 'string' ? p.session : null };
    } catch {
      return { target: null, done: false, session: null };
    }
  }

  /** 本次会话的 id(runtime 传进来的进程 epoch)。 */
  private session(): string {
    return this.deps.instanceId ?? 'default';
  }

  private saveBackfillState(next: { target: number | null; done: boolean }): void {
    this.deps.kv.kvSet(FOLLOW_BACKFILL_KEY, JSON.stringify({ ...next, session: this.session() }));
  }

  /** 补拉完成了没有 —— **只认本会话**(见 `backfillState` 注释)。 */
  backfillDone(): boolean {
    const st = this.backfillState();
    return st.done && st.session === this.session();
  }

  /**
   * 启动补拉一步(P1-07)。**可重入、可续**:
   *
   * 1. 第一次调用时用 `GET /me?recent=N` 定两个数 —— 起点 `recent_after_id` 与**目标水位**
   *    `cursor`(全库当前水位)。两个数都落 kv,进程重启后接着补。
   * 2. 每次只拉一页,落库由调用方做完再 `commitCursor`;只有**游标追上目标水位**才置 `done`。
   *    第一版的三个 bug 都在这:`followBackfilled` 在调用前就设 true(/me 失败也直接切 live)、
   *    「只有被过滤记录的空页」被当成补完(后面还有历史)、40 页上限耗尽也算补完 ——
   *    剩下那段历史里还在 freshness 内的 open 会以 `backfill=false` 被自动下单。
   *
   * 返回 `done=false` 就该再调一次(下一个 tick);`error` 非空时保持未完成,继续退避重试。
   */
  async backfillStep(recent = FOLLOW_BACKFILL_DEFAULT): Promise<{ signals: TraderSignal[]; next_cursor: number; done: boolean; target: number | null; error: string | null }> {
    const st0 = this.backfillState();
    if (this.backfillDone()) return { signals: [], next_cursor: this.cursor(), done: true, target: st0.target, error: null };
    // 换会话了(重启 / 关了再开):上一次的水位与 done 都不算,重新定边界。
    let state: { target: number | null; done: boolean } = st0.session === this.session() ? { target: st0.target, done: st0.done } : { target: null, done: false };
    if (state.target === null) {
      try {
        const me = await this.me(recent);
        this.onOk();
        // 目标水位必须是**桥报的全库水位**。拿不到就不许猜:退回起点意味着「起点即终点」,
        // 第一页就算补完,后面那一整段历史全部按 live 处理(二审 R2-03)。
        if (me.cursor === null) {
          const msg = 'bridge /me 没给全库水位,定不出历史边界;保持补拉状态重试(不切实时)';
          this.deps.log?.('warn', `跟单补拉:${msg}`);
          return { signals: [], next_cursor: this.cursor(), done: false, target: null, error: msg };
        }
        const target = me.cursor;
        if (me.recent_after_id !== null) this.resetCursor(me.recent_after_id);
        state = { target, done: false };
        this.saveBackfillState(state);
        this.deps.log?.('info', `跟单启动补拉:从 ${me.recent_after_id ?? 0} 补到水位 ${target}(这一批一律只进复盘)`);
      } catch (e) {
        const msg = redactSecrets((e as Error).message, this.deps.credentials());
        this.onFail(msg);
        return { signals: [], next_cursor: this.cursor(), done: false, target: null, error: msg };
      }
    }
    const r = await this.pullOnce({ backfill: true, waitSeconds: 0 });
    if (r.error) return { signals: [], next_cursor: r.cursor, done: false, target: state.target, error: r.error };
    // **补完的判据只有一个**:游标追上了本会话定下的水位。
    // 空页(全被过滤)不算完 —— 它只说明这一段没有属于我们的信号,后面可能还有。
    // 「游标不动的空页」也不算完(第一版的 `stuck` 分支):那是桥暂时没返回东西,
    // 未达水位就宣布完成会把剩下的历史当 live(二审 R2-03)。卡住就一直重试,由退避控节奏。
    const reachedTarget = state.target !== null && r.next_cursor >= state.target;
    if (!reachedTarget && r.next_cursor <= r.cursor && !r.signals.length && !r.dropped) {
      this.deps.log?.('info', `跟单补拉:游标 ${r.cursor} 还没到水位 ${state.target},但桥这一页什么都没返回;保持补拉状态下一轮重试`);
    }
    return { signals: r.signals, next_cursor: r.next_cursor, done: reachedTarget, target: state.target, error: null };
  }

  /** 补拉收尾:只有调用方确认整段都落库了才置 done。 */
  finishBackfill(): void {
    this.saveBackfillState({ target: this.backfillState().target, done: true });
    this.backfilled = true;
  }

  /** 拉一页。失败不抛:返回 `error` 并把退避推起来(调用方是巡检循环,不该被一次网络抖动打断)。 */
  async pullOnce(opts: { backfill?: boolean; waitSeconds?: number; limit?: number } = {}): Promise<PullResult> {
    const after = this.cursor();
    const wait = opts.waitSeconds ?? FOLLOW_WAIT_SECONDS;
    let body: Record<string, unknown>;
    try {
      body = await this.request('signals', {
        after_id: after,
        limit: Math.min(200, Math.max(1, opts.limit ?? 50)),
        scan_limit: 500,
        wait_seconds: Math.min(30, Math.max(0, wait)),
        poll_interval_seconds: 0.5,
        agent_id: FOLLOW_AGENT_ID,
        instance_id: this.deps.instanceId ?? 'default',
      });
    } catch (e) {
      const msg = redactSecrets((e as Error).message, this.deps.credentials());
      this.onFail(msg);
      return { signals: [], cursor: after, next_cursor: after, dropped: 0, quarantined: [], waited: false, error: msg };
    }
    this.onOk();
    const now = this.now();
    const creds = this.deps.credentials();
    const items = Array.isArray(body['items']) ? (body['items'] as Record<string, unknown>[]) : [];
    const dlq: FollowDlqEntry[] = [];
    // 桥自己逐条容错跳过的坏行:必须被上层观测(一条坏行曾让下游断流 3.5 小时而 health 全绿)。
    for (const s of Array.isArray(body['skipped']) ? (body['skipped'] as Record<string, unknown>[]) : []) {
      // R4-06:DLQ 记录本身也要脱敏 —— `signal_id` 可能整段带着凭证形状(那种行我们拒收,但留痕要干净)。
      dlq.push({ at: now, signal_id: s['signal_id'] === undefined ? null : redactSecrets(String(s['signal_id']), creds).slice(0, 160), record_id: s['record_id'] === undefined ? null : Number(s['record_id']), error: redactSecrets(String(s['error'] ?? 'bridge skipped'), creds).slice(0, 300), stage: 'bridge' });
    }
    const signals: TraderSignal[] = [];
    for (const item of items) {
      const recordId = Number(item['record_id']);
      const envelope = item['envelope'] && typeof item['envelope'] === 'object' ? (item['envelope'] as Record<string, unknown>) : {};
      const payload = envelope['payload'] ?? item['payload'] ?? item;
      const r = normalizeBridgeSignal(payload, { now, backfill: opts.backfill === true, session: this.session(), record_id: Number.isInteger(recordId) ? recordId : null });
      if (!r.signal) {
        dlq.push({ at: now, signal_id: item['signal_id'] === undefined ? null : redactSecrets(String(item['signal_id']), creds).slice(0, 160), record_id: Number.isInteger(recordId) ? recordId : null, error: redactSecrets(r.errors.join(';'), creds).slice(0, 300), stage: 'normalize' });
        continue;
      }
      // 归一化过程里的软错误(例如止损方向不对)也留痕,但信号照用(降级由消费端决定)。
      if (r.errors.length) dlq.push({ at: now, signal_id: redactSecrets(r.signal.signal_id, creds).slice(0, 160), record_id: r.signal.record_id, error: redactSecrets(r.errors.join(';'), creds).slice(0, 300), stage: 'normalize' });
      // R3-06:**在进入系统的这一刻**就把秘密抹掉(入库前、emit 前)。
      // 带单员原文里可能整段贴着一把 key(转发、截图文字、误粘贴都会),`sanitizeText` 只是文本清洗
      // 不是秘密替换 —— 不在这里抹,它会原样进 `demo_trader_signal.raw_text`、进 SSE、进日志。
      signals.push(redactSignalSecrets(r.signal, creds));
    }
    this.pushDlq(dlq);
    const scanned = Number(body['scanned_to_id']);
    // 游标 = scanned_to_id(被过滤掉的记录也算扫过了)。它缺失时,退回「本页所有见过的 record_id 的最大值」
    // —— 包括**被隔离的坏行**:一页全是坏行时只看成功信号会让游标原地不动,于是每轮都重读同一坏页、
    // DLQ 无限膨胀(复审最后一节点出的那条)。坏行已经进 DLQ 留痕了,可以安全跨过去。
    const seen = [...signals.map((x) => x.record_id ?? 0), ...dlq.map((d) => d.record_id ?? 0)];
    const nextCursor = Number.isInteger(scanned) && scanned > after ? scanned : Math.max(after, ...seen);
    return {
      signals,
      cursor: after,
      next_cursor: nextCursor,
      dropped: dlq.length,
      quarantined: dlq.map((d) => d.record_id).filter((x): x is number => x !== null),
      waited: body['waited'] === true,
      error: null,
    };
  }

  /**
   * 投递回执(游标观测用)。**只写自己这一路的进度**,不改桥上任何业务数据。
   * 失败只 warn:回执丢了最坏是桥上的「agent 落后多少」不准,不影响本地处置。
   */
  async ack(signalIds: readonly string[]): Promise<{ ok: boolean; error: string | null }> {
    if (!signalIds.length) return { ok: true, error: null };
    const creds = this.deps.credentials();
    const base = this.deps.baseUrl().replace(/\/+$/, '');
    if (!creds || !base) return { ok: false, error: '凭证或 bridge_url 未配置' };
    const deliveries = signalIds.slice(0, 500).map((signal_id) => ({ signal_id, agent_id: FOLLOW_AGENT_ID, status: 'SUCCESS', status_code: 200 }));
    try {
      const res = await this.deps.fetch(`${base}/api/v1/subscriber/agent-deliveries/batch`, {
        method: 'POST',
        headers: { ...this.headers(creds), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveries }),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, error: null };
    } catch (e) {
      this.deps.log?.('warn', `跟单回执失败(不影响本地处置):${(e as Error).message}`);
      return { ok: false, error: (e as Error).message };
    }
  }
}
