/**
 * Pine 脚本准入门。目录里的脚本默认**不可用**,必须先过这几关才 admitted=true:
 *   (a) 因果:在若干采样点 i 上,用 bars[0..i] 跑出来的第 i 个值,必须等于用全量 bars 跑出来的第 i 个值。
 *       不等 = 脚本能看见未来(lookahead),直接拒收。这是 pine_series 敢标 lookahead:'none' 的唯一依据。
 *   (b) 确定性:同一份输入跑两次,序列必须逐位相等(含 null 位置)。
 *   (c) 至少一个数值输出序列(全 null / 没有 plot 的脚本进不了策略 IR)。
 *   (d) 实测预热根数:各输出前导 null 段的最大长度;pine_series 的 warmup_bars 参数不得小于它。
 *   (e) 参数(给了 schema 时):准入所用参数必须合 inputs_schema,不合直接判死、不跑引擎。
 *
 * v2(2026-09-23):(a)–(d) 在**多套数据**上各跑一遍,每套都得过——
 *   - synthetic:确定性合成 K 线(永远有);
 *   - market:研究库里最新的日线 / 4h 数据集切最后 1200 根(有才用;没有时报告 real_data=false 并注明);
 *   - custom:调用方显式给的 bars / dataset_id。
 * 合成数据太规整,有些 lookahead(比如按日期对齐的 request.security)只在真实行情上才露馅,所以要两套都过。
 *
 * 通过 PineRunner 注入引擎,单元测试直接用 mock,不需要真起引擎。
 */
import type { ResearchBar, ResearchDataset } from '@trading-swarm/contracts';
import type { PineRunner, PineRunInput } from './client.js';
import { validatePineInputs, type PineInputsSchema } from './inputs-schema.js';

export type AdmissionCheckName = 'outputs' | 'determinism' | 'causality' | 'warmup' | 'inputs';
export interface AdmissionCheck { name: AdmissionCheckName; ok: boolean; message: string }

/** 一套测试数据上的准入结果。 */
export interface AdmissionSuiteReport {
  id: AdmissionSuiteKind;
  label: string;
  dataset_id: string | null;
  symbol: string | null;
  timeframe: string;
  bars: number;
  ok: boolean;
  checks: AdmissionCheck[];
  outputs: string[];
  warmup_bars: number;
  sample_points: number[];
}

export interface AdmissionReport {
  ok: boolean;
  /** 各套数据合并后的检查项:某项在任一套上失败即失败,message 按套分段。 */
  checks: AdmissionCheck[];
  /** 有数值的 plot 名(各套的并集),pine_series 的 output 参数只能从这里选。 */
  outputs: string[];
  /** 实测预热根数(各套里最长的前导 null 段)。 */
  warmup_bars: number;
  /** 第一套数据的因果抽样点(bar 下标),留痕用;各套自己的在 suites[] 里。 */
  sample_points: number[];
  bars: number;
  timeframe: string;
  tolerance: number;
  warnings: string[];
  ran_at: number;
  method_version: string;
  /** v2:每套数据各自的结果。v1 旧报告没有这个字段。 */
  suites?: AdmissionSuiteReport[];
  /** v2:是否用上了真实行情;false = 研究库里没有日线/4h 数据集,只用了合成数据。 */
  real_data?: boolean;
}

export const ADMISSION_METHOD_VERSION = 'pine_admission_v2';
/** 相对容差:PineTS 内部是浮点,前缀跑与全量跑的累积误差允许到 1e-9 相对量级。 */
export const ADMISSION_TOLERANCE = 1e-9;
/** 真实行情切多少根:够暴露日期对齐类 lookahead,又不至于让 8 次引擎调用太慢。 */
export const ADMISSION_MARKET_BARS = 1200;

export type AdmissionSuiteKind = 'synthetic' | 'market' | 'custom';
export interface AdmissionSuite {
  id: AdmissionSuiteKind;
  label: string;
  bars: ResearchBar[];
  timeframe: string;
  dataset_id?: string | null;
  symbol?: string | null;
}

