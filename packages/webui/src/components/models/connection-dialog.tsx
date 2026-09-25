/**
 * 「添加连接 / 编辑连接」弹层(§9.52)。
 *   添加:选类型 → 填 key(或选本机 CLI)→「保存并测试」= POST 建连接,成功后自动 POST .../test,
 *         结果就地显示;连接已经存下了,测试失败也可以直接关掉回列表再改。
 *   编辑:类型不能改;key 输入框留空 = 不改(PATCH 不带 api_key),永不回显明文,只给 key_masked 看。
 * key 输入框一律 type=password,autocomplete=off。
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { CliTool, ConnectionKind, ModelConnection, ModelConnectionTest, ModelsView } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { KindIcon } from './kind-icon';
import { CLI_TOOLS, CONNECTION_KINDS, DEFAULT_BASE_URL, KIND_LABEL } from './logic';
import { MODELS_QUERY_KEY } from './use-models';

type Phase = 'form' | 'testing' | 'done';

/** 与网关 MIN_API_KEY_LENGTH 一致(cheap-review Low-14) */
const MIN_KEY_LEN = 16;

/** 网关 400 错误码 → 人话(SSRF / key 校验,cheap-review High-3 / Low-14);被拒的地址细节附在后面 */
const ERROR_HINT: Record<string, string> = {
  base_url_not_allowed: '内置服务只能用缺省地址;要自定义地址请选「OpenAI 兼容」',
  base_url_insecure: 'base_url 必须是 https(只有 localhost / 127.0.0.1 / ::1 且不填 key 时可用 http)',
  base_url_blocked: 'base_url 指向内网 / 本机 / 云元数据地址,已拒绝',
  base_url_unresolvable: 'base_url 的域名解析不了',
  api_key_invalid: 'API key 至少 16 位,不能有空白',
};
export function saveErrorText(e: Error): string {
  const code = (e as Error & { code?: string }).code;
  const hint = code ? ERROR_HINT[code] : undefined;
  if (!hint) return e.message;
  return code === 'base_url_blocked' || code === 'base_url_unresolvable' ? `${t(hint)}:${e.message}` : t(hint);
}

/** 连接建好 / 改好 / 测完都要落进 ['models'] 缓存;SSE models.changed 也会来,这里先乐观写一份 */
function upsertConnection(old: ModelsView | undefined, conn: ModelConnection): ModelsView | undefined {
  if (!old) return old;
  const has = old.connections.some((c) => c.id === conn.id);
  return { ...old, connections: has ? old.connections.map((c) => (c.id === conn.id ? conn : c)) : [...old.connections, conn] };
}

export function applyTestResult(old: ModelsView | undefined, id: string, test: ModelConnectionTest): ModelsView | undefined {
  if (!old) return old;
  return { ...old, connections: old.connections.map((c) => (c.id === id ? { ...c, last_test: test, status: test.ok ? 'ok' : 'error' } : c)) };
}

