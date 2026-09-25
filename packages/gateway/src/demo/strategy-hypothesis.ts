/**
 * 假设生成(策略闭环 v2 §1.1「发现」的第二个来源:复盘教训 → 新策略族/变体的 draft)。
 *
 * 节奏:Reviewer 批次跑完后触发,**每周最多 1 次**,`workflow.strategy_discovery` 默认**关**。
 * 一次只花一个便宜大脑调用,输入是四样东西:
 *   1. 最近 30 天的复盘卡摘要(哪类交易在亏);
 *   2. 已批准的长期记忆(人点过头的教训);
 *   3. 现有策略族清单(别再提一个已经有的);
 *   4. Radar 最近一轮「当前 regime 下没有一条策略够格」的缺口。
 *
 * **模型没有任何晋升权**:它只能产出 `draft`,而且要先过四道**代码**校验——
 *   - schema 合法(id/family/horizon/触发/清单/规则/参数都成形,参数值落在自己的 [min,max] 内);
 *   - `checklist.required` 全在 {@link CHECKLIST_LIBRARY}(代码算得出来的判据);
 *   - `evidence.indicators` 的 id 全在指标库({@link INDICATOR_SETS});
 *   - `measurable` 为真(**量不出来的假设直接丢**,不进库);
 *   - 内容哈希判重(与任何已有版本同 hash 就丢)。
 * 不合格的不是「打回去让模型重写」,是**丢掉并记一行日志** —— 生成便宜,校验贵,重试只会烧钱。
 */

import type { Brain } from './brain.js';
import { HORIZON_POLICY, type StrategyHorizon } from './horizon.js';
import { INDICATOR_SETS } from './routes-indicators.js';
import { measurable } from './strategy-lab.js';
import {
  CHECKLIST_LIBRARY,
  EVENT_SUBKINDS,
  strategyContentHash,
  type StrategyEvidenceSpec,
  type StrategyFamily,
  type StrategyParam,
  type StrategySpec,
  type StrategyLibrary,
} from './strategies.js';
import type { MemoryItem, TriggerKind } from './types.js';

export const HYPOTHESIS_VERSION = 'hyp-v1';
/** 每周最多一次。 */
export const HYPOTHESIS_EVERY_MS = 7 * 86_400_000;
/** 一次最多收几条(超出的直接截断,不是报错)。 */
export const HYPOTHESIS_MAX = 3;
/** 复盘卡摘要的窗口。 */
export const HYPOTHESIS_LOOKBACK_MS = 30 * 86_400_000;

const FAMILIES: StrategyFamily[] = ['trend_continuation', 'mtf', 'volatility', 'derivatives', 'mean_reversion'];
const TRIGGER_KINDS: TriggerKind[] = ['kline_close', 'fast_move', 'breakout', 'ema_cross', 'vol_spike', 'retest', 'session', 'funding'];
const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d'];
const ID_RE = /^[a-z][a-z0-9_]{2,39}$/;

/** 待落库的新策略草稿(= createDraft 的入参形状)。 */
export type HypothesisDraft = Omit<StrategySpec, 'version' | 'content_hash' | 'created_at' | 'status' | 'eval_stats' | 'lab_stats' | 'parent_version'>;

export interface HypothesisDrop {
  id: string;
  reason: string;
}

export interface HypothesisInputs {
  /** 最近 30 天的复盘卡摘要行(reviewer 的 TradeCard 压成一行一条)。 */
  retro_lines: string[];
  /** 已批准(active)的长期记忆。 */
  memories: MemoryItem[];
  /** 现有策略族清单:id / 名字 / 族 / 状态 / 期望。 */
  existing: { id: string; name: string; family: StrategyFamily; horizon: StrategyHorizon; status: string; expectancy_r: number | null }[];
  /** Radar 最近一轮的「没有一条策略够格」缺口(regime + 说明)。 */
  gaps: string[];
}

// ---------------------------------------------------------------- prompt(纯函数)

