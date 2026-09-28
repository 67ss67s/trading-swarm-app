import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { MarketCli, type CliRunner } from '../../src/demo/asp-agent/cli.js';
import { buildAspMonitor, expediteFailedPushes, monitorPushes, resetMonitorCacheForTest, type MonitorDeps } from '../../src/demo/asp-agent/monitor.js';
import { ensureBroadcastTables } from '../../src/demo/asp-agent/services/broadcast.js';

const NOW = Date.UTC(2026, 8, 26, 12);
const H = 3_600_000;
const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' });

function setup(opts: { approval?: number; ps?: string; tick?: number | null; listed?: Record<string, unknown>[] } = {}) {
  const db = new DatabaseSync(':memory:');
  ensureBroadcastTables(db);
  db.exec(`CREATE TABLE okx_market_provider_task (job_id TEXT PRIMARY KEY, kind TEXT, service_id TEXT, buyer_agent_id TEXT, handler_key TEXT, state TEXT, remote_status INTEGER,
    accept_attempts INTEGER, deliver_attempts INTEGER, error TEXT, deliverable_text TEXT, result_json TEXT, raw_json TEXT, test_flag INTEGER, created_at INTEGER, updated_at INTEGER)`);
  const runner: CliRunner = async (_b, args) => args[1] === 'get-my-agents'
    ? ok({ list: [{ agentList: [{ agentId: '13866', approvalDisplayStatus: opts.approval ?? 4, approvalLabel: opts.approval === 5 ? 'Listing rejected' : 'Listed', onlineStatus: 1, name: 'Trading Swarm' }] }] })
    : args[1] === 'service-list' ? ok(opts.listed ? [{ list: opts.listed }] : []) : ok({});
  const deps: MonitorDeps = {
    db, cli: new MarketCli(runner), now: () => NOW, aspId: async () => '13866',
    poller: () => ({ running: true, lock_held: true, interval_ms: 60_000, last_tick: opts.tick === null ? null : { at: NOW - (opts.tick ?? 30_000), error: null, tasks: 0, locked: false } }),
    services: () => [{ service_id: 'svc-intel', name: 'Market Intel', kind: 'subscription' }, { service_id: 'svc-bt', name: 'Strategy Backtest Quick', kind: 'one_time' }],
    strategyRuns: () => [{ status: 'running', publish_asp: true, strategy_name: 'MTF', timeframe: '15m', next_scan_at: NOW + 60_000 }],
    processes: async () => opts.ps ?? '781 node /Users/x/.local/bin/okx-a2a run\n900 node /Users/x/.trade-gate-okx/micro/recorder.mjs',
    recorderDataMtime: () => NOW - 60_000, recorderLogTail: () => '', listenerMtime: () => NOW - 60_000,
  };
  const push = (id: string, at: number, status: string) => {
    db.prepare('INSERT INTO okx_market_service_push VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'svc-intel', 'market_brief', at, 's', 't', JSON.stringify({ signal: `【Futures】BTC-USDT-SWAP | ${id}` }), '["j1"]', null);
    db.prepare('INSERT INTO okx_market_service_push_job(event_id,job_id,status,attempts,updated_at) VALUES (?,?,?,1,?)').run(id, 'j1', status, at);
  };
  const task = (job: string, state: string, age: number, test = 1) => db.prepare('INSERT INTO okx_market_provider_task VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(job, 'one_time', 'svc-bt', '1791', null, state, 1, 1, 0, null, null, null, JSON.stringify({ jobName: `order ${job}` }), test, NOW - age, NOW - age);
  return { db, deps, push, task };
}

describe('ASP monitor', () => {
  beforeEach(() => resetMonitorCacheForTest());
  it('all green when listed, polling, daemons up and a signal went out recently', async () => {
    const s = setup(); s.push('brief:1', NOW - 2 * H, 'delivered'); s.task('a', 'delivered', H);
    const m = await buildAspMonitor(s.deps);
    expect(m.overall).toBe('ok');
    expect(m.services[0]).toMatchObject({ name: 'Market Intel', status: 'ok', subscribers: 1, last_signal: '【Futures】BTC-USDT-SWAP | brief:1' });
    expect(m.tasks.items[0]).toMatchObject({ job_id: 'a', service: 'Strategy Backtest Quick', title: 'order a', status: 'ok' });
  });
  it('flags a subscription service near the 12 h no-signal rule, even if newer pushes failed', async () => {
    const s = setup(); s.push('brief:1', NOW - 8 * H, 'delivered'); s.push('brief:2', NOW - 4 * H, 'failed');
    expect((await buildAspMonitor(s.deps)).services[0]).toMatchObject({ status: 'warn', failed_recent: 1 });
    const t = setup(); t.push('brief:1', NOW - 12 * H, 'delivered');
    const m = await buildAspMonitor(t.deps);
    expect(m.services[0]!.status).toBe('fail'); expect(m.overall).toBe('fail');
  });
  it('a poller that has not ticked yet is a warning, not a failure', async () => {
    const s = setup({ tick: null }); s.push('brief:1', NOW - H, 'delivered');
    expect((await buildAspMonitor(s.deps)).checks.find((c) => c.key === 'poller')).toMatchObject({ status: 'warn' });
  });
  it('fails on a stale poller, a missing daemon, a rejected listing and a stuck order', async () => {
    const s = setup({ approval: 5, ps: '900 node recorder.mjs', tick: 10 * 60_000 }); s.push('brief:1', NOW - H, 'delivered'); s.task('b', 'accepted', 3 * H);
    const m = await buildAspMonitor(s.deps);
    const by = Object.fromEntries(m.checks.map((c) => [c.key, c.status]));
    expect(by).toMatchObject({ listing: 'fail', poller: 'fail', a2a: 'fail', recorder: 'ok', tasks: 'fail' });
    expect(m.tasks.items[0]).toMatchObject({ job_id: 'b', status: 'fail' });
  });
  it('takes the service list from the live OKX listing (so listing changes show up), with price and one-time order counts', async () => {
    const s = setup({ listed: [
      { serviceId: 'svc-intel', serviceName: 'Market Intel', subscription: [{ fee: '9.9', interval: 'month' }] },
      { serviceId: 'svc-new', serviceName: 'Brand New Feed', subscription: [{ fee: '3', interval: 'month' }] },
      { serviceId: 'svc-bt', serviceName: 'Strategy Backtest Quick', fee: '2', subscription: [] },
    ] });
    s.push('brief:1', NOW - H, 'delivered'); s.task('a', 'delivered', H); s.task('b', 'declined', 2 * H);
    const m = await buildAspMonitor(s.deps);
    expect(m.services_source).toBe('listing');
    expect(m.services.map((x) => [x.name, x.kind, x.price, x.status])).toEqual([
      ['Market Intel', 'subscription', '9.9 USDT/month', 'ok'], ['Brand New Feed', 'subscription', '3 USDT/month', 'warn'], ['Strategy Backtest Quick', 'one_time', '2 USDT', 'warn']]);
    expect(m.services[2]!.orders_7d).toEqual({ delivered: 1, declined: 1 });
  });
  it('speaks English for the judge snapshot and hides local error text', async () => {
    const s = setup(); s.push('brief:1', NOW - H, 'delivered');
    s.db.prepare("INSERT INTO okx_market_provider_task VALUES ('c','one_time','svc-bt','1791',null,'deliver_unknown',1,1,1,'CLI 超时 /Users/x',null,null,'{}',1,?,?)").run(NOW - H, NOW - H);
    const m = await buildAspMonitor({ ...s.deps, lang: 'en' });
    expect(m.checks.map((c) => c.label)).toContain('Order poller');
    expect(JSON.stringify(m)).not.toMatch(/[\u4e00-\u9fff]/);
    expect(m.tasks.items[0]).toMatchObject({ job_id: 'c', error: null, retryable: true });
  });
  it('push detail lists signal line, detail and per-job result; expedite clears the retry cooldown', async () => {
    const s = setup(); s.push('brief:1', NOW - H, 'delivered'); s.push('brief:2', NOW - 30 * 60_000, 'failed');
    const d = monitorPushes(s.db, 'svc-intel', { now: NOW, hours: 24, strategy: false });
    expect(d.items.map((x) => [x.event_id, x.status, x.signal])).toEqual([['brief:2', 'failed', '【Futures】BTC-USDT-SWAP | brief:2'], ['brief:1', 'delivered', '【Futures】BTC-USDT-SWAP | brief:1']]);
    expect(d.items[0]!.detail).toBe('t');
    expect(expediteFailedPushes(s.db, NOW)).toBe(1);
    expect((s.db.prepare("SELECT updated_at FROM okx_market_service_push_job WHERE event_id='brief:2'").get() as { updated_at: number }).updated_at).toBeLessThanOrEqual(NOW - 5 * 60_000);
  });
  it('does not block on a slow listing query: stale cache is served while refreshing', async () => {
    const s = setup(); s.push('brief:1', NOW - H, 'delivered');
    await buildAspMonitor(s.deps); // 填缓存
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const slow: MonitorDeps = { ...s.deps, now: () => NOW + 11 * 60_000, cli: new MarketCli(async (_b, args) => { await gate; return args[1] === 'get-my-agents' ? ok({ list: [{ agentList: [{ agentId: '13866', approvalDisplayStatus: 5, approvalLabel: 'Listing rejected' }] }] }) : ok([]); }) };
    const m = await buildAspMonitor(slow); // 缓存过期但立即返回旧值
    expect(m.checks.find((c) => c.key === 'listing')).toMatchObject({ status: 'ok' });
    release(); await new Promise((r) => setTimeout(r, 10));
    expect((await buildAspMonitor(slow)).checks.find((c) => c.key === 'listing')).toMatchObject({ status: 'fail' });
  });
});
