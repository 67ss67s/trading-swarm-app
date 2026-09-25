/**
 * 世界状态:每个 agent 的位置/动作(坐着、走路、茶水间、开会、伸懒腰)、信封、气泡、粒子特效。
 * 只吃 FloorSnapshot;新交接 → 信封,新会议 → 走到会议桌,新事件 → 升级光圈/完成火花。
 */
import type { AgentSnapshot, EvoDay, FloorSnapshot, HandoffSnapshot, MeetingSnapshot, Pt, TeamEvent } from './types';
import { CATCH_LINES, roleMeta, ROLE_ORDER, type RoleMeta } from './roles';
import { DESKS, MEETING_SEATS, PANTRY, TABLE, GLOBE, SOFA, deskOf, nearestRing, polyAt, polyLen, routeBetween, trailFromSeat, type DeskSpot } from './layout';
import { MAILBOX } from './desks';

export type Act = 'seated' | 'walk' | 'stand';

export interface AgentSim {
  role: string;
  meta: RoleMeta;
  desk: DeskSpot;
  data: AgentSnapshot;
  pos: Pt;
  act: Act;
  path: Pt[] | null;
  pathD: number;
  pathLen: number;
  /** 当前站立处回环的路(茶水间/会议座位) */
  trail: Pt[];
  goal: 'desk' | 'pantry' | 'meeting';
  standUntil: number;
  stretchUntil: number;
  blinkUntil: number;
  nextBlink: number;
  nextIdle: number;
  look: -1 | 0 | 1;
  lookUntil: number;
  hopUntil: number;
  waveUntil: number;
  mail: number;
  meetingId: string | null;
  carry: boolean;
  phase: number;
  facing: -1 | 1;
}

export interface Envelope {
  id: string;
  from: string;
  to: string;
  path: Pt[];
  len: number;
  d: number;
  color: string;
  reply: string;
  gold: boolean;
  trail: Pt[];
}

export interface Fx {
  kind: 'spark' | 'star' | 'confetti' | 'coin' | 'ripple' | 'ring' | 'plus';
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  floor?: number;
}

export interface Bubble {
  key: string;
  role: string;
  text: string;
  until: number;
  tone: 'say' | 'catch' | 'evo' | 'done' | 'alert';
  anchor?: Pt;
}

export interface Weather {
  rain: boolean;
  thunder: boolean;
  alarm: boolean;
  fireworks: boolean;
  night: boolean;
  explain: string;
}

const WALK = 40;
const ENV_SPEED = 115;

export class World {
  agents = new Map<string, AgentSim>();
  envelopes: Envelope[] = [];
  fx: Fx[] = [];
  bubbles = new Map<string, Bubble>();
  snapshot: FloorSnapshot | null = null;
  evo = new Map<string, EvoDay[]>();
  weather: Weather = { rain: false, thunder: false, alarm: false, fireworks: false, night: true, explain: '' };
  reduced = false;
  now = 0;
  cursor: Pt | null = null;
  dropHover: string | null = null;
  meetingActive = 0;
  petRollUntil = 0;
  flash = 0;
  private seenHandoffs = new Set<string>();
  private seenEvents = new Set<string>();
  private seenMeetings = new Set<string>();
  private pendingMeetings: MeetingSnapshot[] = [];
  private first = true;
  private seq = 0;

  constructor() {
    for (const d of DESKS) {
      const meta = roleMeta(d.role);
      this.agents.set(d.role, {
        role: d.role,
        meta,
        desk: d,
        data: { role: d.role, callsign: meta.callsign, color: meta.color, status: 'idle', line: '' },
        pos: { ...d.seat },
        act: 'seated',
        path: null,
        pathD: 0,
        pathLen: 0,
        trail: trailFromSeat(d),
        goal: 'desk',
        standUntil: 0,
        stretchUntil: 0,
        blinkUntil: 0,
        nextBlink: Math.random() * 4,
        nextIdle: 4 + Math.random() * 10,
        look: 0,
        lookUntil: 0,
        hopUntil: 0,
        waveUntil: 0,
        mail: 0,
        meetingId: null,
        carry: false,
        phase: Math.random() * 6,
        facing: 1,
      });
    }
  }

