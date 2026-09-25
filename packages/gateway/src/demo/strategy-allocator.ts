/**
 * 策略自动轮换 allocator(设计 §4;契约 docs/demo/v3-ui-contract.md §9.35)。
 *
 * 背景(内部评审记录 §4 第 7 条):策略闭环 v2 能把一条策略自动推到
 * paper,但**推到 paper 之后没人把它放进票池**——agent 实际上永远只跑 breakout_retest。这个缺口
 * 「不能靠把模型直接接 setWorkflow 弥补」:票池是钱的开关,只能由代码按可复核的规则决定。
 *
 * 所以这里是一套**纯函数**决策:进什么、出什么、为什么,每一条都能用一句话解释,并且
 * 每一次变更都逐条写 `strategy_events`(who='code')。模型在这条路径上一个字都插不进来。
 *
 * 决策顺序(§9.35):
 *   候选(paper+ 且健康) → 按 regime 分桶的 30 天 net 期望降序 → 每族最多 1 条 → 相关票去重
 *   → 最短驻留 3 天(健康问题除外) → 冷却 1 天 → 取前 active_strategies_max 条。
 *
 * 本文件不做 I/O、不看时钟(`now` 由调用方传);落库与告警在 {@link runAllocator} 里,它只用 store。
 */

import { createHash } from 'node:crypto';
import type { DemoStore } from './store.js';
import { degradeDecision, realizedRFromThreads, type StrategyEvent } from './strategy-loop.js';
import { evidenceOf, strategyForBackend, FAMILY_LABEL, type StrategyFamily, type StrategySpec, type StrategyStatus } from './strategies.js';
import { TIER_LABEL, TIER_OF, type DailyRegimeKind, type Tier } from './types.js';

export const ALLOCATOR_VERSION = 'alloc-v1';

/** 进了票池至少待这么多天才允许被 allocator 换下去(退化不受此限,永远立刻出池)。 */
export const ALLOCATOR_MIN_TENURE_DAYS = 3;
/** 被 allocator 换下去之后这么多天内不许再自动进池(人工启用不受此限)。 */
export const ALLOCATOR_COOLDOWN_DAYS = 1;
/** auto 模式下两次决策的最短间隔(每天一次)。 */
export const ALLOCATOR_INTERVAL_MS = 24 * 3_600_000;

const DAY_MS = 24 * 3_600_000;

/** kv 键:上一票池(回滚用)、上次跑/上次变更的时刻、上次理由。 */
export const ALLOCATOR_KV = {
  previous: 'allocator.previous_pool',
  lastRunAt: 'allocator.last_run_at',
  lastChangeAt: 'allocator.last_change_at',
  lastReason: 'allocator.last_reason',
} as const;

/** 期望值取自哪一档(前端必须显示:不能让用户把毛值当净值看)。 */
export type ExpectancySource =
  /** §9.32 无偏回放里**当前 regime 桶**的净期望(最好的一档) */
  | 'regime_net'
  /** §9.32 全样本净期望 `lab.net.expectancy_r` */
  | 'net'
  /** §9.32 样本外净期望 `lab.oos_net_expectancy` */
  | 'oos_net'
  /** 一个数都没有 */
  | 'none';

export const EXPECTANCY_SOURCE_LABEL: Record<ExpectancySource, string> = {
  regime_net: '本 regime 净期望',
  net: '净期望',
  oos_net: '样本外净期望',
  none: '无数据',
};

/**
 * daily regime(`bull/bear/range/volatile`)→ 回放统计的 regime 桶(`trend/range/high_vol`,
 * 见 replay-stats.ts `summarizeReplay`)。以前 allocator 直接拿 `bull` 去查桶,而回放**从来不写**
 * 这个键,于是「按 regime 选策略」这件事一次都没真的发生过(永远静默退到全样本)。
 */
export const REGIME_BUCKET: Record<DailyRegimeKind, 'trend' | 'range' | 'high_vol'> = {
  bull: 'trend',
  bear: 'trend',
  range: 'range',
  volatile: 'high_vol',
};

/** Lab 成绩超过这么多天没更新就只算「旧证据」:能留在池里,不能凭它新进池。 */
export const ALLOCATOR_STALE_DAYS = 30;
/** 新进池至少要这么多个**有效样本**(4h 簇均值口径,与 replay-stats 的 effective_n 同源)。 */
export const ALLOCATOR_MIN_EFFECTIVE_N = 30;

