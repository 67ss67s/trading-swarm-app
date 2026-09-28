/**
 * 楼层 PM 对话框的「仓位倍率生效模式」三段开关(off / advise / apply)。纯逻辑见 sizing-mode-logic.ts。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { lockReason } from '@/lib/edition';
import { getLang, t } from '@/lib/i18n';
import { PUBLIC_DEMO_BUILD } from '@/lib/nav';
import { isJudgeLockedError, normalizeSizingMode, SIZING_MODE_TEXT, SIZING_MODES, sizingLockReason, sizingModeLabel, type SizingMode } from './sizing-mode-logic';

// 评审版构建统一走 lib/edition.ts 的 lockReason(英文原因);公网体验版(VITE_PUBLIC_DEMO)沿用中文提示走 t()。
const BUILD_LOCK: string | null = lockReason('execution_policy') ?? (PUBLIC_DEMO_BUILD ? sizingLockReason({ readOnlyBuild: true, serverLocked: false }) : null);

/**
 * 读写仓位模式的**唯一切换点**。
 * 现在:GET /api/workflow 读 sizing_agent,POST /api/workflow { sizing_agent } 写(react-query key ['workflow'])。
 * 将来:§9.56 GET/PATCH /api/execution-policy 上线后(契约 docs/demo/v3-ui-contract.md,同样带 sizing_agent),
 * 只改本 hook 的 queryKey / queryFn / mutationFn / 失效的 key,组件不用动。
 */
export function useSizingMode() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const [serverLocked, setServerLocked] = useState(false);
  const m = useMutation({
    mutationFn: (mode: SizingMode) => api.patchWorkflow({ sizing_agent: mode }),
    onSuccess: (res, mode) => {
      qc.setQueryData(['workflow'], res.workflow);
      void qc.invalidateQueries({ queryKey: ['workflow'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      const errs = res.errors ?? [];
      if (errs.length > 0 || res.workflow.sizing_agent !== mode) toast.warning(t('仓位模式没生效'), { description: errs.join('; ') || undefined });
      else toast.success(t('仓位模式已切到「{m}」', { m: sizingModeLabel(mode, getLang()) }));
    },
    onError: (err) => {
      if (isJudgeLockedError(err)) setServerLocked(true);
      toast.error(t('仓位模式切换失败'), { description: err instanceof Error ? err.message : String(err) });
    },
  });
  return {
    mode: normalizeSizingMode(q.data?.sizing_agent),
    loading: q.isLoading,
    loadError: q.isError,
    setMode: (mode: SizingMode) => m.mutate(mode),
    pending: m.isPending,
    lockReason: BUILD_LOCK ?? sizingLockReason({ readOnlyBuild: false, serverLocked }),
  };
}

export function SizingModeSwitch() {
  const s = useSizingMode();
  const [hover, setHover] = useState<SizingMode | null>(null);
  const shown = hover ?? s.mode;
  const disabled = !!s.lockReason || s.pending || s.loading;
  return (
    <div className="sizing">
      <div className="srow">
        <span className="lbl">{t('仓位倍率生效模式')}</span>
        <div className="seg" role="radiogroup" aria-label={t('仓位倍率生效模式')} onMouseLeave={() => setHover(null)}>
          {SIZING_MODES.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={s.mode === k}
              className={s.mode === k ? 'on' : ''}
              disabled={disabled}
              title={s.lockReason ? t(s.lockReason) : t(SIZING_MODE_TEXT[k].hint)}
              onMouseEnter={() => setHover(k)}
              onClick={() => {
                if (k !== s.mode) s.setMode(k);
              }}
            >
              {sizingModeLabel(k, getLang())}
            </button>
          ))}
        </div>
      </div>
      <div className="shint">
        {s.pending ? t('保存中…') : shown ? t(SIZING_MODE_TEXT[shown].hint) : s.loadError ? t('读不到当前仓位模式') : t('加载中…')}
      </div>
      {s.lockReason ? <div className="slock">{t(s.lockReason)}</div> : null}
    </div>
  );
}
