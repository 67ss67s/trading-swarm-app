/**
 * Strategy Lab(研究角色,这版**零模型**):把「策略库里每个版本现在跑得怎样」变成一个**预注册、可复现**的实验。
 *
 * 实验 = 冻结 manifest(策略 id/version/content_hash 的清单 × 数据窗口 × 结算参数 × 代码版本)→ 对每个 symbol 用
 * funnel.ts 的机械前瞻期望(同一份 K 线缓存、同一套结算)算出每个策略版本的 setups / 胜率 / 期望 R →
 * 结果冻结进 bot_run.result,并交接 strategy_lab → gate_captain(kind result)。**不改任何策略、不晋升、不写 eval_stats**
 * (Codex 稿 §6.4:统计要绑确切版本,现行 updateEvalStats 写 head 会错配,先不写)。
 *
 * 节奏:每 7 天,或累计 ≥ 10 笔新平仓;手动可触发;同一 manifest 哈希 24h 内不重复跑。
 * 这是「研究记录」,不是「策略已验证」——机械筛选的正期望 ≠ 含模型出入场的策略成绩(§6.3),summary 里写明。
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync } from 'node:fs';
import { anchoredWalkForward, summarizeReplay, selectWalkForward, selectUniverse, sharpe, UNIVERSE_RULE, type ReplaySample, type ReplayStats, effectiveReturns, validKline } from './replay-stats.js';
import { createHash } from 'node:crypto';
import { funnelForSeries, loadFunnelSeries, type FunnelThresholds, type LadderRung } from './funnel.js';
import { SIGNAL_REGISTRY, measurable, nextSignalState, closedWeeks, type SignalState } from './strategy-signals.js';
import { visibleWindow, missingSpans, mergeSpans, type Span } from './backtest.js';
import { dailyRegime, tfToMs } from './market.js';
import { simulateOutcome, outcomeEquityMarks } from './outcome.js';
import type { StrategySpec } from './strategies.js';

export const LAB_EVERY_MS = 7 * 86_400_000;
export const LAB_MIN_NEW_CLOSED = 10;
/** 60d 训练 + purge + 完整 OOS；position 使用至少一年。 */
export function scheduledLabDays(specs: readonly Pick<StrategySpec, 'horizon'>[]): number {
  return specs.some(s => s.horizon === 'position') ? 365 : 180;
}
/** 补缓存须请求完整根：旧范围止于根内时，不丢弃不足一根的尾片。 */
export function labCacheFetchSpans(covered: Span[], from: number, to: number, step: number): Span[] {
  return mergeSpans(missingSpans(covered, from, to, 1).map(g => ({
    from: Math.floor(g.from / step) * step,
    to: Math.min(to, Math.ceil((g.to + 1) / step) * step - 1),
  })));
}
export const LAB_DEDUP_MS = 24 * 3_600_000;
export const LAB_CODE_VERSION = 'strategy-lab-v3.2-p1b';

export interface ExperimentManifest {
  universe_rule: string;
  data_hashes?: Record<string, string>;
  universe_details?: { symbol: string; first_cached_at: number | null; last_cached_at: number | null; selected: boolean; status: string; error?: string }[];
  load_failure_ratio?: number;
  selected_load_failure_ratio?: number;
  probe_candidates?: { strategy_id: string; version: number; param: string; value: number }[];
  trial_count_snapshot?: Record<string, number>;
  statistics?: { bootstrap_iterations: number; bootstrap_seed: number; block_rule: string; train_days: number; test_days: number; eligibility: string };
  manifest_hash: string;
  code_version: string;
  registered_at: number;
  timeframe: string;
  days: number;
  from: number;
  to: number;
  symbols: string[];
  strategies: { id: string; version: number; content_hash: string; status: string }[];
  outcome: { stop_atr: number; tp_r: number; horizon_bars: number };
  cooldown_bars: number;
}