  apply(s: FloorSnapshot): void {
    this.snapshot = s;
    for (const a of s.agents) {
      const sim = this.agents.get(a.role);
      if (sim) sim.data = a;
    }
    for (const row of s.evolution ?? []) this.evo.set(row.role, row.days);
    this.weather = computeWeather(s);
    const key = (h: HandoffSnapshot) => h.id ?? `${h.at}|${h.from}|${h.to}`;
    for (const h of s.handoffs) {
      const k = key(h);
      if (this.seenHandoffs.has(k)) continue;
      this.seenHandoffs.add(k);
      if (!this.first) this.sendEnvelope(h.from, h.to, h.text, h.reply);
    }
    for (const m of s.meetings ?? []) {
      if (this.seenMeetings.has(m.id)) continue;
      this.seenMeetings.add(m.id);
      if (!this.first || m.until > Date.now()) this.pendingMeetings.push(m);
    }
    for (const e of s.events ?? []) {
      if (this.seenEvents.has(e.id)) continue;
      this.seenEvents.add(e.id);
      if (!this.first) this.onEvent(e);
    }
    this.first = false;
  }

  // ---------- 信封 ----------
  sendEnvelope(from: string, to: string, text: string, reply?: string, gold = false): void {
    const a = this.agents.get(from);
    const b = this.agents.get(to);
    if (!b) return;
    let fromTrail: Pt[];
    if (gold) fromTrail = [{ x: MAILBOX.x, y: MAILBOX.y - 34 }, { x: MAILBOX.x, y: MAILBOX.y - 10 }, nearestRing({ x: MAILBOX.x, y: MAILBOX.y - 30 })];
    else if (!a) return;
    else if (a.act === 'seated') fromTrail = trailFromSeat(a.desk);
    else fromTrail = [{ ...a.pos }, nearestRing(a.pos)];
    const path = routeBetween(fromTrail, trailFromSeat(b.desk));
    const lines = CATCH_LINES[to] ?? ['收到'];
    const env: Envelope = {
      id: `env${++this.seq}`,
      from,
      to,
      path,
      len: polyLen(path),
      d: 0,
      color: gold ? '#ffcf4a' : a?.meta.color ?? '#ffffff',
      reply: reply ?? lines[Math.floor(Math.random() * lines.length)]!,
      gold,
      trail: [],
    };
    this.envelopes.push(env);
    if (a && !gold) {
      a.look = b.desk.x < a.pos.x ? -1 : 1;
      a.lookUntil = this.now + 1.2;
      this.say(from, short(text, 16), 2600, 'say');
    }
  }

  say(role: string, text: string, ms = 2600, tone: Bubble['tone'] = 'say'): void {
    this.bubbles.set(role, { key: `${role}:${++this.seq}`, role, text, until: this.now + ms / 1000, tone });
  }

  private arrive(env: Envelope): void {
    const b = this.agents.get(env.to);
    if (!b) return;
    if (b.act === 'seated') this.catchMail(b, env.reply, env.gold ? '#ffcf4a' : env.color);
    else b.mail++;
  }

  private catchMail(b: AgentSim, reply: string, color: string): void {
    b.hopUntil = this.now + 0.45;
    b.look = 0;
    b.lookUntil = 0;
    this.say(b.role, reply, 2800, 'catch');
    const head = this.head(b);
    this.burst(head.x, head.y - 2, color, 8, 'spark');
  }

