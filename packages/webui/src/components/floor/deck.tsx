/**
 * 楼层中央:桌子拓扑(notebook §3)+ 像素人 + 桌上气泡 + 交接包裹动画 + 三块小屏。
 * 纯展示;点桌子只是选中,「打开工作台」在选中卡里(设计稿 §1:桌子是既有页面的入口)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { exchangeInfo } from '@/lib/exchange';
import { backendLabel, BIAS_LABEL, REGIME_LABEL } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { EquityPoint, MarketState, MarketView, Overview } from '@/api/types';
import { ROLE_ORDER, type RoleMetaMap } from './roles';
import { AgentStation } from './station';
import { Ambient } from './ambient';
import { HandoffOverlay, useHandoffEvents } from './handoff-overlay';
import type { Pulses } from './animator';
import { useFloorMotions } from './motion';
import type { BotPresence, BotRole, FeedItem } from './types';
import type { SceneMeta } from './scenes';
import type { EvoDay } from '@/api/evolution';

export interface DeckAgent {
  role: BotRole;
  name: string;
  enabled: boolean;
  note: string | null;
  presence: BotPresence;
  lastLine: FeedItem | null;
  /** 有证据的常驻提示(行情过期 / 预算耗尽 / 断流),叠在 presence.action 之上 */
  overlay?: { text: string; tone: 'warn' | 'danger' } | null;
}

interface DeckProps {
  /** 当前场景(scenes.ts);决定墙上分区文字与场景专属的布景层 */
  scene: SceneMeta;
  execution?: import('@/api/types').ExecutionView | null;
  meta: RoleMetaMap;
  agents: DeckAgent[];
  pulses: Pulses;
  handoffs: import('./types').BotHandoff[];
  /** 当前判断步骤(overview.queue.running.step),画在 THREAD 桌的屏幕上,只画真实步骤 */
  step: string | null;
  /** 首次名册响应只建立基线,不能把历史记录当新交接。 */
  handoffsReady?: boolean;
  selected: BotRole | null;
  onSelect: (r: BotRole) => void;
  overview: Overview | null | undefined;
  equity: EquityPoint[];
  now: number;
  /** 2026-09-23 进化方格:角色 → 日序列 + 截止日;接口没就绪时不传,工位下不画方格 */
  evo?: { byRole: Record<string, EvoDay[]>; to: string } | null;
}

// ---------------------------------------------------------------- 小屏

