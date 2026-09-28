// Workflow settings (docs/demo/v2-agent-loop.md §2): the one object the user edits from the UI.
// Bounds are enforced here so neither the UI nor the chat tool can push the loop somewhere silly.

import { CLI_COMMAND_MAX_CHARS, CLI_NAMES, defaultCliCommands, type CliName } from './cli-launch.js';
import { DEFAULT_ACTIVE_STRATEGIES } from './strategies.js';
import { DEFAULT_FUNNEL_SYMBOLS } from './funnel.js';
import { PROTECTION_TTL_DAYS_BOUNDS, PROTECTION_TTL_DAYS_DEFAULT } from './protection.js';
import { DEFAULT_FOLLOW_SETTINGS, normalizeFollowSettings } from './trader-follow.js';
import { DEFAULT_EXECUTION_THRESHOLDS, EXECUTION_NUMERIC_BOUNDS, LEGACY_EXECUTION_DEFAULTS, STOP_FLOOR_ATR_TFS, executionThresholds } from './execution-policy.js';
import { TIERS, type AgentCliKind, type Backend, type BrainKind, type CliCommandsView, type Tier, type TierPolicy, type Workflow } from './types.js';

declare module './types.js' { interface Workflow { research_daily_cap?: { model_calls: number; fetches: number } } }
// §9.52 判断要素(Decisions API)的日花费闸,美元;超了 DecisionClient 抛 decision_budget_exhausted。
declare module './types.js' { interface Workflow { decision_daily_usd_cap?: number } }
// §9.56 只暂停 AI 扫盘(不再扫新机会、扫完的也不开仓);paused 是全停,策略运行不受这个开关影响。
declare module './types.js' { interface Workflow { ai_scan_paused?: boolean } }

export const DEFAULT_PLAYBOOK = [
  '突破-回踩(单一策略,v3):',
  '- 适用:交易方向与 1h 趋势一致(EMA20 与 EMA50 同向),且 4h 不是明显反向趋势(4h 反向时只允许限价挂回踩位、信心 ≤ 0.5);价格刚突破 20 根高/低点,或回踩 EMA20 站稳。',
  '- 入场两种形态:①回踩已确认(最近一根收在突破位之上/之下,量比 ≥ 1.0)→ 市价;②突破刚发生、回踩还没来 → PROPOSE 一个限价 entry_zone 挂在突破位到 EMA20 之间,等它回来(不成交按所选策略 horizon 的复查周期等待,长线不因下一根短线波动撤单)。不要因为"还没回踩"就只 WATCH——挂限价就是等回踩的方式。',
  '- 不追:距离 20 根高/低点已超过 1.5 个 ATR 的位置不追;资金费率绝对值 > 0.05% 且与方向同侧时降低信心。',
  '- NO_TRADE 条件:1h 与 4h 明显反向(4h 价格在 EMA20/EMA50 的另一侧且距离 > 1 ATR);价格夹在 EMA20 与 EMA50 之间震荡;ATR% < 0.4%(没波动);信息员标了高相关的风险事件在 2 小时内。',
  '- 日线状态(代码算的证据):bear 时不做多突破(只允许做空或 NO_TRADE),bull 时不做空突破;range 时突破要求量比 ≥ 1.5;volatile 时止损至少 1.2 ATR。',
  '- 交易时段:美股开盘窗口(开盘后 15 分钟内)不追单,等第一根 15m 收盘再判断;周末流动性差,只做回踩确认过的入场。',
  '- 急拉急跌触发(fast_move):先判断是不是新闻驱动(看信息员证据),没有新闻的急拉急跌大概率均值回归,不追;有新闻且与 1h 趋势同向才考虑回踩入场。',
  '- 失效:收盘跌回突破位另一侧,或触及止损。',
  '- 止损放在最近结构位(swing 低/高)之外,至少 1%(波动大的币按规则里的 ATR 下限放得更宽);第一止盈至少是止损距离的 1.5 倍,可给第二止盈。',
  '- 有持仓时:论点未变 → HOLD;触及失效条件 → EXIT;浮盈超过 1 倍止损距离且结构转弱 → REDUCE;演示版不允许 ADD。',
  '- 挂单等待中:结构没坏 → HOLD;结构坏了或价格已远离入场区 → INVALIDATE(撤单)。',
].join('\n');

/** 09-27 之前的出厂 playbook。库里存的和它逐字相同 = 没人改过,迁移到新默认;改过的不动。 */
export const LEGACY_DEFAULT_PLAYBOOK_V3 = [
  '突破-回踩(单一策略,v3):',
  '- 适用:交易方向与 1h 趋势一致(EMA20 与 EMA50 同向),且 4h 不是明显反向趋势(4h 反向时只允许限价挂回踩位、信心 ≤ 0.5);价格刚突破 20 根高/低点,或回踩 EMA20 站稳。',
  '- 入场两种形态:①回踩已确认(最近一根收在突破位之上/之下,量比 ≥ 1.0)→ 市价;②突破刚发生、回踩还没来 → PROPOSE 一个限价 entry_zone 挂在突破位到 EMA20 之间,等它回来(不成交按所选策略 horizon 的复查周期等待,长线不因下一根短线波动撤单)。不要因为"还没回踩"就只 WATCH——挂限价就是等回踩的方式。',
  '- 不追:距离 20 根高/低点已超过 1.5 个 ATR 的位置不追;资金费率绝对值 > 0.05% 且与方向同侧时降低信心。',
  '- NO_TRADE 条件:1h 与 4h 明显反向(4h 价格在 EMA20/EMA50 的另一侧且距离 > 1 ATR);价格夹在 EMA20 与 EMA50 之间震荡;ATR% < 0.4%(没波动);信息员标了高相关的风险事件在 2 小时内。',
  '- 日线状态(代码算的证据):bear 时不做多突破(只允许做空或 NO_TRADE),bull 时不做空突破;range 时突破要求量比 ≥ 1.5;volatile 时止损至少 1.2 ATR。',
  '- 交易时段:美股开盘窗口(开盘后 15 分钟内)不追单,等第一根 15m 收盘再判断;周末流动性差,只做回踩确认过的入场。',
  '- 急拉急跌触发(fast_move):先判断是不是新闻驱动(看信息员证据),没有新闻的急拉急跌大概率均值回归,不追;有新闻且与 1h 趋势同向才考虑回踩入场。',
  '- 失效:收盘跌回突破位另一侧,或触及止损。',
  '- 止损放在最近 swing 低/高之外(至少 0.8 ATR),第一止盈至少 1.5 倍止损距离,可给第二止盈。',
  '- 有持仓时:论点未变 → HOLD;触及失效条件 → EXIT;浮盈超过 1 倍止损距离且结构转弱 → REDUCE;演示版不允许 ADD。',
  '- 挂单等待中:结构没坏 → HOLD;结构坏了或价格已远离入场区 → INVALIDATE(撤单)。',
].join('\n');

