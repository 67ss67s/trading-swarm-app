/**
 * Pine 引擎托管器:起 / 崩溃退避重启 / 次数上限标 down / 卡死看门狗 / 退出收摊 / disabled。
 * 用一个假引擎脚本(不跑 PineTS)模拟各种子进程行为,真引擎的沙箱与准入在 engine-sandbox.test.ts。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PineEngineHost, setPineEngineHost, pineEngineHealth, sandboxReadDirs, pineEnginePackageDir } from '../../../../src/demo/research/pine/engine-host.js';
import { pineEngineUrl } from '../../../../src/demo/research/pine/client.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'pine-host-'));
const fake = path.join(dir, 'fake-engine.cjs');
writeFileSync(fake, `
const http = require('http'); const fs = require('fs');
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'crash') { process.stderr.write('boom: fake crash\\n'); process.exit(3); }
if (mode === 'crash_once') {
  if (!fs.existsSync(process.env.FAKE_MARK)) { fs.writeFileSync(process.env.FAKE_MARK, '1'); process.exit(4); }
}
if (mode === 'silent') { setInterval(() => {}, 1000); return; }
const server = http.createServer((req, res) => { res.end(JSON.stringify({ ok: true, pid: process.pid })); });
server.listen(Number(process.env.PINE_ENGINE_PORT || 0), '127.0.0.1', () => {
  const port = server.address().port;
  process.stdout.write(JSON.stringify({ event: 'ready', port, version: 'fake-1', pid: process.pid }) + '\\n');
  if (process.send) {
    process.send({ type: 'ready', port, version: 'fake-1' });
    setInterval(() => process.send({ type: 'heartbeat' }), 100);
    process.on('disconnect', () => process.exit(0));
  }
  if (mode === 'hang') setTimeout(() => { for (;;) {} }, 300);
});
`);

const alive = (pid: number | null): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn: () => boolean, ms = 8000): Promise<void> => {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > ms) throw new Error('until timeout'); await new Promise((r) => setTimeout(r, 25)); }
};
const hosts: PineEngineHost[] = [];
const make = (env: Record<string, string>, extra: Partial<ConstructorParameters<typeof PineEngineHost>[0]> = {}): PineEngineHost => {
  const h = new PineEngineHost({ entry: fake, sandbox: false, env, backoffMs: () => 50, log: () => {}, ...extra });
  hosts.push(h);
  return h;
};
afterEach(async () => { for (const h of hosts.splice(0)) await h.stop(); setPineEngineHost(null); });

describe('Pine 引擎托管器', () => {
  it('拉起后回报临时端口,health 字段齐全,地址可用', async () => {
    const h = make({ FAKE_MODE: 'ok' }).start();
    expect(h.health().status).toBe('starting');
    expect(await h.ready()).toBe(true);
    const health = h.health();
    expect(health).toMatchObject({ status: 'up', restarts: 0, last_error: null, engine: 'pinets', version: 'fake-1' });
    expect(health.port).toBeGreaterThan(0);
    expect(health.port).not.toBe(8793);
    expect(alive(health.pid)).toBe(true);
    const body = await fetch(`${h.url()}/health`).then((r) => r.json()) as { pid: number };
    expect(body.pid).toBe(health.pid);
    // client 从托管器拿地址
    setPineEngineHost(h);
    expect(pineEngineUrl()).toBe(h.url());
  });

  it('TG_PINE_PORT 式显式端口照用', async () => {
    const probe = make({ FAKE_MODE: 'ok' }).start();
    await probe.ready();
    const port = probe.health().port!;
    await probe.stop();
    const h = make({ FAKE_MODE: 'ok' }, { port }).start();
    await h.ready();
    expect(h.health().port).toBe(port);
  });

  it('崩溃后退避重启,restarts 计数,恢复成 up', async () => {
    const mark = path.join(dir, `mark-${Date.now()}`);
    const h = make({ FAKE_MODE: 'crash_once', FAKE_MARK: mark }).start();
    await until(() => h.health().status === 'up');
    expect(existsSync(mark)).toBe(true);
    expect(h.health().restarts).toBe(1);
    expect(h.health().last_error).toMatch(/code=4/);
    // 活着的子进程被外部杀掉也会被拉回来
    const pid = h.health().pid!;
    process.kill(pid, 'SIGKILL');
    await until(() => h.health().status === 'up' && h.health().pid !== pid);
    expect(h.health().restarts).toBe(2);
  });

  it('连续失败超过上限标记 down,带最后的错误;client 报 PROVIDER_ERROR 而不是空序列', async () => {
    const h = make({ FAKE_MODE: 'crash' }, { maxRestarts: 2 }).start();
    await until(() => h.health().status === 'down');
    expect(h.health().restarts).toBe(2);
    expect(h.health().last_error).toMatch(/boom: fake crash/);
    expect(await h.ready()).toBe(false);
    setPineEngineHost(h);
    expect(() => pineEngineUrl()).toThrow(/PROVIDER_ERROR:pine_engine_unavailable.*boom/);
  });

  it('就绪超时(不回报端口)按失败处理', async () => {
    const h = make({ FAKE_MODE: 'silent' }, { readyTimeoutMs: 300, maxRestarts: 0 }).start();
    await until(() => h.health().status === 'down');
    expect(h.health().last_error).toMatch(/ready_timeout/);
  });

  it('心跳断了(脚本卡死事件循环)→ 看门狗 SIGKILL 并重启', async () => {
    const h = make({ FAKE_MODE: 'hang' }, { hangMs: 1200, maxRestarts: 1 }).start();
    await h.ready();
    const first = h.health().pid!;
    await until(() => !alive(first), 6000);
    await until(() => h.health().restarts >= 1, 6000);
    expect(h.health().last_error ?? '').toMatch(/pine_engine_hung|SIGKILL/);
  }, 15000);

  it('stop() 收掉子进程;disabled 不拉起、client 明确说被关了', async () => {
    const h = make({ FAKE_MODE: 'ok' }).start();
    await h.ready();
    const pid = h.health().pid!;
    await h.stop();
    expect(alive(pid)).toBe(false);
    expect(h.health().status).toBe('down');

    const off = make({ FAKE_MODE: 'ok' }, { enabled: false }).start();
    expect(off.health()).toMatchObject({ status: 'disabled', pid: null, port: null });
    setPineEngineHost(off);
    expect(() => pineEngineUrl()).toThrow(/TG_PINE_ENGINE=0/);
    setPineEngineHost(null);
    expect(pineEngineHealth().status).toBe('down'); // 没托管器 = down + not_started,不假装 up
    expect(pineEngineHealth().last_error).toMatch(/not_started/);
  });

  it('网关进程退出(正常 exit 与被 SIGKILL)时子进程一并消失', async () => {
    const hostTs = fileURLToPath(new URL('../../../../src/demo/research/pine/engine-host.ts', import.meta.url));
    for (const how of ['exit', 'sigkill'] as const) {
      const parentScript = path.join(dir, `parent-${how}.mjs`);
      writeFileSync(parentScript, `
import { PineEngineHost } from ${JSON.stringify(hostTs)};
const h = new PineEngineHost({ entry: ${JSON.stringify(fake)}, sandbox: false, env: { FAKE_MODE: 'ok' }, log: () => {} }).start();
await h.ready();
process.stdout.write(JSON.stringify({ child: h.health().pid }) + '\\n');
// 等测试确认子进程活着之后再退(stdin 来一行就 exit),避免负载高时的竞态
${how === 'exit' ? "process.stdin.once('data', () => process.exit(0));" : 'setInterval(() => {}, 1000);'}
`);
      const parent = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', parentScript], { stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise((r) => parent.once('exit', r));
      const childPid = await new Promise<number>((resolve, reject) => {
        let buf = '';
        parent.stdout.on('data', (c) => { buf += c; const line = buf.split('\n')[0]; if (buf.includes('\n')) resolve(JSON.parse(line!).child); });
        parent.on('exit', (code) => { if (!buf) reject(new Error(`parent exited ${code}`)); });
      });
      expect(alive(childPid)).toBe(true);
      if (how === 'sigkill') parent.kill('SIGKILL');
      else parent.stdin.write('bye\n');
      await exited;
      await until(() => !alive(childPid), 5000);
    }
  }, 20000);

  it('沙箱只读目录 = 引擎包 + 依赖树的真实路径(不放行整个仓库根)', () => {
    const pkg = pineEnginePackageDir();
    expect(pkg).toMatch(/packages\/pine-engine$/);
    const dirs = sandboxReadDirs(pkg!);
    expect(dirs[0]).toBe(pkg);
    expect(dirs.some((d) => d.endsWith(`${path.sep}pinets`))).toBe(true);
    const root = path.resolve(pkg!, '..', '..');
    expect(dirs).not.toContain(root);
    expect(dirs).not.toContain(path.join(root, 'node_modules'));
  });
});
