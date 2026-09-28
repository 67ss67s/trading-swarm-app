/**
 * 批量验证(内部名:矩阵研究)新建表单的预算层:纯函数 + 一个不碰 React 的防抖器,单测在 test/matrix-budget.test.ts。
 *
 *   budgetDims      估算 → 四个维度(变体 / 判断调用 / 判断花费 / 币数)的值、上限、黄(>80%)红(超)档;旧后端没有 budget 时按缺省上限兜底
 *   project         用当前估算(cells[].judge_calls、stage1_trials、judge_call_usd、budget)静态投影「多选 / 少选这一项」后的数字:
 *                     币 / 族 / 方向:同组其余维度不变,按已有值的平均加一行(总和 ≈ (k+1)/k 放大);
 *                     周期:每组加一格,判断次数 = 变体 × ceil(window_days × (train+selection) × 天内根数 / 30);
 *                     加 code_judge 臂:每个 code 格复制一格;两段式按「纯代码变体 + 最坏 K 格补跑」算;
 *                     最后按「模型算的当前值 → 后端当前值」的比例校准,没改动时投影 = 后端数字。
 *   planFixes       超标时的一键修正(先调 estimate 验证再展示):两段式 > 自动拆批(不行再拆批 + 两段式)> 减维度,最多 3 个。
 *   createBatches   拆批后串行创建,每批带 origin.batch = { id, index, total }。
 * 文案 key 是中文原文,英文在 ./i18n-en.ts。
 */
import type { BudgetDim, JudgeStageMode, MatrixArm, MatrixEstimate, MatrixEstimateCell, MatrixEstimateResponse, MatrixSpecLite, MatrixStudyView, MatrixTimeframe } from '@/api/matrix-study';
import { t } from '@/lib/i18n';

/** 后端缺省(spec.ts DEFAULT_BUDGET / MAX_SYMBOLS / DEFAULT_JUDGE_STAGE_MAX_CELLS);旧后端估算里没有 budget 时用 */
export const MAX_SYMBOLS = 6;
export const DEFAULT_LIMITS = { variants: 300, judge_calls: 20000, judge_usd: '1', symbols: MAX_SYMBOLS } as const;
export const DEFAULT_JUDGE_STAGE_MAX_CELLS = 12;
export const DIMS: BudgetDim[] = ['variants', 'judge_calls', 'judge_usd', 'symbols'];
export const DIM_TEXT: Record<BudgetDim, string> = { variants: '变体', judge_calls: '判断调用', judge_usd: '判断花费', symbols: '币数' };
export const dimText = (d: BudgetDim) => t(DIM_TEXT[d]);
export const dimsText = (ds: BudgetDim[]) => ds.map(dimText).join(t('、'));

const WINDOW_DAYS: Record<MatrixTimeframe, number> = { '3m': 30, '5m': 45, '15m': 180, '4h': 730, '1d': 1460 };
const BARS_PER_DAY: Record<MatrixTimeframe, number> = { '3m': 480, '5m': 288, '15m': 96, '4h': 6, '1d': 1 };

/** 单个变体按 all 模式的判断次数 ≈ ceil(window_days × (train+selection) × 天内根数 / 30)(15m 缺省 ≈ 461) */
export function judgeCallsPerVariant(tf: MatrixTimeframe, spec?: Record<string, unknown> | null): number {
  const wd = (spec?.['window_days'] as Partial<Record<MatrixTimeframe, number>> | undefined)?.[tf] ?? WINDOW_DAYS[tf];
  const sp = spec?.['split'] as { train?: number; selection?: number } | undefined;
  const frac = (sp?.train ?? 0.6) + (sp?.selection ?? 0.2);
  return Math.ceil(Math.round(wd * frac * BARS_PER_DAY[tf] * 1e6) / 1e6 / 30);
}

// ---------------------------------------------------------------- 维度档位

export type Level = 'ok' | 'near' | 'over';
export interface DimState { dim: BudgetDim; value: number; limit: number; ratio: number; level: Level; shown: string; limitShown: string }

const ratioOf = (value: number, limit: number) => (limit > 0 ? value / limit : value > 0 ? Infinity : 0);
export const levelOf = (ratio: number): Level => (ratio > 1 ? 'over' : ratio > 0.8 ? 'near' : 'ok');
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
export const fmtUsd = (n: number) => n.toFixed(2);

