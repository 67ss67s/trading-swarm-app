// 判断账本(judgment-ledger.ts,契约 §9.29):落行、三条腿的反事实结算、分层汇总、持久化与巡检。
// 纯代码、零模型、零网络(K 线由测试喂)。
import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import {
  councilStanceOf,
  counterfactualLeg,
  decodeLedgerCursor,
  encodeLedgerCursor,
  ledgerMode,
  ledgerRowFor,
  LEDGER_MIN_CLUSTERS,
  LEDGER_MIN_SAMPLE,
  mechanicalDirection,
  modelStance,
  modelStanceOf,
  recordJudgment,
  reviewRegret,
  rowSettlementStatus,
  settleJudgmentLedger,
  settlementCompleteness,
  settleRow,
  snapshotFromEpisode,
  summarizeDecisions,
  summarizeLedger,
  holdingReasonOf,
  type JudgmentLedgerRow,
  type LedgerRegret,
  type LedgerSnapshot,
} from '../../src/demo/judgment-ledger.js';
import type { CouncilResult } from '../../src/demo/strategy-council.js';
import type { Episode, Evidence, Judgment, Kline, StrategyThread } from '../../src/demo/types.js';
import { newThread } from '../../src/demo/threads.js';

const NOW = 1_788_700_000_000;
const TF_MS = 15 * 60_000;

// ------------------------------------------------------------------ fixtures

function structure(tf: string, o: { close: number; ema20: number; ema50: number; atr: number; high20: number; low20: number }, ref: string): Evidence {
  const up = o.ema20 > o.ema50;
  return {
    ref,
    kind: 'structure',
    label: `${tf} 结构`,
    value: `收 ${o.close}; EMA20${up ? '>' : '<'}EMA50(偏${up ? '多' : '空'}), 价在 EMA20 上; EMA20 ${o.ema20} EMA50 ${o.ema50}; ATR14 ${o.atr} (1.00%); 20根高 ${o.high20}(距 1.00%) 低 ${o.low20}(距 2.00%); 50根高 ${o.high20 + 20} 低 ${o.low20 - 20}; 最近一根 +0.10%, 近5根 +0.50%; 量比 1.20`,
    observed_at: NOW - TF_MS,
    source: `fapi klines ${tf}`,
    stale: false,
  };
}

const marketEv: Evidence = { ref: 'E0', kind: 'market', label: '最新价 / 标记价', value: 'last 100, mark 100', observed_at: NOW, source: 'fapi premiumIndex+ticker', stale: false };

/** 判断周期 15m(第一条结构证据),1h 结构决定机械基线方向。 */
function evidence(h1Up: boolean): Evidence[] {
  return [
    marketEv,
    structure('15m', { close: 100, ema20: 101, ema50: 99, atr: 10, high20: 100, low20: 80 }, 'E1'),
    structure('1h', { close: 100, ema20: h1Up ? 105 : 95, ema50: 100, atr: 12, high20: 110, low20: 70 }, 'E2'),
  ];
}

