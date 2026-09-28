/**
 * pine_series(signal)/ pine_series_exit(exit):把「Pine 脚本目录」里**已准入**的任意 Pine 指标
 * 当成一个原语接进策略 IR。
 *
 * 为什么不走 registry.define():define() 会把 bars 截到 i+1,于是回测每根 bar 都变成一次
 * 独立的引擎调用(几千次子进程 + PineTS 全量重算),不可用。这里改成「整段数据跑一次、按 i 取值」,
 * 正确性由**准入门的因果测试**背书:脚本必须证明 bars[0..i] 与全量 bars 在第 i 根上输出一致,
 * 否则 admitted=false,这两个原语根本取不到它。lookahead:'none' 的依据就是那份准入报告。
 *
 * 没有引擎 / 脚本不在目录 / 没准入 / 输出名不存在 / 声明的 warmup 小于实测预热 —— 一律抛错,
 * 绝不返回 pass:false 假装「这根没信号」。
 */
import type { ResearchBar } from '@trade-gate/contracts';
import { schemas } from '@trade-gate/contracts';
import { registry, type Primitive, type PrimitiveContext, type PrimitiveValue } from './registry.js';
import type { PineScript } from '../pine/catalog.js';
import { pineCatalog } from '../pine/catalog.js';
import { runPine, runPineSync, inputsRecord, PINE_ENGINE_HINT } from '../pine/client.js';
import { effectiveInputsSchema, validatePineInputs } from '../pine/inputs-schema.js';

/** 引擎与目录的接入口;测试注入 mock,生产由 pine/routes.ts 装配。 */
export interface PineRuntime {
  /** 按 id 或名字取目录条目。 */
  script(idOrName: string): PineScript | null;
  /** 跑出 plot 名 → 与 bars 等长的序列(同步;实现内部负责缓存)。 */
  series(script: PineScript, inputs: Record<string, unknown> | undefined, bars: ResearchBar[], timeframe: string): Record<string, (number | null)[]>;
  /** 可选:把窗口 bars 还原成它所属的整段数据,让引擎一次跑完而不是逐根跑。 */
  whole?(bars: ResearchBar[], timeframe_ms: number): ResearchBar[] | null;
  /** 可选:记一次使用量。 */
  used?(id: string): void;
}

let runtime: PineRuntime | null = null;
export function setPineRuntime(rt: PineRuntime | null): void { runtime = rt; }
export function pineRuntime(): PineRuntime | null { return runtime; }

export function timeframeLabel(ms: number): string {
  if (ms % 86400000 === 0) return `${ms / 86400000}d`;
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  return `${Math.max(1, Math.round(ms / 60000))}m`;
}

const params = (schemas.research.$defs as Record<string, unknown>).PrimitiveParamsPineSeries as Record<string, unknown>;

/** 比较所需的一根样本:当根与上一根的指标值、收盘价、以及可选的第二条输出。 */
export interface PineSample { value: number | null; previous: number | null; close: number; closePrevious: number | null; other: number | null; otherPrevious: number | null }