export function hypothesisPrompt(inp: HypothesisInputs): { system: string; user: string } {
  const system = [
    '你是 trading-swarm 的策略假设生成器。你读最近的复盘、已批准的教训、现有策略清单和行情缺口,提出最多 3 条**新的可测策略假设**。',
    '你提出的是**待验证的草稿**,不是可以上线的策略:它会先跑机械漏斗回测,再跑影子实盘,全部由代码判,你没有任何晋升权。',
    '',
    '硬约束(违反的条目会被代码直接丢掉,不会退回给你重写):',
    `- family 只能是:${FAMILIES.join(' / ')};horizon 只能是:${Object.keys(HORIZON_POLICY).join(' / ')}。`,
    `- 为了「量得出来」,family 必须是 trend_continuation / mtf / volatility 之一,并且 params 里至少有一个漏斗旋钮(chase_atr_max / retest_vol_min / range_vol_min / breakout_window)。量不出来的假设一律丢。`,
    `- checklist.required 只能从这些**代码算得出来**的判据里选:${CHECKLIST_LIBRARY.join(' / ')}。`,
    `- trigger.kinds 只能从:${TRIGGER_KINDS.join(' / ')};min_timeframe 与 checklist.timeframes 只能从:${TIMEFRAMES.join(' / ')}。`,
    `- evidence.indicators 的 id 只能是指标库里的:${INDICATOR_SETS.join(' / ')};evidence.events 可为上面的 trigger 种类或事件 subkind:${EVENT_SUBKINDS.join(' / ')}。事件 subkind 订阅独立唤醒 event。`,
    '- 每个参数都要写 value / min / max,value 必须落在 [min, max] 内;参数是**这条假设的可调旋钮**,不是常识。',
    '- id 用小写下划线,要和现有策略明显不同;不要提出与现有策略内容等价的东西。',
    '- 规则要可判定:「收在 X 之上」「量比 ≥ Y」可以,「趋势走强」「情绪不错」不行。',
    '',
    '只输出 JSON 数组,最多 3 条,不要任何解释:',
    '[{"id":"…","name":"≤12字","family":"…","horizon":"…","why":"这条假设想修的是哪一类失败(≤60字)",',
    ' "trigger":{"kinds":["breakout"],"min_timeframe":"15m","cooldown_bars":4},',
    ' "checklist":{"required":["scan_checklist"],"timeframes":["15m","1h"]},',
    ' "rules":{"entry":["…"],"invalidation":["…"],"exit":["…"],"sizing_note":"…"},',
    ' "params":{"chase_atr_max":{"value":1.2,"min":0.5,"max":3,"unit":"ATR","note":"…"}},',
    ' "evidence":{"indicators":[{"id":"ema20","tf":"1h"}],"events":["breakout"],"info_topics":[]}}]',
  ].join('\n');

  const lines: string[] = [];
  lines.push('## 现有策略(别重复提)');
  for (const s of inp.existing) lines.push(`- ${s.id}(${s.name},${s.family}/${s.horizon},${s.status}${s.expectancy_r === null ? '' : `,期望 ${s.expectancy_r.toFixed(2)}R`})`);
  if (!inp.existing.length) lines.push('(策略库是空的)');

  lines.push('', '## 最近 30 天复盘(哪类交易在亏)');
  for (const l of inp.retro_lines.slice(0, 40)) lines.push(`- ${l}`);
  if (!inp.retro_lines.length) lines.push('(这段时间没有已结算的交易)');

  lines.push('', '## 已批准的教训');
  for (const m of inp.memories.slice(0, 15)) lines.push(`- ${m.content.slice(0, 200)}`);
  if (!inp.memories.length) lines.push('(还没有批准过的教训)');

  lines.push('', '## 行情缺口(Radar:当前 regime 下没有一条策略够格)');
  for (const g of inp.gaps.slice(0, 10)) lines.push(`- ${g}`);
  if (!inp.gaps.length) lines.push('(最近一轮筛选没有报缺口)');

  lines.push('', '只输出 JSON 数组,最多 3 条。');
  return { system, user: lines.join('\n') };
}

// ---------------------------------------------------------------- 解析 + 校验(纯函数,永不抛)

const INDICATOR_IDS = new Set<string>(INDICATOR_SETS as readonly string[]);
const CHECKLIST_IDS = new Set<string>(CHECKLIST_LIBRARY as readonly string[]);

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function strArray(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : [];
}

/**
 * 模型输出 → 合法草稿。不合法的条目进 `dropped`(带原因),永远不抛。
 * `existingHashes` 是库里所有版本的 content_hash,用于判重;`existingIds` 用于挡同名。
 */
