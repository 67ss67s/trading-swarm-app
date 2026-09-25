/**
 * 开放办公室的环境美术:墙、窗景、书架、海报、大屏、霓虹、地板、地毯、走廊、茶水间、沙发、光池、暗角。
 * buildBackground 缓存静态层;drawWallDynamic / drawFloorDynamic / drawCorners 每帧画会动的部分。
 */
import type { Theme, WallSeg } from './themes';
import type { Weather } from './world';
import { BUF_H, BUF_W, DESKS, EX, EY, GLOBE, PANTRY, RING, SOFA, TABLE, WALL_H, WORLD_H, WORLD_W, XL, XR, YB, YT } from './layout';
import { box, dither, ellipse, ellipseDither, hash, hline, makeCanvas, mix, neonText, px, rect, rgba, rng, shade, text, textCenter, textWidth, vline, type Ctx } from './pixel';
import { charSprite, drawGlobe, drawPet, drawPlant, WORLD } from './sprites';
import { ROLES, ROLE_ORDER } from './roles';

const SEG_Y = 14;
const SEG_H = 70;

// ---------------- 静态背景 ----------------
export function buildBackground(th: Theme): HTMLCanvasElement {
  const [cv, g] = makeCanvas(BUF_W, BUF_H);
  g.translate(EX, EY);
  const p = th.c;
  drawFloor(g, th);
  drawWallBase(g, th);
  for (const s of th.wall) drawSegStatic(g, th, s);
  // 墙脚线 + 墙根阴影
  rect(g, XL, WALL_H - 4, XR - XL, 4, p.trim);
  hline(g, XL, WALL_H - 4, XR - XL, p.trimHi);
  hline(g, XL, WALL_H - 1, XR - XL, p.outline);
  g.save();
  g.globalAlpha = 0.35;
  rect(g, XL, WALL_H, XR - XL, 2, '#000');
  g.globalAlpha = 0.18;
  dither(g, XL, WALL_H + 2, XR - XL, 4, '#000');
  g.restore();
  drawRugAndRing(g, th);
  drawPantryStatic(g, th);
  drawSofaStatic(g, th);
  return cv;
}

function drawWallBase(g: Ctx, th: Theme): void {
  const p = th.c;
  rect(g, XL, 0, XR - XL, WALL_H, p.wall);
  if (th.floor === 'wood') {
    // 木护墙板:竖向木条 + 下半截镶板
    for (let x = XL; x < XR; x += 16) {
      vline(g, x, 8, WALL_H - 8, p.wallDark);
      vline(g, x + 1, 8, WALL_H - 8, p.wallHi);
      for (let y = 12; y < WALL_H - 30; y += 7) if (hash(x * 7 + y) > 0.7) px(g, x + 4 + ((y * 3) % 9), y, p.wallDark);
    }
    rect(g, XL, WALL_H - 30, XR - XL, 26, p.wallDark);
    hline(g, XL, WALL_H - 30, XR - XL, p.trimHi);
    hline(g, XL, WALL_H - 29, XR - XL, p.trim);
    for (let x = XL + 4; x < XR; x += 40) {
      rect(g, x, WALL_H - 25, 34, 17, shade(p.wallDark, -0.15));
      hline(g, x, WALL_H - 25, 34, p.wall);
      vline(g, x, WALL_H - 25, 17, p.wall);
    }
  } else if (th.floor === 'metal') {
    for (let y = 8; y < WALL_H; y += 22) {
      hline(g, XL, y, XR - XL, p.wallDark);
      hline(g, XL, y + 1, XR - XL, p.wallHi);
    }
    for (let x = XL; x < XR; x += 48) {
      vline(g, x, 8, WALL_H, p.wallDark);
      for (let y = 12; y < WALL_H; y += 22) {
        px(g, x + 3, y, p.wallHi);
        px(g, x + 44, y, p.wallHi);
      }
    }
    rect(g, XL, WALL_H - 14, XR - XL, 10, p.wallDark);
  } else {
    // 霓虹:紫墙 + 斜纹砖
    for (let y = 8; y < WALL_H; y += 8) for (let x = (y / 8) % 2 ? XL : XL + 10; x < XR; x += 20) {
      hline(g, x, y, 18, p.wallHi);
      vline(g, x, y, 8, p.wallDark);
    }
    rect(g, XL, WALL_H - 16, XR - XL, 12, p.wallDark);
  }
  // 天花板(含上方延伸:梁 + 吊灯)
  rect(g, XL, YT, XR - XL, 8 - YT, p.ceiling);
  for (let x = XL + 20; x < XR; x += 80) {
    rect(g, x, YT, 10, 8 - YT, shade(p.ceiling, 0.12));
    vline(g, x, YT, 8 - YT, shade(p.ceiling, 0.25));
  }
  hline(g, XL, -2, XR - XL, shade(p.ceiling, 0.2));
  rect(g, XL, 0, XR - XL, 8, p.ceiling);
  hline(g, XL, 7, XR - XL, p.outline);
  hline(g, XL, 8, XR - XL, shade(p.wall, -0.25));
  if (th.floor === 'wood') for (let x = XL; x < XR; x += 4) px(g, x, 6, p.trim);
}

