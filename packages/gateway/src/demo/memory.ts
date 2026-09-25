// Long-term memory, "B7-lite" (docs/demo/memory.md; design §11 L3). Deliberately NOT a Mem0 clone:
// - entities here are structured (symbol / timeframe / regime / tags), so recall is structured filtering +
//   FTS5 trigram BM25 for free text, no embeddings until the corpus proves it needs them;
// - every write is a proposal until a human approves it (user-typed memories are the human, so they activate);
// - memory never overrides L1 live truth: it is injected as evidence labelled 记忆 and its numbers are not market
//   numbers (eval excludes them from the hallucination sources);
// - candidates are generated only on thread close (templated fact) and on explicit reflect (LLM lessons),
//   never on every judgment.
// - 09-23 记忆分域(docs/design/self-evolution-2026-09-23.md §5):每条记忆属于一个 layer
//   (global/role/strategy/symbol/thread);谁能读哪层、谁能写哪层由 MEMORY_MATRIX 决定,recall 按 reader_role
//   过滤并按层分配槽位,propose 按 proposed_by_role 校验写权;被引用的记忆在 episode 结算后回写 outcome(§2.2)。

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Brain } from './brain.js';
import type { BotRole } from './bots.js';
import type { MemoryEvent, MemoryItem, MemoryKind, MemoryLayer, MemoryProposer, MemoryRecallHit, MemoryRecallQuery, MemoryScope, MemoryStats, MemoryStatus, StrategyThread } from './types.js';

export const MEMORY_LIMITS = {
  content_max_chars: 300,
  recall_limit: 5,
  recall_char_budget: 600, // ≈ 300 tokens of Chinese
  decay_days: 30,
  tags_max: 12,
};

// ---------------------------------------------------------------- 09-23 分域:读写矩阵(§5.2)

const ALL_LAYERS: MemoryLayer[] = ['global', 'role', 'strategy', 'symbol', 'thread'];

export interface MemoryAccess {
  read: MemoryLayer[];
  write: MemoryLayer[];
}

/**
 * 读写矩阵,单一事实来源(bots.ts 的 memory_scope seed 从这里取,validateRoleBoundaries 开机比对)。
 * 写 'role' 层时只能写 role = 自己;读 'role' 层时只读 role = 自己(reviewer / gate_captain 除外,它们读全部)。
 */
export const MEMORY_MATRIX: Readonly<Record<BotRole, Readonly<MemoryAccess>>> = {
  gate_captain: { read: ALL_LAYERS, write: ALL_LAYERS },
  radar: { read: ['global', 'symbol'], write: ['role'] },
  thread_manager: { read: ['global', 'strategy', 'symbol'], write: [] },
  strategy_lab: { read: ['strategy', 'global'], write: ['strategy', 'global'] },
  portfolio_manager: { read: ['role'], write: [] },
  risk_sentinel: { read: [], write: [] },
  reviewer: { read: ALL_LAYERS, write: ['role', 'strategy', 'symbol', 'global'] },
  executor: { read: [], write: [] },
  asp_agent: { read: ['global'], write: [] },
};

/** 读全部 role 层(不限于自己)的角色。 */
const FULL_READERS: ReadonlySet<BotRole> = new Set<BotRole>(['reviewer', 'gate_captain']);
/** 额外的 kind 限制:portfolio_manager 只读 calibration(且只在 role:portfolio_manager 层)。 */
const READ_KINDS: Partial<Record<BotRole, MemoryKind[]>> = { portfolio_manager: ['calibration'] };
/** §5.3 每层召回上限;填充顺序 strategy → symbol → global → role → thread,空层的槽位按分数让给其它层。 */
export const LAYER_QUOTA: Readonly<Record<MemoryLayer, number>> = { strategy: 2, symbol: 2, global: 1, role: 1, thread: 1 };
const FILL_ORDER: MemoryLayer[] = ['strategy', 'symbol', 'global', 'role', 'thread'];

/** 写入方身份:角色,或 user(人本人)/ system(确定性代码模板)。 */
export type MemoryWriterRole = BotRole | 'user' | 'system';

/** 写权矩阵拒绝。status 403,同时落一条 `write_denied` 事件(memory_id='-')。 */
export class MemoryWriteDeniedError extends Error {
  readonly status = 403;
  readonly code = 'memory_write_denied';
  constructor(
    readonly writer: MemoryWriterRole,
    readonly layer: MemoryLayer,
    readonly role: BotRole | null,
  ) {
    super(`记忆写权拒绝:${writer} 不能写 ${layer}${layer === 'role' ? `:${role ?? '?'}` : ''} 层`);
    this.name = 'MemoryWriteDeniedError';
  }
}

