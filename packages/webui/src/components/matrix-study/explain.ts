/**
 * 批量验证(内部名:矩阵研究,§9.53 B)的「翻成人话」层:纯函数,不碰 React,单测在 test/matrix-ux.test.ts。
 *   - 没通过的主因 → 一句白话 + 下一步建议
 *   - 迭代诊断码(exposure / stop_tight / sample …)→ 中文短标题;改法去掉生成器前缀和 IR 路径
 *   - 门槛名(selection_trades>=30 …)→ 白话
 *   - 预计用时:按最近几次研究的实际速度估,没有历史就只给取数上限
 * 文案 key 都是中文原文,英文在 ./i18n-en.ts。
 */
import type { CellResult, FailureCause, MatrixCellDef, MatrixConclusion, MatrixEstimate, MatrixGeneration, MatrixStudyView } from '@/api/matrix-study';
import { t } from '@/lib/i18n';

/** 没通过的主因:标题 + 一句解释(结论卡和结果地图悬停共用) */
export function causePlain(c: FailureCause): { title: string; detail: string } {
  switch (c) {
    case 'insufficient_evidence': return { title: t('样本不足'), detail: t('这段历史里交易太少,不够下结论') };
    case 'cost_dominated': return { title: t('手续费吃掉利润'), detail: t('扣掉手续费和滑点之后就不赚钱了') };
    case 'underperform_hold': return { title: t('跑不过拿着不动'), detail: t('同一段行情,直接持有比它赚得多') };
    case 'unsupported_execution': return { title: t('跑不起来'), detail: t('这种组合现在执行不了(比如判断全部出错),没法评估') };
  }
}

/** 主因对应的下一步建议(按常见程度排,最多 3 条) */
export function nextSteps(c: FailureCause): string[] {
  switch (c) {
    case 'insufficient_evidence': return [t('换更短的周期,比如 4h 换成 15m,同一段时间里交易会多很多'), t('多加几个币,样本攒得更快'), t('拉长回测的历史区间')];
    case 'cost_dominated': return [t('换更长的周期,少交易、每笔目标放大一点'), t('少选反应很快的策略族(比如均值回归),它们交易频繁,手续费占比高')];
    case 'underperform_hold': return [t('这段行情单边走,拿着不动本来就很强;试试加上另一个方向'), t('换别的策略族,或换一批走势不一样的币')];
    case 'unsupported_execution': return [t('先只用「纯代码」跑一次,确认策略本身能跑'), t('检查 Jev 的模型连接是否正常')];
  }
}

/** 结论里数量最多的主因;都为 0 返回 null */
export function mainCause(causes: Partial<Record<FailureCause, number>>): FailureCause | null {
  let best: FailureCause | null = null, n = 0;
  for (const [k, v] of Object.entries(causes) as [FailureCause, number][]) if (v > n) { best = k; n = v; }
  return best;
}

/** 迭代诊断码 → 中文短标题(后端 research/loop/diagnose.ts 的 key) */
const DIAG_TITLE: Record<string, string> = {
  exposure: '在场时间太短', stop_tight: '止损太紧', sample: '交易太少', fees: '手续费吃掉利润', concentration: '利润集中在少数几笔',
  worst_exit: '某种离场方式亏得最多', trade_center: '多数交易其实不赚', decay: '前段赚钱、后段变差', exit_mix: '各种离场方式的盈亏',
  assets: '各个币表现不一', param_mismatch: '入场和离场参数不一致', blocked: '很多单子被拦下', stop_widened: '止损被放宽到成本线',
  limit_wrong_side: '限价挂在了吃亏的一侧', fill: '限价单大多没成交', sizing: '仓位太小', reconcile: '账目核对', variants: '试过的版本太多',
};
export const diagTitle = (code: string) => (DIAG_TITLE[code] ? t(DIAG_TITLE[code]!) : code);

/** 诊断原文「code:文本;code:文本」→ [{code, title, text}];没有 code 前缀的整段当一条 */
export function parseDiagnosis(raw: string): { code: string | null; title: string; text: string }[] {
  return raw.split(/;(?=[a-z_]+:)/).map((seg) => seg.trim()).filter(Boolean).map((seg) => {
    const m = /^([a-z_]+):([\s\S]*)$/.exec(seg);
    return m ? { code: m[1]!, title: diagTitle(m[1]!), text: m[2]!.trim() } : { code: null, title: seg, text: seg };
  });
}