function judgment(over: Partial<Judgment> = {}): Judgment {
  return { action: 'PROPOSE', direction: 'long', confidence: 0.6, headline: 'h', thesis: 't', reasons: ['r [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null, strategy_id: 'breakout_retest', ...over };
}

function council(direction: 'long' | 'short' | null, reached: boolean): CouncilResult {
  return {
    version: 'council-v1',
    at: NOW,
    symbol: 'BTCUSDT',
    mode: 'advise',
    verdicts: [],
    consensus: { reached, direction, agreeing: [], dissenting: [], neutral: [], abstaining: [], required: 2, reason: 'test' },
    text: 'council',
  };
}

function episode(over: Partial<Episode> = {}): Episode {
  return {
    id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    at: NOW,
    as_of: NOW,
    symbol: 'BTCUSDT',
    thread_id: null,
    trigger: { kind: 'scan', detail: '扫描' },
    strategy_before: { state: 'researching', version: 0 },
    evidence: evidence(true),
    context_text: '',
    context_hash: '',
    prompt_version: 'v3',
    model: 'stub',
    judgment: judgment(),
    judgment_raw: null,
    schema_errors: [],
    reducer: null,
    gates: [],
    intent: null,
    usage: null,
    status: 'done',
    error: null,
    strategy_after: null,
    strategy_council: council('long', true),
    ...over,
  };
}

/** open_time 从 as_of 起,每根 15m。 */
function bars(specs: { o: number; h: number; l: number; c: number }[], from = NOW): Kline[] {
  return specs.map((s, i) => ({ open_time: from + i * TF_MS, open: String(s.o), high: String(s.h), low: String(s.l), close: String(s.c), volume: '1', close_time: from + (i + 1) * TF_MS - 1 }));
}

const flat = (n: number, o = 100, c = 100): { o: number; h: number; l: number; c: number }[] => Array.from({ length: n }, () => ({ o, h: o + 1, l: o - 1, c }));

const SNAP: LedgerSnapshot = { timeframe: '15m', last_close: 100, mark: 100, atr14: 10, swing_high_20: 100, swing_low_20: 80, ema20_1h: 105, ema50_1h: 100 };

// ------------------------------------------------------------------ 快照与方向

describe('snapshotFromEpisode / mechanicalDirection', () => {
  it('reads ATR / EMA / 20-bar swings out of the code-generated structure evidence', () => {
    const { snapshot, note } = snapshotFromEpisode(episode());
    expect(note).toBe('');
    expect(snapshot).toMatchObject({ timeframe: '15m', last_close: 100, mark: 100, atr14: 10, swing_high_20: 100, swing_low_20: 80, ema20_1h: 105, ema50_1h: 100 });
    expect(mechanicalDirection(snapshot)).toEqual({ direction: 'long', note: '' });
    const down = snapshotFromEpisode(episode({ evidence: evidence(false) })).snapshot;
    expect(mechanicalDirection(down).direction).toBe('short');
  });

  it('null + reason when the 1h EMAs are missing, tie, or there is no structure evidence at all', () => {
    expect(mechanicalDirection(null).direction).toBeNull();
    expect(mechanicalDirection({ ...SNAP, ema20_1h: null }).note).toMatch(/没有 1h 结构证据/);
    expect(mechanicalDirection({ ...SNAP, ema20_1h: 100, ema50_1h: 100 }).note).toMatch(/方向说不出来/);
    const empty = snapshotFromEpisode(episode({ evidence: [marketEv] }));
    expect(empty.snapshot).toBeNull();
    expect(empty.note).toMatch(/没有结构证据/);
  });
});

// ------------------------------------------------------------------ 反事实结算

describe('counterfactualLeg', () => {
  it('long: stop / target / horizon 三种结局', () => {
    // fill 100, level 100 → stop 92(0.8 ATR),stop_distance 8,tp 112(1.5R)
    const stop = counterfactualLeg('long', SNAP, bars([{ o: 100, h: 101, l: 90, c: 91 }, ...flat(3)]));
    expect(stop).toMatchObject({ status: 'stop', fill: 100, stop: 92, tp: 112, r: -1, bars_walked: 1 });
    const tp = counterfactualLeg('long', SNAP, bars([...flat(2), { o: 100, h: 115, l: 99, c: 114 }]));
    expect(tp).toMatchObject({ status: 'tp', r: 1.5, bars_walked: 3 });
    const expired = counterfactualLeg('long', SNAP, bars([...flat(3), { o: 100, h: 105, l: 99, c: 104 }]));
    expect(expired).toMatchObject({ status: 'expired', r: 0.5, bars_walked: 4 });
  });

  it('short: 方向镜像,止损用 20 根低点', () => {
    // fill 100, level 80 → anchor 100 → stop 108,tp 88
    expect(counterfactualLeg('short', SNAP, bars([{ o: 100, h: 110, l: 99, c: 109 }]))).toMatchObject({ status: 'stop', stop: 108, tp: 88, r: -1 });
    expect(counterfactualLeg('short', SNAP, bars([{ o: 100, h: 101, l: 85, c: 86 }]))).toMatchObject({ status: 'tp', r: 1.5 });
    expect(counterfactualLeg('short', SNAP, bars([...flat(2), { o: 100, h: 101, l: 95, c: 96 }]))).toMatchObject({ status: 'expired', r: 0.5 });
  });

  it('同一根同时触及止损与止盈按止损计;超过 48 根不再走;不表态 = 0R;算不出 = null', () => {
    const both = counterfactualLeg('long', SNAP, bars([{ o: 100, h: 120, l: 80, c: 100 }]));
    expect(both).toMatchObject({ status: 'stop', r: -1 });
    // 第 49 根才打止盈 → 走不到,按第 48 根收盘 mark-to-market
    const late = counterfactualLeg('long', SNAP, bars([...flat(48), { o: 100, h: 120, l: 99, c: 119 }]));
    expect(late).toMatchObject({ status: 'expired', bars_walked: 48, r: 0 });
    expect(counterfactualLeg(null, SNAP, bars(flat(3)))).toMatchObject({ status: 'flat', r: 0, direction: null });
    expect(counterfactualLeg('long', SNAP, [])).toMatchObject({ status: 'unscoreable', r: null });
    expect(counterfactualLeg('long', null, bars(flat(3)))).toMatchObject({ status: 'unscoreable', r: null });
    expect(counterfactualLeg('long', { ...SNAP, atr14: 0 }, bars(flat(3))).note).toMatch(/ATR/);
  });
});

describe('reviewRegret', () => {
  const inPos = { status: 'in_position' as const, side: 'long' as const, entry_type: 'market' as const, entry_price: 100, fill: 100, stop: 90, tp: 130 };

  it('HOLD 走到止损时,此刻走人才是对的 → regret > 0', () => {
    const r = reviewRegret(inPos, 'HOLD', 100, bars([{ o: 100, h: 101, l: 89, c: 90 }]));
    expect(r).toMatchObject({ hold_r: -1, exit_now_r: 0, chosen_r: -1, best_r: 0, regret_r: 1, hold_status: 'stop' });
  });

  it('EXIT 在一段本来会走到止盈的行情里 → regret = hold − exit', () => {
    const r = reviewRegret(inPos, 'EXIT', 100, bars([{ o: 100, h: 131, l: 99, c: 130 }]));
    expect(r).toMatchObject({ hold_r: 3, exit_now_r: 0, chosen_r: 0, best_r: 3, regret_r: 3, hold_status: 'tp' });
    // REDUCE 各占一半
    expect(reviewRegret(inPos, 'REDUCE', 100, bars([{ o: 100, h: 131, l: 99, c: 130 }]))!.chosen_r).toBe(1.5);
    // 判对了就没有 regret
    expect(reviewRegret(inPos, 'HOLD', 100, bars([{ o: 100, h: 131, l: 99, c: 130 }]))!.regret_r).toBe(0);
  });

  it('挂单:horizon 内没成交 → 留着与撤掉等价,0R', () => {
    const pend = { status: 'pending_entry' as const, side: 'long' as const, entry_type: 'limit' as const, entry_price: 50, fill: null, stop: 45, tp: 60 };
    const r = reviewRegret(pend, 'HOLD', 100, bars(flat(4)));
    expect(r).toMatchObject({ hold_r: 0, exit_now_r: 0, regret_r: 0, hold_status: 'unfilled' });
    expect(reviewRegret(inPos, 'HOLD', 100, [])).toBeNull();
  });
});

// ------------------------------------------------------------------ 落行 / 回填

describe('ledgerRowFor / settleRow', () => {
  it('落行时 outcome 全空、settled_at 为 null,horizon_end_at = as_of + 48 根', () => {
    const row = ledgerRowFor(episode(), null)!;
    expect(row).toMatchObject({
      symbol: 'BTCUSDT', mode: 'scan', timeframe: '15m', strategy_id: 'breakout_retest',
      model_action: 'PROPOSE', model_dir: 'long', council_dir: 'long', council_agree: true, mechanical_dir: 'long',
      outcome_r_model: null, outcome_r_council: null, outcome_r_mechanical: null, regret_review: null, settled_at: null,
    });
    expect(row.horizon_end_at).toBe(NOW + 48 * TF_MS);
    expect(row.mechanical_note).toBeNull();
  });

  it('不记账:未完成的 episode、对话提议、既没判断也没议会的行;没有议会时 council_agree 为 null', () => {
    expect(ledgerRowFor(episode({ status: 'running' }), null)).toBeNull();
    expect(ledgerRowFor(episode({ trigger: { kind: 'chat', detail: '对话' } }), null)).toBeNull();
    expect(ledgerRowFor(episode({ judgment: null, strategy_council: null }), null)).toBeNull();
    const noCouncil = ledgerRowFor(episode({ strategy_council: null }), null)!;
    expect(noCouncil.council_agree).toBeNull();
    expect(noCouncil.council_dir).toBeNull();
    // 没有结构证据 → 方向算不出,原因写进 mechanical_note
    const blind = ledgerRowFor(episode({ evidence: [marketEv] }), null)!;
    expect(blind.mechanical_dir).toBeNull();
    expect(blind.mechanical_note).toMatch(/没有结构证据/);
    expect(blind.timeframe).toBeNull();
  });

  it('modelStanceOf 三态:PROPOSE/HOLD = direction,NO_TRADE/WATCH/EXIT/INVALIDATE = flat,没判断 = unknown', () => {
    const t = { side: 'short' } as StrategyThread;
    expect(modelStanceOf(episode(), null)).toMatchObject({ stance: 'direction', direction: 'long' });
    expect(modelStanceOf(episode({ judgment: judgment({ action: 'HOLD', direction: null }) }), t)).toMatchObject({ stance: 'direction', direction: 'short' });
    for (const action of ['NO_TRADE', 'WATCH', 'EXIT', 'INVALIDATE'] as const) {
      expect(modelStanceOf(episode({ judgment: judgment({ action, direction: 'long' }) }), t)).toMatchObject({ stance: 'flat', direction: null });
    }
    // 没有判断(模型没跑出来)= unknown,既不是方向也不是 flat
    expect(modelStanceOf(episode({ judgment: null }), null)).toMatchObject({ stance: 'unknown', direction: null });
    // HOLD 但没线程、也没方向 → 方向读不出来 = unknown
    expect(modelStanceOf(episode({ judgment: judgment({ action: 'HOLD', direction: null }) }), null)).toMatchObject({ stance: 'unknown' });
    // 兼容壳:modelStance 只在 direction 态给方向
    expect(modelStance(episode({ judgment: judgment({ action: 'WATCH', direction: 'long' }) }), t)).toBeNull();
  });

  it('P1-12 反例:WATCH + direction=long 必须是 flat(0R),不能被当成入场', () => {
    const ep = episode({ judgment: judgment({ action: 'WATCH', direction: 'long' }) });
    const row = ledgerRowFor(ep, null)!;
    expect(row).toMatchObject({ model_stance: 'flat', model_dir: null });
    // 同一段行情做多本来能打 1.5R —— WATCH 腿只能拿 0R
    const settled = settleRow(row, bars([{ o: 100, h: 115, l: 99, c: 114 }]), null, NOW + 1);
    expect(settled).toMatchObject({ outcome_r_model: 0, outcome_source_model: 'flat', outcome_r_council: 1.5 });
    expect(settled.legs.model).toMatchObject({ stance: 'flat', status: 'flat', r: 0 });
  });

  it('P1-12 反例:议会 reached=false 但 consensus 带方向 → flat 0R;完全没有议会 = unknown(null,不进均值)', () => {
    const noConsensus = ledgerRowFor(episode({ strategy_council: council('long', false) }), null)!;
    expect(noConsensus).toMatchObject({ council_stance: 'flat', council_dir: null, council_agree: false });
    const s1 = settleRow(noConsensus, bars([{ o: 100, h: 115, l: 99, c: 114 }]), null, NOW + 1);
    expect(s1.outcome_r_council).toBe(0);
    expect(s1.legs.council).toMatchObject({ stance: 'flat', r: 0 });

    const noCouncil = ledgerRowFor(episode({ strategy_council: null }), null)!;
    expect(noCouncil).toMatchObject({ council_stance: 'unknown', council_dir: null, council_agree: null });
    const s2 = settleRow(noCouncil, bars([{ o: 100, h: 115, l: 99, c: 114 }]), null, NOW + 1);
    expect(s2.outcome_r_council).toBeNull(); // unknown 不进任何均值,更不是 flat
    expect(s2.legs.council).toMatchObject({ stance: 'unknown', r: null });
  });

  it('P1-12:议会腿消费 code_consensus(纯代码票),不是混了模型的 consensus', () => {
    const mixed = { ...council('long', true), code_consensus: { reached: false, direction: null, agreeing: [], dissenting: [], neutral: [], abstaining: [], required: 2, reason: '纯代码没达成' } } as unknown as CouncilResult;
    expect(councilStanceOf(mixed as never)).toMatchObject({ stance: 'flat', direction: null });
    const r = ledgerRowFor(episode({ strategy_council: mixed }), null)!;
    expect(r.council_stance).toBe('flat');
    expect(r.council_dir).toBeNull();
    expect(r.council_agree).toBe(false);
    // 旧 episode 没有这个字段就退回 consensus
    expect(councilStanceOf(council('long', true))).toMatchObject({ stance: 'direction', direction: 'long' });
  });

  it('councilStanceOf:reached=true 才是 direction', () => {
    expect(councilStanceOf(council('long', true))).toMatchObject({ stance: 'direction', direction: 'long' });
    expect(councilStanceOf(council('long', false))).toMatchObject({ stance: 'flat', direction: null });
    expect(councilStanceOf(council(null, true))).toMatchObject({ stance: 'flat' }); // 达成共识但没方向 = 不入场
    expect(councilStanceOf(null)).toMatchObject({ stance: 'unknown' });
  });

  it('P1-12 反例:mode 是纯函数 —— 开仓 episode(PROPOSE)末尾填了 thread_id 仍然是 scan', () => {
    const t = closedThread();
    const opened = episode({ thread_id: t.id, judgment: judgment({ action: 'PROPOSE', direction: 'long' }) });
    expect(ledgerMode(opened, t)).toBe('scan');
    expect(ledgerRowFor(opened, t)!.mode).toBe('scan');
    // 复查动作 / 复查触发才是 review
    expect(ledgerMode(episode({ thread_id: t.id, judgment: judgment({ action: 'HOLD', direction: null }) }), t)).toBe('review');
    expect(ledgerMode(episode({ thread_id: t.id, judgment: judgment({ action: 'EXIT', direction: null }) }), t)).toBe('review');
    expect(ledgerMode(episode({ thread_id: t.id, judgment: null, trigger: { kind: 'thread_review', detail: '复查' } }), t)).toBe('review');
    expect(ledgerMode(episode(), null)).toBe('scan');
  });

  it('回填三条腿:模型做多打止盈、议会做空同段行情打止损、机械基线与模型同向', () => {
    const row = ledgerRowFor(episode({ strategy_council: council('short', true) }), null)!;
    const settled = settleRow(row, bars([...flat(2), { o: 100, h: 115, l: 99, c: 114 }]), null, NOW + 1);
    expect(settled).toMatchObject({ outcome_r_model: 1.5, outcome_r_council: -1, outcome_r_mechanical: 1.5, outcome_source_model: 'counterfactual' });
    expect(settled.settled_at).toBe(NOW + 1);
    expect(settled.legs.council).toMatchObject({ direction: 'short', status: 'stop' });
  });

  it('模型不表态 = 0R 的 flat 腿(议会照样按自己的方向结算)', () => {
    const row = ledgerRowFor(episode({ judgment: judgment({ action: 'NO_TRADE', direction: null, strategy_id: null }) }), null)!;
    const settled = settleRow(row, bars([{ o: 100, h: 115, l: 99, c: 114 }]), null, NOW + 1);
    expect(settled).toMatchObject({ outcome_r_model: 0, outcome_source_model: 'flat', outcome_r_council: 1.5 });
  });

  it('P1-12 反例:线程结算的净 R 只进 realized 那本账,模型腿永远是反事实(同快照、同 horizon、同成本口径)', () => {
    const t = closedThread();
    const row = ledgerRowFor(episode({ thread_id: t.id, judgment: judgment({ action: 'HOLD', direction: null }) }), t)!;
    expect(row.mode).toBe('review');
    // 同一段行情:做多打止损 → 反事实 −1R;交易所那笔净 R 是 +1.5
    const settled = settleRow(row, bars([{ o: 100, h: 101, l: 89, c: 90 }]), t, NOW + 1);
    expect(settled.outcome_source_model).toBe('counterfactual');
    expect(settled.outcome_r_model).toBe(-1);
    expect(settled.legs.model).toMatchObject({ stance: 'direction', direction: 'long', status: 'stop' });
    expect(settled.realized).toMatchObject({ r: 1.5, net_pnl: '1.5', source: 'thread_settlement', settlement_status: 'complete' });
    // realized 不参与 judgment_alpha
    const s = summarizeLedger([settled]).overall;
    expect(s.judgment_alpha).toBe(settled.outcome_r_model! - settled.outcome_r_council!);
  });

  it('P1-12:EXIT 之后线程已 closed,复查快照从线程重建退出前状态(而不是丢掉)', () => {
    const t = closedThread();
    const row = ledgerRowFor(episode({ thread_id: t.id, judgment: judgment({ action: 'EXIT', direction: null }) }), t)!;
    expect(row.mode).toBe('review');
    expect(row.review).toMatchObject({ status: 'in_position', side: 'long', stop: 90, tp: 130, fill: 100, reconstructed: true });
    // EXIT 在一段本来会走到止盈的行情里 → regret > 0
    const settled = settleRow(row, bars([{ o: 100, h: 131, l: 99, c: 130 }]), t, NOW + 1);
    expect(settled.regret_review).toBe(3);
    // EXIT 是 flat 腿
    expect(settled.outcome_r_model).toBe(0);
  });

  it('复查一条还开着的线程:regret 回填(HOLD 走到止损,此刻走人更好)', () => {
    const open: StrategyThread = { ...closedThread(), status: 'in_position', closed_at: null, settlement: null, realized_pnl: null };
    const row = ledgerRowFor(episode({ thread_id: open.id, judgment: judgment({ action: 'HOLD', direction: null }) }), open)!;
    expect(row.review).toMatchObject({ status: 'in_position', side: 'long', stop: 90, tp: 130, fill: 100, reconstructed: false });
    const settled = settleRow(row, bars([{ o: 100, h: 101, l: 89, c: 90 }]), open, NOW + 1);
    expect(settled.regret_review).toBe(1); // hold −1R,此刻走人 0R
    expect(settled.outcome_source_model).toBe('counterfactual');
  });
});

function closedThread(): StrategyThread {
  const t = newThread({ id: 'thr-led-1', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 't', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '90', take_profits: ['130'], qty: '0.1', margin_usdt: '2000', leverage: 5, margin_mode: 'cross', now: NOW - 3_600_000 } as Parameters<typeof newThread>[0]);
  return { ...t, status: 'closed', opened_at: NOW - 3_600_000, closed_at: NOW - 60_000, filled_avg_price: '100', exit_price: '101.5', realized_pnl: '1.5', close_reason: '止盈触发', protection_client_order_ids: ['sl-1'], settlement: { at: NOW, realized_pnl: '1.5', commission: '0', funding: '0', net_pnl: '1.5', exit_price: '101.5', trades: 2, window: [NOW - 3_600_000, NOW], source: 'exchange' }, version: 3 };
}

// ------------------------------------------------------------------ 汇总

function row(over: Partial<JudgmentLedgerRow>): JudgmentLedgerRow {
  const base = ledgerRowFor(episode(), null)!;
  const episode_id = over.episode_id ?? `ep-${Math.random().toString(36).slice(2, 9)}`;
  return { ...base, episode_id, cluster_id: over.cluster_id ?? episode_id, settled_at: NOW + 1, ...over };
}

describe('summarizeLedger', () => {
  it('按策略分层;n < 10 的层标 insufficient 且不下结论', () => {
    const rows = [
      ...Array.from({ length: 12 }, () => row({ strategy_id: 'a', outcome_r_model: 1, outcome_r_council: 0.5, outcome_r_mechanical: 0 })),
      ...Array.from({ length: 3 }, () => row({ strategy_id: 'b', outcome_r_model: -1, outcome_r_council: 1, outcome_r_mechanical: 0 })),
    ];
    const s = summarizeLedger(rows);
    expect(s.n).toBe(15);
    expect(s.settled).toBe(15);
    expect(s.min_sample).toBe(LEDGER_MIN_SAMPLE);
    const a = s.by_strategy.find((x) => x.strategy_id === 'a')!;
    expect(a).toMatchObject({ n: 12, insufficient: false, judgment_alpha: 0.5, alpha_n: 12, alpha_vs_mechanical: 1, verdict: 'model_adds' });
    const b = s.by_strategy.find((x) => x.strategy_id === 'b')!;
    expect(b).toMatchObject({ n: 3, insufficient: true, verdict: 'insufficient' });
    expect(b.judgment_alpha).toBe(-2); // 数字照算,只是不下结论
    expect(s.conclusion).toMatch(/override_alpha < 0/);
  });

  it('override_rate / override_alpha:alpha≈0 且不听议会时更差 → no_edge', () => {
    const agree = Array.from({ length: 8 }, () => row({ strategy_id: 'a', model_dir: 'long', council_dir: 'long', outcome_r_model: 1, outcome_r_council: 1 }));
    const over = Array.from({ length: 4 }, () => row({ strategy_id: 'a', model_dir: 'short', council_dir: 'long', outcome_r_model: -1, outcome_r_council: 1 }));
    const s = summarizeLedger([...agree, ...over]).overall;
    expect(s.override_rate).toBeCloseTo(4 / 12, 4);
    expect(s.override_n).toBe(4);
    expect(s.override_alpha).toBe(-2);
    // 全体 alpha = (8×0 + 4×−2)/12 = −0.6667 → 模型有害
    expect(s.judgment_alpha).toBeCloseTo(-0.6667, 3);
    expect(s.verdict).toBe('model_hurts');
    // 把 override 的 R 拉平到 0,alpha≈0 而 override_alpha 仍 < 0 → 模型没有增量
    const flatOver = Array.from({ length: 4 }, () => row({ strategy_id: 'a', model_dir: 'short', council_dir: 'long', outcome_r_model: 0.9, outcome_r_council: 1 }));
    const s2 = summarizeLedger([...agree, ...flatOver]).overall;
    expect(s2.verdict).toBe('no_edge');
  });

  it('未结算的行不进任何均值;since 只看窗口内;议会缺席时 override 分母不算它', () => {
    const rows = [
      row({ outcome_r_model: 2, outcome_r_council: 0 }),
      row({ settled_at: null, outcome_r_model: null, outcome_r_council: null }),
      row({ at: NOW - 10 * 86_400_000, outcome_r_model: -5, outcome_r_council: 0 }),
      row({ council_agree: null, council_dir: null, council_stance: 'unknown', outcome_r_model: 1, outcome_r_council: 0 }),
    ];
    const s = summarizeLedger(rows, { since: NOW - 86_400_000 });
    expect(s.n).toBe(3);
    expect(s.unsettled).toBe(1);
    expect(s.overall.alpha_n).toBe(2);
    expect(s.overall.judgment_alpha).toBe(1.5);
    expect(s.overall.override_n).toBe(0);
    expect(s.overall.override_rate).toBe(0);
    expect(s.overall.review_regret).toBeNull();
  });
});

describe('P1-12 样本阈值 / 伪重复样本 / 口径补充', () => {
  it('反例:10 行里 9 行未结算、只有 1 对有效配对 → insufficient=true 且 verdict 只能是 insufficient', () => {
    const rows = [
      ...Array.from({ length: 9 }, () => row({ strategy_id: 'a', settled_at: null, outcome_r_model: null, outcome_r_council: null, outcome_r_mechanical: null })),
      row({ strategy_id: 'a', outcome_r_model: 1, outcome_r_council: 0, outcome_r_mechanical: 0 }),
    ];
    const s = summarizeLedger(rows).overall;
    expect(s.n).toBe(10);
    expect(s.alpha_n).toBe(1);
    expect(s.judgment_alpha).toBe(1); // 数字照算
    expect(s.insufficient).toBe(true);
    expect(s.verdict).toBe('insufficient'); // 绝不能是 model_adds / no_edge
  });

  it('反例:同一线程 12 次 review 只算 1 个独立簇 → 仍是 insufficient', () => {
    const rows = Array.from({ length: 12 }, () => row({ strategy_id: 'a', thread_id: 'thr-1', cluster_id: 'thr-1', mode: 'review', outcome_r_model: 1, outcome_r_council: 0 }));
    const s = summarizeLedger(rows).overall;
    expect(s.alpha_n).toBe(12);
    expect(s.alpha_clusters).toBe(1);
    expect(s.insufficient).toBe(true);
    expect(s.verdict).toBe('insufficient');
    expect(LEDGER_MIN_CLUSTERS).toBeGreaterThan(1);
  });

  it('insufficient 时结论文案不说「模型没有增量」', () => {
    const s = summarizeLedger([row({ outcome_r_model: 0.9, outcome_r_council: 1 })]);
    expect(s.overall.verdict).toBe('insufficient');
    expect(s.conclusion).toMatch(/insufficient/);
    expect(s.conclusion).toMatch(/有效配对数/);
  });

  it('汇总报行动覆盖率 + 双方都表态时的方向对照 alpha', () => {
    const both = Array.from({ length: 6 }, () => row({ model_stance: 'direction', model_dir: 'long', council_stance: 'direction', council_dir: 'long', outcome_r_model: 1, outcome_r_council: 0.5 }));
    const modelFlat = Array.from({ length: 2 }, () => row({ model_stance: 'flat', model_dir: null, council_stance: 'direction', council_dir: 'long', outcome_r_model: 0, outcome_r_council: -1 }));
    const noCouncil = Array.from({ length: 2 }, () => row({ model_stance: 'direction', model_dir: 'long', council_stance: 'unknown', council_dir: null, council_agree: null, outcome_r_model: 1, outcome_r_council: null }));
    const s = summarizeLedger([...both, ...modelFlat, ...noCouncil]).overall;
    // 模型:10 行都知道表态,8 行给了方向;议会:只有 8 行知道表态,全是方向
    expect(s.model_known_n).toBe(10);
    expect(s.model_direction_rate).toBe(0.8);
    expect(s.council_known_n).toBe(8);
    expect(s.council_direction_rate).toBe(1);
    // 双方都 direction 的只有 6 行
    expect(s.alpha_both_dir_n).toBe(6);
    expect(s.alpha_both_dir).toBe(0.5);
    // 全体配对(含 flat 对照)= 8 行
    expect(s.alpha_n).toBe(8);
  });
});

describe('P1-13 结算完整性', () => {
  it('settlementCompleteness:trades=0 / 没有平仓均价 / 资金费缺失当 0 都是 partial;没有 settlement 是 missing', () => {
    const t = closedThread();
    expect(settlementCompleteness(t)).toMatchObject({ status: 'complete' });

    const empty = { ...t, settlement: { ...t.settlement!, trades: 0, note: '窗口内交易所没有这个币的成交:盈亏留空,不当作 0' } };
    expect(settlementCompleteness(empty).status).toBe('partial');
    expect(settlementCompleteness(empty).reasons.join(';')).toMatch(/没有成交/);

    const noExit = { ...t, settlement: { ...t.settlement!, exit_price: null } };
    expect(settlementCompleteness(noExit).status).toBe('partial');

    const noFunding = { ...t, settlement: { ...t.settlement!, note: '资金费流水没读到,净额只含成交与手续费' } };
    expect(settlementCompleteness(noFunding).status).toBe('partial');
    expect(settlementCompleteness(noFunding).reasons.join(';')).toMatch(/资金费/);

    expect(settlementCompleteness({ ...t, settlement: null }).status).toBe('missing');
    expect(settlementCompleteness(null).status).toBe('missing');

    // 行上的状态:没线程 / 线程还开着 = null(不涉及结算),已平才判
    expect(rowSettlementStatus(null)).toBeNull();
    expect(rowSettlementStatus({ ...t, status: 'in_position' })).toBeNull();
    expect(rowSettlementStatus(t)).toBe('complete');
    expect(rowSettlementStatus(empty)).toBe('partial');
  });

  it('反例:结算 trades=0 的行被排除出 summarizeLedger 的所有统计', () => {
    const good = Array.from({ length: 10 }, () => row({ strategy_id: 'a', outcome_r_model: 1, outcome_r_council: 0, outcome_r_mechanical: 0 }));
    const bad = Array.from({ length: 5 }, () => row({ strategy_id: 'a', settlement_status: 'partial', thread_id: 'thr-bad', cluster_id: 'thr-bad', outcome_r_model: -9, outcome_r_council: 0, outcome_r_mechanical: 0 }));
    const s = summarizeLedger([...good, ...bad]);
    expect(s.overall.alpha_n).toBe(10);
    expect(s.overall.judgment_alpha).toBe(1); // −9 那批完全没进来
    expect(s.overall.excluded_incomplete).toBe(5);
    expect(s.excluded_incomplete).toBe(5);
  });

  it('结算不完整时 realized 那本账也标出来,并且不影响反事实腿', () => {
    const t = closedThread();
    const broken = { ...t, settlement: { ...t.settlement!, trades: 0, note: '窗口内交易所没有这个币的成交:盈亏留空,不当作 0' } };
    const row0 = ledgerRowFor(episode({ thread_id: broken.id, judgment: judgment({ action: 'HOLD', direction: null }) }), broken)!;
    expect(row0.settlement_status).toBe('partial');
    const settled = settleRow(row0, bars([{ o: 100, h: 115, l: 99, c: 114 }]), broken, NOW + 1);
    expect(settled.outcome_r_model).toBe(1.5); // 反事实照走
    expect(settled.realized).toMatchObject({ settlement_status: 'partial' });
    expect(summarizeLedger([settled]).overall.alpha_n).toBe(0);
  });
});

// ------------------------------------------------------------------ 持久化 + 巡检

describe('JudgmentLedgerStore / settleJudgmentLedger', () => {
  it('落行、按策略与 since 过滤分页、到期才进 pending,巡检回填后不再是 pending', async () => {
    const state = openStateDb(':memory:');
    const store = new DemoStore(state);
    const ep = episode();
    expect(recordJudgment(store, ep)).not.toBeNull();
    expect(recordJudgment(store, ep)).toBeNull(); // 已记过不覆盖
    store.judgments.save(row({ strategy_id: 'other', at: NOW - 10 * 86_400_000, horizon_end_at: NOW - 9 * 86_400_000 }));

    expect(store.judgments.count()).toBe(2);
    expect(store.judgments.count({ strategy_id: 'breakout_retest' })).toBe(1);
    expect(store.judgments.list({ since: NOW - 86_400_000 })).toHaveLength(1);
    expect(store.judgments.list({ limit: 1, offset: 1 })).toHaveLength(1);

    // horizon 还没到 → 不进 pending
    expect(store.judgments.pending(NOW)).toHaveLength(0);
    const after = NOW + 48 * TF_MS + 1;
    expect(store.judgments.pending(after).map((r) => r.episode_id)).toEqual([ep.id]);

    const r = await settleJudgmentLedger(store, {
      now: after,
      fetchKlines: async () => bars([...flat(2), { o: 100, h: 115, l: 99, c: 114 }]),
    });
    expect(r).toMatchObject({ settled: 1, waiting: 0, errors: 0 });
    const saved = store.judgments.get(ep.id)!;
    expect(saved).toMatchObject({ outcome_r_model: 1.5, outcome_r_council: 1.5, outcome_r_mechanical: 1.5, settled_at: after });
    expect(store.judgments.pending(after)).toHaveLength(0);
    state.close();
  });

  it('结算预算只算真结算的行:最旧几行都在等持仓线程时,后面到期的扫描行照样结算(09-24 积压 177 行)', async () => {
    const state = openStateDb(':memory:');
    const store = new DemoStore(state);
    const open = { ...closedThread(), id: 'thr-open', status: 'in_position', closed_at: null, settlement: null } as StrategyThread;
    store.saveThread(open);
    const after = NOW + 48 * TF_MS + 1;
    for (let k = 0; k < 6; k++) store.judgments.save(row({ thread_id: 'thr-open', settled_at: null, horizon_end_at: NOW + k }));
    const scan = row({ thread_id: null, settled_at: null, horizon_end_at: NOW + 100 });
    store.judgments.save(scan);
    const r = await settleJudgmentLedger(store, { now: after, limit: 5, fetchKlines: async () => bars([...flat(2), { o: 100, h: 115, l: 99, c: 114 }]) });
    expect(r).toMatchObject({ settled: 1, waiting: 6, errors: 0 });
    expect(store.judgments.get(scan.episode_id)!.settled_at).toBe(after);
    state.close();
  });

  it('游标分页(encodeLedgerCursor/decodeLedgerCursor):按 cursor 翻页与按 offset 翻页给出同一顺序,不重不漏', () => {
    const state = openStateDb(':memory:');
    const store = new DemoStore(state);
    for (let i = 0; i < 5; i++) store.judgments.save(row({ episode_id: `ep-${i}`, at: NOW + i }));

    const byOffset = [...store.judgments.list({ limit: 2, offset: 0 }), ...store.judgments.list({ limit: 2, offset: 2 }), ...store.judgments.list({ limit: 2, offset: 4 })];

    const byCursor: JudgmentLedgerRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const batch = store.judgments.list({ limit: 2, cursor });
      if (batch.length === 0) break;
      byCursor.push(...batch);
      cursor = encodeLedgerCursor(batch[batch.length - 1]!);
    }

    expect(byCursor.map((r) => r.episode_id)).toEqual(byOffset.map((r) => r.episode_id));
    expect(byCursor).toHaveLength(5);

    const parsed = decodeLedgerCursor(encodeLedgerCursor(byCursor[0]!));
    expect(parsed).toMatchObject({ at: byCursor[0]!.at, episode_id: byCursor[0]!.episode_id });
    expect(decodeLedgerCursor('garbage-no-colon')).toBeNull();
    state.close();
  });

  it('取 K 线失败只记错误,不把行标成已结算', async () => {
    const state = openStateDb(':memory:');
    const store = new DemoStore(state);
    const ep = episode();
    recordJudgment(store, ep);
    const after = NOW + 48 * TF_MS + 1;
    const r = await settleJudgmentLedger(store, { now: after, fetchKlines: async () => { throw new Error('网络错误'); } });
    expect(r).toMatchObject({ settled: 0, errors: 1 });
    expect(store.judgments.get(ep.id)!.settled_at).toBeNull();
    state.close();
  });
});


describe('P1-12:账本 alpha 按簇均值汇总', () => {
  it('同一簇里刷 10 行不能主导结论(行均值 vs 簇均值)', () => {
    // A 簇:10 行,每行 alpha = +1;B..K 簇:各 1 行,alpha = 0。
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row({ episode_id: `a-${i}`, cluster_id: 'cluster-a', strategy_id: 'x', outcome_r_model: 1, outcome_r_council: 0 })),
      ...Array.from({ length: 10 }, (_, i) => row({ episode_id: `b-${i}`, cluster_id: `cluster-b${i}`, strategy_id: 'x', outcome_r_model: 0, outcome_r_council: 0 })),
    ];
    const s = summarizeLedger(rows).overall;
    // 行均值会是 0.5;簇均值 = (1 + 0×10) / 11 ≈ 0.0909
    expect(s.judgment_alpha).toBeCloseTo(1 / 11, 3);
    expect(s.alpha_n).toBe(20);
    expect(s.alpha_clusters).toBe(11);
  });
});

