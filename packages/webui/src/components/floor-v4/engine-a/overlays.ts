/**
 * 浮层:toast、像素 tooltip、NPC 对话框(打字机)、房间卡、进化日卡、审批卡、运行策略卡、像素命令行、拖拽幽灵、紧急停止长按。
 * 每个都只管 DOM;真实入口写在调用处注释里(main.ts / tasks.ts)。
 */
import { t, tmap } from '@/lib/i18n';
import type { DeskInfo } from '../engine-b/types';
import type { AgentMetric, EvoDay, EvoDayDetail, InboxItem, StrategyRef } from './types';
import { roleMeta } from './roles';
import { charSprite } from './sprites';
import { makeCanvas } from './pixel';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- toast ----------
export function makeToaster(host: HTMLElement): (msg: string, sub?: string) => void {
  const box = h('div', 'toasts');
  host.append(box);
  return (msg, sub) => {
    const t = h('div', 'toast', `${esc(msg)}${sub ? `<small>${esc(sub)}</small>` : ''}`);
    box.append(t);
    while (box.children.length > 3) box.firstElementChild?.remove();
    window.setTimeout(() => t.remove(), 3800);
  };
}

// ---------- tooltip ----------
export function makeTip(): { show(html: string, x: number, y: number): void; hide(): void } {
  const el = h('div', 'fa-tip');
  el.hidden = true;
  document.body.append(el);
  return {
    show(html, x, y) {
      el.innerHTML = html;
      el.hidden = false;
      const w = el.offsetWidth;
      const hh = el.offsetHeight;
      el.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
      el.style.top = `${Math.max(8, y - hh - 12)}px`;
    },
    hide() {
      el.hidden = true;
    },
  };
}

const STATUS_ZH: Record<EvoDay['status'], string> = tmap({ good: '好', ok: '一般', bad: '差', none: '无记录' });
export function evoTipHtml(role: string, d: EvoDay, color: string): string {
  const m = roleMeta(role);
  const score = d.score != null ? ` · ${t('{n} 分', { n: d.score })}` : '';
  const head = d.headline ? `<br>${esc(d.headline)}` : '';
  const tail = t('进化事件 {n} 条 · 点一下看当天', { n: d.events ?? 0 });
  return `<b style="color:${m.color}">${esc(m.callsign)}</b> · <b>${esc(d.date)}</b><br><span class="sw" style="background:${color}"></span>${STATUS_ZH[d.status]}${score}${head}<br>${esc(tail)}`;
}

// ---------- NPC 对话框 ----------
export interface NpcOption {
  label: string;
  run: () => void;
}
export function makeNpc(host: HTMLElement): { open(role: string, line: string, options: NpcOption[]): void; say(line: string, options: NpcOption[]): void; close(): void; isOpen(): boolean } {
  let el: HTMLDivElement | null = null;
  let timer = 0;
  let role = '';
  const render = (line: string, options: NpcOption[]) => {
    if (!el) return;
    const sayEl = el.querySelector<HTMLElement>('.say')!;
    const opts = el.querySelector<HTMLElement>('.opts')!;
    window.clearInterval(timer);
    sayEl.classList.remove('done');
    opts.innerHTML = '';
    const buttons = options.map((o, i) => {
      const b = h('button', '', `${i + 1}. ${esc(o.label)}`);
      b.onclick = () => o.run();
      return b;
    });
    const finish = () => {
      window.clearInterval(timer);
      sayEl.textContent = line;
      sayEl.classList.add('done');
      opts.append(...buttons);
      buttons[0]?.focus({ preventScroll: true });
    };
    if (reduced()) return finish();
    let i = 0;
    sayEl.textContent = '';
    timer = window.setInterval(() => {
      i += 1;
      sayEl.textContent = line.slice(0, i);
      if (i >= line.length) finish();
    }, 28);
    sayEl.onclick = finish;
  };
  const api = {
    open(r: string, line: string, options: NpcOption[]) {
      api.close();
      role = r;
      const m = roleMeta(r);
      el = h('div', 'npc');
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', t('{cs} 对话', { cs: m.callsign }));
      const src = charSprite(m.shape, m.color, { cell: 3 });
      const [c, g] = makeCanvas(40, 40);
      g.drawImage(src, Math.round((40 - src.width) / 2), 40 - src.height - 1);
      const body = h('div', 'body', `<div class="name" style="color:${m.color}">${esc(m.callsign)} · ${esc(m.desk)}</div><div class="say"></div><div class="opts"></div>`);
      el.append(c, body);
      el.addEventListener('keydown', (e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= 9) {
          const b = el?.querySelectorAll<HTMLButtonElement>('.opts button')[n - 1];
          if (b) {
            e.preventDefault();
            e.stopPropagation();
            b.click();
          }
        }
      });
      host.append(el);
      render(line, options);
    },
    say(line: string, options: NpcOption[]) {
      render(line, options);
    },
    close() {
      window.clearInterval(timer);
      el?.remove();
      el = null;
      role = '';
    },
    isOpen() {
      return !!el && !!role;
    },
  };
  return api;
}

