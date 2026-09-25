/** 最近的矩阵研究列表;onOpen 缺省跳 #matrix-study?id=,研究台内嵌时就地打开详情 */
import { useMatrixStudies, type MatrixStudyView } from '@/api/matrix-study';
import { fmtDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { STATUS_TEXT, shortSyms } from './shared';

const summary = (s: MatrixStudyView) => {
  const sp = s.manifest.spec, mine = sp.strategies?.length ?? 0;
  return `${shortSyms(sp.symbols)} — ${sp.timeframes.join('/')}${mine ? ` · ${t('我的策略 {n} 条', { n: mine })}` : ''}`;
};

export function MatrixStudyList({ limit = 20, onOpen, emptyHint = false }: { limit?: number; onOpen?: (id: string) => void; emptyHint?: boolean }) {
  const q = useMatrixStudies();
  const items = q.data?.items ?? [];
  if (!items.length) return emptyHint && !q.isLoading ? <p className="px-1 text-[12px] text-muted-foreground">{t('还没有矩阵研究')}</p> : null;
  return (
    <section className="rounded-lg border p-3">
      <h3 className="mb-2 text-[13px] font-medium">{t('最近的矩阵研究')}</h3>
      <div className="divide-y">
        {items.slice(0, limit).map((s) => (
          <a key={s.id} href={`#matrix-study?id=${encodeURIComponent(s.id)}`} onClick={onOpen ? (e) => { e.preventDefault(); onOpen(s.id); } : undefined} className="flex items-center gap-3 py-1.5 text-[12px] hover:bg-muted/50">
            <span className="num w-36 shrink-0 text-muted-foreground">{fmtDateTime(s.created_at)}</span>
            <span className="min-w-0 flex-1 truncate">{summary(s)}</span>
            <span>{STATUS_TEXT[s.status] ?? s.status}</span>
            {s.state.conclusion ? <span className={s.state.conclusion.kind === 'passed' ? 'text-up' : 'text-muted-foreground'}>{s.state.conclusion.kind === 'passed' ? t('有候选') : t('没找到')}</span> : null}
          </a>
        ))}
      </div>
    </section>
  );
}
