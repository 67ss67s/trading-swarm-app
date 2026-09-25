// chat.ts 2026-09-24 只读工具:注册、参数校验、只读(不写任何表)、返回形状与深链。零模型(脑子是桩)。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import {
  DEEP_LINKS,
  OBSERVE_MIN_SAMPLE,
  READONLY_CHAT_TOOLS,
  isReadonlyChatTool,
  readonlyChatTools,
  runChatTurn,
  systemPrompt,
  type ChatDeps,
  type ChatTools,
  type OptionalModuleLoader,
} from '../../src/demo/chat.js';
import type { Brain, BrainResult } from '../../src/demo/brain.js';
import type { ChatMessage } from '../../src/demo/types.js';
import { JudgmentLedgerStore, type JudgmentLedgerRow } from '../../src/demo/judgment-ledger.js';
import { persistCandidate, type StrategyCandidate } from '../../src/demo/strategy-candidate.js';
import { ResearchStore } from '../../src/demo/research/store.js';
import type { ResearchService } from '../../src/demo/research/service.js';
import { StrategyStore } from '../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../src/demo/research/strategies/service.js';
import { summaryOf } from '../../src/demo/research/backtest-report.js';
import { defaultIR, meta, report } from './research/strategies/fixtures.js';

const NOW = Date.now();
let dir = '';
let dbPath = '';
let state: StateDb;
let strategyId = '';
let reportId = '';

function ledgerRow(i: number, over: Partial<JudgmentLedgerRow> = {}): JudgmentLedgerRow {
  const episode_id = `ep-t${i}`;
  const hold = i % 2 === 0;
  return {
    version: 'jl-v2',
    episode_id,
    at: NOW - 3_600_000 - i * 60_000,
    as_of: NOW - 3_600_000 - i * 60_000,
    symbol: 'BTCUSDT',
    timeframe: '1h',
    mode: 'review',
    thread_id: `thr-${i % 12}`,
    cluster_id: `thr-${i % 12}`,
    strategy_id: i % 3 === 0 ? 'breakout_retest' : 'trend_pullback',
    model_action: hold ? 'HOLD' : 'EXIT',
    trigger_kind: i % 2 === 0 ? 'heartbeat' : 'breakout',
    holding_reason: hold ? 'thesis_intact' : 'invalidated',
    prompt_version: 'p-v7',
    model_stance: 'direction',
    model_dir: 'long',
    council_stance: 'direction',
    council_dir: 'long',
    council_agree: true,
    mechanical_dir: 'long',
    mechanical_note: null,
    horizon_end_at: NOW - 60_000,
    outcome_r_model: 0.5 + (i % 5) * 0.1,
    outcome_r_council: 0.4,
    outcome_r_mechanical: 0.2,
    outcome_source_model: 'counterfactual',
    regret_review: 0.1,
    regret_hold: hold ? 0.2 + (i % 3) * 0.1 : null,
    settled_at: NOW - 30_000,
    settle_note: null,
    settlement_status: null,
    realized: null,
    snapshot: null,
    review: null,
    legs: { model: null, council: null, mechanical: null },
    regret: { hold_r: 1, exit_now_r: 0.5, chosen_r: hold ? 1 : 0.5, best_r: 1, regret_r: hold ? 0 : 0.5, regret_hold: hold ? 0.2 + (i % 3) * 0.1 : null, regret_exit: hold ? null : 0.5 + (i % 4) * 0.25, hold_status: 'tp', note: '' },
    ...over,
  } as JudgmentLedgerRow;
}

