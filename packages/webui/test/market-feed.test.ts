import { describe, expect, it } from 'vitest';
import type { MarketInboxRow, TraderSignal } from '../src/api/types';
import { MISROUTED_BEFORE, adaptSubscriptions, buildSignalFeed, classifyDelivery, deliveryContent, levelsFromText, offTypeFeedKeys, subscriptionDisplay, subscriptionServiceKind } from '../src/api/market-adapt';

const row = (id: string, raw: string, extra: Partial<MarketInboxRow> = {}): MarketInboxRow => ({
  delivery_id: id, job_id: 'job-a', message_id: null, received_at: 1_000 + Number(id.replace(/\D/g, '') || 0), signal_type: null, parse_status: 'bad', signal_id: null, note: null, raw, ...extra,
});
const sig = (over: Partial<TraderSignal>): TraderSignal => ({
  id: 's1', signal_id: 'sig-1', record_id: null, trader: 'svc', symbol: 'ETHUSDT', side: 'long', action: 'open', entry_kind: 'market', entry_prices: ['2739.52'], stop: '2690.19', tps: [{ price: '2787.83', pct: null } as TraderSignal['tps'][number]],
  size_pct: null, valid_until: null, published_at: 500, ingested_at: 500, raw_text: '', ref_order: null, order_end_state: null, market_type: 'swap', transport: 'okx_asp', backfill: false, session: null,
  needs_reconcile: false, claim_id: null, claim_owner: null, claim_at: null, invalid_validity: false, status: 'evidence', mode_applied: 'evidence', thread_id: null, decision: null, created_at: 500, updated_at: 500, ...over,
});

const ALERT = '【微观结构告警 / Microstructure Alert】 ETH 清算放量 · OKX 永续 · 2026-09-25 12:16 UTC\nETH 近 15 分钟 OKX 永续清算 $1.92M\n📥 [Received] Trading Swarm#13866 → Jacky#13529 (you)\nJob: 0x4d6a...2939\n────────────\n「jobId: 0x4d6a\ndeliverableType: file」';
const BRIEF_SENT = '📤 [Sent] Trading Swarm#13866 (you) → Jacky#13529\nJob: 0xa1eb...a1b4\n────────────\n「jobId: 0xa1eb\ndeliverableType: text\n- - -\n【行情简报 / Market Brief】 2026-09-25 12:00 UTC\nBTC 日线多头、ETH 日线多头。\n— 行情\nBTC 84636.6」\n────────────';
const BRIEF_RECV = BRIEF_SENT.replace('📤 [Sent] Trading Swarm#13866 (you) → Jacky#13529', '📥 [Received] Trading Swarm#13866 → Jacky#13529 (you)');
const ORDER = '📤 [Sent] A → B\nJob: x\n────────────\n「jobId: x\ndeliverableType: text\n- - -\n【Futures】ETH-USDT-SWAP | LONG 1x | Market | Reference Price 2739.52\n- - -\n[intent:deliver]」';
const GATE = '【交易计划把关 / Trade Plan Gate】 Trading Swarm\n结论:计划存疑 —— 需人工复核(BTCUSDT 做多 1h)\n计划:做多 入场 84,300 止损 83,100 目标 86,500 / 88,000 · 永续 1h';
const TASK = '📥 [Received] SecAgent#1791 → Trading Swarm#13866 (you)\nJob: 0x5c9d...79ca\n────────────\n「A task has been created for your service through okx.ai task market.」\n────────────';

describe('delivery content & classification', () => {
  it('strips the platform envelope and keeps the provider text', () => {
    expect(deliveryContent(ALERT).content.split('\n')).toEqual(['【微观结构告警 / Microstructure Alert】 ETH 清算放量 · OKX 永续 · 2026-09-25 12:16 UTC', 'ETH 近 15 分钟 OKX 永续清算 $1.92M']);
    expect(deliveryContent(ORDER).content).toBe('【Futures】ETH-USDT-SWAP | LONG 1x | Market | Reference Price 2739.52');
    expect(deliveryContent(TASK).envelopeOnly).toBe(true);
  });

  it('derives the type from the header when there is no signal object', () => {
    const k = (raw: string) => { const c = deliveryContent(raw); return classifyDelivery({ parse_status: 'bad', signal_type: null, content: c.content, envelopeOnly: c.envelopeOnly, signal: null }); };
    expect(k(ALERT)).toBe('alert');
    expect(k(BRIEF_SENT)).toBe('intel');
    expect(k(GATE)).toBe('report');
    expect(k(TASK)).toBe('system');
  });

  it('a brief misparsed as an arbitrage signal (no basis) is still intel, not a trade', () => {
    const c = deliveryContent(BRIEF_SENT);
    const s = sig({ kind: 'arbitrage', action: 'analysis_only', side: null, entry_prices: [], stop: null, tps: [], arbitrage: { symbol: 'BTCUSDT', spot_side: 'long', perp_side: 'short', basis_pct: null, expected_apr: null } });
    expect(classifyDelivery({ parse_status: 'bad', signal_type: 'arbitrage', content: c.content, envelopeOnly: c.envelopeOnly, signal: s })).toBe('intel');
  });

  it('pulls key price levels out of report text', () => {
    expect(levelsFromText(GATE)).toEqual({ entry: '84300', stop: '83100', targets: ['86500', '88000'] });
  });
});