/** 估算 → 四个维度;e 为空(还没估 / 估算报错)时只有币数有意义。币数永远用表单当前的数(估算可能是上一次的) */
export function budgetDims(e: MatrixEstimate | null | undefined, symbolCount: number): DimState[] {
  const b = e?.budget;
  const lim = {
    variants: b?.variants.limit ?? DEFAULT_LIMITS.variants, judge_calls: b?.judge_calls.limit ?? DEFAULT_LIMITS.judge_calls,
    judge_usd: Number(b?.judge_usd.limit ?? DEFAULT_LIMITS.judge_usd), symbols: b?.symbols.limit ?? DEFAULT_LIMITS.symbols,
  };
  const out: DimState[] = [];
  const push = (dim: BudgetDim, value: number, limit: number, shown: string, limitShown: string) => {
    const ratio = ratioOf(value, limit);
    out.push({ dim, value, limit, ratio, level: levelOf(ratio), shown, limitShown });
  };
  if (e) {
    const v = b?.variants.value ?? e.matrix_trials, c = b?.judge_calls.value ?? e.judge_calls, u = Number(b?.judge_usd.value ?? e.judge_usd);
    push('variants', v, lim.variants, fmtInt(v), fmtInt(lim.variants));
    push('judge_calls', c, lim.judge_calls, fmtInt(c), fmtInt(lim.judge_calls));
    push('judge_usd', u, lim.judge_usd, `$${fmtUsd(u)}`, `$${fmtUsd(lim.judge_usd)}`);
    // 后端 over / near 是真相:本地比例和它不一致时以后端为准(只会更严)
    for (const d of out) if (e.over?.includes(d.dim)) d.level = 'over'; else if (d.level === 'ok' && e.near?.includes(d.dim)) d.level = 'near';
  }
  push('symbols', symbolCount, lim.symbols, String(symbolCount), String(lim.symbols));
  return out;
}
export const overOf = (dims: DimState[]) => dims.filter((d) => d.level === 'over').map((d) => d.dim);

/** 估算报错 → 说清是哪个维度 */
export function estimateErrorText(msg: string): string {
  if (/symbols_invalid|symbols/i.test(msg)) return t('币数超了:一次最多 {n} 个币', { n: MAX_SYMBOLS });
  if (/variants|budget/i.test(msg)) return t('变体超了:{m}', { m: msg });
  return msg;
}

// ---------------------------------------------------------------- 静态投影

interface CellLite { symbol: string; tf: MatrixTimeframe; family: string; side: string; arm: MatrixArm; variants: number; calls: number }
export interface ProjectionBase { spec: MatrixSpecLite; estimate: MatrixEstimate; cells: MatrixEstimateCell[] }
export type Change =
  | { kind: 'add_symbol' }
  | { kind: 'add_family'; family: string }
  | { kind: 'add_timeframe'; tf: MatrixTimeframe }
  | { kind: 'add_side'; side: 'long' | 'short' }
  | { kind: 'add_arm'; arm: MatrixArm }
  | { kind: 'set_stage'; mode: JudgeStageMode }
  | { kind: 'remove_side'; side: 'long' | 'short' }
  | { kind: 'remove_timeframe'; tf: MatrixTimeframe }
  | { kind: 'remove_families'; families: string[] };
export interface Projected { variants: number; judge_calls: number; judge_usd: number | null; symbols: number; ratios: Record<BudgetDim, number>; over: BudgetDim[] }

/** `SYMBOL|tf|family|side|arm`(family 里不含 |,保险起见中间段拼回去) */
export function parseCellId(id: string): { symbol: string; tf: MatrixTimeframe; family: string; side: string; arm: MatrixArm } | null {
  const p = id.split('|');
  if (p.length < 5) return null;
  return { symbol: p[0]!, tf: p[1] as MatrixTimeframe, family: p.slice(2, -2).join('|'), side: p[p.length - 2]!, arm: p[p.length - 1] as MatrixArm };
}

