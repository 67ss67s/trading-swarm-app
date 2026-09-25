// 09-23 记忆分域(docs/design/self-evolution-2026-09-23.md §5 / §2.2;契约 docs/demo/memory.md §1–§3、v3-ui-contract §9.48):
// 读权矩阵(每个角色只看到自己的层)、每层配额与空层让位、写权拒绝 + write_denied 事件、迁移 0040 回填旧行
// (FTS 照常命中)、outcome 回写幂等 + memory_stats、sweepOutcomes 从已结算账本 × episode 证据抽引用、bots 结构化 memory_scope。

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { LAYER_QUOTA, MEMORY_MATRIX, MemoryStore, MemoryWriteDeniedError, citedMemoryIds, contentHash, type ProposeInput } from '../../src/demo/memory.js';
import { validateRoleBoundaries } from '../../src/demo/bots.js';
import type { BotRole } from '../../src/demo/bots.js';
import type { MemoryItem } from '../../src/demo/types.js';

const NOW = 1_788_500_000_000;
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/migrations');
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function fresh(): { store: DemoStore; mem: MemoryStore } {
  const store = new DemoStore(openStateDb(':memory:'));
  return { store, mem: store.memory };
}

function active(mem: MemoryStore, content: string, extra: Partial<ProposeInput> = {}): MemoryItem {
  const { item } = mem.propose({ kind: 'lesson', content, proposed_by: 'user', proposed_by_role: 'system', now: NOW, ...extra });
  return item.status === 'active' ? item : mem.approve(item.id, NOW)!;
}

/** 每层各一条(role 层三条),方便看每个读者拿到哪些。 */
function seedLayers(mem: MemoryStore): Record<string, string> {
  return {
    global: active(mem, '全局教训:周末流动性差别追单', { scope: { layer: 'global' } }).id,
    reviewer: active(mem, '复盘方法:先看止损是否被扫再看方向', { scope: { layer: 'role', role: 'reviewer' } }).id,
    pmCal: active(mem, '组合校准:单簇敞口上限偏松', { kind: 'calibration', scope: { layer: 'role', role: 'portfolio_manager' } }).id,
    pmLesson: active(mem, '组合教训:别在高相关币上同时满仓', { scope: { layer: 'role', role: 'portfolio_manager' } }).id,
    radar: active(mem, '筛选方法:量比异动要看连续两根', { scope: { layer: 'role', role: 'radar' } }).id,
    s1: active(mem, '策略 s1:突破后回踩不破才加仓', { scope: { layer: 'strategy', strategy_id: 's1' } }).id,
    s2: active(mem, '策略 s2:均值回归在趋势日失效', { scope: { layer: 'strategy', strategy_id: 's2' } }).id,
    btc: active(mem, 'BTCUSDT 亚洲时段假突破多', { scope: { layer: 'symbol', symbol: 'BTCUSDT' } }).id,
    eth: active(mem, 'ETHUSDT 消息面敏感', { scope: { symbol: 'ETHUSDT' } }).id,
    thread: active(mem, '线程 thr-1 的论点是日线级别', { scope: { layer: 'thread', thread_id: 'thr-1' } }).id,
  };
}

const ids = (hits: { item: MemoryItem }[]): string[] => hits.map((h) => h.item.id).sort();