/** 整段数组 open_time → 下标(按数组引用缓存):逐根线性查找在 4h 六年(1.3 万根)上是 O(n²),2026-09-23 实测把网关事件循环堵了 8 分钟 */
const openIndex = new WeakMap<ResearchBar[], Map<number, number>>();
function indexOfOpen(full: ResearchBar[], open_time: number | undefined): number {
  if (open_time === undefined) return -1;
  let m = openIndex.get(full);
  if (!m) { m = new Map(full.map((b, i) => [b.open_time, i])); openIndex.set(full, m); }
  return m.get(open_time) ?? -1;
}
/** 取当前 bar(与上一根)的指标值;所有失败都抛带说明的错误。 */
function resolve(ctx: PrimitiveContext, p: Record<string, unknown>): PineSample {
  if (!runtime) throw new Error(`PROVIDER_ERROR:pine_runtime_missing:pine_series 需要 Pine 引擎与脚本目录。${PINE_ENGINE_HINT}`);
  const id = String(p.script_id ?? '');
  const script = runtime.script(id);
  if (!script) throw new Error(`pine_script_not_found:${id}(目录里没有这个脚本;先 POST /api/research/pine/scripts 登记)`);
  if (!script.admitted) {
    const failed = script.admission_report?.checks.filter((c) => !c.ok).map((c) => `${c.name}:${c.message}`) ?? ['尚未跑过准入'];
    throw new Error(`pine_script_not_admitted:${script.name}:${failed.join(';')}`);
  }
  const inputErrors = validatePineInputs(effectiveInputsSchema(script.inputs_schema, script.script), inputsRecord(p.inputs));
  if (inputErrors.length) throw new Error(`pine_inputs_invalid:${script.name}:${inputErrors.join(';')}`);
  const actual = script.admission_report?.warmup_bars ?? 0, declared = Number(p.warmup_bars);
  // 声明的预热小于实测 → 策略会在指标还没成形的区间里下单;这是参数错误,必须显性失败。
  if (!Number.isFinite(declared) || declared < actual) {
    throw new Error(`pine_warmup_understated:${script.name} 实测预热 ${actual} 根,warmup_bars 声明 ${p.warmup_bars};把 warmup_bars 提到 ≥ ${actual}`);
  }

  const timeframe = timeframeLabel(ctx.timeframe_ms);
  const window = ctx.bars;
  const whole = runtime.whole?.(window, ctx.timeframe_ms) ?? null;
  // 能还原成整段数据就整段跑(一次),否则退回按窗口跑(结果一样,只是慢)。
  const bars = whole ?? window;
  const index = whole ? indexOfOpen(whole, window[ctx.i]?.open_time) : ctx.i;
  if (index < 0) throw new Error('pine_bar_not_in_dataset');
  const series = runtime.series(script, inputsRecord(p.inputs), bars, timeframe);

  const name = String(p.output ?? '');
  const row = series[name];
  if (!row) throw new Error(`pine_output_not_found:${name};可用输出:${Object.keys(series).join('、') || '(无)'}`);
  const compareTo = String(p.compare_to ?? (p.threshold === undefined ? 'zero' : 'threshold'));
  let other: (number | null)[] | undefined;
  if (compareTo === 'output') {
    const otherName = String(p.compare_output ?? '');
    other = series[otherName];
    if (!other) throw new Error(`pine_compare_output_not_found:${otherName};可用输出:${Object.keys(series).join('、')}`);
  }
  runtime.used?.(script.id);
  return {
    value: row[index] ?? null,
    previous: index > 0 ? (row[index - 1] ?? null) : null,
    close: Number(bars[index]?.close),
    closePrevious: index > 0 ? Number(bars[index - 1]?.close) : null,
    other: other ? (other[index] ?? null) : null,
    otherPrevious: other && index > 0 ? (other[index - 1] ?? null) : null,
  };
}

/** 参考值:threshold / 0 / 收盘价 / 另一条输出。 */
function reference(p: Record<string, unknown>, r: PineSample, previous: boolean): number | null {
  switch (String(p.compare_to ?? (p.threshold === undefined ? 'zero' : 'threshold'))) {
    case 'zero': return 0;
    case 'close': return previous ? r.closePrevious : r.close;
    case 'output': return previous ? r.otherPrevious : r.other;
    default: {
      const t = Number(p.threshold);
      if (!Number.isFinite(t)) throw new Error('pine_threshold_required:compare_to=threshold 时必须给 threshold');
      return t;
    }
  }
}

/** 比较:预热段(null)一律不成立。 */
export function pineCompare(p: Record<string, unknown>, r: PineSample): boolean {
  const operator = String(p.operator ?? 'above');
  const v = r.value;
  if (v === null) return false;
  const ref = reference(p, r, false);
  if (ref === null) return false;
  if (operator === 'above') return v > ref;
  if (operator === 'below') return v < ref;
  const prev = r.previous;
  if (prev === null) return false;
  const prevRef = reference(p, r, true);
  if (prevRef === null) return false;
  return operator === 'cross_above' ? prev <= prevRef && v > ref : prev >= prevRef && v < ref;
}

