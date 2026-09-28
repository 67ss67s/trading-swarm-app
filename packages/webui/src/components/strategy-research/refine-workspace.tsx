/**
 * 精修工作区:把研究台主体(pages/research.tsx 的 ResearchWorkbench,embedded)嵌进来,迭代 / 改进能力全保留。
 * 用在「策略研究」第 3 步(step-refine.tsx)。
 *   带入:seed = 海选里的一组(study + trial)→ 研究台「策略构建」预填这一组的 IR(与 #research?matrix_study=&trial= 同一条路)。
 *   顶部一条「带入的策略摘要」;研究会话里每次回测都会自动存进「我的策略」(后端 strategies/service attachReport),
 *   这里每 8 秒看一次「我的策略」:进来之后有策略被存 / 更新 → 调一次 onSaved(每进一次只调一次),之后出现「去验收」按钮。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, FlaskConical, Sparkles } from 'lucide-react';
import { researchApi } from '@/api/client';
import { matrixApi } from '@/api/matrix-study';
import { Button } from '@/components/ui/button';
import { familyLabel } from '@/components/matrix-study/shared';
import { displayName } from '@/components/agent-strategy/switch-list';
import { ResearchWorkbench } from '@/pages/research';
import { t } from '@/lib/i18n';
import { savedSince } from './model';

const signed = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

export interface RefineSeed { study: string; trial: string }
export interface SavedStrategy { id: string; label: string }

export interface RefineWorkspaceProps {
  seed: RefineSeed | null;
  /** 在前台:只有在前台时才轮询「我的策略」、才算「进来之后存的」 */
  active: boolean;
  /** 进来之后第一次看到有策略被存 / 更新 */
  onSaved: (s: SavedStrategy) => void;
  /** 「去验收 xx」按钮 */
  onValidate: (strategyId: string) => void;
  /** 右上角的返回链接(回到海选 / 换一组) */
  back: { label: string; go: () => void };
  /** 研究台里「回到海选」 */
  onBackToScout: (studyId?: string) => void;
  /** 没有带入组合时的提示 */
  emptyText: string;
  /** 摘要条右侧的一句说明 */
  hint: string;
}

export function RefineWorkspace({ seed, active, onSaved, onValidate, back, onBackToScout, emptyText, hint }: RefineWorkspaceProps) {
  const trialQ = useQuery({ queryKey: ['matrix-trial', seed?.study ?? null, seed?.trial ?? null], queryFn: () => matrixApi.trial(seed!.study, seed!.trial), enabled: !!seed, retry: 0, staleTime: Infinity });
  // 进来的时刻:之后被存 / 更新的策略才算「精修的产出」
  const since = useRef(Date.now());
  const reported = useRef(false);
  useEffect(() => { if (active) { since.current = Date.now(); reported.current = false; } }, [active]);
  const listQ = useQuery({ queryKey: ['research', 'my-strategies', 'refine-watch'], queryFn: () => researchApi.myStrategies({ filter: 'all', sort: 'updated' }), enabled: active, refetchInterval: active ? 8_000 : false, retry: false });
  const saved = listQ.data ? savedSince(listQ.data.strategies, since.current) : null;
  const [lastSaved, setLastSaved] = useState<SavedStrategy | null>(null);
  useEffect(() => {
    if (!active || !saved || reported.current) return;
    reported.current = true;
    const next = { id: saved.id, label: `${displayName(saved)} v${saved.current_version}` };
    setLastSaved(next);
    onSaved(next);
  }, [active, saved, onSaved]);

  const d = trialQ.data, m = d?.scorecard?.metrics;
  return (
    <div className="flex flex-col gap-2" data-testid="step-refine">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-3 py-2 text-[12px]">
        <FlaskConical className="size-4 text-primary" />
        {seed ? (
          d ? (
            <span data-testid="refine-seed">
              <span className="text-muted-foreground">{t('带入')}:</span>
              <span className="num font-medium">{d.cell.symbol.replace(/USDT$/, '')} {d.cell.timeframe}</span> · {d.cell.family_name ?? familyLabel(d.cell.family)} · {d.cell.side === 'long' ? t('做多') : t('做空')}
              {m ? <span className="text-muted-foreground"> · {t('选择段')} {signed(m.total_return)} · {t('{n} 笔', { n: m.trades })}</span> : null}
              {d.scorecard ? <span className="text-muted-foreground"> · {t('评分')} {d.scorecard.score.value}</span> : null}
            </span>
          ) : trialQ.isError ? <span className="text-destructive">{t('带入的那一组读不到:{e}', { e: (trialQ.error as Error).message })}</span> : <span className="text-muted-foreground">{t('正在读取带入的那一组…')}</span>
        ) : (
          <span className="text-muted-foreground">{emptyText}</span>
        )}
        <span className="text-[11px] text-muted-foreground">{hint}</span>
        <div className="ml-auto flex items-center gap-2">
          {lastSaved ? (
            <Button size="xs" variant="outline" className="gap-1" onClick={() => onValidate(lastSaved.id)}><Sparkles className="size-3" />{t('去验收 {name}', { name: lastSaved.label })}<ArrowRight className="size-3" /></Button>
          ) : null}
          <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={back.go}><ArrowLeft className="size-3" />{back.label}</button>
        </div>
      </div>
      <div className="h-[calc(100svh-17rem)] min-h-[560px] overflow-hidden rounded-xl border">
        <ResearchWorkbench key={seed ? `${seed.study}|${seed.trial}` : 'blank'} embedded matrixSeed={seed} onBackToScout={onBackToScout} />
      </div>
    </div>
  );
}
