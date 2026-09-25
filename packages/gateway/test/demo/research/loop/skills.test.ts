// 复盘 skill 加载器:SKILL.md 分段、按问题类型挑段、找不到 skill 时安静回落
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkill, parseSkill, pickReflectionSections, reflectionPrompt, skillPath, REFLECTION_SKILL } from "../../../../src/demo/research/loop/skills.js";

describe("skill 加载器", () => {
  it("解析 YAML 头(含一层嵌套)与 section 标记;标记前是 intro", () => {
    const s = parseSkill("x", "---\ntitle: x\nmetadata:\n  version: 0.2.0\n---\n# X\n\n引言\n<!-- section:a -->\n## A\nA 内容\n<!-- section:b-c -->\nB 内容\n");
    expect(s.meta).toMatchObject({ title: "x", version: "0.2.0" });
    expect(s.intro).toContain("引言");
    expect([...s.sections.keys()]).toEqual(["a", "b-c"]);
    expect(s.sections.get("a")).toBe("## A\nA 内容");
    expect(s.sections.get("b-c")).toBe("B 内容");
  });
  it("仓库里的 research-reflection:七步 + 铁律 + loop 作答规则都在,主文件 ≤ 250 行", () => {
    const skill = loadSkill(REFLECTION_SKILL)!;
    expect(skill).not.toBeNull();
    expect(skill.path).toMatch(/skills\/research-reflection\/SKILL\.md$/);
    for (const id of ["core", "reconcile", "faithfulness", "benchmark", "attribution", "signal_noise", "next_step", "writing", "loop_answer"]) expect(skill.sections.has(id), id).toBe(true);
    expect(skill.meta["version"]).toMatch(/^\d+\.\d+\.\d+$/);
    // 主文件篇幅约束(细节放 references)
    const lines = readFileSync(skill.path, "utf8").split("\n").length;
    expect(lines).toBeLessThanOrEqual(250);
  });
  it("TG_SKILLS_DIR 优先;找不到 skill 返回 null,不抛错", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skills-"));
    mkdirSync(path.join(dir, "demo"));
    writeFileSync(path.join(dir, "demo", "SKILL.md"), "---\ntitle: demo\n---\n<!-- section:core -->\n核心");
    expect(skillPath("demo", { TG_SKILLS_DIR: dir })).toBe(path.join(dir, "demo", "SKILL.md"));
    expect(loadSkill("demo", { TG_SKILLS_DIR: dir })!.sections.get("core")).toBe("核心");
    expect(loadSkill("no-such-skill-xyz", { TG_SKILLS_DIR: dir })).toBeNull();
    // 目录里的 research-reflection 缺段时只取有的段;一段都没有 → null
    mkdirSync(path.join(dir, REFLECTION_SKILL));
    writeFileSync(path.join(dir, REFLECTION_SKILL, "SKILL.md"), "---\ntitle: r\n---\n<!-- section:core -->\n铁律\n<!-- section:zzz -->\n无关");
    expect(reflectionPrompt("validate", "", { TG_SKILLS_DIR: dir })!.sections).toEqual(["core"]);
    const bare = mkdtempSync(path.join(tmpdir(), "skills-"));
    mkdirSync(path.join(bare, REFLECTION_SKILL));
    writeFileSync(path.join(bare, REFLECTION_SKILL, "SKILL.md"), "---\ntitle: r\n---\n没有分段");
    expect(reflectionPrompt("validate", "", { TG_SKILLS_DIR: bare })).toBeNull();
  });
});

describe("按问题类型挑段", () => {
  it("诊断走全套;验证不带拆来源与下一步;横比不带核数", () => {
    expect(pickReflectionSections("diagnose")).toEqual(["core", "reconcile", "faithfulness", "benchmark", "attribution", "signal_noise", "next_step", "writing", "loop_answer"]);
    const v = pickReflectionSections("validate", "BTC 日线 20/50 金叉做多和持有比");
    expect(v).toEqual(expect.arrayContaining(["core", "reconcile", "faithfulness", "benchmark", "signal_noise", "writing", "loop_answer"]));
    expect(v).not.toContain("attribution");
    expect(v).not.toContain("next_step");
    const c = pickReflectionSections("compare", "20/50 和 10/30 哪组好");
    expect(c).not.toContain("reconcile");
    expect(c).toContain("signal_noise");
  });
  it("问题关键词补段,且补在 writing 之前、顺序稳定", () => {
    const v = pickReflectionSections("validate", "这个结果为什么比持有差?下一步怎么改");
    expect(v).toContain("attribution");
    expect(v).toContain("next_step");
    expect(v.indexOf("attribution")).toBeLessThan(v.indexOf("signal_noise"));
    expect(v.indexOf("next_step")).toBeLessThan(v.indexOf("writing"));
    expect(v.at(-1)).toBe("loop_answer");
  });
  it("拼出的提示只含挑中的段,长度受控", () => {
    const d = reflectionPrompt("diagnose", "为什么比持有差")!, v = reflectionPrompt("validate", "BTC 均线和持有比")!;
    expect(d.text).toContain("第 4 步 拆来源");
    expect(v.text).not.toContain("第 4 步 拆来源");
    expect(v.text).not.toContain("第 6 步 提出下一步");
    expect(v.text).toContain("第 2 步 忠实度");
    expect(d.text.length).toBeLessThan(6000);
    expect(v.text.length).toBeLessThan(d.text.length);
  });
});
