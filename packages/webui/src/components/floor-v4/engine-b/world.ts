/**
 * 世界状态:角色(走路 / 坐电梯 / 开会 / 茶水间)、电梯调度(SCAN)、交接信封、气泡、粒子。
 * 纯逻辑,不碰 canvas;render.ts 只读这里的状态画图。
 */
import { t } from '@/lib/i18n';
import type { Layout } from './layout';
import { ROLES } from './roles';
import type { AgentSnap, AgentStatus, EvoRoleRow, HandoffSnap, MeetingSnap, Role, SfxKind } from './types';
import { handoffKey, EVO_KIND_LABEL } from './types';
import type { Pose } from './sprites';

export type Step =
  | { k: 'walk'; x: number }
  | { k: 'lift'; to: number }
  | { k: 'stay'; dur: number; pose: Pose; tag?: string }
  | { k: 'call'; fn: () => void };

interface Mover {
  level: number;
  x: number;
  mode: 'idle' | 'walk' | 'waitLift' | 'inLift' | 'stay';
  plan: Step[];
  stayLeft: number;
  stayPose: Pose;
  speed: number;
}

export interface Actor extends Mover {
  role: Role;
  status: AgentStatus;
  line: string;
  look: -1 | 0 | 1;
  walked: number;
  poseOverride: Pose | null;
  poseLeft: number;
  blinkAt: number;
  nextIdleAt: number;
  away: boolean; // 不在自己工位
  waveUntil: number;
  task: string | null;
  tea: boolean;
  meeting: string | null;
}

export interface Envelope extends Mover {
  key: string;
  from: Role;
  to: Role;
  reply: string;
  color: string;
  trail: { x: number; y: number; level: number }[];
  popT: number;
  state: 'travel' | 'onDesk' | 'done';
  bornAt: number;
}

export interface Bubble {
  id: number;
  role: Role;
  text: string;
  until: number;
  kind: 'say' | 'alert' | 'evo';
  /** 不挂在角色头上、挂在某个点上的气泡(宠物 / 信箱) */
  at?: { x: number; y: number };
}

export interface EvoFx { role: Role; t0: number }

export interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size?: number; g?: number }
export interface Ripple { x: number; y: number; t0: number }

interface Rider { kind: 'agent' | 'env'; ref: Actor | Envelope; from: number; to: number }

export interface Cab {
  pos: number;
  dir: 1 | -1 | 0;
  doorT: number;
  riders: Rider[];
  ding: number;
}

interface Meeting { id: string; topic: string; roles: Role[]; phase: 'gather' | 'talk' | 'leave'; t: number; talkIdx: number }

/** 开会时的闲聊;播放时才 t() */
const MEET_LINES = ['我同意', '风险可控', '再等一根 K 线', '仓位减半?', '数据够了', '我来盯着'];

export class World {
  L: Layout;
  t = 0;
  actors = new Map<Role, Actor>();
  envelopes: Envelope[] = [];
  bubbles: Bubble[] = [];
  particles: Particle[] = [];
  cab: Cab = { pos: 0, dir: 0, doorT: 0, riders: [], ding: 0 };
  waiting: Rider[] = [];
  meeting: Meeting | null = null;
  evoFx: EvoFx[] = [];
  ripples: Ripple[] = [];
  cursor: { x: number; y: number } | null = null;
  dropTarget: Role | null = null;
  alarmUntil = 0;
  petRollUntil = 0;
  /** 门口信箱的位置(街面) */
  get mailboxX(): number { return this.L.mainX - 18; }
  /** 底层大堂门的 x(主楼左外墙) */
  get lobbyX(): number { return this.L.mainX + 2; }
  /** 有信封 / 人在门口 → 门打开 */
  lobbyOpen(): boolean {
    return this.envelopes.some((e) => e.level === 0 && e.mode !== 'inLift' && Math.abs(e.x - this.lobbyX) < 12);
  }
  get statueX(): number { return Math.max(4, this.L.mainX - 40); }
  private evoSeen = new Map<Role, string>();
  reduced: boolean;
  onDelivered: ((key: string) => void) | undefined;
  /** 音效触发点(信封送达 / 批准 / 进化 / 击掌);引擎只喊不响 */
  onSfx: ((k: SfxKind) => void) | undefined;
  private seenHandoffs = new Set<string>();
  private seenMeetings = new Set<string>();
  private primed = false;
  private bubbleSeq = 0;
  private teaCount = 0;

