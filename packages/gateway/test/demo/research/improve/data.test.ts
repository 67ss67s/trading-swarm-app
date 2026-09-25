import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import { freezeData, makeSegments } from '../../../../src/demo/research/improve/data.js';
import { synthBars } from '../backtest-report-fixtures.js';
import { H4, START, SYMS, loaderOf, universeBars } from './fixtures.js';

describe('冻结数据与切段', () => {
  it('边界落在真实 close_time 上:训练 50%(4 折连续)/ 验证 25% / 留出 25%,互不重叠,前 300 根让给预热', () => {
    const bars = synthBars(1300, H4, 3, START), closes = new Set(bars.map((b) => b.close_time));
    const s = makeSegments(bars, START);
    const all = [s.train, s.validation, s.holdout, ...s.folds].flatMap((w) => [w.from_ms, w.to_ms]);
    expect(all.every((t) => closes.has(t))).toBe(true);
    const idx = (t: number) => bars.findIndex((b) => b.close_time === t);
    expect(idx(s.train.from_ms)).toBe(300);// 预热 300 根
    expect(idx(s.train.to_ms) - idx(s.train.from_ms) + 1).toBe(500);// 1000 根可评估 × 50%
    expect(idx(s.validation.from_ms)).toBe(idx(s.train.to_ms) + 1);
    expect(idx(s.validation.to_ms) - idx(s.validation.from_ms) + 1).toBe(250);
    expect(idx(s.holdout.from_ms)).toBe(idx(s.validation.to_ms) + 1);
    expect(s.holdout.to_ms).toBe(bars.at(-1)!.close_time);
    expect(s.folds).toHaveLength(4);
    expect(s.folds[0]!.from_ms).toBe(s.train.from_ms); expect(s.folds[3]!.to_ms).toBe(s.train.to_ms);
    for (let k = 1; k < 4; k++) expect(idx(s.folds[k]!.from_ms)).toBe(idx(s.folds[k - 1]!.to_ms) + 1);
    // 窗口起点前数据够预热时,评估从窗口起点开始
    const later = makeSegments(bars, bars[400]!.close_time);
    expect(later.train.from_ms).toBe(bars[400]!.close_time);
    expect(() => makeSegments(bars.slice(0, 320), START)).toThrow(/too_short/);
  });
  it('冻结:落库拿 dataset_id;带同一组 dataset_ids 重跑不再取数、切段逐字相同;缺失资产剔出并留痕', async () => {
    const db = openStateDb(':memory:'), store = new ResearchStore(db.db), data = universeBars(1500), loader = loaderOf(data);
    const spec = { universe: [...SYMS, 'NOPEUSDT'], timeframe: '4h', from_ms: START + 300 * H4, to_ms: START + 1500 * H4 };
    const a = await freezeData(store, spec, { loader });
    expect(a.data.universe).toEqual(SYMS);
    expect(a.notes.some((n) => n.includes('NOPEUSDT') && n.includes('剔出'))).toBe(true);
    expect(a.notes.some((n) => n.includes('少于设计要求'))).toBe(true);
    expect(Object.keys(a.dataset_ids)).toEqual(SYMS);
    const b = await freezeData(store, { ...spec, universe: SYMS, dataset_ids: a.dataset_ids }, { loader });
    expect(loader.calls.filter((c) => c === 'BTCUSDT')).toHaveLength(1);
    expect(b.data.segments).toEqual(a.data.segments);
    expect(b.data.assets.map((x) => x.bars.length)).toEqual(a.data.assets.map((x) => x.bars.length));
    db.close();
  });
});
