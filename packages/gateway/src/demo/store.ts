import { LogWriter } from './log-retention.js';
import { AGENT_REGISTRY, agentSessionId, isBotRole, isCanonicalSession } from './agent-registry.js';
import { collapseObservations, errorKind } from './alert-summary.js';
// SQLite persistence for the demo runtime (tables from migrations/0002_demo.sql).

import type { DatabaseSync } from 'node:sqlite';
import type { StateDb } from '../state-db.js';
import { sourceLabel } from './info.js';
import type { ActivityItem, ChatMessage, ChatSession, DemoIntent, EquityPoint, Episode, EpisodeSummary, InformationEvent, LogLine, MarketState, Strategy, StrategyRevision, StrategyThread, ThreadStatus, Workflow } from './types.js';
import { summarize } from './types.js';
import { MemoryStore } from './memory.js';
import { ensureBreakoutRetestV2, StrategyLibrary } from './strategies.js';
import type { BacktestRun, BacktestStep } from './backtest.js';
import type { AttributionPoint } from './attribution.js';
import { BotRegistry } from './bots.js';
import { ScreenStore } from './screener.js';
import { PortfolioStore, RiskStore } from './team-store.js';
import { JudgmentLedgerStore } from './judgment-ledger.js';
import { EventStore } from './events.js';
import { LabProbeQueue, ShadowThreadStore, StrategyEventStore } from './strategy-loop.js';
import { TraderSignalStore } from './trader-signal.js';

/**
 * 时间线摘要(types.ts summarize)用不到的大字段在 SQLite 里先剔掉再交给 JS 解析:
 * context_text / evidence / evidence_plan / decision_record / judgment_raw / memory 约占一条 episode JSON 的八成。
 * 只剔 summarize 不读的键(judgment 只读 action/direction/headline/confidence/reasons,council 只读 consensus,entry 只读 recommended/market_blocked),输出与全量解析逐字段相同;
 * 路径不存在时 json_remove 原样返回。改 summarize 读取的字段时要同步检查这里。
 */
const EPISODE_SUMMARY_JSON = "json_remove(json, '$.context_text', '$.evidence', '$.evidence_plan', '$.decision_record', '$.judgment_raw', '$.memory', '$.judgment.thesis', '$.judgment.watch_conditions', '$.strategy_council.verdicts', '$.strategy_council.code_consensus', '$.strategy_council.text', '$.entry_advice.text', '$.entry_advice.reason')";

export class DemoStore {
  /** v3.2 long-term memory (memory.ts) on the same sqlite handle. */
  readonly memory: MemoryStore;
  /** v3.5 strategy library (strategies.ts), seeded with the built-ins on first construction. */
  readonly strategies: StrategyLibrary;
  /** Bot 团队注册表(bots.ts):八个角色 + bot_runs + bot_handoffs。seed() 顺手断言 exchange.write 只有 executor 持有。 */
  readonly bots: BotRegistry;
  /** Radar 筛选产物(screener.ts):demo_screen + demo_watch_candidate。 */
  readonly screens: ScreenStore;
  /** Portfolio Manager 快照 / Risk Sentinel 告警(team-store.ts,migrations/0010)。 */
  readonly portfolio: PortfolioStore;
  readonly risk: RiskStore;
  /** 判断准确度账本(judgment-ledger.ts,migrations/0016;契约 §9.29)。零模型。 */
  readonly judgments: JudgmentLedgerStore;
  /** 事件区(events.ts,migrations/0016):三路 capture 的 market_events 表。 */
  readonly events: EventStore;
  /** 策略生命周期台账(strategy-loop.ts,migrations/0018;契约 §9.27)。 */
  readonly strategyEvents: StrategyEventStore;
  /** 影子实盘的虚拟线程(不下单、不占容量、不进风控、不进胜率;刻意不进 demo_threads)。 */
  readonly shadowThreads: ShadowThreadStore;
  /** attribution 的 param 提案排队等 Lab 验证(达标才 createVersion)。 */
  readonly labProbes: LabProbeQueue;
  /** 跟单 session 的信号表(trader-signal.ts,migrations/0022;契约 §9.38)。 */
  readonly traderSignals: TraderSignalStore;
  constructor(private readonly state: StateDb) {
    this.memory = new MemoryStore(state.db);
    this.strategies = new StrategyLibrary(state.db);
    this.strategies.seed();
    this.bots = new BotRegistry(state.db);
    this.bots.seed();
    this.ensureAgentSessions();
    this.screens = new ScreenStore(state.db);
    this.portfolio = new PortfolioStore(state.db);
    this.risk = new RiskStore(state.db);
    this.judgments = new JudgmentLedgerStore(state.db);
    this.events = new EventStore(state.db);
    this.strategyEvents = new StrategyEventStore(state.db);
    this.shadowThreads = new ShadowThreadStore(state.db);
    this.labProbes = new LabProbeQueue(state.db);
    this.traderSignals = new TraderSignalStore(state.db);
    // 漏斗跑出来的 breakout_retest v2 草稿(停在 backtest,实盘仍然走 paper 的 v1)。
    ensureBreakoutRetestV2(this.strategies);
  }
  /** Signal Market DAOs share the gateway database handle. */
  get marketDb() { return this.state.db; }
  private get db() {
    return this.state.db;
  }

