import { afterEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ profile: 'old', calls: [] as string[][] }));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => { throw new Error('real spawn forbidden'); }),
  spawnSync: vi.fn((_bin: string, args: string[]) => {
    fake.calls.push(args);
    if (_bin === 'which') return { status: 0, stdout: '/fake/okx' };
    if (args[0] === '--version') return { status: 0, stdout: 'okx 1.4.7' };
    if (args.join(' ') === 'config show') return { status: 0, stdout: `default_profile: ${fake.profile}\n[old]\n demo: true\n[new]\n demo: true\n` };
    throw new Error('unexpected CLI command');
  }),
}));
import { okxAvailability, resetOkxAvailability } from '../../src/demo/execution-okx.js';
afterEach(() => { vi.unstubAllEnvs(); resetOkxAvailability(); fake.calls = []; fake.profile = 'old'; });

describe('setup 后重新发现默认 profile', () => {
  it('reset 清空旧缓存，下一次从掩码 CLI 输出选新 profile', () => {
    vi.stubEnv('TG_OKX_PROFILE', undefined);
    resetOkxAvailability();
    expect(okxAvailability('fake-okx').profile).toBe('old');
    expect(okxAvailability('fake-okx').profiles).toEqual([{ name: 'old', demo: true, is_default: true }, { name: 'new', demo: true, is_default: false }]);
    fake.profile = 'new';
    expect(okxAvailability('fake-okx').profile).toBe('old');
    resetOkxAvailability();
    expect(okxAvailability('fake-okx').profile).toBe('new');
    expect(fake.calls.filter(c => c[0] === 'config')).toEqual([['config', 'show'], ['config', 'show']]);
  });
  it('显式 TG_OKX_PROFILE 保持优先', () => {
    vi.stubEnv('TG_OKX_PROFILE', 'old'); fake.profile = 'new'; resetOkxAvailability();
    expect(okxAvailability('fake-okx').profile).toBe('old');
  });
  it('缓存过期后先回旧结果、后台异步重探,不再同步 spawn 卡事件循环', () => {
    vi.stubEnv('TG_OKX_PROFILE', undefined); resetOkxAvailability();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(okxAvailability('fake-okx').profile).toBe('old');
      const syncCalls = fake.calls.length;
      vi.setSystemTime(Date.now() + 61_000);
      expect(okxAvailability('fake-okx').profile).toBe('old');
      expect(fake.calls.length).toBe(syncCalls);
    } finally { vi.useRealTimers(); }
  });
});
