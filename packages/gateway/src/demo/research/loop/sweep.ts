/**
 * 参数扫描的第二组、第三组参数由代码从已编译的基准 IR 派生(2026-09-23),不再靠「把周期放大一倍」这类文字提示让模型重编。
 * - 问题里写了明确取值(「20/50 和 10/30」「周期 10、20、30」)→ 按出现顺序映射到基准 IR 里的周期类参数;
 * - 没写 → 敏感性扫描:周期类参数整体 ×0.5 与 ×2(取整、不低于 2)。
 * 每个变体都过零模型 compile 校验(参数越界、结构不合法就换下一种缩放),变更逐条列出给报告用。
 */
import type { StrategyIR, StrategyPrimitive } from "@trade-gate/contracts";
import type { DefineTool, ToolRegistryLike } from "../data/loop-tools.js";
import type { ToolContext } from "./tools.js";

/** 周期类参数:整数、≥2、名字像长度/周期/回看。阈值(rsi 35)、倍数(atr 2.5)不算,扫描不动它们。 */
const PERIOD_KEY = /(^|_)(period|length|len|lookback|window|fast|slow|signal|bars|n|span|swing_length|atr_period)$/i;
export interface ParamChange { path: string; from: number; to: number }
export interface SweepVariant { key: string; label: string; ir: StrategyIR; changes: ParamChange[] }

type Slot = { path: string; holder: Record<string, unknown>; key: string; value: number };
/** 周期类参数,含通用指标原语嵌套在 args / compare_args 里的 period(2026-09-23:只扫顶层时「参数 10/30」只改了入场,离场仍是 20/50 死叉) */
function periodSlots(ir: StrategyIR): Slot[] {
  const nodes: [string, StrategyPrimitive][] = [
    ...ir.signal.map((p, i) => [`signal.${i}`, p] as [string, StrategyPrimitive]),
    ["entry", ir.entry],
    ...ir.exit.map((p, i) => [`exit.${i}`, p] as [string, StrategyPrimitive]),
    ["risk.stop", ir.risk.stop],
    ...(ir.regime ? [["regime", ir.regime] as [string, StrategyPrimitive]] : []),
  ];
  const out: Slot[] = [];
  const scan = (holder: Record<string, unknown>, path: string) => {
    for (const [key, value] of Object.entries(holder)) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 2 && PERIOD_KEY.test(key)) out.push({ path: `${path}.${key}`, holder, key, value });
      else if ((key === "args" || key === "compare_args") && value && typeof value === "object" && !Array.isArray(value)) scan(value as Record<string, unknown>, `${path}.${key}`);
    }
  };
  for (const [path, node] of nodes) scan(node.params ?? {}, `${path}.params`);
  return out;
}
/** 只取信号段的周期参数去对「20/50」这种写法:用户说的参数几乎总是指信号本身。 */
const signalSlots = (slots: Slot[]) => {
  const s = slots.filter((x) => x.path.startsWith("signal."));
  return s.length ? s : slots;
};

/** 问题里的参数组:「20/50」「(10,30)」算一组;「10、20、30」或「10,20,30」算单参数的多组。 */
export function explicitGroups(question: string): number[][] {
  const pairs = [...question.matchAll(/(\d{1,4})\s*[/／]\s*(\d{1,4})(?:\s*[/／]\s*(\d{1,4}))?/g)].map((m) => m.slice(1).filter(Boolean).map(Number));
  if (pairs.length) return pairs;
  const list = /(?:周期|参数|长度|period|length)[^\d]{0,6}((?:\d{1,4}\s*[、,，和与及或]\s*)+\d{1,4})/i.exec(question)?.[1];
  return list ? list.split(/[、,，和与及或]/).map((x) => [Number(x.trim())]).filter((g) => g[0]! > 0) : [];
}

