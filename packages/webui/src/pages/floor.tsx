/**
 * 楼层页(#/floor):Grok Bot Architecture 风格的「值班团队作战楼层」。
 * 设计:docs/design/ops-floor-2026-09-05.md —— 三层监督的前两层(状态提示 + 侧栏预览),
 * 每张桌子是既有工作台的入口,不新增任何权限;楼层只读,唯一的写动作是 ack 交接(= 已阅,
 * 不代表接手或授权);Radar 的 watchlist 提案在这里只预览 diff,应用去筛选页确认(Codex 评审 §8)。
 *
 * 数据全部走 App.tsx 约定的 query key(['overview'] ['activity'] ['bots'] ['execution']
 * ['backtest'] ['history']),本页不开 SSE;bots.changed / screener.changed / activity 由 App.tsx 失效。
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { ActivityResponse, BotsResponse, CaptainBriefResponse, ChatMessagesResponse, LabExperimentsResponse, PortfolioSnapshotResponse, ReviewerCardsResponse, RiskAlertsResponse } from '@/api/types';
import { Council, HandoffFeed } from '@/components/floor/council';
import { Deck, type DeckAgent } from '@/components/floor/deck';
import { MissionSource, SelectedAgentCard, WriterFence } from '@/components/floor/mission';
import { useFloorPulses } from '@/components/floor/animator';
import { derivePresence, lastLineByRole, mergeFeed } from '@/components/floor/presence';
import { LOCAL_ROSTER, ROLE_ORDER, orderedRoles, resolveRoleMeta } from '@/components/floor/roles';
import { paletteStyle, useFloorPrefs } from '@/components/floor/prefs';
import { PROGRESS_TTL_MS, useRoleProgress } from '@/components/floor/progress';
import { PortfolioPanel, RISK_LEVEL_COLOR, RISK_LEVEL_LABEL, RiskPanel } from '@/components/floor/risk-card';
import { ReviewerPanel } from '@/components/floor/reviewer-card';
import { CaptainBriefPanel, LabPanel } from '@/components/floor/lab-card';
import type { BotProfileWithPresence, BotRole } from '@/components/floor/types';
import { SCENES } from '@/components/floor/scenes';
import { SceneSwitch } from '@/components/floor/scene-switch';
import { CurrentStrategyChip, DeskStrategySlices } from '@/components/agent-strategy/current-strategy';
import { DESK_SLICES, useAgentStrategy } from '@/api/agent-strategy';
import '@/components/floor/floor.css';
import '@/components/floor/scene-command.css';
import '@/components/floor/scene-research.css';
import '@/components/floor/scene-meme.css';
import { exchangeInfo } from '@/lib/exchange';
import { useEvolutionDaily } from '@/api/evolution';
import { TodayStrip } from '@/components/evolution/today-strip';
import { ModelSetupBanner } from '@/components/models/setup-banner';
import { useModels } from '@/components/models/use-models';
import { backendLabel, fx, relativeTime, useNow } from '@/lib/format';
import { t, tmap, useLang } from '@/lib/i18n';
import { fmtCost } from '@/lib/money';

/** 执行通道连接状态;'checking' 是前端在数据没回来时自己填的。 */
const CONN_LABEL: Record<string, string> = tmap({ connected: '已连接', needs_auth: '未登录', unavailable: '不可用', unknown: '状态未知', checking: '检查中' });

function useSecondTick(): number {
  // useNow 默认 15s;楼层的时钟和倒计时要走秒。
  return useNow(1000);
}

