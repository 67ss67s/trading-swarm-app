/**
 * 渲染入口:把 World 画到逻辑分辨率的画布上(镜头 / 放大在 engine.ts 里做)。
 * 图层顺序:天空 → 城市 → 雨 → 街道 → 井道 → 茶水间 → 房间后景 → 轿厢 + 乘客 → 外壳 → 屋顶
 *         → 椅背 → 坐着的角色 → 桌面前景 → 走动的角色 → 宠物 → 信封 → 状态图标 → 灯光 → 粒子 → 聚焦遮罩
 */
import type { Theme } from './themes';
import type { EvoRoleRow, Role } from './types';
import { drawBoard, drawPanel } from './evo';
import { drawThunder, drawRoofAlarm, drawEmergency, type Weather } from './weather';
import { ROLES } from './roles';
import type { World, Actor } from './world';
import type { RoomGeo } from './layout';
import { drawSky, drawCity, drawRain, drawStreet, drawStreetGlow, drawShellBack, drawShellFront, drawCab, drawCabDoors, drawRoof } from './env';
import { roomBack, terrace, type RoomCtx } from './rooms';
import { roomMid, roomFront, roomLights, drawZ } from './rooms-front';
import { drawAgent, drawPet, R, P, glow, ring, rgba, shade, text, AH, type Ctx, type Pose } from './sprites';

export interface RenderOpts {
  focus: Role | null;
  hover: Role | null;
  /** 聚焦遮罩强度 0..1(镜头推进时渐入) */
  focusAmt: number;
  evo: Map<Role, EvoRoleRow>;
  /** 展开 30 天方格的房间 */
  evoExpanded: Role | null;
  evoHover: { role: Role; index: number } | null;
  weather: Weather;
  /** 待批订单数(信箱灯) */
  approvals: number;
  /** 连点雕像的计数(雕像发光) */
  statueHits: number;
}

let RAIN = false;
function rc(W: World, th: Theme, role: Role): RoomCtx {
  const a = W.actors.get(role)!;
  return { th, t: W.t, status: a.status, reduced: W.reduced, L: W.L, rain: RAIN };
}

function isSeated(W: World, a: Actor): boolean {
  const room = W.L.rooms[a.role];
  if (a.mode === 'stay' && a.plan.length === 0 && a.meeting) return true;
  return !a.away && a.mode === 'idle' && a.plan.length === 0 && a.level === room.level && Math.abs(a.x - room.seatX) < 1;
}

function poseOf(W: World, a: Actor): Pose {
  if (a.poseOverride) return a.poseOverride;
  if (a.waveUntil > W.t) return Math.floor(W.t * 5) % 2 ? 'talk' : 'catch';
  if (a.mode === 'walk') return Math.floor(a.walked / 3) % 2 ? 'walk1' : 'walk2';
  if (a.mode === 'stay') return a.stayPose;
  return 'stand';
}

export function drawActor(ctx: Ctx, W: World, th: Theme, a: Actor, x: number, y: number): void {
  const info = ROLES[a.role];
  const t = W.t;
  const pose = poseOf(W, a);
  const phase = a.role.length * 0.37;
  const breath = W.reduced ? 0 : ((Math.floor((t + phase) / (a.status === 'idle' ? 1.1 : 0.75)) % 2) as 0 | 1);
  const blink = !W.reduced && t >= a.blinkAt && t < a.blinkAt + 0.14;
  const bob = pose === 'walk1' ? 1 : pose === 'catch' && !W.reduced ? Math.round(Math.abs(Math.sin(t * 9)) * 2) : 0;
  const look = a.poseOverride === 'catch' ? 0 : a.look;
  // 脚下阴影
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  const small = a.mode === 'inLift';
  ctx.fillRect(Math.round(x - (small ? 5 : 7)), Math.round(y), small ? 10 : 14, 1);
  drawAgent(ctx, info.shape, info.color, th.outline, x, y, { pose, blink, look, breath: pose === 'walk1' || pose === 'walk2' ? 0 : breath }, bob, small);
}

