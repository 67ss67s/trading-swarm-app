import { describe, it, expect, vi } from 'vitest';
import { passiveFill, pairedBootstrap, studyLeg, PARAM_GRID, runStudy } from './entry-param-study.js';
import { SIGNAL_REGISTRY } from './strategy-signals.js';
import { scheduledLabDays, labCacheFetchSpans } from './strategy-lab.js';
import { DAY, anchoredWalkForward } from './replay-stats.js';
import type { StrategySpec } from './strategies.js';
import type { Kline } from './types.js';
const bar = (open: number, low: number, high: number, i = 0): Kline => ({ open: String(open), low: String(low), high: String(high), close: String(open), volume: '10', open_time: i * 900000, close_time: (i + 1) * 900000 - 1 });
describe('P9 conservative paired entry', () => {
    it('repairs a partially covered final candle and is idempotent after completion', () => {
        expect(labCacheFetchSpans([{from:0,to:DAY + DAY/2}],0,2*DAY-1,DAY)).toEqual([{from:DAY,to:2*DAY-1}]);
        expect(labCacheFetchSpans([{from:0,to:2*DAY-1}],0,2*DAY-1,DAY)).toEqual([]);
        expect(labCacheFetchSpans([],0,DAY-1,DAY)).toEqual([{from:0,to:DAY-1}]);
    });
    it('scheduled windows contain complete purged OOS folds', () => {
        expect(scheduledLabDays([{ horizon: 'intraday' }])).toBe(180);
        expect(scheduledLabDays([{ horizon: 'position' }])).toBe(365);
        expect(anchoredWalkForward(0, 180 * DAY, 48, 900000).length).toBeGreaterThanOrEqual(3);
        expect(anchoredWalkForward(0, 365 * DAY, 48, DAY).length).toBeGreaterThanOrEqual(3);
    });
    it('post-only rejects marketable prices, does not chase, requires crossing, expires after two bars', () => {
        expect(passiveFill('long', 100, [bar(100, 90, 110)], 0.1)).toBeNull();
        expect(passiveFill('long', 99, [bar(100, 99, 110)], 0.1)).toBeNull();
        expect(passiveFill('long', 99, [bar(100, 100, 110), bar(101, 98.9, 110, 1)], 0.1)).toBe(1);
        expect(passiveFill('long', 99, [bar(100, 100, 110), bar(100, 100, 110, 1), bar(100, 98, 110, 2)], 0.1)).toBeNull();
        expect(passiveFill('short', 101, [bar(100, 90, 101.1)], 0.1)).toBe(0);
    });
    it('keeps same risk denominator and exits; maker fee 2bp plus exit taker 5bp', () => {
        const s = { at: 0, direction: 'long' as const, entry: 'market' as const, reference_price: '100', trigger_price: '99', atr: 2, stop_distance: '10', tp_r: 2, invalidation: [], coverage: 'ohlcv' as const };
        const bars = [bar(100, 98, 102), bar(105, 104, 106, 1), bar(110, 109, 111, 2)];
        const a = studyLeg(s, bars, [], 0.1, 'taker'), b = studyLeg(s, bars, [], 0.1, 'trigger');
        expect(a.gross_r).toBeCloseTo(1);
        expect(b.gross_r).toBeCloseTo(1.1);
        expect(b.fee_r).toBeCloseTo((99 * 0.0002 + 110 * 0.0005) / 10);
        expect(b.net_r).toBeCloseTo(b.gross_r - b.fee_r - b.slip_r - b.funding_r);
    });
    it('pairs before clustering across symbols, preserves zeros and uses deterministic blocks', () => {
        const rows = Array.from({ length: 40 }, (_, i) => ({ at: i * 14400000, baseline: i % 2, passive: i % 2 + 0.2 }));
        const a = pairedBootstrap(rows);
        expect(a.ci.lower).toBeCloseTo(0.2);
        expect(a.ci.upper).toBeCloseTo(0.2);
        expect(pairedBootstrap([...rows, ...rows])).toEqual(a);
        expect(pairedBootstrap(rows.slice(0, 29)).ci.status).toBe('insufficient');
        expect(pairedBootstrap([{ at: 0, baseline: 1, passive: 0 }]).delta_net_r).toBe(-1);
    });
    it('preregisters exactly twelve distinct candidates', () => expect(new Set(PARAM_GRID.map(x => JSON.stringify(x))).size).toBe(12));
    it('keeps unfilled opportunities at zero and never takes a pre-fill-bar profit', () => {
        const s = { at: 0, direction: 'long' as const, entry: 'market' as const, reference_price: '100', trigger_price: '99', atr: 2, stop_distance: '10', tp_r: 2, invalidation: [], coverage: 'ohlcv' as const };
        const missed = studyLeg(s, [bar(100, 100, 121), bar(100, 100, 121, 1), bar(100, 98, 121, 2)], [], 0.1, 'trigger');
        expect(missed).toMatchObject({ filled: false, net_r: 0, gross_r: 0, fee_r: 0, slip_r: 0, funding_r: 0, marks: [], wait_bars: null });
        // The first bar has a TP touch before this resting entry ever fills; the second
        // has an ambiguous TP touch before/after fill, so neither may cash out at TP.
        const filled = studyLeg(s, [bar(100, 100, 121), bar(100, 98, 121, 1), bar(101, 100, 102, 2)], [], 0.1, 'trigger');
        expect(filled).toMatchObject({ filled: true, wait_bars: 2, exit_at: bar(101, 100, 102, 2).close_time });
        expect(filled.gross_r).toBeCloseTo(0.2);
        // Stop wins if stop and TP are both in the fill candle.
        expect(studyLeg(s, [bar(100, 89, 121)], [], 0.1, 'trigger').gross_r).toBeCloseTo(-0.9);
    });
    it('freezes training selection before revealing only one candidate OOS', async () => {
        const step = 4 * 3600000, end = 90 * DAY, testFrom = 60 * DAY + step;
        const spec = { id: 'synthetic_trend', version: 1, content_hash: 'fixture', family: 'trend_continuation', params: { horizon_bars: { value: 1, min: 1, max: 1, step: 1 } }, trigger: { min_timeframe: '4h', cooldown_bars: 1 }, checklist: { timeframes: ['4h'] } } as unknown as StrategySpec;
        const seen = new Set<string>();
        const spy = vi.spyOn(SIGNAL_REGISTRY, 'trend_continuation').mockImplementation(c => {
            const at = c.bars[c.timeframe]!.at(-1)!.close_time;
            if (at >= testFrom)
                seen.add(JSON.stringify(PARAM_GRID.find(p => p.stop_atr === c.params.stop_atr!.value && p.tp_r === c.params.tp_r!.value && p.chase_atr_max === c.params.chase_atr_max!.value)));
            return { at, direction: 'long', entry: 'market', reference_price: '101', trigger_price: '99', atr: 1, stop_distance: String(c.params.stop_atr!.value), tp_r: c.params.tp_r!.value, invalidation: [], coverage: 'ohlcv' };
        });
        const execute = async (oosClose: number) => {
            seen.clear();
            const bars = Array.from({ length: 150 + end / step }, (_, i) => {
                const at = (i - 150) * step, close = at >= 60 * DAY ? oosClose : 101;
                return { ...bar(100, Math.min(100, close), Math.max(100, close)), open_time: at, close_time: at + step - 1, close: String(close) };
            });
            const keys: string[] = [];
            const result = await runStudy('params', [spec], ['TEST'], 0, end, () => ({ base: bars, h1: [], h4: bars, d1: [], funding: [] }), { TEST: 0.01 }, (_family, ks) => { keys.push(...ks); return keys.length; });
            const row = result.results[0]!;
            if (!('selected' in row) || !row.training)
                throw Error('expected parameter result');
            expect(keys).toHaveLength(12);
            expect(seen.size).toBe(1);
            expect(row.training.every(c => c.stats.replay.effective_n >= 30)).toBe(true);
            return row;
        };
        try {
            const up = await execute(110), down = await execute(90);
            expect(up.selected?.index).toBe(0);
            expect(down.selected?.index).toBe(up.selected?.index);
            expect(down.training).toEqual(up.training);
            expect(up.selected!.oos.net_per_opportunity_r!).toBeGreaterThan(0);
            expect(down.selected!.oos.net_per_opportunity_r!).toBeLessThan(0);
        }
        finally {
            spy.mockRestore();
        }
    });
});
