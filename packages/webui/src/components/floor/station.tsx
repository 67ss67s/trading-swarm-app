import type { CSSProperties } from 'react';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { DeckAgent } from './deck';
import type { Pulses } from './animator';
import type { Motion } from './motion';
import type { RoleMetaMap } from './roles';
import type { BotRole, PresenceState } from './types';
import { Sprite } from './sprite';
import type { EvoDay } from '@/api/evolution';
import { DayGrid } from '@/components/evolution/day-grid';

const BUBBLE_STATE: Partial<Record<PresenceState, string>> = { blocked: 'of-b-blocked', waiting: 'of-b-waiting', off: 'of-b-off' };
const STEPS = ['fetching', 'context', 'thinking', 'validating', 'gating', 'executing'] as const;
const STATE_LABEL: Record<PresenceState, string> = tmap({ idle: '待命', thinking: '思考', working: '干活中', waiting: '等着', blocked: '卡住', done: '完成', off: '未接线' });
const STATUS: Record<PresenceState, string> = { idle: 'var(--of-ink-faint)', thinking: 'var(--of-info)', working: 'var(--of-accent)', waiting: 'var(--of-warn)', blocked: 'var(--of-danger)', done: 'var(--of-info)', off: 'var(--of-ink-faint)' };

/** 共享工位:显示的是 presence 与真实步骤,装饰不会编造行情或任务进度。 */
export function AgentStation({ a, meta, selected, onSelect, pulse, step, motion, highlight, animateLed, evo }: {
  a: DeckAgent; meta: RoleMetaMap; selected: boolean; onSelect: () => void;
  pulse: Pulses[BotRole]; step: string | null; motion: Motion | undefined;
  highlight: boolean; animateLed: boolean;
  /** 最近 30 天进化方格(/api/evolution/daily);接口没就绪时不画 */
  evo?: { days: EvoDay[]; to: string } | null;
}) {
  const m = meta[a.role];
  const big = a.role === 'gate_captain';
  const thinking = a.presence.state === 'thinking';
  // 保持原来的气泡内容和优先级。
  const bubble = pulse?.text ?? a.overlay?.text ?? a.presence.action ?? (a.lastLine ? a.lastLine.summary : null);
  const showBubble = Boolean(bubble) && (Boolean(pulse) || Boolean(a.overlay) || a.presence.state !== 'idle');
  const bubbleClass = pulse ? `of-b-${pulse.kind}` : a.overlay ? (a.overlay.tone === 'danger' ? 'of-b-blocked' : 'of-b-waiting') : BUBBLE_STATE[a.presence.state];
  const stepIdx = a.role === 'thread_manager' && step ? STEPS.indexOf(step as (typeof STEPS)[number]) : -1;
  return (
    <div className={cn('of-desk', big && 'of-big', selected && 'of-selected', highlight && 'of-handoff-lit')}
      data-role={a.role} data-state={a.presence.state}
      style={{ left: `${m.x}%`, top: `${m.y}%`, '--of-role': m.color, '--seat': m.color, '--of-status': STATUS[a.presence.state] } as CSSProperties}
      onClick={onSelect} role="button" tabIndex={0} aria-pressed={selected}
      aria-label={`${m.callsign} · ${m.desk} · ${STATE_LABEL[a.presence.state]}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      title={a.enabled ? t(a.name) : `${t(a.name)}(${t('还没接线')})${a.note ? `:${t(a.note)}` : ''}`}>
      {a.presence.state !== 'off' ? <span aria-hidden="true" className={cn('of-spot', (a.presence.state === 'working' || thinking) && 'of-spot-live')} /> : null}
      {big ? <span aria-hidden="true" className="of-council-core"><i /><b /></span> : null}
      {showBubble ? <span className={cn('of-desk-bubble', bubbleClass, pulse?.kind === 'say' && 'of-typewriter')} title={bubble ?? undefined}>
        {thinking && !pulse ? <span className="of-dots"><i /><i /><i /></span> : null}<span className="of-bubble-text">{bubble}</span>
      </span> : null}
      <span className="of-desk-sprite" style={{ transform: `translate(calc(-50% + ${motion?.dx ?? 0}px), ${motion?.dy ?? 0}px)`, transition: `transform ${motion?.ms ?? 0}ms linear` }}>
        <Sprite rows={m.sprite} color={m.color} px={big ? 5 : 4} state={a.presence.state} walking={motion?.walking} facing={motion?.facing} pulseClass={pulse ? `of-pulse-${pulse.kind}` : undefined} />
        {motion?.carrying ? <span className="of-carry" title={t('交接单')} /> : null}<span className="of-shadow" />
      </span>
      <div className="of-desk-table">
        <span className="of-monitor-stand" aria-hidden="true" />
        <span className={cn('of-desk-screen', (a.presence.state === 'working' || thinking) && 'of-screen-live')}>
          <span className="of-terminal-heading"><span className="of-status-led" />{STATE_LABEL[a.presence.state]}</span>
          {stepIdx >= 0 ? <span className="of-steps" title={t('步骤 {step}', { step })}>
            {STEPS.map((st, i) => <b key={st} style={{ background: i <= stepIdx ? m.color : undefined, opacity: i === stepIdx ? 1 : 0.5 }} />)}
          </span> : <span className="of-terminal-lines" aria-hidden="true"><i /><i /><i /><b className={cn('of-terminal-cursor', a.role === 'radar' && 'of-ambient-cursor')} /></span>}
        </span>
        <span aria-hidden="true" className="of-keyboard" />
        <span aria-hidden="true" className="of-desk-lamp"><i className={cn('of-lamp-glow', a.role === 'strategy_lab' && 'of-ambient-lamp')} /><b /></span>
        <span aria-hidden="true" className={cn('of-desk-props', (a.role === 'portfolio_manager' || a.role === 'reviewer') && 'of-props-paper')}><i /><b /></span>
        <span className="of-desk-front" aria-hidden="true"><i className={cn('of-status-led', animateLed && a.presence.state !== 'off' && 'of-ambient-led')} /><b /><b /><b /></span>
        <span aria-hidden="true" className="of-desk-leg of-desk-leg-l" /><span aria-hidden="true" className="of-desk-leg of-desk-leg-r" />
      </div>
      <span className="of-desk-name"><span style={{ color: a.enabled ? m.color : undefined }}>{m.callsign}</span><span>{m.desk}</span></span>
      {/* 2026-09-23 进化:桌牌下一条最近 30 天方格,点格子去 #evolution?role=…&date=…(点击不冒泡成选桌) */}
      {evo ? <span className="of-desk-evo" onClick={(e) => e.stopPropagation()}>
        <DayGrid mode="compact" days={evo.days} to={evo.to} compactDays={30} cell={3} gap={1} label={t('{who} 最近 30 天', { who: m.callsign })}
          onSelect={(d) => { window.location.hash = `evolution?role=${a.role}&date=${d.date}`; }} />
      </span> : null}
    </div>
  );
}