  /**
   * 轮询读缓存(活动流 / 时间线摘要):UI 每 5 秒轮询,而这两张表几分钟才写一次,每次都读大 JSON + 解析是白烧主线程。
   * 失效是精确的,不引入陈旧:本连接的写只经 saveActivity / saveEpisode(写后立刻清对应前缀);
   * 其它连接/进程提交写入时 `PRAGMA data_version` 变化 → 整表清空;事务进行中不读不写缓存(不缓存未提交状态)。
   * 缓存值当只读用;返回时数组浅拷贝,调用方 sort/push 不会污染缓存。
   */
  private readCache = new Map<string, unknown>();
  private readCacheDataVersion = -1;
  private dataVersionStmt: ReturnType<DatabaseSync['prepare']> | null = null;
  private cachedRead<T>(key: string, load: () => T): T {
    if (this.db.isTransaction) return load();
    this.dataVersionStmt ??= this.db.prepare('PRAGMA data_version');
    const dv = Number((this.dataVersionStmt.get() as { data_version: number }).data_version);
    if (dv !== this.readCacheDataVersion) { this.readCache.clear(); this.readCacheDataVersion = dv; }
    if (this.readCache.has(key)) return this.readCache.get(key) as T;
    const value = load();
    if (this.readCache.size >= 64) this.readCache.clear();
    this.readCache.set(key, value);
    return value;
  }
  private invalidateReads(prefix: 'activity:' | 'episodes:'): void {
    for (const k of [...this.readCache.keys()]) if (k.startsWith(prefix)) this.readCache.delete(k);
  }

