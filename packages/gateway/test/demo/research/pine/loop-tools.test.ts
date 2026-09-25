/**
 * agent 侧的两个工具:pine_lookup(搜目录)、pine_author(写脚本 + 自动准入)。
 * 用真的 ToolRegistry + 与 loop/tools.ts 同形状的 def(),确认主线程那行接线能装得上;
 * 模型与引擎都是 mock。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { ToolRegistry, type ToolDefinition, type ToolContext } from '../../../../src/demo/research/loop/tools.js';
import { schema } from '../../../../src/demo/research/loop/schema.js';
import { PineCatalog } from '../../../../src/demo/research/pine/catalog.js';
import { registerPineTools, stripFence, type PineToolDef } from '../../../../src/demo/research/pine/loop-tools.js';
import type { PineRunInput, PineRunResult } from '../../../../src/demo/research/pine/client.js';

const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));

/** loop/tools.ts 里私有的 def() 的同形副本(主线程会把自己的传进来)。 */
const def: PineToolDef = (name, input, output, run, options = {}) => ({
  name, version: '1', task_kinds: ['market', 'compare', 'validate', 'diagnose'], asset_classes: ['crypto'],
  access: 'compute', budget_class: 'none', timeout_ms: 30000, idempotent: true, cancellable: true,
  input: schema(input), output: schema(output), run, ...options,
} as ToolDefinition<never, never>);

function setup() {
  const db = openStateDb(':memory:');
  clean.push(() => db.close());
  const catalog = new PineCatalog(db.db, () => 1700000000000);
  const registry = new ToolRegistry();
  return { catalog, registry };
}

const causal = async (input: PineRunInput): Promise<PineRunResult> => ({
  bars: input.bars.length, warnings: [],
  series: { out: input.bars.map((_b, i, all) => (i < 2 ? null : Number(all[i]!.close))) },
});

const ctx = (brain?: ToolContext['brain']): ToolContext => ({
  inquiry_id: 'i1', step_id: 's1', signal: new AbortController().signal,
  store: null as never, budget: null as never, brain, now: () => 0, market: null as never,
});