function candidate(i: number): StrategyCandidate {
  const settled = i < 8;
  return {
    id: `cand_${(0xa00 + i).toString(16)}`,
    version_tag: 'candidate-v0',
    at: NOW - i * 3_600_000,
    as_of: NOW - i * 3_600_000,
    symbol: i % 2 ? 'ETHUSDT' : 'BTCUSDT',
    timeframe: '1h',
    strategy_id: 'synth:donchian_close_long_v1:1h',
    version: 1,
    ir_hash: 'h1',
    ir_source: 'synth',
    origin: 'online',
    direction: 'long',
    entry_type: 'next_open_market',
    entry_ref: 100,
    stop: 95,
    target: 110,
    target_source: 'fixed_r_target',
    rr: 2,
    invalidation: 95,
    horizon_bars: 48,
    reason: 't',
    unmapped: [],
    view_bars: 200,
    status: settled ? 'settled' : 'open',
    model: null,
    settlement: settled
      ? { source: 'plan_walk', settled_at: NOW, horizon_bars: 48, bars_seen: 48, plan: { status: 'tp', r: i === 0 ? 8 : -0.5, fill_price: 100, exit_price: 101, bars_held: 3 }, trail: { status: 'stop', r: 0.3, fill_price: 100, exit_price: 101, bars_held: 5 }, note: '' }
      : null,
  } as unknown as StrategyCandidate;
}

function seed(db: DatabaseSync): void {
  const ledger = new JudgmentLedgerStore(db);
  for (let i = 0; i < 40; i++) ledger.save(ledgerRow(i));
  for (let i = 0; i < 12; i++) persistCandidate(db, candidate(i));
  // 研究策略 + 一份带逐笔的回测报告
  const research = new ResearchStore(db);
  const svc = new StrategyService(new StrategyStore(db), research, {} as ResearchService);
  strategyId = svc.create({ name: '顺势突破', strategy_ir: defaultIR() }).id;
  const r = report({ ir: defaultIR(), strategy_id: strategyId, m: { trades: 12, total_return: 0.08, max_drawdown: 0.04, avg_holding_ms: 7_200_000 } });
  r.assets[0]!.trades = Array.from({ length: 12 }, (_, k) => ({ id: `t${k}`, symbol: 'BTCUSDT', side: 'long' as const, entry_at: k, entry_price: 1, exit_at: k + 1, exit_price: 1, qty: 1, pnl: 1, return_pct: k === 0 ? 0.5 : -0.01, fees: 0, bars_held: 2, exit_reason: 'stop', segment: 'in_sample' as const }));
  reportId = r.id;
  db.prepare('INSERT INTO research_backtests(id,created_at,strategy_ir_hash,strategy_id,strategy_version,report_json,summary_json) VALUES (?,?,?,?,?,?,?)').run(r.id, r.created_at, r.strategy_ir_hash, strategyId, 1, JSON.stringify(r), JSON.stringify(summaryOf(r)));
  svc.attachReport(r, meta(), { strategy_id: strategyId, strategy_version: 1 });
  // OKX 全市场扫描(universe='okx_all')+ 一条旧口径的筛选(不该被读到)
  db.prepare("INSERT INTO demo_screen(id, horizon, started_at, finished_at, status, universe, symbols_json, errors_json) VALUES ('scr-okx','short',?,?,'done','okx_all','[\"A\",\"B\",\"C\"]','[]')").run(NOW - 5000, NOW - 4000);
  db.prepare("INSERT INTO demo_screen(id, horizon, started_at, status, universe, symbols_json, errors_json) VALUES ('scr-w','short',?,'done','watchlist+whitelist','[\"A\"]','[]')").run(NOW - 1000);
  const wc = db.prepare("INSERT INTO demo_watch_candidate VALUES ('scr-okx','short',?, 'breakout_retest', ?, ?, ?, '{}', ?, ?)");
  wc.run('SOLUSDT', 0.91, 1, JSON.stringify(['放量突破', '趋势向上', '第三条']), NOW + 1e7, NOW);
  wc.run('DOGEUSDT', 0.7, 2, '[]', NOW + 1e7, NOW);
}

/** 所有用户表的行数指纹(只读断言用)。 */
function fingerprint(db: DatabaseSync): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => `${t}:${(db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n}`).join('|');
}