// ---------- 通用卡片 ----------
function card(host: HTMLElement, cls: string, pos: Partial<Record<'left' | 'right' | 'top' | 'bottom', string>>): HTMLDivElement {
  const el = h('div', `card px-box ${cls}`);
  Object.assign(el.style, pos);
  host.append(el);
  return el;
}

const m3 = (ms: AgentMetric[] = []) => `<div class="m3">${ms.slice(0, 3).map((m) => `<div><span>${esc(m.label)}</span><b class="${m.tone === 'up' ? 'up' : m.tone === 'down' ? 'down' : m.tone === 'warn' ? 'warn' : ''}">${esc(m.value)}</b></div>`).join('')}</div>`;

/** 这个角色用的模型;broken = 连接断了(红点)。null = 不用模型 */
export type RoomBrain = { name: string; sourceLabel: string; broken: boolean } | null;
export interface RoomCardData {
  line: string;
  status: string;
  metrics?: AgentMetric[];
  brain?: RoomBrain;
  desk?: DeskInfo | null;
}
export interface RoomCardApi {
  el: HTMLDivElement;
  update(a: RoomCardData): void;
}

const ENGINE_BADGE: Record<string, string> = tmap({ code: '代码', decision: '决策模型', llm: 'LLM' });
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function brainHtml(b: RoomBrain | undefined): string {
  if (!b) return '';
  const dot = b.broken ? `<i class="bdot" title="${esc(t('模型连接断了'))}"></i>` : '';
  return `${dot}<span>${esc(t('模型 {name} · {src}', { name: b.name, src: b.sourceLabel }))}</span>`;
}

function slicesHtml(d: DeskInfo | null | undefined): string {
  if (!d) return '';
  if (d.kind === 'free') return `<div class="sl-empty">${esc(t('自由判断(playbook)'))}</div>`;
  if (!d.slices.length) return `<div class="sl-empty">${esc(t('当前策略没有分给这张桌的规则'))}</div>`;
  return d.slices
    .map((sl) => {
      const rules = sl.rules.slice(0, 3).map((r) => `<li title="${esc(r)}">${esc(clip(r, 60))}</li>`).join('');
      const more = sl.rules.length > 3 ? `<li class="more">${esc(t('还有 {n} 条', { n: sl.rules.length - 3 }))}</li>` : '';
      return `<div class="sl"><div class="slh"><b title="${esc(sl.summary)}">${esc(sl.title)}</b><em class="eng ${sl.engine}">${esc(ENGINE_BADGE[sl.engine] ?? sl.engine)}</em></div>${rules || more ? `<ul>${rules}${more}</ul>` : ''}</div>`;
    })
    .join('');
}

/** 房间卡:只建一次,数据变化时 update() 原地改文字,不闪 */
export function roomCard(host: HTMLElement, a: RoomCardData & { role: string }, onBack: () => void, onEvo: () => void): RoomCardApi {
  const m = roleMeta(a.role);
  const el = card(host, 'room', { right: '16px', bottom: '16px' });
  el.innerHTML = `<button class="x" title="${esc(t('返回全景(Esc)'))}">×</button>
<div class="hd"><b class="cs" style="color:${m.color}">${esc(m.callsign)}</b><span class="rn">${esc(m.roomName)} · ${esc(m.title)}</span></div>
<div class="st"><i class="lamp"></i><span class="stl"></span><span class="ln"></span></div>
<div class="brain" hidden></div>
<div class="m3"><div><span></span><b></b></div><div><span></span><b></b></div><div><span></span><b></b></div></div>
<div class="slices" hidden></div>
<div class="acts"></div>`;
  const acts = el.querySelector('.acts')!;
  // 真实入口:主应用 hash 页(roles.ts 的 page),例如 #intel / #my-strategies
  const open = h('a', 'pbtn ok', esc(t('打开工作台 → {page}', { page: m.pageLabel })));
  open.href = `#${m.page}`;
  const evo = h('button', 'pbtn', esc(t('30 天进化')));
  evo.onclick = onEvo;
  const back = h('button', 'pbtn', esc(t('← 返回全景')));
  back.onclick = onBack;
  acts.append(open, evo, back);
  el.querySelector<HTMLButtonElement>('.x')!.onclick = onBack;
  const stZh: Record<string, string> = tmap({ working: '在干活', waiting: '等着', stuck: '卡住', idle: '空闲' });
  const stCol: Record<string, string> = { working: 'var(--up)', waiting: 'var(--warn)', stuck: 'var(--down)', idle: 'var(--faint)' };
  const cells = [...el.querySelectorAll<HTMLElement>('.m3 > div')];
  const brainEl = el.querySelector<HTMLElement>('.brain')!;
  const slicesEl = el.querySelector<HTMLElement>('.slices')!;
  let lastBrain = '';
  let lastSlices = '';
  const update: RoomCardApi['update'] = (x) => {
    // 只在内容变了才重写,避免每次刷新重置滚动位置
    const bh = brainHtml(x.brain);
    if (bh !== lastBrain) {
      lastBrain = bh;
      brainEl.innerHTML = bh;
      brainEl.hidden = !bh;
    }
    const sh = slicesHtml(x.desk);
    if (sh !== lastSlices) {
      lastSlices = sh;
      slicesEl.innerHTML = sh;
      slicesEl.hidden = !sh;
    }
    el.querySelector<HTMLElement>('.lamp')!.style.background = stCol[x.status] ?? 'var(--faint)';
    el.querySelector('.stl')!.textContent = stZh[x.status] ?? x.status;
    el.querySelector('.ln')!.textContent = x.line;
    (x.metrics ?? []).slice(0, 3).forEach((mt, i) => {
      const c = cells[i];
      if (!c) return;
      c.querySelector('span')!.textContent = mt.label;
      const b = c.querySelector('b')!;
      if (b.textContent !== mt.value) b.textContent = mt.value;
      b.className = mt.tone === 'up' ? 'up' : mt.tone === 'down' ? 'down' : mt.tone === 'warn' ? 'warn' : '';
    });
  };
  update(a);
  return { el, update };
}