function drawSegStatic(g: Ctx, th: Theme, s: WallSeg): void {
  const p = th.c;
  const x = s.x;
  const y = SEG_Y;
  const w = s.w;
  const h = SEG_H;
  if (s.kind === 'shelf' || s.kind === 'toys') {
    box(g, x, y - 4, w, h + 6, p.shelf, shade(p.shelf, 0.2), p.shelfDark, p.outline);
    const rows = 3;
    const R = rng(x * 13 + 7);
    for (let r = 0; r < rows; r++) {
      const by = y + 2 + r * 22;
      rect(g, x + 3, by, w - 6, 18, p.shelfDark);
      rect(g, x + 3, by + 18, w - 6, 3, p.shelf);
      hline(g, x + 3, by + 18, w - 6, shade(p.shelf, 0.3));
      let bx = x + 4;
      while (bx < x + w - 6) {
        if (s.kind === 'toys') {
          const role = ROLE_ORDER[Math.floor(R() * ROLE_ORDER.length)]!;
          const m = ROLES[role];
          const spr = charSprite(m.shape, m.color, { cell: 1 });
          g.drawImage(spr, bx, by + 18 - spr.height + 1);
          bx += spr.width + 4 + Math.floor(R() * 5);
          continue;
        }
        const roll = R();
        if (roll < 0.08 && bx < x + w - 14) {
          // 小地球仪 / 小盆栽
          ellipse(g, bx + 4, by + 12, 3, 3, p.lamp);
          px(g, bx + 3, by + 11, shade(p.lamp, 0.4));
          rect(g, bx + 3, by + 15, 3, 3, p.metalDark);
          bx += 10;
          continue;
        }
        const bw = 2 + Math.floor(R() * 3);
        const bh = 11 + Math.floor(R() * 7);
        const col = p.books[Math.floor(R() * p.books.length)]!;
        rect(g, bx, by + 18 - bh, bw, bh, col);
        vline(g, bx, by + 18 - bh, bh, shade(col, 0.25));
        if (bh > 13) hline(g, bx, by + 18 - bh + 3, bw, shade(col, 0.45));
        vline(g, bx + bw, by + 18 - bh, bh, shade(col, -0.5));
        bx += bw + 1;
        if (R() < 0.08) bx += 3;
      }
    }
    return;
  }
  if (s.kind === 'window') {
    box(g, x - 3, y - 3, w + 6, h + 6, p.trim, p.trimHi, shade(p.trim, -0.3), p.outline);
    rect(g, x - 5, y + h + 2, w + 10, 4, p.trimHi);
    hline(g, x - 5, y + h + 5, w + 10, p.outline);
    return;
  }
  if (s.kind === 'screen') {
    box(g, x - 3, y - 3, w + 6, h + 6, p.monFrame, p.monFrameHi, p.outline, p.outline);
    rect(g, x + w / 2 - 6, y + h + 3, 12, 3, p.monFrame);
    return;
  }
  if (s.kind === 'poster') {
    const lines = s.text ?? [];
    if (th.id === 'lab') {
      box(g, x, y, w, h, '#e9dcc0', '#f7eed8', '#b8a07a', p.outline);
      rect(g, x + 3, y + 3, w - 6, h - 6, '#2c3a5a');
      // 夕阳 + 山
      for (let j = 0; j < 20; j++) hline(g, x + 3, y + 30 + j, w - 6, mix('#f0a050', '#6a3a5a', j / 20));
      ellipse(g, x + w / 2, y + 44, 7, 7, '#ffd070');
      for (let i = 0; i < w - 6; i++) {
        const mh = 8 + Math.abs(((i * 7) % 23) - 11) + (i % 5);
        vline(g, x + 3 + i, y + h - 3 - mh, mh, i % 3 ? '#3a2a3a' : '#4a3448');
      }
      lines.forEach((l, i) => textCenter(g, l, x + w / 2, y + 7 + i * 7, '#f3e0b8'));
    } else if (th.id === 'command') {
      box(g, x, y, w, h, '#0a1426', '#15284a', '#050a14', p.outline);
      for (let j = 0; j < h - 4; j += 3) hline(g, x + 2, y + 2 + j, w - 4, '#0d1a30');
      lines.forEach((l, i) => textCenter(g, l, x + w / 2, y + (lines.length > 2 ? 16 + i * 10 : 14 + i * 14), i === 0 ? p.neonB : p.text, lines.length > 2 ? 1 : 2));
      rect(g, x + 10, y + h - 12, w - 20, 3, p.metalDark);
      rect(g, x + 10, y + h - 12, (w - 20) * 0.7, 3, p.neonB);
    } else {
      box(g, x, y, w, h, '#2a0f40', '#4a1a6a', '#180828', p.outline);
      rect(g, x + 2, y + 2, w - 4, h - 4, lines[0] === 'GOOD' ? '#ffcf4a' : '#39206a');
      lines.forEach((l, i) => textCenter(g, l, x + w / 2, y + 30 + i * 8, lines[0] === 'GOOD' ? '#8a1a6a' : '#ff9af0'));
      if (lines[0] === 'GOOD') {
        // 戴墨镜的柴犬头像(原创像素)
        ellipse(g, x + w / 2, y + 16, 11, 9, '#e89a4a');
        rect(g, x + w / 2 - 9, y + 13, 18, 3, '#101010');
        rect(g, x + w / 2 - 10, y + 5, 4, 5, '#e89a4a');
        rect(g, x + w / 2 + 6, y + 5, 4, 5, '#e89a4a');
        ellipse(g, x + w / 2, y + 21, 5, 2, '#fff0dc');
      } else {
        // 心 + 小外星人
        const hx = x + w / 2;
        rect(g, hx - 6, y + 10, 5, 4, '#ff4fd8');
        rect(g, hx + 1, y + 10, 5, 4, '#ff4fd8');
        rect(g, hx - 5, y + 14, 10, 3, '#ff4fd8');
        rect(g, hx - 3, y + 17, 6, 2, '#ff4fd8');
        px(g, hx - 5, y + 11, '#ffc2f4');
      }
    }
    return;
  }
  if (s.kind === 'neon') {
    rect(g, x, y + 4, w, h - 8, shade(p.wall, -0.3));
    for (const nx of [x - 4, x + w + 2]) {
      rect(g, nx, y - 4, 3, h + 8, p.outline);
    }
  }
}