const evoStub: OptionalModuleLoader = async (name) =>
  name === 'evolution'
    ? {
        evolutionDaily: (_db: DatabaseSync, o: { from: string; to: string }) => ({
          version: 'evolution/v1',
          from: o.from,
          to: o.to,
          roles: [
            { role: 'thread_manager', label: '判断', metric_label: '判断增量', days: [{ date: o.from, status: 'good', score: 0.3, headline: '好', events: 0 }, { date: o.to, status: 'none', score: null, headline: '', events: 0 }], summary: { good: 1, ok: 0, bad: 0, none: 1, baseline_days: 5 } },
            { role: 'radar', label: '雷达', metric_label: '命中', days: [{ date: o.to, status: 'bad', score: 0.1, headline: '差', events: 0 }], summary: { good: 0, ok: 0, bad: 1, none: 0, baseline_days: 5 } },
          ],
          today: { judgments: { used: 3, cap: 300, cost_cny: 1.2, idle_share: 0.5 }, candidates: { open: 1, settled: 2, today_new: 0 }, live_pool: { size: 2 } },
          missing_sources: [],
        }),
      }
    : null;
const noModules: OptionalModuleLoader = async () => null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-chat-ro-'));
  dbPath = join(dir, 'state.sqlite');
  state = openStateDb(dbPath);
  seed(state.db);
});
afterAll(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('注册', () => {
  it('六个只读工具都在系统提示里,并要求附深链与样本口径', () => {
    expect(READONLY_CHAT_TOOLS).toEqual(['get_judgment_ledger', 'list_candidates', 'list_my_strategies', 'get_backtest_report', 'get_evolution', 'get_universe_scan']);
    const sp = systemPrompt(false);
    for (const n of READONLY_CHAT_TOOLS) {
      expect(sp).toContain(`- ${n}{`);
      expect(isReadonlyChatTool(n)).toBe(true);
    }
    expect(isReadonlyChatTool('propose_thread')).toBe(false);
    expect(sp).toContain('< 30');
    expect(sp).toContain('中位数');
    for (const h of ['#judgments', '#my-strategies', '#backtest?id=', '#evolution?role=', '#screener', '#research', '#market']) expect(sp).toContain(h);
    expect(Object.keys(readonlyChatTools(state.db, { loadModule: noModules })).sort()).toEqual([...READONLY_CHAT_TOOLS].sort());
  });

  it('runChatTurn:ChatTools 里没有的只读工具名也能调通,结果带 links', async () => {
    const replies = ['@@tool {"name":"get_judgment_ledger","args":{"dim":"strategy"}}', '看完了 [判断记录](#judgments)'];
    const prompts: string[] = [];
    const brain = { name: 'stub', complete: async (_s: string, p: string): Promise<BrainResult> => { prompts.push(p); return { text: replies.shift() ?? '完' } as BrainResult; } } as unknown as Brain;
    const saved: ChatMessage[] = [];
    const deps: ChatDeps = { brain: () => brain, tools: {} as ChatTools, stateSummary: () => 's', history: () => saved, save: (m) => saved.push(m), emit: () => {}, log: () => {}, readonly_db: state.db };
    const msg = await runChatTurn(deps, '模型判断值不值?');
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0]!.ok).toBe(true);
    const res = msg.tool_calls[0]!.result as { ready: boolean; links: { href: string }[] };
    expect(res.ready).toBe(true);
    expect(res.links[0]!.href).toBe('#judgments');
    // 截到 4000 字后链接仍在
    expect(prompts[1]).toContain('#judgments');
    expect(msg.text).toContain('#judgments');
  });

  it('runChatTurn:参数错误回成工具失败(ok=false,invalid_args)', async () => {
    const replies = ['@@tool {"name":"list_candidates","args":{"limit":999}}', '参数不对'];
    const brain = { name: 'stub', complete: async (): Promise<BrainResult> => ({ text: replies.shift() ?? '完' }) as BrainResult } as unknown as Brain;
    const deps: ChatDeps = { brain: () => brain, tools: {} as ChatTools, stateSummary: () => 's', history: () => [], save: () => {}, emit: () => {}, log: () => {}, readonly_db: state.db };
    const msg = await runChatTurn(deps, 'x');
    expect(msg.tool_calls[0]!.ok).toBe(false);
    expect((msg.tool_calls[0]!.result as { error: string }).error).toMatch(/^invalid_args:list_candidates:limit/);
  });
});