  // ---------- 事件 → 特效 ----------
  private onEvent(e: TeamEvent): void {
    const sim = this.agents.get(e.role);
    if (!sim) return;
    const head = this.head(sim);
    if (e.kind === 'evolution') {
      this.fx.push({ kind: 'ring', x: sim.pos.x, y: sim.pos.y - 2, vx: 0, vy: 0, life: 0, max: 1.4, color: '#ffe066' });
      this.burst(head.x, head.y, '#ffe066', 10, 'star');
      this.fx.push({ kind: 'plus', x: head.x, y: head.y - 6, vx: 0, vy: -10, life: 0, max: 1.6, color: '#ffe066' });
      const what = e.text.replace(sim.meta.callsign + ' ', '');
      this.say(e.role, what.includes('教训') ? '+1 教训' : what.includes('假设') ? '+1 验证' : '+1 进化', 2600, 'evo');
    } else if (e.kind === 'task_done') {
      this.burst(head.x, head.y, sim.meta.color, 14, 'spark');
      this.fx.push({ kind: 'ring', x: sim.pos.x, y: sim.pos.y - 2, vx: 0, vy: 0, life: 0, max: 1, color: sim.meta.color });
      this.say(e.role, '搞定!', 2400, 'done');
    } else if (e.kind === 'task_start') {
      sim.hopUntil = this.now + 0.4;
      this.say(e.role, '收到,这就办', 2200, 'catch');
    } else if (e.kind === 'system' && e.text.includes('紧急停止')) {
      this.flash = 1;
    }
  }

  celebrate(role: string, kind: 'catch' | 'done' | 'levelup' | 'highfive' | 'coins'): void {
    if (kind === 'coins') {
      for (let i = 0; i < 40; i++)
        this.fx.push({ kind: 'coin', x: GLOBE.x + (Math.random() - 0.5) * 10, y: GLOBE.y, vx: (Math.random() - 0.5) * 90, vy: -60 - Math.random() * 60, life: 0, max: 2.6, color: '#ffcf4a', floor: TABLE.y + 20 + Math.random() * 40 });
      return;
    }
    const sim = this.agents.get(role);
    if (!sim) return;
    const head = this.head(sim);
    if (kind === 'highfive') {
      sim.hopUntil = this.now + 0.5;
      sim.stretchUntil = this.now + 0.6;
      for (let i = 0; i < 26; i++) {
        const cols = ['#ff4fd8', '#39f0ff', '#ffe066', '#5effa8', '#ff7a5c'];
        this.fx.push({ kind: 'confetti', x: head.x, y: head.y - 4, vx: (Math.random() - 0.5) * 80, vy: -40 - Math.random() * 50, life: 0, max: 1.6, color: cols[i % cols.length]!, floor: sim.pos.y + 4 });
      }
      this.say(role, '击掌!', 1800, 'done');
    } else if (kind === 'catch') {
      this.catchMail(sim, '接住!', sim.meta.color);
    } else if (kind === 'done') {
      this.burst(head.x, head.y, sim.meta.color, 14, 'spark');
    } else {
      this.fx.push({ kind: 'ring', x: sim.pos.x, y: sim.pos.y - 2, vx: 0, vy: 0, life: 0, max: 1.4, color: '#ffe066' });
      this.burst(head.x, head.y, '#ffe066', 10, 'star');
    }
  }

  ripple(p: Pt): void {
    this.fx.push({ kind: 'ripple', x: p.x, y: p.y, vx: 0, vy: 0, life: 0, max: 0.7, color: '#ffffff' });
  }

  private burst(x: number, y: number, color: string, n: number, kind: 'spark' | 'star'): void {
    if (this.reduced) n = Math.min(n, 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const sp = 20 + Math.random() * 25;
      this.fx.push({ kind, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 15, life: 0, max: 0.8 + Math.random() * 0.5, color });
    }
  }

  head(s: AgentSim): Pt {
    return { x: s.pos.x, y: s.pos.y - 28 };
  }

  // ---------- 走路 ----------
  private walk(s: AgentSim, path: Pt[], goal: AgentSim['goal']): void {
    if (this.reduced) {
      const end = path[path.length - 1]!;
      s.pos = { ...end };
      s.path = null;
      s.act = goal === 'desk' ? 'seated' : 'stand';
      s.goal = goal;
      return;
    }
    s.path = path;
    s.pathD = 0;
    s.pathLen = polyLen(path);
    s.act = 'walk';
    s.goal = goal;
  }

  private currentTrail(s: AgentSim): Pt[] {
    return s.act === 'seated' ? trailFromSeat(s.desk) : s.trail;
  }

  goToPantry(s: AgentSim): void {
    const trail = [PANTRY.spot, ...PANTRY.path];
    s.trail = trail;
    this.walk(s, routeBetween(this.currentTrail(s), trail), 'pantry');
  }