  constructor(L: Layout, reduced: boolean) {
    this.L = L;
    this.reduced = reduced;
    for (const role of Object.keys(ROLES) as Role[]) {
      const room = L.rooms[role];
      this.actors.set(role, {
        role, status: 'idle', line: '', level: room.level, x: room.seatX, mode: 'idle', plan: [], stayLeft: 0, stayPose: 'sit', speed: 26,
        look: 0, walked: 0, poseOverride: null, poseLeft: 0, blinkAt: 1 + Math.random() * 4, nextIdleAt: 4 + Math.random() * 10, away: false, meeting: null, tea: false, waveUntil: 0, task: null,
      });
    }
  }

  /** 画布尺寸变了:布局重算,把所有人瞬移回工位(简单可靠) */
  relayout(L: Layout): void {
    this.L = L;
    for (const a of this.actors.values()) {
      const room = L.rooms[a.role];
      a.level = room.level; a.x = room.seatX; a.mode = 'idle'; a.plan = []; a.away = false; a.meeting = null; a.tea = false;
    }
    this.envelopes = [];
    this.waiting = [];
    this.cab.riders = [];
    this.meeting = null;
    this.teaCount = 0;
  }

  // ---------- 数据入口 ----------
  apply(agents: AgentSnap[], handoffs: HandoffSnap[], meetings: MeetingSnap[] | undefined, evolution?: EvoRoleRow[]): void {
    const primed = this.primed;
    for (const row of evolution ?? []) {
      const today = row.days[row.days.length - 1];
      if (!today) continue;
      const sig = `${today.date}|${today.events ?? 0}`;
      const prev = this.evoSeen.get(row.role);
      this.evoSeen.set(row.role, sig);
      if (!primed || prev === undefined || prev === sig) continue;
      const [pd, pe] = prev.split('|');
      if (pd === today.date && (today.events ?? 0) > Number(pe)) this.evolve(row.role, t(EVO_KIND_LABEL[today.last_event?.kind ?? 'distill'].plus));
    }
    for (const s of agents) {
      const a = this.actors.get(s.role);
      if (!a) continue;
      if (a.status !== 'stuck' && s.status === 'stuck') this.say(s.role, t('卡住了!'), 'alert', 2.6);
      a.status = s.status;
      a.line = s.line;
      const nt = s.task?.label ?? null;
      if (a.task && !nt && this.primed) this.taskDone(a.role, s.line);
      else if (!a.task && nt && this.primed) { this.say(a.role, t('收到:{task}', { task: nt })); a.poseOverride = 'catch'; a.poseLeft = 0.8; }
      a.task = nt;
    }
    if (!this.primed) {
      handoffs.forEach((h) => this.seenHandoffs.add(handoffKey(h)));
      (meetings ?? []).forEach((m) => this.seenMeetings.add(m.id));
      this.primed = true;
      return;
    }
    for (const h of handoffs) {
      const k = handoffKey(h);
      if (this.seenHandoffs.has(k)) continue;
      this.seenHandoffs.add(k);
      this.spawnEnvelope(h);
    }
    for (const m of meetings ?? []) {
      if (this.seenMeetings.has(m.id)) continue;
      this.seenMeetings.add(m.id);
      if (!this.meeting && !this.reduced) this.startMeeting(m);
    }
  }

