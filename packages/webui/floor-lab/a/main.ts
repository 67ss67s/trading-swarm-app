/**
 * 布局 A 原型装配:mock 事件源 → 引擎 setData + 外壳渲染;把游戏式交互接到 mock(真实入口见 tasks.ts / overlays.ts 注释)。
 * 以后接真数据:把 createMockFeed 换成网关 query/SSE 拼出的 FloorSnapshot 即可,引擎不动。
 */
import type { FloorSnapshot, RoleId, ThemeId } from './types';
import { mount } from './render';
import { createMockFeed } from './mock';
import { loadTheme, saveTheme, THEME_ORDER, THEMES } from './themes';
import { ROLE_ORDER, roleMeta, ROLES } from './roles';
import { buildShell } from './shell';
import { COIN_DROP, TASKS, chatHref, evoHref, parseCommand } from './tasks';
import { approvalCard, evoDayCard, evoTipHtml, makeCli, makeNpc, makeTip, makeToaster, roomCard, startDrag, strategyRunCard, wireEstop, type RoomCardApi } from './overlays';

const app = document.getElementById('app')!;
const feed = createMockFeed();
let theme: ThemeId = loadTheme();
let snap: FloorSnapshot = feed.snapshot();
let focused: string | null = null;
let paused = false;

const shell = buildShell(app, {
  onTheme: (id) => setTheme(id),
  onApprove: (id) => approve(id),
  onReject: (id) => reject(id),
  onOpenInbox: (id) => openApproval(id),
  onPickRole: (r) => enterRoom(r),
});
shell.applyTheme(theme);

const toast = makeToaster(shell.stage);
const tip = makeTip();
const npc = makeNpc(shell.stageInner);
let card: HTMLElement | null = null;
let evoCard: HTMLElement | null = null;
const closeCard = () => {
  card?.remove();
  card = null;
};

const engine = mount(shell.canvas, {
  theme,
  onSelectAgent: (role) => openNpc(role),
  onFocusChange: (role) => {
    focused = role;
    closeCard();
    if (role) showRoomCard(role);
  },
  onHoverEvo: (hit) => {
    if (!hit) return tip.hide();
    tip.show(evoTipHtml(hit.role, hit.day, THEMES[theme].evo[hit.day.status]), hit.at.x, hit.at.y);
  },
  onSelectEvo: (role, date) => openEvoDay(role, date),
  onOpenEvoGrid: (role) => enterRoom(role, true),
  onHoverWindow: (text, at) => (text && at ? tip.show(text, at.x, at.y) : tip.hide()),
  onClickMailbox: () => {
    const it = snap.inbox.items[0];
    if (it) openApproval(it.id);
    else toast('信箱是空的', '有待批订单时,金信封会落进来、顶灯会亮');
  },
  onHighFive: (role) => feed.highFive(role),
  onEasterEgg: (k) => toast(k === 'pet' ? '它翻了个身,打了个哈欠' : '金币雨!(连点地球 5 次)'),
});
// 挂载后把卡片宿主设为画布外框(mount 插入的 wrapper),卡片贴着场景
const cardHost = shell.canvas.parentElement as HTMLElement;

feed.subscribe((s) => {
  snap = s;
  engine.setData(s);
  shell.renderTop(s);
  shell.renderRail(s);
  // 房间卡原地刷新数值(不重建,不闪)
  if (focused && roomApi && card === roomApi.el) {
    const a = s.agents.find((x) => x.role === focused);
    if (a) roomApi.update(a);
  }
});

// ---------- 主题 ----------
function setTheme(id: ThemeId): void {
  theme = id;
  saveTheme(id);
  shell.applyTheme(id);
  engine.setTheme(id);
}

// ---------- 房间 ----------
function enterRoom(role: string, evo = false): void {
  npc.close();
  engine.focus(role, { evo });
}
let roomApi: RoomCardApi | null = null;
function showRoomCard(role: string): void {
  const a = snap.agents.find((x) => x.role === role);
  if (!a) return;
  roomApi = roomCard(cardHost, a, () => engine.focus(null), () => engine.focus(role, { evo: true }));
  card = roomApi.el;
}

