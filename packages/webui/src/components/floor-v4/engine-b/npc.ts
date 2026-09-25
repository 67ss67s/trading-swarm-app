/**
 * NPC 对话框(游戏式):点 agent → 镜头推进到它房间,底部弹像素风对话框,打字机逐字出字。
 * 选项:聊聊(→ #agent 预选该角色)/ 派个活(TASKS 里 2–3 个一键任务)/ 你今天干了啥 / 打开工作台 / 离开。
 * ↑↓ 选、Enter 确认、点对话框跳过打字。
 */
import { t } from '@/lib/i18n';
import { ROLES, TASKS, STATUS_LABEL } from './roles';
import { agentSprite } from './sprites';
import type { AgentSnap, DeskInfo, Role, RoleEngine, TaskDef } from './types';

export const NPC_CSS = `
.flb-npc{position:absolute;left:50%;bottom:16px;transform:translateX(-50%) translateY(10px);width:min(780px,calc(100% - 32px));pointer-events:auto;display:flex;gap:14px;
  background:#0f0d14;color:#f4f1ea;border:3px solid var(--c);box-shadow:0 0 0 3px #000,6px 6px 0 3px rgba(0,0,0,.45);padding:12px 14px 12px 12px;opacity:0;transition:opacity .2s,transform .2s;font-size:14px}
.flb-npc.on{opacity:1;transform:translateX(-50%)}
.flb-npc .pt{width:84px;height:84px;image-rendering:pixelated;background:#1a1722;border:2px solid #000;box-shadow:inset 0 0 0 2px var(--c);flex:none}
.flb-npc .body{flex:1;min-width:0}
.flb-npc .nm{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.flb-npc .nm b{font-family:ui-monospace,monospace;font-size:17px;letter-spacing:.06em;color:var(--c)}
.flb-npc .nm span{font-size:12px;color:#9a93a8}
.flb-npc .nm i{font-style:normal;font-size:12px;padding:0 6px;border:1px solid #3a3446}
.flb-npc .say{margin:8px 0 8px;min-height:42px;line-height:1.55;font-size:15px}
.flb-npc .say .cur{display:inline-block;width:8px;height:14px;background:var(--c);vertical-align:-2px;margin-left:2px;animation:npcb .6s steps(2) infinite}
@keyframes npcb{50%{opacity:0}}
.flb-npc .row2{display:flex;gap:16px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap}
.flb-npc ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(150px,auto));gap:2px 18px}
.flb-npc li{cursor:pointer;padding:3px 6px 3px 18px;position:relative;white-space:nowrap}
.flb-npc li:hover,.flb-npc li.on{background:#1f1b2a}
.flb-npc li.on::before{content:"";position:absolute;left:5px;top:50%;margin-top:-5px;border-left:7px solid var(--c);border-top:5px solid transparent;border-bottom:5px solid transparent;animation:npcb .8s steps(2) infinite}
.flb-npc li small{color:#8a8398;margin-left:6px;font-size:11px}
.flb-npc .nums{display:flex;gap:6px}
.flb-npc .num{border:1px solid #2e293a;background:#15121c;padding:4px 8px;text-align:right;min-width:74px}
.flb-npc .num .v{font-family:ui-monospace,monospace;font-weight:700;font-size:15px}
.flb-npc .num .k{font-size:10px;color:#8a8398}
.flb-npc .br{margin-top:3px;font-size:11px;color:#9a93a8;display:flex;align-items:center;gap:5px;min-width:0}
.flb-npc .br[hidden],.flb-npc .dk[hidden]{display:none}
.flb-npc .br em{font-style:normal;color:#d8d3e2;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.flb-npc .br .dot{width:7px;height:7px;background:#ff3b4e;box-shadow:0 0 0 1px #000;flex:none}
.flb-npc .dk{margin-top:6px;max-height:92px;overflow:auto;border:1px solid #2e293a;background:#15121c;padding:4px 8px;font-size:12px;line-height:1.4}
.flb-npc .dk .sl+.sl{margin-top:4px;padding-top:4px;border-top:1px dashed #2e293a}
.flb-npc .dk .st{display:flex;align-items:center;gap:6px;color:#f4f1ea;font-weight:600}
.flb-npc .dk .bd{font-size:10px;font-weight:400;padding:0 4px;border:1px solid #4a4358;color:#b8b0c8}
.flb-npc .dk .bd.code{border-color:#3d7a5a;color:#8fe0b0}.flb-npc .dk .bd.decision{border-color:#7a6a3d;color:#f0d890}.flb-npc .dk .bd.llm{border-color:#5a4a8a;color:#c8b4ff}
.flb-npc .dk ul{display:block;grid-template-columns:none}
.flb-npc .dk li{cursor:default;padding:0 0 0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#b8b0c8}
.flb-npc .dk li:hover{background:none}
.flb-npc .dk li::before{content:"·";position:absolute;left:2px}
.flb-npc .dk .mute{color:#8a8398}
@media (prefers-reduced-motion: reduce){.flb-npc{transition:none}.flb-npc .say .cur,.flb-npc li.on::before{animation:none}}
`;

