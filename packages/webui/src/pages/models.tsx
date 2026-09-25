/**
 * #models「模型连接」页(docs/demo/v3-ui-contract.md §9.52,设计 chat-to-strategy-loop §3.7 / 验收 F1–F2)。
 *
 * 2026-09-25 重做(Jacky:「每个 agent 都分开来,都改成能选 cli 和 apikey,且带一个测试连接的功能」):
 *   主体 = 7 张 agent 卡(components/models/role-card.tsx):每张自己选「本机 CLI | API key | 用默认」+ 模型,
 *         保存即 PUT /api/models/bindings/:role,「测试连接」= POST /api/models/bindings/:role/test;
 *   顶部一行说明没单独设置的 agent 用哪个默认(主脑 / 副脑);
 *   折叠区「高级:未单独设置时用的默认」= 原回退主脑 / 副脑控件(BrainControls);
 *   折叠区「已保存的连接」= 原连接列表(测试 / 编辑 / 删除)+「添加连接」弹层。
 * 绑定的连接失效时该角色直接报错,不静默回退(卡片红点 + 顶部提示)。
 *
 * react-query:只读 ['models'](GET /api/models);SSE `models.changed` 由 App.tsx 直接写进这份缓存。
 */
import { useState, type ReactNode } from 'react';
import { ChevronRight, Plus, RefreshCw } from 'lucide-react';
import type { ModelConnection, ModelsView } from '@/api/types';
import { BrainControls } from '@/components/brain-controls';
import { ConnectionDialog } from '@/components/models/connection-dialog';
import { ConnectionList } from '@/components/models/connection-list';
import { brokenRoles, MODEL_ROLES, okConnectionCount, roleCard } from '@/components/models/logic';
import { RoleCard } from '@/components/models/role-card';
import { useModels } from '@/components/models/use-models';
import { Pane, Workspace } from '@/components/pane';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { t } from '@/lib/i18n';

/** 当前默认主脑 / 副脑的名字:从回退到它的角色的 effective 里取(没有角色回退时不知道,显示 —) */
function defaultNames(view: ModelsView): { main: string; cheap: string } {
  const pick = (src: 'fallback_main' | 'fallback_cheap') => MODEL_ROLES.map((r) => view.effective[r]).find((e) => e?.source === src)?.name || '—';
  return { main: pick('fallback_main'), cheap: pick('fallback_cheap') };
}

function Fold({ id, title, hint, actions, children, defaultOpen = false }: { id: string; title: string; hint?: string; actions?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div id={id} className="shrink-0 rounded-lg border bg-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="text-[12.5px] font-semibold">{title}</span>
          {hint ? <span className="min-w-0 truncate text-[11px] text-muted-foreground">{hint}</span> : null}
        </button>
        {open && actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {open ? <div className="border-t">{children}</div> : null}
    </div>
  );
}

export function ModelsPage() {
  const q = useModels();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ModelConnection | null>(null);
  const view = q.data ?? null;
  const broken = brokenRoles(view);
  const defaults = view ? defaultNames(view) : null;

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <Workspace className="shrink-0">
        <Pane
          title={t('模型连接')}
          hint={t('每个 agent 单独选用本机 CLI 或 API key,保存即生效,卡上可以直接测试连接')}
          actions={
            <Button size="xs" variant="ghost" onClick={() => void q.refetch()} disabled={q.isFetching} title={t('刷新')}>
              <RefreshCw className={q.isFetching ? 'animate-spin' : undefined} />
            </Button>
          }
        >
          {q.isLoading ? (
            <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-56 w-full" />
              ))}
            </div>
          ) : q.isError || !view ? (
            <p className="p-3 text-[12px] text-destructive">
              {t('加载失败')}:{q.error instanceof Error ? q.error.message : String(q.error ?? '')}
              <span className="ml-1 text-muted-foreground">{t('(网关可能还没接 /api/models)')}</span>
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-1 border-b px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="models-defaults-line">
                <span>{t('没单独设置的 agent 用默认:')}</span>
                <span className="num text-foreground">{t('主脑 {name}', { name: defaults!.main })}</span>
                <span>·</span>
                <span className="num text-foreground">{t('副脑 {name}', { name: defaults!.cheap })}</span>
                <button type="button" className="ml-1 text-primary hover:underline" onClick={() => document.getElementById('models-fallback')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  {t('改默认 ↓')}
                </button>
              </div>
              {broken.length > 0 ? (
                <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
                  {t('这些 agent 的连接失效了,调用会直接报错(不会静默回退):{roles}', { roles: broken.map((r) => roleCard(r).title).join('、') })}
                </div>
              ) : null}
              <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3" data-testid="role-cards">
                {MODEL_ROLES.map((role) => (
                  <RoleCard key={role} role={role} view={view} />
                ))}
              </div>
            </>
          )}
        </Pane>
      </Workspace>

      <Fold id="models-fallback" title={t('高级:未单独设置时用的默认')} hint={t('对话 / 判断 / 研究回退主脑,策略过滤 / 复盘 / 信息员回退副脑')}>
        <BrainControls idPrefix="models" />
      </Fold>

      {view ? (
        <Fold
          id="models-connections"
          title={t('已保存的连接')}
          hint={t('{ok} / {n} 个可用', { ok: okConnectionCount(view), n: view.connections.length })}
          actions={
            <Button size="xs" variant="outline" onClick={openAdd}>
              <Plus />
              {t('添加连接')}
            </Button>
          }
        >
          <ConnectionList
            view={view}
            onEdit={(c) => {
              setEditing(c);
              setDialogOpen(true);
            }}
          />
        </Fold>
      ) : null}

      <ConnectionDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} cliDetected={view?.cli_detected ?? []} />
    </div>
  );
}
