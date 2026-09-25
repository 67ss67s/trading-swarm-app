/**
 * 应用外壳:侧栏 + 顶栏 + hash 路由 + 底部状态栏 + 命令面板 + 紧急停止确认弹窗。
 * 仿 8793 frontend-design/src/App.tsx,砍掉 dry_run/live 模式、readonly 角色、更新检查、
 * 首次向导、账户切换——本项目只有 paper/demo 两个后端,由网关自己决定,前端不切换。
 *
 * ── react-query key 约定(所有页面必须遵守,这样 App.tsx 这一个 SSE 连接才能把大家的
 *    缓存都失效对) ──
 *   ['overview']                 GET /api/overview(loop/strategy/account/market/
 *                                 recent_episodes/workflow/market_state/threads/markets/queue)
 *   ['episodes']                 GET /api/episodes(时间线列表)
 *   ['episode', id]              GET /api/episodes/:id(详情,懒加载)
 *   ['threads', status]          GET /api/threads?status=  status ∈ 'open' | 'all'
 *   ['thread', id]               GET /api/threads/:id
 *   ['logs']                     GET /api/logs
 *   ['workflow']                 GET /api/workflow
 *   ['market-state']             GET /api/market-state
 *   ['market-state-history']     GET /api/market-state/history
 *   ['chat-messages']            GET /api/chat/messages
 *   ['positions']                GET /api/positions
 *   ['open-orders']              GET /api/orders/open
 *   ['symbols']                  GET /api/symbols
 *   ['info-events']              GET /api/info/events
 *   ---- v3(docs/demo/v3-ui-contract.md)----
 *   ['chat-messages', kind]      GET /api/chat/messages?kind=  kind ∈ 'chat' | 'narration' | 'all'
 *                                (invalidate 用前缀 ['chat-messages'] 一次全失效)
 *   ['history']                  GET /api/history(复盘页;thread.changed 时失效)
 *   ['activity']                 GET /api/activity(活动流;SSE `activity` 直接 prepend)
 *   ['regime', symbol]           GET /api/market/regime?symbol=
 *   ---- v3.2(docs/demo/memory.md):长期记忆 ----
 *   ['memory', ...]              记忆页(pages/memory.tsx)所有子查询的前缀,比如
 *                                ['memory','list',symbol] / ['memory','search',q,symbol] /
 *                                ['memory','detail',id];SSE `memory.changed` 按这个前缀一次全失效
 *   ---- v3.3:执行后端(操作台)----
 *   ['execution']                GET /api/execution(执行后端 + agent_mcp 连接状态;
 *                                SSE `execution.changed` 失效它。refetchInterval 30s)
 *   ['brains']                   GET /api/brains(大脑选项,staleTime 5 分钟)
 *   ---- v3.4(docs/demo/v3-ui-contract.md §9.8):回放与盲测 ----
 *   ['backtest']                 GET /api/backtest(回测列表 + running)
 *   ['backtest', id]             GET /api/backtest/:id(run + steps + trades)
 *   ['klines-history', symbol, interval, from, to]
 *                                GET /api/market/klines/history(回放图的历史 K 线,磁盘缓存)
 *   ---- v3.5(docs/design/strategy-library-2026-09-05.md):策略库 ----
 *   ['strategies']               GET /api/strategies(策略库列表 + active + 文案表;
 *                                SSE `strategy.changed` 按这个前缀失效,连详情一起带上)
 *   ['strategies', id]           GET /api/strategies/:id(spec + 版本列表 + 该策略的归因点)
 *   ---- v3.6(网关 src/demo/screener.ts + bots.ts):雷达 / 筛选器 + 机器人团队 ----
 *   ['screener', 'latest', horizon]
 *                                GET /api/screener/latest?horizon=(最新一次筛选 + 候选 + 排程)
 *   ['screener', 'history', horizon]
 *                                GET /api/screener/history?horizon=&limit=
 *   ['screener', 'detail', id]   GET /api/screener/:id(点历史里的老筛选)
 *                                (SSE `screener.changed` 按前缀 ['screener'] 一次全失效)
 *   ['bots']                     GET /api/bots(角色名册 + 最近 run + 最近 handoff;
 *                                SSE `bots.changed` 失效它)
 *   ---- v3.7:Portfolio / Risk ----
 *   ['portfolio', 'snapshot']    GET /api/portfolio/snapshot(SSE `portfolio.changed` 按前缀 ['portfolio'] 失效)
 *   ['reviewer', 'cards']        GET /api/reviewer/cards(平仓复盘卡 + 批次决策;bots.changed / thread.changed 时失效)
 *   ['lab', 'experiments']       GET /api/lab/experiments(机械期望实验;bots.changed 时失效)
 *   ['captain', 'brief']         GET /api/captain/brief(值班简报;bots.changed 时失效)
 *   ['risk', 'alerts', status]   GET /api/risk/alerts?status=(SSE `risk.changed` 按前缀 ['risk'] 失效,顺带 ['bots'])
 *   ---- v3.12(docs/demo/v3-ui-contract.md §9.29 / §9.30)----
 *   ['judgment-ledger','summary',since]    GET /api/judgment-ledger/summary(复盘页「判断增量」)
 *   ['judgment-ledger','rows',sid,since]   GET /api/judgment-ledger?strategy_id=(点开一层策略才拉)
 *   ['market-events', status, asset, subkind]
 *                                GET /api/market-events(事件区;**不是 /api/events**,那是 SSE)
 *   ['market-events','detail',id]          GET /api/market-events/:id(开抽屉才拉)
 *                                事件没有专属 SSE,靠 30 秒轮询 + 写操作后手动失效
 *   ['backtest', id, 'attribution']
 *                                GET /api/backtest/:id/attribution(某次回测的归因点位;
 *                                跑归因是 POST /api/backtest/:id/attribute,调便宜大脑会花钱)
 *   ---- v3.13(docs/demo/v3-ui-contract.md §9.38):跟单 session ----
 *   ['follow']                   GET /api/follow(设置 + 连接状态 + 权重表 + 待批队列;
 *                                写操作后 / SSE `trader_signal` 到达时一起失效)
 *   ['follow','signals']         GET /api/follow/signals?limit=300(信号流全量,筛选在前端做;
 *                                SSE `trader_signal` 按 signal_id 直接 upsert 进这份缓存)
 *   ['follow','stats']           GET /api/follow/stats(8794 权重表 + 本地每人统计)
 *
 *   ---- §9.46:我的策略(pages/my-strategies.tsx)----
 *   ['research','my-strategies',filter,sort,q]  GET /api/research/strategies?q=&filter=&sort=
 *   ['research','my-strategy',id,report]        GET /api/research/strategies/:id?report=
 *                                写操作后两个前缀一起失效;#backtest?id= 映射到本页单报告视图
 *
 *   ---- 2026-09-23 进化页(docs/design/evolution-floor-2026-09-23.md,api/evolution.ts)----
 *   ['evolution','daily',from,to]  GET /api/evolution/daily(方格 + 楼层「今天」条;无 SSE,5 分钟轮询)
 *   ['evolution','day',role,date]  GET /api/evolution/day(点格子开抽屉才拉)
 *   ['research','improve','jobs',n] GET /api/research/improve?limit=(楼层 LAB 卡最近改进环)
 *
 *   ---- §9.52 模型连接与角色底层(pages/models.tsx)----
 *   ['models']                   GET /api/models(连接 + 7 角色绑定 + effective + cli_detected;
 *                                SSE `models.changed` 直接把 ModelsView 写进缓存;顶栏胶囊 / 楼层横幅与角色卡共用)
 *
 * SSE → 缓存的映射见下面 useLiveEvents(...) 里的 handlers;新页面只要用上面这些 key 发
 * useQuery,不用自己再开一条 /api/events 连接。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from '@/components/app-sidebar';
import { CommandMenu } from '@/components/command-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusBar } from '@/components/status-bar';
import { TopBar } from '@/components/top-bar';
import { api, useLiveEvents } from '@/api/client';
import { setRoleProgress } from '@/components/floor/progress';
import type { Page } from '@/lib/nav';
import { t, useLang } from '@/lib/i18n';
import { TradePage } from '@/pages/trade';
import { AgentPage } from '@/pages/agent';
import { IntelPage } from '@/pages/intel';
import { EventsPage } from '@/pages/events';
import { ScreenerPage } from '@/pages/screener';
import { WatchPage } from '@/pages/watch';
import { FloorPage } from '@/pages/floor';
import { FloorV4Page } from '@/pages/floor-v4';
import { PageErrorBoundary } from '@/components/page-error-boundary';
import { JudgmentsPage } from '@/pages/judgments';
import { EvolutionPage } from '@/pages/evolution';
import { HistoryPage } from '@/pages/history';
import { StrategiesPage } from '@/pages/strategies';
import { ResearchPage } from '@/pages/research';
import { MyStrategiesPage } from '@/pages/my-strategies';
import { LogsPage } from '@/pages/logs';
import { SettingsPage } from '@/pages/settings';
import { ModelsPage } from '@/pages/models';
import { MatrixStudyPage } from '@/pages/matrix-study';
import { MarketPage } from '@/pages/market';
import { StartPage } from '@/pages/start';
import { ConnectPage } from '@/pages/connect';
import { bootRedirect } from '@/components/start/logic';
import { useStartCore } from '@/components/start/use-start';

const PAGE_IDS: Page[] = ['start', 'connect', 'trade', 'agent', 'watch', 'floor', 'floor-v4', 'intel', 'events', 'screener', 'market', 'judgments', 'evolution', 'history', 'strategies', 'research', 'matrix-study', 'my-strategies', 'models', 'logs', 'settings'];

const LAST_PAGE_KEY = 'tg.page.last';

/**
 * 无 hash 时的落点:上次离开的页;第一次进来落楼层(09-06 拍板:默认首页不强制,记上次页)。
 * 2026-09-25(信息架构 ②):接入核心四项没完成时改落 #start,见 App() 里的 bootRedirect;
 * 这里是同步的初值,数据到了再决定要不要跳。
 */
