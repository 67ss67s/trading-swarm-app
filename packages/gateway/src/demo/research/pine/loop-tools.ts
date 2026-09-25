/**
 * 研究 loop 给 agent 用的两个 Pine 工具:
 *   pine_lookup —— 按概念搜脚本目录(名字/描述/别名),回已准入的可引用条目。
 *   pine_author —— 让模型按概念定义写一段 Pine,自动跑准入,通过才进目录;
 *                  失败就把准入报告里的具体原因回给 agent(而不是一句「失败了」)。
 *
 * IO schema 统一用 research-loop.json 已有的通用 "Object"/"Json",不动那份契约。
 * 主线程接线:在 createToolRegistry() 里加一行 registerPineTools(registry, def)。
 */
import type { ToolRegistry, ToolDefinition, ToolContext, ToolResult } from '../loop/tools.js';
import { PineCatalog, pineCatalog, summarize } from './catalog.js';
import { admitScript, defaultSuites, admissionDataSource, type AdmissionReport, type PineDatasetSource } from './admission.js';
import { runPine, PINE_ENGINE_HINT } from './client.js';

/** loop/tools.ts 里那个私有 def() 的形状;主线程把自己的 def 传进来即可。 */
export type PineToolDef = <I, O>(
  name: string,
  input: string,
  output: string,
  run: ToolDefinition<I, O>['run'],
  options?: Partial<ToolDefinition<I, O>>,
) => ToolDefinition<I, O>;

export interface PineToolOptions {
  /** 目录来源;默认取进程内单例(pine/routes.ts 装配)。 */
  catalog?: () => PineCatalog | null;
  /** 引擎调用;默认走 HTTP 客户端。测试注入 mock。 */
  runner?: typeof runPine;
  /** 准入真实行情套的数据源;默认取 pine/routes.ts 装配的研究库。 */
  datasets?: () => PineDatasetSource | null;
  now?: () => number;
}

const ok = <O,>(output: O): ToolResult<O> => ({
  status: 'ok', output, snapshot_refs: [], artifact_refs: [], warnings: [], latency_ms: 0,
});
const err = (note: string): ToolResult<null> => ({
  status: 'error', output: null, error_code: 'PROVIDER_ERROR', retryable: false,
  snapshot_refs: [], artifact_refs: [], warnings: [note], latency_ms: 0,
});

export const PINE_AUTHOR_SYSTEM = [
  '你在为一个量化研究系统编写 PineScript v5 指标。只输出脚本源码,不要解释、不要 markdown 代码围栏。',
  '硬性要求:',
  '1) 第一行 //@version=5,第二行 indicator("名字", overlay=…)。',
  '2) 只能用当根及更早的数据。禁止任何形式的未来函数:不得用负的 offset(如 close[-1])、',
  '   不得用 request.security 的 lookahead_on、不得在 barstate.islast 上写回历史。脚本会被机器做因果测试:',
  '   用 bars[0..i] 跑与用全量 bars 跑,第 i 根的输出必须一模一样,不一致直接拒收。',
  '3) 必须确定性:不得用随机数、timenow、当前时钟。同一输入跑两次必须逐位相同。',
  '4) 至少一个 plot(),并给每个 plot 起明确的 title —— 策略侧按 title 引用这条序列。',
  '5) 参数用 `名字 = input.int(默认值, "名字")` 这种形式声明,变量名与标题一致(系统按名字注入参数)。',
].join('\n');

