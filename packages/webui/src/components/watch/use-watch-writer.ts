/**
 * 观察列表的一键写入(加 / 移除 / 排序 / 可交易开关 / 上限):
 * 读 ['workflow'] 缓存 → 算下一版 → 乐观写回缓存 → 串行 PATCH /api/workflow(老接口,只带变了的字段)。
 * 串行保证连点几下「+」时请求按顺序落地;失败就回拉服务端,并 toast。
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Workflow } from '@/api/types';
import { t } from '@/lib/i18n';

export type WatchPatch = Pick<Workflow, 'watchlist'> & Partial<Pick<Workflow, 'watch_only' | 'watchlist_max'>>;

export function useWatchWriter() {
  const qc = useQueryClient();
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [pending, setPending] = useState(0);

  /** fn 拿到当前(含乐观)名单,返回要写的字段;返回 null 表示不写。 */
  const write = (fn: (wf: Workflow) => Partial<WatchPatch> | null, okText?: string) => {
    const cur = qc.getQueryData<Workflow>(['workflow']);
    if (!cur) {
      toast.error(t('工作流还没加载好,稍后再试'));
      return;
    }
    const patch = fn(cur);
    if (!patch || Object.keys(patch).length === 0) return;
    qc.setQueryData<Workflow>(['workflow'], { ...cur, ...patch });
    setPending((n) => n + 1);
    chain.current = chain.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const res = await api.patchWorkflow(patch);
          if (res.errors?.length) {
            toast.error(t('没保存'), { description: res.errors.join('；') });
            qc.setQueryData(['workflow'], res.workflow);
            return;
          }
          qc.setQueryData(['workflow'], res.workflow);
          void qc.invalidateQueries({ queryKey: ['overview'] });
          void qc.invalidateQueries({ queryKey: ['portfolio'] });
          if (okText) toast.success(okText);
        } catch (err) {
          toast.error(t('保存失败'), { description: err instanceof Error ? err.message : String(err) });
          void qc.invalidateQueries({ queryKey: ['workflow'] });
        } finally {
          setPending((n) => n - 1);
        }
      });
  };

  return { write, pending: pending > 0 };
}
