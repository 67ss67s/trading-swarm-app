import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  BASELINE_MIN_DAYS, CAPTAIN, EVO_ROLES, TM, classify, baselineOf, evolutionDaily, evolutionDay, isIdleCall, parseCostCny, resolveRange,
  type EpisodeRow,
} from '../../src/demo/evolution.js';
import { registerEvolutionRoutes } from '../../src/demo/routes-evolution.js';
import type { RouteContext, RouteHandler } from '../../src/demo/http-extra.js';

const DAY = 86_400_000;
const T = (date: string, h = 12): number => Date.parse(`${date}T${String(h).padStart(2, '0')}:00:00.000Z`);
const NOW = T('2026-09-23', 23);

function schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE demo_episodes (id TEXT PRIMARY KEY, at INTEGER NOT NULL, status TEXT NOT NULL, action TEXT, json TEXT NOT NULL);
    CREATE TABLE demo_judgment_ledger (episode_id TEXT PRIMARY KEY, at INTEGER NOT NULL, as_of INTEGER NOT NULL, symbol TEXT NOT NULL, timeframe TEXT, mode TEXT NOT NULL,
      thread_id TEXT, strategy_id TEXT, model_action TEXT, model_dir TEXT, council_dir TEXT, council_agree INTEGER, mechanical_dir TEXT, mechanical_note TEXT,
      horizon_end_at INTEGER NOT NULL, outcome_r_model REAL, outcome_r_council REAL, outcome_r_mechanical REAL, outcome_source_model TEXT, regret_review REAL,
      settled_at INTEGER, settle_note TEXT, json TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'online');
    CREATE TABLE demo_equity (at INTEGER PRIMARY KEY, equity REAL NOT NULL, unrealized REAL NOT NULL, backend TEXT NOT NULL DEFAULT 'paper');
    CREATE TABLE demo_market_states (id TEXT PRIMARY KEY, as_of INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE demo_risk_alert (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL,
      detail TEXT NOT NULL, value REAL, threshold REAL, refs_json TEXT NOT NULL, auto_action TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      observed_count INTEGER NOT NULL, resolved_at INTEGER, acked_at INTEGER);
    CREATE TABLE demo_screen (id TEXT PRIMARY KEY, horizon TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, universe TEXT NOT NULL,
      symbols_json TEXT NOT NULL, errors_json TEXT NOT NULL, run_id TEXT, handoff_id TEXT, proposal_json TEXT, brain_json TEXT, cost_cny REAL NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE demo_watch_candidate (screen_id TEXT NOT NULL, horizon TEXT NOT NULL, symbol TEXT NOT NULL, strategy_id TEXT NOT NULL, fit_score REAL NOT NULL, rank INTEGER NOT NULL,
      reasons_json TEXT NOT NULL, card_json TEXT NOT NULL, ttl_at INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (screen_id, symbol, strategy_id));
    CREATE TABLE research_inquiries (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, task_kind TEXT NOT NULL, status TEXT NOT NULL, question TEXT NOT NULL);
    CREATE TABLE research_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE research_backtests (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, strategy_id TEXT);
    CREATE TABLE improve_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, strategy_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE improve_candidates (job_id TEXT NOT NULL, id TEXT NOT NULL, generator TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, rationale TEXT NOT NULL, PRIMARY KEY(job_id,id));
    CREATE TABLE research_strategy_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, version INTEGER, note TEXT NOT NULL DEFAULT '');
    CREATE TABLE demo_strategy_event (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, who TEXT NOT NULL, kind TEXT NOT NULL,
      from_status TEXT, to_status TEXT, reason TEXT NOT NULL, evidence_json TEXT NOT NULL);
    CREATE TABLE demo_lab_probe_queue (id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, param TEXT NOT NULL, value REAL NOT NULL, source TEXT NOT NULL, source_ref TEXT, queued_at INTEGER NOT NULL,
      status TEXT NOT NULL, checked_at INTEGER, note TEXT);
    CREATE TABLE demo_bot_run (id TEXT PRIMARY KEY, role TEXT NOT NULL, routine TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, budget_json TEXT NOT NULL,
      cost_cny REAL NOT NULL DEFAULT 0, summary TEXT, error TEXT, input_json TEXT, result_json TEXT);
    CREATE TABLE demo_memory (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, symbol TEXT, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER,
      expires_at INTEGER, json TEXT NOT NULL);
    CREATE TABLE demo_memory_events (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT);
    CREATE TABLE lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, status TEXT, json TEXT);
    CREATE TABLE demo_intents (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE okx_market_delivery_in (delivery_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, received_at INTEGER NOT NULL, raw TEXT NOT NULL, parse_status TEXT NOT NULL, signal_id TEXT,
      signal_json TEXT, errors_json TEXT NOT NULL, signal_type TEXT, session TEXT);
    CREATE TABLE okx_market_delivery_out_job (event_id TEXT NOT NULL, job_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, result_json TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY(event_id, job_id));
    CREATE TABLE demo_strategy_candidate (id TEXT PRIMARY KEY, at INTEGER NOT NULL, settled_at INTEGER);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL);
  `);
}
function freshDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); schema(db); return db; }

let seq = 0;
interface EpOpts { symbol?: string; action?: string | null; status?: string; node?: string; model?: boolean; voting?: number | null; allowed?: string[]; error?: string; prompt?: string; cost?: string }
function episode(db: DatabaseSync, at: number, o: EpOpts = {}): string {
  const id = `ep-${++seq}`;
  const json: Record<string, unknown> = {
    id, at, symbol: o.symbol ?? 'BTCUSDT', thread_id: o.node?.startsWith('review') ? 'thr-1' : null, prompt_version: o.prompt ?? 'pv-1',
    trigger: { kind: 'event' }, graph: o.node === undefined ? { node: 'scan' } : { node: o.node },
    usage: o.model === false ? null : { cost_estimate: o.cost ?? '≈¥0.020' },
    error: o.error ?? null, judgment: o.action ? { action: o.action, headline: 'h' } : null,
  };
  if (o.voting !== null) json['strategy_council'] = { consensus: { voting: Array.from({ length: o.voting ?? 0 }, (_, i) => `s${i}`), gate_reason: '共识闸当前无效:没有策略能投票(全部弃权)' }, verdicts: [{ strategy_id: 'breakout_retest', stance: 'abstain', reasons: ['本次触发器没有唤醒这条策略'] }] };
  if (o.allowed) json['holding_review'] = { allowed_actions: o.allowed };
  db.prepare('INSERT INTO demo_episodes(id, at, status, action, json) VALUES (?,?,?,?,?)').run(id, at, o.status ?? 'done', o.action === undefined ? 'NO_TRADE' : o.action, JSON.stringify(json));
  return id;
}
function ledger(db: DatabaseSync, at: number, model: number | null, mech: number | null, o: { symbol?: string; cluster?: string; settled?: boolean; dir?: string | null; mark?: number } = {}): void {
  const id = `ep-l${++seq}`;
  db.prepare(`INSERT INTO demo_judgment_ledger(episode_id, at, as_of, symbol, mode, model_action, model_dir, horizon_end_at, outcome_r_model, outcome_r_mechanical, settled_at, json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, at, at, o.symbol ?? 'BTCUSDT', 'scan', 'NO_TRADE', o.dir ?? null, at + DAY, model, mech, o.settled === false ? null : at + 3600_000,
    JSON.stringify({ cluster_id: o.cluster ?? id, source: 'online', mark: o.mark ?? null }));
}
const tmDays = (d: ReturnType<typeof evolutionDaily>, role = 'thread_manager') => d.roles.find((r) => r.role === role)!.days;

