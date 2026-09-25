/** P9 预注册离线研究；不写策略、资格或 active。 */
import { createHash } from 'node:crypto';
import { SIGNAL_REGISTRY, closedWeeks, nextSignalState, type SignalContext, type Setup } from './strategy-signals.js';
import { visibleWindow } from './backtest.js';
import { dailyRegime, tfToMs } from './market.js';
import { conservativeLimitFill, simulateOutcome, outcomeEquityMarks, openTrade, tradeCosts } from './outcome.js';
import { DAY, anchoredWalkForward, bootstrapCI, effectiveReturns, equityDrawdown, summarizeReplay, validKline, sharpe, type ReplaySample } from './replay-stats.js';
import { PROMOTION_POLICY, type StrategySpec } from './strategies.js';
import type { SeriesBundle } from './funnel.js';
import type { Kline } from './types.js';
export const PARAM_GRID = [1.2, 1.8, 2.4].flatMap(stop_atr => [1.5, 2.5].flatMap(tp_r => [0.25, 0.75].map(chase_atr_max => ({ stop_atr, tp_r, chase_atr_max }))));
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export function pairedBootstrap(rows: {
    at: number;
    baseline: number;
    passive: number;
}[]) {
    const deltas = effectiveReturns(rows.map(r => ({ at: r.at, net_r: r.passive - r.baseline })));
    return { delta_net_r: mean(deltas), effective_n: deltas.length, ci: bootstrapCI(deltas) };
}
/** 首根 open 作为报价代理：可立即成交则 post-only 拒绝，拒绝后不重挂；两根内必须穿过一 tick。 */
export function passiveFill(direction: 'long' | 'short', limit: number, bars: Kline[], tick: number) {
    if (!bars.length || !(tick > 0))
        return null;
    if (direction === 'long' ? limit >= Number(bars[0]!.open) : limit <= Number(bars[0]!.open))
        return null;
    for (let i = 0; i < Math.min(2, bars.length); i++)
        if (conservativeLimitFill(direction, limit, bars[i]!, tick) !== null)
            return i;
    return null;
}
export function studyLeg(signal: Setup, bars: Kline[], funding: SeriesBundle['funding'], tick: number, mode: 'taker' | 'trigger' | 'passive_01') {
    const sign = signal.direction === 'long' ? 1 : -1, base = Number(bars[0]!.open), risk = Number(signal.stop_distance);
    const stop = base - sign * risk, tp = base + sign * risk * signal.tp_r;
    const raw = Number(signal.trigger_price) - sign * (mode === 'passive_01' ? 0.1 * signal.atr : 0);
    const limit = (sign === 1 ? Math.floor(raw / tick) : Math.ceil(raw / tick)) * tick;
    const fill = mode === 'taker' ? 0 : passiveFill(signal.direction, limit, bars, tick);
    if (fill === null)
        return { filled: false, net_r: 0, gross_r: 0, fee_r: 0, slip_r: 0, funding_r: 0, funding_known: 0, funding_expected: 0, wait_bars: null, wait_ms: null, adverse_1_r: null, adverse_3_r: null, marks: [], exit_at: bars.at(-1)!.close_time, net_bps: 0 };
    const price = mode === 'taker' ? base : limit;
    // 固定基线止损/止盈/期限与风险分母；拒绝穿越止损的入场。
    if (sign * (price - stop) <= 0)
        return { filled: false, net_r: 0, gross_r: 0, fee_r: 0, slip_r: 0, funding_r: 0, funding_known: 0, funding_expected: 0, wait_bars: null, wait_ms: null, adverse_1_r: null, adverse_3_r: null, marks: [], exit_at: bars.at(-1)!.close_time, net_bps: 0 };
    const inp = { direction: signal.direction, entry: mode === 'taker' ? 'market' as const : 'limit' as const, limit_price: mode === 'taker' ? null : price, stop, tp, bars: bars.slice(fill), atr: signal.atr, funding, costs: { tick } };
    const out = simulateOutcome(inp);
    const scale = out.stop_distance! / risk;
    const costs = tradeCosts(openTrade(signal.direction, price, stop, tp)!, out.exit_price!, inp.entry, bars[fill]!.open_time, out.exit_at!, signal.atr, funding, { tick });
    const adverse = (n: number) => bars.length >= fill + n ? Math.max(0, ...bars.slice(fill, fill + n).map(b => sign * (price - Number(sign === 1 ? b.low : b.high)) / risk)) : null;
    return { filled: true, net_r: out.net_r! * scale, gross_r: out.gross_r! * scale, fee_r: costs.fee_r * scale, slip_r: costs.slip_r * scale, funding_r: costs.funding_r * scale, funding_known: costs.funding_known, funding_expected: costs.funding_expected, wait_bars: fill + 1, wait_ms: (fill + 1) * (bars[0]!.close_time - bars[0]!.open_time + 1), adverse_1_r: adverse(1), adverse_3_r: adverse(3), marks: outcomeEquityMarks(inp, out).map(m => ({ ...m, r: m.r * scale })), exit_at: out.exit_at!, net_bps: out.net_r! * scale * risk / base * 10000 };
}
type Row = ReplaySample & ReturnType<typeof studyLeg>;
function summary(rows: Row[], folds: Parameters<typeof summarizeReplay>[1], trials: number, trainSrs: number[] = []) {
    const filled = rows.filter(r => r.filled), expected = filled.reduce((s, r) => s + r.funding_expected, 0);
    const replay = summarizeReplay(rows, folds, trials, trainSrs), policy = PROMOTION_POLICY.defaults;
    const absolute_gate = { passed: effectiveReturns(filled.filter(r => folds.some(f => r.at >= f.test_from && r.horizon_end_at < f.test_to))).length >= policy.oos_min_n && (replay.oos_ci.lower ?? -Infinity) > policy.oos_ci_lower && (replay.dsr ?? -Infinity) > policy.dsr_min && Object.entries(replay.regime).filter(([key, b]) => b.n > 0 && (b.net_expectancy ?? -Infinity) >= 0 && filled.some(r => r.regime === key && folds.some(f => r.at >= f.test_from && r.horizon_end_at < f.test_to))).length >= policy.nonnegative_regimes && replay.max_dd_r <= policy.max_dd_r, policy };
    const changes = new Map<number, number>();
    for (const r of rows) {
        let prev = 0;
        for (const mark of [...r.marks, { at: r.exit_at, r: r.net_r }]) {
            changes.set(mark.at, (changes.get(mark.at) ?? 0) + mark.r - prev);
            prev = mark.r;
        }
    }
    let equity = 0;
    const daily = new Map<number, number>();
    for (const [at, delta] of [...changes].sort((a, b) => a[0] - b[0])) {
        equity += delta;
        daily.set(Math.floor(at / DAY) * DAY, equity);
    }
    return { cluster_net_r: mean(effectiveReturns(rows)), funding_expected: expected, funding_known: filled.reduce((s, r) => s + r.funding_known, 0), gross_per_fill_r: mean(filled.map(r => r.gross_r)), fee_per_fill_r: mean(filled.map(r => r.fee_r)), slip_per_fill_r: mean(filled.map(r => r.slip_r)), funding_per_fill_r: mean(filled.map(r => r.funding_r)), wait_ms: mean(filled.map(r => r.wait_ms!)), descriptive_regime: Object.fromEntries(['trend', 'range', 'high_vol', 'unknown'].map(k => { const xs = rows.filter(r => r.regime === k); return [k, { opportunities: xs.length, effective_n: effectiveReturns(xs).length, net_r: mean(effectiveReturns(xs)) }]; })), concurrent_max_dd_r: equityDrawdown(rows), fixed_risk_daily_curve: [...daily].map(([at, r]) => ({ at, r })), opportunities: rows.length, fills: filled.length, fill_rate: rows.length ? filled.length / rows.length : null, net_per_opportunity_r: mean(rows.map(r => r.net_r)), net_per_fill_r: mean(filled.map(r => r.net_r)), gross_r: mean(rows.map(r => r.gross_r)), fee_r: mean(rows.map(r => r.fee_r)), slip_r: mean(rows.map(r => r.slip_r)), funding_r: mean(rows.map(r => r.funding_r)), wait_bars: mean(filled.map(r => r.wait_bars!)), adverse_1_r: mean(filled.flatMap(r => r.adverse_1_r === null ? [] : [r.adverse_1_r])), adverse_3_r: mean(filled.flatMap(r => r.adverse_3_r === null ? [] : [r.adverse_3_r])), funding_coverage: expected ? filled.reduce((s, r) => s + r.funding_known, 0) / expected : null, fee_initial_risk_ratio: mean(filled.map(r => r.fee_r)), net_bps: mean(rows.map(r => r.net_bps)), fixed_risk_total_r: rows.reduce((s, r) => s + r.net_r, 0), replay, absolute_gate };
}
export async function runStudy(kind: 'entry' | 'params', specs: StrategySpec[], symbols: string[], from: number, to: number, load: (symbol: string, tf: string) => SeriesBundle, ticks: Record<string, number>, record: (family: string, keys: string[]) => number) {
    const selected = specs.filter(s => kind === 'entry' ? ['breakout_retest', 'vol_compression_expansion', 'mtf_alignment'].includes(s.id) : s.family === 'trend_continuation');
    const manifest = { code: 'entry-param-v1', kind, from, to, symbols, strategies: selected, grid: kind === 'params' ? PARAM_GRID : null, train_days: 60, purge: 'full_horizon', oos: kind === 'entry' ? 'anchored_60d_train_20d_test_purged' : 'single_frozen_selection_full_remaining_window', entry_modes: ['taker', 'trigger', 'passive_01'], ticks: Object.fromEntries(Object.entries(ticks).map(([symbol, tick]) => [symbol, String(tick)])), universe: 'current_workflow_fixed;survivorship_bias', funding_interval_ms: 28800000 };
    const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const results = [];
    const hashes: Record<string, string> = {};
    const coverage: Record<string, unknown> = {};
    const trialCounts = new Map<string, number>();
    for (const family of new Set(selected.map(s => s.family))) {
        const keys = selected.filter(s => s.family === family).flatMap(s => (kind === 'entry' ? ['taker', 'trigger', 'passive_01'] : PARAM_GRID).map((p, i) => `${hash}:${s.content_hash}:${i}:${JSON.stringify(p)}`));
        trialCounts.set(family, record(family, keys));
    }
    for (const spec of selected) {
        const tf = spec.trigger.min_timeframe, ms = tfToMs(tf), horizon = spec.params.horizon_bars?.value ?? 48;
        const fold = { train_from: from, train_to: from + 60 * DAY, test_from: from + 60 * DAY + horizon * ms, test_to: to };
        const folds = kind === 'entry' ? anchoredWalkForward(from,to,horizon,ms) : [fold];
        const variants = kind === 'params' ? PARAM_GRID : [null];
        const trials = trialCounts.get(spec.family)!;
        const candidates: {
            params: typeof PARAM_GRID[number] | null;
            rows: Row[][];
        }[] = [];
        const collect = (params: typeof PARAM_GRID[number] | null, start: number, end: number): Row[][] => {
            const rows: Row[][] = [[], [], []];
            const patched = structuredClone(spec.params);
            if (params)
                for (const [key, value] of Object.entries(params))
                    patched[key] = { ...(patched[key] ?? { min: 0, max: 10, step: 0.1 }), value };
            for (const symbol of symbols) {
                if (!(ticks[symbol]! > 0))
                    throw Error(`missing tick: ${symbol}`);
                const s = load(symbol, tf);
                const window = s.base.filter(b => b.open_time >= from && b.close_time < to);
                coverage[`${symbol}:${tf}`] = { bars: window.length, expected_bars: (to - from) / ms, first_at: window[0]?.open_time ?? null, last_at: window.at(-1)?.close_time ?? null };
                const m15 = tf !== '15m' && spec.checklist.timeframes.includes('15m') ? load(symbol, '15m').base : [];
                const weeks = closedWeeks(s.d1, to);
                if (m15.length)
                    hashes[`${symbol}:15m-confirm`] = createHash('sha256').update(JSON.stringify(m15)).digest('hex');
                hashes[`${symbol}:${tf}`] = createHash('sha256').update(JSON.stringify(s)).digest('hex');
                let state = { compression_bars: 0, armed: false, last_at: -1 }, last = -Infinity;
                let regimeAt = -1;
                let regime: ReturnType<typeof dailyRegime> = null;
                for (let i = 150; i < s.base.length - horizon; i++) {
                    const b = s.base[i]!, t = b.close_time;
                    if (t < from - 150 * ms || t >= end)
                        continue;
                    const daily = visibleWindow(s.d1, t, 260);
                    if (daily.at(-1)?.close_time !== regimeAt) {
                        regimeAt = daily.at(-1)?.close_time ?? -1;
                        regime = dailyRegime(daily, t);
                    }
                    const ctx: SignalContext = { bars: { '15m': visibleWindow(m15, t, 150), '1w': visibleWindow(weeks, t, 80), '1h': visibleWindow(s.h1, t, 120), '4h': visibleWindow(s.h4, t, 80), '1d': daily, [tf]: tf === '1d' ? daily : s.base.slice(i - 149, i + 1) }, params: patched, derivatives: null, regime: regime?.regime ?? null, timeframe: tf, confirmation: spec.checklist.timeframes.filter(x => x !== tf), state };
                    const signal = SIGNAL_REGISTRY[spec.family](ctx);
                    if (spec.family === 'volatility')
                        state = nextSignalState(ctx);
                    if (!signal || t < from || i - last < spec.trigger.cooldown_bars)
                        continue;
                    last = i;
                    if (t < start || t + horizon * ms >= end)
                        continue;
                    const future = s.base.slice(i + 1, i + 1 + horizon);
                    if (future.some((x, j) => !validKline(x) || x.open_time !== b.open_time + (j + 1) * ms || x.close_time !== x.open_time + ms - 1 || x.close_time >= to))
                        continue;
                    const modes = kind === 'entry' ? ['taker', 'trigger', 'passive_01'] as const : ['taker'] as const;
                    for (const [j, mode] of modes.entries()) {
                        const leg = studyLeg(signal, future, s.funding, ticks[symbol]!, mode);
                        rows[j]!.push({ ...leg, at: t, horizon_end_at: t + horizon * ms, symbol, regime: ctx.regime === 'bull' || ctx.regime === 'bear' ? 'trend' : ctx.regime === 'volatile' ? 'high_vol' : ctx.regime ?? 'unknown', equity_marks: leg.marks });
                    }
                }
            }
            return rows;
        };
        for (const params of variants)
            candidates.push({ params, rows: collect(params, from, kind === 'params' ? fold.train_to : to) });
        const train = (rs: Row[]) => rs.filter(r => r.at >= from && r.horizon_end_at < fold.train_to);
        const oos = (rs: Row[]) => rs.filter(r => folds.some(f=>r.at>=f.test_from&&r.horizon_end_at<f.test_to));
        if (kind === 'entry') {
            const rs = candidates[0]!.rows;
            results.push({ id: spec.id, version: spec.version, family: spec.family, trial_count: trials, arms: rs.map((r, i) => ({ mode: ['taker', 'trigger', 'passive_01'][i], all: summary(r, folds, trials), oos: summary(oos(r), folds, trials), paired: i ? pairedBootstrap(r.map((x, j) => ({ at: x.at, baseline: rs[0]![j]!.net_r, passive: x.net_r }))) : null, oos_paired: i ? pairedBootstrap(r.flatMap((x, j) => folds.some(f=>x.at>=f.test_from&&x.horizon_end_at<f.test_to) ? [{ at: x.at, baseline: rs[0]![j]!.net_r, passive: x.net_r }] : [])) : null, missed_positive_baseline_r: i ? mean(r.map((x, j) => x.filled ? 0 : Math.max(0, rs[0]![j]!.net_r))) : 0, missed_large_move_r: i ? mean(r.map((x, j) => !x.filled && rs[0]![j]!.gross_r >= 1 ? rs[0]![j]!.net_r : 0)) : 0 })) });
        }
        else {
            const ranked = candidates.map((c, index) => ({ index, score: mean(effectiveReturns(train(c.rows[0]!))), n: effectiveReturns(train(c.rows[0]!)).length })).filter(c => c.n >= 30).sort((a, b) => b.score! - a.score! || a.index - b.index);
            const best = ranked[0];
            // 排名已经冻结；只对这一个候选运行剩余 OOS 一次。
            const selectedOos = best ? collect(candidates[best.index]!.params, fold.test_from, to)[0]! : [];
            const srs = candidates.flatMap(c => { const sr = sharpe(effectiveReturns(train(c.rows[0]!))); return sr === null ? [] : [sr]; });
            results.push({ id: spec.id, version: spec.version, family: spec.family, trial_count: trials, training: candidates.map((c, index) => ({ index, params: c.params, stats: summary(train(c.rows[0]!), [], trials) })), selected: best ? { index: best.index, params: candidates[best.index]!.params, oos: summary(selectedOos, [fold], trials, srs) } : null, neighbor_indices: best ? candidates.flatMap((c, i) => Object.keys(c.params!).reduce((n, k) => { const domain = k === 'stop_atr' ? [1.2, 1.8, 2.4] : k === 'tp_r' ? [1.5, 2.5] : [0.25, 0.75]; return n + Math.abs(domain.indexOf(c.params![k as keyof typeof c.params]) - domain.indexOf(candidates[best.index]!.params![k as keyof typeof c.params])); }, 0) === 1 ? [i] : []) : [] });
        }
    }
    return { manifest, manifest_hash: hash, trial_count_snapshot: Object.fromEntries(trialCounts), data_hashes: hashes, coverage, results };
}