type Opt = { label: string; hint?: string; run: () => void };

export interface NpcDeps {
  outline: () => string;
  reduced: boolean;
  onChat: (role: Role) => void;
  onTask: (role: Role, task: TaskDef) => void;
  onWorkbench: (role: Role) => void;
  onLeave: () => void;
  /** 「派个活」的任务表;缺省用 roles.ts 的 TASKS(原型 mock) */
  tasks?: (role: Role) => TaskDef[];
}

export function createNpc(overlay: HTMLElement, deps: NpcDeps) {
  const el = document.createElement('div');
  el.className = 'flb-npc';
  el.style.display = 'none';
  overlay.appendChild(el);
  let role: Role | null = null;
  let snap: AgentSnap | undefined;
  let full = '';
  let shown = 0;
  let opts: Opt[] = [];
  let sel = 0;
  let timer = 0;
  let pt: HTMLCanvasElement | null = null;
  let talkT = 0;
  const taskList = (r: Role): TaskDef[] => (deps.tasks ? deps.tasks(r) : TASKS[r]);

  function type(text: string): void {
    full = text;
    shown = deps.reduced ? text.length : 0;
    renderSay();
    clearInterval(timer);
    if (shown < full.length) {
      timer = window.setInterval(() => {
        shown = Math.min(full.length, shown + 1);
        talkT++;
        renderSay();
        drawPortrait();
        if (shown >= full.length) { clearInterval(timer); drawPortrait(); }
      }, 26);
    }
  }
  function renderSay(): void {
    const s = el.querySelector('.say');
    if (s) s.innerHTML = `${esc(full.slice(0, shown))}${shown < full.length ? '<span class="cur"></span>' : ''}`;
  }
  function renderNums(): void {
    const box = el.querySelector('.nums');
    if (!box) return;
    const stats = (snap?.stats ?? []).slice(0, 3);
    box.innerHTML = stats.map((x) => `<div class="num"><div class="v">${esc(x.value)}</div><div class="k">${esc(x.label)}</div></div>`).join('');
  }
  function drawPortrait(): void {
    if (!pt || !role) return;
    const info = ROLES[role];
    const c = pt.getContext('2d')!;
    c.clearRect(0, 0, 21, 21);
    const talking = shown < full.length;
    const sp = agentSprite(info.shape, info.color, deps.outline(), { pose: talking && talkT % 6 < 3 ? 'talk' : 'stand', blink: false, look: 0, breath: talking ? ((talkT >> 1) % 2) as 0 | 1 : 0 });
    c.drawImage(sp, 1, 2);
  }
  /** 模型行 + 策略片:open / update 都重画 */
  function renderMeta(): void {
    const br = el.querySelector<HTMLElement>('.br');
    const dk = el.querySelector<HTMLElement>('.dk');
    if (br) {
      const b = snap?.brain;
      br.hidden = b === undefined;
      br.innerHTML = b === undefined ? ''
        : b === null ? `<span>${esc(t('不用模型(纯代码)'))}</span>`
        : `${b.broken ? `<span class="dot" title="${esc(t('模型连接断了'))}"></span>` : ''}<span>${esc(t('模型'))}</span><em title="${esc(`${b.name} · ${b.sourceLabel}`)}">${esc(b.name)} · ${esc(b.sourceLabel)}</em>`;
    }
    if (dk) {
      const d = snap?.desk;
      dk.hidden = !d;
      dk.innerHTML = d ? deskHtml(d) : '';
    }
  }
  function renderOpts(): void {
    const ul = el.querySelector('.row2 ul')!;
    ul.innerHTML = opts.map((o, i) => `<li data-i="${i}" class="${i === sel ? 'on' : ''}">${esc(o.label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</li>`).join('');
  }
  function rootOpts(): void {
    if (!role) return;
    const r = role;
    const info = ROLES[r];
    opts = [
      { label: t('聊聊'), hint: t('打开 Agent 对话'), run: () => { deps.onChat(r); type(t('好,去对话页找我,我已经在等你了。')); } },
      { label: t('派个活'), hint: t('{n} 个一键任务', { n: taskList(r).length }), run: () => taskOpts() },
      { label: t('你今天干了啥'), run: () => { type(snap?.today ?? t('今天还没什么可说的。')); } },
      { label: t('打开工作台 · {page}', { page: info.pageLabel }), run: () => deps.onWorkbench(r) },
      { label: t('离开'), hint: 'Esc', run: () => deps.onLeave() },
    ];
    sel = 0;
    renderOpts();
  }
  function taskOpts(): void {
    if (!role) return;
    const r = role;
    type(t('要我做什么?'));
    opts = [
      ...taskList(r).map((task) => ({ label: task.label, run: () => { deps.onTask(r, task); type(t('好,这就去「{task}」!干完我在动态里告诉你。', { task: task.label })); rootOpts(); } })),
      { label: t('← 返回'), run: () => { type(greet()); rootOpts(); } },
    ];
    sel = 0;
    renderOpts();
  }
  function greet(): string {
    if (!snap) return t('找我有事吗?');
    if (snap.task) return t('我正在「{task}」,马上好。还有别的吗?', { task: snap.task.label });
    if (snap.status === 'stuck') return t('{line}……我卡住了,可能需要你看一眼。', { line: snap.line });
    return t('{line}。找我有事吗?', { line: snap.line });
  }

  el.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('.row2 li');
    if (li) { const o = opts[Number((li as HTMLElement).dataset['i'])]; o?.run(); return; }
    if (shown < full.length) { shown = full.length; clearInterval(timer); renderSay(); drawPortrait(); }
  });

  return {
    get role() { return role; },
    open(r: Role, s: AgentSnap | undefined): void {
      role = r;
      snap = s;
      const info = ROLES[r];
      el.style.setProperty('--c', info.color);
      el.innerHTML = `<canvas class="pt" width="21" height="21"></canvas>
        <div class="body">
          <div class="nm"><b>${info.callsign}</b><span>${esc(info.title)} · ${esc(info.desk)}</span><i>${esc(STATUS_LABEL[s?.status ?? 'idle'] ?? '')}</i></div>
          <div class="br" hidden></div>
          <div class="say"></div>
          <div class="row2"><ul></ul><div class="nums"></div></div>
          <div class="dk" hidden></div>
        </div>`;
      pt = el.querySelector('canvas');
      el.style.display = 'flex';
      requestAnimationFrame(() => el.classList.add('on'));
      renderNums();
      renderMeta();
      rootOpts();
      type(greet());
      drawPortrait();
    },
    update(s: AgentSnap | undefined): void {
      snap = s;
      const st = el.querySelector('.nm i');
      if (st && s) st.textContent = STATUS_LABEL[s.status] ?? s.status;
      if (role) { renderNums(); renderMeta(); }
    },
    close(): void {
      role = null;
      clearInterval(timer);
      el.classList.remove('on');
      el.style.display = 'none';
    },
    /** 返回 true 表示按键被对话框吃掉 */
    key(e: KeyboardEvent): boolean {
      if (!role) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { sel = (sel + 1) % opts.length; renderOpts(); return true; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { sel = (sel - 1 + opts.length) % opts.length; renderOpts(); return true; }
      if (e.key === 'Enter') { if (shown < full.length) { shown = full.length; renderSay(); } else opts[sel]?.run(); return true; }
      return false;
    },
  };
}

