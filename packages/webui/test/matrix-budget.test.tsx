/**
 * 09-26 批量验证新建表单:边选边估(防抖)、逐维度黄 / 红与「超了哪个维度」、静态投影「再加这个会超 X」、
 * 一键修正三种(两段式 / 自动拆批 / 减维度)、拆批串行创建带 origin.batch、详情页两段式注释与「未测 Jev」、列表批次标记、英文词条。
 * fakeEstimate 按后端 manifest.ts estimate() 的口径算(每格变体 × 单变体判断数;两段式 = 纯代码变体 + 最坏 K 格),上限 300 / 20000 / $1 / 6 币。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { matrixApi, unwrapMatrixStudyView, type BudgetDim, type MatrixEstimate, type MatrixEstimateCell, type MatrixEstimateResponse, type MatrixSpecLite, type MatrixStudyView, type MatrixTimeframe } from '../src/api/matrix-study';
import {
  budgetDims, createBatches, createDebouncer, currentOver, evenChunks, judgeCallsPerVariant, optionHint, overOf, planFixes, project, type ProjectionBase,
} from '../src/components/matrix-study/budget';
import { DEFAULT_JUDGE_STAGE, MatrixStudyCreate, submitSpec } from '../src/components/matrix-study/create';
import { MatrixStudyBody } from '../src/components/matrix-study/detail';
import { BatchTag } from '../src/components/matrix-study/list';
import { judgeStageNote, mapTone } from '../src/components/matrix-study/explain';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { EN } from '../src/lib/i18n-en';
import { normalizeSpec } from '../../gateway/src/demo/research/matrix-study/spec';

// ---------------------------------------------------------------- 仿后端估算

const FAM_VARIANTS: Record<string, number> = { breakout: 4, ma_trend: 3, ema_cross: 3, pullback: 3, mean_reversion: 3, smc: 2 };
const CALL_USD = 0.00015;

function fakeEstimate(spec: MatrixSpecLite): MatrixEstimateResponse {
  if (spec.symbols.length > 6) throw new Error('symbols_invalid');
  const cand = spec.judge_stage === 'candidates', K = spec.judge_stage_max_cells ?? 12;
  const cells: MatrixEstimateCell[] = [];
  for (const sym of spec.symbols) for (const tf of spec.timeframes) for (const f of spec.families) for (const side of spec.sides) for (const arm of spec.arms) {
    const v = FAM_VARIANTS[f] ?? 1;
    cells.push({ id: `${sym}|${tf}|${f}|${side}|${arm}`, applicability: 'applicable', reason: null, variants: v, judge_calls: arm === 'code_judge' ? v * judgeCallsPerVariant(tf) : 0 });
  }
  const judge = cells.filter((c) => c.id.endsWith('|code_judge'));
  const code = cells.filter((c) => c.id.endsWith('|code'));
  const judgeAll = judge.reduce((a, c) => a + c.judge_calls!, 0);
  const stage1 = cand ? code.reduce((a, c) => a + c.variants, 0) : cells.reduce((a, c) => a + c.variants, 0);
  const perCell = judge.map((c) => c.judge_calls! / c.variants).sort((a, b) => b - a);
  const hasCode = spec.arms.includes('code');
  const trialsMax = cand && hasCode ? Math.min(K, judge.length) : 0;
  const callsMax = cand && hasCode ? perCell.slice(0, K).reduce((a, b) => a + b, 0) : 0;
  const matrix_trials = cand ? stage1 + trialsMax : stage1;
  const judge_calls = cand ? callsMax : judgeAll;
  const usd = judge_calls * CALL_USD;
  const ratio: Record<BudgetDim, number> = { variants: matrix_trials / 300, judge_calls: judge_calls / 20000, judge_usd: usd / 1, symbols: spec.symbols.length / 6 };
  const dims: BudgetDim[] = ['variants', 'judge_calls', 'judge_usd', 'symbols'];
  const estimate: MatrixEstimate = {
    cells: { total: cells.length, applicable: cells.length, not_applicable: 0, research_only: 0 },
    matrix_trials, iteration_trials_max: 0, variants: matrix_trials, judge_calls, judge_usd: usd.toFixed(6),
    data: { series: spec.symbols.length * spec.timeframes.length, bars: 1000, cold_fetch_ms_upper: 60_000 },
    within_budget: matrix_trials <= 300, warnings: [], stage1_trials: stage1,
    judge_stage: cand ? { mode: 'candidates', max_cells: K, judge_cells: judge.length, trials_max: trialsMax, calls_max: callsMax } : { mode: 'all', max_cells: null, judge_cells: judge.length, trials_max: judge.reduce((a, c) => a + c.variants, 0), calls_max: judgeAll },
    budget: { variants: { value: matrix_trials, limit: 300 }, judge_calls: { value: judge_calls, limit: 20000 }, judge_usd: { value: usd.toFixed(6), limit: '1' }, symbols: { value: spec.symbols.length, limit: 6 } },
    over: dims.filter((d) => ratio[d] > 1), near: dims.filter((d) => ratio[d] > 0.8 && ratio[d] <= 1),
    judge_call_usd: String(CALL_USD),
  };
  return { spec, estimate, cells };
}
const asyncEstimate = vi.fn(async (s: MatrixSpecLite) => fakeEstimate(s));

const SYMS6 = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'HYPEUSDT'];
const SYMS10 = [...SYMS6, 'ADAUSDT', 'LINKUSDT', 'SUIUSDT', 'AVAXUSDT'];
const ALL_FAMS = ['breakout', 'ma_trend', 'ema_cross', 'pullback', 'mean_reversion', 'smc'];
const spec = (p: Partial<MatrixSpecLite>): MatrixSpecLite => ({
  symbols: ['BTCUSDT'], timeframes: ['4h'], families: ['breakout', 'ma_trend'], market: 'perp', sides: ['long'], arms: ['code', 'code_judge'], recommendation_id: null, judge_stage: 'all', ...p,
});
const baseOf = (s: MatrixSpecLite): ProjectionBase => { const r = fakeEstimate(s); return { spec: s, estimate: r.estimate, cells: r.cells! }; };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); asyncEstimate.mockClear(); });

// ---------------------------------------------------------------- 渲染(SSR + 预置查询结果)

/** 新建表单(flow)在 SSR 下的规格与 create.tsx 里拼出来的一致:缺省 judge_stage = candidates */
function renderCreate(preset: { symbols: string[]; timeframes: MatrixTimeframe[]; families: string[]; sides: ('long' | 'short')[] }, judgeStage: 'all' | 'candidates' = 'candidates', fixes?: unknown) {
  const qc = new QueryClient();
  const s = spec({ ...preset, judge_stage: judgeStage });
  if (s.symbols.length <= 6) qc.setQueryDefaults(['matrix-estimate'], { initialData: fakeEstimate(s), staleTime: Infinity });
  if (fixes) qc.setQueryDefaults(['matrix-fixes'], { initialData: fixes, staleTime: Infinity });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(TooltipProvider, null, createElement(MatrixStudyCreate, { flow: true, from: null, preset: { ...preset, market: 'perp' } }) as ReactElement)));
}

