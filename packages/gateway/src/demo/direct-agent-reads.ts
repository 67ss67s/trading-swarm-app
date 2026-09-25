import { spawn } from 'node:child_process';

export interface ReadState { get(key: string): string | null; set(key: string, value: string): void }
export interface BridgeResult { namespace: string; observed_at?: number; data?: unknown }
export type ReadBridge = (request: Record<string, unknown>) => Promise<BridgeResult>;
export function rustReadBridge(binary: string): ReadBridge {
  return (request) => new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = ''; let finished = false;
    const finish = (error?: Error, value?: BridgeResult) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('只读 MCP 超时；未调用模型')); }, 120_000);
    child.on('error', () => finish(new Error('零模型读取组件不可用（TG_DIRECT_READ_BIN 未配置或不可执行）；不会回退到模型')));
    child.stdout.on('data', (b) => { out += String(b); if (out.length > 16_000_000) { child.kill(); finish(new Error('只读响应过大')); } });
    child.stdin.on('error', () => {});
    child.on('close', () => {
      try {
        const v = JSON.parse(out);
        if (!v.ok || !v.result?.namespace) return finish(new Error(`只读 MCP 失败：${String(v.error ?? 'invalid_response')}；请检查只读桥的币安登录`));
        finish(undefined, v.result);
      } catch { finish(new Error('只读 MCP 响应格式错误；未调用模型')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

type Row = Record<string, unknown>;
const row = (v: unknown): Row => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('只读响应缺少对象'); return v as Row; };
const list = (v: unknown): Row[] => { if (!Array.isArray(v)) throw new Error('只读响应缺少完整列表'); return v.map(row); };
const dec = (v: unknown): string => { if (typeof v !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(v)) throw new Error('只读金额字段缺失或格式错误'); return v; };
const str = (v: unknown): string => { if (typeof v !== 'string' || !v) throw new Error('只读标识字段缺失'); return v; };
const integer = (v: unknown): number => { const n = Number(v); if ((typeof v !== 'number' && (typeof v !== 'string' || !/^-?\d+$/.test(v))) || !Number.isSafeInteger(n)) throw new Error('只读整数字段缺失'); return n; };
function sumDecimals(values: string[]): string {
  const scale = Math.max(0, ...values.map(v => (v.split('.')[1] ?? '').length));
  const n = values.reduce((a,v) => { const negative = v.startsWith('-'); const [whole, fraction = ''] = v.replace(/^-/, '').split('.'); return a + BigInt(`${whole}${fraction.padEnd(scale, '0')}`) * (negative ? -1n : 1n); }, 0n);
  const abs = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  return `${n < 0n ? '-' : ''}${scale ? `${abs.slice(0, -scale)}.${abs.slice(-scale)}` : abs}`;
}
function order(o: Row, algo = false): Row {
  const stop = o[algo ? 'triggerPrice' : 'stopPrice']; const price = o.price;
  return { symbol: str(o.symbol), client_order_id: str(o[algo ? 'clientAlgoId' : 'clientOrderId']), type: str(o[algo ? 'orderType' : 'type']), side: str(o.side), qty: dec(o[algo ? 'quantity' : 'origQty'] ?? (o.closePosition === true ? '0' : undefined)), price: price == null || Number(price) === 0 ? null : dec(price), stop_price: stop == null || Number(stop) === 0 ? null : dec(stop), reduce_only: o.reduceOnly === true || o.closePosition === true, status: str(o[algo ? 'algoStatus' : 'status']) };
}
function account(data: unknown): Row {
  const v = row(data), a = row(v.account);
  const positions = list(v.positions).filter(p => Number(dec(p.positionAmt)) !== 0).map(p => ({ symbol: str(p.symbol), side: p.positionSide === 'SHORT' || Number(p.positionAmt) < 0 ? 'short' : 'long', qty: dec(p.positionAmt).replace(/^-/, ''), entry_price: dec(p.entryPrice), mark_price: dec(p.markPrice), unrealized_pnl: dec(p.unRealizedProfit), leverage: integer(p.leverage) }));
  return { equity: dec(a.totalMarginBalance), available: dec(a.availableBalance), unrealized_pnl: dec(a.totalUnrealizedProfit), positions, open_orders: [...list(v.orders).map(o => order(o)), ...list(v.algos).map(o => order(o, true))] };
}
const READ_OPS = new Set(['account', 'settlement', 'get_order', 'get_leverage', 'list_algo_orders', 'query_algo_orders']);
export const isDirectRead = (op: unknown): boolean => READ_OPS.has(String(op));
type Cached = { namespace: string; at: number; observed_at: number; data: unknown; covered_end?: number };

/** Only deterministic reads. No model fallback, even when auth/network/schema validation fails. */
export class DirectAgentReads {
  private pending = new Map<string, Promise<Cached>>();
  calls = 0; hits = 0;
  constructor(private readonly bridge: ReadBridge, private readonly state: ReadState, private readonly now = Date.now) {}
  private load(key: string): Cached | null { try { return JSON.parse(this.state.get(key) ?? 'null'); } catch { return null; } }
  private async fetch(namespace: string, key: string, request: Row, ttl: number, requiredEnd?: number): Promise<Cached> {
    const full = `direct-read:v1:${namespace}:${key}`;
    const cache = this.load(full);
    if (cache?.namespace === namespace && (requiredEnd === undefined || (cache.covered_end ?? -1) >= requiredEnd) && cache.at <= this.now() && this.now() - cache.at < ttl) { this.hits++; return cache; }
    const pendingKey = `${full}:${request.end_ms ?? ''}`;
    const old = this.pending.get(pendingKey); if (old) return old;
    const p = (async () => {
      this.calls++;
      const result = await this.bridge(request);
      if (result.namespace !== namespace) throw new Error('币安授权发生变化，请重新读取');
      const observed_at = integer(result.observed_at);
      const value = { namespace, at: this.now(), observed_at, data: result.data, ...(typeof request.end_ms === 'number' ? { covered_end: request.end_ms } : {}) };
      // Validated only by the caller; never persist a response until normalization succeeds.
      return value;
    })().finally(() => { this.pending.delete(pendingKey); });
    this.pending.set(pendingKey, p); return p;
  }
  private save(namespace: string, key: string, v: Cached): void { this.state.set(`direct-read:v1:${namespace}:${key}`, JSON.stringify(v)); }
  invalidateAccount(): void {
    const key = 'direct-read:account-generation';
    this.state.set(key, String(Number(this.state.get(key) ?? 0) + 1));
  }
  async run(task: Row): Promise<Row> {
    const op = String(task.op);
    if (!isDirectRead(op)) throw new Error('不允许的只读操作');
    const { namespace } = await this.bridge({ op: 'status' });
    if (op === 'settlement') return this.settlement(namespace, task);
    const request = { op, ...(task.symbol ? { symbol: task.symbol } : {}), ...(task.client_order_id ? { client_order_id: task.client_order_id } : {}) };
    const key = JSON.stringify(request) + (op === 'account' ? `:generation:${this.state.get('direct-read:account-generation') ?? '0'}` : '');
    // Keep execution-sensitive order reads fresh; account snapshot keeps original observation time.
    const v = await this.fetch(namespace, key, request, op === 'account' ? 15_000 : 0);
    let out: Row;
    if (op === 'account') out = { ok: true, account: account(v.data), observed_at: v.observed_at };
    else if (op === 'get_order') {
      if (v.data === null) return { ok: true, order: null };
      const o = row(v.data);
      out = { ok: true, order: { status: str(o.status), executed_qty: dec(o.executedQty), avg_price: o.avgPrice == null ? null : dec(o.avgPrice), raw: o } };
    } else if (op === 'get_leverage') {
      const p = list(v.data).find(p => p.symbol === task.symbol); if (!p) throw new Error('杠杆读取缺少目标合约');
      out = { ok: true, symbol: task.symbol, leverage: integer(p.leverage) };
    } else {
      const orders = list(v.data).map(o => order(o, true));
      out = op === 'list_algo_orders' ? { ok: true, orders: orders.map(o => ({ client_algo_id: o.client_order_id, algo_id: null })) } : { ok: true, found: orders.some(o => o.client_order_id === task.client_algo_id) };
    }
    if (op === 'account') this.save(namespace, key, v);
    return out;
  }
  private async settlement(namespace: string, task: Row): Promise<Row> {
    const start = integer(task.start_ms), end = integer(task.end_ms), symbol = str(task.symbol);
    if (end > this.now()) throw new Error('结算窗口尚未结束，稍后重试');
    if (start < 0 || end < start || end-start > 31*86400_000) throw new Error('结算时间范围错误');
    const trades = new Map<string, Row>(), funding = new Map<string, Row>();
    const day = 86400_000;
    for (let from = Math.floor(start/day)*day; from <= end; from += day) {
      const to = Math.min(from+day-1, this.now());
      if (to < from) throw new Error('不能读取未来结算');
      const key = `settlement:${symbol}:${from}`;
      const v = await this.fetch(namespace, key, { op: 'settlement', symbol, start_ms: from, end_ms: to }, task.force_refresh === true ? 0 : to < this.now()-day ? 6*3600_000 : 5*60_000, Math.min(end, from+day-1));
      const data = row(v.data);
      for (const r of list(data.trades)) {
        if (r.symbol !== symbol || r.commissionAsset !== 'USDT') throw new Error('成交合约或手续费币种不匹配');
        const time = integer(r.time); const id = str(String(r.id ?? ''));
        const normalized = { id, order_id: r.orderId == null ? null : String(r.orderId), time, side: str(r.side), price: dec(r.price), qty: dec(r.qty), realized_pnl: dec(r.realizedPnl), commission: dec(r.commission), position_side: r.positionSide ?? null };
        if (time >= start && time <= end) trades.set(`${symbol}:${id}`, normalized);
      }
      for (const r of list(data.funding)) {
        if (r.symbol !== symbol || r.incomeType !== 'FUNDING_FEE' || r.asset !== 'USDT') throw new Error('资金费合约或币种不匹配');
        const time = integer(r.time), id = str(String(r.tranId ?? '')); const income = dec(r.income);
        if (time >= start && time <= end) funding.set(`${symbol}:${id}`, { time, income });
      }
      this.save(namespace, key, v);
    }
    return { ok: true, trades: [...trades.values()], funding: [...funding.values()], funding_total: sumDecimals([...funding.values()].map(v => String(v.income))) };
  }
}
