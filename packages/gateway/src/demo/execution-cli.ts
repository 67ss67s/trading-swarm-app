import type { Market } from './types.js';
// Agent OS channel: the official `binance-cli` (Binance Skills Hub `binance` skill) as an execution
// backend. The gateway never sees the API key — binance-cli reads its own profile store; we only pass
// `--profile <name>` and force `BINANCE_API_ENV=demo` (Binance Demo Trading) for the demo. Conditional
// SL/TP legs use the algo-order endpoints, as the current futures API requires.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AccountView, Backend, Direction, OpenOrderView, PositionView, SymbolInfo } from './types.js';
import type { SymbolRules } from './gates.js';
import type { EntryRequest, ExecBackend, OrderReceipt, OrderStatusView, PaperEvent } from './execution.js';

export interface CliBackendOptions {
  bin: string;
  profile: string | null;
  env: 'demo' | 'testnet';
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/** 给用户看的接入步骤(cli 后端不可用时显示在执行页顶上)。 */
export const CLI_SETUP_GUIDE = [
  '1. 到 https://demo.binance.com 开 Demo Trading,生成一对 API key(模拟盘,不动真钱)。',
  '2. 终端里跑:npx binance-cli profile create --name tswarm-demo,按提示粘 key/secret,环境选 demo。',
  '3. 回到这里刷新,「Binance 模拟盘(官方 binance-cli)」会变成可选,点它切换。',
  '密钥只存在 binance-cli 自己的 profile 里,网关不碰。想用别的 profile 名:启动时设 TG_DEMO_CLI_PROFILE。',
].join('\n');

let cliAvailCache: { at: number; key: string; result: { available: boolean; note?: string } } | null = null;
/**
 * cli 后端现在能不能用:binance-cli 二进制在不在 + 指定 profile 建没建。结果缓存 60 s(executionView 调用很频繁,
 * 不能每次都 spawn)。任何异常 → 不可用并把原因写进 note。
 */
export function cliAvailability(bin: string, profile: string | null): { available: boolean; note?: string } {
  const key = `${bin}|${profile ?? ''}`;
  if (cliAvailCache && cliAvailCache.key === key && Date.now() - cliAvailCache.at < 60_000) return cliAvailCache.result;
  let result: { available: boolean; note?: string };
  try {
    const binOk = bin.includes('/') ? existsSync(bin) : spawnSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).status === 0;
    if (!binOk) result = { available: false, note: `找不到 binance-cli(${bin});在仓库里 npm install 会带上它,或设 TG_DEMO_BINANCE_CLI 指向可执行文件。\n${CLI_SETUP_GUIDE}` };
    else if (!profile) result = { available: true };
    else {
      const r = spawnSync(bin, ['profile', 'list'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 8_000, env: { ...process.env, BINANCE_API_ENV: 'demo' } });
      const out = `${String(r.stdout ?? '')}\n${String(r.stderr ?? '')}`;
      if (r.error) result = { available: false, note: `binance-cli 跑不起来:${r.error.message}\n${CLI_SETUP_GUIDE}` };
      else if (new RegExp(`(^|[^A-Za-z0-9_-])${profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`).test(out)) result = { available: true };
      else result = { available: false, note: `binance-cli 已装,但还没有 profile「${profile}」(需要一对 Demo Trading 的 API key)。\n${CLI_SETUP_GUIDE}` };
    }
  } catch (e) {
    result = { available: false, note: `检查 binance-cli 失败:${(e as Error).message}\n${CLI_SETUP_GUIDE}` };
  }
  cliAvailCache = { at: Date.now(), key, result };
  return result;
}

export function defaultBinanceCliBin(repoRoot: string): string {
  const fromEnv = process.env['TG_DEMO_BINANCE_CLI'];
  if (fromEnv) return fromEnv;
  const local = path.join(repoRoot, 'node_modules', '.bin', 'binance-cli');
  return existsSync(local) ? local : 'binance-cli';
}

class CliError extends Error {
  constructor(
    public readonly kind: 'transport' | 'rejected' | 'local_reject',
    message: string,
    public readonly code: number | null,
    public readonly ambiguous: boolean,
  ) {
    super(message);
  }
}