function defaultPage(): Page {
  try {
    const saved = window.localStorage.getItem(LAST_PAGE_KEY) as Page | null;
    if (saved && PAGE_IDS.includes(saved)) return saved;
  } catch {
    /* 无 storage */
  }
  return 'floor';
}

function readPageFromHash(): Page {
  const hash = window.location.hash.slice(1).split('?')[0] as Page;
  // §9.46:#backtest?id=<report_id>(研究页结果面板跳过来)落到「我的策略」页的单报告视图
  if ((hash as string) === 'backtest') return 'my-strategies';
  // 2026-09-23:记忆并进进化页,#memory 落到进化页的「记忆」标签(页内按 hash 选标签)
  if ((hash as string) === 'memory') return 'evolution';
  return PAGE_IDS.includes(hash) ? hash : defaultPage();
}

/** market.tick 合并:3s 内多条只失效一次 ['overview']。 */
let overviewTimer: number | undefined;
function coalesceOverview(qc: QueryClient): void {
  if (overviewTimer) return;
  overviewTimer = window.setTimeout(() => {
    overviewTimer = undefined;
    void qc.invalidateQueries({ queryKey: ['overview'] });
  }, 3000);
}

/** log 批量写缓存:攒 400ms 一次。 */
let logBuffer: unknown[] = [];
let logTimer: number | undefined;
function pushLog(qc: QueryClient, entry: unknown): void {
  logBuffer.push(entry);
  if (logTimer) return;
  logTimer = window.setTimeout(() => {
    logTimer = undefined;
    const batch = logBuffer.reverse();
    logBuffer = [];
    qc.setQueryData(['logs'], (old: unknown) => {
      const cur = old as { logs: unknown[] } | undefined;
      if (!cur) return old;
      return { logs: [...batch, ...cur.logs].slice(0, 500) };
    });
  }, 400);
}