/**
 * 09-12 §2:分层配额的出厂值 —— **全 0 / 空 = 不额外限制**。
 * 新闸的默认必须是「什么也不改」;Jacky 在设置页里把数字填上去,分层才真正生效。
 */
export const DEFAULT_TIER_POLICY: TierPolicy = {
  max_open_threads: 0,
  max_opens_per_day: 0,
  entry_styles: [],
  council_min_agree: 0,
  allocator_slots: 0,
};

export function defaultTierPolicies(): Record<Tier, TierPolicy> {
  return { short: { ...DEFAULT_TIER_POLICY }, mid: { ...DEFAULT_TIER_POLICY }, long: { ...DEFAULT_TIER_POLICY } };
}

export const DEFAULT_WORKFLOW: Workflow = {
  markets: ['perp'], default_market: 'perp',
  watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
  watch_only: [],
  timeframe: '15m',
  info_every_ms: 30 * 60_000,
  risk_pct: '0.5',
  sizing_agent: 'apply',
  leverage: 3,
  margin_mode: 'cross',
  max_open_threads: 3,
  max_opens_per_day: 4,
  daily_loss_stop_pct: '3',
  // §9.56 执行层止损/净RR 阈值(原来写死在 gates.ts / 持仓计划里);所有机会来源共用。
  stop_floor_mode: DEFAULT_EXECUTION_THRESHOLDS.stop_floor_mode,
  stop_floor_atr_tf: DEFAULT_EXECUTION_THRESHOLDS.stop_floor_atr_tf,
  min_stop_pct: DEFAULT_EXECUTION_THRESHOLDS.min_stop_pct,
  max_stop_pct: DEFAULT_EXECUTION_THRESHOLDS.max_stop_pct,
  min_stop_atr: DEFAULT_EXECUTION_THRESHOLDS.min_stop_atr,
  min_net_rr: DEFAULT_EXECUTION_THRESHOLDS.min_net_rr,
  auto_approve: true,
  // 没接模型时不调用任何模型:用户在 Model connections 里接上自己的模型、给角色绑定后才会真正调用
  brain: 'stub',
  cheap_brain: 'stub',
  brain_model: null,
  cheap_brain_model: null,
  playbook_text: DEFAULT_PLAYBOOK,
  paused: false,
  ai_scan_paused: false,
  narrate: true,
  chat_requires_approval: false,
  scan_mode: 'triggered',
  heartbeat_every_ms: 30 * 60_000,
  invalidation_confirm_bars: 2,
  invalidation_buffer_atr: 0.2,
  fast_move_pct: '0.8',
  review_every_close: false,
  // Overwritten at boot by main.ts with the backend it actually constructed (see DemoRuntime.bootExecution).
  execution: 'paper',
  exec_agent_cli: 'claude',
  // Explicit, not "the CLI default": sonnet is the cheap one, and every write op is one CLI run.
  exec_agent_model: 'sonnet',
  daily_judgment_cap: 300,
  lab_autopilot: true,
  strategy_discovery: false,
  screener_enabled: true,
  screener_short_every_ms: 12 * 3_600_000,
  screener_swing_every_ms: 72 * 3_600_000,
  screener_universe: 'watchlist+whitelist',
  screener_symbols: [],
  screener_whitelist: [...DEFAULT_FUNNEL_SYMBOLS],
  screener_max_symbols: 60,
  screener_use_brain: true,
  screener_apply: 'propose',
  screener_expectancy: false,
  watchlist_max: 60, // 可调,见 WORKFLOW_BOUNDS.watchlist_max;每多一个币 = 多一份心跳/收盘判断的钱(09-06 放开:原 8/上限 24)
  // Boot default per CLI: TG_DEMO_CLI_CLAUDE / _CODEX / _PI, else the bare name (cli-launch.ts).
  cli_commands: defaultCliCommands(),
  active_strategies: [...DEFAULT_ACTIVE_STRATEGIES],
  // 09-12 §9.35:默认 manual —— 自动换票池会改钱的开关,先让人显式打开。
  active_mode: 'manual',
  strategy_council: 'advise',
  council_min_agree: 2,
  council_model: 'off',
  entry_style: 'prefer_limit',
  entry_max_wait_bars: 8,
  tier_policy: defaultTierPolicies(),
  research_daily_cap: { model_calls: 20, fetches: 100 },
  decision_daily_usd_cap: 2,
  event_blackout_min: 0, // 09-12 事件区:0 = 事件封锁闸关闭(默认)
  protection_ttl_days: PROTECTION_TTL_DAYS_DEFAULT,
  protection_auto_verify_per_day: 0, // 09-12 P1-04:A 阶段默认无自动真钱金丝雀额度(只告警)
  // 09-12 跟单 session:出厂 enabled=false、名册空 —— 不拉 bridge、不跑任何跟单链路。
  follow: { ...DEFAULT_FOLLOW_SETTINGS, subscriptions: {} },
  updated_at: 0,
};

