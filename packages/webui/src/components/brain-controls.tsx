/**
 * 「回退主脑 / 副脑」控件(§9.52 起:未单独绑定的角色用这里;按角色绑连接 + 模型在 #models 页)。
 * 原大脑切换控件(v3.3):两行 BrainPickerRow(判断/对话大脑、信息员大脑)+ 一个显式「应用」
 * 按钮,直接 POST /api/workflow(不是 Agent 页那套 draft/保存 流程),POST 回来的 errors
 * 贴到对应字段下,成功后失效 ['workflow'] 与 ['overview']。
 *
 * 两处复用:顶栏大脑名的 Popover(components/top-bar.tsx)、设置页「大脑」卡(pages/settings.tsx)。
 * id 前缀由调用方给(datalist id 必须全局唯一,两处同时挂载时不能撞)。
 *
 * react-query key 约定见 src/App.tsx 顶部注释:这里只读 ['workflow'] 与 ['brains'],
 * workflow.changed SSE 会自动把服务端值推进来(草稿脏时不覆盖用户没应用的编辑)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Workflow } from '@/api/types';
import { BrainPickerRow } from '@/components/brain-picker';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';
import { ROLE_META } from '@/components/floor/roles';
import { SLOT_ROLES, SLOT_ROLE_DUTY, type BrainSlot } from '@/lib/role-brain';
import { MODEL_ROLE_LABEL, MODEL_ROLES } from '@/components/models/logic';
import { useModels } from '@/components/models/use-models';

type BrainDraft = Pick<Workflow, 'brain' | 'brain_model' | 'cheap_brain' | 'cheap_brain_model'>;

const BRAIN_FIELDS: (keyof BrainDraft)[] = ['brain', 'brain_model', 'cheap_brain', 'cheap_brain_model'];

const BRAIN_FIELD_LABEL: Record<string, string> = tmap({
  brain: '回退主脑',
  brain_model: '回退主脑模型',
  cheap_brain: '回退副脑',
  cheap_brain_model: '回退副脑模型',
});

function pickBrains(w: Workflow): BrainDraft {
  return { brain: w.brain, brain_model: w.brain_model ?? null, cheap_brain: w.cheap_brain, cheap_brain_model: w.cheap_brain_model ?? null };
}

/** 服务端 errors 每条以字段名开头;先长后短匹配,免得 brain_model 被 brain 抢走。 */
function splitBrainErrors(errors: string[]): { byField: Record<string, string>; general: string[] } {
  const byField: Record<string, string> = {};
  const general: string[] = [];
  const fields = Object.keys(BRAIN_FIELD_LABEL).sort((a, b) => b.length - a.length);
  for (const e of errors) {
    const field = fields.find((f) => e.startsWith(f));
    if (field) byField[field] = e.slice(field.length).replace(/^[\s:：]+/, '') || e;
    else general.push(e);
  }
  return { byField, general };
}

/**
 * 槽位下挂的角色。§9.52 起:有 ModelsView 时列「当前回退到这个槽位」的模型角色(没单独绑定的);
 * 老网关没有 /api/models 时照旧列楼层呼号(颜色和团队卡一致)。
 */
export function SlotRoles({ slot }: { slot: BrainSlot }) {
  const modelsQ = useModels();
  if (modelsQ.data) {
    const src = slot === 'main' ? 'fallback_main' : 'fallback_cheap';
    const roles = MODEL_ROLES.filter((r) => modelsQ.data.effective[r]?.source === src);
    return <span className="num">{roles.length > 0 ? t('回退到这里:{roles}', { roles: roles.map((r) => MODEL_ROLE_LABEL[r]).join('、') }) : t('没有角色回退到这里(都单独绑定了)')}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      {SLOT_ROLES[slot].map((r) => (
        <span key={r} className="num">
          <span className="font-semibold" style={{ color: ROLE_META[r].color }}>
            {ROLE_META[r].callsign}
          </span>{' '}
          {SLOT_ROLE_DUTY[r]}
        </span>
      ))}
    </span>
  );
}

