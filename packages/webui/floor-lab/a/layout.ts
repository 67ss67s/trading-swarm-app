/**
 * 布局 A · 开放办公室:世界 640×360 逻辑像素。9 张工位围着中央会议桌,一圈走廊(环)+ 每桌一条支路。
 * 信封和走动的 agent 都沿「支路 → 环 → 支路」走,保证看起来是顺着走廊。
 */
import type { Pt, RoleId } from './types';

export const WORLD_W = 640;
export const WORLD_H = 360;
export const WALL_H = 96;
/** 缓冲区在世界四周多画的边(大屏时相机能看到更多天花板/地板/侧墙) */
export const EX = 40;
export const EY = 40;
export const BUF_W = WORLD_W + 2 * EX;
export const BUF_H = WORLD_H + 2 * EY;
export const XL = -EX;
export const XR = WORLD_W + EX;
export const YT = -EY;
export const YB = WORLD_H + EY;

export interface DeskSpot {
  role: RoleId;
  x: number;
  /** 桌面前沿 y */
  y: number;
  seat: Pt;
  /** 从座位走到环上的折线(不含座位,最后一点在环上) */
  exit: Pt[];
  kind: 'desk' | 'kiosk';
  /** 桌子朝向:角色坐在桌后,面朝观众 */
  wide: number;
}

export const DESKS: DeskSpot[] = [
  { role: 'radar', x: 184, y: 146, seat: { x: 184, y: 140 }, exit: [{ x: 246, y: 140 }, { x: 246, y: 176 }], kind: 'desk', wide: 80 },
  { role: 'gate_captain', x: 320, y: 142, seat: { x: 320, y: 136 }, exit: [{ x: 391, y: 136 }, { x: 391, y: 176 }], kind: 'desk', wide: 92 },
  { role: 'strategy_lab', x: 456, y: 146, seat: { x: 456, y: 140 }, exit: [{ x: 391, y: 140 }, { x: 391, y: 176 }], kind: 'desk', wide: 80 },
  { role: 'thread_manager', x: 112, y: 222, seat: { x: 112, y: 216 }, exit: [{ x: 160, y: 216 }, { x: 160, y: 226 }, { x: 180, y: 226 }], kind: 'desk', wide: 76 },
  { role: 'portfolio_manager', x: 112, y: 304, seat: { x: 112, y: 298 }, exit: [{ x: 160, y: 298 }, { x: 160, y: 266 }, { x: 180, y: 266 }], kind: 'desk', wide: 76 },
  { role: 'reviewer', x: 528, y: 222, seat: { x: 528, y: 216 }, exit: [{ x: 480, y: 216 }, { x: 480, y: 226 }, { x: 460, y: 226 }], kind: 'desk', wide: 76 },
  { role: 'risk_sentinel', x: 528, y: 304, seat: { x: 528, y: 298 }, exit: [{ x: 480, y: 298 }, { x: 480, y: 266 }, { x: 460, y: 266 }], kind: 'desk', wide: 76 },
  { role: 'executor', x: 262, y: 312, seat: { x: 262, y: 306 }, exit: [{ x: 262, y: 276 }], kind: 'desk', wide: 84 },
  { role: 'asp_agent', x: 380, y: 312, seat: { x: 380, y: 306 }, exit: [{ x: 380, y: 276 }], kind: 'kiosk', wide: 78 },
];

/** 相机取景框:内容的包围盒(舞台按它来放大) */
export const VIEW = { cx: 320, cy: 172, w: 500, h: 344 };

export function deskOf(role: string): DeskSpot | undefined {
  return DESKS.find((d) => d.role === role);
}

export const RING = { x1: 180, y1: 176, x2: 460, y2: 276 };
const RING_PTS: Pt[] = [
  { x: RING.x1, y: RING.y1 },
  { x: RING.x2, y: RING.y1 },
  { x: RING.x2, y: RING.y2 },
  { x: RING.x1, y: RING.y2 },
];
const RW = RING.x2 - RING.x1;
const RH = RING.y2 - RING.y1;
export const RING_LEN = 2 * (RW + RH);

