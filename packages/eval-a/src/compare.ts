// `compare a b`: both runs re-scored on the intersection of their case ids, side by side.
//
// Cross-set mode: when the two runs were scored against DIFFERENT case sets (`design` vs `holdout`), the
// intersection is empty and "both sides re-scored on the common cases" degenerates into an empty report.
// There the comparison is a regression read instead — each side scored on its OWN full case list, and the
// question is not "did they agree case by case" (there are no shared cases) but "did the numbers we tuned
// on the design set survive on the holdout set".

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CounterfactualSummary } from './counterfactual.js';
import { buildReport, HARD, loadEpisodes, type Metric, type Report } from './report.js';
import { loadCases } from './run.js';
import type { RunMeta } from './types.js';
import { readJson, writeJson, writeText } from './util.js';

export interface Comparison {
  a: string;
  b: string;
  /** The case set each run was scored against. */
  set_a: string;
  set_b: string;
  /** `set_a !== set_b`: no common cases, each side scored on its own full case list. */
  cross_set: boolean;
  common_cases: number;
  only_a: number;
  only_b: number;
  verdict_a: string;
  verdict_b: string;
  metrics: { name: string; a: string; b: string; status_a: string; status_b: string; delta: number | null }[];
  /** Cases excluded from action agreement because one side's samples disagreed (agreement < 2/3). 0 on single-sample runs. */
  unstable_either: number;
  action_diffs: { case_id: string; a: string; b: string }[];
  agreement: number | null;
}

const fmtDelta = (m1: Metric, m2: Metric): number | null => (m1.value === null || m2.value === null ? null : Math.round((m2.value - m1.value) * 10000) / 10000);

const MISSING: Metric = { name: '', value: null, display: 'n/a(该 run 的报告没有这项)', threshold: '', status: 'NOT_IMPLEMENTED', n: 0, note: null, examples: [], details: {} };

/** Join by metric name, not by index, so a run reported with an older metric set still lines up. */
function metricRows(ra: Report, rb: Report): Comparison['metrics'] {
  const byB = new Map(rb.metrics.map((m) => [m.name, m]));
  const names = [...ra.metrics.map((m) => m.name), ...rb.metrics.map((m) => m.name).filter((x) => !ra.metrics.some((m) => m.name === x))];
  const byA = new Map(ra.metrics.map((m) => [m.name, m]));
  return names.map((name) => {
    const ma = byA.get(name) ?? MISSING;
    const mb = byB.get(name) ?? MISSING;
    return { name, a: ma.display, b: mb.display, status_a: ma.status, status_b: mb.status, delta: fmtDelta(ma, mb) };
  });
}

/** The cases dir a run was scored against, without building its report. */
function casesDirOf(runDir: string, override?: string): string | undefined {
  if (override) return resolve(override);
  const metaPath = join(resolve(runDir), 'run.json');
  if (!existsSync(metaPath)) return undefined;
  const d = readJson<RunMeta>(metaPath).cases_dir;
  return d ? resolve(d) : undefined;
}

/** The set name of a cases dir (same rule `buildReport` uses: the first case's `set`, else the dir name). */
function setNameOf(dir: string | undefined): string {
  if (!dir) return '';
  return loadCases(dir)[0]?.set ?? basename(dir);
}