export function evoDayCard(host: HTMLElement, d: EvoDayDetail, href: string, onClose: () => void): HTMLDivElement {
  const m = roleMeta(d.role);
  const el = card(host, 'evo', { left: '16px', top: '16px' });
  el.innerHTML = `<button class="x">×</button><h4 style="color:${m.color}">${esc(m.callsign)} · ${esc(d.date)}</h4><div class="sub">${esc(t('这一天的表现'))}</div>${m3(d.metrics)}<ul>${d.records.map((r) => `<li><small>${esc(r.at)}</small>${esc(r.text)}</li>`).join('')}</ul><div class="acts"></div>`;
  // 真实入口:#evolution?role=&date=
  const a = h('a', 'pbtn ok', esc(t('去进化页看全部 →')));
  a.href = href;
  const c = h('button', 'pbtn', esc(t('关闭')));
  c.onclick = onClose;
  el.querySelector('.acts')!.append(a, c);
  el.querySelector<HTMLButtonElement>('.x')!.onclick = onClose;
  return el;
}

export function approvalCard(host: HTMLElement, it: InboxItem, onOk: () => void, onNo: () => void, onClose: () => void): HTMLDivElement {
  const el = card(host, 'approve', { left: '50%', top: '50%' });
  el.style.transform = 'translate(-50%,-50%)';
  el.style.borderColor = '#b8862a';
  el.innerHTML = `<button class="x">×</button><h4 style="color:#ffcf4a">${esc(t('金信封 · 待你批准'))}</h4><div class="sub">${esc(it.detail)}</div><p style="font:700 18px var(--mono);margin:6px 0 12px">${esc(it.title)}</p><div class="acts"></div>`;
  // 真实入口:POST /api/approvals/{id}/approve | /reject(审批绑定 plan_hash,重闸只能拒不能改)
  const ok = h('button', 'pbtn ok', esc(t('批准 → 交给 EXEC')));
  const no = h('button', 'pbtn no', esc(t('拒绝')));
  ok.onclick = onOk;
  no.onclick = onNo;
  el.querySelector('.acts')!.append(ok, no);
  el.querySelector<HTMLButtonElement>('.x')!.onclick = onClose;
  return el;
}

