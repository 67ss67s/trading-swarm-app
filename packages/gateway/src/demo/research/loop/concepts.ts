/**
 * 概念解析 loop(§9.45)。问题先被拆成「概念」,每个概念解析到三种来源之一:
 *   1. 原语目录 registry(listPrimitives) —— 已经能直接回测的实现;
 *   2. 指标/形态词典 lexicon.ts —— 中英文术语到实现的映射表,含近似与未支持的如实标注;
 *   3. data adapter 目录 —— 数据指标(价格/资金费/持仓量/清算/订单簿…)的可得性。
 * 解析不出的概念不阻塞计划:它们被记成 unmapped,交给 acquire_concept 子 loop 去获取,
 * 同时进报告的「概念覆盖」段与答案的 data_gap 块,让用户看见「哪些没支持、为什么」。
 */
import { pineCatalog } from "../pine/catalog.js";
import type { Brain } from "../../brain.js";
import { listPrimitives } from "../primitives/index.js";
import {
  LEXICON,
  leftoverText,
  lookupTerm,
  matchLexicon,
  type ConceptCategory,
  type LexiconEntry,
} from "./lexicon.js";

export type { ConceptCategory } from "./lexicon.js";

export type ConceptStatus =
  | "mapped" // 有可直接使用的实现
  | "acquired" // 本轮通过 acquire_concept 拿到了定义与实现方式
  | "proxy" // 用近似实现代替,语义有差异且已标注
  | "unmapped"; // 没有实现,原因见 note

export type ConceptSource =
  | "primitive_registry"
  | "lexicon"
  | "data_catalog"
  | "acquired"
  | "none";

export interface ResolvedConcept {
  /** 问题里的原文片段 */
  term: string;
  /** 规范概念 id;未识别时等于 term */
  concept_id: string;
  category: ConceptCategory;
  status: ConceptStatus;
  source: ConceptSource;
  /** 原语名 / 数据 metric / 指标表行名 / 周期代号 / 资产符号;没有实现时为 null */
  target: string | null;
  note: string;
}

// ── data adapter 钩子 ────────────────────────────────────────────────────
// 另一个工作包在做 data/catalog.ts。这里只声明接口并给一个占位实现(沿用 inspect_data_coverage 的现有语义),
// 接线方式:`setDataConceptResolver((metric) => catalog.lookup(metric))`,签名见 DataConceptResolver。

export interface DataConceptCoverage {
  metric: string;
  availability: "available" | "partial" | "missing" | "not_applicable";
  note: string;
}
export type DataConceptResolver = (
  metric: string,
) => DataConceptCoverage | null;

/** 占位表:与 inspect_data_coverage / get_liquidation_estimates 当前的返回语义一致。 */
const PLACEHOLDER_DATA_CATALOG: Record<string, DataConceptCoverage> = {
  price: { metric: "price", availability: "available", note: "OKX K 线快照。" },
  funding: { metric: "funding", availability: "available", note: "已结算资金费率;现货不适用。" },
  open_interest: { metric: "open_interest", availability: "available", note: "永续持仓量;现货不适用。" },
  liquidations: { metric: "liquidations", availability: "partial", note: "公共接口只给最近若干条,窗口通常覆盖不全。" },
  liquidation_estimates: { metric: "liquidation_estimates", availability: "missing", note: "估计数据源尚未接入。" },
  orderbook: { metric: "orderbook", availability: "missing", note: "订单簿快照未接。" },
};

let dataResolver: DataConceptResolver = (metric) =>
  PLACEHOLDER_DATA_CATALOG[metric] ?? null;

/** data/catalog.ts 就绪后由组装处调用一次;传 null 恢复占位实现。 */
export function setDataConceptResolver(resolver: DataConceptResolver | null): void {
  dataResolver = resolver ?? ((metric) => PLACEHOLDER_DATA_CATALOG[metric] ?? null);
}
export function resolveDataConcept(metric: string): DataConceptCoverage | null {
  return dataResolver(metric);
}

// ── 抽概念 ───────────────────────────────────────────────────────────────

const SYMBOLS =
  /\b(?:BTC|ETH|SOL|DOGE|XRP|BNB|ADA|AVAX|DOT|LINK|TON|SUI|HYPE|OKB|PEPE|LTC|TRX)\b/gi;

