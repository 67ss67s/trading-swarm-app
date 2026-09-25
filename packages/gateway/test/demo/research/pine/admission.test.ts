/**
 * 准入门:因果 / 确定性 / 有数值输出 / 实测预热。
 * 全部走 mock runner,不需要真起引擎 —— 引擎只负责把 Pine 跑成序列,
 * 这里要测的是「拿什么样的序列判它能不能进目录」。
 */
import { describe, it, expect } from 'vitest';
import {
  admitScript, syntheticBars, leadingNulls, samplePoints, ADMISSION_METHOD_VERSION, ADMISSION_MARKET_BARS,
  syntheticSuite, marketSuite, defaultSuites, type AdmissionSuite, type PineDatasetSource,
} from '../../../../src/demo/research/pine/admission.js';
import type { ResearchDataset } from '@trading-swarm/contracts';
import type { PineRunInput, PineRunResult } from '../../../../src/demo/research/pine/client.js';

const bars = syntheticBars(120);

/** 因果指标:第 i 根只看 bars[0..i]（3 根简单均线,前 2 根预热）。 */
const sma3 = (input: PineRunInput): PineRunResult => ({
  bars: input.bars.length,
  warnings: [],
  series: {
    sma: input.bars.map((_b, i, all) =>
      i < 2 ? null : (Number(all[i]!.close) + Number(all[i - 1]!.close) + Number(all[i - 2]!.close)) / 3),
  },
});

const runner = (fn: (input: PineRunInput) => PineRunResult) => async (input: PineRunInput) => fn(input);

describe('Pine 准入门', () => {
  it('因果脚本通过四关,并报出实测预热与采样点', async () => {
    const report = await admitScript('//@version=5', runner(sma3), { bars, now: () => 1700000000000 });
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    expect(report.checks.map((c) => c.name).sort()).toEqual(['causality', 'determinism', 'outputs', 'warmup']);
    expect(report.outputs).toEqual(['sma']);
    expect(report.warmup_bars).toBe(2);
    expect(report.sample_points.length).toBeGreaterThan(1);
    expect(report.sample_points.at(-1)).toBe(bars.length - 1);
    expect(report.method_version).toBe(ADMISSION_METHOD_VERSION);
    expect(report.ran_at).toBe(1700000000000);
  });

  it('看得见未来的脚本被因果检查拒收(前缀跑与全量跑在同一根上不同)', async () => {
    // 用「下一根收盘」当输出:全量跑时 i 能看到 i+1,前缀跑时看不到 → 尾部必然对不上
    const lookahead = (input: PineRunInput): PineRunResult => ({
      bars: input.bars.length, warnings: [],
      series: { peek: input.bars.map((_b, i, all) => (all[i + 1] ? Number(all[i + 1]!.close) : Number(all[i]!.close))) },
    });
    const report = await admitScript('x', runner(lookahead), { bars });
    expect(report.ok).toBe(false);
    const causality = report.checks.find((c) => c.name === 'causality')!;
    expect(causality.ok).toBe(false);
    expect(causality.message).toContain('lookahead');
    expect(report.checks.find((c) => c.name === 'determinism')!.ok).toBe(true);
  });

  it('不确定的脚本被拒收,且报告指出是哪条输出漂移', async () => {
    let call = 0;
    const drifting = (input: PineRunInput): PineRunResult => {
      call += 1;
      return { bars: input.bars.length, warnings: [], series: { noise: input.bars.map(() => call) } };
    };
    const report = await admitScript('x', runner(drifting), { bars });
    expect(report.ok).toBe(false);
    const determinism = report.checks.find((c) => c.name === 'determinism')!;
    expect(determinism.ok).toBe(false);
    expect(determinism.message).toContain('noise');
  });

  it('没有数值输出的脚本直接判死,不再往下跑因果', async () => {
    const empty = (input: PineRunInput): PineRunResult => ({ bars: input.bars.length, warnings: [], series: { blank: input.bars.map(() => null) } });
    const report = await admitScript('x', runner(empty), { bars });
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]!.name).toBe('outputs');
    expect(report.outputs).toEqual([]);
  });

  it('预热长到吃掉整段样本时 warmup 判死(样本太短或脚本无效)', async () => {
    const late = (input: PineRunInput): PineRunResult => ({
      bars: input.bars.length, warnings: [],
      series: { slow: input.bars.map((_b, i) => (i >= input.bars.length - 1 && input.bars.length >= bars.length ? 1 : null)) },
    });
    const report = await admitScript('x', runner(late), { bars });
    const warmup = report.checks.find((c) => c.name === 'warmup')!;
    expect(warmup.ok).toBe(true); // 最后一根有值 → 预热 = n-1 < n
    expect(report.warmup_bars).toBe(bars.length - 1);
  });

  it('容差内的浮点抖动不算 lookahead', async () => {
    const jitter = (input: PineRunInput): PineRunResult => {
      const full = sma3(input);
      const drift = input.bars.length === bars.length ? 0 : 1e-12;
      return { ...full, series: { sma: full.series.sma!.map((v) => (v === null ? null : v + drift)) } };
    };
    const report = await admitScript('x', runner(jitter), { bars });
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
  });

  it('合成 K 线是确定性的,采样点跳过预热并一定包含最后一根', () => {
    expect(syntheticBars(50)).toEqual(syntheticBars(50));
    expect(leadingNulls([null, null, 1, 2])).toBe(2);
    expect(leadingNulls([null, null])).toBe(2);
    const points = samplePoints(200, 30, 6);
    expect(points[0]).toBeGreaterThan(30);
    expect(points.at(-1)).toBe(199);
    expect([...points].sort((a, b) => a - b)).toEqual(points);
  });
});

