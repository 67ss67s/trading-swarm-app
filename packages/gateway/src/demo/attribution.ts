// 归因闭环(Jacky 的 agent 交易流程第 4–6 步:记录 → 归因 → 改机制 → 回测验证)。
//
// 一次回测跑完后,便宜大脑读这次的成交(入场/出场/R/MAE/MFE)、导致这些成交的判断、以及亏损单
// 当时的上下文,吐 ≤ 3 个「问题点位」。每个点位必须说清四件事:证据当时显示了什么、规则当时说了
// 什么、实际发生了什么、提议怎么改。提议是有类型的:改措辞 / 改参数(带 strategy_id + 参数名 +
// 落在 [min,max] 里的新值)/ 加清单项。
//
// 硬约束(design v1 §11「记忆不改数字」+ 决定稿 §2 F):
// - 归因只 propose,永不 apply。参数要变成现实,必须有人在界面上点「生成新版本」,落成 draft,
//   再一格一格晋升。
// - 每个点位同时写一条长期记忆提案(status=proposed),等人批准;不批准就永远不进上下文。

import { createHash, randomBytes } from 'node:crypto';
import type { Brain } from './brain.js';
import type { BacktestRun, BacktestStep, BacktestTrade } from './backtest.js';
import type { MemoryStore } from './memory.js';
import type { StrategySpec } from './strategies.js';
import { ACTIONS, DECISION_RECORD_VERSION, TIER_OF, tierOfTimeframe, type Action, type DecisionReasonCode, type DecisionRecord, type Direction, type Episode, type StrategyThread, type Tier } from './types.js';
import type { EntryStyle } from './entry-policy.js';

export type AttributionKind = 'rule_wording' | 'param' | 'checklist_item';

export interface AttributionProposal {
  kind: AttributionKind;
  strategy_id: string | null;
  /** kind='param' 时:参数名与提议值(值必须落在该参数的 [min,max] 内,否则整条被丢掉)。 */
  param?: string | null;
  value?: number | null;
  /** kind='rule_wording' / 'checklist_item' 时:提议的新措辞 / 新清单项。 */
  text: string;
}

export interface AttributionPoint {
  id: string;
  run_id: string;
  at: number;
  strategy_id: string | null;
  symbol: string | null;
  kind: AttributionKind;
  title: string;
  /** 证据当时显示了什么。 */
  evidence_said: string;
  /** 规则当时说了什么。 */
  rule_said: string;
  /** 实际发生了什么。 */
  actual: string;
  proposal: AttributionProposal;
  /** 对应的长期记忆提案 id(status=proposed)。 */
  memory_id: string | null;
  /** 人点了「生成新版本」后落在哪个版本上;null = 还没采纳。 */
  applied_version: number | null;
}

