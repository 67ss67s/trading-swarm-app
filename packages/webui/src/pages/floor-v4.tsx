/**
 * 楼层 v4(#floor-v4):像素场景为主角(docs/design/floor-v4-2026-09-25.md)。
 * 两种布局可切换:A 开放办公室 / B 大楼剖面;各带 3 套主题(夜间研究所 / 指挥中心 / Meme Lab)。
 * 画布 + 窄右栏 3 块(需要你处理 / 钱 / 团队动态)+ 顶栏(品牌、3 个关键数、布局、主题、紧急停止)。
 *
 * 数据全部复用现有 query key(App.tsx 顶部约定),SSE 由 App.tsx 统一失效;本页只订阅 connected 状态之外不再开连接。
 * 真实数据 → 引擎快照的映射在 components/floor-v4/snapshot.ts(纯函数,有测试)。
 * 不新增后端接口:审批走 /api/intents/:id/confirm-token + approve/reject,紧急停止走 /api/halt,
 * 派活见 components/floor-v4/tasks.ts,运行策略复用我的策略的 RunDialog。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, researchApi } from '@/api/client';
import type { ActivityResponse, BotsResponse, PortfolioSnapshotResponse, RiskAlertsResponse, Workflow } from '@/api/types';
import { evolutionApi, useEvolutionDaily } from '@/api/evolution';
import { useAgentStrategy } from '@/api/agent-strategy';
import { CurrentStrategyChip, RUN_TEXT } from '@/components/agent-strategy/current-strategy';
import { useModels } from '@/components/models/use-models';
import { CoinPickerDialog, addCoin, effectiveCoins, loadCoins, moveCoin, removeCoin, saveCoins, COINS_MAX } from '@/components/floor-v4/coins';
import { createSfx, loadSoundOn, saveSoundOn } from '@/components/floor-v4/sound';
import { RunDialog, activeRunIds, useStrategyRuns } from '@/components/my-strategies/run-panel';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { mountA, mountB, type EngineCallbacks, type EvoDetail, type FloorEngine, type Layout, type UiTheme } from '@/components/floor-v4/adapters';
import { EStop, HandoffCard, IntentCard, PixelLogo } from '@/components/floor-v4/cards';
import { ROLES, ROLE_ORDER } from '@/components/floor-v4/engine-b/roles';
import { THEMES, THEME_ORDER, isThemeId } from '@/components/floor-v4/engine-b/themes';
import { buildFloorModel, type FeedRow, type FloorModel, type FloorTask, type Role } from '@/components/floor-v4/snapshot';
import { coinTask, parseCommand, realTasks, type RealTask, type TaskContext } from '@/components/floor-v4/tasks';
import '@/components/floor-v4/floor-v4.css';
import { fmtPrice, relativeTime, useNow } from '@/lib/format';
import { t, useLang } from '@/lib/i18n';

const LAYOUT_KEY = 'tg.floor.v4.layout';
const THEME_KEY = 'tg.floor.v4.theme';

function load<T>(key: string, ok: (v: unknown) => v is T, dflt: T): T {
  try {
    const v = window.localStorage.getItem(key);
    if (ok(v)) return v;
  } catch {
    /* 私密模式 */
  }
  return dflt;
}
function save(key: string, v: string): void {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}
const isLayout = (v: unknown): v is Layout => v === 'a' || v === 'b';

const fmt2 = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : s;
};

type Card = { kind: 'intent'; id: string } | { kind: 'handoff'; id: string } | null;