export interface ExperimentCell {
  strategy_id: string;
  version: number;
  symbol: string;
  setups: number;
  per_week: number;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
  total_r: number;
  replay?: ReplayStats;
  coverage?: Record<string, number>;
  gross?: { expectancy_r: number | null; total_r: number };
  net?: { expectancy_r: number | null; total_r: number };
}

export interface ExperimentResult {
  execution_manifest?: ExperimentManifest;
  data_hashes?: Record<string, string>;
  manifest_hash: string;
  /** funnel.ts 的 setup 定义是「突破 + 回踩」族的;其他族的策略这版量不出来,只列出来,不给假数字。 */
  unmeasured: { strategy_id: string; version: number; reason: string }[];
  cells: ExperimentCell[];
  /** 每个策略版本跨 symbol 的汇总(按 n 加权的期望) */
  by_strategy: { strategy_id: string; version: number; symbols: number; setups: number; n: number; win_rate: number | null; expectancy_r: number | null; total_r: number; replay?: ReplayStats; coverage?: Record<string, number>; gross?: { expectancy_r: number | null; total_r: number }; net?: { expectancy_r: number | null; total_r: number } }[];
  /** 09-07:参数探针汇总(只对 deps.probe 里的版本跑);老结果没有这个字段。 */
  probes?: ProbeCell[];
  errors: { symbol: string; error: string }[];
  note: string;
}

const FUNNEL_PARAM_KEYS = ['chase_atr_max', 'retest_vol_min', 'range_vol_min', 'breakout_window'];

/**
 * funnel.ts 的 setup 定义是「突破 + 回踩」:趋势延续族原生适用;多周期对齐族与波动压缩族是同一结构加一个前置条件
 * (周期同向 / squeeze),用它的参数(chase_atr_max / retest_vol_min / breakout_window)喂进去是个**粗代理**,summary 里会写明。
 * 资金费率极值族与区间均值回归族不是突破结构,喂进去只会得到同一份默认漏斗的数字(假数),所以不量。
 */
export { measurable };
/** @deprecated 使用 measurable。 */
export const measurableByFunnel = measurable;

/** 策略参数 → funnel 阈值(与 screener.ts thresholdsFor 同口径:突破位恒用前 N 根)。 */
export function rungFor(spec: StrategySpec): LadderRung {
  const p = (k: string, d: number): number => spec.params[k]?.value ?? d;
  const patch: Partial<FunnelThresholds> = {
    breakout_level: 'prior',
    vol_mode: 'either',
    chase_atr_max: p('chase_atr_max', 1.5),
    retest_vol_min: p('retest_vol_min', 1),
    range_vol_min: p('range_vol_min', 1),
    breakout_window: Math.max(1, Math.round(p('breakout_window', 12))),
  };
  return { key: `${spec.id}@${spec.version}`, label: `${spec.name} v${spec.version}`, patch };
}

export function registerManifest(inp: { strategies: StrategySpec[]; symbols: string[]; timeframe: string; days: number; now: number; outcome?: ExperimentManifest['outcome']; cooldown_bars?: number }): ExperimentManifest {
  const outcome = inp.outcome ?? { stop_atr: 0.8, tp_r: 1.5, horizon_bars: 48 };
  const cooldown = inp.cooldown_bars ?? 4;
  const strategies = inp.strategies.map((s) => ({ id: s.id, version: s.version, content_hash: s.content_hash, status: s.status })).sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
  const symbols = [...new Set(inp.symbols.map((s) => s.toUpperCase()))].sort();
  // 窗口按天取整,让同一天内重复注册得到同一个哈希(去重靠它)。
  const to = Math.floor(inp.now / 86_400_000) * 86_400_000;
  const from = to - inp.days * 86_400_000;
  const body = JSON.stringify({ code: LAB_CODE_VERSION, tf: inp.timeframe, from, to, symbols, strategies, outcome, cooldown, universe_rule: UNIVERSE_RULE });
  return { universe_rule: UNIVERSE_RULE, manifest_hash: createHash('sha256').update(body).digest('hex').slice(0, 16), code_version: LAB_CODE_VERSION, registered_at: inp.now, timeframe: inp.timeframe, days: inp.days, from, to, symbols, strategies, outcome, cooldown_bars: cooldown };
}

