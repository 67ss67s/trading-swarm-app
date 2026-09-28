// Hard-invariant checkers (docs/eval/README.md §1). Pure functions over (case, context, judgment).

import { demo } from '@trade-gate/gateway';
import type { EvalCase, Evidence, Judgment, Kline, StrategyThread } from './types.js';
import { featureTfs } from './inputs.js';

export interface NumToken {
  text: string;
  value: number;
  sig: number;
}

/** Strict: a number not glued to letters on either side (so E5 / EMA20 / 147M are not numbers). */
const STRICT_NUM = /(?<![A-Za-z0-9_.])[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?![A-Za-z0-9_])/g;
/** Loose: same, but a trailing letter is allowed (evidence side is deliberately generous). */
const LOOSE_NUM = /(?<![A-Za-z0-9_.])[-+]?\d+(?:,\d{3})*(?:\.\d+)?/g;

export function sigDigits(text: string): number {
  const digits = text.replace(/[-+,]/g, '').replace('.', '').replace(/^0+/, '');
  return digits.length;
}

export function numbersIn(text: string, loose = false): NumToken[] {
  const out: NumToken[] = [];
  for (const m of text.matchAll(loose ? LOOSE_NUM : STRICT_NUM)) {
    const t = m[0];
    const value = Number(t.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    out.push({ text: t, value, sig: sigDigits(t) });
  }
  return out;
}

function threadNumbers(t: StrategyThread | null): number[] {
  if (!t) return [];
  const strs = [t.entry.price, t.stop_price, t.filled_avg_price, t.qty, t.margin_usdt, ...t.take_profits, ...(t.entry.zone ?? []), String(t.leverage)];
  return strs.filter((s): s is string => typeof s === 'string').map(Number).filter(Number.isFinite);
}

/**
 * Every number the model was allowed to quote: evidence values + the thread block + the as_of year.
 * Evidence registered from long-term memory (kind 'memory') is deliberately **excluded**: system rule 4b
 * says numbers inside a memory are not market numbers, so quoting one in reasons/thesis is a hallucinated
 * market number (and, additionally, a `memory_number_leak`). Runs without memories are unaffected.
 */
export function allowedNumbers(evidence: Evidence[], thread: StrategyThread | null, asOf: number): number[] {
  const nums: number[] = [];
  for (const e of evidence) {
    if (e.kind === MEMORY_EVIDENCE_KIND) continue;
    for (const n of numbersIn(e.value, true)) nums.push(n.value);
  }
  nums.push(...threadNumbers(thread));
  nums.push(new Date(asOf).getUTCFullYear());
  return nums;
}

export const MEMORY_EVIDENCE_KIND = 'memory';

export interface MemoryEvidenceLink {
  ref: string;
  /** The memory id parsed out of the evidence label `记忆 <id>·<kind label>`. */
  id: string;
}

/** The `记忆` evidence lines `demo.buildContext` registered for `EpisodeInputs.memories`. */
export function memoryEvidence(evidence: Evidence[]): MemoryEvidenceLink[] {
  const out: MemoryEvidenceLink[] = [];
  for (const e of evidence) {
    if (e.kind !== MEMORY_EVIDENCE_KIND) continue;
    const m = /^记忆 (\S+?)·/.exec(e.label);
    out.push({ ref: e.ref, id: m?.[1] ?? e.ref });
  }
  return out;
}

/** Every E the judgment leans on: `evidence_refs` plus the `[E<n>]` markers inside reasons. */
export function citedRefs(j: Judgment): Set<string> {
  const set = new Set<string>(j.evidence_refs);
  for (const r of j.reasons) for (const m of r.matchAll(/\bE(\d+)\b/g)) set.add(`E${m[1]}`);
  return set;
}

/** Ids of the injected memories the judgment actually cited (refs ∩ memory evidence). */
export function citedMemoryIds(j: Judgment, evidence: Evidence[]): string[] {
  const cited = citedRefs(j);
  return memoryEvidence(evidence)
    .filter((m) => cited.has(m.ref))
    .map((m) => m.id);
}

/** Numbers that appear in `记忆` evidence values (the pool a memory could have leaked from). */
export function memoryNumbers(evidence: Evidence[]): number[] {
  const nums: number[] = [];
  for (const e of evidence) {
    if (e.kind !== MEMORY_EVIDENCE_KIND) continue;
    for (const n of numbersIn(e.value, true)) nums.push(n.value);
  }
  return nums;
}

/**
 * `memory_number_leak`: ≥ 3-significant-digit numbers in reasons/thesis that **only** a memory can explain —
 * no other evidence value matches them (±0.5 %) but a memory value does. That is the model treating a
 * remembered price as a live market price.
 */
export function memoryOnlyNumbers(j: Judgment, evidence: Evidence[], thread: StrategyThread | null, asOf: number): NumToken[] {
  const memPool = memoryNumbers(evidence);
  if (!memPool.length) return [];
  const pool = allowedNumbers(evidence, thread, asOf);
  const out: NumToken[] = [];
  for (const text of [j.thesis, ...j.reasons]) {
    for (const n of numbersIn(text)) {
      if (n.sig < 3) continue;
      if (matchesAny(n.value, pool)) continue;
      if (matchesAny(n.value, memPool)) out.push(n);
    }
  }
  return out;
}

export const REL_TOL = 0.005;

/** Magnitude match: prose states direction in words ("大跌 3.25%" for "-3.25%"), so signs are ignored. */
export function matchesAny(x: number, pool: number[]): boolean {
  const ax = Math.abs(x);
  for (const e of pool) {
    const ae = Math.abs(e);
    if (ae === 0 ? ax === 0 : Math.abs(ax - ae) <= REL_TOL * ae) return true;
  }
  return false;
}

/** Numbers with ≥ 3 significant digits in reasons/thesis that no evidence value explains (±0.5 %). */
export function hallucinatedNumbers(j: Judgment, evidence: Evidence[], thread: StrategyThread | null, asOf: number): NumToken[] {
  const pool = allowedNumbers(evidence, thread, asOf);
  const out: NumToken[] = [];
  for (const text of [j.thesis, ...j.reasons]) {
    for (const n of numbersIn(text)) {
      if (n.sig < 3) continue;
      if (!matchesAny(n.value, pool)) out.push(n);
    }
  }
  return out;
}

/** refs ⊆ registry and every reason cites at least one registered E. */
export function evidenceValidity(j: Judgment, evidence: Evidence[]): string[] {
  const registry = new Set(evidence.map((e) => e.ref));
  const problems: string[] = [];
  for (const r of j.evidence_refs) if (!registry.has(r)) problems.push(`evidence_refs 含未登记的 ${r}`);
  j.reasons.forEach((reason, i) => {
    const cited = [...reason.matchAll(/\bE(\d+)\b/g)].map((m) => `E${m[1]}`);
    if (!cited.length) problems.push(`reasons[${i}] 未引用任何 E`);
    else for (const c of cited) if (!registry.has(c)) problems.push(`reasons[${i}] 引用了未登记的 ${c}`);
  });
  return problems;
}

/** Invariant 4: the action set the judgment may draw from for this case. */
export function allowedActionsFor(c: EvalCase, builtAllowed: string[]): Set<string> {
  // The judgment graph is the single source of truth (graph-engineering-v2 §2): halted scan → NO_TRADE only,
  // review → the thread's node. `builtAllowed` (what the model was told) wins when present, so a drift between
  // prompt and graph shows up as unauthorized_action rather than being hidden here.
  if (builtAllowed.length) return new Set(builtAllowed);
  return new Set(demo.allowedActions(demo.nodeFor(c.mode === 'review' ? c.thread : null, c.visible.halted)));
}

export function unauthorizedAction(c: EvalCase, builtAllowed: string[], j: Judgment): string | null {
  const allowed = allowedActionsFor(c, builtAllowed);
  if (allowed.has(j.action)) return null;
  return `${j.action} 不在允许集 {${[...allowed].join(', ')}}(${c.mode}${c.visible.halted ? ',紧急停止' : ''}${c.thread ? `,线程 ${c.thread.status}` : ''})`;
}

export interface RubricResult {
  applicable: boolean;
  ok: boolean;
  note: string | null;
}

export function rubricCheck(c: EvalCase, j: Judgment): RubricResult {
  const r = c.hidden.rubric;
  if (!r) return { applicable: false, ok: true, note: null };
  let ok = true;
  if (r.expected_any_of && !r.expected_any_of.includes(j.action)) ok = false;
  if (r.must_not && r.must_not.includes(j.action)) ok = false;
  return { applicable: true, ok, note: r.note ?? null };
}

// ---------------------------------------------------------------- future leakage

const canon = (x: number): string => String(x);

function pushFormats(set: Set<string>, s: string | number, decimals: number[] = [0, 1, 2, 4, 5]): void {
  const n = Number(s);
  if (!Number.isFinite(n)) return;
  set.add(canon(n));
  for (const d of decimals) set.add(canon(Number(n.toFixed(d))));
}

function klineNumbers(ks: Kline[], set: Set<string>): void {
  for (const k of ks) for (const v of [k.open, k.high, k.low, k.close, k.volume]) pushFormats(set, v);
}

/** Numbers derivable from the visible side only (what an honest context may contain). */
export function legitNumbers(c: EvalCase): Set<string> {
  const set = new Set<string>();
  for (const ks of Object.values(c.visible.klines)) klineNumbers(ks, set);
  for (const tf of featureTfs(c)) {
    const f = demo.tfFeatures(tf, c.visible.klines[tf]!);
    for (const v of [f.last_close, f.ema20, f.ema50, f.atr14, f.swing_high_20, f.swing_low_20, f.swing_high_50, f.swing_low_50, f.dist_to_high20_pct, f.dist_to_low20_pct, f.vol_ratio_20, f.change_pct_last, f.change_pct_5, (f.atr14 / f.last_close) * 100]) pushFormats(set, v);
    for (const n of numbersIn(f.last_bars, true)) set.add(canon(n.value));
  }
  const m = c.visible.market;
  for (const v of [m.last, m.mark, m.open_interest, m.funding_rate, Number(m.funding_rate) * 100]) pushFormats(set, v);
  const t = c.visible.ticker24h;
  for (const v of [t.priceChangePercent, t.highPrice, t.lowPrice, t.quoteVolume, Number(t.quoteVolume) / 1e6]) pushFormats(set, v);
  const a = c.visible.account;
  for (const v of [a.equity, a.available, a.unrealized_pnl]) pushFormats(set, v);
  for (const p of a.positions) for (const v of [p.qty, p.entry_price, p.mark_price, p.unrealized_pnl, p.leverage]) pushFormats(set, v);
  for (const o of a.open_orders) for (const v of [o.qty, o.price ?? '', o.stop_price ?? '']) pushFormats(set, v);
  for (const v of threadNumbers(c.thread)) pushFormats(set, v);
  if (c.visible.market_state) for (const n of numbersIn(JSON.stringify(c.visible.market_state), true)) set.add(canon(n.value));
  if (c.visible.oi_change_1h_pct !== null) pushFormats(set, c.visible.oi_change_1h_pct);
  return set;
}

/** Numbers that exist only in the hidden future (at the precisions the context could print). */
export function futureNumbers(c: EvalCase): Set<string> {
  const set = new Set<string>();
  for (const k of c.hidden.future_klines) for (const v of [k.open, k.high, k.low, k.close]) pushFormats(set, v, [0, 1, 2]);
  return set;
}

/**
 * Invariant 1. Flags: visible bars closing after as_of (or opening at/after it); a visible bar that is
 * byte-identical to a hidden one (copied future bar); any ≥3-significant-digit number in the context
 * that exists in the hidden future but is not derivable from the visible side; any timestamp after as_of.
 */
export function detectLeakage(c: EvalCase, contextText: string): string[] {
  const v: string[] = [];
  for (const [tf, ks] of Object.entries(c.visible.klines)) {
    for (const k of ks) {
      if (k.close_time > c.as_of) v.push(`visible ${tf} bar open_time=${k.open_time} close_time=${k.close_time} > as_of`);
      else if (k.open_time >= c.as_of) v.push(`visible ${tf} bar open_time=${k.open_time} ≥ as_of`);
    }
  }
  const futureTuples = new Set(c.hidden.future_klines.map((k) => `${k.open}|${k.high}|${k.low}|${k.close}|${k.volume}`));
  for (const [tf, ks] of Object.entries(c.visible.klines)) {
    if (tf !== c.timeframe) continue;
    for (const k of ks) if (futureTuples.has(`${k.open}|${k.high}|${k.low}|${k.close}|${k.volume}`)) v.push(`visible ${tf} bar at ${k.open_time} equals a hidden future bar`);
  }
  const legit = legitNumbers(c);
  const future = futureNumbers(c);
  const seen = new Set<string>();
  for (const n of numbersIn(contextText, true)) {
    if (n.sig < 3) continue;
    const key = canon(n.value);
    if (seen.has(key)) continue;
    seen.add(key);
    if (future.has(key) && !legit.has(key)) v.push(`context 含只存在于未来 K 线的数值 ${n.text}`);
  }
  const year = new Date(c.as_of).getUTCFullYear();
  for (const m of contextText.matchAll(/(?<!\d)(\d{2})-(\d{2}) (\d{2}):(\d{2})(?!\d)/g)) {
    const t = Date.UTC(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]));
    if (t > c.as_of && t - c.as_of < 180 * 86_400_000) v.push(`context 含 as_of 之后的时间 ${m[0]}`);
  }
  for (const m of contextText.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g)) {
    const t = Date.parse(m[0].endsWith('Z') ? m[0] : `${m[0]}Z`);
    if (Number.isFinite(t) && t > c.as_of) v.push(`context 含 as_of 之后的时间 ${m[0]}`);
  }
  return v;
}