/** 未知概念探测:这些后缀说明用户在说一个「指标/形态」,前缀词却不在词典里。 */
const UNKNOWN_SUFFIX = /([一-龥A-Za-z0-9%]{1,12})\s*(背离|形态|指标|通道|均线|信号|买点|卖点|图形|曲线|振荡器|震荡指标|摆动指标|云图)/g;
/** 词典没收录的英文术语(Coppock、Fisher Transform、Vortex…):首字母大写或全大写、至少 4 个字母,最多三个词。 */
const ENGLISH_TERM = /\b(?:[A-Z][A-Za-z]{3,}|[A-Z]{3,})(?:\s+(?:[A-Z][A-Za-z]{2,}|[A-Z]{2,})){0,2}\b/g;
const ENGLISH_STOP = new Set(["strategy", "backtest", "buy", "hold", "spot", "perp", "okx", "binance", "usdt", "usd", "pine", "long", "short", "daily", "hourly", "with", "and", "the", "vs", "true", "false", "api", "json"]);
/** 用户主动用引号圈出来的术语,一律当概念看。 */
const QUOTED = /[「『“"']([^」』”"']{1,20})[」』”"']/g;

export interface ExtractedConcept {
  term: string;
  category: ConceptCategory;
  entry?: LexiconEntry;
}

/** 从问题里抽概念:词典命中 + 原语名直呼 + 资产符号 + 未识别的指标/形态词。顺序稳定、不做模型调用。 */
export function extractConcepts(question: string): ExtractedConcept[] {
  const out: ExtractedConcept[] = [];
  const seen = new Set<string>();
  const push = (term: string, category: ConceptCategory, entry?: LexiconEntry) => {
    const key = (entry?.id ?? term).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ term, category, ...(entry ? { entry } : {}) });
  };
  for (const m of matchLexicon(question)) push(m.term, m.entry.category, m.entry);
  // 直接写原语名(ema_cross / order_blocks …)也算一个概念
  const lower = question.toLowerCase();
  for (const p of listPrimitives().items)
    if (lower.includes(p.name)) push(p.name, categoryOfPrimitive(p.category));
  for (const s of question.match(SYMBOLS) ?? []) push(s.toUpperCase(), "asset");
  const leftover = leftoverText(question);
  for (const m of leftover.matchAll(UNKNOWN_SUFFIX))
    push(m[0]!.trim(), /背离|指标|均线/.test(m[2]!) ? "indicator" : "pattern");
  for (const m of leftover.matchAll(QUOTED)) {
    const term = m[1]!.trim();
    if (term) push(term, lookupTerm(term)?.category ?? "pattern", lookupTerm(term));
  }
  // 词典和原语目录都没有的英文术语(2026-09-22 实测「Coppock 曲线」整句没抽出任何未知概念,模型编译时就凭空造 script_id)
  for (const m of leftover.matchAll(ENGLISH_TERM)) {
    // 多词术语去掉资产代码与停用词(「BTC Coppock」→「Coppock」,2026-09-23 实测同一概念被抽成两个、各跑一遍获取)
    const words = m[0]!.trim().split(/\s+/).filter((w) => { const sym = /^[A-Z]{2,6}$/.test(w) && SYMBOLS.test(w); SYMBOLS.lastIndex = 0; return !sym && !ENGLISH_STOP.has(w.toLowerCase()); });
    const term = words.join(" ");
    if (!term || term.length < 4) continue;
    // 「Coppock 曲线」已被后缀规则抽走时,不再单独抽一个「Coppock」
    if (out.some((c) => c.term.toLowerCase().includes(term.toLowerCase()))) continue;
    push(term, lookupTerm(term)?.category ?? "indicator", lookupTerm(term));
  }
  return out;
}

function categoryOfPrimitive(category: string): ConceptCategory {
  return category === "structure"
    ? "structure"
    : category === "signal" || category === "indicator"
      ? "indicator"
      : "risk";
}

// ── 解析概念 ─────────────────────────────────────────────────────────────

const PRIMITIVE_NAMES = new Set(listPrimitives().items.map((p) => p.name));
/** Pine 目录里按名字找已准入脚本:先整词,再去掉「曲线/指标/线」等后缀。 */
function catalogScript(term: string): { id: string; name: string; description: string } | null {
  const cat = pineCatalog();
  if (!cat) return null;
  for (const q of [term, term.replace(/\s*(曲线|指标|线|振荡器|震荡指标)$/, "")].filter((x, i, a) => x.length >= 3 && a.indexOf(x) === i)) {
    const hit = cat.search(q, { admitted: true, limit: 1 })[0];
    if (hit) return { id: hit.id, name: hit.name, description: hit.description };
  }
  return null;
}