  // ---------- 路线 ----------
  private sideOf(x: number): 'main' | 'wing' {
    return x < this.L.shaftX + this.L.shaftW / 2 ? 'main' : 'wing';
  }
  /** 从 (level, x) 去 (level2, x2) 的步骤 */
  route(level: number, x: number, level2: number, x2: number): Step[] {
    if (level === level2) return [{ k: 'walk', x: x2 }];
    const L = this.L;
    const door = this.sideOf(x) === 'main' ? L.shaftX - 3 : L.wingX + 3;
    return [{ k: 'walk', x: door }, { k: 'lift', to: level2 }, { k: 'walk', x: x2 }];
  }
  private goto(a: Actor, level: number, x: number, tail: Step[] = []): void {
    if (a.tea) { a.tea = false; this.teaCount = Math.max(0, this.teaCount - 1); }
    if (a.mode === 'inLift') {
      const r = this.cab.riders.find((rr) => rr.ref === a);
      a.plan = [...this.route(r ? r.to : a.level, this.L.shaftCenter, level, x), ...tail];
      return;
    }
    if (a.mode === 'waitLift') this.waiting = this.waiting.filter((w) => w.ref !== a);
    a.mode = 'idle';
    a.stayLeft = 0;
    a.plan = [...this.route(a.level, a.x, level, x), ...tail];
  }
  private home(a: Actor): Step[] {
    const r = this.L.rooms[a.role];
    return [...this.route(a.level, a.x, r.level, r.seatX), { k: 'call', fn: () => { a.away = false; } }];
  }

