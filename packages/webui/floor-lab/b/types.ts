/**
 * 楼层 v4 · 布局 B(大楼剖面)的数据契约。
 * 形状刻意贴近真实数据(/api/bots、/api/activity、overview、execution),
 * 以后 React 外壳只需把真 query 映射成 Snapshot 喂给 engine.setData()。
 * 金额一律十进制字符串,时间戳一律 unix 毫秒(仓库约定)。
 */

export type Role =
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

export interface AgentStat {
  label: string;
  value: string;
}

export interface AgentSnap {
  role: Role;
  callsign: string;
  color: string;
  status: AgentStatus;
  /** 人话:这个 agent 此刻在干什么 */
  line: string;
  /** 房间里只放 3 个关键数(可缺省,缺省时房间卡显示「—」) */
  stats?: AgentStat[];
  /** 你派给它的活(进行中);消失 = 干完,引擎播完成动画 */
  task?: { id: string; label: string } | null;
  /** 「你今天干了啥」的一句话小结 */
  today?: string;
}

export interface HandoffSnap {
  /** 可选;缺省时引擎用 at|from|to 做键 */
  id?: string;
  from: Role;
  to: Role;
  /** 人话,动态流里渲染成「FROM <text> → 交给 TO」 */
  text: string;
  at: number;
  /** 接收方接住信封时冒的一句话;缺省「收到」 */
  reply?: string;
}

export interface MeetingSnap {
  id: string;
  roles: Role[];
  topic: string;
  at: number;
}

export interface InboxItem {
  id: string;
  kind: 'approval' | 'handoff';
  title: string;
  detail?: string;
  at: number;
}

// ---------- 进化方格(与 #evolution 页同源) ----------
export type EvoStatus = 'good' | 'ok' | 'bad' | 'none';
export type EvoKind = 'distill' | 'verify' | 'adopt';

export interface EvoDay {
  date: string; // YYYY-MM-DD(UTC)
  status: EvoStatus;
  score: number | null;
  headline: string | null;
  /** 当天「提炼/验证/采纳」进化事件数 */
  events?: number;
  /** 可选:最近一次进化事件的类型(用于动态流措辞);真数据没有时按「提炼」说 */
  last_event?: { kind: EvoKind; text: string };
}

export interface EvoRoleRow {
  role: Role;
  /** 旧 → 新,最后一格是今天 */
  days: EvoDay[];
}

export interface EvoDayDetail {
  role: Role;
  date: string;
  metrics: AgentStat[];
  records: { title: string; detail: string }[];
}

/** 非交接类的团队动态(派活 / 审批 / 策略运行 / 进化 / 紧急停止…) */
export interface ActivityItem {
  id: string;
  role: Role | 'user';
  kind: 'task_start' | 'task_done' | 'approval' | 'strategy_run' | 'evo' | 'watch' | 'system';
  text: string;
  at: number;
}

/** 天气即状态:只读行情 / 风控 / 时间 */
export interface MarketState {
  /** BTC 1 小时波动(百分比,十进制字符串) */
  btc_vol_1h: string;
  risk_level: 'low' | 'mid' | 'high';
}

export interface StrategyCard {
  id: string;
  name: string;
  symbol: string;
  stage: 'draft' | 'backtest' | 'paper' | 'live';
}

export interface Snapshot {
  agents: AgentSnap[];
  handoffs: HandoffSnap[];
  money: { equity: string; pnl_today: string; positions: number };
  inbox: { count: number; items: InboxItem[] };
  /** 可选:多人「开会」事件(真数据里可由 council 投票 / 多角色任务映射) */
  meetings?: MeetingSnap[];
  /** 可选:每个角色最近 30 天的进化方格 */
  evolution?: EvoRoleRow[];
  activity?: ActivityItem[];
  market?: MarketState;
  strategy?: StrategyCard;
}

export type ThemeId = 'study' | 'command' | 'meme';

export interface MountOptions {
  theme: ThemeId;
  /** 点 agent 或退出房间时回调;null = 回全景 */
  onSelectAgent?: (role: Role | null) => void;
  /** 信封送达(接收方接住)时回调,用于动态流把「在路上」翻成「已接住」 */
  onHandoffDelivered?: (key: string) => void;
  /** 画布上方的 DOM 覆盖层(气泡 / 房间卡);缺省时引擎自己在 canvas 的父元素里建一个 */
  overlay?: HTMLElement;
  /** 覆盖系统 prefers-reduced-motion 检测 */
  reducedMotion?: boolean;
  /** 房间卡「打开工作台」的跳转;缺省 location.hash = page */
  onOpenWorkbench?: (role: Role, page: string) => void;
  /** 点进化方格某一格时取当天详情(真数据接 /api/evolution/day);缺省时抽屉只显示方格本身的字段 */
  getEvoDetail?: (role: Role, date: string) => EvoDayDetail | Promise<EvoDayDetail | null> | null;
  /** 抽屉里「去进化页看全部」;缺省 location.hash = `evolution?role=&date=` */
  onOpenEvolution?: (role: Role, date: string) => void;
  /** NPC 对话框里的选择:聊聊 / 派活 / 打开工作台 */
  onAgentAction?: (role: Role, action: 'chat' | 'task' | 'workbench', task?: TaskDef) => void;
  /** 点门口信箱(有待批订单时亮灯) */
  onMailbox?: () => void;
  /** 彩蛋等轻提示 */
  onToast?: (text: string) => void;
}

export interface TaskDef {
  id: string;
  label: string;
  /** 干完后的一句话结果(mock 用) */
  result: string;
  /** 真实入口(接真数据时调它) */
  real: string;
}

export interface FloorHandle {
  setData(snapshot: Snapshot): void;
  setTheme(id: ThemeId): void;
  /** 程序化进房间 / 回全景 */
  focus(role: Role | null): void;
  /** 拖拽投放:客户端坐标下是哪个 agent(没有返回 null) */
  pick(clientX: number, clientY: number): Role | null;
  /** 拖拽悬停目标:该 agent 伸手 + 工位高亮 */
  setDropTarget(role: Role | null): void;
  /** 松手后「接住」动画 + 一句话 */
  catchDrop(role: Role, line: string): void;
  /** 审批结果:批准 → 金信封从信箱飞向 EXEC;拒绝 → 信封揉成纸团 */
  approval(approved: boolean): void;
  /** 紧急停止的场景表现(警报灯旋转、全员停手) */
  emergency(): void;
  /** 空格:暂停 / 继续动画,返回是否已暂停 */
  togglePause(): boolean;
  /** 覆盖天气(演示用;null = 跟随真实状态) */
  setWeatherOverride(w: 'rain' | 'clear' | 'night' | 'day' | null): void;
  destroy(): void;
}

export const EVO_KIND_LABEL: Record<EvoKind, { verb: string; plus: string }> = {
  distill: { verb: '提炼了', plus: '+1 教训' },
  verify: { verb: '验证了', plus: '+1 验证' },
  adopt: { verb: '采纳了', plus: '+1 采纳' },
};

export function handoffKey(h: HandoffSnap): string {
  return h.id ?? `${h.at}|${h.from}|${h.to}`;
}
