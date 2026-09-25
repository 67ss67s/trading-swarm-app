import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './ambient';
import type { RoleMetaMap } from './roles';
import type { BotHandoff, BotRole } from './types';

export interface HandoffEvent { key: string; from: BotRole; to: BotRole; kind: 'handoff' | 'ack' }
const TTL = 1100;

/** 首次成功响应建立基线;只消费新记录和已观察到的 pending→acked,不消费 activity 映射。 */
export function useHandoffEvents(handoffs: BotHandoff[], ready: boolean) {
  const [events, setEvents] = useState<HandoffEvent[]>([]);
  const seen = useRef(new Map<string, string>());
  const primed = useRef(false);
  const newest = useRef(0);
  const timers = useRef(new Set<number>());
  useEffect(() => {
    if (!ready) return;
    const added: HandoffEvent[] = [];
    for (const h of handoffs) {
      const prev = seen.current.get(h.handoff_id);
      if (primed.current && h.from_role !== h.to_role) {
        if (prev === undefined && h.created_at >= newest.current) added.push({ key: `${h.handoff_id}:new`, from: h.from_role, to: h.to_role, kind: 'handoff' });
        else if (prev === 'pending' && h.status === 'acked' && h.to_role !== 'gate_captain') added.push({ key: `${h.handoff_id}:ack`, from: h.to_role, to: 'gate_captain', kind: 'ack' });
      }
    }
    // API 是有限窗口;保留当前窗口和时间水位,避免旧记录滚回来时再播。
    seen.current = new Map(handoffs.map((h) => [h.handoff_id, h.status]));
    newest.current = Math.max(newest.current, ...handoffs.map((h) => h.created_at));
    primed.current = true;
    if (!added.length) return;
    // 爆发时只显示最新三条,避免全场闪烁。数据本身仍完整留在 feed。
    const batch = added.slice(-3);
    setEvents((current) => [...current, ...batch].slice(-3));
    const keys = new Set(batch.map((e) => e.key));
    const timer = window.setTimeout(() => {
      setEvents((current) => current.filter((e) => !keys.has(e.key)));
      timers.current.delete(timer);
    }, TTL);
    timers.current.add(timer);
  }, [handoffs, ready]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current.clear(); }, []);
  return events;
}

/** 路径只存在 1.1s;端点按和桌位完全相同的尺寸换算,不参与点击。 */
export function HandoffOverlay({ events, meta, size }: { events: HandoffEvent[]; meta: RoleMetaMap; size: { w: number; h: number } }) {
  const reduced = useReducedMotion();
  if (!events.length || reduced) return null;
  return <svg className="of-handoff-overlay" viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" aria-hidden="true">
    {events.map((event) => {
      const from = meta[event.from]; const to = meta[event.to];
      if (!from || !to) return null;
      const x1 = from.x * size.w / 100; const y1 = from.y * size.h / 100;
      const x2 = to.x * size.w / 100; const y2 = to.y * size.h / 100;
      const dx = x2 - x1; const dy = y2 - y1;
      const distance = Math.hypot(dx, dy) || 1;
      const ux = dx / distance; const uy = dy / distance;
      const ax = x2 - ux * 24; const ay = y2 - uy * 24;
      return <g key={event.key} className="of-handoff-path" data-handoff={event.key}>
        <path d={`M ${x1} ${y1} L ${x2} ${y2}`} />
        <path className="of-handoff-arrow" d={`M ${ax - ux * 8 - uy * 4} ${ay - uy * 8 + ux * 4} L ${ax} ${ay} L ${ax - ux * 8 + uy * 4} ${ay - uy * 8 - ux * 4}`} />
        <circle cx={x1} cy={y1} r="4" /><circle cx={x2} cy={y2} r="7" />
      </g>;
    })}
  </svg>;
}