describe('memory scope: read matrix (§5.2)', () => {
  it('each reader role sees only its layers; symbol never leaks across coins', () => {
    const { mem } = fresh();
    const m = seedLayers(mem);
    const q = { symbol: 'BTCUSDT', now: NOW, limit: 50, char_budget: 5000 };
    // thread_manager(缺省读者):global + 当前策略 + 当前币
    expect(ids(mem.recall({ ...q, strategy_id: 's1' }))).toEqual([m.global, m.s1, m.btc].sort());
    expect(ids(mem.recall({ ...q, reader_role: 'thread_manager', strategy_id: 's1' }))).toEqual([m.global, m.s1, m.btc].sort());
    // 没有策略上下文 → 判断不读 strategy 层(旧调用点不传 strategy_id 的行为)
    expect(ids(mem.recall(q))).toEqual([m.global, m.btc].sort());
    // reviewer / gate_captain:全部层(symbol 不泄漏规则照旧 → 没有 ETH)
    const all = [m.global, m.reviewer, m.pmCal, m.pmLesson, m.radar, m.s1, m.s2, m.btc, m.thread].sort();
    expect(ids(mem.recall({ ...q, reader_role: 'reviewer' }))).toEqual(all);
    expect(ids(mem.recall({ ...q, reader_role: 'gate_captain' }))).toEqual(all);
    // radar:global + symbol
    expect(ids(mem.recall({ ...q, reader_role: 'radar' }))).toEqual([m.global, m.btc].sort());
    // portfolio_manager:只有 role:portfolio_manager 的 calibration
    expect(ids(mem.recall({ ...q, reader_role: 'portfolio_manager' }))).toEqual([m.pmCal]);
    // strategy_lab:strategy(给了 strategy_id 就只那条)+ global
    expect(ids(mem.recall({ ...q, reader_role: 'strategy_lab' }))).toEqual([m.global, m.s1, m.s2].sort());
    expect(ids(mem.recall({ ...q, reader_role: 'strategy_lab', strategy_id: 's2' }))).toEqual([m.global, m.s2].sort());
    // asp_agent:只有 global;executor / risk_sentinel:什么都不读
    expect(ids(mem.recall({ ...q, reader_role: 'asp_agent' }))).toEqual([m.global]);
    expect(mem.recall({ ...q, reader_role: 'executor' })).toEqual([]);
    expect(mem.recall({ ...q, reader_role: 'risk_sentinel' })).toEqual([]);
  });

  it('radar boosts tag=screen; free-text recall is filtered by the matrix too', () => {
    const { mem } = fresh();
    const plain = active(mem, '全局:别在资金费极端时追多', { scope: { layer: 'global' }, confidence: 0.9 });
    const screen = active(mem, '全局:筛选时剔除上线不足七天的币', { scope: { layer: 'global' }, tags: ['screen'], confidence: 0.5 });
    const hitsRadar = mem.recall({ symbol: null, reader_role: 'radar', now: NOW, limit: 1 });
    expect(hitsRadar.map((h) => h.item.id)).toEqual([screen.id]);
    expect(hitsRadar[0]!.why).toContain('筛选类');
    expect(mem.recall({ symbol: null, reader_role: 'thread_manager', now: NOW, limit: 1 }).map((h) => h.item.id)).toEqual([plain.id]);
    const role = active(mem, '复盘方法:止损被扫后看成交量', { scope: { layer: 'role', role: 'reviewer' } });
    expect(mem.recall({ symbol: null, text: '止损被扫', now: NOW })).toEqual([]);
    expect(mem.recall({ symbol: null, text: '止损被扫', reader_role: 'reviewer', now: NOW }).map((h) => h.item.id)).toEqual([role.id]);
  });
});