export interface RunExperimentDeps {
  specs: StrategySpec[];
  universe_candidates?: string[];
  top_n?: number;
  /** 测试/离线可注入持久 trial 记账器；返回 family 累积计数。 */
  record_trials?: (family: string, keys: string[]) => number;
  loadSeries?: typeof loadFunnelSeries;
  pause_ms?: number;
  onProgress?: (symbol: string, done: number, total: number) => void;
  /** 09-07:对这些版本(key `id@version`,一般是各策略的 head)额外跑参数探针:每个漏斗参数上下各拨一档。 */
  probe?: Set<string>;
  /**
   * 09-12 §1.3:**点名要测的候选值**(key `id@version`),来自 attribution 的 param 提案队列。
   * 与上面的「上下各拨一档」并列跑,所以一条归因提案能在同一份数据上拿到和现值可比的期望。
   */
  probe_values?: Record<string, { param: string; value: number }[]>;
}

/** 参数探针:一个版本 × 一个参数 × 一个候选值,跨 symbol 汇总后的机械期望。 */
export interface ProbeCell {
  replay?: ReplayStats;
  selected_folds?: number;
  strategy_id: string;
  version: number;
  param: string;
  value: number;
  symbols: number;
  setups: number;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
  total_r: number;
}

/** 每个漏斗参数拨一档的步长(单位同参数本身);超出 [min,max] 或等于当前值的候选跳过。 */
const PROBE_STEP: Record<string, number> = { chase_atr_max: 0.25, retest_vol_min: 0.2, range_vol_min: 0.2, breakout_window: 4 };

export function probeRungsFor(spec: StrategySpec, extra: readonly { param: string; value: number }[] = []): { rung: LadderRung; param: string; value: number }[] {
  const out: { rung: LadderRung; param: string; value: number }[] = [];
  const base = rungFor(spec);
  const push = (param: string, raw: number): void => {
    if (out.some((o) => o.param === param && o.value === raw)) return;
    out.push({ rung: { key: `${spec.id}@${spec.version}#${param}=${raw}`, label: `${spec.name} v${spec.version} ${param}=${raw}`, patch: { ...base.patch, [param]: raw } }, param, value: raw });
  };
  // 点名的候选值先进(归因提案要的就是这几个数);越界/等于现值的照样跳过。
  for (const e of extra) {
    const p = spec.params[e.param];
    if (!p || !Number.isFinite(e.value)) continue;
    const raw = e.param === 'breakout_window' ? Math.round(e.value) : Math.round(e.value * 100) / 100;
    if (raw < p.min || raw > p.max || raw === p.value) continue;
    push(e.param, raw);
  }
  for (const [param, step] of Object.entries(PROBE_STEP)) {
    const p = spec.params[param];
    if (!p) continue;
    for (const dir of [-1, 1]) {
      const raw = param === 'breakout_window' ? Math.round(p.value + dir * step) : Math.round((p.value + dir * step) * 100) / 100;
      if (raw < p.min || raw > p.max || raw === p.value) continue;
      push(param, raw);
    }
  }
  return out;
}