export const WORKFLOW_BOUNDS = {
  watchlist_max: [1, 300] as const,
  timeframes: ['1m', '3m', '5m', '15m', '30m', '1h', '4h'],
  info_every_ms: [2 * 60_000, 6 * 3_600_000] as const,
  // 执行层数值边界的唯一来源是 execution-policy.ts(§9.56 PATCH /api/execution-policy 与这里同一份)
  risk_pct: [EXECUTION_NUMERIC_BOUNDS.risk_pct.min, EXECUTION_NUMERIC_BOUNDS.risk_pct.max] as const,
  leverage: [EXECUTION_NUMERIC_BOUNDS.leverage.min, EXECUTION_NUMERIC_BOUNDS.leverage.max] as const,
  max_open_threads: [EXECUTION_NUMERIC_BOUNDS.max_open_threads.min, EXECUTION_NUMERIC_BOUNDS.max_open_threads.max] as const,
  max_opens_per_day: [EXECUTION_NUMERIC_BOUNDS.max_opens_per_day.min, EXECUTION_NUMERIC_BOUNDS.max_opens_per_day.max] as const,
  daily_loss_stop_pct: [EXECUTION_NUMERIC_BOUNDS.daily_loss_stop_pct.min, EXECUTION_NUMERIC_BOUNDS.daily_loss_stop_pct.max] as const,
  min_stop_pct: [EXECUTION_NUMERIC_BOUNDS.min_stop_pct.min, EXECUTION_NUMERIC_BOUNDS.min_stop_pct.max] as const,
  max_stop_pct: [EXECUTION_NUMERIC_BOUNDS.max_stop_pct.min, EXECUTION_NUMERIC_BOUNDS.max_stop_pct.max] as const,
  min_stop_atr: [EXECUTION_NUMERIC_BOUNDS.min_stop_atr.min, EXECUTION_NUMERIC_BOUNDS.min_stop_atr.max] as const,
  min_net_rr: [EXECUTION_NUMERIC_BOUNDS.min_net_rr.min, EXECUTION_NUMERIC_BOUNDS.min_net_rr.max] as const,
  playbook_max_chars: 4000,
  heartbeat_every_ms: [5 * 60_000, 4 * 3_600_000] as const,
  invalidation_confirm_bars: [1, 5] as const,
  invalidation_buffer_atr: [0, 1] as const,
  fast_move_pct: [0.2, 5] as const,
  /** 0 = unlimited; the upper bound is a guard against a fat-fingered 30000. */
  daily_judgment_cap: [0, 5000] as const,
  cli_command_max_chars: CLI_COMMAND_MAX_CHARS,
  active_strategies_max: 4,
  council_min_agree: [1, 4] as const,
  protection_ttl_days: PROTECTION_TTL_DAYS_BOUNDS,
  protection_auto_verify_per_day: [0, 5] as const,
  entry_max_wait_bars: [2, 48] as const,
  /** 0 = 关闭;上限 6 小时,再长就等于把这个币停了。 */
  event_blackout_min: [0, 360] as const,
  /** 分层配额(每个字段 0 = 继承全局 / 不限)。上界只是防手滑,不是策略判断。 */
  tier_policy: {
    max_open_threads: [0, 6] as const,
    max_opens_per_day: [0, 12] as const,
    council_min_agree: [0, 4] as const,
    allocator_slots: [0, 4] as const,
  },
};

/** 分层配额里允许出现的入场方式。 */
export const TIER_ENTRY_STYLES: readonly ('market' | 'limit')[] = ['market', 'limit'];

/**
 * 一份 tier_policy 的 fail-closed 规范化:缺字段 / 手改坏 / 越界 → 回默认(= 不限),
 * **不回一个更松的数**。老库里没有这个字段时也走这里。
 */
export function normalizeTierPolicies(raw: unknown): Record<Tier, TierPolicy> {
  const out = defaultTierPolicies();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const tier of TIERS) {
    const p = src[tier];
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const o = p as Record<string, unknown>;
    const num = (key: 'max_open_threads' | 'max_opens_per_day' | 'council_min_agree' | 'allocator_slots'): number => {
      const [lo, hi] = WORKFLOW_BOUNDS.tier_policy[key];
      const n = Number(o[key]);
      return Number.isInteger(n) && n >= lo && n <= hi ? n : DEFAULT_TIER_POLICY[key];
    };
    const styles = Array.isArray(o['entry_styles'])
      ? [...new Set((o['entry_styles'] as unknown[]).map(String))].filter((s): s is 'market' | 'limit' => (TIER_ENTRY_STYLES as string[]).includes(s))
      : [];
    out[tier] = {
      max_open_threads: num('max_open_threads'),
      max_opens_per_day: num('max_opens_per_day'),
      entry_styles: styles,
      council_min_agree: num('council_min_agree'),
      allocator_slots: num('allocator_slots'),
    };
  }
  return out;
}

/** Strategy ids are file-name-ish on purpose: they end up in prompts, tags and route paths. */
export const STRATEGY_ID_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** Rough model calls per hour for the UI / logs (docs/demo/v3-ui-contract.md §1). */
export function estimateCallsPerHour(w: Workflow): { min: number; max: number } {
  const tfMin = Math.max(1, tfMinutes(w.timeframe));
  const n = w.watchlist.length;
  if (w.scan_mode === 'every_close') {
    const per = n * (60 / tfMin);
    return { min: Math.round(per), max: Math.round(per) };
  }
  const heartbeat = n * (60 / Math.max(5, w.heartbeat_every_ms / 60_000));
  return { min: Math.round(heartbeat), max: Math.round(heartbeat + n * 4) };
}

function tfMinutes(tf: string): number {
  const m = /^(\d+)([mh])$/.exec(tf);
  if (!m) return 15;
  return Number(m[1]) * (m[2] === 'h' ? 60 : 1);
}

export const BRAINS: BrainKind[] = ['pi', 'claude', 'codex', 'stub'];
/** Execution backends the workflow may name (docs/demo/v3-ui-contract.md §9.6). */
export const BACKENDS: Backend[] = ['paper', 'demo', 'cli', 'agent_mcp', 'mcp', 'okx'];

/**
 * 某个交易所下真正可见/可选的通道(docs/design/okx-atk-2026-09-20.md §5)。
 * okx 模式只留 paper 与 okx:Binance 的四条通道连注册都不注册,列出来只会让人点了报错。
 * 校验仍用全量 BACKENDS —— 切过交易所的旧 workflow 里可能存着另一边的通道名,不该当成非法值炸掉。
 */