export function parseHypotheses(text: string, ctx: { existingHashes: Set<string>; existingIds: Set<string> }): { drafts: HypothesisDraft[]; dropped: HypothesisDrop[] } {
  const drafts: HypothesisDraft[] = [];
  const dropped: HypothesisDrop[] = [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return { drafts, dropped: [{ id: '(整段)', reason: '输出里没有 JSON 数组' }] };
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return { drafts, dropped: [{ id: '(整段)', reason: `JSON 解析失败:${(e as Error).message.slice(0, 120)}` }] };
  }
  if (!Array.isArray(arr)) return { drafts, dropped: [{ id: '(整段)', reason: '顶层不是数组' }] };

  const seenIds = new Set(ctx.existingIds);
  const seenHashes = new Set(ctx.existingHashes);
  for (const raw of arr.slice(0, HYPOTHESIS_MAX * 2)) {
    if (drafts.length >= HYPOTHESIS_MAX) break;
    const o = (raw ?? {}) as Record<string, unknown>;
    const id = str(o['id']).toLowerCase();
    const drop = (reason: string): void => {
      dropped.push({ id: id || '(无 id)', reason });
    };
    if (!ID_RE.test(id)) {
      drop('id 不合法(小写字母/数字/下划线,3–40 字符)');
      continue;
    }
    if (seenIds.has(id)) {
      drop('id 已存在');
      continue;
    }
    const family = str(o['family']) as StrategyFamily;
    if (!FAMILIES.includes(family)) {
      drop(`family ${str(o['family']) || '(空)'} 不在枚举里`);
      continue;
    }
    const horizon = str(o['horizon']) as StrategyHorizon;
    if (!Object.hasOwn(HORIZON_POLICY, horizon)) {
      drop(`horizon ${str(o['horizon']) || '(空)'} 不在枚举里`);
      continue;
    }
    const name = str(o['name']).slice(0, 20) || id;

    const trg = (o['trigger'] ?? {}) as Record<string, unknown>;
    const kinds = strArray(trg['kinds'], 6).filter((k): k is TriggerKind => (TRIGGER_KINDS as string[]).includes(k));
    if (!kinds.length) {
      drop('trigger.kinds 为空或全部不在枚举里');
      continue;
    }
    const minTf = str(trg['min_timeframe']);
    if (!TIMEFRAMES.includes(minTf)) {
      drop(`trigger.min_timeframe ${minTf || '(空)'} 不在枚举里`);
      continue;
    }
    const cooldown = Number(trg['cooldown_bars']);
    if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 96) {
      drop('trigger.cooldown_bars 必须是 0–96 的数字');
      continue;
    }

    const chk = (o['checklist'] ?? {}) as Record<string, unknown>;
    const required = strArray(chk['required'], 6);
    if (!required.length) {
      drop('checklist.required 为空');
      continue;
    }
    const badChecks = required.filter((r) => !CHECKLIST_IDS.has(r));
    if (badChecks.length) {
      drop(`checklist.required 里 ${badChecks.join('/')} 不是代码算得出来的判据`);
      continue;
    }
    const timeframes = strArray(chk['timeframes'], 4).filter((t) => TIMEFRAMES.includes(t));
    if (!timeframes.length) {
      drop('checklist.timeframes 为空或全部不在枚举里');
      continue;
    }

    const rl = (o['rules'] ?? {}) as Record<string, unknown>;
    const entry = strArray(rl['entry'], 6).map((s) => s.slice(0, 300));
    const invalidation = strArray(rl['invalidation'], 4).map((s) => s.slice(0, 300));
    const exit = strArray(rl['exit'], 4).map((s) => s.slice(0, 300));
    if (!entry.length || !invalidation.length || !exit.length) {
      drop('rules 的 entry/invalidation/exit 三段都不能为空');
      continue;
    }
    const sizingNote = str(rl['sizing_note']).slice(0, 200);

    const rawParams = (o['params'] ?? {}) as Record<string, unknown>;
    const params: Record<string, StrategyParam> = {};
    let paramError: string | null = null;
    for (const [k, v] of Object.entries(rawParams).slice(0, 8)) {
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(k)) {
        paramError = `参数名 ${k} 不合法`;
        break;
      }
      const pv = (v ?? {}) as Record<string, unknown>;
      const value = Number(pv['value']);
      const min = Number(pv['min']);
      const max = Number(pv['max']);
      if (![value, min, max].every((n) => Number.isFinite(n))) {
        paramError = `参数 ${k} 的 value/min/max 必须都是数字`;
        break;
      }
      if (min >= max || value < min || value > max) {
        paramError = `参数 ${k} 的 value=${value} 不在 [${min}, ${max}] 内`;
        break;
      }
      params[k] = { value, min, max, ...(str(pv['unit']) ? { unit: str(pv['unit']).slice(0, 8) } : {}), ...(str(pv['note']) ? { note: str(pv['note']).slice(0, 80) } : {}) };
    }
    if (paramError) {
      drop(paramError);
      continue;
    }
    if (!Object.keys(params).length) {
      drop('params 为空(没有可调旋钮就没法做参数探针)');
      continue;
    }

    const rawEv = (o['evidence'] ?? {}) as Record<string, unknown>;
    const indicators: StrategyEvidenceSpec['indicators'] = [];
    let evError: string | null = null;
    for (const it of (Array.isArray(rawEv['indicators']) ? rawEv['indicators'] : []).slice(0, 12)) {
      const io = (it ?? {}) as Record<string, unknown>;
      const iid = str(io['id']);
      const itf = str(io['tf']);
      if (!INDICATOR_IDS.has(iid)) {
        evError = `evidence.indicators 里 ${iid || '(空)'} 不在指标库里`;
        break;
      }
      if (!TIMEFRAMES.includes(itf)) {
        evError = `evidence.indicators 里 ${iid} 的周期 ${itf || '(空)'} 不在枚举里`;
        break;
      }
      indicators.push({ id: iid, tf: itf });
    }
    if (evError) {
      drop(evError);
      continue;
    }
    const events = strArray(rawEv['events'], 8).filter((k): k is StrategyEvidenceSpec['events'][number] => (TRIGGER_KINDS as string[]).includes(k) || (EVENT_SUBKINDS as readonly string[]).includes(k));
    const infoTopics = strArray(rawEv['info_topics'], 6).map((s) => s.slice(0, 24).toLowerCase());
    // evidence.events 与 trigger.kinds 取交集;交集为空 = 这条策略永远醒不了,当场丢。
    if (events.length && !events.some((e) => (kinds as string[]).includes(e) || (EVENT_SUBKINDS as readonly string[]).includes(e))) {
      drop('evidence.events 与 trigger.kinds 交集为空(这条策略永远醒不了)');
      continue;
    }
    const evidence: StrategyEvidenceSpec = { indicators, events, info_topics: infoTopics };

    const draft: HypothesisDraft = {
      id,
      name,
      family,
      horizon,
      trigger: { kinds, min_timeframe: minTf, cooldown_bars: Math.round(cooldown) },
      checklist: { required, timeframes },
      rules: { entry, invalidation, exit, ...(sizingNote ? { sizing_note: sizingNote } : {}) },
      params,
      evidence,
    };

    // 量不出来的假设直接丢:measurable 读 family + 漏斗旋钮。
    const probe = { ...draft, version: 1, content_hash: '', status: 'draft', eval_stats: { backtests: 0, trades: 0, win_rate: null, expectancy_r: null, mae_r_p50: null, last_run_id: null, noise_note: null }, created_at: 0 } as StrategySpec;
    if (!measurable(probe)) {
      drop(`漏斗量不出来(family=${family},没有漏斗旋钮),不进库`);
      continue;
    }
    const hash = strategyContentHash(draft);
    if (seenHashes.has(hash)) {
      drop(`内容哈希与已有版本相同(${hash.slice(0, 12)})`);
      continue;
    }
    seenIds.add(id);
    seenHashes.add(hash);
    drafts.push(draft);
  }
  return { drafts, dropped };
}