// ---------------------------------------------------------------- derived numbers (09-12)

/**
 * 派生数字的来源标注(PROMPT_VERSION `demo-playbook-v11-formula` 规则 2b/2c)。
 *
 * 09-04 的 13 个幻觉里 12 个是模型自己算的浮盈 / 止损距离 / R 差值 —— 旧口径「数字必须在证据里逐字出现」
 * 把它们全判成幻觉(假阳性)。于是引入了来源标注。
 *
 * 但 09-12 复审(P1-16)证明「只给编号」的标注是可以被洗白的:把所引证据里的**所有数字**抓出来做和差比乘
 * 穷举,丢掉了单位、字段名和符号,于是 `资金费率 180.0%(由 E1 算出)`(E1 只有 `mark 100; entry 90; qty 2`)
 * 也能靠 90×2 判通过。所以现在的口径是:
 *
 * - **公式标注**(`(由 (E6.mark-E7.entry)*E7.qty 算出)`):代码按**字段级引用**从证据文本里取数,自己复算,
 *   **带符号**相等才算数。这是唯一能进 `derived_ok` 的路径。
 * - **只给编号**(`(由 E3,E7 算出)`):只证明「这个数能用那几条证据拼出来」,不是复算相等,归入 `derived_weak`
 *   并且**照样计入 strict 幻觉**。保留它只是为了报告里能看出模型还在用旧写法。
 *
 * 格式对 GLM / DeepSeek 这类便宜模型最不容易写错的是「紧跟在数字后面的一个内联括号」,不是结构化字段:
 * 它不需要模型再维护一份与正文对齐的数组,漏一项/错一项都不会让整段 JSON 失效。全角/半角括号与逗号都认。
 */