describe('memory scope: per-layer budgets (§5.3)', () => {
  it('top-5 is split strategy 2 / symbol 2 / global 1 even when globals score higher', () => {
    const { mem } = fresh();
    for (let i = 0; i < 4; i++) active(mem, `策略 s1 教训 ${i}`, { scope: { layer: 'strategy', strategy_id: 's1' }, confidence: 0.1 });
    for (let i = 0; i < 4; i++) active(mem, `BTC 教训 ${i}`, { scope: { symbol: 'BTCUSDT' }, confidence: 0.1 });
    for (let i = 0; i < 4; i++) active(mem, `全局教训 ${i}`, { scope: { layer: 'global' }, confidence: 1, tags: ['breakout'] });
    const hits = mem.recall({ symbol: 'BTCUSDT', strategy_id: 's1', tags: ['breakout'], now: NOW });
    expect(hits).toHaveLength(5);
    const count = (l: string) => hits.filter((h) => h.item.scope.layer === l).length;
    expect([count('strategy'), count('symbol'), count('global')]).toEqual([LAYER_QUOTA.strategy, LAYER_QUOTA.symbol, LAYER_QUOTA.global]);
    // 输出仍按分数排序
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
  });

  it('empty layers give their slots to the others; char budget still applies', () => {
    const { mem } = fresh();
    for (let i = 0; i < 6; i++) active(mem, `全局教训编号 ${i}`, { scope: { layer: 'global' } });
    expect(mem.recall({ symbol: 'BTCUSDT', now: NOW })).toHaveLength(5);
    active(mem, 'BTC 唯一一条', { scope: { symbol: 'BTCUSDT' } });
    const hits = mem.recall({ symbol: 'BTCUSDT', now: NOW });
    expect(hits).toHaveLength(5);
    expect(hits.filter((h) => h.item.scope.layer === 'symbol')).toHaveLength(1);
    const tiny = mem.recall({ symbol: 'BTCUSDT', now: NOW, char_budget: 20 });
    expect(tiny.reduce((n, h) => n + h.item.content.length, 0)).toBeLessThanOrEqual(20);
  });
});

describe('memory scope: write matrix', () => {
  it('denies by role, throws a typed 403 and logs write_denied (even for duplicate content)', () => {
    const { mem } = fresh();
    const existing = active(mem, '全局:已有的一条', { scope: { layer: 'global' } });
    const attempt = (input: Partial<ProposeInput>) => () => mem.propose({ kind: 'lesson', content: '全局:已有的一条', proposed_by: 'agent', now: NOW, ...input });
    expect(attempt({ proposed_by_role: 'thread_manager' })).toThrow(MemoryWriteDeniedError);
    try {
      attempt({ proposed_by_role: 'thread_manager' })();
    } catch (e) {
      expect((e as MemoryWriteDeniedError).status).toBe(403);
      expect((e as MemoryWriteDeniedError).code).toBe('memory_write_denied');
    }
    const denied = mem.events('-').filter((e) => e.kind === 'write_denied');
    expect(denied).toHaveLength(2);
    expect(JSON.parse(denied[0]!.detail!)).toMatchObject({ writer: 'thread_manager', layer: 'global' });
    expect(mem.events(existing.id).some((e) => e.kind === 'dedup_hit')).toBe(false);

    const p = (content: string, role: BotRole, scope: ProposeInput['scope']) => () => mem.propose({ kind: 'lesson', content, proposed_by: 'agent', proposed_by_role: role, scope, now: NOW });
    expect(p('radar 写别人的 role 层', 'radar', { layer: 'role', role: 'reviewer' })).toThrow(MemoryWriteDeniedError);
    expect(p('radar 写 global', 'radar', { layer: 'global' })).toThrow(MemoryWriteDeniedError);
    expect(p('radar 写自己的 role 层', 'radar', { layer: 'role', role: 'radar' })()).toMatchObject({ created: true });
    expect(p('reviewer 写 thread 层', 'reviewer', { layer: 'thread', thread_id: 'thr-1' })).toThrow(MemoryWriteDeniedError);
    expect(p('reviewer 写 strategy', 'reviewer', { strategy_id: 's1' })().item.scope.layer).toBe('strategy');
    expect(p('reviewer 写自己的 role 层', 'reviewer', { layer: 'role', role: 'reviewer' })().created).toBe(true);
    expect(p('lab 写 symbol', 'strategy_lab', { symbol: 'BTCUSDT' })).toThrow(MemoryWriteDeniedError);
    expect(p('lab 写 strategy', 'strategy_lab', { layer: 'strategy', strategy_id: 's9' })().created).toBe(true);
    expect(p('portfolio 什么都不能写', 'portfolio_manager', { layer: 'role', role: 'portfolio_manager' })).toThrow(MemoryWriteDeniedError);
  });

  it('missing role is inferred (temporary): agent → reviewer, system/user → anything', () => {
    const { mem } = fresh();
    expect(mem.propose({ kind: 'lesson', content: 'agent 写 symbol', proposed_by: 'agent', scope: { symbol: 'btcusdt' }, now: NOW }).item.scope).toMatchObject({ layer: 'symbol', symbol: 'BTCUSDT' });
    expect(() => mem.propose({ kind: 'lesson', content: 'agent 写 thread', proposed_by: 'agent', scope: { thread_id: 'thr-9' }, now: NOW })).toThrow(MemoryWriteDeniedError);
    expect(mem.propose({ kind: 'fact', content: 'system 写 thread', proposed_by: 'system', scope: { thread_id: 'thr-9' }, now: NOW }).item.scope.layer).toBe('thread');
    expect(mem.propose({ kind: 'preference', content: 'user 写别人的 role', proposed_by: 'user', scope: { layer: 'role', role: 'radar' }, activate: true, now: NOW }).item.status).toBe('active');
    expect(mem.events(mem.list({ layer: 'symbol' })[0]!.id).at(-1)!.detail).toBe('agent(reviewer)');
  });

  it('scope consistency is validated (400)', () => {
    const { mem } = fresh();
    const bad = (scope: ProposeInput['scope']) => () => mem.propose({ kind: 'lesson', content: `x ${JSON.stringify(scope)}`, proposed_by: 'system', scope, now: NOW });
    expect(bad({ layer: 'role' })).toThrow(/role/);
    expect(bad({ layer: 'role', role: 'nobody' as BotRole })).toThrow(/role/);
    expect(bad({ layer: 'strategy' })).toThrow(/strategy_id/);
    expect(bad({ layer: 'symbol' })).toThrow(/symbol/);
    expect(bad({ layer: 'thread' })).toThrow(/thread_id/);
  });
});

