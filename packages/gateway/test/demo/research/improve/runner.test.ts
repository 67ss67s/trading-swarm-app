import { describe, expect, it } from 'vitest';
import { validate } from '@trade-gate/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../../../src/demo/research/strategies/service.js';
import type { ResearchService } from '../../../../src/demo/research/service.js';
import { ImproveStore } from '../../../../src/demo/research/improve/store.js';
import { runImprovement, type ImproveEvent } from '../../../../src/demo/research/improve/runner.js';
import { freezeData } from '../../../../src/demo/research/improve/data.js';
import { EvalEnv, evaluateTrain } from '../../../../src/demo/research/improve/evaluate.js';
import { randomEntryBaseline } from '../../../../src/demo/research/improve/random-entry.js';
import { hash } from '../../../../src/demo/research/primitives.js';
import { jobDetail } from '../../../../src/demo/research/improve/routes.js';
import { emaIR, loaderOf, specOf, universeBars, H4, START, SYMS, LOOSE } from './fixtures.js';

const data = universeBars(2100);
describe('改进环 runner(合成数据,零模型)', () => {
  it('跑满 2 代:谱系、排行榜、冠军只跑一次留出段、账本(试验数/Deflated Sharpe/随机入场)、冠军写成策略新版本且状态不动', async () => {
    const db = openStateDb(':memory:'), jobs = new ImproveStore(db.db);
    const strategies = new StrategyService(new StrategyStore(db.db), new ResearchStore(db.db), null as unknown as ResearchService);
    // 这条用例验证 promote-only 路径(关掉多步搜索,与第一阶段语义相同);多步搜索见下一条。
    // 起点 20/50:诊断 v2(63b93a8)与结构口径止盈止损(e515443)之后,这份合成数据上是它在第 2 代 promote(原先 3/8 那条不再改得动)
    const s = strategies.create({ name: '20/50 EMA', strategy_ir: emaIR(20, 50), timeframe: '4h' });
    const job = jobs.createJob(specOf({ strategy_ir: emaIR(20, 50), strategy_id: s.id, strategy_version: 1, write_version: true, budget: { ...specOf().budget, allow_explore: false } }));
    const events: ImproveEvent[] = [];
    const out = await runImprovement({ db: db.db, loader: loaderOf(data), emit: (e) => events.push(e) }, job.id);
    expect(out.status, out.error ?? '').toBe('completed');
    expect(out.progress!.generations).toHaveLength(2);
    const cs = jobs.candidates(job.id), evaluated = cs.filter((c) => c.evaluation);
    expect(cs[0]).toMatchObject({ id: 'g0_base', generator: 'baseline', parent_id: null });
    expect(cs.filter((c) => c.generation === 1).length).toBeGreaterThan(0);
    expect(cs.filter((c) => c.generation >= 1).every((c) => c.parent_id !== null && c.diff.length > 0 && c.rationale.length > 0)).toBe(true);
    expect(new Set(cs.map((c) => c.ir_hash)).size).toBe(cs.length);// 同任务不重复试同一个 IR
    // 留出段:只有冠军有,且任务已占用
    const champ = cs.find((c) => c.status === 'champion')!;
    expect(champ.id).toBe(out.result!.champion_id);
    expect(evaluated.filter((c) => c.evaluation!.holdout)).toHaveLength(1);
    expect(champ.evaluation!.holdout).toMatchObject({ segment: 'holdout' });
    expect(out.holdout_used_at).not.toBeNull();
    expect(() => jobs.claimHoldout(job.id)).toThrow('improve_holdout_already_used');
    // 这份合成数据上(确定性)第 2 代的候选在验证段优于基线,成为冠军
    expect(out.result!.champion_is_baseline).toBe(false);
    expect(champ.generation).toBe(2);
    expect(champ.evaluation!.validation!.sharpe!).toBeGreaterThan(out.result!.baseline_validation!.sharpe ?? -Infinity);
    // 账本
    const ledger = out.ledger!;
    expect(ledger.trials).toBe(evaluated.length);
    expect(ledger.pbo).toBeNull();
    expect(ledger.deflated_sharpe === null || (ledger.deflated_sharpe >= 0 && ledger.deflated_sharpe <= 1)).toBe(true);
    expect(ledger.random_entry!.returns).toHaveLength(3);
    // 策略版本:冠军不是基线才写,状态不推进
    const detail = strategies.detail(s.id);
    expect(out.result!.strategy_version_written).toBe(2);
    expect(detail.versions.find((v) => v.version === 2)!.note).toContain(job.id);
    expect(detail.strategy.status).toBe('draft');
    // 事件与契约
    expect(events.at(-1)).toMatchObject({ phase: 'done', status: 'completed' });
    for (const e of events) expect(validate('research-improve', e)).toEqual({ ok: true });
    const view = jobDetail(out, cs);
    expect(validate('research-improve', JSON.parse(JSON.stringify(view)))).toEqual({ ok: true });
    expect(view.leaderboard[0]!.objective).not.toBeNull();
    db.close();
  }, 180000);
  it('多步搜索:门槛全不过时 explore 父策略继续往下搜,谱系标 explore_parent,冠军仍是基线;关掉后按 patience 停', async () => {
    const strict = { ...LOOSE, min_trades_total: 1e6 };// 任何候选都过不了门槛 → 不可能 promote
    const run = async (allow_explore: boolean) => {
      const db = openStateDb(':memory:'), jobs = new ImproveStore(db.db);
      const job = jobs.createJob(specOf({ objective: strict, budget: { ...specOf().budget, generations: 3, patience: 1, allow_explore } }));
      const out = await runImprovement({ db: db.db, loader: loaderOf(data) }, job.id);
      const cs = jobs.candidates(job.id); db.close();
      return { out, cs };
    };
    const on = await run(true), off = await run(false);
    expect(on.out.status, on.out.error ?? '').toBe('completed');
    const gens = on.out.progress!.generations;
    const explored = gens.filter((g) => g.mode === 'explore');
    expect(explored.length).toBeGreaterThan(0);
    for (const g of explored) {
      const p = on.cs.find((c) => c.status === 'explore_parent' && c.generation === g.generation)!;
      expect(p).toBeTruthy();
      expect(p.evaluation!.passed).toBe(false);
      expect(p.evaluation!.validation ?? null).toBeNull();// explore 不偷看验证段
      expect(p.evaluation!.objective!).toBeGreaterThan(on.cs.find((c) => c.id === g.parent_id)!.evaluation!.objective!);
      expect(g.champion_id).toBe('g0_base');
    }
    // 下一代从 explore 父策略出发
    const e1 = explored[0]!, next = gens.find((g) => g.generation === e1.generation + 1);
    if (next) expect(next.parent_id).toBe(on.cs.find((c) => c.status === 'explore_parent' && c.generation === e1.generation)!.id);
    expect(on.out.result!.champion_is_baseline).toBe(true);
    expect(on.cs.find((c) => c.status === 'champion')!.id).toBe('g0_base');
    expect(on.out.ledger!.trials).toBe(on.cs.filter((c) => c.evaluation).length);
    expect(on.out.ledger!.notes.join(' ')).toContain('多步搜索');
    // 关掉:第一代没 promote 就按 patience=1 停,没有 explore 父策略
    expect(off.out.progress!.generations).toHaveLength(1);
    expect(off.cs.some((c) => c.status === 'explore_parent')).toBe(false);
    expect(off.out.progress!.generations[0]!.mode).toBeNull();
    expect(on.out.progress!.generations.length).toBeGreaterThan(1);
  }, 240000);
  it('随机入场基线:同种子逐位可复现,换种子不同;入场笔数与冠军同量级', async () => {
    const db = openStateDb(':memory:'), store = new ResearchStore(db.db);
    const f = await freezeData(store, { universe: SYMS, timeframe: '4h', from_ms: START + 300 * H4, to_ms: START + 1500 * H4 }, { loader: loaderOf(universeBars(1500)) });
    const env = new EvalEnv(f.data), ir = emaIR(), key = hash(ir), t = await evaluateTrain(env, ir, key, LOOSE);
    const a = await randomEntryBaseline(env, ir, key, f.data.segments.train, t.train, { runs: 4, seed: 99 });
    const b = await randomEntryBaseline(new EvalEnv(f.data), ir, key, f.data.segments.train, t.train, { runs: 4, seed: 99 });
    const c = await randomEntryBaseline(env, ir, key, f.data.segments.train, t.train, { runs: 4, seed: 100 });
    expect(a!.ledger.returns).toEqual(b!.ledger.returns);
    expect(a!.ledger.trades).toEqual(b!.ledger.trades);
    expect(c!.ledger.returns).not.toEqual(a!.ledger.returns);
    const mean = a!.ledger.trades.reduce((x, y) => x + y, 0) / 4;
    expect(mean).toBeGreaterThan(t.train.trades * 0.3); expect(mean).toBeLessThan(t.train.trades * 3);
    expect(a!.ledger.champion_percentile).toBeGreaterThanOrEqual(0);
    db.close();
  }, 120000);
  it('进程内取消:中途 abort → cancelled,不跑留出段', async () => {
    const db = openStateDb(':memory:'), jobs = new ImproveStore(db.db), job = jobs.createJob(specOf()), ac = new AbortController();
    const out = await runImprovement({ db: db.db, loader: loaderOf(data), signal: ac.signal, emit: (e) => { if (e.phase === 'baseline') ac.abort(); } }, job.id);
    expect(out.status).toBe('cancelled');
    expect(out.holdout_used_at).toBeNull();
    db.close();
  }, 60000);
});
