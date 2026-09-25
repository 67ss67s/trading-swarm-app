/** 钱包只通过官方 CLI 访问；不读取或返回登录凭证。 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultOkxSpawn, type OkxSpawnFn, type OkxRunResult } from './execution-okx.js';

export function walletCli(): string {
  const local = join(homedir(), '.local/bin/onchainos');
  return existsSync(local) ? local : 'onchainos';
}
export interface WalletView {
  installed: boolean; cli: string; logged_in: boolean; email: string | null;
  login_type: string | null; account_name: string | null; account_id: string | null; checked_at: number;
}
export function cliData(r: OkxRunResult): Record<string, unknown> {
  // 不传播 CLI 原始错误，登录响应可能包含 session token。
  if (r.code !== 0 || r.timedOut || r.spawnError) throw new Error('CLI 调用失败或超时');
  let body;
  try { body = JSON.parse(r.stdout); } catch { throw new Error('CLI 返回无效 JSON'); }
  if (body?.ok !== true || !body.data || typeof body.data !== 'object') throw new Error('CLI 未返回成功状态');
  return body.data;
}
const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
/** 地址按「一把私钥一行」归并:EVM 全链同一个地址,只显示一次 + 链数;BTC/SOL/SUI/X Layer 各一行。 */
export interface WalletAddressRow { family: string; address: string; chains: string[] }
export interface WalletAsset { chain: string | null; symbol: string; balance: string; value_usd: string | null }
export interface WalletAssetsView {
  logged_in: boolean;
  addresses: WalletAddressRow[];
  total_value_usd: string | null;
  assets: WalletAsset[];
  updated_at: number | null;
  checked_at: number;
}
const num = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
/** `wallet addresses` 的 data:{accountId, accountName, bitcoin:[{address,chainName}], evm:[...], solana:[...], ...}。 */
export function parseWalletAddresses(d: Record<string, unknown>): WalletAddressRow[] {
  const out: WalletAddressRow[] = [];
  for (const [family, rows] of Object.entries(d)) {
    if (!Array.isArray(rows)) continue;
    const byAddr = new Map<string, string[]>();
    for (const r of rows as Record<string, unknown>[]) {
      const addr = str(r['address']); if (!addr) continue;
      const chains = byAddr.get(addr) ?? []; chains.push(str(r['chainName']) ?? str(r['chainIndex']) ?? '?'); byAddr.set(addr, chains);
    }
    for (const [address, chains] of byAddr) out.push({ family, address, chains });
  }
  // 常用的排前面
  const order = ['evm', 'bitcoin', 'solana', 'sui', 'xlayer'];
  const rank = (f: string): number => { const i = order.indexOf(f); return i === -1 ? 99 : i; };
  return out.sort((a, b) => rank(a.family) - rank(b.family));
}
/** `wallet balance --all` 的 data:{details:{<accountId>:{data:[{tokenAssets:[...]}], total_value_usd, updated_at}}, totalValueUsd}。tokenAssets 字段名按几种常见写法兜底。 */
export function parseWalletBalance(d: Record<string, unknown>): { total_value_usd: string | null; assets: WalletAsset[]; updated_at: number | null } {
  const assets: WalletAsset[] = [];
  let updated: number | null = null;
  const details = (d['details'] ?? {}) as Record<string, Record<string, unknown>>;
  for (const acct of Object.values(details)) {
    const u = Number(acct['updated_at']); if (Number.isFinite(u) && u > 0) updated = u > 1e12 ? u : u * 1000;
    for (const blk of (Array.isArray(acct['data']) ? acct['data'] : []) as Record<string, unknown>[]) {
      for (const t of (Array.isArray(blk['tokenAssets']) ? blk['tokenAssets'] : []) as Record<string, unknown>[]) {
        const symbol = str(t['symbol']) ?? str(t['tokenSymbol']) ?? str(t['tokenName']); if (!symbol) continue;
        assets.push({ chain: str(t['chainName']) ?? str(t['chain']) ?? num(t['chainIndex']), symbol, balance: num(t['balance']) ?? num(t['amount']) ?? '0', value_usd: num(t['balanceUsd']) ?? num(t['valueUsd']) ?? num(t['value_usd']) ?? num(t['usdValue']) });
      }
    }
  }
  assets.sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
  return { total_value_usd: num(d['totalValueUsd']) ?? num(d['total_value_usd']), assets, updated_at: updated };
}
export class WalletStatus {
  private cachedAssets: WalletAssetsView | null = null;
  /** 地址 + 余额(两趟只读 CLI,缓存 60s)。没登录直接回空,不起 CLI。 */
  async assets(refresh = false): Promise<WalletAssetsView> {
    if (!refresh && this.cachedAssets && this.now() - this.cachedAssets.checked_at < 60_000) return this.cachedAssets;
    const st = await this.status(refresh);
    const view: WalletAssetsView = { logged_in: st.logged_in, addresses: [], total_value_usd: null, assets: [], updated_at: null, checked_at: this.now() };
    if (st.logged_in) {
      const [a, b] = await Promise.all([
        this.run(this.bin(), ['wallet', 'addresses'], 20_000).then(cliData).catch(() => null),
        this.run(this.bin(), refresh ? ['wallet', 'balance', '--all', '--force'] : ['wallet', 'balance', '--all'], 30_000).then(cliData).catch(() => null),
      ]);
      if (a) view.addresses = parseWalletAddresses(a);
      if (b) Object.assign(view, parseWalletBalance(b));
    }
    this.cachedAssets = view;
    return view;
  }
  private polls = new Map<string, { promise: Promise<WalletView | { pending: true; error: string }>; controller: AbortController }>();
  private cached: WalletView | null = null;
  constructor(private run: OkxSpawnFn = defaultOkxSpawn, private bin: () => string = walletCli, private now = Date.now) {}
  async status(refresh = false): Promise<WalletView> {
    if (!refresh && this.cached && this.now() - this.cached.checked_at < 30_000) return this.cached;
    const cli = this.bin();
    const view: WalletView = { installed: false, cli, logged_in: false, email: null, login_type: null, account_name: null, account_id: null, checked_at: this.now() };
    try {
      const r = await this.run(cli, ['wallet', 'status'], 15_000);
      view.installed = !r.spawnError;
      const d = cliData(r);
      view.logged_in = d.loggedIn === true;
      view.email = str(d.email); view.login_type = str(d.loginType);
      view.account_name = str(d.currentAccountName); view.account_id = str(d.currentAccountId);
    } catch { /* 状态探测失败时灯为灰色，绝不透出 CLI 原文。 */ }
    this.cached = view;
    return view;
  }
  async login(): Promise<{ url: string; session_id: string }> {
    const d = cliData(await this.run(this.bin(), ['wallet', 'login', '--phase', 'init'], 20_000));
    if (typeof d.loginUrl !== 'string' || typeof d.authSessionId !== 'string' || !d.authSessionId) throw new Error('登录响应缺少 URL/session id');
    const url = new URL(d.loginUrl);
    if (url.protocol !== 'https:') throw new Error('登录 URL 必须使用 HTTPS');
    return { url: d.loginUrl, session_id: d.authSessionId };
  }
  poll(session: unknown, signal?: AbortSignal): Promise<WalletView | { pending: true; error: string }> {
    if (typeof session !== 'string' || !session.trim() || session.length > 1024 || session.startsWith('-')) return Promise.reject(new Error('session_id 必须为非空字符串'));
    const existing = this.polls.get(session);
    const connectAbort = (entry: { promise: Promise<WalletView | { pending: true; error: string }>; controller: AbortController }) => {
      if (signal) {
        const abort = () => entry.controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        void entry.promise.then(() => signal.removeEventListener('abort', abort), () => signal.removeEventListener('abort', abort));
      }
      return entry.promise;
    };
    if (existing) return connectAbort(existing);
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    const pending = (async () => {
      try {
        cliData(await this.run(this.bin(), ['wallet', 'login', '--phase', 'poll', '--session-id', session], 60_000, { signal: controller.signal }));
        this.cached = null;
        return await this.status(true);
      } catch {
        return { pending: true as const, error: '钱包登录尚未确认，请重试' };
      } finally { this.cached = null; }
    })().finally(() => { this.polls.delete(session); });
    const entry = { promise: pending, controller };
    this.polls.set(session, entry);
    return connectAbort(entry);
  }
  async logout(): Promise<WalletView> {
    // logout 成功时 CLI 只回 {"ok":true}(没有 data),不能套 cliData 的「必须有 data」口径——
    // 否则登出明明成功了,界面却报「CLI 未返回成功状态」(2026-09-20 用户实测)。只认退出码和 ok:false。
    try {
      const r = await this.run(this.bin(), ['wallet', 'logout'], 20_000);
      if (r.code !== 0 || r.timedOut || r.spawnError) throw new Error('CLI 调用失败或超时');
      let ok = true;
      try { ok = (JSON.parse(r.stdout) as { ok?: unknown })?.ok !== false; } catch { /* 非 JSON 输出按退出码算 */ }
      if (!ok) throw new Error('登出失败');
    } finally { this.cached = null; this.cachedAssets = null; }
    return this.status(true);
  }
}
export const walletStatus = new WalletStatus();