export function backendsFor(exchange: 'okx' | 'binance'): Backend[] {
  return exchange === 'okx' ? ['paper', 'okx'] : ['paper', 'demo', 'cli', 'agent_mcp', 'mcp'];
}
export const AGENT_CLIS: AgentCliKind[] = ['claude', 'codex'];
/** Model ids are passed to a CLI as an argument: keep them to a conservative charset. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export function applyWorkflowPatch(current: Workflow, patch: Record<string, unknown>): { next: Workflow; errors: string[] } {
  const errors: string[] = [];
  const next: Workflow = { ...current };
  const clampNum = (v: unknown, [lo, hi]: readonly [number, number], field: string): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      errors.push(`${field} 必须是数字`);
      return null;
    }
    return Math.min(hi, Math.max(lo, n));
  };
  if ('watchlist' in patch) {
    const raw = patch['watchlist'];
    if (!Array.isArray(raw)) errors.push('watchlist 必须是数组');
    else {
      const list = [...new Set(raw.map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z0-9]{2,20}USDT$/.test(s)))];
      if (list.length === 0) errors.push('watchlist 至少一个 USDT 永续,如 BTCUSDT');
      else next.watchlist = list.slice(0, next.watchlist_max);
    }
  }
  if ('timeframe' in patch) {
    const tf = String(patch['timeframe']);
    if (!WORKFLOW_BOUNDS.timeframes.includes(tf)) errors.push(`timeframe 只能是 ${WORKFLOW_BOUNDS.timeframes.join('/')}`);
    else next.timeframe = tf;
  }
  if ('info_every_ms' in patch) {
    const v = clampNum(patch['info_every_ms'], WORKFLOW_BOUNDS.info_every_ms, 'info_every_ms');
    if (v !== null) next.info_every_ms = Math.round(v);
  }
  if ('risk_pct' in patch) {
    const v = clampNum(patch['risk_pct'], WORKFLOW_BOUNDS.risk_pct, 'risk_pct');
    if (v !== null) next.risk_pct = String(Math.round(v * 100) / 100);
  }
  if ('leverage' in patch) {
    const v = clampNum(patch['leverage'], WORKFLOW_BOUNDS.leverage, 'leverage');
    if (v !== null) next.leverage = Math.round(v);
  }
  if ('margin_mode' in patch) {
    if (patch['margin_mode'] !== 'cross' && patch['margin_mode'] !== 'isolated') errors.push('margin_mode 只能是 cross/isolated');
    else next.margin_mode = patch['margin_mode'];
  }
  if ('max_open_threads' in patch) {
    const v = clampNum(patch['max_open_threads'], WORKFLOW_BOUNDS.max_open_threads, 'max_open_threads');
    if (v !== null) next.max_open_threads = Math.round(v);
  }
  if ('max_opens_per_day' in patch) {
    const v = clampNum(patch['max_opens_per_day'], WORKFLOW_BOUNDS.max_opens_per_day, 'max_opens_per_day');
    if (v !== null) next.max_opens_per_day = Math.round(v);
  }
  if ('daily_loss_stop_pct' in patch) {
    const v = clampNum(patch['daily_loss_stop_pct'], WORKFLOW_BOUNDS.daily_loss_stop_pct, 'daily_loss_stop_pct');
    if (v !== null) next.daily_loss_stop_pct = String(Math.round(v * 10) / 10);
  }
  // §9.56 执行层止损/净RR 阈值:越界报错不静默钳(用户以为设上了 0.1% 其实被钳成 0.2%,比报错更糟)。
  for (const f of ['min_stop_pct', 'max_stop_pct', 'min_stop_atr', 'min_net_rr'] as const) {
    if (!(f in patch)) continue;
    const [lo, hi] = WORKFLOW_BOUNDS[f];
    const n = Number(patch[f]);
    if (patch[f] === null || patch[f] === '' || typeof patch[f] === 'boolean' || !Number.isFinite(n) || n < lo || n > hi) errors.push(`${f} 需在 ${lo}–${hi}${f === 'min_stop_atr' ? '(0 = 关闭)' : ''}`);
    else next[f] = Math.round(n * 1000) / 1000;
  }
  if ('stop_floor_mode' in patch) {
    if (patch['stop_floor_mode'] !== 'pct' && patch['stop_floor_mode'] !== 'atr') errors.push('stop_floor_mode 只能是 pct / atr');
    else next.stop_floor_mode = patch['stop_floor_mode'];
  }
  if ('stop_floor_atr_tf' in patch) {
    const tf = patch['stop_floor_atr_tf'];
    if (typeof tf !== 'string' || !(STOP_FLOOR_ATR_TFS as readonly string[]).includes(tf)) errors.push(`stop_floor_atr_tf 只能是 ${STOP_FLOOR_ATR_TFS.join(' / ')}`);
    else next.stop_floor_atr_tf = tf as Workflow['stop_floor_atr_tf'];
  }
  if (('min_stop_pct' in patch || 'max_stop_pct' in patch) && !((next.min_stop_pct ?? DEFAULT_EXECUTION_THRESHOLDS.min_stop_pct) < (next.max_stop_pct ?? DEFAULT_EXECUTION_THRESHOLDS.max_stop_pct))) {
    errors.push('min_stop_pct 必须小于 max_stop_pct');
    next.min_stop_pct = current.min_stop_pct;
    next.max_stop_pct = current.max_stop_pct;
  }
  if ('auto_approve' in patch) {
    if (typeof patch['auto_approve'] !== 'boolean') errors.push('auto_approve 必须是布尔');
    else next.auto_approve = patch['auto_approve'];
  }
  for (const f of ['brain', 'cheap_brain'] as const) {
    if (f in patch) {
      const b = patch[f];
      if (typeof b !== 'string' || !BRAINS.includes(b as BrainKind)) errors.push(`${f} 只能是 ${BRAINS.join('/')}`);
      else next[f] = b as BrainKind;
    }
  }
  for (const f of ['brain_model', 'cheap_brain_model'] as const) {
    if (f in patch) {
      const m = patch[f];
      if (m === null || m === '' || m === undefined) next[f] = null;
      else if (typeof m !== 'string' || !MODEL_ID_RE.test(m.trim())) errors.push(`${f} 只能是模型 id(字母数字 . _ : / -,≤ 80 字符),如 zai/glm-5.3 或 sonnet`);
      else next[f] = m.trim();
    }
  }
  if ('playbook_text' in patch) {
    const t = patch['playbook_text'];
    if (typeof t !== 'string') errors.push('playbook_text 必须是字符串');
    else next.playbook_text = t.slice(0, WORKFLOW_BOUNDS.playbook_max_chars);
  }
  // ---- v7 失效确认(用户在界面改;agent 只能看,记忆里的偏好当证据)
  if ('invalidation_confirm_bars' in patch) {
    const n = Number(patch['invalidation_confirm_bars']);
    if (!Number.isInteger(n) || n < WORKFLOW_BOUNDS.invalidation_confirm_bars[0] || n > WORKFLOW_BOUNDS.invalidation_confirm_bars[1]) errors.push('invalidation_confirm_bars 需在 1–5');
    else next.invalidation_confirm_bars = n;
  }
  if ('invalidation_buffer_atr' in patch) {
    const v = clampNum(patch['invalidation_buffer_atr'], WORKFLOW_BOUNDS.invalidation_buffer_atr, 'invalidation_buffer_atr');
    if (v !== null) next.invalidation_buffer_atr = Math.round(v * 100) / 100;
  }
  // ---- screener (Radar) fields
  for (const f of ['screener_enabled', 'screener_use_brain', 'screener_expectancy', 'lab_autopilot'] as const) {
    if (f in patch) {
      if (typeof patch[f] !== 'boolean') errors.push(`${f} 必须是布尔`);
      else next[f] = patch[f] as boolean;
    }
  }
  for (const f of ['screener_short_every_ms', 'screener_swing_every_ms'] as const) {
    if (f in patch) {
      const n = Number(patch[f]);
      if (!Number.isFinite(n) || n < 3_600_000 || n > 30 * 24 * 3_600_000) errors.push(`${f} 需在 1 小时到 30 天之间(毫秒)`);
      else next[f] = Math.round(n);
    }
  }
  if ('screener_max_symbols' in patch) {
    const n = Number(patch['screener_max_symbols']);
    if (!Number.isInteger(n) || n < 1 || n > 300) errors.push('screener_max_symbols 需在 1–300');
    else next.screener_max_symbols = n;
  }
  if ('screener_universe' in patch) {
    const u = patch['screener_universe'];
    if (u !== 'watchlist+whitelist' && u !== 'top_volume' && u !== 'explicit' && u !== 'okx_all') errors.push('screener_universe 只能是 watchlist+whitelist / top_volume / explicit / okx_all');
    else next.screener_universe = u;
  }
  if ('screener_apply' in patch) {
    const a = patch['screener_apply'];
    if (a !== 'propose' && a !== 'auto') errors.push('screener_apply 只能是 propose / auto');
    else next.screener_apply = a;
  }
  if ('screener_symbols' in patch) {
    const raw = patch['screener_symbols'];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) errors.push('screener_symbols 必须是字符串数组');
    else next.screener_symbols = [...new Set(raw.map((x) => (x as string).trim().toUpperCase()).filter(Boolean))].slice(0, 300);
  }
  if ('screener_whitelist' in patch) {
    const raw = patch['screener_whitelist'];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) errors.push('screener_whitelist 必须是字符串数组');
    else next.screener_whitelist = [...new Set(raw.map((x) => (x as string).trim().toUpperCase()).filter(Boolean))].slice(0, 300);
  }
  if ('watchlist_max' in patch) {
    const n = Number(patch['watchlist_max']);
    if (!Number.isInteger(n) || n < WORKFLOW_BOUNDS.watchlist_max[0] || n > WORKFLOW_BOUNDS.watchlist_max[1]) errors.push(`watchlist_max 需在 ${WORKFLOW_BOUNDS.watchlist_max[0]}–${WORKFLOW_BOUNDS.watchlist_max[1]}`);
    else {
      next.watchlist_max = n;
      if (next.watchlist.length > n) next.watchlist = next.watchlist.slice(0, n);
    }
  }
  if ('watch_only' in patch) {
    const raw = patch['watch_only'];
    if (!Array.isArray(raw)) errors.push('watch_only 必须是数组');
    else next.watch_only = [...new Set(raw.map((s) => String(s).trim().toUpperCase()).filter((s) => next.watchlist.includes(s)))];
  }
  // watchlist 变了,watch_only 只保留还在名单里的
  next.watch_only = (next.watch_only ?? []).filter((s) => next.watchlist.includes(s));
  if ('paused' in patch) {
    if (typeof patch['paused'] !== 'boolean') errors.push('paused 必须是布尔');
    else next.paused = patch['paused'];
  }
  if ('ai_scan_paused' in patch) {
    if (typeof patch['ai_scan_paused'] !== 'boolean') errors.push('ai_scan_paused 必须是布尔');
    else next.ai_scan_paused = patch['ai_scan_paused'];
  }
  if ('narrate' in patch) {
    if (typeof patch['narrate'] !== 'boolean') errors.push('narrate 必须是布尔');
    else next.narrate = patch['narrate'];
  }
  if ('chat_requires_approval' in patch) {
    if (typeof patch['chat_requires_approval'] !== 'boolean') errors.push('chat_requires_approval 必须是布尔');
    else next.chat_requires_approval = patch['chat_requires_approval'];
  }
  if ('scan_mode' in patch) {
    if (patch['scan_mode'] !== 'triggered' && patch['scan_mode'] !== 'every_close') errors.push('scan_mode 只能是 triggered/every_close');
    else next.scan_mode = patch['scan_mode'];
  }
  if ('heartbeat_every_ms' in patch) {
    const v = clampNum(patch['heartbeat_every_ms'], WORKFLOW_BOUNDS.heartbeat_every_ms, 'heartbeat_every_ms');
    if (v !== null) next.heartbeat_every_ms = Math.round(v);
  }
  if ('fast_move_pct' in patch) {
    const v = clampNum(patch['fast_move_pct'], WORKFLOW_BOUNDS.fast_move_pct, 'fast_move_pct');
    if (v !== null) next.fast_move_pct = String(Math.round(v * 100) / 100);
  }
  if ('review_every_close' in patch) {
    if (typeof patch['review_every_close'] !== 'boolean') errors.push('review_every_close 必须是布尔');
    else next.review_every_close = patch['review_every_close'];
  }
  if ('execution' in patch) {
    const b = patch['execution'];
    if (typeof b !== 'string' || !BACKENDS.includes(b as Backend)) errors.push(`execution 只能是 ${BACKENDS.join('/')}`);
    else next.execution = b as Backend;
  }
  if ('exec_agent_cli' in patch) {
    const c = patch['exec_agent_cli'];
    if (typeof c !== 'string' || !AGENT_CLIS.includes(c as AgentCliKind)) errors.push(`exec_agent_cli 只能是 ${AGENT_CLIS.join('/')}`);
    else next.exec_agent_cli = c as AgentCliKind;
  }
  if ('exec_agent_model' in patch) {
    const m = patch['exec_agent_model'];
    if (m === null || m === '' || m === undefined) next.exec_agent_model = null;
    else if (typeof m !== 'string' || !MODEL_ID_RE.test(m.trim())) errors.push('exec_agent_model 只能是模型 id(字母数字 . _ : / -,≤ 80 字符),如 sonnet 或 gpt-5.4');
    else next.exec_agent_model = m.trim();
  }
  // 09-12 §1.1 假设生成(每周 ≤1 次便宜大脑调用)。默认关:它会往策略库里加东西,先让人看过再开。
  if ('strategy_discovery' in patch) {
    if (typeof patch['strategy_discovery'] !== 'boolean') errors.push('strategy_discovery 必须是布尔');
    else next.strategy_discovery = patch['strategy_discovery'];
  }
  if ('sizing_agent' in patch) {
    if (typeof patch['sizing_agent'] === 'string' && ['off', 'advise', 'apply'].includes(patch['sizing_agent'])) next.sizing_agent = patch['sizing_agent'] as Workflow['sizing_agent'];
    else errors.push('sizing_agent 必须为 off / advise / apply');
  }
  if ('active_strategies' in patch) {
    const raw = patch['active_strategies'];
    if (!Array.isArray(raw)) errors.push('active_strategies 必须是数组');
    else {
      const list = [...new Set(raw.map((x) => String(x).trim()))];
      const bad = list.filter((x) => !STRATEGY_ID_RE.test(x));
      if (bad.length) errors.push(`active_strategies 里不是合法策略 id:${bad.join(', ')}`);
      // 库里存不存在、够不够 paper 由 routes-strategies.ts / buildContext 前的 resolve() 把关(这里是纯函数)。
      else next.active_strategies = list.slice(0, WORKFLOW_BOUNDS.active_strategies_max);
    }
  }
  // ---- 09-12 §9.35 策略自动轮换
  if ('active_mode' in patch) {
    const m = patch['active_mode'];
    if (m === 'manual' || m === 'auto') next.active_mode = m;
    else errors.push('active_mode 只能是 manual / auto');
  }
  // ---- 09-09 策略议会
  if ('strategy_council' in patch) {
    const m = patch['strategy_council'];
    if (m === 'off' || m === 'advise' || m === 'require') next.strategy_council = m;
    else errors.push('strategy_council 只能是 off / advise / require');
  }
  if ('council_model' in patch) {
    const m = patch['council_model'];
    if (m === 'off' || m === 'cheap' || m === 'main') next.council_model = m;
    else errors.push('council_model 只能是 off / cheap / main');
  }
  // ---- 09-12 跟单 session(trader-follow.ts)。整块替换:传进来的那份过 normalizeFollowSettings
  // (fail-closed 回默认,不回一个更松的数);**凭证不走这条路**(env 或 kv `follow.credentials`)。
  if ('follow' in patch) {
    const raw = patch['follow'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push('follow 必须是对象');
    else {
      const merged = { ...next.follow, ...(raw as Record<string, unknown>) };
      // traders / thresholds 是**整块替换**(前端改一个带单员时要把整份 traders 发上来),
      // 不做逐键合并 —— 半合并会让「删掉一个带单员」永远删不掉。
      next.follow = normalizeFollowSettings(merged);
      if ((raw as Record<string, unknown>)['api_key'] !== undefined || (raw as Record<string, unknown>)['secret_token'] !== undefined) {
        errors.push('bridge 凭证不通过 workflow 保存(用 POST /api/follow 的 credentials 字段)');
      }
    }
  }

  if ('protection_auto_verify_per_day' in patch) {
    const n = Number(patch['protection_auto_verify_per_day']);
    if (!Number.isInteger(n) || n < WORKFLOW_BOUNDS.protection_auto_verify_per_day[0] || n > WORKFLOW_BOUNDS.protection_auto_verify_per_day[1]) errors.push(`protection_auto_verify_per_day 需在 ${WORKFLOW_BOUNDS.protection_auto_verify_per_day[0]}–${WORKFLOW_BOUNDS.protection_auto_verify_per_day[1]} 的整数(0 = 不自动跑真钱金丝雀)`);
    else next.protection_auto_verify_per_day = n;
  }
  if ('protection_ttl_days' in patch) {
    const n = Number(patch['protection_ttl_days']);
    if (!Number.isInteger(n) || n < WORKFLOW_BOUNDS.protection_ttl_days[0] || n > WORKFLOW_BOUNDS.protection_ttl_days[1]) errors.push(`protection_ttl_days 需在 ${WORKFLOW_BOUNDS.protection_ttl_days[0]}–${WORKFLOW_BOUNDS.protection_ttl_days[1]} 天的整数`);
    else next.protection_ttl_days = n;
  }
  if ('council_min_agree' in patch) {
    const n = Number(patch['council_min_agree']);
    if (!Number.isInteger(n) || n < WORKFLOW_BOUNDS.council_min_agree[0] || n > WORKFLOW_BOUNDS.council_min_agree[1]) errors.push('council_min_agree 需在 1–4');
    else next.council_min_agree = n;
  }
  // ---- 09-09 入场方式与挂单耐心
  if ('entry_style' in patch) {
    const v = patch['entry_style'];
    if (v === 'free' || v === 'prefer_limit' || v === 'limit_only') next.entry_style = v;
    else errors.push('entry_style 只能是 free / prefer_limit / limit_only');
  }
  if ('entry_max_wait_bars' in patch) {
    const n = Number(patch['entry_max_wait_bars']);
    if (!Number.isInteger(n) || n < WORKFLOW_BOUNDS.entry_max_wait_bars[0] || n > WORKFLOW_BOUNDS.entry_max_wait_bars[1]) errors.push('entry_max_wait_bars 需在 2–48');
    else next.entry_max_wait_bars = n;
  }
  // 09-12 事件区:0 = 关闭;越界报错而不是静默钳,省得用户以为自己设上了 600 分钟。
  if ('research_daily_cap' in patch) {
    const c = patch['research_daily_cap'] as { model_calls?: unknown; fetches?: unknown } | null;
    if (!c || !Number.isInteger(c.model_calls) || !Number.isInteger(c.fetches) || Number(c.model_calls) < 0 || Number(c.model_calls) > 20 || Number(c.fetches) < 0 || Number(c.fetches) > 100) errors.push('research_daily_cap: model_calls 0–20，fetches 0–100');
    else next.research_daily_cap = { model_calls: Number(c.model_calls), fetches: Number(c.fetches) };
  }
  if ('decision_daily_usd_cap' in patch) {
    const n = Number(patch['decision_daily_usd_cap']);
    // 越界报错不静默钳:0 = 当天不再调判断要素;上限 100 美元防手滑。
    if (patch['decision_daily_usd_cap'] === null || !Number.isFinite(n) || n < 0 || n > 100) errors.push('decision_daily_usd_cap 需在 0–100(美元)');
    else next.decision_daily_usd_cap = n;
  }
  if ('event_blackout_min' in patch) {
    const n = Number(patch['event_blackout_min']);
    if (!Number.isInteger(n) || n < WORKFLOW_BOUNDS.event_blackout_min[0] || n > WORKFLOW_BOUNDS.event_blackout_min[1]) errors.push('event_blackout_min 需在 0–360(0 = 关闭)');
    else next.event_blackout_min = n;
  }
  // ---- 09-12 §2 分层配额(只做部分合并:传 { short: { max_opens_per_day: 2 } } 只改这一格)
  if ('tier_policy' in patch) {
    const raw = patch['tier_policy'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push('tier_policy 必须是对象,如 {"short":{"max_opens_per_day":2}}');
    else {
      const merged: Record<Tier, TierPolicy> = normalizeTierPolicies(current.tier_policy);
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!(TIERS as string[]).includes(k)) {
          errors.push(`tier_policy.${k} 不认识,只能是 ${TIERS.join('/')}`);
          continue;
        }
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          errors.push(`tier_policy.${k} 必须是对象`);
          continue;
        }
        const tier = k as Tier;
        const o = v as Record<string, unknown>;
        const next: TierPolicy = { ...merged[tier] };
        for (const f of ['max_open_threads', 'max_opens_per_day', 'council_min_agree', 'allocator_slots'] as const) {
          if (!(f in o)) continue;
          const [lo, hi] = WORKFLOW_BOUNDS.tier_policy[f];
          const n = Number(o[f]);
          if (!Number.isInteger(n) || n < lo || n > hi) errors.push(`tier_policy.${tier}.${f} 需在 ${lo}–${hi} 的整数(0 = 继承全局/不限)`);
          else next[f] = n;
        }
        if ('entry_styles' in o) {
          const list = o['entry_styles'];
          if (!Array.isArray(list) || list.some((x) => !(TIER_ENTRY_STYLES as string[]).includes(String(x)))) errors.push(`tier_policy.${tier}.entry_styles 只能是 ${TIER_ENTRY_STYLES.join('/')} 的数组(空 = 不限)`);
          else next.entry_styles = [...new Set(list.map(String))] as ('market' | 'limit')[];
        }
        merged[tier] = next;
      }
      next.tier_policy = merged;
    }
  }
  if ('daily_judgment_cap' in patch) {
    const v = clampNum(patch['daily_judgment_cap'], WORKFLOW_BOUNDS.daily_judgment_cap, 'daily_judgment_cap');
    if (v !== null) next.daily_judgment_cap = Math.round(v);
  }
  if ('cli_commands' in patch) {
    const raw = patch['cli_commands'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) errors.push('cli_commands 必须是对象,如 {"claude":"claudeproxy"}');
    else {
      const merged: CliCommandsView = { ...current.cli_commands };
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!(CLI_NAMES as string[]).includes(k)) {
          errors.push(`cli_commands.${k} 不认识,只能是 ${CLI_NAMES.join('/')}`);
          continue;
        }
        const name = k as CliName;
        const err = cliCommandError(v);
        if (err) errors.push(`cli_commands.${name} ${err}`);
        else merged[name] = String(v).trim();
      }
      next.cli_commands = merged;
    }
  }
  next.updated_at = Date.now();
  if (patch['markets'] !== undefined) {
    if (Array.isArray(patch['markets']) && patch['markets'].length && patch['markets'].every(m => m === 'spot' || m === 'perp')) next.markets = [...new Set(patch['markets'])] as Workflow['markets'];
    else errors.push('invalid_markets');
  }
  if (patch['default_market'] !== undefined) {
    if (patch['default_market'] === 'spot' || patch['default_market'] === 'perp') next.default_market = patch['default_market'];
    else errors.push('invalid_market');
  }
  if (!next.markets.includes(next.default_market)) errors.push('default_market_not_enabled');
  return { next, errors };
}

/** null = accepted. A launch command is one line of shell: non-empty, bounded, no newlines. */
export function cliCommandError(v: unknown): string | null {
  if (typeof v !== 'string') return '必须是字符串';
  const t = v.trim();
  if (!t) return '不能为空(默认就写 CLI 名字,如 claude)';
  if (t.length > CLI_COMMAND_MAX_CHARS) return `太长(最多 ${CLI_COMMAND_MAX_CHARS} 字符)`;
  if (/[\r\n]/.test(v)) return '只能是一行,不能有换行';
  return null;
}

