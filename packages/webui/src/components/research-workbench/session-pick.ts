/**
 * 研究台进页时落到哪段对话:当前选中的还在列表里就不动;没有(换了机器 / 被删了 / 第一次来)就落到最近一条。
 * current 要传「此刻真正选中的」(研究台用 ref 记),不能用渲染时的旧值:深链 #research?session= 刚选中的对话
 * 在同一轮里还没进 state,拿旧值(第一次来是 null)判断会把它盖成最近一条。
 */
export function fallbackSession(sessions: readonly { id: string }[], current: string | null): string | null {
  if (!sessions.length) return null;
  if (current && sessions.some((x) => x.id === current)) return null;
  return sessions[0]!.id;
}
