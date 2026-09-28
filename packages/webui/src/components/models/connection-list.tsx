/**
 * 连接列表(§9.52):类型图标、名字、掩码 key、状态点、上次测试(时间 / 延迟 / detail)、测试 / 编辑 / 删除。
 * 测试可能要几秒到 90 秒(CLI),按钮带 loading;删除被角色占用时网关回 409 connection_in_use,
 * 把 body.roles 翻成角色名显示在这一行下面(同时 toast)。
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, PlugZap, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiRequestError } from '@/api/client';
import type { ModelConnection, ModelRole, ModelsView } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { JudgeLock } from '@/components/judge-lock';
import { Button } from '@/components/ui/button';
import { friendlyError } from '@/lib/edition';
import { relativeTime, useNow } from '@/lib/format';
import { t, tmap, listSep } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { applyTestResult } from './connection-dialog';
import { KindIcon } from './kind-icon';
import { connectionName, inUseRoles, KIND_LABEL, MODEL_ROLE_LABEL } from './logic';
import { MODELS_QUERY_KEY } from './use-models';

const STATUS_LABEL: Record<ModelConnection['status'], string> = tmap({ ok: '可用', error: '失效', untested: '未测试' });
const STATUS_DOT: Record<ModelConnection['status'], string> = { ok: 'bg-up', error: 'bg-down', untested: 'bg-muted-foreground/40' };

export function StatusDot({ status, className }: { status: ModelConnection['status']; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', STATUS_DOT[status], className)} title={STATUS_LABEL[status]} />;
}

function ConnectionRow({ conn, view, now, onEdit }: { conn: ModelConnection; view: ModelsView; now: number; onEdit: (c: ModelConnection) => void }) {
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [blockedBy, setBlockedBy] = useState<ModelRole[] | null>(null);
  const boundRoles = view.bindings.filter((b) => b.connection_id === conn.id).map((b) => b.role);

  const test = useMutation({
    mutationFn: () => api.testModelConnection(conn.id),
    onSuccess: (res) => {
      qc.setQueryData<ModelsView>(MODELS_QUERY_KEY, (old) => applyTestResult(old, conn.id, res));
      if (res.ok) toast.success(t('{name} 测试通过', { name: connectionName(conn) }));
      else toast.error(t('{name} 测试失败', { name: connectionName(conn) }), { description: friendlyError(res.detail) });
    },
    onError: (e: Error) => toast.error(t('{name} 测试失败', { name: connectionName(conn) }), { description: friendlyError(e.message) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: MODELS_QUERY_KEY }),
  });

  const del = useMutation({
    mutationFn: () => api.deleteModelConnection(conn.id),
    onSuccess: () => {
      setConfirmOpen(false);
      setBlockedBy(null);
      qc.setQueryData<ModelsView>(MODELS_QUERY_KEY, (old) => (old ? { ...old, connections: old.connections.filter((c) => c.id !== conn.id) } : old));
      void qc.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
      toast.success(t('连接已删除'));
    },
    onError: (e: Error) => {
      setConfirmOpen(false);
      if (e instanceof ApiRequestError && e.code === 'connection_in_use') {
        const roles = inUseRoles(e.body);
        setBlockedBy(roles);
        toast.error(t('删不了:还有角色绑着这个连接'), { description: roles.map((r) => MODEL_ROLE_LABEL[r]).join(listSep()) || e.message });
      } else toast.error(t('删除失败'), { description: friendlyError(e.message) });
    },
  });

  const lt = conn.last_test;
  return (
    <div className="border-b px-3 py-2 last:border-b-0" data-testid="model-connection-row">
      <div className="flex items-center gap-2.5">
        <KindIcon kind={conn.kind} className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12.5px]">
            <StatusDot status={conn.status} />
            <span className="truncate font-semibold">{connectionName(conn)}</span>
            <span className="shrink-0 text-[10.5px] text-muted-foreground">{KIND_LABEL[conn.kind]}</span>
            <span className={cn('shrink-0 text-[10.5px]', conn.status === 'ok' ? 'text-up' : conn.status === 'error' ? 'text-down' : 'text-muted-foreground')}>{STATUS_LABEL[conn.status]}</span>
          </div>
          <div className="num mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted-foreground">
            {conn.kind === 'cli' ? <span>CLI · {conn.cli ?? '—'}</span> : <span>{conn.key_masked ?? t('没有 key')}</span>}
            {conn.base_url ? <span className="max-w-64 truncate" title={conn.base_url}>{conn.base_url}</span> : null}
            {boundRoles.length > 0 ? <span>{t('绑定:{roles}', { roles: boundRoles.map((r) => MODEL_ROLE_LABEL[r]).join(listSep()) })}</span> : null}
          </div>
          <div className="num mt-0.5 text-[10.5px] text-muted-foreground">
            {lt ? (
              <span className={cn(lt.ok ? '' : 'text-down')}>
                {t('上次测试 {when}', { when: relativeTime(lt.at, now) })}
                {lt.latency_ms != null ? ` · ${lt.latency_ms}ms` : ''}
                {lt.detail ? <span className="ml-1 break-all text-muted-foreground">· {friendlyError(lt.detail)}</span> : null}
              </span>
            ) : (
              <span>{t('还没测过')}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <JudgeLock feature="model_connection_edit">
            <Button size="xs" variant="outline" disabled={test.isPending} onClick={() => test.mutate()} title={t('发一次最短往返;CLI 可能要一分多钟')}>
              {test.isPending ? <Loader2 className="size-3 animate-spin" /> : <PlugZap />}
              {test.isPending ? t('测试中…') : t('测试')}
            </Button>
          </JudgeLock>
          <JudgeLock feature="model_connection_edit">
            <Button size="icon-xs" variant="ghost" aria-label={t('编辑')} title={t('编辑')} onClick={() => onEdit(conn)}>
              <Pencil />
            </Button>
          </JudgeLock>
          <JudgeLock feature="model_connection_edit">
            <Button size="icon-xs" variant="ghost" className="text-destructive hover:text-destructive" aria-label={t('删除')} title={t('删除')} onClick={() => setConfirmOpen(true)}>
              <Trash2 />
            </Button>
          </JudgeLock>
        </div>
      </div>
      {blockedBy ? (
        <div className="mt-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive" data-testid="connection-in-use">
          {t('还有这些 agent 绑着它,先在上面对应的 agent 卡里改掉再删:{roles}', { roles: blockedBy.map((r) => MODEL_ROLE_LABEL[r]).join(listSep()) || '—' })}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        title={t('删除连接')}
        summary={t('确认删除')}
        danger
        busy={del.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => del.mutate()}
      >
        <p>{t('删掉「{name}」,网关本机存的 key 一起删。绑着它的角色要先改绑,否则删不了。', { name: connectionName(conn) })}</p>
      </ConfirmDialog>
    </div>
  );
}

export function ConnectionList({ view, onEdit }: { view: ModelsView; onEdit: (c: ModelConnection) => void }) {
  const now = useNow();
  if (view.connections.length === 0) {
    return <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">{t('还没有连接。点右上角「添加连接」,填一个 API key 或选一个本机 CLI。')}</div>;
  }
  return (
    <div>
      {view.connections.map((c) => (
        <ConnectionRow key={c.id} conn={c} view={view} now={now} onEdit={onEdit} />
      ))}
    </div>
  );
}