function apply(ir: StrategyIR, slots: Slot[], values: (slot: Slot, i: number) => number | null): { ir: StrategyIR; changes: ParamChange[] } {
  const next = structuredClone(ir) as StrategyIR, changes: ParamChange[] = [];
  const all = periodSlots(next);
  slots.forEach((slot, i) => {
    const v = values(slot, i);
    if (v === null || v === slot.value) return;
    const target = all.find((s) => s.path === slot.path)!;
    target.holder[target.key] = v;
    changes.push({ path: slot.path, from: slot.value, to: v });
  });
  return { ir: next, changes };
}
const scaled = (factor: number) => (slot: Slot) => Math.max(2, Math.round(slot.value * factor));

/** 候选变体按优先级排好,调用方逐个校验、取前 count 个合法的。 */
export function candidateVariants(ir: StrategyIR, question: string): { label: string; ir: StrategyIR; changes: ParamChange[] }[] {
  const slots = periodSlots(ir), out: { label: string; ir: StrategyIR; changes: ParamChange[] }[] = [];
  if (!slots.length) return out;
  const target = signalSlots(slots);
  for (const group of explicitGroups(question)) {
    // 信号段的旧值 → 新值;其他段(离场/方向门)里取值相同的周期参数一起换,「20/50 → 10/30」时死叉离场也跟着变成 10/30
    const map = new Map(target.slice(0, group.length).map((s, i) => [s.value, group[i]!] as const));
    const v = apply(ir, slots, (s) => (map.has(s.value) ? map.get(s.value)! : null));
    if (v.changes.length) out.push({ label: `参数 ${group.join("/")}`, ...v });
  }
  for (const factor of [0.5, 2, 1.5, 0.75]) {
    const v = apply(ir, slots, scaled(factor));
    if (v.changes.length) out.push({ label: `周期 ×${factor}`, ...v });
  }
  // 去掉与基准或彼此相同的
  const seen = new Set([JSON.stringify(ir)]);
  return out.filter((v) => {
    const k = JSON.stringify(v.ir);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function sweepVariants(
  input: { ir: StrategyIR; question: string; timeframe: string; count?: number },
  ctx: ToolContext,
): Promise<{ base_label: string; variants: SweepVariant[]; rejected: { label: string; reason: string }[]; note: string }> {
  const count = Math.min(3, Math.max(1, input.count ?? 2));
  const rejected: { label: string; reason: string }[] = [], variants: SweepVariant[] = [];
  const candidates = candidateVariants(input.ir, input.question);
  if (!candidates.length) throw Error("NOT_COMPARABLE:no_period_params_to_sweep");
  for (const c of candidates) {
    if (variants.length >= count) break;
    if (!ctx.backtests) throw Error("DATA_MISSING:backtest_service");
    // 不带 text 的 compile = 零模型调用,只做检查
    const checked = await ctx.backtests.compile({ ir: c.ir, timeframe: input.timeframe }, ctx);
    if (!checked.ok || !checked.ir) {
      rejected.push({ label: c.label, reason: checked.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.message ?? ""}`).join("; ").slice(0, 300) || "invalid" });
      continue;
    }
    const ir = checked.ir;
    variants.push({ key: String.fromCharCode(98 + variants.length), label: c.label, ir: { ...ir, label: `${input.ir.label} · ${c.label}` }, changes: c.changes });
  }
  if (variants.length < count) throw Error(`NOT_COMPARABLE:only_${variants.length}_valid_variants`);
  const explicit = explicitGroups(input.question).length > 0;
  return {
    base_label: input.ir.label,
    variants,
    rejected,
    note: explicit ? "按问题里给出的参数取值派生,映射到信号段的周期参数(按出现顺序)" : "问题没给具体取值,做周期敏感性扫描(周期类参数整体缩放);阈值与倍数类参数保持不变",
  };
}

export function registerSweepTools(registry: ToolRegistryLike, def: DefineTool): void {
  registry.register(def("derive_param_variants", "Object", "Object", async (input: { ir: StrategyIR; question: string; timeframe: string; count?: number }, ctx: ToolContext) => {
    const out = await sweepVariants(input, ctx);
    return { status: "ok", output: out, snapshot_refs: [], artifact_refs: [], warnings: out.rejected.map((r) => `variant_rejected:${r.label}`), latency_ms: 0 };
  }, { task_kinds: ["validate"] }));
}
