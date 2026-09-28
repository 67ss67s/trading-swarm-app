import { afterEach, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { DEFAULT_MARKET_SETTINGS } from '../../src/demo/asp-agent/settings.js';
import { FETCH_FAILED_NOTE, MarketInbox, classifyInboxTexts, classifyTypeHeaderLine, isSellerSideMirror, pickSignal, type QueueRow } from '../../src/demo/asp-agent/inbox.js';

const states: StateDb[] = [];
afterEach(() => { for (const s of states.splice(0)) s.close(); });
function store() { const s = openStateDb(':memory:'); states.push(s); return new DemoStore(s); }
const now = 1800000000000;
function inbox(s: DemoStore, extra: Partial<ConstructorParameters<typeof MarketInbox>[0]> = {}) {
  return new MarketInbox({ store: s, settings: () => ({ ...DEFAULT_MARKET_SETTINGS, enabled: true }), session: () => 's1', now: () => now, system: async () => {}, emit: () => {}, selfAspIds: () => ['13866'], ...extra });
}
/** 买方收到的 XMTP 信封(守护写进 user_attention 的样子)。 */
const received = (body: string, from = 'Trading Swarm#13866') => `📥 [Received] ${from} → Jacky#13529 (you)\nJob: 0x1c13...8840\n────────────\n「jobId: 0x1c133e3a\ndeliverableType: text\n- - -\n${body}\n- - -\n[intent:deliver]」\n────────────`;
const q = (id: string, content: string, created = now): QueueRow => ({ id, job_id: '0x1c13', message_id: `agent-message:inbound:${id}`, content, llm_content: null, payload_json: null, created_at: new Date(created).toISOString() });
const iso = new Date(now).toISOString();
const LONG_DETAIL = 'Market Brief · 2026-09-26 08:00 UTC\nSince the 04:00 UTC brief: BTC +0.13%, ETH +0.07%; daily regimes unchanged. Funding rate extremes: ONE +0.198%, FLOCK -0.178%.\n— Prices & daily regime\nBTC 84050.4 · 24h +0.01% · Daily: bullish · 20d +5.3% · 5d +3.6% · ATR 2.94% · Vol percentile 74%\nETH 2689.4 · 24h +0.60% · Daily: bullish · 20d +8.5% · 5d +1.8% · ATR 3.89% · Vol percentile 56%\nRule-based analysis of OKX market data. Not investment advice.';

describe('type-header lines (OKX 官方类型头)', () => {
  it('our Market Intel info line + long detail → intel, never a signal', async () => {
    const line = '【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP | Market brief | BTC bullish · ETH bullish · scan leader PHA. Since the 00:00 UTC brief: BTC -0.13% | Info only, no order | Trading Swarm';
    expect(classifyTypeHeaderLine(line, now)).toMatchObject({ kind: 'intel' });
    const s = store(); const i = inbox(s);
    await i.accept([q('intel1', received(`${line}\n\n${LONG_DETAIL}`))]);
    expect(i.rows()[0]).toMatchObject({ parse_status: 'intel', signal_id: null, signal: null });
    expect(i.capture()).toEqual([]); expect(s.traderSignals.list()).toHaveLength(0);
  });
  it('strategy status line → status, never a signal', async () => {
    const s = store(); const i = inbox(s);
    await i.accept([q('st1', received('【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP | No active setup | Multi-timeframe 15m scanning | Next scan 09-26 04:15 UTC | Status only, no order | Trading Swarm'))]);
    expect(i.rows()[0]).toMatchObject({ parse_status: 'status', signal: null });
    expect(i.capture()).toEqual([]);
  });
  it('a type-header line without side and without price is intel, with a price but unreadable action is invalid', () => {
    expect(classifyTypeHeaderLine('【Futures】OKX perps | Radar picks | Top: BTC', now)).toMatchObject({ kind: 'intel' });
    expect(classifyTypeHeaderLine('【Futures】BTC-USDT-SWAP | HOLD | Reference Price 64000', now)).toMatchObject({ kind: 'invalid' });
  });
  it('CLOSE LONG maps to close with side long; REDUCE 50% maps to reduce; direction is never guessed', async () => {
    const s = store(); const i = inbox(s);
    await i.accept([q('c1', received('【Futures】ETH-USDT-SWAP | CLOSE LONG | Market | Reference Price 2700.5 | Valid for 15min | Trading Swarm strategy 15m'))]);
    const r = i.rows()[0]!;
    expect(r).toMatchObject({ parse_status: 'order', signal: { symbol: 'ETHUSDT', action: 'close', side: 'long', market_type: 'perp' } });
    expect(i.capture()).toHaveLength(1);
    expect(classifyTypeHeaderLine('【Futures】ETH-USDT-SWAP | REDUCE 50% SHORT | Market | Valid for 15min', now)).toMatchObject({ kind: 'signal', obj: { action: 'REDUCE', direction: 'short', reduce_pct: '50' } });
    const bare = classifyTypeHeaderLine('【Futures】ETH-USDT-SWAP | CLOSE | Market | Valid for 15min', now);
    expect(bare).toMatchObject({ kind: 'signal', obj: { action: 'CLOSE' } }); expect(bare?.kind === 'signal' && bare.obj['direction']).toBeFalsy();
  });
  it('【Spot】 BUY with price → spot order (market_type spot); SELL ALL → close; bare spot SELL is not guessed', async () => {
    const s = store(); const i = inbox(s);
    await i.accept([q('sp1', received('【Spot】OKX | ETH-USDT | BUY | Limit | Order Price 2650 USDT | Stop Loss 2600 | Take Profit 2800 | Valid for 2h | Trading Swarm'))]);
    expect(i.rows()[0]).toMatchObject({ parse_status: 'order', signal: { symbol: 'ETHUSDT', market_type: 'spot', action: 'open', side: 'long', entry_prices: ['2650'], stop: '2600', valid_until: now + 2 * 3600_000 } });
    expect(classifyTypeHeaderLine('【Spot】OKX | ETH-USDT | SELL ALL | Market | Valid for 15min', now)).toMatchObject({ kind: 'signal', obj: { action: 'CLOSE', direction: 'long', market: 'spot', symbol: 'ETH-USDT' } });
    expect(classifyTypeHeaderLine('【Spot】OKX | ETH-USDT | SELL | Market | Reference Price 2700 USDT', now)).toMatchObject({ kind: 'message' });
  });
  it('Prediction / Options / DeFi headers have no execution path → message', () => {
    expect(classifyTypeHeaderLine('【Prediction】BTC-100K-DEC | BUY YES | Order Price 0.42', now)).toMatchObject({ kind: 'message' });
  });
  it('legacy 【合约信号】 lines keep their old dedup key', () => {
    const a = classifyTypeHeaderLine('【合约信号】ONE-PERP | LONG 1x | 入场 0.005365-0.005408 | SL 0.003476 | TP1 0.007292 | 仓位 5% | 4h 内有效', iso);
    expect(a).toMatchObject({ kind: 'signal', obj: { symbol: 'ONE-USDT-SWAP', action: 'LONG', text_format: 'alpha_engine_line' } });
  });
});

describe('non-signal deliveries', () => {
  it('decrypted file report → report; failed decrypt → invalid flagged as fetch failure (counts as 处理失败, not 没读懂)', async () => {
    const desc = '📥 [Received] Trading Swarm#13866 → Jacky#13529 (you)\n「jobId: 0xabc\ndeliverableType: file\nfileKey: 0xabc/0xabc-1\ndigest: e111\nsalt: a=\nnonce: b=\nsecret: c=\nfilename: report.md...」';
    const report = '[Strategy Research Report · Quick Backtest] Trading Swarm\nBTC 1h Candle streak: return -93.3%, buy & hold 32.0% · Sharpe -8.81 · max drawdown 93.4% · 836 trades.\n{"window":"2025-09..2026-09","fees_bps":5}\n' + 'Detail line. '.repeat(40);
    const s = store(); const i = inbox(s, { fetchFile: async () => report });
    await i.accept([q('f1', desc)]);
    expect(i.rows()[0]).toMatchObject({ parse_status: 'report', signal: null });
    const s2 = store(); const i2 = inbox(s2, { fetchFile: async () => null });
    await i2.accept([q('f2', desc)]);
    expect(i2.rows()[0]).toMatchObject({ parse_status: 'invalid', errors: [FETCH_FAILED_NOTE] });
    expect(i2.status()).toMatchObject({ fetch_failed: 1, unreadable: 0, trade_signals: 0 });
  });
  it('"A2A message send failed" receipts are skipped (seller-side), classified system if ever re-read', async () => {
    const receipt = 'A2A message send failed\n\nJob: 0xa1eb0817...2fa1b4\nTarget: agentId=13529\nCommand: 15816a9a\nReason: Message eligibility service is temporarily unavailable';
    expect(isSellerSideMirror(receipt, [])).toBe(true);
    expect(classifyInboxTexts([receipt])).toMatchObject({ status: 'system' });
    const s = store(); const i = inbox(s);
    expect(await i.accept([q('r1', receipt)])).toEqual({ scanned: 0, duplicates: 0 });
  });
  it('seller mirrors are skipped, including task-created notices before our ASP id is known', async () => {
    const sent = '📤 [Sent] Trading Swarm#13866 (you) → Jacky#13529\nJob: 0xa1eb...a1b4\n────────────\n「jobId: 0xa1eb\ndeliverableType: text\n- - -\n【Futures】ETH-USDT-SWAP | LONG 1x | Market | Reference Price 2709.32 | Stop Loss 2664.5 | Take Profit 2738.56 | Valid for 15min | Trading Swarm\n- - -\n[intent:deliver]」';
    const task = '📥 [Received] SecAgent#1791 → Trading Swarm#13866 (you)\nJob: 0x645e...be37\n────────────\n「A task has been created for your service through okx.ai task market. Job Title: x」';
    expect(isSellerSideMirror(task, [])).toBe(true);
    const s = store(); const i = inbox(s, { selfAspIds: () => [] });
    expect(await i.accept([q('m1', sent), q('m2', task)])).toEqual({ scanned: 0, duplicates: 0 });
    expect(s.traderSignals.list()).toHaveLength(0);
  });
  it('a brief mentioning "Funding rate extremes" / radar "Basis (…)" is intel, not arbitrage', async () => {
    expect(pickSignal(LONG_DETAIL)).toBeNull();
    const radar = 'Radar Picks · Short-term tier · 2026-09-26 11:50 UTC\n#6 BTCUSDT · fit 0.71 · Basis (Breakout retest): Checklist 4/7 met';
    const s = store(); const i = inbox(s);
    await i.accept([q('b1', received(LONG_DETAIL)), q('b2', received(radar))]);
    expect(i.rows().map((r) => r.parse_status)).toEqual(['intel', 'intel']);
    expect(i.capture()).toEqual([]); expect(s.traderSignals.list()).toHaveLength(0);
  });
  it('unknown plain message → message (neutral), not invalid; platform notices stay notice', async () => {
    const s = store(); const i = inbox(s);
    await i.accept([q('u1', received('hi there, thanks for subscribing!', 'Someone#42')), q('n1', '[onchainos:task-terminal] 【已取消】「x」的免费试用已取消,访问权限立即终止。')]);
    expect(i.rows().map((r) => r.parse_status).sort()).toEqual(['message', 'notice']);
    expect(i.status()).toMatchObject({ unreadable: 0, fetch_failed: 0, trade_signals: 0 });
  });
  it('a JSON block without explicit order fields inside a long text is not a trade signal', () => {
    const text = `Weekly Report\n${'Analysis paragraph. '.repeat(20)}\n{"deliveryId":"w1","summary":"range-bound"}`;
    expect(classifyInboxTexts([text])).toMatchObject({ status: 'report' });
  });
});

describe('status() counters', () => {
  it('reports additive per-status counts and re-classifies legacy rows at read time', async () => {
    const s = store(); const i = inbox(s);
    await i.accept([q('o1', received('【Futures】SOL-USDT-SWAP | LONG 1x | Market | Reference Price 121.75 | Stop Loss 120.14 | Take Profit 122.23 | Valid for 15min | Trading Swarm'))]);
    // 历史行(旧分类器写进去的,账本不可改):简报被判成 arbitrage、我们自己的 [Sent] 镜像被判成 order、情报被判成 invalid。
    const ins = s.marketDb.prepare('INSERT INTO okx_market_delivery_in(delivery_id,job_id,received_at,raw,parse_status,signal_id,signal_json,errors_json,signal_type,session) VALUES (?,?,?,?,?,?,?,?,?,?)');
    ins.run('legacy-arb', 'j', now, received(LONG_DETAIL), 'arbitrage', 'x1', JSON.stringify({ kind: 'arbitrage', arbitrage: { basis_pct: null, expected_apr: null } }), '[]', 'arbitrage', 's0');
    ins.run('legacy-sent', 'j', now, '📤 [Sent] Trading Swarm#13866 (you) → Jacky#13529\n「【Futures】ETH-USDT-SWAP | LONG 1x | Market」', 'order', 'x2', null, '[]', 'order', 's0');
    ins.run('legacy-invalid', 'j', now, 'Microstructure Alert · ETH Liquidation spike · OKX perps · 2026-09-25 13:36 UTC\nETH: $3.80M liquidated', 'invalid', null, null, '["投递里挑不出信号对象"]', null, 's0');
    const st = i.status();
    expect(st).toMatchObject({ received: 4, dlq: 1, stored_counts: { order: 2, arbitrage: 1, invalid: 1 }, counts: { order: 1, intel: 2, system: 1 }, trade_signals: 1, intel_analysis: 2, unreadable: 0, fetch_failed: 0 });
    // 增量缓存:再来一行只算新行。
    await i.accept([q('m9', received('ok', 'Someone#42'))]);
    expect(i.status().counts).toMatchObject({ order: 1, intel: 2, system: 1, message: 1 });
  });
});
