/**
 * 楼层顶部引导横幅(§9.52):没有任何可用连接,且两个旧槽位当前选的 CLI 都起不来时出现,
 * 引导去「模型连接」添加。判定见 logic.ts needsModelSetup;数据没到齐不出,免得误报。
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { t } from '@/lib/i18n';
import { needsModelSetup } from './logic';
import { useModels } from './use-models';

export function ModelSetupBanner({ slots }: { slots: { brain: string; cheap_brain: string } | null | undefined }) {
  const modelsQ = useModels();
  const brainsQ = useQuery({ queryKey: ['brains'], queryFn: () => api.brains(), staleTime: 5 * 60_000, retry: 0 });
  if (!needsModelSetup(modelsQ.data, brainsQ.data?.brains, slots)) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[var(--of-warn)] bg-[var(--of-panel-2)] px-4 py-2 text-[11px]" data-testid="model-setup-banner">
      <span className="of-kicker" style={{ color: 'var(--of-warn)' }}>
        {t('没有可用的模型')}
      </span>
      <span className="text-[var(--of-ink-dim)]">{t('还没有能用的模型连接,回退主脑 / 副脑的 CLI 也没找到——团队现在调不了模型。添加一个 API key 或本机 CLI 就能开工。')}</span>
      <button
        type="button"
        className="ml-auto shrink-0 border px-2 py-1 text-[10px] font-semibold hover:bg-[var(--of-panel)]"
        style={{ borderColor: 'var(--of-warn)', color: 'var(--of-warn)' }}
        onClick={() => (window.location.hash = 'models')}
      >
        {t('去「模型连接」添加 →')}
      </button>
    </div>
  );
}
