/**
 * §9.55 起:下拉 = 九个 agent 的规范线程(与楼层对话框同一条)+ 下面的「其它会话」(手动新建的自由会话)。
 * 以前楼层每点一次「和它对话」就新建一个角色会话,下拉里会出现重复的 @MARKET / @BOOK;那些遗留会话后端迁移时归档,这里也不再列。
 * 规范线程不能归档/删除,只能清空。
 *
 * 对话会话条(v3-ui-contract §9.14):选会话 / 新建 / 改名 / 归档 / 删除 + 「允许执行」开关。
 * 允许执行 = 这个会话里我说执行,agent 就能把待批意图下到当前执行通道(多出 approve_intent / reject_intent 两个工具);
 * 默认关,切换要二次确认。default 会话不能删只能清空。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { BotRole, ChatSession } from '@/api/types';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AGENT_CALLSIGN, chatStateText, roleOfSession, useAgents } from '@/api/agents';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { getLang, t } from '@/lib/i18n';

const ROLE_CALLSIGN: Record<BotRole, string> = AGENT_CALLSIGN;

export const SESSION_KEY = 'tg.chat.session';

export function readSavedSession(): string {
  try {
    return window.localStorage.getItem(SESSION_KEY) || 'default';
  } catch {
    return 'default';
  }
}

export function ChatSessionBar({ session, onChange, compact }: { session: string; onChange: (id: string) => void; compact?: boolean }) {
  const qc = useQueryClient();
  const sessionsQ = useQuery({ queryKey: ['chat-sessions'], queryFn: () => api.chatSessions(false), retry: false });
  const sessions = sessionsQ.data?.sessions ?? [];
  const current: ChatSession | undefined = sessions.find((s) => s.id === session);
  const agentsQ = useAgents();
  const agents = agentsQ.data?.agents ?? [];
  const agentRole = roleOfSession(session);
  const agent = agentRole ? agents.find((a) => a.role === agentRole) ?? null : null;
  const canonical = agentRole !== null || current?.canonical === true;
  // 自由会话 = 不是规范线程、也不是遗留的角色会话
  const freeSessions = sessions.filter((s) => !roleOfSession(s.id) && !s.canonical && !s.role);
  const [confirmExec, setConfirmExec] = useState<null | boolean>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['chat-sessions'] });
  const create = useMutation({
    mutationFn: (title: string) => api.createChatSession(title),
    onSuccess: (r) => {
      invalidate();
      onChange(r.session.id);
      toast.success(t('新会话「{title}」', { title: r.session.title }));
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: (p: { id: string; patch: { title?: string; archived?: boolean; can_execute?: boolean } }) => api.updateChatSession(p.id, p.patch),
    onSuccess: (r, p) => {
      invalidate();
      if (p.patch.archived) onChange('default');
      if (p.patch.can_execute !== undefined) toast.success(p.patch.can_execute ? t('这个会话的意图卡会显示「执行…」按钮(还是要你两步确认)') : t('这个会话的意图卡不显示执行按钮'));
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteChatSession(id),
    onSuccess: () => {
      invalidate();
      onChange('default');
      toast.success(t('会话已删除'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rename = () => {
    if (!current) return;
    const name = window.prompt(t('会话名'), current.title);
    if (name && name.trim() && name.trim() !== current.title) update.mutate({ id: current.id, patch: { title: name.trim() } });
  };
  const newSession = () => {
    const name = window.prompt(t('新会话名'), t('会话 {date}', { date: new Date().toLocaleDateString(getLang() === 'en' ? 'en-US' : 'zh-CN') }));
    if (name && name.trim()) create.mutate(name.trim());
  };

  if (sessionsQ.isError && agentsQ.data?.fallback) return null; // 老网关没有会话接口:什么都不画,对话照旧
  const canExec = current?.can_execute ?? false;

  return (
    <div className={cn('flex shrink-0 flex-wrap items-center gap-1 border-b px-2 text-[11px]', compact ? 'py-0.5' : 'py-1')}>
      <Select value={session} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-6 max-w-[16rem] text-[11px]">
          <SelectValue placeholder={t('选择 agent')} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel className="text-[10px]">{t('九个 agent(和楼层同一条对话)')}</SelectLabel>
            {agents.map((a) => {
              const busy = a.chat.state !== 'idle';
              return (
                <SelectItem key={a.role} value={a.session_id} className="text-[11.5px]" disabled={!a.enabled}>
                  <span className="mr-1 inline-block min-w-[4.2rem] rounded-sm border border-primary/40 px-1 text-center text-[9px] text-primary">@{a.callsign}</span>
                  {a.name}
                  {a.message_count ? <span className="num ml-1 text-[10px] text-muted-foreground">{a.message_count}</span> : null}
                  {busy ? <span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-primary align-middle" /> : null}
                  {!a.enabled ? <span className="ml-1 text-[10px] text-muted-foreground">{t('已关')}</span> : null}
                </SelectItem>
              );
            })}
          </SelectGroup>
          {freeSessions.length ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel className="text-[10px]">{t('其它会话')}</SelectLabel>
                {freeSessions.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-[11.5px]">
                    {s.title}
                    <span className="num ml-1 text-[10px] text-muted-foreground">{s.message_count}</span>
                    {s.can_execute ? <span className="ml-1 text-[10px] text-muted-foreground">{t('显示执行')}</span> : null}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {/* 选中的是遗留角色会话(老数据):也放进来,否则下拉显示不出当前值 */}
          {current && !canonical && current.role ? (
            <SelectItem value={current.id} className="text-[11.5px]">
              {current.title} <span className="text-[10px] text-muted-foreground">{t('(旧会话)')}</span>
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {agent ? (
        <span className="min-w-0 truncate text-[10.5px] text-muted-foreground" title={agent.tagline}>
          {chatStateText(agent.chat) ? <span className="mr-1 text-primary">{chatStateText(agent.chat)}</span> : null}
          {agent.tagline}
        </span>
      ) : current?.role ? (
        <span className="rounded-sm border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary" title={t('这个会话里 agent 用这个角色的口径回答,优先用这个角色的工具')}>
          {t('对着')} @{ROLE_CALLSIGN[current.role] ?? current.role}
        </span>
      ) : null}
      <Button variant="ghost" size="icon-xs" title={t('新建会话')} onClick={newSession} disabled={create.isPending}>
        <Plus />
      </Button>
      <Button variant="ghost" size="icon-xs" title={t('改名')} onClick={rename} disabled={!current || canonical || update.isPending}>
        <Pencil />
      </Button>
      <Button variant="ghost" size="icon-xs" title={t('归档(还能在设置里找回)')} onClick={() => current && update.mutate({ id: current.id, patch: { archived: true } })} disabled={!current || canonical || update.isPending}>
        <Archive />
      </Button>
      <Button variant="ghost" size="icon-xs" title={canonical ? t('agent 的对话删不掉,只能清空') : t('删除会话')} onClick={() => setConfirmDelete(true)} disabled={!current || canonical || remove.isPending}>
        <Trash2 />
      </Button>

      <label className={cn('ml-auto flex items-center gap-1.5 rounded border px-1.5 py-0.5', canExec ? 'border-border text-foreground' : 'border-border text-muted-foreground')} title={t('只是显示偏好:开了,这个会话里的待批意图卡就显示「执行…」按钮。默认 agent 能在对话里自己批准执行;设置页开了「对话执行需我确认」才轮到你点。')}>
        <ShieldCheck className="size-3.5" />
        <span>{t('显示执行按钮')}</span>
        <Switch checked={canExec} disabled={!current || update.isPending} onCheckedChange={(v) => setConfirmExec(v)} className="scale-75" />
      </label>

      <ConfirmDialog
        open={confirmExec !== null}
        title={confirmExec ? t('在这个会话显示执行按钮?') : t('隐藏这个会话的执行按钮?')}
        summary={confirmExec ? t('确认显示') : t('确认隐藏')}
        danger={Boolean(confirmExec)}
        busy={update.isPending}
        onCancel={() => setConfirmExec(null)}
        onConfirm={() => {
          if (current && confirmExec !== null) update.mutate({ id: current.id, patch: { can_execute: confirmExec } });
          setConfirmExec(null);
        }}
      >
        <p>
          {confirmExec
            ? t('这只是显示偏好。默认 agent 在对话里可以自己批准执行(照样过全部代码闸);设置页开了「对话执行需我确认」之后,它只能推一张确认卡,由你两步点。')
            : t('隐藏之后这个会话的意图卡只剩「拒绝」;想执行去顶栏的「需要你点」。agent 的行为不变。')}
        </p>
      </ConfirmDialog>
      <ConfirmDialog open={confirmDelete} title={t('删除会话')} summary={t('确认删除')} danger busy={remove.isPending} onCancel={() => setConfirmDelete(false)} onConfirm={() => current && remove.mutate(current.id)}>
        <p>{t('会删掉「{title}」里的全部对话记录,恢复不了。', { title: current?.title ?? '' })}</p>
      </ConfirmDialog>
    </div>
  );
}