export type AllocatorBlock = 'status' | 'health' | 'evidence' | 'family_taken' | 'correlated' | 'tier_slot' | 'cooldown' | 'rank' | null;

export interface AllocatorCandidate {
  id: string;
  name: string;
  family: StrategyFamily;
  family_label: string;
  version: number;
  status: StrategyStatus;
  /** 09-12 §2:这条策略属于哪一层(短/中/长)。 */
  tier: Tier;
  /** 决策**之后**在不在票池。 */
  in_pool: boolean;
  /** 状态与健康都过关(= 有资格参与排序)。 */
  eligible: boolean;
  expectancy_r: number | null;
  expectancy_source: ExpectancySource;
  n: number | null;
  healthy: boolean;
  health_reason: string;
  correlation_key: string;
  blocked_by: AllocatorBlock;
  /** 一句话:为什么在 / 为什么不在。前端直接显示这一句。 */
  reason: string;
}

export interface AllocatorChange {
  id: string;
  reason: string;
}

export interface AllocatorDecision {
  version: string;
  at: number;
  mode: ActiveMode;
  regime: DailyRegimeKind | null;
  changed: boolean;
  from: string[];
  to: string[];
  add: AllocatorChange[];
  remove: AllocatorChange[];
  keep: AllocatorChange[];
  reason: string;
}

export type ActiveMode = 'manual' | 'auto';

export interface AllocatorInputs {
  now: number;
  mode: ActiveMode;
  /** 当前票池(workflow.active_strategies)。 */
  active: readonly string[];
  /**
   * 候选策略的**生效版本 × backend 视角**(不是 head raw)。调用方用
   * `strategies.resolve(ids, { allow_below_paper: false, backend })` 拿:head 是个还在回测的新版本时,
   * 生效的仍然是那一版 paper —— 读 head raw status 会把「v2 在回测」误判成「这条策略没到 paper」,
   * 于是把正在跑的 v1 从票池里清掉(09-12 复审 allocator 缺口 1)。
   */
  specs: readonly StrategySpec[];
  /** 票池最多几条(WORKFLOW_BOUNDS.active_strategies_max)。 */
  max: number;
  /** 分桶用的日线状态;null = 不分桶,用全样本。 */
  regime: DailyRegimeKind | null;
  /** (策略 id, 生效版本)→ 这条策略**已结算**交易的 R(从旧到新),用来判健康。 */
  realized_r: (id: string, version: number) => readonly number[];
  /** 策略 id → 它进入当前票池的时刻(ms);拿不到 = 不知道 → 按「刚进」保守处理(不许换下)。 */
  entered_at: (id: string) => number | null;
  /** 策略 id → 它上一次被 allocator 换下去的时刻(ms);null = 没被换下过。 */
  removed_at: (id: string) => number | null;
  /**
   * 09-12 §2:每层名额(`workflow.tier_policy[tier].allocator_slots`)。
   * **不传 / 某层为 0 = 该层不限**,与分层上线之前逐字同一个行为。
   * 判定插在「每族 1 条 / 相关票去重」之后、驻留/冷却/容量之前:先决定哪些够格排队,再谈谁留下。
   */
  tier_slots?: Partial<Record<Tier, number>>;
}

