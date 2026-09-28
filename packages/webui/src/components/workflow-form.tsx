/**
 * 工作流表单(从 pages/agent.tsx 抽出来,2026-09-06 Agent 页重排 B+)。2026-09-25 现状:
 *   - 观察列表页(pages/watch.tsx)自己画名单板和节奏(watch-panel.tsx),不再用这个表单的 pace 组
 *   - 设置页「风控与自动化」:groups=['risk','limits','automation'] + hideWatchlist + hideMarket
 *     (名单 / 节奏只在观察列表页改;交易市场 / 杠杆 / 保证金模式跟账户模式一起在 #connect 接入页改)
 * 保存机制:草稿 diff → POST /api/workflow 部分应用 → 出错字段保留用户输入;服务端被别处改了会提示不覆盖。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Market, TierPolicy, Workflow } from '@/api/types';
import { TIER_LABEL, TIERS } from '@/api/types';
import { BrainPickerRow } from '@/components/brain-picker';
import { SlotRoles } from '@/components/brain-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

import { friendlyError } from '@/lib/edition';
import { relativeTime } from '@/lib/format';
import { trimNum, verdictText } from '@/lib/capacity';
import { cn } from '@/lib/utils';
import { t, tmap, listSep } from '@/lib/i18n';



const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

/** 老网关没有 v3 / v3.3 字段时的兜底,前端显示与 diff 都按这个补齐。 */
const V3_DEFAULTS = {
  narrate: true,
  scan_mode: 'triggered' as Workflow['scan_mode'],
  heartbeat_every_ms: 30 * 60_000,
  fast_move_pct: '0.8',
  review_every_close: false,
  // v3.3:0 = 不限
  daily_judgment_cap: 0,
  // v3.10:失效确认(老网关没有时按网关默认值补)
  invalidation_confirm_bars: 2,
  invalidation_buffer_atr: 0.2,
  watch_only: [] as string[],
  watchlist_max: 60,
  // §9.40 市场维度(老网关没有 → 只有永续)
  markets: ['perp'] as Market[],
  default_market: 'perp' as Market,
  // v3.12 §9.30 事件封锁:0 = 关闭(老网关没有这个字段时也按 0 显示)
  event_blackout_min: 0,
};

function normalize(w: Workflow): Workflow {
  return { ...V3_DEFAULTS, ...w, sizing_agent: w.sizing_agent ?? 'advise' };
}

/** 可保存的字段(排除 updated_at)。 */
const PATCHABLE: (keyof Workflow)[] = [
  'watchlist',
  'timeframe',
  'info_every_ms',
  'risk_pct',
  'sizing_agent',
  'leverage',
  'margin_mode',
  'max_open_threads',
  'max_opens_per_day',
  'daily_loss_stop_pct',
  'auto_approve',
  'chat_requires_approval',
  'brain',
  'brain_model',
  'cheap_brain',
  'cheap_brain_model',
  'playbook_text',
  'paused',
  'narrate',
  'scan_mode',
  'heartbeat_every_ms',
  'fast_move_pct',
  'review_every_close',
  'daily_judgment_cap',
  'invalidation_confirm_bars',
  'invalidation_buffer_atr',
  'watch_only',
  'watchlist_max',
  // §9.40
  'markets',
  'default_market',
  // §9.31:止损验证凭证的有效期(1–30 天);只有人能改,对话里的 set_workflow 会被网关拒。
  'protection_ttl_days',
  'event_blackout_min',
  // §9.35 票池谁来改(手动 / 代码每天决策一次);策略页顶部的切换写的是同一个字段。
  'active_mode',
  // §9.25 议会三个开关(只有人能改,对话里的 set_workflow 会被网关拒)。
  'strategy_council',
  'council_min_agree',
  'council_model',
  // §9.26 限价入场。
  'entry_style',
  // §9.37 分层配额(短/中/长各一套;全 0 = 继承全局,不额外限制)。
  'tier_policy',
  // 09-07 Strategy Lab 自动闭环 / §9.27 假设生成(会往策略库加东西)。
  'lab_autopilot',
  'strategy_discovery',
];

function diffWorkflow(server: Workflow, draft: Workflow): Partial<Workflow> {
  const out: Record<string, unknown> = {};
  for (const k of PATCHABLE) {
    if (JSON.stringify(server[k]) !== JSON.stringify(draft[k])) out[k] = draft[k];
  }
  return out as Partial<Workflow>;
}

const FIELD_LABEL: Record<string, string> = tmap({
  watchlist: '观察列表',
  timeframe: '周期',
  info_every_ms: '信息员频率',
  risk_pct: '单笔风险',
  sizing_agent: '自动仓位',
  leverage: '杠杆',
  margin_mode: '保证金模式',
  max_open_threads: '最多同时线程数',
  max_opens_per_day: '每日最多开仓',
  daily_loss_stop_pct: '日亏停',
  auto_approve: '自动执行',
  chat_requires_approval: '对话执行需我确认',
  brain: '主脑',
  brain_model: '主脑模型',
  cheap_brain: '副脑',
  cheap_brain_model: '副脑模型',
  playbook_text: 'Playbook',
  paused: '暂停',
  narrate: '旁白',
  scan_mode: '扫描方式',
  heartbeat_every_ms: '心跳',
  fast_move_pct: '急拉急跌阈值',
  review_every_close: '每根收盘复查',
  watch_only: '只观察不交易',
  watchlist_max: '名单上限',
  invalidation_confirm_bars: '失效确认根数',
  invalidation_buffer_atr: '失效确认深度',
  daily_judgment_cap: '每日判断上限',
  protection_ttl_days: '止损验证有效期',
  event_blackout_min: '事件封锁',
  active_mode: '票池谁来改',
  strategy_council: '策略议会',
  council_min_agree: '共识票数',
  council_model: '议会模型',
  entry_style: '入场方式',
  tier_policy: '分层配额',
  lab_autopilot: '实验室自动闭环',
  strategy_discovery: '策略假设生成',
});

/** 把服务端 errors(每条以字段名开头)拆成 {field: message};认不出字段的进 general。 */
function splitErrors(errors: string[]): { byField: Record<string, string>; general: string[] } {
  const byField: Record<string, string> = {};
  const general: string[] = [];
  // 按字段名长度降序匹配,避免 "brain_model" 之类的错误被前缀更短的 "brain" 先命中
  const fieldsByLength = Object.keys(FIELD_LABEL).sort((a, b) => b.length - a.length);
  for (const e of errors) {
    const field = fieldsByLength.find((f) => e.startsWith(f));
    if (field) byField[field] = e.slice(field.length).replace(/^[\s:：]+/, '') || e;
    else general.push(e);
  }
  return { byField, general };
}