describe('memory scope: migration 0040 on a DB that already has rows', () => {
  it('backfills layer (symbol → symbol, else global), rewrites json scope, keeps FTS hits', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tg-mem-scope-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'state.sqlite');
    // 1) 只跑 0040 之前的迁移,写两条旧形状的行(json 里 scope 只有 symbol/timeframe/regime)。
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      const v = f.replace(/\.sql$/, '');
      if (v >= '0040') continue;
      old.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      old.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(v, NOW);
    }
    const legacy = (id: string, content: string, symbol: string | null) => {
      const item = { id, kind: 'lesson', scope: { symbol, timeframe: null, regime: 'bear' }, content, source_refs: [], tags: ['legacy'], confidence: 0.6, status: 'active', proposed_by: 'agent', supersedes: null, superseded_by: null, created_at: NOW, decided_at: NOW, last_used_at: null, use_count: 0, expires_at: null, content_hash: contentHash(content) };
      old.prepare('INSERT INTO demo_memory(id, kind, status, symbol, content_hash, created_at, last_used_at, expires_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'lesson', 'active', symbol, item.content_hash, NOW, null, null, JSON.stringify(item));
      old.prepare('INSERT INTO demo_memory_fts(memory_id, content, tags) VALUES (?, ?, ?)').run(id, content, 'legacy');
    };
    legacy('mem-old-btc', 'BTCUSDT 熊市里反弹做空更稳', 'BTCUSDT');
    legacy('mem-old-global', '熊市里不要逆势抄底', null);
    old.close();

    // 2) openStateDb 补跑 0040。
    const state = openStateDb(file);
    const cols = (state.db.prepare("SELECT name FROM pragma_table_info('demo_memory')").all() as { name: string }[]).map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(['layer', 'role', 'strategy_id', 'thread_id']));
    const rows = state.db.prepare('SELECT id, layer, json FROM demo_memory ORDER BY id').all() as { id: string; layer: string; json: string }[];
    expect(rows.map((r) => [r.id, r.layer])).toEqual([['mem-old-btc', 'symbol'], ['mem-old-global', 'global']]);
    expect(JSON.parse(rows[0]!.json).scope).toEqual({ symbol: 'BTCUSDT', timeframe: null, regime: 'bear', layer: 'symbol', role: null, strategy_id: null, thread_id: null });

    const mem = new MemoryStore(state.db);
    expect(mem.get('mem-old-global')!.scope.layer).toBe('global');
    // FTS(独立表,没重建)照常命中,且过读权矩阵
    expect(mem.recall({ symbol: 'BTCUSDT', text: '熊市里', now: NOW }).map((h) => h.item.id).sort()).toEqual(['mem-old-btc', 'mem-old-global']);
    expect(mem.recall({ symbol: 'BTCUSDT', now: NOW }).map((h) => h.item.id).sort()).toEqual(['mem-old-btc', 'mem-old-global']);
    // 迁移后新写入走新列
    const { item } = mem.propose({ kind: 'lesson', content: '迁移后写的策略教训', proposed_by: 'agent', scope: { strategy_id: 's1' }, now: NOW });
    expect((state.db.prepare('SELECT layer, strategy_id FROM demo_memory WHERE id = ?').get(item.id) as { layer: string; strategy_id: string })).toEqual({ layer: 'strategy', strategy_id: 's1' });
    state.db.close();
  });
});

