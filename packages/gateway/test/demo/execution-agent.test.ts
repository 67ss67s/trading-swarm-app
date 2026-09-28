// execution-agent.ts: AgentMcpBackend drives a real child process (a fake CLI script written to a temp
// dir, in the style of the brain adapters) so the argv, the stdin prompt, the JSON-envelope unwrapping,
// the timeout kill and the caches are all exercised for real — no network, no `claude`/`codex` needed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentMcpBackend, CLAUDE_LOGIN_COMMAND, claudeLoginCommand, CODEX_MCP_BLOCKED_DETAIL, DEFAULT_MCP_NAME, defaultAgentSpawn, lastJsonObject, probeMcpConnection, type AgentSpawn, type SpawnResult } from '../../src/demo/execution-agent.js';
import { cliSpawnArgs, resolveCliLaunch } from '../../src/demo/cli-launch.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';

let dir = '';
let script = '';

/** The fake CLI: behaves like `claude -p --output-format json` or like `codex exec -o <file>`. */
const SCRIPT = `
const fs = require('fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || 'ok';
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (mode === 'hang') { setInterval(() => {}, 1000); }
else {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const prompt = Buffer.concat(chunks).toString();
    const op = (/"op":\\s*"([a-z_]+)"/.exec(prompt) || [])[1] || 'unknown';
    let body;
    if (mode === 'garbage') body = 'I looked at the tools but I am not going to answer in JSON. Sorry!';
    else if (op === 'account') body = JSON.stringify({ ok: true, account: { equity: '1234.50', available: '1000', unrealized_pnl: '4.5', positions: [{ symbol: 'BTCUSDT', side: 'long', qty: '0.01', entry_price: '60000', mark_price: '60450', unrealized_pnl: '4.5', leverage: 3 }], open_orders: [] } });
    else if (op === 'get_order') body = JSON.stringify({ ok: true, order: { status: 'FILLED', avg_price: '60123.4', executed_qty: '0.01', raw: { fake: true } } });
    else if (op === 'open_with_protection') body = JSON.stringify(mode === 'reject'
      ? { entry: { outcome: 'filled', avg_price: '86.24', executed_qty: '0.35', order_id: '1', error: null }, stop: { outcome: 'failed', algo_id: null, error: '-4509 TIF GTE can only be used with open positions' }, tp: { outcome: 'skipped', algo_id: null, error: null } }
      : { entry: { outcome: 'filled', avg_price: '86.24', executed_qty: '0.35', order_id: '1', error: null }, stop: { outcome: 'submitted', algo_id: '77', error: null }, tp: { outcome: 'submitted', algo_id: '78', error: null } });
    else if (mode === 'reject') body = JSON.stringify({ ok: false, outcome: 'failed', error: 'no such tool: futures_new_order' });
    else body = 'Let me place that order for you.\\n' + JSON.stringify({ ok: true, outcome: 'filled', order_id: '99', avg_price: '60123.4', executed_qty: '0.01', raw: { echoed_op: op } });
    const outIdx = args.indexOf('-o');
    if (outIdx >= 0) { fs.writeFileSync(args[outIdx + 1], body); process.stdout.write('codex noise on stdout\\n'); }
    else process.stdout.write(JSON.stringify({ type: 'result', result: body, usage: { input_tokens: 10 } }));
    process.exit(0);
  });
}
`;

/** Runs the fake script instead of the real CLI, keeping every other argument identical. */
function fakeSpawn(mode: 'ok' | 'garbage' | 'hang' | 'reject', logFile?: string): AgentSpawn {
  return (cmd, args, stdin, opts) =>
    defaultAgentSpawn(process.execPath, [script, cmd, ...args], stdin, { ...opts, env: { ...opts.env, FAKE_MODE: mode, ...(logFile ? { FAKE_LOG: logFile } : {}) } });
}