/** 生成器前缀 → 白话标签 */
const GENERATOR_TEXT: Record<string, string> = { diagnosis: '按诊断改', swap: '换一个部件', neighborhood: '试附近的参数' };

/** 改法原文「generator:说明(ir.path)」→ { how, text };去掉 IR 路径和括号里的补充说明 */
export function plainChange(raw: string): { how: string | null; text: string } {
  if (/没有产出新变体/.test(raw)) return { how: null, text: t('没想出新的改法,这一格停在上一版') };
  const m = /^([a-z_]+):([\s\S]*)$/.exec(raw.trim());
  const gen = m ? m[1]! : null;
  let body = (m ? m[2]! : raw).trim();
  // 去括号:先剥最内层,重复几次处理嵌套(中英文括号都算)
  for (let i = 0; i < 4; i++) body = body.replace(/[（(][^（）()]*[）)]/g, '');
  body = body.replace(/\s{2,}/g, ' ').replace(/[,,;;]\s*$/, '').trim();
  return { how: gen ? (GENERATOR_TEXT[gen] ? t(GENERATOR_TEXT[gen]!) : gen) : null, text: body };
}

/** 门槛名 → 白话(后端 gate 名形如 selection_trades>=30 / beats_exposure_matched_hold) */
export function gatePlain(name: string): string {
  const num = /(\d+(?:\.\d+)?)\s*$/.exec(name)?.[1];
  if (name.startsWith('selection_trades')) return t('交易至少 {n} 笔', { n: num ?? '30' });
  if (name.startsWith('selection_blocks')) return t('覆盖足够多的时间段');
  if (name.startsWith('expectancy')) return t('平均每笔赚钱');
  if (name.startsWith('net_return')) return t('扣费后赚钱');
  if (name.startsWith('stress_2x')) return t('手续费翻倍也还赚钱');
  if (name.startsWith('beats_exposure_matched_hold')) return t('跑赢同等仓位的持有');
  if (name.startsWith('max_drawdown')) return t('最大回撤不超过 {p}%', { p: num ? Math.round(Number(num) * 100) : '35' });
  if (name.startsWith('deflated_sharpe')) return t('扣掉「试了很多次」的运气成分后仍然显著');
  return name;
}

/**
 * 结果地图格子的颜色档。v2 后端带 tier 时按三档:通过 / 候补 · 可纸面观察 / 等最终验收 / 未通过 / 不适用;
 * 旧后端没有 tier 时沿用 v1 的通过 / 接近 / 未通过。
 */
export type MapTone = 'pass' | 'candidate' | 'waiting' | 'near' | 'fail' | 'na' | 'pending' | 'untested';
export function mapTone(applicability: string, r: CellResult | undefined): MapTone {
  if (applicability !== 'applicable') return 'na';
  if (!r) return 'pending';
  // Jev 两段式:没入选 / 第一阶段还没完的 code_judge 格 verdict 记 ineligible,但意思是「没补跑 Jev」,不是不适用
  if (r.judge_stage === 'not_candidate' || r.judge_stage === 'pending') return 'untested';
  if (r.tier) return r.tier === 'paper_candidate' ? 'candidate' : r.tier === 'pending' ? 'waiting' : r.tier === 'ineligible' ? 'na' : r.tier;
  return r.verdict === 'ineligible' ? 'na' : r.verdict;
}

/**
 * Jev 两段式的注释:「只对候补测了 Jev(补跑 X 格 / 合格 Y 格)」。不是两段式返回 null。
 * X / Y 优先取结论里的数,其次取运行状态(selected 名单 / eligible);都没有时只说前半句。
 */