describe('边选边估:防抖', () => {
  it('300ms 内连改 5 次只估一次,估的是最后一次的规格', async () => {
    vi.useFakeTimers();
    const bodies: MatrixSpecLite[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push((JSON.parse(init!.body!) as { spec: MatrixSpecLite }).spec);
      return new Response(JSON.stringify(fakeEstimate(bodies.at(-1)!)), { status: 200 });
    }));
    const results: MatrixEstimateResponse[] = [];
    const deb = createDebouncer<MatrixSpecLite>((s) => { void matrixApi.estimate(s).then((r) => results.push(r)); }, 300);
    for (const n of [1, 2, 3, 4, 5]) { deb.push(spec({ symbols: SYMS6.slice(0, n) })); vi.advanceTimersByTime(100); }
    expect(fetch).not.toHaveBeenCalled();
    expect(deb.pending()).toBe(true);
    vi.advanceTimersByTime(300);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodies[0]!.symbols).toEqual(SYMS6.slice(0, 5));
    await vi.runAllTimersAsync();
    expect(results[0]!.estimate.budget!.symbols.value).toBe(5);
    // 再改一次:再过 300ms 才发第二次
    deb.push(spec({ symbols: SYMS6 }));
    vi.advanceTimersByTime(299);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    deb.cancel();
  });
});