export function strategyRunCard(host: HTMLElement, s: StrategyRef, onRun: (mode: 'paper' | 'live', symbol: string) => void, onClose: () => void): HTMLDivElement {
  const el = card(host, 'run', { left: '50%', top: '50%' });
  el.style.transform = 'translate(-50%,-50%)';
  el.innerHTML = `<button class="x">×</button><h4 style="color:${roleMeta('executor').color}">${esc(t('运行策略'))}</h4><div class="sub">${esc(t('EXEC 接住了「{name} {ver}」', { name: s.name, ver: s.version }))}</div>
  <div style="display:flex;gap:6px;margin:8px 0" data-k="sym">${['SOL', 'BTC', 'ETH'].map((x, i) => `<button class="pbtn" aria-pressed="${i === 0}" data-v="${x}">${x}</button>`).join('')}</div>
  <div style="display:flex;gap:6px;margin:8px 0 12px" data-k="mode"><button class="pbtn" aria-pressed="true" data-v="paper">${esc(t('模拟盘 paper'))}</button><button class="pbtn" aria-pressed="false" data-v="live">${esc(t('实盘(需审批)'))}</button></div><div class="acts"></div>`;
  const pick = (k: string) => {
    const g = el.querySelector(`[data-k=${k}]`)!;
    g.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        g.querySelectorAll('button').forEach((x) => {
          x.setAttribute('aria-pressed', 'false');
          (x as HTMLElement).style.borderColor = '';
        });
        b.setAttribute('aria-pressed', 'true');
        b.style.borderColor = 'var(--accent)';
      };
      if (b.getAttribute('aria-pressed') === 'true') b.style.borderColor = 'var(--accent)';
    });
    return () => g.querySelector<HTMLButtonElement>('[aria-pressed=true]')!.dataset.v!;
  };
  const sym = pick('sym');
  const mode = pick('mode');
  // 真实入口:§9.51 Strategy Run —— POST /api/strategy-runs { strategy_id, symbol, mode }
  const run = h('button', 'pbtn ok', esc(t('开跑')));
  run.onclick = () => onRun(mode() as 'paper' | 'live', sym());
  const c = h('button', 'pbtn', esc(t('算了')));
  c.onclick = onClose;
  el.querySelector('.acts')!.append(run, c);
  el.querySelector<HTMLButtonElement>('.x')!.onclick = onClose;
  return el;
}

// ---------- 命令行 ----------
export function makeCli(host: HTMLElement, onSubmit: (s: string) => void): { toggle(): void; isOpen(): boolean; close(): void } {
  let el: HTMLDivElement | null = null;
  const api = {
    toggle() {
      if (el) return api.close();
      el = h('div', 'cli', `&gt; <input aria-label="${esc(t('命令'))}" placeholder="${esc(t('让 radar 盯 SOL'))}" /><div class="hint">${esc(t('例:让 radar 盯 SOL · 回测 当前策略 ETH · 现在判断一次 BTC · 查风险 · 复盘昨天   (Enter 执行 · Esc 关闭)'))}</div>`);
      host.append(el);
      const inp = el.querySelector('input')!;
      inp.focus();
      inp.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          onSubmit(inp.value);
          inp.value = '';
        } else if (e.key === 'Escape' || e.key === '`' || e.key === '~') {
          e.preventDefault();
          api.close();
        }
      };
    },
    isOpen: () => !!el,
    close() {
      el?.remove();
      el = null;
    },
  };
  return api;
}

// ---------- 拖拽 ----------
export interface DragSpec {
  label: string;
  sub: string;
  /** 悬停到某处时的提示;返回 null = 不可放 */
  hint(clientX: number, clientY: number): { text: string; ok: boolean } | null;
  drop(clientX: number, clientY: number): void;
  cancel(): void;
}
export function startDrag(e: PointerEvent, spec: DragSpec): void {
  const ghost = h('div', 'ghost', `${esc(spec.label)}<small>${esc(spec.sub)}</small>`);
  document.body.append(ghost);
  const move = (ev: PointerEvent) => {
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
    const hi = spec.hint(ev.clientX, ev.clientY);
    ghost.classList.toggle('ok', !!hi?.ok);
    ghost.querySelector('small')!.textContent = hi?.text ?? spec.sub;
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    ghost.remove();
    spec.drop(ev.clientX, ev.clientY);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  move(e);
}

// ---------- 紧急停止:掀罩 + 按住 2 秒 ----------
export function wireEstop(root: HTMLElement, onFire: () => void, onHint: (s: string) => void): void {
  const cover = root.querySelector<HTMLElement>('.cover')!;
  const btn = root.querySelector<HTMLElement>('.btn')!;
  let raf = 0;
  let t0 = 0;
  let closeTimer = 0;
  cover.onclick = () => {
    root.classList.add('open');
    onHint(t('保护罩已掀开:按住红钮 2 秒触发紧急停止'));
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => root.classList.remove('open'), 6000);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    root.style.setProperty('--p', '0');
  };
  btn.onpointerdown = (e) => {
    if (!root.classList.contains('open')) return;
    e.preventDefault();
    window.clearTimeout(closeTimer);
    t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 2000);
      root.style.setProperty('--p', String(p));
      if (p >= 1) {
        stop();
        root.classList.remove('open');
        onFire();
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  btn.onpointerup = () => {
    if (root.style.getPropertyValue('--p') !== '0' && root.style.getPropertyValue('--p') !== '') onHint(t('松手了,没触发(要按满 2 秒)'));
    stop();
    closeTimer = window.setTimeout(() => root.classList.remove('open'), 4000);
  };
  btn.onpointerleave = stop;
}