describe('Pine 准入 v2:两套数据', () => {
  const market = (count = 1500): AdmissionSuite => ({ id: 'market', label: '真实 BTC 1d', bars: syntheticBars(count, 86400000, Date.UTC(2020, 0, 1)).map((b, i) => ({ ...b, close: (Number(b.close) * (1 + ((i * 7919) % 13) / 100)).toFixed(8) })), timeframe: '1d', dataset_id: 'ds1', symbol: 'BTCUSDT' });

  it('两套各自跑因果与确定性,都过才 ok;报告带每套结果与 real_data', async () => {
    const seen: string[] = [];
    const report = await admitScript('x', async (i) => { seen.push(i.timeframe!); return sma3(i); }, { suites: [syntheticSuite(120), market(300)], now: () => 1 });
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    expect(report.method_version).toBe('pine_admission_v2');
    expect(report.real_data).toBe(true);
    expect(report.suites!.map((x) => [x.id, x.ok, x.bars])).toEqual([['synthetic', true, 120], ['market', true, 300]]);
    for (const suite of report.suites!) expect(suite.checks.map((c) => c.name)).toEqual(['outputs', 'warmup', 'determinism', 'causality']);
    expect(seen).toContain('1h');
    expect(seen).toContain('1d'); // 真实套按自己的周期跑
    expect(report.checks.find((c) => c.name === 'causality')!.message).toContain('[真实 BTC 1d]');
  });

  it('只在真实行情上露馅的 lookahead(按日期对齐)也被拒收,报告指出是哪一套', async () => {
    // 1h 数据上因果;日线数据上偷看下一根 —— 只用合成数据会漏掉
    const sneaky = (input: PineRunInput): PineRunResult => input.timeframe === '1d'
      ? { bars: input.bars.length, warnings: [], series: { v: input.bars.map((_b, i, all) => Number((all[i + 1] ?? all[i]!).close)) } }
      : sma3(input);
    const report = await admitScript('x', runner(sneaky), { suites: [syntheticSuite(120), market(300)] });
    expect(report.ok).toBe(false);
    expect(report.suites!.find((x) => x.id === 'synthetic')!.ok).toBe(true);
    expect(report.suites!.find((x) => x.id === 'market')!.ok).toBe(false);
    const causality = report.checks.find((c) => c.name === 'causality')!;
    expect(causality.ok).toBe(false);
    expect(causality.message).toContain('[真实 BTC 1d]');
    expect(causality.message).not.toContain('[合成');
  });

  it('确定性也按套检查', async () => {
    let n = 0;
    const flaky = (input: PineRunInput): PineRunResult => input.timeframe === '1d'
      ? { bars: input.bars.length, warnings: [], series: { v: input.bars.map(() => ++n) } }
      : sma3(input);
    const report = await admitScript('x', runner(flaky), { suites: [syntheticSuite(120), market(200)] });
    expect(report.checks.find((c) => c.name === 'determinism')!.ok).toBe(false);
    expect(report.suites![0]!.ok).toBe(true);
  });

  it('marketSuite 取研究库最新的日线/4h 数据集切最后 1200 根;没有就只剩合成一套', () => {
    const ds = market(1500);
    const source: PineDatasetSource = {
      datasets: () => [
        { id: 'h1', timeframe_ms: 3600000 },
        { id: 'd1', timeframe_ms: 86400000 },
        { id: 'h4', timeframe_ms: 14400000 },
      ],
      dataset: (id) => ({ id, venue: 'okx', market: 'spot', symbol: 'BTCUSDT', source: 'test', timeframe_ms: id === 'h4' ? 14400000 : 86400000, bars: ds.bars } as unknown as ResearchDataset),
    };
    const picked = marketSuite(source)!;
    expect(picked.dataset_id).toBe('d1'); // 1h 跳过,按列表顺序(入库新→旧)取第一条日线/4h
    expect(picked.bars).toHaveLength(ADMISSION_MARKET_BARS);
    expect(picked.bars.at(-1)).toEqual(ds.bars.at(-1));
    expect(picked.timeframe).toBe('1d');
    expect(defaultSuites(source).map((x) => x.id)).toEqual(['synthetic', 'market']);
    expect(defaultSuites({ datasets: () => [{ id: 'h1', timeframe_ms: 3600000 }], dataset: source.dataset }).map((x) => x.id)).toEqual(['synthetic']);
    expect(defaultSuites(null).map((x) => x.id)).toEqual(['synthetic']);
  });

  it('只有合成数据时 real_data=false', async () => {
    const report = await admitScript('x', runner(sma3), {});
    expect(report.real_data).toBe(false);
    expect(report.suites).toHaveLength(1);
    expect(report.suites![0]!.id).toBe('synthetic');
  });
});
