/**
 * 楼层 v4 · 布局 A(开放办公室)原型的公共类型。
 * 数据形状贴近真实网关:agents / handoffs / money / inbox;金额一律十进制字符串,时间戳 unix 毫秒。
 * 渲染引擎只认这些类型,不认 mock —— 以后 React 包一层直接喂真数据。
 */
import type { SfxKind } from '../engine-b/types';

export type RoleId =
  | 'gate_captain'
  | 'radar'
  | 'thread_manager'
  | 'strategy_lab'
  | 'portfolio_manager'
  | 'risk_sentinel'
  | 'reviewer'
  | 'executor'
  | 'asp_agent';

export type AgentStatus = 'working' | 'waiting' | 'stuck' | 'idle';

export interface AgentMetric {
  label: string;
  value: string;
  tone?: 'up' | 'down' | 'warn' | 'plain';
}

export interface AgentSnapshot {
  role: string;
  callsign: string;
  color: string;
  status: AgentStatus;
  /** 人话:它此刻在干嘛 */
  line: string;
  /** 进房间时显示的 3 个关键数(可选) */
  metrics?: AgentMetric[];
  /** 你派给它的活(进行中);头顶画任务图标 */
  task?: { id: string; label: string; icon: TaskIcon } | null;
}

export type TaskIcon = 'scan' | 'eye' | 'flask' | 'bolt' | 'shield' | 'coin' | 'book' | 'shop' | 'chat';

// ---- 进化方格(#evolution 同形) ----
export type EvoStatus = 'good' | 'ok' | 'bad' | 'none';
export interface EvoDay {
  date: string;
  status: EvoStatus;
  score: number | null;
  headline: string | null;
  events?: number;
}
export interface EvoRoleRow {
  role: string;
  days: EvoDay[];
}
export interface EvoDayDetail {
  role: string;
  date: string;
  metrics: AgentMetric[];
  records: { at: string; text: string }[];
}

/** 团队事件(进化提炼 / 派活完成 / 系统) —— 画布播动画,右栏进动态流 */
export interface TeamEvent {
  id: string;
  kind: 'evolution' | 'task_done' | 'task_start' | 'approval' | 'system' | 'highfive';
  role: string;
  text: string;
  at: number;
}

/** 窗外天气 = 状态 */
export interface MarketState {
  ticker: { symbol: string; price: string; chg_pct: number }[];
  volatility_1h_pct: number;
  risk_level: 'low' | 'mid' | 'high';
  utc_hour: number;
}

export interface StrategyRef {
  id: string;
  name: string;
  version: string;
}

export interface HandoffSnapshot {
  id?: string;
  from: string;
  to: string;
  text: string;
  at: number;
  /** 接收方接住时冒的一句短话(可选,没有就按角色挑一句默认) */
  reply?: string;
}

/** 多人碰头(可选字段;真数据里可由连续交接推导) */
export interface MeetingSnapshot {
  id: string;
  roles: string[];
  topic: string;
  at: number;
  until: number;
}

export interface MoneySnapshot {
  equity: string;
  pnl_today: string;
  positions: number;
}

export interface InboxItem {
  id: string;
  kind: 'approval' | 'handoff';
  title: string;
  detail: string;
  at: number;
  from?: string;
}

export interface InboxSnapshot {
  count: number;
  items: InboxItem[];
}

export interface FloorSnapshot {
  now: number;
  agents: AgentSnapshot[];
  handoffs: HandoffSnapshot[];
  money: MoneySnapshot;
  inbox: InboxSnapshot;
  meetings?: MeetingSnapshot[];
  evolution?: EvoRoleRow[];
  events?: TeamEvent[];
  market?: MarketState;
  strategy?: StrategyRef | null;
  /** 紧急停止已触发 */
  halted?: boolean;
}

export type ThemeId = 'lab' | 'command' | 'meme';

export interface ScreenPt {
  /** 相对视口(client)坐标 */
  x: number;
  y: number;
}

export interface MountOptions {
  theme: ThemeId;
  /** 点中某个 agent(画布里点人/点桌);at = 该 agent 头顶的屏幕坐标 */
  onSelectAgent?: (role: string, at?: ScreenPt) => void;
  /** 悬停/离开进化方格的某一格 */
  onHoverEvo?: (hit: { role: string; day: EvoDay; at: ScreenPt } | null) => void;
  /** 点进化方格的某一格 */
  onSelectEvo?: (role: string, date: string) => void;
  /** 点方块条的标题(桌牌)→ 进房间看 30 天 */
  onOpenEvoGrid?: (role: string) => void;
  /** 悬停窗户:解释天气 */
  onHoverWindow?: (text: string | null, at?: ScreenPt) => void;
  /** 点信箱里的金信封 */
  onClickMailbox?: () => void;
  /** 双击 agent = 击掌 */
  onHighFive?: (role: string) => void;
  /** 彩蛋 */
  onEasterEgg?: (kind: 'pet' | 'coins') => void;
  /** 镜头推进/拉回完成时回调(role=null 表示回到全景) */
  onFocusChange?: (role: string | null) => void;
  /** 不传则跟随 prefers-reduced-motion */
  reducedMotion?: boolean;
  /** 8-bit 音效触发点:信封被接住 / 金信封(批准)飞出 / +1 进化 / 击掌。引擎只喊,不放声音 */
  onSfx?: (k: SfxKind) => void;
}

export interface FloorHandle {
  setData(snapshot: FloorSnapshot): void;
  setTheme(id: ThemeId): void;
  /** 推进到某个 agent 的小房间;null = 回全景;evo=true 时高亮房间里的 30 天方格板 */
  focus(role: string | null, opts?: { evo?: boolean }): void;
  /** 客户端坐标下是哪个 agent 的工位(拖放用);没有返回 null */
  dropTargetAt(clientX: number, clientY: number): string | null;
  /** 拖拽悬停高亮:目标 agent 伸手 */
  setDropHover(role: string | null): void;
  /** 播一次反馈动画 */
  celebrate(role: string, kind: 'catch' | 'done' | 'levelup' | 'highfive' | 'coins'): void;
  /** 让某 agent 冒一句话 */
  say(role: string, text: string, ms?: number): void;
  /** 金信封从信箱飞到某 agent */
  sendGold(to: string): void;
  /** 空格暂停 */
  setPaused(paused: boolean): void;
  /** agent 头顶的屏幕坐标(放对话框用) */
  agentScreenPos(role: string): ScreenPt | null;
  destroy(): void;
}

export interface Pt {
  x: number;
  y: number;
}