// ---------- NPC 对话 ----------
function openNpc(role: string): void {
  const m = roleMeta(role);
  const a = snap.agents.find((x) => x.role === role);
  const greet = a?.task ? `我正在办你派的活:${a.task.label}。还要点啥?` : `${a?.line ?? '在呢'}。找我什么事?`;
  const menu = () => [
    {
      label: '聊聊',
      // 真实入口:#agent?role=<role>(Agent 对话页,预选该角色)
      run: () => {
        npc.close();
        toast(`打开 Agent 对话,预选 ${m.callsign}`, chatHref(role));
      },
    },
    { label: '派个活', run: () => taskMenu(role) },
    { label: '你今天干了啥', run: () => npc.say(feed.todaySummary(role), [{ label: '好的', run: () => npc.close() }, { label: '返回', run: () => npc.say(greet, menu()) }]) },
    { label: '进它的房间', run: () => enterRoom(role) },
    { label: '走开', run: () => npc.close() },
  ];
  npc.open(role, greet, menu());
}

function taskMenu(role: string): void {
  const list = TASKS[role as RoleId] ?? [];
  const opts = list.map((t) => ({
    label: t.label,
    run: () => {
      if (t.needsSymbol) {
        npc.say(`${t.label.replace('某币', '')}——哪个币?`, ['SOL', 'BTC', 'ETH', 'DOGE'].map((s) => ({ label: s, run: () => dispatch(role, t.id, s) })));
      } else dispatch(role, t.id);
    },
  }));
  npc.say(list.length ? '要我干点啥?' : '我这儿没有能一键派的活。', [...opts, { label: '算了', run: () => npc.close() }]);
}

function dispatch(role: string, taskId: string, symbol?: string): void {
  const r = feed.assign(role as RoleId, taskId, symbol);
  npc.close();
  const def = TASKS[role as RoleId]?.find((t) => t.id === taskId);
  toast(r.msg, r.ok && def ? `真实入口:${def.real}` : undefined);
  if (r.ok) engine.celebrate(role, 'catch');
}

// ---------- 进化日卡 ----------
function openEvoDay(role: string, date: string): void {
  evoCard?.remove();
  tip.hide();
  evoCard = evoDayCard(cardHost, feed.evoDetail(role, date), evoHref(role, date), () => {
    evoCard?.remove();
    evoCard = null;
  });
}

// ---------- 审批(金信封) ----------
function approve(id: string): void {
  const it = snap.inbox.items.find((x) => x.id === id);
  closeCard();
  feed.approve(id);
  engine.sendGold('executor');
  toast(`已批准:${it?.title ?? ''}`, '金信封飞向 EXEC · 真实入口 POST /api/approvals/{id}/approve');
}
function reject(id: string): void {
  closeCard();
  feed.reject(id);
  toast('已驳回', '真实入口 POST /api/approvals/{id}/reject');
}
function openApproval(id: string): void {
  const it = snap.inbox.items.find((x) => x.id === id);
  if (!it) return;
  closeCard();
  card = approvalCard(cardHost, it, () => approve(id), () => reject(id), closeCard);
}

// ---------- 拖币派活 ----------
shell.ticker.addEventListener('pointerdown', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.coin');
  if (!el) return;
  e.preventDefault();
  const sym = el.dataset.symbol!;
  startDrag(e, {
    label: sym,
    sub: '拖到 RADAR / THREAD / LAB',
    hint(x, y) {
      const role = engine.dropTargetAt(x, y);
      const drop = role ? COIN_DROP[role as RoleId] : undefined;
      engine.setDropHover(drop ? role : null);
      if (!role) return null;
      return drop ? { text: `→ ${roleMeta(role).callsign} ${drop.verb}`, ok: true } : { text: `${roleMeta(role).callsign} 不接这个`, ok: false };
    },
    drop(x, y) {
      engine.setDropHover(null);
      const role = engine.dropTargetAt(x, y);
      const drop = role ? COIN_DROP[role as RoleId] : undefined;
      if (!role) return;
      if (!drop) return toast(`${roleMeta(role).callsign} 不接币`, '试试 RADAR(观察) / THREAD(判断) / LAB(回测)');
      dispatch(role, drop.task, sym);
    },
    cancel() {
      engine.setDropHover(null);
    },
  });
});