function liteCells(base: ProjectionBase): CellLite[] {
  const out: CellLite[] = [];
  for (const c of base.cells) {
    if (c.applicability !== 'applicable') continue;
    const k = parseCellId(c.id);
    if (!k) continue;
    const calls = k.arm === 'code_judge' ? c.judge_calls ?? c.variants * judgeCallsPerVariant(k.tf, base.spec) : 0;
    out.push({ ...k, variants: c.variants, calls });
  }
  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const keyOf = (c: CellLite, skip: keyof CellLite) => (['symbol', 'tf', 'family', 'side', 'arm'] as const).filter((k) => k !== skip).map((k) => c[k]).join('|');

/** 按 all / candidates 口径算变体(预算口径 = matrix_trials)与判断调用;vs = 两段式每格补跑的变体数 */
function totals(cells: CellLite[], mode: JudgeStageMode, K: number, vs: number): { variants: number; calls: number } {
  if (mode === 'all') return { variants: sum(cells.map((c) => c.variants)), calls: sum(cells.filter((c) => c.arm === 'code_judge').map((c) => c.calls)) };
  const code = cells.filter((c) => c.arm === 'code');
  const codeKeys = new Set(code.map((c) => keyOf(c, 'arm')));
  const judge = cells.filter((c) => c.arm === 'code_judge' && codeKeys.has(keyOf(c, 'arm')));
  const top = judge.map((c) => (c.variants ? (c.calls / c.variants) * vs : 0)).sort((a, b) => b - a).slice(0, K);
  return { variants: sum(code.map((c) => c.variants)) + Math.min(K, judge.length) * vs, calls: sum(top) };
}

/** 同组(其余维度相同)按平均值加一格 */
function addAverage(cells: CellLite[], dim: 'symbol' | 'family' | 'side', value: string): CellLite[] {
  const groups = new Map<string, CellLite[]>();
  for (const c of cells) { const k = keyOf(c, dim); const g = groups.get(k); if (g) g.push(c); else groups.set(k, [c]); }
  const extra = [...groups.values()].map((g) => ({ ...g[0]!, [dim]: value, variants: sum(g.map((c) => c.variants)) / g.length, calls: sum(g.map((c) => c.calls)) / g.length }));
  return [...cells, ...extra];
}

function applyChange(cells: CellLite[], ch: Change, spec: MatrixSpecLite, judgeOk: boolean): CellLite[] {
  switch (ch.kind) {
    case 'add_symbol': return addAverage(cells, 'symbol', '__new__');
    case 'add_family': return addAverage(cells, 'family', ch.family);
    case 'add_side': return addAverage(cells, 'side', ch.side);
    case 'add_timeframe': {
      const groups = new Map<string, CellLite[]>();
      for (const c of cells) { const k = keyOf(c, 'tf'); const g = groups.get(k); if (g) g.push(c); else groups.set(k, [c]); }
      const per = judgeCallsPerVariant(ch.tf, spec);
      return [...cells, ...[...groups.values()].map((g) => { const v = sum(g.map((c) => c.variants)) / g.length; return { ...g[0]!, tf: ch.tf, variants: v, calls: g[0]!.arm === 'code_judge' ? v * per : 0 }; })];
    }
    case 'add_arm': {
      if (ch.arm === 'code_judge') {
        if (!judgeOk) return cells;
        return [...cells, ...cells.filter((c) => c.arm === 'code').map((c) => ({ ...c, arm: 'code_judge' as const, calls: c.variants * judgeCallsPerVariant(c.tf, spec) }))];
      }
      return [...cells, ...cells.filter((c) => c.arm === 'code_judge').map((c) => ({ ...c, arm: 'code' as const, calls: 0 }))];
    }
    case 'set_stage': return cells;
    case 'remove_side': return cells.filter((c) => c.side !== ch.side);
    case 'remove_timeframe': return cells.filter((c) => c.tf !== ch.tf);
    case 'remove_families': return cells.filter((c) => !ch.families.includes(c.family));
  }
}

/** 投影「多选 / 少选这一项」之后的四个维度;没有 cells(旧后端)返回 null */
export function project(base: ProjectionBase, ch: Change | null): Projected | null {
  if (!base.cells?.length) return null;
  const e = base.estimate, spec = base.spec;
  const mode: JudgeStageMode = e.judge_stage?.mode ?? (spec.judge_stage === 'candidates' ? 'candidates' : 'all');
  const K = e.judge_stage?.max_cells ?? spec.judge_stage_max_cells ?? DEFAULT_JUDGE_STAGE_MAX_CELLS;
  const vs = e.judge_stage?.mode === 'candidates' ? e.judge_stage.trials_max / Math.max(1, Math.min(K, e.judge_stage.judge_cells)) || 1 : 1;
  const cells = liteCells(base);
  // judge_call_usd === null(新后端明说没有模型配置)→ code_judge 臂整块不适用,加了也不产生判断
  const judgeOk = e.judge_call_usd !== null;
  const now = totals(cells, mode, K, vs);
  const calV = now.variants > 0 ? e.matrix_trials / now.variants : 1;
  const calC = now.calls > 0 && e.judge_calls > 0 ? e.judge_calls / now.calls : 1;
  const nextMode = ch?.kind === 'set_stage' ? ch.mode : mode;
  const next = totals(ch ? applyChange(cells, ch, spec, judgeOk) : cells, nextMode, K, nextMode === mode ? vs : 1);
  const variants = Math.round(next.variants * calV), judge_calls = Math.round(next.calls * calC);
  const unit = e.judge_call_usd != null ? Number(e.judge_call_usd) : e.judge_calls > 0 ? Number(e.judge_usd) / e.judge_calls : null;
  const judge_usd = judge_calls === 0 ? 0 : unit == null ? null : judge_calls * unit;
  const symbols = spec.symbols.length + (ch?.kind === 'add_symbol' ? 1 : 0);
  const b = e.budget;
  const ratios: Record<BudgetDim, number> = {
    variants: ratioOf(variants, b?.variants.limit ?? DEFAULT_LIMITS.variants),
    judge_calls: ratioOf(judge_calls, b?.judge_calls.limit ?? DEFAULT_LIMITS.judge_calls),
    judge_usd: judge_usd == null ? 0 : ratioOf(judge_usd, Number(b?.judge_usd.limit ?? DEFAULT_LIMITS.judge_usd)),
    symbols: ratioOf(symbols, b?.symbols.limit ?? DEFAULT_LIMITS.symbols),
  };
  return { variants, judge_calls, judge_usd, symbols, ratios, over: DIMS.filter((d) => ratios[d] > 1) };
}

export interface OptionHint { text: string; detail: string; severe: boolean; over: BudgetDim[] }
/**
 * 选项提示:多选这一项后会新超的维度 →「再加这个会超 X」;超过上限 1.5 倍算「很明显」(界面置灰,但不禁用)。
 * 当前已经超的维度不重复提示(修正区会说)。
 */
export function optionHint(base: ProjectionBase | null, ch: Change, currentOver: BudgetDim[] = []): OptionHint | null {
  if (!base) return null;
  const p = project(base, ch);
  if (!p) return null;
  const fresh = p.over.filter((d) => !currentOver.includes(d));
  if (!fresh.length) return null;
  const parts = fresh.map((d) => `${dimText(d)} ${d === 'judge_usd' ? `$${fmtUsd(p.judge_usd ?? 0)}` : fmtInt(d === 'variants' ? p.variants : d === 'judge_calls' ? p.judge_calls : p.symbols)}`);
  const detail = parts.join(t('、'));
  return { text: ch.kind === 'set_stage' ? t('改成这个会超:{x}', { x: detail }) : t('再加这个会超:{x}', { x: detail }), detail, severe: fresh.some((d) => p.ratios[d] > 1.5), over: fresh };
}

// ---------------------------------------------------------------- 一键修正

export type FixKind = 'two_stage' | 'split' | 'split_two_stage' | 'reduce';
export interface FixOption {
  kind: FixKind; title: string; detail: string; still_over: BudgetDim[];
  /** 应用到表单(两段式 / 减维度) */
  patch?: Partial<MatrixSpecLite>;
  /** 拆批:每批完整规格(已带 origin.batch 之外的全部字段),点了就串行创建 */
  batches?: MatrixSpecLite[];
}
type EstimateFn = (spec: MatrixSpecLite) => Promise<MatrixEstimateResponse>;

/** 当前是否超预算:币数 > 6 静态判;其余看估算 */
export function currentOver(spec: MatrixSpecLite, e: MatrixEstimate | null | undefined): BudgetDim[] {
  return overOf(budgetDims(e, spec.symbols.length));
}

/** 按币均分 n 批(前面的批多一个) */
export function evenChunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [], base = Math.floor(xs.length / n), extra = xs.length % n;
  let i = 0;
  for (let k = 0; k < n; k++) { const len = base + (k < extra ? 1 : 0); out.push(xs.slice(i, i + len)); i += len; }
  return out.filter((c) => c.length);
}