function statusIcon(ctx: Ctx, W: World, a: Actor, x: number, y: number): void {
  const t = W.t;
  const top = y - AH - 7;
  if (a.status === 'stuck') {
    if (W.reduced || Math.floor(t * 3) % 2 === 0) {
      R(ctx, x - 2, top - 7, 5, 8, '#1a0508');
      R(ctx, x - 1, top - 6, 3, 4, '#ff3b5c');
      R(ctx, x - 1, top - 1, 3, 1, '#ff3b5c');
      glow(ctx, x, top - 3, 6, '#ff3b5c', 0.35);
    }
  } else if (a.task) {
    // 你派的活:头顶小写字板 + 转圈进度点
    R(ctx, x - 4, top - 9, 9, 9, '#1a1408');
    R(ctx, x - 3, top - 8, 7, 7, '#f2e6c4');
    R(ctx, x - 1, top - 9, 3, 2, '#8a6a3a');
    for (let i = 0; i < 3; i++) R(ctx, x - 2, top - 6 + i * 2, i === 2 ? 3 : 5, 1, '#6a5a3a');
    const k = W.reduced ? 0 : Math.floor(t * 6) % 4;
    const pts: [number, number][] = [[6, -8], [7, -6], [6, -4], [5, -6]];
    pts.forEach(([dx, dy], i) => P(ctx, x + dx, top + dy, i === k ? '#ffe36b' : '#6a5a3a'));
  } else if (a.status === 'waiting' && isSeated(W, a)) {
    const k = W.reduced ? 3 : Math.floor(t * 2.5) % 4;
    R(ctx, x - 5, top - 4, 11, 5, 'rgba(10,10,14,0.75)');
    for (let i = 0; i < 3; i++) P(ctx, x - 3 + i * 3, top - 2, i < k ? '#ffd166' : '#5a5040');
  }
}

function drawEnvelope(ctx: Ctx, x: number, y: number, color: string, th: Theme): void {
  x = Math.round(x) - 3;
  y = Math.round(y) - 2;
  glow(ctx, x + 3, y + 2, 8, color, 0.4);
  R(ctx, x - 1, y - 1, 9, 7, th.outline);
  R(ctx, x, y, 7, 5, '#fff4d6');
  P(ctx, x, y, '#e8d8b0'); P(ctx, x + 6, y, '#e8d8b0');
  P(ctx, x + 1, y + 1, '#c9b48a'); P(ctx, x + 5, y + 1, '#c9b48a');
  P(ctx, x + 2, y + 2, '#c9b48a'); P(ctx, x + 4, y + 2, '#c9b48a');
  P(ctx, x + 3, y + 3, color);
  R(ctx, x, y + 4, 7, 1, '#e8d8b0');
}

