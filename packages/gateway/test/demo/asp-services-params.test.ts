import { describe, expect, it } from 'vitest';
import type { PerCallJob } from '../../src/demo/asp-agent/services/types.js';
import { freeText, jsonParams, positive } from '../../src/demo/asp-agent/services/params.js';
import { planGateService } from '../../src/demo/asp-agent/services/plan-gate.js';
import { jevProbabilityService } from '../../src/demo/asp-agent/services/jev-probability.js';
import { assetHorizonService } from '../../src/demo/asp-agent/services/asset-horizon.js';
import { validateMatrix } from '../../src/demo/asp-agent/services/matrix-report.js';
import { validateQuick } from '../../src/demo/asp-agent/services/quick-backtest.js';

// 买方 agent 照着上架描述自己拼 JSON 的各种写法;以前这些要么整单拒,要么字段被悄悄丢掉
const job = (params: unknown, description = 'Please review this request.'): PerCallJob =>
  ({ job_id: 'job1', service_key: 'plan_gate', description, service_params: typeof params === 'string' ? params : JSON.stringify(params) });

describe('buyer JSON params: key aliases and value spellings', () => {
  it('camelCase / alias keys reach the plan fields', () => {
    expect(planGateService.validate(job({ pair: 'BTC-USDT-SWAP', side: 'Long', entryPrice: '84,300', stopLoss: '$83100', takeProfit: [86500, '88000 USDT'], interval: '1H' })))
      .toMatchObject({ symbol: 'BTCUSDT', side: 'long', entry: 84300, stop: 83100, targets: [86500, 88000], timeframe: '1h' });
    expect(planGateService.validate(job({ instId: 'ETH-USDT-SWAP', direction: 'short', entry_price: 2500, sl: 2600, tp: 2300, bar: '4H' })))
      .toMatchObject({ symbol: 'ETHUSDT', side: 'short', entry: 2500, stop: 2600, targets: [2300], timeframe: '4h' });
    expect(planGateService.validate(job({ coin: 'Bitcoin', side: 'bullish', entry: 84300, stop: 83100 }))).toMatchObject({ symbol: 'BTCUSDT', side: 'long' });
  });
  it('the original key wins over an alias', () => {
    expect(jsonParams(job({ symbol: 'ETH', pair: 'BTC' }))).toMatchObject({ symbol: 'ETH' });
  });
  it('market spellings: futures / SWAP / perpetual / Spot', () => {
    expect(jevProbabilityService.validate(job({ symbol: 'BTC', market: 'futures' }))).toMatchObject({ market: 'perp' });
    expect(jevProbabilityService.validate(job({ symbol: 'BTC', market: 'SWAP' }))).toMatchObject({ market: 'perp' });
    expect(jevProbabilityService.validate(job({ symbol: 'BTC', marketType: 'Spot' }))).toMatchObject({ market: 'spot' });
    expect(validateQuick(job({ symbol: 'BTC', timeframe: '4h', market: 'Perpetual', family: 'breakout' }))).toMatchObject({ market: 'perp' });
  });
  it('probability horizon_bars accepts "12 bars"', () => {
    expect(jevProbabilityService.validate(job({ symbol: 'BTC', horizonBars: '12 bars' }))).toMatchObject({ horizon_bars: 12 });
  });
  it('asset picks: horizon spellings and top', () => {
    expect(assetHorizonService.validate(job({ horizons: ['short-term', 'Mid Term', 'long_term'], market: 'futures', top: 5 })))
      .toMatchObject({ horizons: ['short', 'mid', 'long'], market: 'perp', top_n: 5 });
    expect(assetHorizonService.validate(job({ horizon: 'medium', coins: ['Bitcoin', 'eth'] }))).toMatchObject({ horizons: ['mid'], symbols: ['BTCUSDT', 'ETHUSDT'] });
  });
  it('matrix: sides / families / timeframes case and aliases', () => {
    expect(validateMatrix(job({ symbols: ['BTC'], timeframes: ['4H'], sides: ['Long', 'SHORT'], families: ['Breakout', 'mean-reversion'] })))
      .toMatchObject({ timeframes: ['4h'], sides: ['long', 'short'], families: ['breakout', 'mean_reversion'] });
    expect(validateMatrix(job({ symbols: ['BTC'], timeframes: '1D', sides: 'both' }))).toMatchObject({ timeframes: ['1d'], sides: ['long', 'short'] });
  });
  it('quick backtest: strategy text in an unknown JSON key is not lost; family spelled loosely', () => {
    expect(validateQuick(job({ symbol: 'BTC', timeframe: '4H', strategy: 'go long on a close above the prior 20-bar high, 2 ATR stop, 3R target' }, 'Backtest please')))
      .toMatchObject({ symbol: 'BTCUSDT', timeframe: '4h', idea: { family: 'breakout' } });
    expect(validateQuick(job({ symbol: 'BTC', timeframe: '1h', family: 'EMA-Cross' }))).toMatchObject({ idea: { family: 'ema_cross' } });
    expect(validateQuick(job({ symbol: 'BTC', timeframe: '1h', family: 'RSI oversold bounce' }))).toMatchObject({ idea: { family: 'mean_reversion' } });
  });
  it('freeText keeps unknown JSON fields as "key: value" lines and leaves known ones out', () => {
    const t = freeText(job({ symbol: 'BTC', entryRule: 'close above 20-bar high', notes: ['tight stop'] }, 'desc'));
    expect(t).toContain('entry rule: close above 20-bar high'); expect(t).toContain('notes: tight stop'); expect(t).not.toContain('symbol:');
  });
  it('positive() reads formatted numbers', () => {
    expect([positive('84,300'), positive('$84300.5'), positive('84300 USDT'), positive('1,234,567'), positive('abc'), positive('-5')]).toEqual([84300, 84300.5, 84300, 1234567, null, null]);
  });
});
