/**
 * 可移植的楼层引擎(布局 B · 大楼剖面)。
 *   const h = mount(canvas, { theme, onSelectAgent });  h.setData(snapshot); h.setTheme('meme'); h.destroy();
 * 以后 React 只需 useEffect 里 mount 一次,query 变了就 setData。引擎不依赖 React / 路由 / 网关。
 *
 * 画面:逻辑分辨率缓冲(~300 像素高)→ 整数倍放大到显示画布(image-rendering: pixelated)。
 * 镜头:聚焦某个房间时整数倍推进,过渡中允许非整数,停稳后对齐像素网格。
 */
import { computeLayout } from './layout';
import { render, focusRect } from './render';
import { ROLES, STATUS_LABEL } from './roles';
import { THEMES } from './themes';
import type { AgentSnap, EvoDay, EvoDayDetail, EvoRoleRow, FloorHandle, MountOptions, Role, Snapshot, ThemeId } from './types';
import { evoHit, type EvoHit } from './evo';
import { createNpc, NPC_CSS } from './npc';
import { computeWeather, type Weather, type WeatherOverride } from './weather';
import { World } from './world';

const CSS = `
.flb-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",ui-monospace,monospace}
.flb-bubble{position:absolute;left:0;top:0;transform:translate(-50%,-100%);white-space:nowrap;font-size:12px;line-height:1.25;padding:4px 7px;color:#f4f1ea;background:#14121a;border:2px solid var(--c);box-shadow:3px 3px 0 rgba(0,0,0,.55);image-rendering:pixelated;transition:opacity .2s}
.flb-bubble::after{content:"";position:absolute;left:50%;bottom:-8px;margin-left:-3px;width:6px;height:6px;background:var(--c);clip-path:polygon(0 0,100% 0,50% 100%)}
.flb-bubble.alert{background:#2a0610;color:#ffd5dc}
.flb-bubble.evo{background:#2a2206;color:#ffe9a0;--c:#ffe36b !important;font-weight:700}
.flb-evotip{position:absolute;left:0;top:0;min-width:180px;max-width:280px;font-size:12px;line-height:1.4;padding:7px 9px;background:#0d0c12;color:#eee;border:2px solid var(--c);box-shadow:3px 3px 0 rgba(0,0,0,.6);pointer-events:none}
.flb-evotip .d{font-family:ui-monospace,monospace;font-weight:700;display:flex;gap:8px;align-items:center}
.flb-evotip .sq{width:10px;height:10px;display:inline-block;box-shadow:inset -2px -2px 0 rgba(0,0,0,.35)}
.flb-evotip .h{margin-top:3px}
.flb-evotip .e{color:#ffe36b;margin-top:3px}
.flb-evotip .hint{color:#888;font-size:11px;margin-top:4px}
.flb-drawer{position:absolute;left:0;top:0;width:320px;pointer-events:auto;background:var(--panel,#15121c);color:var(--ink,#eee);border:2px solid var(--c);box-shadow:5px 5px 0 rgba(0,0,0,.55);padding:12px 14px;font-size:13px}
.flb-drawer .x{position:absolute;right:8px;top:6px;cursor:pointer;background:none;border:0;color:var(--dim,#999);font:inherit;font-size:16px;box-shadow:none;padding:0 4px}
.flb-drawer .hd{font-family:ui-monospace,monospace;font-weight:800;color:var(--c);display:flex;gap:8px;align-items:center}
.flb-drawer .sq{width:12px;height:12px;display:inline-block;box-shadow:inset -2px -2px 0 rgba(0,0,0,.35)}
.flb-drawer .hl{margin:6px 0 10px;line-height:1.45}
.flb-drawer .nums{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}
.flb-drawer .num{background:var(--panel-2,#1c1826);border:1px solid var(--line,#333);padding:6px 7px}
.flb-drawer .num .v{font-family:ui-monospace,monospace;font-size:16px;font-weight:700}
.flb-drawer .num .k{font-size:11px;color:var(--dim,#999)}
.flb-drawer ul{list-style:none;margin:0 0 10px;padding:0}
.flb-drawer li{padding:5px 0;border-top:1px dashed var(--line,#333)}
.flb-drawer li b{display:block;font-weight:600}
.flb-drawer li span{color:var(--dim,#999);font-size:12px}
.flb-drawer button.go{font:inherit;font-size:13px;cursor:pointer;padding:6px 11px;border:2px solid var(--c);background:var(--c);color:#0b0b10;font-weight:700;box-shadow:2px 2px 0 rgba(0,0,0,.5)}
.flb-bubble b{color:var(--c);font-weight:700;margin-right:5px;font-family:ui-monospace,monospace;font-size:11px}
.flb-tip{position:absolute;left:0;top:0;transform:translate(-50%,calc(-100% - 6px));font-size:12px;padding:5px 8px;background:rgba(10,10,16,.92);color:#eee;border:1px solid var(--c);white-space:nowrap}
.flb-tip b{color:var(--c);font-family:ui-monospace,monospace;margin-right:6px}
@media (prefers-reduced-motion: reduce){.flb-bubble{transition:none}}
`;