export function render(ctx: Ctx, W: World, th: Theme, o: RenderOpts): void {
  const L = W.L;
  const t = W.t;
  ctx.imageSmoothingEnabled = false;
  const wx = o.weather;
  RAIN = wx.rain;
  drawSky(ctx, L, th, t, W.reduced, wx.night, wx.rain);
  drawCity(ctx, L, th, t, W.reduced, wx.night);
  if (wx.thunder) drawThunder(ctx, L, t, W.reduced);
  drawRain(ctx, L, wx.rain, t, W.reduced);
  drawStreet(ctx, L, th, t, W.reduced);
  drawMailbox(ctx, W, th, o.approvals);
  drawStatue(ctx, W, th, o.statueHits);
  drawShellBack(ctx, L, th);
  terrace(ctx, L, { th, t, status: 'idle', reduced: W.reduced, L });

  const rooms = Object.values(L.rooms) as RoomGeo[];
  for (const r of rooms) roomBack(ctx, r, rc(W, th, r.role));

  // 轿厢 + 乘客
  const doorOpen = W.cab.doorT > 0;
  const cab = drawCab(ctx, L, th, W.cabFloorY(), doorOpen, W.cab.ding);
  for (const a of W.actors.values()) {
    if (a.mode !== 'inLift') continue;
    const p = W.actorPos(a);
    drawActor(ctx, W, th, a, p.x, p.y);
  }
  for (const e of W.envelopes) {
    if (e.mode !== 'inLift') continue;
    const p = W.envPos(e);
    drawEnvelope(ctx, p.x, p.y, e.color, th);
  }
  drawCabDoors(ctx, cab, th, doorOpen);

  drawShellFront(ctx, L, th, t, W.cab.pos, W.reduced, W.lobbyOpen());
  drawRoof(ctx, L, th, t, ROLES.radar.color, W.reduced);
  if (wx.alarm || W.alarmUntil > t) drawRoofAlarm(ctx, L, t, W.reduced, W.alarmUntil > t);

  for (const r of rooms) roomMid(ctx, r, rc(W, th, r.role));
  const seated: Actor[] = [];
  const others: Actor[] = [];
  for (const a of W.actors.values()) {
    if (a.mode === 'inLift') continue;
    (isSeated(W, a) ? seated : others).push(a);
  }
  // 坐在工位上的人抬高 3px(坐在椅子上),桌面只挡住腿
  for (const a of seated) { const p = W.actorPos(a); drawActor(ctx, W, th, a, p.x, p.y - (a.meeting ? 0 : 3)); }
  for (const r of rooms) {
    const a = W.actors.get(r.role)!;
    const typing = a.status === 'working' && isSeated(W, a) && !a.meeting && !a.poseOverride;
    roomFront(ctx, r, rc(W, th, r.role), L, typing);
  }
  for (const a of others) { const p = W.actorPos(a); drawActor(ctx, W, th, a, p.x, p.y); }

  // 宠物在茶水间长椅上睡觉
  const bx = L.wingX + Math.round((L.wingW - 2) * 0.55);
  const petBreath = !W.reduced && Math.floor(t / 1.4) % 2 === 0;
  if (W.petRollUntil > t) {
    // 彩蛋:翻身打哈欠
    const hop = W.reduced ? 0 : Math.round(Math.abs(Math.sin((W.petRollUntil - t) * 5)) * 2);
    ctx.save();
    ctx.translate(bx + 3 + 14, 0);
    ctx.scale(-1, 1);
    drawPet(ctx, th.pet, 0, L.wingTop - 6 - hop, true, th.outline);
    ctx.restore();
  } else {
    drawPet(ctx, th.pet, bx + 3, L.wingTop - 6, petBreath, th.outline);
    if (!W.reduced) drawZ(ctx, bx + 6, L.wingTop - 13, t, '#e8e6df');
  }

  // 信封 + 拖尾
  for (const e of W.envelopes) {
    if (e.mode === 'inLift') continue;
    const p = W.envPos(e);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    e.trail.forEach((tp, i) => {
      if (tp.level !== e.level || e.state === 'onDesk') return;
      const k = i / e.trail.length;
      ctx.fillStyle = rgba(e.color, 0.55 * k);
      const ty = L.floorY(tp.level) - 21;
      ctx.fillRect(Math.round(tp.x), ty + (i % 2), 1, 1 + (k > 0.6 ? 1 : 0));
    });
    ctx.restore();
    drawEnvelope(ctx, p.x, p.y, e.color, th);
  }

  for (const a of W.actors.values()) {
    if (a.mode === 'inLift') continue;
    const p = W.actorPos(a);
    statusIcon(ctx, W, a, p.x, p.y);
  }

  // 灯光
  for (const r of rooms) roomLights(ctx, r, rc(W, th, r.role));
  drawStreetGlow(ctx, L, th);
  if (W.alarmUntil > t) drawEmergency(ctx, L, rooms, t, W.alarmUntil - t, W.reduced);

  // 拖拽目标:工位高亮 + 头顶箭头
  if (W.dropTarget) {
    const r = L.rooms[W.dropTarget];
    const col = ROLES[W.dropTarget].color;
    const on = W.reduced || Math.floor(t * 6) % 2 === 0;
    ctx.fillStyle = rgba(col, on ? 0.95 : 0.5);
    ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, 2);
    ctx.fillRect(r.x - 1, r.y + r.h - 1, r.w + 2, 2);
    ctx.fillRect(r.x - 1, r.y - 1, 2, r.h + 2);
    ctx.fillRect(r.x + r.w - 1, r.y - 1, 2, r.h + 2);
    const a = W.actors.get(W.dropTarget)!;
    const p = W.actorPos(a);
    const ay = p.y - AH - 12 - (W.reduced ? 0 : Math.round(Math.abs(Math.sin(t * 6)) * 2));
    R(ctx, p.x - 3, ay, 7, 1, col); R(ctx, p.x - 2, ay + 1, 5, 1, col); R(ctx, p.x - 1, ay + 2, 3, 1, col); P(ctx, p.x, ay + 3, col);
  }
  // 点地板的小涟漪
  for (const rp of W.ripples) {
    const k = (t - rp.t0) / 0.6;
    const rx = 2 + k * 10, ry = Math.max(1, rx * 0.35);
    ctx.fillStyle = `rgba(255,255,255,${0.7 * (1 - k)})`;
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; ctx.fillRect(Math.round(rp.x + Math.cos(a) * rx), Math.round(rp.y + Math.sin(a) * ry), 1, 1); }
  }

  // 进化灯板(灯光之后画,保持像素清晰)
  for (const r of rooms) {
    const hv = o.evoHover && o.evoHover.role === r.role ? o.evoHover.index : null;
    drawBoard(ctx, r, o.evo.get(r.role), th, t, W.reduced, W.evoFlash(r.role), hv, o.evoExpanded === r.role);
  }
  if (o.evoExpanded) {
    const r = L.rooms[o.evoExpanded];
    const hv = o.evoHover && o.evoHover.role === r.role ? o.evoHover.index : null;
    drawPanel(ctx, r, o.evo.get(r.role), th, t, W.reduced, hv);
  }
  // 升级光圈
  for (const fx of W.evoFx) {
    const a = W.actors.get(fx.role);
    if (!a) continue;
    const p = W.actorPos(a);
    const k = (t - fx.t0) / 1.6;
    if (W.reduced) continue;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ring(ctx, p.x, p.y - 10, 5 + k * 18, rgba('#ffe36b', 0.9 * (1 - k)));
    ring(ctx, p.x, p.y - 10, 3 + k * 10, rgba('#ffffff', 0.6 * (1 - k)));
    ctx.restore();
    glow(ctx, p.x, p.y - 10, 13, '#ffe36b', 0.3 * (1 - k));
  }

  // 粒子
  for (const p of W.particles) {
    ctx.fillStyle = rgba(p.color, Math.max(0, Math.min(1, (p.life / p.max) * 1.5)));
    const sz = p.size ?? 1;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), sz, sz);
  }

  // 悬停描边
  if (o.hover && o.hover !== o.focus) {
    const r = L.rooms[o.hover];
    const col = ROLES[o.hover].color;
    ctx.fillStyle = rgba(col, 0.9);
    const x0 = r.x - 1, y0 = r.y - 1, w = r.w + 2, h = r.h + 2;
    for (let i = 0; i < w; i += 3) { ctx.fillRect(x0 + i, y0, 2, 1); ctx.fillRect(x0 + i, y0 + h - 1, 2, 1); }
    for (let i = 0; i < h; i += 3) { ctx.fillRect(x0, y0 + i, 1, 2); ctx.fillRect(x0 + w - 1, y0 + i, 1, 2); }
  }

  // 聚焦遮罩
  if (o.focus && o.focusAmt > 0) {
    const r = focusRect(W, o.focus);
    ctx.save();
    ctx.fillStyle = `rgba(4,4,10,${0.62 * o.focusAmt})`;
    ctx.beginPath();
    ctx.rect(0, 0, L.LW, L.LH);
    ctx.rect(r.x + r.w, r.y, -r.w, r.h);
    ctx.fill('evenodd');
    ctx.restore();
    const col = ROLES[o.focus].color;
    ctx.fillStyle = rgba(col, 0.8 * o.focusAmt);
    ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, 1);
    ctx.fillRect(r.x - 1, r.y + r.h, r.w + 2, 1);
    ctx.fillRect(r.x - 1, r.y - 1, 1, r.h + 2);
    ctx.fillRect(r.x + r.w, r.y - 1, 1, r.h + 2);
    ctx.fillStyle = shade(col, 0.4);
    ctx.fillRect(r.x - 1, r.y - 1, 3, 1);
    ctx.fillRect(r.x + r.w - 2, r.y + r.h, 3, 1);
  }
}

