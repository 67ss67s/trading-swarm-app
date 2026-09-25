import { DirectAgentReads, rustReadBridge } from './direct-agent-reads.js';
// Entry: `node dist/demo/main.js` (or `npm run demo` in packages/gateway). Config via env:
//   TG_DEMO_PORT=18800  TG_DEMO_BRAIN=pi|claude|stub (initial workflow.brain; later edited from the UI)
//   TG_DEMO_BACKEND=auto|paper|demo|cli|agent_mcp|mcp (auto = demo iff ~/.trading-swarm/secrets/apikey-demo.json exists)
//   cli = Agent OS channel: official binance-cli (Skills Hub `binance` skill) with BINANCE_API_ENV=demo and
//         profile TG_DEMO_CLI_PROFILE (default tswarm-demo, created via `binance-cli profile create`)
//   agent_mcp = an agent CLI (TG_EXEC_AGENT_CLI=claude|codex, TG_EXEC_AGENT_MODEL) driving Binance's official
//         MCP server; the CLI owns the OAuth session, the gateway holds nothing. See execution-agent.ts.
//   mcp = the gateway itself calling that same MCP server with its own OAuth token (TG_BINANCE_OAUTH_CLIENT_ID)
//         through a human-confirmed tool map; zero model cost. See execution-mcp.ts / mcp-map.ts.
//   TG_EXCHANGE=okx|binance (默认 okx;okx 模式下只注册 paper/okx 两条通道,币安 OAuth 与 /api/binance/* 不挂)
//   okx = 官方 okx CLI(@okx_ai/okx-trade-cli)本地签名;二进制 TG_OKX_CLI → ~/.local/bin/okx → PATH,
//         profile TG_OKX_PROFILE(默认 ~/.okx/config.toml 的 default_profile),非模拟盘要 TG_OKX_LIVE=1。
//         行情走 OKX 公共 REST(TG_OKX_REST_BASE)。见 docs/design/okx-atk-2026-09-20.md
//   TG_DEMO_JUDGMENT_CAP=300 (0 = unlimited) initial daily_judgment_cap
//   TG_DEMO_AUTO_APPROVE=1  TG_DEMO_RUN_ON_START=1  TG_DEMO_DB=~/.trading-swarm/demo/state.sqlite

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStateDb } from '../state-db.js';
import { stubBrain } from './brain.js';
import { DemoBackend, PaperBackend, defaultDemoExecBin, type ExecBackend } from './execution.js';
import { CliBackend, cliAvailability, defaultBinanceCliBin } from './execution-cli.js';
import { AgentMcpBackend, DEFAULT_MCP_URL } from './execution-agent.js';
import { McpDirectBackend, mcpAvailability } from './execution-mcp.js';
import { loadToolMap, MCP_MAP_KV_KEY } from './mcp-map.js';
import { McpHttpClient } from './mcp-client.js';
import { BinanceOAuth } from './binance-oauth.js';
import { okxAvailability, OkxCliBackend } from './execution-okx.js';
import { exchange } from './market.js';
import { backendsFor, loadWorkflow } from './workflow.js';
import type { AgentCliKind, Backend } from './types.js';
import { createServer } from './http.js';
import { DemoRuntime } from './runtime.js';
import { DemoStore } from './store.js';
import { startPineEngine, stopPineEngine } from './research/pine/engine-host.js';