describe('memory outcome writeback (§2.2)', () => {
  it('recordOutcome is idempotent per (memory, episode); stats ignore nulls; get/list expose memory_stats', () => {
    const { mem } = fresh();
    const a = active(mem, '全局:回踩确认再进', { scope: { layer: 'global' } });
    expect(mem.get(a.id)!.memory_stats).toEqual({ cited_n: 0, mean_r_when_cited: null, mean_regret_when_cited: null });
    expect(mem.recordOutcome({ memory_id: a.id, episode_id: 'ep-1', outcome_r: 1.5, regret_r: null, at: NOW })).toBe(true);
    expect(mem.recordOutcome({ memory_id: a.id, episode_id: 'ep-1', outcome_r: 9, regret_r: 9, at: NOW })).toBe(false);
    expect(mem.recordOutcome({ memory_id: a.id, episode_id: 'ep-2', outcome_r: -0.5, regret_r: 0.4, at: NOW })).toBe(true);
    expect(mem.recordOutcome({ memory_id: a.id, episode_id: 'ep-3', outcome_r: null, regret_r: null, at: NOW })).toBe(true);
    expect(mem.recordOutcome({ memory_id: 'mem-nope', episode_id: 'ep-1', outcome_r: 1, regret_r: null })).toBe(false);
    expect(mem.stats(a.id)).toEqual({ cited_n: 3, mean_r_when_cited: 0.5, mean_regret_when_cited: 0.4 });
    expect(mem.get(a.id)!.memory_stats!.cited_n).toBe(3);
    expect(mem.list({ status: ['active'] })[0]!.memory_stats).toEqual({ cited_n: 3, mean_r_when_cited: 0.5, mean_regret_when_cited: 0.4 });
    // 统计不落 json(写库时剥掉)
    mem.markUsed([a.id], NOW + 1);
    expect(mem.get(a.id)!.use_count).toBe(1);
    expect(mem.events(a.id).filter((e) => e.kind === 'outcome')).toHaveLength(3);
  });

  it('citedMemoryIds reads evidence kind=memory ∩ judgment.evidence_refs, plus episode.memory.cited', () => {
    const ep = {
      evidence: [
        { ref: 'E1', kind: 'price', label: '价格' },
        { ref: 'E7', kind: 'memory', label: '记忆 mem-aaa111·教训' },
        { ref: 'E8', kind: 'memory', label: '记忆 mem-bbb222·事实' },
      ],
      judgment: { evidence_refs: ['E1', 'E7'] },
      memory: { injected: ['mem-aaa111', 'mem-bbb222', 'mem-ccc333'], cited: ['mem-ccc333'] },
    };
    expect(citedMemoryIds(ep).sort()).toEqual(['mem-aaa111', 'mem-ccc333']);
    expect(citedMemoryIds({ evidence: ep.evidence, judgment: null })).toEqual([]);
  });

  it('sweepOutcomes: settled ledger rows × episode evidence → outcome events, idempotent, unsettled skipped', () => {
    const { mem } = fresh();
    const db = openLedgerDb(mem);
    const a = active(mem, '全局:趋势日别做均值回归', { scope: { layer: 'global' } });
    const b = active(mem, 'BTCUSDT 周末假突破', { scope: { symbol: 'BTCUSDT' } });
    const ep = (id: string, cited: string[]) => ({
      id,
      evidence: [
        { ref: 'E5', kind: 'memory', label: `记忆 ${a.id}·教训` },
        { ref: 'E6', kind: 'memory', label: `记忆 ${b.id}·教训` },
      ],
      judgment: { evidence_refs: cited },
      memory: { injected: [a.id, b.id], cited: [] },
    });
    const insert = (id: string, cited: string[], settled: number | null, r: number | null, regret: number | null) => {
      db.prepare('INSERT INTO demo_episodes(id, at, status, action, json) VALUES (?, ?, ?, ?, ?)').run(id, NOW, 'done', 'HOLD', JSON.stringify(ep(id, cited)));
      db.prepare(
        'INSERT INTO demo_judgment_ledger(episode_id, at, as_of, symbol, timeframe, mode, horizon_end_at, outcome_r_model, regret_review, settled_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, NOW, NOW, 'BTCUSDT', '15m', 'review', NOW + 1, r, regret, settled, '{}');
    };
    insert('ep-1', ['E5', 'E6'], NOW + 10, 2, 0.5);
    insert('ep-2', ['E5'], NOW + 20, -1, null);
    insert('ep-3', ['E5', 'E6'], null, null, null); // 未结算
    expect(mem.sweepOutcomes()).toEqual({ scanned: 2, recorded: 3 });
    expect(mem.sweepOutcomes()).toEqual({ scanned: 2, recorded: 0 });
    expect(mem.stats(a.id)).toEqual({ cited_n: 2, mean_r_when_cited: 0.5, mean_regret_when_cited: 0.5 });
    expect(mem.stats(b.id)).toEqual({ cited_n: 1, mean_r_when_cited: 2, mean_regret_when_cited: 0.5 });
  });
});

/** MemoryStore 与账本/episode 同库;测试里直接拿它的句柄写夹具。 */
function openLedgerDb(mem: MemoryStore): DatabaseSync {
  return (mem as unknown as { db: DatabaseSync }).db;
}

describe('bots: structured memory_scope', () => {
  it('seeds memory_scope from MEMORY_MATRIX; legacy free text is read back as matrix + note; mismatches fail validation', () => {
    const { store } = fresh();
    store.bots.seed(NOW);
    for (const p of store.bots.profiles()) {
      expect(p.memory_scope.read).toEqual([...MEMORY_MATRIX[p.role].read]);
      expect(p.memory_scope.write).toEqual([...MEMORY_MATRIX[p.role].write]);
    }
    expect(store.bots.profile('thread_manager')!.memory_scope.write).toEqual([]);
    expect(store.bots.profile('executor')!.memory_scope).toMatchObject({ read: [], write: [] });
    const db = openLedgerDb(store.memory);
    db.prepare("UPDATE demo_bot_profile SET memory_scope = '旧的自由文本' WHERE role = 'radar'").run();
    expect(store.bots.profile('radar')!.memory_scope).toEqual({ read: ['global', 'symbol'], write: ['role'], note: '旧的自由文本' });
    const profiles = store.bots.profiles();
    expect(validateRoleBoundaries(profiles)).toEqual([]);
    const tampered = profiles.map((p) => (p.role === 'thread_manager' ? { ...p, memory_scope: { ...p.memory_scope, write: ['global' as const] } } : p));
    expect(validateRoleBoundaries(tampered)).toEqual(['thread_manager: memory_scope 与 MEMORY_MATRIX 不一致']);
  });
});