export function judgeStageNote(s: Pick<MatrixStudyView, 'manifest' | 'state' | 'judge_stage'>): string | null {
  const js = s.judge_stage ?? null, c = s.state.conclusion?.judge_stage ?? null;
  const cand = s.manifest.spec.judge_stage === 'candidates' || js?.mode === 'candidates' || c?.mode === 'candidates';
  if (!cand) return null;
  const rerun = c?.rerun_cells ?? (js && js.status !== 'pending' ? js.selected.length : null);
  const eligible = c?.eligible ?? (js && js.status !== 'pending' ? js.eligible : null);
  if (rerun == null || eligible == null) return js?.status === 'pending' || !js ? t('只对候补测 Jev:先跑纯代码,候补定下来后再补跑') : t('只对候补测了 Jev');
  return t('只对候补测了 Jev(补跑 {x} 格 / 合格 {y} 格)', { x: rerun, y: eligible });
}

/** 评分标签(研究台 / 我的策略同一套 score_label) */
export const SCORE_LABEL_TEXT: Record<string, string> = { excellent: '优秀', good: '良好', fair: '一般', needs_work: '待改进', poor: '差' };
export const scoreLabelText = (l: string | null | undefined) => (l && SCORE_LABEL_TEXT[l] ? t(SCORE_LABEL_TEXT[l]!) : '—');

/** 这一格能不能「存为候补策略」:研究已完成、这格是候补,或最好的试验是「接近」且还不是通过 / 等验收 */
export function canAdoptCandidate(s: Pick<MatrixStudyView, 'status'>, r: CellResult | undefined): boolean {
  if (!r || s.status !== 'completed' || !r.tier_trial_id) return false;
  if (r.tier === 'paper_candidate') return true;
  return r.tier === 'fail' && r.verdict === 'near' && r.tier_trial_id === r.best_trial_id && !(r.tier_reasons ?? []).some((x) => x.includes('最终验收'));
}

/** 「在研究台继续打磨」深链:研究台读 matrix_study + trial,取这一组的 IR 进策略构建 */
export const researchLink = (studyId: string, trialId: string) => `#research?matrix_study=${encodeURIComponent(studyId)}&trial=${encodeURIComponent(trialId)}`;

/**
 * 结论卡下方的 notes:去重;过程类事件(resume → queued、进程重启、已取消…)不放结论区,收进「技术信息」。
 */
const PROCESS_NOTE = [/^resume\s*→/, /^进程重启/, /^已取消/, /^cancel/i, /^lease/i];
export function splitNotes(notes: string[]): { notes: string[]; tech: string[] } {
  const seen = new Set<string>(), out: string[] = [], tech: string[] = [];
  for (const raw of notes) {
    const n = raw.trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    (PROCESS_NOTE.some((re) => re.test(n)) ? tech : out).push(n);
  }
  return { notes: out, tech };
}

/** 结论卡标题 + 副标题:按三档说(候补不算通过) */
export function conclusionHead(c: MatrixConclusion): { tone: 'pass' | 'candidate' | 'none'; title: string; sub: string } {
  const nc = c.paper_candidates ?? 0;
  if (c.kind === 'passed') return { tone: 'pass', title: t('找到 {n} 条通过最终验收的策略', { n: c.finalist_ids.length }), sub: nc ? t('往下看「最终候选」:可以存成我的策略,再设为 agent 当前策略。另有 {n} 组候补,可以先用模拟盘观察。', { n: nc }) : t('往下看「最终候选」:可以存成我的策略,再设为 agent 当前策略。') };
  if (nc) return { tone: 'candidate', title: t('没有能直接上实盘的,但有 {n} 组值得先用模拟盘看看', { n: nc }), sub: t('这些组合只差样本数或统计显著性:选择段赚钱、跑赢同等仓位持有、回撤也在门槛内。它们没做最终验收,不算通过;点结果地图里的蓝色格子,可以存为候补策略,去我的策略里用模拟盘跑前向。') };
  return { tone: 'none', title: t('这次没有找到能用的策略'), sub: t('这也是有用的结论:这些组合在这段历史里站不住,省得拿真钱去试。') };
}

/**
 * 预计用时(毫秒区间):按最近已完成研究的实际速度估算 —— 纯代码每次试验多久、每次 Jev 判断多久。
 * 下限 = 只跑第一轮;上限 = 加满迭代 + 冷数据取数上限。没有可参考的历史返回 null。
 */