export function compareRuns(aDir: string, bDir: string, casesDir?: string): { comparison: Comparison; markdown: string; reports: [Report, Report] } {
  const idsA = new Set(loadEpisodes(resolve(aDir)).map((e) => e.case_id));
  const idsB = new Set(loadEpisodes(resolve(bDir)).map((e) => e.case_id));
  const common = new Set([...idsA].filter((id) => idsB.has(id)));
  // Same cases dir ⇒ same set by construction, so the (cheap) dir check short-circuits before loadCases.
  const dirA = casesDirOf(aDir, casesDir);
  const dirB = casesDirOf(bDir, casesDir);
  const crossSet = dirA !== undefined && dirB !== undefined && dirA !== dirB && setNameOf(dirA) !== setNameOf(dirB);
  // Cross-set: no common cases to intersect on — each side is scored over its OWN full case list.
  const onlyIds = crossSet ? undefined : common;
  const ra = buildReport(aDir, casesDir, onlyIds);
  const rb = buildReport(bDir, casesDir, onlyIds);
  const rowsB = new Map(rb.rows.map((r) => [r.case_id, r]));
  const diffs: Comparison['action_diffs'] = [];
  let same = 0;
  // Only cases stable on BOTH sides count toward action agreement (docs/eval/denoise-plan-2026-09-04.md §2.3).
  const stableA = new Set(ra.rows.filter((r) => r.stable !== false).map((r) => r.case_id));
  const stableB = new Set(rb.rows.filter((r) => r.stable !== false).map((r) => r.case_id));
  let unstableEither = 0;
  if (!crossSet)
    for (const ra1 of ra.rows) {
      const rb1 = rowsB.get(ra1.case_id);
      if (rb1 && (!stableA.has(ra1.case_id) || !stableB.has(ra1.case_id))) {
        unstableEither++;
        continue;
      }
      if (!rb1) continue;
      const sa = `${ra1.action}${ra1.direction ? '/' + ra1.direction : ''}`;
      const sb = `${rb1.action}${rb1.direction ? '/' + rb1.direction : ''}`;
      if (ra1.action === rb1.action) same++;
      else diffs.push({ case_id: ra1.case_id, a: sa, b: sb });
    }
  const comparison: Comparison = {
    a: ra.run_id,
    b: rb.run_id,
    set_a: ra.set,
    set_b: rb.set,
    cross_set: crossSet,
    common_cases: common.size,
    only_a: idsA.size - common.size,
    only_b: idsB.size - common.size,
    verdict_a: ra.verdict,
    verdict_b: rb.verdict,
    metrics: metricRows(ra, rb),
    action_diffs: diffs,
    agreement: crossSet ? null : ra.rows.length - unstableEither > 0 ? Math.round((same / (ra.rows.length - unstableEither)) * 10000) / 10000 : null,
    unstable_either: unstableEither,
  };
  // Column labels: plain A/B on a same-set compare (byte-identical to the old output), set-tagged when cross-set.
  const LA = crossSet ? `A (set ${ra.set})` : 'A';
  const LB = crossSet ? `B (set ${rb.set})` : 'B';
  const L: string[] = [];
  L.push(`# Compare — ${ra.run_id} (A) vs ${rb.run_id} (B)`);
  L.push('');
  L.push(`- A: \`${ra.brain}\` / \`${ra.model}\`, 结论 **${ra.verdict}**`);
  L.push(`- B: \`${rb.brain}\` / \`${rb.model}\`, 结论 **${rb.verdict}**`);
  if (crossSet) {
    L.push(`- 跨 case 集对比(A set \`${ra.set}\` vs B set \`${rb.set}\`):共同 case ${common.size},两边各按自己的 case 集独立算分;跨集只描述泛化差异,回归退化须在同一保留集比较旧版与新版`);
    L.push(`- A ${ra.n_episodes} 个 episode / ${ra.n_cases_in_set} 个 case,B ${rb.n_episodes} 个 episode / ${rb.n_cases_in_set} 个 case;噪声底 A ${ra.sampling ? `${((ra.sampling.noise_floor ?? 0) * 100).toFixed(0)}%` : 'n/a'} / B ${rb.sampling ? `${((rb.sampling.noise_floor ?? 0) * 100).toFixed(0)}%` : 'n/a'}`);
    L.push('- 动作一致率 n/a — 不同 case 集,不比逐 case 动作');
  } else {
    L.push(`- 共同 case ${common.size}(A 独有 ${comparison.only_a},B 独有 ${comparison.only_b});两边指标都只按共同 case 重算`);
    L.push(`- 动作一致率 ${comparison.agreement === null ? 'n/a' : `${(comparison.agreement * 100).toFixed(1)}%`}(${same}/${ra.rows.length - comparison.unstable_either}${comparison.unstable_either ? `;另有 ${comparison.unstable_either} 个 case 因一侧采样不稳定(众数 < 4/5 或不唯一)不计` : ''});噪声底 A ${ra.sampling ? `${((ra.sampling.noise_floor ?? 0) * 100).toFixed(0)}%` : 'n/a'} / B ${rb.sampling ? `${((rb.sampling.noise_floor ?? 0) * 100).toFixed(0)}%` : 'n/a'}`);
  }
  L.push('');
  if (crossSet) {
    // The three numbers a design→holdout regression actually turns on, called out before the full table.
    L.push('## 回归测试三项(设计集 → 保留集)');
    L.push('');
    L.push(`| 项 | ${LA} | ${LB} | 读法 |`);
    L.push('|---|---|---|---|');
    const st = (r: Report, name: string): string => {
      const m = r.metrics.find((x) => x.name === name);
      return m ? (m.status === 'FAIL' ? `**FAIL**(${m.display})` : `${m.status} ${m.display}`) : 'n/a';
    };
    for (const name of HARD) L.push(`| 硬不变量 ${name} | ${st(ra, name)} | ${st(rb, name)} | 保留集上任一项 FAIL = 规则没迁移过去 |`);
    const cfMean = (r: Report): string => {
      const m = r.metrics.find((x) => x.name === 'review_counterfactual');
      return m && m.n ? `${(m.value ?? 0).toFixed(2)}R(n=${m.n})` : 'n/a';
    };
    L.push(`| review_counterfactual 平均 regret R | ${cfMean(ra)} | ${cfMean(rb)} | 越小越好;跨集分布不同;回归需同集旧版对照 |`);
    const vmOf = (r: Report): string => r.metrics.find((x) => x.name === 'vs_mechanical')?.display ?? 'n/a';
    L.push(`| vs_mechanical | ${vmOf(ra)} | ${vmOf(rb)} | agent 相对机械基线的 R;配对 edge 与选择性分开读;无 PROPOSE = 无提案价值证据 |`);
    L.push('');
  }
  L.push('## 指标对照(逐项并排)');
  L.push('');
  L.push(`| 指标 | ${LA} | ${LB} | Δ(B−A) | A 状态 | B 状态 |`);
  L.push('|---|---|---|---|---|---|');
  for (const m of comparison.metrics) L.push(`| ${m.name} | ${m.a} | ${m.b} | ${m.delta === null ? '' : m.delta} | ${m.status_a} | ${m.status_b} |`);
  L.push('');
  const detail = (r: Report, name: string): Record<string, unknown> => (r.metrics.find((m) => m.name === name)?.details ?? {});
  const missA = (detail(ra, 'edge_coverage')['model_missing'] as string[] | undefined) ?? [];
  const missB = (detail(rb, 'edge_coverage')['model_missing'] as string[] | undefined) ?? [];
  L.push('## 判断图');
  L.push('');
  L.push(`- 未覆盖的模型边 — A: ${missA.join(', ') || '无'};B: ${missB.join(', ') || '无'}`);
  L.push(`- 闸拒绝分布 — A: ${JSON.stringify(detail(ra, 'guard_hit_distribution')['rejections'] ?? {})};B: ${JSON.stringify(detail(rb, 'guard_hit_distribution')['rejections'] ?? {})}`);
  L.push(`- 越图动作 — A: ${ra.rows.filter((x) => x.graph.illegal).length};B: ${rb.rows.filter((x) => x.graph.illegal).length}`);
  L.push('');
  // Counterfactual R: the number that says whether the newer run's HOLD/EXIT boundary moved the right way.
  const cfOf = (r: Report): CounterfactualSummary | null => {
    const m = r.metrics.find((x) => x.name === 'review_counterfactual');
    return m && m.n ? (m.details as unknown as CounterfactualSummary) : null;
  };
  const cfa = cfOf(ra);
  const cfb = cfOf(rb);
  if (cfa || cfb) {
    const f = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : x.toFixed(2));
    const d = (x: number | null | undefined, y: number | null | undefined): string => (x === null || x === undefined || y === null || y === undefined ? '' : (y - x >= 0 ? '+' : '') + (y - x).toFixed(2));
    L.push('## 复查反事实 R(单路径,不是 P&L)');
    L.push('');
    L.push(`| 项 | ${LA} | ${LB} | Δ(B−A) |`);
    L.push('|---|---|---|---|');
    L.push(`| 可结算复查 case | ${cfa?.n ?? 0} | ${cfb?.n ?? 0} | |`);
    L.push(`| 平均 regret R | ${f(cfa?.mean_regret_r)} | ${f(cfb?.mean_regret_r)} | ${d(cfa?.mean_regret_r, cfb?.mean_regret_r)} |`);
    L.push(`| 中位 regret R | ${f(cfa?.median_regret_r)} | ${f(cfb?.median_regret_r)} | ${d(cfa?.median_regret_r, cfb?.median_regret_r)} |`);
    L.push(`| 选中最优比例 | ${f(cfa?.chose_best_share)} | ${f(cfb?.chose_best_share)} | ${d(cfa?.chose_best_share, cfb?.chose_best_share)} |`);
    L.push(`| 判 EXIT 改 HOLD 的平均 R | ${f(cfa?.hold_instead_of_exit_r)} | ${f(cfb?.hold_instead_of_exit_r)} | ${d(cfa?.hold_instead_of_exit_r, cfb?.hold_instead_of_exit_r)} |`);
    L.push(`| 判 HOLD 改离场的平均 R | ${f(cfa?.exit_instead_of_hold_r)} | ${f(cfb?.exit_instead_of_hold_r)} | ${d(cfa?.exit_instead_of_hold_r, cfb?.exit_instead_of_hold_r)} |`);
    L.push(`| 2×2 判HOLD(对/错) | ${cfa?.matrix.hold_hold ?? 0} / ${cfa?.matrix.hold_exit ?? 0} | ${cfb?.matrix.hold_hold ?? 0} / ${cfb?.matrix.hold_exit ?? 0} | |`);
    L.push(`| 2×2 判EXIT(对/错) | ${cfa?.matrix.exit_exit ?? 0} / ${cfa?.matrix.exit_hold ?? 0} | ${cfb?.matrix.exit_exit ?? 0} / ${cfb?.matrix.exit_hold ?? 0} | |`);
    L.push('');
    L.push('regret 越小越好;「判 EXIT 改 HOLD 的平均 R」为正 = 那些 EXIT 走早了,为负 = 走对了。单路径口径见各自 report.md。');
    if (!crossSet && (cfa?.n ?? 0) !== (cfb?.n ?? 0)) L.push(`**两边的 case 数不同(${cfa?.n ?? 0} vs ${cfb?.n ?? 0}):动作类指标只在各自采样稳定的 case 上算,不稳定的 case 一侧有一侧没有。要严格比,取两边都稳定的交集单独算。**`);
    L.push('');
  }
  const memLine = (r: Report): string => ['memory_number_leak', 'memory_command_followed', 'memory_citation_rate', 'memory_irrelevant_cited', 'memory_action_flip'].map((name) => `${name} ${r.metrics.find((m) => m.name === name)?.display ?? 'n/a'}`).join(';');
  if (ra.rows.some((x) => x.memory.injected.length) || rb.rows.some((x) => x.memory.injected.length)) {
    L.push('## 长期记忆');
    L.push('');
    L.push(`- ${LA}: ${memLine(ra)}`);
    L.push(`- ${LB}: ${memLine(rb)}`);
    L.push('');
  }
  if (crossSet) {
    L.push('## 动作不同的 case');
    L.push('');
    L.push('不适用:A 与 B 跑的是不同的 case 集,逐 case 动作不作配对比较,动作一致率同理为 n/a。要看的是上面「回归测试三项」与指标对照表。');
    L.push('');
  } else {
    L.push(`## 动作不同的 case(${diffs.length})`);
    L.push('');
    if (diffs.length) {
      L.push('| case | A | B |');
      L.push('|---|---|---|');
      for (const d of diffs.slice(0, 60)) L.push(`| \`${d.case_id}\` | ${d.a} | ${d.b} |`);
      if (diffs.length > 60) L.push(`| … | 还有 ${diffs.length - 60} 个 | |`);
    } else L.push('无。');
    L.push('');
  }
  return { comparison, markdown: L.join('\n'), reports: [ra, rb] };
}

export function writeComparison(aDir: string, bDir: string, outPath?: string, casesDir?: string): { comparison: Comparison; markdown: string; path: string } {
  const { comparison, markdown } = compareRuns(aDir, bDir, casesDir);
  const path = outPath ?? join(dirname(resolve(aDir)), `compare-${basename(resolve(aDir))}-vs-${basename(resolve(bDir))}.md`);
  writeText(path, markdown);
  writeJson(path.replace(/\.md$/, '') + '.json', comparison);
  return { comparison, markdown, path };
}
