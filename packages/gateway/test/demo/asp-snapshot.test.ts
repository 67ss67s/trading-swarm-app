// 信号市场只读快照模式(asp-snapshot.ts)与导出脚本的脱敏(scripts/export-asp-snapshot.mjs)。
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aspCliBlocked, serveAspSnapshot, snapshotKey } from '../../src/demo/asp-snapshot.js';
import { spawnCli } from '../../src/demo/asp-agent/cli.js';
import { ownerOnlyRead } from '../../src/demo/public-gate.js';
// @ts-expect-error 纯 JS 脚本,没有类型声明
import { redact } from '../../../../scripts/export-asp-snapshot.mjs';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function snapshotFile(endpoints: Record<string, unknown>, asOf = 1_790_000_000_000): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-asp-snap-'));
  dirs.push(dir);
  const file = path.join(dir, 'asp-snapshot.json');
  writeFileSync(file, JSON.stringify({ version: 1, as_of: asOf, source: 'test', endpoints }));
  vi.stubEnv('TG_PUBLIC_ASP_SNAPSHOT', file);
  return file;
}

function call(method: string, rawUrl: string): { handled: boolean; status: number; body: Record<string, unknown> | null } {
  let status = 0;
  let text = '';
  const res = { writeHead: (code: number) => { status = code; }, end: (t = '') => { text = t; } } as unknown as http.ServerResponse;
  const url = new URL(rawUrl, 'http://127.0.0.1');
  const handled = serveAspSnapshot({ method } as http.IncomingMessage, res, url);
  return { handled, status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

describe('信号市场只读快照', () => {
  it('GET 按路径+排序后的查询返回原形状,根上带 snapshot;加载中/刷新中的状态收成已完成,cache.fetched_at 取快照时间', () => {
    snapshotFile({
      '/api/market/status': { lights: { wallet: { ok: true } }, cache: { fetched_at: null, stale: true, refreshing: true, state: 'loading', error: null } },
      [snapshotKey('/api/market/catalog', new URLSearchParams('sort=hot&page=1&category=ALL&page_size=60'))]: { agents: [{ agent_id: '1' }], building: true, cache: { fetched_at: null } },
      '/api/market/subscriptions': { thisDeviceId: null, subscriptions: [{ job_id: 'j1' }] },
    });
    const status = call('GET', '/api/market/status?fresh=1');
    expect(status).toMatchObject({ handled: true, status: 200, body: { lights: { wallet: { ok: true } }, snapshot: { as_of: 1_790_000_000_000, source: 'test' }, cache: { fetched_at: 1_790_000_000_000, refreshing: false, stale: false, state: 'ready' } } });
    const catalog = call('GET', '/api/market/catalog?category=ALL&page=1&page_size=60&sort=hot');
    expect(catalog.body).toMatchObject({ agents: [{ agent_id: '1' }], building: false, snapshot: { as_of: 1_790_000_000_000 }, cache: { fetched_at: 1_790_000_000_000 } });
    expect(call('GET', '/api/market/subscriptions').body).toMatchObject({ subscriptions: [{ job_id: 'j1' }], snapshot: { as_of: 1_790_000_000_000 } });
    expect(call('GET', '/api/market/catalog/999')).toMatchObject({ status: 404, body: { error: { code: 'snapshot_missing' } } });
    // 行情接口不归快照管
    expect(call('GET', '/api/market/klines?tf=15m').handled).toBe(false);
  });

  it('公网英文模式(TG_PUBLIC_DEMO=1 + TG_PUBLIC_LANG=en)下快照响应也过英文层;不开英文原样', () => {
    const body = {
      subscriptions: [{ job_id: 'j1', display: { label: '试用中 · 剩 2 天 9 小时 · 到期不续费' }, remote: { title: 'tg · 市场情报 自测' }, asp: { name: '磐衡量化' } }],
      asp: { profileDescription: 'Trading Swarm 是一个多 agent 交易团队。策略在研究台用全历史回测验证。' },
    };
    snapshotFile({ '/api/market/subscriptions': body });
    vi.stubEnv('TG_PUBLIC_DEMO', '1');
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    const en = call('GET', '/api/market/subscriptions').body as unknown as typeof body;
    expect(en.subscriptions[0]!.display.label).toBe('On trial · 2d 9h left · no renewal at expiry');
    expect(en.subscriptions[0]!.remote.title).toBe('tg · Market intel (self-test)');
    expect(en.subscriptions[0]!.asp.name).toBe('磐衡量化'); // 第三方 ASP 名是外部内容,不翻
    expect(en.asp.profileDescription).toMatch(/^Trading Swarm is a multi-agent trading team\./);
    vi.stubEnv('TG_PUBLIC_LANG', '');
    expect(call('GET', '/api/market/subscriptions').body).toMatchObject(body);
  });

  it('快照模式下访客可读 OKX.AI 页的接口(已脱敏);模型/执行/钱包登录等仍仅 owner;关快照时 market 读取照旧仅 owner', () => {
    snapshotFile({});
    for (const p of ['/api/market/status', '/api/market/asp', '/api/market/subscriptions', '/api/market/inbox', '/api/asp-services/provider-tasks']) expect(ownerOnlyRead(p), p).toBe(false);
    for (const p of ['/api/models', '/api/execution', '/api/wallet/status', '/api/brains']) expect(ownerOnlyRead(p), p).toBe(true);
    vi.stubEnv('TG_PUBLIC_ASP_SNAPSHOT', '');
    expect(ownerOnlyRead('/api/market/status')).toBe(true);
  });

  it('写接口一律 403 judge_locked(英文);关掉快照时不接管', () => {
    snapshotFile({});
    for (const [m, p] of [['POST', '/api/market/subscribe'], ['POST', '/api/market/asp/register'], ['PATCH', '/api/market/subscriptions/j1'], ['POST', '/api/asp-services/products/x/apply'], ['POST', '/api/wallet/login']] as const) {
      const r = call(m, p);
      expect(r, `${m} ${p}`).toMatchObject({ handled: true, status: 403, body: { error: { code: 'judge_locked', message: expect.stringMatching(/^Locked in the review demo: /) } } });
    }
    vi.stubEnv('TG_PUBLIC_ASP_SNAPSHOT', '');
    expect(call('POST', '/api/market/subscribe').handled).toBe(false);
  });

  it('快照文件更新后按 mtime 热加载,不用重启;坏文件保留上一份', () => {
    const file = snapshotFile({ '/api/market/settings': { enabled: true } }, 1);
    expect(call('GET', '/api/market/settings').body).toMatchObject({ enabled: true, snapshot: { as_of: 1 } });
    writeFileSync(file, JSON.stringify({ version: 1, as_of: 2, source: 'test', endpoints: { '/api/market/settings': { enabled: false } } }));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(call('GET', '/api/market/settings').body).toMatchObject({ enabled: false, snapshot: { as_of: 2 } });
    writeFileSync(file, '{broken');
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect(call('GET', '/api/market/settings').body).toMatchObject({ enabled: false, snapshot: { as_of: 2 } });
  });

  it('快照模式下 onchainos / okx-a2a 子进程一律不启动', async () => {
    snapshotFile({});
    expect(aspCliBlocked('/home/x/.local/bin/onchainos')).toBe(true);
    expect(aspCliBlocked('okx-a2a')).toBe(true);
    expect(aspCliBlocked('okx')).toBe(false);
    const r = await spawnCli('onchainos', ['agent', 'my-subscriptions'], 1000);
    expect(r).toMatchObject({ code: 1, stderr: expect.stringContaining('asp_snapshot_mode') });
  });
});

describe('导出脚本脱敏', () => {
  it('去掉设备 ID、邮箱、本机路径、进程号、CLI 报错与各种凭证字段;钱包地址保留', () => {
    const input = {
      thisDeviceId: 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
      lights: { wallet: { ok: true, detail: 'someone@gmail.com · Account 1' }, a2a: { ok: true, detail: 'running pid=781' } },
      wallet: { email: 'someone@gmail.com', account_id: 'acc-1', address: '0xc133d7b85c6e4f003e24483156225f714c497924' },
      identity: { agentWalletAddress: '0xc133d7b85c6e4f003e24483156225f714c497924', api_key: 'k-123', session_token: 't', refresh_token: 'r' },
      errors: ['Command failed: /Users/demo/.local/bin/onchainos agent asp --data {...}'],
      last_error: 'spawn onchainos ENOENT',
      stderr: 'boom',
      cli_path: '/Users/demo/.local/bin/onchainos',
      note: 'see /Users/demo/Desktop/x.log',
      deliveries: [{ content: 'full delivery text' }],
    };
    const out = redact(input) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(out['thisDeviceId']).toBeNull();
    expect(text).not.toMatch(/feedface|@gmail|pid=781|acc-1|k-123|session_token|refresh_token|Command failed|ENOENT|boom|\/Users\/demo/);
    expect(text).toContain('0xc133d7b85c6e4f003e24483156225f714c497924');
    expect(text).toContain('full delivery text'); // 默认保留正文全文
  });
});
