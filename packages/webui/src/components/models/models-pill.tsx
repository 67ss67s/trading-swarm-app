/**
 * 顶栏「模型连接 · n 个可用」胶囊(§9.52):n = status==='ok' 的连接数,点击跳 #models。
 * 有角色绑着一条失效连接(effective.source==='binding' 且连接 status==='error')时带红点,title 列出失效角色。
 * 老网关没有 /api/models:不画。
 */
import { Cable } from 'lucide-react';
import { t, listSep } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { brokenRoles, MODEL_ROLE_LABEL, okConnectionCount } from './logic';
import { useModels } from './use-models';

export function ModelsPill() {
  const q = useModels();
  if (!q.data) return null;
  const n = okConnectionCount(q.data);
  const broken = brokenRoles(q.data);
  const title = broken.length > 0 ? t('这些角色绑定的连接失效了:{roles}', { roles: broken.map((r) => MODEL_ROLE_LABEL[r]).join(listSep()) }) : t('去「模型连接」管理 API key / 本机 CLI 和角色底层');
  return (
    <a
      href="#models"
      title={title}
      data-testid="models-pill"
      className={cn('relative flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground', n === 0 && 'border-warn/40 text-warn')}
    >
      <Cable className="size-3 shrink-0" />
      <span className="num whitespace-nowrap">{t('模型连接 · {n} 个可用', { n })}</span>
      {broken.length > 0 ? <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-down ring-2 ring-background" data-testid="models-pill-alert" /> : null}
    </a>
  );
}
