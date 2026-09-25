/**
 * 节奏参数(docs/design/watch-screener-review-2026-09-24.md 二-2):分组、每项一句人话 + 推荐值(点一下套用)。
 * 只管 pace 这几项字段的草稿;保存走 PATCH /api/workflow,只发变了的字段。名单的增删排序不在这里(即点即存)。
 */
import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Workflow } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { estimateDaily } from './watch-logic';

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

export interface PaceDraft {
  timeframe: string;
  scan_mode: Workflow['scan_mode'];
  heartbeat_every_ms: number;
  fast_move_pct: string;
  review_every_close: boolean;
  invalidation_confirm_bars: number;
  invalidation_buffer_atr: number;
  info_every_ms: number;
}

const PACE_KEYS: (keyof PaceDraft)[] = ['timeframe', 'scan_mode', 'heartbeat_every_ms', 'fast_move_pct', 'review_every_close', 'invalidation_confirm_bars', 'invalidation_buffer_atr', 'info_every_ms'];

/** 老网关缺字段时的兜底(与 workflow-form V3_DEFAULTS 同值) */
export function paceOf(w: Workflow): PaceDraft {
  return {
    timeframe: w.timeframe,
    scan_mode: w.scan_mode ?? 'triggered',
    heartbeat_every_ms: w.heartbeat_every_ms ?? 30 * 60_000,
    fast_move_pct: w.fast_move_pct ?? '0.8',
    review_every_close: w.review_every_close ?? false,
    invalidation_confirm_bars: w.invalidation_confirm_bars ?? 2,
    invalidation_buffer_atr: w.invalidation_buffer_atr ?? 0.2,
    info_every_ms: w.info_every_ms,
  };
}

function diffPace(a: PaceDraft, b: PaceDraft): Partial<PaceDraft> {
  const out: Record<string, unknown> = {};
  for (const k of PACE_KEYS) if (a[k] !== b[k]) out[k] = b[k];
  return out as Partial<PaceDraft>;
}

const PRESETS: { id: string; label: string; hint: string; patch: Partial<PaceDraft> }[] = [
  { id: 'steady', label: '稳健(推荐)', hint: '15m · 触发器 · 心跳 30 分钟 · 信息员 30 分钟', patch: { timeframe: '15m', scan_mode: 'triggered', heartbeat_every_ms: 30 * 60_000, info_every_ms: 30 * 60_000, review_every_close: false } },
  { id: 'showcase', label: '演示节奏', hint: '1m · 每根收盘都问 · 信息员 3 分钟(很费钱)', patch: { timeframe: '1m', scan_mode: 'every_close', info_every_ms: 3 * 60_000, heartbeat_every_ms: 5 * 60_000, review_every_close: true } },
];

function Field({ label, help, rec, onRec, children }: { label: string; help: string; rec?: string; onRec?: () => void; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <div className="text-[12px] text-foreground/90">{label}</div>
        <div className="text-[10.5px] leading-4 text-muted-foreground">
          {help}
          {rec ? (
            <button type="button" onClick={onRec} className="ml-1 rounded-sm border border-primary/30 px-1 text-[10px] text-primary hover:bg-primary/10" title={t('点一下套用推荐值')}>
              {t('推荐 {v}', { v: rec })}
            </button>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b last:border-b-0">
      <div className="bg-muted/30 px-3 py-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground">{title}</div>
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  );
}

function MinutesInput({ ms, min, onChange }: { ms: number; min: number; onChange: (ms: number) => void }) {
  const [text, setText] = useState(String(Math.round(ms / 60_000)));
  useEffect(() => setText((cur) => (Number(cur) * 60_000 === ms ? cur : String(Math.round(ms / 60_000)))), [ms]);
  return (
    <>
      <Input
        type="number"
        min={min}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(Math.round(Math.max(1, n) * 60_000));
        }}
        className="num h-7 w-16 text-[12px]"
      />
      <span className="text-[11px] text-muted-foreground">{t('分钟')}</span>
    </>
  );
}

