/**
 * 大楼剖面的几何:按逻辑画布尺寸算出每层楼、电梯井、侧楼、屋顶的像素矩形。
 * 主楼自上而下:L5 RADAR → L4 THREAD → L3 LAB → L2 BOOK → L1 SENTINEL → L0 EXEC。
 * 侧楼:L0 MARKET(临街小铺)、L1 AUDIT(图书馆)、L2–L3 HELM(双层指挥层)、L4 屋顶茶水间。
 */
import type { Role } from './types';

export interface Rect { x: number; y: number; w: number; h: number }

export interface RoomGeo extends Rect {
  role: Role;
  level: number;
  side: 'main' | 'wing';
  /** 座位(脚底中心 x) */
  seatX: number;
}

export interface Layout {
  LW: number;
  LH: number;
  groundY: number;
  floorH: number;
  slab: number;
  wall: number;
  mainX: number;
  mainW: number;
  shaftX: number;
  shaftW: number;
  wingX: number;
  wingW: number;
  towerTop: number;
  wingTop: number;
  rooms: Record<Role, RoomGeo>;
  terrace: Rect & { level: number };
  meetSeats: number[];
  meetTableX: number;
  coffeeX: number;
  /** 某一层的地面 y(脚底) */
  floorY(level: number): number;
  /** 某一层主楼 / 侧楼能走的 x 区间 */
  walkRange(level: number, side: 'main' | 'wing'): [number, number];
  shaftCenter: number;
}

export function computeLayout(LW: number, LH: number): Layout {
  const street = 26;
  const groundY = LH - street;
  const topReserve = 46; // 圆顶 + 天线 + 一点天空
  const floorH = Math.max(34, Math.min(54, Math.floor((groundY - topReserve) / 6)));
  const slab = 4;
  const wall = 5;
  const shaftW = 24;
  const mainW = Math.max(158, Math.min(236, Math.round(LW * 0.4)));
  const wingW = Math.max(128, Math.min(186, Math.round(LW * 0.3)));
  const total = mainW + shaftW + wingW;
  const mainX = Math.round((LW - total) / 2) - 6;
  const shaftX = mainX + mainW;
  const wingX = shaftX + shaftW;
  const floorY = (l: number) => groundY - l * floorH;
  const towerTop = floorY(6);
  const wingTop = floorY(4);

  const mk = (role: Role, level: number, side: 'main' | 'wing', levels = 1, seatFrac = 0.5): RoomGeo => {
    const x = side === 'main' ? mainX + wall : wingX;
    const w = side === 'main' ? mainW - wall : wingW - wall;
    const y = floorY(level + levels) + slab;
    const h = floorY(level) - y;
    return { role, level, side, x, y, w, h, seatX: Math.round(x + w * seatFrac) };
  };

  const rooms: Record<Role, RoomGeo> = {
    radar: mk('radar', 5, 'main', 1, 0.56),
    thread_manager: mk('thread_manager', 4, 'main', 1, 0.6),
    strategy_lab: mk('strategy_lab', 3, 'main', 1, 0.58),
    portfolio_manager: mk('portfolio_manager', 2, 'main', 1, 0.52),
    risk_sentinel: mk('risk_sentinel', 1, 'main', 1, 0.54),
    executor: mk('executor', 0, 'main', 1, 0.5),
    asp_agent: mk('asp_agent', 0, 'wing', 1, 0.42),
    reviewer: mk('reviewer', 1, 'wing', 1, 0.55),
    gate_captain: mk('gate_captain', 2, 'wing', 2, 0.82),
  };
  const helm = rooms.gate_captain;
  const meetTableX = Math.round(helm.x + helm.w * 0.42);
  const meetSeats = [-20, 20, -38, 36, -54].map((d) => Math.max(helm.x + 9, Math.min(helm.x + helm.w - 9, meetTableX + d)));
  const terrace = { x: wingX, y: floorY(5), w: wingW - wall, h: floorH, level: 4 };

  return {
    LW, LH, groundY, floorH, slab, wall, mainX, mainW, shaftX, shaftW, wingX, wingW, towerTop, wingTop,
    rooms, terrace, meetSeats, meetTableX,
    coffeeX: Math.round(wingX + 22),
    floorY,
    walkRange(level, side) {
      if (side === 'main') return [mainX + wall + 8, shaftX - 2];
      if (level === 4) return [wingX + 2, wingX + wingW - wall - 10];
      return [wingX + 2, wingX + wingW - wall - 8];
    },
    shaftCenter: shaftX + shaftW / 2,
  };
}

/** 角色所在的层 / 侧 */
export function roleSpot(L: Layout, role: Role): { level: number; side: 'main' | 'wing'; x: number } {
  const r = L.rooms[role];
  return { level: r.level, side: r.side, x: r.seatX };
}