// ---------------------------------------------------------------- 小工具

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * 相关票去重键:看同一批证据、被同一批触发器唤醒的两条策略,在议会里**不是两票,是一票投两次**。
 * 键 = 证据指标 (id@tf#params) 排序 ∪ trigger.kinds 排序 的 sha1 前 12 位。
 */
export function correlationKey(spec: StrategySpec): string {
  const ev = evidenceOf(spec);
  const inds = ev.indicators
    .map((i) => `${i.id}@${i.tf}#${i.params ? JSON.stringify(Object.fromEntries(Object.keys(i.params).sort().map((k) => [k, i.params![k]!]))) : ''}`)
    .sort();
  const kinds = [...spec.trigger.kinds].sort();
  return createHash('sha1').update(JSON.stringify({ inds, kinds })).digest('hex').slice(0, 12);
}

/**
 * 这条策略(**这个版本**)可用的净期望,按 regime → 全样本 → 样本外逐档取。
 *
 * 09-12 回归修复:字段名对齐新的回放形状(`lab.net.expectancy_r`、
 * `lab.regime.{trend,range,high_vol}.net_expectancy`,见 replay-stats.ts `summarizeReplay`),
 * regime 键按 {@link REGIME_BUCKET} 从 daily regime 映射过来;**毛值那一档(`lab_stats.expectancy_r`)
 * 直接删掉** —— 没扣费的数字不能决定钱往哪走。
 *
 * 另外给两个「证据质量」标记(不改数字,只改它有没有资格**新进**票池):
 *  - `stale`:`lab.at` 超过 {@link ALLOCATOR_STALE_DAYS} 天没更新;
 *  - `insufficient`:没有数,或有效样本 < {@link ALLOCATOR_MIN_EFFECTIVE_N}。
 */
export function expectancyFor(
  spec: StrategySpec,
  regime: DailyRegimeKind | null,
  now?: number,
): { value: number | null; source: ExpectancySource; n: number | null; stale: boolean; insufficient: boolean; note: string } {
  const lab = (spec.lab_stats ?? null) as (Record<string, unknown> & { n?: number; at?: number }) | null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? round4(v) : null);
  const nOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const ageDays = lab && typeof lab.at === 'number' && now !== undefined ? (now - lab.at) / DAY_MS : null;
  const stale = ageDays !== null && ageDays > ALLOCATOR_STALE_DAYS;
  const done = (value: number | null, source: ExpectancySource, n: number | null): ReturnType<typeof expectancyFor> => {
    const insufficient = value === null || n === null || n < ALLOCATOR_MIN_EFFECTIVE_N;
    const notes: string[] = [];
    if (insufficient) notes.push(value === null ? '没有净期望数据' : `有效样本 ${n ?? 0} < ${ALLOCATOR_MIN_EFFECTIVE_N}`);
    if (stale) notes.push(`Lab 成绩已 ${Math.floor(ageDays!)} 天没更新(>${ALLOCATOR_STALE_DAYS} 天)`);
    return { value, source, n, stale, insufficient, note: notes.join(';') };
  };
  if (!lab) return done(null, 'none', null);
  if (regime) {
    const buckets = lab['regime'];
    if (buckets && typeof buckets === 'object' && !Array.isArray(buckets)) {
      const b = (buckets as Record<string, unknown>)[REGIME_BUCKET[regime]];
      if (b && typeof b === 'object') {
        const v = num((b as Record<string, unknown>)['net_expectancy']);
        if (v !== null) return done(v, 'regime_net', nOf((b as Record<string, unknown>)['n']));
      }
    }
  }
  const net = lab['net'];
  if (net && typeof net === 'object') {
    const v = num((net as Record<string, unknown>)['expectancy_r']);
    if (v !== null) return done(v, 'net', nOf(lab['effective_n']) ?? nOf(lab.n));
  }
  const oos = num(lab['oos_net_expectancy']);
  if (oos !== null) return done(oos, 'oos_net', nOf(lab['oos_n']));
  return done(null, 'none', nOf(lab['effective_n']) ?? nOf(lab.n));
}

/** `paper` / `live_capped` 才有资格进票池(与 `resolve({allow_below_paper:false})` 同一口径)。 */
export function allocatable(status: StrategyStatus): boolean {
  return status === 'paper' || status === 'live_capped';
}

// ---------------------------------------------------------------- 决策(纯函数)

/**
 * 跑一次轮换决策。**纯函数**:不落库、不告警、不看时钟。`mode='manual'` 时照样算出完整决策
 * (前端要拿它当预览),但调用方不该应用它——应用与否由 {@link runAllocator} 按 mode 决定。
 */