const aid = (): string => `attr-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

function fmtR(r: number | null | undefined): string {
  return r === null || r === undefined || !Number.isFinite(r) ? 'n/a' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

/** 从一条 step 的上下文里挑出模型看到的清单证据(不是整段 prompt——太长且大部分是重复的)。 */
function checklistOf(step: BacktestStep | undefined): string {
  const j = step?.judgment;
  if (!j) return '(无判断)';
  return `${j.headline};理由:${j.reasons.slice(0, 3).join(' | ')}`;
}

export function attributionPrompt(run: BacktestRun, steps: BacktestStep[], trades: BacktestTrade[], strategies: StrategySpec[]): { system: string; user: string } {
  const system = [
    '你是 trade-gate 的归因模块。你读一次回测的成交、导致它们的判断、以及亏损单当时的理由,找出最多 3 个「问题点位」。',
    '每个点位必须同时说清四件事:证据当时显示了什么(evidence_said)、规则当时说了什么(rule_said)、实际发生了什么(actual)、提议怎么改(proposal)。',
    '提议只能是三种类型之一:',
    '- "rule_wording":某条规则的措辞不够可判定,给出新措辞(text)。',
    '- "param":某个参数的值不合适,给 strategy_id、param(参数名)、value(新值,必须落在下面给出的 [min,max] 内)。',
    '- "checklist_item":代码清单里缺一项该算的东西,给出要加的那一项(text)。',
    '规则:只写这批成交里能直接看出来的问题,不要写通用常识;不要提议「多做/少做」这种没有可执行形态的改动;',
    '一次回测是单次采样,噪声底约 30%,所以不要因为一两笔亏损就提议大改参数——提议要说明它想修的是哪一类失败,而不是这一笔。',
    '没有值得提的就输出空数组。只输出 JSON 数组:',
    '[{"title":"≤20字","strategy_id":"…或null","symbol":"BTCUSDT或null","evidence_said":"…","rule_said":"…","actual":"…","proposal":{"kind":"rule_wording|param|checklist_item","strategy_id":"…或null","param":"…或null","value":数字或null,"text":"…"}}]',
  ].join('\n');

  const stepByIdx = new Map(steps.map((s) => [s.idx, s]));
  const lines: string[] = [];
  lines.push(`## 这次回测`);
  lines.push(`${run.symbol} ${run.timeframe} ${new Date(run.from_ms).toISOString().slice(0, 16)} → ${new Date(run.to_ms).toISOString().slice(0, 16)},模式 ${run.mode},大脑 ${run.brain},prompt ${run.prompt_version}`);
  const sm = run.summary;
  if (sm) lines.push(`判断 ${sm.judgments} 次(扫描 ${sm.scans}/复查 ${sm.reviews}),成交 ${sm.trades} 笔,胜率 ${sm.win_rate === null ? 'n/a' : `${(sm.win_rate * 100).toFixed(0)}%`},平均 ${fmtR(sm.avg_r)},累计 ${fmtR(sm.sum_r)},最大回撤 ${sm.max_drawdown_r.toFixed(2)}R`);

  lines.push('', '## 可以改的策略与参数范围');
  for (const s of strategies) {
    lines.push(`- ${s.id}(v${s.version},${s.name}):参数 ${Object.entries(s.params).map(([k, v]) => `${k}=${v.value}${v.unit ?? ''} 范围[${v.min}, ${v.max}]`).join(';') || '(无)'}`);
    lines.push(`  入场规则:${s.rules.entry.join(' ')}`);
    lines.push(`  失效规则:${s.rules.invalidation.join(' ')}`);
  }

  lines.push('', '## 成交(按时间)');
  for (const t of trades) {
    const st = stepByIdx.get(t.step_idx);
    lines.push(
      `- #${t.step_idx} ${new Date(t.proposed_at).toISOString().slice(5, 16).replace('T', ' ')} ${t.direction === 'long' ? '做多' : '做空'} ${t.entry}` +
        `,策略 ${st?.strategy_id ?? '未标注'},结果 ${t.status} ${fmtR(t.r)}(MAE ${fmtR(t.mae_r)} / MFE ${fmtR(t.mfe_r)},持有 ${t.bars_held ?? 'n/a'} 根),原因 ${t.close_reason}`,
    );
    lines.push(`  当时的判断:${checklistOf(st)}`);
  }
  if (!trades.length) lines.push('(这次没有成交)');

  const losers = trades.filter((t) => (t.r ?? 0) < 0).slice(0, 5);
  if (losers.length) {
    lines.push('', '## 亏损单当时看到的证据(节选)');
    for (const t of losers) {
      const st = stepByIdx.get(t.step_idx);
      lines.push(`- #${t.step_idx} ${fmtR(t.r)}:${st?.judgment?.thesis?.slice(0, 160) ?? '(无论点)'}`);
      if (st?.trigger) lines.push(`  触发:${st.trigger}`);
    }
  }

  const blocked = steps.filter((s) => s.outcome?.kind === 'blocked').slice(0, 5);
  if (blocked.length) {
    lines.push('', '## 被闸拦下的提议(可能说明规则和闸不一致)');
    for (const s of blocked) lines.push(`- #${s.idx} ${s.outcome?.detail ?? ''}`);
  }

  lines.push('', '只输出 JSON 数组,最多 3 条。');
  return { system, user: lines.join('\n') };
}

/** 解析模型输出;不合法的条目直接丢掉(参数越界的也丢),永远不抛。 */
export function parseAttribution(text: string, run: BacktestRun, strategies: StrategySpec[], now = Date.now()): AttributionPoint[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const byId = new Map(strategies.map((s) => [s.id, s]));
  const out: AttributionPoint[] = [];
  for (const x of arr) {
    if (out.length >= 3) break;
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const rawProposal = (o['proposal'] ?? {}) as Record<string, unknown>;
    const kind = rawProposal['kind'];
    if (kind !== 'rule_wording' && kind !== 'param' && kind !== 'checklist_item') continue;
    const sid = typeof o['strategy_id'] === 'string' && byId.has(o['strategy_id']) ? o['strategy_id'] : null;
    const pSid = typeof rawProposal['strategy_id'] === 'string' && byId.has(rawProposal['strategy_id'] as string) ? (rawProposal['strategy_id'] as string) : sid;
    const title = String(o['title'] ?? '').trim().slice(0, 40);
    if (!title) continue;
    const proposal: AttributionProposal = { kind, strategy_id: pSid, text: String(rawProposal['text'] ?? '').trim().slice(0, 300) };
    if (kind === 'param') {
      const spec = pSid ? byId.get(pSid) : null;
      const name = typeof rawProposal['param'] === 'string' ? rawProposal['param'] : '';
      const def = spec?.params[name];
      const v = Number(rawProposal['value']);
      // 参数提议必须指名道姓、落在范围内;否则这条整个丢掉,不留一个「大概想改点什么」的记录。
      if (!spec || !def || !Number.isFinite(v) || v < def.min || v > def.max) continue;
      proposal.param = name;
      proposal.value = v;
      if (!proposal.text) proposal.text = `${name}:${def.value}${def.unit ?? ''} → ${v}${def.unit ?? ''}`;
    } else if (!proposal.text) continue;
    out.push({
      id: aid(),
      run_id: run.id,
      at: now,
      strategy_id: pSid,
      symbol: typeof o['symbol'] === 'string' ? o['symbol'].toUpperCase() : run.symbol,
      kind,
      title,
      evidence_said: String(o['evidence_said'] ?? '').slice(0, 400),
      rule_said: String(o['rule_said'] ?? '').slice(0, 400),
      actual: String(o['actual'] ?? '').slice(0, 400),
      proposal,
      memory_id: null,
      applied_version: null,
    });
  }
  return out;
}

