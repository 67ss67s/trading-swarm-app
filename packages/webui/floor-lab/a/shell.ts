/**
 * DOM 外壳:顶栏(品牌 + 3 个关键数 + 可拖行情 + 主题 + 声音预留 + 紧急停止)与右栏三块
 * (需要你处理 / 钱 / 团队动态,团队动态头上挂 9×14 团队状态热力 + 名册)。纯 DOM,无框架。
 */
import type { FloorSnapshot, ThemeId } from './types';
import { THEMES, THEME_ORDER } from './themes';
import { ROLE_ORDER, roleMeta } from './roles';
import { charSprite } from './sprites';
import { makeCanvas, rect, px, mix } from './pixel';

export interface Shell {
  canvas: HTMLCanvasElement;
  stage: HTMLElement;
  stageInner: HTMLElement;
  ticker: HTMLElement;
  strat: HTMLElement;
  estop: HTMLElement;
  heat: HTMLCanvasElement;
  renderTop(s: FloorSnapshot): void;
  renderRail(s: FloorSnapshot): void;
  applyTheme(id: ThemeId): void;
}

export interface ShellHandlers {
  onTheme(id: ThemeId): void;
  onApprove(id: string): void;
  onReject(id: string): void;
  onOpenInbox(id: string): void;
  onPickRole(role: string): void;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

export function spriteIcon(role: string, cell = 1): HTMLCanvasElement {
  const m = roleMeta(role);
  const src = charSprite(m.shape, m.color, { cell });
  const [c, g] = makeCanvas(src.width, src.height);
  g.drawImage(src, 0, 0);
  return c;
}

export function buildShell(app: HTMLElement, hd: ShellHandlers): Shell {
  // ---------- 顶栏 ----------
  const top = h('header', 'top');
  const brand = h('div', 'brand');
  const logo = spriteIcon('gate_captain');
  brand.append(logo, h('div', '', '<b>Trading Swarm</b><small>楼层 · 布局 A 开放办公室</small>'));
  const kpis = h('div', 'kpis');
  const ticker = h('div', 'ticker');
  ticker.title = '拖到 RADAR / THREAD / LAB 的工位上派活';
  const themes = h('div', 'themes');
  themes.setAttribute('role', 'group');
  themes.setAttribute('aria-label', '主题');
  for (const id of THEME_ORDER) {
    const b = h('button', '', THEMES[id].name);
    b.dataset.id = id;
    b.title = THEMES[id].desc + '(T 切换)';
    b.onclick = () => hd.onTheme(id);
    themes.append(b);
  }
  const sound = h('button', 'iconbtn', '声音 · 预留');
  sound.disabled = true;
  sound.title = '声音开关(预留)';
  const estop = h('div', 'estop');
  estop.innerHTML = '<div class="btn" role="button" aria-label="紧急停止:按住 2 秒"></div><div class="ring"></div><div class="cover" title="先掀开保护罩">STOP</div>';
  const estopLabel = h('div', 'estop-label', '紧急停止<br>掀罩 · 按住 2 秒');
  top.append(brand, kpis, ticker, h('div', 'spacer'), themes, sound, estopLabel, estop);

  // ---------- 主体 ----------
  const main = h('main');
  const stage = h('section', 'stage');
  const stageInner = h('div', 'stage-inner');
  const canvas = h('canvas');
  canvas.setAttribute('aria-label', '团队楼层像素场景;所有信息在右栏有文字版');
  stageInner.append(canvas);
  const caption = h('div', 'caption');
  stage.append(stageInner, caption);
  const rail = h('aside', 'rail');
  const inbox = h('section', 'blk px-box inbox');
  const money = h('section', 'blk px-box money');
  const team = h('section', 'blk px-box team');
  rail.append(inbox, money, team);
  main.append(stage, rail);
  app.append(top, main);

  // 钱 + 当前策略卡(可拖给 EXEC)
  money.innerHTML = '<h3>钱</h3><div class="row"><div><span>权益 U</span><b data-k="eq">—</b></div><div><span>今日盈亏</span><b data-k="pnl">—</b></div><div><span>持仓</span><b data-k="pos">—</b></div></div>';
  const strat = h('div', 'strat');
  strat.title = '拖到 EXEC 工位 = 运行这条策略';
  money.append(strat);

  // 团队动态:热力 + 名册 + 动态流
  team.innerHTML = '<h3>团队动态<span class="n" data-k="online"></span></h3>';
  const heatWrap = h('div', 'heat');
  const heat = h('canvas');
  heat.title = '团队状态:每行一个 agent,最近 14 天;点一行 = 推镜头过去';
  heatWrap.append(heat, h('div', 'lg', '团队状态 · 14 天<br><span data-k="lg"></span><br>点一行进它的房间'));
  const roster = h('div', 'roster');
  for (const r of ROLE_ORDER) {
    const m = roleMeta(r);
    const b = h('button');
    b.style.color = m.color;
    b.title = `${m.callsign} · ${m.desk}(按 ${ROLE_ORDER.indexOf(r) + 1})`;
    const i = h('i');
    i.dataset.role = r;
    b.append(spriteIcon(r), document.createTextNode(m.callsign), i);
    b.onclick = () => hd.onPickRole(r);
    roster.append(b);
  }
  const feed = h('ul', 'feed');
  feed.setAttribute('aria-live', 'polite');
  team.append(heatWrap, roster, feed);

  // 热力点击
  const HC = 5;
  const HG = 1;
  heat.width = 14 * (HC + HG) + 1;
  heat.height = 9 * (HC + HG) + 1;
  heat.style.width = `${heat.width * 2}px`;
  heat.style.height = `${heat.height * 2}px`;
  heat.onclick = (e) => {
    const r = heat.getBoundingClientRect();
    const row = Math.floor(((e.clientY - r.top) / r.height) * 9);
    const role = ROLE_ORDER[Math.max(0, Math.min(8, row))];
    if (role) hd.onPickRole(role);
  };
  let heatHover = -1;
  heat.onmousemove = (e) => {
    const r = heat.getBoundingClientRect();
    heatHover = Math.floor(((e.clientY - r.top) / r.height) * 9);
    const role = ROLE_ORDER[heatHover];
    heat.title = role ? `${roleMeta(role).callsign}:点一下推镜头过去` : '';
    if (lastSnap) drawHeat(lastSnap);
  };
  heat.onmouseleave = () => {
    heatHover = -1;
    if (lastSnap) drawHeat(lastSnap);
  };

  let theme: ThemeId = 'lab';
  let lastSnap: FloorSnapshot | null = null;

  function drawHeat(s: FloorSnapshot): void {
    const g = heat.getContext('2d')!;
    const ev = THEMES[theme].evo;
    g.clearRect(0, 0, heat.width, heat.height);
    ROLE_ORDER.forEach((role, ri) => {
      const days = (s.evolution?.find((r) => r.role === role)?.days ?? []).slice(-14);
      if (ri === heatHover) rect(g, 0, ri * (HC + HG), heat.width, HC + 1, 'rgba(255,255,255,0.18)');
      days.forEach((d, i) => {
        const x = 1 + i * (HC + HG);
        const y = 1 + ri * (HC + HG);
        rect(g, x, y, HC, HC, ev[d.status]);
        if (d.status === 'good') px(g, x, y, mix(ev.good, '#ffffff', 0.7));
        if (d.status === 'bad') {
          const dk = mix(ev.bad, '#000000', 0.6);
          px(g, x + 1, y + 1, dk);
          px(g, x + 3, y + 1, dk);
          px(g, x + 2, y + 2, dk);
          px(g, x + 1, y + 3, dk);
          px(g, x + 3, y + 3, dk);
        }
      });
    });
    const lg = team.querySelector<HTMLElement>('[data-k=lg]')!;
    lg.innerHTML = (['good', 'ok', 'bad', 'none'] as const).map((k) => `<i style="display:inline-block;width:8px;height:8px;background:${ev[k]};margin:0 3px 0 0"></i>${{ good: '好', ok: '一般', bad: '差', none: '无' }[k]}`).join(' ');
  }

  const feedSeen = new Set<string>();

  return {
    canvas,
    stage,
    stageInner,
    ticker,
    strat,
    estop,
    heat,
    applyTheme(id) {
      theme = id;
      const ui = THEMES[id].ui;
      for (const [k, v] of Object.entries(ui)) document.documentElement.style.setProperty(k, v);
      themes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
      caption.innerHTML = `<span>${THEMES[id].name} · ${THEMES[id].desc}</span><span><i style="background:var(--up)"></i>在干活 <i style="background:var(--warn)"></i>等着 <i style="background:var(--down)"></i>卡住 <i style="background:var(--faint)"></i>空闲</span><span>点 agent 对话 · 双击击掌 · 点桌牌看 30 天 · 拖顶栏币种派活</span><span><kbd>1</kbd>–<kbd>9</kbd> 进房间 <kbd>T</kbd> 主题 <kbd>L</kbd> 布局 B <kbd>空格</kbd> 暂停 <kbd>~</kbd> 命令行</span>`;
      if (lastSnap) drawHeat(lastSnap);
    },
    renderTop(s) {
      const pnl = Number(s.money.pnl_today);
      const working = s.agents.filter((a) => a.status === 'working').length;
      kpis.innerHTML = `<div class="kpi"><span>权益 U</span><b>${esc(Number(s.money.equity).toLocaleString('en-US', { maximumFractionDigits: 2 }))}</b></div><div class="kpi"><span>今日盈亏</span><b class="${pnl >= 0 ? 'up' : 'down'}">${esc(s.money.pnl_today)}</b></div><div class="kpi"><span>在干活</span><b>${working}<small style="color:var(--dim);font-size:11px"> / ${s.agents.length}</small></b></div>`;
      const tk = s.market?.ticker ?? [];
      if (ticker.children.length !== tk.length) {
        ticker.innerHTML = '';
        for (const c of tk) {
          const el = h('div', 'coin');
          el.dataset.symbol = c.symbol;
          ticker.append(el);
        }
      }
      tk.forEach((c, i) => {
        const el = ticker.children[i] as HTMLElement;
        el.innerHTML = `<b>${esc(c.symbol)}</b><span>${esc(c.price)}</span><span class="${c.chg_pct >= 0 ? 'up' : 'down'}">${c.chg_pct >= 0 ? '+' : ''}${c.chg_pct.toFixed(2)}%</span>`;
      });
    },
    renderRail(s) {
      lastSnap = s;
      // 需要你处理(0 时隐藏)
      inbox.hidden = s.inbox.count === 0;
      inbox.innerHTML = `<h3>需要你处理<span class="n">${s.inbox.count}</span></h3>`;
      for (const it of s.inbox.items) {
        const row = h('div', 'item');
        row.innerHTML = `<div><b>${esc(it.title)}</b><small>${esc(it.detail)}</small></div>`;
        const ok = h('button', 'pbtn ok', '批准');
        const no = h('button', 'pbtn no', '驳回');
        ok.onclick = () => hd.onApprove(it.id);
        no.onclick = () => hd.onReject(it.id);
        row.querySelector('div')!.onclick = () => hd.onOpenInbox(it.id);
        row.append(ok, no);
        inbox.append(row);
      }
      // 钱
      const pnl = Number(s.money.pnl_today);
      money.querySelector('[data-k=eq]')!.textContent = Number(s.money.equity).toLocaleString('en-US', { maximumFractionDigits: 2 });
      const pe = money.querySelector<HTMLElement>('[data-k=pnl]')!;
      pe.textContent = s.money.pnl_today;
      pe.className = pnl >= 0 ? 'up' : 'down';
      money.querySelector('[data-k=pos]')!.textContent = String(s.money.positions);
      strat.innerHTML = s.strategy ? `<span>当前策略</span><b>${esc(s.strategy.name)} ${esc(s.strategy.version)}</b><small>拖给 EXEC</small>` : '<span>自由判断</span>';
      strat.dataset.id = s.strategy?.id ?? '';
      // 名册状态灯
      for (const a of s.agents) {
        const i = team.querySelector<HTMLElement>(`i[data-role="${a.role}"]`);
        if (i) i.style.background = a.status === 'working' ? 'var(--up)' : a.status === 'waiting' ? 'var(--warn)' : a.status === 'stuck' ? 'var(--down)' : 'var(--faint)';
      }
      team.querySelector('[data-k=online]')!.textContent = `${s.agents.filter((a) => a.status !== 'idle').length}/${s.agents.length} 在岗`;
      drawHeat(s);
      // 动态流:交接 + 会议 + 事件,同一个快照
      type F = { id: string; at: number; role: string; html: string; cls?: string };
      const items: F[] = [];
      const cs = (r: string) => `<span class="cs" style="color:${roleMeta(r).color}">${esc(roleMeta(r).callsign)}</span>`;
      for (const x of s.handoffs) {
        if (x.from === 'gate_captain' && x.text.startsWith('你')) continue;
        items.push({ id: x.id ?? `${x.at}${x.from}`, at: x.at, role: x.from, html: `${cs(x.from)} ${esc(x.text)} → 交给 ${cs(x.to)}` });
      }
      for (const m of s.meetings ?? []) if (m.at <= Date.now()) items.push({ id: m.id, at: m.at, role: m.roles[0]!, html: `${m.roles.map(cs).join('、')} 在会议桌碰头:${esc(m.topic)}` });
      for (const e of s.events ?? []) items.push({ id: e.id, at: e.at, role: e.role, html: esc(e.text).replace(esc(roleMeta(e.role).callsign), cs(e.role)), cls: e.kind === 'evolution' ? 'evo' : '' });
      items.sort((a, b) => b.at - a.at);
      feed.innerHTML = '';
      for (const it of items.slice(0, 40)) {
        const li = h('li', it.cls ?? '');
        if (feedSeen.has(it.id)) li.style.animation = 'none';
        feedSeen.add(it.id);
        li.innerHTML = `<i class="dot" style="background:${roleMeta(it.role).color}"></i><span class="tx">${it.html}</span><span class="tm">${ago(it.at)}</span>`;
        li.onclick = () => hd.onPickRole(it.role);
        feed.append(li);
      }
    },
  };
}