export function ConnectionDialog({ open, onOpenChange, editing, cliDetected }: { open: boolean; onOpenChange: (open: boolean) => void; editing: ModelConnection | null; cliDetected: ModelsView['cli_detected'] }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<ConnectionKind | null>(null);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [cli, setCli] = useState<CliTool | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [test, setTest] = useState<ModelConnectionTest | null>(null);

  // 每次打开重置表单;编辑时带上现有的非敏感字段(key 永远空着)
  useEffect(() => {
    if (!open) return;
    setKind(editing?.kind ?? null);
    setLabel(editing?.label ?? '');
    setBaseUrl(editing?.base_url ?? '');
    setApiKey('');
    setCli(editing?.cli ?? null);
    setPhase('form');
    setError(null);
    setSavedId(editing?.id ?? null);
    setTest(null);
  }, [open, editing]);

  const runTest = async (id: string) => {
    setPhase('testing');
    try {
      const res = await api.testModelConnection(id);
      setTest(res);
      qc.setQueryData<ModelsView>(MODELS_QUERY_KEY, (old) => applyTestResult(old, id, res));
    } catch (e) {
      setTest({ at: Date.now(), ok: false, latency_ms: null, detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setPhase('done');
      void qc.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    }
  };

  const save = useMutation({
    mutationFn: async (): Promise<ModelConnection> => {
      if (!kind) throw new Error(t('先选连接类型'));
      const trimmedKey = apiKey.trim();
      if (editing) {
        const patch: Record<string, string> = {};
        if (label.trim() !== (editing.label ?? '')) patch.label = label.trim();
        // 只有 OpenAI 兼容连接能改地址;内置服务带 base_url 会被网关 400
        if (kind === 'openai_compatible' && baseUrl.trim() !== (editing.base_url ?? '')) patch.base_url = baseUrl.trim();
        if (kind === 'cli' && cli && cli !== editing.cli) patch.cli = cli;
        if (kind !== 'cli' && trimmedKey) patch.api_key = trimmedKey; // 留空 = 不改
        return api.patchModelConnection(editing.id, patch);
      }
      return api.createModelConnection({
        kind,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(kind === 'openai_compatible' && baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
        ...(kind === 'cli' && cli ? { cli } : {}),
        ...(kind !== 'cli' && trimmedKey ? { api_key: trimmedKey } : {}),
      });
    },
    onSuccess: (conn) => {
      setApiKey(''); // 明文用完即丢
      setError(null);
      setSavedId(conn.id);
      qc.setQueryData<ModelsView>(MODELS_QUERY_KEY, (old) => upsertConnection(old, conn));
      toast.success(editing ? t('连接已更新') : t('连接已保存'));
      void runTest(conn.id);
    },
    onError: (e: Error) => setError(saveErrorText(e)),
  });

  // 前端先拦一道明显缺的字段(网关也会校验)
  const missing: string | null = !kind
    ? t('先选连接类型')
    : kind === 'cli'
      ? cli
        ? null
        : t('选一个本机 CLI')
      : kind === 'openai_compatible' && !baseUrl.trim()
        ? t('OpenAI 兼容连接要填 base_url')
        : !editing && kind !== 'openai_compatible' && !apiKey.trim()
          ? t('填 API key')
          : apiKey.trim() && (apiKey.trim().length < MIN_KEY_LEN || /\s/.test(apiKey.trim()))
            ? t('API key 至少 16 位,不能有空白')
            : null;

  // 测试可能要一分多钟:测试中也允许关掉弹层,结果照样落进 ['models'] 缓存
  const busy = save.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('编辑连接') : t('添加连接')}</DialogTitle>
          <DialogDescription>{t('API key 只存在网关本机的密钥文件里,不进数据库、不进日志,页面上只显示掩码。')}</DialogDescription>
        </DialogHeader>

        {phase === 'form' ? (
          <div className="flex flex-col gap-3 text-[12px]">
            {/* 1. 类型 */}
            <div>
              <Label className="mb-1.5 text-[11px] text-muted-foreground">{t('类型')}</Label>
              <div className="grid grid-cols-4 gap-1.5">
                {CONNECTION_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={Boolean(editing) && k !== kind}
                    onClick={() => setKind(k)}
                    className={cn('flex flex-col items-center gap-1 rounded-md border px-1.5 py-2 text-[11px] transition-colors hover:bg-muted disabled:opacity-40', kind === k && 'border-primary bg-primary/10 text-foreground')}
                  >
                    <KindIcon kind={k} className="size-4" />
                    <span className="truncate">{KIND_LABEL[k]}</span>
                  </button>
                ))}
              </div>
            </div>

            {kind ? (
              <>
                <div>
                  <Label htmlFor="mc-label" className="mb-1 text-[11px] text-muted-foreground">
                    {t('名字(可不填)')}
                  </Label>
                  <Input id="mc-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === 'cli' && cli ? `${KIND_LABEL.cli} · ${cli}` : KIND_LABEL[kind]} className="h-8 text-[12px]" />
                </div>

                {kind === 'cli' ? (
                  <div>
                    <Label className="mb-1 text-[11px] text-muted-foreground">{t('本机 CLI')}</Label>
                    <div className="flex flex-col gap-1">
                      {CLI_TOOLS.map((tool) => {
                        const det = cliDetected.find((d) => d.tool === tool);
                        return (
                          <button
                            key={tool}
                            type="button"
                            onClick={() => setCli(tool)}
                            className={cn('flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left hover:bg-muted', cli === tool && 'border-primary bg-primary/10')}
                          >
                            <span className="num w-14 font-semibold">{tool}</span>
                            {det?.ok ? (
                              <span className="num min-w-0 flex-1 truncate text-up" title={det.command ?? ''}>
                                {t('已探测到')} · {det.command ?? tool}
                              </span>
                            ) : (
                              <span className="min-w-0 flex-1 truncate text-muted-foreground">{t('未找到')}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1 text-[10.5px] text-muted-foreground">{t('CLI 连接走本机登录态 / 订阅,不需要 key;启动命令在设置页「CLI 启动命令」里改。')}</p>
                  </div>
                ) : (
                  <>
                    <div>
                      <Label htmlFor="mc-key" className="mb-1 text-[11px] text-muted-foreground">
                        API key
                        {editing?.key_masked ? <span className="num ml-1 text-muted-foreground/80">({t('当前')} {editing.key_masked})</span> : null}
                      </Label>
                      <Input id="mc-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={editing ? t('留空 = 不改') : 'sk-…'} className="num h-8 text-[12px]" />
                    </div>
                    {kind === 'openai_compatible' ? (
                      <div>
                        <Label htmlFor="mc-base" className="mb-1 text-[11px] text-muted-foreground">
                          base_url <span className="text-destructive">*</span>
                        </Label>
                        <Input id="mc-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" className="num h-8 text-[12px]" />
                        <p className="mt-1 text-[10.5px] text-muted-foreground">{t('必须 https;只有本机(localhost / 127.0.0.1 / ::1)且不填 key 时可用 http。内网 / 云元数据地址会被拒。')}</p>
                      </div>
                    ) : (
                      <p className="text-[10.5px] text-muted-foreground">
                        {t('地址固定为内置')} <span className="num">{DEFAULT_BASE_URL[kind]}</span>
                      </p>
                    )}
                  </>
                )}
              </>
            ) : null}

            {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{error}</div> : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-[12px]">
            {phase === 'testing' ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t('已保存,正在测试连接…(CLI 可能要一分多钟)')}
              </div>
            ) : test ? (
              <div className={cn('flex flex-col gap-1', test.ok ? 'text-up' : 'text-destructive')}>
                <div className="flex items-center gap-1.5">
                  <Badge variant={test.ok ? 'outline' : 'destructive'} className={cn('text-[10px]', test.ok && 'border-up/30 text-up')}>
                    {test.ok ? t('测试通过') : t('测试失败')}
                  </Badge>
                  {test.latency_ms != null ? <span className="num">{test.latency_ms}ms</span> : null}
                </div>
                <div className="num break-words text-[11px] text-muted-foreground">{test.detail}</div>
                {!test.ok ? <div className="text-[11px] text-muted-foreground">{t('连接已经存下了,可以关掉后在列表里「编辑」改 key 再测。')}</div> : null}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {phase === 'form' ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
                {t('取消')}
              </Button>
              <Button size="sm" disabled={busy || Boolean(missing)} title={missing ?? undefined} onClick={() => save.mutate()}>
                {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('保存并测试')}
              </Button>
            </>
          ) : (
            <>
              {phase === 'done' && savedId ? (
                <Button variant="outline" size="sm" onClick={() => void runTest(savedId)}>
                  {t('再测一次')}
                </Button>
              ) : null}
              <Button size="sm" onClick={() => onOpenChange(false)}>
                {phase === 'testing' ? t('关掉,后台继续测') : t('完成')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