const KIND_LABEL: Record<AttributionKind, string> = { rule_wording: '规则措辞', param: '参数', checklist_item: '清单项' };

/** 一个问题点位 → 一条长期记忆提案的正文(≤ 300 字,memory.ts 会再截一次)。 */
export function attributionMemoryContent(a: AttributionPoint): string {
  const what = a.proposal.kind === 'param' ? `建议把 ${a.proposal.strategy_id ?? '?'} 的 ${a.proposal.param} 调到 ${a.proposal.value}` : `建议(${KIND_LABEL[a.proposal.kind]})${a.proposal.text}`;
  return `回测归因:${a.title}——证据显示「${a.evidence_said}」,规则说「${a.rule_said}」,实际「${a.actual}」;${what}(单次采样,噪声底 ~30%,未验证)`;
}

export interface AttributionDeps {
  brain: Brain;
  memory: MemoryStore;
  save: (a: AttributionPoint) => void;
  /**
   * 09-12 §1.3:`param` 类提案不再只进记忆——它**同时**进 Lab 探针队列,下一轮实验在同一份数据上
   * 验证一次,达标才由 labAutopilot 落成 draft 新版本。记忆那条仍然留着(它是给人读的教训),
   * 但「这个数字该不该改」从此由数据回答,不由人凭印象点采纳。
   */
  enqueueProbe?: (p: { strategy_id: string; param: string; value: number; source_ref: string }) => void;
  now?: number;
}

export interface AttributionResult {
  points: AttributionPoint[];
  raw: string;
  error: string | null;
}

/**
 * 跑一次归因:调便宜大脑 → 解析 → 每条落一行 demo_backtest_attribution + 一条 `proposed` 记忆。
 * 永远不修改策略、不批准记忆、不下单。
 */
export async function runAttribution(run: BacktestRun, steps: BacktestStep[], trades: BacktestTrade[], strategies: StrategySpec[], deps: AttributionDeps): Promise<AttributionResult> {
  const now = deps.now ?? Date.now();
  const { system, user } = attributionPrompt(run, steps, trades, strategies);
  let raw = '';
  try {
    const r = await deps.brain.complete(system, user, { timeoutMs: 180_000 });
    raw = r.text;
  } catch (e) {
    return { points: [], raw: '', error: (e as Error).message.slice(0, 300) };
  }
  const points = parseAttribution(raw, run, strategies, now);
  for (const a of points) {
    const { item } = deps.memory.propose({
      // 参数类提议是「这个数字可能不对」的校准记录;措辞/清单类是教训。
      kind: a.proposal.kind === 'param' ? 'calibration' : 'lesson',
      content: attributionMemoryContent(a),
      scope: { symbol: a.symbol ?? null },
      source_refs: [run.id],
      tags: [a.strategy_id ?? '', (a.symbol ?? '').toLowerCase(), 'backtest_attribution', a.proposal.kind].filter(Boolean),
      confidence: 0.4,
      proposed_by: 'agent',
      proposed_by_role: 'reviewer',
      now,
    });
    a.memory_id = item.id;
    deps.save(a);
    if (a.proposal.kind === 'param' && a.proposal.strategy_id && a.proposal.param && a.proposal.value !== null && a.proposal.value !== undefined) {
      deps.enqueueProbe?.({ strategy_id: a.proposal.strategy_id, param: a.proposal.param, value: a.proposal.value, source_ref: a.id });
    }
  }
  return { points, raw, error: null };
}

// ================================================================================================
// 09-12 §1 策略归因报告(确定性,零模型,零网络)
//
// 上面那半是「模型对一次回测的意见」(AttributionPoint,一行未动);下面这半是**代码对已结算实盘的账**。
// 同一个文件里两半同名不同物:上面 propose,下面只汇总。
//
// 设计:docs/design/attribution-and-tiers-2026-09-12.md §1。口径三条铁律:
//   1. 只吃 `settlementComplete === true` 的已平线程(和 judgment-ledger 同一条线);
//   2. 全是**净值**(含手续费与资金费),没有任何一个毛值;
//   3. 整块 n < ATTRIBUTION_MIN_SAMPLE 时 `insufficient: true`,块内**推断量**全部写 null,
//      **计数量**照常给 —— 数不够就不许出结论,但不许假装没数据。
// ================================================================================================

