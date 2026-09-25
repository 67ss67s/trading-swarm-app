/**
 * 渲染入口:mount(canvas, opts) → FloorHandle。
 * 世界画进 640×360 离屏缓冲,再按整数倍放大 + 相机裁切到画布;点人推镜头进房间。
 * 气泡用 DOM 覆盖层(中文清楚),其余全是 Canvas 像素。React 以后只需 useEffect 里 mount/destroy + setData。
 */
import type { EvoDay, FloorHandle, FloorSnapshot, MountOptions, Pt, ScreenPt, TaskIcon, ThemeId } from './types';
import { THEMES, type Theme } from './themes';
import { BUF_H, BUF_W, DESKS, EX, EY, GLOBE, SOFA, TABLE, VIEW, WALL_H, WORLD_H, WORLD_W, deskOf } from './layout';
import { buildBackground, buildLights, buildVignette, drawFloorDynamic, drawForeground, drawLounge, drawPlants, drawTable, drawWallDynamic, PLANTS, windowRects } from './scene';
import { drawChair, drawDesk, drawMailbox, evoCellRect, EVO_CELLS, mailboxRect, MAILBOX, plateRect } from './desks';
import { drawRoom, roomEvoCellRect, ROOM_AGENT } from './rooms';
import { World, type AgentSim } from './world';
import { drawChar, drawEnvelope, shadow } from './sprites';
import { ellipse, makeCanvas, mix, px, rect, rgba, text, textWidth, type Ctx } from './pixel';

type Mode = 'floor' | 'zoomIn' | 'room' | 'zoomOut';
type Hit =
  | { kind: 'evo'; role: string; idx: number; day: EvoDay }
  | { kind: 'plate'; role: string }
  | { kind: 'mailbox' }
  | { kind: 'agent'; role: string }
  | { kind: 'pet' }
  | { kind: 'globe' }
  | { kind: 'window' }
  | { kind: 'floor'; p: Pt }
  | null;

const ENGINE_CSS = `
.fa-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.fa-bubble{position:absolute;transform:translate(-50%,-100%);white-space:nowrap;font:600 12px/1.25 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1a1410;background:#fffaf0;padding:3px 7px;border:2px solid #1a1410;box-shadow:2px 2px 0 rgba(0,0,0,.45);image-rendering:pixelated;animation:fa-pop .18s steps(3) both}
.fa-bubble::after{content:"";position:absolute;left:50%;bottom:-6px;width:6px;height:4px;margin-left:-3px;background:#fffaf0;border:2px solid #1a1410;border-top:0;box-sizing:content-box}
.fa-bubble.catch{background:#eaffd8}.fa-bubble.catch::after{background:#eaffd8}
.fa-bubble.evo{background:#fff1a8;color:#5a3a00}.fa-bubble.evo::after{background:#fff1a8}
.fa-bubble.done{background:#d8f4ff}.fa-bubble.done::after{background:#d8f4ff}
.fa-bubble.alert{background:#ffd8de}.fa-bubble.alert::after{background:#ffd8de}
@keyframes fa-pop{from{transform:translate(-50%,-80%) scale(.6);opacity:0}to{transform:translate(-50%,-100%) scale(1);opacity:1}}
@media (prefers-reduced-motion: reduce){.fa-bubble{animation:none}}
`;

function glove(): string {
  const [c, g] = makeCanvas(16, 16);
  const rows = ['..##............', '.#ww#...........', '.#ww#...........', '.#ww###.........', '.#ww#ww##.......', '.#ww#ww#w#......', '##ww#ww#w##.....', '#wwwwwwwwww#....', '#wwwwwwwwww#....', '.#wwwwwwwww#....', '.#wwwwwwwww#....', '..#wwwwwww#.....', '...#######......'];
  rows.forEach((r, y) => [...r].forEach((ch, x) => ch !== '.' && px(g, x, y, ch === '#' ? '#1a1410' : '#fffaf0')));
  return `url(${c.toDataURL()}) 3 1, pointer`;
}