function drawFloor(g: Ctx, th: Theme): void {
  const p = th.c;
  const top = WALL_H;
  rect(g, XL, top, XR - XL, YB - top, p.floorA);
  if (th.floor === 'wood') {
    const R = rng(99);
    for (let y = top, row = 0; y < YB; y += 7, row++) {
      let x = XL - Math.floor(R() * 40);
      while (x < XR) {
        const L = 34 + Math.floor(R() * 40);
        const col = R() < 0.5 ? p.floorA : p.floorB;
        rect(g, x, y, L, 7, col);
        hline(g, x, y, L, shade(col, 0.08));
        vline(g, x, y, 7, p.floorLine);
        for (let k = 0; k < 3; k++) hline(g, x + 3 + Math.floor(R() * (L - 10)), y + 2 + Math.floor(R() * 3), 3 + Math.floor(R() * 5), shade(col, -0.1));
        x += L;
      }
      hline(g, XL, y + 6, XR - XL, p.floorLine);
    }
  } else if (th.floor === 'metal') {
    for (let y = top; y < YB; y += 16)
      for (let x = ((y - top) / 16) % 2 ? XL - 16 : XL; x < XR; x += 32) {
        const col = hash(x * 3 + y) > 0.5 ? p.floorA : p.floorB;
        rect(g, x, y, 32, 16, col);
        hline(g, x, y, 32, p.floorHi);
        vline(g, x, y, 16, shade(col, 0.1));
        hline(g, x, y + 15, 32, p.floorLine);
        vline(g, x + 31, y, 16, p.floorLine);
        px(g, x + 2, y + 2, p.floorHi);
        px(g, x + 29, y + 13, p.floorHi);
      }
  } else {
    for (let y = top; y < YB; y += 12)
      for (let x = XL; x < XR; x += 24) {
        const col = ((x / 24 + (y - top) / 12) & 1) ? p.floorA : p.floorB;
        rect(g, x, y, 24, 12, col);
        hline(g, x, y, 24, p.floorLine);
        vline(g, x, y, 12, p.floorLine);
      }
    // 地面反光条
    g.save();
    g.globalAlpha = 0.18;
    for (let y = top + 24; y < YB; y += 48) hline(g, XL, y, XR - XL, p.neonA);
    g.restore();
  }
  // 远处(靠墙)更暗:纵深
  g.save();
  for (let j = 0; j < 40; j++) {
    g.globalAlpha = 0.28 * (1 - j / 40);
    hline(g, XL, top + j, XR - XL, '#000');
  }
  g.restore();
}

function drawRugAndRing(g: Ctx, th: Theme): void {
  const p = th.c;
  // 中央地毯
  const rx = 90;
  const ry = 34;
  const cx = TABLE.x;
  const cy = TABLE.y + 6;
  if (th.id === 'lab') {
    rect(g, cx - rx, cy - ry, rx * 2, ry * 2, p.rugEdge);
    rect(g, cx - rx + 2, cy - ry + 2, rx * 2 - 4, ry * 2 - 4, p.rugDark);
    rect(g, cx - rx + 5, cy - ry + 5, rx * 2 - 10, ry * 2 - 10, p.rug);
    for (let i = cx - rx + 8; i < cx + rx - 8; i += 6) {
      px(g, i, cy - ry + 3, p.rugEdge);
      px(g, i + 3, cy + ry - 4, p.rugEdge);
    }
    for (let j = -ry + 10; j < ry - 10; j += 8) for (let i = -rx + 14; i < rx - 14; i += 12) {
      px(g, cx + i, cy + j, p.rugEdge);
      px(g, cx + i + 1, cy + j + 1, shade(p.rug, 0.2));
      px(g, cx + i - 1, cy + j + 1, shade(p.rug, 0.2));
      px(g, cx + i, cy + j + 2, p.rugEdge);
    }
    for (let i = cx - rx; i < cx + rx; i += 2) {
      px(g, i, cy - ry - 1, '#d8c7a0');
      px(g, i, cy + ry, '#d8c7a0');
    }
  } else if (th.id === 'command') {
    ellipse(g, cx, cy, rx, ry, p.rugEdge);
    ellipse(g, cx, cy, rx - 3, ry - 2, p.rugDark);
    ellipse(g, cx, cy, rx - 8, ry - 5, p.rug);
    g.save();
    g.globalAlpha = 0.5;
    for (let a = 0; a < 48; a++) {
      const ang = (a / 48) * Math.PI * 2;
      px(g, cx + Math.cos(ang) * (rx - 5), cy + Math.sin(ang) * (ry - 3.5), p.neonA);
    }
    g.restore();
  } else {
    ellipse(g, cx, cy, rx, ry, p.rugEdge);
    ellipse(g, cx, cy, rx - 2, ry - 2, p.rugDark);
    for (let j = -ry + 6; j < ry - 4; j += 6) for (let i = -rx + 10; i < rx - 10; i += 10) {
      const k = 1 - (j * j) / (ry * ry) - (i * i) / (rx * rx);
      if (k > 0.1) rect(g, cx + i, cy + j, 2, 2, (i + j) % 20 === 0 ? p.neonB : shade(p.rugEdge, -0.35));
    }
  }
  // 走廊:环 + 支路
  const segs: [number, number, number, number][] = [
    [RING.x1, RING.y1, RING.x2, RING.y1],
    [RING.x2, RING.y1, RING.x2, RING.y2],
    [RING.x2, RING.y2, RING.x1, RING.y2],
    [RING.x1, RING.y2, RING.x1, RING.y1],
  ];
  for (const d of DESKS) {
    const pts = [{ x: d.exit[0]!.x, y: d.exit[0]!.y + (d.y > 280 ? 0 : 10) }, ...d.exit.slice(1)];
    if (d.exit.length === 1) pts.unshift({ x: d.seat.x, y: d.y + 16 });
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y]);
  }
  segs.push([PANTRY.path[0]!.x, PANTRY.path[0]!.y, PANTRY.path[1]!.x, PANTRY.path[1]!.y]);
  for (const [x1, y1, x2, y2] of segs) {
    const minx = Math.min(x1, x2);
    const miny = Math.min(y1, y2);
    const horiz = y1 === y2;
    const w = horiz ? Math.abs(x2 - x1) + 12 : 12;
    const h = horiz ? 12 : Math.abs(y2 - y1) + 12;
    const X = horiz ? minx - 6 : minx - 6;
    const Y = horiz ? miny - 6 : miny - 6;
    if (th.id === 'lab') {
      g.save();
      g.globalAlpha = 0.22;
      dither(g, X + 1, Y + 1, w - 2, h - 2, p.floorHi);
      g.restore();
    } else {
      rect(g, X, Y, w, h, p.runner);
    }
  }
  // 边线(第二遍,压在交叉处之上)
  for (const [x1, y1, x2, y2] of segs) {
    const minx = Math.min(x1, x2);
    const miny = Math.min(y1, y2);
    const horiz = y1 === y2;
    const L = horiz ? Math.abs(x2 - x1) + 12 : Math.abs(y2 - y1) + 12;
    const col = th.id === 'lab' ? p.runnerEdge : shade(p.runnerEdge, -0.45);
    for (let i = 0; i < L; i += th.id === 'lab' ? 8 : 4) {
      if (horiz) {
        px(g, minx - 6 + i, miny - 6, col);
        px(g, minx - 6 + i, miny + 5, col);
      } else {
        px(g, minx - 6, miny - 6 + i, col);
        px(g, minx + 5, miny - 6 + i, col);
      }
    }
  }
}