// ------------------------------------------------------------------ 09-23 P0-1:分层键 / regret_hold / by_decision

describe('jl-v2 分层与复查决策表', () => {
  const inPos = { status: 'in_position' as const, side: 'long' as const, entry_type: 'market' as const, entry_price: 100, fill: 100, stop: 90, tp: 130, reconstructed: true };

  it('regret_hold:HOLD 走到止损 = exit_now − hold;EXIT 没有 regret_hold,只有 regret_exit', () => {
    const hold = reviewRegret(inPos, 'HOLD', 95, bars([{ o: 95, h: 96, l: 89, c: 90 }]))!;
    // exit_now = (95−100)/10 = −0.5;hold = −1 → 拿着多亏了 0.5R
    expect(hold).toMatchObject({ hold_r: -1, exit_now_r: -0.5, regret_hold: 0.5, regret_exit: null, regret_r: 0.5 });
    const heldRight = reviewRegret(inPos, 'HOLD', 95, bars([{ o: 95, h: 131, l: 94, c: 130 }]))!;
    expect(heldRight).toMatchObject({ regret_hold: 0, regret_exit: null });
    const exit = reviewRegret(inPos, 'EXIT', 95, bars([{ o: 95, h: 131, l: 94, c: 130 }]))!;
    // 走早了:hold = 3,exit_now = −0.5 → regret_exit 3.5
    expect(exit).toMatchObject({ regret_hold: null, regret_exit: 3.5, regret_r: 3.5 });
  });

  it('ledgerRowFor 带出 trigger_kind / holding_reason / prompt_version / mark;旧 episode 没有持仓闸 = unknown', () => {
    const t = closedThread();
    const withGate = episode({ thread_id: t.id, trigger: { kind: 'heartbeat', detail: 'hb' }, prompt_version: 'demo-playbook-v9-holding', judgment: judgment({ action: 'EXIT' }), holding_review: { allowed_actions: ['HOLD', 'EXIT'], required_action: null, reason: 'confirmed_thesis_invalidation', attention: false, last_closed_at: null, spike: null } } as Partial<Episode>);
    const r1 = ledgerRowFor(withGate, t)!;
    expect(r1).toMatchObject({ mode: 'review', trigger_kind: 'heartbeat', holding_reason: 'confirmed_thesis_invalidation', prompt_version: 'demo-playbook-v9-holding', mark: 100 });
    const old = ledgerRowFor(episode({ thread_id: t.id, trigger: { kind: 'kline_close', detail: 'k' }, judgment: judgment({ action: 'HOLD' }) }), t)!;
    expect(old.holding_reason).toBe('unknown');
    // scan 行没有持仓理由这回事
    expect(ledgerRowFor(episode(), null)!.holding_reason).toBeNull();
    expect(holdingReasonOf(episode(), 'scan')).toBeNull();
  });

  it('快照读不出来(旧 episode 价位取整把 ATR 抹成 0)的复查行:三条腿不可评分,但 regret 仍靠标记价 + 线程周期算得出', () => {
    const t = closedThread();
    const rounded = evidence(true).map((e) => (e.kind === 'structure' ? { ...e, value: e.value.replace(/ATR14 [\d.]+/, 'ATR14 0') } : e));
    const ep = episode({ thread_id: t.id, evidence: rounded, judgment: judgment({ action: 'HOLD' }), strategy_council: undefined });
    const r = ledgerRowFor(ep, t)!;
    expect(r.snapshot).toBeNull();
    expect(r.timeframe).toBe('15m'); // 退回线程周期
    const settled = settleRow(r, bars([{ o: 100, h: 131, l: 99, c: 130 }]), t, NOW + 1);
    expect(settled.outcome_r_model).toBeNull();
    expect(settled.regret).toMatchObject({ hold_r: 3, exit_now_r: 0, regret_hold: 0 });
    expect(settled.regret_hold).toBe(0);
  });

  it('settleRow 的 review_bars:regret 走线程周期的 K 线,三条腿照旧吃快照周期', () => {
    const t = closedThread();
    const r = ledgerRowFor(episode({ thread_id: t.id, judgment: judgment({ action: 'HOLD' }) }), t)!;
    const legBars = bars(flat(3));
    const reviewBars = bars([{ o: 100, h: 101, l: 89, c: 90 }]);
    const a = settleRow(r, legBars, t, NOW + 1);
    const b = settleRow(r, legBars, t, NOW + 1, { review_bars: reviewBars });
    expect(a.regret!.hold_status).toBe('expired');
    expect(b.regret).toMatchObject({ hold_status: 'stop', hold_r: -1, regret_hold: 1 });
    expect(b.outcome_r_model).toBe(a.outcome_r_model);
  });

  it('by_decision 按 (action × holding_reason × trigger × prompt) 分组;EXIT 格给 regret>0.5R 占比,HOLD 格给 mean regret_hold', () => {
    const reg = (hold_r: number, exit_now_r: number, action: string): LedgerRegret => {
      const chosen_r = action === 'EXIT' ? exit_now_r : hold_r;
      const best_r = Math.max(hold_r, exit_now_r);
      return { hold_r, exit_now_r, chosen_r, best_r, regret_r: best_r - chosen_r, regret_hold: action === 'HOLD' ? Math.max(0, exit_now_r - hold_r) : null, regret_exit: action === 'EXIT' ? Math.max(0, hold_r - exit_now_r) : null, hold_status: 'expired', note: '' };
    };
    const rv = (action: string, trigger_kind: string, holding_reason: string | undefined, hold: number, exitNow: number, cluster: string): JudgmentLedgerRow => {
      const regret = reg(hold, exitNow, action);
      return row({ mode: 'review', model_action: action, trigger_kind, holding_reason, prompt_version: 'v8', cluster_id: cluster, thread_id: cluster, regret, regret_review: regret.regret_r, regret_hold: regret.regret_hold });
    };
    const rows = [
      rv('EXIT', 'heartbeat', 'unknown', 1.5, -0.2, 't1'), // 走早了 1.7R
      rv('EXIT', 'heartbeat', 'unknown', -1, -0.3, 't2'), // 走对了
      rv('EXIT', 'heartbeat', 'unknown', 0.1, 0, 't3'), // 小后悔 0.1R,不算 >0.5
      rv('HOLD', 'heartbeat', 'thesis_intact', -1, -0.4, 't1'),
      rv('HOLD', 'heartbeat', 'thesis_intact', 2, 0.5, 't2'),
      // 旧 jl-v1 行:没有分层键 → 读作 unknown
      { ...rv('HOLD', 'x', undefined, 1, 0, 't4'), trigger_kind: undefined, prompt_version: undefined, holding_reason: undefined },
      // scan 行、未结算行不进决策表
      row({ mode: 'scan', model_action: 'PROPOSE' }),
      { ...rv('HOLD', 'heartbeat', 'thesis_intact', 1, 0, 't5'), settled_at: null },
    ];
    const d = summarizeDecisions(rows);
    const exit = d.find((x) => x.model_action === 'EXIT')!;
    expect(exit).toMatchObject({ holding_reason: 'unknown', trigger_kind: 'heartbeat', prompt_version: 'v8', n: 3, clusters: 3, exit_regret_gt_half_share: 0.3333, mean_regret_hold: null, insufficient: true });
    expect(exit.mean_regret).toBeCloseTo((1.7 + 0 + 0.1) / 3, 3);
    const hold = d.find((x) => x.model_action === 'HOLD' && x.holding_reason === 'thesis_intact')!;
    expect(hold).toMatchObject({ n: 2, exit_regret_gt_half_share: null, mean_regret_hold: 0.3, mean_hold_r: 0.5, mean_exit_now_r: 0.05 });
    const legacy = d.find((x) => x.trigger_kind === 'unknown')!;
    expect(legacy).toMatchObject({ holding_reason: 'unknown', prompt_version: 'unknown', n: 1 });
    expect(d.reduce((a, x) => a + x.n, 0)).toBe(6);

    const s = summarizeLedger(rows);
    expect(s.by_decision).toEqual(d);
    expect(s.by_holding_reason.map((x) => x.value).sort()).toEqual(['thesis_intact', 'unknown']);
    expect(s.by_trigger_kind.find((x) => x.value === 'heartbeat')).toMatchObject({ dim: 'trigger_kind', review_hold_n: 2, review_regret_hold: 0.3 }); // 未结算那行不进
  });
});
