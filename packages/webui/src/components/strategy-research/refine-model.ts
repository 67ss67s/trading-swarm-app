/**
 * 「优化」页(#refine)的纯逻辑:地址栏 ⇄ 带入的组合,以及从一次海选里挑出能精修的组合。
 *
 * 路由(hash 不带斜杠):
 *   #refine                         挑一组(最近的海选结果)或从头开始
 *   #refine?study=<ms_…>&trial=<mt_…>  带入海选里的一组,在研究台里精修
 *   #refine?blank=1                 不带入,直接用研究台从头做
 */
import type { CellResult, MatrixCellDef, MatrixStudyView } from '@/api/matrix-study';
import { mapTone, type MapTone } from '@/components/matrix-study/explain';

export interface RefineRoute { study: string | null; trial: string | null; blank: boolean }

export function parseRefineRoute(hash: string): RefineRoute {
  const q = new URLSearchParams(hash.replace(/^#/, '').split('?')[1] ?? '');
  const study = q.get('study'), trial = q.get('trial');
  return { study: study && trial ? study : null, trial: study && trial ? trial : null, blank: q.get('blank') === '1' };
}

export function refineHash(r: Partial<RefineRoute>): string {
  if (r.study && r.trial) return `refine?${new URLSearchParams({ study: r.study, trial: r.trial }).toString()}`;
  return r.blank ? 'refine?blank=1' : 'refine';
}

export interface RefineCandidate {
  def: MatrixCellDef;
  result: CellResult;
  trial: string;
  tone: MapTone;
  score: number | null;
  total_return: number | null;
  trades: number | null;
}

/** 越靠前越值得精修:通过 → 等最终验收 → 候补 → 接近 → 未通过 */
const TONE_RANK: Partial<Record<MapTone, number>> = { pass: 0, waiting: 1, candidate: 2, near: 3, fail: 4 };

/**
 * 一次海选里能带进研究台精修的组合:要有试验 id、结果已出、不是「不适用 / 没测」;
 * 按档位排,同档按评分(没有评分卡的旧研究按选择段收益)从高到低。
 */
export function refineCandidates(s: MatrixStudyView, limit = 12): RefineCandidate[] {
  const out: RefineCandidate[] = [];
  for (const def of s.manifest.cells) {
    const r = s.state.cells[def.id];
    if (!r) continue;
    const tone = mapTone(def.applicability, r);
    const trial = r.tier_trial_id ?? r.best_trial_id ?? null;
    if (!trial || TONE_RANK[tone] === undefined) continue;
    const m = r.scorecard?.metrics;
    out.push({ def, result: r, trial, tone, score: r.scorecard?.score.value ?? null, total_return: m?.total_return ?? r.selection?.total_return ?? null, trades: m?.trades ?? r.selection?.trades ?? null });
  }
  const key = (c: RefineCandidate) => c.score ?? (c.total_return ?? -Infinity) * 100;
  out.sort((a, b) => TONE_RANK[a.tone]! - TONE_RANK[b.tone]! || key(b) - key(a));
  return out.slice(0, limit);
}