export function allocatorDecide(inp: AllocatorInputs): { decision: AllocatorDecision; candidates: AllocatorCandidate[] } {
  const max = Math.max(1, Math.round(inp.max));
  const from = [...new Set(inp.active.map(String))];
  const byId = new Map(inp.specs.map((s) => [s.id, s]));

  type Row = {
    spec: StrategySpec;
    exp: ReturnType<typeof expectancyFor>;
    healthy: boolean;
    health_reason: string;
    key: string;
    blocked: AllocatorBlock;
    reason: string;
  };

  const rows: Row[] = inp.specs.map((spec) => {
    const d = degradeDecision(inp.realized_r(spec.id, spec.version));
    const exp = expectancyFor(spec, inp.regime, inp.now);
    return {
      spec,
      exp,
      healthy: !d.degrade,
      health_reason: d.reason,
      key: correlationKey(spec),
      blocked: null,
      reason: '',
    };
  });

  // 1. 候选门:状态 + 健康
  const eligible: Row[] = [];
  for (const r of rows) {
    if (!allocatable(r.spec.status)) {
      r.blocked = 'status';
      r.reason = `状态 ${r.spec.status},还没到 paper,不进票池`;
      continue;
    }
    if (!r.healthy) {
      r.blocked = 'health';
      r.reason = `已退化(${r.health_reason}),不进票池`;
      continue;
    }
    // 证据门(09-12 复审缺口 2):**只挡新进池**。没有合格净期望/成绩过期的策略不能靠一个 null
    // 排进票池;但已经在池里、又没退化的策略不因此被踢出去——那会让默认种子(v1 paper、还没跑过新
    // Lab)在第一次 auto 决策时就把票池清空,等于用「缺数据」停掉整条流水线。
    if (!from.includes(r.spec.id) && (r.exp.insufficient || r.exp.stale)) {
      r.blocked = 'evidence';
      r.reason = `证据不足以新进票池(${r.exp.note || '没有净期望数据'})`;
      continue;
    }
    eligible.push(r);
  }

  // 最短驻留没满、又健康的在池策略 = **本轮锁定**。锁定要在「每族 1 条 / 相关票去重」**之前**生效,
  // 否则一条同族或相关的新策略会在排序阶段就把它挤掉 —— 那等于绕过了驻留保护(换汤不换药的换人)。
  const lockedIn = (r: Row): boolean => {
    if (!from.includes(r.spec.id)) return false;
    const enteredAt = inp.entered_at(r.spec.id);
    return (inp.now - (enteredAt ?? inp.now)) / DAY_MS < ALLOCATOR_MIN_TENURE_DAYS;
  };

  // 2. 排序:锁定的在池策略优先占位,其余按期望降序,null 排最后;同分按 id 稳定排序(决策必须可复现)。
  eligible.sort((a, b) => {
    const la = lockedIn(a) ? 1 : 0;
    const lb = lockedIn(b) ? 1 : 0;
    if (la !== lb) return lb - la;
    const av = a.exp.value;
    const bv = b.exp.value;
    if (av === null && bv === null) return a.spec.id.localeCompare(b.spec.id);
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av || a.spec.id.localeCompare(b.spec.id);
  });

  const expText = (r: Row): string => (r.exp.value === null ? '没有期望数据' : `${EXPECTANCY_SOURCE_LABEL[r.exp.source]} ${r.exp.value.toFixed(2)}R${r.exp.n === null ? '' : `/${r.exp.n} 笔`}`);

  // 3–4. 每族最多 1 条 + 相关票去重
  const familyTaken = new Map<StrategyFamily, string>();
  const keyTaken = new Map<string, string>();
  const ranked: Row[] = [];
  for (const r of eligible) {
    const famOwner = familyTaken.get(r.spec.family);
    if (famOwner) {
      r.blocked = 'family_taken';
      r.reason = `同族(${FAMILY_LABEL[r.spec.family] ?? r.spec.family})已有 ${famOwner} 在排队,每族最多 1 条`;
      continue;
    }
    const keyOwner = keyTaken.get(r.key);
    if (keyOwner) {
      r.blocked = 'correlated';
      r.reason = `与 ${keyOwner} 看同一批证据(相关票),只留期望高的那条`;
      continue;
    }
    familyTaken.set(r.spec.family, r.spec.id);
    keyTaken.set(r.key, r.spec.id);
    ranked.push(r);
  }

  // 4b. 09-12 §2 按层名额。每层名额用完之后,该层排在后面的候选让位给别的层 ——
  // 否则一个短线爆发期会把中线/长线的位置全占掉,票池看起来满了,实际只押一个周期。
  // `tier_slots` 不传 / 某层 0 = 该层不限(默认行为逐字不变)。
  const tierUsed = new Map<Tier, string[]>();
  const tierRanked: Row[] = [];
  for (const r of ranked) {
    const tier = TIER_OF[r.spec.horizon];
    const slots = inp.tier_slots?.[tier] ?? 0;
    const used = tierUsed.get(tier) ?? [];
    if (slots > 0 && used.length >= slots) {
      r.blocked = 'tier_slot';
      r.reason = `${TIER_LABEL[tier]}层名额 ${slots} 个已被 ${used.join('/')} 占满`;
      continue;
    }
    tierUsed.set(tier, [...used, r.spec.id]);
    tierRanked.push(r);
  }

  // 5–7. 驻留 / 冷却 / 容量。先把「必须留下」的算出来,再用剩余容量按排名填。
  const forced: Row[] = []; // 最短驻留没满、又健康:不许换下去
  const fillable: Row[] = [];
  for (const r of tierRanked) {
    const inPool = from.includes(r.spec.id);
    if (inPool) {
      const enteredAt = inp.entered_at(r.spec.id);
      // 拿不到进池时刻 = 不知道待了多久,保守按「刚进」处理(宁可少换一次)。
      const tenureDays = enteredAt === null ? 0 : (inp.now - enteredAt) / DAY_MS;
      if (tenureDays < ALLOCATOR_MIN_TENURE_DAYS) {
        r.reason = `在池 ${tenureDays < 0 ? 0 : Math.floor(tenureDays)} 天,不满最短驻留 ${ALLOCATOR_MIN_TENURE_DAYS} 天,本轮不动`;
        forced.push(r);
        continue;
      }
      fillable.push(r);
      continue;
    }
    const removedAt = inp.removed_at(r.spec.id);
    if (removedAt !== null && inp.now - removedAt < ALLOCATOR_COOLDOWN_DAYS * DAY_MS) {
      r.blocked = 'cooldown';
      const hours = Math.max(0, Math.ceil((ALLOCATOR_COOLDOWN_DAYS * DAY_MS - (inp.now - removedAt)) / 3_600_000));
      r.reason = `刚被换下,冷却还剩 ${hours} 小时`;
      continue;
    }
    fillable.push(r);
  }

  const picked: Row[] = [...forced];
  for (const r of fillable) {
    if (picked.length >= max) {
      r.blocked = 'rank';
      r.reason = `排名不够(票池只有 ${max} 个位置);${expText(r)}`;
      continue;
    }
    picked.push(r);
  }
  // 驻留强留的条数就超了容量:超出部分按期望从低到高挤掉(容量是硬的,驻留不是)。
  if (picked.length > max) {
    const overflow = picked.slice(max);
    for (const r of overflow) {
      r.blocked = 'rank';
      r.reason = `票池只有 ${max} 个位置,期望更低被挤出;${expText(r)}`;
    }
    picked.length = max;
  }

  const to = picked.map((r) => r.spec.id);
  const add: AllocatorChange[] = [];
  const remove: AllocatorChange[] = [];
  const keep: AllocatorChange[] = [];
  for (const r of picked) {
    const line = r.reason || `${expText(r)},${FAMILY_LABEL[r.spec.family] ?? r.spec.family}族第 1 名`;
    r.reason = line;
    if (from.includes(r.spec.id)) keep.push({ id: r.spec.id, reason: line });
    else add.push({ id: r.spec.id, reason: line });
  }
  for (const id of from) {
    if (to.includes(id)) continue;
    const r = rows.find((x) => x.spec.id === id);
    const spec = byId.get(id);
    const why = r?.reason || (spec ? `不在本轮前 ${max} 名` : '库里已经没有这条策略');
    remove.push({ id, reason: why });
  }

  const candidates: AllocatorCandidate[] = rows
    .map((r) => ({
      id: r.spec.id,
      name: r.spec.name,
      family: r.spec.family,
      family_label: FAMILY_LABEL[r.spec.family] ?? r.spec.family,
      version: r.spec.version,
      status: r.spec.status,
      tier: TIER_OF[r.spec.horizon],
      in_pool: to.includes(r.spec.id),
      eligible: allocatable(r.spec.status) && r.healthy,
      expectancy_r: r.exp.value,
      expectancy_source: r.exp.source,
      n: r.exp.n,
      healthy: r.healthy,
      health_reason: r.health_reason,
      correlation_key: r.key,
      blocked_by: r.blocked,
      reason: r.reason || (to.includes(r.spec.id) ? `在票池:${expText(r)}` : '本轮没有入选'),
    }))
    .sort((a, b) => Number(b.in_pool) - Number(a.in_pool) || Number(b.eligible) - Number(a.eligible) || (b.expectancy_r ?? -99) - (a.expectancy_r ?? -99) || a.id.localeCompare(b.id));

  const changed = add.length > 0 || remove.length > 0;
  const reason = changed
    ? `${inp.regime ? `${inp.regime} 行情下,` : ''}进 ${add.map((x) => x.id).join('/') || '无'};出 ${remove.map((x) => x.id).join('/') || '无'};留 ${keep.map((x) => x.id).join('/') || '无'}`
    : `票池不变(${to.join('/') || '空'}):没有一条候选比在池的更好,或都卡在驻留/冷却上`;

  return {
    decision: { version: ALLOCATOR_VERSION, at: inp.now, mode: inp.mode, regime: inp.regime, changed, from, to, add, remove, keep, reason },
    candidates,
  };
}