function resolveOne(c: ExtractedConcept): ResolvedConcept {
  const base = { term: c.term, category: c.category };
  // 1. 原语目录:直呼原语名
  if (PRIMITIVE_NAMES.has(c.term))
    return { ...base, concept_id: c.term, status: "mapped", source: "primitive_registry", target: c.term, note: "原语目录已有实现。" };
  const entry = c.entry;
  // 资产与周期不需要「实现」:前者由 resolve_instruments 落到合约,后者是计划参数
  if (!entry && c.category === "asset")
    return { ...base, concept_id: c.term, status: "mapped", source: "data_catalog", target: c.term, note: "由 resolve_instruments 确认是否在售。" };
  if (!entry && c.category === "timeframe")
    return { ...base, concept_id: c.term, status: "mapped", source: "data_catalog", target: c.term, note: "作为计划的 timeframe 参数。" };
  // 已准入的 Pine 脚本(之前获取过的指标/形态)直接复用,不再每问一次就重写一份(2026-09-23 实测 Coppock 被写了三份)
  const pine = (!entry || entry.kind === "indicator_row" || entry.kind === "unsupported") && ["indicator", "pattern", "structure"].includes(c.category) ? catalogScript(c.term) : null;
  if (pine)
    return { ...base, concept_id: c.term, status: "acquired", source: "acquired", target: pine.id, note: `Pine 目录已有通过准入的脚本「${pine.name}」(script_id=${pine.id}),用 pine_series 原语引用。` };
  if (!entry)
    return { ...base, concept_id: c.term, status: "unmapped", source: "none", target: null, note: "原语目录与词典都没有这个概念;需要先定义它的判定规则。" };
  // 2. 词典
  if (entry.kind === "primitive") {
    const exists = entry.target ? PRIMITIVE_NAMES.has(entry.target) : false;
    if (!exists)
      return { ...base, concept_id: entry.id, status: "unmapped", source: "lexicon", target: null, note: `词典指向的原语 ${entry.target} 不在目录里(词典已过期)。` };
    return {
      ...base,
      concept_id: entry.id,
      status: entry.approximate ? "proxy" : "mapped",
      source: entry.approximate ? "lexicon" : "primitive_registry",
      target: entry.target,
      note: entry.note,
    };
  }
  // 3. data adapter 目录
  if (entry.kind === "data_metric") {
    const coverage = entry.target ? resolveDataConcept(entry.target) : null;
    if (!coverage)
      return { ...base, concept_id: entry.id, status: "unmapped", source: "data_catalog", target: entry.target, note: `数据目录里没有 ${entry.target};${entry.note}` };
    if (coverage.availability === "available")
      return { ...base, concept_id: entry.id, status: entry.approximate ? "proxy" : "mapped", source: "data_catalog", target: entry.target, note: entry.approximate ? entry.note : coverage.note };
    if (coverage.availability === "partial")
      return { ...base, concept_id: entry.id, status: "proxy", source: "data_catalog", target: entry.target, note: coverage.note };
    return { ...base, concept_id: entry.id, status: "unmapped", source: "data_catalog", target: entry.target, note: coverage.note };
  }
  if (entry.kind === "indicator_row")
    return { ...base, concept_id: entry.id, status: "unmapped", source: "lexicon", target: entry.target, note: entry.note };
  if (entry.kind === "unsupported")
    return { ...base, concept_id: entry.id, status: "unmapped", source: "lexicon", target: null, note: entry.note };
  // comparison / timeframe / asset:由计划模板或回测步骤承担,不需要原语
  return { ...base, concept_id: entry.id, status: "mapped", source: "lexicon", target: entry.target, note: entry.note };
}

export interface ConceptResolution {
  concepts: ResolvedConcept[];
  mapped: ResolvedConcept[];
  proxied: ResolvedConcept[];
  unmapped: ResolvedConcept[];
}

/** 确定性解析:不调模型、不读网络。acquired 由 acquire_concept 之后 merge 进来。 */
export function resolveConcepts(
  question: string,
  acquired: ResolvedConcept[] = [],
): ConceptResolution {
  const byId = new Map<string, ResolvedConcept>();
  for (const c of extractConcepts(question)) {
    const r = resolveOne(c);
    if (!byId.has(r.concept_id)) byId.set(r.concept_id, r);
  }
  for (const a of acquired) byId.set(a.concept_id, a);
  const concepts = [...byId.values()];
  return {
    concepts,
    mapped: concepts.filter((c) => c.status === "mapped" || c.status === "acquired"),
    proxied: concepts.filter((c) => c.status === "proxy"),
    unmapped: concepts.filter((c) => c.status === "unmapped"),
  };
}