describe('超标提示:逐维度黄 / 红', () => {
  it('单变体判断数公式:15m ≈ 461、4h 117、1d 39', () => {
    expect(judgeCallsPerVariant('15m')).toBe(461);
    expect(judgeCallsPerVariant('4h')).toBe(117);
    expect(judgeCallsPerVariant('1d')).toBe(39);
    expect(judgeCallsPerVariant('4h', { window_days: { '4h': 365 }, split: { train: 0.5, selection: 0.25 } })).toBe(Math.ceil((365 * 0.75 * 6) / 30));
  });
  it('>80% 黄、超了红;币数 > 6 不用后端就判超', () => {
    // 6 币 × 15m × 6 族 × 多空 × 两臂(all):432 变体 / 99576 次 / $14.94 —— 三个都超;币数正好 6 个 = 100% 黄
    const e = fakeEstimate(spec({ symbols: SYMS6, timeframes: ['15m'], families: ALL_FAMS, sides: ['long', 'short'] })).estimate;
    const d = budgetDims(e, 6);
    expect(Object.fromEntries(d.map((x) => [x.dim, x.level]))).toEqual({ variants: 'over', judge_calls: 'over', judge_usd: 'over', symbols: 'near' });
    expect(overOf(d)).toEqual(['variants', 'judge_calls', 'judge_usd']);
    // 旧后端:没有 budget / over,按缺省上限兜底
    const { budget: _b, over: _o, near: _n, ...old } = e;
    expect(overOf(budgetDims(old as MatrixEstimate, 6))).toEqual(['variants', 'judge_calls', 'judge_usd']);
    // 没估算也能判币数
    expect(currentOver(spec({ symbols: SYMS10 }), null)).toEqual(['symbols']);
  });
  it('表单:超了的维度标红并写出是哪个维度;开始按钮禁用,说「先点上面的修正」', () => {
    const html = renderCreate({ symbols: SYMS6, timeframes: ['15m'], families: ALL_FAMS, sides: ['long', 'short'] }, 'all');
    expect(html).toMatch(/data-dim="variants" data-level="over"/);
    expect(html).toMatch(/data-dim="judge_calls" data-level="over"[^>]*>Jev 判断 99,576 次 \/ 20,000/);
    expect(html).toMatch(/data-dim="judge_usd" data-level="over"/);
    expect(html).toContain('变体 432 / 300');
    expect(html).toContain('超了:变体、判断调用、判断花费');
    expect(html).toContain('text-destructive');
    expect(html).toContain('先点上面的修正');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?开始海选/);
    // 缺省就是两段式,开关在
    expect(html).toContain('data-testid="judge-stage"');
    expect(html).toContain('只对候补测 Jev(省钱)');
  });
  it('表单:用到 80% 以上但没超的维度标黄;两段式写「最坏 K 格」', () => {
    // 两段式:6 币 × 15m × 6 族 × 多空 → 216 + 12 = 228 变体(76%),5532 次,$0.83(83% 黄)
    const html = renderCreate({ symbols: SYMS6, timeframes: ['15m'], families: ALL_FAMS, sides: ['long', 'short'] });
    expect(html).toMatch(/data-dim="judge_usd" data-level="near"/);
    expect(html).toMatch(/data-dim="variants" data-level="ok"/);
    expect(html).toContain('text-warn');
    expect(html).toContain('(两段式,按最坏 12 格估)');
    expect(html).toContain('Jev 判断 5,532 次 / 20,000');
    expect(html).not.toContain('先点上面的修正');
    expect(html).not.toContain('超了:');
  });
  it('表单:币数 > 6 静态判超,资产栏写清楚', () => {
    const html = renderCreate({ symbols: SYMS10, timeframes: ['4h'], families: ['breakout'], sides: ['long'] });
    expect(html).toContain('币数超了:10 个,一次最多 6 个');
    expect(html).toMatch(/data-dim="symbols" data-level="over"/);
    expect(html).toContain('超了:币数');
    expect(html).toContain('先点上面的修正');
  });
});