const ENGINE_LABEL = (e: RoleEngine): string => (e === 'code' ? t('代码') : e === 'decision' ? t('决策模型') : 'LLM');
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 策略片:自由判断 / 策略没给这张桌分片 / 逐片(标题 + 执行者徽章 + 最多 3 条规则) */
function deskHtml(d: DeskInfo): string {
  if (d.kind === 'free') return `<div class="mute">${esc(t('自由判断(playbook)'))}</div>`;
  const head = d.strategy ? `<div class="mute">${esc(t('策略 {name}', { name: d.strategy }))}</div>` : '';
  if (!d.slices.length) return `${head}<div class="mute">${esc(t('当前策略没有分给这张桌的规则'))}</div>`;
  return head + d.slices.map((sl) => {
    const more = sl.rules.length - 3;
    const rules = sl.rules.slice(0, 3).map((r) => `<li title="${esc(r)}">${esc(clip(r, 64))}</li>`).join('')
      + (more > 0 ? `<li class="mute">${esc(t('另 {n} 条', { n: more }))}</li>` : '');
    return `<div class="sl"><div class="st" title="${esc(sl.summary)}">${esc(clip(sl.title, 40))}<span class="bd ${sl.engine}">${esc(ENGINE_LABEL(sl.engine))}</span></div>${rules ? `<ul>${rules}</ul>` : ''}</div>`;
  }).join('');
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
