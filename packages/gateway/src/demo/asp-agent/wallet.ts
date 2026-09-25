/** Subscription-fee wallet view only; secrets and signing remain inside the official CLI. */
import { readFile, stat } from 'node:fs/promises';
import { MarketCli, data, object } from './cli.js';
export interface MarketWalletView { logged_in: boolean; email: string | null; account_name: string | null; address: string | null; chain: 'xlayer'; balance_usdt: string | null; deposit_address: string | null; checked_at: number; }
export const XLAYER_USDT = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const str = (v: unknown) => typeof v === 'string' ? v : null;
/** Walk platform balance/address envelopes without exposing account policy or credentials. */
function records(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.flatMap(records);
  const o = object(v); return Object.keys(o).length ? [o, ...Object.values(o).filter((x) => x && typeof x === 'object').flatMap(records)] : [];
}
export class MarketWallet {
  private cached: MarketWalletView | null = null;
  constructor(private readonly cli: MarketCli) {}
  invalidate() { this.cached = null; }
  async status(fresh = false): Promise<MarketWalletView> {
    if (!fresh && this.cached && Date.now() - this.cached.checked_at < 30000) return this.cached;
    const state = data(await this.cli.json(['wallet', 'status']));
    const view: MarketWalletView = { logged_in: state['loggedIn'] === true, email: str(state['email']), account_name: str(state['currentAccountName'] ?? state['accountName']), address: null, chain: 'xlayer', balance_usdt: null, deposit_address: null, checked_at: Date.now() };
    if (view.logged_in) {
      const [addresses, balance] = await Promise.all([this.cli.json(['wallet', 'addresses', '--chain', 'xlayer']), this.cli.json(['wallet', 'balance', '--chain', 'xlayer'])]);
      const address = records(addresses).map((x) => str(x['address'] ?? x['walletAddress'])).find((x) => x && /^0x[0-9a-f]{40}$/i.test(x)) ?? null;
      view.address = address; view.deposit_address = address;
      // XLayer 上的 USDT 在 CLI 里叫 USD₮0(tokenAddress 0x779d…3736),按归一化符号或合约地址都认。
      const usdt = (x: Record<string, unknown>) => String(x['symbol'] ?? x['tokenSymbol'] ?? '').toUpperCase().replace('₮', 'T').replace(/0$/, '') === 'USDT' || String(x['tokenAddress'] ?? '').toLowerCase() === XLAYER_USDT;
      const token = records(balance).find(usdt);
      const amount = token?.['balance'] ?? token?.['amount'];
      view.balance_usdt = typeof amount === 'string' && /^\d+(?:\.\d+)?$/.test(amount) ? amount : null;
    }
    this.cached = view; return view;
  }
  async depositNotice() {
    const wallet = await this.status();
    if (!wallet.logged_in || !wallet.deposit_address) throw Object.assign(new Error('请先登录并取得 XLayer 充值地址'), { status: 409 });
    const notice = data(await this.cli.call('funding-notice', ['--chain', 'xlayer', '--currency', 'USDT', '--shortfall', '0', '--deposit-address', wallet.deposit_address, '--format', 'json']));
    let qr: string | null = typeof notice['qr_base64'] === 'string' ? notice['qr_base64'] : null;
    const path = notice['imagePath'];
    if (!qr && typeof path === 'string') {
      const info = await stat(path); if (info.isFile() && info.size <= 2 * 1024 * 1024) {
        const bytes = await readFile(path);
        if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) qr = bytes.toString('base64');
      }
    }
    return { chain: 'xlayer', currency: 'USDT', deposit_address: wallet.deposit_address, qr_base64: qr, mime_type: 'image/png' };
  }
}