describe('静态投影:再加这个会超 X', () => {
  it('没改动时投影 = 后端当前数字;加周期 / 族 / 方向 / 臂按公式放大', () => {
    const s = spec({ symbols: SYMS6.slice(0, 3), timeframes: ['4h'], families: ['breakout', 'ma_trend'] });
    const b = baseOf(s);
    expect(project(b, null)).toMatchObject({ variants: 42, judge_calls: 3 * 7 * 117 });
    // 加 15m:变体翻倍,判断 += 3 × 7 × 461;和后端真算一致
    const real = fakeEstimate({ ...s, timeframes: ['4h', '15m'] }).estimate;
    expect(project(b, { kind: 'add_timeframe', tf: '15m' })).toMatchObject({ variants: real.matrix_trials, judge_calls: real.judge_calls });
    // 族 / 方向 / 币按 (k+1)/k
    expect(project(b, { kind: 'add_side', side: 'short' })!.variants).toBe(84);
    expect(project(b, { kind: 'add_family', family: 'pullback' })!.variants).toBe(63);
    expect(project(b, { kind: 'add_symbol' })!.variants).toBe(56);
    // 只有纯代码时加 code_judge 臂
    const codeOnly = baseOf({ ...s, arms: ['code'] });
    expect(project(codeOnly, { kind: 'add_arm', arm: 'code_judge' })).toMatchObject({ variants: 42, judge_calls: 2457 });
  });
  it('会新超的选项给提示,写出维度和数字;不超的不提示', () => {
    const b = baseOf(spec({ symbols: SYMS6.slice(0, 3), timeframes: ['4h'], families: ['breakout', 'ma_trend'] }));
    const h = optionHint(b, { kind: 'add_timeframe', tf: '15m' })!;
    expect(h.over).toEqual(['judge_usd']);
    expect(h.text).toBe('再加这个会超:判断花费 $1.82');
    expect(h.severe).toBe(true);
    expect(optionHint(b, { kind: 'add_family', family: 'pullback' })).toBeNull();
    // 两段式下同样加 15m 不超(只补跑最坏 12 格)
    const cand = baseOf(spec({ symbols: SYMS6.slice(0, 3), timeframes: ['4h'], families: ['breakout', 'ma_trend'], judge_stage: 'candidates' }));
    expect(optionHint(cand, { kind: 'add_timeframe', tf: '15m' })).toBeNull();
    // 切回「每组都测」会超
    const big = baseOf(spec({ symbols: SYMS6, timeframes: ['15m'], families: ALL_FAMS, sides: ['long', 'short'], judge_stage: 'candidates' }));
    expect(optionHint(big, { kind: 'set_stage', mode: 'all' })!.over).toEqual(['variants', 'judge_calls', 'judge_usd']);
    // 已经超的维度不重复提示
    expect(optionHint(b, { kind: 'add_timeframe', tf: '15m' }, ['judge_usd'])).toBeNull();
  });
  it('表单:会超的选项加警示样式和 title(不禁用)', () => {
    const html = renderCreate({ symbols: SYMS6.slice(0, 3), timeframes: ['4h'], families: ['breakout', 'ma_trend'], sides: ['long'] }, 'all');
    const btn15 = /<button[^>]*title="([^"]*)"[^>]*data-budget-warn="(\w+)"[^>]*>15m/.exec(html);
    expect(btn15?.[1]).toBe('再加这个会超:判断花费 $1.82');
    expect(btn15?.[2]).toBe('severe');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-budget-warn/);
    // 「每组都测」已选;族里加 pullback 不超 → 没有警示
    expect(html).toMatch(/<button[^>]*>回踩<\/button>/);
    expect(html).not.toMatch(/data-budget-warn="[a-z]+"[^>]*>回踩/);
  });
});