/** 旧 json(迁移前写的)没有 layer:有币 → symbol,否则 global。 */
export function layerOf(scope: Partial<MemoryScope>): MemoryLayer {
  return scope.layer ?? (scope.symbol ? 'symbol' : 'global');
}

export function canWriteMemory(writer: MemoryWriterRole, scope: Pick<MemoryScope, 'layer' | 'role' | 'symbol'>): boolean {
  if (writer === 'user' || writer === 'system') return true;
  const access = MEMORY_MATRIX[writer];
  const layer = layerOf(scope);
  if (!access || !access.write.includes(layer)) return false;
  return layer !== 'role' || scope.role === writer;
}

/** 读权(不含 symbol 不泄漏规则,那条在 recall 里对所有角色生效)。 */
export function canReadMemory(reader: BotRole, item: Pick<MemoryItem, 'kind' | 'scope'>, q: { strategy_id?: string | null } = {}): boolean {
  const access = MEMORY_MATRIX[reader];
  if (!access) return false;
  const layer = layerOf(item.scope);
  if (!access.read.includes(layer)) return false;
  const kinds = READ_KINDS[reader];
  if (kinds && !kinds.includes(item.kind)) return false;
  if (layer === 'role' && !FULL_READERS.has(reader) && item.scope.role !== reader) return false;
  if (layer === 'strategy') {
    if (q.strategy_id) return item.scope.strategy_id === q.strategy_id; // 跨策略不泄漏
    if (reader === 'thread_manager') return false; // 判断没有策略上下文 → 不读 strategy 层
  }
  return true;
}

/**
 * 缺省写入方推断(**临时**,调用点显式传 proposed_by_role 之后删):
 * user → user;system → system;agent → reviewer(现存 agent 写入方只有 reviewer.ts / attribution.ts,都是复盘类)。
 */
export function inferWriterRole(proposedBy: MemoryProposer): MemoryWriterRole {
  return proposedBy === 'agent' ? 'reviewer' : proposedBy;
}

export interface ProposeInput {
  kind: MemoryKind;
  content: string;
  /** layer 缺省推断:role → 'role';thread_id → 'thread';strategy_id → 'strategy';symbol → 'symbol';否则 'global'。 */
  scope?: Partial<MemoryScope>;
  source_refs?: string[];
  tags?: string[];
  confidence?: number;
  proposed_by: MemoryProposer;
  /** 09-23 写权校验用。缺省见 inferWriterRole(临时推断)。 */
  proposed_by_role?: MemoryWriterRole;
  supersedes?: string | null;
  expires_at?: number | null;
  /** Skip the approval step (only for memories the human typed themselves). */
  activate?: boolean;
  now?: number;
}

export interface MemoryListFilter {
  status?: MemoryStatus[];
  symbol?: string | null;
  kind?: MemoryKind;
  layer?: MemoryLayer;
  role?: BotRole;
  strategy_id?: string;
  limit?: number;
}

