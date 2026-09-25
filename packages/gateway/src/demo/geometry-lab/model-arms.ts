/**
 * Geometry Lab model arms (B one-shot digest, C tool loop, D pick-from-menu). See core.ts for the frame.
 *
 * All three use the same Brain adapter as production (brain.ts; default `pi` → zai/glm-5.3, text mode,
 * `--no-tools`). Arm C's "tools" are therefore a text protocol: the model emits {"calls":[…]} and the
 * code answers with tool outputs computed ONLY from the View (bars ≤ as_of), then re-prompts with the
 * transcript. Token counts are the adapter's approximation (chars/3), cost uses brain.ts BRAIN_PRICES_CNY.
 *
 * RR rules: the 9b–9d lines are taken verbatim from rr-prompt.ts at runtime (single source); every call
 * stores its system-prompt hash so a later wording change is visible in the lab DB.
 */
import { createHash } from 'node:crypto';
import { priceFor, type Brain } from '../brain.js';
import { RR_PROMPT } from '../rr-prompt.js';
import { extractJson } from '../schema.js';
import { armA, assertVisible, atrOf, enumerateLevels, htfBars, htfLevels, pivots, resolvePick, tfFeatures, volumeProfile, type Geometry, type LevelMenu, type View } from './core.js';

// ─────────────────────────────── accounting ───────────────────────────────

export interface Meter {
  calls: number;
  in_tok: number;
  out_tok: number;
  latency_ms: number;
  cost_cny: number;
}
export const newMeter = (): Meter => ({ calls: 0, in_tok: 0, out_tok: 0, latency_ms: 0, cost_cny: 0 });

export interface CallLogEntry {
  arm: string;
  turn: number;
  system_hash: string;
  user_text: string;
  output_text: string | null;
  error: string | null;
  latency_ms: number;
  in_tok: number;
  out_tok: number;
}

export class BudgetExhausted extends Error {
  constructor() {
    super('model_call_budget_exhausted');
  }
}

/**
 * Per-run ¥ cap. `spent` is priced from a CJK-aware token estimate (CJK char = 1 token, anything else = 1 per
 * 2.5 chars), which is deliberately above the adapter's chars/3 meter, so stopping on it also stops the meter
 * total under the cap. Each call reserves max(ceiling, 2 × its own input cost) before it starts and is only started
 * when spent + all in-flight reserves + its reserve stays ≤ max; `ceiling` starts at `ceilingInit` and grows to the
 * most expensive call seen.
 */
export interface CnyBudget {
  max: number;
  spent: number;
  spent_meter: number;
  inflight: number;
  reserved: number;
  ceiling: number;
}
export const newCnyBudget = (max: number, ceilingInit = 0.01): CnyBudget => ({ max, spent: 0, spent_meter: 0, inflight: 0, reserved: 0, ceiling: ceilingInit });

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/gu;
export function conservativeTokens(s: string): number {
  const cjk = s.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((s.length - cjk) / 2.5);
}