export function registerPineTools(registry: ToolRegistry, def: PineToolDef, options: PineToolOptions = {}): ToolRegistry {
  const resolve = options.catalog ?? (() => pineCatalog());
  const run = options.runner ?? runPine;

  registry.register(def<{ query?: string; limit?: number; admitted_only?: boolean }, unknown>(
    'pine_lookup',
    'Object',
    'Object',
    async (input) => {
      const catalog = resolve();
      if (!catalog) return err('pine_catalog_unavailable:Pine 脚本目录未装配');
      const items = catalog.search(String(input?.query ?? ''), {
        limit: Math.min(50, Number(input?.limit ?? 20)),
        admitted: input?.admitted_only === false ? undefined : true,
      });
      return ok({
        items: items.map((s) => {
          const brief = summarize(s);
          return {
            script_id: s.id, name: s.name, description: s.description, aliases: s.aliases,
            outputs: s.outputs, admitted: s.admitted, usage_count: s.usage_count,
            warmup_bars: brief.admission_summary?.warmup_bars ?? null,
            source: s.source, license: s.license,
          };
        }),
        note: '只有 admitted=true 的脚本能被 pine_series / pine_series_exit 引用;引用时 warmup_bars 不得小于这里的 warmup_bars。',
      });
    },
    { access: 'read', budget_class: 'none', timeout_ms: 10000 },
  ));

  registry.register(def<{ concept?: string; name?: string; timeframe?: string; attempts?: number }, unknown>(
    'pine_author',
    'Object',
    'Object',
    async (input, ctx: ToolContext) => {
      const catalog = resolve();
      if (!catalog) return err('pine_catalog_unavailable:Pine 脚本目录未装配');
      if (!ctx.brain) return err('brain_unavailable:pine_author 需要模型');
      const concept = String(input?.concept ?? '').trim();
      if (!concept) return err('concept_required:请给出指标的概念定义(算什么、用哪些量、怎么判定)');
      // 准入两套数据:合成 + 研究库里最新的日线/4h(有的话);两套都过才进目录
      const suites = defaultSuites((options.datasets ?? admissionDataSource)());
      const timeframe = String(input?.timeframe ?? '1h');
      const attempts = Math.max(1, Math.min(3, Number(input?.attempts ?? 2)));
      const trail: { attempt: number; reason: string }[] = [];
      let user = `指标概念:${concept}\n基础周期:${timeframe}`;

      for (let attempt = 0; attempt < attempts; attempt++) {
        if (ctx.signal.aborted) return err('CANCELLED');
        const response = await ctx.brain.complete(PINE_AUTHOR_SYSTEM, user, { timeoutMs: 120000 });
        const script = stripFence(response.text);
        if (!script) { trail.push({ attempt, reason: '模型没有输出脚本' }); user = `${concept}\n上一次没有输出可用源码,只输出 PineScript 源码。`; continue; }
        let report: AdmissionReport;
        try {
          report = await admitScript(script, (i) => run(i, { noCache: true, timeoutMs: 60000 }), { suites, now: options.now });
        } catch (e) {
          // 引擎没起是环境问题,不是模型问题:不再重试,直接把启动方式回给 agent。
          return err(`${e instanceof Error ? e.message : String(e)};${PINE_ENGINE_HINT}`);
        }
        if (!report.ok) {
          const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name}:${c.message}`).join(';');
          trail.push({ attempt, reason: failed });
          user = `${concept}\n上一版未通过准入:${failed}\n只修违规处,重新输出完整脚本。上一版:\n${script}`;
          continue;
        }
        const name = uniqueName(catalog, String(input?.name ?? concept).slice(0, 60));
        const created = catalog.create({
          name, description: concept, script, source: 'agent',
          // inputs_schema 留空 = 目录按源码 input.*() 声明推导,之后引用时按它校验参数
          aliases: [], inputs_schema: {}, author: ctx.brain.name ?? null, license: null,
        });
        const admitted = catalog.admit(created.id, report);
        return ok({
          script_id: admitted.id, name: admitted.name, admitted: true,
          outputs: report.outputs, warmup_bars: report.warmup_bars,
          attempts: attempt + 1, rejected: trail,
          admission_data: (report.suites ?? []).map((x) => x.label), real_data: report.real_data ?? false,
          usage: `在策略 IR 里这样引用:{"primitive":"pine_series","params":{"script_id":"${admitted.id}","output":"${report.outputs[0]}","operator":"above","compare_to":"zero","warmup_bars":${Math.max(1, report.warmup_bars)}}}`,
        });
      }
      return ok({ script_id: null, admitted: false, attempts, rejected: trail, reason: trail.at(-1)?.reason ?? 'unknown' });
    },
    { access: 'create_run', budget_class: 'model_call', timeout_ms: 300000, idempotent: false, task_kinds: ['market', 'compare', 'validate', 'diagnose'] },
  ));

  return registry;
}

/** 模型爱套 ```pine 围栏,剥掉;剥完还得像个 Pine 脚本才算数。 */
export function stripFence(text: string): string {
  const fenced = /```(?:pine|pinescript)?\s*\n([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  return /(^|\n)\s*(\/\/@version|indicator\s*\(|study\s*\()/.test(body) ? body : '';
}

/** 目录里名字唯一;重名就加后缀,不要让 agent 因为撞名白写一版。 */
function uniqueName(catalog: PineCatalog, base: string): string {
  const clean = base.replace(/\s+/g, ' ').trim() || 'pine_indicator';
  if (!catalog.search(clean).some((s) => s.name === clean)) return clean;
  for (let n = 2; n < 100; n++) {
    const candidate = `${clean} #${n}`;
    if (!catalog.search(candidate).some((s) => s.name === candidate)) return candidate;
  }
  return `${clean} ${Date.now()}`;
}