describe('一键修正', () => {
  it('两段式排第一,数字是验证过的;拆批(all 不行)退到「拆批 + 两段式」;第三个是减维度并注明仍超', async () => {
    const s = spec({ symbols: SYMS6, timeframes: ['15m'], families: ALL_FAMS, sides: ['long', 'short'] });
    const fixes = await planFixes(s, fakeEstimate(s), asyncEstimate);
    expect(fixes.map((f) => f.kind)).toEqual(['two_stage', 'split_two_stage', 'reduce']);
    expect(fixes[0]).toMatchObject({ title: '改成两段式:只对候补测 Jev', detail: '变体 228/300 · Jev 5,532 次 · 预留 $0.83', still_over: [], patch: { judge_stage: 'candidates' } });
    expect(fixes[1]!.batches!.map((b) => b.symbols)).toEqual([SYMS6.slice(0, 3), SYMS6.slice(3)]);
    expect(fixes[1]!.batches!.every((b) => b.judge_stage === 'candidates')).toBe(true);
    expect(fixes[1]!.title).toBe('拆成 2 批 + 两段式,直接开始');
    expect(fixes[2]).toMatchObject({ title: '去掉做空', patch: { sides: ['long'] } });
    expect(fixes[2]!.still_over).toEqual(['judge_calls', 'judge_usd']);
    expect(fixes[2]!.detail).toContain('仍超 判断调用、判断花费');
    // 验证过:每个按钮的规格都真调了估算
    expect(asyncEstimate).toHaveBeenCalledWith(expect.objectContaining({ judge_stage: 'candidates', symbols: SYMS6 }));
  });
  it('拆批:10 币 → 2 批(5 + 5),串行创建两次,origin.batch 同 id、index 1/2', async () => {
    const s = spec({ symbols: SYMS10, timeframes: ['4h'], families: ['breakout', 'ma_trend'], judge_stage: 'candidates', origin: { chat_session_id: 'cs_1' } });
    const fixes = await planFixes(s, null, asyncEstimate);
    expect(fixes.map((f) => f.kind)).toEqual(['split']);
    const split = fixes[0]!;
    expect(split.title).toBe('拆成 2 批,直接开始');
    expect(split.batches!.map((b) => b.symbols.length)).toEqual([5, 5]);
    expect(evenChunks(SYMS10.concat('X'), 2).map((c) => c.length)).toEqual([6, 5]);
    // 串行:第二次 POST 在第一次返回之后才发
    const log: string[] = [];
    const posted: { spec: MatrixSpecLite }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init!.body!) as { spec: MatrixSpecLite };
      posted.push(body);
      const i = posted.length;
      log.push(`start ${i}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${i}`);
      return new Response(JSON.stringify({ id: `ms_${i}`, status: 'queued', stage: 'queued', created_at: 1, updated_at: 1, manifest_hash: 'h', spec: body.spec, cells: [] }), { status: 200 });
    }));
    const r = await createBatches(split.batches!, matrixApi.create, 'batch-test-1');
    expect(r.error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    expect(posted.map((p) => p.spec.origin)).toEqual([
      { chat_session_id: 'cs_1', batch: { id: 'batch-test-1', index: 1, total: 2 } },
      { chat_session_id: 'cs_1', batch: { id: 'batch-test-1', index: 2, total: 2 } },
    ]);
    expect(posted.map((p) => p.spec.symbols)).toEqual([SYMS10.slice(0, 5), SYMS10.slice(5)]);
    expect(r.created.map((v) => v.id)).toEqual(['ms_1', 'ms_2']);
    // 缺省批次 id 形如 batch-<36 进制时间戳>-<随机>,后端校验 [A-Za-z0-9_.:-]{1,80}
    const r2 = await createBatches([split.batches![0]!], async (x) => ({ id: 'x', manifest: { spec: x, cells: [] } }) as unknown as MatrixStudyView);
    expect(r2.created[0]!.manifest.spec.origin!.batch!.id).toMatch(/^batch-[0-9a-z]+-[0-9a-z]+$/);
  });
  it('拆批中途失败:停下,返回已创建的和错误', async () => {
    let n = 0;
    const r = await createBatches([spec({}), spec({}), spec({})], async () => { if (++n === 2) throw new Error('boom'); return { id: `ms_${n}` } as MatrixStudyView; });
    expect(r.created.map((v) => v.id)).toEqual(['ms_1']);
    expect(r.error?.message).toBe('boom');
  });
  it('减维度:按静态投影挑降幅最大的两个,再验证,展示真实数字', async () => {
    // 纯代码 6 币 × 2 周期 × 4 族 × 多空 = 312 变体(只超变体)
    const s = spec({ symbols: SYMS6, timeframes: ['4h', '1d'], families: ['breakout', 'ma_trend', 'ema_cross', 'pullback'], sides: ['long', 'short'], arms: ['code'] });
    const fixes = await planFixes(s, fakeEstimate(s), asyncEstimate);
    expect(fixes.map((f) => f.kind)).toEqual(['split', 'reduce', 'reduce']);
    expect(fixes[0]!.batches!.length).toBe(2);
    const fam = fixes.find((f) => f.title.startsWith('少两个策略族'))!;
    expect(fam.patch!.families).toHaveLength(2);
    expect(fam.patch!.families).not.toContain('breakout');
    expect(fam.detail).toBe('变体 144/300');
    expect(fam.still_over).toEqual([]);
    const other = fixes[2]!;
    expect(['去掉做空', '去掉 4h 周期', '去掉 1d 周期']).toContain(other.title);
    expect(other.detail).toBe('变体 156/300');
  });
  it('不超时不给修正;表单里修正按钮写出修正后的数字', async () => {
    const ok = spec({ symbols: SYMS6.slice(0, 2) });
    expect(await planFixes(ok, fakeEstimate(ok), asyncEstimate)).toEqual([]);
    const s = spec({ symbols: SYMS6, timeframes: ['15m'], families: ALL_FAMS, sides: ['long', 'short'] });
    const fixes = await planFixes(s, fakeEstimate(s), asyncEstimate);
    const html = renderCreate({ symbols: SYMS6, timeframes: ['15m'], families: ALL_FAMS, sides: ['long', 'short'] }, 'all', fixes);
    expect(html).toContain('data-testid="budget-fixes"');
    expect(html).toContain('超出这次能跑的上限:变体、判断调用、判断花费');
    expect(html.match(/data-fix="/g)?.length).toBe(3);
    expect(html).toContain('变体 228/300 · Jev 5,532 次 · 预留 $0.83');
    expect(html).toContain('拆成 2 批 + 两段式,直接开始');
  });
});

