/**
 * 楼层动效的「事件 → 短暂脉冲」翻译器(评审口径:只做有证据的,见
 * docs/design/ui-consistency-agent-page-2026-09-06.md §4/§6)。
 *
 * 每个脉冲都对应一个真实事件,1–3 秒后自动消失,叠在 presence 之上;presence 本身不由这里改。
 *   - nod   :某条真交接从 pending 变 acked → 接收方点头(人已阅,不代表接手/授权)
 *   - stamp :entry_filled / tp_hit / sl_hit / protection_placed → EXEC 盖章
 *   - done  :recent_episodes[0] 换了 → THREAD 头顶显示该次判断的动作(WATCH / PROPOSE …)
 *   - say   :对话里 agent 新回复 → HELM 头顶打字机(前 40 字);用户新发言 → HELM「…」
 *   - ping  :真交接新建 → 发送方举一下(飞包动画在 deck.tsx,这里只管发送方)
 */
import { useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import type { ActivityItem, ChatMessage, EpisodeSummary } from '@/api/types';
import type { BotHandoff, BotRole } from './types';

export type PulseKind = 'nod' | 'stamp' | 'done' | 'say' | 'ping' | 'listen';

export interface Pulse {
  kind: PulseKind;
  text: string | null;
  until: number;
}

export type Pulses = Partial<Record<BotRole, Pulse>>;

const TTL: Record<PulseKind, number> = { nod: 1400, stamp: 1200, done: 2600, say: 4000, ping: 900, listen: 2500 };

const STAMP_KINDS = new Set(['entry_filled', 'tp_hit', 'sl_hit', 'protection_placed', 'thread_canceled']);

export function useFloorPulses(inp: { handoffs: BotHandoff[]; activity: ActivityItem[]; episodes: EpisodeSummary[]; chat: ChatMessage[]; now: number }): Pulses {
  const [pulses, setPulses] = useState<Pulses>({});
  const seen = useRef<{ handoffStatus: Map<string, string>; lastActivity: string | null; lastEpisode: string | null; lastChat: string | null; primed: boolean }>({
    handoffStatus: new Map(),
    lastActivity: null,
    lastEpisode: null,
    lastChat: null,
    primed: false,
  });

  const fire = (role: BotRole, kind: PulseKind, text: string | null, at: number) => setPulses((p) => ({ ...p, [role]: { kind, text, until: at + TTL[kind] } }));

  // 交接:新建 → 发送方 ping;pending→acked → 接收方 nod
  useEffect(() => {
    const s = seen.current;
    const now = Date.now();
    for (const h of inp.handoffs) {
      const prev = s.handoffStatus.get(h.handoff_id);
      if (prev === undefined) {
        if (s.primed) fire(h.from_role, 'ping', null, now);
      } else if (prev === 'pending' && h.status === 'acked') {
        fire(h.to_role, 'nod', t('已读'), now);
      }
      s.handoffStatus.set(h.handoff_id, h.status);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inp.handoffs]);

  // 活动:成交/止损/止盈/保护腿 → EXEC 盖章
  useEffect(() => {
    const s = seen.current;
    const latest = inp.activity[0];
    if (!latest) return;
    if (s.lastActivity && latest.id !== s.lastActivity && STAMP_KINDS.has(latest.kind)) fire('executor', 'stamp', latest.title, Date.now());
    s.lastActivity = latest.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inp.activity]);

  // 判断结束 → THREAD 头顶显示动作
  useEffect(() => {
    const s = seen.current;
    const ep = inp.episodes[0];
    if (!ep) return;
    if (s.lastEpisode && ep.id !== s.lastEpisode) fire('thread_manager', 'done', `${ep.symbol} ${ep.action ?? '—'}`, Date.now());
    s.lastEpisode = ep.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inp.episodes]);

  // 对话 → HELM
  useEffect(() => {
    const s = seen.current;
    const last = inp.chat[inp.chat.length - 1];
    if (!last) return;
    if (s.lastChat && last.id !== s.lastChat) {
      if (last.role === 'agent') fire('gate_captain', 'say', last.text.replace(/\s+/g, ' ').slice(0, 40), Date.now());
      else if (last.role === 'user') fire('gate_captain', 'listen', '…', Date.now());
    }
    s.lastChat = last.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inp.chat]);

  // 第一次数据到齐后才开始对「新建」做动效,避免刷新页面时全场乱飞
  useEffect(() => {
    if (!seen.current.primed && inp.handoffs.length >= 0 && inp.activity.length > 0) seen.current.primed = true;
  }, [inp.handoffs.length, inp.activity.length]);

  // 过期清理
  useEffect(() => {
    setPulses((p) => {
      let changed = false;
      const next: Pulses = {};
      for (const [k, v] of Object.entries(p) as [BotRole, Pulse][]) {
        if (v.until > inp.now) next[k] = v;
        else changed = true;
      }
      return changed ? next : p;
    });
  }, [inp.now]);

  return pulses;
}