/**
 * 编译期参数校验:inputs 必须合脚本的 inputs_schema(类型/范围/枚举;schema 缺省从源码 input.*() 推导)。
 * 返回错误列表;脚本不在目录时返回空(那是 pine_script_ready / 运行期的事,这里只管参数)。
 * checkIR 可以直接调它出一条 pine_inputs 检查;没接之前,warmup() 会因参数不合抛错,编译照样判死。
 */
export function pineSeriesParamErrors(p: Record<string, unknown>): string[] {
  const script = runtime?.script(String(p.script_id ?? ''));
  if (!script) return [];
  return validatePineInputs(effectiveInputsSchema(script.inputs_schema, script.script), inputsRecord(p.inputs))
    .map((e) => `Pine 脚本「${script.name}」参数不合 schema:${e}`);
}

/** 预热根数:声明值与准入实测值取大,让 checkIR 的 warmup 检查看到真实数字。参数不合 schema 时抛错 → 编译判死。 */
function warmup(p: Record<string, unknown>): number {
  const errors = pineSeriesParamErrors(p);
  if (errors.length) throw new Error(`pine_inputs_invalid:${errors.join(';')}`);
  const declared = Number(p.warmup_bars);
  const actual = runtime?.script(String(p.script_id ?? ''))?.admission_report?.warmup_bars ?? 0;
  return Math.max(Number.isFinite(declared) ? declared : 0, actual, 1);
}

function describe(p: Record<string, unknown>): string {
  const name = runtime?.script(String(p.script_id ?? ''))?.name ?? String(p.script_id ?? '?');
  const target = String(p.compare_to ?? (p.threshold === undefined ? 'zero' : 'threshold'));
  const ref = target === 'threshold' ? String(p.threshold) : target === 'output' ? String(p.compare_output) : target === 'close' ? '收盘价' : '0';
  const op = { above: '高于', below: '低于', cross_above: '上穿', cross_below: '下穿' }[String(p.operator ?? 'above')] ?? String(p.operator);
  const errors = pineSeriesParamErrors(p);
  return `Pine 脚本「${name}」的 ${String(p.output ?? '?')} ${op} ${ref}（${JSON.stringify(p)}）${errors.length ? `【参数不合 schema,编译判死:${errors.join(';')}】` : ''}`;
}

function register(name: string, category: Primitive['category'], compute: Primitive['compute']): Primitive {
  const primitive: Primitive = { name, category, params, warmup_bars: warmup, lookahead: 'none', describe, compute };
  registry.set(name, primitive);
  return primitive;
}

export const pine_series = register('pine_series', 'signal', (ctx, p): PrimitiveValue => ({ pass: pineCompare(p, resolve(ctx, p)) }));
export const pine_series_exit = register('pine_series_exit', 'exit', (ctx, p): PrimitiveValue => ({ exit: !!ctx.position && pineCompare(p, resolve(ctx, p)) }));

/**
 * 默认运行时:目录走进程内单例(pine/routes.ts 装配),序列走同步 HTTP 客户端。
 * datasets 传进来时可以把回测窗口还原成整段数据,一个 (脚本, 参数, 数据集) 只跑一次引擎。
 */