function drawPantryStatic(g: Ctx, th: Theme): void {
  const p = th.c;
  g.save();
  g.translate(36, 0);
  // 柜台
  box(g, 34, 110, 62, 20, p.deskFront, p.deskTopHi, p.deskFrontDark, p.outline);
  rect(g, 34, 106, 62, 5, p.deskTop);
  hline(g, 34, 106, 62, p.deskTopHi);
  for (let x = 38; x < 92; x += 14) {
    rect(g, x, 114, 12, 13, shade(p.deskFront, -0.12));
    px(g, x + 10, 120, p.metalHi);
  }
  // 咖啡机
  box(g, 40, 88, 16, 18, p.metal, p.metalHi, p.metalDark, p.outline);
  rect(g, 43, 92, 10, 4, '#101418');
  rect(g, 45, 99, 6, 1, p.metalDark);
  rect(g, 44, 101, 8, 5, shade(p.metal, -0.3));
  // 杯架
  for (let i = 0; i < 3; i++) {
    rect(g, 62 + i * 5, 102, 4, 4, p.outline);
    rect(g, 62 + i * 5, 102, 3, 3, i === 1 ? p.neonB : '#e8e0d0');
  }
  // 饮水机
  box(g, 80, 96, 12, 14, p.metalHi, shade(p.metalHi, 0.2), p.metal, p.outline);
  rect(g, 81, 80, 10, 16, p.outline);
  rect(g, 82, 81, 8, 14, rgba('#8fd0ff', 0.7) as string);
  rect(g, 82, 81, 2, 14, '#c8ecff');
  // 招牌
  const sign = th.id === 'lab' ? 'TEA' : 'CAFE';
  rect(g, 62, 90, textWidth(sign) + 6, 9, p.outline);
  text(g, sign, 65, 92, p.neonA);
  g.restore();
}

function drawSofaStatic(g: Ctx, th: Theme): void {
  const p = th.c;
  const x = SOFA.x - 32;
  const y = SOFA.y;
  box(g, x, y - 22, 64, 12, p.sofa, p.sofaHi, p.sofaDark, p.outline);
  box(g, x - 2, y - 12, 68, 12, p.sofa, p.sofaHi, p.sofaDark, p.outline);
  box(g, x - 6, y - 18, 7, 18, p.sofaHi, shade(p.sofaHi, 0.2), p.sofaDark, p.outline);
  box(g, x + 63, y - 18, 7, 18, p.sofaHi, shade(p.sofaHi, 0.2), p.sofaDark, p.outline);
  vline(g, x + 32, y - 11, 10, p.sofaDark);
  for (let i = 4; i < 60; i += 8) px(g, x + i, y - 17, p.sofaDark);
  // 抱枕
  box(g, x + 44, y - 18, 10, 7, p.neonB, shade(p.neonB, 0.3), shade(p.neonB, -0.3), p.outline);
  g.save();
  g.globalAlpha = 0.3;
  rect(g, x - 4, y, 72, 2, '#000');
  g.restore();
}

// ---------------- 每帧:墙上会动的 ----------------
export function drawWallDynamic(g: Ctx, th: Theme, t: number, still: boolean, equity: string, wx: Weather): void {
  for (const s of th.wall) {
    if (s.kind === 'window') drawWindow(g, th, s.x, SEG_Y, s.w, SEG_H, t, still, wx);
    else if (s.kind === 'screen') drawWallScreen(g, th, s.x, SEG_Y, s.w, SEG_H, t, still, equity);
    else if (s.kind === 'neon') drawNeonSign(g, th, s, t, still);
  }
  // 天花板吊灯/灯带
  const p = th.c;
  if (th.id === 'command') {
    const k = still ? 1 : 0.75 + 0.25 * Math.sin(t * 2);
    g.save();
    g.globalAlpha = k;
    hline(g, XL, WALL_H - 4, XR - XL, p.neonA);
    g.globalAlpha = 0.25 * k;
    hline(g, XL, WALL_H - 5, XR - XL, p.neonA);
    hline(g, XL, WALL_H - 3, XR - XL, p.neonA);
    g.restore();
  } else if (th.id === 'meme') {
    g.save();
    for (let x = XL; x < XR; x += 2) {
      const on = still ? 1 : 0.6 + 0.4 * Math.sin(t * 3 + x * 0.05);
      g.globalAlpha = on;
      px(g, x, WALL_H - 4, x % 4 ? p.neonA : p.neonB);
    }
    g.restore();
  }
  // 饮水机气泡
  if (!still) {
    const ph = (t * 0.7) % 1;
    px(g, 121 + Math.round(Math.sin(t * 5)), 94 - ph * 12, '#ffffff');
    const ph2 = (t * 0.7 + 0.5) % 1;
    px(g, 123, 94 - ph2 * 12, '#dff4ff');
  }
  // 咖啡机指示灯
  px(g, 89, 90, still || Math.sin(t * 3) > 0 ? '#ff4040' : '#601010');
}

export function windowRects(th: Theme): { x: number; y: number; w: number; h: number }[] {
  return th.wall.filter((s) => s.kind === 'window').map((s) => ({ x: s.x, y: SEG_Y, w: s.w, h: SEG_H }));
}

const DAY_SKY = ['#5a8fd0', '#7aa8dc', '#9cc0e4', '#c8d8e8'];

