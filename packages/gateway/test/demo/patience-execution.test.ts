import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMcpBackend, type AgentSpawn } from '../../src/demo/execution-agent.js';
import { collapseObservations, errorKind } from '../../src/demo/alert-summary.js';

const response = (obj: unknown) => ({ stdout: JSON.stringify(obj), stderr: '', code: 0, timedOut: false, spawnError: null });
const account = { ok: true, account: { equity: '100', available: '100', unrealized_pnl: '0', positions: [], open_orders: [] } };
function backend(spawnFn: AgentSpawn) { return new AgentMcpBackend({ cli: 'claude', model: null, log: () => {}, spawnFn }); }
afterEach(() => vi.restoreAllMocks());
describe('execution recovery without writes being retried', () => {
  it.each([4, 3])('unknown leverage is rechecked, accepts only matching state (%i)', async (actual) => {
    const prompts: string[] = [];
    const b = backend(async (_c,_a,p) => { prompts.push(p); return response(prompts.length === 1 ? { ok: false } : { ok: true, symbol: 'SKHYNIXUSDT', leverage: actual }); });
    await b.start();
    try {
      const r = await b.setLeverage('SKHYNIXUSDT',4);
      expect(r.ok).toBe(actual === 4);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('get_leverage');
      expect(prompts[1]).toContain('INCLUDING zero-size rows');
    } finally { await b.stop(); }
  });
  it('account errors back off and self-heal, do not return stale success', async () => {
    let now = 100_000; vi.spyOn(Date,'now').mockImplementation(() => now);
    let calls = 0;
    const b = backend(async () => ++calls < 3 ? response({ ok: false, error: 'session limit' }) : response(account));
    await b.start();
    try {
      await expect(b.account()).rejects.toThrow('session limit');
      now += 14_999;
      await expect(b.account()).rejects.toThrow('session limit'); expect(calls).toBe(1);
      now += 1;
      await expect(b.account()).rejects.toThrow('session limit'); expect(calls).toBe(2);
      now += 29_999;
      await expect(b.account()).rejects.toThrow(); expect(calls).toBe(2);
      now += 1;
      expect((await b.account()).equity).toBe('100.00'); expect(calls).toBe(3);
      await b.account(); expect(calls).toBe(3);
    } finally { await b.stop(); }
  });
  it('a read spanning a write has its start timestamp and cannot repopulate the invalidated cache', async () => {
    let now = 100_000; vi.spyOn(Date,'now').mockImplementation(() => now);
    let finish!: (r: ReturnType<typeof response>) => void;
    let calls = 0;
    const b = backend(async () => ++calls === 1 ? new Promise((resolve) => { finish=resolve; }) : response(account));
    await b.start();
    try {
      const old = b.account();
      now += 20_000; b.invalidateAccount();
      now += 5_000; finish(response(account));
      expect((await old).as_of).toBe(100_000);
      expect((await b.account()).as_of).toBe(125_000); expect(calls).toBe(2);
    } finally { await b.stop(); }
  });
  it('missing positions never becomes a flat account', async () => {
    const b = backend(async () => response({ ok: true, account: { equity: '100', available:'100', unrealized_pnl:'0', open_orders: [] } }));
    await b.start();
    try { await expect(b.account()).rejects.toThrow('不能把缺 positions 当作空仓'); } finally { await b.stop(); }
  });
  it('entry omits false reduceOnly and closePosition fields in the executable task', async () => {
    const prompts: string[] = [];
    // outcome 'submitted' 不是明确失败,limit 单会追加一次 get_order 回读比价(execution-agent.ts §09-09⑤),
    // 所以按 op 找 place_entry 那条 prompt,不能假定只有一次调用。
    const b = backend(async (_c,_a,p) => { prompts.push(p); return response({ ok:true, outcome:'submitted' }); });
    await b.start();
    try {
      await b.placeEntry({ symbol:'SKHYNIXUSDT', direction:'long', qty:'0.01', entry:'limit', limit_price:'1294', client_order_id:'test-cid' });
      const prompt = prompts.find((p) => /"op":\s*"place_entry"/.test(p))!;
      expect(prompt).not.toContain('"reduce_only": false'); expect(prompt).not.toContain('"close_position": false');
      expect(prompt).toContain('OMIT reduceOnly and closePosition entirely');
    } finally { await b.stop(); }
  });
});
it('error summaries collapse identical kind/scope while keeping latest details and observation dates', () => {
  const rows = [{ at: 20, scope:'account', message:'session limit latest' },{ at:10,scope:'account',message:'session limit old' },{ at:5,scope:'market',message:'session limit other scope' }];
  const result = collapseObservations(rows, (r) => `${r.scope}:${errorKind(r.message)}`);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ message:'session limit latest', observed_count:2, first_seen_at:10, last_seen_at:20 });
});
