import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explainAccountLevelError, okxRestBase, parseOkxToml, readProfileSecrets, setAccountLevel, signOkx, type OkxFetch } from '../../src/demo/okx-account-mode.js';

const TOML = `# OKX Trade Kit Configuration
default_profile = "okx-demo"

[profiles.okx-demo]
api_key = "AK123"
secret_key = "SK456"
passphrase = "pp#with#hash"  # 带 # 的值不能被当注释剥掉
demo = true
site = "global"

[profiles.live]
api_key = "AK9"
secret_key = "SK9"
passphrase = 'pw'
demo = false
site = "eea"
`;

function tmpConfig(): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'okx-cfg-')), 'config.toml');
  fs.writeFileSync(f, TOML);
  return f;
}

describe('okx-account-mode', () => {
  it('parses the okx config without a TOML dependency (quoted # kept, booleans typed)', () => {
    const cfg = parseOkxToml(TOML);
    expect(cfg.default_profile).toBe('okx-demo');
    expect(cfg.profiles['okx-demo']).toMatchObject({ api_key: 'AK123', secret_key: 'SK456', passphrase: 'pp#with#hash', demo: true, site: 'global' });
    expect(cfg.profiles['live']).toMatchObject({ passphrase: 'pw', demo: false, site: 'eea' });
  });

  it('readProfileSecrets picks default_profile and rejects unknown/incomplete profiles', () => {
    const f = tmpConfig();
    expect(readProfileSecrets(null, f)).toMatchObject({ name: 'okx-demo', demo: true, site: 'global' });
    expect(readProfileSecrets('live', f)).toMatchObject({ name: 'live', demo: false, site: 'eea' });
    expect(() => readProfileSecrets('nope', f)).toThrow(/找不到 profile/);
  });

  it('signs like OKX v5 (base64 HMAC-SHA256 of ts+method+path+body) and maps sites', () => {
    const sig = signOkx('SK', '2026-09-21T00:00:00.000Z', 'POST', '/api/v5/account/set-account-level', '{"acctLv":"2"}');
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(sig).toBe(signOkx('SK', '2026-09-21T00:00:00.000Z', 'POST', '/api/v5/account/set-account-level', '{"acctLv":"2"}'));
    expect(okxRestBase('global')).toBe('https://www.okx.com');
    expect(okxRestBase('eea')).toBe('https://eea.okx.com');
  });

  it('setAccountLevel: demo header, signed headers, ok on code 0 and re-reads acctLv', async () => {
    const f = tmpConfig();
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const fetchFn: OkxFetch = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (url.endsWith('/set-account-level')) return { status: 200, text: async () => JSON.stringify({ code: '0', msg: '', data: [{ acctLv: '3' }] }) };
      return { status: 200, text: async () => JSON.stringify({ code: '0', msg: '', data: [{ acctLv: '3', posMode: 'net_mode' }] }) };
    };
    const r = await setAccountLevel(3, null, fetchFn, f);
    expect(r).toEqual({ ok: true, code: '0', msg: '', acct_lv: 3 });
    expect(calls[0]!.url).toBe('https://www.okx.com/api/v5/account/set-account-level');
    expect(calls[0]!.body).toBe('{"acctLv":"3"}');
    expect(calls[0]!.headers['x-simulated-trading']).toBe('1');
    expect(calls[0]!.headers['OK-ACCESS-KEY']).toBe('AK123');
    expect(calls[0]!.headers['OK-ACCESS-PASSPHRASE']).toBe('pp#with#hash');
    expect(calls[0]!.headers['OK-ACCESS-SIGN']).toBe(signOkx('SK456', calls[0]!.headers['OK-ACCESS-TIMESTAMP']!, 'POST', '/api/v5/account/set-account-level', '{"acctLv":"3"}'));
    // live profile:没有模拟盘头,基址按 site
    const r2 = await setAccountLevel(2, 'live', fetchFn, f);
    expect(r2.ok).toBe(true);
    expect(calls[2]!.url.startsWith('https://eea.okx.com/')).toBe(true);
    expect(calls[2]!.headers['x-simulated-trading']).toBeUndefined();
  });

  it('setAccountLevel: OKX business error is surfaced, 51070 explained, non-JSON body tolerated', async () => {
    const f = tmpConfig();
    const fetchFn: OkxFetch = async (url) => {
      if (url.endsWith('/set-account-level')) return { status: 200, text: async () => JSON.stringify({ code: '51070', msg: 'You do not meet the requirements', data: [] }) };
      return { status: 200, text: async () => JSON.stringify({ code: '0', msg: '', data: [{ acctLv: '1' }] }) };
    };
    const r = await setAccountLevel(2, null, fetchFn, f);
    expect(r).toEqual({ ok: false, code: '51070', msg: 'You do not meet the requirements', acct_lv: 1 });
    expect(explainAccountLevelError(r.code, r.msg)).toMatch(/简单模式第一次切出/);
    const html: OkxFetch = async () => ({ status: 403, text: async () => '<html>blocked</html>' });
    const r3 = await setAccountLevel(2, null, html, f);
    expect(r3.ok).toBe(false);
    expect(r3.code).toBe('403');
    expect(r3.msg).toMatch(/非 JSON/);
  });
});