function tfMinutes(tf: string): number {
  const n = Number(tf.slice(0, -1));
  const u = tf.slice(-1);
  return u === 'h' ? n * 60 : u === 'd' ? n * 1440 : n;
}

/** 预计每小时调用模型次数(docs/demo/v3-ui-contract.md §1 的近似公式)。 */
function callsPerHour(w: Workflow): { low: number; high: number } {
  const n = Math.max(1, w.watchlist.length);
  if (w.scan_mode === 'every_close') {
    const c = n * (60 / Math.max(1, tfMinutes(w.timeframe)));
    return { low: c, high: c };
  }
  const hb = n * (60 / Math.max(5, w.heartbeat_every_ms / 60_000));
  return { low: hb, high: hb + n * 4 };
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <div className="px-3 pb-1.5 text-[11px] text-destructive animate-in fade-in duration-200">{msg}</div>;
}

/** 工作流草稿的一行字段——Input/Select/Switch 共用的行布局。 */
function FieldRow({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className={cn(error && 'bg-destructive/5')}>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <Label className="min-w-0 shrink-0 text-[12px] font-normal text-muted-foreground">
          {label}
          {hint ? <span className="ml-1 text-[10px] text-muted-foreground/70">{hint}</span> : null}
        </Label>
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">{children}</div>
      </div>
      <FieldError msg={error} />
    </div>
  );
}

/**
 * 数字输入:内部用字符串,清空/输入一半不会把 draft 打成 NaN 或 0;只在能解析时回写。
 * 外部值变了(比如点了预设 / 服务端刷新)会同步进来。
 */
function NumInput({ value, onChange, className, min, step }: { value: number | string; onChange: (n: number) => void; className?: string; min?: number; step?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((cur) => (Number(cur) === Number(value) ? cur : String(value)));
  }, [value]);
  return (
    <Input
      type="number"
      min={min}
      step={step}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => {
        if (text.trim() === '' || !Number.isFinite(Number(text))) setText(String(value));
      }}
      className={cn('h-7 w-20 text-[12px]', className)}
      inputMode="decimal"
    />
  );
}

/**
 * 名单表(§9.16):watchlist 是唯一真源;每行 币 / 观察|交易 开关(watch_only 子集)/ 最近判断 / 来源(手动|Radar 提案);
 * 顶部 用量/上限(1–24,每多一个币 = 多一份心跳/收盘判断的模型费)。Radar「应用提案」也写进同一个 watchlist。
 */
