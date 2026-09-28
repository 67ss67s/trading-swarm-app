/**
 * 研究 loop 的 skill 加载器(2026-09-23)。skill 是仓库根 `skills/<name>/SKILL.md`(与 trade-gate / asp-agent 同格式:
 * YAML 头 + 正文),正文用 `<!-- section:<id> -->` 分段。compose_answer 按问题类型只取相关段落拼进系统提示,
 * 不整份塞给模型(弱模型长提示更容易跑偏,也更慢)。
 *
 * 查找顺序:环境变量 TG_SKILLS_DIR → 从本文件往上逐级找 `skills/<name>/SKILL.md`(src 与 dist 都能找到仓库根)。
 * 找不到时返回 null,调用方照旧用不带 skill 的提示,不影响答案生成。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Skill { name: string; path: string; meta: Record<string, string>; intro: string; sections: Map<string, string> }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, { mtime: number; skill: Skill }>();

export function skillPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const roots: string[] = [];
  if (env["TG_SKILLS_DIR"]) roots.push(env["TG_SKILLS_DIR"]);
  for (let d = HERE, i = 0; i < 10; i++, d = path.dirname(d)) {
    roots.push(path.join(d, "skills"));
    if (path.dirname(d) === d) break;
  }
  for (const r of roots) {
    const p = path.join(r, name, "SKILL.md");
    if (existsSync(p)) return p;
  }
  return null;
}

/** 解析 SKILL.md:YAML 头只取一层 `key: value`;正文按 section 标记切段,标记之前的是 intro。 */
export function parseSkill(name: string, text: string, file = ""): Skill {
  const meta: Record<string, string> = {};
  let body = text;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1]!.split("\n")) {
      const m = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (m && m[2]) meta[m[1]!] = m[2].trim();
    }
  }
  const sections = new Map<string, string>();
  const marker = /<!--\s*section:([\w-]+)\s*-->/g;
  const hits = [...body.matchAll(marker)];
  const intro = (hits.length ? body.slice(0, hits[0]!.index) : body).trim();
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1]!.index! : body.length;
    sections.set(h[1]!, body.slice(h.index! + h[0].length, end).trim());
  });
  return { name, path: file, meta, intro, sections };
}

/** 读 skill(按文件 mtime 缓存,改了 SKILL.md 不用重启网关) */
export function loadSkill(name: string, env: NodeJS.ProcessEnv = process.env): Skill | null {
  const p = skillPath(name, env);
  if (!p) return null;
  try {
    const mtime = statSync(p).mtimeMs, hit = cache.get(p);
    if (hit && hit.mtime === mtime) return hit.skill;
    const skill = parseSkill(name, readFileSync(p, "utf8"), p);
    cache.set(p, { mtime, skill });
    return skill;
  } catch {
    return null;
  }
}

// ── research-reflection:按问题类型挑段 ────────────────────────────────────

export const REFLECTION_SKILL = "research-reflection";
export type ReflectionKind = "diagnose" | "validate" | "compare";

/**
 * 问题类型 → 段落。所有类型都带铁律(core)、写法(writing)与 loop 作答规则(loop_answer);
 * diagnose 走全套归因;validate 只要核数 / 忠实度 / 比较对象 / 噪声;compare(A/B、参数扫描)重点是比较对象与试验次数。
 * 问题里的关键词再补段:问「可信 / 显著 / 过拟合」补噪声段,问「怎么改 / 下一步」补下一步段,问「为什么 / 亏」补拆来源段。
 */
export function pickReflectionSections(kind: ReflectionKind, question = ""): string[] {
  const base: Record<ReflectionKind, string[]> = {
    diagnose: ["core", "reconcile", "faithfulness", "benchmark", "attribution", "signal_noise", "next_step", "writing", "loop_answer"],
    validate: ["core", "reconcile", "faithfulness", "benchmark", "signal_noise", "writing", "loop_answer"],
    compare: ["core", "faithfulness", "benchmark", "signal_noise", "writing", "loop_answer"],
  };
  const out = [...base[kind]];
  const want = (id: string, before: string) => { if (out.includes(id)) return; const i = out.indexOf(before); out.splice(i >= 0 ? i : out.length, 0, id); };
  if (/为什么|原因|亏|归因|复盘|拆|why|loss|attribut/i.test(question)) want("attribution", "signal_noise");
  if (/可信|靠谱|显著|噪声|运气|过拟合|偶然|significan|overfit|luck|noise/i.test(question)) want("signal_noise", "writing");
  if (/怎么改|改进|优化|下一步|接下来|调整|improve|next/i.test(question)) want("next_step", "writing");
  return out;
}

/** 按问题类型拼出 skill 提示段;skill 缺失或一段都没取到时返回 null */
export function reflectionPrompt(kind: ReflectionKind, question = "", env: NodeJS.ProcessEnv = process.env): { text: string; sections: string[]; path: string } | null {
  const skill = loadSkill(REFLECTION_SKILL, env);
  if (!skill) return null;
  const ids = pickReflectionSections(kind, question).filter((id) => skill.sections.has(id));
  if (!ids.length) return null;
  const text = `【复盘方法(skill ${skill.name} v${skill.meta["version"] ?? "?"},只取与本问题相关的段落)】\n` + ids.map((id) => skill.sections.get(id)!).join("\n\n");
  return { text, sections: ids, path: skill.path };
}