export interface AdmissionOptions {
  /** 多套测试数据;给了就只用这些。 */
  suites?: AdmissionSuite[];
  /** 兼容旧调用:单套数据(= 一套 custom);suites 与 bars 都没给时只用合成数据。 */
  bars?: ResearchBar[];
  inputs?: Record<string, unknown>;
  /** 给了就先按它校验 inputs(不合直接判死)。 */
  schema?: PineInputsSchema;
  timeframe?: string;
  symbol?: string;
  /** 因果采样点数量,默认 6。 */
  samples?: number;
  tolerance?: number;
  now?: () => number;
}

/** 只用到 ResearchStore 的这两个方法;测试可以塞一个最小实现。 */
export interface PineDatasetSource {
  datasets(): { id: string; timeframe_ms: number; symbol?: string; first_at?: number; last_at?: number }[];
  dataset(id: string): ResearchDataset;
}

export const timeframeText = (ms: number): string =>
  ms % 86400000 === 0 ? `${ms / 86400000}d` : ms % 3600000 === 0 ? `${ms / 3600000}h` : `${Math.round(ms / 60000)}m`;

/**
 * 合成测试 K 线:确定性、带趋势段与回撤段、成交量有节奏,够让大部分指标跑出非平凡序列。
 * 有真实 dataset 时优先传真数据(路由支持 dataset_id),这里是没有数据时的兜底。
 */
export function syntheticBars(count = 320, stepMs = 3600000, t0 = Date.UTC(2025, 0, 1)): ResearchBar[] {
  let price = 100;
  return Array.from({ length: count }, (_, i) => {
    const open = price;
    // 周期性趋势 + 固定节奏的回撤,全程无随机数,准入结果可复现
    price = Math.max(20, price + Math.sin(i / 11) * 1.4 + (i % 23 === 0 ? -6 : 0.35));
    const high = Math.max(open, price) + 0.4, low = Math.min(open, price) - 0.4;
    return {
      open_time: t0 + i * stepMs,
      close_time: t0 + (i + 1) * stepMs - 1,
      available_at: t0 + (i + 1) * stepMs - 1,
      open: open.toFixed(8), high: high.toFixed(8), low: low.toFixed(8), close: price.toFixed(8),
      volume: (i % 7 === 0 ? 220 : 100 + (i % 13) * 3).toFixed(8),
    } satisfies ResearchBar;
  });
}

export function syntheticSuite(count = 320): AdmissionSuite {
  return { id: 'synthetic', label: `合成 K 线(${count} 根 1h)`, bars: syntheticBars(count), timeframe: '1h', dataset_id: null, symbol: 'TEST-USDT' };
}

/**
 * 真实行情套:研究库里最新(按入库时间)的日线或 4h 数据集,取最后 1200 根。
 * 没有这类数据集 / 读取失败返回 null——调用方只用合成数据,报告里 real_data=false。
 */
export function marketSuite(source: PineDatasetSource | null | undefined, maxBars = ADMISSION_MARKET_BARS): AdmissionSuite | null {
  if (!source) return null;
  let list: ReturnType<PineDatasetSource['datasets']> = [];
  try { list = source.datasets(); } catch { return null; }
  for (const summary of list) {
    if (summary.timeframe_ms !== 86400000 && summary.timeframe_ms !== 14400000) continue;
    try {
      const d = source.dataset(summary.id);
      const bars = d.bars.slice(-maxBars);
      if (bars.length < 60) continue;
      const timeframe = timeframeText(d.timeframe_ms);
      return { id: 'market', label: `真实行情 ${d.symbol} ${timeframe}(最后 ${bars.length} 根)`, bars, timeframe, dataset_id: summary.id, symbol: d.symbol };
    } catch { continue; }
  }
  return null;
}

/** 默认两套:合成 + 真实行情(有的话)。 */
export function defaultSuites(source?: PineDatasetSource | null): AdmissionSuite[] {
  const market = marketSuite(source);
  return market ? [syntheticSuite(), market] : [syntheticSuite()];
}