function WatchlistEditor({ draft, setDraft, error }: { draft: Workflow; setDraft: (fn: (w: Workflow) => Workflow) => void; error?: string }) {
  const [text, setText] = useState('');
  const symbolsQ = useQuery({ queryKey: ['symbols'], queryFn: api.symbols });
  const episodesQ = useQuery({ queryKey: ['episodes'], queryFn: () => api.episodes({ limit: 100 }), staleTime: 30_000 });
  const screenQ = useQuery({ queryKey: ['screener', 'latest', 'short'], queryFn: () => api.screenerLatest('short'), retry: false, staleTime: 60_000 });
  // §9.18:每币「可做 / 要 N U」,Portfolio Manager 纯代码估算;老网关 404 就不显示这列
  const capacityQ = useQuery({ queryKey: ['portfolio', 'capacity'], queryFn: api.portfolioCapacity, retry: false, staleTime: 60_000 });
  const capBySym = new Map((capacityQ.data?.capacity?.by_symbol ?? []).map((r) => [r.symbol, r]));
  const known = new Set((symbolsQ.data?.symbols ?? []).map((s) => s.symbol));
  const max = Math.max(1, Math.min(300, draft.watchlist_max ?? 60));
  const watchOnly = new Set(draft.watch_only ?? []);
  const radarSet = new Set(screenQ.data?.screen?.proposal?.symbols ?? []);
  const lastByAgent = new Map<string, { at: number; action: string | null }>();
  for (const e of episodesQ.data ?? []) if (!lastByAgent.has(e.symbol)) lastByAgent.set(e.symbol, { at: e.at, action: e.action });
  // 和筛选页同源:每个币在最近一次短线筛选里的最佳策略 / 契合度 / 排名(没进候选 = 没算出来或没过门槛)
  const radarBest = new Map<string, { strategy: string; fit: number; rank: number }>();
  for (const c of screenQ.data?.candidates ?? []) {
    if (radarBest.has(c.symbol)) continue;
    const st = c.card.strategies.find((f) => f.strategy_id === c.strategy_id);
    radarBest.set(c.symbol, { strategy: st?.name ?? c.strategy_id, fit: c.fit_score, rank: c.rank });
  }
  // 输入预览:敲几个字母就列出全部匹配的可交易资产(列表内滚动,不设上限——上限只在名单本身 1–24,那才是花模型费的地方),已在名单 / Radar 候选 都标出来;Enter 选高亮的
  const q = text.trim().toUpperCase();
  const suggestions = useMemo(() => {
    if (!q || !symbolsQ.data) return [] as string[];
    const all = symbolsQ.data.symbols.filter((x) => x.status === 'TRADING' || !x.status).map((x) => x.symbol);
    const starts = all.filter((x) => x.startsWith(q));
    const contains = all.filter((x) => !x.startsWith(q) && x.includes(q));
    return [...starts, ...contains];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, symbolsQ.data]);
  const [hi, setHi] = useState(0);
  useEffect(() => setHi(0), [q]);

  const add = (pick?: string) => {
    const sym = (pick ?? (suggestions.length && !known.has(text.trim().toUpperCase()) ? suggestions[hi] ?? suggestions[0] : text.trim().toUpperCase())) ?? '';
    if (!sym) return;
    if (symbolsQ.data && !known.has(sym)) {
      toast.error(t('不认识这个币'), { description: t('{symbol} 不在可交易列表里', { symbol: sym }) });
      return;
    }
    if (draft.watchlist.includes(sym)) {
      toast.error(t('已经在名单里了'));
      return;
    }
    if (draft.watchlist.length >= max) {
      toast.error(t('名单最多 {n} 个', { n: max }), { description: t('先把上限调高,或者移掉一个;手动下单不受这个限制。') });
      return;
    }
    setDraft((w) => ({ ...w, watchlist: [...w.watchlist, sym] }));
    setText('');
  };
  const remove = (sym: string) => setDraft((w) => ({ ...w, watchlist: w.watchlist.filter((s) => s !== sym), watch_only: (w.watch_only ?? []).filter((s) => s !== sym) }));
  const toggleTrade = (sym: string, trade: boolean) =>
    setDraft((w) => ({ ...w, watch_only: trade ? (w.watch_only ?? []).filter((s) => s !== sym) : [...new Set([...(w.watch_only ?? []), sym])] }));

  return (
    <div className={cn(error && 'bg-destructive/5')}>
      <div className="px-3 py-2">
        <div className="mb-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
          {t('名单')}
          <span className="text-[10.5px]">{t('= agent 能看、能交易的全部币,只有这一份')}</span>
          <span className="num ml-auto text-[10px]">
            {draft.watchlist.length}/{max}
          </span>
          <NumInput min={1} value={max} onChange={(n) => setDraft((w) => ({ ...w, watchlist_max: Math.max(1, Math.min(300, Math.round(n))) }))} className="w-14" />
        </div>
        <div className="mb-1.5 text-[10.5px] text-muted-foreground">{t('上限 1–300。每多一个币,就多一份心跳 / 收盘判断的模型费。')}</div>
        {draft.watchlist.length === 0 ? <div className="py-2 text-[11px] text-muted-foreground">{t('空的,没有要盯的币')}</div> : null}
        {draft.watchlist.length ? (
          <table className="w-full text-[11.5px]">
            <thead className="text-[10px] text-muted-foreground">
              <tr>
                <th className="py-0.5 text-left font-normal">{t('币')}</th>
                <th className="py-0.5 text-left font-normal">{t('可交易')}</th>
                <th className="py-0.5 text-left font-normal">{t('最近判断')}</th>
                <th className="py-0.5 text-left font-normal" title={t('最近一次短线筛选给的最佳策略 / 契合度,和筛选页同一份')}>{t('Radar 策略 / 契合')}</th>
                {capacityQ.data?.capacity ? <th className="py-0.5 text-left font-normal" title={t('Portfolio Manager 按典型止损估的:当前权益下,这个币还能不能按风险比例做')}>{t('容量')}</th> : null}
                <th className="py-0.5 text-left font-normal">{t('来源')}</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y">
              {draft.watchlist.map((sym) => {
                const last = lastByAgent.get(sym);
                const trade = !watchOnly.has(sym);
                return (
                  <tr key={sym} className="animate-in fade-in duration-150">
                    <td className="num py-1 font-semibold">{sym}</td>
                    <td className="py-1">
                      <label className="flex items-center gap-1" title={trade ? t('可交易:判断能出 PROPOSE') : t('只观察:判断只能出 NO_TRADE / WATCH')}>
                        <Switch checked={trade} onCheckedChange={(v) => toggleTrade(sym, v)} className="scale-75" />
                        <span className={cn('text-[10.5px]', trade ? 'text-foreground' : 'text-muted-foreground')}>{trade ? t('可交易') : t('只观察')}</span>
                      </label>
                    </td>
                    <td className="num py-1 text-[10.5px] text-muted-foreground">{last ? `${last.action ?? '—'} · ${relativeTime(last.at)}` : '—'}</td>
                    {(() => {
                      const b = radarBest.get(sym);
                      return (
                        <td className="py-1 text-[10.5px] text-muted-foreground">
                          {b ? (
                            <a href="#screener" className="hover:underline" title={t('筛选排名 #{rank}', { rank: b.rank })}>
                              {b.strategy} <span className="num text-foreground">{b.fit.toFixed(2)}</span>
                            </a>
                          ) : (
                            <span title={t('最近一次筛选没把它列进候选(没算,或者没过门槛)')}>{t('没进候选')}</span>
                          )}
                        </td>
                      );
                    })()}
                    {capacityQ.data?.capacity
                      ? (() => {
                          const r = capBySym.get(sym);
                          return (
                            <td className={cn('num py-1 text-[10.5px]', !r ? 'text-muted-foreground' : r.verdict === 'ok' ? 'text-up' : r.verdict === 'needs_equity' ? 'text-warn' : 'text-muted-foreground')} title={r?.equity_shortfall && r.equity_shortfall !== '0' ? t('还差 {n} U 权益', { n: trimNum(r.equity_shortfall) }) : undefined}>
                              {r ? verdictText(r) : t('没估')}
                            </td>
                          );
                        })()
                      : null}
                    <td className="py-1 text-[10.5px] text-muted-foreground">{radarSet.has(sym) ? t('Radar 提案') : t('手动')}</td>
                    <td className="py-1 text-right">
                      <button type="button" onClick={() => remove(sym)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t('移除 {symbol}', { symbol: sym })}>
                        <X className="size-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        <div className="relative mt-2 flex items-center gap-1.5">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              } else if (e.key === 'ArrowDown' && suggestions.length) {
                e.preventDefault();
                setHi((i) => (i + 1) % suggestions.length);
              } else if (e.key === 'ArrowUp' && suggestions.length) {
                e.preventDefault();
                setHi((i) => (i - 1 + suggestions.length) % suggestions.length);
              } else if (e.key === 'Escape') {
                setText('');
              }
            }}
            placeholder={t('敲币名预览,比如 BTC')}
            className="h-7 text-[12px]"
            autoComplete="off"
            spellCheck={false}
          />
          {q && suggestions.length ? (
            <ul className="absolute left-0 top-full z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded-md border bg-popover text-[11.5px] shadow-lg" role="listbox">
              {suggestions.map((sym, i) => {
                const inList = draft.watchlist.includes(sym);
                const b = radarBest.get(sym);
                return (
                  <li
                    key={sym}
                    role="option"
                    aria-selected={i === hi}
                    className={cn('flex cursor-pointer items-center gap-2 px-2 py-1', i === hi && 'bg-muted', inList && 'opacity-60')}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (!inList) add(sym);
                    }}
                    onMouseEnter={() => setHi(i)}
                  >
                    <span className="num font-semibold">{sym}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {inList ? t('已在名单') : b ? `Radar #${b.rank} · ${b.strategy} ${b.fit.toFixed(2)}` : radarSet.has(sym) ? t('Radar 提案') : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : q && symbolsQ.data && !known.has(q) ? (
            <div className="absolute left-0 top-full z-20 mt-1 rounded-md border bg-popover px-2 py-1 text-[11px] text-muted-foreground shadow-lg">{t('没有匹配的可交易品种')}</div>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => add()} className="shrink-0">
            <Plus className="size-3.5" />
            {t('添加')}
          </Button>
          <a href="#screener" className="shrink-0 text-[10.5px] text-muted-foreground hover:underline">
            {t('让 Radar 提案 →')}
          </a>
        </div>
      </div>
      <FieldError msg={error} />
    </div>
  );
}

type Preset = { id: string; label: string; hint: string; patch: Partial<Workflow> };
const PRESETS: Preset[] = [
  {
    id: 'showcase',
    label: '演示节奏',
    hint: '1m · 每根收盘都问 · 信息员 3 分钟 · 旁白开',
    // label / hint 都是 i18n key,渲染时过 t()
    patch: { timeframe: '1m', scan_mode: 'every_close', info_every_ms: 3 * 60_000, heartbeat_every_ms: 5 * 60_000, review_every_close: true, narrate: true },
  },
  {
    id: 'steady',
    label: '稳健',
    hint: '15m · 触发器 · 心跳 30 分钟 · 信息员 30 分钟',
    patch: { timeframe: '15m', scan_mode: 'triggered', info_every_ms: 30 * 60_000, heartbeat_every_ms: 30 * 60_000, review_every_close: false },
  },
];

function Section({ id, sectioned, open, onToggle, children }: { id: WorkflowGroup; sectioned: boolean; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  if (!sectioned) return <>{children}</>;
  return (
    <div>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 bg-muted/40 px-3 py-1.5 text-left text-[11px] font-semibold tracking-wide text-muted-foreground hover:text-foreground">
        {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        {GROUP_LABEL[id]}
      </button>
      {open ? <div className="divide-y">{children}</div> : null}
    </div>
  );
}

export type WorkflowGroup = 'pace' | 'risk' | 'limits' | 'automation' | 'brain';

const GROUP_LABEL: Record<WorkflowGroup, string> = tmap({ pace: '节奏 · 盯盘参数', risk: '风险', limits: '额度', automation: '自动化', brain: '大脑' });

/**
 * 工作流表单。`groups` 决定渲染哪几组字段(Agent 页「盯盘参数」抽屉只要 pace;设置页全量),
 * `sectioned` 时每组是可折叠小节(设置页)。保存机制不变:diff → 部分应用 → 出错字段保留用户输入。
 */
export function WorkflowForm({ groups, sectioned = false, defaultOpen = ['pace'], hideWatchlist = false, hideMarket = false }: { groups: WorkflowGroup[]; sectioned?: boolean; defaultOpen?: WorkflowGroup[]; /** 09-07:盯盘参数页自己画名单板,这里只留周期/扫描/心跳等 */ hideWatchlist?: boolean; /** 09-25:交易市场 / 杠杆 / 保证金模式在 #connect 接入页(和账户模式联动),这里不画 */ hideMarket?: boolean }) {
  const [openGroups, setOpenGroups] = useState<Set<WorkflowGroup>>(() => new Set(defaultOpen));
  const toggleGroup = (g: WorkflowGroup) => setOpenGroups((s) => {
    const n = new Set(s);
    if (n.has(g)) n.delete(g);
    else n.add(g);
    return n;
  });
  const show = (g: WorkflowGroup) => groups.includes(g);
  const queryClient = useQueryClient();
  const workflowQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const brainsQ = useQuery({ queryKey: ['brains'], queryFn: () => api.brains(), staleTime: 5 * 60_000 });
  const server = useMemo(() => (workflowQ.data ? normalize(workflowQ.data) : null), [workflowQ.data]);
  const [draft, setDraftState] = useState<Workflow | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalErrors, setGeneralErrors] = useState<string[]>([]);
  const [serverUpdated, setServerUpdated] = useState(false);

  const patch = useMemo(() => (server && draft ? diffWorkflow(server, draft) : {}), [server, draft]);
  const dirty = Object.keys(patch).length > 0;

  // 服务端值变了:草稿相对「上一版服务端值」干净就直接换;脏就提示,不覆盖用户没保存的编辑
  const draftRef = useRef<Workflow | null>(null);
  draftRef.current = draft;
  const lastServerRef = useRef<Workflow | null>(null);
  const ownSaveRef = useRef(false); // 自己保存引起的 server 变化不算「别处改了」
  useEffect(() => {
    if (!server) return;
    const prev = lastServerRef.current;
    lastServerRef.current = server;
    if (ownSaveRef.current) {
      ownSaveRef.current = false;
      return;
    }
    const cur = draftRef.current;
    if (!cur || !prev) {
      setDraftState(server);
      return;
    }
    const dirtyVsPrev = Object.keys(diffWorkflow(prev, cur)).length > 0;
    if (!dirtyVsPrev || Object.keys(diffWorkflow(server, cur)).length === 0) {
      setDraftState(server);
      return;
    }
    setServerUpdated(true);
  }, [server]);

  const setDraft = (fn: (w: Workflow) => Workflow) => setDraftState((cur) => (cur ? fn(cur) : cur));
  const applyPreset = (p: Preset) => {
    setDraft((w) => ({ ...w, ...p.patch }));
    toast.info(t('已套用「{name}」,记得保存', { name: t(p.label) }), { description: t(p.hint) });
  };
  const reloadFromServer = () => {
    if (server) setDraftState(server);
    setServerUpdated(false);
    setFieldErrors({});
    setGeneralErrors([]);
  };

  const save = useMutation({
    mutationFn: (p: Partial<Workflow>) => api.patchWorkflow(p),
    onSuccess: (res, sent) => {
      const next = normalize(res.workflow);
      ownSaveRef.current = true;
      queryClient.setQueryData(['workflow'], res.workflow);
      // §9.35:active_mode 在策略页顶部也有一个切换,两处写的是同一个字段 —— 保存完把
      // 票池相关的两个 key 一起失效,那边立刻能看到这边的改动(反过来那边也会失效 ['workflow'])。
      void queryClient.invalidateQueries({ queryKey: ['allocator'] });
      void queryClient.invalidateQueries({ queryKey: ['strategies'] });
      const { byField, general } = splitErrors(res.errors);
      setFieldErrors(byField);
      setGeneralErrors(general);
      setServerUpdated(false);
      // 出错的字段保留用户输入,其它以服务端为准
      setDraftState((cur) => {
        const merged: Record<string, unknown> = { ...next };
        if (cur) for (const f of Object.keys(byField)) merged[f] = (cur as unknown as Record<string, unknown>)[f];
        return merged as unknown as Workflow;
      });
      const n = Object.keys(sent).length;
      if (res.errors.length > 0) {
        toast.warning(t('{n} 个字段没保存', { n: res.errors.length }), { description: res.errors.join('; ') });
      } else {
        toast.success(n > 0 ? t('已保存 {n} 项', { n }) : t('没有改动'));
      }
    },
    onError: (err) => toast.error(t('保存失败'), { description: friendlyError(err instanceof Error ? err.message : String(err)) }),
  });

  if (!draft) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const infoMinutes = Math.round(draft.info_every_ms / 60000);
  const heartbeatMinutes = Math.round(draft.heartbeat_every_ms / 60000);
  const calls = callsPerHour(draft);
  const callsText = calls.low === calls.high ? `${Math.round(calls.low)}` : `${Math.round(calls.low)}–${Math.round(calls.high)}`;
  const costText = `≈¥${(calls.high * 0.006).toFixed(2)}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {serverUpdated ? (
        <button
          type="button"
          onClick={reloadFromServer}
          className="flex shrink-0 items-center gap-1.5 border-b bg-warn/10 px-3 py-1.5 text-left text-[11px] text-warn animate-in fade-in slide-in-from-top-1 duration-200"
        >
          <RefreshCw className="size-3" />
          {t('服务端的工作流变了(可能是 agent 改的,也可能是别处改的)。点这里丢掉本地没保存的改动,拉最新的。')}
        </button>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y">
          {show('pace') ? (
            <Section id="pace" sectioned={sectioned} open={openGroups.has('pace')} onToggle={() => toggleGroup('pace')}>

          <div className="flex items-center gap-1.5 px-3 py-2">
            <span className="text-[11px] text-muted-foreground">{t('预设')}</span>
            {PRESETS.map((p) => (
              <Button key={p.id} size="xs" variant="outline" className="rounded-full" title={t(p.hint)} onClick={() => applyPreset(p)}>
                {t(p.label)}
              </Button>
            ))}
          </div>

          {hideWatchlist ? null : <WatchlistEditor draft={draft} setDraft={setDraft} error={fieldErrors['watchlist']} />}

          <FieldRow label={t('周期')} error={fieldErrors['timeframe']}>
            <Select value={draft.timeframe} onValueChange={(v) => setDraft((w) => ({ ...w, timeframe: v }))}>
              <SelectTrigger size="sm" className="h-7 w-24 text-[12px]">
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
          </FieldRow>

          <FieldRow label={t('扫描方式')} error={fieldErrors['scan_mode']}>
            <Select value={draft.scan_mode} onValueChange={(v) => setDraft((w) => ({ ...w, scan_mode: v as Workflow['scan_mode'] }))}>
              <SelectTrigger size="sm" className="h-7 w-36 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="triggered">{t('触发器命中才问模型')}</SelectItem>
                <SelectItem value="every_close">{t('每根收盘都问(演示用)')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <div className="px-3 pb-2 text-[11px] leading-relaxed text-muted-foreground">
            {draft.scan_mode === 'triggered'
              ? t('每根收盘只在本地算特征。突破、EMA 交叉、放量、急拉急跌、开收盘窗口、资金费率极端、回踩,命中任一个,或者到心跳,才叫模型。')
              : t('每根收盘对观察列表里每个币各问一次模型,费用随周期线性涨;演示看热闹用。')}
            <div className="num mt-1 text-foreground/80">
              {t('预计')} <span className="font-semibold">{callsText}</span> {t('次/小时')} · {costText}{t('/小时(GLM 单价 ≈¥0.006)')}
            </div>
          </div>

          {draft.scan_mode === 'triggered' ? (
            <>
              <FieldRow label={t('心跳')} hint={t('分钟,每个币最久多久问一次')} error={fieldErrors['heartbeat_every_ms']}>
                <NumInput min={5} value={heartbeatMinutes} onChange={(m) => setDraft((w) => ({ ...w, heartbeat_every_ms: Math.round(Math.max(1, m) * 60000) }))} />
              </FieldRow>
              <FieldRow label={t('急拉急跌阈值')} hint={t('% / 5 分钟,立刻唤醒')} error={fieldErrors['fast_move_pct']}>
                <Input
                  value={draft.fast_move_pct}
                  onChange={(e) => setDraft((w) => ({ ...w, fast_move_pct: e.target.value }))}
                  className="num h-7 w-20 text-[12px]"
                  inputMode="decimal"
                />
              </FieldRow>
            </>
          ) : null}

          <FieldRow label={t('每根收盘复查')} hint={t('关 = 只在成交、止损止盈、触发器、心跳的时候看')} error={fieldErrors['review_every_close']}>
            <Switch checked={draft.review_every_close} onCheckedChange={(v) => setDraft((w) => ({ ...w, review_every_close: v }))} />
          </FieldRow>

          <FieldRow label={t('失效确认根数')} hint={t('连续几根收盘 K 线越过失效价才算数,1–5')} error={fieldErrors['invalidation_confirm_bars']}>
            <NumInput min={1} value={draft.invalidation_confirm_bars} onChange={(n) => setDraft((w) => ({ ...w, invalidation_confirm_bars: Math.min(5, Math.max(1, Math.round(n))) }))} className="w-16" />
          </FieldRow>
          <FieldRow label={t('失效确认深度')} hint={t('越过不到这么多 ATR 就不算,0–1')} error={fieldErrors['invalidation_buffer_atr']}>
            <NumInput min={0} step={0.05} value={draft.invalidation_buffer_atr} onChange={(n) => setDraft((w) => ({ ...w, invalidation_buffer_atr: Math.min(1, Math.max(0, n)) }))} className="w-16" />
          </FieldRow>
          <div className="px-3 pb-2 text-[11px] leading-relaxed text-muted-foreground">{t('失效价被越过不等于必须离场,只有止损是硬线。根数和深度都满足了,才写成「失效确认=是」进持仓复查的证据。这两项模型改不了。')}</div>

          <FieldRow label={t('信息员频率')} hint={t('分钟')} error={fieldErrors['info_every_ms']}>
            <NumInput min={2} value={infoMinutes} onChange={(m) => setDraft((w) => ({ ...w, info_every_ms: Math.round(Math.max(1, m) * 60000) }))} />
          </FieldRow>

          
            </Section>
          ) : null}
          {show('risk') ? (
            <Section id="risk" sectioned={sectioned} open={openGroups.has('risk')} onToggle={() => toggleGroup('risk')}>
<FieldRow label={t('自动仓位')} error={fieldErrors['sizing_agent']}>
            <Select value={draft.sizing_agent} onValueChange={(v) => setDraft((w) => ({ ...w, sizing_agent: v as Workflow['sizing_agent'] }))}>
              <SelectTrigger size="sm" className="h-7 w-24 text-[12px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{t('关')}</SelectItem>
                <SelectItem value="advise">{t('只建议')}</SelectItem>
                <SelectItem value="apply">{t('采用')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
<FieldRow label={t('单笔风险')} hint={t('% 权益')} error={fieldErrors['risk_pct']}>
            <Input
              value={draft.risk_pct}
              onChange={(e) => setDraft((w) => ({ ...w, risk_pct: e.target.value }))}
              className="num h-7 w-20 text-[12px]"
              inputMode="decimal"
            />
          </FieldRow>

          {hideMarket ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              {t('交易市场、杠杆、保证金模式跟账户模式一起在「接入」页改。')}
              <a href="#connect" className="ml-1 text-primary hover:underline">{t('去接入页 →')}</a>
            </div>
          ) : (
            <>
          <FieldRow label={t('交易市场')} hint={t('现货无杠杆、只能买入持有')} error={fieldErrors['markets'] ?? fieldErrors['default_market']}>
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              {(['perp', 'spot'] as Market[]).map((m) => {
                const on = (draft.markets ?? ['perp']).includes(m);
                return (
                  <label key={m} className="flex items-center gap-1 select-none">
                    <Switch
                      checked={on}
                      onCheckedChange={(v) =>
                        setDraft((w) => {
                          const cur = w.markets ?? ['perp'];
                          const next = v ? [...new Set([...cur, m])] : cur.filter((x) => x !== m);
                          const markets: Market[] = next.length ? next : ['perp'];
                          const default_market: Market = markets.includes(w.default_market ?? 'perp') ? (w.default_market ?? 'perp') : markets[0]!;
                          return { ...w, markets, default_market };
                        })
                      }
                    />
                    {m === 'perp' ? t('永续') : t('现货')}
                  </label>
                );
              })}
              <span className="text-muted-foreground">{t('默认')}</span>
              <Select value={draft.default_market ?? 'perp'} onValueChange={(v) => setDraft((w) => ({ ...w, default_market: v as Market }))}>
                <SelectTrigger size="sm" className="h-7 w-20 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(draft.markets ?? ['perp']).map((m) => (
                    <SelectItem key={m} value={m}>
                      {m === 'perp' ? t('永续') : t('现货')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FieldRow>

          <FieldRow label={t('杠杆')} hint="1–10" error={fieldErrors['leverage']}>
            <NumInput min={1} value={draft.leverage} onChange={(n) => setDraft((w) => ({ ...w, leverage: n }))} />
          </FieldRow>

          <FieldRow label={t('保证金模式')} error={fieldErrors['margin_mode']}>
            <Select value={draft.margin_mode} onValueChange={(v) => setDraft((w) => ({ ...w, margin_mode: v as Workflow['margin_mode'] }))}>
              <SelectTrigger size="sm" className="h-7 w-24 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cross">{t('全仓')}</SelectItem>
                <SelectItem value="isolated">{t('逐仓')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
            </>
          )}

          <FieldRow label={t('日亏停')} hint={t('% 当日权益,到了就停新开仓')} error={fieldErrors['daily_loss_stop_pct']}>
            <Input
              value={draft.daily_loss_stop_pct}
              onChange={(e) => setDraft((w) => ({ ...w, daily_loss_stop_pct: e.target.value }))}
              className="num h-7 w-16 text-[12px]"
              inputMode="decimal"
            />
          </FieldRow>

          {/* v3.12 §9.30:事件封锁闸。0 = 关;> 0 时从事件开始前 N 分钟一直封到影响窗口结束。 */}
          <FieldRow label={t('事件封锁')} hint={t('分钟,0–360,0 = 关')} error={fieldErrors['event_blackout_min']}>
            <NumInput min={0} step={5} value={draft.event_blackout_min ?? 0} onChange={(n) => setDraft((w) => ({ ...w, event_blackout_min: Math.min(360, Math.max(0, Math.round(n))) }))} className="w-16" />
          </FieldRow>
          <div className="px-3 pb-2 text-[10.5px] leading-4 text-muted-foreground">
            {t('事件前 N 分钟到窗口结束不开新仓,不拦平仓。事件都在「事件区」页。')}
            <a href="#events" className="ml-1 text-primary hover:underline">{t('去事件区 →')}</a>
          </div>

          
            </Section>
          ) : null}
          {show('limits') ? (
            <Section id="limits" sectioned={sectioned} open={openGroups.has('limits')} onToggle={() => toggleGroup('limits')}>
<FieldRow label={t('最多同时线程数')} error={fieldErrors['max_open_threads']}>
            <NumInput min={1} value={draft.max_open_threads} onChange={(n) => setDraft((w) => ({ ...w, max_open_threads: n }))} className="w-16" />
          </FieldRow>

          <FieldRow label={t('每日最多开仓')} error={fieldErrors['max_opens_per_day']}>
            <NumInput min={1} value={draft.max_opens_per_day} onChange={(n) => setDraft((w) => ({ ...w, max_opens_per_day: n }))} className="w-16" />
          </FieldRow>

          <FieldRow label={t('每日判断上限')} hint={t('次/天,0–5000,0 = 不限')} error={fieldErrors['daily_judgment_cap']}>
            <NumInput min={0} value={draft.daily_judgment_cap ?? 0} onChange={(n) => setDraft((w) => ({ ...w, daily_judgment_cap: Math.max(0, Math.min(5000, Math.round(n))) }))} />
          </FieldRow>
          <div className="px-3 pb-2 text-[11px] leading-relaxed text-muted-foreground">{t('到上限之后,当天不再调模型(聊天不受限)。')}</div>

          
            </Section>
          ) : null}
          {show('automation') ? (
            <Section id="automation" sectioned={sectioned} open={openGroups.has('automation')} onToggle={() => toggleGroup('automation')}>
<FieldRow label={t('自动执行')} hint={t('扫描路径:agent 提议免确认')} error={fieldErrors['auto_approve']}>
            <Switch checked={draft.auto_approve} onCheckedChange={(v) => setDraft((w) => ({ ...w, auto_approve: v }))} />
          </FieldRow>

          {draft.chat_requires_approval !== undefined ? (
            <FieldRow label={t('对话执行需我确认')} hint={t('默认关:agent 在对话里就能批准执行(照样过全部代码闸);开了才要你两步确认')} error={fieldErrors['chat_requires_approval']}>
              <Switch checked={draft.chat_requires_approval} onCheckedChange={(v) => setDraft((w) => ({ ...w, chat_requires_approval: v }))} />
            </FieldRow>
          ) : null}

          <FieldRow label={t('旁白')} hint={t('判断、成交、平仓的时候在「动态」里说一句')} error={fieldErrors['narrate']}>
            <Switch checked={draft.narrate} onCheckedChange={(v) => setDraft((w) => ({ ...w, narrate: v }))} />
          </FieldRow>

          <FieldRow label={t('暂停')} hint={t('暂停期间不调模型')} error={fieldErrors['paused']}>
            <Switch checked={draft.paused} onCheckedChange={(v) => setDraft((w) => ({ ...w, paused: v }))} />
          </FieldRow>

          {/* §9.31:凭证按「通道 × 交易对」记,过期时刻按**当前**这个值从 verified_at 现算——调小了旧凭证立刻过期。 */}
          {draft.protection_ttl_days !== undefined ? (
            <FieldRow label={t('止损验证有效期')} hint={t('天,1–30:止损验证凭证多久要重验一次')} error={fieldErrors['protection_ttl_days']}>
              <NumInput
                min={1}
                value={draft.protection_ttl_days}
                onChange={(n) => setDraft((w) => ({ ...w, protection_ttl_days: Math.max(1, Math.min(30, Math.round(n))) }))}
                className="w-16"
              />
            </FieldRow>
          ) : null}

          {/* ──── §9.35 票池谁来改 ────────────────────────────────────
              手动 = 今天的行为(只有人点启用 / 停用);自动 = allocator 每天一次用**代码**
              决策票池。模型没有任何一条路径能改票池;策略页顶部那个切换写的是同一个字段。 */}
          {draft.active_mode !== undefined ? (
            <>
              <FieldRow label={t('票池谁来改')} hint={t('自动 = 代码每天排一次票池')} error={fieldErrors['active_mode']}>
                <Select value={draft.active_mode} onValueChange={(v) => setDraft((w) => ({ ...w, active_mode: v as Workflow['active_mode'] }))}>
                  <SelectTrigger size="sm" className="h-7 w-28 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">{t('手动')}</SelectItem>
                    <SelectItem value="auto">{t('自动')}</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <div className="px-3 pb-2 text-[10.5px] leading-4 text-muted-foreground">
                {draft.active_mode === 'auto'
                  ? t('每天一次按 regime 与最近 30 天净期望重排票池,会换掉正在参加议会表态的策略;不花钱,人随时能在策略页回滚。')
                  : t('票池只有你能改;allocator 只在策略页算预览,不落库。')}
                <a href="#strategies" className="ml-1 text-primary hover:underline">{t('去策略页 →')}</a>
              </div>
            </>
          ) : null}

          {/* ──── §9.25 策略议会三个开关(只有人能改) ──────────────────── */}
          {draft.strategy_council !== undefined ? (
            <>
              <FieldRow label={t('策略议会')} hint={t('关 / 只参考 / 硬闸')} error={fieldErrors['strategy_council']}>
                <Select value={draft.strategy_council} onValueChange={(v) => setDraft((w) => ({ ...w, strategy_council: v as Workflow['strategy_council'] }))}>
                  <SelectTrigger size="sm" className="h-7 w-40 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">{t('关')}</SelectItem>
                    <SelectItem value="advise">{t('只参考')}</SelectItem>
                    <SelectItem value="require">{t('硬闸:不够票不开仓')}</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <div className="px-3 pb-2 text-[10.5px] leading-4 text-muted-foreground">
                {t('「硬闸」会真的拦下开仓:票池里够不到共识票数,这一单就不开。这一项本身不花钱。')}
              </div>
            </>
          ) : null}

          {draft.council_min_agree !== undefined ? (
            <FieldRow label={t('共识票数')} hint={t('1–4 条策略同向才算有共识')} error={fieldErrors['council_min_agree']}>
              <NumInput
                min={1}
                value={draft.council_min_agree}
                onChange={(n) => setDraft((w) => ({ ...w, council_min_agree: Math.max(1, Math.min(4, Math.round(n))) }))}
                className="w-16"
              />
            </FieldRow>
          ) : null}

          {draft.council_model !== undefined ? (
            <>
              <FieldRow label={t('议会模型')} hint={t('关 / 副脑 / 主脑')} error={fieldErrors['council_model']}>
                <Select value={draft.council_model} onValueChange={(v) => setDraft((w) => ({ ...w, council_model: v as Workflow['council_model'] }))}>
                  <SelectTrigger size="sm" className="h-7 w-36 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">{t('关(纯代码表态)')}</SelectItem>
                    <SelectItem value="cheap">{t('副脑')}</SelectItem>
                    <SelectItem value="main">{t('主脑')}</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <div className="px-3 pb-2 text-[10.5px] leading-4 text-muted-foreground">
                {draft.council_model === 'off'
                  ? t('票池里每条策略都由代码表态,一次模型都不调,不花钱。')
                  : t('会花钱:每条策略一次模型调用 —— 一轮判断的调用数 = 票池条数。')}
              </div>
            </>
          ) : null}

          {/* ──── §9.26 限价入场 ───────────────────────────────── */}
          {draft.entry_style !== undefined ? (
            <>
              <FieldRow label={t('入场方式')} hint={t('随判断 / 优先限价挂回踩')} error={fieldErrors['entry_style']}>
                <Select value={draft.entry_style} onValueChange={(v) => setDraft((w) => ({ ...w, entry_style: v as Workflow['entry_style'] }))}>
                  <SelectTrigger size="sm" className="h-7 w-40 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">{t('随判断(市价也行)')}</SelectItem>
                    <SelectItem value="prefer_limit">{t('优先限价挂回踩')}</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              <div className="px-3 pb-2 text-[10.5px] leading-4 text-muted-foreground">
                {t('不花钱,但会改成交方式:优先限价 = 少追高,代价是可能挂不上、错过这一波。')}
              </div>
            </>
          ) : null}

          {/* ──── 策略库自动化:一个动策略状态,一个往库里加东西 ──────── */}
          {draft.lab_autopilot !== undefined ? (
            <>
              <FieldRow label={t('实验室自动闭环')} hint={t('自动写回成绩、自动提草稿、数据态自动晋升')} error={fieldErrors['lab_autopilot']}>
                <Switch checked={draft.lab_autopilot} onCheckedChange={(v) => setDraft((w) => ({ ...w, lab_autopilot: v }))} />
              </FieldRow>
              <div className="px-3 pb-2 text-[10.5px] leading-4 text-muted-foreground">
                {t('零模型,不花钱;但会动策略状态(draft / backtest / shadow 这几格的数据态晋升)。进 paper 之后照样要人点。')}
              </div>
            </>
          ) : null}

          {draft.strategy_discovery !== undefined ? (
            <>
              <FieldRow label={t('策略假设生成')} hint={t('默认关')} error={fieldErrors['strategy_discovery']}>
                <Switch checked={draft.strategy_discovery} onCheckedChange={(v) => setDraft((w) => ({ ...w, strategy_discovery: v }))} />
              </FieldRow>
              <div className="px-3 pb-2 text-[10.5px] leading-4 text-muted-foreground">
                {t('会花钱(副脑,每周 ≤ 1 次),而且会往策略库里加新草稿。新草稿不会自己进票池,要一格一格晋升。')}
              </div>
            </>
          ) : null}

          {/* §9.37 分层配额:短/中/长每层独立。**全 0 / 不勾 = 继承全局**,
              所以这一区什么都不动时,行为和分层上线之前逐字相同。 */}
          {draft.tier_policy !== undefined ? (
            <>
              <div className="px-3 pt-2 text-[11px] font-medium text-muted-foreground">{t('分层配额')}</div>
              <div className="px-3 pb-1 text-[10.5px] leading-4 text-muted-foreground">
                {t('按持有周期分层:scalp / intraday = 短线,swing = 中线,position = 长线。每格 0 = 继承全局,不额外限制;入场方式一个都不勾 = 不限。')}
              </div>
              <FieldError msg={fieldErrors['tier_policy']} />
              {TIERS.map((tier) => {
                const p = draft.tier_policy![tier];
                const patch = (over: Partial<TierPolicy>) =>
                  setDraft((w) => ({ ...w, tier_policy: { ...w.tier_policy!, [tier]: { ...w.tier_policy![tier], ...over } } }));
                return (
                  <div key={tier} className="border-t">
                    <div className="px-3 pt-2 text-[11.5px] font-medium">{t(TIER_LABEL[tier])}</div>
                    <FieldRow label={t('容量上限')} hint={t('0 = 继承全局')}>
                      <NumInput min={0} value={p.max_open_threads} onChange={(n) => patch({ max_open_threads: Math.max(0, Math.min(6, Math.round(n))) })} className="w-16" />
                    </FieldRow>
                    <FieldRow label={t('每日开仓上限')} hint={t('0 = 继承全局')}>
                      <NumInput min={0} value={p.max_opens_per_day} onChange={(n) => patch({ max_opens_per_day: Math.max(0, Math.min(12, Math.round(n))) })} className="w-16" />
                    </FieldRow>
                    <FieldRow label={t('议会票数')} hint={t('0 = 继承全局')}>
                      <NumInput min={0} value={p.council_min_agree} onChange={(n) => patch({ council_min_agree: Math.max(0, Math.min(4, Math.round(n))) })} className="w-16" />
                    </FieldRow>
                    <FieldRow label={t('票池名额')} hint={t('0 = 不限')}>
                      <NumInput min={0} value={p.allocator_slots} onChange={(n) => patch({ allocator_slots: Math.max(0, Math.min(4, Math.round(n))) })} className="w-16" />
                    </FieldRow>
                    <FieldRow label={t('允许的入场方式')} hint={t('都不勾 = 不限')}>
                      {(['market', 'limit'] as const).map((style) => (
                        <label key={style} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Switch
                            size="sm"
                            checked={p.entry_styles.includes(style)}
                            onCheckedChange={(on) =>
                              patch({ entry_styles: on ? [...p.entry_styles, style] : p.entry_styles.filter((x) => x !== style) })
                            }
                          />
                          {style === 'market' ? t('市价') : t('限价')}
                        </label>
                      ))}
                    </FieldRow>
                  </div>
                );
              })}
            </>
          ) : null}

          <div className={cn(fieldErrors['playbook_text'] && 'bg-destructive/5')}>
            <div className="px-3 py-2">
              <div className="mb-1.5 flex items-center text-[12px] text-muted-foreground">
                Playbook
                <span className="num ml-auto text-[10px]">{draft.playbook_text.length}/4000</span>
              </div>
              <Textarea
                value={draft.playbook_text}
                onChange={(e) => setDraft((w) => ({ ...w, playbook_text: e.target.value }))}
                rows={9}
                className="resize-y text-[12px] leading-relaxed"
                placeholder={t('写给判断模型看的策略说明…')}
              />
            </div>
            <FieldError msg={fieldErrors['playbook_text']} />
          </div>

            </Section>
          ) : null}
          {show('brain') ? (
            <Section id="brain" sectioned={sectioned} open={openGroups.has('brain')} onToggle={() => toggleGroup('brain')}>
<div id="workflow-brain-section" className="border-t">
            <div className="px-3 pt-2 text-[11px] font-medium text-muted-foreground">{t('大脑')}</div>
            <BrainPickerRow
              id="brain-main"
              label={t('主脑')}
              hint={<SlotRoles slot="main" />}
              kind={draft.brain}
              model={draft.brain_model}
              brains={brainsQ.data?.brains ?? []}
              onKindChange={(k) => setDraft((w) => ({ ...w, brain: k }))}
              onModelChange={(m) => setDraft((w) => ({ ...w, brain_model: m && m.trim() !== '' ? m : null }))}
              kindError={fieldErrors['brain']}
              modelError={fieldErrors['brain_model']}
            />
            <BrainPickerRow
              id="brain-cheap"
              label={t('副脑')}
              hint={<SlotRoles slot="cheap" />}
              kind={draft.cheap_brain}
              model={draft.cheap_brain_model}
              brains={brainsQ.data?.brains ?? []}
              onKindChange={(k) => setDraft((w) => ({ ...w, cheap_brain: k }))}
              onModelChange={(m) => setDraft((w) => ({ ...w, cheap_brain_model: m && m.trim() !== '' ? m : null }))}
              kindError={fieldErrors['cheap_brain']}
              modelError={fieldErrors['cheap_brain_model']}
            />
          </div>

          
            </Section>
          ) : null}
        </div>
      </ScrollArea>
      <Separator />
      <div className="shrink-0 space-y-1.5 p-2.5">
        {generalErrors.length > 0 ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{generalErrors.join('; ')}</div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <Button
            className="flex-1"
            size="sm"
            disabled={save.isPending || !dirty}
            onClick={() => {
              if (dirty) save.mutate(patch);
            }}
          >
            {save.isPending ? t('保存中…') : dirty ? t('保存 {n} 项改动', { n: Object.keys(patch).length }) : t('没有改动')}
          </Button>
          {dirty ? (
            <Button size="sm" variant="ghost" onClick={reloadFromServer} title={t('丢掉没保存的改动')}>
              {t('撤销')}
            </Button>
          ) : null}
        </div>
        {dirty ? (
          <div className="num truncate text-[10.5px] text-muted-foreground">
            {t('改了')}:{Object.keys(patch).map((k) => FIELD_LABEL[k] ?? k).join(listSep())}
          </div>
        ) : null}
      </div>
    </div>
  );
}