export function mount(canvas: HTMLCanvasElement, opts: MountOptions): FloorHandle {
  const host = canvas.parentElement!;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  if (!document.getElementById('flb-css')) {
    const st = document.createElement('style');
    st.id = 'flb-css';
    st.textContent = CSS + NPC_CSS;
    document.head.appendChild(st);
  }
  const overlay = opts.overlay ?? (() => { const d = document.createElement('div'); host.appendChild(d); return d; })();
  overlay.classList.add('flb-overlay');

  const reduced = opts.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let theme = THEMES[opts.theme] ?? THEMES.study;
  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d')!;
  const ctx = canvas.getContext('2d')!;
  canvas.style.imageRendering = 'pixelated';

  let dpr = 1, Wdev = 1, Hdev = 1, S = 2;
  let world: World | null = null;
  let snapshot: Snapshot | null = null;
  const agentsByRole = new Map<Role, AgentSnap>();
  const evoRows = new Map<Role, EvoRoleRow>();
  let evoExpanded: Role | null = null;
  let evoHover: EvoHit | null = null;
  let drawer: { role: Role; index: number } | null = null;

  // 镜头
  const cam = { z: 1, cx: 0, cy: 0, tz: 1, tcx: 0, tcy: 0 };
  let focusRole: Role | null = null;
  let focusAmt = 0;
  let hover: Role | null = null;
  let view = { sx: 0, sy: 0, scale: 1 };

  function resize(): void {
    const rect = host.getBoundingClientRect();
    dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    Wdev = Math.max(2, Math.round(rect.width * dpr));
    Hdev = Math.max(2, Math.round(rect.height * dpr));
    canvas.width = Wdev;
    canvas.height = Hdev;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    S = Math.max(1, Math.min(Math.floor(Hdev / 290), Math.floor(Wdev / 380)));
    const LW = Math.ceil(Wdev / S), LH = Math.ceil(Hdev / S);
    buf.width = LW;
    buf.height = LH;
    const L = computeLayout(LW, LH);
    if (!world) {
      world = new World(L, reduced);
      world.onDelivered = (k) => opts.onHandoffDelivered?.(k);
      if (snapshot) world.apply(snapshot.agents, snapshot.handoffs, snapshot.meetings, snapshot.evolution);
    } else world.relayout(L);
    setCamTarget(true);
  }

  function setCamTarget(snap = false): void {
    if (!world) return;
    const L = world.L;
    if (!focusRole) {
      cam.tz = 1; cam.tcx = L.LW / 2; cam.tcy = L.LH / 2;
    } else {
      const r = focusRect(world, focusRole);
      const z = Math.max(2, Math.min(4, Math.floor(Math.min((L.LW * 0.94) / (r.w + 16), (L.LH * 0.62) / (r.h + 20)))));
      cam.tz = z;
      cam.tcx = r.x + r.w / 2;
      cam.tcy = r.y + r.h / 2 + (L.LH / z) * 0.16;
    }
    if (snap || reduced) { cam.z = cam.tz; cam.cx = cam.tcx; cam.cy = cam.tcy; }
  }

  function computeView(): void {
    if (!world) return;
    const L = world.L;
    const scale = S * cam.z;
    const sw = Wdev / scale, sh = Hdev / scale;
    let sx = cam.cx - sw / 2, sy = cam.cy - sh / 2;
    sx = Math.max(0, Math.min(L.LW - sw, sx));
    sy = Math.max(0, Math.min(L.LH - sh, sy));
    const settled = Math.abs(cam.z - Math.round(cam.z)) < 0.001;
    if (settled) { sx = Math.round(sx); sy = Math.round(sy); }
    view = { sx, sy, scale };
  }

  const toCss = (lx: number, ly: number) => ({ x: ((lx - view.sx) * view.scale) / dpr, y: ((ly - view.sy) * view.scale) / dpr });
  const toLogical = (cx: number, cy: number) => ({ x: (cx * dpr) / view.scale + view.sx, y: (cy * dpr) / view.scale + view.sy });

  // ---------- 命中测试 ----------
  function hit(cx: number, cy: number): Role | null {
    if (!world) return null;
    const p = toLogical(cx, cy);
    for (const a of world.actors.values()) {
      const ap = world.actorPos(a);
      if (Math.abs(p.x - ap.x) <= 10 && p.y <= ap.y + 1 && p.y >= ap.y - 22) return a.role;
    }
    for (const r of Object.values(world.L.rooms)) {
      if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) return r.role;
    }
    return null;
  }

  function setFocus(role: Role | null, notify = true): void {
    if (role === focusRole) return;
    focusRole = role;
    if (!role || (evoExpanded && evoExpanded !== role)) evoExpanded = null;
    setCamTarget();
    renderCard();
    if (notify) opts.onSelectAgent?.(role);
  }

  const evoAt = (cx: number, cy: number): EvoHit | null => {
    if (!world) return null;
    const p = toLogical(cx, cy);
    return evoHit(world.L, evoRows, p.x, p.y, evoExpanded);
  };
  // ---------- 场景里的可点物件:信箱 / 雕像 / 宠物 / 天空(天气解释) ----------
  type Thing = 'mailbox' | 'statue' | 'pet' | 'sky';
  function thingAt(cx: number, cy: number): Thing | null {
    if (!world) return null;
    const p = toLogical(cx, cy);
    const L = world.L, g = L.groundY;
    if (p.x >= world.mailboxX - 2 && p.x <= world.mailboxX + 14 && p.y >= g - 28 && p.y <= g) return 'mailbox';
    if (p.x >= world.statueX - 1 && p.x <= world.statueX + 15 && p.y >= g - 17 && p.y <= g) return 'statue';
    const bx = L.wingX + Math.round((L.wingW - 2) * 0.55);
    if (p.x >= bx + 2 && p.x <= bx + 18 && p.y >= L.wingTop - 14 && p.y <= L.wingTop - 4) return 'pet';
    const inTower = p.x >= L.mainX - 2 && p.x <= L.wingX + L.wingW + 2 && p.y >= L.towerTop - 30;
    const aboveTerrace = p.x >= L.wingX && p.y < L.wingTop - 34 && p.y >= L.towerTop - 30;
    if (p.y < g - 30 && (!inTower || aboveTerrace)) return 'sky';
    const hr = L.rooms.gate_captain;
    if (p.x >= hr.x + hr.w - 26 && p.x <= hr.x + hr.w - 8 && p.y >= hr.y + 11 && p.y <= hr.y + hr.h * 0.5) return 'sky';
    return null;
  }
  let thing: Thing | null = null;
  let hoverSince = 0;
  let waved: Role | null = null;
  let statueHits = 0;
  let statueLast = 0;

  const onMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    evoHover = evoAt(cx, cy);
    thing = evoHover ? null : thingAt(cx, cy);
    const h = evoHover || (thing && thing !== 'sky') ? null : hit(cx, cy);
    if (h !== hover) { hover = h; hoverSince = performance.now(); waved = null; }
    if (world) world.cursor = toLogical(cx, cy);
    canvas.style.cursor = evoHover || hover || (thing && thing !== 'sky') ? CURSOR_POINT : CURSOR_GLOVE;
  };
  const onLeave = () => { hover = null; evoHover = null; thing = null; if (world) world.cursor = null; };
  const onClick = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const eh = evoAt(cx, cy);
    if (eh) {
      if (eh.kind === 'title') {
        evoExpanded = evoExpanded === eh.role ? null : eh.role;
        if (evoExpanded && focusRole !== eh.role) setFocus(eh.role);
        closeDrawer();
      } else openDrawer(eh.role, eh.index);
      return;
    }
    if (drawer) { closeDrawer(); return; }
    const th2 = thingAt(cx, cy);
    if (th2 && world) {
      if (th2 === 'mailbox') { opts.onMailbox?.(); return; }
      if (th2 === 'statue') {
        const now = performance.now();
        statueHits = now - statueLast < 900 ? statueHits + 1 : 1;
        statueLast = now;
        if (statueHits >= 5) {
          statueHits = 0;
          world.coinShower(world.statueX + 7, world.L.groundY - 14);
          opts.onToast?.('招财柴犬显灵了:撒了一地金币(彩蛋)');
        }
        return;
      }
      if (th2 === 'pet') {
        const L = world.L;
        const bx = L.wingX + Math.round((L.wingW - 2) * 0.55);
        world.petRoll(bx + 10, L.wingTop - 12);
        return;
      }
    }
    const r = hit(cx, cy);
    if (world) {
      const p = toLogical(cx, cy);
      // 点在地板附近 → 小涟漪
      for (let l = 0; l < 6; l++) {
        const fy = world.L.floorY(l);
        if (Math.abs(p.y - fy) < 5 && p.x > world.L.mainX && p.x < world.L.wingX + world.L.wingW) world.ripple(p.x, fy - 1);
      }
      if (p.y > world.L.groundY - 3) world.ripple(p.x, Math.min(p.y, world.L.groundY + 3));
    }
    if (focusRole) {
      if (!r) setFocus(null);
      else if (r !== focusRole) setFocus(r);
    } else if (r) setFocus(r);
  };
  const onDbl = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const r = hit(e.clientX - rect.left, e.clientY - rect.top);
    if (r && world) world.highFive(r);
  };
  const onKey = (e: KeyboardEvent) => {
    if (npc.key(e)) { e.preventDefault(); return; }
    if (e.key !== 'Escape') return;
    if (drawer) closeDrawer();
    else if (evoExpanded) evoExpanded = null;
    else if (focusRole) setFocus(null);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDbl);
  window.addEventListener('keydown', onKey);

  // ---------- DOM:气泡 / 提示 / 房间卡 ----------
  const bubbleEls = new Map<number, HTMLDivElement>();
  const tip = document.createElement('div');
  tip.className = 'flb-tip';
  tip.style.display = 'none';
  overlay.appendChild(tip);
  const evoTip = document.createElement('div');
  evoTip.className = 'flb-evotip';
  evoTip.style.display = 'none';
  overlay.appendChild(evoTip);
  const drawerEl = document.createElement('div');
  drawerEl.className = 'flb-drawer';
  drawerEl.style.display = 'none';
  overlay.appendChild(drawerEl);
  let drawerAnchor = { x: 0, y: 0 };

  const EVO_TXT: Record<string, string> = { good: '好', ok: '一般', bad: '差', none: '无数据' };
  const evoColor = (d: EvoDay) => theme.evo[d.status];

  function closeDrawer(): void {
    drawer = null;
    drawerEl.style.display = 'none';
  }
  function openDrawer(role: Role, index: number): void {
    const row = evoRows.get(role);
    const d = row?.days[index];
    if (!row || !d) return;
    drawer = { role, index };
    const info = ROLES[role];
    drawerEl.style.setProperty('--c', info.color);
    const head = `<button class="x" data-act="x" title="关闭">×</button>
      <div class="hd"><span class="sq" style="background:${evoColor(d)}"></span>${info.callsign} · ${d.date}${index === row.days.length - 1 ? ' · 今天' : ''}</div>
      <div class="hl">${EVO_TXT[d.status]}${d.score != null ? ` · 分 ${d.score}` : ''}${d.headline ? ` —— ${escapeHtml(d.headline)}` : ''}${d.events ? `<br><span style="color:#ffe36b">★ 当天 ${d.events} 次进化事件</span>` : ''}</div>`;
    const fill = (det: EvoDayDetail | null) => {
      const ms = (det?.metrics ?? []).slice(0, 3);
      drawerEl.innerHTML = head + (ms.length ? `<div class="nums">${ms.map((m) => `<div class="num"><div class="v">${escapeHtml(m.value)}</div><div class="k">${escapeHtml(m.label)}</div></div>`).join('')}</div>` : '')
        + (det?.records?.length ? `<ul>${det.records.slice(0, 2).map((r) => `<li><b>${escapeHtml(r.title)}</b><span>${escapeHtml(r.detail)}</span></li>`).join('')}</ul>` : '')
        + `<button class="go" data-act="go">去进化页看全部 →</button>`;
      drawerEl.querySelector<HTMLButtonElement>('[data-act=x]')!.onclick = () => closeDrawer();
      drawerEl.querySelector<HTMLButtonElement>('[data-act=go]')!.onclick = () => {
        if (opts.onOpenEvolution) opts.onOpenEvolution(role, d.date);
        else location.hash = `evolution?role=${role}&date=${d.date}`;
      };
    };
    const got = opts.getEvoDetail?.(role, d.date) ?? null;
    if (got && typeof (got as Promise<unknown>).then === 'function') { fill(null); (got as Promise<EvoDayDetail | null>).then((x) => { if (drawer && drawer.role === role && drawer.index === index) fill(x); }); }
    else fill(got as EvoDayDetail | null);
    drawerEl.style.display = 'block';
    evoTip.style.display = 'none';
  }
  function cellAnchor(role: Role, index: number): { x: number; y: number } | null {
    if (!world) return null;
    const row = evoRows.get(role);
    if (!row) return null;
    // 复用命中测试的几何:扫描房间灯板 / 展开面板,找这一格的中心
    const L = world.L;
    const r = L.rooms[role];
    const n = row.days.length;
    if (evoExpanded === role) {
      const k = index - (n - Math.min(n, 30)) + (30 - Math.min(n, 30));
      const bx = r.x + r.w - 4 - (15 * 6 - 1 + 6);
      const px = bx + 3 + (k % 15) * 6 + 2.5, py = r.y + 1 + 7 + 1 + 9 + Math.floor(k / 15) * 6 + 5;
      return toCss(px, py);
    }
    const i = index - (n - Math.min(n, 14)) + (14 - Math.min(n, 14));
    const bw = 2 + 11 + 3 + 14 * 4 - 1 + 2;
    const cx = r.x + r.w - 4 - bw + 2 + 11 + 3 + i * 4 + 1.5;
    return toCss(cx, r.y + 1 + 2 + 3);
  }

  const npc = createNpc(overlay, {
    outline: () => theme.outline,
    reduced,
    onChat: (r) => opts.onAgentAction?.(r, 'chat'),
    onTask: (r, t) => opts.onAgentAction?.(r, 'task', t),
    onWorkbench: (r) => {
      if (opts.onAgentAction) opts.onAgentAction(r, 'workbench');
      else if (opts.onOpenWorkbench) opts.onOpenWorkbench(r, ROLES[r].page);
      else location.hash = ROLES[r].page;
    },
    onLeave: () => setFocus(null),
    ...(opts.getTasks ? { tasks: opts.getTasks } : {}),
  });
  function renderCard(): void {
    if (!focusRole) npc.close();
    else npc.open(focusRole, agentsByRole.get(focusRole));
  }

  function placeCard(): void {
    /* 房间卡已换成底部 NPC 对话框(npc.ts),无需跟随定位 */
  }


  function updateOverlay(): void {
    if (!world) return;
    const W = world;
    const live = new Set<number>();
    for (const b of W.bubbles) {
      const a = W.actors.get(b.role);
      if (!a) continue;
      live.add(b.id);
      let el = bubbleEls.get(b.id);
      if (!el) {
        el = document.createElement('div');
        el.className = `flb-bubble${b.kind === 'alert' ? ' alert' : b.kind === 'evo' ? ' evo' : ''}`;
        el.style.setProperty('--c', ROLES[b.role].color);
        el.innerHTML = `<b>${ROLES[b.role].callsign}</b>${escapeHtml(b.text)}`;
        overlay.appendChild(el);
        bubbleEls.set(b.id, el);
      }
      const p = W.actorPos(a);
      const s = toCss(p.x, p.y - 24);
      el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
      el.style.opacity = b.until - W.t < 0.3 ? '0' : '1';
    }
    for (const [id, el] of bubbleEls) if (!live.has(id)) { el.remove(); bubbleEls.delete(id); }

    if (hover && hover !== focusRole) {
      const a = W.actors.get(hover)!;
      const p = W.actorPos(a);
      const s = toCss(p.x, p.y - 25);
      const info = ROLES[hover];
      tip.style.setProperty('--c', info.color);
      tip.style.whiteSpace = 'nowrap';
      tip.innerHTML = `<b>${info.callsign}</b>${STATUS_LABEL[a.status] ?? ''} · ${escapeHtml(a.line)}${focusRole !== hover ? ' <span style="color:#888">· 点我说话,双击击掌</span>' : ''}`;
      tip.style.display = 'block';
      tip.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, calc(-100% - 30px))`;
      // 有气泡时让开
      if (W.bubbles.some((b) => b.role === hover)) tip.style.display = 'none';
    } else if (thing === 'sky' && world && world.cursor) {
      const s = toCss(world.cursor.x, world.cursor.y);
      tip.style.setProperty('--c', '#9fb8ff');
      tip.style.whiteSpace = 'nowrap';
      tip.innerHTML = weather.reasons.map((x) => escapeHtml(x)).join('<br>');
      tip.style.display = 'block';
      tip.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, calc(-100% - 14px))`;
    } else if ((thing === 'mailbox' || thing === 'statue' || thing === 'pet') && world && world.cursor) {
      const s = toCss(world.cursor.x, world.cursor.y);
      tip.style.setProperty('--c', '#ffd23a');
      tip.style.whiteSpace = 'nowrap';
      tip.innerHTML = thing === 'mailbox'
        ? (approvals() > 0 ? `<b>信箱</b>${approvals()} 封待批订单,点开审批` : '<b>信箱</b>没有待批的')
        : thing === 'statue' ? '<b>招财柴犬</b>摸摸头?' : '<b>小家伙</b>睡得正香';
      tip.style.display = 'block';
      tip.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, calc(-100% - 14px))`;
    } else tip.style.display = 'none';
    if (hover && world && waved !== hover && performance.now() - hoverSince > 1200) { world.wave(hover); waved = hover; }
    placeCard();

    // 进化格 tooltip
    if (evoHover && evoHover.kind === 'cell' && !drawer) {
      const row = evoRows.get(evoHover.role);
      const d = row?.days[evoHover.index];
      if (d) {
        const info = ROLES[evoHover.role];
        const s = toCss(evoHover.x, evoHover.y);
        evoTip.style.setProperty('--c', evoColor(d));
        evoTip.innerHTML = `<div class="d"><span class="sq" style="background:${evoColor(d)}"></span>${info.callsign} · ${d.date}</div>
          <div class="h">${EVO_TXT[d.status]}${d.score != null ? ` · ${d.score}` : ''}${d.headline ? ` · ${escapeHtml(d.headline)}` : ''}</div>
          ${d.events ? `<div class="e">★ ${d.events} 次进化事件</div>` : ''}<div class="hint">点开看当天表现</div>`;
        evoTip.style.display = 'block';
        const tw = evoTip.offsetWidth;
        const x = Math.max(8, Math.min(overlay.clientWidth - tw - 8, s.x - tw / 2));
        evoTip.style.transform = `translate(${Math.round(x)}px, ${Math.round(s.y + 14)}px)`;
      }
    } else if (evoHover && evoHover.kind === 'title' && !drawer) {
      const s = toCss(evoHover.x, evoHover.y);
      evoTip.style.setProperty('--c', '#ffe36b');
      evoTip.innerHTML = `<div class="d">EVO · ${ROLES[evoHover.role].callsign}</div><div class="h">最近 14 天进化方格</div><div class="hint">${evoExpanded === evoHover.role ? '点击收起' : '点击展开 30 天完整方格'}</div>`;
      evoTip.style.display = 'block';
      evoTip.style.transform = `translate(${Math.round(Math.max(8, s.x - 60))}px, ${Math.round(s.y + 14)}px)`;
    } else evoTip.style.display = 'none';

    if (drawer) {
      const a = cellAnchor(drawer.role, drawer.index);
      if (a) drawerAnchor = a;
      const dw = drawerEl.offsetWidth, dh = drawerEl.offsetHeight;
      let x = drawerAnchor.x - dw / 2, y = drawerAnchor.y + 14;
      x = Math.max(8, Math.min(overlay.clientWidth - dw - 8, x));
      if (y + dh > overlay.clientHeight - 8) y = Math.max(8, drawerAnchor.y - dh - 14);
      drawerEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }

  // ---------- 主循环 ----------
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    let dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    if (!world) return;
    if (reduced) { acc += dt; if (acc < 1 / 15) return; dt = acc; acc = 0; }
    if (paused) dt = 0;
    weather = computeWeather(snapshot?.market, snapshot?.money.pnl_today, wOverride);
    if (dt > 0) world.update(dt);
    if (!reduced && dt > 0 && weather.fireworks && world.t > nextFirework) {
      nextFirework = world.t + 5 + Math.random() * 6;
      const L = world.L;
      const fx = Math.random() < 0.5 ? 20 + Math.random() * Math.max(10, L.mainX - 60) : L.wingX + L.wingW + 20 + Math.random() * Math.max(10, L.LW - L.wingX - L.wingW - 40);
      world.burst(fx, 20 + Math.random() * 40, ['#ffd23a', '#ff4fd8', '#39f0ff', '#7dffb0', '#ffffff'], 30, true);
    }
    const k = reduced ? 1 : 1 - Math.exp(-dt * 7);
    cam.z += (cam.tz - cam.z) * k;
    cam.cx += (cam.tcx - cam.cx) * k;
    cam.cy += (cam.tcy - cam.cy) * k;
    if (Math.abs(cam.z - cam.tz) < 0.004) cam.z = cam.tz;
    if (Math.abs(cam.cx - cam.tcx) < 0.05) cam.cx = cam.tcx;
    if (Math.abs(cam.cy - cam.tcy) < 0.05) cam.cy = cam.tcy;
    focusAmt += ((focusRole ? 1 : 0) - focusAmt) * (reduced ? 1 : Math.min(1, dt * 6));
    render(bctx, world, theme, {
      focus: focusRole ?? (focusAmt > 0.02 ? lastFocus : null), hover, focusAmt,
      evo: evoRows, evoExpanded,
      evoHover: evoHover && evoHover.kind === 'cell' ? { role: evoHover.role, index: evoHover.index } : drawer,
      weather, approvals: approvals(), statueHits,
    });
    if (focusRole) lastFocus = focusRole;
    computeView();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = theme.sky[0]!;
    ctx.fillRect(0, 0, Wdev, Hdev);
    const sw = Wdev / view.scale, sh = Hdev / view.scale;
    ctx.drawImage(buf, view.sx, view.sy, sw, sh, 0, 0, sw * view.scale, sh * view.scale);
    updateOverlay();
  }
  let lastFocus: Role | null = null;
  let paused = false;
  let nextFirework = 3;
  const wOverride: { sky: 'night' | 'day' | null; rain: 'rain' | 'clear' | null } = { sky: null, rain: null };
  let weather: Weather = computeWeather(undefined, undefined, wOverride);
  const approvals = () => (snapshot?.inbox.items ?? []).filter((i) => i.kind === 'approval').length;

  const ro = new ResizeObserver(() => resize());
  ro.observe(host);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    setData(s: Snapshot) {
      snapshot = s;
      agentsByRole.clear();
      s.agents.forEach((a) => agentsByRole.set(a.role, a));
      (s.evolution ?? []).forEach((r) => evoRows.set(r.role, r));
      world?.apply(s.agents, s.handoffs, s.meetings, s.evolution);
      if (focusRole) npc.update(agentsByRole.get(focusRole));
    },
    setTheme(id: ThemeId) {
      theme = THEMES[id] ?? theme;
    },
    focus(role: Role | null) {
      setFocus(role, false);
    },
    pick(clientX: number, clientY: number): Role | null {
      const rect = canvas.getBoundingClientRect();
      if (clientX < rect.left || clientY < rect.top || clientX > rect.right || clientY > rect.bottom) return null;
      return hit(clientX - rect.left, clientY - rect.top);
    },
    setDropTarget(role: Role | null) {
      if (world) world.dropTarget = role;
    },
    catchDrop(role: Role, line: string) {
      world?.catchDrop(role, line);
    },
    approval(ok: boolean) {
      world?.approval(ok);
    },
    emergency() {
      world?.emergency();
    },
    togglePause() {
      paused = !paused;
      return paused;
    },
    setWeatherOverride(w: WeatherOverride) {
      if (w === null) { wOverride.sky = null; wOverride.rain = null; }
      else if (w === 'night' || w === 'day') wOverride.sky = w;
      else wOverride.rain = w;
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDbl);
      window.removeEventListener('keydown', onKey);
      overlay.innerHTML = '';
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---------- 像素手套光标(运行时程序化生成,不用外部图片) ----------
function makeCursor(rows: string[], hotX: number, hotY: number, fallback: string): string {
  try {
    const k = 2;
    const cv = document.createElement('canvas');
    cv.width = rows[0]!.length * k;
    cv.height = rows.length * k;
    const c = cv.getContext('2d')!;
    const pal: Record<string, string> = { o: '#1a1420', w: '#f6f1e6', s: '#c9c0b0', r: '#e0485a' };
    rows.forEach((r, y) => [...r].forEach((ch, x) => { const col = pal[ch]; if (col) { c.fillStyle = col; c.fillRect(x * k, y * k, k, k); } }));
    return `url(${cv.toDataURL()}) ${hotX * k} ${hotY * k}, ${fallback}`;
  } catch {
    return fallback;
  }
}
const GLOVE = ['..oo........', '.owwo.......', '.owwo.......', '.owwoooo....', '.owwowwoo...', 'oowwwwwwoo..', 'owowwwwwwo..', 'owwwwwwwso..', '.owwwwwwso..', '..owwwwso...', '...orrrro...', '...oooooo...'];
const POINT = ['..oo........', '.owwo.......', '.owwo.......', '.owwoooooo..', '.owwowwowwo.', 'oowwwwwwwwo.', 'owowwwwwwwo.', 'owwwwwwwwso.', '.owwwwwwwso.', '..owwwwwso..', '...orrrrro..', '...ooooooo..'];
const CURSOR_GLOVE = makeCursor(GLOVE, 2, 1, 'default');
const CURSOR_POINT = makeCursor(POINT, 2, 1, 'pointer');
