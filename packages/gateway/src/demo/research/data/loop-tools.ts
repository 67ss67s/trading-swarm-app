/**
 * 数据目录暴露给研究 loop 的工具(§9.44)。两个:
 * - find_data_source:问「这个指标这个标的这个周期有没有数据」,答案含来源、没接的原因、可用的代理;
 * - inspect_data_coverage:原来直接问 provider,现在先过目录 —— 目录说不成立就不调网络,目录说没接就如实说没接。
 * 这里只装配工具,不实现数据抓取;IO schema 复用契约里已有的通用名字(Object / DataInput / Coverage),不动 research-loop.json。
 * 注意:对 loop 只用 import type,运行时不依赖 loop/,避免和 tools.ts 形成真实循环依赖。
 */
import type { ToolDefinition, ToolResult, ToolContext } from '../loop/tools.js';
import type { Availability, Coverage, Instrument, MetricKey } from './index.js';
import { describeProxy, proxiesFor } from './proxies.js';
import { marketTypeOf, resolveDataConcept, listAdapters, type CatalogAvailability, type DataConceptResolution } from './catalog.js';
/** tools.ts 里那个私有的 def 的签名;由主线程把 def 传进来,这里不复制一份默认值。 */
export type DefineTool = <I, O>(name: string, input: string, output: string, run: ToolDefinition<I, O>['run'], options?: Partial<ToolDefinition<I, O>>) => ToolDefinition<I, O>;
/** 只用到 register,避免把 ToolRegistry 的实现细节绑进来。 */
export interface ToolRegistryLike { register<I, O>(def: ToolDefinition<I, O>): unknown }
const METRICS: MetricKey[] = ['price', 'funding', 'open_interest', 'liquidations', 'liquidation_estimates', 'orderbook'];
/** 目录的 not_connected 在契约里没有对应值(LoopAvailability 只有五个),对外一律收敛成 missing —— 宁可说没有,不能说有。 */
const toAvailability = (a: CatalogAvailability): Availability => (a === 'not_connected' ? 'missing' : a);
const toStatus = (a: CatalogAvailability) => { const v = toAvailability(a); return v === 'available' ? ('ok' as const) : v; };
function ok<O>(output: O, extra: Partial<ToolResult<O>> = {}): ToolResult<O> {
  return { status: 'ok', output, snapshot_refs: [], artifact_refs: [], warnings: [], latency_ms: 0, ...extra };
}
/** 入参里的 instrument 允许是完整 Instrument,也允许只给 canonical_id 字符串(规划器常常只有 id)。 */
function readInstrument(raw: unknown): Instrument | string {
  if (typeof raw === 'string' && raw) return raw;
  if (raw && typeof raw === 'object' && typeof (raw as Instrument).canonical_id === 'string') return raw as Instrument;
  throw Error('SCHEMA_MISMATCH:instrument_required');
}
function readMetric(raw: unknown): MetricKey {
  if (typeof raw === 'string' && (METRICS as string[]).includes(raw)) return raw as MetricKey;
  throw Error('SCHEMA_MISMATCH:metric_required');
}
/** 解析结果 + 代理说明,做成给模型看的一坨 Json(工具 output 用通用 "Object")。 */
function present(r: DataConceptResolution) {
  const rules = proxiesFor(r.metric, r.market_type);
  return {
    ...r,
    availability_contract: toAvailability(r.availability),
    proxy_rules: rules.map((rule) => ({ id: rule.id, label: rule.label, target: rule.target, requires: rule.requires.map((q) => q.metric), statement: describeProxy(rule) })),
    fabrication_guard: '缺数据就说缺;代理指标必须以代理身份出现在报告里,不能填进原指标的字段',
  };
}
/** 目录的解释拼进 Coverage.note —— Coverage 在契约里是 additionalProperties:false,多的信息只能进 note 和 warnings。 */
const noteOf = (r: DataConceptResolution, extra?: string) => [r.availability === 'available' && r.adapter_id ? `来源 ${r.adapter_id}` : '', r.note, extra].filter(Boolean).join(';');
function proxyWarnings(r: DataConceptResolution): string[] {
  if (r.availability === 'available') return [];
  return proxiesFor(r.metric, r.market_type).map((rule) => `可用代理:${describeProxy(rule)}`);
}
/**
 * 把数据目录的两个工具装进 registry。主线程调用:registerDataTools(registry, def)。
 * 前提:tools.ts 里原来那条 inspect_data_coverage 的 registry.register 要先删掉(registry 重名会抛 duplicate_tool)。
 */
export function registerDataTools(registry: ToolRegistryLike, def: DefineTool): void {
  registry.register(
    def(
      'find_data_source',
      'Object',
      'Object',
      async (input: Record<string, unknown>) => {
        const metric = readMetric(input.metric), instrument = readInstrument(input.instrument);
        const timeframe = typeof input.timeframe === 'string' ? input.timeframe : null;
        const r = resolveDataConcept(metric, instrument, timeframe);
        return ok(present(r), {
          status: toStatus(r.availability),
          coverage: { availability: toAvailability(r.availability), note: noteOf(r) },
          warnings: proxyWarnings(r),
        });
      },
      { access: 'read' },
    ),
  );
  registry.register(
    def(
      'inspect_data_coverage',
      'DataInput',
      'Coverage',
      async (input: { instrument: Instrument; window: { from_ms: number; to_ms: number }; timeframe?: string; metric?: MetricKey }, ctx: ToolContext) => {
        const metric = readMetric(input.metric);
        const r = resolveDataConcept(metric, input.instrument, input.timeframe ?? null);
        // 目录就能定案的三种:不成立 / 已知但没接 / 连来源都没有 —— 不碰网络,直接如实回。
        if (r.availability === 'not_applicable' || r.availability === 'not_connected' || r.availability === 'missing') {
          const coverage: Coverage = { availability: toAvailability(r.availability), note: noteOf(r) };
          return ok(coverage, { status: toStatus(r.availability), coverage, warnings: proxyWarnings(r) });
        }
        // 目录说有,再问真来源要实际覆盖;provider 说没有的时候把目录的解释一起带上,别让模型以为是随机失败。
        const live = await ctx.market.coverage(input.instrument, metric, input.window, ctx.signal);
        const coverage: Coverage = live.availability === 'available' ? live : { ...live, note: noteOf(r, live.note) };
        return ok(coverage, {
          status: coverage.availability === 'available' ? ('ok' as const) : coverage.availability,
          coverage,
          warnings: coverage.availability === 'available' ? [] : proxyWarnings(r),
        });
      },
      { access: 'read', budget_class: 'data_call' },
    ),
  );
}
/** 给诊断页/报告用的目录快照(不是工具,HTTP 层想直接读目录时用)。 */
export function dataCatalogSummary() {
  return { catalog: listAdapters(), metrics: METRICS, market_types: ['spot', 'perp', 'equity', 'index'] };
}
export { marketTypeOf };