  goToSeat(s: AgentSim, seat: Pt): void {
    const trail = [seat, nearestRing(seat)];
    const from = s.act === 'walk' ? [{ ...s.pos }, nearestRing(s.pos)] : this.currentTrail(s);
    s.trail = trail;
    this.walk(s, routeBetween(from, trail), 'meeting');
  }

  goHome(s: AgentSim): void {
    const from = s.act === 'walk' ? [{ ...s.pos }, nearestRing(s.pos)] : s.trail;
    this.walk(s, routeBetween(from, trailFromSeat(s.desk)), 'desk');
  }

  // ---------- 每帧 ----------
  update(dt: number, now: number): void {
    this.now = now;
    const wall = Date.now();
    // 会议
    for (const m of this.pendingMeetings.slice()) {
      if (wall >= m.at) {
        this.pendingMeetings.splice(this.pendingMeetings.indexOf(m), 1);
        if (wall < m.until) this.startMeeting(m, (m.until - wall) / 1000);
      }
    }
    if (this.meetingActive > 0) this.meetingActive = Math.max(0, this.meetingActive - dt);
    for (const s of this.agents.values()) this.updateAgent(s, dt, now);
    // 信封
    for (const e of this.envelopes.slice()) {
      e.d += (this.reduced ? ENV_SPEED * 2.2 : ENV_SPEED) * dt;
      const p = this.envPos(e);
      if (!this.reduced) {
        e.trail.push({ x: p.x, y: p.y });
        if (e.trail.length > 14) e.trail.shift();
      }
      if (e.d >= e.len) {
        this.envelopes.splice(this.envelopes.indexOf(e), 1);
        this.arrive(e);
      }
    }
    // 特效
    for (const f of this.fx.slice()) {
      f.life += dt;
      if (f.kind === 'coin' || f.kind === 'confetti') {
        f.vy += 180 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.floor != null && f.y > f.floor) {
          f.y = f.floor;
          f.vy *= -0.35;
          f.vx *= 0.6;
        }
      } else if (f.kind === 'spark' || f.kind === 'star') {
        f.vy += 40 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.vx *= 0.96;
      } else if (f.kind === 'plus') {
        f.y += f.vy * dt;
      }
      if (f.life >= f.max) this.fx.splice(this.fx.indexOf(f), 1);
    }
    for (const [k, b] of this.bubbles) if (b.until < now) this.bubbles.delete(k);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 1.5);
  }

  envPos(e: Envelope): Pt {
    const p = polyAt(e.path, e.d);
    // 两端升到头顶高度,中间离地 12px 飞
    const endH = 22;
    const midH = 12;
    const k1 = Math.min(1, e.d / 18);
    const k2 = Math.min(1, (e.len - e.d) / 18);
    const h = midH + (endH - midH) * (1 - Math.min(k1, k2));
    return { x: p.x, y: p.y - h };
  }

  envFloor(e: Envelope): Pt {
    return polyAt(e.path, e.d);
  }

  private startMeeting(m: MeetingSnapshot, dur: number): void {
    const roles = m.roles.filter((r) => this.agents.has(r)).slice(0, MEETING_SEATS.length);
    this.meetingActive = dur;
    if (this.reduced) {
      roles.forEach((r, i) => this.say(r, i === 0 ? `开会:${m.topic}` : '在', dur * 1000, 'say'));
      return;
    }
    roles.forEach((r, i) => {
      const s = this.agents.get(r)!;
      s.meetingId = m.id;
      s.standUntil = this.now + dur + i * 0.3;
      this.goToSeat(s, MEETING_SEATS[i]!);
    });
    const host = roles[0];
    if (host) window.setTimeout(() => this.say(host, `碰一下:${m.topic}`, 3200, 'say'), 2600);
  }

  private updateAgent(s: AgentSim, dt: number, now: number): void {
    if (now > s.nextBlink) {
      s.blinkUntil = now + 0.13;
      s.nextBlink = now + 2.5 + Math.random() * 4;
    }
    if (s.act === 'walk' && s.path) {
      s.pathD += WALK * dt;
      const p = polyAt(s.path, s.pathD);
      if (p.dx) s.facing = p.dx < 0 ? -1 : 1;
      s.pos = { x: p.x, y: p.y };
      if (s.pathD >= s.pathLen) {
        s.path = null;
        if (s.goal === 'desk') {
          s.act = 'seated';
          s.pos = { ...s.desk.seat };
          s.carry = false;
          s.meetingId = null;
          if (s.mail > 0) {
            s.mail = 0;
            this.catchMail(s, '有信,我看看', s.meta.color);
          }
        } else {
          s.act = 'stand';
          if (s.goal === 'pantry') s.standUntil = now + 3 + Math.random() * 2;
        }
      }
      return;
    }
    if (s.act === 'stand') {
      if (s.goal === 'meeting') s.look = s.pos.x < TABLE.x ? 1 : -1;
      if (now > s.standUntil) {
        if (s.goal === 'pantry') s.carry = true;
        s.look = 0;
        this.goHome(s);
      }
      return;
    }
    // 坐着
    if (this.reduced) return;
    const st = s.data.status;
    // 看鼠标
    if (this.cursor) {
      const dx = this.cursor.x - s.pos.x;
      const dy = this.cursor.y - (s.pos.y - 14);
      if (Math.hypot(dx, dy) < 90 && now > s.lookUntil) s.look = Math.abs(dx) < 6 ? 0 : dx < 0 ? -1 : 1;
      else if (now > s.lookUntil) s.look = 0;
    } else if (now > s.lookUntil) s.look = 0;
    if (now > s.nextIdle) {
      s.nextIdle = now + 7 + Math.random() * 14;
      if (s.data.task || st === 'stuck') return;
      const r = Math.random();
      const pantryBusy = [...this.agents.values()].some((o) => o !== s && o.goal === 'pantry' && o.act !== 'seated');
      if ((st === 'idle' || st === 'waiting') && r < 0.28 && !pantryBusy && this.meetingActive <= 0) this.goToPantry(s);
      else if (r < 0.6 && st !== 'working') s.stretchUntil = now + 1.4;
      else {
        s.look = Math.random() < 0.5 ? -1 : 1;
        s.lookUntil = now + 1 + Math.random();
      }
    }
  }

  isTyping(s: AgentSim): boolean {
    return s.act === 'seated' && s.data.status === 'working' && this.now > s.stretchUntil && this.now > s.hopUntil;
  }

  order(): AgentSim[] {
    return ROLE_ORDER.map((r) => this.agents.get(r)!).filter(Boolean);
  }

  petRoll(): void {
    this.petRollUntil = this.now + 2.4;
    this.bubbles.set('__pet', { key: `pet${++this.seq}`, role: '__pet', text: '哈~欠', until: this.now + 2.2, tone: 'say', anchor: { x: SOFA.x - 16, y: SOFA.y - 26 } });
  }
}