// ---------------------------------------------------------------- 落库(store 侧,仍然零模型)

/**
 * 从台账推「这条策略是什么时候进当前票池的」。口径:最后一条 `activated` 之后没有 `deactivated`
 * 就是那条 `activated` 的时刻;找不到就返回 null(调用方按「刚进」保守处理)。
 */
export function enteredAtFrom(events: readonly StrategyEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'activated') return e.at;
    if (e.kind === 'deactivated') return null;
  }
  return null;
}

/** 从台账推「最后一次被 **allocator** 换下去」的时刻(人工停用不算冷却)。 */
export function removedAtFrom(events: readonly StrategyEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'activated') return null;
    if (e.kind === 'deactivated' && e.who === 'code') return e.at;
  }
  return null;
}

export interface AllocatorRunDeps {
  now?: number;
  /** 健康/状态都按这个通道读(§9.36:paper 资格只属于有证据的 backend)。默认 `paper`。 */
  backend?: string;
  /** 分桶用的日线状态(runtime 传主观察币的;拿不到 null)。 */
  regime?: DailyRegimeKind | null;
  max: number;
  mode: ActiveMode;
  active: readonly string[];
  /** 09-12 §2:每层名额(`workflow.tier_policy[tier].allocator_slots`);不传 = 不限。 */
  tier_slots?: Partial<Record<Tier, number>>;
  /** 只算预览、不落库(GET 端点用)。 */
  preview?: boolean;
  /** manual 模式下强制应用一次(人点了「现在算一遍」)。 */
  force?: boolean;
  realizedR?: (id: string, version: number) => readonly number[];
  log?: (level: 'info' | 'warn', message: string) => void;
}