export function mount(canvas: HTMLCanvasElement, opts: MountOptions): FloorHandle {
  if (!document.getElementById('fa-engine-css')) {
    const st = document.createElement('style');
    st.id = 'fa-engine-css';
    st.textContent = ENGINE_CSS;
    document.head.appendChild(st);
  }
  const parent = canvas.parentElement!;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;flex:none;line-height:0';
  parent.insertBefore(wrap, canvas);
  wrap.appendChild(canvas);
  const layer = document.createElement('div');
  layer.className = 'fa-layer';
  wrap.appendChild(layer);
  canvas.style.imageRendering = 'pixelated';
  canvas.style.display = 'block';
  const cursorUrl = glove();
  canvas.style.cursor = cursorUrl;

  const g = canvas.getContext('2d')!;
  const [wb, wg] = makeCanvas(BUF_W, BUF_H);
  const [rb, rg] = makeCanvas(BUF_W, BUF_H);
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const world = new World();
  let reduced = opts.reducedMotion ?? mq.matches;
  world.reduced = reduced;
  let th: Theme = THEMES[opts.theme];
  let bg = buildBackground(th);
  let lights = buildLights(th);
  let vig = buildVignette(th);
  let LW = 640;
  let LH = 360;
  let css = 2;
  let camX = 0;
  let camY = 0;
  let mode: Mode = 'floor';
  let focusRole: string | null = null;
  let evoFocus = false;
  let zoomP = 0;
  let t = 0;
  let last = performance.now();
  let raf = 0;
  let paused = false;
  let hover: Hit = null;
  let hoverSince = 0;
  let waved = false;
  let globeClicks: number[] = [];
  let clickTimer = 0;
  let snapshot: FloorSnapshot | null = null;

  const onMq = () => {
    if (opts.reducedMotion == null) {
      reduced = mq.matches;
      world.reduced = reduced;
    }
  };
  mq.addEventListener('change', onMq);

  // ---------- 尺寸 ----------
  const resize = () => {
    const aw = Math.max(200, parent.clientWidth);
    const ah = Math.max(150, parent.clientHeight);
    // 按内容包围盒取景:≥3 倍时取整数倍,否则用分数倍把舞台铺满(像素边缘在高分屏上几乎看不出)
    const fit = Math.min(aw / VIEW.w, ah / VIEW.h);
    css = fit >= 3 ? Math.floor(fit) : fit;
    LW = Math.min(BUF_W, Math.floor(aw / css));
    LH = Math.min(BUF_H, Math.floor(ah / css));
    canvas.width = LW;
    canvas.height = LH;
    canvas.style.width = `${Math.round(LW * css)}px`;
    canvas.style.height = `${Math.round(LH * css)}px`;
    g.imageSmoothingEnabled = false;
    camX = Math.max(-EX, Math.min(WORLD_W + EX - LW, Math.round(VIEW.cx - LW / 2)));
    camY = Math.max(-EY, Math.min(WORLD_H + EY - LH, Math.round(VIEW.cy - LH / 2)));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(parent);
  resize();

  // ---------- 坐标 ----------
  const toWorld = (cx: number, cy: number): Pt => {
    const r = canvas.getBoundingClientRect();
    return { x: ((cx - r.left) / r.width) * LW + camX, y: ((cy - r.top) / r.height) * LH + camY };
  };
  const toClient = (p: Pt): ScreenPt => {
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((p.x - camX) / LW) * r.width, y: r.top + ((p.y - camY) / LH) * r.height };
  };
  const toLayer = (p: Pt): Pt => ({ x: ((p.x - camX) / LW) * canvas.clientWidth, y: ((p.y - camY) / LH) * canvas.clientHeight });

  // ---------- 命中 ----------
  const inR = (p: Pt, r: { x: number; y: number; w: number; h: number }, pad = 0) => p.x >= r.x - pad && p.x < r.x + r.w + pad && p.y >= r.y - pad && p.y < r.y + r.h + pad;
  const agentBox = (s: AgentSim) => {
    if (s.act === 'seated') return { x: s.desk.x - 14, y: s.desk.seat.y - 30, w: 28, h: s.desk.y - s.desk.seat.y + 22 };
    return { x: s.pos.x - 14, y: s.pos.y - 30, w: 28, h: 32 };
  };
  const hitFloor = (p: Pt): Hit => {
    for (const d of DESKS) {
      const days = world.evo.get(d.role) ?? [];
      const last14 = days.slice(-EVO_CELLS);
      for (let i = 0; i < EVO_CELLS; i++) {
        const r = evoCellRect(d, i);
        if (p.x >= r.x - 0.5 && p.x < r.x + r.w + 0.5 && p.y >= r.y - 1.5 && p.y < r.y + r.h + 1.5) {
          const day = last14[i];
          if (day) return { kind: 'evo', role: d.role, idx: i, day };
        }
      }
      if (inR(p, plateRect(d), 1)) return { kind: 'plate', role: d.role };
    }
    if (inR(p, mailboxRect(), 2)) return { kind: 'mailbox' };
    // 站着/走路的优先(在前面)
    const sims = [...world.agents.values()].sort((a, b) => b.pos.y - a.pos.y);
    for (const s of sims) if (inR(p, agentBox(s))) return { kind: 'agent', role: s.role };
    if (Math.abs(p.x - (SOFA.x - 8)) < 14 && p.y > SOFA.y - 24 && p.y < SOFA.y - 4) return { kind: 'pet' };
    if (Math.hypot(p.x - GLOBE.x, p.y - GLOBE.y) < GLOBE.r + 3) return { kind: 'globe' };
    for (const r of windowRects(th)) if (inR(p, r)) return { kind: 'window' };
    if (p.y > WALL_H) return { kind: 'floor', p };
    return null;
  };
  const hitRoom = (p: Pt): Hit => {
    if (!focusRole) return null;
    const days = (world.evo.get(focusRole) ?? []).slice(-30);
    const pad = 30 - days.length;
    for (let i = 0; i < 30; i++) {
      const r = roomEvoCellRect(i);
      const day = days[i - pad];
      if (day && inR(p, r, 1)) return { kind: 'evo', role: focusRole, idx: i, day };
    }
    if (Math.abs(p.x - ROOM_AGENT.x) < 28 && p.y > ROOM_AGENT.y - 54 && p.y < ROOM_AGENT.y + 4) return { kind: 'agent', role: focusRole };
    return null;
  };

  const sameHit = (a: Hit, b: Hit) => JSON.stringify(a && { ...a, day: undefined, p: undefined }) === JSON.stringify(b && { ...b, day: undefined, p: undefined });

  const onMove = (e: PointerEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    const inRoom = mode === 'room';
    world.cursor = inRoom ? null : p;
    roomCursor = inRoom ? p : null;
    const h = inRoom ? hitRoom(p) : mode === 'floor' ? hitFloor(p) : null;
    if (!sameHit(h, hover)) {
      if (hover?.kind === 'evo' && h?.kind !== 'evo') opts.onHoverEvo?.(null);
      if (hover?.kind === 'window' && h?.kind !== 'window') opts.onHoverWindow?.(null);
      hover = h;
      hoverSince = t;
      waved = false;
      if (h?.kind === 'evo') opts.onHoverEvo?.({ role: h.role, day: h.day, at: { x: e.clientX, y: e.clientY } });
      if (h?.kind === 'window') opts.onHoverWindow?.(world.weather.explain, { x: e.clientX, y: e.clientY });
    } else if (h?.kind === 'evo') opts.onHoverEvo?.({ role: h.role, day: h.day, at: { x: e.clientX, y: e.clientY } });
    else if (h?.kind === 'window') opts.onHoverWindow?.(world.weather.explain, { x: e.clientX, y: e.clientY });
    const clickable = h && h.kind !== 'floor' && h.kind !== 'window';
    canvas.style.cursor = clickable ? cursorUrl : cursorUrl;
    canvas.title = h?.kind === 'plate' ? '看它 30 天的进化方格' : h?.kind === 'mailbox' ? '你的信箱:待批订单' : '';
  };
  let roomCursor: Pt | null = null;
  const onLeave = () => {
    world.cursor = null;
    roomCursor = null;
    hover = null;
    opts.onHoverEvo?.(null);
    opts.onHoverWindow?.(null);
  };
  const onClick = (e: MouseEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    const h = mode === 'room' ? hitRoom(p) : mode === 'floor' ? hitFloor(p) : null;
    if (!h) return;
    if (h.kind === 'evo') opts.onSelectEvo?.(h.role, h.day.date);
    else if (h.kind === 'plate') opts.onOpenEvoGrid?.(h.role);
    else if (h.kind === 'mailbox') opts.onClickMailbox?.();
    else if (h.kind === 'agent') {
      window.clearTimeout(clickTimer);
      const role = h.role;
      clickTimer = window.setTimeout(() => opts.onSelectAgent?.(role, api.agentScreenPos(role) ?? undefined), 220);
    } else if (h.kind === 'pet') {
      world.petRoll();
      opts.onEasterEgg?.('pet');
    } else if (h.kind === 'globe') {
      globeClicks = [...globeClicks.filter((x) => t - x < 2.5), t];
      if (globeClicks.length >= 5) {
        globeClicks = [];
        world.celebrate('', 'coins');
        opts.onEasterEgg?.('coins');
      }
    } else if (h.kind === 'floor') world.ripple(h.p);
  };
  const onDbl = (e: MouseEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    const h = mode === 'floor' ? hitFloor(p) : mode === 'room' ? hitRoom(p) : null;
    if (h?.kind === 'agent') {
      window.clearTimeout(clickTimer);
      world.celebrate(h.role, 'highfive');
      opts.onHighFive?.(h.role);
    }
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDbl);

  // ---------- 画 ----------
  const still = () => reduced || paused;

  function drawAgent(s: AgentSim): void {
    const S = still();
    const now = world.now;
    const hovered = hover?.kind === 'agent' && hover.role === s.role;
    const drop = world.dropHover === s.role;
    const hop = now < s.hopUntil ? Math.round(Math.sin(((s.hopUntil - now) / 0.45) * Math.PI) * 3) : 0;
    let wave = false;
    if (hovered && s.act === 'seated' && t - hoverSince > 1.2 && !waved && !S) {
      waved = true;
      s.waveUntil = now + 1.3;
    }
    if (now < s.waveUntil) wave = true;
    const stretch = !S && (now < s.stretchUntil || drop || wave);
    const o = {
      breath: !S && Math.sin(t * 2.4 + s.phase) > 0,
      blink: !S && now < s.blinkUntil,
      look: (s.act === 'walk' ? s.facing : s.look) as -1 | 0 | 1,
      stretch,
      walk: (s.act === 'walk' && !S ? (Math.floor(t * 8) % 2) + 1 : 0) as 0 | 1 | 2,
    };
    const x = s.pos.x;
    const y = s.pos.y - hop;
    if (s.act !== 'seated') shadow(wg, s.pos.x, s.pos.y, 9, 0.35);
    if (drop) {
      wg.save();
      wg.globalAlpha = 0.5 + 0.3 * Math.sin(t * 8);
      ellipse(wg, s.desk.x, s.desk.y + 6, s.desk.wide / 2 + 6, 12, s.meta.color);
      wg.restore();
    }
    drawChar(wg, s.meta.shape, s.meta.color, x, y, o);
    if (wave) {
      const k = Math.floor(t * 8) % 2;
      rect(wg, x + 12 + k, y - 24, 3, 4, '#1a1410');
      rect(wg, x + 13 + k, y - 23, 2, 2, s.meta.color);
    }
    if (s.carry) {
      rect(wg, x + 9, y - 10, 4, 4, '#1a1410');
      rect(wg, x + 10, y - 9, 2, 2, '#f4efe2');
    }
    // 头顶图标
    const hx = x;
    const hy = y - 32 - (o.stretch ? 2 : 0);
    const st = s.data.status;
    if (s.data.task) drawTaskIcon(wg, hx, hy - 4, s.data.task.icon, s.meta.color, t, S);
    else if (st === 'stuck') {
      const on = S || Math.sin(t * 7) > -0.3;
      if (on) {
        rect(wg, hx - 3, hy - 9, 7, 9, '#1a1410');
        rect(wg, hx - 2, hy - 8, 5, 7, th.c.down);
        rect(wg, hx, hy - 7, 1, 3, '#ffffff');
        rect(wg, hx, hy - 3, 1, 1, '#ffffff');
      }
    } else if (st === 'waiting' && s.act === 'seated') {
      const n = S ? 3 : (Math.floor(t * 2.5) % 3) + 1;
      rect(wg, hx - 6, hy - 6, 13, 6, '#1a1410');
      rect(wg, hx - 5, hy - 5, 11, 4, '#fffaf0');
      for (let i = 0; i < n; i++) px(wg, hx - 3 + i * 3, hy - 3, '#1a1410');
    }
    if (hovered || drop) {
      const cs = s.meta.callsign;
      const w = textWidth(cs) + 6;
      const ty = hy - (s.data.task || st !== 'working' ? 18 : 9);
      rect(wg, hx - w / 2 - 1, ty - 1, w + 2, 9, s.meta.color);
      rect(wg, hx - w / 2, ty, w, 7, '#1a1410');
      text(wg, cs, hx - w / 2 + 3, ty + 1, s.meta.color);
      px(wg, hx, ty + 8, s.meta.color);
    }
  }

  function renderFloor(): void {
    const S = still();
    const s = snapshot;
    wg.setTransform(1, 0, 0, 1, EX, EY);
    wg.drawImage(bg, -EX, -EY);
    drawWallDynamic(wg, th, t, S, s?.money.equity ?? '—', world.weather);
    drawFloorDynamic(wg, th, t, S, world.envelopes.length);
    drawLounge(wg, th, t, S, world.now < world.petRollUntil);
    type Item = { y: number; draw: () => void };
    const items: Item[] = [];
    for (const sim of world.agents.values()) {
      const d = sim.desk;
      items.push({ y: d.seat.y - 1, draw: () => drawChair(wg, th, d) });
      items.push({ y: sim.act === 'seated' ? d.seat.y : sim.pos.y, draw: () => drawAgent(sim) });
      const hoverIdx = hover?.kind === 'evo' && hover.role === d.role ? hover.idx : -1;
      const plateHi = (hover?.kind === 'plate' && hover.role === d.role) || world.dropHover === d.role ? 1 : 0;
      items.push({
        y: d.y + 16,
        draw: () =>
          drawDesk(wg, th, d, { status: sim.data.status, color: sim.meta.color, seated: sim.act === 'seated', typing: world.isTyping(sim), evo: world.evo.get(d.role) ?? [], hoverEvo: hoverIdx, highlight: plateHi, mail: sim.mail > 0 }, t + sim.phase, S),
      });
    }
    items.push({ y: TABLE.y + 12, draw: () => drawTable(wg, th, t, S, world.meetingActive > 0) });
    items.push({ y: MAILBOX.y, draw: () => drawMailbox(wg, th, s?.inbox.count ?? 0, t, S, hover?.kind === 'mailbox') });
    PLANTS.forEach((pl, i) => items.push({ y: pl.y, draw: () => drawPlants(wg, th, t, S, [pl]) }));
    void 0;
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    // 信封
    for (const e of world.envelopes) {
      const p = world.envPos(e);
      const f = world.envFloor(e);
      if (!reduced) e.trail.forEach((q, i) => {
        wg.fillStyle = rgba(e.color, (i / e.trail.length) * 0.6);
        wg.fillRect(Math.round(q.x), Math.round(q.y), i > e.trail.length - 5 ? 2 : 1, 1);
      });
      shadow(wg, f.x, f.y, 4, 0.3);
      drawEnvelope(wg, p.x, p.y + (S ? 0 : Math.round(Math.sin(t * 10 + e.d * 0.1))), e.color, '#1a1410', S ? 0.6 : 0.8 + 0.2 * Math.sin(t * 12));
    }
    drawFx(wg);
    // 光
    wg.save();
    wg.globalCompositeOperation = 'lighter';
    wg.globalAlpha = S ? 1 : th.lights === 'lamp' ? 0.94 + 0.06 * Math.sin(t * 7.3) * Math.sin(t * 2.1) : 1;
    wg.drawImage(lights, -EX, -EY);
    wg.restore();
    // 警报灯
    if (world.weather.alarm) drawAlarm(wg, S);
    wg.drawImage(vig, -EX, -EY);
    drawForeground(wg, th, t, S, { x0: camX, x1: camX + LW, y1: camY + LH });
    if (world.flash > 0) {
      wg.fillStyle = `rgba(255,40,60,${(world.flash * 0.35).toFixed(3)})`;
      wg.fillRect(-EX, -EY, BUF_W, BUF_H);
    }
  }

  function drawAlarm(G: Ctx, S: boolean): void {
    const bx = 320;
    const by = 8;
    rect(G, bx - 5, by, 10, 6, '#1a1410');
    rect(G, bx - 4, by + 1, 8, 5, '#ff3040');
    const a = S ? 1.2 : t * 3.2;
    G.save();
    G.globalCompositeOperation = 'lighter';
    G.globalAlpha = 0.22;
    G.fillStyle = '#ff2030';
    G.beginPath();
    G.moveTo(bx, by + 4);
    const L = 420;
    G.lineTo(bx + Math.cos(a - 0.22) * L, by + 4 + Math.abs(Math.sin(a - 0.22)) * L * 0.55);
    G.lineTo(bx + Math.cos(a + 0.22) * L, by + 4 + Math.abs(Math.sin(a + 0.22)) * L * 0.55);
    G.closePath();
    G.fill();
    G.globalAlpha = S ? 0.06 : 0.05 + 0.08 * Math.max(0, Math.sin(t * 6));
    G.fillRect(-EX, -EY, BUF_W, BUF_H);
    G.restore();
  }

  function drawFx(G: Ctx): void {
    for (const f of world.fx) {
      const k = 1 - f.life / f.max;
      G.save();
      G.globalAlpha = Math.max(0, Math.min(1, k * 1.4));
      if (f.kind === 'spark') px(G, f.x, f.y, f.color);
      else if (f.kind === 'star') {
        px(G, f.x, f.y, '#ffffff');
        px(G, f.x - 1, f.y, f.color);
        px(G, f.x + 1, f.y, f.color);
        px(G, f.x, f.y - 1, f.color);
        px(G, f.x, f.y + 1, f.color);
      } else if (f.kind === 'confetti') rect(G, f.x, f.y, 2, 1 + (Math.floor(f.life * 10) % 2), f.color);
      else if (f.kind === 'coin') {
        const w = Math.abs(Math.cos(f.life * 9)) * 3;
        rect(G, f.x - w / 2 - 0.5, f.y - 2, w + 1, 4, '#1a1410');
        rect(G, f.x - w / 2, f.y - 1.5, Math.max(1, w), 3, '#ffcf4a');
      } else if (f.kind === 'ripple') {
        const r = 2 + (1 - k) * 12;
        for (let a = 0; a < 20; a++) px(G, f.x + Math.cos((a / 20) * 6.283) * r, f.y + Math.sin((a / 20) * 6.283) * r * 0.45, f.color);
      } else if (f.kind === 'ring') {
        const r = 6 + (1 - k) * 22;
        for (let a = 0; a < 40; a++) {
          const ang = (a / 40) * 6.283;
          px(G, f.x + Math.cos(ang) * r, f.y + Math.sin(ang) * r * 0.4, f.color);
          if (a % 5 === 0) px(G, f.x + Math.cos(ang) * r, f.y + Math.sin(ang) * r * 0.4 - (1 - k) * 18, f.color);
        }
      } else if (f.kind === 'plus') text(G, '+1', f.x - 3, f.y, f.color);
      G.restore();
    }
  }

  function renderRoom(): void {
    const sim = focusRole ? world.agents.get(focusRole) : null;
    if (!sim) return;
    rg.setTransform(1, 0, 0, 1, EX, EY);
    const hoverIdx = hover?.kind === 'evo' ? hover.idx : -1;
    drawRoom(rg, { th, sim, evo: world.evo.get(sim.role) ?? [], hoverEvo: hoverIdx, evoFocus, t, still: still(), weather: world.weather, cursor: roomCursor });
    if (sim.data.task) drawTaskIcon(rg, ROOM_AGENT.x, ROOM_AGENT.y - 60, sim.data.task.icon, sim.meta.color, t, still());
    rg.drawImage(vig, -EX, -EY);
  }

  function compose(): void {
    g.fillStyle = th.ui['--stage'] ?? '#000';
    g.fillRect(0, 0, LW, LH);
    if (mode === 'floor') {
      g.drawImage(wb, camX + EX, camY + EY, LW, LH, 0, 0, LW, LH);
      return;
    }
    if (mode === 'room') {
      g.drawImage(rb, camX + EX, camY + EY, LW, LH, 0, 0, LW, LH);
      return;
    }
    const d = focusRole ? deskOf(focusRole) : null;
    const bx = camX + LW / 2;
    const by = camY + LH / 2;
    const tx = d ? d.x : bx;
    const ty = d ? d.y - 16 : by;
    const p = mode === 'zoomIn' ? zoomP : 1 - zoomP;
    const e = p * p * (3 - 2 * p);
    const z = 1 + e * 3;
    const cx = bx + (tx - bx) * e;
    const cy = by + (ty - by) * e;
    const sw = LW / z;
    const sh = LH / z;
    g.drawImage(wb, cx - sw / 2 + EX, cy - sh / 2 + EY, sw, sh, 0, 0, LW, LH);
    if (e > 0.6) {
      g.save();
      g.globalAlpha = Math.min(1, (e - 0.6) / 0.4);
      g.drawImage(rb, camX + EX, camY + EY, LW, LH, 0, 0, LW, LH);
      g.restore();
    }
  }

  // ---------- 气泡层 ----------
  const bubbleEls = new Map<string, HTMLDivElement>();
  function syncBubbles(): void {
    const want = new Map<string, { text: string; tone: string; at: Pt }>();
    if (mode === 'floor') {
      for (const b of world.bubbles.values()) {
        const s = world.agents.get(b.role);
        const anchor = b.anchor ?? (s ? { x: s.pos.x, y: s.pos.y - (s.data.task || s.data.status !== 'working' ? 44 : 34) } : null);
        if (anchor) want.set(b.key, { text: b.text, tone: b.tone, at: toLayer(anchor) });
      }
    } else if (mode === 'room' && focusRole) {
      const b = world.bubbles.get(focusRole);
      if (b) want.set(b.key, { text: b.text, tone: b.tone, at: toLayer({ x: ROOM_AGENT.x, y: ROOM_AGENT.y - 72 }) });
    }
    for (const [k, el] of bubbleEls) if (!want.has(k)) {
      el.remove();
      bubbleEls.delete(k);
    }
    for (const [k, v] of want) {
      let el = bubbleEls.get(k);
      if (!el) {
        el = document.createElement('div');
        el.className = `fa-bubble ${v.tone}`;
        el.textContent = v.text;
        layer.appendChild(el);
        bubbleEls.set(k, el);
      }
      el.style.left = `${Math.round(v.at.x)}px`;
      el.style.top = `${Math.round(v.at.y)}px`;
    }
  }

  // ---------- 循环 ----------
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) {
      t += dt;
      world.update(dt, t);
    }
    if (mode === 'zoomIn' || mode === 'zoomOut') {
      zoomP += dt / (reduced ? 0.001 : 0.6);
      if (zoomP >= 1) {
        zoomP = 1;
        if (mode === 'zoomIn') {
          mode = 'room';
          opts.onFocusChange?.(focusRole);
        } else {
          mode = 'floor';
          focusRole = null;
          opts.onFocusChange?.(null);
        }
      }
    }
    if (mode !== 'room') renderFloor();
    if (mode !== 'floor') renderRoom();
    compose();
    syncBubbles();
  };
  raf = requestAnimationFrame(frame);

  const api: FloorHandle = {
    setData(s) {
      snapshot = s;
      world.apply(s);
    },
    setTheme(id: ThemeId) {
      th = THEMES[id];
      bg = buildBackground(th);
      lights = buildLights(th);
      vig = buildVignette(th);
    },
    focus(role, fo) {
      hover = null;
      if (role) {
        const sim = world.agents.get(role);
        if (!sim) return;
        evoFocus = !!fo?.evo;
        if (focusRole === role && mode === 'room') return;
        focusRole = role;
        mode = mode === 'room' ? 'room' : 'zoomIn';
        zoomP = 0;
        if (mode === 'room') opts.onFocusChange?.(role);
        world.say(role, sim.data.line || '在呢', 3500, 'say');
      } else if (mode === 'room' || mode === 'zoomIn') {
        mode = 'zoomOut';
        zoomP = 0;
      }
    },
    dropTargetAt(cx, cy) {
      const p = toWorld(cx, cy);
      if (mode === 'room') return focusRole;
      if (mode !== 'floor') return null;
      for (const d of DESKS) if (p.x >= d.x - d.wide / 2 - 4 && p.x <= d.x + d.wide / 2 + 4 && p.y >= d.seat.y - 34 && p.y <= d.y + 18) return d.role;
      for (const s of world.agents.values()) if (s.act !== 'seated' && Math.abs(p.x - s.pos.x) < 14 && p.y > s.pos.y - 30 && p.y < s.pos.y + 2) return s.role;
      return null;
    },
    setDropHover(role) {
      world.dropHover = role;
    },
    celebrate(role, kind) {
      world.celebrate(role, kind);
    },
    say(role, text, ms) {
      world.say(role, text, ms ?? 2600);
    },
    sendGold(to) {
      world.sendEnvelope('you', to, '', '接住,马上下单', true);
    },
    setPaused(p) {
      paused = p;
    },
    agentScreenPos(role) {
      if (mode === 'room' && role === focusRole) return toClient({ x: ROOM_AGENT.x + camX * 0, y: ROOM_AGENT.y - 60 });
      const s = world.agents.get(role);
      if (!s) return null;
      return toClient({ x: s.pos.x, y: s.pos.y - 34 });
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq.removeEventListener('change', onMq);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDbl);
      layer.remove();
      parent.insertBefore(canvas, wrap);
      wrap.remove();
    },
  };
  return api;
}