/** 整块样本不足的门槛。低于它,这一块的期望/胜率/中位数/差值全写 null。 */
export const ATTRIBUTION_MIN_SAMPLE = 10;

/** 该版本没记回放周期时的兜底 —— Jacky 点名的那个 15m。 */
export const REPLAY_TIMEFRAME_FALLBACK = '15m';

export const ATTRIBUTION_VERSION = 'attr-v1';

/** 出局分类(枚举:报告里不出现任何自由文本分类,自由文本正是黑盒的形态)。 */
export type ExitKind = 'stop' | 'take_profit' | 'expiry' | 'invalidation' | 'manual' | 'other';
export const EXIT_KINDS: readonly ExitKind[] = ['stop', 'take_profit', 'expiry', 'invalidation', 'manual', 'other'];
export const EXIT_KIND_LABEL: Record<ExitKind, string> = {
  stop: '止损出局',
  take_profit: '止盈出局',
  expiry: '到期出局',
  invalidation: '论点失效',
  manual: '人工平仓',
  other: '其他',
};

/** 这个币从哪来(screener 维度)。 */
export type SymbolOrigin = 'radar' | 'whitelist' | 'watchlist' | 'manual' | 'unknown';
export const SYMBOL_ORIGINS: readonly SymbolOrigin[] = ['radar', 'whitelist', 'watchlist', 'manual', 'unknown'];
export const SYMBOL_ORIGIN_LABEL: Record<SymbolOrigin, string> = {
  radar: 'Radar 候选',
  whitelist: '白名单',
  watchlist: '观察名单',
  manual: '手工/对话',
  unknown: '已不在任何名单',
};

/**
 * `close_reason` 是一句自由文本(runtime 各处写的),这里是**唯一**把它归一成枚举的地方。
 * 顺序有意义:止损/止盈的判定必须在「人工」之前 —— 人点的平仓按钮也可能写成「离场」,
 * 但「止损触发 @ x」永远是止损。
 */
export function exitKindOf(closeReason: string | null | undefined): ExitKind {
  const s = (closeReason ?? '').trim();
  if (!s) return 'other';
  if (/止损/.test(s)) return 'stop';
  if (/止盈/.test(s)) return 'take_profit';
  if (/到期|超时|过期|窗口结束/.test(s)) return 'expiry';
  if (/失效|论点|invalidate/i.test(s)) return 'invalidation';
  if (/人工|手动|用户|紧急停止|离场|平仓/.test(s)) return 'manual';
  return 'other';
}

/** 报告里的一笔样本(已经归一化过,下面所有汇总都只读这个形状)。 */
export interface AttributionTrade {
  thread_id: string;
  symbol: string;
  direction: Direction;
  opened_at: number;
  closed_at: number;
  /** 线上入场周期。 */
  timeframe: string;
  net_r: number;
  /** `settlement` = 交易所净额;`price` = 只有价格能算(退档,会在 note 里标出来)。 */
  r_source: 'settlement' | 'price';
  exit: ExitKind;
  /** |入场 − 止损| / 入场 × 100。 */
  stop_distance_pct: number | null;
  /** (手续费 + 资金费支出) / 初始风险 —— 「止损距离 vs 成本比」的那个比值。 */
  cost_over_risk: number | null;
  origin: SymbolOrigin;
  /** 线上线程不记录逐根极值(见设计 §1.6):默认 null,有人往线程上记了自动就有数。 */
  mae_r: number | null;
  mfe_r: number | null;
}

/**
 * 一条已平线程 → 一笔样本。返回 null = 这条不该进统计。
 *
 * **净 R 的公式与 `strategy-loop.realizedRFromThreads` 逐字相同**(那是降级与轮换共用的口径):
 * 优先 `settlement.net_pnl / initial_risk`,没有就退到 `(exit-entry)*qty/risk`。
 * 两边不能漂 —— 测试里有一条断言直接对拍这两个函数的输出序列。
 */