function drawWindow(g: Ctx, th: Theme, x: number, y: number, w: number, h: number, t: number, still: boolean, wx: Weather): void {
  const W = { ...th.win, sky: wx.night ? th.win.sky : wx.rain ? ['#4a5468', '#5a6478', '#6a7488', '#7a8498'] : DAY_SKY.map((c, i) => mix(c, th.win.sky[i]!, 0.25)), stars: th.win.stars && wx.night && !wx.rain, rain: wx.rain, moon: wx.night && !wx.rain ? th.win.moon : null };
  if (!wx.night) W.lit = W.lit.map((c) => shade(c, -0.55));
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  // 天空分带 + 抖动过渡
  const band = Math.ceil(h / W.sky.length);
  W.sky.forEach((c, i) => rect(g, x, y + i * band, w, band, c));
  W.sky.forEach((c, i) => {
    if (i > 0) dither(g, x, y + i * band - 2, w, 3, c, i);
  });
  if (W.stars) for (let i = 0; i < 26; i++) {
    const sx = x + Math.floor(hash(i * 3 + x) * w);
    const sy = y + Math.floor(hash(i * 5 + x) * h * 0.45);
    const tw = still ? 1 : Math.sin(t * 2 + i) > -0.3 ? 1 : 0;
    if (tw) px(g, sx, sy, i % 5 ? '#c8d0ff' : '#ffffff');
  }
  if (W.moon && x < 100) {
    const mx = x + w - 26;
    const my = y + 13;
    g.save();
    g.globalAlpha = 0.2;
    ellipse(g, mx, my, 10, 10, W.moon);
    g.restore();
    ellipse(g, mx, my, 6, 6, W.moon);
    px(g, mx - 2, my - 1, shade(W.moon, -0.12));
    px(g, mx + 1, my + 2, shade(W.moon, -0.12));
    px(g, mx + 2, my - 3, shade(W.moon, -0.08));
  }
  // 飞艇
  if (W.blimp && x < 100) {
    const bx = x + ((still ? 30 : t * 6) % (w + 60)) - 30;
    const by = y + 18 + Math.round(Math.sin(t * 0.8) * 1);
    ellipse(g, bx, by, 14, 5, '#1a0a2a');
    ellipse(g, bx, by, 13, 4, '#6a3a9a');
    hline(g, bx - 10, by - 2, 20, '#8a5ac0');
    rect(g, bx - 8, by - 1, 16, 3, '#ff4fd8');
    text(g, 'HODL', bx - 7, by - 2, '#fff0fa');
    rect(g, bx - 3, by + 5, 6, 2, '#2a1040');
  }
  // 远楼
  const R = rng(x * 17 + 3);
  for (let bx = x - 4; bx < x + w; ) {
    const bw = 8 + Math.floor(R() * 12);
    const bh = 22 + Math.floor(R() * 26);
    rect(g, bx, y + h - bh, bw, bh, W.far);
    for (let wy = y + h - bh + 3; wy < y + h - 2; wy += 4)
      for (let wx = bx + 2; wx < bx + bw - 1; wx += 3) {
        const id = wx * 131 + wy * 7;
        const on = hash(id + Math.floor(still ? 0 : t * 0.25 + hash(id) * 8)) > 0.78;
        if (on) px(g, wx, wy, shade(W.lit[id % W.lit.length]!, -0.35));
      }
    bx += bw + 1;
  }
  // 近楼
  let tallest = { x: 0, y: y + h, w: 0 };
  for (let bx = x - 6; bx < x + w; ) {
    const bw = 12 + Math.floor(R() * 16);
    const bh = 14 + Math.floor(R() * 36);
    const top = y + h - bh;
    rect(g, bx, top, bw, bh, W.near);
    vline(g, bx, top, bh, W.nearHi);
    hline(g, bx, top, bw, W.nearHi);
    if (top < tallest.y) tallest = { x: bx, y: top, w: bw };
    for (let wy = top + 3; wy < y + h - 1; wy += 3)
      for (let wx = bx + 2; wx < bx + bw - 2; wx += 3) {
        const id = wx * 71 + wy * 13;
        const on = hash(id + Math.floor(still ? 0 : t * 0.18 + hash(id + 1) * 11)) > 0.6;
        if (on) px(g, wx, wy, W.lit[id % W.lit.length]!);
        else if (hash(id + 3) > 0.6) px(g, wx, wy, shade(W.near, 0.12));
      }
    bx += bw + 1;
  }
  // 楼顶航标灯
  const blink = still || Math.sin(t * 3) > 0.2;
  vline(g, tallest.x + Math.floor(tallest.w / 2), tallest.y - 5, 5, W.nearHi);
  if (blink) px(g, tallest.x + Math.floor(tallest.w / 2), tallest.y - 6, '#ff3a3a');
  // 雨
  if (W.rain && !still) {
    g.fillStyle = 'rgba(170,200,255,0.45)';
    for (let i = 0; i < 40; i++) {
      const sp = 60 + hash(i) * 40;
      const rx = x + ((hash(i * 7) * (w + 40) + t * sp * 0.35) % (w + 40)) - 20;
      const ry = y + ((hash(i * 11) * h + t * sp) % h);
      g.fillRect(Math.round(rx), Math.round(ry), 1, 3);
      g.fillRect(Math.round(rx) - 1, Math.round(ry) + 3, 1, 1);
    }
  }
  // 打雷:闪白 + 闪电
  if (wx.thunder && !still) {
    const k = Math.floor(t * 2.5);
    if (hash(k * 13 + x) > 0.86) {
      g.save();
      g.globalAlpha = 0.45;
      rect(g, x, y, w, h, '#e8f0ff');
      g.restore();
      let bx = x + 10 + hash(k) * (w - 20);
      for (let by = y; by < y + h * 0.7; by += 3) {
        rect(g, bx, by, 1, 3, '#ffffff');
        bx += (hash(k + by) - 0.5) * 4;
      }
    }
  }
  // 盈利:烟花
  if (wx.fireworks && !still && wx.night) {
    for (let f = 0; f < 2; f++) {
      const cyc = 2.8;
      const T = t + f * 1.4 + x * 0.01;
      const k = Math.floor(T / cyc);
      const ph = (T % cyc) / cyc;
      const fx = x + 12 + hash(k * 7 + f + x) * (w - 24);
      const fy = y + 10 + hash(k * 3 + f) * 16;
      const col = W.lit[(k + f) % W.lit.length]!;
      if (ph < 0.25) px(g, fx, fy + (1 - ph / 0.25) * 30, '#fff0c0');
      else if (ph < 0.8) {
        const r = ((ph - 0.25) / 0.55) * 9;
        g.save();
        g.globalAlpha = 1 - (ph - 0.25) / 0.55;
        for (let a = 0; a < 12; a++) px(g, fx + Math.cos(a * 0.52) * r, fy + Math.sin(a * 0.52) * r + (ph - 0.25) * 6, col);
        g.restore();
      }
    }
  }
  // 玻璃反光
  g.save();
  g.globalAlpha = 0.08;
  for (let i = 0; i < h; i++) hline(g, x + 10 + i * 0.6, y + i, 10, '#ffffff');
  g.restore();
  g.restore();
  // 窗棂
  const p = th.c;
  const cols = Math.max(1, Math.round(w / 48));
  for (let i = 1; i < cols; i++) {
    const mx = x + Math.round((w * i) / cols);
    rect(g, mx - 1, y, 3, h, p.trim);
    vline(g, mx - 1, y, h, p.trimHi);
  }
  rect(g, x, y + Math.round(h * 0.38), w, 2, p.trim);
  hline(g, x, y + Math.round(h * 0.38), w, p.trimHi);
}