export const TABLE = { x: 320, y: 226, rx: 60, ry: 20 };
export const GLOBE = { x: 320, y: 196, r: 14 };
export const PANTRY = { spot: { x: 104, y: 152 }, path: [{ x: 104, y: 170 }, { x: 180, y: 176 }] as Pt[] };
export const SOFA = { x: 546, y: 132 };
export const MEETING_SEATS: Pt[] = [
  { x: 258, y: 212 },
  { x: 382, y: 212 },
  { x: 244, y: 240 },
  { x: 396, y: 240 },
  { x: 290, y: 262 },
  { x: 350, y: 262 },
];

/** 环上某点 → 弧长参数 */
export function ringParam(p: Pt): number {
  const { x1, y1, x2, y2 } = RING;
  const dTop = Math.abs(p.y - y1);
  const dRight = Math.abs(p.x - x2);
  const dBot = Math.abs(p.y - y2);
  const dLeft = Math.abs(p.x - x1);
  const m = Math.min(dTop, dRight, dBot, dLeft);
  if (m === dTop) return Math.max(0, Math.min(RW, p.x - x1));
  if (m === dRight) return RW + Math.max(0, Math.min(RH, p.y - y1));
  if (m === dBot) return RW + RH + Math.max(0, Math.min(RW, x2 - p.x));
  return 2 * RW + RH + Math.max(0, Math.min(RH, y2 - p.y));
}

export function ringPoint(s: number): Pt {
  s = ((s % RING_LEN) + RING_LEN) % RING_LEN;
  if (s < RW) return { x: RING.x1 + s, y: RING.y1 };
  s -= RW;
  if (s < RH) return { x: RING.x2, y: RING.y1 + s };
  s -= RH;
  if (s < RW) return { x: RING.x2 - s, y: RING.y2 };
  s -= RW;
  return { x: RING.x1, y: RING.y2 - s };
}

/** 环上两点之间走较短方向,返回途经拐角(不含起点,含终点) */
export function ringRoute(a: Pt, b: Pt): Pt[] {
  const sa = ringParam(a);
  const sb = ringParam(b);
  let fwd = sb - sa;
  if (fwd < 0) fwd += RING_LEN;
  const dir = fwd <= RING_LEN / 2 ? 1 : -1;
  const dist = dir === 1 ? fwd : RING_LEN - fwd;
  const out: Pt[] = [];
  const corners = [0, RW, RW + RH, 2 * RW + RH];
  // 按行进方向列出途经拐角
  const hits: { d: number; p: Pt }[] = [];
  for (let i = 0; i < 4; i++) {
    const c = corners[i]!;
    let d = dir === 1 ? c - sa : sa - c;
    d = ((d % RING_LEN) + RING_LEN) % RING_LEN;
    if (d > 0.5 && d < dist - 0.5) hits.push({ d, p: RING_PTS[i]! });
  }
  hits.sort((m, n) => m.d - n.d);
  for (const h of hits) out.push(h.p);
  out.push(b);
  return out;
}

export function nearestRing(p: Pt): Pt {
  return ringPoint(ringParam(p));
}

/** 从 A 点(已在环上或可直达环)到 B 点的走廊路径 */
export function routeBetween(fromTrail: Pt[], toTrail: Pt[]): Pt[] {
  // fromTrail:起点 → … → 环上一点;toTrail:终点 → … → 环上一点
  const a = fromTrail[fromTrail.length - 1]!;
  const b = toTrail[toTrail.length - 1]!;
  const mid = ringRoute(a, b);
  mid.pop();
  return [...fromTrail, ...mid, ...toTrail.slice().reverse()];
}

export function trailFromSeat(d: DeskSpot): Pt[] {
  return [d.seat, ...d.exit];
}

export function trailFromPoint(p: Pt): Pt[] {
  return [p, nearestRing(p)];
}

export function polyLen(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return L;
}

export function polyAt(pts: Pt[], d: number): Pt & { dx: number; dy: number } {
  if (pts.length === 1) return { ...pts[0]!, dx: 0, dy: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= L || i === pts.length - 1) {
      const f = L > 0 ? Math.max(0, Math.min(1, d / L)) : 1;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, dx: Math.sign(b.x - a.x), dy: Math.sign(b.y - a.y) };
    }
    d -= L;
  }
  const last = pts[pts.length - 1]!;
  return { ...last, dx: 0, dy: 0 };
}
