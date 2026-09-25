/**
 * 「CLI 启动命令」卡:每个 CLI(claude / codex / pi)在这台机器上到底怎么启动。
 *
 * 为什么需要:没有两个人的启动方式一样。有人 `claude` 就在 PATH 上;有人得带代理环境变量;
 * 有人只有一个写在 ~/.zshrc 里的别名(`claudeproxy`),这个别名在非交互 shell 里根本不存在。
 * 网关拿到这条命令后:单个词且在 PATH 上 → 直接起进程;其它一律经登录 shell(`-ilc`)执行,
 * 所以别名和环境变量前缀都能生效。
 *
 * 交互:输入框失焦 / 回车立刻 POST /api/workflow(部分对象即可),右边一个「测试」按钮跑
 * POST /api/brains/test 看这条命令能不能真的答话(会花几秒到一分钟)。徽章显示解析结果。
 *
 * react-query key 约定见 src/App.tsx:读写 ['workflow'],保存后重新探测 ['brains']。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { BrainKind, BrainOption, BrainTestResult, CliCommands, Workflow } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { exchangeInfo, type ExchangeInfo } from '@/lib/exchange';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

type CliKey = keyof CliCommands;

// hint 吃一个 ExchangeInfo:agent_mcp / MCP 登录是币安专属,OKX 模式下这两条路根本不存在。
const ROWS: { key: CliKey; label: string; hint: (ex: ExchangeInfo) => string }[] = [
  { key: 'claude', label: 'claude', hint: (ex) => (ex.id === 'okx' ? t('主脑 / 角色 agent') : t('主脑 / agent_mcp 执行 / 币安 MCP 登录')) },
  { key: 'codex', label: 'codex', hint: (ex) => (ex.id === 'okx' ? t('主脑 / 角色 agent') : t('主脑 / agent_mcp 执行')) },
  { key: 'pi', label: 'pi', hint: () => t('主脑 / 副脑(按 token 计费)') },
];

const DEFAULTS: CliCommands = { claude: 'claude', codex: 'codex', pi: 'pi' };

function resolvedBadge(opt: BrainOption | undefined): { text: string; className: string; title: string } {
  const r = opt?.resolved;
  if (!r) return { text: t('未知'), className: 'text-muted-foreground', title: t('网关没返回解析结果(旧版本)') };
  if (!r.ok) return { text: t('找不到'), className: 'border-destructive/40 text-destructive', title: r.detail };
  if (r.via === 'direct') return { text: t('直接起'), className: 'border-up/40 text-up', title: r.detail };
  return { text: t('经 shell'), className: 'border-up/40 text-up', title: r.detail };
}

export function CliCommandsCard({ className }: { className?: string }) {
  const queryClient = useQueryClient();
  const workflowQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const brainsQ = useQuery({ queryKey: ['brains'], queryFn: () => api.brains(), staleTime: 5 * 60_000, retry: 0 });
  // ['execution'] 全站共用一份缓存(轮询在 useExecutionQuery 里),这里只读不另加 interval
  const executionQ = useQuery({ queryKey: ['execution'], queryFn: api.execution });
  const ex = exchangeInfo(executionQ.data);

  const server = useMemo<CliCommands>(() => ({ ...DEFAULTS, ...(workflowQ.data?.cli_commands ?? {}) }), [workflowQ.data]);
  const serverSig = JSON.stringify(server);
  const [draft, setDraft] = useState<CliCommands | null>(null);
  const [errors, setErrors] = useState<Partial<Record<CliKey, string>>>({});
  const [results, setResults] = useState<Partial<Record<CliKey, BrainTestResult>>>({});
  const [testing, setTesting] = useState<CliKey | null>(null);
  const lastServerRef = useRef('');

  // 服务端值变了:草稿没被改过就跟着换,改过就保留用户还没保存的编辑。
  useEffect(() => {
    if (!workflowQ.data) return;
    const prev = lastServerRef.current;
    if (prev === serverSig) return;
    lastServerRef.current = serverSig;
    setDraft((cur) => (cur === null || JSON.stringify(cur) === prev ? (JSON.parse(serverSig) as CliCommands) : cur));
  }, [serverSig, workflowQ.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<CliCommands>) => api.patchWorkflow({ cli_commands: patch } as Partial<Workflow>),
    onSuccess: async (res) => {
      const byField: Partial<Record<CliKey, string>> = {};
      for (const e of res.errors ?? []) {
        const m = /^cli_commands\.(claude|codex|pi)\s*(.*)$/.exec(e);
        if (m) byField[m[1] as CliKey] = m[2] || e;
      }
      setErrors(byField);
      const next = { ...DEFAULTS, ...(res.workflow.cli_commands ?? {}) };
      // 出错的行保留用户输入,其它以服务端为准。
      setDraft((cur) => {
        const merged: CliCommands = { ...next };
        if (cur) for (const k of Object.keys(byField) as CliKey[]) merged[k] = cur[k];
        return merged;
      });
      lastServerRef.current = JSON.stringify(next);
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['workflow'] });
      void queryClient.invalidateQueries({ queryKey: ['execution'] });
      if ((res.errors ?? []).length) toast.warning(t('启动命令没保存'), { description: res.errors.join('; ') });
      else {
        // 命令变了要重新探测(?refresh=1),否则徽章还是上一条命令的结果。
        try {
          queryClient.setQueryData(['brains'], await api.brains(true));
        } catch {
          void queryClient.invalidateQueries({ queryKey: ['brains'] });
        }
      }
    },
    onError: (err) => toast.error(t('保存失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  if (!draft) {
    return (
      <div className={cn('space-y-2 p-3', className)}>
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    );
  }

  const commit = async (key: CliKey): Promise<boolean> => {
    const value = draft[key].trim();
    if (value === server[key]) return true;
    if (!value) {
      setErrors((e) => ({ ...e, [key]: t('不能留空,默认就写 CLI 的名字') }));
      return false;
    }
    await save.mutateAsync({ [key]: value } as Partial<CliCommands>);
    return true;
  };

  const runTest = async (key: CliKey): Promise<void> => {
    if (!(await commit(key))) return;
    setTesting(key);
    setResults((r) => ({ ...r, [key]: undefined }));
    try {
      const res = await api.testBrain(key as BrainKind, null);
      setResults((r) => ({ ...r, [key]: res }));
      if (res.ok) toast.success(t('{cli} 通了', { cli: key }), { description: `${res.name} · ${res.latency_ms} ms` });
      else toast.error(t('{cli} 没通', { cli: key }), { description: res.error ?? t('没有返回内容') });
    } catch (e) {
      setResults((r) => ({ ...r, [key]: { ok: false, kind: key as BrainKind, model: null, name: key, latency_ms: 0, text: null, error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className={cn('flex flex-col', className)}>
      {ROWS.map(({ key, label, hint }) => {
        const opt = brainsQ.data?.brains.find((b) => b.kind === key);
        const badge = resolvedBadge(opt);
        const dirty = draft[key].trim() !== server[key];
        const result = results[key];
        return (
          <div key={key} className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`cli-cmd-${key}`} className="num w-14 shrink-0 text-[12px] font-normal">
                {label}
              </Label>
              <Input
                id={`cli-cmd-${key}`}
                value={draft[key]}
                placeholder={DEFAULTS[key]}
                onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))}
                onBlur={() => void commit(key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commit(key);
                  }
                }}
                className="num h-7 min-w-0 flex-1 text-[12px]"
              />
              <Badge variant="outline" className={cn('shrink-0 text-[10.5px]', badge.className)} title={badge.title}>
                {badge.text}
              </Badge>
              {dirty ? (
                <Button size="xs" variant="outline" disabled={save.isPending} onClick={() => void commit(key)}>
                  {t('保存')}
                </Button>
              ) : null}
              <Button size="xs" variant="outline" disabled={testing !== null || save.isPending} onClick={() => void runTest(key)}>
                {testing === key ? <Loader2 className="size-3 animate-spin" /> : null}
                {t('测试')}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-16 text-[10.5px] leading-relaxed">
              <span className="text-muted-foreground">{hint(ex)}</span>
              {errors[key] ? <span className="text-destructive">{errors[key]}</span> : null}
              {result ? (
                <span className={cn('num', result.ok ? 'text-up' : 'text-destructive')} title={result.error ?? result.text ?? ''}>
                  {result.ok ? `${t('通了')} · ${result.name} · ${result.latency_ms} ms` : `${t('没通')} · ${(result.error ?? '').slice(0, 120)}`}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}

      <div className="px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('可以填别名(比如')} <span className="num">claudeproxy</span>{t('),也可以填带环境变量前缀的命令,都走你的登录 shell。单个词且在 PATH 上就直接起进程(徽章「直接起」),其余经')} <span className="num">{'$SHELL -ilc'}</span> {t('执行(徽章「经 shell」),所以 ~/.zshrc 里的别名也能用。改完立刻生效,不用重启网关。')}
      </div>
    </div>
  );
}