function drawWallScreen(g: Ctx, th: Theme, x: number, y: number, w: number, h: number, t: number, still: boolean, equity: string): void {
  const p = th.c;
  const acc = p.neonA;
  rect(g, x, y, w, h, '#050a10');
  // 世界地图点阵
  const mapW = 36;
  const ox = x + 3;
  const oy = y + 12;
  for (let r = 0; r < 14; r++)
    for (let c = 0; c < mapW; c++) {
      const land = WORLD[r + 1]?.[c] === '#';
      if (land && (c + r) % 1 === 0) px(g, ox + c * 1.4, oy + r * 2, shade(p.up, -0.25));
    }
  // 城市脉冲
  const cities = [[9, 4], [19, 3], [30, 5], [28, 10], [12, 11]];
  cities.forEach(([c, r], i) => {
    const ph = still ? 0.3 : (t * 0.6 + i * 0.23) % 1;
    const X = ox + c! * 1.4;
    const Y = oy + r! * 2;
    px(g, X, Y, '#ffffff');
    if (ph < 0.6) {
      g.save();
      g.globalAlpha = 0.6 - ph;
      const rr = Math.round(ph * 8);
      for (let a = 0; a < 12; a++) px(g, X + Math.cos((a / 12) * 6.28) * rr, Y + Math.sin((a / 12) * 6.28) * rr * 0.6, acc);
      g.restore();
    }
  });
  text(g, 'MARKETS', x + 3, y + 3, acc);
  if (!still && Math.sin(t * 4) > 0) text(g, 'LIVE', x + 34, y + 3, p.down);
  // 右侧:K 线
  const cx0 = x + 56;
  const cw = w - 60;
  rect(g, cx0 - 2, y + 2, 1, h - 4, '#0f2030');
  const n = Math.floor(cw / 3);
  const shift = still ? 0 : Math.floor(t * 1.5);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const k = i + shift;
    const o = Math.sin(k * 0.35) * 8 + Math.sin(k * 0.11) * 10 + (hash(k) - 0.5) * 6;
    const c2 = o + (hash(k + 99) - 0.45) * 7;
    const hi = Math.max(o, c2) + hash(k + 7) * 3;
    const lo = Math.min(o, c2) - hash(k + 8) * 3;
    const base = y + 34;
    const col = c2 >= o ? p.up : p.down;
    vline(g, cx0 + i * 3 + 1, base - hi, hi - lo + 1, shade(col, -0.2));
    rect(g, cx0 + i * 3, base - Math.max(o, c2), 3 - 1 + 1, Math.max(1, Math.abs(c2 - o)), col);
    v = c2;
  }
  void v;
  // 成交量柱
  for (let i = 0; i < n; i++) {
    const k = i + shift;
    const vh = 2 + Math.floor(hash(k * 3) * 8);
    rect(g, cx0 + i * 3, y + h - 12 - vh, 2, vh, shade(acc, -0.45));
  }
  // 权益数
  rect(g, x + 2, y + h - 10, w - 4, 8, '#081420');
  text(g, 'EQ ' + equity, x + 4, y + h - 8, p.text);
  // 扫描线
  if (!still) {
    const sy = y + Math.floor((t * 20) % h);
    g.save();
    g.globalAlpha = 0.12;
    hline(g, x, sy, w, '#ffffff');
    g.restore();
  }
}

function drawNeonSign(g: Ctx, th: Theme, s: WallSeg, t: number, still: boolean): void {
  const p = th.c;
  const label = s.text?.[0] ?? '';
  const scale = 3;
  const tw = textWidth(label, scale);
  const x = Math.round(s.x + (s.w - tw) / 2);
  const y = SEG_Y + 14;
  // 灯管
  for (const [nx, col] of [[s.x - 3, p.neonB], [s.x + s.w + 3, p.neonA]] as const) {
    const on = still ? 1 : 0.8 + 0.2 * Math.sin(t * 5 + nx);
    g.save();
    g.globalAlpha = 0.25 * on;
    rect(g, nx - 3, SEG_Y - 4, 7, SEG_H + 8, col);
    g.globalAlpha = on;
    rect(g, nx - 1, SEG_Y - 4, 3, SEG_H + 8, mix(col, '#ffffff', 0.5));
    g.restore();
  }
  // 偶尔闪一下的字母
  const flick = still ? -1 : Math.floor(t * 7) % 53 === 0 ? 2 : -1;
  for (let i = 0; i < label.length; i++) {
    const ch = label[i]!;
    const on = i === flick ? 0.2 : 1;
    neonText(g, ch, x + i * 4 * scale, y, i < 4 ? p.neonA : p.neonB, scale, on);
  }
  text(g, 'IDEAS  AGENTS  TRADES', s.x + (s.w - textWidth('IDEAS  AGENTS  TRADES')) / 2, y + 22, p.textDim);
  // 小心形
  const hx = s.x + s.w / 2;
  const hy = y + 34;
  const pulse = still ? 1 : 0.7 + 0.3 * Math.sin(t * 4);
  g.save();
  g.globalAlpha = pulse;
  rect(g, hx - 4, hy, 3, 2, p.neonA);
  rect(g, hx + 1, hy, 3, 2, p.neonA);
  rect(g, hx - 3, hy + 2, 6, 1, p.neonA);
  rect(g, hx - 2, hy + 3, 4, 1, p.neonA);
  rect(g, hx - 1, hy + 4, 2, 1, p.neonA);
  g.restore();
}

