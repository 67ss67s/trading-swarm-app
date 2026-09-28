import { backendLabel } from '@/lib/format';
import { IS_JUDGE } from '@/lib/edition';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/* 底部状态栏:连接/后端/大脑 —— 桌面应用的信息沉底位(仿 8793 status-bar.tsx,去掉版本号/i18n)。 */
export function StatusBar({ connected, backend, brain }: { connected: boolean; backend: string; brain: string }) {
  return (
    <footer className="flex h-6.5 shrink-0 items-center gap-4 border-t bg-sidebar px-3 text-[11px] text-muted-foreground select-none">
      <span className="flex items-center gap-1.5">
        <span className={cn('size-1.5 rounded-full', connected ? 'bg-up' : 'bg-down')} />
        {connected ? t('实时连接正常') : t('连接断了,正在重连')}
      </span>
      <span className="num">{t('后端')} {backendLabel(backend)}</span>
      {/* 评审版:旧「主脑」槽位(workflow.brain)不反映按角色绑定的实际模型,访客又读不到 /api/models,干脆不显示 */}
      {IS_JUDGE ? null : <span className="num ml-auto">{t('主脑')} {brain}</span>}
    </footer>
  );
}