export interface ModelCtx {
  brain: Brain;
  /** shared across the whole run; `used` is incremented BEFORE each call; `cny` (optional) is the ¥ cap */
  budget: { used: number; max: number; cny?: CnyBudget };
  log: (e: CallLogEntry) => void;
  timeoutMs?: number;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function call(ctx: ModelCtx, arm: string, turn: number, system: string, user: string, m: Meter): Promise<string> {
  if (ctx.budget.used >= ctx.budget.max) throw new BudgetExhausted();
  const p = priceFor(ctx.brain.name);
  const cb = ctx.budget.cny;
  if (cb && !p) throw new Error(`--max-cny needs a priced brain; ${ctx.brain.name} is not in BRAIN_PRICES_CNY`);
  const consIn = p ? (conservativeTokens(system + user) / 1e6) * p.input : 0;
  const reserve = cb ? Math.max(cb.ceiling, 2 * consIn) : 0;
  if (cb && cb.spent + cb.reserved + reserve > cb.max) throw new BudgetExhausted();
  ctx.budget.used++;
  if (cb) {
    cb.inflight++;
    cb.reserved += reserve;
  }
  const started = Date.now();
  const base = { arm, turn, system_hash: sha(system), user_text: user };
  try {
    const r = await ctx.brain.complete(system, user, { timeoutMs: ctx.timeoutMs ?? 180_000 });
    const cost = p ? (r.input_tokens / 1e6) * p.input + (r.output_tokens / 1e6) * p.output : 0;
    m.calls++;
    m.in_tok += r.input_tokens;
    m.out_tok += r.output_tokens;
    m.latency_ms += r.latency_ms;
    m.cost_cny += cost;
    if (cb && p) {
      const cons = consIn + (conservativeTokens(r.text) / 1e6) * p.output;
      cb.spent += cons;
      cb.spent_meter += cost;
      cb.ceiling = Math.max(cb.ceiling, cons);
    }
    ctx.log({ ...base, output_text: r.text, error: null, latency_ms: r.latency_ms, in_tok: r.input_tokens, out_tok: r.output_tokens });
    return r.text;
  } catch (e) {
    m.calls++;
    m.latency_ms += Date.now() - started;
    if (cb) cb.spent += consIn; // a failed call may still have been billed for its input
    ctx.log({ ...base, output_text: null, error: e instanceof Error ? e.message : String(e), latency_ms: Date.now() - started, in_tok: 0, out_tok: 0 });
    throw e;
  } finally {
    if (cb) {
      cb.inflight--;
      cb.reserved -= reserve;
    }
  }
}

// ─────────────────────────────── digest + prompts ───────────────────────────────

export function decimalsFor(p: number): number {
  return p >= 1000 ? 2 : p >= 100 ? 3 : p >= 1 ? 4 : 6;
}

export interface TextOut {
  text: string;
  /** every price level printed in `text`, as printed (the hallucination detector's universe) */
  prices: number[];
}

/** Production-style structure block (context.ts §structure line) for 1h and 4h + last 4 1h bars. */
export function digest(v: View): TextOut {
  assertVisible(v);
  const f1 = tfFeatures(v.bars);
  const d = decimalsFor(f1.close);
  const prices: number[] = [];
  const px = (x: number): string => {
    const s = x.toFixed(d);
    prices.push(Number(s));
    return s;
  };
  const pct = (x: number): string => x.toFixed(2);
  const line = (tf: string, f: ReturnType<typeof tfFeatures>): string =>
    `${tf} 结构: 收 ${px(f.close)}; ${f.ema20 > f.ema50 ? 'EMA20>EMA50(偏多)' : 'EMA20<EMA50(偏空)'}, ${f.close > f.ema20 ? '价在 EMA20 上' : '价在 EMA20 下'}; EMA20 ${px(f.ema20)} EMA50 ${px(f.ema50)}; ATR14 ${f.atr14.toFixed(d)} (${pct((f.atr14 / f.close) * 100)}%); 20根高 ${px(f.hi20)}(距 ${pct(((f.hi20 - f.close) / f.close) * 100)}%) 低 ${px(f.lo20)}(距 ${pct(((f.close - f.lo20) / f.close) * 100)}%); 50根高 ${px(f.hi50)} 低 ${px(f.lo50)}; 最近一根 ${f.chg_last_pct >= 0 ? '+' : ''}${pct(f.chg_last_pct)}%, 近5根 ${f.chg5_pct >= 0 ? '+' : ''}${pct(f.chg5_pct)}%; 量比 ${f.vol_ratio20.toFixed(2)}`;
  const h4 = htfBars(v, 4 * 3_600_000);
  const lines = [
    `标的 ${v.symbol} 现货;数据截至 ${new Date(v.as_of + 1).toISOString()}(该根 1h 已收盘)。参考价(最新收盘)= ${px(f1.close)}。`,
    `[E1] ${line('1h', f1)}`,
    h4.length >= 51 ? `[E2] ${line('4h', tfFeatures(h4))}` : '[E2] 4h 结构: 已收盘根数不足',
    `[E3] 1h 最近 4 根(开/高/低/收/量): ${v.bars
      .slice(-4)
      .map((b) => `${px(Number(b.open))}/${px(Number(b.high))}/${px(Number(b.low))}/${px(Number(b.close))}/${Number(b.volume).toFixed(2)}`)
      .join('; ')}`,
  ];
  return { text: lines.join('\n'), prices };
}

/** 9b–9d of rr-prompt.ts, verbatim. */
export function rrRules(): string {
  const lines = RR_PROMPT.split('\n').filter((l) => /^9[bcd]\./.test(l));
  if (lines.length !== 3) throw new Error('rr_prompt_9b_9d_missing');
  return lines.join('\n');
}

const header = (v: View, close: number, d: number, extra: string): string =>
  `你是交易几何规划器。这笔交易的入场已经由代码决定且不可更改:${v.symbol} 现货 1h 多单,市价在下一根 K 线开盘成交(参考价=最新收盘 ${close.toFixed(d)})。你的唯一任务是为它放置止损和第一止盈目标。不能拒绝、不能改方向、不能改入场。${extra}\n` +
  `下面三条是生产扫描提示词的盈亏比规则(原文照录);本实验里「不提案/NO_TRADE」对应 target=null(不设目标,只靠止损与到期离场)。\n${rrRules()}\n`;

export function systemB(v: View): string {
  const c = tfFeatures(v.bars).close;
  return (
    header(v, c, decimalsFor(c), '') +
    '只输出一个 JSON 对象,不要其他文字:\n{"stop":"十进制字符串,低于参考价","target":"十进制字符串,高于参考价,或 null","rationale":"≤120字,分别说明止损与目标的结构依据并引用证据编号","source_levels":["止损依据:价位+出处","目标依据:价位+出处"]}'
  );
}

export const C_MAX_TURNS = 5;
export const C_MAX_TOOL_CALLS = 6;
export const C_MAX_CALLS_PER_TURN = 3;

export function systemC(v: View): string {
  const c = tfFeatures(v.bars).close;
  return (
    header(v, c, decimalsFor(c), '') +
    `你可以调用只读工具查看截至参考时刻(含)已收盘的数据,看不到未来。每一轮只输出一个 JSON 对象,二选一:\n` +
    `1) 调工具:{"calls":[{"tool":"swing_points","args":{"left":3,"right":3,"n":6}}]}  每轮最多 ${C_MAX_CALLS_PER_TURN} 个,全程最多 ${C_MAX_TOOL_CALLS} 个,最多 ${C_MAX_TURNS} 轮。\n` +
    `2) 结束:{"final":{"stop":{"level":"价位","from":"T2","buffer_atr":0.1},"target":{"level":"价位","from":"T3"} 或 null,"rationale":"≤120字"}}\n` +
    `规则:止损价 = stop.level − buffer_atr × ATR14(ATR14 用 T0 摘要里的 1h 值,由代码计算),buffer_atr 取 0 到 3;目标价 = target.level。level 必须是你在 from 所指那条输出(T0=摘要,T1..=工具结果)里原样出现过的价格;不在任何输出里出现的价位视为编造,本笔作废改用代码方案。\n` +
    `工具:\n- klines {"n":1-120}:最近 n 根 1h K 线(age=0 为最新一根)\n- atr {"n":2-100}:1h ATR(n)\n- swing_points {"left":1-20,"right":1-20,"n":1-20}:1h 已确认摆动高/低点,各返回最近 n 个\n- htf_levels {"tf":"4h"|"1d"}:已收盘高周期摆动高/低点(离现价最近的 3 个)与近 20 根区间高低\n- volume_profile {"n":20-500,"bins":5-40}:最近 n 根成交量分布(POC、高量节点、70% 价值区、占比最高的桶)`
  );
}

export function systemD(v: View): string {
  const c = tfFeatures(v.bars).close;
  return (
    header(v, c, decimalsFor(c), '你只能从代码列出的候选里选编号,不能写任何价格数字。') +
    '只输出一个 JSON 对象,不要其他文字:{"stop_idx":整数,"target_idx":整数或null,"reason":"≤120字,说明所选止损与目标的结构依据"}\nR 倍数目标的价格由代码按你所选止损计算:参考价 + k×(参考价 − 止损)。'
  );
}

export function renderMenu(menu: LevelMenu): string {
  const d = decimalsFor(menu.close);
  const s = menu.stops.map((o) => `[${o.idx}] ${o.label} → 价 ${o.price!.toFixed(d)},距参考价 ${o.dist_atr!.toFixed(2)} ATR / ${o.dist_pct!.toFixed(2)}%`);
  const t = menu.targets.map((o) => (o.r_multiple !== null ? `[${o.idx}] ${o.label} → 价随所选止损而定` : `[${o.idx}] ${o.label} → 价 ${o.price!.toFixed(d)},距参考价 ${o.dist_atr!.toFixed(2)} ATR / ${o.dist_pct!.toFixed(2)}%`));
  return `止损候选(均在参考价下方):\n${s.join('\n')}\n目标候选(均在参考价上方):\n${t.join('\n')}`;
}

// ─────────────────────────────── tools (arm C) ───────────────────────────────

const clampInt = (x: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.round(Number(x));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Read-only tools over the View only; returns the text the model sees plus every price it printed. */
export function runTool(v: View, name: string, args: Record<string, unknown> = {}): TextOut {
  assertVisible(v);
  const close = Number(v.bars.at(-1)!.close);
  const d = decimalsFor(close);
  const prices: number[] = [];
  const px = (x: number): string => {
    const s = x.toFixed(d);
    prices.push(Number(s));
    return s;
  };
  const out = (o: unknown): TextOut => ({ text: JSON.stringify(o), prices });
  const last = v.bars.length - 1;
  switch (name) {
    case 'klines': {
      const n = clampInt(args['n'], 1, 120, 24);
      return out({ tool: 'klines', tf: '1h', rows: v.bars.slice(-n).map((b, i, a) => ({ age: a.length - 1 - i, o: px(Number(b.open)), h: px(Number(b.high)), l: px(Number(b.low)), c: px(Number(b.close)), v: Number(b.volume).toFixed(2) })) });
    }
    case 'atr': {
      const n = clampInt(args['n'], 2, 100, 14);
      return out({ tool: 'atr', tf: '1h', n, atr: atrOf(v.bars, n).toFixed(d) });
    }
    case 'swing_points': {
      const left = clampInt(args['left'], 1, 20, 3);
      const right = clampInt(args['right'], 1, 20, 3);
      const n = clampInt(args['n'], 1, 20, 5);
      const ps = pivots(v.bars, left, right);
      const fmt = (kind: 'high' | 'low') => ps.filter((p) => p.kind === kind).slice(-n).map((p) => ({ price: px(p.price), age_bars: last - p.index, side: p.price > close ? 'above' : 'below' }));
      return out({ tool: 'swing_points', tf: '1h', left, right, highs: fmt('high'), lows: fmt('low') });
    }
    case 'htf_levels': {
      const tf = args['tf'] === '1d' ? '1d' : '4h';
      const h = htfLevels(v, tf);
      return out({ tool: 'htf_levels', tf, complete_bars: h.complete_bars, swing_highs_above: h.highs_above.map(px), swing_lows_below: h.lows_below.map(px), range20_high: h.range20_high === null ? null : px(h.range20_high), range20_low: h.range20_low === null ? null : px(h.range20_low) });
    }
    case 'volume_profile': {
      const n = clampInt(args['n'], 20, 500, 120);
      const bins = clampInt(args['bins'], 5, 40, 24);
      const vp = volumeProfile(v.bars, n, bins);
      const byShare = [...vp.bins].sort((a, b) => b.share - a.share);
      let acc = 0;
      const va: typeof vp.bins = [];
      for (const b of byShare) {
        if (acc >= 0.7) break;
        va.push(b);
        acc += b.share;
      }
      return out({ tool: 'volume_profile', n: vp.n, bins, poc: px(vp.poc), hvn: vp.hvn.map(px), value_area_low: px(Math.min(...va.map((b) => b.lo))), value_area_high: px(Math.max(...va.map((b) => b.hi))), top_bins: byShare.slice(0, 6).map((b) => ({ lo: px(b.lo), hi: px(b.hi), share: b.share.toFixed(3) })) });
    }
    default:
      return out({ error: `unknown_tool:${name}` });
  }
}

/** A level is grounded when some printed price is within ±tol (relative). */
export function groundedIn(p: number, prices: readonly number[], tol = 0.0005): boolean {
  return Number.isFinite(p) && prices.some((x) => x > 0 && Math.abs(p - x) / x <= tol);
}

// ─────────────────────────────── arms ───────────────────────────────

export interface ArmOutput {
  g: Geometry;
  meter: Meter;
}

const num = (x: unknown): number => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);
const isNullish = (x: unknown): boolean => x === null || x === undefined || x === 'null' || x === '';
const asObj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

function fallbackA(v: View, flags: string[], note: string): Geometry {
  const a = armA(v);
  return { ...a, rationale: `${note} → ${a.rationale}`, flags: [...new Set([...a.flags, 'fallback_a', ...flags])] };
}

/** Arm B: one shot from the digest, free numbers (production style); ungrounded numbers are flagged, not rejected. */
export async function armB(v: View, ctx: ModelCtx): Promise<ArmOutput> {
  assertVisible(v);
  const m = newMeter();
  const dg = digest(v);
  const close = tfFeatures(v.bars).close;
  const system = systemB(v);
  let user = dg.text;
  let lastErr = '';
  for (let turn = 1; turn <= 2; turn++) {
    const text = await call(ctx, 'B', turn, system, user, m);
    try {
      const j = asObj(extractJson(text));
      const stop = num(j['stop']);
      const target = isNullish(j['target']) ? null : num(j['target']);
      if (!(stop > 0 && stop < close)) throw new Error(`stop 必须低于参考价 ${close}`);
      if (target !== null && !(target > close)) throw new Error(`target 必须高于参考价 ${close} 或为 null`);
      const flags: string[] = [];
      if (!groundedIn(stop, dg.prices)) flags.push('stop_ungrounded');
      if (target !== null && !groundedIn(target, dg.prices)) flags.push('target_ungrounded');
      if (turn > 1) flags.push('repaired');
      return { g: { stop, target, rationale: String(j['rationale'] ?? ''), source_levels: Array.isArray(j['source_levels']) ? j['source_levels'].map(String) : [], flags }, meter: m };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      user = `${dg.text}\n\n[上次输出无效:${lastErr}。只修正 JSON。]`;
    }
  }
  return { g: fallbackA(v, ['invalid_output'], `B invalid: ${lastErr}`), meter: m };
}

/** Arm C: tool loop; each final level must appear in some printed output (±0.05%) or the candidate falls back to A. */
export async function armC(v: View, ctx: ModelCtx): Promise<ArmOutput & { tool_calls: number; transcript: string }> {
  assertVisible(v);
  const m = newMeter();
  const dg = digest(v);
  const f = tfFeatures(v.bars);
  const close = f.close;
  const system = systemC(v);
  const outputs: TextOut[] = [dg];
  let transcript = '';
  let toolCalls = 0;
  const flags: string[] = [];
  for (let turn = 1; turn <= C_MAX_TURNS; turn++) {
    const mustFinish = turn === C_MAX_TURNS || toolCalls >= C_MAX_TOOL_CALLS;
    const user = `T0(摘要):\n${dg.text}${transcript}\n\n[状态] 已用工具 ${toolCalls}/${C_MAX_TOOL_CALLS},第 ${turn}/${C_MAX_TURNS} 轮。${mustFinish ? '工具预算已用完或已是最后一轮:必须输出 final。' : ''}`;
    const text = await call(ctx, 'C', turn, system, user, m);
    transcript += `\n\n[第 ${turn} 轮你的输出]\n${text.slice(0, 1500)}`;
    let j: Record<string, unknown>;
    try {
      j = asObj(extractJson(text));
    } catch (e) {
      transcript += `\n[系统] 输出不是 JSON:${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    if ('final' in j) {
      const fin = asObj(j['final']);
      const s = asObj(fin['stop']);
      const level = num(s['level']);
      const buffer = isNullish(s['buffer_atr']) ? 0 : num(s['buffer_atr']);
      const tRaw = fin['target'];
      const t = isNullish(tRaw) ? null : asObj(tRaw);
      const tLevel = t ? num(t['level']) : null;
      const stop = level - buffer * f.atr14;
      const problems: string[] = [];
      if (!Number.isFinite(level)) problems.push('stop.level 不是数字');
      if (!(buffer >= 0 && buffer <= 3)) problems.push('buffer_atr 必须在 0..3');
      if (!(stop > 0 && stop < close)) problems.push(`止损价 ${stop} 必须低于参考价 ${close}`);
      if (tLevel !== null && !(tLevel > close)) problems.push(`target.level 必须高于参考价 ${close}`);
      if (problems.length) {
        transcript += `\n[系统] final 无效:${problems.join(';')}`;
        continue;
      }
      const check = (p: number, from: unknown): 'ok' | 'miscited' | 'hallucinated' => {
        const k = /^T(\d+)$/.exec(String(from ?? '').trim());
        const cited = k ? outputs[Number(k[1])] : undefined;
        if (cited && groundedIn(p, cited.prices)) return 'ok';
        return outputs.some((o) => groundedIn(p, o.prices)) ? 'miscited' : 'hallucinated';
      };
      const cs = check(level, s['from']);
      const ct = tLevel === null ? 'ok' : check(tLevel, t!['from']);
      if (cs === 'miscited' || ct === 'miscited') flags.push('miscited');
      const intended = `model stop.level=${level} (${String(s['from'])}, ${cs}) buffer=${buffer}ATR; target=${tLevel ?? 'null'} (${t ? String(t['from']) : '-'}, ${ct})`;
      if (cs === 'hallucinated' || ct === 'hallucinated') {
        return { g: fallbackA(v, ['hallucinated', ...flags], intended), meter: m, tool_calls: toolCalls, transcript };
      }
      return { g: { stop, target: tLevel, rationale: String(fin['rationale'] ?? ''), source_levels: [intended], flags }, meter: m, tool_calls: toolCalls, transcript };
    }
    const calls = Array.isArray(j['calls']) ? j['calls'] : [];
    if (!calls.length || mustFinish) {
      transcript += `\n[系统] ${mustFinish ? '预算已用完,下一轮必须输出 final。' : '没有识别到 calls 或 final。'}`;
      continue;
    }
    for (const c of calls.slice(0, Math.min(C_MAX_CALLS_PER_TURN, C_MAX_TOOL_CALLS - toolCalls))) {
      const o = asObj(c);
      const name = String(o['tool'] ?? '');
      const args = asObj(o['args']);
      const res = runTool(v, name, args);
      outputs.push(res);
      toolCalls++;
      transcript += `\n[工具结果] T${outputs.length - 1} = ${name}(${JSON.stringify(args)}) → ${res.text}`;
    }
  }
  return { g: fallbackA(v, ['no_final'], 'C produced no valid final'), meter: m, tool_calls: toolCalls, transcript };
}

/** Arm D: the model returns indices only; code resolves them to prices. */
export async function armD(v: View, ctx: ModelCtx): Promise<ArmOutput & { menu: LevelMenu }> {
  assertVisible(v);
  const m = newMeter();
  const menu = enumerateLevels(v);
  const system = systemD(v);
  const base = `${digest(v).text}\n\n${renderMenu(menu)}`;
  let user = base;
  let lastErr = '';
  for (let turn = 1; turn <= 2; turn++) {
    const text = await call(ctx, 'D', turn, system, user, m);
    try {
      const j = asObj(extractJson(text));
      const si = num(j['stop_idx']);
      const ti = isNullish(j['target_idx']) ? null : num(j['target_idx']);
      const g = resolvePick(menu, si, ti);
      return { g: { ...g, rationale: String(j['reason'] ?? ''), flags: turn > 1 ? ['repaired'] : [] }, meter: m, menu };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      user = `${base}\n\n[上次输出无效:${lastErr}。只修正 JSON,编号必须在列表范围内。]`;
    }
  }
  return { g: fallbackA(v, ['invalid_output'], `D invalid: ${lastErr}`), meter: m, menu };
}