export default function App() {
  // 语言一变,整棵树跟着重渲染,所有 t() 读到新值(组件自己不用再挂 hook)。
  useLang();
  const queryClient = useQueryClient();
  const [page, setPageState] = useState<Page>(readPageFromHash);
  const setPage = (p: Page) => {
    const current = window.location.hash.slice(1);
    if (current.split('?')[0] !== p) window.location.hash = p;
    setPageState(p);
  };
  useEffect(() => {
    const onHashChange = () => setPageState(readPageFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  // 2026-09-25 默认首页:只在「无 hash 冷启动、用户还没点过别处」时判一次——核心四项(交易所 / 模型 /
  // 观察列表 / 当前策略)没完成 → #start;完成了但记住的是 start → 回楼层;还判不出来就等数据。
  const startCore = useStartCore();
  const bootDecided = useRef(Boolean(window.location.hash.slice(1)));
  useEffect(() => {
    if (bootDecided.current) return;
    if (window.location.hash.slice(1)) {
      bootDecided.current = true; // 用户已经点去别处了,不抢
      return;
    }
    const target = bootRedirect(startCore.core, page);
    if (startCore.core === null) return;
    bootDecided.current = true;
    if (target) setPage(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startCore.core, page]);
  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_PAGE_KEY, page);
    } catch {
      /* 私密模式等 */
    }
  }, [page]);

  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 20_000 });
  const [connected, setConnected] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [haltOpen, setHaltOpen] = useState(false);
  const [resumeHaltOpen, setResumeHaltOpen] = useState(false);
  const [haltBusy, setHaltBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);

  useLiveEvents(
    {
      'loop.state': () => void queryClient.invalidateQueries({ queryKey: ['overview'] }),
      'queue.state': () => void queryClient.invalidateQueries({ queryKey: ['overview'] }),
      'account.updated': (account) => {
        queryClient.setQueryData(['overview'], (old: unknown) => (old && typeof old === 'object' ? { ...old, account } : old));
        void queryClient.invalidateQueries({ queryKey: ['positions'] });
        void queryClient.invalidateQueries({ queryKey: ['open-orders'] });
      },
      // 每个观察币每 10s 各来一条 tick;合并成最多每 3s 失效一次 overview,别让整个外壳跟着每条 tick 重渲染
      'market.tick': () => coalesceOverview(queryClient),
      // v3.5:同一个事件既报「在跑的策略变了」也报策略库自己的变动(晋升/退役/新版本/归因),
      //       前缀 ['strategies'] 一次把列表和 ['strategies', id] 详情都失效掉。
      'strategy.changed': () => {
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        void queryClient.invalidateQueries({ queryKey: ['strategies'] });
      },
      'workflow.changed': (workflow) => {
        queryClient.setQueryData(['workflow'], workflow);
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
      },
      // §9.19 设置提议:列表 + 活动流
      'workflow.proposal': () => {
        void queryClient.invalidateQueries({ queryKey: ['workflow', 'proposals'] });
        void queryClient.invalidateQueries({ queryKey: ['activity'] });
      },
      'intent.changed': () => {
        void queryClient.invalidateQueries({ queryKey: ['episodes'] });
        void queryClient.invalidateQueries({ queryKey: ['intents'] });
      },
      'episode.started': () => void queryClient.invalidateQueries({ queryKey: ['episodes'] }),
      'episode.finished': (summary) => {
        queryClient.setQueryData(['episodes'], (old: unknown) => {
          if (!Array.isArray(old)) return old;
          return [summary, ...old.filter((e: { id: string }) => e.id !== summary.id)].slice(0, 200);
        });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        if (summary.thread_id) void queryClient.invalidateQueries({ queryKey: ['thread', summary.thread_id] });
      },
      'thread.changed': (thread) => {
        void queryClient.invalidateQueries({ queryKey: ['reviewer'] });
        void queryClient.invalidateQueries({ queryKey: ['threads', 'open'] });
        void queryClient.invalidateQueries({ queryKey: ['threads', 'all'] });
        void queryClient.invalidateQueries({ queryKey: ['thread', thread.id] });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        // 线程进终态才影响复盘页;不区分也没关系,history 查询自己有 staleTime
        if (thread.status === 'closed' || thread.status === 'canceled' || thread.status === 'invalidated') {
          void queryClient.invalidateQueries({ queryKey: ['history'] });
        }
      },
      'market_state.updated': (state) => {
        queryClient.setQueryData(['market-state'], state);
        void queryClient.invalidateQueries({ queryKey: ['market-state-history'] });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
      },
      // 前缀匹配:['chat-messages','chat'] / ['chat-messages','narration'] 一起失效
      'chat.message': () => void queryClient.invalidateQueries({ queryKey: ['chat-messages'] }),
      // v3.2:记忆提案/批准/拒绝/遗忘/使用任一变化都打这个事件;前缀失效 ['memory', ...] 全部子查询
      'memory.changed': () => void queryClient.invalidateQueries({ queryKey: ['memory'] }),
      // v3.3:切了执行后端 / 重新探了 MCP 连接 / OAuth 回调回来了
      'execution.changed': () => {
        // 切执行通道 = 切账户上下文:权益/持仓/挂单/线程/复盘都要按新通道重拉
        void queryClient.invalidateQueries({ queryKey: ['execution'] });
        void queryClient.invalidateQueries({ queryKey: ['overview'] });
        void queryClient.invalidateQueries({ queryKey: ['positions'] });
        void queryClient.invalidateQueries({ queryKey: ['open-orders'] });
        void queryClient.invalidateQueries({ queryKey: ['threads'] });
        void queryClient.invalidateQueries({ queryKey: ['history'] });
        void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      },
      // 2026-09-21 研究工作台:进度事件只写进 ['research','progress',run_id];终态/入队才失效列表与详情
      'research.workbench': (ev) => {
        queryClient.setQueryData(['research', 'progress', ev.run_id], ev);
        if (ev.event !== 'progress') {
          void queryClient.invalidateQueries({ queryKey: ['research', 'runs'] });
          void queryClient.invalidateQueries({ queryKey: ['research', 'run', ev.run_id] });
          void queryClient.invalidateQueries({ queryKey: ['research', 'result', ev.run_id] });
          void queryClient.invalidateQueries({ queryKey: ['research', 'capabilities'] });
        }
      },
      // 第三轮:研究对话实时事件按 chat_id 追加进 ['research','chat-live',chat_id];结论/产物到了顺带失效 chat 详情
      'research.chat': (ev) => {
        queryClient.setQueryData(['research', 'chat-live', ev.chat_id], (old: unknown) => {
          const cur = Array.isArray(old) ? (old as typeof ev[]) : [];
          return cur.some((x) => x.seq === ev.seq) ? cur : [...cur, ev].slice(-500);
        });
        queryClient.setQueryData(['research', 'chat-live', 'latest'], ev.chat_id);
        if (ev.event === 'final' || ev.event === 'error') void queryClient.invalidateQueries({ queryKey: ['research', 'chat', ev.chat_id] });
      },
      // §9.44:研究会话的 inquiry 事件按 seq 去重后存进 ['research','inquiry-live',inquiry_id];
      // 终态(completed/incomplete/failed/cancelled)和 awaiting_input 才回源拉一次会话,拿落库的 blocks。
      'research.inquiry': (ev) => {
        queryClient.setQueryData(['research', 'inquiry-live', ev.inquiry_id], (old: unknown) => {
          const cur = Array.isArray(old) ? (old as typeof ev[]) : [];
          if (cur.some((x) => x.seq === ev.seq)) return cur;
          return [...cur, ev].sort((a, b) => a.seq - b.seq).slice(-800);
        });
        const settled = ev.event === 'inquiry.completed' || ev.event === 'inquiry.incomplete' || ev.event === 'inquiry.failed' || ev.event === 'inquiry.cancelled' || ev.event === 'inquiry.awaiting_input';
        if (settled) {
          void queryClient.invalidateQueries({ queryKey: ['research', 'session', ev.session_id] });
          void queryClient.invalidateQueries({ queryKey: ['research', 'sessions'] });
        }
      },
      // v3.4:回测进度(每次判断一条)只更新那一条 run 的缓存,别整页刷新
      'backtest.progress': (p) => {
        queryClient.setQueryData(['backtest', p.run_id], (old: unknown) => {
          const cur = old as { run: { progress: unknown } } | undefined;
          if (!cur) return old;
          return { ...cur, run: { ...cur.run, progress: { done: p.done, total: p.total, last_action: p.last_action, at: p.at } } };
        });
        void queryClient.invalidateQueries({ queryKey: ['backtest', p.run_id] });
      },
      'backtest.changed': (run) => {
        void queryClient.invalidateQueries({ queryKey: ['backtest'] });
        void queryClient.invalidateQueries({ queryKey: ['backtest', run.id] });
      },
      // v3.6:一次筛选从 running 走到 done/failed,连带 workflow(auto 模式会改 watchlist)
      // 和团队页的 handoff 收件箱都可能变了;前缀 ['screener'] 一次把 latest/history/详情全失效。
      'screener.changed': (e) => {
        // 楼层 RADAR 桌的筛选进度(每币一条);done/total 缺失或 status 非 running = 结束
        if (e.status === 'running' && typeof e.done === 'number' && typeof e.total === 'number') setRoleProgress('radar', { label: t('{horizon} 筛选', { horizon: e.horizon }), done: e.done, total: e.total });
        else setRoleProgress('radar', null);
        void queryClient.invalidateQueries({ queryKey: ['screener'] });
        void queryClient.invalidateQueries({ queryKey: ['bots'] });
        void queryClient.invalidateQueries({ queryKey: ['workflow'] });
      },
      'bots.changed': (e) => {
        // v3.9:strategy_lab 实验进度(每币一条带 progress;结束那条没有 progress)
        if (e.role === 'strategy_lab') setRoleProgress('strategy_lab', e.progress ? { label: t('实验 {symbol}', { symbol: e.progress.symbol }), done: e.progress.done, total: e.progress.total } : null);
        void queryClient.invalidateQueries({ queryKey: ['bots'] });
        // v3.8:reviewer 的 trade_card / review_batch run 也在 bots 里,复盘面板一起刷
        void queryClient.invalidateQueries({ queryKey: ['reviewer'] });
        void queryClient.invalidateQueries({ queryKey: ['lab'] });
        void queryClient.invalidateQueries({ queryKey: ['captain'] });
      },
      // v3.7:账户敞口快照 / 风控告警(presence 也会跟着变,一起失效 ['bots'])
      'portfolio.changed': () => void queryClient.invalidateQueries({ queryKey: ['portfolio'] }),
      'risk.changed': () => {
        void queryClient.invalidateQueries({ queryKey: ['risk'] });
        void queryClient.invalidateQueries({ queryKey: ['bots'] });
      },
      activity: (item) => {
        queryClient.setQueryData(['activity'], (old: unknown) => {
          const cur = old as { activity: { id: string }[] } | undefined;
          if (!cur) return old;
          if (cur.activity.some((a) => a.id === item.id)) return old;
          return { activity: [item, ...cur.activity].slice(0, 500) };
        });
      },
      // 日志是所有模块的唯一出口,扫描时一秒能来十几条;攒 400ms 一次写缓存,500 行的列表就不会逐条重渲染
      log: (entry) => pushLog(queryClient, entry),
      // §9.38/§9.39:每条信号发两次(收到时 status:new,处置完终态);按 signal_id 覆盖同一行。
      // 没有 ['follow','signals'] 缓存(用户还没进过信号市场)时不用管——下次进页面会整份重拉。
      trader_signal: (sig) => {
        queryClient.setQueryData(['follow', 'signals'], (old: unknown) => {
          const cur = old as { signals: { signal_id: string }[]; connection: unknown } | undefined;
          if (!cur) return old;
          const idx = cur.signals.findIndex((s) => s.signal_id === sig.signal_id);
          const signals = idx === -1 ? [sig, ...cur.signals] : cur.signals.map((s, i) => (i === idx ? sig : s));
          return { ...cur, signals };
        });
        // 权重表(['follow','stats'])与 ['follow'] 一起失效——待办列表(pending_review/
        // pending_review_total)就在 ['follow'] 的响应里,不是独立 query,这一下就够了。
        // 信号流那份缓存上面已经直接 upsert,不用等重拉。
        void queryClient.invalidateQueries({ queryKey: ['follow'], exact: true });
        void queryClient.invalidateQueries({ queryKey: ['market', 'subscriptions'] });
      },
      // 2026-09-20 信号市场:入站账本 / 出站扇出 / 订阅 / 售后,都是低频事件,直接让对应 query 失效。
      market_delivery: () => {
        void queryClient.invalidateQueries({ queryKey: ['market', 'inbox'] });
        void queryClient.invalidateQueries({ queryKey: ['market', 'status'] });
      },
      market_publish: () => {
        void queryClient.invalidateQueries({ queryKey: ['market', 'asp'] });
      },
      market_subscription: () => {
        void queryClient.invalidateQueries({ queryKey: ['market', 'subscriptions'] });
        void queryClient.invalidateQueries({ queryKey: ['market', 'status'] });
      },
      market_aftersale: () => {
        void queryClient.invalidateQueries({ queryKey: ['market', 'asp'] });
      },
      // §9.52:连接增删改 / 测试结果 / 角色绑定变了,data 就是完整 ModelsView,直接写缓存
      'models.changed': (view) => queryClient.setQueryData(['models'], view),
    },
    setConnected,
  );

  const account = overviewQ.data?.account ?? null;
  const queue = overviewQ.data?.queue ?? null;
  const halted = overviewQ.data?.loop.halted ?? false;
  const paused = overviewQ.data?.loop.paused ?? false;
  const backend = overviewQ.data?.loop.backend ?? 'paper';
  const brain = overviewQ.data?.loop.brain ?? '—';
  const usageToday = overviewQ.data?.usage_today ?? null;

  const confirmHalt = async () => {
    setHaltBusy(true);
    try {
      await api.halt();
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      setHaltOpen(false);
    } finally {
      setHaltBusy(false);
    }
  };
  const confirmResumeHalt = async () => {
    setResumeBusy(true);
    try {
      await api.resume('RESUME');
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      setResumeHaltOpen(false);
    } finally {
      setResumeBusy(false);
    }
  };

  return (
    <TooltipProvider>
      <SidebarProvider style={{ '--sidebar-width': '9.5rem', '--sidebar-width-icon': '2.9rem' } as React.CSSProperties}>
        <AppSidebar page={page} onNavigate={setPage} />
        <SidebarInset className="h-svh min-w-0 overflow-hidden">
          <TopBar
            page={page}
            account={account}
            queue={queue}
            halted={halted}
            paused={paused}
            usage={usageToday}
            connected={connected}
            onOpenCommand={() => setCmdOpen(true)}
            onOpenHalt={() => setHaltOpen(true)}
            onOpenResumeHalt={() => setResumeHaltOpen(true)}
          />
          <main className="min-h-0 flex-1 overflow-auto p-3">
            <PageErrorBoundary page={page}>
            {page === 'start' ? <StartPage /> : null}
            {page === 'connect' ? <ConnectPage /> : null}
            {page === 'trade' ? <TradePage /> : null}
            {page === 'agent' ? <AgentPage /> : null}
            {page === 'intel' ? <IntelPage /> : null}
            {page === 'events' ? <EventsPage /> : null}
            {page === 'screener' ? <ScreenerPage /> : null}
            {page === 'market' ? <MarketPage /> : null}
            {page === 'watch' ? <WatchPage /> : null}
            {page === 'floor' ? <FloorPage connected={connected} /> : null}
            {page === 'floor-v4' ? <FloorV4Page connected={connected} /> : null}
            {page === 'judgments' ? <JudgmentsPage /> : null}
            {page === 'evolution' ? <EvolutionPage /> : null}
            {page === 'history' ? <HistoryPage /> : null}
            {page === 'strategies' ? <StrategiesPage /> : null}
            {page === 'research' ? <ResearchPage /> : null}
            {page === 'my-strategies' ? <MyStrategiesPage /> : null}
            {page === 'models' ? <ModelsPage /> : null}
            {page === 'matrix-study' ? <MatrixStudyPage /> : null}
            {page === 'logs' ? <LogsPage /> : null}
            {page === 'settings' ? <SettingsPage /> : null}
            </PageErrorBoundary>
          </main>
          <StatusBar connected={connected} backend={backend} brain={brain} />
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
          <ConfirmDialog
            open={resumeHaltOpen}
            title={t('解除紧急停止')}
            summary={t('确认解除')}
            danger
            requireText="RESUME"
            busy={resumeBusy}
            onCancel={() => setResumeHaltOpen(false)}
            onConfirm={() => void confirmResumeHalt()}
          >
            <p>{t('解除之后调度恢复正常,agent 随时可能重新判断、重新开仓。当前状况处理好了吗?')}</p>
          </ConfirmDialog>
        </SidebarInset>
        <CommandMenu
          open={cmdOpen}
          onOpenChange={setCmdOpen}
          onNavigate={setPage}
          halted={halted}
          onOpenHalt={() => setHaltOpen(true)}
          onOpenResumeHalt={() => setResumeHaltOpen(true)}
        />
        <Toaster richColors position="bottom-right" />
      </SidebarProvider>
    </TooltipProvider>
  );
}