export interface AllocatorRunResult {
  decision: AllocatorDecision;
  candidates: AllocatorCandidate[];
  /** 决策有没有被落下去(写台账 + 需要调用方 setWorkflow)。 */
  applied: boolean;
  /** applied 时的新票池;没应用时 = 原样。 */
  active: string[];
  /** 可回滚到的上一票池(applied 时 = 决策前那份)。 */
  previous: string[] | null;
  skipped_reason: string | null;
}

/**
 * 跑一次 allocator 并(按 mode)落库。**不自己改 workflow** —— 它把新票池放在
 * `result.active` 里交给 runtime/route 去 `setWorkflow`,免得这里也变成第二个写者。
 */
export function runAllocator(store: DemoStore, deps: AllocatorRunDeps): AllocatorRunResult {
  const now = deps.now ?? Date.now();
  const backend = deps.backend ?? 'paper';
  const realized = deps.realizedR ?? ((id: string, version: number) => realizedRFromThreads(store, id, version, backend));
  // 09-12 复审缺口 1/3:候选是**生效版本 × backend**,不是 head raw。`resolve` 会在 head 还没晋升时
  // 退回那一版 paper,`strategyForBackend` 再把状态/影子成绩换成这个通道的那份;两步都跳过的话,
  // allocator 看到的「状态」和 strategy-loop / 议会看到的根本不是同一个东西。
  const specs = store.strategies.list().map((head) => {
    const resolved = store.strategies.resolve([head.id], { allow_below_paper: false, backend }).specs[0];
    return resolved ?? strategyForBackend(head, backend);
  });
  const { decision, candidates } = allocatorDecide({
    now,
    mode: deps.mode,
    active: deps.active,
    specs,
    max: deps.max,
    regime: deps.regime ?? null,
    realized_r: realized,
    entered_at: (id) => enteredAtFrom(store.strategyEvents.timeline(id, 200)),
    removed_at: (id) => removedAtFrom(store.strategyEvents.timeline(id, 200)),
    tier_slots: deps.tier_slots,
  });

  const previous = readPrevious(store);
  const base: AllocatorRunResult = { decision, candidates, applied: false, active: [...deps.active], previous, skipped_reason: null };
  if (deps.preview) return { ...base, skipped_reason: '预览' };
  if (deps.mode !== 'auto' && !deps.force) return { ...base, skipped_reason: `active_mode=${deps.mode},allocator 不自动改票池` };
  if (!decision.changed) {
    store.kvSet(ALLOCATOR_KV.lastRunAt, String(now));
    return { ...base, skipped_reason: decision.reason };
  }
  applyDecision(store, decision, now);
  deps.log?.('info', `allocator:${decision.reason}`);
  return { ...base, applied: true, active: decision.to, previous: decision.from };
}

