/**
 * 原型页装配:DOM 外壳(顶栏 / 右栏)+ mock 事件源 + 引擎。只做装配,不放业务逻辑。
 * 接真数据时:把 createMock() 换成真 query → Snapshot 的映射即可,engine / 右栏渲染不动。
 */
import { mount } from './engine';
import { createMock } from './mock';
import { ROLES, ROLE_ORDER, TASKS } from './roles';
import { THEMES, THEME_ORDER, isThemeId } from './themes';
import { handoffKey, EVO_KIND_LABEL, type Role, type Snapshot, type TaskDef, type ThemeId } from './types';
import { installInteractions } from './interact';

const THEME_KEY = 'tg.floorlab.b.theme';
function loadTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isThemeId(v)) return v;
  } catch { /* 私密模式 */ }
  return 'study';
}
function saveTheme(id: ThemeId): void {
  try { localStorage.setItem(THEME_KEY, id); } catch { /* ignore */ }
}

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="top">
    <div class="brand"><canvas class="logo" id="logo" width="13" height="13"></canvas><div><b>Trading Swarm</b><small>值班楼层 · 大楼剖面</small></div></div>
    <div class="kpis">
      <div class="kpi"><span class="k">权益 USDT</span><span class="v" id="k-eq">—</span></div>
      <div class="kpi"><span class="k">今日盈亏</span><span class="v" id="k-pnl">—</span></div>
      <div class="kpi"><span class="k">在岗</span><span class="v" id="k-on">—</span></div>
    </div>
    <div class="coins" id="coins" title="把币拖给 RADAR / THREAD / LAB"></div>
    <div class="spacer"></div>
    <div class="heat" id="heat" title="团队状态:每行一个角色、每格一天(最近 14 天),点行跳到该角色">
      <div class="lab">团队状态<br><span class="mono">14 天</span></div>
      <canvas id="heat-cv"></canvas>
    </div>
    <div class="seg" id="themes"></div>
    <div class="estop" id="estop"></div>
  </header>
  <main class="stage">
    <div class="scene" id="scene"><canvas id="cv"></canvas><div class="keys" id="keys">1–9 切人 · T 主题 · 空格 暂停 · <b>~</b> 命令行 · 双击击掌</div></div>
    <aside class="rail">
      <section class="blk inbox" id="inbox"></section>
      <section class="blk"><h3>钱</h3><div class="money" id="money"></div><div class="strat" id="strat" title="拖到 EXEC 工位运行"></div></section>
      <section class="blk feedblk"><h3>团队动态 <span class="n mono" id="feed-n"></span></h3><ul class="feed" id="feed"></ul></section>
    </aside>
  </main>`;

// 像素 logo
(() => {
  const c = (document.getElementById('logo') as HTMLCanvasElement).getContext('2d')!;
  const rows = ['.....##......', '....####.....', '...######....', '..##.##.##...', '..########...', '...######....', '..#.#..#.#...', '.............', '.##.......##.', '##.#.....#.##', '.##.......##.', '.............', '.............'];
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '#') { c.fillStyle = y < 7 ? '#ffb454' : '#9be15d'; c.fillRect(x, y, 1, 1); } }));
})();

let theme = loadTheme();
const mock = createMock();
let snap: Snapshot = mock.snapshot();

// ---------- 主题 ----------
const themesEl = document.getElementById('themes')!;
function applyThemeVars(): void {
  const ui = THEMES[theme].ui;
  for (const [k, v] of Object.entries(ui)) document.documentElement.style.setProperty(k, v);
  themesEl.innerHTML = THEME_ORDER.map((id) => `<button data-t="${id}" class="${id === theme ? 'on' : ''}">${THEMES[id].name}</button>`).join('');
  drawHeat();
}
themesEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  const id = b?.dataset['t'];
  if (!isThemeId(id)) return;
  setTheme(id);
});
function setTheme(id: ThemeId): void {
  theme = id;
  saveTheme(id);
  applyThemeVars();
  floor.setTheme(id);
}

// ---------- 引擎 ----------
const delivered = new Set<string>();
const floor = mount(document.getElementById('cv') as HTMLCanvasElement, {
  theme,
  onSelectAgent: () => {},
  onAgentAction: (role, action, task) => ui.agentAction(role, action, task),
  onMailbox: () => ui.openApproval(),
  onToast: (t) => ui.toast(t),
  onHandoffDelivered: (k) => { delivered.add(k); renderFeed(); },
  getEvoDetail: (role, date) => mock.evoDetail(role, date),
  onOpenEvolution: (role, date) => { location.hash = `evolution?role=${role}&date=${date}`; },
});
(window as unknown as { __floorB: unknown; __mockB: unknown }).__floorB = floor;
(window as unknown as { __mockB: unknown }).__mockB = mock; // 调试 / 截图脚本用
const ui = installInteractions({
  floor,
  mock,
  snap: () => snap,
  setTheme: (id) => setTheme(id),
  theme: () => theme,
});
document.getElementById('inbox')!.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.item')) ui.openApproval(); });

// ---------- 右栏 ----------
const fmt = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : s;
};
function renderMoney(): void {
  const m = snap.money;
  const pnl = Number(m.pnl_today);
  document.getElementById('money')!.innerHTML = `
    <div class="cell"><div class="v">${fmt(m.equity)}</div><div class="k">权益</div></div>
    <div class="cell"><div class="v ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}${fmt(m.pnl_today)}</div><div class="k">今日盈亏</div></div>
    <div class="cell"><div class="v">${m.positions}</div><div class="k">持仓</div></div>`;
  document.getElementById('k-eq')!.textContent = fmt(m.equity);
  const kp = document.getElementById('k-pnl')!;
  kp.textContent = `${pnl >= 0 ? '+' : ''}${fmt(m.pnl_today)}`;
  kp.className = `v ${pnl >= 0 ? 'up' : 'down'}`;
  const on = snap.agents.filter((a) => a.status !== 'idle').length;
  document.getElementById('k-on')!.textContent = `${on}/${snap.agents.length}`;
}
function renderInbox(): void {
  const el = document.getElementById('inbox')!;
  if (snap.inbox.count === 0) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `<h3><span class="dot"></span>需要你处理 <span class="n">${snap.inbox.count}</span></h3>` +
    snap.inbox.items.slice(0, 3).map((it) => `<div class="item" data-id="${it.id}">${it.kind === 'approval' ? '🟡 ' : ''}${esc(it.title)}${it.detail ? `<small>${esc(it.detail)}</small>` : ''}</div>`).join('');
}

// 团队动态:交接 + 进化事件(都来自同一份 snapshot)
interface FeedItem { key: string; at: number; html: string; tag?: string; tagCls?: string }
const evoFeed: FeedItem[] = [];
const shownFeed = new Set<string>();
const evoSeen = new Map<Role, string>();
function diffEvolution(): void {
  for (const row of snap.evolution ?? []) {
    const d = row.days[row.days.length - 1];
    if (!d) continue;
    const sig = `${d.date}|${d.events ?? 0}`;
    const prev = evoSeen.get(row.role);
    evoSeen.set(row.role, sig);
    if (prev === undefined || prev === sig) continue;
    const [pd, pe] = prev.split('|');
    if (pd !== d.date || (d.events ?? 0) <= Number(pe)) continue;
    const kind = d.last_event?.kind ?? 'distill';
    const info = ROLES[row.role];
    evoFeed.push({
      key: `evo|${row.role}|${d.events}`,
      at: Date.now(),
      html: `<span class="cs" style="color:${info.color}">${info.callsign}</span> ${EVO_KIND_LABEL[kind].verb} 1 条教训${d.last_event ? `:${esc(d.last_event.text)}` : ''}`,
      tag: '★ 进化', tagCls: 'evo',
    });
  }
}
function renderFeed(): void {
  const items: FeedItem[] = snap.handoffs.map((h) => {
    const f = ROLES[h.from], t = ROLES[h.to];
    const k = handoffKey(h);
    const done = delivered.has(k) || Date.now() - h.at > 20_000;
    return {
      key: k, at: h.at,
      html: `<span class="cs" style="color:${f.color}">${f.callsign}</span> ${esc(h.text)} → 交给 <span class="cs" style="color:${t.color}">${t.callsign}</span>`,
      tag: done ? '已接住' : '在路上…', tagCls: done ? 'ok' : '',
    };
  });
  for (const m of snap.meetings ?? []) {
    items.push({ key: m.id, at: m.at, html: `<span class="cs" style="color:${ROLES.gate_captain.color}">HELM</span> 召集 ${m.roles.filter((r) => r !== 'gate_captain').map((r) => `<span class="cs" style="color:${ROLES[r].color}">${ROLES[r].callsign}</span>`).join(' ')} 开会:${esc(m.topic)}`, tag: '开会' });
  }
  const TAG: Record<string, [string, string]> = { task_start: ['派活', ''], task_done: ['完成', 'ok'], approval: ['审批', 'evo'], strategy_run: ['运行策略', 'ok'], evo: ['★ 进化', 'evo'], watch: ['观察', ''], system: ['系统', 'bad'] };
  for (const a of snap.activity ?? []) {
    if (a.kind === 'evo') continue; // 进化事件由方格 diff 生成(与场景动画同源)
    const who = a.role === 'user' ? '<span class="cs" style="color:var(--accent)">你</span>' : `<span class="cs" style="color:${ROLES[a.role].color}">${ROLES[a.role].callsign}</span>`;
    const txt = a.role === 'user' ? esc(a.text.replace(/^你/, '')) : esc(a.text.replace(new RegExp('^' + ROLES[a.role].callsign + ' ?'), ''));
    const [tag, cls] = TAG[a.kind] ?? ['', ''];
    items.push({ key: a.id, at: a.at, html: `${who} ${txt}`, tag, tagCls: cls });
  }
  items.push(...evoFeed);
  items.sort((a, b) => b.at - a.at);
  const el = document.getElementById('feed')!;
  const top = items.slice(0, 30);
  el.innerHTML = top.map((it) => `<li data-k="${esc(it.key)}" class="${shownFeed.has(it.key) ? '' : 'new'}">${it.html}<div class="meta"><span>${ago(it.at)}</span>${it.tag ? `<span class="tag ${it.tagCls ?? ''}">${it.tag}</span>` : ''}</div></li>`).join('');
  top.forEach((it) => shownFeed.add(it.key));
  document.getElementById('feed-n')!.textContent = `${items.length}`;
}
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s} 秒前`;
  return `${Math.round(s / 60)} 分钟前`;
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---------- 团队状态迷你热力 9×14 ----------
const heatCv = document.getElementById('heat-cv') as HTMLCanvasElement;
const HC = 4, HG = 1, HROWS = ROLE_ORDER.length, HCOLS = 14;
function drawHeat(): void {
  const scale = 1;
  heatCv.width = HCOLS * (HC + HG) + 4;
  heatCv.height = HROWS * (HC + HG) - HG;
  heatCv.style.width = `${heatCv.width * scale}px`;
  heatCv.style.height = `${heatCv.height * scale}px`;
  const c = heatCv.getContext('2d')!;
  c.clearRect(0, 0, heatCv.width, heatCv.height);
  const th = THEMES[theme];
  ROLE_ORDER.forEach((role, y) => {
    c.fillStyle = ROLES[role].color;
    c.fillRect(0, y * (HC + HG), 2, HC);
    const row = snap.evolution?.find((r) => r.role === role);
    const days = row?.days.slice(-HCOLS) ?? [];
    days.forEach((d, x) => {
      const px = 4 + x * (HC + HG), py = y * (HC + HG);
      c.fillStyle = th.evo[d.status];
      c.fillRect(px, py, HC, HC);
      if (d.status === 'bad') { c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(px + 1, py + 1, 1, 1); c.fillRect(px + 2, py + 2, 1, 1); c.fillRect(px + 2, py + 1, 1, 1); c.fillRect(px + 1, py + 2, 1, 1); }
      if (d.status === 'good') { c.fillStyle = 'rgba(255,255,255,.6)'; c.fillRect(px, py, 1, 1); }
    });
  });
  heatCv.style.width = `${heatCv.width * 1}px`;
}
heatCv.addEventListener('click', (e) => {
  const r = heatCv.getBoundingClientRect();
  const y = Math.floor(((e.clientY - r.top) / r.height) * HROWS);
  const role = ROLE_ORDER[Math.max(0, Math.min(HROWS - 1, y))];
  if (role) floor.focus(role);
});
heatCv.addEventListener('mousemove', (e) => {
  const r = heatCv.getBoundingClientRect();
  const y = Math.floor(((e.clientY - r.top) / r.height) * HROWS);
  const role = ROLE_ORDER[Math.max(0, Math.min(HROWS - 1, y))];
  if (role) heatCv.title = `${ROLES[role].callsign} · ${ROLES[role].title} —— 点击推镜头过去`;
});

// ---------- 数据流 ----------
function onSnap(s: Snapshot): void {
  snap = s;
  ui.refresh();
  diffEvolution();
  floor.setData(s);
  renderMoney();
  renderInbox();
  renderFeed();
  drawHeat();
}
diffEvolution();
applyThemeVars();
onSnap(snap);
mock.start(onSnap);
setInterval(renderFeed, 5000);

void TASKS;
export type { TaskDef };
