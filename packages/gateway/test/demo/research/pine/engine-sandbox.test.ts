/**
 * 真引擎(@trading-swarm/pine-engine + PineTS)在 Node 权限模型下:
 *   - 正常 Pine 脚本能跑,并在「合成 + 仿真实行情」两套数据上过准入(因果 / 确定性);
 *   - 脚本里写文件、起子进程、发网络请求、拿网关 env、杀父进程,全部被拒,且没有副作用。
 * 需要根目录 npm install 过(pinets 在 node_modules);装不上时整组跳过而不是假绿。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResearchBar } from '@trading-swarm/contracts';
import { PineEngineHost, setPineEngineHost, pineEnginePackageDir, sandboxReadDirs } from '../../../../src/demo/research/pine/engine-host.js';
import { runPine, clearPineCache } from '../../../../src/demo/research/pine/client.js';
import { admitScript, syntheticSuite, type AdmissionSuite } from '../../../../src/demo/research/pine/admission.js';

const pkg = pineEnginePackageDir();
const ready = !!pkg && sandboxReadDirs(pkg).some((d) => existsSync(path.join(d, 'dist')) && d.endsWith('pinets'));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'pine-sandbox-'));

/** 仿真实行情:确定性伪随机游走(日线),与合成数据的正弦节奏完全不同。 */
function walkBars(count: number): ResearchBar[] {
  let seed = 42, price = 30000;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const day = 86400000, t0 = Date.UTC(2022, 0, 1);
  return Array.from({ length: count }, (_, i) => {
    const open = price;
    price = Math.max(1000, price * (1 + (rnd() - 0.5) * 0.06));
    const high = Math.max(open, price) * (1 + rnd() * 0.01), low = Math.min(open, price) * (1 - rnd() * 0.01);
    return { open_time: t0 + i * day, close_time: t0 + (i + 1) * day - 1, available_at: t0 + (i + 1) * day - 1, open: open.toFixed(2), high: high.toFixed(2), low: low.toFixed(2), close: price.toFixed(2), volume: (1000 + rnd() * 500).toFixed(2) };
  });
}

let host: PineEngineHost;
describe.skipIf(!ready)('Pine 引擎沙箱(真 PineTS,权限模型)', () => {
  beforeAll(async () => {
    process.env['TG_FAKE_GATEWAY_SECRET'] = 'should-not-leak';
    host = new PineEngineHost({ log: () => {} }).start();
    setPineEngineHost(host);
    expect(await host.ready(20000)).toBe(true);
  }, 30000);
  afterAll(async () => { delete process.env['TG_FAKE_GATEWAY_SECRET']; setPineEngineHost(null); await host?.stop(); clearPineCache(); });

  const bars = syntheticSuite(120).bars;
  const run = (script: string) => runPine({ script, bars, timeframe: '1h' }, { noCache: true, timeoutMs: 20000 });

  it('正常脚本在权限模式下能跑', async () => {
    const out = await run('//@version=5\nindicator("t")\nplot(ta.rsi(close, 14), "rsi")\n');
    expect(out.series.rsi).toHaveLength(bars.length);
    expect(out.series.rsi!.filter((v) => v !== null).length).toBeGreaterThan(90);
  });

  it('写文件 / 起子进程 / 取 fs 模块 被拒,且文件没有被创建', async () => {
    const target = path.join(scratch, 'pwned.txt');
    const attempts = [
      `process.mainModule.require('fs').writeFileSync(${JSON.stringify(target)}, 'x'); plot(close, 'c')`,
      `//@version=5\nindicator('x')\nx = process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(target)}, 'x')\nplot(close, 'c')`,
      `process.getBuiltinModule('child_process').execSync('touch ${target}'); plot(close, 'c')`,
      `(async () => { const cp = await import('node:child_process'); cp.execSync('touch ${target}'); })(); plot(close, 'c')`,
    ];
    for (const source of attempts) {
      await expect(run(source)).rejects.toThrow(/pine_script_failed/);
    }
    expect(existsSync(target)).toBe(false);
    // 引擎本身没被打挂
    expect(host.health().status).toBe('up');
  });

  it('网络、父进程、网关 env 都够不着', async () => {
    await expect(run(`fetch('http://127.0.0.1:1/'); plot(close, 'c')`)).rejects.toThrow(/pine_script_failed/);
    await expect(run(`process.kill(process.ppid, 'SIGTERM'); plot(close, 'c')`)).rejects.toThrow(/pine_sandbox_denied/);
    // env 只有托管器显式给的引擎变量:网关自己的 env(这里是 HOME 与测试塞的 TG_FAKE_GATEWAY_SECRET)进不去
    const probe = await run(`plot((process.env.HOME === undefined ? 1 : 0) + (process.env.TG_FAKE_GATEWAY_SECRET === undefined ? 10 : 0) + (process.env.PINE_ENGINE_PORT !== undefined ? 100 : 0), 'n')`);
    expect(probe.series.n![0]).toBe(111);
  });

  it('真引擎上两套数据(合成 + 仿真实日线)都过因果与确定性', async () => {
    const market: AdmissionSuite = { id: 'market', label: '仿真实 日线', bars: walkBars(400), timeframe: '1d', dataset_id: 'fake', symbol: 'BTCUSDT' };
    const report = await admitScript(
      '//@version=5\nindicator("macd")\nfast = input.int(12, "fast")\n[m, s, h] = ta.macd(close, fast, 26, 9)\nplot(m, "macd")\nplot(s, "signal")\n',
      (i) => runPine(i, { noCache: true, timeoutMs: 30000 }),
      { suites: [syntheticSuite(200), market], samples: 3 },
    );
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    expect(report.real_data).toBe(true);
    expect(report.suites!.map((x) => [x.id, x.ok])).toEqual([['synthetic', true], ['market', true]]);
    expect(report.suites![1]!.checks.map((c) => c.name)).toEqual(['outputs', 'warmup', 'determinism', 'causality']);
    expect(report.outputs).toEqual(['macd', 'signal']);
  }, 60000);
});