function backend(mode: 'ok' | 'garbage' | 'hang' | 'reject', extra: Partial<ConstructorParameters<typeof AgentMcpBackend>[0]> = {}, logFile?: string): AgentMcpBackend {
  return new AgentMcpBackend({ cli: 'claude', model: null, log: () => undefined, spawnFn: fakeSpawn(mode, logFile), timeoutMs: 5000, ...extra });
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tgate-agent-test-'));
  script = path.join(dir, 'fake-cli.cjs');
  writeFileSync(script, SCRIPT);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('lastJsonObject', () => {
  it('takes the last complete top-level object and ignores prose and braces in strings', () => {
    expect(lastJsonObject('blah {"a":1} then {"b":{"c":"}"}}')).toEqual({ b: { c: '}' } });
    expect(lastJsonObject('no json here')).toBeNull();
    expect(lastJsonObject('[1,2,3]')).toBeNull();
    expect(lastJsonObject('{"broken": ')).toBeNull();
  });
});

describe('AgentMcpBackend write ops', () => {
  it('one CLI run per write op, parses the JSON out of the claude envelope', async () => {
    const log = path.join(dir, 'argv-1.log');
    const b = backend('ok', {}, log);
    await b.start();
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'market', limit_price: null, client_order_id: 'tgd-1' });
    expect(r.outcome).toBe('filled');
    expect(r.avg_price).toBe('60123.4');
    expect((r.receipt as { raw: { echoed_op: string } }).raw.echoed_op).toBe('place_entry');
    expect(b.runCount).toBe(1);

    const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; cwd: string });
    const args = rows[0]!.args;
    expect(args[0]).toBe('claude');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain(`mcp__${DEFAULT_MCP_NAME}__*`);
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Bash');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    // cwd is a scratch dir, never the repo (so no CLAUDE.md / project settings are loaded)
    expect(rows[0]!.cwd).not.toContain('trade-gate/packages');
    const cfg = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1]!, 'utf8')) as { mcpServers: Record<string, { type: string; url: string }> };
    expect(cfg.mcpServers[DEFAULT_MCP_NAME]!.type).toBe('http');
    expect(cfg.mcpServers[DEFAULT_MCP_NAME]!.url).toContain('agent.binance.com');
    await b.stop();
  });

  it('garbage output → unknown with the raw text as the error (never a silent failed)', async () => {
    const b = backend('garbage');
    await b.start();
    const r = await b.placeStop('BTCUSDT', 'long', '59000', 'tgd-sl-1');
    expect(r.outcome).toBe('unknown');
    expect(r.error).toContain('没有 JSON 对象');
    expect(r.error).toContain('not going to answer in JSON');
    await b.stop();
  });

  it('timeout → the child is killed and the outcome is unknown', async () => {
    const b = backend('hang', { timeoutMs: 400 });
    await b.start();
    const r = await b.placeTakeProfit('BTCUSDT', 'long', '62000', 'tgd-tp-1');
    expect(r.outcome).toBe('unknown');
    expect(r.error).toContain('timed out');
    await b.stop();
  });

  it('an agent that declares failed stays failed, and closePosition never reads unknown as flat', async () => {
    const b = backend('reject');
    await b.start();
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'short', qty: '0.01', entry: 'market', limit_price: null, client_order_id: 'tgd-2' });
    expect(r.outcome).toBe('failed');
    expect(r.error).toContain('no such tool');
    const c = await b.closePosition('BTCUSDT', 'tgd-3');
    expect(c.closed).toBe(false);
    expect(c.error).toContain('no such tool');
    await b.stop();
  });

  it('codex driver reads the answer out of the -o file', async () => {
    const b = backend('ok', { cli: 'codex', model: 'gpt-5.4' });
    await b.start();
    const r = await b.setLeverage('BTCUSDT', 3);
    expect(r.ok).toBe(true);
    await b.stop();
  });
});

