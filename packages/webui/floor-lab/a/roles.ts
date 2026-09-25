/**
 * 角色展示元数据(从 src/components/floor/roles.ts + prefs.ts 抄出,保持同源;原型不 import src,方便整块搬走)。
 */
import type { RoleId } from './types';

export type ShapeId = 'blob' | 'tall' | 'wide' | 'boxy';

export const SHAPES: Record<ShapeId, string[]> = {
  blob: ['....####....', '...######...', '..########..', '.##h#eeh#e#.', '.####ee####.', '.##########.', '..##.##.##..', '.###.##.###.', '.##..##..##.', '....#..#....', '...##..##...', '..##....##..'],
  tall: ['....####....', '...######...', '...#e##e#...', '...######...', '....####....', '..########..', '.##########.', '.##.####.##.', '.##.####.##.', '....####....', '....#..#....', '...##..##...'],
  wide: ['..........', '.##....##.', '..##..##..', '.########.', '##e####e##', '##########', '#.######.#', '#.#....#.#', '...#..#...', '..##..##..', '.##....##.', '..........'].map((r) => ('.' + r).padEnd(12, '.')),
  boxy: ['.##########.', '.#h########.', '.##e####e##.', '.##########.', '.###.##.###.', '.####..####.', '.##########.', '..########..', '...##..##...', '...##..##...', '..###..###..', '............'],
};

export type RoomKind = 'helm' | 'radar' | 'lab' | 'thread' | 'audit' | 'book' | 'sentinel' | 'exec' | 'market';

export interface RoleMeta {
  role: RoleId;
  callsign: string;
  title: string;
  desk: string;
  color: string;
  shape: ShapeId;
  room: RoomKind;
  roomName: string;
  page: string;
  pageLabel: string;
}

export const ROLES: Record<RoleId, RoleMeta> = {
  gate_captain: { role: 'gate_captain', callsign: 'HELM', title: 'Gate Captain', desk: '指挥台', color: '#ff7a5c', shape: 'blob', room: 'helm', roomName: '作战桌', page: 'agent', pageLabel: 'Agent 对话' },
  radar: { role: 'radar', callsign: 'RADAR', title: 'Radar', desk: '雷达台', color: '#9be15d', shape: 'tall', room: 'radar', roomName: '天文台', page: 'intel', pageLabel: '信息员' },
  strategy_lab: { role: 'strategy_lab', callsign: 'LAB', title: 'Strategy Lab', desk: '策略实验台', color: '#c98bff', shape: 'boxy', room: 'lab', roomName: '实验室', page: 'my-strategies', pageLabel: '我的策略' },
  thread_manager: { role: 'thread_manager', callsign: 'THREAD', title: 'Thread Manager', desk: '论点台', color: '#5ec8ff', shape: 'wide', room: 'thread', roomName: '线索板', page: 'judgments', pageLabel: '判断记录' },
  reviewer: { role: 'reviewer', callsign: 'AUDIT', title: 'Reviewer', desk: '复盘台', color: '#ffd166', shape: 'tall', room: 'audit', roomName: '图书馆', page: 'history', pageLabel: '复盘' },
  portfolio_manager: { role: 'portfolio_manager', callsign: 'BOOK', title: 'Portfolio Manager', desk: '组合台', color: '#f4a261', shape: 'boxy', room: 'book', roomName: '账本墙', page: 'trade', pageLabel: '交易' },
  risk_sentinel: { role: 'risk_sentinel', callsign: 'SENTINEL', title: 'Risk Sentinel', desk: '风控哨台', color: '#ff5d8f', shape: 'wide', room: 'sentinel', roomName: '瞭望塔', page: 'settings', pageLabel: '设置 · 风控' },
  executor: { role: 'executor', callsign: 'EXEC', title: 'Executor', desk: '执行台', color: '#4fd1c5', shape: 'blob', room: 'exec', roomName: '交易台', page: 'agent', pageLabel: 'Agent · 执行' },
  asp_agent: { role: 'asp_agent', callsign: 'MARKET', title: 'ASP Agent', desk: '市场台', color: '#7fd1ff', shape: 'wide', room: 'market', roomName: '小铺子', page: 'market', pageLabel: '信号市场' },
};

export const ROLE_ORDER: RoleId[] = ['gate_captain', 'radar', 'thread_manager', 'strategy_lab', 'portfolio_manager', 'risk_sentinel', 'executor', 'reviewer', 'asp_agent'];

export function roleMeta(role: string): RoleMeta {
  return (ROLES as Record<string, RoleMeta>)[role] ?? { ...ROLES.gate_captain, role: role as RoleId, callsign: role.toUpperCase().slice(0, 8), title: role, color: '#b8c4ff' };
}

/** 接住交接时的默认短话(交接没带 reply 时用) */
export const CATCH_LINES: Record<string, string[]> = {
  gate_captain: ['收到,我来排', '好,记下了', '这就派活'],
  radar: ['收到,继续盯', '好,加进观察', '明白'],
  thread_manager: ['收到,开条线索', '我来理论点', '接住了'],
  strategy_lab: ['好,跑一轮回测', '收到,进实验', '让我试试'],
  portfolio_manager: ['收到,算下仓位', '看看敞口', '好,记账'],
  risk_sentinel: ['收到,过一遍闸', '我来查风险', '先别急'],
  executor: ['收到,准备下单', '回执稍后到', '执行中'],
  reviewer: ['收到,记进复盘', '回头细看', '好,存档'],
  asp_agent: ['收到,上架', '好,发出去', '记进市场账本'],
};