export class CliBackend implements ExecBackend {
  marketsSupported(): Market[] { return ['perp']; }
  /** Its own kind since v3.3 (was reported as 'demo'): the UI and the workflow now distinguish the channels. */
  readonly kind: Backend = 'cli';
  private rulesCache = new Map<string, SymbolRules>();
  private symbolsCache: SymbolInfo[] | null = null;
  private positionSideDual = false;

  constructor(private readonly opts: CliBackendOptions) {}

  async start(): Promise<void> {
    const t = await this.run(['futures-usds', 'check-server-time'], false);
    this.opts.log('info', `binance-cli ready (env=${this.opts.env}, profile=${this.opts.profile ?? 'env'}), server time ${String((t as { serverTime?: number }).serverTime)}`);
    try {
      const mode = (await this.run(['futures-usds', 'get-current-position-mode'], true)) as { dualSidePosition?: boolean };
      this.positionSideDual = Boolean(mode.dualSidePosition);
      this.opts.log('info', `position mode: ${this.positionSideDual ? 'hedge (dual)' : 'one-way'}`);
    } catch (e) {
      this.opts.log('warn', `无法读取持仓模式(凭证未配置?):${(e as Error).message}`);
    }
  }
  async stop(): Promise<void> {}

  /** Runs one binance-cli command; parses its JSON output; classifies failures. */
  private run(args: string[], signed: boolean, timeoutMs = 20_000): Promise<unknown> {
    const full = [...args];
    if (signed && this.opts.profile) full.push('--profile', this.opts.profile);
    const isWrite = args.some((a) => a === 'new-order' || a === 'new-algo-order' || a === 'cancel-order' || a === 'cancel-algo-order' || a.startsWith('cancel-all'));
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.bin, full, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BINANCE_API_ENV: this.opts.env } });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        // A write that timed out may have reached the exchange: always ambiguous.
        reject(new CliError('transport', `binance-cli ${args.slice(0, 2).join(' ')} timed out`, null, isWrite));
      }, timeoutMs);
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (err += String(d)));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new CliError('transport', `spawn binance-cli failed: ${e.message}`, null, false));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const text = out.trim() || err.trim();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        const obj = parsed as { code?: number; msg?: string } | null;
        if (obj && typeof obj.code === 'number' && obj.code < 0) return reject(new CliError('rejected', `${obj.code} ${obj.msg ?? ''}`.trim(), obj.code, false));
        if (code !== 0) {
          const msg = (err || out).trim().slice(-400) || `exit ${code}`;
          // Never sent: missing profile/credentials, argument validation, unknown command.
          const localReject = /is signed|create a profile|profile .*not found|Unknown argument|Missing required|API key|credential/i.test(msg);
          if (localReject) return reject(new CliError('local_reject', msg, null, false));
          const looksRejected = /code\s*[:=]\s*-\d+|"msg"|Invalid|invalid|not found|Mandatory/.test(msg);
          return reject(new CliError(looksRejected ? 'rejected' : 'transport', msg, null, isWrite && !looksRejected));
        }
        if (parsed === null && text) return reject(new CliError('transport', `unparseable output: ${text.slice(0, 200)}`, null, args.some((a) => a === 'new-order' || a === 'new-algo-order')));
        resolve(parsed);
      });
    });
  }

  async markPrice(symbol: string, market: Market = 'perp'): Promise<string> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const r = (await this.run(['futures-usds', 'mark-price', '--symbol', symbol], false)) as { markPrice: string };
    return Number(r.markPrice).toString();
  }

  private symbolsFetchedAt = 0;
  async symbols(market: Market = 'perp'): Promise<SymbolInfo[]> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    if (this.symbolsCache && Date.now() - this.symbolsFetchedAt < 10 * 60_000) return this.symbolsCache;
    const info = (await this.run(['futures-usds', 'exchange-information'], false, 40_000)) as { symbols: Record<string, unknown>[] };
    this.symbolsFetchedAt = Date.now();
    const rows: SymbolInfo[] = [];
    for (const s of info.symbols) {
      if (s['contractType'] !== 'PERPETUAL' || s['quoteAsset'] !== 'USDT') continue;
      const filters = (s['filters'] as Record<string, string>[]) ?? [];
      const f = (type: string): Record<string, string> | undefined => filters.find((x) => x['filterType'] === type);
      const row: SymbolInfo = {
        symbol: String(s['symbol']),
        status: String(s['status']),
        price_precision: Number(s['pricePrecision'] ?? 2),
        qty_precision: Number(s['quantityPrecision'] ?? 3),
        step_size: f('LOT_SIZE')?.['stepSize'] ?? '0.001',
        tick_size: f('PRICE_FILTER')?.['tickSize'] ?? '0.1',
        min_qty: f('LOT_SIZE')?.['minQty'] ?? '0.001',
        min_notional: f('MIN_NOTIONAL')?.['notional'] ?? '5',
      };
      rows.push(row);
      this.rulesCache.set(row.symbol, { step_size: row.step_size, tick_size: row.tick_size, min_qty: row.min_qty, min_notional: row.min_notional });
    }
    this.symbolsCache = rows;
    return rows;
  }

  async symbolRules(symbol: string, market: Market = 'perp'): Promise<SymbolRules> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const cached = this.rulesCache.get(symbol);
    if (cached) return cached;
    await this.symbols();
    return this.rulesCache.get(symbol) ?? { step_size: '0.001', tick_size: '0.1', min_qty: '0.001', min_notional: '5' };
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ ok: boolean; error: string | null }> {
    try {
      await this.run(['futures-usds', 'change-initial-leverage', '--symbol', symbol, '--leverage', String(leverage)], true);
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  async setMarginType(symbol: string, mode: 'cross' | 'isolated'): Promise<{ ok: boolean; error: string | null }> {
    try {
      await this.run(['futures-usds', 'change-margin-type', '--symbol', symbol, '--margin-type', mode === 'cross' ? 'CROSSED' : 'ISOLATED'], true);
      return { ok: true, error: null };
    } catch (e) {
      if (e instanceof CliError && e.code === -4046) return { ok: true, error: null }; // no need to change
      return { ok: false, error: (e as Error).message };
    }
  }

  async account(): Promise<AccountView> {
    const [acct, pos, orders, algos] = await Promise.all([
      this.run(['futures-usds', 'account-information-v3'], true) as Promise<Record<string, unknown>>,
      this.run(['futures-usds', 'position-information-v3'], true) as Promise<Record<string, unknown>[]>,
      this.run(['futures-usds', 'current-all-open-orders'], true) as Promise<Record<string, unknown>[]>,
      (this.run(['futures-usds', 'current-all-algo-open-orders'], true) as Promise<unknown>).catch(() => [] as unknown),
    ]);
    const positions: PositionView[] = [];
    for (const p of pos) {
      const amt = Number(p['positionAmt'] ?? '0');
      if (String(p['positionSide'] ?? 'BOTH') !== 'BOTH') this.positionSideDual = true;
      if (amt === 0) continue;
      positions.push({ market: 'perp', symbol: String(p['symbol']), side: amt > 0 ? 'long' : 'short', qty: Math.abs(amt).toString(), entry_price: Number(p['entryPrice'] ?? '0').toString(), mark_price: Number(p['markPrice'] ?? '0').toString(), unrealized_pnl: Number(p['unRealizedProfit'] ?? '0').toFixed(2), leverage: Number(p['leverage'] ?? '0') });
    }
    const open_orders: OpenOrderView[] = orders.map((o) => ({
      symbol: String(o['symbol'] ?? ''),
      market: 'perp',
      client_order_id: String(o['clientOrderId'] ?? ''),
      type: String(o['type'] ?? ''),
      side: String(o['side'] ?? ''),
      qty: String(o['origQty'] ?? '0'),
      price: Number(o['price'] ?? '0') > 0 ? String(o['price']) : null,
      stop_price: Number(o['stopPrice'] ?? '0') > 0 ? String(o['stopPrice']) : null,
      reduce_only: Boolean(o['reduceOnly']) || Boolean(o['closePosition']),
      status: String(o['status'] ?? ''),
    }));
    const algoRows = Array.isArray(algos) ? (algos as Record<string, unknown>[]) : Array.isArray((algos as { orders?: unknown[] })?.orders) ? ((algos as { orders: Record<string, unknown>[] }).orders) : [];
    for (const a of algoRows) {
      open_orders.push({
        symbol: String(a['symbol'] ?? ''),
        market: 'perp',
        client_order_id: String(a['clientAlgoId'] ?? a['clientOrderId'] ?? ''),
        type: String(a['orderType'] ?? a['type'] ?? 'STOP_MARKET'),
        side: String(a['side'] ?? ''),
        qty: String(a['quantity'] ?? a['origQty'] ?? '0'),
        price: null,
        stop_price: Number(a['triggerPrice'] ?? a['stopPrice'] ?? '0') > 0 ? String(a['triggerPrice'] ?? a['stopPrice']) : null,
        reduce_only: Boolean(a['reduceOnly']) || Boolean(a['closePosition']),
        status: String(a['algoStatus'] ?? a['status'] ?? 'NEW'),
      });
    }
    const wallet = Number(acct['totalWalletBalance'] ?? '0');
    const upnl = Number(acct['totalUnrealizedProfit'] ?? '0');
    return { backend: this.kind, equity: (wallet + upnl).toFixed(2), available: Number(acct['availableBalance'] ?? '0').toFixed(2), unrealized_pnl: upnl.toFixed(2), positions, open_orders, as_of: Date.now() };
  }

  private receipt(p: Promise<unknown>): Promise<OrderReceipt> {
    return p.then(
      (r) => {
        const rec = r as Record<string, unknown>;
        const status = String(rec['status'] ?? rec['algoStatus'] ?? '');
        const avg = Number(rec['avgPrice'] ?? '0');
        return { outcome: status === 'FILLED' ? 'filled' : 'submitted', receipt: rec, avg_price: avg > 0 ? avg.toString() : null, error: null } as OrderReceipt;
      },
      (e: unknown) => {
        if (e instanceof CliError) return { outcome: e.ambiguous ? 'unknown' : 'failed', receipt: { kind: e.kind, code: e.code }, avg_price: null, error: e.message } as OrderReceipt;
        return { outcome: 'failed', receipt: null, avg_price: null, error: String(e) } as OrderReceipt;
      },
    );
  }

  async placeEntry(req: EntryRequest): Promise<OrderReceipt> {
    if (req.market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const args = ['futures-usds', 'new-order', '--symbol', req.symbol, '--side', req.direction === 'long' ? 'BUY' : 'SELL', '--type', req.entry === 'market' ? 'MARKET' : 'LIMIT', '--quantity', req.qty, '--new-client-order-id', req.client_order_id, '--new-order-resp-type', 'RESULT'];
    if (req.entry === 'limit') args.push('--price', String(req.limit_price), '--time-in-force', 'GTC');
    if (this.positionSideDual) args.push('--position-side', req.direction.toUpperCase());
    return this.receipt(this.run(args, true, 30_000));
  }

  private closeSide(position: Direction): string {
    return position === 'long' ? 'SELL' : 'BUY';
  }
  private algo(symbol: string, position: Direction, type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', trigger: string, id: string): Promise<OrderReceipt> {
    const args = ['futures-usds', 'new-algo-order', '--algo-type', 'CONDITIONAL', '--symbol', symbol, '--side', this.closeSide(position), '--type', type, '--trigger-price', trigger, '--close-position', 'true', '--working-type', 'MARK_PRICE', '--client-algo-id', id];
    if (this.positionSideDual) args.push('--position-side', position.toUpperCase());
    return this.receipt(this.run(args, true, 30_000));
  }
  placeStop(symbol: string, position: Direction, stop_price: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    return this.algo(symbol, position, 'STOP_MARKET', stop_price, id);
  }
  placeTakeProfit(symbol: string, position: Direction, tp: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    return this.algo(symbol, position, 'TAKE_PROFIT_MARKET', tp, id);
  }

  async closePosition(symbol: string, id: string, market: Market = 'perp'): Promise<{ closed: boolean; receipt: unknown; error: string | null }> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    try {
      const pos = (await this.run(['futures-usds', 'position-information-v3', '--symbol', symbol], true)) as Record<string, unknown>[];
      const row = pos.find((p) => Number(p['positionAmt'] ?? '0') !== 0);
      if (!row) return { closed: false, receipt: null, error: null };
      const amt = Number(row['positionAmt']);
      const args = ['futures-usds', 'new-order', '--symbol', symbol, '--side', amt > 0 ? 'SELL' : 'BUY', '--type', 'MARKET', '--quantity', Math.abs(amt).toString(), '--new-client-order-id', id, '--new-order-resp-type', 'RESULT'];
      if (this.positionSideDual) args.push('--position-side', amt > 0 ? 'LONG' : 'SHORT');
      else args.push('--reduce-only', 'true');
      const r = await this.run(args, true, 30_000);
      return { closed: true, receipt: r, error: null };
    } catch (e) {
      return { closed: false, receipt: null, error: (e as Error).message };
    }
  }

  async reducePosition(symbol: string, qty: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const acct = await this.account();
    const pos = acct.positions.find((p) => p.symbol === symbol);
    if (!pos) return { outcome: 'failed', receipt: null, avg_price: null, error: 'no position' };
    const args = ['futures-usds', 'new-order', '--symbol', symbol, '--side', this.closeSide(pos.side), '--type', 'MARKET', '--quantity', qty, '--new-client-order-id', id, '--new-order-resp-type', 'RESULT'];
    if (this.positionSideDual) args.push('--position-side', pos.side.toUpperCase());
    else args.push('--reduce-only', 'true');
    return this.receipt(this.run(args, true, 30_000));
  }

  async cancelAll(symbol: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const errors: string[] = [];
    for (const cmd of ['cancel-all-open-orders', 'cancel-all-algo-open-orders']) {
      try {
        await this.run(['futures-usds', cmd, '--symbol', symbol], true);
      } catch (e) {
        if (!(e instanceof CliError && e.kind === 'rejected')) errors.push(`${cmd}: ${(e as Error).message}`);
      }
    }
    return { ok: errors.length === 0, error: errors.join('; ') || null };
  }

  async cancelOrder(symbol: string, client_order_id: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    try {
      await this.run(['futures-usds', 'cancel-order', '--symbol', symbol, '--orig-client-order-id', client_order_id], true);
      return { ok: true, error: null };
    } catch (e) {
      const gone = (x: unknown): boolean => x instanceof CliError && x.kind === 'rejected' && (x.code === -2011 || x.code === -2013 || /-201[13]\b/.test(x.message));
      if (e instanceof CliError && e.kind === 'rejected') {
        try {
          await this.run(['futures-usds', 'cancel-algo-order', '--client-algo-id', client_order_id], true);
          return { ok: true, error: null };
        } catch (e2) {
          if (gone(e2)) return { ok: false, error: `cancel unknown: ${(e2 as Error).message}` }; // absence is not zero-fill proof
          return { ok: false, error: (e2 as Error).message };
        }
      }
      return { ok: false, error: (e as Error).message };
    }
  }

  async getOrder(symbol: string, client_order_id: string, _fresh = false, market: Market = 'perp'): Promise<OrderStatusView | null> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    try {
      const raw = (await this.run(['futures-usds', 'query-order', '--symbol', symbol, '--orig-client-order-id', client_order_id], true)) as Record<string, unknown>;
      const avg = Number(raw['avgPrice'] ?? '0');
      return { status: String(raw['status'] ?? ''), avg_price: avg > 0 ? avg.toString() : null, executed_qty: String(raw['executedQty'] ?? ''), raw };
    } catch (e) {
      if (e instanceof CliError && e.kind === 'rejected') return null; // -2013 order does not exist
      throw e;
    }
  }

  tick(): PaperEvent[] {
    return [];
  }
}
