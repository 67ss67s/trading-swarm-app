/**
 * 「角色底层」表(§9.52):7 行,每行选连接 + 模型,显示当前生效来源(绑定 / 回退主脑 / 回退副脑 / 未设置)。
 * 改连接 = 立即 PUT /api/models/bindings/:role;模型输入框可手打,候选取该连接的 models_hint
 * (非 decision 角色不列 typesafe/ 开头的),选中候选 / 回车 / 失焦时才 PUT,不逐键请求。
 * decision 只列 openrouter 连接,模型缺省 ~typesafe/jev-latest。
 * 400 错误码(decision_requires_openrouter / decision_only_model / model_required / not_found)翻成人话贴在行下面。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiRequestError } from '@/api/client';
import type { ModelRole, ModelsView, RoleBinding } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { StatusDot } from './connection-list';
import { bindingErrorText, connectionName, connectionsForRole, isDecisionOnlyModel, MODEL_ROLE_DUTY, MODEL_ROLE_LABEL, MODEL_ROLES, modelHintsForRole, pickModelForConnection, ROLE_FALLBACK, roleBindingBroken, SOURCE_LABEL } from './logic';
import { MODELS_QUERY_KEY } from './use-models';

/** Radix Select 不收空串 value:「不单独绑定」用这个哨兵 */
const NONE = '__none__';

function RoleRow({ role, binding, view }: { role: ModelRole; binding: RoleBinding; view: ModelsView }) {
  const qc = useQueryClient();
  const [modelDraft, setModelDraft] = useState(binding.model ?? '');
  const [error, setError] = useState<string | null>(null);
  // 服务端值变了(SSE / 别处改了)就跟着换
  useEffect(() => setModelDraft(binding.model ?? ''), [binding.model, binding.connection_id]);

  const conn = binding.connection_id ? (view.connections.find((c) => c.id === binding.connection_id) ?? null) : null;
  const options = connectionsForRole(role, view.connections);
  const hints = modelHintsForRole(role, conn);
  const eff = view.effective[role];
  const broken = roleBindingBroken(view, role);
  const listId = `model-hints-${role}`;

  const put = useMutation({
    mutationFn: (b: { connection_id: string | null; model: string | null }) => api.putModelBinding(role, b.connection_id, b.model),
    onSuccess: (next) => {
      setError(null);
      qc.setQueryData(MODELS_QUERY_KEY, next);
    },
    onError: (e: Error) => {
      const msg = e instanceof ApiRequestError ? bindingErrorText(e.code, e.message) : e.message;
      setError(msg);
      setModelDraft(binding.model ?? '');
      toast.error(t('{role} 没改成', { role: MODEL_ROLE_LABEL[role] }), { description: msg });
    },
  });

  const onConnection = (v: string) => {
    if (v === NONE) {
      if (binding.connection_id !== null || binding.model !== null) put.mutate({ connection_id: null, model: null });
      return;
    }
    const next = view.connections.find((c) => c.id === v);
    if (!next || next.id === binding.connection_id) return;
    put.mutate({ connection_id: next.id, model: pickModelForConnection(role, next, binding.model) });
  };

  const commitModel = (raw: string) => {
    // 选中候选时已经发过一次,紧跟着的失焦别再发
    if (!binding.connection_id || put.isPending) return;
    const m = raw.trim() === '' ? null : raw.trim();
    if (m === binding.model) return;
    // 前端先挡一道(网关也会回 decision_only_model)
    if (role !== 'decision' && isDecisionOnlyModel(m)) {
      setError(bindingErrorText('decision_only_model', ''));
      setModelDraft(binding.model ?? '');
      return;
    }
    put.mutate({ connection_id: binding.connection_id, model: m });
  };

  const fallback = ROLE_FALLBACK[role];
  const noneLabel = fallback === 'main' ? t('不单独绑定(用回退主脑)') : fallback === 'cheap' ? t('不单独绑定(用回退副脑)') : t('不绑定(未设置)');

  return (
    <div className={cn('grid grid-cols-[minmax(0,11rem)_minmax(0,14rem)_minmax(0,1fr)_minmax(0,13rem)] items-center gap-2 border-b px-3 py-2 last:border-b-0', error && 'bg-destructive/5')} data-testid={`role-row-${role}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
          {MODEL_ROLE_LABEL[role]}
          {broken ? <span className="inline-block size-2 rounded-full bg-down" title={t('绑定的连接失效了,这个角色调用会直接报错,不会静默回退')} /> : null}
        </div>
        <div className="truncate text-[10.5px] text-muted-foreground" title={MODEL_ROLE_DUTY[role]}>
          {MODEL_ROLE_DUTY[role]}
        </div>
      </div>

      <Select value={binding.connection_id ?? NONE} onValueChange={onConnection} disabled={put.isPending}>
        <SelectTrigger size="sm" className="h-7 w-full text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
          {options.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              <StatusDot status={c.status} />
              {connectionName(c)}
            </SelectItem>
          ))}
          {/* 已绑的连接如果不在可选列表(比如 decision 绑到了非 openrouter),也要显示出来 */}
          {conn && !options.some((c) => c.id === conn.id) ? (
            <SelectItem value={conn.id} disabled>
              {connectionName(conn)}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>

      <div className="flex min-w-0 items-center gap-1">
        <Input
          list={listId}
          value={modelDraft}
          disabled={!binding.connection_id || put.isPending}
          placeholder={binding.connection_id ? (role === 'decision' ? '~typesafe/jev-latest' : t('模型 id,可手打')) : t('先选连接')}
          onChange={(e) => {
            const v = e.target.value;
            setModelDraft(v);
            // 从候选里点中 = 立即生效;手打的等回车 / 失焦
            if (hints.includes(v)) commitModel(v);
          }}
          onBlur={() => commitModel(modelDraft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitModel(modelDraft);
            if (e.key === 'Escape') setModelDraft(binding.model ?? '');
          }}
          className="num h-7 min-w-0 flex-1 text-[12px]"
        />
        <datalist id={listId}>
          {hints.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {put.isPending ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>

      <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
        <Badge variant="outline" className={cn('shrink-0 text-[10px]', eff?.source === 'binding' ? (broken ? 'border-down/40 text-down' : 'border-up/30 text-up') : eff?.source === 'unset' ? 'text-muted-foreground' : '')}>
          {eff ? SOURCE_LABEL[eff.source] : '—'}
        </Badge>
        <span className="num truncate text-muted-foreground" title={eff?.name}>
          {eff?.name || '—'}
        </span>
      </div>

      {error ? <div className="col-span-4 text-[11px] text-destructive">{error}</div> : null}
    </div>
  );
}

export function RoleBindings({ view }: { view: ModelsView }) {
  return (
    <div className="min-w-[44rem]">
      <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,14rem)_minmax(0,1fr)_minmax(0,13rem)] gap-2 border-b bg-muted/20 px-3 py-1 text-[10.5px] text-muted-foreground">
        <span>{t('角色')}</span>
        <span>{t('连接')}</span>
        <span>{t('模型')}</span>
        <span>{t('当前生效')}</span>
      </div>
      {MODEL_ROLES.map((role) => {
        const binding = view.bindings.find((b) => b.role === role) ?? { role, connection_id: null, model: null };
        return <RoleRow key={role} role={role} binding={binding} view={view} />;
      })}
    </div>
  );
}
