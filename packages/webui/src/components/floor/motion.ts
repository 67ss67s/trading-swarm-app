/** 有证据的走动:和连线共用新交接 / 已阅事件,不在待机时随机踱步。 */
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './ambient';
import type { HandoffEvent } from './handoff-overlay';
import type { RoleMetaMap } from './roles';
import type { BotRole } from './types';

export interface Motion {
  dx: number; dy: number; facing: 'left' | 'right'; walking: boolean;
  carrying: boolean; ms: number;
}
export type Motions = Partial<Record<BotRole, Motion>>;
const REST: Motion = { dx: 0, dy: 0, facing: 'right', walking: false, carrying: false, ms: 0 };

export function useFloorMotions({ events, meta, size }: { events: HandoffEvent[]; meta: RoleMetaMap; size: { w: number; h: number } }): Motions {
  const [motions, setMotions] = useState<Motions>({});
  const reduced = useReducedMotion();
  const played = useRef(new Set<string>());
  const busy = useRef(new Set<BotRole>());
  const timers = useRef(new Set<number>());
  useEffect(() => {
    if (reduced) {
      timers.current.forEach((t) => window.clearTimeout(t)); timers.current.clear();
      busy.current.clear(); setMotions({});
      played.current = new Set(events.map((e) => e.key));
      return;
    }
    const later = (fn: () => void, ms: number) => {
      const t = window.setTimeout(() => { timers.current.delete(t); fn(); }, ms);
      timers.current.add(t);
    };
    const set = (role: BotRole, m: Partial<Motion>) => setMotions((cur) => ({ ...cur, [role]: { ...REST, ...cur[role], ...m } }));
    for (const event of events) {
      if (played.current.has(event.key)) continue;
      played.current.add(event.key);
      const from = meta[event.from]; const to = meta[event.to];
      if (!from || !to || busy.current.has(event.from) || busy.current.has(event.to)) continue;
      busy.current.add(event.from); busy.current.add(event.to);
      const dx = (to.x - from.x) * size.w / 100;
      const dy = (to.y - from.y) * size.h / 100;
      const distance = Math.hypot(dx, dy) || 1;
      const stop = Math.max(0, distance - 60) / distance;
      const ms = Math.max(350, Math.round(distance * stop / 220 * 1000));
      set(event.to, { facing: dx > 0 ? 'left' : 'right' });
      set(event.from, { dx: dx * stop, dy: dy * stop, facing: dx < 0 ? 'left' : 'right', walking: true, carrying: true, ms });
      later(() => {
        set(event.from, { walking: false, carrying: false });
        later(() => {
          set(event.from, { dx: 0, dy: 0, walking: true, facing: dx < 0 ? 'right' : 'left' });
          later(() => {
            set(event.from, REST); set(event.to, REST);
            busy.current.delete(event.from); busy.current.delete(event.to);
          }, ms);
        }, event.kind === 'ack' ? 500 : 800);
      }, ms);
    }
    played.current = new Set(events.map((e) => e.key));
  }, [events, meta, size, reduced]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current.clear(); busy.current.clear(); }, []);
  return motions;
}
