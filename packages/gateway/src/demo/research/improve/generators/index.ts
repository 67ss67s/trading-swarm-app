/**
 * 候选生成器注册表。改进环 runner 只认这里注册过的生成器,不 import 各生成器内部。
 * 内置:diagnosis / neighborhood / swap(第一阶段)。oracle(第二阶段,research/improve/oracle/)按约定导出
 *   `oracleGenerator: CandidateGenerator`,runner 在任务点名 oracle 时经 loadOptionalGenerator 动态加载并注册;model 生成器同理。
 */
import type { CandidateGenerator, GeneratorName } from '../types.js';
import { diagnosisGenerator } from './diagnosis.js';
import { neighborhoodGenerator } from './neighborhood.js';
import { swapGenerator } from './swap.js';

const registry = new Map<GeneratorName, CandidateGenerator>();
export function registerGenerator(g: CandidateGenerator): void { registry.set(g.name, g); }
export function getGenerator(name: GeneratorName): CandidateGenerator | null { return registry.get(name) ?? null; }
export function registeredGenerators(): GeneratorName[] { return [...registry.keys()]; }
for (const g of [diagnosisGenerator, neighborhoodGenerator, swapGenerator]) registerGenerator(g);
export const DEFAULT_GENERATORS: GeneratorName[] = ['diagnosis', 'neighborhood', 'swap'];

/** 可选生成器的模块入口(相对本文件);模块需导出 `<name>Generator`。用变量拼路径,oracle 目录还没落地时不影响编译。 */
const OPTIONAL: Partial<Record<GeneratorName, string>> = { oracle: '../oracle/index.js', model: '../model/index.js' };
export async function loadOptionalGenerator(name: GeneratorName): Promise<CandidateGenerator | null> {
  const have = getGenerator(name);
  if (have) return have;
  const rel = OPTIONAL[name];
  if (!rel) return null;
  // 源码模式(测试 / 开发)下入口是 .ts,编译后是 .js:两种都试
  for (const file of [rel, rel.replace(/\.js$/, '.ts')]) {
    try {
      const mod = (await import(new URL(file, import.meta.url).href)) as Record<string, unknown>;
      const g = mod[`${name}Generator`] as CandidateGenerator | undefined;
      if (g && typeof g.generate === 'function' && g.name === name) { registerGenerator(g); return g; }
    } catch { /* 模块不存在:按未注册处理,runner 写进 notes */ }
  }
  return null;
}