export function normalizeContent(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function contentHash(s: string): string {
  return createHash('sha256').update(normalizeContent(s)).digest('hex');
}

const KIND_LABEL: Record<MemoryKind, string> = { lesson: '教训', preference: '偏好', fact: '事实', calibration: '校准' };
export const memoryKindLabel = (k: MemoryKind): string => KIND_LABEL[k];

function mid(): string {
  return `mem-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

function normTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, MEMORY_LIMITS.tags_max);
}

/** Pure scoring for structured recall; `bm25` is the normalised 0–1 text score when a text query was used. */
export function scoreMemory(item: MemoryItem, q: MemoryRecallQuery, now: number, bm25: number | null = null): { score: number; why: string[] } {
  const why: string[] = [];
  let score = 0;
  if (q.strategy_id && item.scope.strategy_id === q.strategy_id) {
    score += 0.3;
    why.push('同策略');
  }
  if (q.symbol && item.scope.symbol === q.symbol) {
    score += 0.3;
    why.push('同币');
  } else if (item.scope.symbol === null && layerOf(item.scope) === 'global') {
    score += 0.15;
    why.push('全局');
  }
  if (q.reader_role === 'radar' && item.tags.includes('screen')) {
    score += 0.1;
    why.push('筛选类');
  }
  if (q.regime && item.scope.regime && item.scope.regime === q.regime) {
    score += 0.15;
    why.push(`regime ${q.regime}`);
  }
  if (q.timeframe && item.scope.timeframe && item.scope.timeframe === q.timeframe) {
    score += 0.05;
    why.push(`周期 ${q.timeframe}`);
  }
  const qt = normTags(q.tags);
  if (qt.length && item.tags.length) {
    const hit = qt.filter((t) => item.tags.includes(t));
    if (hit.length) {
      score += 0.3 * (hit.length / qt.length);
      why.push(`标签 ${hit.join('/')}`);
    }
  }
  score += 0.2 * Math.max(0, Math.min(1, item.confidence));
  if (bm25 !== null) {
    score += 0.4 * bm25;
    why.push(`文本 ${bm25.toFixed(2)}`);
  }
  const ref = item.last_used_at ?? item.decided_at ?? item.created_at;
  const ageDays = (now - ref) / 86_400_000;
  if (ageDays > MEMORY_LIMITS.decay_days) {
    score *= 0.5;
    why.push(`${Math.floor(ageDays)} 天未用,衰减`);
  }
  return { score: Math.round(score * 1000) / 1000, why };
}

/** json → MemoryItem,旧形状(迁移前、或 json_set 没跑到的行)的 scope 补齐新字段。 */
function parseItem(json: string): MemoryItem {
  const m = JSON.parse(json) as MemoryItem;
  const sc = (m.scope ?? {}) as Partial<MemoryScope>;
  m.scope = {
    layer: layerOf(sc),
    role: sc.role ?? null,
    strategy_id: sc.strategy_id ?? null,
    symbol: sc.symbol ?? null,
    timeframe: sc.timeframe ?? null,
    regime: sc.regime ?? null,
    thread_id: sc.thread_id ?? null,
  };
  return m;
}

const clean = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** propose 的 scope 归一 + 一致性校验(400)。 */
export function normalizeScope(input: Partial<MemoryScope> | undefined): Required<MemoryScope> {
  const sc = input ?? {};
  const symbol = clean(sc.symbol)?.toUpperCase() ?? null;
  const strategy_id = clean(sc.strategy_id);
  const thread_id = clean(sc.thread_id);
  const role = (clean(sc.role) as BotRole | null) ?? null;
  const layer: MemoryLayer = sc.layer ?? (role ? 'role' : thread_id ? 'thread' : strategy_id ? 'strategy' : symbol ? 'symbol' : 'global');
  const bad = (msg: string): never => {
    throw Object.assign(new Error(`memory scope 无效:${msg}`), { status: 400 });
  };
  if (!ALL_LAYERS.includes(layer)) bad(`未知 layer ${String(layer)}`);
  if (layer === 'role' && (!role || !(role in MEMORY_MATRIX))) bad('layer=role 必须带合法 role');
  if (layer === 'strategy' && !strategy_id) bad('layer=strategy 必须带 strategy_id');
  if (layer === 'symbol' && !symbol) bad('layer=symbol 必须带 symbol');
  if (layer === 'thread' && !thread_id) bad('layer=thread 必须带 thread_id');
  return { layer, role: layer === 'role' ? role : null, strategy_id, symbol, timeframe: sc.timeframe ?? null, regime: sc.regime ?? null, thread_id };
}

const round4 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000);
const EMPTY_STATS: MemoryStats = { cited_n: 0, mean_r_when_cited: null, mean_regret_when_cited: null };

/**
 * 一个 episode 里「判断真的引用了」的记忆 id:evidence 里 kind='memory' 且 ref 在 judgment.evidence_refs 里的那几条
 * (label 形如 `记忆 mem-…·教训`,见 context.ts),并上 runtime 记下的 episode.memory.cited(它还算了 reasons 里的 E#)。
 */
export function citedMemoryIds(ep: { evidence?: { ref?: string; kind?: string; label?: string }[] | null; judgment?: { evidence_refs?: string[] } | null; memory?: { cited?: string[] } | null }): string[] {
  const out = new Set<string>();
  const refs = new Set(ep.judgment?.evidence_refs ?? []);
  for (const ev of ep.evidence ?? []) {
    if (ev?.kind !== 'memory' || !ev.ref || !refs.has(ev.ref)) continue;
    const m = /记忆 (mem-[0-9a-z]+)/.exec(ev.label ?? '');
    if (m) out.add(m[1]!);
  }
  for (const id of ep.memory?.cited ?? []) if (typeof id === 'string' && id.startsWith('mem-')) out.add(id);
  return [...out];
}

export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {}

  private row(id: string): MemoryItem | null {
    const r = this.db.prepare('SELECT json FROM demo_memory WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? parseItem(r.json) : null;
  }

  private write(m: MemoryItem): void {
    const { memory_stats: _stats, ...persist } = m;
    this.db
      .prepare(
        'INSERT INTO demo_memory(id, kind, status, symbol, content_hash, created_at, last_used_at, expires_at, layer, role, strategy_id, thread_id, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, symbol = excluded.symbol, last_used_at = excluded.last_used_at, expires_at = excluded.expires_at, layer = excluded.layer, role = excluded.role, strategy_id = excluded.strategy_id, thread_id = excluded.thread_id, json = excluded.json',
      )
      .run(m.id, m.kind, m.status, m.scope.symbol, m.content_hash, m.created_at, m.last_used_at, m.expires_at, layerOf(m.scope), m.scope.role ?? null, m.scope.strategy_id ?? null, m.scope.thread_id ?? null, JSON.stringify(persist));
  }

  private event(memoryId: string, kind: MemoryEvent['kind'], detail: string | null, at: number): void {
    this.db.prepare('INSERT INTO demo_memory_events(memory_id, at, kind, detail) VALUES (?, ?, ?, ?)').run(memoryId, at, kind, detail);
  }

  get(id: string): MemoryItem | null {
    const m = this.row(id);
    return m ? { ...m, memory_stats: this.stats(id) } : null;
  }

  /** Exact-duplicate guard: an existing proposed/active item with the same normalised content wins (its hit is logged). */
  findDuplicate(content: string): MemoryItem | null {
    const rows = this.db.prepare("SELECT json FROM demo_memory WHERE content_hash = ? AND status IN ('proposed','active')").all(contentHash(content)) as { json: string }[];
    return rows.length ? parseItem(rows[0]!.json) : null;
  }

  propose(input: ProposeInput): { item: MemoryItem; created: boolean } {
    const now = input.now ?? Date.now();
    const content = input.content.replace(/\s+/g, ' ').trim().slice(0, MEMORY_LIMITS.content_max_chars);
    if (!content) throw Object.assign(new Error('memory content 不能为空'), { status: 400 });
    const scope = normalizeScope(input.scope);
    // 写权先于去重:越权写入即便内容重复也要被拒并留痕,不能借 dedup 静默「成功」。
    const writer = input.proposed_by_role ?? inferWriterRole(input.proposed_by);
    if (!canWriteMemory(writer, scope)) {
      const detail = JSON.stringify({ writer, proposed_by: input.proposed_by, layer: scope.layer, role: scope.role, strategy_id: scope.strategy_id, symbol: scope.symbol, content: content.slice(0, 80) });
      this.event('-', 'write_denied', detail, now);
      throw new MemoryWriteDeniedError(writer, scope.layer, scope.role);
    }
    const dup = this.findDuplicate(content);
    if (dup) {
      this.event(dup.id, 'dedup_hit', `重复提案(${input.proposed_by})`, now);
      return { item: dup, created: false };
    }
    const item: MemoryItem = {
      id: mid(),
      kind: input.kind,
      scope,
      content,
      source_refs: [...new Set(input.source_refs ?? [])].slice(0, 20),
      tags: normTags(input.tags),
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)),
      status: input.activate ? 'active' : 'proposed',
      proposed_by: input.proposed_by,
      supersedes: input.supersedes ?? null,
      superseded_by: null,
      created_at: now,
      decided_at: input.activate ? now : null,
      last_used_at: null,
      use_count: 0,
      expires_at: input.expires_at ?? null,
      content_hash: contentHash(content),
    };
    this.write(item);
    this.db.prepare('INSERT INTO demo_memory_fts(memory_id, content, tags) VALUES (?, ?, ?)').run(item.id, item.content, item.tags.join(' '));
    this.event(item.id, 'proposed', `${input.proposed_by}${writer !== input.proposed_by ? `(${writer})` : ''}${input.activate ? ',直接激活' : ''}`, now);
    if (input.activate) {
      this.event(item.id, 'approved', '用户自述,免审批', now);
      if (item.supersedes) this.markSuperseded(item.supersedes, item.id, now);
    }
    return { item, created: true };
  }

  private markSuperseded(oldId: string, newId: string, now: number): void {
    const old = this.row(oldId);
    if (!old || old.status !== 'active') return;
    this.write({ ...old, status: 'superseded', superseded_by: newId });
    this.event(oldId, 'superseded', `被 ${newId} 取代`, now);
  }

  approve(id: string, now = Date.now()): MemoryItem | null {
    const m = this.row(id);
    if (!m) return null;
    if (m.status !== 'proposed') throw Object.assign(new Error(`记忆 ${id} 状态是 ${m.status},只能批准 proposed`), { status: 409 });
    const next: MemoryItem = { ...m, status: 'active', decided_at: now };
    this.write(next);
    this.event(id, 'approved', null, now);
    if (m.supersedes) this.markSuperseded(m.supersedes, id, now);
    return next;
  }

  reject(id: string, reason: string | null = null, now = Date.now()): MemoryItem | null {
    const m = this.row(id);
    if (!m) return null;
    if (m.status !== 'proposed') throw Object.assign(new Error(`记忆 ${id} 状态是 ${m.status},只能拒绝 proposed`), { status: 409 });
    const next: MemoryItem = { ...m, status: 'rejected', decided_at: now };
    this.write(next);
    this.event(id, 'rejected', reason, now);
    return next;
  }

  /** Tombstone: the row stays (history), recall never returns it again. */
  forget(id: string, reason: string | null = null, now = Date.now()): MemoryItem | null {
    const m = this.row(id);
    if (!m) return null;
    if (m.status === 'forgotten') return m;
    const next: MemoryItem = { ...m, status: 'forgotten', decided_at: now };
    this.write(next);
    this.event(id, 'forgotten', reason, now);
    return next;
  }

  markUsed(ids: string[], now = Date.now()): void {
    for (const id of ids) {
      const m = this.row(id);
      if (!m || m.status !== 'active') continue;
      this.write({ ...m, last_used_at: now, use_count: m.use_count + 1 });
      this.event(id, 'used', null, now);
    }
  }

  /** 带 memory_stats(§2.2)的列表;recall 走 listRaw,不为每次判断现算统计。 */
  list(filter: MemoryListFilter = {}): MemoryItem[] {
    const items = this.listRaw(filter);
    const stats = this.statsFor(items.map((m) => m.id));
    return items.map((m) => ({ ...m, memory_stats: stats.get(m.id) ?? EMPTY_STATS }));
  }

  private listRaw(filter: MemoryListFilter = {}): MemoryItem[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      args.push(...filter.status);
    }
    if (filter.symbol !== undefined) {
      if (filter.symbol === null) where.push('symbol IS NULL');
      else {
        where.push('(symbol = ? OR symbol IS NULL)');
        args.push(filter.symbol.toUpperCase());
      }
    }
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    if (filter.layer) {
      where.push('layer = ?');
      args.push(filter.layer);
    }
    if (filter.role) {
      where.push('role = ?');
      args.push(filter.role);
    }
    if (filter.strategy_id) {
      where.push('strategy_id = ?');
      args.push(filter.strategy_id);
    }
    args.push(filter.limit ?? 200);
    const rows = this.db.prepare(`SELECT json FROM demo_memory ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...args) as { json: string }[];
    return rows.map((r) => parseItem(r.json));
  }

  // ---------------------------------------------------------------- §2.2 后果回写

  /**
   * 判断引用了这条记忆的 episode 结算后,把结果挂回记忆。幂等:同一 (memory_id, episode_id) 只记一次
   * (唯一索引 idx_demo_memory_events_outcome,迁移 0040)。未知记忆 id 返回 false。NULL 不是 0:算不出的 R 留 null,不进均值。
   */
  recordOutcome(o: { memory_id: string; episode_id: string; outcome_r: number | null; regret_r: number | null; at?: number }): boolean {
    if (!o.episode_id || !this.row(o.memory_id)) return false;
    const num = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const detail = JSON.stringify({ episode_id: o.episode_id, outcome_r: num(o.outcome_r), regret_r: num(o.regret_r) });
    const r = this.db.prepare("INSERT OR IGNORE INTO demo_memory_events(memory_id, at, kind, detail) VALUES (?, ?, 'outcome', ?)").run(o.memory_id, o.at ?? Date.now(), detail);
    return Number(r.changes) > 0;
  }

  stats(memoryId: string): MemoryStats {
    return this.statsFor([memoryId]).get(memoryId) ?? EMPTY_STATS;
  }

  private statsFor(ids: string[]): Map<string, MemoryStats> {
    const out = new Map<string, MemoryStats>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      if (!chunk.length) continue;
      const rows = this.db
        .prepare(
          `SELECT memory_id, COUNT(*) AS n, AVG(json_extract(detail, '$.outcome_r')) AS r, AVG(json_extract(detail, '$.regret_r')) AS g FROM demo_memory_events WHERE kind = 'outcome' AND memory_id IN (${chunk.map(() => '?').join(',')}) GROUP BY memory_id`,
        )
        .all(...chunk) as { memory_id: string; n: number; r: number | null; g: number | null }[];
      for (const r of rows) out.set(r.memory_id, { cited_n: Number(r.n), mean_r_when_cited: round4(r.r), mean_regret_when_cited: round4(r.g) });
    }
    return out;
  }

  /**
   * 扫已结算的判断账本行(demo_judgment_ledger.settled_at 非空)× demo_episodes,把 episode 引用过的记忆
   * (citedMemoryIds)逐条 recordOutcome(outcome_r = outcome_r_model,regret_r = regret_review)。幂等,可反复跑。
   * 没接进 runtime(见 docs/demo/memory.md「待接线」)。`db` 缺省用本 store 的库。
   */
  sweepOutcomes(db: DatabaseSync = this.db, opts: { since?: number; now?: number } = {}): { scanned: number; recorded: number } {
    const rows = db
      .prepare(
        `SELECT l.episode_id AS episode_id, l.outcome_r_model AS r, l.regret_review AS g, l.settled_at AS settled_at, e.json AS ej
           FROM demo_judgment_ledger l JOIN demo_episodes e ON e.id = l.episode_id
          WHERE l.settled_at IS NOT NULL AND l.settled_at >= ? AND e.json LIKE '%"kind":"memory"%'`,
      )
      .all(opts.since ?? 0) as { episode_id: string; r: number | null; g: number | null; settled_at: number; ej: string }[];
    let recorded = 0;
    for (const row of rows) {
      let ep: Parameters<typeof citedMemoryIds>[0];
      try {
        ep = JSON.parse(row.ej) as Parameters<typeof citedMemoryIds>[0];
      } catch {
        continue;
      }
      for (const id of citedMemoryIds(ep)) {
        if (this.recordOutcome({ memory_id: id, episode_id: row.episode_id, outcome_r: row.r, regret_r: row.g, at: opts.now ?? row.settled_at })) recorded++;
      }
    }
    return { scanned: rows.length, recorded };
  }

  counts(): Record<MemoryStatus, number> {
    const out: Record<MemoryStatus, number> = { proposed: 0, active: 0, rejected: 0, superseded: 0, forgotten: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM demo_memory GROUP BY status').all() as { status: MemoryStatus; n: number }[]) out[r.status] = r.n;
    return out;
  }

  events(memoryId: string, limit = 50): MemoryEvent[] {
    return this.db.prepare('SELECT id, memory_id, at, kind, detail FROM demo_memory_events WHERE memory_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(memoryId, limit) as unknown as MemoryEvent[];
  }

  /**
   * Structured recall: active, not expired, scope global or same symbol; optional FTS5 text match (trigram, so
   * ≥ 3 chars) restricts + rescored with BM25; then top-K under a character budget. Cross-symbol items never leak.
   */
  recall(q: MemoryRecallQuery): MemoryRecallHit[] {
    const now = q.now ?? Date.now();
    const reader: BotRole = q.reader_role ?? 'thread_manager';
    const strategyId = clean(q.strategy_id);
    const limit = q.limit ?? MEMORY_LIMITS.recall_limit;
    const budget = q.char_budget ?? MEMORY_LIMITS.recall_char_budget;
    const symbol = q.symbol ? q.symbol.toUpperCase() : null;
    let candidates: { item: MemoryItem; bm25: number | null }[];
    const text = q.text?.trim() ?? '';
    if (text.length >= 3) {
      const safe = `"${text.replace(/"/g, '""')}"`;
      const rows = this.db
        .prepare("SELECT m.json AS json, bm25(demo_memory_fts) AS s FROM demo_memory_fts JOIN demo_memory m ON m.id = demo_memory_fts.memory_id WHERE demo_memory_fts MATCH ? AND m.status = 'active' ORDER BY s LIMIT ?")
        .all(safe, Math.max(limit * 4, 60)) as { json: string; s: number }[];
      // bm25() is negative-better; normalise to 0–1 within this candidate set.
      const best = rows.length ? Math.min(...rows.map((r) => r.s)) : -1;
      candidates = rows.map((r) => ({ item: parseItem(r.json), bm25: best === 0 ? 1 : Math.max(0, Math.min(1, r.s / best)) }));
    } else {
      candidates = this.listRaw({ status: ['active'], symbol: symbol ?? undefined, limit: 500 }).map((item) => ({ item, bm25: null }));
    }
    const hits: MemoryRecallHit[] = [];
    for (const c of candidates) {
      const it = c.item;
      if (it.status !== 'active') continue;
      if (it.expires_at !== null && it.expires_at <= now) continue;
      if (it.scope.symbol !== null && symbol !== null && it.scope.symbol !== symbol) continue;
      if (it.scope.symbol !== null && symbol === null && !text) continue; // no symbol context → only global items
      if (!canReadMemory(reader, it, { strategy_id: strategyId })) continue; // §5.2 读权矩阵
      const { score, why } = scoreMemory(it, { ...q, symbol, strategy_id: strategyId, reader_role: reader }, now, c.bm25);
      hits.push({ item: it, score, why });
    }
    const byScore = (a: MemoryRecallHit, b: MemoryRecallHit): number => b.score - a.score || b.item.created_at - a.item.created_at;
    hits.sort(byScore);
    // §5.3 每层配额:先按 strategy → symbol → global → role → thread 各取至多 LAYER_QUOTA 条,
    // 剩余槽位(某层空/不够)按分数让给其它层;总数与字符预算照旧。
    const out: MemoryRecallHit[] = [];
    const taken = new Set<string>();
    let used = 0;
    const take = (h: MemoryRecallHit): boolean => {
      if (out.length >= limit || taken.has(h.item.id)) return false;
      if (used + h.item.content.length > budget && out.length > 0) return false;
      out.push(h);
      taken.add(h.item.id);
      used += h.item.content.length;
      return true;
    };
    for (const layer of FILL_ORDER) {
      let n = 0;
      for (const h of hits) {
        if (n >= LAYER_QUOTA[layer] || out.length >= limit) break;
        if (layerOf(h.item.scope) === layer && take(h)) n++;
      }
    }
    for (const h of hits) {
      if (out.length >= limit) break;
      take(h);
    }
    return out.sort(byScore);
  }
}

// ---------------------------------------------------------------- candidate generation

/** Templated, deterministic fact about a finished trade — proposed by `system` on thread close, no model involved. */
export function tradeFactCandidate(t: StrategyThread, ctx: { regime: string | null; trigger: string | null; now?: number }): ProposeInput | null {
  if (t.status !== 'closed' && t.status !== 'canceled') return null;
  const pnl = t.realized_pnl !== null ? Number(t.realized_pnl) : null;
  const side = t.side === 'long' ? '做多' : '做空';
  const entry = t.filled_avg_price ? Number(t.filled_avg_price) : null;
  const stop = t.stop_price ? Number(t.stop_price) : null;
  const exit = t.exit_price ? Number(t.exit_price) : null;
  let r: number | null = null;
  if (entry && stop && exit && t.qty) {
    const risk = Math.abs(entry - stop);
    if (risk > 0) r = ((t.side === 'long' ? exit - entry : entry - exit) / risk);
  }
  const hold = t.opened_at && t.closed_at ? Math.round((t.closed_at - t.opened_at) / 60_000) : null;
  const outcome = t.status === 'canceled' ? '未成交撤单' : pnl === null ? '结果未知' : pnl >= 0 ? '盈利' : '亏损';
  const day = new Date(t.closed_at ?? ctx.now ?? Date.now()).toISOString().slice(0, 10);
  const content = `${day} ${t.symbol} ${side}(${t.source},${t.timeframe}${ctx.regime ? `,日线 ${ctx.regime}` : ''}${ctx.trigger ? `,触发 ${ctx.trigger}` : ''})→ ${outcome}${r !== null ? ` ${r >= 0 ? '+' : ''}${r.toFixed(1)}R` : ''}${hold !== null ? `,持有 ${hold} 分钟` : ''};原因:${(t.close_reason ?? '—').slice(0, 60)}`;
  const tags = [t.symbol.toLowerCase(), t.side, t.source, t.timeframe, ctx.regime ?? '', ctx.trigger ?? '', t.status === 'canceled' ? 'canceled' : pnl === null ? '' : pnl >= 0 ? 'win' : 'loss', r !== null && r <= -0.9 ? 'stopped_out' : ''].filter(Boolean);
  return { kind: 'fact', content, scope: { symbol: t.symbol, timeframe: t.timeframe, regime: ctx.regime }, source_refs: [t.id, ...t.episode_ids.slice(-3)], tags, confidence: 0.9, proposed_by: 'system', now: ctx.now };
}

/** Prompt for the reflect step (design §11 L-daily): distil ≤ 3 lessons from recent finished trades + existing memory. */
export function reflectPrompt(closed: StrategyThread[], facts: MemoryItem[], existing: MemoryItem[]): { system: string; user: string } {
  const system = [
    '你是 trading-swarm 的复盘模块。你读最近已结束的交易和已批准的记忆,提炼最多 3 条"教训"(lesson),每条一句话,≤ 120 字,简体中文,面向交易员。',
    '规则:只写从这些交易里能直接看出来的规律(如"某 regime 下做多突破连亏"),不要写通用常识;不要写具体价格数字;不要重复已有记忆;每条给 confidence(0.3–0.9)、适用范围 symbol(可 null)、regime(可 null)、tags(≤ 6 个英文/小写)、source_refs(引用下面的线程 id)。',
    '没有值得记的规律就输出空数组。只输出 JSON 数组:[{"content":"…","confidence":0.6,"symbol":"BTCUSDT"|null,"regime":"bear"|null,"tags":["…"],"source_refs":["thr-…"]}]',
  ].join('\n');
  const lines: string[] = ['## 最近已结束的交易'];
  for (const t of closed) lines.push(`- ${t.id} ${t.symbol} ${t.side} ${t.source} ${t.timeframe} 盈亏 ${t.realized_pnl ?? 'n/a'} 原因 ${t.close_reason ?? '—'} 论点:${t.thesis.slice(0, 80)}`);
  lines.push('', '## 已有的交易事实记忆');
  for (const f of facts) lines.push(`- ${f.id} ${f.content}`);
  lines.push('', '## 已批准的教训/偏好(不要重复)');
  for (const e of existing) lines.push(`- ${e.id} [${e.kind}] ${e.content}`);
  lines.push('', '只输出 JSON 数组。');
  return { system, user: lines.join('\n') };
}

export function parseReflectOutput(text: string, closedIds: Set<string>): ProposeInput[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ProposeInput[] = [];
  for (const x of arr) {
    if (out.length >= 3) break;
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const content = typeof o['content'] === 'string' ? o['content'].trim() : '';
    if (!content) continue;
    const refs = Array.isArray(o['source_refs']) ? (o['source_refs'] as unknown[]).filter((r): r is string => typeof r === 'string' && closedIds.has(r)) : [];
    out.push({
      kind: 'lesson',
      content,
      confidence: typeof o['confidence'] === 'number' ? o['confidence'] : 0.5,
      scope: { symbol: typeof o['symbol'] === 'string' ? o['symbol'] : null, regime: typeof o['regime'] === 'string' ? o['regime'] : null },
      tags: Array.isArray(o['tags']) ? (o['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : [],
      source_refs: refs,
      proposed_by: 'agent',
    });
  }
  return out;
}

/** Runs the reflect step with a brain; returns the proposals it created (all `proposed`, awaiting approval). */
export async function runReflect(store: MemoryStore, brain: Brain, closed: StrategyThread[], opts: { now?: number } = {}): Promise<{ proposed: MemoryItem[]; raw: string; skipped: number }> {
  if (!closed.length) return { proposed: [], raw: '', skipped: 0 };
  const facts = store.list({ status: ['active'], kind: 'fact', limit: 50 });
  const existing = store.list({ status: ['active'], limit: 100 }).filter((m) => m.kind !== 'fact');
  const { system, user } = reflectPrompt(closed, facts, existing);
  const r = await brain.complete(system, user, { timeoutMs: 120_000 });
  const inputs = parseReflectOutput(r.text, new Set(closed.map((t) => t.id)));
  const proposed: MemoryItem[] = [];
  let skipped = 0;
  for (const inp of inputs) {
    const { item, created } = store.propose({ ...inp, now: opts.now });
    if (created) proposed.push(item);
    else skipped++;
  }
  return { proposed, raw: r.text, skipped };
}