// ---------------- 每帧:地上会动的 ----------------
/** 走廊引导灯:沿环流动的光点;active 表示有信封在路上,光更亮 */
export function drawFloorDynamic(g: Ctx, th: Theme, t: number, still: boolean, active: number): void {
  const p = th.c;
  if (still) return;
  const col = th.id === 'lab' ? p.lamp : p.runnerEdge;
  const per = 2 * (RING.x2 - RING.x1 + RING.y2 - RING.y1);
  const n = 18;
  g.save();
  for (let i = 0; i < n; i++) {
    const s = ((i / n) * per + t * 14) % per;
    const pt = ringPt(s);
    const a = th.id === 'lab' ? 0.35 : 0.55 + 0.35 * Math.min(1, active);
    g.globalAlpha = a;
    px(g, pt.x - 6, pt.y - 6, col);
    px(g, pt.x + 5, pt.y + 5, col);
    px(g, pt.x - 6, pt.y + 5, col);
    px(g, pt.x + 5, pt.y - 6, col);
  }
  g.restore();
}

function ringPt(s: number): { x: number; y: number } {
  const W = RING.x2 - RING.x1;
  const H = RING.y2 - RING.y1;
  if (s < W) return { x: RING.x1 + s, y: RING.y1 };
  s -= W;
  if (s < H) return { x: RING.x2, y: RING.y1 + s };
  s -= H;
  if (s < W) return { x: RING.x2 - s, y: RING.y2 };
  s -= W;
  return { x: RING.x1, y: RING.y2 - s };
}

/** 墙边与角落的动态道具(宠物、落地灯) */
export function drawLounge(g: Ctx, th: Theme, t: number, still: boolean, roll = false): void {
  const p = th.c;
  const pet = th.pet;
  const px0 = SOFA.x - 8;
  if (roll) {
    // 彩蛋:翻身 + 打哈欠
    g.save();
    g.translate(px0, 0);
    g.scale(-1, 1);
    g.translate(-px0, 0);
    drawPet(g, pet.kind, pet.body, pet.dark, pet.belly, px0, SOFA.y - 12, t, p.outline, true);
    g.restore();
    rect(g, px0 + 8, SOFA.y - 17, 3, 3, p.outline);
    px(g, px0 + 9, SOFA.y - 16, '#e27a8a');
  } else drawPet(g, pet.kind, pet.body, pet.dark, pet.belly, px0, SOFA.y - 11, t, p.outline, still);
  // 落地灯(沙发旁)
  const lx = SOFA.x - 44;
  rect(g, lx, 100, 1, 32, p.metalDark);
  rect(g, lx - 3, 131, 7, 2, p.metalDark);
  box(g, lx - 5, 92, 11, 8, p.lamp, shade(p.lamp, 0.35), shade(p.lamp, -0.3), p.outline);
}

// ---------------- 会议桌 + 全息地球 ----------------
export function drawTable(g: Ctx, th: Theme, t: number, still: boolean, meeting: boolean): void {
  const p = th.c;
  const { x, y, rx, ry } = TABLE;
  g.save();
  g.globalAlpha = 0.35;
  ellipse(g, x, y + 10, rx + 4, ry, '#000');
  g.restore();
  // 桌腿/底座
  rect(g, x - 16, y + 4, 32, 10, p.outline);
  rect(g, x - 15, y + 4, 30, 9, p.tableDark);
  // 桌沿厚度
  ellipse(g, x, y + 3, rx + 1, ry + 1, p.outline);
  ellipse(g, x, y + 3, rx, ry, p.tableDark);
  ellipse(g, x, y, rx, ry, p.table);
  ellipse(g, x, y - 1, rx - 3, ry - 3, p.tableHi);
  ellipse(g, x, y, rx - 4, ry - 3, p.table);
  if (th.id !== 'lab') {
    g.save();
    g.globalAlpha = meeting ? 0.9 : 0.5;
    for (let a = 0; a < 90; a++) {
      const ang = (a / 90) * Math.PI * 2;
      px(g, x + Math.cos(ang) * (rx - 1), y + 2 + Math.sin(ang) * (ry - 0.5), p.neonA);
    }
    g.restore();
  } else {
    // 木纹
    for (let i = -rx + 10; i < rx - 10; i += 9) hline(g, x + i, y - 4 + ((i * 3) & 7), 6, shade(p.table, -0.15));
  }
  // 桌上小物:文件、笔记本、杯子
  rect(g, x - 44, y - 4, 10, 7, '#e8e0cc');
  hline(g, x - 43, y - 2, 7, '#9a8a70');
  hline(g, x - 43, y, 6, '#9a8a70');
  box(g, x + 30, y - 2, 14, 7, p.metalDark, p.metal, p.outline);
  rect(g, x + 32, y - 7, 10, 5, p.monFrame);
  rect(g, x + 33, y - 6, 8, 3, still ? p.neonB : Math.sin(t * 3) > 0 ? p.neonB : shade(p.neonB, -0.3));
  // 投影台
  const gx = GLOBE.x;
  const gy = GLOBE.y;
  ellipse(g, x, y - 1, 12, 4, p.outline);
  ellipse(g, x, y - 2, 11, 3, p.metal);
  ellipse(g, x, y - 3, 8, 2, p.holoDim);
  // 光束
  g.save();
  g.globalAlpha = th.id === 'lab' ? 0.14 : 0.2;
  for (let j = 0; j < y - 3 - gy; j++) {
    const k = j / (y - 3 - gy);
    const hw = Math.round(3 + k * 6);
    hline(g, x - hw, y - 3 - j, hw * 2 + 1, p.holo);
  }
  g.restore();
  // 地球(会议时更亮更大)
  const r = GLOBE.r + (meeting ? 2 : 0);
  const bob = still ? 0 : Math.round(Math.sin(t * 1.5));
  g.save();
  g.globalAlpha = 0.25;
  ellipse(g, gx, gy + bob, r + 4, r + 4, p.holo);
  g.restore();
  g.save();
  g.globalAlpha = 0.95;
  drawGlobe(g, gx, gy + bob, r, p.holo, p.holoDim, t, still);
  g.restore();
  // 环绕光环
  if (!still) {
    const a0 = t * 1.2;
    for (let k = 0; k < 24; k++) {
      const ang = a0 + (k / 24) * Math.PI * 2;
      const front = Math.sin(ang) > 0;
      g.fillStyle = rgba(p.holo, front ? 0.9 : 0.35);
      g.fillRect(Math.round(gx + Math.cos(ang) * (r + 6)), Math.round(gy + bob + Math.sin(ang) * 3), 1, 1);
    }
  }
}

