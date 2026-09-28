/**
 * 楼层右栏:Agent Council(8 角色 tile + AI/CODE/EXEC 徽章)+ Live Handoffs 流。
 * 交接流里真 bot_handoffs 行(实线左边)与 activity 映射行(点线左边)视觉区分(设计稿 §4);
 * 待阅的真交接可以 ack(= 已阅);subject.type='screen' 且带 watchlist 提案的,只预览 before → after
 * diff,应用去筛选页确认(楼层只读,Codex 评审 §8)。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { relativeTime } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { DeckAgent } from './deck';
import { roleCallsign, roleColor, type RoleMetaMap } from './roles';
import { Sprite } from './sprite';
import type { BotRole, FeedItem } from './types';
import { roleBrainDisplay } from '@/lib/role-brain';
import type { LoopView, ModelsView } from '@/api/types';
import { MODEL_ROLE_LABEL } from '@/components/models/logic';

const BADGE_CLASS = { AI: 'border-[#5ec8ff55] text-[#5ec8ff]', CODE: 'border-[#ff5d8f55] text-[#ff5d8f]', EXEC: 'border-[#4fd1c555] text-[#4fd1c5]' } as const;

export function Council({ meta, agents, selected, onSelect, rosterSource, riskLevel, loop, models }: { meta: RoleMetaMap; agents: DeckAgent[]; selected: BotRole | null; onSelect: (r: BotRole) => void; rosterSource: 'gateway' | 'local'; riskLevel: 'none' | 'warn' | 'high' | 'critical' | null; loop?: Pick<LoopView, 'brain' | 'cheap_brain'> | null; models?: ModelsView | null }) {
  const online = agents.filter((a) => a.presence.state !== 'off').length;
  return (
    <div className="of-panel flex flex-col">
      <div className="flex items-center border-b border-[var(--of-line)] px-3 py-1.5">
        <span className="of-kicker">{t('团队')}</span>
        <span className="ml-auto text-[10px]" style={{ color: 'var(--of-accent)' }}>
          {t('{online} / {total} 在线', { online, total: agents.length })}
        </span>
      </div>
      {rosterSource === 'local' ? <div className="border-b border-[var(--of-line)] px-3 py-1 text-[9px] text-[var(--of-warn)]">{t('名册走的本地兜底,网关还没提供 /api/bots')}</div> : null}
      <div className="grid grid-cols-2 gap-px bg-[var(--of-line)]">
        {agents.map((a) => {
          const m = meta[a.role];
          const sel = selected === a.role;
          return (
            <button
              key={a.role}
              type="button"
              onClick={() => onSelect(a.role)}
              className={cn('flex items-center gap-2 bg-[var(--of-panel)] px-2 py-2 text-left hover:bg-[var(--of-panel-2)]', sel && 'outline outline-1 outline-[var(--of-danger)]')}
              title={a.presence.action ?? (a.note ? t(a.note) : t(a.name))}
            >
              <Sprite rows={m.sprite} color={m.color} px={2.5} state={a.presence.state} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1">
                  <i className={cn('of-dot', `of-dot-${a.presence.state}`)} />
                  <span className="truncate text-[9px] font-bold tracking-wide" style={{ color: a.enabled ? m.color : 'var(--of-ink-faint)' }}>
                    {m.callsign}
                  </span>
                  {a.role === 'risk_sentinel' && riskLevel && riskLevel !== 'none' ? (
                    <span className="rounded-sm border px-1 text-[8px] leading-3" style={{ color: riskLevel === 'warn' ? 'var(--of-warn)' : 'var(--of-danger)', borderColor: 'currentColor' }}>
                      {riskLevel}
                    </span>
                  ) : null}
                  <span className={cn('ml-auto rounded-sm border px-1 text-[8px] leading-3', BADGE_CLASS[m.badge])}>{m.badge}</span>
                </span>
                <span className="block truncate text-[9px] text-[var(--of-ink-dim)]">{m.title}</span>
                {(() => {
                  // §9.52:读 ModelsView.effective(绑定 / 回退主脑 / 回退副脑 / 未设置);老网关回退两槽推断
                  const b = roleBrainDisplay(a.role, models, loop);
                  if (!b) return null;
                  const title = b.broken
                    ? t('{role} 绑定的连接失效了,调用会直接报错(去「模型连接」修)', { role: b.modelRole ? MODEL_ROLE_LABEL[b.modelRole] : m.callsign })
                    : t('{slot}:{name}(点开选中卡可以换)', { slot: b.sourceLabel, name: b.name });
                  return (
                    <span className="num flex items-center gap-1 truncate text-[8.5px] text-[var(--of-ink-faint)]" title={title}>
                      {b.broken ? <i className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: 'var(--of-danger)' }} /> : null}
                      <span className="truncate" style={b.broken ? { color: 'var(--of-danger)' } : undefined}>
                        {b.sourceLabel} · {b.name}
                      </span>
                    </span>
                  );
                })()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 交接流

const KIND_LABEL: Record<string, string> = tmap({ request: '请求', result: '结果', review: '审查', alert: '告警', blocked: '卡住' });
const KIND_COLOR = { request: 'var(--of-info)', result: 'var(--of-accent)', review: 'var(--of-warn)', alert: 'var(--of-danger)', blocked: 'var(--of-danger)' } as const;

function proposalSymbols(payload: Record<string, unknown> | null): string[] | null {
  if (!payload) return null;
  const p = payload['proposal'];
  if (p && typeof p === 'object' && Array.isArray((p as { symbols?: unknown }).symbols)) return (p as { symbols: unknown[] }).symbols.map(String);
  if (Array.isArray(payload['symbols'])) return (payload['symbols'] as unknown[]).map(String);
  return null;
}

function FeedRow({ f, now, watchlist, meta }: { f: FeedItem; now: number; watchlist: string[]; meta: RoleMetaMap }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ack = useMutation({
    mutationFn: (id: string) => api.ackHandoff(id),
    onSuccess: () => {
      toast.success(t('已标记为已读'));
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const h = f.handoff;
  const proposal = h ? proposalSymbols(h.payload) : null;
  const canApply = h && h.subject.type === 'screen' && proposal && proposal.length > 0;
  const added = proposal ? proposal.filter((s) => !watchlist.includes(s)) : [];
  const removed = proposal ? watchlist.filter((s) => !proposal.includes(s)) : [];
  return (
    <div className={cn('of-feed-row', f.source === 'handoff' ? 'of-real' : 'of-mapped', f.dim && 'of-dim')}>
      <div className="flex items-center gap-1 text-[9px]">
        <span className="font-bold tracking-wider" style={{ color: roleColor(f.from, meta) }}>
          {roleCallsign(f.from, meta)}
        </span>
        <span className="text-[var(--of-ink-faint)]">→</span>
        <span className="font-bold tracking-wider" style={{ color: roleColor(f.to, meta) }}>
          {roleCallsign(f.to, meta)}
        </span>
        <span style={{ color: KIND_COLOR[f.kind] }}>· {f.activity_kind === 'proposal' ? t('出策略') : KIND_LABEL[f.kind] ?? f.kind}</span>
        {f.source === 'activity' ? <span className="rounded-sm border border-[var(--of-line)] px-1 text-[8px] text-[var(--of-ink-faint)]" title={t('这是单体代码里的一个事件,按角色归属画成箭头;不是两个 bot 之间真的交接过')}>{t('系统事件')}</span> : <span className="rounded-sm border border-[var(--of-accent)] px-1 text-[8px] text-[var(--of-accent)]" title={f.handoff?.handoff_id}>{t('交接')}</span>}
        {f.status === 'pending' ? <span className="text-[var(--of-warn)]">· {t('待读')}</span> : null}
        <span className="ml-auto text-[var(--of-ink-faint)]">{relativeTime(f.at, now)}</span>
      </div>
      <div className="mt-0.5 whitespace-pre-wrap break-words text-[10px] leading-4 text-[var(--of-ink)]">{f.summary}</div>
      {f.detail ? <div className="mt-0.5 line-clamp-2 text-[9px] leading-3.5 text-[var(--of-ink-dim)]">{f.detail}</div> : null}
      {h ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {h.status === 'pending' ? (
            <button type="button" className="border border-[var(--of-line)] px-1.5 py-0.5 text-[9px] hover:bg-[var(--of-panel-2)]" disabled={ack.isPending} onClick={() => ack.mutate(h.handoff_id)}>
              {t('已读')}
            </button>
          ) : null}
          {canApply ? (
            <button type="button" className="border border-[var(--of-accent)] px-1.5 py-0.5 text-[9px] text-[var(--of-accent)] hover:bg-[var(--of-panel-2)]" onClick={() => setOpen((v) => !v)}>
              {open ? t('收起') : t('看观察名单会变成什么')}
            </button>
          ) : null}
          {h.subject.type === 'screen' ? (
            <a className="text-[9px] text-[var(--of-ink-dim)] underline" href="#screener">
              {t('去筛选页')}
            </a>
          ) : null}
          {h.subject.type === 'strategy_experiment' ? (
            <a className="text-[9px] text-[var(--of-accent)] underline" href="#strategies" title={t('机械前瞻期望,不是策略成绩')}>
              {t('去策略库看实验')}
            </a>
          ) : null}
          {h.subject.type === 'memory_proposal' ? (
            <a className="text-[9px] text-[var(--of-accent)] underline" href="#memory" title={t('批次 {key}', { key: String((h.payload as { batch_key?: string } | null)?.batch_key ?? '') })}>
              {t('去记忆页批教训({n} 条)', { n: Array.isArray((h.payload as { memory_ids?: unknown[] } | null)?.memory_ids) ? ((h.payload as { memory_ids: unknown[] }).memory_ids.length) : '?' })}
            </a>
          ) : null}
        </div>
      ) : null}
      {open && canApply && proposal ? (
        <div className="mt-1 border border-[var(--of-line)] bg-[var(--of-panel-2)] p-2 text-[9px]">
          <div className="text-[var(--of-ink-dim)]">
            {t('现在 {a} 个 → 提案 {b} 个(应用会改 workflow.watchlist,也就改了自动判断的输入;楼层不落地,去筛选页确认)', { a: watchlist.length, b: proposal.length })}
          </div>
          {added.length ? (
            <div>
              <span className="text-[var(--of-accent)]">+ {t('加入')}</span> {added.join(' ')}
            </div>
          ) : null}
          {removed.length ? (
            <div>
              <span className="text-[var(--of-danger)]">− {t('移出')}</span> {removed.join(' ')}
            </div>
          ) : null}
          {!added.length && !removed.length ? <div>{t('和当前观察名单一样,不用应用。')}</div> : null}
          <div className="mt-1 flex gap-1">
            <a className="border border-[var(--of-accent)] px-1.5 py-0.5 text-[var(--of-accent)]" href="#screener" title={t('楼层只读:要应用观察名单,去筛选页确认')}>
              {t('去筛选页应用 →')}
            </a>
            <button type="button" className="border border-[var(--of-line)] px-1.5 py-0.5" onClick={() => setOpen(false)}>
              {t('取消')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function HandoffFeed({ feed, now, watchlist, meta }: { feed: FeedItem[]; now: number; watchlist: string[]; meta: RoleMetaMap }) {
  const real = feed.filter((f) => f.source === 'handoff').length;
  return (
    <div className="of-panel flex min-h-0 flex-1 flex-col">
      <div className="flex items-center border-b border-[var(--of-line)] px-3 py-1.5">
        <span className="of-kicker">{t('交接与事件')}</span>
        <span className="ml-auto text-[10px]" style={{ color: 'var(--of-accent)' }}>
          {t('实时 · 真交接 {n}', { n: real })}
        </span>
      </div>
      <div className="of-scroll min-h-0 flex-1 overflow-y-auto">
        {feed.length ? feed.map((f) => <FeedRow key={f.id} f={f} now={now} watchlist={watchlist} meta={meta} />) : <div className="p-3 text-[10px] text-[var(--of-ink-dim)]">{t('还没有交接记录。')}</div>}
      </div>
    </div>
  );
}