  // ---------- 气泡 / 粒子 ----------
  say(role: Role, text: string, kind: 'say' | 'alert' | 'evo' = 'say', dur = 2.8): void {
    this.bubbles = this.bubbles.filter((b) => b.role !== role);
    this.bubbles.push({ id: ++this.bubbleSeq, role, text, until: this.t + dur, kind });
    if (this.bubbles.length > 5) this.bubbles.shift();
  }
  private sparkle(x: number, y: number, color: string, n = 14): void {
    if (this.reduced) return;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const v = 18 + Math.random() * 22;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 10, life: 0.7, max: 0.7, color });
    }
  }

  // ---------- 游戏式交互 ----------
  taskDone(role: Role, line: string): void {
    const a = this.actors.get(role);
    if (!a) return;
    const p = this.actorPos(a);
    this.say(role, t('搞定!{line}', { line: line.length > 18 ? line.slice(0, 18) + '…' : line }), 'say', 3.2);
    this.burst(p.x, p.y - 14, ['#5dff8f', '#ffffff', '#ffe36b'], 16);
    a.poseOverride = 'stretch'; a.poseLeft = 1;
  }
  wave(role: Role): void {
    const a = this.actors.get(role);
    if (a && a.waveUntil < this.t) a.waveUntil = this.t + 1.4;
  }
  highFive(role: Role): void {
    const a = this.actors.get(role);
    if (!a) return;
    const p = this.actorPos(a);
    a.poseOverride = 'catch'; a.poseLeft = 0.9;
    this.say(role, t('击掌!'), 'say', 1.6);
    this.onSfx?.('highfive');
    this.burst(p.x, p.y - 18, ['#ff4fd8', '#39f0ff', '#ffd166', '#7dffb0', '#ff7a5c'], 26, true);
  }
  ripple(x: number, y: number): void {
    this.ripples.push({ x, y, t0: this.t });
  }
  catchDrop(role: Role, line: string): void {
    const a = this.actors.get(role);
    if (!a) return;
    const p = this.actorPos(a);
    a.poseOverride = 'catch'; a.poseLeft = 1.1;
    this.say(role, line, 'say', 2.8);
    this.burst(p.x, p.y - 18, ['#ffe36b', '#ffffff', ROLES[role].color], 18);
  }
  approval(ok: boolean): void {
    const L = this.L;
    if (!ok) {
      this.burst(this.mailboxX + 3, L.groundY - 14, ['#b0aaa0', '#6a655c', '#e8e2d4'], 12, true);
      this.bubbles.push({ id: ++this.bubbleSeq, role: 'executor', text: t('已拒绝,揉掉了'), until: this.t + 2, kind: 'alert', at: { x: this.mailboxX + 3, y: L.groundY - 16 } });
      return;
    }
    // 批准的金信封:信箱 → 底层大堂门 → (需要时坐电梯)→ EXEC 工位
    const dest = L.rooms.executor;
    const door = this.lobbyX;
    const env: Envelope = {
      key: `approval-${this.t}`, from: 'executor', to: 'executor', reply: t('收到你的批准,下单!'), color: '#ffd23a',
      level: 0, x: this.mailboxX + 3, mode: 'idle',
      plan: [{ k: 'walk', x: door - 6 }, { k: 'stay', dur: 0.35, pose: 'stand' }, { k: 'walk', x: door + 8 }, ...this.route(0, door + 8, dest.level, dest.seatX)],
      stayLeft: 0, stayPose: 'stand', speed: 60, trail: [], popT: 0.45, state: 'travel', bornAt: this.t,
    };
    this.envelopes.push(env);
    this.onSfx?.('approval');
  }
  emergency(): void {
    this.alarmUntil = this.t + 10;
    for (const a of this.actors.values()) { a.poseOverride = 'catch'; a.poseLeft = 1.4; }
    this.say('risk_sentinel', t('紧急停止!全部停手!'), 'alert', 3.5);
  }
  petRoll(petX: number, petY: number): void {
    if (this.petRollUntil > this.t) return;
    this.petRollUntil = this.t + 2.6;
    this.bubbles.push({ id: ++this.bubbleSeq, role: 'reviewer', text: t('哈~欠…'), until: this.t + 2.2, kind: 'say', at: { x: petX, y: petY } });
  }
  coinShower(x: number, y: number): void {
    for (let i = 0; i < 46; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const v = 40 + Math.random() * 60;
      this.particles.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: 1.6 + Math.random() * 0.8, max: 2.4, color: i % 4 ? '#ffd23a' : '#fff3a8', size: 2, g: 90 });
    }
  }
  burst(x: number, y: number, colors: string[], n: number, big = false): void {
    if (this.reduced) return;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const v = 20 + Math.random() * (big ? 45 : 28);
      this.particles.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - 12, life: 0.8 + Math.random() * 0.5, max: 1.3, color: colors[i % colors.length]!, size: big && i % 3 === 0 ? 2 : 1 });
    }
  }

  /** 进化事件:头顶 +1、升级光圈、小星星 */
  evolve(role: Role, label: string): void {
    this.evoFx.push({ role, t0: this.t });
    this.say(role, label, 'evo', 2.6);
    this.onSfx?.('evolve');
    const a = this.actors.get(role);
    if (!a || this.reduced) return;
    const p = this.actorPos(a);
    for (let i = 0; i < 10; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const v = 20 + Math.random() * 26;
      this.particles.push({ x: p.x, y: p.y - 14, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: 1, max: 1, color: i % 3 ? '#ffe36b' : '#ffffff' });
    }
    if (a.mode === 'idle' && !a.away) { a.poseOverride = 'stretch'; a.poseLeft = 0.9; }
  }
  evoFlash(role: Role): number {
    let f = 0;
    for (const e of this.evoFx) if (e.role === role) f = Math.max(f, 1 - (this.t - e.t0) / 1.6);
    return Math.max(0, f);
  }

  // ---------- 信封 ----------
  private spawnEnvelope(h: HandoffSnap): void {
    const from = this.actors.get(h.from);
    const to = this.actors.get(h.to);
    if (!from || !to) return;
    const env: Envelope = {
      key: handoffKey(h), from: h.from, to: h.to, reply: h.reply ?? t('收到'), color: ROLES[h.from].color,
      level: from.mode === 'inLift' ? this.L.rooms[h.from].level : from.level,
      x: from.mode === 'inLift' ? this.L.rooms[h.from].seatX : from.x,
      mode: 'idle', plan: [], stayLeft: 0, stayPose: 'stand', speed: 64, trail: [], popT: 0.45, state: 'travel', bornAt: this.t,
    };
    const dest = this.L.rooms[h.to];
    env.plan = this.route(env.level, env.x, dest.level, dest.seatX);
    this.envelopes.push(env);
    if (from.mode !== 'inLift' && from.mode !== 'walk') { from.poseOverride = 'talk'; from.poseLeft = 0.6; }
  }

  private deliver(env: Envelope): void {
    const to = this.actors.get(env.to)!;
    env.state = 'done';
    to.poseOverride = 'catch';
    to.poseLeft = 1.1;
    to.look = 0;
    this.say(env.to, env.reply);
    this.sparkle(env.x, this.L.floorY(env.level) - 18, env.color);
    this.onDelivered?.(env.key);
    this.onSfx?.('envelope');
  }

  // ---------- 开会 ----------
  private startMeeting(m: MeetingSnap): void {
    const roles = m.roles.filter((r) => this.actors.has(r)).slice(0, 5);
    this.meeting = { id: m.id, topic: m.topic, roles, phase: 'gather', t: 0, talkIdx: 0 };
    const L = this.L;
    const helmLevel = L.rooms.gate_captain.level;
    let seat = 0;
    for (const r of roles) {
      const a = this.actors.get(r)!;
      a.meeting = m.id;
      a.away = true;
      const x = r === 'gate_captain' ? L.meetTableX + 56 : L.meetSeats[seat++ % L.meetSeats.length]!;
      this.goto(a, helmLevel, x, [{ k: 'stay', dur: 999, pose: 'stand', tag: 'meet' }]);
    }
    this.say('gate_captain', t('开会:{topic}', { topic: m.topic }), 'say', 3.2);
  }

  private updateMeeting(dt: number): void {
    const m = this.meeting;
    if (!m) return;
    m.t += dt;
    const arrived = m.roles.every((r) => {
      const a = this.actors.get(r)!;
      return a.mode === 'stay' && a.plan.length === 0;
    });
    if (m.phase === 'gather' && (arrived || m.t > 28)) { m.phase = 'talk'; m.t = 0; }
    if (m.phase === 'talk') {
      const beat = Math.floor(m.t / 1.9);
      if (beat > m.talkIdx && beat <= m.roles.length + 1) {
        m.talkIdx = beat;
        const r = m.roles[beat % m.roles.length]!;
        const a = this.actors.get(r)!;
        a.poseOverride = 'talk'; a.poseLeft = 1.2;
        this.say(r, beat === 1 ? m.topic : t(MEET_LINES[(beat * 7 + r.length) % MEET_LINES.length]!), 'say', 2.2);
      }
      if (m.t > 9.5) {
        m.phase = 'leave';
        for (const r of m.roles) {
          const a = this.actors.get(r)!;
          a.meeting = null;
          a.mode = 'idle';
          a.stayLeft = 0;
          a.plan = this.home(a);
        }
        this.meeting = null;
      }
    }
  }

  // ---------- 空闲小动作 ----------
  private idleBehaviour(a: Actor): void {
    if (this.reduced || a.meeting || a.away || a.plan.length || a.mode !== 'idle') return;
    if (this.t < a.nextIdleAt) return;
    const idle = a.status === 'idle';
    a.nextIdleAt = this.t + (idle ? 7 : 16) + Math.random() * (idle ? 10 : 18);
    const roll = Math.random();
    if (idle && roll < 0.42 && this.teaCount < 2 && !this.meeting) {
      // 去屋顶茶水间端杯咖啡再回来
      const L = this.L;
      a.away = true;
      a.tea = true;
      this.teaCount++;
      const x = L.coffeeX + 12 + Math.floor(Math.random() * 3) * 18;
      a.plan = [
        ...this.route(a.level, a.x, L.terrace.level, x),
        { k: 'stay', dur: 4.5 + Math.random() * 2, pose: 'cup', tag: 'tea' },
        { k: 'call', fn: () => { if (a.tea) { a.tea = false; this.teaCount = Math.max(0, this.teaCount - 1); } a.plan = this.home(a); } },
      ];
    } else if (roll < 0.8) {
      a.poseOverride = 'stretch';
      a.poseLeft = 1.3;
    } else {
      a.look = Math.random() < 0.5 ? -1 : 1;
      a.poseLeft = 0;
    }
  }

  // ---------- 通用行走 / 电梯 ----------
  private stepMover(m: Mover, dt: number, onLiftBoard: () => void): void {
    if (m.mode === 'inLift' || m.mode === 'waitLift') return;
    if (m.mode === 'stay') {
      m.stayLeft -= dt;
      if (m.stayLeft > 0) return;
      m.mode = 'idle';
    }
    const s = m.plan[0];
    if (!s) { m.mode = 'idle'; return; }
    if (s.k === 'walk') {
      const d = s.x - m.x;
      const v = m.speed * dt;
      if (Math.abs(d) <= v) { m.x = s.x; m.plan.shift(); m.mode = 'idle'; }
      else { m.x += Math.sign(d) * v; m.mode = 'walk'; }
    } else if (s.k === 'lift') {
      m.plan.shift();
      if (s.to === m.level) return;
      m.mode = 'waitLift';
      this.waiting.push({ kind: 'agent', ref: m as Actor, from: m.level, to: s.to });
      onLiftBoard();
    } else if (s.k === 'stay') {
      m.plan.shift();
      m.mode = 'stay';
      m.stayLeft = s.dur;
      m.stayPose = s.pose;
    } else if (s.k === 'call') {
      m.plan.shift();
      s.fn();
    }
  }

  private updateCab(dt: number): void {
    const cab = this.cab;
    cab.ding = Math.max(0, cab.ding - dt);
    if (cab.doorT > 0) { cab.doorT -= dt; return; }
    const stops = new Set<number>();
    this.waiting.forEach((w) => stops.add(w.from));
    cab.riders.forEach((r) => stops.add(r.to));
    if (stops.size === 0) { cab.dir = 0; return; }
    const cur = cab.pos;
    const list = [...stops];
    const up = list.filter((l) => l >= cur - 0.001).sort((a, b) => a - b);
    const down = list.filter((l) => l <= cur + 0.001).sort((a, b) => b - a);
    let target: number;
    if (cab.dir >= 0 && up.length) { target = up[0]!; cab.dir = 1; }
    else if (down.length) { target = down[0]!; cab.dir = -1; }
    else { target = up[0]!; cab.dir = 1; }
    const speed = this.reduced ? 4 : 2.6; // 层/秒
    const d = target - cab.pos;
    if (Math.abs(d) <= speed * dt) {
      cab.pos = target;
      cab.doorT = 0.55;
      cab.ding = 0.5;
      // 下客
      const out = cab.riders.filter((r) => r.to === target);
      cab.riders = cab.riders.filter((r) => r.to !== target);
      for (const r of out) {
        const m = r.ref;
        m.level = target;
        m.x = this.L.shaftCenter;
        m.mode = 'idle';
      }
      // 上客
      const inn = this.waiting.filter((w) => w.from === target);
      this.waiting = this.waiting.filter((w) => w.from !== target);
      for (const r of inn) { r.ref.mode = 'inLift'; cab.riders.push(r); }
    } else {
      cab.pos += Math.sign(d) * speed * dt;
    }
  }

  // ---------- 主循环 ----------
  update(dt: number): void {
    this.t += dt;
    const L = this.L;
    this.updateCab(dt);
    this.updateMeeting(dt);

    for (const a of this.actors.values()) {
      if (a.poseLeft > 0) { a.poseLeft -= dt; if (a.poseLeft <= 0) a.poseOverride = null; }
      const px = a.x;
      this.stepMover(a, dt, () => {});
      if (a.mode === 'walk') { a.walked += Math.abs(a.x - px); a.look = a.x > px ? 1 : -1; }
      else if (a.mode === 'idle' && !a.away && a.plan.length === 0) {
        const room = L.rooms[a.role];
        if (a.level !== room.level || Math.abs(a.x - room.seatX) > 1) a.plan = this.home(a);
        else if (a.poseLeft <= 0 && a.status !== 'waiting') a.look = 0;
      }
      if (a.status === 'waiting' && a.mode === 'idle' && !a.away && !this.reduced) {
        a.look = (Math.floor(this.t / 1.6 + a.role.length) % 3 - 1) as -1 | 0 | 1;
      }
      if (this.t > a.blinkAt + 0.14) a.blinkAt = this.t + 2.2 + Math.random() * 3.5;
      // 看向光标 / 拖拽目标伸手
      if (this.dropTarget === a.role && a.mode !== 'inLift') { a.poseOverride = 'catch'; a.poseLeft = 0.15; }
      if (this.cursor && a.mode === 'idle' && !a.away && a.poseLeft <= 0) {
        const p = this.actorPos(a);
        const dx = this.cursor.x - p.x, dy = this.cursor.y - (p.y - 12);
        if (Math.abs(dx) < 90 && Math.abs(dy) < 45) a.look = Math.abs(dx) < 4 ? 0 : dx > 0 ? 1 : -1;
      }
      this.idleBehaviour(a);
    }

    for (const e of this.envelopes) {
      if (e.state === 'done') continue;
      if (e.popT > 0) { e.popT -= dt; continue; }
      if (e.state === 'onDesk') {
        const to = this.actors.get(e.to)!;
        if (!to.away && to.mode === 'idle' && to.level === e.level) this.deliver(e);
        continue;
      }
      this.stepMover(e, dt, () => {
        const w = this.waiting[this.waiting.length - 1];
        if (w && w.ref === e) w.kind = 'env';
      });
      if (e.mode !== 'inLift') {
        e.trail.push({ x: e.x, y: 0, level: e.level });
        if (e.trail.length > 16) e.trail.shift();
      } else if (e.trail.length) e.trail.shift();
      // 接收方看向飞来的信封
      const to = this.actors.get(e.to)!;
      if (e.level === to.level && e.mode === 'walk' && Math.abs(e.x - to.x) < 70 && !to.away && to.poseLeft <= 0) {
        to.look = e.x < to.x ? -1 : 1;
      }
      if (e.plan.length === 0 && e.mode === 'idle') {
        if (!to.away && to.level === e.level && Math.abs(to.x - e.x) < 14 && to.mode !== 'inLift') this.deliver(e);
        else e.state = 'onDesk';
      }
    }
    this.envelopes = this.envelopes.filter((e) => e.state !== 'done');

    this.bubbles = this.bubbles.filter((b) => b.until > this.t);
    this.evoFx = this.evoFx.filter((e) => this.t - e.t0 < 1.6);
    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.g ?? 40) * dt; p.life -= dt; }
    this.ripples = this.ripples.filter((r) => this.t - r.t0 < 0.6);
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  /** 角色此刻在画面上的位置(脚底);在电梯里时返回轿厢里的位置 */
  actorPos(a: Actor): { x: number; y: number } {
    if (a.mode === 'inLift') {
      const idx = this.cab.riders.findIndex((r) => r.ref === a);
      return { x: this.L.shaftCenter + (idx % 2 === 0 ? -2 : 3), y: this.cabFloorY() };
    }
    return { x: a.x, y: this.L.floorY(a.level) };
  }
  cabFloorY(): number {
    return this.L.groundY - this.cab.pos * this.L.floorH;
  }
  envPos(e: Envelope): { x: number; y: number } {
    if (e.mode === 'inLift') return { x: this.L.shaftCenter + 4, y: this.cabFloorY() - 16 };
    const bob = this.reduced ? 0 : Math.round(Math.sin((this.t - e.bornAt) * 7) * 1.2);
    const pop = e.popT > 0 ? Math.round((1 - e.popT / 0.45) * 6) : 6;
    if (e.state === 'onDesk') return { x: e.x + 7, y: this.L.floorY(e.level) - 11 + bob };
    return { x: e.x, y: this.L.floorY(e.level) - 15 - pop + bob };
  }
}