/** 按 manifest 跑:每个 symbol 拉一次序列,把每个策略版本当一个「变体」喂给 funnel,读它的前瞻期望。 */
export async function runExperiment(m: ExperimentManifest, deps: RunExperimentDeps): Promise<ExperimentResult> {
  const load = deps.loadSeries ?? loadFunnelSeries;
  const inManifest = deps.specs.filter((s) => m.strategies.some((x) => x.id === s.id && x.version === s.version && x.content_hash === s.content_hash));
  const unmeasured = inManifest.filter((s) => !measurableByFunnel(s)).map((s) => ({ strategy_id: s.id, version: s.version, reason: `策略族 ${s.family} 的 setup 定义还没接进实验(funnel 只算突破回踩族)` }));
  for (const pinned of m.strategies) if (!inManifest.some(s => s.id === pinned.id && s.version === pinned.version)) unmeasured.push({ strategy_id: pinned.id, version: pinned.version, reason: '策略版本或 content_hash 与预注册 manifest 不符' });
  const measurable = inManifest.filter(measurableByFunnel);
  const rungs = measurable.map(rungFor);
  // 参数探针:只对 deps.probe 指定的版本(一般是 head),每个参数上下各一档
  const probeDefs = measurable
    .filter((s) => deps.probe?.has(`${s.id}@${s.version}`) || (deps.probe_values?.[`${s.id}@${s.version}`]?.length ?? 0) > 0)
    .flatMap((s) => probeRungsFor(s, deps.probe_values?.[`${s.id}@${s.version}`] ?? []));
  const allSamples = new Map<string, ReplaySample[]>();
  const trialCounts = new Map<string, number>();
  let trialDb: DatabaseSync | null = null;
  if (!deps.record_trials && !deps.loadSeries) {
    const dir = join(homedir(), '.trading-swarm', 'demo'); mkdirSync(dir, { recursive: true });
    trialDb = new DatabaseSync(join(dir, 'lab-trials.sqlite'));
    trialDb.exec('CREATE TABLE IF NOT EXISTS demo_strategy_trials(family TEXT NOT NULL, trial_key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(family, trial_key))');
  }
  try {
    for (const family of new Set(measurable.map(s => s.family))) {
      const specs = measurable.filter(s => s.family === family);
      const keys = specs.flatMap(s => [`${m.manifest_hash}:${s.content_hash}`, ...probeDefs.filter(d => d.rung.key.startsWith(`${s.id}@${s.version}#`)).map(d => `${m.manifest_hash}:${d.rung.key}`)]);
      if (trialDb) { const insert = trialDb.prepare('INSERT OR IGNORE INTO demo_strategy_trials VALUES (?, ?, ?)'); for (const key of keys) insert.run(family, key, m.registered_at); }
      trialCounts.set(family, deps.record_trials ? deps.record_trials(family, keys) : trialDb ? Number((trialDb.prepare('SELECT count(*) AS n FROM demo_strategy_trials WHERE family = ?').get(family) as { n: number }).n) : keys.length);
    }
  } finally { trialDb?.close(); }
  const candidateSymbolsRaw = deps.universe_candidates ?? (deps.loadSeries ? m.symbols : readdirSync(join(homedir(), '.trading-swarm', 'demo', 'klines')).filter(f => f.endsWith('-1d.json') && !f.startsWith('FAKE')).map(f => f.slice(0, -8)));
  const candidateSymbols = [...new Set(candidateSymbolsRaw)].sort();
  const errors: { symbol: string; error: string }[] = [];
  const preloaded = new Map<string, Awaited<ReturnType<typeof load>>>();
  for (const symbol of candidateSymbols) { try { const data = await load(symbol, m.timeframe, m.from - 30 * 86_400_000, m.to); if (!data.d1.length || !data.base.length) throw new Error('empty series'); preloaded.set(symbol, data); } catch (e) { errors.push({ symbol, error: `load: ${(e as Error).message}` }); } }
  const selectedSymbols = selectUniverse(Object.fromEntries([...preloaded].map(([s, b]) => [s, b.d1])), m.from, deps.top_n ?? m.symbols.length);
  const loadedBySymbol = new Map<string, Map<string, Awaited<ReturnType<typeof load>>>>();
  const dataHashes: Record<string, string> = {};
  for (const symbol of selectedSymbols) {
    try {
    const byTf = new Map<string, Awaited<ReturnType<typeof load>>>([[m.timeframe, preloaded.get(symbol)!]]);
    for (const spec of measurable) {
      const tf = spec.trigger.min_timeframe;
      if (!byTf.has(tf)) byTf.set(tf, await load(symbol, tf, m.from, m.to));
    }
    loadedBySymbol.set(symbol, byTf);
    for (const [tf, series] of byTf) dataHashes[`${symbol}:${tf}`] = createHash('sha256').update(JSON.stringify(series)).digest('hex');
    } catch (e) { errors.push({ symbol, error: `load: ${(e as Error).message}` }); loadedBySymbol.delete(symbol); }
  }
  // 未入选候选也决定 point-in-time 排名，原始内容必须纳入 manifest。
  for (const [symbol, series] of preloaded) dataHashes[`${symbol}:universe`] = createHash('sha256').update(JSON.stringify(series)).digest('hex');
  const universeDetails = candidateSymbols.map(symbol => { const days = preloaded.get(symbol)?.d1 ?? []; const first = days[0]?.open_time ?? null; const last = days.at(-1)?.close_time ?? null; const error = errors.find(e => e.symbol === symbol)?.error; return { symbol, first_cached_at: first, last_cached_at: last, selected: selectedSymbols.includes(symbol), status: error ? 'load_failed' : first === null ? 'missing' : first > m.from - 30 * 86400000 ? 'listing_age_insufficient' : last! < m.from - 86400000 ? 'inactive_at_start' : last! < m.to - 86400000 ? 'delisted_or_missing_tail' : selectedSymbols.includes(symbol) ? 'selected' : 'below_rank', ...(error ? { error } : {}) }; });
  const loadFailureRatio = candidateSymbols.length ? new Set(errors.map(e => e.symbol)).size / candidateSymbols.length : 1;
  const selectedLoadFailureRatio = selectedSymbols.length ? selectedSymbols.filter(symbol => errors.some(e => e.symbol === symbol)).length / selectedSymbols.length : 0;
  const executionBody: ExperimentManifest = { ...m, data_hashes: dataHashes, universe_details: universeDetails, load_failure_ratio: loadFailureRatio, selected_load_failure_ratio: selectedLoadFailureRatio, symbols: selectedSymbols, universe_rule: UNIVERSE_RULE, probe_candidates: probeDefs.map(d => { const [id, version] = d.rung.key.split('#')[0]!.split('@'); return { strategy_id: id!, version: Number(version), param: d.param, value: d.value }; }), trial_count_snapshot: Object.fromEntries(trialCounts), statistics: { bootstrap_iterations: 2000, bootstrap_seed: 0x51a7, block_rule: '4h_cluster_mean_then_ceil_sqrt_n', train_days: 60, test_days: 20, eligibility: 'planned_horizon_end_before_window_end' } };
  const executionManifest = { ...executionBody, manifest_hash: createHash('sha256').update(JSON.stringify({ ...executionBody, dataHashes })).digest('hex').slice(0, 16) };
  const probeRaw: (ProbeCell & { symbol: string })[] = [];
  const cells: ExperimentCell[] = [];
  if (loadFailureRatio > 0.2 || selectedLoadFailureRatio > 0.2) return { manifest_hash: executionManifest.manifest_hash, execution_manifest: executionManifest, data_hashes: dataHashes, unmeasured, cells: [], by_strategy: [], probes: [], errors, note: 'load 失败超过 20%，覆盖率阻断，不生成 lab_stats' };
  let done = 0;
  for (const symbol of selectedSymbols.filter(s => loadedBySymbol.has(s))) {
    try {
      const seriesByTf = loadedBySymbol.get(symbol)!;
      for (const spec of measurable) {
        const tf = spec.trigger.min_timeframe;
        let series = seriesByTf.get(tf);
        if (!series) { series = await load(symbol, tf, m.from, m.to); seriesByTf.set(tf, series); }
        const weeks = closedWeeks(series.d1, m.to);
        const defs = [{ spec, param: '', value: 0 }, ...probeDefs.filter(d => d.rung.key.startsWith(`${spec.id}@${spec.version}#`)).map(d => ({ spec: { ...spec, params: { ...spec.params, [d.param]: { ...spec.params[d.param]!, value: d.value } } }, param: d.param, value: d.value }))];
        for (const def of defs) {
          let state: SignalState = { compression_bars: 0, armed: false, last_at: -1 };
          let last = -Infinity; let setups = 0; const samples: ReplaySample[] = []; const coverage: Record<string, number> = { decisions: 0, funding_observations: 0, oi_observations: 0, funding_estimated: 0 }; const rs: number[] = []; const gross: number[] = [];
          let regimeAt = -1; let regime: ReturnType<typeof dailyRegime> = null;
          for (let i = 0; i < series.base.length; i++) {
            const bar = series.base[i]!; const t = bar.close_time;
            if (t > m.to) break;
            if (t < m.from - 150 * tfToMs(tf)) continue;
            const bars = { '1h': visibleWindow(series.h1, t, 120), '4h': visibleWindow(series.h4, t, 80), '1d': visibleWindow(series.d1, t, 260), '1w': visibleWindow(weeks, t, 80), [tf]: tf === '1d' ? visibleWindow(series.d1, t, 260) : series.base.slice(Math.max(0, i - Math.max(150, spec.checklist.min_bars ?? 0) + 1), i + 1) };
            const dailyBars = visibleWindow(series.d1, t, 260);
            const dayAt = dailyBars.at(-1)?.close_time ?? -1;
            if (dayAt !== regimeAt) { regime = dailyRegime(dailyBars, t); regimeAt = dayAt; }
            const ctx = { bars, params: def.spec.params, derivatives: { funding: series.funding.filter(f => f.at <= t), oi_change_pct: null }, regime: regime?.regime ?? null, timeframe: tf, confirmation: def.spec.checklist.timeframes.filter(f => f !== tf), state };
            if (t >= m.from) { coverage.decisions = (coverage.decisions ?? 0) + 1; if (ctx.derivatives.funding.length) coverage.funding_observations = (coverage.funding_observations ?? 0) + 1; }
            const signal = SIGNAL_REGISTRY[spec.family](ctx);
            if (spec.family === 'volatility') state = nextSignalState(ctx);
            if (!signal || t < m.from || i - last < spec.trigger.cooldown_bars) continue;
            if (signal.at !== t || Object.values(bars).some(bs => bs.some(b => b.close_time > t))) throw new Error('执行器前视泄漏');
            last = i; setups++;
            coverage[signal.coverage] = (coverage[signal.coverage] ?? 0) + 1;
            const sign = signal.direction === 'long' ? 1 : -1;
            const px = Number(signal.reference_price); const distance = Number(signal.stop_distance);
            const horizon = spec.params.horizon_bars?.value ?? m.outcome.horizon_bars;
            if (i + horizon >= series.base.length) continue;
            const future = series.base.slice(i + 1, i + 1 + horizon);
            if (future.length !== horizon || future.some((b, j) => !validKline(b) || b.open_time !== bar.open_time + (j + 1) * tfToMs(tf) || b.close_time !== b.open_time + tfToMs(tf) - 1 || b.close_time >= m.to)) continue;
            const outcomeInput = { atr: signal.atr, funding: series.funding, direction: signal.direction, entry: signal.entry, limit_price: signal.entry === 'limit' ? px : null, stop: px - sign * distance, tp: px + sign * distance * signal.tp_r, bars: series.base.slice(i + 1, i + 1 + (spec.params.horizon_bars?.value ?? m.outcome.horizon_bars)) };
            const outcome = simulateOutcome(outcomeInput);
            if (outcome.funding_estimated) coverage.funding_estimated = (coverage.funding_estimated ?? 0) + 1;
            if (outcome.net_r != null) { rs.push(outcome.net_r); gross.push(outcome.gross_r!); samples.push({ equity_marks: outcomeEquityMarks(outcomeInput, outcome), at: t, exit_at: outcome.exit_at ?? series.base[i + 1 + outcome.exit_bar!]!.close_time, horizon_end_at: t + horizon * tfToMs(tf), gross_r: outcome.gross_r!, net_r: outcome.net_r, symbol, regime: ctx.regime === 'bull' || ctx.regime === 'bear' ? 'trend' : ctx.regime === 'volatile' ? 'high_vol' : ctx.regime ?? 'unknown' }); }
          }
          const key = `${spec.id}@${spec.version}${def.param ? `#${def.param}=${def.value}` : ''}`;
          allSamples.set(key, [...(allSamples.get(key) ?? []), ...samples]);
          const total = rs.reduce((a, b) => a + b, 0);
          const grossTotal = gross.reduce((a, b) => a + b, 0);
          const row = { coverage, gross: { expectancy_r: gross.length ? grossTotal / gross.length : null, total_r: grossTotal }, net: { expectancy_r: rs.length ? total / rs.length : null, total_r: total }, strategy_id: spec.id, version: spec.version, symbol, setups, per_week: setups / Math.max(1e-9, m.days / 7), n: rs.length, win_rate: rs.length ? rs.filter(r => r > 0).length / rs.length : null, expectancy_r: rs.length ? total / rs.length : null, total_r: total };
          if (def.param) probeRaw.push({ ...row, param: def.param, value: def.value, symbols: 1 }); else cells.push(row);
        }
      }
    } catch (e) {
      errors.push({ symbol, error: (e as Error).message.slice(0, 200) });
    }
    done++;
    deps.onProgress?.(symbol, done, m.symbols.length);
    if (deps.pause_ms) await new Promise((r) => setTimeout(r, deps.pause_ms));
  }
  const failedSymbols = new Set(errors.map(e => e.symbol));
  const selectedFailureRatio = selectedSymbols.length ? selectedSymbols.filter(s => failedSymbols.has(s)).length / selectedSymbols.length : 0;
  if (selectedFailureRatio > 0.2 || (candidateSymbols.length && failedSymbols.size / candidateSymbols.length > 0.2)) return { manifest_hash: executionManifest.manifest_hash, execution_manifest: executionManifest, data_hashes: dataHashes, unmeasured, cells: [], by_strategy: [], probes: [], errors, note: '失败超过 20%，覆盖率阻断，不生成 lab_stats' };
  for (let i = cells.length - 1; i >= 0; i--) if (failedSymbols.has(cells[i]!.symbol)) cells.splice(i, 1);
  for (let i = probeRaw.length - 1; i >= 0; i--) if (failedSymbols.has(probeRaw[i]!.symbol)) probeRaw.splice(i, 1);
  for (const [key, samples] of allSamples) allSamples.set(key, samples.filter(s => !failedSymbols.has(s.symbol)));
  const by = new Map<string, ExperimentResult['by_strategy'][number]>();
  for (const c of cells) {
    const k = `${c.strategy_id}@${c.version}`;
    const cur = by.get(k) ?? { strategy_id: c.strategy_id, version: c.version, symbols: 0, setups: 0, n: 0, win_rate: null, expectancy_r: null, total_r: 0 };
    cur.coverage ??= {}; for (const [key, n] of Object.entries(c.coverage ?? {})) cur.coverage[key] = (cur.coverage[key] ?? 0) + n;
    cur.symbols++;
    cur.setups += c.setups;
    cur.n += c.n;
    cur.total_r += c.total_r;
    cur.gross = { expectancy_r: null, total_r: (cur.gross?.total_r ?? 0) + (c.gross?.total_r ?? 0) };
    by.set(k, cur);
  }
  const winsByKey = new Map<string, number>();
  for (const c of cells) {
    const k = `${c.strategy_id}@${c.version}`;
    winsByKey.set(k, (winsByKey.get(k) ?? 0) + (c.win_rate !== null ? Math.round(c.win_rate * c.n) : 0));
  }
  const byStrategy: ExperimentResult['by_strategy'] = [...by.values()].map((s) => ({ ...s, gross: { total_r: s.gross?.total_r ?? 0, expectancy_r: s.n ? (s.gross?.total_r ?? 0) / s.n : null }, net: { total_r: s.total_r, expectancy_r: s.n ? s.total_r / s.n : null }, win_rate: s.n ? (winsByKey.get(`${s.strategy_id}@${s.version}`) ?? 0) / s.n : null, expectancy_r: s.n ? s.total_r / s.n : null })).sort((a, b) => (b.expectancy_r ?? -99) - (a.expectancy_r ?? -99));
  // 探针跨 symbol 汇总(按 n 加权)
  const probeBy = new Map<string, ProbeCell & { wins: number }>();
  for (const c of probeRaw) {
    const k = `${c.strategy_id}@${c.version}#${c.param}=${c.value}`;
    const cur = probeBy.get(k) ?? { strategy_id: c.strategy_id, version: c.version, param: c.param, value: c.value, symbols: 0, setups: 0, n: 0, win_rate: null, expectancy_r: null, total_r: 0, wins: 0 };
    cur.symbols++;
    cur.setups += c.setups;
    cur.n += c.n;
    cur.total_r += c.total_r;
    cur.wins += c.win_rate !== null ? Math.round(c.win_rate * c.n) : 0;
    probeBy.set(k, cur);
  }
  const probes: ProbeCell[] = [...probeBy.values()].map(({ wins, ...p }) => ({ ...p, win_rate: p.n ? wins / p.n : null, expectancy_r: p.n ? p.total_r / p.n : null }));
  for (const row of byStrategy) {
    const spec = measurable.find(s => s.id === row.strategy_id && s.version === row.version)!;
    const tf = spec.trigger.min_timeframe;
    const folds = anchoredWalkForward(m.from, m.to, spec.params.horizon_bars?.value ?? m.outcome.horizon_bars, tfToMs(tf));
    const key = `${spec.id}@${spec.version}`;
    const candidates = [{ key, samples: allSamples.get(key) ?? [] }, ...probes.filter(p => p.strategy_id === spec.id && p.version === spec.version).map(p => ({ key: `${key}#${p.param}=${p.value}`, samples: allSamples.get(`${key}#${p.param}=${p.value}`) ?? [] }))];
    const trialSrs = candidates.map(c => sharpe(c.samples.filter(s => folds[0] && s.horizon_end_at < folds[0].train_to).map(s => s.net_r))).filter((n): n is number => n !== null);
    row.replay = summarizeReplay(allSamples.get(key) ?? [], folds, trialCounts.get(spec.family)!, trialSrs);
    row.n = row.replay.effective_n;
    const selections = selectWalkForward(candidates, folds);
    for (const probe of probes.filter(p => p.strategy_id === spec.id && p.version === spec.version)) {
      const chosen = selections.filter(s => s.key === `${key}#${probe.param}=${probe.value}`);
      probe.selected_folds = chosen.length;
      probe.replay = summarizeReplay(chosen.flatMap(s => s.samples), folds, trialCounts.get(spec.family)!, trialSrs);
      // 兼容旧 autopilot：只暴露训练选中后的测试记账，未经验证不可能满足旧 n 门。
      probe.n = (probe.replay.dsr ?? -Infinity) > 0 && (probe.replay.oos_ci.lower ?? -Infinity) > 0 ? probe.replay.oos_n : 0;
      probe.expectancy_r = probe.replay.oos_expectancy;
      probe.total_r = chosen.flatMap(s => s.samples).reduce((a, s) => a + s.net_r, 0);
      const chosenSamples = chosen.flatMap(s => s.samples);
      probe.win_rate = chosenSamples.length ? chosenSamples.filter(s => s.net_r > 0).length / chosenSamples.length : null;
    }
  }
  return {
    manifest_hash: executionManifest.manifest_hash,
    execution_manifest: executionManifest,
    data_hashes: dataHashes,
    unmeasured,
    cells,
    by_strategy: byStrategy,
    ...(probeDefs.length ? { probes } : {}),
    errors,
    note: '五族独立确定性执行器；各策略使用自己的触发周期。研究记录不等于含模型的线上成绩。',
  };
}

// CLI专用离线研究入口，不纳入常规策略漏斗/议会。
export { runPairStudy, PAIR_STUDY } from './pair-study.js';