describe('AgentMcpBackend caches', () => {
  it('account is cached and invalidated by every write op; getOrder is cached per client_order_id', async () => {
    const b = backend('ok', { accountTtlMs: 60_000 });
    await b.start();
    const a1 = await b.account();
    expect(a1.backend).toBe('agent_mcp');
    expect(a1.equity).toBe('1234.50');
    expect(a1.positions).toHaveLength(1);
    expect(b.runCount).toBe(1);
    await b.account();
    await b.account();
    expect(b.runCount).toBe(1); // still cached

    await b.setMarginType('BTCUSDT', 'cross'); // a write → cache dropped
    expect(b.runCount).toBe(2);
    await b.account();
    expect(b.runCount).toBe(3);

    const o1 = await b.getOrder('BTCUSDT', 'tgd-9');
    expect(o1?.status).toBe('FILLED');
    expect(o1?.avg_price).toBe('60123.4');
    expect(b.runCount).toBe(4);
    await b.getOrder('BTCUSDT', 'tgd-9');
    expect(b.runCount).toBe(4); // 30 s cache
    await b.getOrder('BTCUSDT', 'tgd-other');
    expect(b.runCount).toBe(5);
    await b.stop();
  });

  it('concurrent account() calls share one CLI run', async () => {
    const b = backend('ok');
    await b.start();
    const [x, y] = await Promise.all([b.account(), b.account()]);
    expect(x.equity).toBe(y.equity);
    expect(b.runCount).toBe(1);
    await b.stop();
  });

  it('tick() is a no-op (not a simulator)', () => {
    expect(backend('ok').tick()).toEqual([]);
  });
});

describe('probeMcpConnection', () => {
  const canned = (stdout: string, code: number | null, spawnError: string | null = null): AgentSpawn => async () => ({ stdout, stderr: '', code, timedOut: false, spawnError }) as SpawnResult;

  it('codex is reported unavailable without spawning anything (login blocked upstream)', async () => {
    let called = false;
    const spy: AgentSpawn = async () => {
      called = true;
      return { stdout: '', stderr: '', code: 0, timedOut: false, spawnError: null };
    };
    const c = await probeMcpConnection('codex', DEFAULT_MCP_NAME, spy);
    expect(called).toBe(false);
    expect(c.status).toBe('unavailable');
    expect(c.detail).toBe(CODEX_MCP_BLOCKED_DETAIL);
  });

  it('claude: needs auth / connected / unavailable', async () => {
    expect((await probeMcpConnection('claude', DEFAULT_MCP_NAME, canned('Status: ✘ Needs authentication', 0))).status).toBe('needs_auth');
    expect((await probeMcpConnection('claude', DEFAULT_MCP_NAME, canned('Status: ✓ Connected', 0))).status).toBe('connected');
    expect((await probeMcpConnection('claude', DEFAULT_MCP_NAME, canned('No MCP server found', 1))).status).toBe('unavailable');
    expect((await probeMcpConnection('claude', DEFAULT_MCP_NAME, canned('', null, 'spawn claude ENOENT'))).status).toBe('unavailable');
    expect((await probeMcpConnection('claude', DEFAULT_MCP_NAME, canned('something else entirely', 0))).status).toBe('unknown');
  });
});

describe('默认模型', () => {
  it('workflow 默认 sonnet;model=null 时 claude 的 argv 里仍然是 --model sonnet(每笔写操作一次 CLI,挑便宜的)', async () => {
    expect(DEFAULT_WORKFLOW.exec_agent_model).toBe('sonnet');
    const log = path.join(dir, 'argv-model.log');
    const b = backend('ok', { model: null }, log);
    await b.start();
    await b.setLeverage('BTCUSDT', 3);
    const args = (JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]!) as { args: string[] }).args;
    // args[0] is whatever cli-launch decided to spawn: `claude` when it is on PATH, otherwise the login
    // shell plus its `-ilc '<cmd> "$@"' --` prefix (this machine may not have claude at all).
    const launch = resolveCliLaunch('claude');
    expect(args.slice(0, 1 + launch.argsPrefix.length)).toEqual([launch.file, ...launch.argsPrefix]);
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    await b.stop();
  });

  it('登录命令跑的是交互式 claude 的 /mcp,cwd 是家目录(服务器注册在那个 project scope)', () => {
    expect(CLAUDE_LOGIN_COMMAND).toContain('cd ~');
    expect(CLAUDE_LOGIN_COMMAND).toContain('claude');
    expect(CLAUDE_LOGIN_COMMAND).toContain('/mcp');
  });
});