// ---------------------------------------------------------------- 跑一次(编排)

export interface HypothesisDeps {
  brain: Brain;
  library: StrategyLibrary;
  now?: number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export interface HypothesisResult {
  drafts: { id: string; version: number }[];
  dropped: HypothesisDrop[];
  raw: string;
  error: string | null;
}

/**
 * 一次假设生成:便宜大脑一次调用 → 代码校验 → 合格的落成 v1 draft。
 * 调用方负责节流(每周 ≤ 1 次 + `workflow.strategy_discovery` 开关)。
 */
export async function runHypothesis(inp: HypothesisInputs, deps: HypothesisDeps): Promise<HypothesisResult> {
  const now = deps.now ?? Date.now();
  const { system, user } = hypothesisPrompt(inp);
  let raw = '';
  try {
    const r = await deps.brain.complete(system, user, { timeoutMs: 180_000 });
    raw = r.text;
  } catch (e) {
    return { drafts: [], dropped: [], raw: '', error: (e as Error).message.slice(0, 300) };
  }
  const existingIds = new Set<string>();
  const existingHashes = new Set<string>();
  for (const head of deps.library.list({ include_retired: true })) {
    existingIds.add(head.id);
    for (const v of deps.library.versions(head.id)) existingHashes.add(v.content_hash);
  }
  const { drafts, dropped } = parseHypotheses(raw, { existingHashes, existingIds });
  const made: { id: string; version: number }[] = [];
  for (const d of drafts) {
    const r = deps.library.createDraft(d, { now });
    if (!r.spec) {
      dropped.push({ id: d.id, reason: r.error ?? '落库失败' });
      continue;
    }
    made.push({ id: r.spec.id, version: r.spec.version });
  }
  for (const d of dropped) deps.log?.('info', `假设 ${d.id} 被丢弃:${d.reason}`);
  return { drafts: made, dropped, raw, error: null };
}