export function BrainControls({ idPrefix, className, onApplied }: { idPrefix: string; className?: string; onApplied?: () => void }) {
  const queryClient = useQueryClient();
  const workflowQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const brainsQ = useQuery({ queryKey: ['brains'], queryFn: () => api.brains(), staleTime: 5 * 60_000, retry: 0 });

  const server = useMemo(() => (workflowQ.data ? pickBrains(workflowQ.data) : null), [workflowQ.data]);
  const serverSig = server ? JSON.stringify(server) : '';
  const [draft, setDraft] = useState<BrainDraft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalErrors, setGeneralErrors] = useState<string[]>([]);
  const lastServerRef = useRef('');

  // 服务端值变了:草稿干净(等于上一版服务端值)就跟着换;脏就保留用户没应用的编辑。
  useEffect(() => {
    if (!serverSig) return;
    const prev = lastServerRef.current;
    if (prev === serverSig) return;
    lastServerRef.current = serverSig;
    setDraft((cur) => (cur === null || JSON.stringify(cur) === prev ? (JSON.parse(serverSig) as BrainDraft) : cur));
  }, [serverSig]);

  const patch = useMemo(() => {
    if (!server || !draft) return {} as Partial<BrainDraft>;
    const out: Record<string, unknown> = {};
    for (const k of BRAIN_FIELDS) if (JSON.stringify(server[k]) !== JSON.stringify(draft[k])) out[k] = draft[k];
    return out as Partial<BrainDraft>;
  }, [server, draft]);
  const dirty = Object.keys(patch).length > 0;

  const apply = useMutation({
    mutationFn: (p: Partial<Workflow>) => api.patchWorkflow(p),
    onSuccess: (res) => {
      const next = pickBrains(res.workflow);
      const { byField, general } = splitBrainErrors(res.errors ?? []);
      setFieldErrors(byField);
      setGeneralErrors(general);
      // 出错的字段保留用户输入,其它以服务端为准
      setDraft((cur) => {
        const merged: Record<string, unknown> = { ...next };
        if (cur) for (const f of Object.keys(byField)) merged[f] = (cur as unknown as Record<string, unknown>)[f];
        return merged as unknown as BrainDraft;
      });
      lastServerRef.current = JSON.stringify(next);
      queryClient.setQueryData(['workflow'], res.workflow);
      void queryClient.invalidateQueries({ queryKey: ['workflow'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['brains'] });
      if ((res.errors ?? []).length > 0) toast.warning(t('{n} 个字段没生效', { n: res.errors.length }), { description: res.errors.join('; ') });
      else {
        toast.success(t('回退主脑 / 副脑换好了,未绑定的角色下一次调用就用新的'));
        onApplied?.();
      }
    },
    onError: (err) => toast.error(t('切换失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  if (!draft) {
    return (
      <div className={cn('space-y-2 p-3', className)}>
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    );
  }

  const current = brainsQ.data?.current ?? null;
  const brains = brainsQ.data?.brains ?? [];

  return (
    <div className={cn('flex flex-col', className)}>
      {current ? (
        <div className="num px-3 pt-2 text-[10.5px] leading-relaxed text-muted-foreground">
          {t('当前生效')}:{t('回退主脑')} <span className="text-foreground">{current.brain}</span> · {t('回退副脑')} <span className="text-foreground">{current.cheap_brain}</span>
          <div>{t('未单独绑定的角色用这里;按角色单独绑连接和模型去')} <a href="#models" className="text-primary hover:underline">{t('模型连接')}</a>。</div>
        </div>
      ) : null}

      <BrainPickerRow
        id={`${idPrefix}-brain-main`}
        label={t('回退主脑')}
        hint={<SlotRoles slot="main" />}
        kind={draft.brain}
        model={draft.brain_model}
        brains={brains}
        onKindChange={(k) => setDraft((w) => (w ? { ...w, brain: k } : w))}
        onModelChange={(m) => setDraft((w) => (w ? { ...w, brain_model: m && m.trim() !== '' ? m : null } : w))}
        kindError={fieldErrors['brain']}
        modelError={fieldErrors['brain_model']}
      />
      <BrainPickerRow
        id={`${idPrefix}-brain-cheap`}
        label={t('回退副脑')}
        hint={<SlotRoles slot="cheap" />}
        kind={draft.cheap_brain}
        model={draft.cheap_brain_model}
        brains={brains}
        onKindChange={(k) => setDraft((w) => (w ? { ...w, cheap_brain: k } : w))}
        onModelChange={(m) => setDraft((w) => (w ? { ...w, cheap_brain_model: m && m.trim() !== '' ? m : null } : w))}
        kindError={fieldErrors['cheap_brain']}
        modelError={fieldErrors['cheap_brain_model']}
      />

      <div className="px-3 pb-1 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('按 token 计费的大脑(pi)要花钱,claude / codex 走订阅。模型可以直接手打,pi 写成')} <span className="num">provider/model</span>。
      </div>

      {generalErrors.length > 0 ? (
        <div className="mx-3 mb-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{generalErrors.join('; ')}</div>
      ) : null}

      <div className="flex items-center gap-1.5 px-3 pb-2.5">
        <Button size="sm" className="flex-1" disabled={!dirty || apply.isPending} onClick={() => apply.mutate(patch as Partial<Workflow>)}>
          {apply.isPending ? t('应用中…') : dirty ? t('应用 {n} 项', { n: Object.keys(patch).length }) : t('没有改动')}
        </Button>
        {dirty ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (server) setDraft(server);
              setFieldErrors({});
              setGeneralErrors([]);
            }}
          >
            {t('撤销')}
          </Button>
        ) : null}
      </div>
      {dirty ? (
        <div className="num truncate px-3 pb-2 text-[10.5px] text-muted-foreground">
          {t('待应用')}:{Object.keys(patch).map((k) => BRAIN_FIELD_LABEL[k] ?? k).join('、')}
        </div>
      ) : null}
    </div>
  );
}