// ---- 进程内数据源单例:pine/routes.ts 装配(研究库),loop 工具 pine_author 准入时取用。
let datasetSource: PineDatasetSource | null = null;
export function setAdmissionDataSource(source: PineDatasetSource | null): void { datasetSource = source; }
export function admissionDataSource(): PineDatasetSource | null { return datasetSource; }

/** 前导 null 段长度(第一个非 null 的下标);全 null 返回序列长度。 */
export function leadingNulls(row: (number | null)[]): number {
  const at = row.findIndex((v) => v !== null);
  return at === -1 ? row.length : at;
}

const close = (a: number | null, b: number | null, tol: number): boolean => {
  if (a === null || b === null) return a === b;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
};

/** 采样点:跳过预热段,在剩余区间里均匀取点,最后一根一定取(最容易暴露 lookahead 的位置在尾部)。 */
export function samplePoints(bars: number, warmup: number, samples: number): number[] {
  const first = Math.min(bars - 1, Math.max(warmup + 1, Math.floor(bars * 0.25)));
  const lastIndex = bars - 1;
  if (first >= lastIndex) return [lastIndex];
  const span = lastIndex - first, take = Math.max(1, Math.min(samples, span + 1));
  const out = new Set<number>();
  for (let k = 0; k < take; k++) out.add(first + Math.round((span * k) / Math.max(1, take - 1)));
  out.add(lastIndex);
  return [...out].sort((a, b) => a - b);
}

export async function admitScript(
  script: string,
  run: PineRunner,
  options: AdmissionOptions = {},
): Promise<AdmissionReport> {
  const suites: AdmissionSuite[] = options.suites?.length
    ? options.suites
    : options.bars?.length
      ? [{ id: 'custom', label: `指定数据(${options.bars.length} 根)`, bars: options.bars, timeframe: options.timeframe ?? '1h', symbol: options.symbol ?? null }]
      : [syntheticSuite()];
  const tolerance = options.tolerance ?? ADMISSION_TOLERANCE;
  const now = options.now ?? Date.now;
  const warnings: string[] = [];
  const first = suites[0]!;
  const finish = (checks: AdmissionCheck[], reports: AdmissionSuiteReport[]): AdmissionReport => {
    const outputs = [...new Set(reports.flatMap((r) => r.outputs))].sort();
    return {
      ok: checks.length > 0 && checks.every((c) => c.ok),
      checks, outputs,
      warmup_bars: reports.length ? Math.max(0, ...reports.map((r) => r.warmup_bars)) : 0,
      sample_points: reports[0]?.sample_points ?? [],
      bars: first.bars.length, timeframe: first.timeframe, tolerance, warnings,
      ran_at: now(), method_version: ADMISSION_METHOD_VERSION,
      suites: reports,
      real_data: suites.some((x) => x.id !== 'synthetic'),
    };
  };

  // (e) 参数先过 schema:不合就不必跑引擎
  if (options.schema) {
    const errors = validatePineInputs(options.schema, options.inputs);
    const check: AdmissionCheck = {
      name: 'inputs', ok: errors.length === 0,
      message: errors.length ? `参数不合 inputs_schema:${errors.join(';')}` : `参数合 inputs_schema(${Object.keys(options.inputs ?? {}).length} 个显式参数)`,
    };
    if (!check.ok) return finish([check], []);
    const reports: AdmissionSuiteReport[] = [];
    for (const suite of suites) reports.push(await admitOnSuite(script, run, suite, options, tolerance, warnings));
    return finish([check, ...mergeChecks(reports)], reports);
  }
  const reports: AdmissionSuiteReport[] = [];
  for (const suite of suites) reports.push(await admitOnSuite(script, run, suite, options, tolerance, warnings));
  return finish(mergeChecks(reports), reports);
}