/** 词典里能直接用的原语(mapped/proxy)按概念 id 取出,给模式模板挑信号用。 */
export function usableTargets(resolution: ConceptResolution, category: ConceptCategory): ResolvedConcept[] {
  return [...resolution.mapped, ...resolution.proxied].filter(
    (c) => c.category === category && c.target && PRIMITIVE_NAMES.has(c.target),
  );
}

// ── 获取子 loop ──────────────────────────────────────────────────────────

export interface AcquiredConcept {
  concept: string;
  definition: string;
  implementation: {
    kind: "primitive" | "indicator_row" | "pine" | "unsupported";
    /** primitive: 原语名;indicator_row: 指标表行名;pine: 脚本 id 占位;unsupported: null */
    target: string | null;
    params: Record<string, unknown> | null;
    /** indicator_row / pine 的计算表达式或脚本要点 */
    expression: string | null;
    note: string;
  };
  provenance: { source: "lexicon" | "brain" | "web"; detail: string; retrieved_at: number };
}

export interface AcquireContext {
  brain?: Brain;
  signal?: AbortSignal;
  now(): number;
}

/**
 * 知识来源是可插拔的:lexicon(本地词典)→ brain(模型定义)→ web(联网检索,只留接口)。
 * 真正的准入(因果测试、进原语目录 / 指标表 / Pine 脚本库)由指标库与 Pine 工作包提供,这里只负责
 * 把「这个词是什么、能怎么实现」结构化下来,让计划带着能映射的部分继续跑。
 */
export interface KnowledgeSource {
  name: "lexicon" | "brain" | "web";
  /** 当前是否可用;web 恒 false,报告里如实标「未联网」。 */
  available(ctx: AcquireContext): boolean;
  lookup(concept: string, ctx: AcquireContext): Promise<AcquiredConcept | null>;
}

export const lexiconKnowledgeSource: KnowledgeSource = {
  name: "lexicon",
  available: () => true,
  async lookup(concept, ctx) {
    const entry = lookupTerm(concept) ?? LEXICON.find((e) => e.id === concept.toLowerCase());
    if (!entry) return null;
    const kind =
      entry.kind === "primitive" && entry.target && PRIMITIVE_NAMES.has(entry.target)
        ? "primitive"
        : entry.kind === "indicator_row"
          ? "indicator_row"
          : "unsupported";
    return {
      concept,
      definition: entry.note,
      implementation: { kind, target: kind === "unsupported" ? null : entry.target, params: null, expression: null, note: entry.approximate ? "近似映射:" + entry.note : entry.note },
      provenance: { source: "lexicon", detail: "词典条目 " + entry.id, retrieved_at: ctx.now() },
    };
  },
};

const ACQUIRE_SYSTEM =
  "你在为一个量化研究系统解释一个交易术语,并选择它在本系统里的实现方式。只输出 JSON " +
  '{"definition":"一句话定义,说明判定规则与确认时点","implementation":{"kind":"primitive|indicator_row|pine|unsupported","target":"原语名或指标行名或null","params":{}或null,"expression":"计算式或null","note":"选择理由与局限"}}。' +
  "kind=primitive 只能选下列已存在的原语之一并说明参数;能用一行指标计算式表达的选 indicator_row;必须逐 bar 状态机或画线才能表达的选 pine;" +
  "定义不清或本系统无法表达的选 unsupported,不要编造原语名,也不要输出行情数字。已有原语:";

