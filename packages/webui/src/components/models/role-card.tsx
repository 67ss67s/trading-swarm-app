/**
 * #models 页的 agent 卡(2026-09-25 重做,Jacky:「每个 agent 都分开来,都改成能选 cli 和 apikey,且带一个测试连接的功能」)。
 *
 * 一张卡 = 一个模型角色(§9.52 ModelRole):标题 + 楼层呼号 + 一句话说明;当前生效底层(绑定 / 用默认)与状态点;
 * 分段选择「本机 CLI | API key | 用默认」(decision 只有「API key(OpenRouter)| 不启用」):
 *   CLI     → 选 claude / codex / pi(显示 cli_detected)+ 模型(可空 = CLI 自己的缺省);保存时复用或自动建 kind='cli' 连接;
 *   API key → 选已有连接,或「新建连接」就地填 key(POST /api/models/connections)+ 模型(models_hint 下拉 + 可手输);
 *   用默认  → PUT {connection_id:null} 解绑,回退主脑 / 副脑(decision = 不启用)。
 * 「测试连接」= POST /api/models/bindings/:role/test(有未保存改动时先保存再测),显示延迟 / 成功失败 / 错误原因。
 * key 输入框 type=password,用完即清;明文不进 state 以外的任何地方。
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, PlugZap, Plus, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiRequestError } from '@/api/client';
import type { CliTool, ConnectionKind, ModelConnection, ModelRole, ModelsView, RoleTestResult } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JudgeLock } from '@/components/judge-lock';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { friendlyError, lockReason } from '@/lib/edition';
import { relativeTime, useNow } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { saveErrorText } from './connection-dialog';
import { StatusDot } from './connection-list';
import { KindIcon } from './kind-icon';
import {
  apiConnectionsForRole,
  apiKindsForRole,
  bindingErrorText,
  type BindingMode,
  cardHealth,
  type CardDraft,
  CLI_TOOLS,
  cliModelHints,
  connectionName,
  DECISION_DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  draftDirty,
  draftFromView,
  draftProblem,
  findCliConnection,
  KIND_LABEL,
  modelHintsForRole,
  NEW_CONNECTION,
  newKindModelHints,
  pickModelForConnection,
  roleCard,
  SOURCE_LABEL,
} from './logic';
import { MODELS_QUERY_KEY } from './use-models';

const HEALTH_DOT = { ok: 'bg-up', error: 'bg-down', untested: 'bg-muted-foreground/40', unset: 'bg-muted-foreground/20' } as const;

function errorText(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const human = bindingErrorText(e.code, '');
    return human || saveErrorText(e);
  }
  return friendlyError(e instanceof Error ? e.message : String(e));
}

function Segmented<T extends string>({ value, options, onChange, disabled, title }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; title?: string }) {
  return (
    <div className="inline-flex w-full rounded-md border bg-muted/30 p-0.5" role="radiogroup" title={title}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn('flex-1 rounded-[5px] px-2 py-1 text-[11.5px] transition-colors disabled:opacity-50', value === o.value ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ModelInput({ id, value, hints, placeholder, disabled, title, onChange }: { id: string; value: string; hints: string[]; placeholder: string; disabled?: boolean; title?: string; onChange: (v: string) => void }) {
  return (
    <div title={title}>
      <div className="mb-1 text-[10.5px] text-muted-foreground">{t('模型')}</div>
      <Input list={id} value={value} disabled={disabled} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} className="num h-7 text-[12px]" />
      <datalist id={id}>
        {hints.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}

export function RoleCard({ role, view }: { role: ModelRole; view: ModelsView }) {
  const qc = useQueryClient();
  const now = useNow();
  const meta = roleCard(role);
  const binding = view.bindings.find((b) => b.role === role) ?? { role, connection_id: null, model: null };
  const boundConn = binding.connection_id ? (view.connections.find((c) => c.id === binding.connection_id) ?? null) : null;
  const eff = view.effective[role];

  const [draft, setDraft] = useState<CardDraft>(() => draftFromView(view, role));
  const [newKey, setNewKey] = useState('');
  const [newBase, setNewBase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<RoleTestResult | null>(null);

  // 服务端这个角色的绑定变了(SSE / 别处改了)→ 草稿跟着换,旧测试结果作废
  const serverKey = `${binding.connection_id ?? ''}|${binding.model ?? ''}`;
  useEffect(() => {
    setDraft(draftFromView(view, role));
    setError(null);
    setTest(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const brainsQ = useQuery({ queryKey: ['brains'], queryFn: () => api.brains(), staleTime: 5 * 60_000, retry: 0, enabled: draft.mode === 'cli' });
  const apiConns = apiConnectionsForRole(role, view.connections);
  const selectedConn: ModelConnection | null = draft.mode === 'api' && draft.connectionId && draft.connectionId !== NEW_CONNECTION ? (view.connections.find((c) => c.id === draft.connectionId) ?? null) : null;

  const hints = useMemo(() => {
    if (draft.mode === 'cli') return draft.cli ? cliModelHints(view, draft.cli, brainsQ.data?.brains) : [];
    if (draft.mode === 'api') {
      if (draft.connectionId === NEW_CONNECTION) return draft.newKind ? newKindModelHints(role, draft.newKind) : [];
      return modelHintsForRole(role, selectedConn);
    }
    return [];
  }, [draft.mode, draft.cli, draft.connectionId, draft.newKind, view, role, selectedConn, brainsQ.data]);

  const dirty = draftDirty(view, role, draft);
  const problem = dirty ? draftProblem(role, draft, newKey, newBase) : null;

  const patch = (p: Partial<CardDraft>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...p }));
  };

  const onMode = (mode: BindingMode) => {
    if (mode === draft.mode) return;
    if (mode === 'api') {
      const connectionId = draft.connectionId ?? apiConns[0]?.id ?? NEW_CONNECTION;
      const conn = view.connections.find((c) => c.id === connectionId);
      const model = conn ? (pickModelForConnection(role, conn, draft.model.trim() || null) ?? '') : role === 'decision' ? DECISION_DEFAULT_MODEL : '';
      patch({ mode, connectionId, model, newKind: connectionId === NEW_CONNECTION ? (draft.newKind ?? (role === 'decision' ? 'openrouter' : null)) : draft.newKind });
    } else if (mode === 'cli') {
      const cli = draft.cli ?? view.cli_detected.find((d) => d.ok)?.tool ?? 'claude';
      const cliHints = cliModelHints(view, cli, brainsQ.data?.brains);
      patch({ mode, cli, model: cliHints.includes(draft.model) ? draft.model : '' });
    } else patch({ mode });
  };

  const onConnection = (id: string) => {
    if (id === NEW_CONNECTION) {
      patch({ connectionId: NEW_CONNECTION, newKind: draft.newKind ?? (role === 'decision' ? 'openrouter' : null), model: role === 'decision' ? DECISION_DEFAULT_MODEL : draft.model });
      return;
    }
    const conn = view.connections.find((c) => c.id === id);
    if (!conn) return;
    patch({ connectionId: id, model: pickModelForConnection(role, conn, draft.model.trim() || null) ?? '' });
  };

  const onNewKind = (kind: ConnectionKind) => {
    const h = newKindModelHints(role, kind);
    patch({ newKind: kind, model: role === 'decision' ? DECISION_DEFAULT_MODEL : h.includes(draft.model) ? draft.model : (h[0] ?? '') });
  };

  /** 保存 = (必要时建连接)+ PUT 绑定;返回新 ModelsView */
  const persist = async (): Promise<ModelsView> => {
    if (draft.mode === 'default') return api.putModelBinding(role, null, null);
    let connId: string;
    if (draft.mode === 'cli') {
      const tool = draft.cli as CliTool;
      connId = findCliConnection(view, tool)?.id ?? (await api.createModelConnection({ kind: 'cli', cli: tool })).id;
    } else if (draft.connectionId === NEW_CONNECTION) {
      const kind = draft.newKind as ConnectionKind;
      const key = newKey.trim();
      const created = await api.createModelConnection({
        kind,
        ...(kind === 'openai_compatible' && newBase.trim() ? { base_url: newBase.trim() } : {}),
        ...(key ? { api_key: key } : {}),
      });
      setNewKey(''); // 明文用完即丢
      setNewBase('');
      // 连接已建:后面 PUT 失败时重试不再重复建
      setDraft((d) => ({ ...d, connectionId: created.id }));
      qc.setQueryData<ModelsView>(MODELS_QUERY_KEY, (old) => (old ? { ...old, connections: [...old.connections.filter((c) => c.id !== created.id), created] } : old));
      connId = created.id;
    } else connId = draft.connectionId as string;
    const model = draft.model.trim() || (role === 'decision' ? DECISION_DEFAULT_MODEL : null);
    return api.putModelBinding(role, connId, model);
  };

  const save = useMutation({
    mutationFn: persist,
    onSuccess: (next) => {
      setError(null);
      setTest(null);
      qc.setQueryData(MODELS_QUERY_KEY, next);
      toast.success(t('{role} 已保存', { role: meta.title }));
    },
    onError: (e) => {
      const msg = errorText(e);
      setError(msg);
      toast.error(t('{role} 没改成', { role: meta.title }), { description: msg });
    },
  });

  const runTest = useMutation({
    mutationFn: async () => {
      if (dirty) qc.setQueryData(MODELS_QUERY_KEY, await persist());
      return api.testModelRole(role);
    },
    onSuccess: (r) => {
      setError(null);
      setTest(r);
      void qc.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
    onError: (e) => {
      const msg = errorText(e);
      setError(msg);
      void qc.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
  });

  // 评审版:模型 key 不外露,角色绑定整张卡只读(Segmented / 下拉 / 输入框跟着 busy 一起禁用,原因挂在卡体 title 和按钮 tooltip 上)
  const lock = lockReason('model_connection_edit');
  const busy = save.isPending || runTest.isPending || !!lock;
  const health = cardHealth(view, role, test);
  // 显示的测试结果:本卡刚测的优先;否则绑定连接的上次测试
  const shownTest = test ?? (eff?.source === 'binding' ? (boundConn?.last_test ?? null) : null);

  const modeOptions: { value: BindingMode; label: string }[] =
    role === 'decision'
      ? [
          { value: 'api', label: t('API key(OpenRouter)') },
          { value: 'default', label: t('不启用') },
        ]
      : [
          { value: 'cli', label: t('本机 CLI') },
          { value: 'api', label: t('API key') },
          { value: 'default', label: t('用默认') },
        ];

  const effText =
    eff?.source === 'binding'
      ? eff.name
      : eff?.source === 'fallback_main'
        ? t('默认主脑 · {name}', { name: eff.name || '—' })
        : eff?.source === 'fallback_cheap'
          ? t('默认副脑 · {name}', { name: eff.name || '—' })
          : t('未启用');

  return (
    <div className={cn('flex flex-col gap-2.5 rounded-lg border bg-card p-3', health === 'error' && 'border-down/40')} data-testid={`role-card-${role}`}>
      {/* 头:角色 + 呼号 + 状态点;一句话说明 */}
      <div>
        <div className="flex items-center gap-1.5">
          <span className={cn('inline-block size-2 shrink-0 rounded-full', HEALTH_DOT[health])} title={health === 'ok' ? t('可用') : health === 'error' ? t('失效') : health === 'unset' ? t('未启用') : t('未测试')} />
          <span className="text-[13px] font-semibold">{meta.title}</span>
          <span className="num text-[10.5px] text-muted-foreground">{meta.callsign}</span>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{meta.blurb}</p>
      </div>

      {/* 当前生效 */}
      <div className="flex min-w-0 items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1 text-[11px]">
        <span className="shrink-0 text-muted-foreground">{t('当前生效')}</span>
        <Badge variant="outline" className={cn('shrink-0 text-[10px]', eff?.source === 'binding' ? (health === 'error' ? 'border-down/40 text-down' : 'border-up/30 text-up') : 'text-muted-foreground')}>
          {eff ? (eff.source === 'binding' ? SOURCE_LABEL.binding : eff.source === 'unset' ? t('未启用') : t('用默认')) : '—'}
        </Badge>
        <span className="num min-w-0 truncate" title={effText}>
          {effText}
        </span>
      </div>

      <Segmented value={draft.mode} options={modeOptions} onChange={onMode} disabled={busy} title={lock ?? undefined} />

      {draft.mode === 'cli' ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-3 gap-1">
            {CLI_TOOLS.map((tool) => {
              const det = view.cli_detected.find((d) => d.tool === tool);
              return (
                <button
                  key={tool}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const h = cliModelHints(view, tool, brainsQ.data?.brains);
                    patch({ cli: tool, model: h.includes(draft.model) ? draft.model : '' });
                  }}
                  title={lock ?? det?.command ?? undefined}
                  className={cn('flex flex-col items-start rounded-md border px-2 py-1 text-left hover:bg-muted', draft.cli === tool && 'border-primary bg-primary/10')}
                >
                  <span className="num text-[12px] font-semibold">{tool}</span>
                  <span className={cn('text-[10px]', det?.ok ? 'text-up' : 'text-muted-foreground')}>{det?.ok ? t('已探测到') : t('未找到')}</span>
                </button>
              );
            })}
          </div>
          <ModelInput id={`rc-${role}-cli`} value={draft.model} hints={hints} disabled={busy} title={lock ?? undefined} placeholder={t('留空 = 用 CLI 自己的缺省模型')} onChange={(v) => patch({ model: v })} />
        </div>
      ) : draft.mode === 'api' ? (
        <div className="flex flex-col gap-2">
          <div>
            <div className="mb-1 text-[10.5px] text-muted-foreground">{t('连接')}</div>
            <Select value={draft.connectionId ?? undefined} onValueChange={onConnection} disabled={busy}>
              <SelectTrigger size="sm" className="h-7 w-full text-[12px]" title={lock ?? undefined}>
                <SelectValue placeholder={t('选一个连接,或新建一个')} />
              </SelectTrigger>
              <SelectContent>
                {apiConns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <StatusDot status={c.status} />
                    {connectionName(c)}
                    {c.key_masked ? <span className="num ml-1 text-muted-foreground">{c.key_masked}</span> : null}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CONNECTION}>
                  <Plus className="size-3" />
                  {t('新建连接')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {draft.connectionId === NEW_CONNECTION ? (
            <div className="flex flex-col gap-2 rounded-md border border-dashed p-2">
              <div className="grid grid-cols-3 gap-1">
                {apiKindsForRole(role).map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={busy}
                    onClick={() => onNewKind(k)}
                    className={cn('flex items-center gap-1 rounded-md border px-1.5 py-1 text-[10.5px] hover:bg-muted', draft.newKind === k && 'border-primary bg-primary/10 text-foreground')}
                  >
                    <KindIcon kind={k} className="size-3" />
                    <span className="truncate">{k === 'openai_compatible' ? t('自定义') : KIND_LABEL[k]}</span>
                  </button>
                ))}
              </div>
              {draft.newKind ? (
                <>
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={newKey}
                    disabled={busy}
                    onChange={(e) => {
                      setError(null);
                      setNewKey(e.target.value);
                    }}
                    placeholder={draft.newKind === 'openai_compatible' ? t('API key(本机服务可不填)') : t('粘贴 API key')}
                    className="num h-7 text-[12px]"
                    aria-label="API key"
                  />
                  {draft.newKind === 'openai_compatible' ? (
                    <Input value={newBase} disabled={busy} onChange={(e) => setNewBase(e.target.value)} placeholder="https://…/v1" className="num h-7 text-[12px]" aria-label="base_url" />
                  ) : (
                    <p className="num truncate text-[10px] text-muted-foreground">{DEFAULT_BASE_URL[draft.newKind]}</p>
                  )}
                  <p className="text-[10px] leading-snug text-muted-foreground">{t('key 只存在网关本机的密钥文件里,页面上只显示掩码。')}</p>
                </>
              ) : null}
            </div>
          ) : null}

          <ModelInput
            id={`rc-${role}-api`}
            value={draft.model}
            hints={hints}
            disabled={busy}
            title={lock ?? undefined}
            placeholder={role === 'decision' ? DECISION_DEFAULT_MODEL : t('模型 id,可手打')}
            onChange={(v) => patch({ model: v })}
          />
        </div>
      ) : (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {role === 'decision' ? t('不启用时,策略里的判断要素块不可用。') : t('用页面顶部的默认主脑 / 副脑;要改默认在「高级」里。')}
        </p>
      )}

      {/* 操作 */}
      <div className="flex items-center gap-1.5">
        <JudgeLock feature="model_connection_edit">
        <Button size="xs" disabled={!dirty || busy || Boolean(problem)} title={problem ?? undefined} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="size-3 animate-spin" /> : <Save />}
          {t('保存')}
        </Button>
        </JudgeLock>
        <JudgeLock feature="model_connection_edit">
        <Button
          size="xs"
          variant="outline"
          disabled={busy || Boolean(problem) || (!dirty && eff?.source === 'unset')}
          title={dirty ? t('先保存再测试') : t('用当前生效的底层发一次最短往返;CLI 可能要一分多钟')}
          onClick={() => runTest.mutate()}
        >
          {runTest.isPending ? <Loader2 className="size-3 animate-spin" /> : <PlugZap />}
          {runTest.isPending ? t('测试中…') : dirty ? t('保存并测试') : t('测试连接')}
        </Button>
        </JudgeLock>
        {dirty && !busy ? <span className="text-[10.5px] text-warn">{problem ?? t('未保存')}</span> : null}
      </div>

      {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] break-words text-destructive">{error}</div> : null}

      {shownTest ? (
        <div className={cn('num rounded-md px-2 py-1 text-[10.5px]', shownTest.ok ? 'bg-up/10 text-up' : 'bg-down/10 text-down')} data-testid={`role-test-${role}`}>
          <span className="font-semibold">{shownTest.ok ? t('测试通过') : t('测试失败')}</span>
          {shownTest.latency_ms != null ? <span> · {shownTest.latency_ms}ms</span> : null}
          <span className="text-muted-foreground"> · {relativeTime(shownTest.at, now)}</span>
          {shownTest.detail ? <div className="mt-0.5 break-words text-muted-foreground">{friendlyError(shownTest.detail)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