describe('Jev 两段式', () => {
  it('新建表单缺省 candidates,提交 / 估算都带上;后端 normalizeSpec 接受 judge_stage 与 origin.batch', () => {
    expect(DEFAULT_JUDGE_STAGE).toBe('candidates');
    const cur = spec({ judge_stage: DEFAULT_JUDGE_STAGE, symbols: [] });
    const flow = submitSpec(cur, ['SOLUSDT', 'XRPUSDT'], [], true);
    expect(flow.judge_stage).toBe('candidates');
    expect(submitSpec(cur, ['SOLUSDT'], [], false).judge_stage).toBe('candidates');
    const n = normalizeSpec({ ...flow, origin: { batch: { id: 'batch-abc-123', index: 1, total: 2 } } }, { now: 1790349595146 });
    expect(n.judge_stage).toBe('candidates');
    expect(n.origin.batch).toEqual({ id: 'batch-abc-123', index: 1, total: 2 });
  });
  it('详情:两段式注明「只对候补测了 Jev(补跑 X 格 / 合格 Y 格)」;没补跑的格子显示「未测 Jev」不是「不适用」', () => {
    const raw = JSON.parse(readFileSync(new URL('./matrix-study-judge.fixture.json', import.meta.url), 'utf8')) as { spec: Record<string, unknown>; conclusion: Record<string, unknown>; cells: { id: string; arm: string; applicability: string; result: Record<string, unknown> | null }[] };
    raw.spec.judge_stage = 'candidates';
    const judgeCells = raw.cells.filter((c) => c.arm === 'code_judge' && c.applicability === 'applicable' && c.result);
    const skipped = judgeCells.slice(0, 4);
    for (const c of skipped) c.result = { ...c.result!, verdict: 'ineligible', tier: 'ineligible', judge_stage: 'not_candidate', judge_delta: null };
    for (const c of judgeCells.slice(4)) c.result = { ...c.result!, judge_stage: 'rerun' };
    raw.conclusion.judge_stage = { mode: 'candidates', rerun_cells: judgeCells.length - 4, eligible: 9, skipped_cells: 4 };
    (raw as Record<string, unknown>).judge_stage = { mode: 'candidates', max_cells: 12, status: 'done', eligible: 9, selected: [] };
    const s = unwrapMatrixStudyView(raw);
    expect(s.judge_stage?.status).toBe('done');
    const note = `只对候补测了 Jev(补跑 ${judgeCells.length - 4} 格 / 合格 9 格)`;
    expect(judgeStageNote(s)).toBe(note);
    expect(mapTone('applicable', s.state.cells[skipped[0]!.id])).toBe('untested');
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, createElement(MatrixStudyBody, { s }))));
    // 结果地图 + Jev 效果各一处
    expect(html.split(note).length - 1).toBe(2);
    expect(html.match(/data-tone="untested"/g)?.length).toBe(4);
    expect(html).toContain('未测 Jev');
    // 运行状态没结论时退回 selected 名单
    const running = { ...s, state: { ...s.state, conclusion: null }, judge_stage: { mode: 'candidates' as const, max_cells: 12, status: 'selected' as const, eligible: 5, selected: [{ cell_id: 'a', code_cell_id: 'b', code_trial_id: 'c', param: 'p', score: 70, tier: 'paper_candidate' }] } };
    expect(judgeStageNote(running)).toBe('只对候补测了 Jev(补跑 1 格 / 合格 5 格)');
    // 旧研究(all / 没字段)不加注
    expect(judgeStageNote(unwrapMatrixStudyView(JSON.parse(readFileSync(new URL('./matrix-study-judge.fixture.json', import.meta.url), 'utf8'))))).toBeNull();
  });
  it('列表:有 origin.batch 显示「批次 i/N」+ 批次 id 末 4 位;没有不显示', () => {
    const base = unwrapMatrixStudyView(JSON.parse(readFileSync(new URL('./matrix-study-v2.fixture.json', import.meta.url), 'utf8')));
    const withBatch: MatrixStudyView = { ...base, manifest: { ...base.manifest, spec: { ...base.manifest.spec, origin: { chat_session_id: null, batch: { id: 'batch-mg1abc-x7k2', index: 2, total: 3 } } } } };
    const html = renderToStaticMarkup(createElement(BatchTag, { s: withBatch }));
    expect(html).toContain('批次 2/3');
    expect(html).toContain('x7k2');
    expect(html).toContain('data-batch="batch-mg1abc-x7k2"');
    expect(renderToStaticMarkup(createElement(BatchTag, { s: base }))).toBe('');
  });
});

describe('英文词条', () => {
  it('批量验证目录里 t() 的中文文案都有英文', () => {
    const files = ['budget.ts', 'create.tsx', 'detail.tsx', 'explain.ts', 'shared.tsx', 'list.tsx'].map((f) => `../src/components/matrix-study/${f}`);
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) if (/[一-鿿]/.test(m[1]!) && !EN[m[1]!]) missing.push(m[1]!);
    }
    for (const k of ['变体', '判断调用', '判断花费', '币数', '未测 Jev']) if (!EN[k]) missing.push(k);
    expect(missing).toEqual([]);
  });
});
