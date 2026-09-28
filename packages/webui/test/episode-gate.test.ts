/** #judgments:闸门拒绝显示成中性的「没下单 — 原因」,真正的异常才标出错(lib/episode-gate.ts)。 */
import { describe, expect, it } from 'vitest';
import { episodeGateReason } from '../src/lib/episode-gate';

const PLAN = '持仓计划: 主周期ATR/入场价格缺失，无法建立持仓契约';
const ATR = '策略ATR尺度: 1h ATR=1.766428571429，选择1.5倍，实际1.160533764659倍；策略下限1倍;净盈亏比: 净RR=0.433381871133，需≥1';

describe('episodeGateReason', () => {
  it('reducer rejected and error is the same text → gate rejection', () => {
    expect(episodeGateReason({ error: PLAN, reducer: { accepted: false, reason: PLAN } })).toBe(PLAN);
    expect(episodeGateReason({ error: ATR, reducer: { accepted: false, reason: ATR } })).toBe(ATR);
  });

  it('falls back to sentence prefixes when there is no reducer', () => {
    expect(episodeGateReason({ error: PLAN, reducer: null })).toBe(PLAN);
    expect(episodeGateReason({ error: '净RR: 0.4 < 1.0', reducer: null })).toBe('净RR: 0.4 < 1.0');
  });

  it('real failures stay errors', () => {
    const net = '/api/v5/market/candles?instId=AVAX-USDT-SWAP&bar=15m&limit=80 -> HTTP 429(限频熔断中,7s 后再试)';
    expect(episodeGateReason({ error: net, reducer: null })).toBeNull();
    // reducer 拒绝了,但 error 是别的异常:仍是 Error
    expect(episodeGateReason({ error: net, reducer: { accepted: false, reason: '没有优势' } })).toBeNull();
    expect(episodeGateReason({ error: null, reducer: { accepted: false, reason: PLAN } })).toBeNull();
    expect(episodeGateReason({ error: '', reducer: null })).toBeNull();
  });
});
