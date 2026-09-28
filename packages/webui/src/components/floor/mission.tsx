/**
 * 楼层左栏:Mission Source(信息员最新总结)+ 收件箱 + 写者围栏说明;底部是选中 agent 卡。
 */
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Overview } from '@/api/types';
import { BIAS_LABEL, REGIME_LABEL, relativeTime } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { DeckAgent } from './deck';
import type { RoleMetaMap } from './roles';
import { Sprite } from './sprite';
import type { BotProfileWithPresence, BotRole, FeedItem } from './types';
import { useState } from 'react';
import { BrainControls } from '@/components/brain-controls';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { roleBrainDisplay, SLOT_LABEL, SLOT_ROLES } from '@/lib/role-brain';
import type { LoopView, ModelsView } from '@/api/types';
import { MODEL_ROLE_LABEL } from '@/components/models/logic';

const PRESENCE_LABEL: Record<string, string> = tmap({ idle: '待命', thinking: '思考中', working: '干活中', waiting: '等着', blocked: '卡住', done: '完成', off: '未接线' });

export function MissionSource({ overview, now, pendingHandoffs, needsApproval, meta }: { overview: Overview | null | undefined; now: number; pendingHandoffs: FeedItem[]; needsApproval: FeedItem[]; meta: RoleMetaMap }) {
  const ms = overview?.market_state;
  const usage = overview?.usage_today;
  const inbox = pendingHandoffs.length + needsApproval.length;
  return (
    <div className="flex flex-col gap-2">
      <div className="of-panel p-3">
        <div className="flex items-center">
          <span className="of-kicker">{t('市场状态')}</span>
          <span className="ml-auto text-[10px]" style={{ color: ms ? 'var(--of-accent)' : 'var(--of-ink-faint)' }}>
            {ms ? t('信息员在线') : t('还没数据')}
          </span>
        </div>
        <div className="of-title mt-1 text-sm">{ms ? `${REGIME_LABEL[ms.regime] ?? ms.regime} · ${BIAS_LABEL[ms.bias] ?? ms.bias}` : t('信息员还没出总结')}</div>
        {ms ? <div className="mt-1 line-clamp-6 text-[10px] leading-4 text-[var(--of-ink-dim)]">{ms.summary}</div> : null}
        {ms ? (
          <div className="mt-1 text-[9px] text-[var(--of-ink-faint)]">
            {relativeTime(ms.as_of, now)} · {ms.model}
          </div>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-px bg-[var(--of-line)]">
          <Stat label={t('信息源')} value={ms ? ms.majors.length + ms.news.length + ms.top_movers.length : 0} />
          <Stat label={t('今日判断')} value={usage?.judgments ?? 0} />
          <Stat label={t('候选')} value={ms?.candidates.length ?? 0} />
          <Stat label={t('风险事件')} value={ms?.risk_events.length ?? 0} warn={(ms?.risk_events.length ?? 0) > 0} />
        </div>
      </div>

      <div className={cn('of-panel p-3', inbox > 0 && 'border-[var(--of-warn)]')}>
        <div className="of-kicker" style={{ color: inbox > 0 ? 'var(--of-warn)' : undefined }}>
          {t('收件箱')}
        </div>
        <div className="of-title mt-1 text-base" style={{ color: inbox > 0 ? 'var(--of-warn)' : 'var(--of-ink)' }}>
          {inbox > 0 ? t('{n} 件待处理', { n: inbox }) : t('收件箱空')}
        </div>
        <div className="mt-1 text-[10px] leading-4 text-[var(--of-ink-dim)]">
          {pendingHandoffs.length ? t('{n} 条 bot 交接待读', { n: pendingHandoffs.length }) : null}
          {pendingHandoffs.length && needsApproval.length ? ' · ' : null}
          {needsApproval.length ? t('{n} 个提案等你批', { n: needsApproval.length }) : null}
          {!inbox ? t('交接和审批都会落到这里;bot 之间说什么都不算授权。') : null}
        </div>
        {inbox > 0 ? (
          <ul className="mt-2 space-y-1">
            {[...needsApproval, ...pendingHandoffs].slice(0, 3).map((f) => (
              <li key={f.id} className="border-l-2 border-[var(--of-warn)] pl-2 text-[9px] leading-3.5">
                <div className="truncate text-[var(--of-ink)]" title={f.summary}>
                  {f.summary}
                </div>
                <div className="text-[var(--of-ink-faint)]">
                  {t('等了 {t} · 责任人 {who}', { t: relativeTime(f.at, now), who: meta[f.from === 'user' ? 'gate_captain' : f.from].callsign })} ·{' '}
                  <a className="underline" href={f.source === 'handoff' ? (f.handoff?.subject.type === 'screen' ? '#screener' : f.handoff?.subject.type === 'memory_proposal' ? '#memory' : f.handoff?.subject.type === 'strategy_experiment' ? '#strategies' : '#agent') : '#agent'}>
                    {t('去处理 →')}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="bg-[var(--of-panel)] px-2 py-1.5">
      <div className="of-kicker">{label}</div>
      <div className="of-title text-base" style={{ color: warn ? 'var(--of-danger)' : undefined }}>
        {String(value).padStart(2, '0')}
      </div>
    </div>
  );
}

export function WriterFence({ profiles }: { profiles: BotProfileWithPresence[] }) {
  const writers = profiles.filter((p) => p.capabilities.includes('exchange.write')).map((p) => p.role);
  const ok = writers.length === 1 && writers[0] === 'executor';
  return (
    <div className="of-panel p-3">
      <div className="of-kicker" style={{ color: ok ? 'var(--of-info)' : 'var(--of-danger)' }}>
        {ok ? t('写者围栏正常') : t('写者围栏被破坏')}
      </div>
      <div className="of-title mt-1 text-xs">{ok ? t('只有 Executor 能写交易所') : t('拿着 exchange.write 的:{list}', { list: writers.join(', ') || t('无') })}</div>
      <div className="mt-1 text-[9px] leading-3.5 text-[var(--of-ink-dim)]">{t('楼层只读:每个角色在干什么这里都看得到,但改不了任何东西;动钱只走 Agent 页的审批 + 代码闸。')}</div>
    </div>
  );
}

export function SelectedAgentCard({ agent, profile, onOpen, meta, loop, models }: { agent: DeckAgent | null; profile: BotProfileWithPresence | null; onOpen: (page: string) => void; meta: RoleMetaMap; loop?: Pick<LoopView, 'brain' | 'cheap_brain'> | null; models?: ModelsView | null }) {
  if (!agent || !profile) {
    return (
      <div className="of-panel p-3 text-[10px] text-[var(--of-ink-dim)]">
        <div className="of-kicker">{t('选中的角色')}</div>
        <div className="mt-1">{t('点楼层上的桌子,或右栏的角色,看详情。')}</div>
      </div>
    );
  }
  const m = meta[agent.role];
  return <SelectedAgentBody agent={agent} profile={profile} onOpen={onOpen} m={m} meta={meta} loop={loop} models={models} />;
}

function SelectedAgentBody({ agent, profile, onOpen, m, meta, loop, models }: { agent: DeckAgent; profile: BotProfileWithPresence; onOpen: (page: string) => void; m: RoleMetaMap[BotRole]; meta: RoleMetaMap; loop?: Pick<LoopView, 'brain' | 'cheap_brain'> | null; models?: ModelsView | null }) {
  // §9.52:优先读 ModelsView.effective;老网关(没有 /api/models)回退两槽推断
  const brain = roleBrainDisplay(agent.role, models, loop);
  const [brainOpen, setBrainOpen] = useState(false);
  // 「和它对话」= 新建一个对着该角色的会话(POST /api/chat/sessions {role}),记为当前会话,跳 Agent 页
  const talk = useMutation({
    mutationFn: () => api.createChatSession(undefined, agent.role),
    onSuccess: (r) => {
      try {
        window.localStorage.setItem('tg.chat.session', r.session.id);
      } catch {
        /* ignore */
      }
      window.location.hash = 'agent';
    },
    onError: (e: Error) => toast.error(t('开不了会话:{msg}', { msg: e.message })),
  });
  return (
    <div className="of-panel p-3" style={{ borderLeft: `2px solid ${m.color}` }}>
      <div className="flex items-start gap-3">
        <Sprite rows={m.sprite} color={m.color} px={4} state={agent.presence.state} />
        <div className="min-w-0 flex-1">
          <div className="of-kicker">{t('选中的角色')} · {m.badge}</div>
          <div className="of-title text-sm leading-4" style={{ color: m.color }}>
            {m.callsign}
          </div>
          <div className="text-[10px] text-[var(--of-ink)]">{m.title}</div>
          <div className="text-[10px] text-[var(--of-ink-dim)]">{t(profile.name)}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 text-[10px]">
        <i className={cn('of-dot', `of-dot-${agent.presence.state}`)} />
        <span>{PRESENCE_LABEL[agent.presence.state]}</span>
        <span className="text-[var(--of-ink-dim)]">{agent.presence.action ?? (agent.enabled ? '' : (profile.note ? t(profile.note) : t('还没接线')))}</span>
      </div>
      <dl className="mt-2 space-y-1 text-[9px] leading-3.5">
        {brain ? (
          <div className="flex items-center gap-1">
            <dt className="inline text-[var(--of-ink-faint)]">{t('模型')} · </dt>
            <dd
              className="num inline min-w-0 flex-1 truncate text-[var(--of-ink)]"
              style={brain.broken ? { color: 'var(--of-danger)' } : undefined}
              title={
                brain.broken
                  ? t('绑定的连接失效了,这个角色调用会直接报错,不会静默回退')
                  : brain.source === 'slot' && brain.slot
                    ? t('{slot};同槽位的角色:{roles}', { slot: SLOT_LABEL[brain.slot], roles: SLOT_ROLES[brain.slot].map((r) => meta[r].callsign).join(' / ') })
                    : t('{role}角色 · {source}', { role: brain.modelRole ? MODEL_ROLE_LABEL[brain.modelRole] : '', source: brain.sourceLabel })
              }
            >
              {brain.broken ? <i className="mr-1 inline-block size-1.5 rounded-full align-middle" style={{ background: 'var(--of-danger)' }} /> : null}
              {brain.name} <span className="text-[var(--of-ink-faint)]">({brain.sourceLabel})</span>
            </dd>
            <Popover open={brainOpen} onOpenChange={setBrainOpen}>
              <PopoverTrigger asChild>
                <button type="button" className="shrink-0 border border-[var(--of-line)] px-1.5 py-0.5 text-[9px] text-[var(--of-ink-dim)] hover:bg-[var(--of-panel-2)] aria-expanded:bg-[var(--of-panel-2)]" title={t('换这个角色用的大脑(同槽位的角色会一起换)')}>
                  {t('换')}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-96 p-0">
                {brain.source === 'slot' && brain.slot ? (
                  <div className="border-b px-3 py-2 text-[11px] text-muted-foreground">
                    {t('{who} 用的是 ', { who: m.callsign })}
                    <span className="font-semibold text-foreground">{SLOT_LABEL[brain.slot]}</span>
                    {t('。网关只有两个大脑槽,切了会连带 {roles} 一起换。按角色单独钉模型(model_pin)网关还没读,做了再放开。', { roles: SLOT_ROLES[brain.slot].filter((r) => r !== agent.role).map((r) => meta[r].callsign).join(' / ') || t('无') })}
                  </div>
                ) : (
                  <div className="border-b px-3 py-2 text-[11px] text-muted-foreground">
                    {t('{who} 走「{role}」角色底层,当前', { who: m.callsign, role: brain.modelRole ? MODEL_ROLE_LABEL[brain.modelRole] : '' })}
                    <span className="font-semibold text-foreground"> {brain.sourceLabel} · {brain.name}</span>
                    {brain.slot ? t('。它没单独绑定,改下面的回退槽位会连带其它未绑定角色;想单独绑去「模型连接」。') : t('。在「模型连接」里改绑定。')}
                    <a href="#models" className="ml-1 text-primary hover:underline" onClick={() => setBrainOpen(false)}>
                      {t('去模型连接 →')}
                    </a>
                  </div>
                )}
                {brain.slot ? <BrainControls idPrefix={`floor-${agent.role}`} onApplied={() => setBrainOpen(false)} /> : null}
              </PopoverContent>
            </Popover>
          </div>
        ) : (
          <div>
            <dt className="inline text-[var(--of-ink-faint)]">{t('模型')} · </dt>
            <dd className="inline text-[var(--of-ink-dim)]">{t('不调模型(纯代码 / 执行面)')}</dd>
          </div>
        )}
        <div>
          <dt className="inline text-[var(--of-ink-faint)]">{t('负责')} · </dt>
          <dd className="inline text-[var(--of-ink-dim)]">{t(profile.description)}</dd>
        </div>
        <div>
          <dt className="inline text-[var(--of-ink-faint)]">{t('边界')} · </dt>
          <dd className="inline text-[var(--of-ink-dim)]">{t(profile.approval_boundary)}</dd>
        </div>
        <div>
          <dt className="inline text-[var(--of-ink-faint)]">{t('能力')} · </dt>
          <dd className="inline text-[var(--of-ink-dim)]">{profile.capabilities.join(' · ')}</dd>
        </div>
      </dl>
      <div className="mt-2 flex flex-wrap gap-1">
        <button type="button" className="border px-2 py-1 text-[10px] hover:bg-[var(--of-panel-2)]" style={{ borderColor: m.color, color: m.color }} disabled={talk.isPending || agent.presence.state === 'off'} title={t('新开一个对着 {who} 的会话,agent 用它的口径回答', { who: m.callsign })} onClick={() => talk.mutate()}>
          {t('和 {who} 对话 →', { who: m.callsign })}
        </button>
        <button type="button" className="border border-[var(--of-line)] px-2 py-1 text-[10px] text-[var(--of-ink-dim)] hover:bg-[var(--of-panel-2)]" onClick={() => onOpen(m.page)}>
          {t('工作台')} · {m.pageLabel}
        </button>
      </div>
    </div>
  );
}