export function computeWeather(s: FloorSnapshot): Weather {
  const m = s.market;
  const pnl = Number(s.money.pnl_today);
  const hour = m?.utc_hour ?? new Date().getUTCHours();
  const night = hour < 6 || hour >= 18;
  const vol = m?.volatility_1h_pct ?? 0;
  const rain = vol >= 2.5;
  const thunder = vol >= 4;
  const alarm = m?.risk_level === 'high' || !!s.halted;
  const fireworks = !rain && pnl > 0;
  const parts: string[] = [];
  if (thunder) parts.push(`在打雷:BTC 1 小时波动 ${vol.toFixed(1)}%`);
  else if (rain) parts.push(`在下雨:BTC 1 小时波动 ${vol.toFixed(1)}%`);
  else parts.push(`天气晴:1 小时波动只有 ${vol.toFixed(1)}%`);
  if (fireworks) parts.push(`今天赚了 ${s.money.pnl_today} U,放点烟花`);
  if (alarm) parts.push(s.halted ? '紧急停止中:警报灯在转' : '风控等级 high:警报灯在转');
  parts.push(night ? `UTC ${hour} 点,夜景` : `UTC ${hour} 点,白天`);
  return { rain, thunder, alarm, fireworks, night, explain: parts.join(' · ') };
}

function short(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