describe('buildSignalFeed', () => {
  it('merges the sent/received copies of one delivery and summarises without dates or signatures', () => {
    const feed = buildSignalFeed([row('d1', BRIEF_SENT), row('d2', BRIEF_RECV, { parse_status: 'system' })], []);
    expect(feed).toHaveLength(1);
    expect(feed[0]!.repeats).toBe(2);
    expect(feed[0]!.kind).toBe('intel');
    expect(feed[0]!.summary).toBe('BTC 日线多头、ETH 日线多头。');
    expect(feed[0]!.symbol).toBeNull();
  });

  it('uses the follow signal for trade rows (symbol, side, levels) and alerts get a ticker from the text', () => {
    const feed = buildSignalFeed([row('d3', ORDER, { parse_status: 'ingested', signal_type: 'order', signal_id: 'sig-1' }), row('d4', ALERT)], [sig({})]);
    const trade = feed.find((f) => f.kind === 'trade')!;
    expect(trade.symbol).toBe('ETHUSDT');
    expect(trade.side).toBe('long');
    expect(trade.levels).toEqual({ entry: '2739.52', stop: '2690.19', targets: ['2787.83'] });
    expect(trade.summary).toContain('2739.52');
    const alert = feed.find((f) => f.kind === 'alert')!;
    expect(alert.symbol).toBe('ETH');
    expect(alert.summary).toBe('ETH 清算放量 · OKX 永续');
    expect(alert.levels).toEqual({ entry: null, stop: null, targets: [] });
  });

  it('keeps follow signals that have no ledger row', () => {
    const feed = buildSignalFeed([], [sig({ raw_text: '【Futures】SOL', subscription_job_id: 'job-b' } as Partial<TraderSignal>)]);
    expect(feed).toHaveLength(1);
    expect(feed[0]!.job_id).toBe('job-b');
    expect(feed[0]!.kind).toBe('trade');
  });
});

describe('subscription grouping', () => {
  const now = 1_790_339_000_000;
  const base = { trial_type: 1, auto_renew: false, sub_end_time: null } as const;
  it('computes the fallback group from status and trial fields (same rules as the gateway)', () => {
    expect(subscriptionDisplay({ ...base, auto_renew: true, status_name: 'ACTIVE', trial_end_time: now + 1e8 }, now)).toMatchObject({ group: 'trial', until: now + 1e8 });
    expect(subscriptionDisplay({ ...base, status_name: 'ACTIVE', trial_end_time: now + 1e8 }, now)).toMatchObject({ group: 'cancelled_trial', until: now + 1e8 });
    expect(subscriptionDisplay({ ...base, trial_type: 0, status_name: 'ACTIVE', trial_end_time: null }, now).group).toBe('active');
    expect(subscriptionDisplay({ ...base, status_name: 'INIT', trial_end_time: null }, now).group).toBe('pending');
    expect(subscriptionDisplay({ ...base, status_name: 'CLOSED', trial_end_time: now + 1e8 }, now).group).toBe('cancelled_trial');
    expect(subscriptionDisplay({ ...base, status_name: 'CLOSED', trial_end_time: now - 1e8 }, now)).toMatchObject({ group: 'ended', label: '试用已结束' });
    expect(subscriptionDisplay({ ...base, status_name: 'EXPIRED', trial_end_time: null }, now).group).toBe('ended');
  });

  it('sorts active → trial → pending → cancelled trial → ended when the gateway sends no display', () => {
    const future = Math.floor((Date.now() + 86_400_000) / 1000);
    const r = adaptSubscriptions({ subscriptions: [
      { job_id: 'ended', remote: { statusName: 'EXPIRED', trialType: 1 } },
      { job_id: 'cancelled', remote: { statusName: 'CLOSED', trialType: 1, trialEndTime: future } },
      { job_id: 'trial', remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 1, trialEndTime: future } },
      { job_id: 'paid', remote: { statusName: 'ACTIVE', trialType: 0 } },
      { job_id: 'pending', remote: { statusName: 'INIT' } },
    ] });
    expect(r.subscriptions.map((s) => s.job_id)).toEqual(['paid', 'trial', 'pending', 'cancelled', 'ended']);
  });

  it('maps the gateway display field and keeps its order', () => {
    const r = adaptSubscriptions({ subscriptions: [
      { job_id: 'b', remote: { statusName: 'ACTIVE', trialType: 1 }, display: { group: 'trial', label: '试用中 · 剩 2 天', until: 1790584667 } },
      { job_id: 'a', remote: { statusName: 'ACTIVE', trialType: 1 }, display: { group: 'trial', label: '试用中', until: null } },
    ] });
    expect(r.subscriptions.map((s) => s.job_id)).toEqual(['b', 'a']);
    expect(r.subscriptions[0]!.display).toEqual({ group: 'trial', label: '试用中 · 剩 2 天', until: 1790584667000 });
    expect(r.subscriptions[1]!.display.until).toBeNull();
  });
});