function Spark({ points, color }: { points: number[]; color: string }) {
  const d = useMemo(() => {
    if (points.length < 2) return '';
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    return points.map((v, i) => `${(i / (points.length - 1)) * 100},${30 - ((v - min) / span) * 28 - 1}`).join(' ');
  }, [points]);
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-7 w-full">
      <polyline points={d} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function fmtMoney(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtClock(now: number): string {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fmtCountdown(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function MiniScreens({ overview, equity, now, execution }: { overview: Overview | null | undefined; equity: EquityPoint[]; now: number; execution?: import('@/api/types').ExecutionView | null }) {
  const readError = execution?.account_read_error ?? null;
  // 交易所名字/入金链接按 TG_EXCHANGE 走,别写死币安
  const ex = exchangeInfo(execution);
  const unfunded = execution?.account_funded === false || overview?.account?.quality === 'unfunded';
  const acc = overview?.account;
  const equityNow = acc ? Number(acc.equity) : NaN;
  const positions = acc?.positions ?? [];
  const upnl = acc ? Number(acc.unrealized_pnl) || 0 : 0;
  // /api/history 的权益序列目前跨执行通道连在一起(paper 10000 → agent_mcp 100),直接拿首尾相减就是「−9900」。
  // 在网关按通道拆开之前,只取最后一段「没有断崖」的曲线:从尾往前走,相邻两点跳变超过 50% 就当作切了通道,截断。
  const eqAll = equity.map((p) => p.equity).filter((v) => Number.isFinite(v) && v > 0);
  let cut = 0;
  for (let i = eqAll.length - 1; i > 0; i--) {
    const a = eqAll[i - 1]!;
    const b = eqAll[i]!;
    if (Math.abs(b - a) / Math.max(a, b) > 0.5) {
      cut = i;
      break;
    }
  }
  const eq = eqAll.slice(cut);
  // 权益读不到(通道未就绪 / 子账户未入金)时不算 PnL,别把「0 − 起点」画成亏光
  const readable = Number.isFinite(equityNow) && equityNow > 0;
  const pnl = readable && eq.length >= 2 ? equityNow - eq[0]! : null;
  const mk: MarketView | undefined = overview?.market ?? undefined;
  const ms: MarketState | null | undefined = overview?.market_state;
  const major = ms?.majors?.find((m) => m.symbol === mk?.symbol) ?? ms?.majors?.[0];
  const loop = overview?.loop;
  const next = loop?.next_at ? loop.next_at - now : null;
  const q = overview?.queue;
  return (
    <div className="of-market-wall grid grid-cols-3 gap-2 px-2 pt-2">
      <div className="of-panel-2 of-mini p-2">
        <div className="of-kicker">{t('账户')} · {backendLabel(acc?.backend)}</div>
        {readable ? (
          <>
            <div className="of-title text-lg" style={{ color: (pnl ?? 0) >= 0 ? 'var(--of-accent)' : 'var(--of-danger)' }}>
              {pnl === null ? '—' : fmtMoney(pnl)}
            </div>
            <div className="text-[9px] text-[var(--of-ink-dim)]">{t('权益 {v}', { v: equityNow.toFixed(2) })}</div>
            {/* v2 落地清单 4:持仓一眼可见(默认首页的前置条件),点去交易页 */}
            <a href="#trade" className="block text-[9px] hover:underline" title={t('去交易页看持仓')} style={{ color: upnl > 0 ? 'var(--of-accent)' : upnl < 0 ? 'var(--of-danger)' : 'var(--of-ink-dim)' }}>
              {t('持仓 {n} 笔 · 浮盈 {pnl}', { n: positions.length, pnl: fmtMoney(upnl) })}
              {positions.length ? <span className="text-[var(--of-ink-faint)]"> · {positions.slice(0, 3).map((p) => p.symbol.replace(/USDT$/, '')).join(' ')}{positions.length > 3 ? ' …' : ''}</span> : null}
            </a>
            <Spark points={eq.length >= 2 ? eq : [equityNow, equityNow]} color={(pnl ?? 0) >= 0 ? 'var(--of-accent)' : 'var(--of-danger)'} />
          </>
        ) : (
          <>
            <div className="of-title text-base" style={{ color: readError ? 'var(--of-danger)' : 'var(--of-warn)' }}>
              {readError ? t('账户读不出来') : unfunded ? t('{acct}没入金', { acct: ex.account }) : t('账户还没数据')}
            </div>
            <div className="text-[9px] leading-3 text-[var(--of-ink-dim)]">
              {readError ? t('读取失败:{msg}', { msg: readError.message }) : unfunded ? t('{acct}余额是 0,不是亏光了;agent 开不了新仓。', { acct: ex.account }) : t('等执行通道把权益返回来。')}
              {unfunded ? (
                <>
                  {' '}
                  <a className="underline" href={ex.depositUrl} target="_blank" rel="noreferrer noopener">
                    {t('去入金 ↗')}
                  </a>
                </>
              ) : null}
            </div>
          </>
        )}
      </div>
      <div className="of-panel-2 of-mini p-2">
        <div className="of-kicker">{t('当前判断')}</div>
        {q?.running ? (
          <>
            <div className="of-title text-base text-[var(--of-info)]">
              {q.running.kind} {q.running.symbol ?? ''}
            </div>
            <div className="text-[9px] text-[var(--of-ink-dim)]">{t('步骤 {step} · 队列 {n}', { step: q.running.step ?? '—', n: q.pending })}</div>
          </>
        ) : (
          <>
            <div className="of-title text-base">{loop?.paused ? t('已暂停') : loop?.halted ? t('紧急停止') : t('待机')}</div>
            <div className="text-[9px] text-[var(--of-ink-dim)]">
              {t('下一轮 {left} · 队列 {n} · 大脑 {brain}', { left: fmtCountdown(next), n: q?.pending ?? 0, brain: loop?.brain ?? '—' })}
            </div>
          </>
        )}
        <div className="mt-1 flex gap-1">
          {(['fetching', 'context', 'thinking', 'validating', 'gating', 'executing'] as const).map((s) => (
            <span key={s} className="h-1.5 flex-1 rounded-sm" style={{ background: q?.running?.step === s ? 'var(--of-info)' : 'var(--of-line)' }} />
          ))}
        </div>
      </div>
      <div className="of-panel-2 of-mini p-2">
        <div className="flex items-baseline justify-between">
          <div className="of-kicker">{t('主图')}</div>
          <div className="text-[9px] text-[var(--of-ink-dim)]">{fmtClock(now)}</div>
        </div>
        <div className="of-title text-base">
          {mk?.symbol ?? '—'} <span className="text-[var(--of-accent)]">{mk?.last ?? ''}</span>
        </div>
        <div className="text-[9px] text-[var(--of-ink-dim)]">
          {t('24h {chg}% · 费率 {rate}% · OI {oi}', { chg: major?.change_24h_pct ?? '—', rate: mk ? (Number(mk.funding_rate) * 100).toFixed(4) : '—', oi: mk?.open_interest ?? '—' })}
        </div>
        <div className="mt-1 text-[9px]">
          {ms ? (
            <>
              <span className="text-[var(--of-ink-dim)]">{t('状态')}</span> {REGIME_LABEL[ms.regime] ?? ms.regime} · {BIAS_LABEL[ms.bias] ?? ms.bias} · {t('恐贪')} {ms.sentiment.fng ?? '—'}
            </>
          ) : (
            t('信息员还没出总结')
          )}
        </div>
      </div>
    </div>
  );
}

export function Deck({ scene, meta, agents, pulses, handoffs, step, selected, onSelect, overview, equity, now, execution, handoffsReady = true, evo = null }: DeckProps) {
  const byRole = useMemo(() => Object.fromEntries(agents.map((a) => [a.role, a])) as Record<BotRole, DeckAgent | undefined>, [agents]);
  // 地板像素尺寸(走动位移按百分比桌位换算成 px)
  const deckRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 1000, h: 560 });
  useEffect(() => {
    const el = deckRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const r = es[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const events = useHandoffEvents(handoffs, handoffsReady);
  const motions = useFloorMotions({ events, meta, size });
  const ledRole = agents.find((a) => a.presence.state === 'thinking')?.role ?? 'executor';
  const online = agents.filter((a) => a.presence.state !== 'off').length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--of-line)] px-3 py-1.5">
        <span className="of-title text-sm">{t('楼层')}</span>
        <span className="text-[10px] text-[var(--of-ink-dim)]">{t('{n} 个角色在线 · 点桌子看详情', { n: online })}</span>
        {/* 图例放在头部,不再压在右下角的桌牌上 */}
        <span className="hidden gap-3 text-[9px] text-[var(--of-ink-dim)] md:flex">
          <span><i className="of-dot of-dot-working mr-1" />{t('在干活')}</span>
          <span><i className="of-dot of-dot-waiting mr-1" />{t('等着')}</span>
          <span><i className="of-dot of-dot-blocked mr-1" />{t('卡住')}</span>
          <span><i className="of-dot mr-1" />{t('未接线')}</span>
        </span>
        <span className="ml-auto of-kicker">
          {overview?.loop?.halted ? <span style={{ color: 'var(--of-danger)' }}>■ {t('紧急停止')}</span> : overview?.loop?.paused ? <span style={{ color: 'var(--of-warn)' }}>■ {t('已暂停')}</span> : <span style={{ color: 'var(--of-accent)' }}>■ {t('运行中')}</span>}
        </span>
      </div>
      <MiniScreens overview={overview} equity={equity} now={now} execution={execution} />
      <div ref={deckRef} className="of-deck mx-2 mb-2 min-h-0 flex-1" style={{ minHeight: 360 }}>
        <Ambient />
        <HandoffOverlay events={events} meta={meta} size={size} />
        {/* 分区文字贴在墙上:左墙上下两段、右墙上下两段、底墙一段(v2:不铺地毯) */}
        <span className="of-zone of-zone-l" style={{ top: 18 }}>{t(scene.zones.left)}</span>
        <span className="of-zone of-zone-r" style={{ top: 18 }}>{t(scene.zones.right)}</span>
        <span className="of-zone of-zone-t">{t(scene.zones.top)}</span>
        <span className="of-zone of-zone-b">{t(scene.zones.bottom)}</span>
        {agents.map((a) => {
          const r = a.role;
          return <AgentStation key={r} a={a} meta={meta} selected={selected === r} onSelect={() => onSelect(r)} pulse={pulses[r]} step={step} motion={motions[r]} animateLed={r === ledRole} highlight={events.some((e) => e.from === r || e.to === r)} evo={evo ? { days: evo.byRole[r] ?? [], to: evo.to } : null} />;
        })}
      </div>
    </div>
  );
}