describe('参数校验', () => {
  const t = () => readonlyChatTools(state.db, { loadModule: noModules });
  it.each([
    ['get_judgment_ledger', { dim: 'symbol' }, /dim 只能是/],
    ['get_judgment_ledger', { since_days: 0 }, /since_days/],
    ['get_judgment_ledger', { source: 'x' }, /source/],
    ['get_judgment_ledger', { foo: 1 }, /不认识的参数 foo/],
    ['get_judgment_ledger', [1], /args 必须是对象/],
    ['list_candidates', { limit: 1.5 }, /limit/],
    ['list_candidates', { symbol: 3 }, /symbol 必须是字符串/],
    ['list_my_strategies', { filter: 'mine' }, /filter/],
    ['get_backtest_report', {}, /必须且只能给一个/],
    ['get_backtest_report', { id: 'a', strategy_id: 'b' }, /必须且只能给一个/],
    ['get_evolution', { role: 'Bad-Role' }, /role/],
    ['get_evolution', { days: 91 }, /days/],
    ['get_universe_scan', { limit: 0 }, /limit/],
  ] as const)('%s %j → 抛 invalid_args', async (name, args, re) => {
    await expect(t()[name](args)).rejects.toThrow(re);
    await expect(t()[name](args)).rejects.toThrow(/^invalid_args:/);
  });
  it('字符串数字可接受,缺省参数可省', async () => {
    const r = (await t().list_candidates({ limit: '3' })) as { rows: unknown[] };
    expect(r.rows).toHaveLength(3);
    await expect(t().get_universe_scan(undefined)).resolves.toMatchObject({ ready: true });
  });
});