/** 多套结果合并成一份检查清单:任一套失败即失败;只有一套时 message 原样,多套时按套分段。 */
function mergeChecks(reports: AdmissionSuiteReport[]): AdmissionCheck[] {
  const order: AdmissionCheckName[] = ['outputs', 'warmup', 'determinism', 'causality'];
  const out: AdmissionCheck[] = [];
  for (const name of order) {
    const hits = reports.map((r) => ({ r, c: r.checks.find((c) => c.name === name) })).filter((x) => x.c);
    if (!hits.length) continue;
    const ok = hits.every((x) => x.c!.ok);
    const message = reports.length === 1
      ? hits[0]!.c!.message
      : hits.filter((x) => !ok ? !x.c!.ok : true).map((x) => `[${x.r.label}] ${x.c!.message}`).join(';');
    out.push({ name, ok, message });
  }
  return out;
}

/** 在一套数据上跑 (c)(d)(b)(a)。 */
async function admitOnSuite(
  script: string, run: PineRunner, suite: AdmissionSuite, options: AdmissionOptions, tolerance: number, warnings: string[],
): Promise<AdmissionSuiteReport> {
  const bars = suite.bars;
  const base: Omit<PineRunInput, 'bars'> = { script, inputs: options.inputs, timeframe: suite.timeframe, symbol: suite.symbol ?? options.symbol };
  const checks: AdmissionCheck[] = [];
  const report = (outputs: string[], warmup: number, points: number[]): AdmissionSuiteReport => ({
    id: suite.id, label: suite.label, dataset_id: suite.dataset_id ?? null, symbol: suite.symbol ?? null,
    timeframe: suite.timeframe, bars: bars.length,
    ok: checks.every((c) => c.ok), checks, outputs, warmup_bars: warmup, sample_points: points,
  });

  // 全量跑一次(基准)
  const full = await run({ ...base, bars });
  for (const w of full.warnings) if (!warnings.includes(w)) warnings.push(w);

  // (c) 至少一个数值输出
  const outputs = Object.entries(full.series)
    .filter(([, row]) => row.some((v) => v !== null))
    .map(([name]) => name)
    .sort();
  checks.push({
    name: 'outputs',
    ok: outputs.length > 0,
    message: outputs.length ? `数值输出:${outputs.join('、')}` : '脚本没有产出任何数值序列(需要至少一个 plot)',
  });
  if (!outputs.length) return report(outputs, 0, []);

  // (d) 实测预热根数
  const warmup = Math.max(...outputs.map((name) => leadingNulls(full.series[name]!)));
  checks.push({
    name: 'warmup',
    ok: warmup < bars.length,
    message: warmup < bars.length
      ? `实测预热 ${warmup} 根;引用时 pine_series.warmup_bars 不得小于它`
      : `全部输出都是空的(预热 ${warmup} ≥ 测试 K 线 ${bars.length} 根),测试样本太短或脚本无输出`,
  });

  // (b) 确定性:同一输入原样再跑一次,逐位比对
  const again = await run({ ...base, bars });
  const drift = outputs.find((name) => {
    const a = full.series[name]!, b = again.series[name] ?? [];
    return a.length !== b.length || a.some((v, i) => !close(v, b[i] ?? null, 0));
  });
  checks.push({
    name: 'determinism',
    ok: !drift,
    message: drift ? `两次运行结果不一致(输出 ${drift});脚本含随机/时间依赖,不能进目录` : '两次运行逐位一致',
  });

  // (a) 因果:前缀跑 vs 全量跑,在采样点上必须一致
  const points = samplePoints(bars.length, warmup, options.samples ?? 6);
  const violations: string[] = [];
  for (const i of points) {
    const prefix = await run({ ...base, bars: bars.slice(0, i + 1) });
    for (const name of outputs) {
      const whole = full.series[name]![i] ?? null;
      const partial = prefix.series[name]?.[i] ?? null;
      if (!close(whole, partial, tolerance)) {
        violations.push(`bar ${i} 输出 ${name}:全量 ${whole} ≠ 前缀 ${partial}`);
        break;
      }
    }
    if (violations.length >= 3) break;
  }
  checks.push({
    name: 'causality',
    ok: violations.length === 0,
    message: violations.length
      ? `脚本能看见未来(lookahead),拒收:${violations.join(';')}`
      : `在 ${points.length} 个采样点上,前缀与全量结果一致(容差 ${tolerance})`,
  });

  return report(outputs, warmup, points);
}