export function attributionTradeOf(
  t: StrategyThread,
  originOf: (t: StrategyThread) => SymbolOrigin,
): AttributionTrade | null {
  if (t.status !== 'closed') return null;
  const entry = Number(t.filled_avg_price ?? '');
  const stop = Number(t.stop_price ?? '');
  const qty = Number(t.qty ?? '');
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(qty) || qty <= 0) return null;
  const risk = Number(t.settlement?.initial_risk_usdt ?? '') || Math.abs(entry - stop) * qty;
  if (!(risk > 0)) return null;

  const pnl = t.settlement?.net_pnl == null ? null : Number(t.settlement.net_pnl);
  let r: number | null = null;
  let rSource: 'settlement' | 'price' = 'settlement';
  if (pnl !== null && Number.isFinite(pnl)) r = pnl / risk;
  else {
    const exitPrice = t.exit_price === null || t.exit_price === undefined || t.exit_price === '' ? null : Number(t.exit_price);
    if (exitPrice !== null && Number.isFinite(exitPrice)) {
      r = ((t.side === 'long' ? exitPrice - entry : entry - exitPrice) * qty) / risk;
      rSource = 'price';
    }
  }
  if (r === null || !Number.isFinite(r)) return null;

  // `Number('')` 是 0 而不是 NaN,所以「缺字段」必须显式判,不能靠 isFinite 兜。
  const dec = (v: string | null | undefined): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const commission = dec(t.settlement?.commission);
  const funding = dec(t.settlement?.funding);
  // 资金费负数 = 支出;正数是收入,不算进成本(但也不抵扣手续费:成本比问的是「要付出多少」)。
  const costUsdt = (commission === null ? 0 : Math.abs(commission)) + (funding !== null && funding < 0 ? -funding : 0);
  const hasCost = commission !== null || funding !== null;

  return {
    thread_id: t.id,
    symbol: t.symbol,
    direction: t.side,
    opened_at: t.opened_at ?? t.created_at,
    closed_at: t.closed_at ?? t.updated_at,
    timeframe: t.timeframe,
    net_r: r,
    r_source: rSource,
    exit: exitKindOf(t.close_reason),
    stop_distance_pct: entry > 0 ? (Math.abs(entry - stop) / entry) * 100 : null,
    cost_over_risk: hasCost ? costUsdt / risk : null,
    origin: originOf(t),
    mae_r: null,
    mfe_r: null,
  };
}

// ---------------------------------------------------------------- 小工具(全是纯函数)