const ICONS: Record<TaskIcon, string[]> = {
  scan: ['.###.', '#...#', '#...#', '.###.', '....#'],
  eye: ['.....', '.###.', '#.#.#', '.###.', '.....'],
  flask: ['.#.#.', '.#.#.', '#...#', '#####', '.###.'],
  bolt: ['..##.', '.##..', '####.', '..##.', '.##..'],
  shield: ['#####', '#...#', '#.#.#', '.#.#.', '..#..'],
  coin: ['.###.', '##.##', '#.#.#', '##.##', '.###.'],
  book: ['##.##', '#.#.#', '#.#.#', '#.#.#', '##.##'],
  shop: ['#####', '#.#.#', '#####', '#...#', '#.#.#'],
  chat: ['#####', '#...#', '#####', '.#...', '#....'],
};

export function drawTaskIcon(G: Ctx, x: number, y: number, icon: TaskIcon, color: string, t: number, still: boolean): void {
  const bob = still ? 0 : Math.round(Math.sin(t * 4));
  const X = Math.round(x - 5);
  const Y = Math.round(y - 10 + bob);
  rect(G, X - 1, Y - 1, 11, 11, '#1a1410');
  rect(G, X, Y, 9, 9, '#fffaf0');
  (ICONS[icon] ?? ICONS.chat).forEach((row, j) => [...row].forEach((c, i) => c === '#' && px(G, X + 2 + i, Y + 2 + j, mix(color, '#000000', 0.35))));
  // 进度点
  const n = still ? 3 : (Math.floor(t * 3) % 4);
  for (let i = 0; i < 3; i++) px(G, X + 2 + i * 2, Y + 11, i < n ? color : '#3a3028');
}
