// 盘口 / 清算录制源接线:只取 as_of 前已落盘的帧;缺目录不抛错;张数按冻结面值换算成基础币。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { recorderMicrostructure } from '../../src/demo/micro-source.js';

const T = Date.UTC(2026, 8, 25, 8, 0, 0);
const day = '2026-09-25';
afterEach(() => { delete process.env.TG_MICRO_DIR; });

describe('recorderMicrostructure', () => {
  it('取 as_of 前已落盘的最新盘口与 5 分钟清算,未来帧不可见', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'micro-'));
    const book = (at: number, px: string) => JSON.stringify({ at, available_at: at + 800, ts: at + 100, bids: [[px, '10']], asks: [['60010', '5']] });
    writeFileSync(join(dir, `book-BTC-USDT-SWAP-${day}.1.jsonl.gz`), gzipSync([book(T - 90_000, '59990'), book(T - 30_000, '60000'), book(T + 30_000, '61000')].join('\n') + '\n'));
    writeFileSync(join(dir, `liq-BTC-USDT-SWAP-${day}.1.jsonl.gz`), gzipSync(JSON.stringify({ at: T - 60_000, available_at: T - 59_000, ts: T - 61_000, side: 'sell', posSide: 'long', px: '59900', sz: '3' }) + '\n'));
    process.env.TG_MICRO_DIR = dir;
    const snap = await recorderMicrostructure(dir)('BTCUSDT', T);
    expect(snap?.book?.bids[0]).toEqual(['60000', '0.1']);
    expect(snap?.liquidations).toHaveLength(1);
    expect(snap?.liquidations[0]).toMatchObject({ position_side: 'long', quantity: '0.03' });
  });

  it('没录的资产返回 null;目录不存在不抛错', async () => {
    process.env.TG_MICRO_DIR = '/nonexistent-micro';
    expect(await recorderMicrostructure('/nonexistent-micro')('SOLUSDT', T)).toBeNull();
    expect(await recorderMicrostructure('/nonexistent-micro')('BTCUSDT', T)).toBeNull();
  });
});