export function defaultPineRuntime(datasets?: () => { id: string; timeframe_ms: number; first_at?: number; last_at?: number }[], load?: (id: string) => { bars: ResearchBar[] }): PineRuntime {
  const wholeCache = new Map<string, ResearchBar[]>();
  let listCache: { at: number; items: { id: string; timeframe_ms: number; first_at?: number; last_at?: number }[] } | null = null;
  let lastHit: { full: ResearchBar[]; timeframe_ms: number } | null = null;
  // 按 bars 数组的引用缓存序列:whole() 每次返回同一个整段数组,回测/预检查逐根调用时不必每根重新哈希 2400 根 K 线
  // (2026-09-22 实测:每根都算 barsHash 让预检查 15 秒预算爆掉)
  const seriesCache = new WeakMap<ResearchBar[], Map<string, Record<string, (number | null)[]>>>();
  return {
    script: (idOrName) => pineCatalog()?.find(idOrName) ?? null,
    used: (id) => pineCatalog()?.used(id),
    series: (script, inputs, bars, timeframe) => {
      let byKey = seriesCache.get(bars);
      if (!byKey) { byKey = new Map(); seriesCache.set(bars, byKey); }
      const key = `${script.id}|${script.updated_at ?? ''}|${JSON.stringify(inputs ?? {})}|${timeframe}|${bars.length}`;
      const hit = byKey.get(key);
      if (hit) return hit;
      const out = runPineSync({ script: script.script, inputs, bars, timeframe }).series;
      byKey.set(key, out);
      return out;
    },
    whole: (window, timeframe_ms) => {
      if (!datasets || !load) return null;
      const lastBar = window.at(-1);
      if (!lastBar) return null;
      // 同一个窗口末根(回测逐根推进时每根都问一次)先查上次命中的整段;数据集列表缓存 5 秒,不再每根查一遍库
      if (lastHit && lastHit.timeframe_ms === timeframe_ms) { const i = indexOfOpen(lastHit.full, lastBar.open_time); if (i >= 0 && lastHit.full[i]!.close === lastBar.close && lastHit.full.length >= window.length) return lastHit.full; }
      const now = Date.now();
      if (!listCache || now - listCache.at > 5000) listCache = { at: now, items: datasets() };
      for (const summary of listCache.items) {
        if (summary.timeframe_ms !== timeframe_ms) continue;
        if (summary.last_at !== undefined && summary.last_at < lastBar.close_time) continue;
        if (summary.first_at !== undefined && summary.first_at > window[0]!.close_time) continue;
        let full = wholeCache.get(summary.id);
        if (!full) {
          try { full = load(summary.id).bars; } catch { continue; }
          // LRU:超过 16 个整段时淘汰最早的一个(旧口径整体清空,多资产回测时反复重载)
          if (wholeCache.size >= 16) wholeCache.delete(wholeCache.keys().next().value!);
          wholeCache.set(summary.id, full);
        }
        const i = indexOfOpen(full, lastBar.open_time);
        if (i >= 0 && full[i]!.close === lastBar.close && full.length >= window.length) { lastHit = { full, timeframe_ms }; return full; }
      }
      return null;
    },
  };
}

/**
 * 回测前用异步请求把整段 Pine 序列算好放进客户端缓存(键与 runPineSync 相同),逐根取值时只命中缓存。
 * 否则第一次取值走同步 HTTP,在 4h 六年上一次就是十几二十秒,期间网关事件循环整个停住(2026-09-23 实测 29 秒)。
 */
export async function prewarmPineSeries(ir: import('@trade-gate/contracts').StrategyIR, bars: ResearchBar[], timeframe_ms: number): Promise<void> {
  if (!runtime) return;
  const nodes = [...ir.signal, ir.entry, ir.risk.stop, ...ir.exit, ...(ir.regime ? [ir.regime] : []), ...(ir.order?.short_signal ?? [])];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node?.primitive?.startsWith('pine_')) continue;
    const script = runtime.script(String(node.params.script_id ?? ''));
    if (!script?.admitted) continue;
    const inputs = inputsRecord(node.params.inputs), key = `${script.id}|${JSON.stringify(inputs)}|${bars.length}|${bars.at(-1)?.open_time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 逐根取值时 resolve() 会先 whole() 还原整段数据再取序列;这里按同样的规则挑数组,预热的键才和同步路径一致
    const target = runtime.whole?.(bars, timeframe_ms) ?? bars;
    await runPine({ script: script.script, inputs, bars: target, timeframe: timeframeLabel(timeframe_ms) });
  }
}