export function loadWorkflow(json: string | undefined): Workflow {
  if (!json) return { ...DEFAULT_WORKFLOW, updated_at: Date.now() };
  try {
    const parsed = JSON.parse(json) as Partial<Workflow>;
    // cli_commands landed after some DBs were written, and a hand-edited one may be partial: merge
    // per key so a missing CLI still gets its default instead of `undefined` reaching spawn().
    const cli = { ...DEFAULT_WORKFLOW.cli_commands, ...(typeof parsed.cli_commands === 'object' && parsed.cli_commands ? parsed.cli_commands : {}) };
    for (const n of CLI_NAMES) if (cliCommandError(cli[n])) cli[n] = DEFAULT_WORKFLOW.cli_commands[n];
    const ttl = Number(parsed.protection_ttl_days);
    return {
      ...DEFAULT_WORKFLOW,
      ...parsed,
      markets: Array.isArray(parsed.markets) && parsed.markets.length && parsed.markets.every(m => m === 'spot' || m === 'perp') ? [...new Set(parsed.markets)] : ['perp'],
      default_market: parsed.default_market === 'spot' && parsed.markets?.includes('spot') ? 'spot' : 'perp',
      sizing_agent: parsed.sizing_agent === undefined ? 'apply' : ['off', 'advise', 'apply'].includes(parsed.sizing_agent) ? parsed.sizing_agent : 'advise', // 缺字段按拍板默认生效;乱值 fail-closed 回只建议
      // 手改过 / 老库里可能是别的字符串:票池的自动开关必须 fail closed 回 manual。
      active_mode: parsed.active_mode === 'auto' ? 'auto' : 'manual',
      ai_scan_paused: parsed.ai_scan_paused === true,
      // 老库没有这个字段 / 手改坏了:分层配额必须 fail-closed 回「不额外限制」,而不是回一个乱数。
      tier_policy: normalizeTierPolicies(parsed.tier_policy),
      // §9.56 老库没有这几个字段或者值被改坏了,就用默认值,不会换成更宽松的数。
      ...(() => { const th = executionThresholds(parsed); return { stop_floor_mode: th.stop_floor_mode, stop_floor_atr_tf: th.stop_floor_atr_tf, min_stop_pct: th.min_stop_pct, max_stop_pct: th.max_stop_pct, min_stop_atr: th.min_stop_atr, min_net_rr: th.min_net_rr }; })(),
      // 手改过的库里可能是 0 / 字符串 / 缺字段:凭证有效期必须是合法天数,否则凭证永不过期或立刻全部过期。
      protection_ttl_days: Number.isInteger(ttl) && ttl >= PROTECTION_TTL_DAYS_BOUNDS[0] && ttl <= PROTECTION_TTL_DAYS_BOUNDS[1] ? ttl : PROTECTION_TTL_DAYS_DEFAULT,
      // 手改过的库里缺这个字段 = 没有授权过自动真钱金丝雀:按 0 兜底,不继承一个不存在的额度。
      protection_auto_verify_per_day: Number.isInteger(Number(parsed.protection_auto_verify_per_day)) && Number(parsed.protection_auto_verify_per_day) >= 0 && Number(parsed.protection_auto_verify_per_day) <= 5 ? Number(parsed.protection_auto_verify_per_day) : 0,
      cli_commands: cli,
      // 老库没有这个字段 / 手改坏了:跟单设置 fail-closed 回「关闭 + 空名册」。
      follow: normalizeFollowSettings(parsed.follow),
    };
  } catch {
    return { ...DEFAULT_WORKFLOW, updated_at: Date.now() };
  }
}

