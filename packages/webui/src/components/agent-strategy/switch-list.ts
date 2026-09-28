/**
 * 「Agent 当前策略」切换弹层的列表逻辑(纯函数,单测在 test/matrix-ux.test.ts):
 *   - 按质量排序:score_label excellent > good > fair > needs_work > poor > 没评分(同档保持原顺序,即最近更新在前)
 *   - 来源:内置(origin.source=import)/ 批量验证(adopt 写进 description 的「[矩阵研究 …」前缀)/ 批量验证 · 候补
 *     (v2「存为候补策略」写的「[批量验证候补 … · 未经最终验收」前缀)/ 研究台(research_loop,或在研究会话里手建的);判断不了返回 null 不标
 *   - 名字是空或「未指定策略」这类占位名时,换成「资产 · 周期 · 策略族」的自动名(策略族认不出就只要资产 · 周期)
 */
import type { ResearchStrategy } from '@trade-gate/contracts';
import { FAMILY_TEXT } from '@/components/chat/recommendation-card';
import { t } from '@/lib/i18n';

type S = Pick<ResearchStrategy, 'name' | 'symbol' | 'timeframe' | 'description' | 'origin' | 'summary'>;

const SCORE_RANK: Record<string, number> = { excellent: 5, good: 4, fair: 3, needs_work: 2, poor: 1 };
export const scoreRank = (s: Pick<S, 'summary'>) => SCORE_RANK[s.summary?.score_label ?? ''] ?? 0;

export function sortByQuality<T extends Pick<S, 'summary'>>(list: readonly T[]): T[] {
  return list.map((s, i) => ({ s, i })).sort((a, b) => scoreRank(b.s) - scoreRank(a.s) || a.i - b.i).map((x) => x.s);
}

export type StrategySource = 'builtin' | 'matrix' | 'matrix_candidate' | 'research';
const MATRIX_PREFIX = '[矩阵研究 '; // i18n-ignore(后端 description 前缀,只做匹配)
/** 批量验证 v2 候补(未经最终验收)的描述前缀 */
export const MATRIX_CANDIDATE_PREFIX = '[批量验证候补 '; // i18n-ignore
export function strategySource(s: Pick<S, 'origin' | 'description'>): StrategySource | null {
  if (s.origin.source === 'import') return 'builtin';
  if (s.description.startsWith(MATRIX_CANDIDATE_PREFIX)) return 'matrix_candidate';
  if (s.description.startsWith(MATRIX_PREFIX)) return 'matrix';
  if (s.origin.source === 'research_loop' || s.origin.session_id) return 'research';
  return null;
}
export const SOURCE_TEXT: Record<StrategySource, string> = { builtin: '内置', matrix: '批量验证', matrix_candidate: '批量验证 · 候补', research: '研究台' };

const PLACEHOLDER_NAMES = new Set(['未指定策略', // i18n-ignore(匹配占位名)
  '未命名策略', 'untitled', 'untitled strategy']);
export const isPlaceholderName = (name: string) => !name.trim() || PLACEHOLDER_NAMES.has(name.trim().toLowerCase());

/** 批量验证存下来的策略,description 里带「· <family>/<side>/<arm>」 */
function familyOf(s: Pick<S, 'description'>): string | null {
  const m = /· ([a-z_]+)\/(?:long|short)\//.exec(s.description);
  if (!m) return null;
  return (FAMILY_TEXT as Record<string, string>)[m[1]!] ?? null;
}

export function displayName(s: Pick<S, 'name' | 'symbol' | 'timeframe' | 'description'>): string {
  if (!isPlaceholderName(s.name)) return s.name;
  const fam = familyOf(s);
  return [s.symbol.replace(/USDT$/, '') || t('未知资产'), s.timeframe, fam].filter(Boolean).join(' · ');
}
