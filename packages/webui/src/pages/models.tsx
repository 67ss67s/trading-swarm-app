/**
 * #models「模型连接」页(docs/demo/v3-ui-contract.md §9.52,设计 chat-to-strategy-loop §3.7 / 验收 F1–F2)。
 * 上:连接列表(API key / 本机 CLI,测试 / 编辑 / 删除)+「添加连接」弹层;
 * 下:「角色底层」表,7 个角色各选连接 + 模型,改了立即 PUT 生效。
 * 未单独绑定的角色回退到旧的两个槽位(本页底部「默认」一节:回退主脑 / 副脑);绑定的连接失效时该角色直接报错,不静默回退。
 * 2026-09-25 ③-8:回退槽位从顶栏大脑弹层 / 设置页卡片收进本页,顶栏只留模型连接胶囊。
 *
 * react-query:只读 ['models'](GET /api/models);SSE `models.changed` 由 App.tsx 直接写进这份缓存。
 */
import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { ModelConnection } from '@/api/types';
import { BrainControls } from '@/components/brain-controls';
import { ConnectionDialog } from '@/components/models/connection-dialog';
import { ConnectionList } from '@/components/models/connection-list';
import { brokenRoles, MODEL_ROLE_LABEL, okConnectionCount } from '@/components/models/logic';
import { RoleBindings } from '@/components/models/role-bindings';
import { useModels } from '@/components/models/use-models';
import { Pane, Workspace } from '@/components/pane';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { t } from '@/lib/i18n';

export function ModelsPage() {
  const q = useModels();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ModelConnection | null>(null);
  const view = q.data ?? null;
  const broken = brokenRoles(view);

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <Workspace className="shrink-0">
        <Pane
          title={t('模型连接')}
          hint={view ? t('{ok} / {n} 个可用', { ok: okConnectionCount(view), n: view.connections.length }) : undefined}
          actions={
            <>
              <Button size="xs" variant="ghost" onClick={() => void q.refetch()} disabled={q.isFetching} title={t('刷新')}>
                <RefreshCw className={q.isFetching ? 'animate-spin' : undefined} />
              </Button>
              <Button size="xs" onClick={openAdd} disabled={!view}>
                <Plus />
                {t('添加连接')}
              </Button>
            </>
          }
        >
          {q.isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : q.isError || !view ? (
            <p className="p-3 text-[12px] text-destructive">
              {t('加载失败')}:{q.error instanceof Error ? q.error.message : String(q.error ?? '')}
              <span className="ml-1 text-muted-foreground">{t('(网关可能还没接 /api/models)')}</span>
            </p>
          ) : (
            <ConnectionList
              view={view}
              onEdit={(c) => {
                setEditing(c);
                setDialogOpen(true);
              }}
            />
          )}
        </Pane>
      </Workspace>

      {view ? (
        <Workspace className="shrink-0">
          <Pane title={t('角色底层')} hint={t('每个角色单独选连接 + 模型,改了立即生效;不单独绑定的用下面「默认」一节的回退主脑 / 副脑')}>
            {broken.length > 0 ? (
              <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
                {t('这些角色绑定的连接失效了,调用会直接报错(不会静默回退):{roles}', { roles: broken.map((r) => MODEL_ROLE_LABEL[r]).join('、') })}
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <RoleBindings view={view} />
            </div>
            <div className="border-t px-3 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
              {t('判断要素(Jev)走 OpenRouter 的 Decisions API,只能绑 OpenRouter 连接;typesafe/ 开头的模型只给它用。')}
              <button type="button" className="ml-1 text-primary hover:underline" onClick={() => document.getElementById('models-fallback')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                {t('改回退主脑 / 副脑 ↓')}
              </button>
            </div>
          </Pane>
        </Workspace>
      ) : null}

      <div id="models-fallback">
        <Workspace className="shrink-0">
          <Pane title={t('默认(回退主脑 / 副脑)')} hint={t('上面没单独绑定的角色用这里;老网关没有 /api/models 时,所有角色都用这里')}>
            <BrainControls idPrefix="models" />
          </Pane>
        </Workspace>
      </div>

      <ConnectionDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} cliDetected={view?.cli_detected ?? []} />
    </div>
  );
}