export function FloorPage({ connected = true }: { connected?: boolean }) {
  const now = useSecondTick();
  // 桌牌 / 气泡这些常量文案要跟着语言走,所以下面几个 useMemo 都把 lang 算进依赖。
  const lang = useLang();
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 20_000 });
  const activityQ = useQuery<ActivityResponse>({ queryKey: ['activity'], queryFn: () => api.activity(200) });
  const botsQ = useQuery<BotsResponse>({ queryKey: ['bots'], queryFn: api.bots, refetchInterval: 30_000, retry: false });
  const executionQ = useQuery({ queryKey: ['execution'], queryFn: api.execution, refetchInterval: 30_000 });
  const backtestQ = useQuery({ queryKey: ['backtest'], queryFn: () => api.backtests(5), refetchInterval: 30_000 });
  const historyQ = useQuery({ queryKey: ['history'], queryFn: () => api.history(200) });
  const riskQ = useQuery<RiskAlertsResponse>({ queryKey: ['risk', 'alerts', 'open'], queryFn: () => api.riskAlerts('open'), refetchInterval: 60_000, retry: false });
  const portfolioQ = useQuery<PortfolioSnapshotResponse>({ queryKey: ['portfolio', 'snapshot'], queryFn: api.portfolioSnapshot, refetchInterval: 60_000, retry: false });
  const reviewerQ = useQuery<ReviewerCardsResponse>({ queryKey: ['reviewer', 'cards'], queryFn: () => api.reviewerCards(20), refetchInterval: 120_000, retry: false });
  const labQ = useQuery<LabExperimentsResponse>({ queryKey: ['lab', 'experiments'], queryFn: () => api.labExperiments(5), refetchInterval: 120_000, retry: false });
  const captainQ = useQuery<CaptainBriefResponse>({ queryKey: ['captain', 'brief'], queryFn: api.captainBrief, refetchInterval: 300_000, retry: false });
  const chatQ = useQuery<ChatMessagesResponse>({ queryKey: ['chat-messages', 'chat'], queryFn: () => api.chatMessages(30, 'chat') });
  // 2026-09-23 进化:顶部「今天」条 + 工位下 30 天方格;接口没就绪(error)时两者都不画
  const evoQ = useEvolutionDaily();
  // §9.52:角色卡「用什么模型」读 ModelsView.effective;老网关没有 /api/models 时回退两槽推断
  const modelsQ = useModels();
  // §9.54:当前策略与各桌分到的 binding 片
  const agentStrategyQ = useAgentStrategy();
  const evo = useMemo(() => (evoQ.data ? { byRole: Object.fromEntries(evoQ.data.roles.map((r) => [r.role, r.days])), to: evoQ.data.to } : null), [evoQ.data]);

  // 深链:#floor?sel=risk_sentinel(Agent 页异常块「去楼层处理」用)
  const [selected, setSelected] = useState<BotRole | null>(() => {
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const sel = q.get('sel');
    return sel && ((ROLE_ORDER as string[]).includes(sel) || /^[a-z_]+$/.test(sel)) ? (sel as BotRole) : 'gate_captain';
  });
  const prefs = useFloorPrefs();
  const progress = useRoleProgress();
  const rosterSource: 'gateway' | 'local' = botsQ.data ? 'gateway' : 'local';
  // 名册以网关为准:ROLE_ORDER 里的按固定桌位,网关新加的角色(前端还没 meta)按出现顺序排在后面用通用外观。
  const profiles = useMemo<BotProfileWithPresence[]>(() => {
    const src = (botsQ.data?.bots as BotProfileWithPresence[] | undefined) ?? LOCAL_ROSTER;
    const by = Object.fromEntries(src.map((p) => [p.role, p]));
    return orderedRoles(src.map((p) => p.role)).map((r) => by[r]).filter((p): p is BotProfileWithPresence => Boolean(p));
  }, [botsQ.data]);
  const extraRoles = useMemo(() => profiles.map((p) => p.role).filter((r) => !(ROLE_ORDER as string[]).includes(r)), [profiles]);
  const meta = useMemo(() => resolveRoleMeta(prefs, extraRoles), [prefs, lang, extraRoles]);

  const activity = activityQ.data?.activity ?? [];
  const handoffs = botsQ.data?.handoffs ?? [];
  const feed = useMemo(() => mergeFeed(handoffs, activity), [handoffs, activity]);
  const pendingHandoffs = useMemo(() => feed.filter((f) => f.source === 'handoff' && f.status === 'pending'), [feed]);
  const needsApproval = useMemo(() => {
    // 最近 6 小时里「等你批」且之后没有 approved/rejected 的提案;粗口径,只用于收件箱计数。
    const cutoff = now - 6 * 3600_000;
    const decided = new Set(activity.filter((a) => (a.kind === 'approved' || a.kind === 'rejected') && a.at >= cutoff).map((a) => a.thread_id ?? a.symbol ?? ''));
    return feed.filter((f) => f.source === 'activity' && f.kind === 'request' && f.to === 'user' && f.at >= cutoff && !decided.has(f.symbol ?? ''));
  }, [feed, activity, now]);

  const lastLines = useMemo(() => lastLineByRole(feed), [feed]);
  const chatMessages = chatQ.data?.messages ?? [];
  const pulses = useFloorPulses({ handoffs, activity, episodes: overviewQ.data?.recent_episodes ?? [], chat: chatMessages, now });

  // 有证据的常驻提示(Codex §6):断流 / 行情过期 / 预算耗尽 / 认证失败。只挂在相关角色上,不盖住 blocked。
  const overlays = useMemo(() => {
    const out: Partial<Record<BotRole, { text: string; tone: 'warn' | 'danger' }>> = {};
    const ov = overviewQ.data;
    if (!connected) out.radar = { text: t('实时连接断了,数据可能是旧的'), tone: 'danger' };
    else if (ov?.market?.as_of && now - ov.market.as_of > 3 * 60_000) out.radar = { text: t('行情 {n} 分钟没更新', { n: Math.round((now - ov.market.as_of) / 60_000) }), tone: 'warn' };
    if (ov?.usage_today?.capped) out.thread_manager = { text: t('今日判断到上限 {cap},不再调模型', { cap: ov.usage_today.cap }), tone: 'warn' };
    // 进度(有证据:SSE 每币一条)优先于其它常驻提示,15 秒没更新就撤
    for (const [role, p] of Object.entries(progress)) {
      // label 在 App.tsx 写进来时已经 t() 过了,这里别再翻一次
      if (p && now - p.at < PROGRESS_TTL_MS) out[role as BotRole] = { text: `${p.label} ${p.done}/${p.total}`, tone: 'warn' };
    }
    if (executionQ.data?.account_read_error) out.executor = { text: t('账户读不出来:{msg}', { msg: executionQ.data.account_read_error.message }), tone: 'danger' };
    else if (executionQ.data?.account_funded === false) out.executor = { text: t('{acct}没入金,开不了新仓', { acct: exchangeInfo(executionQ.data).account }), tone: 'warn' };
    const conn = executionQ.data?.connection;
    if (!out.executor && executionQ.data && conn && conn.status !== 'connected' && executionQ.data.backend !== 'paper') out.executor = { text: conn.status === 'needs_auth' ? t('执行后端没登录,去 Agent › 执行') : conn.detail || t('执行后端没就绪'), tone: conn.status === 'needs_auth' ? 'danger' : 'warn' };
    return out;
  }, [overviewQ.data, executionQ.data, connected, now, progress, lang]);

  const agents = useMemo<DeckAgent[]>(() => {
    const inputs = { overview: overviewQ.data, execution: executionQ.data, backtests: backtestQ.data, pendingHandoffs: pendingHandoffs.length, recentActivity: activity, now };
    return profiles.map((p) => ({
      role: p.role,
      name: p.name,
      enabled: p.enabled,
      note: p.note,
      // 网关派生的 presence 优先;缺失(老网关 / 本地名册)时前端兜底。
      presence: p.presence ?? derivePresence(p, inputs),
      lastLine: lastLines[p.role] ?? null,
      overlay: overlays[p.role] ?? null,
    }));
  }, [profiles, overviewQ.data, executionQ.data, backtestQ.data, pendingHandoffs.length, activity, now, lastLines, overlays, lang]);

  const selectedAgent = agents.find((a) => a.role === selected) ?? null;
  const selectedProfile = profiles.find((p) => p.role === selected) ?? null;
  const ov = overviewQ.data;
  const usage = ov?.usage_today;
  const lastEp = ov?.recent_episodes?.[0];
  const watchlist = ov?.workflow?.watchlist ?? [];
  const handoffs24h = feed.filter((f) => f.source === 'handoff' && f.at >= now - 24 * 3600_000).length;

  return (
    <div className={`of-root of-scene-${prefs.scene} flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-[var(--of-line)]`} style={paletteStyle(prefs.palette)} data-scene={prefs.scene}>
      {/* 顶栏 */}
      <header className="flex shrink-0 items-stretch border-b border-[var(--of-line)]">
        <div className="flex items-center gap-3 px-4 py-2">
          <span className="grid h-8 w-8 place-items-center rounded-full border border-[var(--of-line)] bg-[var(--of-panel-2)] text-[var(--of-accent)]">◍</span>
          <div>
            <div className="of-title whitespace-nowrap text-xl leading-6">{t('Trading Swarm 值班楼层')}</div>
            <div className="hidden text-[10px] text-[var(--of-ink-dim)] xl:block">{t('谁在干活、谁在等你、钱只能从哪儿出去')}</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 px-3">
          <CurrentStrategyChip className="border-[var(--of-line)] bg-[var(--of-panel-2)]" />
          <SceneSwitch />
        </div>
        <div className="grid grid-cols-4 divide-x divide-[var(--of-line)] border-l border-[var(--of-line)]">
          <TopCell k={t('执行后端')} v={backendLabel(ov?.loop?.backend)} sub={CONN_LABEL[executionQ.data?.connection.status ?? 'checking'] ?? executionQ.data?.connection.status} color={ov?.loop?.halted ? 'var(--of-danger)' : 'var(--of-accent)'} />
          <TopCell k={t('调度')} v={ov?.loop?.halted ? t('紧急停止') : ov?.loop?.paused ? t('已暂停') : t('运行中')} sub={t('每 {n} 分钟 · {brain}', { n: Math.round((ov?.loop?.every_ms ?? 0) / 60000), brain: ov?.loop?.brain ?? '' })} color={ov?.loop?.halted ? 'var(--of-danger)' : ov?.loop?.paused ? 'var(--of-warn)' : 'var(--of-accent)'} />
          <TopCell k={t('今日判断')} v={usage ? `${usage.judgments} / ${usage.cap || '∞'}` : '—'} sub={usage?.est_cny != null ? `≈ ${fmtCost(usage.est_cny)}` : ''} color={usage?.capped ? 'var(--of-warn)' : undefined} />
          <TopCell k={t('开着的线程')} v={String(ov?.threads?.length ?? 0)} sub={t('观察 {n} 个币', { n: watchlist.length })} />
        </div>
      </header>

      <ModelSetupBanner slots={ov?.workflow ? { brain: ov.workflow.brain, cheap_brain: ov.workflow.cheap_brain } : null} />

      <TodayStrip today={evoQ.data?.today} />

      {/* 三栏 */}
      <div className="grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)_260px] gap-2 p-2 xl:grid-cols-[230px_minmax(0,1fr)_300px]">
        <aside className="of-scroll flex min-h-0 flex-col gap-2 overflow-y-auto">
          <MissionSource overview={ov} now={now} pendingHandoffs={pendingHandoffs} needsApproval={needsApproval} meta={meta} />
          <SelectedAgentCard agent={selectedAgent} profile={selectedProfile} onOpen={(page) => (window.location.hash = page)} meta={meta} loop={ov?.loop} models={modelsQ.data ?? null} />
          {selected === 'risk_sentinel' ? <RiskPanel data={riskQ.data} now={now} /> : null}
          {selected === 'portfolio_manager' ? <PortfolioPanel snap={portfolioQ.data?.snapshot} capacity={portfolioQ.data?.capacity ?? null} now={now} /> : null}
          {selected === 'reviewer' ? <ReviewerPanel data={reviewerQ.data} now={now} /> : null}
          {selected === 'strategy_lab' ? <LabPanel data={labQ.data} now={now} /> : null}
          {selected === 'gate_captain' ? <CaptainBriefPanel data={captainQ.data} now={now} /> : null}
          {selected && DESK_SLICES[selected] ? (
            <section className="of-panel space-y-1.5 p-2.5">
              <div className="text-[11px] text-[var(--of-ink-dim)]">{t('当前策略分给这张桌的规则')}</div>
              <DeskStrategySlices desk={selected} view={agentStrategyQ.data} />
            </section>
          ) : null}
          <WriterFence profiles={profiles} />
        </aside>
        <main className="of-panel of-scroll min-h-0 overflow-y-auto overflow-x-hidden">
          <Deck scene={SCENES[prefs.scene]} execution={executionQ.data} meta={meta} agents={agents} pulses={pulses} handoffs={handoffs} handoffsReady={botsQ.isSuccess} step={ov?.queue?.running?.step ?? null} selected={selected} onSelect={setSelected} overview={ov} equity={historyQ.data?.equity ?? []} now={now} evo={evo} />
        </main>
        <aside className="flex min-h-0 flex-col gap-2">
          <Council meta={meta} agents={agents} riskLevel={riskQ.data?.level ?? null} selected={selected} onSelect={setSelected} rosterSource={rosterSource} loop={ov?.loop} models={modelsQ.data ?? null} />
          <HandoffFeed feed={feed} now={now} watchlist={watchlist} meta={meta} />
        </aside>
      </div>

      {/* 底栏 */}
      <footer className="grid shrink-0 grid-cols-6 divide-x divide-[var(--of-line)] border-t border-[var(--of-line)]">
        <BottomCell k={t('连接')} v={!connected ? t('已断开') : activityQ.isError || overviewQ.isError ? t('降级') : botsQ.isError ? t('部分') : t('实时')} sub={botsQ.isError ? t('/api/bots 没提供,名册走本地兜底') : undefined} color={!connected || activityQ.isError || overviewQ.isError ? 'var(--of-danger)' : botsQ.isError ? 'var(--of-warn)' : 'var(--of-accent)'} />
        <BottomCell k={t('24h 交接')} v={String(handoffs24h).padStart(2, '0')} />
        <BottomCell k={t('最新判断')} v={lastEp ? `${lastEp.symbol} ${lastEp.action ?? '—'}` : '—'} sub={lastEp ? `${relativeTime(lastEp.at, now)}${lastEp.confidence != null ? ` · ${t('自报信心 {n}%', { n: Math.round(lastEp.confidence * 100) })}` : ''}` : ''} />
        <BottomCell k={t('审批模式')} v={ov?.workflow?.auto_approve ? t('自动执行') : t('人工确认')} sub={t('楼层只读')} color={ov?.workflow?.auto_approve ? 'var(--of-warn)' : undefined} />
        <BottomCell k={t('风控')} v={riskQ.data ? RISK_LEVEL_LABEL[riskQ.data.level] : '—'} sub={riskQ.data ? `${t('{n} 条告警', { n: riskQ.data.alerts.length })}${riskQ.data.blocks_new_risk ? ` · ${t('停止新增风险')}` : ''} · ${t('敞口 {v}', { v: fx(portfolioQ.data?.snapshot?.positions.gross_ratio, 2, '×') })}` : undefined} color={riskQ.data ? RISK_LEVEL_COLOR[riskQ.data.level] : undefined} />
        <BottomCell k={t('今日亏损')} v={(() => { const v = Number((ov as { daily_loss_pct?: string } | undefined)?.daily_loss_pct ?? 0); return v <= -100 ? t('口径异常') : `${v.toFixed(2)}%`; })()} sub={Number((ov as { daily_loss_pct?: string } | undefined)?.daily_loss_pct ?? 0) <= -100 ? t('日起始权益还是上个通道的,网关待修') : t('上限 {n}%', { n: ov?.workflow?.daily_loss_stop_pct ?? '—' })} />
      </footer>
    </div>
  );
}

function TopCell({ k, v, sub, color }: { k: string; v: string; sub?: string; color?: string }) {
  return (
    <div className="flex min-w-[120px] flex-col justify-center px-3 py-1 xl:min-w-[150px] xl:px-4">
      <span className="of-kicker">{k}</span>
      <span className="of-title text-sm" style={{ color }}>
        {v}
      </span>
      {sub ? <span className="text-[9px] text-[var(--of-ink-dim)]">{sub}</span> : null}
    </div>
  );
}

function BottomCell({ k, v, sub, color }: { k: string; v: string; sub?: string; color?: string }) {
  return (
    <div className="flex items-baseline gap-2 px-3 py-1.5">
      <span className="of-kicker">{k}</span>
      <span className="text-[10px] font-bold" style={{ color }}>
        {v}
      </span>
      {sub ? <span className="text-[9px] text-[var(--of-ink-faint)]">{sub}</span> : null}
    </div>
  );
}