export function FloorV4Page({ connected = true }: { connected?: boolean }) {
  useLang();
  const qc = useQueryClient();
  const now = useNow(5000);
  const [layout, setLayoutState] = useState<Layout>(() => load(LAYOUT_KEY, isLayout, 'b'));
  const [theme, setThemeState] = useState<UiTheme>(() => load(THEME_KEY, isThemeId, 'study'));
  const [tasks, setTasks] = useState<Partial<Record<Role, FloorTask>>>({});
  const [card, setCard] = useState<Card>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // 紧急停止:按住 2 秒只是打开确认框,和顶栏按钮同一个确认(输入 HALT)后才真的调 /api/halt
  const [haltOpen, setHaltOpen] = useState(false);
  const [haltBusy, setHaltBusy] = useState(false);

  // ---- 真实数据(query key 与旧楼层 / App.tsx 约定一致)----
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 20_000 });
  const activityQ = useQuery<ActivityResponse>({ queryKey: ['activity'], queryFn: () => api.activity(200) });
  const botsQ = useQuery<BotsResponse>({ queryKey: ['bots'], queryFn: api.bots, refetchInterval: 30_000, retry: false });
  const executionQ = useQuery({ queryKey: ['execution'], queryFn: api.execution, refetchInterval: 30_000 });
  const riskQ = useQuery<RiskAlertsResponse>({ queryKey: ['risk', 'alerts', 'open'], queryFn: () => api.riskAlerts('open'), refetchInterval: 60_000, retry: false });
  const portfolioQ = useQuery<PortfolioSnapshotResponse>({ queryKey: ['portfolio', 'snapshot'], queryFn: api.portfolioSnapshot, refetchInterval: 60_000, retry: false });
  const historyQ = useQuery({ queryKey: ['history'], queryFn: () => api.history(200) });
  const intentsQ = useQuery({ queryKey: ['intents'], queryFn: () => api.intents(50), refetchInterval: 60_000, retry: false });
  const workflowQ = useQuery<Workflow>({ queryKey: ['workflow'], queryFn: api.workflow });
  const strategiesQ = useQuery({ queryKey: ['research', 'my-strategies', 'all', 'updated', ''], queryFn: () => researchApi.myStrategies({ filter: 'all', sort: 'updated' }), refetchInterval: 120_000, retry: false });
  const runsQ = useStrategyRuns();
  const btcQ = useQuery({ queryKey: ['floor-v4', 'btc-1h'], queryFn: () => api.klines('1m', 60, 'BTCUSDT'), refetchInterval: 60_000, retry: false });
  const evoQ = useEvolutionDaily();
  const episodesQ = useQuery({ queryKey: ['episodes'], queryFn: () => api.episodes({ limit: 100 }), refetchInterval: 60_000, retry: false });
  const agentStrategyQ = useAgentStrategy();
  const modelsQ = useModels();

  const runningIds = useMemo(() => activeRunIds(runsQ.data?.runs), [runsQ.data]);
  const model: FloorModel = useMemo(
    () =>
      buildFloorModel({
        now,
        bots: botsQ.data ?? null,
        activity: activityQ.data?.activity ?? [],
        overview: overviewQ.data ?? null,
        execution: executionQ.data ?? null,
        portfolio: portfolioQ.data ?? null,
        risk: riskQ.data ?? null,
        evolution: evoQ.data ?? null,
        intents: intentsQ.data ?? [],
        strategies: strategiesQ.data?.strategies ?? [],
        runningStrategyIds: runningIds,
        history: historyQ.data ?? null,
        btcKlines: btcQ.data?.klines ?? null,
        tasks,
        episodes: episodesQ.data ?? null,
        agentStrategy: agentStrategyQ.data ?? null,
        models: modelsQ.data ?? null,
      }),
    [now, botsQ.data, activityQ.data, overviewQ.data, executionQ.data, portfolioQ.data, riskQ.data, evoQ.data, intentsQ.data, strategiesQ.data, runningIds, historyQ.data, btcQ.data, tasks, episodesQ.data, agentStrategyQ.data, modelsQ.data],
  );
  // 引擎第一次 setData 会把已有交接记成「看过」;等名册和活动流(信封的两个来源)都回来再喂,否则后到的旧交接会全飞一遍信封。
  // overview 可能很慢(账户读取走执行通道),不等它。
  const ready = !botsQ.isPending && !activityQ.isPending;

  const taskCtx: TaskContext = useMemo(
    () => ({
      model,
      watchlist: workflowQ.data?.watchlist ?? overviewQ.data?.workflow?.watchlist ?? [],
      candidates: (overviewQ.data?.market_state?.candidates ?? []).map((c) => c.symbol),
      threadSymbols: (overviewQ.data?.threads ?? []).map((x) => x.symbol),
    }),
    [model, workflowQ.data, overviewQ.data],
  );

  // ---- 引擎 ----
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<FloorEngine | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const nowRef = useRef(now);
  nowRef.current = now;

  // ---- 8-bit 音效(默认关,开关存 localStorage)----
  const [soundOn, setSoundOn] = useState(loadSoundOn);
  const sfxRef = useRef<ReturnType<typeof createSfx> | null>(null);
  if (!sfxRef.current) sfxRef.current = createSfx(soundOn);
  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    saveSoundOn(next);
    sfxRef.current?.setOn(next);
    if (next) sfxRef.current?.play('evolve');
  };

  const flash = useCallback((text: string, sub?: string) => (sub ? toast(text, { description: sub }) : toast(text)), []);

  const runTask = useCallback(
    async (role: Role, task: RealTask) => {
      const eng = engineRef.current;
      if (task.kind === 'goto') {
        if (task.hash) window.location.hash = task.hash;
        return;
      }
      eng?.catchDrop(role, t('收到:{l}', { l: task.label }));
      setTasks((p) => ({ ...p, [role]: { id: task.id, label: task.label } }));
      const t0 = Date.now();
      try {
        switch (task.kind) {
          case 'watch': {
            const sym = task.symbol!;
            const wf = await qc.fetchQuery({ queryKey: ['workflow'], queryFn: api.workflow, staleTime: 2_000 });
            if (wf.watchlist.includes(sym)) {
              toast(t('{s} 已经在观察列表里了', { s: sym }));
              break;
            }
            const res = await api.patchWorkflow({ watchlist: [...wf.watchlist, sym] });
            qc.setQueryData(['workflow'], res.workflow);
            if (res.errors?.length) throw new Error(res.errors.join('; '));
            void qc.invalidateQueries({ queryKey: ['overview'] });
            toast.success(t('RADAR 把 {s} 加进了观察列表', { s: sym }));
            break;
          }
          case 'info_run':
            await api.infoRunNow();
            toast.success(t('RADAR 开始梳理一轮市场,结果会进团队动态'));
            break;
          case 'judge': {
            const r = await api.scanNow(task.symbol);
            toast.success(task.symbol ? t('THREAD 开始判断 {s}', { s: task.symbol }) : t('THREAD 开始把观察列表判断一轮'), { description: t('排了 {n} 个判断', { n: r.job_ids.length }) });
            break;
          }
          case 'backtest': {
            const st = modelRef.current.strategyObj;
            if (!st) throw new Error(t('还没有可回测的策略'));
            const r = await researchApi.backtestMyStrategy(st.id, task.symbol ? { symbols: [task.symbol] } : {});
            void qc.invalidateQueries({ queryKey: ['research'] });
            toast.success(t('「{n}」回测完成', { n: st.name }), { action: { label: t('看报告'), onClick: () => (window.location.hash = `backtest?id=${encodeURIComponent(r.report_id)}`) } });
            break;
          }
          case 'brief': {
            const r = await qc.fetchQuery({ queryKey: ['captain', 'brief'], queryFn: api.captainBrief, staleTime: 30_000 });
            toast(r.brief?.headline ?? t('今天还没有值班简报'), r.brief ? { description: t('待阅交接 {h} · 风控 {r} · 今日花费 ¥{c}', { h: r.brief.pending_handoffs.count, r: r.brief.risk.level, c: r.brief.total_cost_cny.toFixed(2) }) } : undefined);
            break;
          }
          case 'exposure': {
            const r = await qc.fetchQuery({ queryKey: ['portfolio', 'snapshot'], queryFn: api.portfolioSnapshot, staleTime: 10_000 });
            const s = r.snapshot;
            toast(s ? t('总敞口 {g} · 净 {n} USDT · 未保护 {u} USDT', { g: s.positions.gross_ratio != null ? `${s.positions.gross_ratio.toFixed(2)}×` : '—', n: s.positions.net.toFixed(0), u: s.unprotected_notional.toFixed(0) }) : t('组合快照还没生成'));
            break;
          }
          case 'risk': {
            await qc.invalidateQueries({ queryKey: ['risk'] });
            const r = await qc.fetchQuery({ queryKey: ['risk', 'alerts', 'open'], queryFn: () => api.riskAlerts('open') });
            toast(t('风控等级 {l} · {n} 条开着的告警', { l: r.level, n: r.alerts.length }), r.alerts[0] ? { description: r.alerts[0].title } : undefined);
            break;
          }
        }
      } catch (e) {
        toast.error(t('{c} 没办成:{l}', { c: ROLES[role].callsign, l: task.label }), { description: e instanceof Error ? e.message : String(e) });
      } finally {
        // 至少留 1.5 秒让「干活」动画播完再收
        window.setTimeout(() => setTasks((p) => {
          if (p[role]?.id !== task.id) return p;
          const next = { ...p };
          delete next[role];
          return next;
        }), Math.max(0, 1500 - (Date.now() - t0)));
      }
    },
    [qc],
  );

  const chat = useCallback(async (role: Role) => {
    // 同旧楼层「和它对话」:新建一个对着该角色的会话,记为当前会话,跳 Agent 页
    try {
      const r = await api.createChatSession(undefined, role);
      try {
        window.localStorage.setItem('tg.chat.session', r.session.id);
      } catch {
        /* ignore */
      }
      window.location.hash = 'agent';
    } catch (e) {
      toast.error(t('开不了会话:{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const openMailbox = useCallback(() => {
    const m = modelRef.current;
    const it = m.pendingIntents[0];
    if (it) return setCard({ kind: 'intent', id: it.id });
    const h = m.pendingHandoffs[0];
    if (h) return setCard({ kind: 'handoff', id: h.handoff_id });
    toast(t('信箱是空的,没有待批订单'));
  }, []);

  const cbRef = useRef<EngineCallbacks | null>(null);
  cbRef.current = {
    onChat: (r) => void chat(r),
    onTask: (r, task) => void runTask(r, task),
    onWorkbench: (r) => (window.location.hash = ROLES[r].page),
    tasksFor: (r) => realTasks(r, taskCtx),
    todayOf: (r) => modelRef.current.agents.find((a) => a.role === r)?.today ?? t('今天还没有可说的事。'),
    onMailbox: openMailbox,
    onToast: (text, sub) => flash(text, sub),
    getEvoDetail: async (role, date): Promise<EvoDetail | null> => {
      try {
        const d = await qc.fetchQuery({ queryKey: ['evolution', 'day', role, date], queryFn: () => evolutionApi.day(role, date) });
        return {
          role,
          date,
          metrics: d.metrics.slice(0, 3).map((x) => ({ label: x.label, value: x.value == null ? '—' : `${x.value}${x.unit ?? ''}` })),
          records: [...d.events, ...d.records].sort((a, b) => b.at - a.at).slice(0, 4).map((x) => ({ at: x.at, title: x.title, ref: x.ref })),
        };
      } catch {
        return null;
      }
    },
    onOpenEvolution: (role, date) => (window.location.hash = `evolution?role=${role}&date=${date}`),
    onSfx: (k) => sfxRef.current?.play(k),
  };

  useEffect(() => {
    const cv = canvasRef.current;
    const host = sceneRef.current;
    if (!cv || !host) return;
    const cb: EngineCallbacks = {
      onChat: (r) => cbRef.current?.onChat(r),
      onTask: (r, x) => cbRef.current?.onTask(r, x),
      onWorkbench: (r) => cbRef.current?.onWorkbench(r),
      tasksFor: (r) => cbRef.current?.tasksFor(r) ?? [],
      todayOf: (r) => cbRef.current?.todayOf(r) ?? '',
      onMailbox: () => cbRef.current?.onMailbox(),
      onToast: (a, b) => cbRef.current?.onToast(a, b),
      getEvoDetail: (r, d) => cbRef.current?.getEvoDetail(r, d) ?? Promise.resolve(null),
      onOpenEvolution: (r, d) => cbRef.current?.onOpenEvolution(r, d),
      onSfx: (k) => cbRef.current?.onSfx?.(k),
    };
    const eng = layout === 'b' ? mountB(cv, theme, cb) : mountA(cv, theme, cb, host);
    engineRef.current = eng;
    if (readyRef.current) eng.setData(modelRef.current, nowRef.current);
    // 深链 #floor?sel=risk_sentinel(Agent 页异常块「去楼层处理」)→ 镜头推到那个角色
    const sel = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('sel');
    const selTimer = sel && (ROLE_ORDER as readonly string[]).includes(sel) ? window.setTimeout(() => eng.focus(sel as Role), 400) : 0;
    // 开发态调试钩子(截图脚本用);生产包里没有
    if (import.meta.env.DEV) (window as unknown as { __floorV4?: unknown }).__floorV4 = { engine: eng, qc, openCard: setCard, openHalt: () => setHaltOpen(true), model: () => modelRef.current };
    return () => {
      window.clearTimeout(selTimer);
      eng.destroy();
      host.querySelectorAll('.flb-overlay').forEach((el) => el.remove());
      engineRef.current = null;
    };
    // theme 走下面单独的 effect,换主题不重建引擎
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  useEffect(() => {
    if (ready) engineRef.current?.setData(model, now);
  }, [model, ready, now, layout]);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  const setTheme = (id: UiTheme) => {
    setThemeState(id);
    save(THEME_KEY, id);
  };
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    save(LAYOUT_KEY, l);
  };

  // ---- 紧急停止:掀罩 + 按住 2 秒 → 打开与顶栏按钮同一个确认框(输入 HALT)→ 确认后才调 POST /api/halt ----
  const confirmHalt = async () => {
    setHaltBusy(true);
    try {
      await api.halt();
      engineRef.current?.emergency();
      toast.success(t('紧急停止已触发:撤挂单、平持仓、停掉后续开仓判断'), { description: t('解除在顶栏右上角「解除紧急停止」') });
      await qc.invalidateQueries({ queryKey: ['overview'] });
      setHaltOpen(false);
    } catch (e) {
      toast.error(t('紧急停止没成功'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setHaltBusy(false);
    }
  };

  // ---- 拖拽:币 → RADAR/THREAD/LAB;策略卡 → EXEC ----
  const drag = (e: React.PointerEvent, html: string, accept: (r: Role) => boolean, drop: (r: Role | null, ev: PointerEvent) => void) => {
    e.preventDefault();
    const ghost = document.createElement('div');
    ghost.className = 'fv4-ghost';
    ghost.innerHTML = html;
    document.body.appendChild(ghost);
    let target: Role | null = null;
    const move = (ev: PointerEvent) => {
      ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 8}px) rotate(-4deg)`;
      const r = engineRef.current?.pick(ev.clientX, ev.clientY) ?? null;
      const ok = r && accept(r) ? r : null;
      if (ok !== target) {
        target = ok;
        engineRef.current?.setDropTarget(ok);
      }
      ghost.classList.toggle('ok', !!ok);
      ghost.classList.toggle('no', !!r && !ok);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.remove();
      engineRef.current?.setDropTarget(null);
      drop(target, ev);
    };
    move(e.nativeEvent);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  // ---- 顶栏币种芯片:用户自定义(存 localStorage),首次 = 观察列表前 5 个 ----
  const watchlist = workflowQ.data?.watchlist ?? overviewQ.data?.workflow?.watchlist ?? [];
  const [storedCoins, setStoredCoins] = useState<string[] | null>(loadCoins);
  const coinList = useMemo(() => effectiveCoins(storedCoins, watchlist), [storedCoins, watchlist]);
  const setCoinList = (next: string[]) => {
    setStoredCoins(next);
    saveCoins(next);
  };
  const [pickerOpen, setPickerOpen] = useState(false);
  const markets = overviewQ.data?.markets ?? {};
  // 不在观察列表里的币,overview 没有价格:各拉 1 根 1m K 线取收盘价
  const extraPx = useQueries({
    queries: coinList.filter((sym) => !markets[sym]?.last).map((sym) => ({ queryKey: ['floor-v4', 'coin-px', sym], queryFn: () => api.klines('1m', 1, sym), refetchInterval: 60_000, retry: false, staleTime: 30_000 })),
  });
  const extraMap = new Map(coinList.filter((sym) => !markets[sym]?.last).map((sym, i) => [sym, extraPx[i]?.data?.klines?.at(-1)?.close ?? null] as const));
  const coins = coinList.map((sym) => ({ sym, last: markets[sym]?.last ?? extraMap.get(sym) ?? null }));

  const onCoinDown = (e: React.PointerEvent, sym: string) => {
    if ((e.target as HTMLElement).closest('.x')) return;
    drag(e, `<b>${esc(sym)}</b><small>${esc(t('拖给 RADAR / THREAD / LAB · 拖到别的币上排序'))}</small>`, (r) => !!coinTask(r, sym, taskCtx), (r, ev) => {
      const chip = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('.coin[data-sym]');
      const over = chip?.dataset.sym;
      if (over && over !== sym) return setCoinList(moveCoin(coinList, sym, over));
      if (over === sym) return;
      if (!r) return void toast(t('把 {s} 拖到 RADAR(观察)/ THREAD(判断)/ LAB(回测)', { s: sym }));
      const task = coinTask(r, sym, taskCtx);
      if (task) void runTask(r, task);
    });
  };

  const st = model.strategyObj;
  const cur = model.current;
  const onStratDown = (e: React.PointerEvent) => {
    if (!st) return;
    drag(e, `<b>▶ ${esc(st.name)}</b><small>${esc(t('拖给 EXEC 运行'))}</small>`, (r) => r === 'executor', (r) => {
      if (r === 'executor') {
        engineRef.current?.catchDrop('executor', t('策略收到,等你确认参数'));
        setRunOpen(true);
      } else toast(t('把策略卡拖到 EXEC 的交易台上'));
    });
  };

  // ---- 键盘:1–9 切人 · T 主题 · L 布局 · 空格 暂停 · ~ 命令行 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (e.key === '`' || e.key === '~') {
        e.preventDefault();
        setConsoleOpen((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[1-9]$/.test(e.key)) {
        const r = ROLE_ORDER[Number(e.key) - 1];
        if (r) engineRef.current?.focus(r);
      } else if (e.key === 't' || e.key === 'T') {
        setThemeState((cur) => {
          const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length]!;
          save(THEME_KEY, next);
          return next;
        });
      } else if (e.key === 'l' || e.key === 'L') {
        setLayoutState((cur) => {
          const next = cur === 'a' ? 'b' : 'a';
          save(LAYOUT_KEY, next);
          return next;
        });
      } else if (e.key === ' ') {
        e.preventDefault();
        const p = engineRef.current?.togglePause();
        toast(p ? t('动画已暂停(空格继续)') : t('动画继续'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ui = THEMES[theme].ui;
  const pnl = Number(model.money.pnl_today);
  const onDuty = model.agents.filter((a) => a.status !== 'idle').length;
  const cardIntent = card?.kind === 'intent' ? model.pendingIntents.find((x) => x.id === card.id) ?? null : null;
  const cardHandoff = card?.kind === 'handoff' ? model.pendingHandoffs.find((x) => x.handoff_id === card.id) ?? null : null;
  const openItem = (kind: 'approval' | 'handoff', id: string) => setCard(kind === 'approval' ? { kind: 'intent', id } : { kind: 'handoff', id });

  return (
    <div className="fv4" style={ui as React.CSSProperties} data-layout={layout} data-theme-id={theme}>
      <header className="top">
        <div className="brand">
          <PixelLogo color={ui['--accent'] ?? '#ffb454'} />
          <div>
            <b>Trading Swarm</b>
            <small>{layout === 'b' ? t('值班楼层 · 大楼剖面') : t('值班楼层 · 开放办公室')}</small>
          </div>
        </div>
        <div className="kpis">
          <div className="kpi">
            <span className="k">{t('权益 USDT')}</span>
            <span className="v">{fmt2(model.money.equity)}</span>
          </div>
          <div className="kpi">
            <span className="k">{t('今日盈亏')}</span>
            <span className={`v ${pnl >= 0 ? 'up' : 'down'}`}>
              {pnl >= 0 ? '+' : ''}
              {fmt2(model.money.pnl_today)}
            </span>
          </div>
          <div className="kpi">
            <span className="k">{t('在岗')}</span>
            <span className="v">
              {onDuty}/{model.agents.length}
            </span>
          </div>
        </div>
        <div className="coins" title={t('把币拖给 RADAR / THREAD / LAB;拖到别的币上排序')}>
          {coins.map((c) => (
            <div key={c.sym} className="coin" data-sym={c.sym} onPointerDown={(e) => onCoinDown(e, c.sym)}>
              <b>{c.sym.replace(/USDT$/, '')}</b>
              <span>{c.last ? fmtPrice(c.last) : '—'}</span>
              <button type="button" className="x" title={t('从顶栏移除')} aria-label={t('从顶栏移除 {s}', { s: c.sym })} onPointerDown={(e) => e.stopPropagation()} onClick={() => setCoinList(removeCoin(coinList, c.sym))}>
                ×
              </button>
            </div>
          ))}
        </div>
        {coins.length < COINS_MAX ? (
          <button type="button" className="coin add" title={t('加一个币(最多 {n} 个)', { n: COINS_MAX })} aria-label={t('加一个币')} onClick={() => setPickerOpen(true)}>
            +
          </button>
        ) : null}
        <CoinPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          current={coinList}
          watchlist={watchlist}
          threadSymbols={taskCtx.threadSymbols}
          onPick={(sym) => {
            setCoinList(addCoin(coinList, sym));
            setPickerOpen(false);
          }}
        />
        <CurrentStrategyChip className="fv4-chip" />
        <div className="spacer" />
        <div className="seg" role="group" aria-label={t('布局')}>
          {(['a', 'b'] as Layout[]).map((l) => (
            <button key={l} type="button" className={l === layout ? 'on' : ''} onClick={() => setLayout(l)} title={l === 'a' ? t('开放办公室') : t('大楼剖面')}>
              {l === 'a' ? t('A 办公室') : t('B 大楼')}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label={t('主题')}>
          {THEME_ORDER.map((id) => (
            <button key={id} type="button" className={id === theme ? 'on' : ''} onClick={() => setTheme(id)}>
              {t(THEMES[id].name)}
            </button>
          ))}
        </div>
        <button type="button" className={`sfx ${soundOn ? 'on' : ''}`} onClick={toggleSound} title={soundOn ? t('音效:开(点一下关)') : t('音效:关(点一下开)')} aria-pressed={soundOn}>
          {soundOn ? '♪' : '♪̸'} <span>{soundOn ? t('音效开') : t('音效关')}</span>
        </button>
        <EStop halted={model.halted} onFire={() => setHaltOpen(true)} />
      </header>

      <main className="stage">
        <div ref={sceneRef} key={layout} className={`scene ${layout}`}>
          <canvas ref={canvasRef} />
          {layout === 'b' ? (
            <div className="keys">
              {t('1–9 切人 · T 主题 · L 布局 · 空格 暂停')} · <b>~</b> {t('命令行')}
            </div>
          ) : null}
          {!connected ? <div className="keys" style={{ top: 34, color: '#ff8a9a' }}>{t('实时连接断了,数据可能是旧的')}</div> : null}
          {cardIntent ? (
            <IntentCard
              it={cardIntent}
              onClose={() => setCard(null)}
              onDone={(ok) => {
                engineRef.current?.approval(ok);
                setCard(null);
              }}
            />
          ) : null}
          {cardHandoff ? <HandoffCard h={cardHandoff} onClose={() => setCard(null)} /> : null}
          {consoleOpen ? <PixelConsole ctx={taskCtx} onClose={() => setConsoleOpen(false)} onRun={(r, task) => void runTask(r, task)} onFocus={(r) => engineRef.current?.focus(r)} onTheme={setTheme} /> : null}
        </div>

        <aside className="rail">
          {model.inbox.count > 0 ? (
            <section className="blk inbox">
              <h3>
                <span className="dot" />
                {t('需要你处理')} <span className="n">{model.inbox.count}</span>
              </h3>
              {model.inbox.items.slice(0, 4).map((it) => (
                <button key={it.id} type="button" className="item" onClick={() => openItem(it.kind, it.id)}>
                  <span className="kd">{it.kind === 'approval' ? t('待批') : t('交接')}</span>
                  {it.title}
                  {it.detail ? <small>{it.detail}</small> : null}
                </button>
              ))}
            </section>
          ) : null}
          <section className="blk">
            <h3>{t('钱')}</h3>
            <div className="money">
              <div className="cell">
                <div className="v">{fmt2(model.money.equity)}</div>
                <div className="k">{t('权益')}</div>
              </div>
              <div className="cell">
                <div className={`v ${pnl >= 0 ? 'up' : 'down'}`}>
                  {pnl >= 0 ? '+' : ''}
                  {fmt2(model.money.pnl_today)}
                </div>
                <div className="k">{t('今日盈亏')}</div>
              </div>
              <div className="cell">
                <div className="v">{model.money.positions}</div>
                <div className="k">{t('持仓')}</div>
              </div>
            </div>
            {cur ? (
              <div className={`strat ${st ? '' : 'static'}`} onPointerDown={st ? onStratDown : undefined} title={st ? t('拖到 EXEC 工位运行') : t('顶栏「当前策略」可切换')}>
                <span className="grip">{st ? '⠿' : '◇'}</span>
                <div>
                  <b>
                    {t('当前策略')} · {cur.name}
                  </b>
                  <small>
                    {cur.kind === 'free'
                      ? t('agent 按 playbook 自由判断')
                      : [cur.symbol, cur.version != null ? `v${cur.version}` : null, cur.run ? RUN_TEXT[cur.run] ?? cur.run : t('没在运行'), st ? t('拖到 EXEC 运行') : null].filter(Boolean).join(' · ')}
                  </small>
                </div>
              </div>
            ) : null}
          </section>
          <section className="blk feedblk">
            <h3>
              {t('团队动态')} <span className="n">{model.feed.length}</span>
            </h3>
            <Feed rows={model.feed} now={now} />
          </section>
        </aside>
      </main>
      <ConfirmDialog
        open={haltOpen}
        title={t('紧急停止')}
        summary={t('确认紧急停止')}
        danger
        requireText="HALT"
        busy={haltBusy}
        onCancel={() => setHaltOpen(false)}
        onConfirm={() => void confirmHalt()}
      >
        <p>{t('这会立刻撤掉全部挂单、市价平掉全部持仓,并停掉后面所有开仓判断,直到你手动恢复。不可逆,想清楚再确认。')}</p>
      </ConfirmDialog>
      {runOpen && st ? <RunDialog strategy={st} version={st.current_version || null} onClose={() => setRunOpen(false)} /> : null}
    </div>
  );
}

function Who({ r }: { r: Role | 'user' }) {
  if (r === 'user') return <span className="cs" style={{ color: 'var(--accent)' }}>{t('你')}</span>;
  return <span className="cs" style={{ color: ROLES[r].color }}>{ROLES[r].callsign}</span>;
}

function Feed({ rows, now }: { rows: FeedRow[]; now: number }) {
  const shown = useRef(new Set<string>());
  const top = rows.slice(0, 40);
  useEffect(() => {
    top.forEach((r) => shown.current.add(r.key));
  });
  if (!top.length) return <div className="feed empty">{t('还没有动态。agent 交接、判断、成交都会出现在这里。')}</div>;
  return (
    <ul className="feed">
      {top.map((r) => (
        <li key={r.key} className={shown.current.has(r.key) ? '' : 'new'}>
          <Who r={r.from} /> {r.text}
          {r.to && r.to !== r.from ? (
            <>
              {' '}
              → <Who r={r.to} />
            </>
          ) : null}
          <div className="meta">
            <span>{relativeTime(r.at, now)}</span>
            <span className={`tag ${r.tone === 'plain' ? '' : r.tone}`}>{r.source === 'handoff' ? (r.status === 'pending' ? t('交接 · 待阅') : t('交接')) : t('事件')}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PixelConsole({ ctx, onClose, onRun, onFocus, onTheme }: { ctx: TaskContext; onClose: () => void; onRun: (r: Role, task: RealTask) => void; onFocus: (r: Role) => void; onTheme: (id: UiTheme) => void }) {
  const [log, setLog] = useState<{ text: string; cls: string }[]>([{ text: t('像素命令行 · 输入 help 看可用指令'), cls: 'dim' }]);
  const say = (text: string, cls = '') => setLog((l) => [...l, { text, cls }].slice(-7));
  const run = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    say(`> ${s}`);
    if (/^(help|帮助|\?)$/i.test(s)) return say(t('让 radar 盯 SOL · 判断 BTC · 回测 ETH · 查风险 · 看持仓 · 去 lab · 主题 指挥'), 'dim');
    if (/^主题|^theme/i.test(s)) {
      const id: UiTheme = /指挥|command/i.test(s) ? 'command' : /meme|霓虹/i.test(s) ? 'meme' : 'study';
      onTheme(id);
      return say(t('主题 → {n}', { n: t(THEMES[id].name) }), 'ok');
    }
    const go = s.match(/^(去|看看?|go)\s*([a-z_一-龥]+)/i);
    if (go) {
      const k = go[2]!.toLowerCase();
      const r = ROLE_ORDER.find((x) => ROLES[x].callsign.toLowerCase() === k || x === k);
      if (r) {
        onFocus(r);
        return say(t('镜头 → {c}', { c: ROLES[r].callsign }), 'ok');
      }
    }
    const cmd = parseCommand(s, ctx);
    if (!cmd) return say(t('没听懂。试试 help'), 'err');
    onRun(cmd.role, cmd.task);
    say(`→ ${ROLES[cmd.role].callsign}:${cmd.task.label}(${cmd.task.real})`, 'ok');
  };
  return (
    <div className="console">
      <div className="log">
        {log.map((l, i) => (
          <div key={i} className={l.cls}>
            {l.text}
          </div>
        ))}
      </div>
      <div className="in">
        <span>&gt;</span>
        <input
          autoFocus
          spellCheck={false}
          placeholder={t('让 radar 盯 SOL / 判断 BTC / 回测 ETH / help')}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              run(e.currentTarget.value);
              e.currentTarget.value = '';
            } else if (e.key === 'Escape' || e.key === '`' || e.key === '~') {
              e.preventDefault();
              onClose();
            }
          }}
        />
      </div>
    </div>
  );
}

