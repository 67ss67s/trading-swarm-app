/** 最近的批量验证(内部名:矩阵研究)列表;onOpen 缺省跳 #matrix-study?id=,研究台内嵌时就地打开详情 */
import { useMatrixStudies, type MatrixStudyView } from '@/api/matrix-study';
import { fmtDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { STATUS_TEXT, shortSyms } from './shared';

const summary = (s: MatrixStudyView) => {
  const sp = s.manifest.spec, mine = sp.strategies?.length ?? 0;
  return `${shortSyms(sp.symbols)} — ${sp.timeframes.join('/')}${mine ? ` · ${t('我的策略 {n} 条', { n: mine })}` : ''}`;
};

/** 自动拆批出来的研究:「批次 i/N」+ 批次 id 末 4 位(同一批一眼能对上);没有 origin.batch 不显示 */
export function BatchTag({ s }: { s: MatrixStudyView }) {
  const b = s.manifest.spec.origin?.batch;
  if (!b || !b.id) return null;
  return (
    <span className="num shrink-0 rounded-full border border-primary/40 bg-primary/5 px-1.5 text-[11px] text-primary" title={t('同一批自动拆出来的研究:{id}', { id: b.id })} data-batch={b.id}>
      {t('批次 {i}/{n}', { i: b.index, n: b.total })} · {b.id.slice(-4)}
    </span>
  );
}

export function MatrixStudyList({ limit = 20, onOpen, emptyHint = false }: { limit?: number; onOpen?: (id: string) => void; emptyHint?: boolean }) {
  const q = useMatrixStudies();
  const items = q.data?.items ?? [];
  if (!items.length) return emptyHint && !q.isLoading ? <p className="px-1 text-[12px] text-muted-foreground">{t('还没有做过批量验证')}</p> : null;
  return (
    <section className="rounded-lg border p-3">
      <h3 className="mb-2 text-[13px] font-medium">{t('最近的批量验证')}</h3>
      <div className="divide-y">
        {items.slice(0, limit).map((s) => (
          <a key={s.id} href={`#matrix-study?id=${encodeURIComponent(s.id)}`} onClick={onOpen ? (e) => { e.preventDefault(); onOpen(s.id); } : undefined} className="flex items-center gap-3 py-1.5 text-[12px] hover:bg-muted/50">
            <span className="num w-36 shrink-0 text-muted-foreground">{fmtDateTime(s.created_at)}</span>
            <span className="min-w-0 flex-1 truncate">{summary(s)}</span>
            <BatchTag s={s} />
            <span>{STATUS_TEXT[s.status] ?? s.status}</span>
            {s.state.conclusion ? <span className={s.state.conclusion.kind === 'passed' ? 'text-up' : s.state.conclusion.paper_candidates ? 'text-primary' : 'text-muted-foreground'}>{s.state.conclusion.kind === 'passed' ? t('有通过的') : s.state.conclusion.paper_candidates ? t('候补 {n} 组', { n: s.state.conclusion.paper_candidates }) : t('没找到能用的')}</span> : null}
          </a>
        ))}
      </div>
    </section>
  );
}
