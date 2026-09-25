import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OkxOnboarding, removeOkxProfile } from '../../src/demo/okx-onboarding.js';
import { bundledOkxBin, defaultOkxCliBin, okxInvocation, type OkxSpawnFn } from '../../src/demo/execution-okx.js';

const status = () => ({ cli: 'fake', profile: 'demo', demo: true, available: true, note: null, version: '1.4.7', profiles: [{ name: 'demo', demo: true, is_default: true }, { name: 'live', demo: false, is_default: false }] });
afterEach(() => vi.unstubAllEnvs());

describe('profile 操作（假 CLI / 临时配置）', () => {
  it('use 校验账户列表，执行 argv 并刷新', async () => {
    vi.stubEnv('TG_OKX_PROFILE', undefined);
    const run = vi.fn<OkxSpawnFn>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const reset = vi.fn();
    const kit = new OkxOnboarding({ run, bin: () => 'fake', status, reset });
    expect(await kit.use({ profile: 'live' })).toEqual(status());
    expect(run).toHaveBeenCalledWith('fake', ['config', 'use', 'live'], 20_000);
    expect(reset).toHaveBeenCalledTimes(2);
    for (const profile of ['missing', '-demo', 'demo;pwd', '../demo', '', null]) {
      // 以连字符开头也不能解释为 CLI 选项。
      await expect(kit.use({ profile })).rejects.toThrow();
    }
    expect(run).toHaveBeenCalledTimes(1);
    vi.stubEnv('TG_OKX_PROFILE', 'demo');
    await expect(kit.use({ profile: 'live' })).rejects.toThrow('TG_OKX_PROFILE');
    await expect(kit.remove({ profile: 'demo' })).rejects.toThrow('TG_OKX_PROFILE');
  });
  it('remove 原子更新默认账户、保留无关表、权限 0600，最后一个账户断开', async () => {
    vi.stubEnv('TG_OKX_PROFILE', undefined);
    const dir = await mkdtemp(join(tmpdir(), 'gateway-okx-profile-'));
    const config = join(dir, 'config.toml');
    const run = vi.fn<OkxSpawnFn>();
    try {
      await writeFile(config, 'default_profile = "demo"\n# comment\n[profiles.demo]\napi_key = "TEST_ONLY"\ndemo = true\n[profiles."live"]\napi_key = "OTHER_TEST_ONLY"\n[settings]\nvalue = 1\n');
      const kit = new OkxOnboarding({ run, status, reset: () => {}, configPath: () => config });
      expect(await kit.remove({ profile: 'demo' })).toEqual(status());
      expect(await readFile(config, 'utf8')).toBe('default_profile = "live"\n# comment\n[profiles."live"]\napi_key = "OTHER_TEST_ONLY"\n[settings]\nvalue = 1\n');
      expect((await stat(config)).mode & 0o777).toBe(0o600);
      await removeOkxProfile(config, 'live');
      expect(await readFile(config, 'utf8')).toBe('# comment\n[settings]\nvalue = 1\n');
      await expect(removeOkxProfile(config, 'missing')).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('删除非默认账户到 EOF，保留默认配置', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-okx-profile-'));
    const config = join(dir, 'config.toml');
    try {
      await writeFile(config, "default_profile = 'live'\n[profiles.live]\ndemo = false\n[profiles.demo]\ndemo = true");
      await removeOkxProfile(config, 'demo');
      expect(await readFile(config, 'utf8')).toBe("default_profile = 'live'\n[profiles.live]\ndemo = false\n");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('JS bin 使用当前 Node，环境覆盖优先', () => {
    expect(okxInvocation('/fake/entry.js', ['--version'])).toEqual([process.execPath, ['/fake/entry.js', '--version']]);
    expect(okxInvocation('okx', ['--version'])).toEqual(['okx', ['--version']]);
    vi.stubEnv('TG_OKX_CLI', '/custom/okx.js');
    expect(defaultOkxCliBin()).toBe('/custom/okx.js');
    vi.stubEnv('TG_OKX_CLI', undefined);
    const bundled = bundledOkxBin('@okx_ai/okx-trade-cli', 'okx');
    if (bundled) expect(defaultOkxCliBin()).toBe(bundled);
  });
});
