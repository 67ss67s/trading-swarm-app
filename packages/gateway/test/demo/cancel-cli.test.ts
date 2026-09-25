import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliBackend } from '../../src/demo/execution-cli.js';

describe('CLI cancel readback uses the same entry CID', () => {
  for (const executedQty of ['0', '0.400000000000000001', undefined]) it(`preserves cumulative quantity ${executedQty ?? 'missing'} without assuming zero`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-cancel-cli-'));
    const bin = join(dir, 'fake-cli'), log = join(dir, 'args.jsonl');
    writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n'); console.log(JSON.stringify(args.includes('query-order')?${JSON.stringify({ status: 'CANCELED', executedQty })}:{status:'CANCELED'}));\n`);
    chmodSync(bin, 0o755);
    const b = new CliBackend({ bin, profile: null, env: 'demo', log: () => {} });
    try {
      expect((await b.cancelOrder('BTCUSDT', 'entry-cid')).ok).toBe(true);
      expect(await b.getOrder('BTCUSDT', 'entry-cid')).toMatchObject({ status: 'CANCELED', executed_qty: executedQty ?? '' });
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x));
      expect(calls).toEqual([
        ['futures-usds', 'cancel-order', '--symbol', 'BTCUSDT', '--orig-client-order-id', 'entry-cid'],
        ['futures-usds', 'query-order', '--symbol', 'BTCUSDT', '--orig-client-order-id', 'entry-cid'],
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('unknown order on regular and algo endpoints is not successful cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-cancel-cli-')), bin = join(dir, 'fake-cli');
    writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify({code:-2011,msg:'Unknown order'}));\n`); chmodSync(bin, 0o755);
    try {
      const b = new CliBackend({ bin, profile: null, env: 'demo', log: () => {} });
      expect(await b.cancelOrder('BTCUSDT', 'entry-cid')).toMatchObject({ ok: false, error: expect.stringContaining('unknown') });
      expect(await b.getOrder('BTCUSDT', 'entry-cid')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
