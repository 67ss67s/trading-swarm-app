/**
 * 研究工作台(#/research,2026-09-21;后端 docs/research/architecture-and-evaluation.md,
 * 前端契约 docs/research/claude-frontend-handoff.md)。
 *
 * 对象链:Dataset → Study → Policy → RunManifest → Job → Result → Decision/Trade → Draft → ChildRun。
 * 一次 run = 冻结的数据 + 策略 + 执行费用 + 大脑身份;改任何一项都是新 run,不在旧图上改标题。
 * 三臂:A 固定规则 / B 代理自由判断 / C 规则出候选、代理只答 FOLLOW/SKIP;A 只跑一次作共同基准。
 *
 * 布局沿用 Horizon 的长处:左栏研究代理对话 + 实验列表,右栏固定策略卡 + 结果分页。
 * 红线:completed 只说明算完了,不说明策略有效;交易数更少/回撤更低不默认染成胜出;
 *       随机参与率对照只标「探索性」;合成数据、未独立验证来源都要给标签。
 *
 * react-query key(App.tsx 顶部注释里的前缀约定):
 *   ['research','capabilities'] / ['research','datasets'] / ['research','runs']
 *   ['research','run',id](running 时 2s 轮询兜底)/ ['research','result',id] / ['research','evidence',id,offset]
 *   ['research','progress',id]  只由 App.tsx 的 SSE `research.workbench` 写入,本页只读缓存。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Ban, Beaker, Braces, Bot, ChevronDown, ChevronRight, Database, Download, FlaskConical, Grid3x3, History, LineChart, Play, RefreshCw, Send, ShieldCheck, Sparkles, Telescope, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, researchApi } from '@/api/client';
import type {
  ResearchRevisionCommand,
  ResearchArmKind,
  ResearchArmResult,
  ResearchChatEvent,
  ResearchChatTask,
  ResearchChatTurn,
  ResearchPrecheckResponse,
  ResearchDatasetSummary,
  ResearchDifference,
  ResearchEvent,
  ResearchExecution,
  ResearchFit,
  ResearchMetrics,
  OrderGateParams,
  ResearchPolicy,
  ResearchRequest,
  ResearchRunStatus,
  ResearchRunSummary,
  ResearchSessionContext,
  ResearchSessionDetail,
  ResearchSessionsResponse,
  ResearchStudy,
  ResearchTrade,
  ResearchUniverse,
  StrategyIR,
} from '@/api/research-types';
import { StrategySettings } from '@/components/research-workbench/strategy-settings';
import { ArmChart, armColor, armLabel, type ArmChartMode } from '@/components/research-workbench/arm-chart';
import { DiagnosticsTab } from '@/components/research-workbench/diagnostics';
import { ArtifactCard, FinalWithArtifacts, TaskTree } from '@/components/research-workbench/artifacts';
import { ArtifactResultPanel, SessionChat, SessionSidebar, loadLegacyChat } from '@/components/research-workbench/session-chat';
import { PineCatalogPanel } from '@/components/research-workbench/pine-catalog';
import { AnimatePresence, AnimatedNumber, Reveal, motion } from '@/components/research-workbench/motion';
import { RulesCard, useRunRules } from '@/components/research-workbench/rules-card';
import { UniverseScreenPanel, tfLabel } from '@/components/research-workbench/screen-panel';
import { StrategyBuilder } from '@/components/research-workbench/strategy-builder';
import type { SeedAsset } from '@/components/research-workbench/seed-dataset';
import { fallbackSession } from '@/components/research-workbench/session-pick';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MatrixStudyPanel } from '@/components/matrix-study/panel';
import { DivisionNote, familyLabel } from '@/components/matrix-study/shared';
import { matrixApi } from '@/api/matrix-study';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { fmtDateTime, fmtDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// 文案与格式(研究契约独有,只在本页用)

const STATUS_LABEL: Record<ResearchRunStatus, string> = tmap({
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  budget_exhausted: '预算耗尽',
  cancelling: '取消中',
  cancelled: '已取消',
  interrupted: '重启中断',
});

function statusClass(s: ResearchRunStatus): string {
  if (s === 'completed') return 'border-up/40 bg-up/10 text-up';
  if (s === 'running' || s === 'queued' || s === 'cancelling') return 'border-primary/40 bg-primary/10 text-primary';
  if (s === 'failed' || s === 'interrupted') return 'border-down/40 bg-down/10 text-down';
  return 'border-warn/40 bg-warn/10 text-warn';
}

const ARM_KINDS: ResearchArmKind[] = ['a_rules', 'b_agent', 'c_filter'];
const ARM_KIND_LABEL: Record<ResearchArmKind, string> = tmap({ a_rules: 'A 固定规则', b_agent: 'B 代理判断', c_filter: 'C 规则+代理筛选' });
const ARM_KIND_HINT: Record<ResearchArmKind, string> = tmap({
  a_rules: '策略的机械解释固定执行,看规则本身表现',
  b_agent: '代理拿当时可见数据自由判断,看它改变了哪些入场与退出',
  c_filter: '规则出候选,代理只答 FOLLOW / SKIP,看筛选有没有增量',
});

const REASON_LABEL: Record<ResearchTrade['reason'], string> = tmap({ stop: '止损', target: '止盈', agent_exit: '代理退出', agent_reduce: '代理减仓', horizon: '持有期到' });
const ACTION_LABEL: Record<string, string> = tmap({ enter: '入场', follow: '跟随', skip: '跳过', hold: '持有', exit: '退出', reduce: '减仓', no_trade: '不交易', blocked: '被闸拦', model_error: '模型错误' });
const TF_OPTIONS = ['15m', '1h', '4h', '1d'] as const;
const PRECHECK_LABEL: Record<string, string> = tmap({ signal_frequency: '信号频率', min_trades: '最少笔数', stop_over_cost: '止损/成本倍数', order_gate_pass_rate: '过盈亏比门比例', stop_fit_rate: '止损放宽比例', holding_vs_timeframe: '预计持有根数', warmup_coverage: '预热覆盖', regime_coverage: '趋势过滤放行' });

/** 右栏视图:结果(对话里选中的产物)/ 实验详情 / 策略构建 / 资产筛选。旧能力一个不少。 */
type PanelView = 'artifact' | 'run' | 'builder' | 'screen' | 'pine' | 'matrix';
const PANEL_VIEWS: PanelView[] = ['artifact', 'run', 'builder', 'screen', 'pine', 'matrix'];
const PANEL_VIEW_LABEL: Record<PanelView, string> = tmap({ artifact: '结果', run: '实验', builder: '策略构建', screen: '资产筛选', pine: 'Pine 目录', matrix: '批量验证' });

/** 当前会话 id 记在本机:刷新回来还是同一条会话(内容一律从 GET /sessions/:id 恢复)。 */
const SESSION_STORE = 'tg.research.session';

