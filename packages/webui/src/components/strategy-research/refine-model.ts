/**
 * 旧的「优化」页地址(#refine,09-28 加、09-29 撤回侧栏)→ 研究台(#research)。
 * 研究台本身就有对话列表和策略构建,单独的优化页是多余的;旧链接照样能用,带的参数换成研究台的写法:
 *   #refine?study=<ms_…>&trial=<mt_…>  → #research?matrix_study=<ms_…>&trial=<mt_…>   把海选里的一组带进策略构建
 *   #refine?session=<id>               → #research?session=<id>                       打开这段研究对话
 *   其他                                → #research
 */
export function refineToResearchHash(hash: string): string {
  const q = new URLSearchParams(hash.replace(/^#/, '').split('?')[1] ?? '');
  const study = q.get('study'), trial = q.get('trial'), session = q.get('session');
  if (study && trial) return `research?${new URLSearchParams({ matrix_study: study, trial }).toString()}`;
  if (session) return `research?${new URLSearchParams({ session }).toString()}`;
  return 'research';
}