/** 估算结果一行:变体 v/limit · Jev c 次 · $u(给按钮写修正后的数字) */
export function budgetLine(e: MatrixEstimate, symbols: number): string {
  const d = budgetDims(e, symbols);
  const get = (k: BudgetDim) => d.find((x) => x.dim === k)!;
  const parts = [t('变体 {v}/{l}', { v: get('variants').shown, l: get('variants').limitShown })];
  if (e.judge_calls > 0) parts.push(t('Jev {c} 次', { c: get('judge_calls').shown }), t('预留 {u}', { u: get('judge_usd').shown }));
  return parts.join(' · ');
}

const hasJudge = (s: MatrixSpecLite) => s.arms.includes('code_judge');
const withStage = (s: MatrixSpecLite, mode: JudgeStageMode): MatrixSpecLite => {
  const { judge_stage_max_cells: _k, ...rest } = s;
  return mode === 'candidates' ? { ...rest, judge_stage: 'candidates', ...(_k !== undefined ? { judge_stage_max_cells: _k } : {}) } : { ...rest, judge_stage: 'all' };
};

/**
 * 超标时的修正建议(每条都先调 estimate 验证,展示真实数字);优先级 两段式 > 拆批 > 减维度,最多 3 条。
 *   两段式:有 code_judge 且不是 candidates → 改成 candidates。
 *   拆批:按币分 N 批(每批 ≤ 6 币,均分),N 从 ceil(n/6) 往上试到每批 1 币,每批 over 都为空才算;不行再试「拆批 + 两段式」。
 *   减维度:去掉做空 / 去掉一个周期 / 少两个策略族,按静态投影挑降幅最大的 1–2 个,再验证;仍超也展示并注明。
 */
