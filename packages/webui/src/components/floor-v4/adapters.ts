/**
 * 两套引擎(布局 A 开放办公室 / 布局 B 大楼剖面)包成同一个形状,React 外壳只认 FloorEngine。
 * 引擎源码各自独立(engine-a/、engine-b/),这里只做参数与回调的翻译:
 *   - B 自带 NPC 对话框与房间推镜;A 的 NPC / 房间卡 / 进化日卡 / tooltip 用 engine-a/overlays.ts 的 DOM 件。
 *   - 审批 / 运行策略 / 紧急停止 / 拖拽 / toast 全在 React 外壳里,两种布局共用。
 */
import { mount as mountEngineA } from './engine-a/render';
import { evoDayCard, evoTipHtml, makeNpc, makeTip, roomCard, type RoomCardApi } from './engine-a/overlays';
import { THEMES as THEMES_A } from './engine-a/themes';
import type { ThemeId as ThemeA } from './engine-a/types';
import { mount as mountEngineB } from './engine-b/engine';
import { ROLES } from './engine-b/roles';
import type { EvoDayDetail as EvoDetailB, SfxKind, TaskDef, ThemeId as ThemeB } from './engine-b/types';
import { setDeco } from './deco';
import { toSnapshotA, type FloorModel, type Role } from './snapshot';
import type { RealTask } from './tasks';
import { t } from '@/lib/i18n';

export type UiTheme = ThemeB; // 'study' | 'command' | 'meme'
export type Layout = 'a' | 'b';

export const themeForA = (id: UiTheme): ThemeA => (id === 'study' ? 'lab' : id);

export interface EvoDetail {
  role: Role;
  date: string;
  metrics: { label: string; value: string }[];
  records: { at: number; title: string; ref: string | null }[];
}

export interface EngineCallbacks {
  onChat(role: Role): void;
  onTask(role: Role, task: RealTask): void;
  onWorkbench(role: Role): void;
  tasksFor(role: Role): RealTask[];
  todayOf(role: Role): string;
  onMailbox(): void;
  onToast(text: string, sub?: string): void;
  getEvoDetail(role: Role, date: string): Promise<EvoDetail | null>;
  onOpenEvolution(role: Role, date: string): void;
  onSelect?(role: Role | null): void;
  /** 8-bit 音效触发(响不响由外壳的声音开关决定) */
  onSfx?(k: SfxKind): void;
}

export interface FloorEngine {
  setData(m: FloorModel, now: number): void;
  setTheme(id: UiTheme): void;
  focus(role: Role | null): void;
  pick(clientX: number, clientY: number): Role | null;
  setDropTarget(role: Role | null): void;
  catchDrop(role: Role, line: string): void;
  approval(ok: boolean): void;
  emergency(): void;
  togglePause(): boolean;
  destroy(): void;
}

const asRole = (r: string | null | undefined): Role | null => (r && r in ROLES ? (r as Role) : null);

// ---------------------------------------------------------------- B

export function mountB(canvas: HTMLCanvasElement, theme: UiTheme, cb: EngineCallbacks): FloorEngine {
  const toDef = (x: RealTask): TaskDef => ({ id: x.id, label: x.label, result: '', real: x.real });
  const h = mountEngineB(canvas, {
    theme,
    onSelectAgent: (r) => cb.onSelect?.(r),
    onAgentAction: (role, action, task) => {
      if (action === 'chat') cb.onChat(role);
      else if (action === 'workbench') cb.onWorkbench(role);
      else if (task) {
        const real = cb.tasksFor(role).find((x) => x.id === task.id);
        if (real) cb.onTask(role, real);
      }
    },
    getTasks: (role) => cb.tasksFor(role).map(toDef),
    onMailbox: () => cb.onMailbox(),
    onToast: (text) => cb.onToast(text),
    getEvoDetail: async (role, date): Promise<EvoDetailB | null> => {
      const d = await cb.getEvoDetail(role, date);
      return d ? { role, date, metrics: d.metrics, records: d.records.map((r) => ({ title: r.title, detail: new Date(r.at).toISOString().slice(11, 16) + ' UTC' })) } : null;
    },
    onOpenEvolution: (role, date) => cb.onOpenEvolution(role, date),
    onSfx: (k) => cb.onSfx?.(k),
  });
  return {
    setData: (m) => {
      setDeco(m.deco);
      h.setData(m);
    },
    setTheme: (id) => h.setTheme(id),
    focus: (r) => h.focus(r),
    pick: (x, y) => h.pick(x, y),
    setDropTarget: (r) => h.setDropTarget(r),
    catchDrop: (r, line) => h.catchDrop(r, line),
    approval: (ok) => h.approval(ok),
    emergency: () => h.emergency(),
    togglePause: () => h.togglePause(),
    destroy: () => h.destroy(),
  };
}

// ---------------------------------------------------------------- A