// ---------------- 光与暗角 ----------------
export function buildLights(th: Theme): HTMLCanvasElement {
  const [cv, g] = makeCanvas(BUF_W, BUF_H);
  g.translate(EX, EY);
  const p = th.c;
  const col = p.lampLight;
  const pool = (x: number, y: number, rx: number, ry: number, a: number) => {
    g.fillStyle = col;
    g.globalAlpha = a * 0.5;
    ellipse(g, x, y, rx, ry, col);
    g.globalAlpha = a * 0.6;
    ellipse(g, x, y, Math.round(rx * 0.66), Math.round(ry * 0.66), col);
    g.globalAlpha = a;
    ellipse(g, x, y, Math.round(rx * 0.36), Math.round(ry * 0.36), col);
    g.globalAlpha = a * 0.5;
    ellipseDither(g, x, y, rx + 3, ry + 2, col);
  };
  const a = th.lights === 'lamp' ? 0.075 : 0.055;
  for (const d of DESKS) pool(d.x + (th.lights === 'lamp' ? d.wide / 2 - 8 : 0), d.y - 6, th.lights === 'lamp' ? 34 : 38, 14, a);
  pool(SOFA.x - 44, 116, 30, 14, a);
  pool(TABLE.x, TABLE.y - 10, 60, 26, a * (th.lights === 'lamp' ? 0.9 : 1.3));
  if (th.lights !== 'lamp') {
    // 窗/屏的冷光落在地上
    for (const s of th.wall) if (s.kind !== 'poster') pool(s.x + s.w / 2, WALL_H + 10, s.w / 2, 10, 0.05);
  } else {
    for (const s of th.wall) if (s.kind === 'window') pool(s.x + s.w / 2, WALL_H + 16, s.w / 2, 10, 0.03);
  }
  g.globalAlpha = 1;
  return cv;
}

export function buildVignette(th: Theme): HTMLCanvasElement {
  const [cv, g] = makeCanvas(BUF_W, BUF_H);
  const grd = g.createRadialGradient(BUF_W / 2, BUF_H * 0.55, 140, BUF_W / 2, BUF_H * 0.55, 470);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, th.id === 'lab' ? 'rgba(10,4,0,0.55)' : 'rgba(0,0,10,0.5)');
  g.fillStyle = grd;
  g.fillRect(0, 0, BUF_W, BUF_H);
  g.fillStyle = th.c.night;
  g.fillRect(0, 0, BUF_W, BUF_H);
  // 抖动量化:把平滑渐变压成像素台阶感
  return cv;
}

// ---------------- 前景植物/角落 ----------------
export const PLANTS: { x: number; y: number; s: number }[] = [
  { x: 60, y: 176, s: 2 },
  { x: 262, y: 122, s: 1 },
  { x: 406, y: 122, s: 1 },
  { x: 584, y: 180, s: 2 },
  { x: 204, y: 334, s: 1.4 },
  { x: 436, y: 334, s: 1.4 },
  { x: 58, y: 266, s: 1.3 },
  { x: 584, y: 266, s: 1.3 },
];

export function drawPlants(g: Ctx, th: Theme, t: number, still: boolean, list = PLANTS): void {
  list.forEach((pl, i) => drawPlant(g, th.c, pl.x, pl.y, pl.s, t, i + 3, still));
}

/** 画布最下面的前景大叶子(压在一切之上,制造纵深) */
export function drawForeground(g: Ctx, th: Theme, t: number, still: boolean, view = { x0: 0, x1: WORLD_W, y1: WORLD_H }): void {
  const p = th.c;
  const sway = still ? 0 : Math.sin(t * 0.9) * 1.5;
  const leaf = (bx: number, by: number, dir: number, len: number, col: string) => {
    for (let i = 0; i < len; i++) {
      const f = i / len;
      const x = bx + dir * i * 0.9 + sway * f;
      const y = by - i * 0.8 + f * f * len * 0.6;
      const wdt = Math.max(1, Math.round(4 * Math.sin(f * Math.PI)));
      rect(g, x, y - wdt / 2, 1, wdt, col);
    }
  };
  const L = view.x0;
  const R = view.x1;
  const B = view.y1;
  leaf(L + 10, B + 4, 1, 44, p.plantDark);
  leaf(L, B + 2, 1, 34, p.plant);
  leaf(L + 18, B + 6, -1, 26, p.plantDark);
  leaf(L + 4, B - 6, 1, 24, p.plantHi);
  leaf(R - 10, B + 4, -1, 44, p.plantDark);
  leaf(R, B + 2, -1, 34, p.plant);
  leaf(R - 18, B + 6, 1, 26, p.plantDark);
  leaf(R - 4, B - 6, -1, 24, p.plantHi);
}
