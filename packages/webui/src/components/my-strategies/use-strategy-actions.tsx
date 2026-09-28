/**
 * 卡片 / 行 / 详情页共用的写操作:重命名、关注、提醒、重新回测、归档、分享、跳研究页、新建。
 * 所有写操作成功后一次性失效两个前缀(App.tsx 顶部 key 约定):
 *   ['research','my-strategies',filter,sort,q]  列表
 *   ['research','my-strategy',id,report]        详情
 * 归档走 ConfirmDialog 二次确认;重命名用一个小 Dialog。弹窗元素由调用方渲染 `dialogs`。
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ResearchStrategy, ResearchStrategyPatch } from '@trade-gate/contracts';
import { researchApi } from '@/api/client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';
import type { StrategyCardActions } from './strategy-card';
import { copyLink, detailHash, researchHash } from './model';

export function invalidateMyStrategies(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['research', 'my-strategies'] }),
    qc.invalidateQueries({ queryKey: ['research', 'my-strategy'] }),
  ]);
}

export function errText(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 404) return t('后端还没有策略对象接口(404)');
  return err instanceof Error ? err.message : String(err);
}

export function go(hash: string): void {
  window.location.hash = hash;
}

export function useStrategyActions(opts: { onArchived?: (s: ResearchStrategy) => void } = {}) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState<ResearchStrategy | null>(null);
  const [renameText, setRenameText] = useState('');
  const [archiving, setArchiving] = useState<ResearchStrategy | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const patch = useMutation({
    mutationFn: (v: { id: string; body: ResearchStrategyPatch }) => researchApi.patchMyStrategy(v.id, v.body),
    onSuccess: () => void invalidateMyStrategies(qc),
    onError: (e) => toast.error(errText(e)),
  });

  const archive = useMutation({
    mutationFn: (s: ResearchStrategy) => researchApi.archiveMyStrategy(s.id),
    onSuccess: (_r, s) => {
      toast.success(t('已归档「{name}」', { name: s.name }));
      setArchiving(null);
      void invalidateMyStrategies(qc);
      opts.onArchived?.(s);
    },
    onError: (e) => toast.error(errText(e)),
  });

  const create = useMutation({
    mutationFn: () => researchApi.createMyStrategy({ name: t('未命名策略') }),
    onSuccess: (s) => {
      void invalidateMyStrategies(qc);
      go(researchHash(s.id, { fresh: true }));
    },
    onError: (e) => toast.error(errText(e)),
  });

  const runBacktest = async (s: ResearchStrategy): Promise<string | null> => {
    setBusy((prev) => new Set(prev).add(s.id));
    try {
      const r = await researchApi.backtestMyStrategy(s.id, {});
      toast.success(t('「{name}」回测完成', { name: s.name }));
      await invalidateMyStrategies(qc);
      return r.report_id;
    } catch (e) {
      toast.error(errText(e));
      return null;
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
  };

  const actions: StrategyCardActions = {
    open: (s) => go(detailHash(s.id)),
    share: (s) => {
      copyLink(detailHash(s.id, s.summary?.report_id)).then(
        () => toast.success(t('已复制策略链接')),
        (e) => toast.error(errText(e)),
      );
    },
    rename: (s) => {
      setRenameText(s.name);
      setRenaming(s);
    },
    toggleWatchlist: (s) => patch.mutate({ id: s.id, body: { watchlist: !s.watchlist } }),
    toggleAlerts: (s) => patch.mutate({ id: s.id, body: { alerts: !s.alerts } }),
    rebacktest: (s) => void runBacktest(s),
    archive: (s) => setArchiving(s),
    continueBuilding: (s) => go(researchHash(s.id, { session: s.origin?.session_id ?? null })),
  };

  const submitRename = () => {
    const name = renameText.trim();
    if (!renaming || !name || name === renaming.name) {
      setRenaming(null);
      return;
    }
    patch.mutate({ id: renaming.id, body: { name } }, { onSuccess: () => setRenaming(null) });
  };

  const dialogs: ReactNode = (
    <>
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('重命名策略')}</DialogTitle>
            <DialogDescription className="sr-only">{t('重命名策略')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameText}
            maxLength={120}
            onChange={(e) => setRenameText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
            }}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenaming(null)} disabled={patch.isPending}>
              {t('取消')}
            </Button>
            <Button size="sm" onClick={submitRename} disabled={patch.isPending || !renameText.trim()}>
              {patch.isPending ? t('处理中…') : t('保存')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!archiving}
        title={t('归档策略')}
        summary={t('确认归档')}
        danger
        busy={archive.isPending}
        onCancel={() => setArchiving(null)}
        onConfirm={() => archiving && archive.mutate(archiving)}
      >
        <p>{t('「{name}」会从列表里移走,版本、回测报告和事件记录都保留。', { name: archiving?.name ?? '' })}</p>
      </ConfirmDialog>
    </>
  );

  return { actions, dialogs, busy, runBacktest, create: () => create.mutate(), creating: create.isPending };
}