describe('只读', () => {
  const calls: [(typeof READONLY_CHAT_TOOLS)[number], unknown][] = [
    ['get_judgment_ledger', {}],
    ['get_judgment_ledger', { dim: 'holding_reason' }],
    ['list_candidates', { limit: 5 }],
    ['list_my_strategies', {}],
    ['get_backtest_report', { strategy_id: '' as string }],
    ['get_evolution', { role: 'radar' }],
    ['get_universe_scan', {}],
  ];
  it('在可写连接上跑全部工具:total_changes 与各表行数不变', async () => {
    const tools = readonlyChatTools(state.db, { loadModule: evoStub });
    const before = fingerprint(state.db);
    const tc0 = (state.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    for (const [n, a] of calls) await tools[n](n === 'get_backtest_report' ? { strategy_id: strategyId } : a);
    expect((state.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(tc0);
    expect(fingerprint(state.db)).toBe(before);
  });
  it('在 SQLite readOnly 连接上全部跑通(任何写都会抛)', async () => {
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tools = readonlyChatTools(ro, { loadModule: evoStub });
      for (const [n, a] of calls) {
        const r = (await tools[n](n === 'get_backtest_report' ? { strategy_id: strategyId } : a)) as { ready: boolean };
        expect(r.ready, n).toBe(true);
      }
      expect(() => ro.exec("UPDATE demo_screen SET status = 'x'")).toThrow(/readonly/i);
    } finally {
      ro.close();
    }
  });
  it('不给库:按 TG_DEMO_DB 开 readOnly 连接', async () => {
    const prev = process.env['TG_DEMO_DB'];
    process.env['TG_DEMO_DB'] = dbPath;
    try {
      const r = (await readonlyChatTools(null, { loadModule: noModules }).list_my_strategies({})) as { ready: boolean; strategies: unknown[] };
      expect(r.ready).toBe(true);
      expect(r.strategies).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env['TG_DEMO_DB'];
      else process.env['TG_DEMO_DB'] = prev;
    }
  });
  it('表还没建 → ready=false(带深链),不抛', async () => {
    const empty = new DatabaseSync(':memory:');
    const tools = readonlyChatTools(empty, { loadModule: noModules });
    for (const n of READONLY_CHAT_TOOLS) {
      const r = (await tools[n](n === 'get_backtest_report' ? { id: 'x' } : {})) as { ready: boolean; links: unknown[] };
      expect(r.ready, n).toBe(false);
      expect(r.links.length, n).toBeGreaterThan(0);
    }
    empty.close();
  });
});

describe('返回形状与深链', () => {
  const tools = () => readonlyChatTools(state.db, { loadModule: evoStub });

  it('get_judgment_ledger:分层、样本量、regret_hold / regret_exit 中心统计', async () => {
    const r = (await tools().get_judgment_ledger({})) as Record<string, any>;
    expect(r.links).toEqual([DEEP_LINKS.judgments]);
    expect(r.version).toBe('jl-v2');
    expect(r.n).toBe(40);
    expect(Object.keys(r.strata)).toEqual(['strategy', 'trigger_kind', 'prompt_version']);
    expect(r.strata.strategy.map((s: any) => s.value).sort()).toEqual(['breakout_retest', 'trend_pullback']);
    const o = r.overall;
    expect(o.alpha_n).toBe(40);
    expect(o.observe_only).toBe(false);
    expect(o.regret_hold).toMatchObject({ n: 20, observe_only: true });
    expect(o.regret_exit.n).toBe(20);
    expect(o.regret_exit.median).not.toBeNull();
    expect(o.regret_exit).toHaveProperty('trimmed_mean');
    const small = r.strata.strategy.find((s: any) => s.value === 'breakout_retest');
    expect(small.observe_only).toBe(small.alpha_n < OBSERVE_MIN_SAMPLE);
    expect(r.sample_rule).toContain('30');
    const one = (await tools().get_judgment_ledger({ dim: 'holding_reason' })) as Record<string, any>;
    expect(Object.keys(one.strata)).toEqual(['holding_reason']);
    expect(one.decisions.length).toBeGreaterThan(0);
    expect(JSON.stringify(r).length).toBeLessThan(4000);
  });

  it('list_candidates:汇总 + 中位数口径 + 行', async () => {
    const r = (await tools().list_candidates({ limit: 5 })) as Record<string, any>;
    expect(r.links.map((l: any) => l.href)).toEqual(['#judgments', '#my-strategies']);
    expect(r.summary).toMatchObject({ n: 12, scoreable: 8, observe_only: true });
    expect(r.plan_r).toMatchObject({ n: 8, median: -0.5, tail_driven: 'up' });
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0]).toMatchObject({ symbol: 'BTCUSDT', strategy: 'synth:donchian_close_long_v1:1h@1', model: 'pending' });
    expect(r.more).toBe(true);
    const eth = (await tools().list_candidates({ symbol: 'ethusdt' })) as Record<string, any>;
    expect(eth.rows.every((x: any) => x.symbol === 'ETHUSDT')).toBe(true);
  });

  it('list_my_strategies:策略对象 + 最新回测摘要 + 深链', async () => {
    const r = (await tools().list_my_strategies({})) as Record<string, any>;
    expect(r.links.map((l: any) => l.href)).toEqual(['#my-strategies', '#research']);
    expect(r.counts.all).toBe(1);
    const s = r.strategies[0];
    expect(s).toMatchObject({ id: strategyId, name: '顺势突破' });
    expect(s.last_backtest).toMatchObject({ report_id: reportId, trades: 12, observe_only: true });
    expect(s.links.map((l: any) => l.href)).toEqual([`#my-strategies?id=${encodeURIComponent(strategyId)}`, `#backtest?id=${reportId}`]);
    const none = (await tools().list_my_strategies({ q: '不存在的' })) as Record<string, any>;
    expect(none.strategies).toEqual([]);
  });

  it('get_backtest_report:按 id 与按 strategy_id 都能取;收益/回撤/笔数/持有/中位数', async () => {
    const byId = (await tools().get_backtest_report({ id: reportId })) as Record<string, any>;
    const bySid = (await tools().get_backtest_report({ strategy_id: strategyId })) as Record<string, any>;
    expect(bySid.id).toBe(reportId);
    expect(byId.found).toBe(true);
    expect(byId.links[0]).toEqual({ label: '回测报告', href: `#backtest?id=${reportId}` });
    expect(byId.links.map((l: any) => l.href)).toContain(`#my-strategies?id=${encodeURIComponent(strategyId)}`);
    expect(byId.metrics).toMatchObject({ total_return: 0.08, max_drawdown: 0.04, trades: 12, avg_holding_h: 2, observe_only: true });
    expect(byId.trade_return).toMatchObject({ n: 12, median: -0.01, tail_driven: 'up', observe_only: true });
    expect(byId.other_assets[0]).toMatchObject({ key: 'ETHUSDT' });
    const miss = (await tools().get_backtest_report({ id: 'nope' })) as Record<string, any>;
    expect(miss).toMatchObject({ ready: true, found: false });
    const missS = (await tools().get_backtest_report({ strategy_id: 'nope' })) as Record<string, any>;
    expect(missS.found).toBe(false);
  });

  it('get_evolution:模块存在 → 方格摘要与角色深链;缺模块 → ready=false', async () => {
    const all = (await tools().get_evolution({ days: 7 })) as Record<string, any>;
    expect(all.ready).toBe(true);
    expect(all.links).toEqual([DEEP_LINKS.evolution]);
    expect(all.roles[0]).toMatchObject({ role: 'thread_manager', cells: 'G-', link: '#evolution?role=thread_manager' });
    expect(all.roles[0].latest.status).toBe('good');
    expect(all.today.judgments).toMatchObject({ used: 3, cap: 300 });
    const one = (await tools().get_evolution({ role: 'radar' })) as Record<string, any>;
    expect(one.roles).toHaveLength(1);
    expect(one.links[0].href).toBe('#evolution?role=radar');
    await expect(tools().get_evolution({ role: 'nobody' })).rejects.toThrow(/没有这个角色/);
    const nr = (await readonlyChatTools(state.db, { loadModule: noModules }).get_evolution({ role: 'radar' })) as Record<string, any>;
    expect(nr).toMatchObject({ ready: false, links: [{ href: '#evolution?role=radar' }] });
    const broken = (await readonlyChatTools(state.db, { loadModule: async () => ({ evolutionDaily: 'not a fn' }) }).get_evolution({})) as Record<string, any>;
    expect(broken.ready).toBe(false);
  });

  it('get_evolution:默认加载器能探测到真实 evolution 模块(存在则 ready,不存在则未就绪)', async () => {
    const r = (await readonlyChatTools(state.db).get_evolution({ days: 3 })) as Record<string, any>;
    expect(typeof r.ready).toBe('boolean');
    expect(r.links[0].href).toBe('#evolution');
    if (r.ready) expect(Array.isArray(r.roles)).toBe(true);
    else expect(r.reason).toMatch(/进化模块/);
  });

  it('get_universe_scan:读 universe=okx_all 的最新一行;模块提供读函数时优先用它', async () => {
    const r = (await tools().get_universe_scan({ limit: 5 })) as Record<string, any>;
    expect(r.links).toEqual([DEEP_LINKS.screener]);
    expect(r.source).toBe('demo_screen');
    expect(r.scan).toMatchObject({ id: 'scr-okx', scanned: 3, errors: 0 });
    expect(r.candidates).toEqual([
      { rank: 1, symbol: 'SOLUSDT', strategy_id: 'breakout_retest', fit_score: 0.91, reasons: ['放量突破', '趋势向上'] },
      { rank: 2, symbol: 'DOGEUSDT', strategy_id: 'breakout_retest', fit_score: 0.7, reasons: [] },
    ]);
    const viaMod = (await readonlyChatTools(state.db, { loadModule: async (n) => (n === 'universe-okx' ? { latestUniverseScan: () => ({ scanned: 300 }) } : null) }).get_universe_scan({})) as Record<string, any>;
    expect(viaMod).toMatchObject({ ready: true, source: 'universe-okx', scan: { scanned: 300 } });
    const fresh = openStateDb(':memory:');
    const nr = (await readonlyChatTools(fresh.db, { loadModule: noModules }).get_universe_scan({})) as Record<string, any>;
    expect(nr).toMatchObject({ ready: false, links: [{ href: '#screener' }] });
    fresh.close();
  });
});