describe('Pine agent 工具', () => {
  it('pine_lookup 默认只回已准入的条目,并带上引用所需的 warmup_bars', async () => {
    const { catalog, registry } = setup();
    const a = catalog.create({ name: '超级趋势', description: 'ATR 通道翻转', aliases: ['supertrend'], script: 'x' });
    catalog.create({ name: '未准入的', description: '超级趋势的半成品', script: 'y' });
    catalog.admit(a.id, {
      ok: true, checks: [], outputs: ['trend'], warmup_bars: 22, sample_points: [], bars: 100,
      timeframe: '1h', tolerance: 1e-9, warnings: [], ran_at: 0, method_version: 'pine_admission_v1',
    });
    registerPineTools(registry, def, { catalog: () => catalog, runner: causal });

    const hit = await registry.get('pine_lookup')!.run({ query: 'supertrend' }, ctx());
    expect(hit.status).toBe('ok');
    const items = (hit.output as { items: { script_id: string; warmup_bars: number }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.script_id).toBe(a.id);
    expect(items[0]!.warmup_bars).toBe(22);
    // admitted_only=false 时连未准入的一起回(让 agent 知道有个半成品在)
    const all = await registry.get('pine_lookup')!.run({ query: '超级趋势', admitted_only: false }, ctx());
    expect((all.output as { items: unknown[] }).items).toHaveLength(2);
  });

  it('pine_author 写出通过准入的脚本时落库并回可直接抄的 IR 片段', async () => {
    const { catalog, registry } = setup();
    registerPineTools(registry, def, { catalog: () => catalog, runner: causal });
    const complete = vi.fn(async () => ({
      text: '```pine\n//@version=5\nindicator("x")\nplot(close, "out")\n```',
      latency_ms: 1, model: 'mock', input_tokens: 1, output_tokens: 1,
    }));
    const out = await registry.get('pine_author')!.run({ concept: '收盘价本身' }, ctx({ name: 'mock', complete }));
    expect(out.status).toBe('ok');
    const body = out.output as { script_id: string; admitted: boolean; outputs: string[]; warmup_bars: number; usage: string };
    expect(body.admitted).toBe(true);
    expect(body.outputs).toEqual(['out']);
    expect(body.warmup_bars).toBe(2);
    expect(body.usage).toContain('pine_series');
    const saved = catalog.get(body.script_id)!;
    expect(saved.source).toBe('agent');
    expect(saved.admitted).toBe(true);
    expect(saved.script).toContain('//@version=5');
  });

  it('准入不过就带着具体原因重试,用尽次数后如实回失败而不是写进目录', async () => {
    const { catalog, registry } = setup();
    // 永远看得见未来的脚本 → 因果必挂
    const lookahead = async (input: PineRunInput): Promise<PineRunResult> => ({
      bars: input.bars.length, warnings: [],
      series: { out: input.bars.map((_b, i, all) => Number((all[i + 1] ?? all[i])!.close)) },
    });
    registerPineTools(registry, def, { catalog: () => catalog, runner: lookahead });
    const complete = vi.fn(async () => ({
      text: '//@version=5\nindicator("x")\nplot(close[-1], "out")',
      latency_ms: 1, model: 'mock', input_tokens: 1, output_tokens: 1,
    }));
    const out = await registry.get('pine_author')!.run({ concept: '偷看下一根', attempts: 2 }, ctx({ name: 'mock', complete }));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![1]).toContain('lookahead'); // 第二次把失败原因喂回去
    const body = out.output as { script_id: null; admitted: boolean; rejected: unknown[] };
    expect(body.script_id).toBeNull();
    expect(body.admitted).toBe(false);
    expect(body.rejected).toHaveLength(2);
    expect(catalog.list()).toHaveLength(0);
  });

  it('引擎没起时 pine_author 不重试,直接把启动方式回给 agent', async () => {
    const { catalog, registry } = setup();
    const dead = async (): Promise<PineRunResult> => { throw new Error('PROVIDER_ERROR:pine_engine_unavailable:挂了'); };
    registerPineTools(registry, def, { catalog: () => catalog, runner: dead });
    const complete = vi.fn(async () => ({ text: '//@version=5\nindicator("x")\nplot(close, "out")', latency_ms: 1, model: 'mock', input_tokens: 1, output_tokens: 1 }));
    const out = await registry.get('pine_author')!.run({ concept: 'x' }, ctx({ name: 'mock', complete }));
    expect(out.status).toBe('error');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out.warnings.join(' ')).toContain('/api/research/pine/health');
  });

  it('缺概念 / 缺模型 / 缺目录时给明确的错误码', async () => {
    const { catalog, registry } = setup();
    registerPineTools(registry, def, { catalog: () => catalog, runner: causal });
    expect((await registry.get('pine_author')!.run({}, ctx({ name: 'm', complete: vi.fn() as never }))).warnings[0]).toContain('concept_required');
    expect((await registry.get('pine_author')!.run({ concept: 'x' }, ctx())).warnings[0]).toContain('brain_unavailable');
    const orphan = new ToolRegistry();
    registerPineTools(orphan, def, { catalog: () => null, runner: causal });
    expect((await orphan.get('pine_lookup')!.run({}, ctx())).warnings[0]).toContain('pine_catalog_unavailable');
  });

  it('剥 markdown 围栏;不像 Pine 脚本的输出一律不收', () => {
    expect(stripFence('```pine\n//@version=5\nindicator("a")\n```')).toContain('indicator("a")');
    expect(stripFence('//@version=5\nplot(close)')).toContain('plot(close)');
    expect(stripFence('我建议你这样写一个指标')).toBe('');
    expect(stripFence('```js\nconsole.log(1)\n```')).toBe('');
  });
});