export const brainKnowledgeSource: KnowledgeSource = {
  name: "brain",
  available: (ctx) => !!ctx.brain,
  async lookup(concept, ctx) {
    if (!ctx.brain) return null;
    const response = await ctx.brain.complete(
      ACQUIRE_SYSTEM + JSON.stringify([...PRIMITIVE_NAMES]),
      JSON.stringify({ concept }),
      { timeoutMs: 30000 },
    );
    const raw = JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as {
      definition?: unknown;
      implementation?: Record<string, unknown>;
    };
    const definition = typeof raw.definition === "string" ? raw.definition.slice(0, 2000) : "";
    const impl = (raw.implementation ?? {}) as Record<string, unknown>;
    let kind = String(impl.kind ?? "unsupported") as AcquiredConcept["implementation"]["kind"];
    if (!["primitive", "indicator_row", "pine", "unsupported"].includes(kind)) kind = "unsupported";
    let target = typeof impl.target === "string" && impl.target ? impl.target : null;
    // 模型说 primitive 但名字不在目录里 = 幻觉,降级成 pine 候选而不是假装能跑
    let note = typeof impl.note === "string" ? impl.note.slice(0, 2000) : "";
    if (kind === "primitive" && (!target || !PRIMITIVE_NAMES.has(target))) {
      note = `模型给的原语名 ${target ?? "(空)"} 不在目录里,已降级为需要新实现;` + note;
      kind = "unsupported";
      target = null;
    }
    if (!definition) return null;
    return {
      concept,
      definition,
      implementation: {
        kind,
        target,
        params: impl.params && typeof impl.params === "object" && !Array.isArray(impl.params) ? (impl.params as Record<string, unknown>) : null,
        expression: typeof impl.expression === "string" ? impl.expression.slice(0, 2000) : null,
        note,
      },
      provenance: { source: "brain", detail: ctx.brain.name, retrieved_at: ctx.now() },
    };
  },
};

/** 联网检索:接口先留着,当前不实现。报告里据此标注「未联网」。 */
export const webKnowledgeSource: KnowledgeSource = {
  name: "web",
  available: () => false,
  async lookup() {
    return null;
  },
};

export const KNOWLEDGE_SOURCES: KnowledgeSource[] = [
  lexiconKnowledgeSource,
  brainKnowledgeSource,
  webKnowledgeSource,
];

/**
 * 按 lexicon → brain → web 顺序尝试。全都拿不到时也返回结构化结果(kind=unsupported),
 * 这样计划不会因为一个不认识的词而失败。
 */
export async function acquireConcept(
  concept: string,
  ctx: AcquireContext,
  sources: KnowledgeSource[] = KNOWLEDGE_SOURCES,
): Promise<{ result: AcquiredConcept; tried: string[]; offline: string[] }> {
  const tried: string[] = [];
  const offline: string[] = [];
  for (const source of sources) {
    if (!source.available(ctx)) {
      offline.push(source.name);
      continue;
    }
    tried.push(source.name);
    try {
      const found = await source.lookup(concept, ctx);
      if (found) return { result: found, tried, offline };
    } catch (e) {
      if (String(e).includes("CANCELLED")) throw e;
      offline.push(source.name + ":" + String(e instanceof Error ? e.message : e).slice(0, 120));
    }
  }
  return {
    result: {
      concept,
      definition: "",
      implementation: { kind: "unsupported", target: null, params: null, expression: null, note: "词典没有收录,模型也没有给出可用定义;需要人工补词典或写 Pine 脚本。" },
      provenance: { source: "lexicon", detail: "no_source_matched", retrieved_at: ctx.now() },
    },
    tried,
    offline,
  };
}

/** 获取结果折回概念状态:能映射的进计划(acquired),不能的仍是 unmapped 但带上定义。 */
export function acquiredToConcept(
  acquired: AcquiredConcept,
  category: ConceptCategory = "pattern",
): ResolvedConcept {
  const impl = acquired.implementation;
  const usable = impl.kind === "primitive" && impl.target && PRIMITIVE_NAMES.has(impl.target);
  // pine_author 写完并通过准入后 params.script_id 会被填上:这时概念可用(pine_series 原语引用),target 是脚本 id
  const scripted = (impl.kind === "pine" || impl.kind === "indicator_row") && !!(impl.params as { script_id?: string } | null)?.script_id && !!impl.target;
  return {
    term: acquired.concept,
    concept_id: acquired.concept,
    category,
    status: usable || scripted ? "acquired" : "unmapped",
    source: "acquired",
    target: usable || scripted ? impl.target : null,
    note:
      (acquired.definition ? acquired.definition + " " : "") +
      (usable
        ? `已映射到原语 ${impl.target}(来源 ${acquired.provenance.source})。`
        : scripted
          ? `已写成 Pine 脚本并通过准入(script_id=${impl.target}),用 pine_series 原语引用。`
        : impl.kind === "indicator_row"
          ? `需要指标表新增一行 ${impl.target ?? ""}:${impl.expression ?? impl.note}`
          : impl.kind === "pine"
            ? "需要 Pine 脚本实现,尚未准入。"
            : impl.note),
  };
}