describe('配置的启动命令(Workflow.cli_commands)', () => {
  it('写操作按配置的命令起子进程:别名走登录 shell,CLI 自己的参数原样跟在后面', async () => {
    const log = path.join(dir, 'argv-command.log');
    const b = backend('ok', { command: 'claudeproxy' }, log);
    await b.start();
    await b.setLeverage('BTCUSDT', 3);
    const args = (JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]!) as { args: string[] }).args;
    // The fake CLI logs [cmd, ...args], i.e. exactly what AgentMcpBackend asked spawn() for.
    const expected = cliSpawnArgs('claudeproxy', ['-p']);
    expect(args.slice(0, 1 + expected.args.length)).toEqual([expected.file, ...expected.args]);
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(b.command).toBe('claudeproxy');
    await b.stop();
  });

  it('codex 同理:配置的命令决定 argv[0],`exec` 等参数不变', async () => {
    const log = path.join(dir, 'argv-command-codex.log');
    const b = backend('ok', { cli: 'codex', command: 'codexproxy' }, log);
    await b.start();
    await b.setLeverage('BTCUSDT', 3);
    const args = (JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]!) as { args: string[] }).args;
    const expected = cliSpawnArgs('codexproxy', ['exec']);
    expect(args.slice(0, 1 + expected.args.length)).toEqual([expected.file, ...expected.args]);
    await b.stop();
  });

  it('MCP 探测走同一条启动路径(别名版 claude 也能被探到)', async () => {
    let seen: { cmd: string; args: string[] } | null = null;
    const spy: AgentSpawn = async (cmd, args) => {
      seen = { cmd, args };
      return { stdout: 'Status: ✓ Connected', stderr: '', code: 0, timedOut: false, spawnError: null } as SpawnResult;
    };
    const c = await probeMcpConnection('claude', DEFAULT_MCP_NAME, spy, 5000, 'claudeproxy');
    expect(c.status).toBe('connected');
    const expected = cliSpawnArgs('claudeproxy', ['mcp', 'get', DEFAULT_MCP_NAME]);
    expect(seen!.cmd).toBe(expected.file);
    expect(seen!.args).toEqual(expected.args);
  });

  it('探测起不来时,报的是用户配的那条命令(不是裸 claude)', async () => {
    const enoent: AgentSpawn = async () => ({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: 'spawn ENOENT' }) as SpawnResult;
    const c = await probeMcpConnection('claude', DEFAULT_MCP_NAME, enoent, 5000, 'claudeproxy');
    expect(c.status).toBe('unavailable');
    expect(c.detail).toContain('claudeproxy');
  });

  it('登录终端里跑的是用户配的命令', () => {
    expect(claudeLoginCommand('claudeproxy')).toBe('cd ~ && claudeproxy "/mcp"');
    expect(claudeLoginCommand(null)).toBe(CLAUDE_LOGIN_COMMAND);
  });
});