/** 把一次决策写进台账与 kv(不改 workflow —— 调用方负责)。 */
export function applyDecision(store: DemoStore, decision: AllocatorDecision, now: number): void {
  for (const c of decision.add) {
    const head = store.strategies.head(c.id);
    store.strategyEvents.append({ strategy_id: c.id, version: head?.version ?? 0, at: now, who: 'code', kind: 'activated', from_status: head?.status ?? null, to_status: head?.status ?? null, reason: `allocator:${c.reason}`, evidence: {} });
  }
  for (const c of decision.remove) {
    const head = store.strategies.head(c.id);
    store.strategyEvents.append({ strategy_id: c.id, version: head?.version ?? 0, at: now, who: 'code', kind: 'deactivated', from_status: head?.status ?? null, to_status: head?.status ?? null, reason: `allocator:${c.reason}`, evidence: {} });
  }
  store.kvSet(ALLOCATOR_KV.previous, JSON.stringify(decision.from));
  store.kvSet(ALLOCATOR_KV.lastRunAt, String(now));
  store.kvSet(ALLOCATOR_KV.lastChangeAt, String(now));
  store.kvSet(ALLOCATOR_KV.lastReason, decision.reason);
}

export function readPrevious(store: DemoStore): string[] | null {
  const raw = store.kvGet(ALLOCATOR_KV.previous);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

export function readNumberKv(store: DemoStore, key: string): number | null {
  const raw = store.kvGet(key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 回滚到上一票池。**不受**最短驻留/冷却约束:这是人的撤销键,不是一次新决策。
 * 返回 null = 没有可回滚的票池。
 */
export function rollbackAllocator(store: DemoStore, current: readonly string[], now = Date.now()): { active: string[]; previous: string[] } | null {
  const prev = readPrevious(store);
  if (!prev) return null;
  const cur = [...current];
  for (const id of prev) {
    if (cur.includes(id)) continue;
    const head = store.strategies.head(id);
    store.strategyEvents.append({ strategy_id: id, version: head?.version ?? 0, at: now, who: 'code', kind: 'activated', from_status: head?.status ?? null, to_status: head?.status ?? null, reason: 'allocator 回滚:换回上一票池', evidence: {} });
  }
  for (const id of cur) {
    if (prev.includes(id)) continue;
    const head = store.strategies.head(id);
    store.strategyEvents.append({ strategy_id: id, version: head?.version ?? 0, at: now, who: 'code', kind: 'deactivated', from_status: head?.status ?? null, to_status: head?.status ?? null, reason: 'allocator 回滚:换回上一票池', evidence: {} });
  }
  // 回滚之后「上一票池」= 回滚前那份,所以再点一次能滚回来。
  store.kvSet(ALLOCATOR_KV.previous, JSON.stringify(cur));
  store.kvSet(ALLOCATOR_KV.lastChangeAt, String(now));
  store.kvSet(ALLOCATOR_KV.lastReason, `回滚到上一票池(${prev.join('/') || '空'})`);
  return { active: prev, previous: cur };
}

/** auto 模式下,现在到没到下一次决策的时间(每天一次)。 */
export function allocatorDue(store: DemoStore, now = Date.now()): boolean {
  const last = readNumberKv(store, ALLOCATOR_KV.lastRunAt);
  return last === null || now - last >= ALLOCATOR_INTERVAL_MS;
}
