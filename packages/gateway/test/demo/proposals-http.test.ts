// v3.10 (§9.19): workflow proposals + one-time confirm tokens on the real HTTP surface; intent approve needs a nonce.
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

let fakeMarket: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;
beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
  ({ createServer } = await import('../../src/demo/http.js'));
});
afterAll(async () => {
  await fakeMarket.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});
let activeHttp: http.Server | null = null;
let activeRt: InstanceType<typeof DemoRuntime> | null = null;
let activeState: StateDb | null = null;
let baseUrl = '';
async function setup(): Promise<InstanceType<typeof DemoRuntime>> {
  const state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  const server = createServer(rt, store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  activeHttp = server;
  activeRt = rt;
  activeState = state;
  return rt;
}
afterEach(async () => {
  if (activeRt) await activeRt.stop();
  if (activeHttp) await new Promise<void>((r) => activeHttp!.close(() => r()));
  activeState?.close();
  activeHttp = null;
  activeRt = null;
  activeState = null;
});
async function post(path: string, body: unknown = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5180' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

it('chat set_workflow: direct keys apply, risky keys become a proposal; apply needs a fresh one-time nonce; second use fails', async () => {
  const rt = await setup();
  const tools = rt.chatTools('cs-1');
  const out = (await tools.set_workflow({ patch: { narrate: false, watchlist: ['BTCUSDT', 'ETHUSDT'], leverage: 20 } })) as any;
  expect(out.applied_keys).toEqual(['narrate']);
  expect(rt.workflow.narrate).toBe(false);
  expect(out.refused_keys).toEqual(['leverage']);
  expect(out.proposal.status).toBe('pending');
  const before = [...rt.workflow.watchlist];
  const list = await (await fetch(`${baseUrl}/api/workflow/proposals`)).json();
  expect(list.proposals[0]).toMatchObject({ id: out.proposal.id, status: 'pending', patch: { watchlist: ['BTCUSDT', 'ETHUSDT'] } });
  // no nonce → 428
  const noNonce = await post(`/api/workflow/proposals/${out.proposal.id}/apply`, {});
  expect(noNonce.status).toBe(428);
  expect(rt.workflow.watchlist).toEqual(before);
  const tok = await post(`/api/workflow/proposals/${out.proposal.id}/confirm-token`);
  expect(tok.status).toBe(200);
  expect(typeof tok.json.nonce).toBe('string');
  const applied = await post(`/api/workflow/proposals/${out.proposal.id}/apply`, { nonce: tok.json.nonce });
  expect(applied.status).toBe(200);
  expect(applied.json.proposal.status).toBe('applied');
  expect(rt.workflow.watchlist).toEqual(['BTCUSDT', 'ETHUSDT']);
  const again = await post(`/api/workflow/proposals/${out.proposal.id}/apply`, { nonce: tok.json.nonce });
  expect(again.status).toBe(409);
});

it('a proposal whose target changed under it cannot be applied with the old token; reject works without a token', async () => {
  const rt = await setup();
  const p = rt.proposeWorkflow({ timeframe: '1h' }, { session_id: null });
  const tok = rt.issueProposalConfirmation(p.id).token;
  rt.setWorkflow({ timeframe: '5m' }); // someone changed it in the UI meanwhile
  expect(() => rt.applyWorkflowProposal(p.id, tok.nonce)).toThrow(/变了/);
  expect(rt.rejectWorkflowProposal(p.id).status).toBe('rejected');
  expect(() => rt.issueProposalConfirmation(p.id)).toThrow(/rejected/);
});

it('chat_requires_approval is a human-only switch: chat set_workflow refuses it; default false lets the agent self-approve, true forces the card', async () => {
  const rt = await setup();
  const out = (await rt.chatTools('cs-1').set_workflow({ patch: { chat_requires_approval: true } })) as any;
  expect(out.refused_keys).toEqual(['chat_requires_approval']);
  expect(rt.workflow.chat_requires_approval).toBe(false);
  await expect(rt.approveIntent('int-missing', null, { by: 'agent' })).rejects.toThrow(/not found/);
  rt.setWorkflow({ chat_requires_approval: true });
  const wf = await (await fetch(`${baseUrl}/api/workflow`)).json();
  expect(wf.chat_requires_approval).toBe(true);
});

it('intent approve without a nonce is refused with 428 before anything executes', async () => {
  const rt = await setup();
  expect(() => rt.issueIntentConfirmation('int-missing')).toThrow(/not found/);
  const r = await post('/api/intents/int-missing/approve', {});
  expect([404, 428]).toContain(r.status);
});
