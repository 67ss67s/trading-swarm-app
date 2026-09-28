/**
 * 研究报告的「概念覆盖」段(§9.45):问题里抽出的指标 / 形态 / 数据概念,各自解析到哪里。
 *   mapped   已有实现(原语目录 / 词典 / 数据目录)
 *   acquired 本轮 acquire_concept 子 loop 拿到了实现(原语,或 pine_author 写成并通过准入的 Pine 脚本)
 *   proxy    用近似实现代替,语义有差异
 *   unmapped 没有实现,note 写原因
 *
 * 数据来源:inquiry.checkpoint.concepts(LoopConcept[],GET /api/research/inquiries/:id 或会话详情的 inquiries[] 里)。
 * 与后端 revisions.ts 生成的 markdown「概念覆盖」段同源同分组,这里是结构化渲染。
 * acquired 且指向 Pine 脚本的概念可点开,看脚本正文与准入结论(GET /api/research/pine/scripts/:id)。
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileCode, LoaderCircle } from 'lucide-react';
import type { LoopConcept, LoopConceptStatus } from '@trade-gate/contracts';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AdmissionVerdictBadge, PineAdmissionReportView, PineInputsTable, pineApi, pineKeys } from '@/components/research-workbench/pine-catalog';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<LoopConceptStatus, string> = tmap({ mapped: '已映射', acquired: '本轮获取', proxy: '近似代理', unmapped: '未支持' });
const STATUS_CLASS: Record<LoopConceptStatus, string> = {
  mapped: 'bg-up/15 text-up',
  acquired: 'bg-primary/15 text-primary',
  proxy: 'bg-warn/15 text-warn',
  unmapped: 'bg-down/10 text-down',
};
const SOURCE_LABEL: Record<string, string> = tmap({ primitive_registry: '原语目录', lexicon: '词典', data_catalog: '数据目录', acquired: '本轮获取', none: '无来源' });
const CATEGORY_LABEL: Record<string, string> = tmap({ indicator: '指标', pattern: '形态', structure: '结构', data_metric: '数据指标', comparison: '对比', timeframe: '周期', asset: '资产', risk: '风险' });

const GROUPS: { key: string; title: string; hint: string; statuses: LoopConceptStatus[] }[] = [
  { key: 'mapped', title: '映射到已有实现', hint: '', statuses: ['mapped', 'acquired'] },
  { key: 'proxy', title: '用近似实现代理', hint: '语义有差异', statuses: ['proxy'] },
  { key: 'unmapped', title: '没有支持', hint: '', statuses: ['unmapped'] },
];

/** acquired 概念若由 pine_author 写成脚本:target 是脚本 id,note 里也带 script_id=…;两处都认。 */
export function pineScriptIdOf(c: LoopConcept): string | null {
  if (c.status !== 'acquired') return null;
  const fromNote = /script_id=([A-Za-z0-9_\-.:]+)/.exec(c.note)?.[1];
  if (fromNote) return fromNote;
  return c.target && /^pine_/.test(c.target) ? c.target : null;
}

/** target 在不同来源下含义不同,给一个人看的前缀。 */
function targetLabel(c: LoopConcept, pineId: string | null): string {
  if (pineId) return t('Pine 脚本');
  if (c.source === 'primitive_registry' || (c.source === 'acquired' && c.target)) return t('原语');
  if (c.source === 'data_catalog') return c.category === 'asset' ? t('资产') : c.category === 'timeframe' ? t('周期') : t('数据指标');
  if (c.source === 'lexicon') return c.category === 'timeframe' ? t('周期') : c.category === 'asset' ? t('资产') : c.category === 'data_metric' ? t('数据指标') : t('实现');
  return t('实现');
}

function PineScriptDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = useQuery({ queryKey: pineKeys.script(id), queryFn: () => pineApi.script(id), enabled: open, retry: false, staleTime: 30_000 });
  const s = q.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[min(900px,94vw)] overflow-auto sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {s?.name ?? id}
            {s ? <AdmissionVerdictBadge ok={s.admission_report ? s.admission_report.ok : null} /> : null}
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px]">{id}</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('读取脚本…')}</div>
        ) : q.error || !s ? (
          <div className="text-[11px] text-down">{t('脚本读不到(可能已被删除)')}:{q.error instanceof Error ? q.error.message : String(q.error ?? '')}</div>
        ) : (
          <div className="space-y-3">
            {s.description ? <p className="text-xs text-muted-foreground">{s.description}</p> : null}
            <div className="rounded-md border">
              <div className="border-b bg-muted/30 px-3 py-1.5"><span className="kicker text-foreground/85">{t('准入结论')}</span></div>
              <PineAdmissionReportView report={s.admission_report} />
            </div>
            <div className="rounded-md border">
              <div className="border-b bg-muted/30 px-3 py-1.5"><span className="kicker text-foreground/85">{t('参数')}</span></div>
              <PineInputsTable schema={s.inputs_schema} />
            </div>
            <div className="rounded-md border">
              <div className="border-b bg-muted/30 px-3 py-1.5"><span className="kicker text-foreground/85">{t('脚本正文')}</span></div>
              <pre className="max-h-[380px] overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre">{s.script}</pre>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConceptRow({ c }: { c: LoopConcept }) {
  const [open, setOpen] = useState(false);
  const pineId = pineScriptIdOf(c);
  return (
    <li className="space-y-0.5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium">{c.term}</span>
        {c.concept_id && c.concept_id !== c.term ? <span className="font-mono text-[10.5px] text-muted-foreground">{c.concept_id}</span> : null}
        <Badge className={cn('text-[10.5px]', STATUS_CLASS[c.status])}>{STATUS_LABEL[c.status] ?? c.status}</Badge>
        <span className="text-[10.5px] text-muted-foreground">{CATEGORY_LABEL[c.category] ?? c.category} · {SOURCE_LABEL[c.source] ?? c.source}</span>
      </div>
      {c.target ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">{targetLabel(c, pineId)}:</span>
          {pineId ? (
            <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 font-mono text-primary hover:underline" title={t('查看 Pine 脚本与准入结论')}>
              <FileCode className="size-3.5" />
              {pineId}
            </button>
          ) : (
            <span className="font-mono">{c.target}</span>
          )}
        </div>
      ) : null}
      {c.note ? (
        <p className={cn('text-[11px] leading-relaxed', c.status === 'unmapped' ? 'text-down' : c.status === 'proxy' ? 'text-warn' : 'text-muted-foreground')}>
          {c.status === 'unmapped' ? t('原因') + ':' : c.status === 'proxy' ? t('代理说明') + ':' : ''}
          {c.note}
        </p>
      ) : null}
      {pineId ? <PineScriptDialog id={pineId} open={open} onOpenChange={setOpen} /> : null}
    </li>
  );
}

export function ConceptCoverage({ concepts }: { concepts: LoopConcept[] | null | undefined }) {
  const list = Array.isArray(concepts) ? concepts : [];
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
        <span className="kicker text-foreground/85">{t('概念覆盖')}</span>
        {list.length ? <span className="text-[10.5px] text-muted-foreground">{t('{n} 个概念', { n: list.length })}</span> : null}
      </div>
      {!list.length ? (
        <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('本轮没有需要解析的指标/形态概念。')}</div>
      ) : (
        GROUPS.map((g) => {
          const rows = list.filter((c) => g.statuses.includes(c.status));
          return (
            <div key={g.key} className="border-b last:border-b-0">
              <div className="flex items-center gap-2 px-3 pt-2 text-[11px]">
                <span className="font-medium">{t(g.title)}</span>
                <span className="num text-muted-foreground">{rows.length}</span>
                {g.hint ? <span className="text-[10.5px] text-muted-foreground">{t(g.hint)}</span> : null}
              </div>
              {rows.length ? (
                <ul className="divide-y divide-border/50">
                  {rows.map((c) => <ConceptRow key={c.concept_id || c.term} c={c} />)}
                </ul>
              ) : (
                <div className="px-3 pt-0.5 pb-2 text-[11px] text-muted-foreground">{t('无')}</div>
              )}
            </div>
          );
        })
      )}
      {list.length ? <div className="border-t px-3 py-1 text-[10.5px] text-muted-foreground">{t('知识来源:本地词典与模型定义;未联网检索。')}</div> : null}
    </div>
  );
}
