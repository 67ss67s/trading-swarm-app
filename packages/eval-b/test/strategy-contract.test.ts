import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { demo } from '@trade-gate/gateway';
import { describe, expect, it } from 'vitest';
import { buildEvalContext } from '../src/context.js';
import { evaluateCase } from '../src/runner.js';
import { minimalCase } from './helpers.js';

describe('production strategy contract parity', () => {
  it('forwards exact strategy version and uses it in model context', () => {
    const c = minimalCase();
    const strategy = demo.BUILTIN_STRATEGIES.find((s) => s.id === 'breakout_retest')!;
    c.visible.strategies = [{ ...strategy, version: 42, name: 'pinned-research-version' }];
    const built = buildEvalContext(c);
    expect(built.strategy_ids).toEqual(['breakout_retest']);
    expect(built.system_text).toContain('pinned-research-version v42');
  });
  it('rejects a PROPOSE with an unknown strategy in both first and repair responses', async () => {
    const c = minimalCase();
    c.visible.strategies = [demo.BUILTIN_STRATEGIES.find((s) => s.id === 'breakout_retest')!];
    const p = Number(c.visible.market.mark);
    const brain = { name: 'invalid-strategy-fixture', async complete() {
      return { text: JSON.stringify({ action: 'PROPOSE', direction: 'long', confidence: 0.6, headline: 'fixture', thesis: 'fixture', reasons: ['fixture [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], strategy_id: 'unavailable_strategy', proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: String(p * .99), take_profits: [String(p * 1.02)], rationale: 'fixture' } }), model: 'fixture', input_tokens: 0, output_tokens: 0, latency_ms: 0 };
    }};
    const ep = await evaluateCase(c, 'fixture', brain, await mkdtemp(path.join(tmpdir(), 'strategy-contract-')));
    expect(ep.schema_valid_first).toBe(false);
    expect(ep.repair_attempt?.valid).toBe(false);
    expect(ep.fail_closed).toBe(true);
    expect(ep.first_attempt.errors.join(' ')).toContain('strategy_id');
  });
  it('forwards actual closed bars so two-close invalidation can be reproduced', () => {
    const c = minimalCase();
    c.mode = 'review';
    const bars = c.visible.klines['1h']!;
    bars.at(-2)!.close = '41900'; bars.at(-1)!.close = '41900';
    c.thread = demo.newThread({ id: 'fixture', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', horizon: 'intraday', thesis: 'fixture', invalidation_text: '42000', watch_conditions: [], entry: { type: 'market', price: '43000', zone: null }, stop_price: '40000', take_profits: ['46000'], qty: '0.01', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: c.as_of - 20000000 });
    c.thread.status = 'in_position'; c.thread.opened_at = c.as_of - 20000000; c.thread.filled_avg_price = '43000';
    c.visible.invalidation_confirm_bars = 2; c.visible.invalidation_buffer_atr = 0;
    const built = buildEvalContext(c);
    const metrics = built.evidence.find((e) => e.label === '持仓度量(代码计算)')!;
    expect(metrics.value).toContain('连续 2 根');
    expect(metrics.value).toContain('失效确认=是');
  });
  it('does not forward a future bar to either features or raw-bar evidence', () => {
    const c = minimalCase(); const before = buildEvalContext(c);
    c.visible.klines['1h']!.push({ ...c.visible.klines['1h']!.at(-1)!, open_time: c.as_of + 1, close_time: c.as_of + 3600000, close: '987654321' });
    expect(buildEvalContext(c).context_text).toBe(before.context_text);
  });
});