/**
 * 09-27 一次性迁移(启动时 runtime 调一次,改了就存库并记活动日志)。评审站和 18811 的 workflow 是整份存过的,
 * 改代码里的默认值管不到它们:
 *  - 库里 min_stop_pct 恰好是旧默认 0.3、又没有 stop_floor_mode(= 这个字段上线之前存的,没人动过)→ 改成 1.0;
 *    min_stop_atr 恰好是旧默认 0.5 的同样改成 1.0(它的含义也从「工作周期 ATR」改成了「所选周期 ATR」)。人改过的值不动。
 *  - playbook_text 和旧出厂 playbook 逐字相同 → 换成新默认;改过一个字都不动。
 * 迁移后 stop_floor_mode 会被存成 pct,下次启动不会再触发。
 */
export function migrateWorkflowJson(json: string | undefined): { changes: { key: string; from: unknown; to: unknown }[] } {
  if (!json) return { changes: [] };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(json) as Record<string, unknown>; } catch { return { changes: [] }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { changes: [] };
  const changes: { key: string; from: unknown; to: unknown }[] = [];
  if (parsed['stop_floor_mode'] === undefined) {
    if (parsed['min_stop_pct'] === LEGACY_EXECUTION_DEFAULTS.min_stop_pct) changes.push({ key: 'min_stop_pct', from: LEGACY_EXECUTION_DEFAULTS.min_stop_pct, to: DEFAULT_EXECUTION_THRESHOLDS.min_stop_pct });
    if (parsed['min_stop_atr'] === LEGACY_EXECUTION_DEFAULTS.min_stop_atr) changes.push({ key: 'min_stop_atr', from: LEGACY_EXECUTION_DEFAULTS.min_stop_atr, to: DEFAULT_EXECUTION_THRESHOLDS.min_stop_atr });
  }
  if (parsed['playbook_text'] === LEGACY_DEFAULT_PLAYBOOK_V3) changes.push({ key: 'playbook_text', from: 'legacy_default_v3', to: 'default' });
  return { changes };
}