/** 零模型只读桥的可执行文件路径;未配置(或路径不存在)时返回 null,agent_mcp 读取退回 agent CLI。 */
const directReadBin = (): string | null => {
  const p = process.env['TG_DIRECT_READ_BIN']?.trim();
  return p && existsSync(p) ? p : null;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
/** demo_kv row holding the PaperBackend snapshot. */
const PAPER_STATE_KEY = 'paper_state';

async function main(): Promise<void> {
  const port = Number(process.env['TG_DEMO_PORT'] ?? '18800');
  const dbPath = process.env['TG_DEMO_DB'] ?? path.join(os.homedir(), '.trading-swarm', 'demo', 'state.sqlite');
  const secretsFile = path.join(os.homedir(), '.trading-swarm', 'secrets', 'apikey-demo.json');
  const wantBackend = process.env['TG_DEMO_BACKEND'] ?? 'auto';
  const hasDemoKey = existsSync(secretsFile) || (Boolean(process.env['TG_DEMO_API_KEY']) && Boolean(process.env['TG_DEMO_API_SECRET']));
  const state = openStateDb(dbPath);
  const store = new DemoStore(state);
  // auto = 上次在界面上选的通道(workflow.execution 已落库)优先;没选过才按有没有 demo key 决定。
  // 之前每次重启都退回 paper,用户切到 agent_mcp 后一刷新就「跳成了模拟」(2026-09-06)。mcp 直连不可自恢复(要 token+映射),不算。
  const persistedExec = loadWorkflow(store.loadWorkflowJson()).execution;
  // TG_EXCHANGE(默认 okx):通道清单按交易所裁(`backendsFor`),okx 模式下只有 paper/okx 两条,
  // Binance 的四条连工厂都不注册;binance 模式下反过来,okx 工厂也不注册(review #13)。
  const ex = exchange();
  // 每次探测/创建后端时重新解析配置；setup 会清空 availability 缓存。
  const okxGate = (): { available: boolean; note?: string } => okxAvailability();
  // 可恢复的通道按交易所分开,清单与 UI 同源(`backendsFor`):binance 模式下上次存的 `okx`
  // 不能被恢复,否则行情走 Binance、交易却发去 OKX,而执行页连 OKX 这个选项都不显示(review #13)。
  // `mcp` 单独排除:直连要 token + 人工确认过的工具映射,重启后不可自恢复。
  const resumable: Set<Backend> = new Set(backendsFor(ex).filter((k) => k !== 'mcp'));
  const autoKind = ex === 'okx'
    ? (persistedExec && resumable.has(persistedExec) ? persistedExec : okxGate().available ? 'okx' : 'paper')
    : persistedExec && resumable.has(persistedExec) && (persistedExec !== 'demo' || hasDemoKey) ? persistedExec : hasDemoKey ? 'demo' : 'paper';
  const backendKind = wantBackend === 'auto' ? autoKind : wantBackend;
  const logFn = (level: 'info' | 'warn' | 'error', message: string, data?: unknown): void => {
    store.log({ at: Date.now(), level, scope: 'demo-exec', message, ...(data === undefined ? {} : { data }) });
    console.error(`${new Date().toISOString()} ${level} [demo-exec] ${message}`);
  };
  // One factory per backend so the UI can switch channels at runtime (v3-ui-contract §9.6). The
  // agent factory reads the LIVE workflow, so changing exec_agent_cli/model then switching picks it up.
  const bootWorkflow = loadWorkflow(store.loadWorkflowJson());
  // Gate-native Binance OAuth (path A): client_id = https URL of the metadata document this gateway also
  // serves at /oauth/binance/client-metadata.json; null → the UI falls back to the CLI login instructions.
  // One MCP client is shared by the `mcp` backend and the /api/binance/* routes so they reuse one session.
  const oauth = new BinanceOAuth({
    clientId: process.env['TG_BINANCE_OAUTH_CLIENT_ID'] ?? null,
    redirectUri: process.env['TG_BINANCE_OAUTH_REDIRECT'] ?? `http://127.0.0.1:${port}/oauth/binance/callback`,
    resource: DEFAULT_MCP_URL,
    kv: { get: (k) => store.kvGet(k), set: (k, v) => store.kvSet(k, v) },
  });
  const mcpHttp = new McpHttpClient({ url: oauth.resource, token: () => oauth.token() });
  const toolMap = (): ReturnType<typeof loadToolMap> => loadToolMap(store.kvGet(MCP_MAP_KV_KEY));
  let rt: DemoRuntime | null = null;
  const agentCli = (): AgentCliKind => (rt?.workflow.exec_agent_cli ?? (process.env['TG_EXEC_AGENT_CLI'] === 'codex' ? 'codex' : bootWorkflow.exec_agent_cli));
  const agentModel = (): string | null => rt?.workflow.exec_agent_model ?? (process.env['TG_EXEC_AGENT_MODEL'] || bootWorkflow.exec_agent_model);
  // The machine-specific launch command for that CLI (alias / env prefix / path), read LIVE like the rest.
  const agentCommand = (): string => (rt?.workflow ?? bootWorkflow).cli_commands[agentCli()];
  const backends: Partial<Record<Backend, () => ExecBackend>> = {
    paper: () =>
      new PaperBackend(Number(process.env['TG_DEMO_PAPER_EQUITY'] ?? '10000'), {
        symbols: 'live',
        // Paper positions/orders/balance survive a restart (docs/demo/README.md §5.8); the
        // demo/cli/agent_mcp backends keep their state on the exchange side and need no snapshot.
        persist: { load: () => store.kvGet(PAPER_STATE_KEY), save: (json) => store.kvSet(PAPER_STATE_KEY, json) },
      }),
    demo: () => new DemoBackend(defaultDemoExecBin(REPO_ROOT), logFn),
    cli: () => new CliBackend({ bin: defaultBinanceCliBin(REPO_ROOT), profile: process.env['TG_DEMO_CLI_PROFILE'] ?? 'tswarm-demo', env: 'demo', log: logFn }),
    agent_mcp: () =>
      new AgentMcpBackend({
        // 零模型只读桥:可选的外部二进制(TG_DIRECT_READ_BIN)。未配置或文件不存在 → 不挂,账户读取走 agent CLI(read_mode=model)。
        reads: directReadBin() ? new DirectAgentReads(rustReadBridge(directReadBin()!), { get: k => store.kvGet(k), set: (k,v) => store.kvSet(k,v) }) : undefined,
        state: { get: k => store.kvGet(k), set: (k,v) => store.kvSet(k,v) },
        leanPrompt: true,
        accountTtlMs: 15_000,
        idleTtlMs: 60_000,
        cli: agentCli(),
        model: agentModel(),
        command: agentCommand(),
        log: logFn,
        // 账户读取已直接走 Rust MCP；idle 只影响健康状态的陈旧度容差。
        idle: () => (rt ? rt.openThreads().length === 0 && !rt.store.intents(50).some((i) => i.status === 'pending_approval' || i.status === 'approved' || i.status === 'submitted' || i.status === 'unknown') : false),
      }),
    mcp: () => new McpDirectBackend({ client: mcpHttp, map: toolMap, log: logFn }),
    okx: () => {
      const current = okxAvailability();
      return new OkxCliBackend({
        bin: current.cli,
        profile: current.profile,
        demo: current.demo,
        live: process.env['TG_OKX_LIVE'] === '1',
        kv: { get: (k) => store.kvGet(k), set: (k, v) => store.kvSet(k, v) },
        log: logFn,
      });
    },
  };
  // 工厂也按交易所裁:okx 模式下摘掉 Binance 的四条(UI 不列、切不过去、不会因为缺 key 在后台报错),
  // binance 模式下摘掉 okx —— 光挡住 resumable 不够,显式 TG_DEMO_BACKEND=okx 也不能绕过去(review #13)。
  for (const k of Object.keys(backends) as Backend[]) if (!backendsFor(ex).includes(k)) delete backends[k];
  // Booting straight into `mcp` only works once a human confirmed the tool map; otherwise start() would
  // throw and the process would die on every restart, so fall back to paper and say why.
  let bootKind = backendKind;
  if (bootKind === 'mcp' && toolMap()?.status !== 'confirmed') {
    console.error('TG_DEMO_BACKEND=mcp 但工具映射还没确认(先授权 → 只读测试 → 确认映射),本次先用 paper 启动');
    bootKind = 'paper';
  }
  const backend: ExecBackend = (backends[bootKind as Backend] ?? backends.paper!)();
  const backendGates = ex === 'okx'
    ? { okx: okxGate }
    : {
        mcp: () => mcpAvailability({ configured: oauth.status().configured, connected: oauth.status().connected, map: toolMap() }),
        // 09-07:官方 binance-cli 是推荐通道;没装/没 profile 时给出接入步骤(executionView 里会带 setup)
        cli: () => cliAvailability(defaultBinanceCliBin(REPO_ROOT), process.env['TG_DEMO_CLI_PROFILE'] ?? 'tswarm-demo'),
      };
  rt = new DemoRuntime({ store, backend, backends, backendGates, brains: { stub: stubBrain() } });
  // Env overrides for the initial workflow (later edits come from the UI and persist in state.sqlite).
  const patch: Record<string, unknown> = {};
  if (process.env['TG_DEMO_BRAIN']) patch['brain'] = process.env['TG_DEMO_BRAIN'];
  if (process.env['TG_DEMO_CHEAP_BRAIN']) patch['cheap_brain'] = process.env['TG_DEMO_CHEAP_BRAIN'];
  if (process.env['TG_DEMO_TF']) patch['timeframe'] = process.env['TG_DEMO_TF'];
  if (process.env['TG_DEMO_WATCHLIST']) patch['watchlist'] = process.env['TG_DEMO_WATCHLIST'].split(',');
  if (process.env['TG_DEMO_AUTO_APPROVE']) patch['auto_approve'] = process.env['TG_DEMO_AUTO_APPROVE'] !== '0';
  if (process.env['TG_EXEC_AGENT_CLI']) patch['exec_agent_cli'] = process.env['TG_EXEC_AGENT_CLI'];
  if (process.env['TG_EXEC_AGENT_MODEL']) patch['exec_agent_model'] = process.env['TG_EXEC_AGENT_MODEL'];
  if (process.env['TG_DEMO_JUDGMENT_CAP']) patch['daily_judgment_cap'] = Number(process.env['TG_DEMO_JUDGMENT_CAP']);
  // Showcase preset (docs/demo/interactive-demo-10min.md): everything visible inside ~10 minutes.
  if (process.env['TG_DEMO_SHOWCASE'] === '1') Object.assign(patch, { timeframe: '1m', info_every_ms: 3 * 60_000, narrate: true, scan_mode: 'every_close', review_every_close: true, watchlist: patch['watchlist'] ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'] });
  if (Object.keys(patch).length) {
    const r = rt.setWorkflow(patch);
    if (r.errors.length) console.error('workflow env overrides rejected:', r.errors.join('; '));
  }
  // okx 模式下不挂 Binance OAuth 与 /api/binance/*(§5)。
  // Pine 引擎(PineTS,AGPL 独立子进程):网关托管拉起,临时端口;TG_PINE_ENGINE=0 关,TG_PINE_PORT 指定端口。起不来不影响其它功能
  startPineEngine();
  const server = createServer(rt, store, ex === 'okx' ? {} : { oauth, mcp: mcpHttp });
  server.listen(port, '127.0.0.1', () => console.error(`demo gateway listening on http://127.0.0.1:${port}  (backend=${backend.kind}, brain=${rt.workflow.brain}, db=${dbPath})`));
  await rt.start({ runOnStart: process.env['TG_DEMO_RUN_ON_START'] === '1' });
  // 预热 OKX 三盏灯(钱包 / A2A / Trade Kit):重启后第一次打开页面不用等两个 CLI(accountLights 之后走 SWR)
  if (ex === 'okx') void rt.okxAccountLights().catch(() => undefined);

  const shutdown = async (): Promise<void> => {
    console.error('shutting down');
    server.close();
    await stopPineEngine();
    await rt.stop();
    state.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