export function estimateWallMs(e: MatrixEstimate, history: MatrixStudyView[]): { low: number; high: number } | null {
  const done = history.filter((s) => s.status === 'completed' && s.state.usage.wall_ms > 0 && (s.ledger?.trial_count ?? 0) > 0);
  const codeOnly = done.filter((s) => s.state.usage.judge_calls === 0).map((s) => s.state.usage.wall_ms / s.ledger!.trial_count);
  if (!codeOnly.length) return null;
  const perTrial = median(codeOnly);
  const withJudge = done.filter((s) => s.state.usage.judge_calls > 0)
    .map((s) => Math.max(0, s.state.usage.wall_ms - perTrial * s.ledger!.trial_count) / s.state.usage.judge_calls);
  const perCall = withJudge.length ? median(withJudge) : 0;
  const low = e.matrix_trials * perTrial + e.judge_calls * perCall;
  const high = (e.matrix_trials + e.iteration_trials_max) * perTrial + e.judge_calls * perCall * (1 + e.iteration_trials_max / Math.max(1, e.matrix_trials)) + e.data.cold_fetch_ms_upper;
  return { low, high: Math.max(low, high) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 预计用时区间 → 「不到 1 分钟 / 大约 3 分钟 / 大约 2–8 分钟」 */
export function durationRange(lowMs: number, highMs: number): string {
  if (highMs < 60_000) return t('不到 1 分钟');
  const a = Math.max(1, Math.round(lowMs / 60_000)), b = Math.max(1, Math.round(highMs / 60_000));
  return a === b ? t('大约 {m} 分钟', { m: a }) : t('大约 {a}–{b} 分钟', { a, b });
}

/** 「不适用 / 只研究」格子的原因 → 白话;认不出的原样返回 */
export function naReason(reason: string | null): string {
  if (!reason) return t('这个组合不适用');
  if (reason.includes('both_evaluated_in_long_cell')) return t('这条策略多空一起算,结果都在「做多」那一格里');
  if (reason.includes('short_timeframe_execution_unverified')) return t('3m / 5m 的实盘下单还没验证过,这一版不回测');
  if (reason.includes('timeframe_segments_missing')) return t('这个周期的历史数据不够切出三段');
  return reason;
}

/** 「Jev 判断的效果」图的行:只取代码 + Jev 判断的适用格子;差值为 null 的(全部跳过 / 出错太多)也保留,画成文字 */
export interface JudgeRow { cell: MatrixCellDef; delta: NonNullable<CellResult['judge_delta']>; usable: boolean; tone: 'up' | 'down' | 'flat' }
export function judgeRows(s: MatrixStudyView): JudgeRow[] {
  const out: JudgeRow[] = [];
  for (const c of s.manifest.cells) {
    if (c.arm !== 'code_judge' || c.applicability !== 'applicable') continue;
    const d = s.state.cells[c.id]?.judge_delta;
    if (!d) continue;
    const usable = d.mean_daily != null && !d.all_skipped && !((d.error_ratio ?? 0) > 0.5);
    const ci = d.ci95;
    const tone = !usable || !ci ? 'flat' : ci[0] > 0 ? 'up' : ci[1] < 0 ? 'down' : 'flat';
    out.push({ cell: c, delta: d, usable, tone });
  }
  return out;
}

/** 选择段收益最高的几格(有成交的适用格子),给「和同期持有比」用 */
export function topCells(s: MatrixStudyView, n = 5): { cell: MatrixCellDef; r: CellResult }[] {
  return s.manifest.cells
    .filter((c) => c.applicability === 'applicable')
    .map((c) => ({ cell: c, r: s.state.cells[c.id] }))
    .filter((x): x is { cell: MatrixCellDef; r: CellResult } => !!x.r?.selection && x.r.selection.trades > 0)
    .sort((a, b) => b.r.selection!.total_return - a.r.selection!.total_return)
    .slice(0, n);
}

/** 迭代记录按格子分组(保持首次出现的顺序) */
export function groupGenerations(gens: MatrixGeneration[]): { cell_id: string; gens: MatrixGeneration[] }[] {
  const m = new Map<string, MatrixGeneration[]>();
  for (const g of gens) { const a = m.get(g.cell_id); if (a) a.push(g); else m.set(g.cell_id, [g]); }
  return [...m.entries()].map(([cell_id, gs]) => ({ cell_id, gens: gs }));
}