export function PaceSection({ workflow, className }: { workflow: Workflow; className?: string }) {
  const qc = useQueryClient();
  const server = useMemo(() => paceOf(workflow), [workflow]);
  const serverKey = JSON.stringify(server);
  const [draft, setDraft] = useState<PaceDraft>(server);
  const [base, setBase] = useState<PaceDraft>(server);
  const patch = diffPace(base, draft);
  const dirty = Object.keys(patch).length > 0;

  // 服务端 pace 变了:本地干净就跟着换;脏就不覆盖(保存时只发改过的字段)
  useEffect(() => {
    if (!dirty) setDraft(server);
    setBase(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const set = (p: Partial<PaceDraft>) => setDraft((d) => ({ ...d, ...p }));

  const save = useMutation({
    mutationFn: (p: Partial<Workflow>) => api.patchWorkflow(p),
    onSuccess: (res) => {
      qc.setQueryData(['workflow'], res.workflow);
      void qc.invalidateQueries({ queryKey: ['overview'] });
      if (res.errors?.length) {
        toast.warning(t('{n} 个字段没保存', { n: res.errors.length }), { description: res.errors.join('; ') });
        return;
      }
      setDraft(paceOf(res.workflow));
      toast.success(t('节奏已保存,下一轮生效'));
    },
    onError: (err) => toast.error(t('保存失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const est = estimateDaily({ watchlist: workflow.watchlist, timeframe: draft.timeframe, scan_mode: draft.scan_mode, heartbeat_every_ms: draft.heartbeat_every_ms }, workflow.daily_judgment_cap ?? 0);
  const triggered = draft.scan_mode === 'triggered';

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">{t('一键套用')}</span>
        {PRESETS.map((p) => (
          <Button key={p.id} size="xs" variant="outline" className="rounded-full" title={t(p.hint)} onClick={() => set(p.patch)}>
            {t(p.label)}
          </Button>
        ))}
        <span className="num ml-auto text-[10.5px] text-muted-foreground" title={t('按当前名单与下面的参数估算;GLM 单价 ≈¥0.006/次')}>
          {t('按这套参数:每天约 {lo}–{hi} 次判断 · ≈¥{cost}', { lo: est.low, hi: est.high, cost: est.costHigh.toFixed(2) })}
          {est.capped ? ` ${t('(被每日上限 {n} 封顶)', { n: workflow.daily_judgment_cap ?? 0 })}` : ''}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Group title={t('多久看一次')}>
          <Field label={t('周期')} help={t('每根 K 线收盘时,代码在本地算一遍特征。周期越短越灵敏,问模型的机会也越多。')} rec="15m" onRec={() => set({ timeframe: '15m' })}>
            <Select value={draft.timeframe} onValueChange={(v) => set({ timeframe: v })}>
              <SelectTrigger size="sm" className="h-7 w-20 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEFRAMES.map((tf) => (
                  <SelectItem key={tf} value={tf}>
                    {tf}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('每根收盘都复查')} help={t('开着:每根收盘都再看一遍;关着:只在成交、止损止盈、触发器、心跳的时候看,省钱。')} rec={t('关')} onRec={() => set({ review_every_close: false })}>
            <Switch checked={draft.review_every_close} onCheckedChange={(v) => set({ review_every_close: v })} />
          </Field>
        </Group>

        <Group title={t('怎么扫')}>
          <Field
            label={t('扫描方式')}
            help={triggered ? t('只有突破、均线交叉、放量、急拉急跌、资金费极端、回踩等信号出现(或到心跳)才叫模型。') : t('每根收盘对名单里每个币都问一次模型,费用随周期线性涨,演示用。')}
            rec={t('触发器')}
            onRec={() => set({ scan_mode: 'triggered' })}
          >
            <Select value={draft.scan_mode} onValueChange={(v) => set({ scan_mode: v as Workflow['scan_mode'] })}>
              <SelectTrigger size="sm" className="h-7 w-32 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="triggered">{t('触发器命中才问')}</SelectItem>
                <SelectItem value="every_close">{t('每根收盘都问')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {triggered ? (
            <Field label={t('急拉急跌阈值')} help={t('5 分钟内涨跌超过这个百分比,立刻叫醒判断,不等收盘。')} rec="0.8%" onRec={() => set({ fast_move_pct: '0.8' })}>
              <Input value={draft.fast_move_pct} onChange={(e) => set({ fast_move_pct: e.target.value })} className="num h-7 w-16 text-[12px]" inputMode="decimal" />
              <span className="text-[11px] text-muted-foreground">%</span>
            </Field>
          ) : null}
        </Group>

        <Group title={t('心跳与信息员')}>
          {triggered ? (
            <Field label={t('心跳')} help={t('就算什么信号都没有,每个币最久隔这么久也会被问一次。越短越费钱。')} rec={t('30 分钟')} onRec={() => set({ heartbeat_every_ms: 30 * 60_000 })}>
              <MinutesInput ms={draft.heartbeat_every_ms} min={5} onChange={(ms) => set({ heartbeat_every_ms: ms })} />
            </Field>
          ) : null}
          <Field label={t('信息员频率')} help={t('信息员(副脑)多久总结一次大盘和新闻,给判断当背景。')} rec={t('30 分钟')} onRec={() => set({ info_every_ms: 30 * 60_000 })}>
            <MinutesInput ms={draft.info_every_ms} min={2} onChange={(ms) => set({ info_every_ms: ms })} />
          </Field>
        </Group>

        <Group title={t('失效确认(模型改不了)')}>
          <Field label={t('确认根数')} help={t('连续几根收盘越过失效价才算「失效」。只是证据,止损才是硬线。')} rec="2" onRec={() => set({ invalidation_confirm_bars: 2 })}>
            <Input
              type="number"
              min={1}
              max={5}
              value={draft.invalidation_confirm_bars}
              onChange={(e) => set({ invalidation_confirm_bars: Math.min(5, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
              className="num h-7 w-14 text-[12px]"
            />
          </Field>
          <Field label={t('确认深度')} help={t('越过失效价不到这么多个 ATR 不算数,防插针。0–1。')} rec="0.2" onRec={() => set({ invalidation_buffer_atr: 0.2 })}>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={draft.invalidation_buffer_atr}
              onChange={(e) => set({ invalidation_buffer_atr: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })}
              className="num h-7 w-14 text-[12px]"
            />
            <span className="text-[11px] text-muted-foreground">ATR</span>
          </Field>
        </Group>
        <div className="px-3 py-2 text-[10.5px] text-muted-foreground">
          {t('每日判断上限 {n}(0 = 不限)、风险、额度、自动化、大脑在「设置 › 工作流」。', { n: workflow.daily_judgment_cap ?? 0 })}
          <a href="#settings" className="ml-1 text-primary hover:underline">
            {t('去设置 →')}
          </a>
        </div>
      </div>

      <div className={cn('flex shrink-0 items-center gap-2 border-t px-3 py-2', dirty && 'bg-primary/5')}>
        <span className={cn('min-w-0 flex-1 truncate text-[11px]', dirty ? 'text-warn' : 'text-muted-foreground')}>{dirty ? t('节奏有 {n} 项没保存', { n: Object.keys(patch).length }) : t('改完点保存,下一轮生效')}</span>
        {dirty ? (
          <Button size="sm" variant="ghost" onClick={() => setDraft(base)}>
            {t('撤销')}
          </Button>
        ) : null}
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(patch as Partial<Workflow>)}>
          {save.isPending ? t('保存中…') : t('保存节奏')}
        </Button>
      </div>
    </div>
  );
}
