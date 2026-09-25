import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import { ImproveManager } from '../../../../src/demo/research/improve/manager.js';
import type { ImproveEvent } from '../../../../src/demo/research/improve/runner.js';
import { specOf, universeBars, SYMS, H4 } from './fixtures.js';

const dir = mkdtempSync(path.join(tmpdir(), 'improve-worker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
/** 文件库 + 预先落库的合成数据集(worker 按 dataset_ids 还原,不联网) */
function setup(n: number) {
  const state = openStateDb(path.join(dir, `s${n}-${Date.now()}.sqlite`)), store = new ResearchStore(state.db), data = universeBars(n), ids: Record<string, string> = {};
  for (const s of SYMS) ids[s] = store.putMarketDataset({ venue: 'okx', market: 'spot', symbol: s, timeframe_ms: H4, source: 'synthetic', retrieved_at: data[s]!.at(-1)!.close_time + 1, bars: data[s]! }, true).id;
  return { state, ids };
}

describe('改进环 worker_threads', () => {
  it('在 worker 里跑完:主线程只收消息,事件循环最大延迟 < 1 秒;结果与进程内同一套表', async () => {
    const { state, ids } = setup(2100), events: ImproveEvent[] = [];
    const m = new ImproveManager(state.db, (e) => events.push(e));
    expect(m.dbPath()).toContain(dir);
    let maxLag = 0, last = performance.now();
    const timer = setInterval(() => { const t = performance.now(); maxLag = Math.max(maxLag, t - last - 50); last = t; }, 50);
    const job = m.start(specOf({ dataset_ids: ids }));
    const out = await m.wait(job.id);
    clearInterval(timer);
    expect(out.status, out.error ?? '').toBe('completed');
    expect(out.result!.champion_id).toBeTruthy();
    expect(m.jobs.candidates(job.id).length).toBeGreaterThan(3);
    expect(events.some((e) => e.phase === 'evaluate')).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: 'done', status: 'completed' });
    expect(maxLag).toBeLessThan(1000);
    state.close();
  }, 180000);
  it('取消走 postMessage:worker 收到后在下一个检查点停下,任务 cancelled、不占用留出段', async () => {
    const { state, ids } = setup(2100);
    let m!: ImproveManager, id = '';
    m = new ImproveManager(state.db, (e) => { if (e.phase === 'baseline' && id) m.cancel(id); });
    id = m.start(specOf({ dataset_ids: ids })).id;
    const out = await m.wait(id);
    expect(out.status).toBe('cancelled');
    expect(out.holdout_used_at).toBeNull();
    expect(m.busy()).toBeNull();
    state.close();
  }, 120000);
});
