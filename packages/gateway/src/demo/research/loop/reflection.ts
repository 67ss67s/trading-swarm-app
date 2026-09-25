/**
 * 复盘 skill(skills/research-reflection)接进研究 loop 的零模型部分(2026-09-23):
 *  - diagnoseContextFor:诊断要的外部上下文(用户原问题、同一策略已回测的变体数);
 *  - reviewNotes:验证 / 横比类回答里,代码从报告现算的「复盘提示」(只取严重项),答案与模型都能引用;
 *  - groundText:模型复盘文本逐句核数字——每个数字都要在可信文本(观察句、诊断、横比、问题原文、报告标题)里出现过,
 *    对不上的句子整句剥掉(沿用「非法引用剥掉」的规则,粒度从整块细到句)。
 */
import type { BacktestReport } from "@trading-swarm/contracts";
import { listBacktestReports } from "../backtest-report.js";
import type { ResearchStore } from "../store.js";
import { diagnoseReport, type DiagnoseContext, type DiagnosisFinding } from "./diagnose.js";
import type { LoopStore } from "./store.js";

/** 原问题:报告所属 inquiry 的问题(追问时它才是策略原话),加上当前追问;都取不到时返回 null(诊断跳过忠实度) */
export function diagnoseContextFor(report: BacktestReport, store: LoopStore, inquiry_id: string, research?: ResearchStore | null): DiagnoseContext {
  const ask = (id: string | null | undefined) => { if (!id) return null; try { return store.inquiry(id).question; } catch { return null; } };
  const origin = ask(report.inquiry_id), current = ask(inquiry_id);
  const question = origin ? [origin, current && current !== origin ? current : null].filter(Boolean).join("\n") : report.inquiry_id === inquiry_id ? current : null;
  let variants: number | null = null;
  if (research && report.strategy_id) {
    try { variants = new Set(listBacktestReports(research, { strategy_id: report.strategy_id, limit: 200 }).map((r) => r.strategy_ir_hash)).size; } catch { variants = null; }
  }
  return { question, variants };
}

/** 验证 / 横比回答里要亮出来的诊断:严重项 + 口径与忠实度类(横比时参数不一致、变体数也要说) */
const ALWAYS = new Set(["param_mismatch", "variants"]);
export function reviewNotes(reports: BacktestReport[], ctxOf: (r: BacktestReport) => DiagnoseContext, perReport = 3): { text: string; findings: (DiagnosisFinding & { report_id: string })[] } | null {
  const lines: string[] = [], findings: (DiagnosisFinding & { report_id: string })[] = [];
  for (const r of reports) {
    let d;
    try { d = diagnoseReport(r, ctxOf(r)); } catch { continue; }
    const picked = d.findings.filter((f) => f.severity === "high" || (reports.length >= 2 && ALWAYS.has(f.key))).slice(0, perReport);
    if (!picked.length) continue;
    lines.push(`${reports.length >= 2 ? r.title + ":" : ""}` + picked.map((f) => f.text).join(";"));
    findings.push(...picked.map((f) => ({ ...f, report_id: r.id })));
  }
  return lines.length ? { text: "复盘提示(代码核对,只作观察):\n" + lines.map((l, i) => `${i + 1}. ${l}`).join("\n"), findings } : null;
}

const NUM = /\d+(?:\.\d+)?/g;
const norm = (x: string) => String(Number(x));
/** 可信文本里出现过的数字集合 */
export function numberCorpus(texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(NUM)) { out.add(m[0]); out.add(norm(m[0])); }
  return out;
}
/** 中文数字 + 数据量词 / 百分之:没法和产物核对,一律当编造(「两个基准」「第一步」「同一成本」这类叙述用词不算;「八成计划」算) */
const CN_NUM = /[零〇两三四五六七八九十百千万亿]+\s*(?:笔|次|倍|根|天|年|月|周|%|％|个百分点)|百分之|[二三四五六七八九]成(?![本交功立为果绩熟员分型])/;
/** 列表序号「(1)」「1.」「1、」「①」不是数据,核数字前先去掉(09-23 GLM 实测:带序号的验证步骤整句被误剥) */
const ENUM = /[（(]\s*\d{1,2}\s*[)）]|(?:^|(?<=[\s:：;；。,，]))\d{1,2}[.、](?!\d)|[①-⑩]/g;
const LABEL = /^\s*(观察|假设|验证)[:：]/;
/** 执行状态的叙述归代码:模型不得说回测「待执行 / 需确认 / 正在跑」 */
export const EXECUTION_NARRATIVE = /尚未(?:执行|运行|回测)|还没(?:有)?(?:执行|运行|回测)|待执行|等待执行|确认(?:后)?(?:再)?执行|是否执行|请确认|正在(?:执行|运行|回测)|将(?:会)?(?:执行|运行)回测/;

/** 逐句核数字:返回保留下来的文本与被剥掉的句数 */
export function groundText(text: string, corpus: Set<string>): { text: string; dropped: number } {
  const label = LABEL.exec(text)?.[0].trim() ?? "";
  const sentences = text.split(/(?<=[。;；!?！？\n])/);
  let dropped = 0;
  const kept = sentences.filter((s) => {
    const bare = s.replace(LABEL, "").replace(ENUM, " ");
    const nums = [...bare.matchAll(NUM)].map((m) => m[0]);
    const ok = !CN_NUM.test(bare) && nums.every((n) => corpus.has(n) || corpus.has(norm(n)));
    if (!ok) dropped++;
    return ok;
  });
  let out = kept.join("").trim();
  // 「观察:」「假设:」「验证:」开头那句被剥掉时,把段名补回剩下的文本前面
  if (out && label && !LABEL.test(out)) out = label + out;
  return { text: out, dropped };
}