export function mountA(canvas: HTMLCanvasElement, theme: UiTheme, cb: EngineCallbacks, overlayHost: HTMLElement): FloorEngine {
  let model: FloorModel | null = null;
  let focused: Role | null = null;
  let room: RoomCardApi | null = null;
  let evoCard: HTMLElement | null = null;
  let paused = false;
  let ui = theme;
  const npc = makeNpc(overlayHost);
  const tip = makeTip();
  const closeRoom = () => {
    room?.el.remove();
    room = null;
  };
  const closeEvo = () => {
    evoCard?.remove();
    evoCard = null;
  };

  const agentOf = (r: Role) => model?.agents.find((a) => a.role === r);
  const openNpc = (role: Role) => {
    const a = agentOf(role);
    const greet = a?.task ? t('我正在办你派的活:{l}。还要点啥?', { l: a.task.label }) : t('{l}。找我什么事?', { l: a?.line ?? t('在呢') });
    const menu = () => [
      { label: t('聊聊'), run: () => { npc.close(); cb.onChat(role); } },
      { label: t('派个活'), run: () => taskMenu(role, greet, menu) },
      { label: t('你今天干了啥'), run: () => npc.say(cb.todayOf(role), [{ label: t('好的'), run: () => npc.close() }, { label: t('返回'), run: () => npc.say(greet, menu()) }]) },
      { label: t('进它的房间'), run: () => { npc.close(); h.focus(role); } },
      { label: t('打开工作台'), run: () => { npc.close(); cb.onWorkbench(role); } },
      { label: t('走开'), run: () => npc.close() },
    ];
    npc.open(role, greet, menu());
  };
  const taskMenu = (role: Role, greet: string, back: () => { label: string; run: () => void }[]) => {
    const list = cb.tasksFor(role);
    npc.say(list.length ? t('要我干点啥?') : t('我这儿没有能一键派的活。'), [
      ...list.map((x) => ({ label: x.label, run: () => { npc.close(); cb.onTask(role, x); } })),
      { label: t('返回'), run: () => npc.say(greet, back()) },
    ]);
  };
  const openEvoDay = async (role: Role, date: string) => {
    closeEvo();
    tip.hide();
    const d = await cb.getEvoDetail(role, date);
    closeEvo();
    const detail = d
      ? { role, date, metrics: d.metrics, records: d.records.slice(0, 4).map((r) => ({ at: new Date(r.at).toISOString().slice(11, 16), text: r.title })) }
      : { role, date, metrics: [], records: [] };
    const host = canvas.parentElement ?? overlayHost;
    evoCard = evoDayCard(host, detail, `#evolution?role=${encodeURIComponent(role)}&date=${encodeURIComponent(date)}`, closeEvo);
  };

  const h = mountEngineA(canvas, {
    theme: themeForA(theme),
    onSelectAgent: (role) => {
      const r = asRole(role);
      if (r) openNpc(r);
    },
    onFocusChange: (role) => {
      focused = asRole(role);
      closeRoom();
      cb.onSelect?.(focused);
      if (!focused) return;
      const a = agentOf(focused);
      if (!a) return;
      const host = canvas.parentElement ?? overlayHost;
      const r0 = focused;
      room = roomCard(host, { role: a.role, line: a.line, status: a.status, metrics: a.stats ?? [], brain: a.brain ?? null, desk: a.desk ?? null }, () => h.focus(null), () => h.focus(r0, { evo: true }));
    },
    onHoverEvo: (hit) => {
      if (!hit) return tip.hide();
      tip.show(evoTipHtml(hit.role, hit.day, THEMES_A[themeForA(ui)].evo[hit.day.status]), hit.at.x, hit.at.y);
    },
    onSelectEvo: (role, date) => {
      const r = asRole(role);
      if (r) void openEvoDay(r, date);
    },
    onOpenEvoGrid: (role) => h.focus(role, { evo: true }),
    onHoverWindow: (text, at) => (text && at ? tip.show(text, at.x, at.y) : tip.hide()),
    onClickMailbox: () => cb.onMailbox(),
    onSfx: (k) => cb.onSfx?.(k),
    onEasterEgg: (k) => cb.onToast(k === 'pet' ? t('它翻了个身,打了个哈欠') : t('金币雨!(连点地球 5 次)')),
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (npc.isOpen()) npc.close();
    else if (evoCard) closeEvo();
    else if (focused) h.focus(null);
  };
  window.addEventListener('keydown', onKey);

  return {
    setData(m, now) {
      model = m;
      setDeco(m.deco);
      h.setData(toSnapshotA(m, now));
      if (focused && room) {
        const a = agentOf(focused);
        if (a) room.update({ line: a.line, status: a.status, metrics: a.stats ?? [], brain: a.brain ?? null, desk: a.desk ?? null });
      }
    },
    setTheme(id) {
      ui = id;
      h.setTheme(themeForA(id));
    },
    focus(r) {
      npc.close();
      h.focus(r);
    },
    pick: (x, y) => asRole(h.dropTargetAt(x, y)),
    setDropTarget: (r) => h.setDropHover(r),
    catchDrop(r, line) {
      h.celebrate(r, 'catch');
      h.say(r, line, 2600);
    },
    approval(ok) {
      if (ok) h.sendGold('executor');
      else h.say('gate_captain', t('驳回了,记下'), 2600);
    },
    emergency() {
      for (const a of model?.agents ?? []) h.say(a.role, t('停手!'), 2200);
    },
    togglePause() {
      paused = !paused;
      h.setPaused(paused);
      return paused;
    },
    destroy() {
      window.removeEventListener('keydown', onKey);
      npc.close();
      closeRoom();
      closeEvo();
      tip.hide();
      document.querySelectorAll('.fa-tip').forEach((el) => el.remove());
      h.destroy();
    },
  };
}
