import type React from 'react';
/**
 * 工作流面板「大脑」一节的一行:kind 下拉(来自 GET /api/brains)+ 模型输入(推荐列表可选 /
 * 自由输入,用原生 datalist,不引入新依赖)+「测试」按钮(POST /api/brains/test)。
 * 判断/对话大脑与信息员大脑各用一行,由 agent.tsx 的 WorkflowPanel 传入 draft 的读写回调,
 * 保存仍走工作流面板现有的 diff 保存机制(brain/brain_model/cheap_brain/cheap_brain_model)。
 */
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/api/client';
import type { BrainKind, BrainOption } from '@/api/types';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

interface BrainPickerRowProps {
  id?: string;
  label: string;
  hint?: React.ReactNode;
  kind: BrainKind;
  model: string | null;
  brains: BrainOption[];
  onKindChange: (k: BrainKind) => void;
  onModelChange: (m: string | null) => void;
  kindError?: string;
  modelError?: string;
}

export function BrainPickerRow({ id, label, hint, kind, model, brains, onKindChange, onModelChange, kindError, modelError }: BrainPickerRowProps) {
  const current = brains.find((b) => b.kind === kind) ?? null;

  const test = useMutation({
    mutationFn: () => api.testBrain(kind, model && model.trim() !== '' ? model.trim() : null),
  });

  return (
    <div id={id} className={cn('px-3 py-2', (kindError || modelError) && 'bg-destructive/5')}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <Label className="text-[12px] font-normal text-muted-foreground">
          {label}
          {hint ? <span className="ml-1 text-[10px] text-muted-foreground/70">{hint}</span> : null}
        </Label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={kind} onValueChange={(v) => onKindChange(v as BrainKind)}>
          <SelectTrigger size="sm" className="h-7 w-28 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {brains.map((b) => (
              <SelectItem key={b.kind} value={b.kind} disabled={!b.available}>
                {b.label}
                {!b.available ? <span className="text-muted-foreground">{t('(没找到 CLI)')}</span> : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          list={id ? `${id}-models` : undefined}
          value={model ?? ''}
          onChange={(e) => onModelChange(e.target.value)}
          placeholder={current?.default_model ?? t('这个 CLI 的默认模型')}
          className="h-7 min-w-0 flex-1 text-[12px]"
        />
        {id ? (
          <datalist id={`${id}-models`}>
            {(current?.models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        ) : null}

        <Button size="xs" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
          {t('测试')}
        </Button>
      </div>

      {kindError ? <div className="mt-1 text-[11px] text-destructive">{kindError}</div> : null}
      {modelError ? <div className="mt-1 text-[11px] text-destructive">{modelError}</div> : null}

      {current && !current.available ? <div className="mt-1 text-[10.5px] text-warn">{current.note || t('没找到这个 CLI,用不了')}</div> : null}
      {current?.note && current.available ? <div className="mt-1 text-[10.5px] text-muted-foreground">{current.note}</div> : null}

      {test.data ? (
        <div className={cn('mt-1.5 flex items-center gap-1.5 text-[11px]', test.data.ok ? 'text-up' : 'text-destructive')}>
          <Badge variant={test.data.ok ? 'outline' : 'destructive'} className={cn('text-[10px]', test.data.ok && 'border-up/30 text-up')}>
            {test.data.ok ? t('成功') : t('失败')}
          </Badge>
          {test.data.ok ? <span className="num">{test.data.latency_ms}ms</span> : null}
          <span className="truncate text-muted-foreground">{test.data.ok ? test.data.text : test.data.error}</span>
        </div>
      ) : null}
      {test.isError ? (
        <div className="mt-1.5 text-[11px] text-destructive">{t('测试失败')}:{test.error instanceof Error ? test.error.message : String(test.error)}</div>
      ) : null}
    </div>
  );
}