/** 聚焦时露出的区域(RADAR 连屋顶圆顶一起露出) */
export function focusRect(W: World, role: Role): { x: number; y: number; w: number; h: number } {
  const r = W.L.rooms[role];
  const L = W.L;
  if (role === 'radar') return { x: r.x - L.wall, y: L.towerTop - 34, w: r.w + L.wall + L.shaftW, h: r.y + r.h - (L.towerTop - 34) + L.slab };
  return { x: r.x, y: r.y - L.slab, w: r.w, h: r.h + L.slab * 2 };
}

/** 门口信箱:有待批订单时小旗竖起、灯闪、金信封露出来 */
export function drawMailbox(ctx: Ctx, W: World, th: Theme, n: number): void {
  const x = W.mailboxX, g = W.L.groundY, t = W.t;
  R(ctx, x + 3, g - 9, 1, 9, th.metal.dark);
  R(ctx, x - 1, g - 17, 10, 9, th.outline);
  R(ctx, x, g - 16, 8, 7, '#c8453a');
  R(ctx, x, g - 16, 8, 1, '#e8735f');
  R(ctx, x + 1, g - 14, 6, 1, '#5a1a14');
  R(ctx, x, g - 10, 8, 1, '#8a2a20');
  if (n > 0) {
    // 小旗竖起 + 灯
    R(ctx, x + 9, g - 21, 1, 8, th.metal.b);
    R(ctx, x + 10, g - 21, 3, 2, '#ffd23a');
    const on = W.reduced || Math.floor(t * 2.5) % 2 === 0;
    R(ctx, x + 3, g - 19, 2, 2, on ? '#ffe36b' : '#6a5a1a');
    if (on) glow(ctx, x + 4, g - 18, 7, '#ffe36b', 0.45);
    // 金信封从投信口探出来
    const bob = W.reduced ? 0 : Math.round(Math.sin(t * 3) * 1);
    const ex = x + 1, ey = g - 25 + bob;
    glow(ctx, ex + 3, ey + 2, 8, '#ffd23a', 0.35);
    R(ctx, ex - 1, ey - 1, 9, 7, th.outline);
    R(ctx, ex, ey, 7, 5, '#ffd23a');
    P(ctx, ex + 1, ey + 1, '#b8860b'); P(ctx, ex + 5, ey + 1, '#b8860b'); P(ctx, ex + 2, ey + 2, '#b8860b'); P(ctx, ex + 4, ey + 2, '#b8860b');
    P(ctx, ex + 3, ey + 3, '#c8453a');
    if (n > 1) text(ctx, String(Math.min(9, n)), ex + 9, ey - 1, '#ffe36b');
  } else {
    R(ctx, x + 9, g - 14, 4, 1, th.metal.b);
    R(ctx, x + 12, g - 15, 2, 2, '#7a6a3a');
  }
}