describe('protective leg after the 2026-09-06 HYPE incident', () => {
  it('sends the stop as an exact tool_execute payload: hedge positionSide + closePosition, no reduceOnly/quantity', async () => {
    let captured = '';
    const spy: AgentSpawn = (cmd, args, stdin, opts) => {
      captured = stdin;
      return fakeSpawn('ok')(cmd, args, stdin, opts);
    };
    const b = new AgentMcpBackend({ cli: 'claude', model: null, log: () => undefined, spawnFn: spy, timeoutMs: 5000 });
    const r = await b.placeStop('HYPEUSDT', 'long', '84.86', 'tgd-sl-hype');
    expect(r.outcome).toBe('filled');
    const task = JSON.parse(captured.slice(captured.indexOf('{'), captured.indexOf('\nRULES:'))) as Record<string, any>;
    expect(task.op).toBe('place_stop');
    expect(task.transport.toolName).toBe('futures_usds.newAlgoOrder');
    expect(task.transport.arguments).toEqual({ algoType: 'CONDITIONAL', symbol: 'HYPEUSDT', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', triggerPrice: 84.86, closePosition: 'true', workingType: 'MARK_PRICE', clientAlgoId: 'tgd-sl-hype' });
    expect('reduceOnly' in task.transport.arguments).toBe(false);
    expect('quantity' in task.transport.arguments).toBe(false);
    const tp = await (async () => { await b.placeTakeProfit('HYPEUSDT', 'short', '80', 'tgd-tp-hype'); return JSON.parse(captured.slice(captured.indexOf('{'), captured.indexOf('\nRULES:'))) as Record<string, any>; })();
    expect(tp.transport.arguments).toMatchObject({ side: 'BUY', positionSide: 'SHORT', type: 'TAKE_PROFIT_MARKET', triggerPrice: 80 });
  });

  it('open_with_protection: one CLI run carries entry + stop (+tp) and parses the combined receipt', async () => {
    let captured = '';
    const spy: AgentSpawn = (cmd, args, stdin, opts) => {
      captured = stdin;
      return fakeSpawn('ok')(cmd, args, stdin, opts);
    };
    const b = new AgentMcpBackend({ cli: 'claude', model: null, log: () => undefined, spawnFn: spy, timeoutMs: 5000 });
    const r = await b.openWithProtection({ symbol: 'HYPEUSDT', direction: 'long', qty: '0.35', entry: 'market', limit_price: null, client_order_id: 'tgd-h-e1', stop_price: '84.86', stop_client_algo_id: 'tgd-h-s1', take_profit: { trigger_price: '88.5', client_algo_id: 'tgd-h-t1' } });
    expect(r.entry.outcome).toBe('filled');
    expect(r.entry.avg_price).toBe('86.24');
    expect(r.stop).toEqual({ outcome: 'submitted', algo_id: '77', error: null });
    expect(r.tp.outcome).toBe('submitted');
    const task = JSON.parse(captured.slice(captured.indexOf('{'), captured.indexOf('\nRULES:'))) as Record<string, any>;
    expect(task.entry.toolName).toBe('futures_usds.newOrder');
    expect(task.entry.arguments).toMatchObject({ symbol: 'HYPEUSDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.35', newOrderRespType: 'RESULT' });
    expect(task.stop.toolName).toBe('futures_usds.newAlgoOrder');
    expect(task.stop.arguments).toMatchObject({ algoType: 'CONDITIONAL', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', triggerPrice: '84.86', closePosition: 'true', clientAlgoId: 'tgd-h-s1' });
    expect('reduceOnly' in task.stop.arguments).toBe(false);
  });

  it('open_with_protection: a rejected stop keeps the filled entry receipt and the exact exchange error', async () => {
    const b = backend('reject');
    const r = await b.openWithProtection({ symbol: 'HYPEUSDT', direction: 'long', qty: '0.35', entry: 'market', limit_price: null, client_order_id: 'tgd-h-e1', stop_price: '84.86', stop_client_algo_id: 'tgd-h-s1' });
    expect(r.entry.outcome).toBe('filled');
    expect(r.stop.outcome).toBe('failed');
    expect(r.stop.error).toContain('-4509');
    expect(r.tp.outcome).toBe('skipped');
  });

  it('reports protection as unverified until TG_AGENT_MCP_PROTECTION=verified', () => {
    const b = backend('ok');
    const prev = process.env['TG_AGENT_MCP_PROTECTION'];
    delete process.env['TG_AGENT_MCP_PROTECTION'];
    expect(b.protectionCapability()).toBe('unverified');
    process.env['TG_AGENT_MCP_PROTECTION'] = 'verified';
    expect(b.protectionCapability()).toBe('verified');
    if (prev === undefined) delete process.env['TG_AGENT_MCP_PROTECTION'];
    else process.env['TG_AGENT_MCP_PROTECTION'] = prev;
  });
});


describe('transport errors override declared failure', () => {
  it.each([
    ['Socket connection closed unexpectedly before a response was received; result not confirmed.', 'unknown'],
    ['timed out', 'unknown'], ['ECONNRESET', 'unknown'], ['EPIPE', 'unknown'],
    ['fetch failed', 'unknown'], ['network error', 'unknown'],
    ['-2021 Order would immediately trigger.', 'failed'],
    ['Order rejected: invalid trigger price', 'failed'],
  ])('%s → %s for standalone and combined stops', async (error, outcome) => {
    const spawnFn: AgentSpawn = async (_cmd, _args, prompt) => ({
      stdout: JSON.stringify(prompt.includes('"op":"open_with_protection"') || prompt.includes('"op": "open_with_protection"')
        ? { entry: { outcome: 'filled', avg_price: '10' }, stop: { outcome: 'failed', error }, tp: { outcome: 'skipped' } }
        : { outcome: 'failed', error }),
      stderr: '', code: 0, timedOut: false, spawnError: null,
    });
    const b = backend('ok', { spawnFn });
    try {
      expect((await b.placeStop('SOXSUSDT', 'short', '11', 'stop-1')).outcome).toBe(outcome);
      const r = await b.openWithProtection({ symbol: 'SOXSUSDT', direction: 'short', qty: '1', entry: 'market', limit_price: null, client_order_id: 'entry-1', stop_price: '11', stop_client_algo_id: 'stop-1' });
      expect(r.entry.outcome).toBe('filled');
      expect(r.stop).toMatchObject({ outcome, error });
    } finally { await b.stop(); }
  });

  it('keeps a 30-minute transport-health ledger: lost responses count, exchange rejections do not', async () => {
    let error = 'Socket connection closed unexpectedly before a response was received; result not confirmed.';
    const spawnFn: AgentSpawn = async () => ({ stdout: JSON.stringify({ outcome: 'failed', error }), stderr: '', code: 0, timedOut: false, spawnError: null });
    const b = backend('ok', { spawnFn });
    try {
      expect(b.transportHealth()).toMatchObject({ runs: 0, transport_errors: 0, last_error: null });
      await b.placeStop('SOXSUSDT', 'short', '11', 'stop-1');
      await b.placeStop('SOXSUSDT', 'short', '11', 'stop-2');
      error = '-2021 Order would immediately trigger.';
      await b.placeStop('SOXSUSDT', 'short', '11', 'stop-3');
      const h = b.transportHealth();
      expect(h.runs).toBe(3);
      expect(h.transport_errors).toBe(2);
      expect(h.last_error).toMatch(/Socket connection closed/);
      expect(h.window_ms).toBe(30 * 60_000);
    } finally { await b.stop(); }
  });
});

// 09-09 待办⑤:限价入场发出去后按 CID 回读一次,核对交易所记的 price 与请求是否一致。
// 只告警(kind='limit_price_mismatch',warn,带 CID/期望价/实际价),从不撤单、从不重发。
describe('agent_mcp 限价单发单后回读比价(09-09 待办⑤)', () => {
  /** 按 prompt 里的 "op" 分发不同回复,不用真跑 fake-cli.cjs 脚本。 */
  function spawnByOp(bodies: Record<string, unknown>): AgentSpawn {
    return async (_cmd, _args, prompt) => {
      const op = (/"op":\s*"([a-z_]+)"/.exec(prompt) || [])[1] ?? 'unknown';
      return { stdout: JSON.stringify(bodies[op] ?? { outcome: 'unknown' }), stderr: '', code: 0, timedOut: false, spawnError: null };
    };
  }
  const filledEntry = { ok: true, outcome: 'filled', order_id: '1', avg_price: '100', executed_qty: '1' };

  it('回读价格与请求不一致 → warn 告警,带 CID/期望价/实际价,不触发第二次下单', async () => {
    const logs: { level: string; message: string; data?: unknown }[] = [];
    const spawnFn = spawnByOp({
      place_entry: filledEntry,
      get_order: { ok: true, order: { status: 'NEW', avg_price: null, executed_qty: '0', raw: { price: '101.5' } } },
    });
    const b = new AgentMcpBackend({ cli: 'claude', model: null, log: (level, message, data) => logs.push({ level, message, data }), spawnFn, timeoutMs: 5000 });
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'limit', limit_price: '100', client_order_id: 'tgd-limit-1' });
    expect(r.outcome).toBe('filled'); // 告警不改回执
    const mismatch = logs.find((l) => (l.data as Record<string, unknown> | undefined)?.['kind'] === 'limit_price_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.level).toBe('warn');
    expect(mismatch!.data).toMatchObject({ symbol: 'BTCUSDT', client_order_id: 'tgd-limit-1', expected_price: '100', actual_price: '101.5' });
    expect(b.runCount).toBe(2); // place_entry + 回读一次,不多打
  });

  it('回读价格一致 → 不告警', async () => {
    const logs: { data?: unknown }[] = [];
    const spawnFn = spawnByOp({
      place_entry: filledEntry,
      get_order: { ok: true, order: { status: 'NEW', avg_price: null, executed_qty: '0', raw: { price: '100' } } },
    });
    const b = new AgentMcpBackend({ cli: 'claude', model: null, log: (_l, _m, data) => logs.push({ data }), spawnFn, timeoutMs: 5000 });
    await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'limit', limit_price: '100', client_order_id: 'tgd-limit-2' });
    expect(logs.some((l) => (l.data as Record<string, unknown> | undefined)?.['kind'] === 'limit_price_mismatch')).toBe(false);
  });

  it('查不到这张单 / 交易所这次没给回 price → 缺证据,不误报', async () => {
    const logs: { data?: unknown }[] = [];
    const spawnFn = spawnByOp({ place_entry: filledEntry, get_order: { ok: true, order: null } });
    const b = new AgentMcpBackend({ cli: 'claude', model: null, log: (_l, _m, data) => logs.push({ data }), spawnFn, timeoutMs: 5000 });
    await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'limit', limit_price: '100', client_order_id: 'tgd-limit-3' });
    expect(logs.some((l) => (l.data as Record<string, unknown> | undefined)?.['kind'] === 'limit_price_mismatch')).toBe(false);
  });

  it('市价单不回读比价(没有 limit_price 可比)', async () => {
    const calls: string[] = [];
    const spawnFn: AgentSpawn = async (_cmd, _args, prompt) => {
      calls.push((/"op":\s*"([a-z_]+)"/.exec(prompt) || [])[1] ?? 'unknown');
      return { stdout: JSON.stringify(filledEntry), stderr: '', code: 0, timedOut: false, spawnError: null };
    };
    const b = new AgentMcpBackend({ cli: 'claude', model: null, log: () => undefined, spawnFn, timeoutMs: 5000 });
    await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'market', limit_price: null, client_order_id: 'tgd-mkt-1' });
    expect(calls).toEqual(['place_entry']); // 没有多打一次回读
  });

  it('入场单被子代理明确判 failed → 不回读比价(压根没到交易所)', async () => {
    const calls: string[] = [];
    const spawnFn: AgentSpawn = async (_cmd, _args, prompt) => {
      calls.push((/"op":\s*"([a-z_]+)"/.exec(prompt) || [])[1] ?? 'unknown');
      return { stdout: JSON.stringify({ ok: false, outcome: 'failed', error: 'no such tool' }), stderr: '', code: 0, timedOut: false, spawnError: null };
    };
    const b = new AgentMcpBackend({ cli: 'claude', model: null, log: () => undefined, spawnFn, timeoutMs: 5000 });
    await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'limit', limit_price: '100', client_order_id: 'tgd-limit-4' });
    expect(calls).toEqual(['place_entry']);
  });

  it('回读本身报错(比如查询超时)→ 只记一条 info,不影响入场回执', async () => {
    const logs: { level: string; data?: unknown }[] = [];
    const spawnFn: AgentSpawn = async (_cmd, _args, prompt) => {
      const op = (/"op":\s*"([a-z_]+)"/.exec(prompt) || [])[1] ?? 'unknown';
      if (op === 'get_order') return { stdout: 'not json at all', stderr: '', code: 0, timedOut: false, spawnError: null };
      return { stdout: JSON.stringify(filledEntry), stderr: '', code: 0, timedOut: false, spawnError: null };
    };
    const b = new AgentMcpBackend({ cli: 'claude', model: null, log: (level, _m, data) => logs.push({ level, data }), spawnFn, timeoutMs: 5000 });
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'limit', limit_price: '100', client_order_id: 'tgd-limit-5' });
    expect(r.outcome).toBe('filled');
    expect(logs.some((l) => (l.data as Record<string, unknown> | undefined)?.['kind'] === 'limit_price_mismatch')).toBe(false);
  });
});