  loadStrategy(id: string): Strategy | null {
    const row = this.db.prepare('SELECT json FROM demo_strategies WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Strategy) : null;
  }
  saveStrategy(s: Strategy): void {
    this.db
      .prepare('INSERT INTO demo_strategies(id, symbol, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(s.id, s.symbol, JSON.stringify(s), s.updated_at);
  }
  addRevision(r: StrategyRevision): void {
    this.db.prepare('INSERT INTO demo_strategy_revisions(strategy_id, version, at, episode_id, json) VALUES (?, ?, ?, ?, ?)').run(r.strategy_id, r.version, r.at, r.episode_id, JSON.stringify(r));
  }
  revisions(strategyId: string, limit = 100): StrategyRevision[] {
    const rows = this.db.prepare('SELECT json FROM demo_strategy_revisions WHERE strategy_id = ? ORDER BY version DESC LIMIT ?').all(strategyId, limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as StrategyRevision);
  }

  saveEpisode(e: Episode): void {
    this.db
      .prepare('INSERT INTO demo_episodes(id, at, status, action, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, action = excluded.action, json = excluded.json')
      .run(e.id, e.at, e.status, e.judgment?.action ?? null, JSON.stringify(e));
    this.invalidateReads('episodes:');
  }
  episode(id: string): Episode | null {
    const row = this.db.prepare('SELECT json FROM demo_episodes WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Episode) : null;
  }
  episodes(limit = 50, beforeAt?: number): EpisodeSummary[] {
    return [...this.cachedRead(`episodes:${limit}:${beforeAt ?? ''}`, () => {
      const rows = (
        beforeAt
          ? this.db.prepare(`SELECT ${EPISODE_SUMMARY_JSON} AS json FROM demo_episodes WHERE at < ? ORDER BY at DESC LIMIT ?`).all(beforeAt, limit)
          : this.db.prepare(`SELECT ${EPISODE_SUMMARY_JSON} AS json FROM demo_episodes ORDER BY at DESC LIMIT ?`).all(limit)
      ) as { json: string }[];
      return rows.map((r) => summarize(JSON.parse(r.json) as Episode));
    })];
  }
  lastEpisode(): Episode | null {
    const row = this.db.prepare("SELECT json FROM demo_episodes WHERE status = 'done' ORDER BY at DESC LIMIT 1").get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Episode) : null;
  }
  opensSince(sinceAt: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM demo_intents WHERE at >= ? AND status IN ('submitted','filled','unknown') AND json LIKE '%\"kind\":\"open\"%'").get(sinceAt) as { n: number };
    return Number(row.n);
  }

  /** Cheap COUNT for the daily judgment cap (docs/demo/v3-ui-contract.md §9.7) — no JSON parsing. */
  episodeCountSince(sinceAt: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM demo_episodes WHERE at >= ?').get(sinceAt) as { n: number };
    return Number(row.n);
  }
  /** Today's token spend per brain name (`Episode.model`), for the usage_today estimate. */
  episodeUsageSince(sinceAt: number): { model: string; count: number; input_tokens: number; output_tokens: number }[] {
    const rows = this.db
      .prepare(
        // 先把索引中的小字段物化。直接 GROUP BY 表达式时 SQLite 仍会把整列 JSON 放进排序器。
        `WITH usage AS MATERIALIZED (
           SELECT COALESCE(json_extract(json, '$.model'), 'unknown') AS model,
                  COALESCE(json_extract(json, '$.usage.input_tokens'), 0) AS input_tokens,
                  COALESCE(json_extract(json, '$.usage.output_tokens'), 0) AS output_tokens
           FROM demo_episodes WHERE at >= ?
         )
         SELECT model, COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens FROM usage GROUP BY model`,
      )
      .all(sinceAt) as { model: string; n: number; input_tokens: number; output_tokens: number }[];
    return rows.map((r) => ({ model: String(r.model), count: Number(r.n), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens) }));
  }

  saveIntent(i: DemoIntent): void {
    this.db
      .prepare('INSERT INTO demo_intents(id, episode_id, at, status, json, market) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json, market = excluded.market')
      .run(i.id, i.episode_id, i.at, i.status, JSON.stringify(i), i.market ?? 'perp');
  }
  intent(id: string): DemoIntent | null {
    const row = this.db.prepare('SELECT json, market FROM demo_intents WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? ({ ...JSON.parse(row.json), market:(row as {market?:string}).market ?? 'perp' } as DemoIntent) : null;
  }
  intents(limit = 50): DemoIntent[] {
    const rows = this.db.prepare('SELECT json, market FROM demo_intents ORDER BY at DESC LIMIT ?').all(limit) as { json: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.json), market:(r as {market?:string}).market ?? 'perp' } as DemoIntent));
  }

  private logWriter?: LogWriter;
  flushLogs(): void { this.logWriter?.flush(); }
  log(line: LogLine): boolean {
    return (this.logWriter ??= new LogWriter(this.db)).write(line);
  }
  logs(limit = 200, beforeId?: number): LogLine[] { return this.logPage(limit, beforeId).logs; }
  logPage(limit = 200, beforeId?: number) {
    const rows = this.db.prepare('SELECT id, at, level, scope, message, json, repeat_count FROM demo_logs WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId ?? Number.MAX_SAFE_INTEGER, limit) as { id: number; at: number; level: LogLine['level']; scope: string; message: string; json: string | null; repeat_count: number }[];
    // newest first (matches the episode list and the WebUI's expectation)
    const logs = collapseObservations(rows.map((r) => ({ id: r.id, at: r.at, level: r.level, scope: r.scope, message: r.message, ...(r.repeat_count > 1 ? { observed_count: r.repeat_count } : {}), ...(r.json ? { data: JSON.parse(r.json) as unknown } : {}) })), (r) => r.level === 'info' ? null : JSON.stringify([r.scope, /^[A-Z0-9]+USDT/.exec(r.message)?.[0] ?? '', (r.data as { thread_id?: string } | undefined)?.thread_id ?? '', errorKind(r.message)])).map((r) => ({ ...r, message: `${r.message}${(r.observed_count ?? 1) > 1 ? ` ×${r.observed_count}` : ''}` }));
    return { logs, next_before_id: rows.length === limit ? rows.at(-1)!.id : null };
  }

  // ---------------------------------------------------------------- v2

  /** General demo-local key/value store (migrations/0005_demo_kv.sql). `null` when the key is unset. */
  kvGet(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM demo_kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  kvSet(key: string, value: string): void {
    if (key === 'protection_credentials' && value.trim().startsWith('[')) {
      const rows = JSON.parse(value) as import('./protection.js').ProtectionCredential[];
      const insert = this.db.prepare('INSERT INTO protection_credentials(channel,symbol,market,json) VALUES (?,?,?,?) ON CONFLICT(channel,symbol,market) DO UPDATE SET json=excluded.json');
      for (const r of rows) insert.run(r.channel, r.symbol ?? '', r.market ?? 'perp', JSON.stringify({...r, market:r.market ?? 'perp'}));
    }

    this.db
      .prepare('INSERT INTO demo_kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, Date.now());
  }
  loadWorkflowJson(): string | undefined {
    return this.state.kvGet('demo.workflow');
  }
  saveWorkflow(w: Workflow): void {
    this.state.kvSet('demo.workflow', JSON.stringify(w));
  }

  saveInfoEvents(events: InformationEvent[]): number {
    const ins = this.db.prepare('INSERT OR IGNORE INTO demo_info_events(id, kind, dedupe_key, occurred_at, ingested_at, json) VALUES (?, ?, ?, ?, ?, ?)');
    let n = 0;
    for (const e of events) n += Number(ins.run(e.id, e.kind, e.dedupe_key, e.occurred_at, e.ingested_at, JSON.stringify(e)).changes);
    return n;
  }
  infoEvents(limit = 100): InformationEvent[] {
    const rows = this.db.prepare('SELECT json FROM demo_info_events ORDER BY occurred_at DESC LIMIT ?').all(limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as InformationEvent);
  }

  saveMarketState(m: MarketState): void {
    this.db.prepare('INSERT INTO demo_market_states(id, as_of, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(m.id, m.as_of, JSON.stringify(m));
  }
  latestMarketState(): MarketState | null {
    const row = this.db.prepare('SELECT json FROM demo_market_states ORDER BY as_of DESC LIMIT 1').get() as { json: string } | undefined;
    return row ? this.hydrateNews(JSON.parse(row.json) as MarketState) : null;
  }
  marketStates(limit = 20, summary = false): MarketState[] {
    const rows = this.db.prepare('SELECT json FROM demo_market_states ORDER BY as_of DESC LIMIT ?').all(limit) as { json: string }[];
    return rows.map((r) => {
      const state = JSON.parse(r.json) as MarketState;
      return summary ? state : this.hydrateNews(state);
    });
  }
  infoEvent(id: string): InformationEvent | null {
    const row = this.db.prepare('SELECT json FROM demo_info_events WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as InformationEvent) : null;
  }
  /**
   * 旧快照的 news[] 只有 ref(I3 这种证据编号):按当轮 info_refs(与 I1..In 同序)回填 event_id 与原文 url,
   * 不依赖「最近 100 条事件」。新快照生成时已带,这里原样返回。
   */
  private hydrateNews(ms: MarketState): MarketState {
    if (!ms.news?.length || ms.news.every((n) => n.event_id && n.source_label)) return ms;
    const refs = ms.info_refs ?? [];
    ms.news = ms.news.map((n) => {
      if (n.event_id) return n.source_label ? n : { ...n, source_label: sourceLabel(n.source) };
      const m = /^I(\d+)$/.exec(n.ref);
      const id = m ? refs[Number(m[1]) - 1] ?? null : null;
      const ev = id ? this.infoEvent(id) : null;
      return { ...n, event_id: id, source_label: sourceLabel(n.source), url: ev && ev.kind === 'news' && /^https?:\/\//.test(ev.source_ref) ? ev.source_ref : null };
    });
    return ms;
  }

  saveThread(t: StrategyThread): void {
    this.db
      .prepare(
        'INSERT INTO demo_threads(id, symbol, status, source, created_at, updated_at, strategy_id, json, backend, market, pair_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, strategy_id = excluded.strategy_id, json = excluded.json, backend = excluded.backend, market = excluded.market, pair_id = excluded.pair_id',
      )
      .run(t.id, t.symbol, t.status, t.source, t.created_at, t.updated_at, t.strategy_id ?? null, JSON.stringify(t), t.backend ?? 'paper', t.market ?? 'perp', t.pair_id ?? null);
  }
  thread(id: string): StrategyThread | null {
    const row = this.db.prepare('SELECT json, market, pair_id FROM demo_threads WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? ({ ...JSON.parse(row.json), market: (row as {market?:string}).market ?? 'perp', pair_id:(row as {pair_id?:string|null}).pair_id ?? null } as StrategyThread) : null;
  }
  /** `backend` 给了就只取该执行通道的线程(切通道 = 切账户上下文);不给 = 全部(内部/迁移用)。 */
  threads(filter: { statuses?: ThreadStatus[]; limit?: number; backend?: string | null } = {}): StrategyThread[] {
    const limit = filter.limit ?? 200;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.statuses && filter.statuses.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      args.push(...filter.statuses);
    }
    if (filter.backend) {
      where.push('backend = ?');
      args.push(filter.backend);
    }
    const rows = this.db.prepare(`SELECT json, market, pair_id FROM demo_threads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`).all(...args, limit) as { json: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.json), market:(r as {market?:string}).market ?? 'perp', pair_id:(r as {pair_id?:string|null}).pair_id ?? null } as StrategyThread));
  }
  threadOpensSince(sinceAt: number, excludeId: string | null = null): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM demo_threads WHERE created_at >= ? AND id != ? AND status != 'canceled' AND source != 'manual' AND json NOT LIKE '%\"entry_client_order_id\":null%'").get(sinceAt, excludeId ?? '') as { n: number };
    return Number(row.n);
  }
  episodesForThread(threadId: string, limit = 50): EpisodeSummary[] {
    const rows = this.db.prepare(`SELECT ${EPISODE_SUMMARY_JSON} AS json FROM demo_episodes ORDER BY at DESC LIMIT 500`).all() as { json: string }[];
    return rows
      .map((r) => JSON.parse(r.json) as Episode)
      .filter((e) => e.thread_id === threadId)
      .slice(0, limit)
      .map(summarize);
  }
  /** 与 `intents(500).filter(thread_id)` 同口径(同一查询、同一顺序、同一 500 条窗口),只是不匹配的行在 SQLite 里就置空,不搬进 JS 解析。 */
  intentsForThread(threadId: string): DemoIntent[] {
    const rows = this.db.prepare("SELECT CASE WHEN json_extract(json, '$.thread_id') = ? THEN json END AS json, market FROM demo_intents ORDER BY at DESC LIMIT ?").all(threadId, 500) as { json: string | null; market?: string }[];
    const out: DemoIntent[] = [];
    for (const r of rows) {
      if (r.json === null) continue;
      const i = { ...JSON.parse(r.json), market: r.market ?? 'perp' } as DemoIntent;
      if (i.thread_id === threadId) out.push(i);
    }
    return out;
  }

  saveChat(m: ChatMessage): void {
    this.db.prepare('INSERT INTO demo_chat(id, at, role, json, session_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, session_id = excluded.session_id').run(m.id, m.at, m.role, JSON.stringify(m), m.kind === 'narration' ? null : (m.session_id ?? 'default'));
    if (m.kind !== 'narration') this.db.prepare('UPDATE demo_chat_session SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(m.at, m.session_id ?? 'default');
  }
  /**
   * Oldest-first. `kind` filters conversation vs narration; rows written before v3 have no kind and are classified by prefix.
   * `session` 只作用于 kind=chat(旁白不分会话);缺省 = 全部会话(旧 UI 行为)。
   */
  chat(limit = 100, kind: 'chat' | 'narration' | 'all' = 'all', session?: string | null): ChatMessage[] {
    const where = session ? "WHERE (session_id = ? OR json_extract(json, '$.kind') = 'narration')" : '';
    const rows = this.db.prepare(`SELECT json, session_id FROM demo_chat ${where} ORDER BY at DESC LIMIT ?`).all(...(session ? [session] : []), kind === 'all' ? limit : Math.max(limit * 4, 400)) as { json: string; session_id: string | null }[];
    const out: ChatMessage[] = [];
    for (const r of rows) {
      const m = JSON.parse(r.json) as ChatMessage;
      const k = m.kind ?? (m.role === 'agent' && m.text.startsWith('旁白 · ') ? 'narration' : 'chat');
      m.kind = k;
      m.session_id = r.session_id;
      if (kind !== 'all' && k !== kind) continue;
      out.push(m);
      if (out.length >= limit) break;
    }
    return out.reverse();
  }
  clearChat(session?: string): void {
    if (session) this.db.prepare('DELETE FROM demo_chat WHERE session_id = ?').run(session);
    else this.db.exec("DELETE FROM demo_chat WHERE json_extract(json, '$.kind') IS NULL OR json_extract(json, '$.kind') = 'chat'");
  }

  // ---- v3.8: chat sessions (migrations/0012)
  /** 启动时修复九条规范线程,保留创建时间、消息与 default id。 */
  ensureAgentSessions(now = Date.now()): void {
    const upsert = this.db.prepare(`INSERT INTO demo_chat_session(id,title,created_at,updated_at,archived,can_execute,role) VALUES (?,?,?,?,0,0,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,role=excluded.role,archived=0`);
    for (const [role, spec] of Object.entries(AGENT_REGISTRY)) if (isBotRole(role)) upsert.run(agentSessionId(role), spec.name, now, now, role);
  }
  lastChatAt(session: string): number | null {
    const row = this.db.prepare('SELECT MAX(at) AS at FROM demo_chat WHERE session_id=?').get(session)!;
    return row['at'] === null ? null : Number(row['at']);
  }
  private toSession(r: Record<string, unknown>): ChatSession {
    return { id: String(r['id']), canonical: isCanonicalSession(String(r['id'])), title: String(r['title']), created_at: Number(r['created_at']), updated_at: Number(r['updated_at']), archived: Number(r['archived']) === 1, can_execute: Number(r['can_execute']) === 1, role: r['role'] === null || r['role'] === undefined ? null : String(r['role']), message_count: Number(r['n'] ?? 0), last_text: r['last_text'] === null || r['last_text'] === undefined ? null : String(r['last_text']).slice(0, 120) };
  }
  private static readonly SESSION_SQL = `SELECT s.*, (SELECT COUNT(*) FROM demo_chat c WHERE c.session_id = s.id) AS n,
      (SELECT json_extract(c.json, '$.text') FROM demo_chat c WHERE c.session_id = s.id ORDER BY c.at DESC LIMIT 1) AS last_text FROM demo_chat_session s`;
  chatSessions(opts: { include_archived?: boolean } = {}): ChatSession[] {
    const rows = this.db.prepare(`${DemoStore.SESSION_SQL} ${opts.include_archived ? '' : 'WHERE s.archived = 0'} ORDER BY s.updated_at DESC`).all() as Record<string, unknown>[];
    return rows.map((r) => this.toSession(r));
  }
  chatSession(id: string): ChatSession | null {
    const r = this.db.prepare(`${DemoStore.SESSION_SQL} WHERE s.id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.toSession(r) : null;
  }
  createChatSession(title: string, now = Date.now(), role: string | null = null): ChatSession {
    if (role !== null) {
      if (!isBotRole(role)) throw Object.assign(new Error('未知 Agent'), { status: 404, code: 'unknown_role' });
      const session = this.chatSession(agentSessionId(role));
      if (session) return session;
      this.ensureAgentSessions(now);
      return this.chatSession(agentSessionId(role))!;
    }
    const id = `cs-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.db.prepare('INSERT INTO demo_chat_session(id, title, created_at, updated_at, archived, can_execute, role) VALUES (?, ?, ?, ?, 0, 0, ?)').run(id, title.trim().slice(0, 80) || '新会话', now, now, role);
    return this.chatSession(id)!;
  }
  updateChatSession(id: string, patch: { title?: string; archived?: boolean; can_execute?: boolean }): ChatSession | null {
    const cur = this.chatSession(id);
    if (!cur) return null;
    if (cur.canonical && patch.archived === true) throw Object.assign(new Error('规范会话不能归档,只能清空'), { status: 409, code: 'canonical_session' });
    this.db.prepare('UPDATE demo_chat_session SET title = ?, archived = ?, can_execute = ?, updated_at = ? WHERE id = ?').run((patch.title ?? cur.title).trim().slice(0, 80) || cur.title, (patch.archived ?? cur.archived) ? 1 : 0, (patch.can_execute ?? cur.can_execute) ? 1 : 0, Date.now(), id);
    return this.chatSession(id);
  }
  deleteChatSession(id: string): boolean {
    if (isCanonicalSession(id)) throw Object.assign(new Error('规范会话不能删除,只能清空'), { status: 409, code: 'canonical_session' });
    this.db.prepare('DELETE FROM demo_chat WHERE session_id = ?').run(id);
    return this.db.prepare('DELETE FROM demo_chat_session WHERE id = ?').run(id).changes > 0;
  }

  // ---- v3: activity timeline + equity points (migrations/0004_demo_v3.sql)

  saveActivity(a: ActivityItem): void {
    this.db.prepare('INSERT INTO demo_activity(id, at, kind, level, symbol, thread_id, json, market) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(a.id, a.at, a.kind, a.level, a.symbol, a.thread_id, JSON.stringify(a), a.market ?? null);
    this.invalidateReads('activity:');
  }
  /** Newest first. */
  activity(limit = 200, beforeAt?: number, threadId?: string): ActivityItem[] { return this.activityPage(limit, beforeAt, threadId).activity; }
  activityPage(limit = 200, beforeAt?: number, threadId?: string, beforeId?: string) {
    const page = this.cachedRead(`activity:${JSON.stringify([limit, beforeAt ?? null, threadId ?? null, beforeAt ? beforeId ?? null : null])}`, () => this.loadActivityPage(limit, beforeAt, threadId, beforeId));
    return { activity: [...page.activity], next_before: page.next_before };
  }
  private loadActivityPage(limit: number, beforeAt?: number, threadId?: string, beforeId?: string) {
    const where: string[] = [];
    const args: (number | string)[] = [];
    if (beforeAt) {
      where.push(beforeId ? '(at, id) < (?, ?)' : 'at < ?');
      args.push(beforeAt);
      if (beforeId) args.push(beforeId);
    }
    if (threadId) {
      where.push('thread_id = ?');
      args.push(threadId);
    }
    const rows = this.db.prepare(`SELECT at, id, json FROM demo_activity${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`).all(...args, limit) as { at: number; id: string; json: string }[];
    const activity = collapseObservations(rows.map((r) => JSON.parse(r.json) as ActivityItem), (a) => ['risk_alert', 'brain_error', 'screen_failed'].includes(a.kind) ? JSON.stringify([a.kind, a.symbol, a.thread_id, a.data['kind'] ?? errorKind(a.title)]) : null).map((a) => ({ ...a, title: `${a.title}${(a.observed_count ?? 1) > 1 ? ` ×${a.observed_count}` : ''}` }));
    const last = rows.at(-1);
    return { activity, next_before: rows.length === limit && last ? { at: last.at, id: last.id } : null };
  }
  saveEquity(p: EquityPoint): void {
    this.db.prepare('INSERT INTO demo_equity(at, equity, unrealized, backend) VALUES (?, ?, ?, ?) ON CONFLICT(at) DO UPDATE SET equity = excluded.equity, unrealized = excluded.unrealized, backend = excluded.backend').run(p.at, p.equity, p.unrealized, p.backend ?? 'paper');
  }
  lastEquityAt(backend: string | null = null): number {
    const row = this.db.prepare(`SELECT MAX(at) AS at FROM demo_equity ${backend ? 'WHERE backend = ?' : ''}`).get(...(backend ? [backend] : [])) as { at: number | null };
    return row.at ?? 0;
  }
  /** Oldest first, thinned to at most `limit` points. `backend` 给了只回该通道的曲线。 */
  equity(limit = 2000, backend: string | null = null): EquityPoint[] {
    const where = backend ? 'WHERE backend = ?' : '';
    const args = backend ? [backend] : [];
    const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM demo_equity ${where}`).get(...args) as { n: number }).n;
    const stride = Math.max(1, Math.ceil(n / limit));
    const rows = this.db.prepare(`SELECT at, equity, unrealized, backend FROM demo_equity ${where} ORDER BY at ASC`).all(...args) as unknown as EquityPoint[];
    return stride === 1 ? rows : rows.filter((_, i) => i % stride === 0 || i === rows.length - 1);
  }
  /** Closed / canceled / invalidated threads, most recently closed first. */
  closedThreads(limit = 200, backend: string | null = null): StrategyThread[] {
    const rows = this.db.prepare(`SELECT json, market, pair_id FROM demo_threads WHERE status IN ('closed','canceled','invalidated') ${backend ? 'AND backend = ?' : ''} ORDER BY COALESCE(json_extract(json, '$.closed_at'), updated_at) DESC LIMIT ?`).all(...(backend ? [backend] : []), limit) as { json: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.json), market:(r as {market?:string}).market ?? 'perp', pair_id:(r as {pair_id?:string|null}).pair_id ?? null } as StrategyThread));
  }
  episodeCountForThread(threadId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM demo_episodes WHERE json_extract(json, '$.thread_id') = ?").get(threadId) as { n: number };
    return Number(row.n);
  }

  // ---- 盲测回放(migrations/0007_demo_backtest.sql;docs/design/blind-backtest-2026-09-05.md)
  // 回测判断故意不写 demo_episodes:它们不占每日判断上限,也不该混进「今日用量」的真实台账。

  saveBacktestRun(r: BacktestRun): void {
    this.db
      .prepare(
        `INSERT INTO demo_backtest_run(id, created_at, symbol, timeframe, from_ms, to_ms, mode, status, params_json, brain, prompt_version, progress_json, summary_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, progress_json = excluded.progress_json, summary_json = excluded.summary_json, error = excluded.error`,
      )
      .run(r.id, r.created_at, r.symbol, r.timeframe, r.from_ms, r.to_ms, r.mode, r.status, JSON.stringify(r.params), r.brain, r.prompt_version, r.progress ? JSON.stringify(r.progress) : null, r.summary ? JSON.stringify(r.summary) : null, r.error);
  }
  private toBacktestRun(row: Record<string, unknown>): BacktestRun {
    return {
      id: String(row['id']),
      created_at: Number(row['created_at']),
      symbol: String(row['symbol']),
      timeframe: String(row['timeframe']),
      from_ms: Number(row['from_ms']),
      to_ms: Number(row['to_ms']),
      mode: String(row['mode']) as BacktestRun['mode'],
      status: String(row['status']) as BacktestRun['status'],
      params: JSON.parse(String(row['params_json'])) as BacktestRun['params'],
      brain: String(row['brain']),
      prompt_version: String(row['prompt_version']),
      progress: row['progress_json'] ? (JSON.parse(String(row['progress_json'])) as BacktestRun['progress']) : null,
      summary: row['summary_json'] ? (JSON.parse(String(row['summary_json'])) as BacktestRun['summary']) : null,
      error: row['error'] === null || row['error'] === undefined ? null : String(row['error']),
    };
  }
  backtestRun(id: string): BacktestRun | null {
    const row = this.db.prepare('SELECT * FROM demo_backtest_run WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toBacktestRun(row) : null;
  }
  /** Newest first. */
  backtestRuns(limit = 50): BacktestRun[] {
    const rows = this.db.prepare('SELECT * FROM demo_backtest_run ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.toBacktestRun(r));
  }
  saveBacktestStep(s: BacktestStep): void {
    this.db
      .prepare(
        `INSERT INTO demo_backtest_step(run_id, idx, at_ms, kind, trigger, visible_upto_ms, judgment_json, action, direction, confidence, gates_json, outcome_json, cost_json, strategy_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, idx) DO UPDATE SET judgment_json = excluded.judgment_json, action = excluded.action, direction = excluded.direction, confidence = excluded.confidence, gates_json = excluded.gates_json, outcome_json = excluded.outcome_json, cost_json = excluded.cost_json, strategy_id = excluded.strategy_id`,
      )
      .run(
        s.run_id,
        s.idx,
        s.at_ms,
        s.kind,
        s.trigger,
        s.visible_upto_ms,
        s.judgment ? JSON.stringify({ judgment: s.judgment, error: s.error }) : s.error ? JSON.stringify({ judgment: null, error: s.error }) : null,
        s.action,
        s.direction,
        s.confidence,
        JSON.stringify(s.gates),
        s.outcome ? JSON.stringify(s.outcome) : null,
        s.cost ? JSON.stringify(s.cost) : null,
        s.strategy_id ?? null,
      );
  }
  /** Oldest first (idx order = the order the walk produced them). */
  backtestSteps(runId: string): BacktestStep[] {
    const rows = this.db.prepare('SELECT * FROM demo_backtest_step WHERE run_id = ? ORDER BY idx ASC').all(runId) as Record<string, unknown>[];
    return rows.map((row) => {
      const wrapped = row['judgment_json'] ? (JSON.parse(String(row['judgment_json'])) as { judgment: BacktestStep['judgment']; error: string | null }) : { judgment: null, error: null };
      return {
        run_id: String(row['run_id']),
        idx: Number(row['idx']),
        at_ms: Number(row['at_ms']),
        kind: String(row['kind']) as BacktestStep['kind'],
        trigger: row['trigger'] === null || row['trigger'] === undefined ? null : String(row['trigger']),
        visible_upto_ms: Number(row['visible_upto_ms']),
        judgment: wrapped.judgment,
        action: row['action'] === null || row['action'] === undefined ? null : String(row['action']),
        direction: (row['direction'] ?? null) as BacktestStep['direction'],
        confidence: row['confidence'] === null || row['confidence'] === undefined ? null : Number(row['confidence']),
        gates: row['gates_json'] ? (JSON.parse(String(row['gates_json'])) as BacktestStep['gates']) : [],
        outcome: row['outcome_json'] ? (JSON.parse(String(row['outcome_json'])) as BacktestStep['outcome']) : null,
        cost: row['cost_json'] ? (JSON.parse(String(row['cost_json'])) as BacktestStep['cost']) : null,
        strategy_id: row['strategy_id'] === null || row['strategy_id'] === undefined ? null : String(row['strategy_id']),
        error: wrapped.error ?? null,
      };
    });
  }

  // ---- v3.5 回测归因(migrations/0008_demo_strategy.sql;attribution.ts)
  // 归因只写这张表 + 一条 proposed 记忆,永远不改策略。人点「生成新版本」时才回来打 applied_version。

  saveAttribution(a: AttributionPoint): void {
    this.db
      .prepare(
        `INSERT INTO demo_backtest_attribution(id, run_id, at, strategy_id, symbol, kind, title, json, memory_id, applied_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, memory_id = excluded.memory_id, applied_version = excluded.applied_version`,
      )
      .run(a.id, a.run_id, a.at, a.strategy_id, a.symbol, a.kind, a.title, JSON.stringify(a), a.memory_id, a.applied_version);
  }
  attribution(id: string): AttributionPoint | null {
    const row = this.db.prepare('SELECT json FROM demo_backtest_attribution WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as AttributionPoint) : null;
  }
  /** Oldest first (the order the cheap brain produced them). */
  attributions(runId: string): AttributionPoint[] {
    const rows = this.db.prepare('SELECT json FROM demo_backtest_attribution WHERE run_id = ? ORDER BY at ASC, id ASC').all(runId) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as AttributionPoint);
  }
  attributionsForStrategy(strategyId: string, limit = 50): AttributionPoint[] {
    const rows = this.db.prepare('SELECT json FROM demo_backtest_attribution WHERE strategy_id = ? ORDER BY at DESC LIMIT ?').all(strategyId, limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as AttributionPoint);
  }
}
