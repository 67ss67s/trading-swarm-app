// pi 连接被掐(Connection error)自动重试;超时类不重试。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piBrain } from '../../src/demo/brain.js';

function fakePi(failures: number, stderr: string): { cmd: string; count: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-pi-'));
  const counter = join(dir, 'n');
  const cmd = join(dir, 'pi');
  writeFileSync(cmd, `#!/bin/sh\ncat >/dev/null\nn=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}\nif [ $n -le ${failures} ]; then echo "${stderr}" >&2; exit 1; fi\necho '{"action":"NO_TRADE"}'\n`);
  chmodSync(cmd, 0o755);
  return { cmd, count: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) };
}

describe('pi brain 连接被掐自动重试', () => {
  it('前两次 Connection error,第三次成功', async () => {
    const f = fakePi(2, 'Connection error.');
    const r = await piBrain({ command: f.cmd }).complete('sys', 'user', { timeoutMs: 30_000 });
    expect(r.text).toContain('NO_TRADE');
    expect(f.count()).toBe(3);
  }, 20_000);
  it('Request timed out 不重试', async () => {
    const f = fakePi(5, 'Request timed out.');
    await expect(piBrain({ command: f.cmd }).complete('sys', 'user', { timeoutMs: 30_000 })).rejects.toThrow(/Request timed out/);
    expect(f.count()).toBe(1);
  });
});