export async function planFixes(spec: MatrixSpecLite, current: MatrixEstimateResponse | null, estimate: EstimateFn): Promise<FixOption[]> {
  const n = spec.symbols.length;
  const over0 = currentOver(spec, current?.estimate);
  if (!over0.length) return [];
  const cache = new Map<string, Promise<MatrixEstimate | null>>();
  const est = (s: MatrixSpecLite) => {
    const k = JSON.stringify(s);
    if (!cache.has(k)) cache.set(k, estimate(s).then((r) => r.estimate, () => null));
    return cache.get(k)!;
  };
  // 估算报错(比如 symbols_invalid)也算没过
  const overFor = (s: MatrixSpecLite, e: MatrixEstimate | null): BudgetDim[] => (e ? currentOver(s, e) : s.symbols.length > MAX_SYMBOLS ? ['symbols'] : ['variants']);
  const out: FixOption[] = [];

  // 1. 两段式(币数超了单靠两段式解决不了,交给拆批 + 两段式)
  const canStage = hasJudge(spec) && spec.judge_stage !== 'candidates';
  if (canStage && n <= MAX_SYMBOLS) {
    const s2 = withStage(spec, 'candidates'), e2 = await est(s2);
    if (e2) {
      const still = currentOver(s2, e2);
      out.push({ kind: 'two_stage', title: t('改成两段式:只对候补测 Jev'), detail: budgetLine(e2, n) + (still.length ? ` · ${t('仍超 {x}', { x: dimsText(still) })}` : ''), still_over: still, patch: { judge_stage: 'candidates' } });
    }
  }

  // 2. 自动拆批
  if (n >= 2) {
    const tryModes: JudgeStageMode[] = [spec.judge_stage === 'candidates' ? 'candidates' : 'all'];
    if (canStage) tryModes.push('candidates');
    split: for (const mode of tryModes) {
      const base = mode === (spec.judge_stage === 'candidates' ? 'candidates' : 'all') ? spec : withStage(spec, mode);
      for (let N = Math.max(2, Math.ceil(n / MAX_SYMBOLS)); N <= n; N++) {
        const chunks = evenChunks(spec.symbols, N);
        const specs = chunks.map((syms) => ({ ...base, symbols: syms }));
        // 先看最大的一批,过不了就换下一个 N,省调用
        const first = await est(specs[0]!);
        if (!first || overFor(specs[0]!, first).length) continue;
        const rest = await Promise.all(specs.slice(1).map(est));
        if (rest.some((e, i) => !e || overFor(specs[i + 1]!, e).length)) continue;
        const all = [first, ...(rest as MatrixEstimate[])];
        const worst = all.reduce((a, e) => (e.matrix_trials + e.judge_calls > a.matrix_trials + a.judge_calls ? e : a));
        const staged = base !== spec;
        out.push({
          kind: staged ? 'split_two_stage' : 'split',
          title: staged ? t('拆成 {n} 批 + 两段式,直接开始', { n: specs.length }) : t('拆成 {n} 批,直接开始', { n: specs.length }),
          detail: t('每批 ≤ {m} 个币;最大一批 {x}', { m: chunks[0]!.length, x: budgetLine(worst, chunks[0]!.length) }),
          still_over: [], batches: specs,
        });
        break split;
      }
    }
  }

  // 3. 减维度(币数超了减维度也没用)
  if (n <= MAX_SYMBOLS && out.length < 3) {
    const cands: { title: string; patch: Partial<MatrixSpecLite>; ch: Change }[] = [];
    if (spec.sides.length > 1 && spec.sides.includes('short')) cands.push({ title: t('去掉做空'), patch: { sides: spec.sides.filter((x) => x !== 'short') }, ch: { kind: 'remove_side', side: 'short' } });
    const base: ProjectionBase | null = current?.cells ? { spec, estimate: current.estimate, cells: current.cells } : null;
    const score = (ch: Change) => { const p = base ? project(base, ch) : null; return p ? Math.max(...over0.map((d) => p.ratios[d])) + sum(DIMS.map((d) => p.ratios[d])) / 100 : Infinity; };
    if (spec.timeframes.length > 1) {
      const tf = [...spec.timeframes].sort((a, b) => score({ kind: 'remove_timeframe', tf: a }) - score({ kind: 'remove_timeframe', tf: b }) || judgeCallsPerVariant(b) - judgeCallsPerVariant(a))[0]!;
      cands.push({ title: t('去掉 {tf} 周期', { tf }), patch: { timeframes: spec.timeframes.filter((x) => x !== tf) }, ch: { kind: 'remove_timeframe', tf } });
    }
    if (spec.families.length >= 3) {
      const per = new Map<string, number>();
      for (const c of current?.cells ?? []) { const k = parseCellId(c.id); if (k && spec.families.includes(k.family)) per.set(k.family, (per.get(k.family) ?? 0) + c.variants + (c.judge_calls ?? 0) / 1000); }
      const two = [...spec.families].sort((a, b) => (per.get(b) ?? 0) - (per.get(a) ?? 0) || spec.families.indexOf(b) - spec.families.indexOf(a)).slice(0, 2);
      cands.push({ title: t('少两个策略族({x})', { x: two.join(t('、')) }), patch: { families: spec.families.filter((f) => !two.includes(f)) }, ch: { kind: 'remove_families', families: two } });
    }
    const picked = cands.map((c) => ({ ...c, s: score(c.ch) })).sort((a, b) => a.s - b.s).slice(0, Math.min(2, 3 - out.length));
    for (const c of picked) {
      const s2 = { ...spec, ...c.patch } as MatrixSpecLite, e2 = await est(s2);
      if (!e2) continue;
      const still = currentOver(s2, e2);
      out.push({ kind: 'reduce', title: c.title, detail: budgetLine(e2, n) + (still.length ? ` · ${t('仍超 {x}', { x: dimsText(still) })}` : ''), still_over: still, patch: c.patch });
    }
  }
  // 能真正修好的排前面(同优先级内),最多 3 个
  const rank: Record<FixKind, number> = { two_stage: 0, split: 1, split_two_stage: 1, reduce: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.still_over.length ? 1 : 0) - (b.still_over.length ? 1 : 0)).slice(0, 3);
}

/** 拆批 id:batch-<时间戳 36 进制>-<随机>(≤ 80 字符,[A-Za-z0-9_.:-]) */
export const newBatchId = (now = Date.now()) => `batch-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 串行创建每一批,spec 带 origin.batch;中途失败就停,返回已创建的和错误 */
export async function createBatches(specs: MatrixSpecLite[], create: (s: MatrixSpecLite) => Promise<MatrixStudyView>, id = newBatchId()): Promise<{ created: MatrixStudyView[]; error: Error | null }> {
  const created: MatrixStudyView[] = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!;
    try {
      created.push(await create({ ...s, origin: { ...(s.origin ?? {}), batch: { id, index: i + 1, total: specs.length } } }));
    } catch (e) { return { created, error: e as Error }; }
  }
  return { created, error: null };
}

// ---------------------------------------------------------------- 防抖

/** 不碰 React 的防抖器:push 连续调用只在静默 ms 后触发最后一次 */
export function createDebouncer<T>(fn: (v: T) => void, ms = 300): { push: (v: T) => void; cancel: () => void; pending: () => boolean } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    push: (v) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(v); }, ms); },
    cancel: () => { if (timer) clearTimeout(timer); timer = null; },
    pending: () => timer !== null,
  };
}