/** 吉祥物雕像(金色招财柴犬):连点 5 次撒金币 */
export function drawStatue(ctx: Ctx, W: World, th: Theme, hits: number): void {
  const x = W.statueX, g = W.L.groundY, t = W.t;
  R(ctx, x - 1, g - 7, 16, 7, th.outline);
  R(ctx, x, g - 6, 14, 6, th.metal.b);
  R(ctx, x, g - 6, 14, 1, th.metal.a);
  R(ctx, x + 2, g - 4, 10, 1, th.metal.dark);
  const rows = ['.o......o.', '.oo....oo.', '.oooooooo.', 'ooeooooeoo', 'oooowwoooo', '.oooooooo.', '..oooooo..', '.oo.oo.oo.', '.oo.oo.oo.'];
  const gold = '#f2c14a', dark = '#b8862a', hi = '#fff0a8';
  const oy = g - 7 - rows.length;
  rows.forEach((r, yy) => [...r].forEach((ch, xx) => {
    if (ch === '.') return;
    const c = ch === 'e' ? '#3a2408' : ch === 'w' ? hi : yy < 3 || xx < 2 ? hi : yy > 6 || xx > 7 ? dark : gold;
    P(ctx, x + 2 + xx, oy + yy, c);
  }));
  const glint = W.reduced ? false : (t * 0.7) % 3 < 0.25;
  if (glint || hits > 0) { P(ctx, x + 4, oy + 1, '#ffffff'); glow(ctx, x + 7, oy + 4, 8 + hits * 2, '#ffd23a', 0.12 + hits * 0.06); }
}