describe('evolution 纯函数', () => {
  it('parseCostCny 解析估算花费', () => {
    expect(parseCostCny('≈¥0.022')).toBe(0.022);
    expect(parseCostCny(null)).toBe(0);
  });

  it('classify:基线不足只按绝对线;基线足够按带宽;绝对坏线优先', () => {
    const spec = { higher_is_better: true, band: 0.15 };
    const thin = baselineOf([0.5, 0.5, null]);
    expect(thin.days).toBe(2);
    expect(thin.note).toContain('基线不足');
    expect(classify(spec, { score: 0.05, active: true, abs: null }, thin)).toBe('ok');
    expect(classify(spec, { score: 0.2, active: true, abs: 'good' }, thin)).toBe('good');
    const full = baselineOf([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(full.days).toBeGreaterThanOrEqual(BASELINE_MIN_DAYS);
    expect(full.note).toBeNull();
    // 明显差于基线:即使达到绝对好线也判 bad
    expect(classify(spec, { score: 0.2, active: true, abs: 'good' }, full)).toBe('bad');
    expect(classify(spec, { score: 0.8, active: true, abs: null }, full)).toBe('good');
    expect(classify(spec, { score: 0.45, active: true, abs: null }, full)).toBe('ok');
    expect(classify(spec, { score: 0.9, active: true, abs: 'bad' }, full)).toBe('bad');
    // 越低越好的角色,方向反过来
    expect(classify({ higher_is_better: false, band: 0.1 }, { score: 0.2, active: true, abs: null }, full)).toBe('good');
    // 没有记录 / 没有可结算结果
    expect(classify(spec, { score: null, active: false, abs: null }, full)).toBe('none');
    expect(classify(spec, { score: null, active: true, abs: null }, full)).toBe('none');
    expect(classify(spec, { score: null, active: true, abs: null, idle_status: 'ok' }, full)).toBe('ok');
    expect(classify(spec, { score: null, active: true, abs: 'bad' }, full)).toBe('bad');
  });

  it('isIdleCall:票池为空的扫描 / 只许 HOLD 的复查 / 没调模型不算', () => {
    const base: EpisodeRow = { id: 'x', at: 0, status: 'done', action: 'NO_TRADE', symbol: 'BTCUSDT', node: 'scan', thread_id: null, trigger_kind: 'event', prompt_version: null, cost: null, model_called: 1, allowed: null, voting: 0, gate_reason: null, error: null, headline: null };
    expect(isIdleCall(base)).toBe(true);
    expect(isIdleCall({ ...base, voting: 2 })).toBe(false);
    expect(isIdleCall({ ...base, model_called: 0 })).toBe(false);
    expect(isIdleCall({ ...base, node: 'review:in_position', allowed: '["HOLD"]' })).toBe(true);
    expect(isIdleCall({ ...base, node: 'review:in_position', allowed: '["HOLD","EXIT"]' })).toBe(false);
  });

  it('resolveRange 缺省 90 天,拒绝倒序和超长', () => {
    expect(resolveRange(null, '2026-09-23', NOW)).toEqual({ from: '2026-06-26', to: '2026-09-23' });
    expect(() => resolveRange('2026-09-24', '2026-09-23', NOW)).toThrow('invalid_range');
    expect(() => resolveRange('2025-01-01', '2026-09-23', NOW)).toThrow('range_too_long');
    expect(() => resolveRange('2026-9-1', '2026-09-23', NOW)).toThrow('invalid_date');
  });
});

describe('evolution 各角色分档(临时库)', () => {
  it('thread_manager:模型胜机械→good,输→bad,可比对不足→none;prompt 版本变化记进化事件', () => {
    const db = freshDb();
    for (let i = 0; i < 4; i++) ledger(db, T('2026-09-21') + i, 0, -0.5); // 模型 0 vs 机械 −0.5 → +0.5R
    for (let i = 0; i < 4; i++) ledger(db, T('2026-09-22') + i, 0, 0.6); // −0.6R
    ledger(db, T('2026-09-23'), 0, null); // 机械算不出
    ledger(db, T('2026-09-23', 13), 0, 0.1, { settled: false });
    episode(db, T('2026-09-22'), { prompt: 'pv-2' });
    episode(db, T('2026-09-21'), { prompt: 'pv-1' });
    const d = evolutionDaily(db, { from: '2026-09-20', to: '2026-09-23', now: NOW });
    const days = tmDays(d);
    expect(days.map((x) => x.status)).toEqual(['none', 'good', 'bad', 'none']);
    expect(days[1]!.score).toBe(0.5);
    expect(days[1]!.headline).toContain('模型 +0.00R vs 机械 −0.50R');
    expect(days[3]!.headline).toContain(`< ${TM.MIN_PAIRED}`);
    expect(days[2]!.events).toBe(1); // pv-2 当天首次出现
    const s = d.roles.find((r) => r.role === 'thread_manager')!.summary;
    expect(s).toEqual({ good: 1, ok: 0, bad: 1, none: 2, baseline_days: 2 });
  });

  it('thread_manager:基线够 5 天后按带宽判,同一簇多行先平均', () => {
    const db = freshDb();
    for (let k = 0; k < 6; k++) { const day = `2026-09-${String(10 + k).padStart(2, '0')}`; for (let i = 0; i < 3; i++) ledger(db, T(day) + i, 0.3, 0); }
    // 当天 0.12R:过了绝对好线,但比基线 0.3R 低 0.18R(> 0.15 带宽)→ bad
    ledger(db, T('2026-09-16'), 0.12, 0, { cluster: 'c1' });
    ledger(db, T('2026-09-16') + 1, 0.12, 0, { cluster: 'c1' });
    ledger(db, T('2026-09-16') + 2, 0.12, 0, { cluster: 'c2' });
    const day = evolutionDay(db, { role: 'thread_manager', date: '2026-09-16', now: NOW });
    expect(day.baseline.days).toBe(6);
    expect(day.baseline.mean).toBe(0.3);
    expect(day.baseline.note).toBeNull();
    expect(day.score).toBe(0.12);
    expect(day.status).toBe('bad');
  });

  it('gate_captain:空转比例 + today 块(额度、花费、票池原因、影子候选)', () => {
    const db = freshDb();
    const today = new Date(NOW); today.setHours(0, 0, 0, 0);
    const t0 = Math.max(today.getTime(), T('2026-09-23', 0)) + 60_000;
    episode(db, t0, { voting: 0 });
    episode(db, t0 + 1, { voting: 0 });
    episode(db, t0 + 2, { node: 'review:in_position', allowed: ['HOLD'], voting: null, action: 'HOLD' });
    episode(db, t0 + 3, { voting: 2, cost: '≈¥0.040' });
    episode(db, t0 + 4, { model: false, status: 'failed', action: null, voting: null });
    db.prepare("INSERT INTO kv(key, value, updated_at) VALUES ('demo.workflow', ?, 0)").run(JSON.stringify({ daily_judgment_cap: 300, active_strategies: ['breakout_retest'] }));
    db.prepare('INSERT INTO demo_equity(at, equity, unrealized, backend) VALUES (?,?,?,?)').run(NOW - 1000, 105449.561, 0, 'okx');
    db.prepare('INSERT INTO demo_strategy_candidate(id, at, settled_at) VALUES (?,?,?), (?,?,?)').run('c1', t0, null, 'c2', t0 - 10 * DAY, t0 - 9 * DAY);
    const d = evolutionDaily(db, { from: '2026-09-23', to: '2026-09-23', now: NOW });
    const cell = tmDays(d, 'gate_captain')[0]!;
    expect(cell.score).toBe(0.75); // 4 次调用,3 次空转
    expect(cell.status).toBe('ok'); // 30% < 75% < 80%
    expect(d.today).not.toBeNull();
    const t = d.today!;
    expect(t.equity).toBe('105449.56');
    expect(t.judgments.used).toBe(5);
    expect(t.judgments.cap).toBe(300);
    expect(t.judgments.cost_cny).toBe(0.1);
    expect(t.judgments.idle_share).toBe(0.75);
    expect(t.live_pool.size).toBe(2); // 最近一次扫描 voting=2
    expect(t.candidates).toEqual({ open: 1, settled: 1, today_new: 1 });
    // 全部空转 → bad
    const db2 = freshDb();
    for (let i = 0; i < 5; i++) episode(db2, T('2026-09-22') + i, { voting: 0 });
    const d2 = evolutionDaily(db2, { from: '2026-09-22', to: '2026-09-22', now: NOW });
    expect(tmDays(d2, 'gate_captain')[0]!.status).toBe('bad');
    expect(d2.today!.live_pool.size).toBe(0);
    expect(d2.today!.live_pool.reason).toContain('breakout_retest 弃权');
    expect(CAPTAIN.BAD_IDLE).toBe(0.8);
  });

  it('radar:头部候选在有效期内被 WATCH/PROPOSE 的比例;全部失败 → bad', () => {
    const db = freshDb();
    const s = T('2026-09-22', 8);
    db.prepare("INSERT INTO demo_screen(id, horizon, started_at, status, universe, symbols_json, errors_json) VALUES ('s1','short',?, 'done','w','[\"A\",\"B\"]','[]')").run(s);
    for (const [sym, rank] of [['AUSDT', 1], ['BUSDT', 2]] as const) db.prepare("INSERT INTO demo_watch_candidate VALUES ('s1','short',?, 'x', 0.9, ?, '[]', '{}', ?, ?)").run(sym, rank, s + 12 * 3600_000, s + 1000);
    episode(db, s + 3600_000, { symbol: 'AUSDT', action: 'WATCH' });
    episode(db, s + 20 * 3600_000, { symbol: 'BUSDT', action: 'PROPOSE' }); // 过了 ttl,不算
    db.prepare("INSERT INTO demo_screen(id, horizon, started_at, status, universe, symbols_json, errors_json) VALUES ('s2','short',?, 'done','w','[\"A\",\"B\"]','[{},{}]')").run(T('2026-09-23', 8));
    const d = evolutionDaily(db, { from: '2026-09-21', to: '2026-09-23', now: NOW });
    const days = tmDays(d, 'radar');
    expect(days[0]!.status).toBe('none');
    expect(days[1]!.score).toBe(0.5);
    expect(days[1]!.status).toBe('good');
    expect(days[2]!.status).toBe('bad');
  });

  it('strategy_lab:过门槛候选/晋升 → good;完成率 < 50% → bad;只有门槛检查 → ok', () => {
    const db = freshDb();
    db.prepare("INSERT INTO research_inquiries VALUES ('i1', ?, 'validate', 'completed', 'q')").run(T('2026-09-21'));
    db.prepare("INSERT INTO improve_candidates VALUES ('j','c1','swap','evaluated',?, 'r'), ('j','c0','baseline','champion',?, 'r')").run(T('2026-09-21'), T('2026-09-21'));
    db.prepare("INSERT INTO research_inquiries VALUES ('i2', ?, 'validate', 'failed', 'q'), ('i3', ?, 'market', 'incomplete', 'q'), ('i4', ?, 'market', 'completed', 'q')").run(T('2026-09-22'), T('2026-09-22'), T('2026-09-22'));
    db.prepare("INSERT INTO research_runs VALUES ('r1', ?, 'failed')").run(T('2026-09-22'));
    db.prepare("INSERT INTO demo_strategy_event(strategy_id, version, at, who, kind, from_status, to_status, reason, evidence_json) VALUES ('b',1,?, 'code','gate_check','backtest','shadow','OOS 不足','{}')").run(T('2026-09-23'));
    db.prepare("INSERT INTO research_strategy_events(strategy_id, at, kind, from_status, to_status) VALUES ('rs1', ?, 'transition', 'backtested', 'paper')").run(T('2026-09-21'));
    const d = evolutionDaily(db, { from: '2026-09-21', to: '2026-09-23', now: NOW });
    const days = tmDays(d, 'strategy_lab');
    expect(days.map((x) => x.status)).toEqual(['good', 'bad', 'ok']);
    expect(days[0]!.events).toBe(2); // 1 个过门槛候选 + 1 次晋升(baseline 不算)
    const detail = evolutionDay(db, { role: 'strategy_lab', date: '2026-09-21', now: NOW });
    expect(detail.events.map((e) => e.kind).sort()).toEqual(['improve_candidate', 'strategy_promoted']);
  });

  it('portfolio_manager:剔除出入金跳变,与 BTC 持有比', () => {
    const db = freshDb();
    const ins = db.prepare("INSERT INTO demo_equity(at, equity, unrealized, backend) VALUES (?,?,0,'okx')");
    ins.run(T('2026-09-21', 23), 100000); ins.run(T('2026-09-22', 1), 150000); /* 入金 */ ins.run(T('2026-09-22', 20), 153000);
    const ms = db.prepare('INSERT INTO demo_market_states(id, as_of, json) VALUES (?,?,?)');
    ms.run('m1', T('2026-09-21', 23), JSON.stringify({ majors: [{ symbol: 'BTCUSDT', last: '100000' }] }));
    ms.run('m2', T('2026-09-22', 20), JSON.stringify({ majors: [{ symbol: 'BTCUSDT', last: '99000' }] }));
    const d = evolutionDaily(db, { from: '2026-09-22', to: '2026-09-22', now: NOW });
    const cell = tmDays(d, 'portfolio_manager')[0]!;
    expect(cell.score).toBeCloseTo(0.03, 6); // +2% vs −1%
    expect(cell.status).toBe('good');
    expect(cell.headline).toContain('出入金');
  });

  it('risk_sentinel / executor / reviewer / asp_agent 分档', () => {
    const db = freshDb();
    const alert = db.prepare("INSERT INTO demo_risk_alert(id, fingerprint, kind, severity, scope, title, detail, refs_json, auto_action, first_seen_at, last_seen_at, observed_count) VALUES (?,?,?,?, 's','t','d','[]',?,?,?,1)");
    alert.run('a1', 'f1', 'account_stale', 'warn', 'none', T('2026-09-21'), T('2026-09-21'));
    alert.run('a2', 'f2', 'x', 'critical', 'block_new_risk', T('2026-09-22'), T('2026-09-22'));
    // executor:9-21 下单成功且无报错 → good;9-22 接口报错 1/2 → bad
    db.prepare("INSERT INTO demo_intents(id, episode_id, at, status, json) VALUES ('i1','',?, 'filled','{}')").run(T('2026-09-21'));
    episode(db, T('2026-09-21'));
    episode(db, T('2026-09-22'), { status: 'failed', action: null, model: false, error: '/api/v5/market/candles 网络错误 ECONNRESET' });
    episode(db, T('2026-09-22') + 1, { status: 'failed', action: null, model: false, error: 'pi timed out after 120000ms' });
    // reviewer:9-21 一条教训已采纳 → good;9-22 批次失败 → bad
    db.prepare("INSERT INTO demo_memory(id, kind, status, content_hash, created_at, json) VALUES ('m1','lesson','active','h',?, '{\"content\":\"x\",\"proposed_by\":\"reviewer\"}')").run(T('2026-09-21'));
    db.prepare("INSERT INTO demo_memory_events(memory_id, at, kind) VALUES ('m1', ?, 'approved')").run(T('2026-09-21', 13));
    db.prepare("INSERT INTO demo_bot_run(id, role, routine, started_at, status, budget_json) VALUES ('b1','reviewer','review_batch',?, 'failed','{}')").run(T('2026-09-22'));
    // asp:9-21 全成功且有投递 → good;9-22 解析失败 1/2 → bad
    db.prepare("INSERT INTO okx_market_delivery_in(delivery_id, job_id, received_at, raw, parse_status, errors_json) VALUES ('d1','j',?, '', 'order','[]'), ('d2','j',?, '', 'order','[]'), ('d3','j',?, '', 'invalid','[]')").run(T('2026-09-21'), T('2026-09-22'), T('2026-09-22') + 1);
    const d = evolutionDaily(db, { from: '2026-09-21', to: '2026-09-23', now: NOW });
    expect(tmDays(d, 'risk_sentinel').map((x) => x.status)).toEqual(['good', 'bad', 'none']);
    expect(tmDays(d, 'executor').map((x) => x.status)).toEqual(['good', 'bad', 'none']);
    expect(tmDays(d, 'reviewer').map((x) => x.status)).toEqual(['good', 'bad', 'none']);
    expect(tmDays(d, 'reviewer')[0]!.events).toBe(2);
    expect(tmDays(d, 'asp_agent').map((x) => x.status)).toEqual(['good', 'bad', 'none']);
    const ex = evolutionDay(db, { role: 'executor', date: '2026-09-22', now: NOW });
    expect(ex.metrics.find((m) => m.key === 'api_errors')!.value).toBe(1); // 模型超时不算交易所报错
    expect(ex.records[0]!.ref).toMatch(/^#judgments\?episode=/);
  });

  it('缺表时该角色给 none,并在 missing_sources 里列出', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE demo_episodes (id TEXT PRIMARY KEY, at INTEGER NOT NULL, status TEXT NOT NULL, action TEXT, json TEXT NOT NULL)');
    const d = evolutionDaily(db, { from: '2026-09-22', to: '2026-09-23', now: NOW });
    expect(d.roles.map((r) => r.role)).toEqual(EVO_ROLES);
    for (const r of d.roles) expect(r.days.every((x) => x.status === 'none')).toBe(true);
    expect(d.missing_sources).toContain('demo_judgment_ledger');
    expect(d.today!.equity).toBeNull();
  });
});

describe('evolution day 明细与路由', () => {
  function fakeCtx(db: DatabaseSync) {
    const routes = new Map<string, RouteHandler>();
    const ctx = {
      route: (m: string, p: string, h: RouteHandler) => routes.set(`${m} ${p}`, h),
      json: (res: { status?: number; body?: unknown }, status: number, body: unknown) => { res.status = status; res.body = body; },
      fail: (res: { status?: number; body?: unknown }, status: number, message: string) => { res.status = status; res.body = { error: message }; },
      rt: { workflow: { daily_judgment_cap: 300, active_strategies: ['breakout_retest'] } },
      store: { marketDb: db },
    } as unknown as RouteContext;
    registerEvolutionRoutes(ctx);
    const call = async (path: string) => {
      const url = new URL(`http://x${path}`);
      const res: { status?: number; body?: unknown } = {};
      await routes.get(`GET ${url.pathname}`)!({} as never, res as never, url, {});
      return res;
    };
    return { routes, call };
  }

  it('GET /api/evolution/daily 与 /day 的形状', async () => {
    const db = freshDb();
    for (let i = 0; i < 60; i++) episode(db, T('2026-09-22') + i * 1000, { symbol: 'ETHUSDT' });
    for (let i = 0; i < 3; i++) ledger(db, T('2026-09-22') + i, 0.2, 0);
    const { routes, call } = fakeCtx(db);
    expect([...routes.keys()].sort()).toEqual(['GET /api/evolution/daily', 'GET /api/evolution/day']);
    const daily = await call('/api/evolution/daily?from=2026-09-20&to=2026-09-23');
    expect(daily.status).toBe(200);
    const body = daily.body as ReturnType<typeof evolutionDaily>;
    expect(body.version).toBe('evolution/v1');
    expect(body.from).toBe('2026-09-20');
    expect(body.roles).toHaveLength(9);
    for (const r of body.roles) {
      expect(r.days).toHaveLength(4);
      expect(Object.keys(r.summary).sort()).toEqual(['bad', 'baseline_days', 'good', 'none', 'ok']);
      expect(typeof r.label).toBe('string');
      expect(typeof r.metric_label).toBe('string');
    }
    expect(Object.keys(body.today!).sort()).toEqual(expect.arrayContaining(['date', 'equity', 'judgments', 'live_pool', 'candidates']));
    expect(body.today!.judgments.cap).toBe(300);

    const day = await call('/api/evolution/day?role=thread_manager&date=2026-09-22');
    expect(day.status).toBe(200);
    const det = day.body as ReturnType<typeof evolutionDay>;
    expect(det.status).toBe('good');
    expect(det.baseline.note).toContain('基线不足');
    expect(det.metrics.find((m) => m.key === 'settled_r_model')!.value).toBe(0.2);
    expect(det.records.length).toBe(50); // 上限 50,倒序
    expect(det.records[0]!.at).toBeGreaterThan(det.records[49]!.at);
    expect(det.records[0]!.ref).toContain('#judgments?episode=');
    expect(Array.isArray(det.events)).toBe(true);

    expect((await call('/api/evolution/day?role=nobody&date=2026-09-22')).status).toBe(400);
    expect((await call('/api/evolution/daily?from=2026-09-24&to=2026-09-23')).status).toBe(400);
  });
});
