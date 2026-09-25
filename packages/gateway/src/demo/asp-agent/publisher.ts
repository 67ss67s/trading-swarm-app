import type { StrategyThread } from '../types.js';
import { settlementCompleteness } from '../judgment-ledger.js';
import type { DemoStore } from '../store.js';
import { symbolToInstId } from '../okx/instruments.js';
import { CliError, MarketCli, data, list } from './cli.js';
import type { PublisherSettings } from './settings.js';
import { captainHandoff, startAspRun, summarizeJudgmentForAnalysis } from './audit.js';
export interface PublishEvent {
  event_id: string; kind: 'entry_filled' | 'thread_closed' | 'sl_hit' | 'tp_hit' | 'reduce_filled' | 'decision_record' | 'strategy_signal';
  signal_time: number; symbol: string; direction: 'long' | 'short' | 'flat'; price: string | null;
  stop_loss: string | null; take_profit: string[]; reason: string; thread_id: string | null;
  realized_r: string | null; backend: string; paper: boolean; transport?: string; confidence?: number; reduce_pct?: string; exit_reason?: string;
  strategy?: { id: string; name: string; version: number; timeframe: string; run_id: string };
  market?: 'spot' | 'perp'; leverage?: number; traded?: boolean; entry_type?: 'next_open_market' | 'limit'; take_profit_sizes?: number[]; valid_until?: number; signal_only?: boolean;
}
export const BANNED_WORDS = /保证|稳赚|必赚|保本|零风险|guaranteed|risk[\s-]*free|no[\s-]*risk|sure[\s-]*profit/i;
export function renderDeliverable(e: PublishEvent, settings: PublisherSettings) {
  const analysis = !e.signal_only && (e.paper || e.backend === 'paper' || e.kind === 'decision_record');
  const action = e.kind === 'entry_filled' || e.kind === 'decision_record' || e.kind === 'strategy_signal' ? e.direction === 'long' ? 'LONG' : e.direction === 'short' ? 'SHORT' : 'FLAT' : e.kind === 'reduce_filled' ? 'REDUCE' : 'CLOSE';
  const payload = { deliveryId: `tg_${e.event_id}`, signal_type: analysis ? 'analysis' : 'order', signalTime: e.signal_time,
    symbol: symbolToInstId(e.symbol, e.market), action, price: e.price, stop_loss: e.stop_loss, take_profit: e.take_profit, leverage: e.leverage ?? null, sz: null,
    valid_until: e.valid_until ?? e.signal_time + 180_000, is_executable: !analysis, ...(analysis ? { can_enter: false } : {}),
    ...(e.strategy ? { strategy: e.strategy, market: e.market, traded: e.traded, ...(e.entry_type ? { entry_type: e.entry_type } : {}), ...(e.take_profit_sizes ? { take_profit_sizes: e.take_profit_sizes } : {}) } : {}),
    reason: summarizeJudgmentForAnalysis(e.reason), source: 'trading-swarm', thread_id: e.thread_id, realized_r: settings.include_realized_pnl ? e.realized_r : null,
    backend: e.backend, paper: e.paper || e.backend === 'paper', ...(action === 'CLOSE' ? { exit_reason: e.exit_reason ?? e.reason } : {}), ...(action === 'REDUCE' ? { reduce_pct: e.reduce_pct ?? '50' } : {}) };
  // OKX.AI 订阅信号规范:以【Futures】/【Spot】等类型头开头、字段顺序固定、只含一个具体价格、≤200 字;
  // 买方 agent 靠类型头判断能否执行,所以分析/纸面类一律发「Service message」而不带类型头。完整结构化字段留在 payload(投递账本)。
  const text = formatSignalText(e);
  return { payload, text };
}
export const SIGNAL_MAX_CHARS = 200;
/** 官方订阅信号类型头(中英)。 */
export const SIGNAL_HEADERS = ['【Spot】', '【Futures】', '【Prediction】', '【Options】', '【DeFi】', '【现货】', '【合约】', '【预测市场】', '【期权】'];
/** 订阅交付文本合规检查:可执行信号以类型头开头,非可执行消息以「Service message:」开头;≤200 字;无收益保证词。 */
export function validateSignalText(text: string): { ok: boolean; executable: boolean; errors: string[] } {
  const t = text.trim(); const errors: string[] = [];
  const executable = SIGNAL_HEADERS.some((h) => t.startsWith(h));
  if (!executable && !t.startsWith('Service message:')) errors.push('必须以【Futures】/【Spot】等类型头或「Service message:」开头');
  if ([...t].length > SIGNAL_MAX_CHARS) errors.push(`超过 ${SIGNAL_MAX_CHARS} 字`);
  if (!t) errors.push('空文本');
  if (BANNED_WORDS.test(t)) errors.push('包含收益保证词');
  return { ok: errors.length === 0, executable, errors };
}
/** 把一条发布事件格式化成订阅交付文本(可执行 → 规范信号行;分析/纸面/FLAT → Service message)。now 用于按剩余有效期写「Valid for」。 */
export function formatSignalText(e: PublishEvent, now: number = e.signal_time): string {
  const analysis = !e.signal_only && (e.paper || e.backend === 'paper' || e.kind === 'decision_record');
  const action = e.kind === 'entry_filled' || e.kind === 'decision_record' || e.kind === 'strategy_signal' ? e.direction === 'long' ? 'LONG' : e.direction === 'short' ? 'SHORT' : 'FLAT' : e.kind === 'reduce_filled' ? 'REDUCE' : 'CLOSE';
  if (analysis || action === 'FLAT') return serviceMessage(`${symbolToInstId(e.symbol, e.market)} ${action}${e.paper || e.backend === 'paper' ? ' · Paper' : ''} · 分析 / Analysis: ${summarizeJudgmentForAnalysis(e.reason)}`);
  return signalLine(e, action, now);
}
const clip = (s: string, n = SIGNAL_MAX_CHARS) => [...s].length <= n ? s : `${[...s].slice(0, n - 1).join('')}…`;
/** 非可执行的服务消息(官方参考实现 sig_text 同款前缀),≤200 字。 */
export function serviceMessage(body: string): string { return clip(`Service message: Trading Swarm · ${body.replace(/\s+/g, ' ').trim()}`); }
function validFor(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 120 ? `${m}min` : `${Math.round(m / 60)}h`;
}
/** 可执行信号的一行规范文本。now 用于重发旧信号时按剩余有效期计算「Valid for」。 */
export function signalLine(e: PublishEvent, action: string, now: number): string {
  const spot = e.market === 'spot';
  const inst = symbolToInstId(e.symbol, e.market);
  const limit = e.entry_type === 'limit';
  const price = e.price ? `${limit ? 'Limit | Order Price' : 'Market | Reference Price'} ${e.price}${spot ? ' USDT' : ''}` : 'Market';
  const risk = [e.stop_loss ? `Stop Loss ${e.stop_loss}` : null, e.take_profit[0] ? `Take Profit ${e.take_profit[0]}` : null];
  const until = e.valid_until ?? e.signal_time + 180_000;
  const valid = `Valid for ${validFor(until - now)}`;
  const side = e.direction === 'short' ? 'SHORT' : 'LONG';
  let fields: (string | null)[];
  if (action === 'CLOSE' || action === 'REDUCE') {
    const verb = action === 'CLOSE' ? 'CLOSE' : `REDUCE ${e.reduce_pct ?? '50'}%`;
    fields = spot ? [`【Spot】OKX`, inst, action === 'CLOSE' ? 'SELL ALL' : `SELL ${e.reduce_pct ?? '50'}%`, e.price ? `Market | Reference Price ${e.price} USDT` : 'Market', valid]
      : [`【Futures】${inst}`, `${verb} ${side}`, e.price ? `Market | Reference Price ${e.price}` : 'Market', valid];
  } else fields = spot ? [`【Spot】OKX`, inst, e.direction === 'short' ? 'SELL' : 'BUY', price, ...risk, valid]
    : [`【Futures】${inst}`, `${side} ${e.leverage ?? 1}x`, price, ...risk, valid];
  const line = fields.filter(Boolean).join(' | ');
  const tagged = `${line} | Trading Swarm${e.strategy ? ` ${e.strategy.name} ${e.strategy.timeframe}` : ''}`;
  return [...tagged].length <= SIGNAL_MAX_CHARS ? tagged : clip(line);
}
export class MarketPublisher {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: { store: DemoStore; cli: MarketCli; settings: () => PublisherSettings; aspId: () => Promise<string>; emit: (event: string, payload: unknown) => void }) {
    // Interrupted sends are unknown, never automatically replayed. Explicit retry remains available.
    this.db.prepare("UPDATE okx_market_delivery_out_job SET status='failed',error='进程中断，投递结果未知；人工核实后可重发',updated_at=? WHERE status='pending'").run(Date.now());
  }
  private get db() { return this.deps.store.marketDb; }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p; }
  async stop(): Promise<void> { await this.chain; }
  publish(event: PublishEvent, opts: { strategy_run?: boolean } = {}) { const frozen = structuredClone(event); return this.serial(() => this.publishInner(frozen, opts.strategy_run === true && !!frozen.strategy)); }
  private async publishInner(e: PublishEvent, strategyRun = false): Promise<unknown> {
    const s = this.deps.settings();
    if ((!s.enabled && !strategyRun) || e.transport === 'okx_asp') return null;
    if (this.db.prepare('SELECT 1 FROM okx_market_delivery_out WHERE event_id=?').get(e.event_id)) return this.get(e.event_id);
    const backend = e.backend === 'paper' ? 'paper' : e.backend.startsWith('okx') ? 'okx' : 'binance';
    const analysis = !e.signal_only && (e.paper || backend === 'paper' || e.kind === 'decision_record');
    if (!strategyRun && (!s.backend_filter.includes(backend) || (analysis ? !s.publish_analysis : !s.publish_orders) || (s.symbols.length && !s.symbols.includes(e.symbol)) || (s.min_confidence !== undefined && (e.confidence ?? 0) < s.min_confidence))) return null;
    if (e.kind === 'decision_record' && e.thread_id) return null;
    const { payload, text } = renderDeliverable(e, s);
    let refusal: string | null = BANNED_WORDS.test(text) || BANNED_WORDS.test(e.reason) ? '敏感词拦截:禁止收益保证' : null;
    let asp = ''; let subscribers: string[] = [];
    if (!refusal) {
      try { asp = await this.deps.aspId(); subscribers = [...new Set(list(await this.deps.cli.call('subscribe-active', ['--agent-id', asp])).map((x) => String(x['jobId'] ?? x['job_id'] ?? '')).filter(Boolean))]; }
      catch (err) { refusal = `订阅者集合获取失败:${(err as Error).message}`; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO okx_market_delivery_out VALUES (?,?,?,?,?,?,?,?)').run(e.event_id, Date.now(), JSON.stringify(e), JSON.stringify(subscribers), text, JSON.stringify(payload), asp, refusal);
      // Explicit column list avoids schema-order coupling.
      for (const job of subscribers) this.db.prepare("INSERT INTO okx_market_delivery_out_job(event_id,job_id,status,updated_at) VALUES (?,?,'pending',?)").run(e.event_id, job, Date.now());
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    const run = startAspRun(this.deps.store, 'asp_publish', { event: e, subscribers }, `asp_publish:${e.event_id}`);
    for (const job of subscribers) await this.send(e.event_id, job, asp, text, false);
    const jobs = this.jobs(e.event_id);
    const failed = jobs.filter((x) => x['status'] === 'failed').length;
    this.deps.store.bots.finishRun(run, { status: refusal || failed ? 'failed' : 'done', error: refusal, result: { jobs, refusal } });
    if (failed > subscribers.length / 2) captainHandoff(this.deps.store, `publish:${e.event_id}`, '信号投递失败超过一半', { event_id: e.event_id, jobs });
    const result = this.get(e.event_id); this.deps.emit('market_publish', result); return result;
  }
  private async send(event: string, job: string, asp: string, text: string, retry: boolean) {
    const claim = this.db.prepare(`UPDATE okx_market_delivery_out_job SET status='pending',attempts=attempts+1,updated_at=? WHERE event_id=? AND job_id=? AND status=? AND ${retry ? '1=1' : 'attempts=0'}`).run(Date.now(), event, job, retry ? 'failed' : 'pending');
    if (!claim.changes) return;
    try {
      const result = await this.deps.cli.call('deliver', [job, '--deliverable-text', text, '--agent-id', asp]);
      this.db.prepare("UPDATE okx_market_delivery_out_job SET status='delivered',error=NULL,result_json=?,updated_at=? WHERE event_id=? AND job_id=?").run(JSON.stringify(data(result)), Date.now(), event, job);
    } catch (err) {
      // deliver 成功时 CLI 可能只退出 0、不打 JSON(cli_invalid_json 只在 exit 0 时出现):按已投递记。
      if (err instanceof CliError && err.code === 'cli_invalid_json') { this.db.prepare("UPDATE okx_market_delivery_out_job SET status='delivered',error=NULL,result_json=?,updated_at=? WHERE event_id=? AND job_id=?").run(JSON.stringify({ exit: 0, stdout: err.raw_message.slice(0, 500) }), Date.now(), event, job); return; }
      this.db.prepare("UPDATE okx_market_delivery_out_job SET status='failed',error=?,updated_at=? WHERE event_id=? AND job_id=?").run((err as Error).message, Date.now(), event, job);
    }
  }
  retry(event: string, job?: string) { return this.serial(async () => {
    const row = this.db.prepare('SELECT * FROM okx_market_delivery_out WHERE event_id=?').get(event);
    if (!row) throw Object.assign(new Error('投递不存在'), { status: 404 });
    if (row['refusal']) throw Object.assign(new Error(String(row['refusal'])), { status: 409 });
    for (const j of this.jobs(event)) if (j['status'] === 'failed' && (!job || j['job_id'] === job)) await this.send(event, String(j['job_id']), String(row['asp_id']), String(row['deliverable_text']), true);
    const result = this.get(event); this.deps.emit('market_publish', result); return result;
  }); }
  private jobs(event: string): Record<string, unknown>[] { return this.db.prepare('SELECT * FROM okx_market_delivery_out_job WHERE event_id=? ORDER BY job_id').all(event).map(({ result_json, ...r }) => ({ ...r, result: result_json ? JSON.parse(String(result_json)) : null })); }
  get(event: string) {
    const row = this.db.prepare('SELECT * FROM okx_market_delivery_out WHERE event_id=?').get(event);
    if (!row) return null;
    return { event_id: event, created_at: row['created_at'], event: JSON.parse(String(row['event_json'])), subscribers: JSON.parse(String(row['subscriber_set_json'])), text: row['deliverable_text'], payload: JSON.parse(String(row['payload_json'])), refusal: row['refusal'], jobs: this.jobs(event) };
  }
  deliveries(limit = 100) { return this.db.prepare('SELECT event_id FROM okx_market_delivery_out ORDER BY created_at DESC LIMIT ?').all(limit).map((x) => this.get(String(x['event_id']))); }
}

/** R uses the frozen opening risk budget, never today's trailed stop or remaining quantity. */
export function realizedR(store: DemoStore, thread: StrategyThread | null): string | null {
  if (!thread || thread.status !== 'closed' || thread.realized_pnl === null || settlementCompleteness(thread).status !== 'complete') return null;
  const opening = store.intentsForThread(thread.id).find((x) => x.kind === 'open');
  const risk = Number(thread.settlement?.initial_risk_usdt ?? opening?.sizing?.risk_usdt ?? 0);
  const net = Number(thread.realized_pnl);
  return risk > 0 && Number.isFinite(net) ? (net / risk).toFixed(4) : null;
}