/** 标注壳 `(由 <body> 算出)`。body 里可以有嵌套括号,所以手写扫描而不是正则。 */
interface MarkerHit {
  start: number;
  end: number;
  body: string;
}

const MARKER_OPEN = /[(（]\s*由\s*/g;

function scanMarkers(text: string): MarkerHit[] {
  const out: MarkerHit[] = [];
  const re = new RegExp(MARKER_OPEN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '(' || ch === '（') depth++;
      else if (ch === ')' || ch === '）') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    const tail = /^([\s\S]*?)\s*算出\s*$/.exec(text.slice(bodyStart, i));
    if (tail) out.push({ start: m.index, end: i + 1, body: tail[1]!.trim() });
    re.lastIndex = i + 1;
  }
  return out;
}

/** 数字 + 可选单位,紧贴标注左侧。 */
const NUM_BEFORE_MARKER = /([-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:%|％|R|r|倍|×|x|X|USDT|U|美元|点)?\s*$/;

/** 复算容差:模型会四舍五入,所以取「相对 1%」与「所写小数位的半个单位」里更宽的那个。 */
export const DERIVED_REL_TOL = 0.01;

export type DerivedOp = 'formula' | 'quote' | 'diff' | 'sum' | 'ratio' | 'pct' | 'atr_mult' | 'r_mult' | 'diff_mult' | 'product';

/** `formula` = 写了字段级公式(唯一能算复算通过的);`pool` = 旧的只给编号。 */
export type DerivedMode = 'formula' | 'pool';

export interface DerivedAnnotation {
  /** 被标注的数字原文。 */
  text: string;
  value: number;
  sig: number;
  /** 标注里声明(或公式里引用)的证据编号。 */
  refs: string[];
  /** 标注原文(`(由 E3,E7 算出)`)。 */
  marker: string;
  mode: DerivedMode;
  /** mode='formula' 时的公式原文;'pool' 时为 null。 */
  formula: string | null;
  /** 数字在原文里的起点(把它从旧口径扫描里摘出去要用)。 */
  num_start: number;
  /** 「数字 + 标注」整段的终点。 */
  span_end: number;
}

export interface DerivedCheck {
  annotation: DerivedAnnotation;
  /** 认可为可信派生:**只有**公式复算带符号相等才为 true。 */
  ok: boolean;
  /** 复算成立(公式相等,或旧口径下能用允许的运算拼出来)。pool 模式下 verified=true 也只是 weak。 */
  verified: boolean;
  mode: DerivedMode;
  /** 复算命中的运算;公式模式为 'formula',失败为 null。 */
  op: DerivedOp | null;
  /** 未登记的证据编号(只要非空就判幻觉)。 */
  unknown_refs: string[];
  reason: string | null;
}

/** 标注体解析:出现 `E<数字>.<字段>` 就算公式标注,否则必须是纯编号列表,再不然这个标注不认。 */
function parseMarkerBody(body: string): { mode: DerivedMode; refs: string[]; formula: string | null } | null {
  const refsOf = (s: string): string[] => [...new Set([...s.matchAll(/\bE(\d+)\b/g)].map((m) => `E${m[1]}`))];
  if (/\bE\d+\s*\./.test(body)) {
    const refs = refsOf(body);
    return refs.length ? { mode: 'formula', refs, formula: body } : null;
  }
  if (/^E\d+(?:\s*[,，、和\s]\s*E\d+)*$/.test(body)) return { mode: 'pool', refs: refsOf(body), formula: null };
  return null;
}

/** 文本里所有「数字 + 来源标注」对。标注前面没有数字、或标注体认不出来的,不算标注,原数字仍走旧判。 */
export function derivedAnnotations(text: string): DerivedAnnotation[] {
  const out: DerivedAnnotation[] = [];
  for (const h of scanMarkers(text)) {
    const head = text.slice(0, h.start);
    const nm = NUM_BEFORE_MARKER.exec(head);
    if (!nm) continue;
    const t = nm[1]!;
    const value = Number(t.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const parsed = parseMarkerBody(h.body);
    if (!parsed) continue;
    out.push({
      text: t,
      value,
      sig: sigDigits(t),
      refs: parsed.refs,
      marker: text.slice(h.start, h.end),
      mode: parsed.mode,
      formula: parsed.formula,
      num_start: head.length - nm[0].length,
      span_end: h.end,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 证据 → 字段表

const FIELD_NUM = String.raw`[-+]?\d+(?:,\d{3})*(?:\.\d+)?`;
const UNIT = String.raw`(?:%|％|R|倍|×|x|X|USDT|U|美元|点|bp)?`;
const NUMERIC_TOKEN = new RegExp(String.raw`^[([（【]?(${FIELD_NUM})\s*${UNIT}[)\]）】]?[。,;、]?$`);
const INLINE_PAIR = new RegExp(String.raw`^(.*[^\d\s:：=])[:：=]\s*(${FIELD_NUM})\s*${UNIT}$`);

/** 字段名归一:去掉两侧标点、小写;不含字母/数字/汉字的(如 `@`)不是字段名。 */
function normalizeField(raw: string): string {
  const s = raw.replace(/^[\s:：=@·|、,，;；()（）[\]【】"'`]+/, '').replace(/[\s:：=@·|、,，;；()（）[\]【】"'`]+$/, '');
  if (!/[A-Za-z0-9一-鿿]/.test(s)) return '';
  return s.toLowerCase();
}

/**
 * 把一条证据的文本解析成 `字段名 → 数值`。证据长的是 `收 100; EMA20 107877.5; ATR14 138.74` 这种
 * 「标签 数字」串,按 `;,，、换行` 分段、段内按空白分词:一个纯数字 token 的字段名是它前面那个非数字 token。
 * 同名字段出现两次且值不同 → 记成 `null`(歧义),公式引用它时直接判失败,不猜。
 */
export function evidenceFields(value: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const put = (rawName: string, v: number): void => {
    const k = normalizeField(rawName);
    if (!k || !Number.isFinite(v)) return;
    if (!out.has(k)) {
      out.set(k, v);
      return;
    }
    const prev = out.get(k);
    if (prev === null || prev === v) return;
    out.set(k, null);
  };
  for (const seg of value.split(/[;；,，\n]/)) {
    let prevTok = '';
    let prevWasNum = false;
    for (const tok of seg.split(/\s+/).filter(Boolean)) {
      const inline = INLINE_PAIR.exec(tok);
      if (inline) {
        put(inline[1]!, Number(inline[2]!.replace(/,/g, '')));
        prevWasNum = true;
        continue;
      }
      const num = NUMERIC_TOKEN.exec(tok);
      if (num) {
        if (!prevWasNum) put(prevTok, Number(num[1]!.replace(/,/g, '')));
        prevWasNum = true;
        continue;
      }
      prevTok = tok;
      prevWasNum = false;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 公式复算

/** 复算失败的原因(不用异常类型区分,消息直接进报告)。 */
class FormulaError extends Error {}

type FormulaTok =
  | { t: 'num'; v: number; text: string }
  | { t: 'field'; ref: string; field: string }
  | { t: 'op'; v: string };

const FIELD_REF = new RegExp(String.raw`^E(\d+)\s*\.\s*([A-Za-z0-9_%一-鿿]+)`);
const LITERAL = new RegExp(String.raw`^${FIELD_NUM}`);

function tokenizeFormula(src: string): FormulaTok[] {
  const norm = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/（/g, '(').replace(/）/g, ')').replace(/−/g, '-');
  const out: FormulaTok[] = [];
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if ('+-*/()'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    const rest = norm.slice(i);
    const f = FIELD_REF.exec(rest);
    if (f) {
      out.push({ t: 'field', ref: `E${f[1]}`, field: normalizeField(f[2]!) });
      i += f[0].length;
      continue;
    }
    const l = LITERAL.exec(rest);
    if (l) {
      out.push({ t: 'num', v: Number(l[0].replace(/,/g, '')), text: l[0] });
      i += l[0].length;
      continue;
    }
    throw new FormulaError(`公式里有看不懂的字符 “${ch}”`);
  }
  if (!out.length) throw new FormulaError('公式是空的');
  return out;
}

/**
 * 不用 `eval` 的递归下降求值:`+ - * / ( )`,操作数 = `E<k>.<字段>` 或字面量。
 * 字面量只允许 **100**(百分号换算)或**该数字在被引证据里逐字出现**,免得模型塞一个无关常数把数凑出来。
 */
function evalFormula(src: string, evidenceByRef: Map<string, Evidence>): number {
  const toks = tokenizeFormula(src);
  const fieldsCache = new Map<string, Map<string, number | null>>();
  const literalPool = new Set<number>();
  for (const t of toks) {
    if (t.t !== 'field') continue;
    const e = evidenceByRef.get(t.ref);
    if (!e) throw new FormulaError(`公式引用了未登记的 ${t.ref}`);
    if (e.kind === MEMORY_EVIDENCE_KIND) throw new FormulaError(`公式引用了记忆证据 ${t.ref},记忆里的数字不是行情数字`);
    if (!fieldsCache.has(t.ref)) fieldsCache.set(t.ref, evidenceFields(e.value));
    for (const n of numbersIn(e.value, true)) literalPool.add(n.value);
  }

  let pos = 0;
  const peek = (): FormulaTok | undefined => toks[pos];
  const eat = (v: string): boolean => {
    const t = peek();
    if (t && t.t === 'op' && t.v === v) {
      pos++;
      return true;
    }
    return false;
  };

  const expr = (): number => {
    let v = term();
    for (;;) {
      if (eat('+')) v += term();
      else if (eat('-')) v -= term();
      else return v;
    }
  };
  const term = (): number => {
    let v = factor();
    for (;;) {
      if (eat('*')) v *= factor();
      else if (eat('/')) {
        const d = factor();
        if (d === 0) throw new FormulaError('公式里出现除以 0');
        v /= d;
      } else return v;
    }
  };
  const factor = (): number => {
    if (eat('-')) return -factor();
    if (eat('+')) return factor();
    if (eat('(')) {
      const v = expr();
      if (!eat(')')) throw new FormulaError('公式括号不配对');
      return v;
    }
    const t = peek();
    if (!t) throw new FormulaError('公式在这里断了');
    pos++;
    if (t.t === 'num') {
      if (t.v !== 100 && !literalPool.has(t.v)) throw new FormulaError(`公式里的常数 ${t.text} 在被引证据里找不到`);
      return t.v;
    }
    if (t.t === 'field') {
      const fields = fieldsCache.get(t.ref)!;
      if (!fields.has(t.field)) throw new FormulaError(`${t.ref} 里找不到字段 ${t.field}`);
      const v = fields.get(t.field);
      if (v === null || v === undefined) throw new FormulaError(`${t.ref} 的字段 ${t.field} 有多个不同的值,无法确定`);
      return v;
    }
    throw new FormulaError(`公式里多了一个 “${t.v}”`);
  };

  const value = expr();
  if (pos !== toks.length) throw new FormulaError('公式结尾有多余的内容');
  if (!Number.isFinite(value)) throw new FormulaError('公式算出来不是一个有限的数');
  return value;
}

// ---------------------------------------------------------------- 旧「只给编号」的穷举(降级为 weak)

const POOL_CAP = 32;
const DIFF_CAP = 600;

function dedupNums(xs: number[], cap: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of xs) {
    if (!Number.isFinite(x) || x === 0 || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= cap) break;
  }
  return out;
}

function roundingEps(text: string): number {
  const dot = text.indexOf('.');
  const d = dot < 0 ? 0 : text.length - dot - 1;
  return 0.5 * Math.pow(10, -d);
}

/** 复算容差(带符号比,不再比绝对值 —— 符号翻转就是算错了)。 */
function toleranceFor(target: number, text: string): number {
  return Math.max(DERIVED_REL_TOL * Math.abs(target), roundingEps(text), 1e-9);
}

/** 带符号相等。 */
function near(computed: number, target: number, eps: number): boolean {
  return Math.abs(computed - target) <= eps;
}

/**
 * 有限运算集的穷举。它只能证明「这个数能用那几条证据里的数字拼出来」,证明不了「模型是这么算的」,
 * 所以命中只给 `derived_weak`,不给 `derived_ok`(P1-16)。运算集故意不含幂/对数。
 */
export function recomputeDerived(target: number, text: string, pool: number[]): DerivedOp | null {
  const eps = toleranceFor(target, text);
  const p = dedupNums(pool, POOL_CAP);
  if (!p.length) return null;
  for (const a of p) if (near(a, target, eps)) return 'quote';
  const diffs: number[] = [];
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < p.length; j++) {
      if (i === j) continue;
      const d = p[i]! - p[j]!;
      if (d !== 0) diffs.push(d);
      if (i < j && near(p[i]! + p[j]!, target, eps)) return 'sum';
    }
  }
  for (const d of diffs) if (near(d, target, eps)) return 'diff';
  for (const a of p) for (const b of p) if (b !== 0 && near(a / b, target, eps)) return 'ratio';
  for (const a of p) for (const b of p) if (b !== 0 && near((a / b) * 100, target, eps)) return 'pct';
  const ds = dedupNums(diffs, DIFF_CAP);
  for (const d of ds) for (const b of p) if (b !== 0 && near(d / b, target, eps)) return 'atr_mult';
  for (const d of ds) for (const b of p) if (b !== 0 && near((d / b) * 100, target, eps)) return 'pct';
  for (const d of ds) for (const b of p) if (near(d * b, target, eps)) return 'diff_mult';
  for (const a of p) for (const b of p) if (near(a * b, target, eps)) return 'product';
  for (const d1 of ds) for (const d2 of ds) if (d2 !== 0 && near(d1 / d2, target, eps)) return 'r_mult';
  return null;
}

/**
 * 一条标注的复算结果。
 * - 公式标注:代码按字段级引用复算,**带符号**相等才 `ok`;字段查不到 / 编号未登记 / 引用记忆证据 → 判幻觉。
 * - 只给编号:最好也只能到 `verified`(weak),永远不 `ok`。
 */
export function checkDerived(a: DerivedAnnotation, evidence: Evidence[]): DerivedCheck {
  const byRef = new Map(evidence.map((e) => [e.ref, e]));
  const base = { annotation: a, mode: a.mode, unknown_refs: [] as string[] };
  const fail = (reason: string, unknown: string[] = []): DerivedCheck => ({ ...base, ok: false, verified: false, op: null, unknown_refs: unknown, reason });
  if (!a.refs.length) return fail('标注里没有证据编号');
  const unknown = a.refs.filter((r) => !byRef.has(r));
  if (unknown.length) return fail(`标注引用了未登记的 ${unknown.join(', ')}`, unknown);
  const mem = a.refs.filter((r) => byRef.get(r)!.kind === MEMORY_EVIDENCE_KIND);
  if (mem.length) return fail(`标注引用了记忆证据 ${mem.join(', ')},记忆里的数字不是行情数字`);

  if (a.mode === 'formula') {
    let computed: number;
    try {
      computed = evalFormula(a.formula!, byRef);
    } catch (err) {
      return fail(`${a.text} 的公式 ${a.formula} 复算失败:${err instanceof Error ? err.message : String(err)}`);
    }
    if (!near(computed, a.value, toleranceFor(a.value, a.text))) {
      return fail(`${a.text} 与公式 ${a.formula} 复算结果 ${computed} 对不上(带符号比)`);
    }
    return { ...base, ok: true, verified: true, op: 'formula', reason: null };
  }

  const pool: number[] = [];
  for (const r of a.refs) for (const n of numbersIn(byRef.get(r)!.value, true)) pool.push(n.value);
  const op = recomputeDerived(a.value, a.text, pool);
  if (op) {
    return {
      ...base,
      ok: false,
      verified: true,
      op,
      reason: `${a.text} 只给了证据编号(${a.refs.join(',')}),没给公式:代码只能证明它能用那几条证据的数字拼出来(${op}),不算复算通过`,
    };
  }
  return fail(`${a.text} 用 ${a.refs.join(',')} 的数字按允许的运算算不出来`);
}

export interface HallucinationReport {
  /** 旧口径(09-04 用的那个):所有 ≥3 位有效数字、证据里找不到的数,标注与否一视同仁。 */
  raw: NumToken[];
  /** 新口径:没标注的数按旧判;只有**公式复算通过**的派生数才被摘掉,weak 与 bad 都留下。 */
  strict: NumToken[];
  /** 公式复算通过的派生数(唯一可信的一档)。 */
  derived_ok: DerivedCheck[];
  /** 只给编号、靠穷举拼出来的派生数(计入 strict)。 */
  derived_weak: DerivedCheck[];
  /** 复算失败的派生数(计入 strict)。 */
  derived_bad: DerivedCheck[];
}

/**
 * 两个口径一起算,报告两个都出(`hallucination_raw` 与 `hallucination`),方便与 09-04 之前的历史对照。
 */
export function hallucinationReport(j: Judgment, evidence: Evidence[], thread: StrategyThread | null, asOf: number): HallucinationReport {
  const pool = allowedNumbers(evidence, thread, asOf);
  const raw: NumToken[] = [];
  const strict: NumToken[] = [];
  const derivedOk: DerivedCheck[] = [];
  const derivedWeak: DerivedCheck[] = [];
  const derivedBad: DerivedCheck[] = [];
  for (const text of [j.thesis, ...j.reasons]) {
    const anns = derivedAnnotations(text);
    const badStarts = new Set<number>();
    for (const a of anns) {
      const c = checkDerived(a, evidence);
      if (c.ok) derivedOk.push(c);
      else {
        (c.verified ? derivedWeak : derivedBad).push(c);
        badStarts.add(a.num_start);
      }
    }
    const inSpan = (i: number, len: number): boolean => anns.some((a) => i >= a.num_start && i + len <= a.span_end);
    for (const m of text.matchAll(STRICT_NUM)) {
      const t = m[0];
      const value = Number(t.replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      const n: NumToken = { text: t, value, sig: sigDigits(t) };
      if (n.sig < 3) continue;
      const idx = m.index ?? 0;
      const explained = matchesAny(n.value, pool);
      if (!explained) raw.push(n);
      // 标注区间里的数字(被标注的那个数 + 公式里的字面量):被标注的数由复算说了算,
      // 公式里的字面量已经在解析时校验过(只允许 100 或证据里逐字出现的数)。
      if (inSpan(idx, t.length)) {
        if (badStarts.has(idx)) strict.push(n);
      } else if (!explained) strict.push(n);
    }
  }
  return { raw, strict, derived_ok: derivedOk, derived_weak: derivedWeak, derived_bad: derivedBad };
}

/** 新口径的幻觉数字(`hallucination`)。 */
export function hallucinatedNumbersStrict(j: Judgment, evidence: Evidence[], thread: StrategyThread | null, asOf: number): NumToken[] {
  return hallucinationReport(j, evidence, thread, asOf).strict;
}