const pct = (v: number | null | undefined, digits = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—');
const signedPct = (v: number | null | undefined, digits = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%` : '—');
const dec = (v: string | number | null | undefined, digits = 2): string => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 }) : String(v);
};
const short = (h: string | null | undefined, n = 10): string => (h ? h.slice(0, n) : '—');
const tone = (v: number | string | null | undefined): string => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 'text-foreground';
  return n > 0 ? 'text-up' : 'text-down';
};

// order-gate「先放置再判定」:代码先放止损止盈,再判盈亏比;这里只负责把来源翻成人话。
const FIT_STOP_LABEL: Record<string, string> = tmap({ strategy: '策略', cost_floor: '成本下限' });
const FIT_TARGET_LABEL: Record<string, string> = tmap({ strategy: '结构', fallback_r: '固定倍数', none: '无止盈' });

/** 一行 fit 摘要:止损 2.40%(成本下限) · 止盈 4.80%(固定倍数) · RR 2.0 */
function fitSummary(f: ResearchFit): string {
  const stop = `${t('止损')} ${pct(f.stop_pct)}(${FIT_STOP_LABEL[f.stop_source] ?? f.stop_source})`;
  const target = `${t('止盈')} ${f.target_pct == null ? '—' : pct(f.target_pct)}(${FIT_TARGET_LABEL[f.target_source] ?? f.target_source})`;
  return `${stop} · ${target}${f.rr == null ? '' : ` · RR ${f.rr.toFixed(1)}`}`;
}

/** 策略名/描述:第一轮 policy 或第二轮 strategy_ir 二选一。 */
function strategyLabelOf(req: ResearchRequest): { label: string; description: string } {
  const src = req.policy ?? req.strategy_ir;
  return { label: src?.label ?? '', description: src?.description ?? '' };
}

/** 把 SSE research.chat 的 task 事件折成当前任务树(同 id 后到的覆盖先到的)。 */
function tasksFromEvents(events: ResearchChatEvent[]): ResearchChatTask[] {
  const map = new Map<string, ResearchChatTask>();
  for (const e of events) {
    if (e.event !== 'task') continue;
    const d = e.data as Partial<ResearchChatTask> & { id?: string };
    if (!d.id || !d.title) continue;
    map.set(d.id, { id: d.id, parent_id: d.parent_id ?? null, title: d.title, status: d.status ?? 'running', detail: d.detail ?? null, started_at: d.started_at, ended_at: d.ended_at ?? null });
  }
  return [...map.values()];
}

/** 沙箱研究代理的本机记录(第三轮沿用);「旧对话(只读)」抽屉读的也是这份。 */
const CHAT_STORE = 'tg.research.chat';
function loadChat(): ResearchChatTurn[] {
  try {
    const raw = window.localStorage.getItem(CHAT_STORE);
    return raw ? (JSON.parse(raw) as ResearchChatTurn[]) : [];
  } catch {
    return [];
  }
}
function saveChat(turns: ResearchChatTurn[]): void {
  try {
    window.localStorage.setItem(CHAT_STORE, JSON.stringify(turns.slice(-60)));
  } catch {
    /* 私密模式 */
  }
}

function stableKey(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 窄屏(<1024px):对话与结果二选一,不并排。 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window === 'undefined' ? false : window.innerWidth < 1024));
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/**
 * 每笔收益类字段的统一 formatter(expectancy_pct / per_trade_return_pct.* / trade_return_histogram.bins)。
 *
 * 判据是确定性的,不猜数值大小:后端创建 run 时会在冻结请求里盖 spec_version('strategy-spec/v1')。
 *   有 spec_version → 这些字段一律小数(0.0143 = 1.43%);
 *   没有(旧 run)  → 这些字段是百分数(-1.43 就是 -1.43%),先除以 100 再走同一条 formatter,并标「旧口径」。
 * net_return / max_drawdown / win_rate 等其它比例字段一直是小数,不走这里。
 */
function ratioPct(v: number | null | undefined, decimal: boolean, digits = 2): { text: string; legacy: boolean; value: number | null } {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { text: '—', legacy: !decimal, value: null };
  const ratio = decimal ? v : v / 100;
  const n = ratio * 100;
  return { text: `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`, legacy: !decimal, value: n };
}

/**
 * 答案层的一句结论:代码按规则生成,不是模型写的。
 * 交易数 < 10 就明说样本不足;completed 只表示算完了,不表示策略有效。
 */
function conclusionOf(m: ResearchMetrics | null, status: ResearchRunStatus): string {
  if (!m) return status === 'completed' ? t('这一轮算完了,但没有可读的结果指标。') : t('还没有结果。');
  const r = signedPct(m.net_return);
  const n = m.closed_trades;
  if (n === 0) return t('本轮历史回测收益 {r},没有产生任何交易:规则在这段行情里没被触发,谈不上胜率或有效性。', { r });
  if (n < 10) return t('本轮历史回测收益 {r},只产生 {n} 笔交易,目前不足以判断规则是否稳定。先看亏损来自哪些交易,再决定下一项验证。', { r, n });
  return t('本轮历史回测收益 {r},期间最大回撤 {d},样本 {n} 笔。这是一段历史上的表现,不说明规则在别的行情里成立。', { r, d: pct(m.max_drawdown), n });
}

/** 用户可读的实验标题:策略名 + 在 <资产> <周期> <窗口> 的历史回测;hash / trial / purpose 不进标题。 */
function readableTitle(run: ResearchRunSummary, dataset: ResearchDatasetSummary | null): string {
  const req = run.manifest.request;
  const label = strategyLabelOf(req).label || t('未命名策略');
  const sym = dataset?.symbol ?? req.dataset_id ?? req.universe_id ?? '';
  const tf = dataset?.timeframe_ms ? tfLabel(dataset.timeframe_ms) : '';
  const win = `${fmtDateTime(req.from_ms)} → ${fmtDateTime(req.to_ms)}`;
  return t('{label} 在 {sym} {tf} {win} 的历史回测', { label, sym, tf, win });
}

// ---------------------------------------------------------------------------
// 页面

export function ResearchPage() {
  return <ResearchWorkbench />;
}

export interface ResearchWorkbenchProps {
  /**
   * 嵌进「策略研究」流程页第 3 步(#strategy-research?step=refine):地址栏属于流程页,研究台不读也不改 hash;
   * 从海选带过来的试验走 matrixSeed(换一组 = 父组件换 key 重挂)。
   */
  embedded?: boolean;
  matrixSeed?: { study: string; trial: string } | null;
  /** 嵌入时「回到海选」:交给流程页切步骤 */
  onBackToScout?: (studyId: string) => void;
}

/** 研究台主体:独立页 #research 与「策略研究」第 3 步(精修)共用 */
export function ResearchWorkbench({ embedded = false, matrixSeed: seedFromProps = null, onBackToScout }: ResearchWorkbenchProps) {
  const qc = useQueryClient();
  const hashQuery = () => (embedded ? '' : window.location.hash.split('?')[1] ?? '');
  const capsQ = useQuery({ queryKey: ['research', 'capabilities'], queryFn: researchApi.capabilities, refetchInterval: 30_000 });
  const runsQ = useQuery({ queryKey: ['research', 'runs'], queryFn: researchApi.runs, refetchInterval: 15_000 });
  const runs = runsQ.data?.items ?? [];

  // ---- 会话(§9.44):列表 + 当前会话;接口没就绪就是空态,不 mock ----
  const sessionsQ = useQuery({ queryKey: ['research', 'sessions'], queryFn: () => researchApi.sessions(40), retry: false });
  const sessions = sessionsQ.data?.items ?? [];
  const sessionsUnavailable = !!sessionsQ.error;
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(SESSION_STORE);
    } catch {
      return null;
    }
  });
  // Keep the first send mounted while its session is created. Explicit switches
  // get a fresh chat instance so late mutation callbacks cannot change its draft.
  const [chatInstance, setChatInstance] = useState(0);
  const chatInstanceRef = useRef(0);
  // 此刻真正选中的对话(同一轮 effect 里 state 还没更新,判断「要不要落到最近一条」看这个)
  const sessionIdRef = useRef(sessionId);
  const selectSession = (id: string, preserveChat = false) => {
    if (!preserveChat) {
      chatInstanceRef.current += 1;
      setChatInstance(chatInstanceRef.current);
    }
    sessionIdRef.current = id;
    setSessionId(id);
  };
  useEffect(() => {
    try {
      if (sessionId) window.localStorage.setItem(SESSION_STORE, sessionId);
      else window.localStorage.removeItem(SESSION_STORE);
    } catch {
      /* 私密模式 */
    }
  }, [sessionId]);
  // 从「我的策略」跳来(#research?strategy_id=&new=1 或 &session=):new=1 开新会话并把草稿策略绑上去,session= 恢复那个会话。
  // 只在进页时读一次 hash,处理完把参数从地址栏去掉,刷新不重复建会话。
  const hashParams = useRef(new URLSearchParams(hashQuery()));
  const [linkedStrategyId, setLinkedStrategyId] = useState<string | null>(() => hashParams.current.get('strategy_id'));
  const hashHandled = useRef(false);
  useEffect(() => {
    if (hashHandled.current) return;
    const p = hashParams.current, sid = p.get('strategy_id'), wanted = p.get('session');
    if (!sid && !wanted) { hashHandled.current = true; return; }
    if (wanted) { if (!sessionsQ.isSuccess) return; hashHandled.current = true; if (sessions.some((x) => x.id === wanted)) selectSession(wanted); }
    else if (sid && p.get('new') === '1') {
      hashHandled.current = true;
      void researchApi.createSession().then((s) => {
        qc.setQueryData<ResearchSessionsResponse>(['research', 'sessions'], (old) => ({ items: [s, ...(old?.items ?? []).filter((item) => item.id !== s.id)] }));
        qc.setQueryData<ResearchSessionDetail>(['research', 'session', s.id], { session: s, messages: [], inquiries: [] });
        selectSession(s.id);
        return researchApi.attachMyStrategySession(sid, s.id).then(() => void qc.invalidateQueries({ queryKey: ['research', 'my-strategies'] }));
      }).catch((e: Error) => toast.error(e.message));
    } else hashHandled.current = true;
    if (hashHandled.current && !embedded) window.history.replaceState(null, '', '#research');
  }, [sessionsQ.isSuccess, sessions]);
  // 记住的会话被删了/换了机器:落到最近一条(不盖掉深链刚选中的那段,见 fallbackSession)
  useEffect(() => {
    if (!hashHandled.current) return;
    const next = fallbackSession(sessions, sessionIdRef.current);
    if (next) selectSession(next);
  }, [sessions, sessionId]);

  const createM = useMutation({
    mutationFn: (_args: { preserveChat: boolean; owner: number }) => researchApi.createSession(),
    onSuccess: (s, args) => {
      qc.setQueryData<ResearchSessionsResponse>(['research', 'sessions'], (old) => ({ items: [s, ...(old?.items ?? []).filter((item) => item.id !== s.id)] }));
      qc.setQueryData<ResearchSessionDetail>(['research', 'session', s.id], { session: s, messages: [], inquiries: [] });
      // A user may select another conversation while creation is in flight.
      if (args.owner === chatInstanceRef.current) selectSession(s.id, args.preserveChat);
      void qc.invalidateQueries({ queryKey: ['research', 'sessions'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ensureSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    try {
      const s = await createM.mutateAsync({ preserveChat: true, owner: chatInstanceRef.current });
      return s.id;
    } catch {
      return null;
    }
  };

  // 对话列表默认展开(第一次来就能看到已有的对话);用户收起过就记住
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { return localStorage.getItem('tg.research.historyExpanded') === 'false'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('tg.research.historyExpanded', String(!sidebarCollapsed)); } catch {} }, [sidebarCollapsed]);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const legacyTurns = useMemo(() => loadLegacyChat(), [legacyOpen]);

  // ---- 追问上下文:选中的产物 / 实验 / 窗口,随下一条消息发送 ----
  const [settingsRunId, setSettingsRunId] = useState<string | null>(null);
  const [context, setContext] = useState<ResearchSessionContext>({});
  const sessionDetailQ = useQuery({ queryKey: ['research', 'session', sessionId], queryFn: () => researchApi.session(sessionId!), enabled: !!sessionId, retry: false });
  useEffect(() => {
    setContext(sessionDetailQ.data?.session.context ?? {});
  }, [sessionId, sessionDetailQ.data?.session.context]);
  const patchContext = (next: ResearchSessionContext) => {
    setContext(next);
    if (sessionId) void researchApi.patchSessionContext(sessionId, next).catch(() => undefined); // 后端没就绪不打断前端
  };

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return new URLSearchParams(hashQuery()).get('run');
    } catch {
      return null;
    }
  });
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [parentForNext, setParentForNext] = useState<ResearchRunSummary | null>(null);
  // 右栏四种视图:结果(产物)/ 实验详情 / 策略构建 / 资产筛选 —— 旧能力一个不少,只是收进视图切换
  const [view, setView] = useState<PanelView>('artifact');
  const [seedUniverse, setSeedUniverse] = useState<ResearchUniverse | null>(null);
  const [seedIr, setSeedIr] = useState<{ ir: StrategyIR; timeframe: string; warmup?: number } | null>(null);
  // 从海选带进来的那一组(币 · 周期 · 市场):策略构建的数据集下拉框按它选
  const [seedAsset, setSeedAsset] = useState<SeedAsset | null>(null);
  const [builderSeedText, setBuilderSeedText] = useState('');

  // 布局状态机:chat_only(对话一栏居中)→ chat_with_artifact(右侧结果面板打开)。
  // 关闭面板只是 display:none,DOM 留着 —— 选中的 artifact / run / tab / 滚动位置都还在,重开即还原。
  // 深链 #research?run=<id> 进来时直接打开实验视图;普通进入默认 chat_only。
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return !!new URLSearchParams(hashQuery()).get('run');
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      if (new URLSearchParams(hashQuery()).get('run')) setView('run');
    } catch {
      /* 无 hash */
    }
  }, []);
  const [panelWidth, setPanelWidth] = useState(() => Math.min(720, Math.max(400, (window.innerWidth - 220) * .52)));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [narrowView, setNarrowView] = useState<'chat' | 'panel'>('chat');
  const narrow = useNarrow();
  const layout: 'chat_only' | 'chat_with_artifact' = panelOpen ? 'chat_with_artifact' : 'chat_only';

  // Desktop resize: CSS also accounts for the history rail and preserves conversation width.
  const dragRef = useRef<{ x: number; w: number; max: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      setPanelWidth(Math.min(Math.max(240, d.w - (e.clientX - d.x)), d.max));
    };
    const up = () => {
      dragRef.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [sidebarCollapsed]);

  // Restore the selected evidence from this session, never retain another session's artifact.
  useEffect(() => {
    setSelectedArtifactId(sessionDetailQ.data?.session.context?.selected_artifact_id ?? null);
    const runId = sessionDetailQ.data?.session.context?.selected_run_id;
    if (runId) setSelectedId(runId);
  }, [sessionId, sessionDetailQ.data?.session.id]);

  const openPanel = (v: PanelView) => {
    setView(v);
    setPanelOpen(true);
    setNarrowView('panel');
  };

  // 批量验证 v2「在研究台继续打磨」:#research?matrix_study=<id>&trial=<trial_id> → 取这一组的资产 / 周期 / 策略族 / IR,
  // 打开「策略构建」并预填(IR + 周期 + 一句描述)。只读一次,处理完把参数从地址栏去掉。
  const [matrixSeed, setMatrixSeed] = useState<{ study_id: string; label: string } | null>(null);
  const matrixHandled = useRef(false);
  useEffect(() => {
    if (matrixHandled.current) return;
    matrixHandled.current = true;
    const p = embedded ? new URLSearchParams(seedFromProps ? { matrix_study: seedFromProps.study, trial: seedFromProps.trial } : {}) : new URLSearchParams(hashQuery()), sid = p.get('matrix_study'), trial = p.get('trial');
    if (!sid || !trial) return;
    void matrixApi.trial(sid, trial).then((d) => {
      const c = d.cell, fam = c.family_name ?? familyLabel(c.family), side = c.side === 'long' ? t('做多') : t('做空');
      const label = `${c.symbol.replace(/USDT$/, '')} ${c.timeframe} · ${fam} · ${side}`;
      const m = d.scorecard?.metrics;
      setSeedIr({ ir: d.ir, timeframe: c.timeframe });
      setSeedAsset({ symbol: c.symbol, timeframe: c.timeframe, market: c.market });
      setBuilderSeedText(t('来自批量验证:{label}({market})。选择段 {ret},{n} 笔。在这里逐条改规则,再回测。', { label, market: c.market === 'perp' ? t('永续') : t('现货'), ret: m ? `${m.total_return >= 0 ? '+' : ''}${(m.total_return * 100).toFixed(1)}%` : '—', n: m?.trades ?? '—' }));
      setMatrixSeed({ study_id: sid, label });
      openPanel('builder');
    }).catch((e: Error) => toast.error(e.message)).finally(() => { if (!embedded) window.history.replaceState(null, '', '#research'); });
  }, []);

  /** 对话里点一张图/表:打开右侧结果面板,并把它记成追问的引用对象。 */
  const openArtifact = (id: string) => {
    setSelectedArtifactId(id);
    openPanel('artifact');
    patchContext({ ...context, selected_artifact_id: id });
  };
  const openRun = (id: string) => {
    setSelectedId(id);
    openPanel('run');
    patchContext({ ...context, selected_run_id: id, selected_artifact_id: null, selected_inquiry_id: null, selected_window: null });
  };

  const submitRevision = async (command: ResearchRevisionCommand, key: string) => {
    const sid = await ensureSession();
    if (!sid) throw Error(t('无法创建会话，请稍后重试'));
    const response = await researchApi.researchCommand(sid, { command, idempotency_key: key });
    qc.setQueryData<ResearchSessionDetail>(['research', 'session', sid], (old) => old ? { ...old,
      messages: old.messages.some((m) => m.id === response.message.id) ? old.messages : [...old.messages, response.message],
      inquiries: old.inquiries.some((q) => q.id === response.inquiry.id) ? old.inquiries : [...old.inquiries, response.inquiry],
    } : old);
    await qc.invalidateQueries({ queryKey: ['research', 'session', sid], exact: true });
    void qc.invalidateQueries({ queryKey: ['research', 'sessions'] });
    void qc.invalidateQueries({ queryKey: ['research', 'revision-context'] });
    setNarrowView('chat');
  };

  // 默认选中:正在跑的 → 最近一条。只记住选择,不自动展开结果面板(默认是 chat_only)。
  useEffect(() => {
    if (selectedId && runs.some((r) => r.id === selectedId)) return;
    const active = capsQ.data?.active_run_id;
    const pick = (active && runs.find((r) => r.id === active)) || runs[0];
    if (pick) setSelectedId(pick.id);
  }, [runs, capsQ.data?.active_run_id, selectedId]);

  const selectedSummary = runs.find((r) => r.id === selectedId) ?? null;
  const live = selectedSummary ? ['queued', 'running', 'cancelling'].includes(selectedSummary.status) : false;
  const runQ = useQuery({
    queryKey: ['research', 'run', selectedId],
    queryFn: () => researchApi.run(selectedId!),
    enabled: !!selectedId,
    refetchInterval: live ? 2_000 : false,
  });
  const run = runQ.data ?? selectedSummary;
  const resultQ = useQuery({
    queryKey: ['research', 'result', selectedId],
    queryFn: () => researchApi.result(selectedId!),
    enabled: !!selectedId && !!run?.result_ready,
    staleTime: 60_000,
  });
  const progressQ = useQuery<ResearchEvent | null>({ queryKey: ['research', 'progress', selectedId], queryFn: async () => null, enabled: false, staleTime: Infinity });

  const cancelM = useMutation({
    mutationFn: (id: string) => researchApi.cancel(id),
    onSuccess: () => {
      toast.success(t('已请求取消:当前模型调用返回或超时后停止'));
      void qc.invalidateQueries({ queryKey: ['research'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openNew = (parent: ResearchRunSummary | null, opts: { universe?: ResearchUniverse | null; ir?: { ir: StrategyIR; timeframe: string; warmup?: number } | null } = {}) => {
    setParentForNext(parent);
    if (opts.universe !== undefined) setSeedUniverse(opts.universe);
    if (opts.ir !== undefined) setSeedIr(opts.ir);
    setSheetOpen(true);
  };

  const chatHidden = narrow && panelOpen && narrowView === 'panel';
  const panelHidden = !panelOpen || (narrow && narrowView === 'chat');

  return (
    <Workspace className="flex h-full min-h-0">
      <StrategySettings runId={settingsRunId} open={!!settingsRunId} onClose={() => setSettingsRunId(null)} onCommand={submitRevision} onSelectVersion={(id) => { openRun(id); setSettingsRunId(null); }} />
      {!chatHidden ? (
        <SessionSidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((v) => !v)}
          sessions={sessions}
          loading={sessionsQ.isLoading}
          unavailable={sessionsUnavailable}
          activeId={sessionId}
          onSelect={(id) => { if (id !== sessionId) selectSession(id); }}
          onNew={() => createM.mutate({ preserveChat: false, owner: chatInstanceRef.current })}
          creating={createM.isPending}
          legacyTurns={legacyTurns}
          onOpenLegacy={() => setLegacyOpen(true)}
          onOpenHistory={() => setHistoryOpen(true)}
          runCount={runs.length}
          onOpenMatrix={embedded && onBackToScout ? () => onBackToScout('') : () => openPanel('matrix')}
        />
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-layout={layout} style={{ display: chatHidden ? 'none' : 'flex' }}>
        {linkedStrategyId ? (
          <div className="flex shrink-0 items-center gap-2 border-b bg-primary/5 px-3 py-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="size-3 text-primary" />
            <span>{t('正在为「我的策略」里的草稿构建:这个会话里的回测会自动存成它的版本')}</span>
            <a className="ml-auto text-primary hover:underline" href={`#my-strategies?id=${encodeURIComponent(linkedStrategyId)}`}>{t('查看策略')}</a>
            <button className="text-muted-foreground hover:text-foreground" onClick={() => setLinkedStrategyId(null)} title={t('隐藏')}><X className="size-3" /></button>
          </div>
        ) : null}
        {!embedded ? <div className="shrink-0 border-b px-3 py-1"><DivisionNote here="research" /></div> : null}
        {matrixSeed ? (
          <div className="flex shrink-0 items-center gap-2 border-b bg-primary/5 px-3 py-1.5 text-[11px] text-muted-foreground">
            <Grid3x3 className="size-3 text-primary" />
            <span>{t('从批量验证带过来:{label},已放进「策略构建」', { label: matrixSeed.label })}</span>
            <a className="ml-auto text-primary hover:underline" href={`#matrix-study?id=${encodeURIComponent(matrixSeed.study_id)}`} onClick={embedded && onBackToScout ? (e) => { e.preventDefault(); onBackToScout(matrixSeed.study_id); } : undefined}>{embedded ? t('回到海选') : t('回到批量验证')}</a>
            <button className="text-muted-foreground hover:text-foreground" onClick={() => setMatrixSeed(null)} title={t('隐藏')}><X className="size-3" /></button>
          </div>
        ) : null}
        <SessionChat
          key={chatInstance}
          sessionId={sessionId}
          sessionsUnavailable={sessionsUnavailable}
          context={context}
          onClearContext={() => patchContext({ ...context, selected_artifact_id: null, selected_run_id: null, selected_window: null, selected_inquiry_id: null })}
          onEnsureSession={ensureSession}
          onOpenArtifact={openArtifact}
          onOpenRun={openRun}
          onOpenSettings={setSettingsRunId}
          onOpenHistory={() => setHistoryOpen(true)}
          panelOpen={panelOpen}
          onShowPanel={() => openPanel(view)}
          narrow={narrow}
        />
      </div>

      {!narrow && panelOpen ? (
        <div
          role="separator"
          aria-orientation="vertical"
          title={t('拖动调整结果面板宽度')}
          className="w-[3px] shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60"
          onMouseDown={(e) => {
            dragRef.current = {
              x: e.clientX,
              w: e.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? panelWidth,
              max: Math.max(0, (e.currentTarget.parentElement?.getBoundingClientRect().width ?? window.innerWidth) - (sidebarCollapsed ? 36 : 228) - 383),
            };
            document.body.style.userSelect = 'none';
          }}
        />
      ) : null}

      {/* 结果面板:关闭 = display:none,不卸载,保住选中的产物 / 实验 / tab / 滚动 */}
      <div
        className="min-h-0 min-w-0 flex-col border-l"
        style={panelHidden ? { display: 'none' } : narrow ? { display: 'flex', flex: '1 1 0%' } : { display: 'flex', flex: '0 0 auto', width: panelWidth, maxWidth: `calc(100% - ${sidebarCollapsed ? 36 : 228}px - 383px)` }}
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/40 px-2">
          {PANEL_VIEWS.filter((v) => !(embedded && v === 'matrix')).map((v) => (
            <Button key={v} size="xs" variant={view === v ? 'secondary' : 'ghost'} onClick={() => setView(v)}>
              {v === 'artifact' ? <LineChart /> : v === 'run' ? <FlaskConical /> : v === 'builder' ? <Wand2 /> : v === 'pine' ? <Braces /> : v === 'matrix' ? <Grid3x3 /> : <Telescope />} {PANEL_VIEW_LABEL[v]}
            </Button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            {(context.selected_run_id || (view === 'run' && selectedId)) ? <Button size="xs" variant="ghost" onClick={() => setSettingsRunId(context.selected_run_id || selectedId)}>{t('设置')}</Button> : null}
            {narrow ? (
              <Button size="xs" variant="ghost" onClick={() => setNarrowView('chat')}>
                {t('回到对话')}
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => setPanelOpen(false)} title={t('关闭结果面板;任务继续跑,选中的产物和滚动位置都保留')}>
              <X /> {t('关闭')}
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {view === 'artifact' ? (
            <ArtifactResultPanel
              artifactId={selectedArtifactId}
              onMeta={(a) => {
                if (a.window && a.id === selectedArtifactId && context.selected_artifact_id === a.id && !context.selected_window) {
                  patchContext({ ...context, selected_artifact_id: a.id, selected_window: a.window });
                }
              }}
            />
          ) : view === 'matrix' ? (
            <MatrixStudyPanel />
          ) : view === 'pine' ? (
            <PineCatalogPanel />
          ) : view === 'screen' ? (
            <UniverseScreenPanel onNewExperiment={(u) => openNew(null, { universe: u })} />
          ) : view === 'builder' ? (
            <StrategyBuilder
              key={matrixSeed ? `matrix:${matrixSeed.label}` : 'builder'}
              initialIr={seedIr?.ir ?? run?.manifest.request.strategy_ir ?? null}
              initialTimeframe={seedIr?.timeframe}
              seedText={builderSeedText}
              onUseIr={(ir, timeframe, warmup) => openNew(null, { ir: { ir, timeframe, warmup } })}
              execution={run?.manifest.request.execution ?? { ...DEFAULT_EXEC, sizing_mode: 'unit_notional' }}
              orderGate={frozenGate(run?.manifest.request.order_gate)}
              seedDatasetId={run?.manifest.request.dataset_id ?? null}
              seedAsset={matrixSeed ? seedAsset : null}
            />
          ) : run ? (
            <>
              <SandboxAgentChat
                selectedRun={run}
                onRunStarted={(id) => {
                  setSelectedId(id);
                  openPanel('run');
                }}
              />
              <div className="flex min-h-0 flex-1 flex-col">
                <RunDetail
                  run={run}
                  result={resultQ.data?.result ?? null}
                  resultLoading={resultQ.isLoading}
                  progress={progressQ.data ?? null}
                  onCancel={() => cancelM.mutate(run.id)}
                  cancelling={cancelM.isPending}
                  onNext={() => openNew(run)}
                />
              </div>
            </>
          ) : (
            <>
              <SandboxAgentChat
                selectedRun={null}
                onRunStarted={(id) => {
                  setSelectedId(id);
                  openPanel('run');
                }}
              />
              <EmptyState onNew={() => openNew(null)} loading={runsQ.isLoading} unsupported={capsQ.data?.unsupported ?? []} />
            </>
          )}
        </div>
      </div>

      <LegacyChatSheet open={legacyOpen} onOpenChange={setLegacyOpen} turns={legacyTurns} />
      <HistoryDrawer
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        runs={runs}
        selectedId={selectedId}
        activeId={capsQ.data?.active_run_id ?? null}
        loading={runsQ.isLoading}
        onSelect={(id) => {
          openRun(id);
          setHistoryOpen(false);
        }}
        onNew={() => {
          setHistoryOpen(false);
          openNew(null);
        }}
      />
      <NewExperimentSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        parent={parentForNext}
        seedUniverse={seedUniverse}
        seedIr={seedIr}
        onStarted={(id) => {
          setSelectedId(id);
          openPanel('run');
          setSheetOpen(false);
        }}
      />
    </Workspace>
  );
}

// ---------------------------------------------------------------------------
// 空态

function EmptyState({ onNew, loading, unsupported }: { onNew: () => void; loading: boolean; unsupported: string[] }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <FlaskConical className="size-8 text-muted-foreground/60" />
      <div className="max-w-md space-y-1">
        <div className="text-[15px] font-semibold">{loading ? t('读取实验列表…') : t('还没有实验')}</div>
        <p className="text-[12px] text-muted-foreground">{t('选一段来源明确的 OKX 现货历史 K 线,冻结一条策略,跑 A/B/C 三臂回放:同一份数据上,固定规则、代理自由判断、规则出候选代理筛选,各自独立持仓、独立记账。')}</p>
      </div>
      <Button size="sm" onClick={onNew}>
        <Beaker /> {t('新建实验')}
      </Button>
      {unsupported.length ? <p className="text-[11px] text-muted-foreground">{t('本版不支持')}:{unsupported.join(' · ')}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 旧对话(只读):第三轮那套本机 localStorage 记录。不迁移、不重放、不能再发新问题,
// 但原消息、任务树、工具调用轨迹与产物引用一条不少,还能翻出来看。

function LegacyChatSheet({ open, onOpenChange, turns }: { open: boolean; onOpenChange: (v: boolean) => void; turns: ResearchChatTurn[] }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-[560px] max-w-[94vw] flex-col gap-0 p-0 sm:max-w-[560px]">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-[14px]">
            <History className="size-4" /> {t('旧对话(只读)')} <span className="num text-[11px] text-muted-foreground">{turns.length}</span>
          </SheetTitle>
          <SheetDescription className="text-[11.5px]">{t('本机保存的旧研究问答(围绕单次实验的一问一答)。新会话不导入它们,这里只做留档查看。')}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-3">
            {!turns.length ? <div className="text-[12px] text-muted-foreground">{t('本机没有旧对话记录。')}</div> : null}
            {turns.map((turn) => (
              <div key={turn.id} className={cn('space-y-1.5', turn.role === 'user' ? 'pl-8' : 'pr-2')}>
                {turn.role === 'user' ? (
                  <div className="rounded-md bg-primary/10 px-2.5 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap">{turn.text}</div>
                ) : (
                  <div className="rounded-md bg-muted/40 px-2.5 py-2 text-[12.5px] leading-relaxed">
                    {turn.tasks?.length ? (
                      <details className="mb-1.5 group">
                        <summary className="cursor-pointer text-[11px] text-muted-foreground select-none">{t('做了 {n} 步', { n: turn.tasks.length })}</summary>
                        <div className="mt-1">
                          <TaskTree tasks={turn.tasks} compact />
                        </div>
                      </details>
                    ) : null}
                    <FinalWithArtifacts text={turn.text} artifacts={turn.artifacts ?? []} />
                  </div>
                )}
                {turn.error ? <div className="text-[11px] text-down">{turn.error}</div> : null}
                {turn.role === 'agent' && turn.trace?.length ? (
                  <details className="group">
                    <summary className="cursor-pointer text-[10.5px] text-muted-foreground select-none">{t('工具调用 {n} 轮', { n: turn.trace.length })}</summary>
                    <div className="mt-1">
                      <TraceSteps trace={turn.trace} />
                    </div>
                  </details>
                ) : null}
                <div className="num text-[10px] text-muted-foreground">{fmtDateTime(turn.at)}</div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 沙箱研究代理(高级):第三轮那套 POST /api/research/chat —— 模型在沙箱里写脚本分析选中的实验,
// 回任务树 / 工具调用轮 / artifact。它回答的是「这次实验怎么了」,和会话式研究(§9.44)不是一件事,
// 所以收进右侧「实验」视图,默认折叠;记录仍写 localStorage tg.research.chat。

function SandboxAgentChat({ selectedRun, onRunStarted }: { selectedRun: ResearchRunSummary | null; onRunStarted: (id: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ResearchChatTurn[]>(loadChat);
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    saveChat(turns);
  }, [turns]);
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, open]);

  // 发送期间 SSE research.chat 会按 chat_id 推任务树;发送前不知道 id,用「最新 chat_id」桥接
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const latestChatQ = useQuery<string | null>({ queryKey: ['research', 'chat-live', 'latest'], queryFn: async () => null, enabled: false, staleTime: Infinity });
  const liveId = latestChatQ.data ?? null;
  const liveQ = useQuery<ResearchChatEvent[]>({ queryKey: ['research', 'chat-live', liveId], queryFn: async () => [], enabled: false, staleTime: Infinity });
  const liveEvents = (liveQ.data ?? []).filter((e) => sendStartedAt === null || e.at >= sendStartedAt - 2_000);
  const liveTasks = tasksFromEvents(liveEvents);
  const liveArtifacts = liveEvents.filter((e) => e.event === 'artifact').map((e) => String(e.data['id'] ?? ''));

  const sendM = useMutation({
    mutationFn: (message: string) => researchApi.chatWithRounds(message, selectedRun?.id, 24),
    onMutate: (message) => {
      setSendStartedAt(Date.now());
      setTurns((cur) => [...cur, { id: stableKey(), at: Date.now(), role: 'user', text: message }]);
    },
    onSuccess: (r) => {
      setTurns((cur) => [...cur, { id: r.id, at: Date.now(), role: 'agent', text: r.final, trace: r.trace, error: r.error ?? null, chat_id: r.id, tasks: r.tasks ?? (liveTasks.length ? liveTasks : undefined), artifacts: r.artifacts ?? (liveArtifacts.length ? liveArtifacts.map((id) => ({ id, kind: 'chart' as const, title: '' })) : undefined) }]);
      setSendStartedAt(null);
      // 代理可能发起了实验:刷新列表,并把新 job 选中
      void qc.invalidateQueries({ queryKey: ['research', 'runs'] });
      for (const step of r.trace) {
        const call = step.call as { tool?: string } | null;
        const res = step.result as { id?: string; status?: string } | null;
        if (call?.tool?.startsWith('experiments.') && res?.id && res.status) onRunStarted(res.id);
      }
    },
    onError: (e: Error) => {
      setSendStartedAt(null);
      setTurns((cur) => [...cur, { id: stableKey(), at: Date.now(), role: 'agent', text: t('研究代理调用失败'), error: e.message }]);
    },
  });

  const submit = () => {
    const msg = text.trim();
    if (!msg || sendM.isPending) return;
    setText('');
    sendM.mutate(msg);
  };

  // 建议问法只在有选中实验时给:没有 run 就问不出「这几笔亏在哪」
  const closedTrades = selectedRun?.metrics.find((m) => m.arm.startsWith('a_rules'))?.metrics.closed_trades ?? selectedRun?.metrics[0]?.metrics.closed_trades ?? 0;
  const suggestions = selectedRun
    ? [closedTrades > 0 ? t('这 {n} 笔亏在哪?', { n: closedTrades }) : t('这一轮为什么一笔交易都没有?'), t('B 和 A 哪里不同?'), t('这段历史里成本吃掉了多少毛利?')]
    : [];

  return (
    <div className="shrink-0 border-b">
      <div className="flex h-7 items-center gap-1.5 bg-muted/30 px-2 text-[11px] select-none">
        <button type="button" className="inline-flex items-center gap-1.5 text-foreground/85 hover:text-foreground" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <Bot className="size-3" />
          <span className="font-medium">{t('沙箱研究代理(高级)')}</span>
        </button>
        <span className="text-[10px] text-muted-foreground">{selectedRun ? t('围绕当前实验,只读') : t('先选中一个实验')}</span>
        <span className="num ml-auto text-[10px] text-muted-foreground">{turns.length}</span>
        {turns.length ? (
          <Button size="xs" variant="ghost" onClick={() => setTurns([])}>
            {t('清空')}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex max-h-[320px] flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-2.5">
              {!turns.length ? <div className="text-[11.5px] text-muted-foreground">{t('让模型在沙箱里写脚本分析这次实验:任务树、每一轮工具调用与产物都会留痕。')}</div> : null}
              {turns.map((turn) => (
                <div key={turn.id} className={cn('space-y-1.5', turn.role === 'user' ? 'pl-8' : 'pr-2')}>
                  {turn.role === 'user' ? (
                    <div className="rounded-md bg-primary/10 px-2.5 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap">{turn.text}</div>
                  ) : (
                    <div className="rounded-md bg-muted/40 px-2.5 py-2 text-[12.5px] leading-relaxed">
                      {turn.tasks?.length ? (
                        <details className="mb-1.5 group">
                          <summary className="cursor-pointer text-[11px] text-muted-foreground select-none">{t('做了 {n} 步', { n: turn.tasks.length })}</summary>
                          <div className="mt-1">
                            <TaskTree tasks={turn.tasks} compact />
                          </div>
                        </details>
                      ) : null}
                      <FinalWithArtifacts text={turn.text} artifacts={turn.artifacts ?? []} />
                    </div>
                  )}
                  {turn.error ? <div className="text-[11px] text-down">{turn.error}</div> : null}
                  {turn.role === 'agent' && turn.trace?.length ? (
                    <details className="group">
                      <summary className="cursor-pointer text-[10.5px] text-muted-foreground select-none">{t('工具调用 {n} 轮', { n: turn.trace.length })}</summary>
                      <div className="mt-1">
                        <TraceSteps trace={turn.trace} />
                      </div>
                    </details>
                  ) : null}
                </div>
              ))}
              {sendM.isPending ? (
                <div className="space-y-1.5 rounded-md border border-dashed px-2.5 py-2">
                  <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <span className="typing-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                    {liveTasks.length ? t('研究代理在工作…') : t('研究代理在读实验…')}
                  </div>
                  <TaskTree tasks={liveTasks} compact />
                  {liveArtifacts.map((id) => (
                    <ArtifactCard key={id} id={id} inline />
                  ))}
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
          <div className="shrink-0 border-t p-2">
            {suggestions.length ? (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button key={s} type="button" className="rounded-md border px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setText(s)}>
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={selectedRun ? t('围绕这次实验提问,例如:这几笔亏在哪?') : t('先选中一个实验再提问。')}
              className="min-h-[52px] resize-none text-[12.5px]"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-[10.5px] text-muted-foreground">{t('B/C 臂与研究对话会消耗当前大脑额度;先用小窗口和硬上限。')}</span>
              <Button size="xs" onClick={submit} disabled={!text.trim() || sendM.isPending}>
                <Send /> {t('发送')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TraceSteps({ trace }: { trace: ResearchChatTurn['trace'] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!trace?.length) return null;
  return (
    <ol className="space-y-0.5 border-l pl-2.5">
      {trace.map((step) => {
        const call = step.call as { tool?: string; args?: unknown; final?: string } | null;
        const res = step.result as { error?: string; id?: string; status?: string } | null;
        const failed = !!res && typeof res === 'object' && 'error' in res && !!res.error;
        const tool = call?.tool ?? (call?.final ? t('结论') : '?');
        return (
          <li key={step.round} className="text-[11px]">
            <button type="button" className="flex w-full items-center gap-1.5 text-left hover:text-foreground" onClick={() => setOpen(open === step.round ? null : step.round)}>
              <span className={cn('inline-block size-1.5 rounded-full', failed ? 'bg-down' : 'bg-up')} />
              <span className="num text-muted-foreground">#{step.round}</span>
              <span className="font-medium">{tool}</span>
              {res?.id && res.status ? <span className="text-muted-foreground">→ {res.id.slice(0, 8)} {STATUS_LABEL[res.status as ResearchRunStatus] ?? res.status}</span> : null}
              {failed ? <span className="text-down">{t('失败')}</span> : null}
            </button>
            {open === step.round ? (
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[10.5px] whitespace-pre-wrap">{JSON.stringify({ args: call?.args, result: step.result }, null, 1)}</pre>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// 历史抽屉:原来的左下实验列表,默认收起;原 ID、状态、时间、参数、结果一条不少

function HistoryDrawer({
  open,
  onOpenChange,
  runs,
  selectedId,
  onSelect,
  onNew,
  activeId,
  loading,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  runs: ResearchRunSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  activeId: string | null;
  loading: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-[380px] max-w-[92vw] flex-col gap-0 p-0 sm:max-w-[380px]">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-[14px]">
            <History className="size-4" /> {t('实验历史')} <span className="num text-[11px] text-muted-foreground">{runs.length}</span>
            <Button size="xs" variant="outline" className="ml-auto" onClick={onNew}>
              <Beaker /> {t('新建')}
            </Button>
          </SheetTitle>
          <SheetDescription className="text-[11.5px]">{t('每条都是冻结的一次 run:数据、策略、成本、大脑任一项不同都是新 run,旧结果不会被覆盖。')}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          {loading ? <div className="p-3 text-[12px] text-muted-foreground">{t('读取中…')}</div> : null}
          {!loading && !runs.length ? <div className="p-3 text-[12px] text-muted-foreground">{t('还没有实验。')}</div> : null}
          <ul className="divide-y">
            {runs.map((r) => {
              const a = r.metrics.find((m) => m.arm.startsWith('a_rules'))?.metrics;
              const best = r.metrics.filter((m) => !m.arm.startsWith('a_rules'));
              return (
                <li key={r.id}>
                  <button type="button" onClick={() => onSelect(r.id)} className={cn('flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-accent/60', selectedId === r.id && 'bg-accent')}>
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[12.5px] font-medium">{strategyLabelOf(r.manifest.request).label || t('未命名策略')}</span>
                      <Badge variant="outline" className={cn('ml-auto h-4 px-1.5 text-[10px]', statusClass(r.status))}>
                        {activeId === r.id && r.status === 'running' ? <span className="progress-spinner" /> : null}
                        {STATUS_LABEL[r.status] ?? r.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
                      <span className="num">#{r.manifest.trial_number}</span>
                      <span>{r.manifest.request.purpose}</span>
                      <span>{r.manifest.request.arms.map((x) => x[0]!.toUpperCase()).join('/')}{r.manifest.request.repeats > 1 ? `×${r.manifest.request.repeats}` : ''}</span>
                      <span className="num ml-auto">{fmtDateTime(r.created_at)}</span>
                    </div>
                    {a || best.length ? (
                      <div className="flex items-center gap-3 text-[10.5px]">
                        {a ? (
                          <span>
                            A <span className={cn('num', tone(a.net_return))}>{signedPct(a.net_return)}</span>
                          </span>
                        ) : null}
                        {best.slice(0, 2).map((m) => (
                          <span key={m.arm}>
                            {m.arm.split(':')[0]![0]!.toUpperCase()} <span className={cn('num', tone(m.metrics.net_return))}>{signedPct(m.metrics.net_return)}</span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 右栏:策略卡 + 结果

interface DetailProps {
  run: ResearchRunSummary;
  result: import('@/api/research-types').ResearchResult | null;
  resultLoading: boolean;
  progress: ResearchEvent | null;
  onCancel: () => void;
  cancelling: boolean;
  onNext: () => void;
}

function RunDetail({ run, result, resultLoading, progress, onCancel, cancelling, onNext }: DetailProps) {
  const req = run.manifest.request;
  const live = ['queued', 'running', 'cancelling'].includes(run.status);
  // 答案层 / 高级:七个分页一个不少,只是默认收在「高级」里
  const [mode, setMode] = useState<'answer' | 'advanced'>('answer');
  const [tab, setTab] = useState('overview');
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const arms = result?.arms ?? [];
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = useMemo(() => new Set(arms.map((a) => a.arm).filter((a) => !hidden.has(a))), [arms, hidden]);
  const [chartMode, setChartMode] = useState<ArmChartMode>('equity');
  const [primaryArm, setPrimaryArm] = useState<string | null>(null);
  const [showMeta, setShowMeta] = useState(false);
  useEffect(() => {
    if (arms.length && (!primaryArm || !arms.some((a) => a.arm === primaryArm))) setPrimaryArm(arms[0]!.arm);
  }, [arms, primaryArm]);
  const primary = arms.find((a) => a.arm === primaryArm) ?? arms[0] ?? null;
  const partial = !!result && result.status !== 'completed';
  const dsQ = useQuery({ queryKey: ['research', 'datasets'], queryFn: researchApi.datasets, staleTime: 60_000 });
  const dataset = dsQ.data?.items.find((d) => d.id === req.dataset_id) ?? null;
  const dataSynthetic = dataset?.venue === 'synthetic';
  const progressData = progress?.event === 'progress' && progress.run_id === run.id ? (progress.data as { arm?: string; done?: number; total?: number; equity?: string }) : null;
  // 规则卡:有 IR 就打一次零模型 compile(缓存到 policy_hash),老模板 run 本地翻 policy
  const { source: rulesSource } = useRunRules({
    ir: req.strategy_ir,
    policy: req.policy,
    execution: req.execution,
    orderGate: req.order_gate,
    timeframe: dataset?.timeframe_ms ? tfLabel(dataset.timeframe_ms) : '1h',
    datasetId: req.dataset_id ?? null,
    cacheKey: run.manifest.policy_hash,
  });

  const replayM = useMutation({
    mutationFn: () => researchApi.replay(run.id),
    onSuccess: (r) => (r.verified ? toast.success(t('零模型调用重放一致:{h}', { h: r.actual_hash.slice(0, 12) })) : toast.error(t('重放结果哈希不一致:期望 {a},实际 {b}', { a: r.expected_hash.slice(0, 12), b: r.actual_hash.slice(0, 12) }))),
    onError: (e: Error) => toast.error(e.message),
  });
  const exportM = useMutation({
    mutationFn: () => researchApi.exportRun(run.id),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `research-${run.id.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <header className="shrink-0 border-b px-4 pt-3 pb-2">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/40">
            <FlaskConical className="size-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[16px] leading-snug font-semibold">{readableTitle(run, dataset)}</h1>
              <Badge variant="outline" className={cn('h-5 px-1.5 text-[10.5px]', statusClass(run.status))}>
                {live ? <span className="progress-spinner" /> : null}
                {STATUS_LABEL[run.status] ?? run.status}
              </Badge>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{strategyLabelOf(req).description}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground">
              <span>{t('历史回测,不是实盘')}</span>
              <span>
                {t('截至')} <span className="num">{fmtDateTime(req.to_ms)}</span>
              </span>
              <span className={cn(dataSynthetic && 'text-down')}>
                {t('数据来源')} {dataSynthetic ? t('合成行情,只用于工程联调') : (dataset?.venue ?? t('未知'))}
              </span>
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => setShowMeta((v) => !v)}>
                {showMeta ? t('收起方法与复现') : t('方法与复现')}
              </button>
            </div>
            {/* 方法与复现:hash / trial / purpose / 引擎 / 大脑 都在这里,不进标题行 */}
            <div className={cn('mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[10.5px] text-muted-foreground', !showMeta && 'hidden')}>
              <span>
                {t('试验')} <span className="num text-foreground/80">#{run.manifest.trial_number}</span> · {req.purpose}
              </span>
              {req.parent_run_id ? (
                <span>
                  {t('父实验')} <span className="num text-foreground/80">{req.parent_run_id.slice(0, 8)}</span>
                </span>
              ) : null}
              <span>
                policy <span className="num text-foreground/80">{short(run.manifest.policy_hash)}</span>
              </span>
              <span>
                {t('数据')} <span className="num text-foreground/80">{short(run.manifest.dataset_hash)}</span>
              </span>
              <span>
                {t('来源策略')} <span className="text-foreground/80">{req.source_strategy_ref ?? t('无(A/C 用机械解释)')}</span>
              </span>
              <span>
                {t('大脑')} <span className="text-foreground/80">{run.manifest.brain.name}{run.manifest.brain.model ? ` · ${run.manifest.brain.model}` : ''}</span>
              </span>
              <span>
                {t('引擎')} <span className="num text-foreground/80">{run.manifest.engine_version}</span>
              </span>
              <span>
                {t('窗口')} <span className="num text-foreground/80">{fmtDateTime(req.from_ms)} → {fmtDateTime(req.to_ms)}</span>
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {live ? (
              <Button size="sm" variant="outline" onClick={onCancel} disabled={cancelling || run.status === 'cancelling'}>
                <Ban /> {t('取消')}
              </Button>
            ) : null}
            {run.status === 'completed' ? (
              <Button size="sm" variant="outline" onClick={() => replayM.mutate()} disabled={replayM.isPending}>
                <ShieldCheck /> {t('重放核验')}
              </Button>
            ) : null}
            {run.result_ready ? (
              <Button size="sm" variant="outline" onClick={() => exportM.mutate()} disabled={exportM.isPending}>
                <Download /> {t('导出')}
              </Button>
            ) : null}
            {!live ? (
              <Button size="sm" onClick={onNext}>
                <Sparkles /> {t('下一次实验')}
              </Button>
            ) : null}
          </div>
        </div>
        {live ? (
          <div className="mt-2 rounded-md border bg-muted/30 px-3 py-2 text-[11.5px]">
            {progressData ? (
              <div className="flex items-center gap-3">
                <span>{armLabel(progressData.arm ?? '')}</span>
                <span className="num">
                  {progressData.done ?? 0} / {progressData.total ?? '?'} bars
                </span>
                {progressData.equity ? <span className="num">equity {dec(progressData.equity)}</span> : null}
                <div className="ml-auto h-1 w-40 overflow-hidden rounded bg-muted">
                  <div className="progress-indicator h-full bg-primary" style={{ transform: `scaleX(${progressData.total ? Math.min(1, (progressData.done ?? 0) / progressData.total) : 0})`, transformOrigin: 'left' }} />
                </div>
              </div>
            ) : (
              <span className="text-muted-foreground">{run.status === 'queued' ? t('排队中,等待引擎推进时钟') : run.status === 'cancelling' ? t('取消中:等当前模型调用返回或超时') : t('运行中,等第一条进度事件…')}</span>
            )}
          </div>
        ) : null}
        {run.error ? <div className="mt-2 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-[11.5px] text-down">{run.error}</div> : null}
        {partial ? <div className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] text-warn">{t('不完整实验({s}):只展示部分结果,没有 A/B/C 比较结论。', { s: STATUS_LABEL[result!.status] ?? result!.status })}</div> : null}
      </header>

      {!result ? (
        <div className="flex flex-1 items-center justify-center p-8 text-[12.5px] text-muted-foreground">{resultLoading ? t('读取结果…') : live ? t('结果会在实验结束后出现') : run.error ?? t('没有结果')}</div>
      ) : mode === 'answer' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-4">
            <span className="kicker text-foreground/85">{t('答案')}</span>
            {arms.length > 1 ? <ArmPicker arms={arms} value={primary?.arm ?? null} onChange={setPrimaryArm} /> : null}
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setMode('advanced')}>
              <ChevronRight /> {t('高级')}
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <AnswerLayer
              run={run}
              result={result}
              arm={primary}
              arms={arms}
              visible={visible}
              focusAt={focusAt}
              rulesSource={rulesSource}
              synthetic={dataSynthetic}
              dataset={dataset}
              onSeeTrades={() => {
                setMode('advanced');
                setTab('trades');
              }}
              onNext={onNext}
            />
          </ScrollArea>
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList variant="line" className="h-9 shrink-0 gap-3 border-b px-4">
            <TabsTrigger value="overview">{t('概览')}</TabsTrigger>
            <TabsTrigger value="trades">{t('交易')}</TabsTrigger>
            <TabsTrigger value="decisions">{t('决策与差异')}</TabsTrigger>
            <TabsTrigger value="diagnostics">{t('诊断')}</TabsTrigger>
            <TabsTrigger value="evaluation">{t('候选评估')}</TabsTrigger>
            <TabsTrigger value="evidence">{t('证据')}</TabsTrigger>
            <TabsTrigger value="setup">{t('实验设置')}</TabsTrigger>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setMode('answer')}>
              {t('回到答案')}
            </Button>
          </TabsList>
          <TabsContent value="overview" className="flex min-h-0 flex-1 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 p-4">
                <ArmSwitch arms={arms} primary={primary?.arm ?? null} onPrimary={setPrimaryArm} hidden={hidden} onToggle={(arm) => setHidden((cur) => { const n = new Set(cur); n.has(arm) ? n.delete(arm) : n.add(arm); return n; })} />
                {primary ? <MetricStrip metrics={primary.metrics} pendingAtEnd={primary.pending_at_end} baseline={arms.find((a) => a.arm.startsWith('a_rules') && a.arm !== primary.arm)?.metrics ?? null} decimal={!!req.spec_version} /> : null}
                <div className="rounded-md border">
                  <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
                    <span className="kicker text-foreground/85">{chartMode === 'equity' ? t('净权益(相对初始现金)') : chartMode === 'drawdown' ? t('回撤') : t('敞口')}</span>
                    <span className="text-[10.5px] text-muted-foreground">{t('bar-close 口径,费用已扣')}</span>
                    <div className="ml-auto flex gap-0.5">
                      {(['equity', 'drawdown', 'exposure'] as ArmChartMode[]).map((m) => (
                        <Button key={m} size="xs" variant={chartMode === m ? 'secondary' : 'ghost'} onClick={() => setChartMode(m)}>
                          {m === 'equity' ? t('权益') : m === 'drawdown' ? t('回撤') : t('敞口')}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="h-[300px]">
                    <ArmChart arms={arms} visible={visible} mode={chartMode} focusAt={focusAt} initialCash={Number(req.execution.initial_cash)} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                  <CostCard req={req} arms={arms} />
                  <ComparisonCard result={result} onFocus={(at) => setFocusAt(at)} />
                  <LabelsCard result={result} run={run} synthetic={dataSynthetic} />
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="trades" className="min-h-0 flex-1">
            <TradesTab arms={arms} primaryArm={primary?.arm ?? null} onPrimary={setPrimaryArm} onFocus={(at) => { setFocusAt(at); }} />
          </TabsContent>
          <TabsContent value="decisions" className="min-h-0 flex-1">
            <DecisionsTab result={result} arms={arms} onFocus={(at) => { setFocusAt(at); setTab('overview'); }} />
          </TabsContent>
          <TabsContent value="diagnostics" className="min-h-0 flex-1">
            <DiagnosticsTab arms={arms} run={run} primaryArm={primary?.arm ?? null} onPrimary={setPrimaryArm} />
          </TabsContent>
          <TabsContent value="evaluation" className="min-h-0 flex-1">
            <EvaluationTab result={result} />
          </TabsContent>
          <TabsContent value="evidence" className="min-h-0 flex-1">
            <EvidenceTab runId={run.id} />
          </TabsContent>
          <TabsContent value="setup" className="min-h-0 flex-1">
            <SetupTab run={run} rulesSource={rulesSource} />
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

/**
 * 答案层:一句结论 + 三张证据卡 + 一张主图 + 规则卡 + 两条下一步。
 * 结论由 conclusionOf 按规则生成(不是模型写的);六格指标条只在「高级」里出现。
 */
function AnswerLayer({
  run,
  result,
  arm,
  arms,
  visible,
  focusAt,
  rulesSource,
  synthetic,
  dataset,
  onSeeTrades,
  onNext,
}: {
  run: ResearchRunSummary;
  result: import('@/api/research-types').ResearchResult;
  arm: ResearchArmResult | null;
  arms: ResearchArmResult[];
  visible: Set<string>;
  focusAt: number | null;
  rulesSource: import('@/components/research-workbench/rules-card').RulesSource;
  synthetic: boolean;
  dataset: ResearchDatasetSummary | null;
  onSeeTrades: () => void;
  onNext: () => void;
}) {
  const req = run.manifest.request;
  const m = arm?.metrics ?? null;
  const n = m?.closed_trades ?? 0;
  const thin = n < 10;
  const cards: { label: string; value: string; cls?: string; sub: string }[] = [
    { label: t('区间收益(扣费后)'), value: m ? signedPct(m.net_return) : '—', cls: tone(m?.net_return), sub: m?.open_position ? t('含期末未平仓的盯市盈亏') : t('手续费与滑点已进入这条曲线') },
    { label: t('期间最大回撤'), value: m ? `-${pct(m.max_drawdown)}` : '—', cls: 'text-down', sub: t('按 bar 收盘的权益峰值算') },
    {
      label: t('交易样本数'),
      value: String(n),
      sub: n === 0 ? t('没有交易,胜率与盈亏比都不成立') : thin ? t('样本不足,胜率与盈亏比先不作结论') : `${t('胜率')} ${m?.win_rate == null ? t('样本不足') : pct(m.win_rate, 0)} · PF ${m?.profit_factor == null ? t('样本不足') : m.profit_factor.toFixed(2)}`,
    },
  ];
  return (
    <div className="mx-auto w-full max-w-[860px] space-y-4 p-4">
      <div className="rounded-md border bg-muted/20 px-3 py-2.5 text-[13px] leading-relaxed">{conclusionOf(m, run.status)}</div>

      <div className="grid grid-cols-1 divide-y rounded-md border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {cards.map((c) => (
          <div key={c.label} className="px-3 py-2.5">
            <div className="text-[10.5px] text-muted-foreground select-none">{c.label}</div>
            <div className={cn('num mt-0.5 text-[20px] font-semibold', c.cls)}>{c.value}</div>
            <div className="mt-0.5 text-[10.5px] text-muted-foreground">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="rounded-md border">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
          <span className="kicker text-foreground/85">{t('扣费后的资金变化')}</span>
          <span className="text-[10.5px] text-muted-foreground">{t('bar-close 口径,费用已扣')}</span>
        </div>
        <div className="h-[280px]">
          <ArmChart arms={arms} visible={visible} mode="equity" focusAt={focusAt} initialCash={Number(req.execution.initial_cash)} />
        </div>
        <div className="border-t px-3 py-1 text-[10.5px] text-muted-foreground">{t('同区间基准(一直持有)尚未计算,图上只有各臂自己的资金曲线。')}</div>
      </div>

      <RulesCard source={rulesSource} hint={rulesSource.fromBackend ? undefined : t('本地翻译,原始参数见「实验设置」')} />

      <div className="rounded-md border">
        <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('下一步')}</div>
        <div className="flex flex-wrap gap-2 px-3 py-2">
          <Button size="sm" variant="outline" onClick={onSeeTrades} disabled={!n}>
            {n ? t('查看这 {n} 笔交易', { n }) : t('没有交易可看')}
          </Button>
          <Button size="sm" variant="outline" onClick={onNext} title={t('打开新建实验并预填当前设置;在「分段」里换成验证段或留出段')}>
            {t('用另一段历史检验')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
        <span>
          {t('资产')} <span className="num text-foreground/80">{dataset?.symbol ?? req.universe_id ?? '—'}</span>
          {dataset?.timeframe_ms ? <span className="num"> · {tfLabel(dataset.timeframe_ms)}</span> : null}
        </span>
        <span>
          {t('窗口')} <span className="num text-foreground/80">{fmtDateTime(req.from_ms)} → {fmtDateTime(req.to_ms)}</span>
        </span>
        <span className={cn(synthetic && 'text-down')}>{synthetic ? t('合成行情,只用于工程联调') : t('来源未独立验证')}</span>
        <span>{t('「已完成」只表示计算走完,不表示策略有效。')}</span>
        {result.evaluation?.promotion ? <span>{t('晋升:{s}', { s: result.evaluation.promotion })}</span> : null}
      </div>
    </div>
  );
}

function ArmSwitch({ arms, primary, onPrimary, hidden, onToggle }: { arms: ResearchArmResult[]; primary: string | null; onPrimary: (arm: string) => void; hidden: Set<string>; onToggle: (arm: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {arms.map((a) => (
        <div key={a.arm} className={cn('flex items-center gap-1 rounded-md border pr-1', primary === a.arm ? 'border-foreground/40 bg-accent/60' : 'border-border')}>
          <button type="button" onClick={() => onPrimary(a.arm)} className="flex items-center gap-1.5 px-2 py-1 text-[11.5px]">
            <i className="inline-block h-0.5 w-3" style={{ background: armColor(a.arm) }} />
            {armLabel(a.arm)}
            <span className={cn('num', tone(a.metrics.net_return))}>{signedPct(a.metrics.net_return)}</span>
          </button>
          <input type="checkbox" className="size-3 accent-current" checked={!hidden.has(a.arm)} onChange={() => onToggle(a.arm)} title={t('在图上显示')} />
        </div>
      ))}
      <span className="text-[10.5px] text-muted-foreground">{t('点臂名切换指标条;勾选控制曲线显示。A 只跑一次作共同基准。')}</span>
    </div>
  );
}

function MetricStrip({ metrics: m, pendingAtEnd, baseline, decimal }: { metrics: ResearchMetrics; pendingAtEnd: boolean; baseline: ResearchMetrics | null; decimal: boolean }) {
  const [more, setMore] = useState(false);
  const delta = typeof baseline?.net_return === 'number' ? m.net_return - baseline.net_return : null;
  const expectancy = ratioPct(m.expectancy_pct, decimal);
  const primary: { label: string; value: number | null; format: (v: number) => string; cls?: string; sub?: string | null; hint?: string }[] = [
    { label: t('策略收益率'), value: m.net_return, format: (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`, cls: tone(m.net_return), sub: delta !== null ? `${t('vs A')} ${signedPct(delta)}` : null, hint: m.open_position ? t('含期末未平仓的盯市盈亏') : undefined },
    {
      label: t('每笔期望'),
      value: m.expectancy_pct ?? null,
      format: (v) => ratioPct(v, decimal).text,
      cls: tone(m.expectancy_pct),
      sub: expectancy.legacy ? t('旧口径:这条 run 的结果字段是百分数,已换算') : t('单位:每笔名义金额的百分比'),
      hint: t('剔除仓位因素:每笔按固定名义算的平均收益(含成本)。新 run(有 spec_version)的字段是小数,旧 run 是百分数,这里按 run 自己的口径换算。'),
    },
    { label: t('最大回撤'), value: m.max_drawdown, format: (v) => `-${(v * 100).toFixed(2)}%`, cls: 'text-down' },
    { label: t('笔数'), value: m.closed_trades, format: (v) => String(Math.round(v)) },
    { label: t('胜率'), value: m.win_rate, format: (v) => `${(v * 100).toFixed(1)}%`, hint: t('按完全平仓的 position 计') },
    { label: t('盈亏比 PF'), value: m.profit_factor, format: (v) => v.toFixed(2), hint: m.profit_factor === null ? t('没有亏损样本或没有交易') : undefined },
  ];
  const secondary: [string, string][] = [
    [t('日 Sharpe'), m.daily_sharpe === null ? t('样本不足') : m.daily_sharpe.toFixed(2)],
    [t('平均敞口'), pct(m.avg_exposure, 1)],
    [t('换手'), dec(m.turnover, 2) + '×'],
    [t('费用'), dec(m.fees, 2)],
    [t('平均净 R'), m.avg_net_r === null ? '—' : m.avg_net_r.toFixed(2)],
    [t('每笔中位'), ratioPct(m.per_trade_return_pct?.median, decimal).text],
    [t('最好 / 最差'), m.per_trade_return_pct ? `${ratioPct(m.per_trade_return_pct.best, decimal).text} / ${ratioPct(m.per_trade_return_pct.worst, decimal).text}` : '—'],
    [t('每笔标准差'), m.per_trade_return_pct?.std == null ? '—' : ratioPct(m.per_trade_return_pct.std, decimal).text],
  ];
  return (
    <div className="rounded-md border">
      <div className="grid grid-cols-3 divide-x md:grid-cols-6">
        {primary.map((c) => (
          <div key={c.label} className="px-3 py-2.5" title={c.hint}>
            <div className="text-[10.5px] text-muted-foreground select-none">{c.label}</div>
            <div className={cn('mt-0.5 text-[18px] font-semibold', c.cls)}>
              {c.value === null || c.value === undefined ? <span className="text-[13px] text-muted-foreground">{c.label === t('胜率') || c.label === t('盈亏比 PF') ? t('样本不足') : '—'}</span> : <AnimatedNumber value={c.value} format={c.format} />}
            </div>
            {c.sub ? <div className="num text-[10.5px] text-muted-foreground">{c.sub}</div> : null}
          </div>
        ))}
      </div>
      <button type="button" className="flex w-full items-center gap-2 border-t px-3 py-1 text-[10.5px] text-muted-foreground hover:text-foreground" onClick={() => setMore((v) => !v)}>
        {more ? t('收起') : t('更多指标')}
        {!more ? <span className="num ml-2 truncate">{secondary.slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' · ')}</span> : null}
      </button>
      <AnimatePresence initial={false}>
        {more ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <dl className="grid grid-cols-4 gap-x-4 gap-y-1 border-t px-3 py-2 text-[11px] md:grid-cols-7">
              {secondary.map(([k, v]) => (
                <div key={k}>
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="num">{v}</dd>
                </div>
              ))}
            </dl>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {pendingAtEnd || m.open_position ? <div className="border-t px-3 py-1 text-[10.5px] text-warn">{t('期末仍有持仓:总收益含盯市盈亏,最后一段不是已实现结果。')}</div> : null}
    </div>
  );
}

function CostCard({ req, arms }: { req: ResearchRequest; arms: ResearchArmResult[] }) {
  const e = req.execution;
  return (
    <div className="rounded-md border">
      <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('成本与执行')}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-[11.5px]">
        <dt className="text-muted-foreground">{t('费率')}</dt>
        <dd className="num">{pct(Number(e.fee_rate), 3)}</dd>
        <dt className="text-muted-foreground">{t('滑点')}</dt>
        <dd className="num">{e.slippage_bps} bps</dd>
        <dt className="text-muted-foreground">{t('单笔风险')}</dt>
        <dd className="num">{pct(Number(e.risk_fraction))} · {t('最大分配')} {pct(Number(e.max_allocation), 0)}</dd>
        <dt className="text-muted-foreground">{t('成交')}</dt>
        <dd>{t('主动买卖统一在下一根 open;止损先看跳空再看触发')}</dd>
        {arms.map((a) => (
          <Fragment key={a.arm}>
            <dt className="text-muted-foreground">{armLabel(a.arm)}</dt>
            <dd className="num">
              {t('费用')} {dec(a.metrics.fees)} · {t('换手')} {dec(a.metrics.turnover)}×
            </dd>
          </Fragment>
        ))}
      </dl>
      <div className="border-t px-3 py-1 text-[10.5px] text-muted-foreground">{t('成本已进入权益曲线,不再重复扣。')}</div>
    </div>
  );
}

function ComparisonCard({ result, onFocus }: { result: import('@/api/research-types').ResearchResult; onFocus: (at: number) => void }) {
  return (
    <div className="rounded-md border">
      <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('与 A 的配对比较')}</div>
      {!result.comparison.length ? <div className="px-3 py-2 text-[11.5px] text-muted-foreground">{t('没有比较:只跑了 A,或实验不完整。')}</div> : null}
      <ul className="divide-y">
        {result.comparison.map((c) => (
          <li key={c.arm} className="space-y-1 px-3 py-2 text-[11.5px]">
            <div className="flex items-center gap-2">
              <i className="inline-block h-0.5 w-3" style={{ background: armColor(c.arm) }} />
              <span className="font-medium">{armLabel(c.arm)}</span>
              <span className={cn('num ml-auto', tone(c.net_return_delta))}>{signedPct(c.net_return_delta)}</span>
            </div>
            <div className="flex flex-wrap gap-x-3 text-[10.5px] text-muted-foreground">
              <span>
                {t('敞口差')} <span className="num">{signedPct(c.exposure_delta, 1)}</span>
              </span>
              <span>
                {t('逐 bar 收益差 CI')}{' '}
                <span className="num">{c.paired_bar_return_ci.status === 'sufficient' && c.paired_bar_return_ci.lower !== null ? `[${signedPct(c.paired_bar_return_ci.lower, 3)}, ${signedPct(c.paired_bar_return_ci.upper, 3)}]` : t('样本不足')}</span>
              </span>
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => c.differences[0] && onFocus(c.differences[0].at)}>
                {t('{n} 处动作不同', { n: c.differences.length })}
              </button>
            </div>
            <div className="text-[10.5px] text-muted-foreground/80">{c.note}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LabelsCard({ result, run, synthetic }: { result: import('@/api/research-types').ResearchResult; run: ResearchRunSummary; synthetic: boolean }) {
  const ev = result.evaluation;
  const items: { text: string; tone: 'warn' | 'muted' | 'down' }[] = [];
  if (synthetic) items.push({ text: t('合成行情,只用于工程联调'), tone: 'down' });
  items.push({ text: t('导入来源未独立验证:{s}', { s: run.manifest.dataset_hash.slice(0, 10) }), tone: 'muted' });
  if (ev) {
    items.push({ text: t('经济证据:{s}', { s: ev.economic_evidence }), tone: ev.economic_evidence === 'synthetic_only' ? 'down' : 'muted' });
    items.push({ text: t('模型历史知识泄漏:{s}', { s: ev.model_weight_leakage }), tone: 'warn' });
    items.push({ text: t('晋升:{s}', { s: ev.promotion }), tone: 'muted' });
    if (ev.trial_count_note) items.push({ text: ev.trial_count_note, tone: 'muted' });
  }
  if (run.manifest.brain.kind === 'stub') items.push({ text: t('大脑是 stub / 脚本决策器,不能称为 LLM 表现'), tone: 'down' });
  return (
    <div className="rounded-md border">
      <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('数据与证据标签')}</div>
      <ul className="space-y-1 px-3 py-2 text-[11px]">
        {items.map((it, i) => (
          <li key={i} className={cn('flex gap-1.5', it.tone === 'down' ? 'text-down' : it.tone === 'warn' ? 'text-warn' : 'text-muted-foreground')}>
            <span>•</span>
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
      <div className="border-t px-3 py-1 text-[10.5px] text-muted-foreground">{t('「已完成」只表示计算走完,不表示策略有效。')}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 交易 / 决策 / 评估 / 证据 / 设置

function ArmPicker({ arms, value, onChange }: { arms: ResearchArmResult[]; value: string | null; onChange: (a: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      {arms.map((a) => (
        <Button key={a.arm} size="xs" variant={value === a.arm ? 'secondary' : 'ghost'} onClick={() => onChange(a.arm)}>
          <i className="inline-block h-0.5 w-2.5" style={{ background: armColor(a.arm) }} />
          {armLabel(a.arm)}
        </Button>
      ))}
    </div>
  );
}

function TradesTab({ arms, primaryArm, onPrimary, onFocus }: { arms: ResearchArmResult[]; primaryArm: string | null; onPrimary: (a: string) => void; onFocus: (at: number) => void }) {
  const arm = arms.find((a) => a.arm === primaryArm) ?? arms[0];
  const trades = arm?.trades ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-1.5">
        <ArmPicker arms={arms} value={arm?.arm ?? null} onChange={onPrimary} />
        <span className="ml-auto text-[10.5px] text-muted-foreground">{t('按退出批次列出;同一 position 的部分减仓共用 position_id,不算多笔完整胜负。')}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <Table className="text-[11.5px]">
          <TableHeader>
            <TableRow>
              <TableHead>position</TableHead>
              {trades.some((x) => x.symbol) ? <TableHead>{t('币')}</TableHead> : null}
              <TableHead>{t('入场')}</TableHead>
              <TableHead>{t('出场')}</TableHead>
              <TableHead className="text-right">{t('入价')}</TableHead>
              <TableHead className="text-right">{t('出价')}</TableHead>
              {trades.some((x) => x.stop) ? <TableHead className="text-right">{t('止损')}</TableHead> : null}
              {trades.some((x) => x.stop) ? <TableHead className="text-right">{t('止盈')}</TableHead> : null}
              <TableHead className="text-right">{t('数量')}</TableHead>
              <TableHead className="text-right">{t('毛收益')}</TableHead>
              <TableHead className="text-right">{t('费用')}</TableHead>
              <TableHead className="text-right">{t('净收益')}</TableHead>
              {trades.some((x) => typeof x.return_pct === 'number') ? <TableHead className="text-right">%</TableHead> : null}
              <TableHead className="text-right">R</TableHead>
              {trades.some((x) => typeof x.mae_r === 'number') ? <TableHead className="text-right">MAE/MFE</TableHead> : null}
              <TableHead>{t('原因')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!trades.length ? (
              <TableRow>
                <TableCell colSpan={16} className="text-center text-muted-foreground">
                  {t('这一臂没有交易。')}
                </TableCell>
              </TableRow>
            ) : null}
            {trades.map((tr) => (
              <TableRow key={tr.id} className="cursor-pointer" onClick={() => onFocus(tr.exit_at)}>
                <TableCell className="num text-muted-foreground">{tr.position_id.slice(0, 8)}</TableCell>
                {trades.some((x) => x.symbol) ? <TableCell className="font-medium">{tr.symbol ?? '—'}</TableCell> : null}
                <TableCell className="num">{fmtDateTime(tr.entry_at)}</TableCell>
                <TableCell className="num">{fmtDateTime(tr.exit_at)}</TableCell>
                <TableCell className="num text-right">{dec(tr.entry_price, 4)}</TableCell>
                <TableCell className="num text-right">{dec(tr.exit_price, 4)}</TableCell>
                {trades.some((x) => x.stop) ? (
                  <TableCell className="num text-right whitespace-nowrap">
                    {tr.stop ? dec(tr.stop, 4) : '—'}
                    {tr.fit?.stop_source === 'cost_floor' ? (
                      <span className="ml-1 rounded-sm border border-warn/40 bg-warn/10 px-1 text-[9.5px] text-warn" title={`${t('策略原始止损')} ${dec(tr.fit.strategy_stop, 4)} · ${t('成本下限')} ${pct(tr.fit.floor_pct)}`}>
                        {t('成本下限')}
                      </span>
                    ) : null}
                  </TableCell>
                ) : null}
                {trades.some((x) => x.stop) ? (
                  <TableCell className="num text-right whitespace-nowrap">
                    {tr.target ? dec(tr.target, 4) : '—'}
                    {tr.fit && tr.fit.target_source !== 'none' ? (
                      <span
                        className={cn('ml-1 rounded-sm border px-1 text-[9.5px]', tr.fit.target_source === 'fallback_r' ? 'border-warn/40 bg-warn/10 text-warn' : 'border-border text-muted-foreground')}
                        title={tr.fit.target_source === 'fallback_r' ? t('策略没给止盈,按止损距离的固定倍数补') : t('策略给的结构目标(上方阻力块下沿)')}
                      >
                        {FIT_TARGET_LABEL[tr.fit.target_source] ?? tr.fit.target_source}
                      </span>
                    ) : null}
                    {tr.fit?.rr != null ? <span className="ml-1 text-[10px] text-muted-foreground">RR {tr.fit.rr.toFixed(1)}</span> : null}
                  </TableCell>
                ) : null}
                <TableCell className="num text-right">{dec(tr.qty, 6)}</TableCell>
                <TableCell className={cn('num text-right', tone(tr.gross_pnl))}>{dec(tr.gross_pnl)}</TableCell>
                <TableCell className="num text-right text-muted-foreground">{dec(tr.fees, 4)}</TableCell>
                <TableCell className={cn('num text-right font-medium', tone(tr.net_pnl))}>{dec(tr.net_pnl)}</TableCell>
                {trades.some((x) => typeof x.return_pct === 'number') ? <TableCell className={cn('num text-right font-medium', tone(tr.return_pct))}>{typeof tr.return_pct === 'number' ? `${tr.return_pct >= 0 ? '+' : ''}${tr.return_pct.toFixed(2)}%${tr.capped ? '*' : ''}` : '—'}</TableCell> : null}
                <TableCell className={cn('num text-right', tone(tr.net_r))}>{tr.net_r === null ? '—' : tr.net_r.toFixed(2)}</TableCell>
                {trades.some((x) => typeof x.mae_r === 'number') ? (
                  <TableCell className="num text-right text-muted-foreground">
                    <span className="text-down">{typeof tr.mae_r === 'number' ? tr.mae_r.toFixed(2) : '—'}</span> / <span className="text-up">{typeof tr.mfe_r === 'number' ? tr.mfe_r.toFixed(2) : '—'}</span>
                  </TableCell>
                ) : null}
                <TableCell>
                  {REASON_LABEL[tr.reason] ?? tr.reason}
                  {tr.timing === 'intrabar_unknown' ? <span className="ml-1 text-[10px] text-warn" title={t('bar 内触发顺序未知')}>{t('bar 内')}</span> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  );
}

function DecisionsTab({ result, arms, onFocus }: { result: import('@/api/research-types').ResearchResult; arms: ResearchArmResult[]; onFocus: (at: number) => void }) {
  const [view, setView] = useState<'diff' | 'all'>('diff');
  const [armId, setArmId] = useState<string | null>(arms[0]?.arm ?? null);
  const arm = arms.find((a) => a.arm === armId) ?? arms[0];
  const diffs: (ResearchDifference & { version: string })[] = useMemo(() => result.comparison.flatMap((c) => c.differences.map((d) => ({ ...d, version: c.arm }))).sort((a, b) => a.at - b.at), [result]);
  // 差异行本身没有 spec_violations,按 臂+时刻+候选 反查那条决策
  const specByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of arms) for (const d of a.decisions) if (d.spec_violations?.length) map.set(`${a.arm}|${d.at}|${d.candidate_id ?? ''}`, d.spec_violations);
    return map;
  }, [arms]);
  const [reasonFilter, setReasonFilter] = useState('');
  const shown = diffs.filter((d) => !reasonFilter || d.reason.includes(reasonFilter) || d.b_action.includes(reasonFilter) || d.a_action.includes(reasonFilter));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
        <Button size="xs" variant={view === 'diff' ? 'secondary' : 'ghost'} onClick={() => setView('diff')}>
          {t('A 与 B/C 的差异')} <span className="num text-muted-foreground">{diffs.length}</span>
        </Button>
        <Button size="xs" variant={view === 'all' ? 'secondary' : 'ghost'} onClick={() => setView('all')}>
          {t('全部决策')}
        </Button>
        {view === 'all' ? <ArmPicker arms={arms} value={arm?.arm ?? null} onChange={setArmId} /> : <Input value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)} placeholder={t('按原因/动作过滤')} className="h-6 w-48 text-[11px]" />}
        <span className="ml-auto text-[10.5px] text-muted-foreground">{t('点一行把权益图定位到那个时刻。follow 不等于一定成交。')}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {view === 'diff' ? (
          <Table className="text-[11.5px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t('时间')}</TableHead>
                <TableHead>{t('版本')}</TableHead>
                <TableHead>{t('候选')}</TableHead>
                <TableHead>A</TableHead>
                <TableHead />
                <TableHead>B/C</TableHead>
                <TableHead>{t('差异原因')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!shown.length ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    {diffs.length ? t('没有匹配的差异') : t('没有差异:没跑 B/C,或每一步动作都一样。')}
                  </TableCell>
                </TableRow>
              ) : null}
              {shown.map((d, i) => (
                <TableRow key={`${d.version}-${d.at}-${i}`} className="cursor-pointer" onClick={() => onFocus(d.at)}>
                  <TableCell className="num">{fmtDateTime(d.at)}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <i className="inline-block h-0.5 w-2.5" style={{ background: armColor(d.version) }} />
                      {armLabel(d.version)}
                    </span>
                  </TableCell>
                  <TableCell className="num text-muted-foreground">{d.candidate_id ? d.candidate_id.replace('candidate_', '').slice(0, 13) : '—'}</TableCell>
                  <TableCell>{ACTION_LABEL[d.a_action] ?? d.a_action}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <ArrowRight className="size-3" />
                  </TableCell>
                  <TableCell className="font-medium">
                    {ACTION_LABEL[d.b_action] ?? d.b_action}
                    <SpecViolationBadge codes={specByKey.get(`${d.version}|${d.at}|${d.candidate_id ?? ''}`)} />
                  </TableCell>
                  <TableCell className="max-w-[420px] truncate text-muted-foreground" title={d.reason}>
                    {d.reason}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table className="text-[11.5px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t('时间')}</TableHead>
                <TableHead>{t('候选')}</TableHead>
                <TableHead>{t('动作')}</TableHead>
                <TableHead>{t('原因')}</TableHead>
                <TableHead>{t('闸')}</TableHead>
                <TableHead>{t('输入哈希')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(arm?.decisions ?? []).slice(0, 2000).map((d) => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => onFocus(d.at)}>
                  <TableCell className="num">{fmtDateTime(d.at)}</TableCell>
                  <TableCell className="num text-muted-foreground">{d.candidate_id ? d.candidate_id.replace('candidate_', '').slice(0, 13) : '—'}</TableCell>
                  <TableCell className={cn(d.action === 'model_error' || d.action === 'blocked' ? 'text-down' : d.action === 'enter' || d.action === 'follow' ? 'text-up' : '')}>
                    {ACTION_LABEL[d.action] ?? d.action}
                    <SpecViolationBadge codes={d.spec_violations} />
                  </TableCell>
                  <TableCell className="max-w-[420px] truncate text-muted-foreground" title={d.reason}>
                    {d.reason}
                  </TableCell>
                  <TableCell className="text-[10.5px] text-warn">
                    {d.gate_errors.join('; ')}
                    {d.fit ? <div className="num text-[10px] text-muted-foreground">{fitSummary(d.fit)}</div> : null}
                  </TableCell>
                  <TableCell className="num text-[10.5px] text-muted-foreground">{short(d.input_hash, 8)}</TableCell>
                </TableRow>
              ))}
              {(arm?.decisions.length ?? 0) > 2000 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {t('只显示前 2000 条;完整记录用导出。')}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        )}
      </ScrollArea>
    </div>
  );
}

/** B 臂 proposal 违反策略规范时的行内小徽标;hover 看 code 列表。后端没给字段就什么也不画。 */
function SpecViolationBadge({ codes }: { codes: string[] | undefined }) {
  if (!codes?.length) return null;
  return (
    <span className="ml-1 rounded-sm border border-down/40 bg-down/10 px-1 text-[9.5px] text-down" title={codes.join('\n')}>
      {t('违反规范 ×{n}', { n: codes.length })}
    </span>
  );
}

function EvaluationTab({ result }: { result: import('@/api/research-types').ResearchResult }) {
  const ev = result.evaluation;
  if (!ev) return <div className="p-6 text-[12px] text-muted-foreground">{t('只有 completed 的实验才有候选评估。')}</div>;
  const settled = ev.labels.filter((l) => l.status === 'settled' || l.net_r !== null);
  const r = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—');
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-4 divide-x rounded-md border">
          {[
            [t('候选总数'), String(ev.labels.length)],
            [t('已结算'), String(settled.length)],
            [t('未结算 / 缺未来数据'), String(ev.labels.length - settled.length)],
            [t('评估范围'), ev.scope],
          ].map(([k, v]) => (
            <div key={k} className="px-3 py-2">
              <div className="text-[10.5px] text-muted-foreground">{k}</div>
              <div className="num mt-0.5 text-[14px] font-semibold">{v}</div>
            </div>
          ))}
        </div>
        <div className="rounded-md border">
          <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('筛选价值(C 臂 follow / skip 对照)')}</div>
          <Table className="text-[11.5px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t('臂')}</TableHead>
                <TableHead className="text-right">{t('候选')}</TableHead>
                <TableHead className="text-right">follow</TableHead>
                <TableHead className="text-right">skip</TableHead>
                <TableHead className="text-right">{t('follow 平均净 R')}</TableHead>
                <TableHead className="text-right">{t('skip 平均净 R')}</TableHead>
                <TableHead className="text-right">{t('全部平均净 R')}</TableHead>
                <TableHead className="text-right">{t('follow CI')}</TableHead>
                <TableHead className="text-right">{t('同参与率随机对照')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!ev.filter_controls.length ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    {t('没跑 C 臂,或没有可评估的候选。')}
                  </TableCell>
                </TableRow>
              ) : null}
              {ev.filter_controls.map((fc) => (
                <TableRow key={fc.arm}>
                  <TableCell>{armLabel(fc.arm)}</TableCell>
                  <TableCell className="num text-right">{fc.eligible_candidates}</TableCell>
                  <TableCell className="num text-right">{fc.followed}</TableCell>
                  <TableCell className="num text-right">{fc.skipped}</TableCell>
                  <TableCell className={cn('num text-right', tone(fc.follow_avg_net_r))}>{r(fc.follow_avg_net_r)}</TableCell>
                  <TableCell className={cn('num text-right', tone(fc.skip_avg_net_r))}>{r(fc.skip_avg_net_r)}</TableCell>
                  <TableCell className={cn('num text-right', tone(fc.all_avg_net_r))}>{r(fc.all_avg_net_r)}</TableCell>
                  <TableCell className="num text-right">{fc.follow_ci && fc.follow_ci.lower !== null ? `[${r(fc.follow_ci.lower)}, ${r(fc.follow_ci.upper)}]` : t('样本不足')}</TableCell>
                  <TableCell className="num text-right">
                    {fc.matched_participation ? (
                      <span title={fc.matched_participation.note ?? ''}>
                        {r(fc.matched_participation.avg_net_r)}
                        {fc.matched_participation.percentile !== null ? ` · P${Math.round(fc.matched_participation.percentile * 100)}` : ''}
                        <span className="ml-1 text-[10px] text-warn">{t('探索性')}</span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {ev.filter_controls.map((fc) => (
            <div key={fc.arm} className="border-t px-3 py-1 text-[10.5px] text-muted-foreground">
              {armLabel(fc.arm)}:{fc.note}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md border">
            <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('重复稳定性(同候选上的 C 判断一致率)')}</div>
            <ul className="divide-y text-[11.5px]">
              {!ev.repeat_agreement.length ? <li className="px-3 py-2 text-muted-foreground">{t('repeats = 1,没有可配对的重复。')}</li> : null}
              {ev.repeat_agreement.map((ra) => (
                <li key={ra.arm} className="flex items-center px-3 py-1.5">
                  <span>{armLabel(ra.arm)}</span>
                  <span className="num ml-auto">
                    {ra.paired_candidates} {t('对')} · {ra.agreement === null ? '—' : pct(ra.agreement, 0)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="border-t px-3 py-1 text-[10.5px] text-muted-foreground">{t('脚本 fixture 的一致率不能称为 LLM 稳定性。')}</div>
          </div>
          <div className="rounded-md border">
            <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('候选标签')}</div>
            <ScrollArea className="h-56">
              <Table className="text-[11px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('候选')}</TableHead>
                    <TableHead>{t('时间')}</TableHead>
                    <TableHead className="text-right">{t('净 R')}</TableHead>
                    <TableHead>{t('状态')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ev.labels.map((l) => (
                    <TableRow key={l.candidate_id}>
                      <TableCell className="num text-muted-foreground">{l.candidate_id.replace('candidate_', '').slice(0, 13)}</TableCell>
                      <TableCell className="num">{fmtDateTime(l.at)}</TableCell>
                      <TableCell className={cn('num text-right', tone(l.net_r))}>{l.net_r === null ? '—' : l.net_r.toFixed(2)}</TableCell>
                      <TableCell className="text-muted-foreground">{l.status}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}

function EvidenceTab({ runId }: { runId: string }) {
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: ['research', 'evidence', runId, offset], queryFn: () => researchApi.evidence(runId, offset) });
  const d = q.data;
  // 一条记录都没有 = 这轮按固定规则执行;不显示「1–0 / 0」这种反向页码
  const empty = !!d && d.total === 0 && !d.model_calls.length;
  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-4">
        {empty ? (
          <div className="rounded-md border bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">{t('此轮按固定规则执行,没有模型决策记录。')}</div>
        ) : (
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="text-muted-foreground">{t('决策记录')}</span>
            <span className="num">{d ? `${Math.min(offset + 1, d.total)}–${Math.min(offset + 5, d.total)} / ${d.total}` : '…'}</span>
            <Button size="xs" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 5))}>
              {t('上一页')}
            </Button>
            <Button size="xs" variant="outline" disabled={!d || offset + 5 >= d.total} onClick={() => setOffset(offset + 5)}>
              {t('下一页')}
            </Button>
            <span className="ml-auto text-[10.5px] text-muted-foreground">{d?.note}</span>
          </div>
        )}
        {q.isLoading ? <div className="text-[12px] text-muted-foreground">{t('读取证据…')}</div> : null}
        {q.error ? <div className="text-[12px] text-down">{(q.error as Error).message}</div> : null}
        {d?.recordings.map((rec, i) => (
          <details key={i} className="rounded-md border">
            <summary className="cursor-pointer px-3 py-1.5 text-[11.5px] select-none">
              {t('记录')} #{offset + i + 1} · <span className="text-muted-foreground">{summarizeRecording(rec)}</span>
            </summary>
            <pre className="max-h-[420px] overflow-auto border-t bg-muted/30 p-3 text-[10.5px] whitespace-pre-wrap">{JSON.stringify(rec, null, 1)}</pre>
          </details>
        ))}
        {d?.model_calls.length ? (
          <div className="pt-2">
            <div className="mb-1 text-[11.5px] text-muted-foreground">{t('原始模型调用(与记录不是 1:1,repair 会多占一次)')}</div>
            {d.model_calls.map((call, i) => (
              <details key={i} className="mb-2 rounded-md border">
                <summary className="cursor-pointer px-3 py-1.5 text-[11.5px] select-none">
                  {t('调用')} #{offset + i + 1}
                </summary>
                <pre className="max-h-[420px] overflow-auto border-t bg-muted/30 p-3 text-[10.5px] whitespace-pre-wrap">{JSON.stringify(call, null, 1)}</pre>
              </details>
            ))}
          </div>
        ) : null}
        {d && !empty && !d.recordings.length && !d.model_calls.length ? <div className="text-[12px] text-muted-foreground">{t('这一页没有记录:换一页看看。')}</div> : null}
        <p className="text-[10.5px] text-muted-foreground">{t('导出包含用户策略与提示词原文,属于本地私有数据。')}</p>
      </div>
    </ScrollArea>
  );
}

function summarizeRecording(rec: unknown): string {
  const r = rec as Record<string, unknown> | null;
  if (!r) return '';
  const parts: string[] = [];
  for (const k of ['arm', 'at', 'action', 'candidate_id', 'input_hash', 'decision_hash']) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${k === 'at' && typeof v === 'number' ? fmtDateTime(v) : String(v).slice(0, 16)}`);
  }
  return parts.join(' · ');
}

function SetupTab({ run, rulesSource }: { run: ResearchRunSummary; rulesSource: import('@/components/research-workbench/rules-card').RulesSource }) {
  const req = run.manifest.request;
  const p = req.policy;
  const e = req.execution;
  const rows: [string, string][] = [
    ...(p
      ? ([
          [t('策略解释器'), p.interpretation],
          ['lookback', String(p.lookback)],
          ['atr_period', String(p.atr_period)],
          ['stop_atr', String(p.stop_atr)],
          ['take_profit_r', String(p.take_profit_r)],
          ['volume_multiple', String(p.volume_multiple)],
          ['holding_bars', String(p.holding_bars)],
        ] as [string, string][])
      : ([[t('策略'), t('策略 IR(见下方)')]] as [string, string][])),
    ...(req.universe_id ? ([[t('资产池'), req.universe_id], [t('最多持仓'), String(e.max_positions ?? 1)], [t('分配'), e.allocation ?? 'equal_risk']] as [string, string][]) : ([[t('数据集'), req.dataset_id ?? '']] as [string, string][])),
    [t('初始现金'), e.initial_cash],
    [t('单笔风险'), e.risk_fraction],
    [t('最大分配'), e.max_allocation],
    [t('费率'), e.fee_rate],
    [t('滑点 bps'), e.slippage_bps],
    ['qty_step', e.qty_step],
    [t('最小名义'), e.min_notional],
    [t('每日开仓上限'), String(e.max_opens_per_day)],
    [t('臂'), req.arms.join(', ')],
    [t('重复次数'), String(req.repeats)],
    [t('模型调用硬上限'), String(req.max_model_calls)],
    [t('时限'), fmtDuration(req.timeout_ms)],
    ['study', req.study_id],
    ['idempotency_key', req.idempotency_key],
    [t('大脑配置哈希'), run.manifest.brain.configuration_hash],
    [t('manifest 哈希'), run.manifest.hash],
    [t('适配器'), run.manifest.adapter_version],
  ];
  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        <RulesCard
          source={rulesSource}
          className="mb-4 max-w-3xl"
          hint={rulesSource.fromBackend ? undefined : t('本地翻译,原始参数见下表')}
          extra={
            <div className="space-y-2 text-[10.5px] text-muted-foreground">
              <div className="num">policy {short(run.manifest.policy_hash, 16)} · manifest {short(run.manifest.hash, 16)}</div>
              {req.strategy_ir ? <pre className="max-h-80 overflow-auto rounded bg-muted/30 p-2 text-[10.5px] whitespace-pre-wrap">{JSON.stringify(req.strategy_ir, null, 1)}</pre> : <div>{t('这条 run 用的是预置模板,没有策略 IR;参数见下表。')}</div>}
            </div>
          }
        />
        <dl className="grid max-w-3xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[11.5px]">
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="num break-all">{v}</dd>
            </Fragment>
          ))}
        </dl>
        {req.strategy_ir ? (
          <div className="mt-4 max-w-3xl rounded-md border">
            <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('冻结的策略 IR')}</div>
            <pre className="max-h-96 overflow-auto p-3 text-[10.5px] whitespace-pre-wrap">{JSON.stringify(req.strategy_ir, null, 1)}</pre>
          </div>
        ) : null}
        {run.manifest.source_strategy ? (
          <div className="mt-4 max-w-3xl rounded-md border">
            <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('B 臂拿到的原策略(与 A/C 的机械解释不是同一份东西)')}</div>
            <pre className="max-h-96 overflow-auto p-3 text-[10.5px] whitespace-pre-wrap">{JSON.stringify(run.manifest.source_strategy, null, 1)}</pre>
          </div>
        ) : null}
        {run.manifest.playbook ? (
          <div className="mt-4 max-w-3xl rounded-md border">
            <div className="border-b bg-muted/30 px-3 py-1.5 kicker text-foreground/85">{t('冻结的 playbook')}</div>
            <pre className="max-h-64 overflow-auto p-3 text-[10.5px] whitespace-pre-wrap">{run.manifest.playbook}</pre>
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// 新建实验抽屉:数据 → 分段 → 策略 → 执行 → 预算 → 预估 → 启动

const DEFAULT_POLICY: ResearchPolicy = { label: '', description: '', interpretation: 'donchian_close_long_v1', lookback: 20, atr_period: 14, stop_atr: 2, take_profit_r: 2, volume_multiple: 1.2, holding_bars: 24 };
// 订单门缺省必须和后端 order-gate.ts DEFAULT_ORDER_GATE 一致(2026-09-23 结构口径,e515443):盈亏比不拦单(只认 IR 的 order.min_rr)、
// 不放宽止损、止损离入场 <0.5×ATR(14) 不做、不按 R 倍数补止盈。每次 run / 体检全字段发出,冻结进 manifest;
// 有 min_stop_atr = 结构口径。LEGACY_GATE 是 09-21~09-23 的旧口径,只用于展示/继承没有 min_stop_atr 的旧 run。
const DEFAULT_GATE: OrderGateParams = { min_rr: 0, min_stop_cost_multiple: 0, max_risk_fraction: '0.02', require_target: false, stop_floor: 'none', target_fallback_r: null, risk_cap_sizing: 'risk_fraction_only', min_stop_atr: 0.5 };
const LEGACY_GATE: OrderGateParams = { min_rr: 1.5, min_stop_cost_multiple: 8, max_risk_fraction: '0.02', require_target: true, stop_floor: 'widen', target_fallback_r: 2, risk_cap_sizing: 'risk_fraction_only' };
/** 旧 run 冻结的 gate 缺字段时按旧口径补齐;有 min_stop_atr 的新 run 字段全,原样 */
const frozenGate = (g: Partial<OrderGateParams> | null | undefined): OrderGateParams => (g ? { ...LEGACY_GATE, ...g } : DEFAULT_GATE);
const isStructureGate = (g: OrderGateParams) => typeof g.min_stop_atr === 'number';
const DEFAULT_EXEC: ResearchExecution = { initial_cash: '10000', risk_fraction: '0.01', max_allocation: '0.25', fee_rate: '0.001', slippage_bps: '5', qty_step: '0.00000001', min_notional: '5', max_opens_per_day: 3 };

interface SheetProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  parent: ResearchRunSummary | null;
  /** 从资产筛选页带过来的资产池(多资产模式) */
  seedUniverse: ResearchUniverse | null;
  /** 从策略构建页带过来的、检查全过的 IR */
  seedIr: { ir: StrategyIR; timeframe: string; warmup?: number } | null;
  onStarted: (id: string) => void;
}

function NewExperimentSheet({ open, onOpenChange, parent, seedUniverse, seedIr, onStarted }: SheetProps) {
  const qc = useQueryClient();
  const capsQ = useQuery({ queryKey: ['research', 'capabilities'], queryFn: researchApi.capabilities });
  const dsQ = useQuery({ queryKey: ['research', 'datasets'], queryFn: researchApi.datasets, enabled: open });
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, enabled: open });
  // 2026-09-23 策略库并进「我的策略」(apply-spec §8):不再读实盘策略库的 rules 文本当 B 臂参考;
  // 改为从研究策略里选一条,载入它当前版本的 IR(规则卡就是下面的 IR 摘要),B 臂拿 IR 的名称与描述
  const myQ = useQuery({ queryKey: ['research', 'my-strategies-picker'], queryFn: () => researchApi.myStrategies({ filter: 'all', sort: 'updated' }), enabled: open, retry: false });
  const [pickedStrategy, setPickedStrategy] = useState('');
  const loadStrategyIR = async (id: string) => {
    setPickedStrategy(id);
    if (!id) return;
    try {
      const d = await researchApi.myStrategy(id);
      const v = d.versions.find((x) => x.version === d.strategy.current_version);
      if (!v?.strategy_ir) {
        toast.error(t('这条策略还没有规则(IR)'));
        return;
      }
      const loaded = v.strategy_ir;
      setIr(loaded);
      setStrategyMode('ir');
      setPolicy((p) => ({ ...p, label: loaded.label, description: loaded.description }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const [datasetId, setDatasetId] = useState<string | null>(null);
  // 第二轮:数据源二选一(单资产 dataset / 多资产 universe);策略二选一(预置模板 policy / 策略 IR)
  const [source, setSource] = useState<'dataset' | 'universe'>('dataset');
  const [universeId, setUniverseId] = useState<string | null>(null);
  const [strategyMode, setStrategyMode] = useState<'template' | 'ir'>('template');
  const [ir, setIr] = useState<StrategyIR | null>(null);
  const [maxPositions, setMaxPositions] = useState(3);
  const [allocation, setAllocation] = useState<'equal_risk' | 'equal_notional'>('equal_risk');
  const universesQ = useQuery({ queryKey: ['research', 'universes'], queryFn: researchApi.universes, enabled: open, retry: false });
  const runsQ = useQuery({ queryKey: ['research', 'runs'], queryFn: researchApi.runs, enabled: open });
  const [pull, setPull] = useState({ symbol: 'BTCUSDT', timeframe: '1h', days: 120 });
  const [policy, setPolicy] = useState<ResearchPolicy>(DEFAULT_POLICY);
  const [exec, setExec] = useState<ResearchExecution>(DEFAULT_EXEC);
  const [arms, setArms] = useState<ResearchArmKind[]>(['a_rules', 'b_agent', 'c_filter']);
  const [repeats, setRepeats] = useState(1);
  const [maxCalls, setMaxCalls] = useState(200);
  const [timeoutMin, setTimeoutMin] = useState(30); // 网关上限 60 分钟(timeout_ms ≤ 3600000)
  const [callTimeoutSec, setCallTimeoutSec] = useState(120); // 单次模型调用超时,上限 300s
  // 第三轮:剔除仓位因素的收益口径、代码层盈亏比硬门、策略体检
  const [sizingMode, setSizingMode] = useState<'unit_notional' | 'risk_fraction'>('unit_notional');
  const [gate, setGate] = useState<OrderGateParams>(DEFAULT_GATE);
  const [precheck, setPrecheck] = useState<ResearchPrecheckResponse | null>(null);
  const [precheckOverride, setPrecheckOverride] = useState(false);
  const [purpose, setPurpose] = useState<ResearchRequest['purpose']>('development');
  const [split, setSplit] = useState({ dev: 0.6, val: 0.2 });
  const [ack, setAck] = useState(false);
  const [idemKey, setIdemKey] = useState(stableKey);
  const [estimate, setEstimate] = useState<import('@/api/research-types').ResearchEstimate | null>(null);

  // 打开抽屉:从父实验继承;没有父实验就用观察列表第一个币
  useEffect(() => {
    if (!open) return;
    setIdemKey(stableKey());
    setEstimate(null);
    setPrecheck(null);
    setPrecheckOverride(false);
    setAck(false);
    if (parent) {
      const r = parent.manifest.request;
      setDatasetId(r.dataset_id ?? null);
      setUniverseId(r.universe_id ?? null);
      setSource(r.universe_id ? 'universe' : 'dataset');
      if (r.policy) setPolicy(r.policy);
      setIr(r.strategy_ir ?? null);
      setStrategyMode(r.strategy_ir ? 'ir' : 'template');
      setMaxPositions(r.execution.max_positions ?? 3);
      setAllocation(r.execution.allocation ?? 'equal_risk');
      setExec(r.execution);
      setArms(r.arms);
      setRepeats(r.repeats);
      setMaxCalls(r.max_model_calls);
      setTimeoutMin(Math.min(60, Math.max(1, Math.round(r.timeout_ms / 60_000))));
      if (r.model_call_timeout_ms) setCallTimeoutSec(Math.round(r.model_call_timeout_ms / 1000));
      setSizingMode(r.execution.sizing_mode ?? 'unit_notional');
      setGate(frozenGate(r.order_gate));
      setPurpose('development');
    } else {
      const first = overviewQ.data?.workflow?.watchlist?.[0];
      if (first) setPull((p) => ({ ...p, symbol: first }));
      if (seedUniverse) {
        setSource('universe');
        setUniverseId(seedUniverse.id);
      }
      if (seedIr) {
        setStrategyMode('ir');
        setIr(seedIr.ir);
        setPolicy((p) => ({ ...p, label: seedIr.ir.label, description: seedIr.ir.description }));
      }
    }
  }, [open, parent, overviewQ.data?.workflow?.watchlist, seedUniverse, seedIr]);

  const datasets = dsQ.data?.items ?? [];
  const universes = universesQ.data?.items ?? [];
  const universe = source === 'universe' ? (universes.find((u) => u.id === universeId) ?? seedUniverse ?? null) : null;
  // 资产池按对齐后的交集网格切段:形状对齐成 dataset 摘要,后面 study / request 共用一条路
  const dataset: ResearchDatasetSummary | null =
    source === 'universe'
      ? universe
        ? { id: universe.id, created_at: universe.retrieved_at, venue: 'universe', market: 'spot', symbol: universe.members.map((m) => m.symbol.replace('USDT', '')).join('/'), source: `${universe.members.length} symbols · ${universe.market_factor.kind}`, timeframe_ms: universe.timeframe_ms, bars: universe.aligned_bars, first_at: universe.first_at, last_at: universe.last_at }
        : null
      : (datasets.find((d) => d.id === datasetId) ?? null);
  const tfMs = dataset?.timeframe_ms ?? 0;
  // IR 的预热根数来自 compile(高周期结构原语可能要几百根);拿不到时保守 60
  const irWarm = ir ? Math.max(60, seedIr?.warmup ?? 0) : 0;

  // Study:按 dataset 的 bar 网格切三段,边界都落在真实 close_time 上(first_at + k*tf)。
  const study = useMemo<ResearchStudy | null>(() => {
    if (!dataset || !dataset.first_at || !dataset.last_at || !tfMs) return null;
    // IR 模式拿不到精确预热/持有期,按保守值(60 根预热、48 根 purge)切;后端 compile 的 warmup 检查兜底
    const warm = strategyMode === 'ir' ? irWarm + 2 : Math.max(policy.lookback, policy.atr_period) + 2;
    const purge = strategyMode === 'ir' ? 48 : Math.max(policy.holding_bars, 12);
    const n = dataset.bars;
    const at = (k: number) => dataset.first_at! + Math.min(Math.max(0, k), n - 1) * tfMs;
    const usable = n - warm - 2 * (purge + 1);
    if (usable < 60) return null;
    const devN = Math.floor(usable * split.dev);
    const valN = Math.floor(usable * split.val);
    const devTo = warm + devN;
    const valFrom = devTo + purge + 1;
    const valTo = valFrom + valN;
    const holdFrom = valTo + purge + 1;
    return {
      id: `study-${dataset.id.slice(0, 10)}-${warm}-${purge}-${Math.round(split.dev * 100)}-${Math.round(split.val * 100)}`,
      dataset_id: dataset.id,
      from_ms: at(warm),
      development_to_ms: at(devTo),
      validation_from_ms: at(valFrom),
      validation_to_ms: at(valTo),
      holdout_from_ms: at(holdFrom),
      to_ms: at(n - 1),
      purge_bars: purge,
      max_trials: 20,
    };
  }, [dataset, tfMs, policy.lookback, policy.atr_period, policy.holding_bars, split, strategyMode, irWarm]);

  const parentStudyId = parent?.manifest.request.study_id ?? null;
  const sameData = parent ? (parent.manifest.request.universe_id ? universeId === parent.manifest.request.universe_id : datasetId === parent.manifest.request.dataset_id) : false;
  const studyId = parent && sameData ? parentStudyId : study?.id ?? null;
  const studyQ = useQuery({ queryKey: ['research', 'study', studyId], queryFn: () => researchApi.study(studyId!), enabled: !!studyId && !!parent, retry: false });
  const effectiveStudy: ResearchStudy | null = parent && studyQ.data ? studyQ.data : study;

  const window = useMemo(() => {
    if (!effectiveStudy) return null;
    return purpose === 'development' ? [effectiveStudy.from_ms, effectiveStudy.development_to_ms] : purpose === 'validation' ? [effectiveStudy.validation_from_ms, effectiveStudy.validation_to_ms] : [effectiveStudy.holdout_from_ms, effectiveStudy.to_ms];
  }, [effectiveStudy, purpose]);

  const buildRequest = (): ResearchRequest | null => {
    if (!dataset || !effectiveStudy || !window) return null;
    if (strategyMode === 'ir' && !ir) return null;
    return {
      idempotency_key: idemKey,
      ...(source === 'universe' ? { universe_id: dataset.id } : { dataset_id: dataset.id }),
      ...(strategyMode === 'ir' && ir
        ? { strategy_ir: { ...ir, label: policy.label.trim() || ir.label, description: policy.description.trim() || ir.description } }
        : { policy: { ...policy, label: policy.label.trim() || `${dataset.symbol} ${t('收盘突破')}`, description: policy.description.trim() || t('收盘突破 {n} 根高点且放量;ATR 止损;固定目标与持有期。', { n: policy.lookback }) } }),
      execution: { ...(source === 'universe' ? { ...exec, max_positions: maxPositions, allocation } : exec), sizing_mode: sizingMode },
      order_gate: gate,
      ...(precheckOverride && precheck && !precheck.ok ? { precheck_overrides: precheck.items.filter((x) => !x.ok).map((x) => x.name) } : {}),
      from_ms: window[0]!,
      to_ms: window[1]!,
      arms,
      repeats,
      max_model_calls: arms.some((a) => a !== 'a_rules') ? maxCalls : 0,
      timeout_ms: timeoutMin * 60_000,
      model_call_timeout_ms: Math.min(300, Math.max(10, callTimeoutSec)) * 1000,
      purpose,
      study_id: effectiveStudy.id,
      ...(parent && purpose !== 'holdout' ? { parent_run_id: parent.id } : {}),
      acknowledge_adaptive_search: ack,
    };
  };

  const pullM = useMutation({
    mutationFn: () => {
      const to = Date.now();
      const from = to - pull.days * 86_400_000;
      return researchApi.datasetFromMarket({ symbol: pull.symbol.toUpperCase(), timeframe: pull.timeframe, from_ms: from, to_ms: to });
    },
    onSuccess: (r) => {
      toast.success(t('已拉取 {sym} {tf} {n} 根', { sym: r.symbol, tf: r.timeframe, n: r.bars }));
      void qc.invalidateQueries({ queryKey: ['research', 'datasets'] });
      setDatasetId(r.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const precheckM = useMutation({
    mutationFn: async () => {
      const req = buildRequest();
      if (!req) throw new Error(t('先选数据并等分段就绪'));
      if (!parent && study) await researchApi.createStudy(study).catch((e: Error) => { if (!/immutable/.test(e.message)) throw e; });
      return researchApi.precheck({ ...(req.strategy_ir ? { ir: req.strategy_ir } : { policy: req.policy }), ...(req.universe_id ? { universe_id: req.universe_id } : { dataset_id: req.dataset_id }), from_ms: req.from_ms, to_ms: req.to_ms, execution: req.execution, order_gate: req.order_gate });
    },
    onSuccess: (r) => setPrecheck(r),
    onError: (e: Error) => (/404|not_found|不存在/.test(e.message) ? toast.warning(t('后端还没有策略体检接口(第三轮交付中),先跳过')) : toast.error(e.message)),
  });
  const estimateM = useMutation({
    mutationFn: async () => {
      const req = buildRequest();
      if (!req) throw new Error(t('先选数据并等分段就绪'));
      if (!parent && study) await researchApi.createStudy(study).catch((e: Error) => { if (!/immutable/.test(e.message)) throw e; });
      return researchApi.estimate(req);
    },
    onSuccess: (r) => setEstimate(r),
    onError: (e: Error) => toast.error(e.message),
  });

  const startM = useMutation({
    mutationFn: async () => {
      const req = buildRequest();
      if (!req) throw new Error(t('先选数据并等分段就绪'));
      if (!parent && study) await researchApi.createStudy(study).catch((e: Error) => { if (!/immutable/.test(e.message)) throw e; });
      return researchApi.startRun(req);
    },
    onSuccess: (r) => {
      toast.success(t('实验已入队:{id}', { id: r.id.slice(0, 8) }));
      void qc.invalidateQueries({ queryKey: ['research'] });
      onStarted(r.id);
    },
    onError: (e: Error) => {
      const msg = e.message;
      if (/research_busy/.test(msg)) toast.error(t('已有实验在跑:{id}', { id: msg.split(':')[1]?.slice(0, 8) ?? '' }));
      else if (/idempotency_conflict/.test(msg)) { toast.error(t('同一个 key 换了请求;已换新 key,请再点一次')); setIdemKey(stableKey()); }
      else if (/study_sealed_after_holdout/.test(msg)) toast.error(t('这个 study 已开启留出检验并封存,不能再优化;换数据或新 study'));
      else toast.error(msg);
    },
  });

  // 同一个 study 上已经有过实验 = 再跑就是适应性搜索,后端要求显式确认(adaptive_search_ack_required)
  const studyHasRuns = !!studyId && (runsQ.data?.items ?? []).some((r) => r.manifest.request.study_id === studyId);
  const needAck = !!parent || studyHasRuns;
  const needModel = arms.some((a) => a !== 'a_rules');
  const brain = overviewQ.data?.workflow?.brain;
  const holdoutSealed = purpose === 'holdout';
  const precheckBlocks = !!precheck && !precheck.ok && !precheckOverride;
  // unit_notional 每笔固定名义,仓位因素已剔除;此时默认不套单笔风险上限(后端 risk_cap_sizing)
  const riskCapMoot = sizingMode === 'unit_notional' && (gate.risk_cap_sizing ?? 'risk_fraction_only') === 'risk_fraction_only';
  const canStart = !!buildRequest() && (!needModel || maxCalls > 0) && (!needAck || ack || purpose !== 'development') && !precheckBlocks;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[560px] max-w-[92vw] flex-col gap-0 p-0 sm:max-w-[560px]">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-[14px]">
            <Beaker className="size-4" /> {parent ? t('下一次实验(父 {id})', { id: parent.id.slice(0, 8) }) : t('新建实验')}
          </SheetTitle>
          <SheetDescription className="text-[11.5px]">{t('改数据、策略、成本、区间、模型任一项都是新 run;分段一旦创建不可原地改。')}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 px-4 py-4 text-[12px]">
            {/* 1 数据 */}
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="kicker text-foreground/85">1 · {t('数据')}</span>
                <div className="ml-auto flex gap-0.5">
                  <Button size="xs" variant={source === 'dataset' ? 'secondary' : 'ghost'} onClick={() => setSource('dataset')} disabled={!!parent}>
                    {t('单资产')}
                  </Button>
                  <Button size="xs" variant={source === 'universe' ? 'secondary' : 'ghost'} onClick={() => setSource('universe')} disabled={!!parent}>
                    {t('资产池')}
                  </Button>
                </div>
              </div>
              {source === 'universe' ? (
                universes.length || seedUniverse ? (
                  <select className="h-8 w-full rounded-md border bg-background px-2 text-[12px]" value={universeId ?? ''} onChange={(e) => setUniverseId(e.target.value || null)}>
                    <option value="">{t('选择已冻结的资产池…')}</option>
                    {[...universes, ...(seedUniverse && !universes.some((u) => u.id === seedUniverse.id) ? [seedUniverse] : [])].map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.members.map((m) => m.symbol.replace('USDT', '')).join('/')} · {tfLabel(u.timeframe_ms)} · {u.aligned_bars} bars · {u.market_factor.kind}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="text-muted-foreground">{t('还没有资产池:去「资产筛选」冻结一个。')}</div>
                )
              ) : datasets.length ? (
                <select className="h-8 w-full rounded-md border bg-background px-2 text-[12px]" value={datasetId ?? ''} onChange={(e) => setDatasetId(e.target.value || null)}>
                  <option value="">{t('选择已冻结的数据快照…')}</option>
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.venue} {d.symbol} {tfLabel(d.timeframe_ms)} · {d.bars} bars · {d.first_at ? fmtDateTime(d.first_at) : ''} → {d.last_at ? fmtDateTime(d.last_at) : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-muted-foreground">{t('还没有数据快照,先从行情通道拉一段。')}</div>
              )}
              {dataset && source === 'dataset' ? <DatasetLine d={dataset} /> : null}
              {source === 'universe' && universe ? (
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="text-[10.5px] text-muted-foreground">{t('最多同时持仓')}</span>
                    <Input type="number" min={1} max={universe.members.length} value={maxPositions} onChange={(e) => setMaxPositions(Math.max(1, Number(e.target.value)))} className="h-7 text-[12px]" disabled={!!parent} />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-[10.5px] text-muted-foreground">{t('分配')}</span>
                    <select className="h-7 w-full rounded-md border bg-background px-2 text-[12px]" value={allocation} onChange={(e) => setAllocation(e.target.value as typeof allocation)} disabled={!!parent}>
                      <option value="equal_risk">{t('等风险(按止损距离)')}</option>
                      <option value="equal_notional">{t('等名义')}</option>
                    </select>
                  </label>
                </div>
              ) : null}
              {source === 'universe' ? null : (
              <div className="rounded-md border bg-muted/20 p-2.5">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Database className="size-3" /> {t('从当前行情通道拉现货历史 K 线(来源写进快照:交易所 + 端点 + 拉取时刻)')}
                </div>
                <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-1.5">
                  <Input value={pull.symbol} onChange={(e) => setPull({ ...pull, symbol: e.target.value.toUpperCase() })} placeholder="BTCUSDT" className="h-7 text-[12px]" />
                  <select className="h-7 rounded-md border bg-background px-1.5 text-[12px]" value={pull.timeframe} onChange={(e) => setPull({ ...pull, timeframe: e.target.value })}>
                    {TF_OPTIONS.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Input type="number" min={7} max={2000} value={pull.days} onChange={(e) => setPull({ ...pull, days: Number(e.target.value) })} className="h-7 w-16 text-[12px]" /> {t('天')}
                  </label>
                  <Button size="sm" variant="outline" onClick={() => pullM.mutate()} disabled={pullM.isPending || !pull.symbol}>
                    {pullM.isPending ? <RefreshCw className="animate-spin" /> : <Download />} {t('拉取')}
                  </Button>
                </div>
                <div className="mt-1 text-[10.5px] text-muted-foreground">{t('单次最多 50,000 根;回放窗口最多 10,000 根。')}</div>
              </div>
              )}
            </section>

            {/* 2 分段 */}
            <section className="space-y-2">
              <div className="kicker text-foreground/85">2 · {t('预注册分段')}</div>
              {effectiveStudy ? (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      [t('development'), effectiveStudy.from_ms, effectiveStudy.development_to_ms, 'development'],
                      [t('validation'), effectiveStudy.validation_from_ms, effectiveStudy.validation_to_ms, 'validation'],
                      [t('holdout'), effectiveStudy.holdout_from_ms, effectiveStudy.to_ms, 'holdout'],
                    ].map(([label, a, b, key]) => (
                      <button
                        key={String(key)}
                        type="button"
                        onClick={() => setPurpose(key as ResearchRequest['purpose'])}
                        className={cn('rounded-md border px-2 py-1.5 text-left', purpose === key ? 'border-foreground/40 bg-accent/60' : 'hover:bg-accent/30')}
                      >
                        <div className="text-[11px] font-medium">{String(label)}</div>
                        <div className="num text-[10px] text-muted-foreground">
                          {fmtDateTime(Number(a))}
                          <br />→ {fmtDateTime(Number(b))}
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 text-[10.5px] text-muted-foreground">
                    <span>
                      purge <span className="num">{effectiveStudy.purge_bars}</span> bars
                    </span>
                    <span>
                      {t('试验上限')} <span className="num">{effectiveStudy.max_trials}</span>
                    </span>
                    <span className="num">study {effectiveStudy.id.slice(0, 24)}</span>
                    {!parent ? (
                      <label className="flex items-center gap-1">
                        dev <Input type="number" min={30} max={80} value={Math.round(split.dev * 100)} onChange={(e) => setSplit({ ...split, dev: Number(e.target.value) / 100 })} className="h-5 w-12 px-1 text-[10.5px]" />% · val{' '}
                        <Input type="number" min={10} max={40} value={Math.round(split.val * 100)} onChange={(e) => setSplit({ ...split, val: Number(e.target.value) / 100 })} className="h-5 w-12 px-1 text-[10.5px]" />%
                      </label>
                    ) : null}
                  </div>
                  {holdoutSealed ? <div className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">{t('留出检验只能跑一次:跑完这个 study 就封存,之后不能再在它上面优化。')}</div> : null}
                  {purpose === 'validation' ? <div className="text-[10.5px] text-muted-foreground">{t('validation 不用于反复优化;它回答「development 上的改动在样本外还成立吗」。')}</div> : null}
                </div>
              ) : (
                <div className="text-muted-foreground">{dataset ? t('数据太短,切不出三段(至少需要 warmup + 2×purge + 60 根)。') : t('先选数据。')}</div>
              )}
            </section>

            {/* 3 策略 */}
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="kicker text-foreground/85">3 · {t('策略(A/C 的机械解释)')}</span>
                <div className="ml-auto flex gap-0.5">
                  <Button size="xs" variant={strategyMode === 'template' ? 'secondary' : 'ghost'} onClick={() => setStrategyMode('template')} disabled={!!parent?.manifest.request.strategy_ir}>
                    {t('预置模板')}
                  </Button>
                  <Button size="xs" variant={strategyMode === 'ir' ? 'secondary' : 'ghost'} onClick={() => setStrategyMode('ir')} disabled={!ir}>
                    {t('策略 IR')}
                  </Button>
                </div>
              </div>
              <Input value={policy.label} onChange={(e) => setPolicy({ ...policy, label: e.target.value })} placeholder={t('名称')} className="h-7 text-[12px]" />
              <Textarea value={policy.description} onChange={(e) => setPolicy({ ...policy, description: e.target.value })} placeholder={t('用一句话描述规则:收盘突破前 N 根最高价且放量,ATR 止损,固定目标与持有期…')} className="min-h-[52px] text-[12px]" />
              {strategyMode === 'ir' && ir ? (
                <div className="rounded-md border bg-muted/20 px-2.5 py-2 text-[11px]">
                  <div className="flex items-center gap-2">
                    <Wand2 className="size-3" />
                    <span>{t('来自策略构建器的 IR(检查已全过)')}</span>
                    <span className="num ml-auto text-muted-foreground">{ir.signal.length} {t('信号')} · {ir.exit.length} {t('出场')}{ir.regime ? ` · ${t('趋势过滤')}` : ''}</span>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    {[...ir.signal.map((x) => x.primitive), ir.entry.primitive, ir.risk.stop.primitive, ir.risk.sizing.primitive, ...ir.exit.map((x) => x.primitive), ...(ir.regime ? [ir.regime.primitive] : [])].join(' → ')}
                  </div>
                </div>
              ) : null}
              <div className={cn('grid grid-cols-3 gap-1.5', strategyMode === 'ir' && 'hidden')}>
                {(
                  [
                    ['lookback', t('突破回看根数'), 1],
                    ['atr_period', t('ATR 周期'), 1],
                    ['stop_atr', t('止损 ATR 倍数'), 0.1],
                    ['take_profit_r', t('止盈 R'), 0.1],
                    ['volume_multiple', t('放量倍数'), 0.1],
                    ['holding_bars', t('最长持有根数'), 1],
                  ] as [keyof ResearchPolicy, string, number][]
                ).map(([k, label, step]) => (
                  <label key={k} className="space-y-0.5">
                    <span className="text-[10.5px] text-muted-foreground">
                      {label} <span className="num">{k}</span>
                    </span>
                    <Input type="number" step={step} value={policy[k] as number} onChange={(e) => setPolicy({ ...policy, [k]: Number(e.target.value) })} className="h-7 text-[12px]" />
                  </label>
                ))}
              </div>
              <div className="text-[10.5px] text-muted-foreground">{t('解释器')}: {capsQ.data?.interpreters.join(', ') ?? 'donchian_close_long_v1'} · {t('现货做多、单资产')}</div>
              <label className="block space-y-0.5">
                <span className="text-[10.5px] text-muted-foreground">{t('从「我的策略」载入规则(当前版本的 IR;B 臂拿它的名称与描述,不再读策略库文本)')}</span>
                <select className="h-7 w-full rounded-md border bg-background px-2 text-[12px]" value={pickedStrategy} onChange={(e) => void loadStrategyIR(e.target.value)}>
                  <option value="">{t('不载入')}</option>
                  {(myQ.data?.strategies ?? []).filter((s) => s.current_version > 0).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · v{s.current_version} · {s.timeframe}
                    </option>
                  ))}
                </select>
              </label>
              {parent ? (
                <div className="rounded-md border bg-muted/20 px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
                  {parent.manifest.request.policy && strategyMode === 'template' ? <PolicyDiff before={parent.manifest.request.policy} after={policy} /> : <span>{t('IR 候选:改动按叶子参数计,一轮最多 2 个经济参数;归因在子实验的「诊断」页。')}</span>}
                </div>
              ) : null}
            </section>

            {/* 4 执行 */}
            <section className="space-y-2">
              <div className="kicker text-foreground/85">4 · {t('执行与成本')}</div>
              <div className="grid grid-cols-4 gap-1.5">
                {(
                  [
                    ['initial_cash', t('初始现金')],
                    ['risk_fraction', t('单笔风险')],
                    ['max_allocation', t('最大分配')],
                    ['fee_rate', t('费率')],
                    ['slippage_bps', t('滑点 bps')],
                    ['qty_step', 'qty_step'],
                    ['min_notional', t('最小名义')],
                    ['max_opens_per_day', t('日开仓上限')],
                  ] as [keyof ResearchExecution, string][]
                ).map(([k, label]) => (
                  <label key={k} className="space-y-0.5">
                    <span className="text-[10.5px] text-muted-foreground">{label}</span>
                    <Input
                      value={String(exec[k])}
                      inputMode="decimal"
                      onChange={(e) => setExec({ ...exec, [k]: k === 'max_opens_per_day' ? Number(e.target.value) : e.target.value })}
                      className="h-7 text-[12px]"
                      disabled={!!parent}
                    />
                  </label>
                ))}
              </div>
              <div className="text-[10.5px] text-muted-foreground">{parent ? t('候选实验沿用父实验的执行与费用设置,才能配对比较。') : t('十进制字符串原样发送,不做科学记数法。')}</div>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 rounded-md border bg-muted/20 px-2.5 py-2 text-[11px]">
                <span className="text-muted-foreground">{t('收益口径')}</span>
                <div className="flex gap-0.5">
                  <Button size="xs" variant={sizingMode === 'unit_notional' ? 'secondary' : 'ghost'} onClick={() => setSizingMode('unit_notional')} disabled={!!parent}>
                    {t('每笔固定名义(剔除仓位)')}
                  </Button>
                  <Button size="xs" variant={sizingMode === 'risk_fraction' ? 'secondary' : 'ghost'} onClick={() => setSizingMode('risk_fraction')} disabled={!!parent}>
                    {t('按风险比例')}
                  </Button>
                </div>
                <span className="text-muted-foreground">{t('盈亏比硬门')}</span>
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={isStructureGate(gate)} onChange={(e) => setGate(e.target.checked ? DEFAULT_GATE : LEGACY_GATE)} className="size-3" disabled={!!parent} /> {t('结构口径(缺省)')}
                    </label>
                    {isStructureGate(gate) ? (
                      <label className="flex items-center gap-1">
                        {t('止损离入场 <')} <Input type="number" step={0.1} min={0} value={gate.min_stop_atr ?? 0.5} onChange={(e) => setGate({ ...gate, min_stop_atr: Number(e.target.value) })} className="h-6 w-14 px-1.5 text-[11px]" disabled={!!parent} /> {t('×ATR(14) 不做')}
                      </label>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1">
                      {t('最小盈亏比')} <Input type="number" step={0.1} min={0.5} value={gate.min_rr} onChange={(e) => setGate({ ...gate, min_rr: Number(e.target.value) })} className="h-6 w-14 px-1.5 text-[11px]" disabled={!!parent} />
                    </label>
                    <label className="flex items-center gap-1">
                      {t('止损 ≥ 成本 ×')} <Input type="number" step={1} min={1} value={gate.min_stop_cost_multiple} onChange={(e) => setGate({ ...gate, min_stop_cost_multiple: Number(e.target.value) })} className="h-6 w-14 px-1.5 text-[11px]" disabled={!!parent} />
                    </label>
                    <label className="flex items-center gap-1">
                      {t('单笔风险 ≤')} <Input value={gate.max_risk_fraction} onChange={(e) => setGate({ ...gate, max_risk_fraction: e.target.value })} className={cn('h-6 w-14 px-1.5 text-[11px]', riskCapMoot && 'opacity-60')} disabled={!!parent} />
                    </label>
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={gate.require_target} onChange={(e) => setGate({ ...gate, require_target: e.target.checked })} className="size-3" disabled={!!parent} /> {t('必须有止盈')}
                    </label>
                  </div>
                  {riskCapMoot ? <div className="text-[10px] text-muted-foreground">{t('unit_notional 已剔除仓位因素,单笔风险上限不适用')}</div> : null}
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-[10.5px]">
                    <label className="flex items-center gap-1">
                      {t('止损窄于下限')}
                      <select className="h-6 rounded-md border bg-background px-1 text-[11px]" value={gate.stop_floor ?? 'widen'} onChange={(e) => setGate({ ...gate, stop_floor: e.target.value as NonNullable<OrderGateParams['stop_floor']> })} disabled={!!parent}>
                        <option value="widen">{t('放宽到下限')}</option>
                        <option value="block">{t('直接拦')}</option>
                        <option value="none">{t('只展示(结构口径)')}</option>
                      </select>
                    </label>
                    <span className="text-muted-foreground">{gate.stop_floor === 'none' ? t('成本下限只展示,不放宽止损也不拦') : gate.stop_floor === 'block' ? t('策略止损比成本下限还窄就拦下,不替它挪止损') : t('策略止损比成本下限还窄时,先把止损放宽到下限再判盈亏比')}</span>
                    <div className="flex items-center gap-1">
                      <label className="flex items-center gap-1">
                        {t('没止盈时补')}
                        <Input type="number" step={0.5} min={0} value={gate.target_fallback_r ?? 2} onChange={(e) => setGate({ ...gate, target_fallback_r: Number(e.target.value) })} className="h-6 w-12 px-1.5 text-[11px]" disabled={!!parent || gate.target_fallback_r === null} />
                        <span className="text-muted-foreground">R</span>
                      </label>
                      <label className="ml-1 flex items-center gap-1">
                        <input type="checkbox" checked={gate.target_fallback_r === null} onChange={(e) => setGate({ ...gate, target_fallback_r: e.target.checked ? null : 2 })} className="size-3" disabled={!!parent} /> {t('不补')}
                      </label>
                    </div>
                    <span className="text-muted-foreground">{gate.target_fallback_r === null ? t('结构上方没有阻力块就判 no_target 拦下') : t('结构上方没有阻力块时,按止损距离的固定倍数补一个止盈')}</span>
                    <label className="flex items-center gap-1">
                      {t('风险上限适用')}
                      <select className="h-6 rounded-md border bg-background px-1 text-[11px]" value={gate.risk_cap_sizing ?? 'risk_fraction_only'} onChange={(e) => setGate({ ...gate, risk_cap_sizing: e.target.value as NonNullable<OrderGateParams['risk_cap_sizing']> })} disabled={!!parent}>
                        <option value="risk_fraction_only">{t('只对按风险比例')}</option>
                        <option value="all">{t('所有仓位法')}</option>
                      </select>
                    </label>
                    <span className="text-muted-foreground">{gate.risk_cap_sizing === 'all' ? t('两种仓位法都套单笔风险上限') : t('unit_notional 口径不套单笔风险上限,只有按风险比例时才套')}</span>
                  </div>
                </div>
              </div>
              <div className="text-[10.5px] text-muted-foreground">
                {isStructureGate(gate)
                  ? t('结构口径:止损放在图上结构位、离入场不到 {k}×ATR 的单子不做(不挪远止损);止盈取图上价位,没有就不设、交给追踪止损;盈亏比只展示,只有策略里写了硬约束才拦。', { k: gate.min_stop_atr ?? 0.5 })
                  : t('候选出现时代码先放止损(结构位/ATR,不得窄于成本下限)和止盈(上方阻力块,没有就按固定倍数),再判盈亏比;只有结构没空间的候选才会被拦。回测与实盘同一份代码。')}
              </div>
            </section>

            {/* 5 模式与预算 */}
            <section className="space-y-2">
              <div className="kicker text-foreground/85">5 · {t('模式与预算')}</div>
              <div className="grid grid-cols-3 gap-1.5">
                {ARM_KINDS.map((k) => (
                  <label key={k} className={cn('cursor-pointer rounded-md border px-2 py-1.5', arms.includes(k) ? 'border-foreground/40 bg-accent/60' : 'hover:bg-accent/30')}>
                    <div className="flex items-center gap-1.5 text-[11px] font-medium">
                      <input type="checkbox" checked={arms.includes(k)} onChange={(e) => setArms((cur) => (e.target.checked ? ARM_KINDS.filter((x) => cur.includes(x) || x === k) : cur.filter((x) => x !== k)))} className="size-3" />
                      <i className="inline-block h-0.5 w-2.5" style={{ background: armColor(k) }} />
                      {ARM_KIND_LABEL[k]}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{ARM_KIND_HINT[k]}</div>
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                <label className="space-y-0.5">
                  <span className="text-[10.5px] text-muted-foreground">{t('重复次数(B/C)')}</span>
                  <Input type="number" min={1} max={5} value={repeats} onChange={(e) => setRepeats(Math.max(1, Number(e.target.value)))} className="h-7 text-[12px]" />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10.5px] text-muted-foreground">{t('模型调用硬上限')}</span>
                  <Input type="number" min={0} value={maxCalls} onChange={(e) => setMaxCalls(Math.max(0, Number(e.target.value)))} className="h-7 text-[12px]" disabled={!needModel} />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10.5px] text-muted-foreground">{t('单次调用超时(秒)')}</span>
                  <Input type="number" min={10} max={300} value={callTimeoutSec} onChange={(e) => setCallTimeoutSec(Math.min(300, Math.max(10, Number(e.target.value))))} className="h-7 text-[12px]" disabled={!needModel} />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10.5px] text-muted-foreground">{t('时限(分钟)')}</span>
                  <Input type="number" min={1} max={60} value={timeoutMin} onChange={(e) => setTimeoutMin(Math.min(60, Math.max(1, Number(e.target.value))))} className="h-7 text-[12px]" />
                </label>
              </div>
              <div className="text-[10.5px] text-muted-foreground">
                {t('大脑')}: {parent ? `${parent.manifest.brain.name}${parent.manifest.brain.model ? ` · ${parent.manifest.brain.model}` : ''}(${t('沿用父实验')})` : brain ?? '…'} · {t('B/C 会真花模型额度;预算耗尽标 incomplete,不当作完整业绩。')}
              </div>
              {needAck ? (
                <label className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px]">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-3" />
                  <span>{parent ? t('我知道这是在 development 上做适应性搜索:每一次候选都计入试验数,改得越多、样本外越不可信。') : t('这个 study 上已经跑过实验:再跑一次就是适应性搜索,计入试验数;我知道样本外可信度会随之下降。')}</span>
                </label>
              ) : null}
            </section>

            {/* 6 预估 */}
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="kicker text-foreground/85">6 · {t('体检、预估与启动')}</span>
                <Button size="xs" variant="outline" onClick={() => precheckM.mutate()} disabled={!buildRequest() || precheckM.isPending}>
                  {precheckM.isPending ? <RefreshCw className="animate-spin" /> : null} {t('策略体检')}
                </Button>
              </div>
              {precheck ? (
                <div className={cn('rounded-md border', precheck.ok ? 'border-up/40' : 'border-warn/40')}>
                  <ul className="divide-y">
                    <AnimatePresence initial={false}>
                      {precheck.items.map((it, i) => (
                        <Reveal key={it.name} delay={i * 0.05}>
                          <li className="flex items-start gap-2 px-2.5 py-1.5 text-[11px]">
                            <span className={cn('mt-0.5 inline-block size-2 shrink-0 rounded-full', it.ok ? 'bg-up' : 'bg-down')} />
                            <span className="w-32 shrink-0 font-medium">{PRECHECK_LABEL[it.name] ?? it.name}</span>
                            <span className="num w-16 shrink-0">{it.value === null ? '—' : typeof it.value === 'number' && !Number.isInteger(it.value) ? it.value.toFixed(2) : String(it.value)}{it.threshold != null ? <span className="text-muted-foreground"> / {it.threshold}</span> : null}</span>
                            <span className="text-muted-foreground">{it.note}</span>
                          </li>
                        </Reveal>
                      ))}
                    </AnimatePresence>
                  </ul>
                  {precheck.suggestions.length ? <div className="border-t px-2.5 py-1.5 text-[10.5px] text-muted-foreground">{t('建议')}:{precheck.suggestions.join(';')}</div> : null}
                  {!precheck.ok ? (
                    <label className="flex items-center gap-2 border-t px-2.5 py-1.5 text-[11px] text-warn">
                      <input type="checkbox" checked={precheckOverride} onChange={(e) => setPrecheckOverride(e.target.checked)} className="size-3" /> {t('体检没过,我仍要跑(会记进 manifest)')}
                    </label>
                  ) : null}
                </div>
              ) : null}
              {estimate ? (
                <div className="grid grid-cols-4 divide-x rounded-md border">
                  {[
                    [t('bars'), String(estimate.bars)],
                    [t('判断上界'), String(estimate.upper_model_calls)],
                    [t('硬上限'), String(estimate.hard_model_call_cap)],
                    [t('费用'), estimate.price ?? t('未知')],
                  ].map(([k, v]) => (
                    <div key={k} className="px-2.5 py-1.5">
                      <div className="text-[10px] text-muted-foreground">{k}</div>
                      <div className="num text-[13px] font-semibold">{v}</div>
                    </div>
                  ))}
                  <div className="col-span-full border-t px-2.5 py-1 text-[10px] text-muted-foreground">{estimate.price_note}</div>
                </div>
              ) : (
                <div className="text-[10.5px] text-muted-foreground">{t('启动前先预估:bars 数、判断次数上界、硬上限;费用未知就显示「未知」,不写 $0。')}</div>
              )}
            </section>
          </div>
        </ScrollArea>
        <div className="flex items-center gap-2 border-t px-4 py-3">
          <span className="num text-[10.5px] text-muted-foreground">key {idemKey.slice(-8)}</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => estimateM.mutate()} disabled={!buildRequest() || estimateM.isPending}>
              {t('预估')}
            </Button>
            <Button size="sm" onClick={() => startM.mutate()} disabled={!canStart || startM.isPending}>
              <Play /> {holdoutSealed ? t('跑留出检验并封存') : t('启动')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DatasetLine({ d }: { d: ResearchDatasetSummary }) {
  const synthetic = d.venue === 'synthetic';
  return (
    <div className="flex flex-wrap items-center gap-x-3 text-[10.5px] text-muted-foreground">
      <span className={cn(synthetic && 'text-down')}>{synthetic ? t('合成数据') : d.venue}</span>
      <span className="num">{d.source}</span>
      <span className="num">{d.id.slice(0, 12)}</span>
      <span>{t('拉取于')} {fmtDateTime(d.created_at)}</span>
      {!synthetic ? <span>{t('来源未独立验证')}</span> : null}
    </div>
  );
}

function PolicyDiff({ before, after }: { before: ResearchPolicy; after: ResearchPolicy }) {
  const keys = (Object.keys(after) as (keyof ResearchPolicy)[]).filter((k) => before[k] !== after[k]);
  const economic = keys.filter((k) => k !== 'label' && k !== 'description');
  if (!keys.length) return <span>{t('与父实验完全一样:先改一个假设。')}</span>;
  return (
    <div className="space-y-0.5">
      <div className={cn(economic.length > 2 && 'text-down')}>
        {t('相对父实验改了 {n} 个经济参数(一轮最多 2 个)', { n: economic.length })}
      </div>
      {keys.map((k) => (
        <div key={k} className="num">
          {k}: {String(before[k])} → {String(after[k])}
        </div>
      ))}
    </div>
  );
}