/** 按 migrateWorkflowJson 的结论改一份已加载的 workflow。 */
export function applyWorkflowMigration(w: Workflow, changes: { key: string }[]): Workflow {
  const next = { ...w };
  for (const c of changes) {
    if (c.key === 'min_stop_pct') next.min_stop_pct = DEFAULT_EXECUTION_THRESHOLDS.min_stop_pct;
    if (c.key === 'min_stop_atr') next.min_stop_atr = DEFAULT_EXECUTION_THRESHOLDS.min_stop_atr;
    if (c.key === 'playbook_text') next.playbook_text = DEFAULT_PLAYBOOK;
  }
  if (changes.some((c) => c.key === 'min_stop_pct' || c.key === 'min_stop_atr')) next.stop_floor_mode = next.stop_floor_mode ?? 'pct';
  return next;
}

/** `workflow.tier_policy` → allocator 要的每层名额(0 的层直接不写,等于不限)。 */
export function tierSlotsOf(w: Workflow): Partial<Record<Tier, number>> {
  const policies = normalizeTierPolicies(w.tier_policy);
  const out: Partial<Record<Tier, number>> = {};
  for (const tier of TIERS) if (policies[tier].allocator_slots > 0) out[tier] = policies[tier].allocator_slots;
  return out;
}

/** 某一层的生效配额(老库/手改坏的库照样给出默认那份)。 */
export function tierPolicyOf(w: Workflow, tier: Tier): TierPolicy {
  return normalizeTierPolicies(w.tier_policy)[tier];
}