describe('off-type history (trade signals mis-pushed to intel / alert subscriptions)', () => {
  const subOf = (job: string, title: string, asp_service_name: string | null = null) => {
    const v = adaptSubscriptions({ subscriptions: [{ job_id: job, remote: { statusName: 'ACTIVE', trialType: 1, autoRenew: 1, title } }] }).subscriptions[0]!;
    return { ...v, asp_service_name };
  };
  const brief = (n: number) => BRIEF_RECV.replace('BTC 日线多头', `BTC 日线多头 ${n}`);
  const trade = (id: string, at: number, job: string) => row(id, ORDER.replace('LONG', `LONG ${id}`), { job_id: job, received_at: at, parse_status: 'ingested', signal_type: 'order' });

  it('tells signal services from intel / alert services by name', () => {
    expect(subscriptionServiceKind(subOf('a', 'tg · 微观告警 自测'))).toBe('non_signal');
    expect(subscriptionServiceKind(subOf('a', 'tg · 市场情报 自测'))).toBe('non_signal');
    expect(subscriptionServiceKind(subOf('a', 'x', 'BTC/ETH Microstructure Alerts'))).toBe('non_signal');
    expect(subscriptionServiceKind(subOf('a', 'x', 'Market Intel 市场情报'))).toBe('non_signal');
    expect(subscriptionServiceKind(subOf('a', 'tg · 策略信号'))).toBe('signal');
    expect(subscriptionServiceKind(subOf('a', 'tg · 某服务'))).toBeNull();
  });

  it('hides every trade signal of a known non-signal service, keeps them for signal services', () => {
    const after = MISROUTED_BEFORE + 3_600_000;
    const feed = buildSignalFeed([row('d1', ALERT, { job_id: 'alerts', received_at: after }), trade('d2', after, 'alerts'), trade('d3', after, 'signals')], []);
    const subs = new Map([['alerts', subOf('alerts', 'tg · 微观告警 自测')], ['signals', subOf('signals', 'tg · 策略信号')]]);
    const off = offTypeFeedKeys(feed, subs);
    expect([...off]).toEqual(['d:d2']);
  });

  it('falls back to the dominant type of the group, only for items before the fix', () => {
    const before = MISROUTED_BEFORE - 3_600_000;
    const after = MISROUTED_BEFORE + 3_600_000;
    const rows = [
      row('d1', brief(1), { job_id: 'j', received_at: before }),
      row('d2', brief(2), { job_id: 'j', received_at: before + 1 }),
      row('d3', brief(3), { job_id: 'j', received_at: after }),
      trade('d4', before + 2, 'j'),
      trade('d5', after + 1, 'j'),
      trade('d6', before, 'not-mine'),
    ];
    const feed = buildSignalFeed(rows, []);
    expect([...offTypeFeedKeys(feed, new Map([['j', subOf('j', 'tg · 某服务')]]))]).toEqual(['d:d4']);
    // 没有过半的主导类型就不动
    const even = buildSignalFeed([row('d1', brief(1), { job_id: 'j', received_at: before }), trade('d4', before, 'j')], []);
    expect(offTypeFeedKeys(even, new Map([['j', subOf('j', 'tg · 某服务')]])).size).toBe(0);
  });
});

describe('English deliverable titles', () => {
  const c = (content: string) => classifyDelivery({ parse_status: 'bad', signal_type: null, content, envelopeOnly: false, signal: null });
  it('classifies English subscription pushes and per-call reports', () => {
    expect(c('Microstructure Alert · ETH Liquidation spike · OKX perps\nETH: $2.1M liquidated')).toBe('alert');
    expect(c('Market Brief · 2026-09-25 12:00 UTC (period 12:00–16:00 UTC)\nDaily regime: BTC bullish')).toBe('intel');
    expect(c('Radar Picks · Swing tier · 2026-09-25 14:00 UTC')).toBe('intel');
    expect(c('[Trade Plan Gate] Trading Swarm\nVerdict: FAIL')).toBe('report');
    expect(c('[Strategy Research Report · Quick Backtest] Trading Swarm')).toBe('report');
  });
});