const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return r4(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

function expectancy(xs: readonly number[]): number | null {
  return xs.length ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

function winRate(xs: readonly number[]): number | null {
  return xs.length ? r4(xs.filter((x) => x > 0).length / xs.length) : null;
}

// ---------------------------------------------------------------- 报告形状

export interface DirectionBucket {
  n: number;
  net_r_sum: number;
  expectancy_r: number | null;
  win_rate: number | null;
}

export interface DirectionBlock {
  insufficient: boolean;
  n: number;
  long: DirectionBucket;
  short: DirectionBucket;
  /** long 期望 − short 期望;正 = 这条策略只有多头能赚。样本不足 → null。 */
  skew: number | null;
}

/** 频率维度的输入:只能来自 decision_record(见设计 §1.2 B),不拿 episode 硬拼。 */
export interface OpportunityCounts {
  /** 这条策略进了允许集(被唤醒且代码没有一口否决)的次数。 */
  opportunities: number;
  /** 被闸拒的分布:闸名 → 次数。闸名是 `GateResult.name`,不是自由文本。 */
  blocked: Record<string, number>;
  /** 最早一条 decision_record 的时刻;这个窗口之前的判断没有结构化允许集。 */
  coverage_from: number | null;
}

export interface FrequencyBlock {
  insufficient: boolean;
  window_days: number | null;
  opens: number;
  opens_per_week: number | null;
  opportunities: number | null;
  opportunities_per_week: number | null;
  /** opens / opportunities;分母为 0 → null。 */
  conversion: number | null;
  blocked: { gate: string; n: number }[];
  coverage_from: number | null;
  note: string;
}

export interface ExitBucket {
  kind: ExitKind;
  label: string;
  n: number;
  share: number;
  expectancy_r: number | null;
}

export interface ExitBlock {
  insufficient: boolean;
  n: number;
  by_kind: ExitBucket[];
  mae_r_p50: number | null;
  mfe_r_p50: number | null;
  stop_distance_pct_p50: number | null;
  /** 费 / 初始风险。> 0.2 基本等于「策略在给交易所打工」。 */
  cost_over_risk_p50: number | null;
  note: string;
}

export interface PeriodBlock {
  insufficient: boolean;
  online_timeframes: { tf: string; n: number }[];
  replay_timeframe: string;
  consistent: boolean;
  mismatch: { tf: string; n: number }[];
  live_net_expectancy_r: number | null;
  replay_oos_net_expectancy_r: number | null;
  /** 线上 − 回放 OOS:这份报告里最贵的一个数(「回放说的」和「真的发生的」之间的距离)。 */
  gap: number | null;
}

export interface ScreenerBucket {
  origin: SymbolOrigin;
  label: string;
  n: number;
  share: number;
  expectancy_r: number | null;
}

export interface ScreenerBlock {
  insufficient: boolean;
  n: number;
  by_origin: ScreenerBucket[];
}

export interface AttributionReport {
  version: string;
  strategy_id: string;
  strategy_name: string | null;
  strategy_version: number;
  backend: string;
  tier: Tier | null;
  horizon: string | null;
  n: number;
  /** 全样本净期望 / 胜率 / 累计。样本不足 → 期望与胜率 null,累计仍给(它是计数量的和)。 */
  expectancy_r: number | null;
  win_rate: number | null;
  net_r_sum: number;
  insufficient: boolean;
  min_sample: number;
  window: [number, number] | null;
  direction: DirectionBlock;
  frequency: FrequencyBlock;
  exits: ExitBlock;
  period: PeriodBlock;
  screener: ScreenerBlock;
  /** 有几笔只能用价格算 R(没有交易所净额);>0 时前端要提示这份报告有退档样本。 */
  price_only_n: number;
}

export interface SummarizeAttributionOpts {
  strategy_id: string;
  strategy_name?: string | null;
  strategy_version: number;
  backend: string;
  tier?: Tier | null;
  horizon?: string | null;
  /** 该版本的回放周期;不给 → REPLAY_TIMEFRAME_FALLBACK。 */
  replay_timeframe?: string | null;
  /** 该版本的回放样本外净期望;不给 → null(gap 也就是 null)。 */
  replay_oos_net_expectancy?: number | null;
  opportunities?: OpportunityCounts | null;
  min_sample?: number;
}

// ---------------------------------------------------------------- 汇总(纯函数)

const WEEK_MS = 7 * 24 * 3_600_000;

function bucketOf(xs: readonly number[], enough: boolean): DirectionBucket {
  return {
    n: xs.length,
    net_r_sum: r4(xs.reduce((a, b) => a + b, 0)),
    expectancy_r: enough ? expectancy(xs) : null,
    win_rate: enough ? winRate(xs) : null,
  };
}

/**
 * 把一批样本拆成五个维度。**不做 I/O、不看时钟**;`window` 由样本自己的时间戳决定。
 */
export function summarizeAttribution(trades: readonly AttributionTrade[], opts: SummarizeAttributionOpts): AttributionReport {
  const minSample = opts.min_sample ?? ATTRIBUTION_MIN_SAMPLE;
  const n = trades.length;
  const enough = n >= minSample;
  const rs = trades.map((t) => t.net_r);
  const window: [number, number] | null = n
    ? [Math.min(...trades.map((t) => t.opened_at)), Math.max(...trades.map((t) => t.closed_at))]
    : null;

  // A. 方向
  const longs = trades.filter((t) => t.direction === 'long').map((t) => t.net_r);
  const shorts = trades.filter((t) => t.direction === 'short').map((t) => t.net_r);
  const longB = bucketOf(longs, enough);
  const shortB = bucketOf(shorts, enough);
  const direction: DirectionBlock = {
    insufficient: !enough,
    n,
    long: longB,
    short: shortB,
    skew: enough && longB.expectancy_r !== null && shortB.expectancy_r !== null ? r4(longB.expectancy_r - shortB.expectancy_r) : null,
  };

  // B. 频率
  const windowDays = window ? Math.max(1, (window[1] - window[0]) / 86_400_000) : null;
  const weeks = window ? Math.max(window[1] - window[0], WEEK_MS) / WEEK_MS : null;
  const opp = opts.opportunities ?? null;
  const blocked = opp ? Object.entries(opp.blocked).map(([gate, count]) => ({ gate, n: count })).sort((a, b) => b.n - a.n || a.gate.localeCompare(b.gate)) : [];
  const frequency: FrequencyBlock = {
    insufficient: !enough,
    window_days: windowDays === null ? null : r4(windowDays),
    opens: n,
    opens_per_week: enough && weeks ? r4(n / weeks) : null,
    opportunities: opp ? opp.opportunities : null,
    opportunities_per_week: enough && opp && weeks ? r4(opp.opportunities / weeks) : null,
    conversion: enough && opp && opp.opportunities > 0 ? r4(n / opp.opportunities) : null,
    blocked,
    coverage_from: opp?.coverage_from ?? null,
    note: opp
      ? '机会数与被闸拒分布只统计有 decision_record 的判断;更早的判断没有结构化允许集,不并入。'
      : '还没有 decision_record:这个窗口里的机会数与被闸拒分布无法统计(不编)。',
  };

  // C. 止损 / 止盈
  const byKind: ExitBucket[] = EXIT_KINDS.map((kind) => {
    const xs = trades.filter((t) => t.exit === kind).map((t) => t.net_r);
    return {
      kind,
      label: EXIT_KIND_LABEL[kind],
      n: xs.length,
      share: n ? r4(xs.length / n) : 0,
      expectancy_r: enough ? expectancy(xs) : null,
    };
  }).filter((b) => b.n > 0);
  const maes = trades.map((t) => t.mae_r).filter((x): x is number => x !== null);
  const mfes = trades.map((t) => t.mfe_r).filter((x): x is number => x !== null);
  const exits: ExitBlock = {
    insufficient: !enough,
    n,
    by_kind: byKind,
    mae_r_p50: enough ? median(maes) : null,
    mfe_r_p50: enough ? median(mfes) : null,
    stop_distance_pct_p50: enough ? median(trades.map((t) => t.stop_distance_pct).filter((x): x is number => x !== null)) : null,
    cost_over_risk_p50: enough ? median(trades.map((t) => t.cost_over_risk).filter((x): x is number => x !== null)) : null,
    note: maes.length ? '' : '线上线程不记录逐根极值,MAE/MFE 需按持仓区间重算 K 线才有;本版不编近似值。',
  };

  // D. 周期一致性
  const replayTf = opts.replay_timeframe ?? REPLAY_TIMEFRAME_FALLBACK;
  const tfCounts = new Map<string, number>();
  for (const t of trades) tfCounts.set(t.timeframe, (tfCounts.get(t.timeframe) ?? 0) + 1);
  const onlineTfs = [...tfCounts.entries()].map(([tf, count]) => ({ tf, n: count })).sort((a, b) => b.n - a.n || a.tf.localeCompare(b.tf));
  const mismatch = onlineTfs.filter((x) => x.tf !== replayTf);
  const liveExp = enough ? expectancy(rs) : null;
  const replayExp = opts.replay_oos_net_expectancy ?? null;
  const period: PeriodBlock = {
    insufficient: !enough,
    online_timeframes: onlineTfs,
    replay_timeframe: replayTf,
    consistent: n > 0 && mismatch.length === 0,
    mismatch,
    live_net_expectancy_r: liveExp,
    replay_oos_net_expectancy_r: replayExp,
    gap: liveExp !== null && replayExp !== null ? r4(liveExp - replayExp) : null,
  };

  // E. screener 来源
  const byOrigin: ScreenerBucket[] = SYMBOL_ORIGINS.map((origin) => {
    const xs = trades.filter((t) => t.origin === origin).map((t) => t.net_r);
    return {
      origin,
      label: SYMBOL_ORIGIN_LABEL[origin],
      n: xs.length,
      share: n ? r4(xs.length / n) : 0,
      expectancy_r: enough ? expectancy(xs) : null,
    };
  }).filter((b) => b.n > 0);

  return {
    version: ATTRIBUTION_VERSION,
    strategy_id: opts.strategy_id,
    strategy_name: opts.strategy_name ?? null,
    strategy_version: opts.strategy_version,
    backend: opts.backend,
    tier: opts.tier ?? null,
    horizon: opts.horizon ?? null,
    n,
    expectancy_r: enough ? expectancy(rs) : null,
    win_rate: enough ? winRate(rs) : null,
    net_r_sum: r4(rs.reduce((a, b) => a + b, 0)),
    insufficient: !enough,
    min_sample: minSample,
    window,
    direction,
    frequency,
    exits,
    period,
    screener: { insufficient: !enough, n, by_origin: byOrigin },
    price_only_n: trades.filter((t) => t.r_source === 'price').length,
  };
}

/** 报告 → 它属于哪一层(策略有 horizon 就按它,没有就按样本的线上周期推)。 */
export function tierForReport(horizon: string | null | undefined, trades: readonly AttributionTrade[]): Tier | null {
  if (horizon && horizon in TIER_OF) return TIER_OF[horizon as keyof typeof TIER_OF];
  const tf = trades[0]?.timeframe;
  return tf ? tierOfTimeframe(tf) : null;
}

// ================================================================================================
// 09-12 §3 黑盒决策规范化:一次判断 → 一条结构化 decision_record
//
// 三栏:**代码允许 → 模型选 → 闸后执行**。每一步的理由是 `DecisionReasonCode` 枚举,不是自由文本。
// 这是纯函数:输入是已经填好的 episode(gates / judgment / graph / council / intent 都在上面),
// 输出是一个可以聚合、可以对拍、可以当统计维度的对象。设计 §3。
// ================================================================================================

export interface DecisionRecordInputs {
  /** 这次判断属于哪一层(runtime 从生效策略的 horizon 取,没有策略时按线程周期推)。 */
  tier: Tier | null;
  /** `workflow.entry_style`,用来解释「允许的入场方式」是怎么收窄的。 */
  entry_style: EntryStyle;
  /** 议会模式:off 时 `allowed.council` 为 null。 */
  council_mode: 'off' | 'advise' | 'require';
  /** 生效的 `council_min_agree`(钳过之后的,不是用户设的那个原始值)。 */
  council_required: number;
}

/** entry_style → 允许的入场方式(与 entry-policy 的闸同一套口径,这里只做「说明」不做判定)。 */
function allowedEntryStyles(style: EntryStyle): { styles: ('market' | 'limit')[]; code: DecisionReasonCode } {
  if (style === 'limit_only') return { styles: ['limit'], code: 'code_entry_limit_only' };
  if (style === 'prefer_limit') return { styles: ['market', 'limit'], code: 'code_entry_prefer_limit' };
  return { styles: ['market', 'limit'], code: 'code_entry_free' };
}

/** 策略版本指纹:sha1(排序后的 `id@version@content_hash`)。没有 strategy_refs → null。 */
export function strategyVersionHash(refs: readonly { id: string; version: number; content_hash: string }[] | undefined): string | null {
  if (!refs || !refs.length) return null;
  const line = refs.map((r) => `${r.id}@${r.version}@${r.content_hash}`).sort().join('|');
  return createHash('sha1').update(line).digest('hex').slice(0, 16);
}

/**
 * 造一条 decision_record。**永远不抛**:它是记录,不是判定;记录本身失败不能把一次判断搞坏。
 */
export function buildDecisionRecord(ep: Episode, inp: DecisionRecordInputs): DecisionRecord {
  const j = ep.judgment;
  const council = ep.strategy_council ?? null;
  const consensus = council?.consensus ?? null;

  // ---- 一、代码允许集
  const allowedCodes: DecisionReasonCode[] = [];
  // 图快照只落 node/edge/guards,不落「这个节点的合法边全集」,所以 allowed.actions 现在是动作全集;
  // 等 graph.ts 开始把合法边写进快照,这里换成那份即可(字段形状不变)。
  const actions: Action[] = [...ACTIONS];
  if (ep.graph) allowedCodes.push('code_graph_edges');
  const entryAllowed = allowedEntryStyles(inp.entry_style);
  allowedCodes.push(entryAllowed.code);
  const refs = ep.strategy_refs ?? [];
  if (!refs.length) allowedCodes.push('code_no_strategy');
  let councilBlock: DecisionRecord['allowed']['council'] = null;
  if (inp.council_mode === 'off' || !council) {
    allowedCodes.push('code_council_off');
  } else {
    const reached = consensus?.reached === true;
    const agreeing = consensus?.agreeing.length ?? 0;
    councilBlock = { reached, direction: consensus?.direction ?? null, agreeing, required: consensus?.required ?? inp.council_required };
    allowedCodes.push(reached ? 'code_council_consensus' : 'code_council_no_consensus');
  }

  // ---- 二、模型选了什么
  const modelCodes: DecisionReasonCode[] = [];
  const illegal = ep.graph?.illegal_action ?? null;
  if (!j) modelCodes.push('model_no_output');
  else if (illegal) modelCodes.push('model_illegal_repaired');
  else modelCodes.push('model_within_allowed');
  if (ep.schema_errors.length && !j) modelCodes.push('model_failclosed');

  // ---- 三、闸之后真的执行了什么
  const execCodes: DecisionReasonCode[] = [];
  const failed = ep.gates.filter((g) => !g.passed);
  const passed = ep.gates.length > 0 && failed.length === 0;
  if (!ep.gates.length) execCodes.push('gate_not_applicable');
  else if (passed) execCodes.push('gate_pass');
  else {
    execCodes.push('gate_blocked');
    // 分层闸单独给码,这样「被闸拒的分布」能把分层拒和别的拒分开数。
    for (const g of failed) {
      if (/每日开仓上限$/.test(g.name) && g.name !== '每日开仓上限') execCodes.push('gate_tier_daily_cap');
      else if (/容量上限$/.test(g.name)) execCodes.push('gate_tier_capacity');
      else if (/入场方式$/.test(g.name) && g.name !== '入场方式') execCodes.push('gate_tier_entry_style');
    }
  }
  if (ep.intent) execCodes.push(ep.intent.status === 'pending_approval' ? 'exec_awaiting_approval' : 'exec_intent');
  else execCodes.push('exec_none');

  return {
    version: DECISION_RECORD_VERSION,
    at: ep.at,
    tier: inp.tier,
    allowed: {
      actions,
      entry_styles: entryAllowed.styles,
      council: councilBlock,
      strategies: refs.map((r) => ({ id: r.id, version: r.version, content_hash: r.content_hash })),
      codes: [...new Set(allowedCodes)],
    },
    model: {
      action: j?.action ?? null,
      direction: j?.direction ?? null,
      entry: j?.proposal?.entry ?? null,
      confidence: j?.confidence ?? null,
      illegal_action: illegal,
      codes: [...new Set(modelCodes)],
    },
    executed: {
      action: passed ? (j?.action ?? null) : null,
      passed,
      blocked_by: failed.map((g) => g.name),
      intent_id: ep.intent?.id ?? null,
      codes: [...new Set(execCodes)],
    },
    evidence_plan_hash: ep.evidence_plan_hash ?? null,
    strategy_version_hash: strategyVersionHash(refs),
  };
}

/**
 * 从一批 episode 里数「这条策略的机会数与被闸拒分布」。**只看 decision_record**:
 * 更早的 episode 没有结构化允许集,硬拼会拼出一个不可复核的数(设计 §1.2 B)。
 */
export function opportunityCountsFrom(
  episodes: readonly Episode[],
  strategyId: string,
): OpportunityCounts {
  let opportunities = 0;
  const blocked: Record<string, number> = {};
  let coverageFrom: number | null = null;
  for (const ep of episodes) {
    const dr = ep.decision_record;
    if (!dr) continue;
    coverageFrom = coverageFrom === null ? dr.at : Math.min(coverageFrom, dr.at);
    if (!dr.allowed.strategies.some((s) => s.id === strategyId)) continue;
    opportunities += 1;
    for (const name of dr.executed.blocked_by) blocked[name] = (blocked[name] ?? 0) + 1;
  }
  return { opportunities, blocked, coverage_from: coverageFrom };
}