// ---------- 拖策略给 EXEC ----------
shell.strat.addEventListener('pointerdown', (e) => {
  const s = snap.strategy;
  if (!s) return;
  e.preventDefault();
  startDrag(e, {
    label: `${s.name} ${s.version}`,
    sub: '拖到 EXEC 工位运行',
    hint(x, y) {
      const role = engine.dropTargetAt(x, y);
      engine.setDropHover(role === 'executor' ? role : null);
      if (!role) return null;
      return role === 'executor' ? { text: '→ EXEC 运行策略', ok: true } : { text: '只有 EXEC 能跑策略', ok: false };
    },
    drop(x, y) {
      engine.setDropHover(null);
      if (engine.dropTargetAt(x, y) !== 'executor') return;
      engine.celebrate('executor', 'catch');
      closeCard();
      card = strategyRunCard(
        cardHost,
        s,
        (mode, symbol) => {
          closeCard();
          engine.say('executor', mode === 'paper' ? `${symbol} 模拟盘开跑` : `${symbol} 实盘等你审批`, 3000);
          engine.celebrate('executor', 'done');
          toast(`运行「${s.name} ${s.version}」· ${symbol} · ${mode === 'paper' ? '模拟盘' : '实盘(需审批)'}`, '真实入口 POST /api/strategy-runs(§9.51)');
        },
        closeCard,
      );
    },
    cancel() {
      engine.setDropHover(null);
    },
  });
});

// ---------- 紧急停止 ----------
wireEstop(
  shell.estop,
  () => {
    // 真实入口:紧急停止(POST /api/emergency-stop,顶栏原有「紧急停止」按钮同源)
    feed.halt();
    toast('紧急停止已触发(演示,20 秒后自动解除)', '真实入口 POST /api/emergency-stop');
  },
  (s) => toast(s),
);

// ---------- 命令行 ----------
const cli = makeCli(shell.stageInner, (input) => {
  const cmd = parseCommand(input);
  if (!cmd) return toast('听不懂', '试试:让 radar 盯 SOL · 回测 当前策略 ETH · 查风险');
  dispatch(cmd.role, cmd.task, cmd.symbol);
});

// ---------- 键盘 ----------
window.addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.tagName === 'INPUT') return;
  if (e.key === '`' || e.key === '~') {
    e.preventDefault();
    cli.toggle();
    return;
  }
  if (e.key === 'Escape') {
    if (cli.isOpen()) return cli.close();
    if (npc.isOpen()) return npc.close();
    if (evoCard) {
      evoCard.remove();
      evoCard = null;
      return;
    }
    if (card && !focused) return closeCard();
    engine.focus(null);
    return;
  }
  if (npc.isOpen()) return;
  if (/^[1-9]$/.test(e.key)) {
    const role = ROLE_ORDER[Number(e.key) - 1];
    if (role) enterRoom(role);
  } else if (e.key === 't' || e.key === 'T') {
    setTheme(THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!);
    toast(`主题:${THEMES[theme].name}`);
  } else if (e.key === 'l' || e.key === 'L') {
    window.location.href = './b.html';
  } else if (e.key === ' ') {
    e.preventDefault();
    paused = !paused;
    engine.setPaused(paused);
    toast(paused ? '动画已暂停(空格继续)' : '继续');
  }
});

// 调试钩子(截图脚本用)
(window as unknown as Record<string, unknown>).__floorA = { engine, feed, setTheme, enterRoom, openNpc, openEvoDay, ROLES };
