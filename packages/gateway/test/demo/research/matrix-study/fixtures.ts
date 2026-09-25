// 矩阵研究测试夹具:确定性合成行情 + 可控优势的假执行器 + 判断桩。只做工程验证,不是经济证据;零网络。
import type { ResearchBar, StrategyIR } from '@trading-swarm/contracts';
import type { AssetExecutor, AssetRunEquity, BarsLoader } from '../../../../src/demo/research/backtest-report.js';
import { candidateSnapshot } from '../../../../src/demo/research/judge/candidate.js';
import type { DecisionProvider, FrozenModelProfile } from '../../../../src/demo/research/judge/types.js';
import { synthBars } from '../backtest-report-fixtures.js';

export const H4 = 4 * 3600000, DAY = 86400000, START = Date.UTC(2022, 0, 1), NBARS = 3200;
export const TO_MS = START + NBARS * H4 - 1;
export const SYMS = ['BTCUSDT', 'ETHUSDT'];
const cache = new Map<string, ResearchBar[]>();
export function barsOf(symbol: string, step = H4): ResearchBar[] {
  const k = `${symbol}:${step}`;
  if (!cache.has(k)) cache.set(k, synthBars(Math.round((NBARS * H4) / step), step, 11 + symbol.length * 3, START, 100 + symbol.length * 7));
  return cache.get(k)!;
}
/** 合成 loader:记下每次请求的窗口(隔离断言用) */
export function loader(): BarsLoader & { calls: { symbol: string; tf: string; from_ms: number; to_ms: number }[] } {
  const calls: { symbol: string; tf: string; from_ms: number; to_ms: number }[] = [];
  const f = (async (symbol, tf, w) => {
    calls.push({ symbol, tf, from_ms: w.from_ms, to_ms: w.to_ms });
    const step = tf === '4h' ? H4 : tf === '1d' ? DAY : 15 * 60000;
    return { bars: barsOf(symbol, step).filter((b) => b.open_time >= w.from_ms && b.close_time <= w.to_ms), source: 'synthetic' };
  }) as BarsLoader & { calls: typeof calls };
  f.calls = calls; return f;
}
/** 测试用的放宽协议:只把块长缩到 2 天(合成窗口短),其余门槛保持严格 */
export const protocol = { block_days: 2, bootstrap_replicates: 299 };
export function baseSpec(o: Record<string, unknown> = {}) {
  return { symbols: SYMS, timeframes: ['4h'], families: ['ema_cross'], market: 'spot', sides: ['long'], arms: ['code'], window_days: { '4h': 400 }, to_ms: TO_MS, iterate: { top_k: 2, generations: 1, candidates_per_generation: 2, patience: 1 }, protocol, ...o };
}
export const PROFILE: FrozenModelProfile = { ref: 'jev_test_v1', connection_id: 'conn_test', connection_revision: 'r1', model: 'stub/jev', model_revision: 'stub-2026-09-25', routing: 'stub', parser_version: 'judge_answers_v1', max_call_usd: '0.0001', retry_policy: 'none' };
/** 判断桩:按 state 的确定性哈希决定跟 / 不跟;记录调用数 */
export function stubProvider(): DecisionProvider & { calls: number } {
  const p = {
    profile: PROFILE, calls: 0,
    decide: async (req: { state: Record<string, unknown> }) => {
      p.calls++;
      const s = JSON.stringify(req.state); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      const yes = h % 3 === 0 ? 0.3 : 0.8;
      return { model: PROFILE.model, answers: { take: { type: 'noul' as const, noul: yes }, quality: { type: 'score' as const, score: 2, confidence: 0.8, probabilities: { poor: 0.1, fair: 0.2, good: 0.4, excellent: 0.3 } } }, usage: { input_tokens: 600, cost_usd: 0.000027 }, latency_ms: 3 };
    },
  };
  return p;
}
/**
 * 可控优势的假执行器:从窗口起点起每 6 根开一笔、持 3 根,单笔收益 edge ± 噪声(扣 2× 手续费后仍为正),
 * 并按订单核同样的方式报候选(给账户级回放算止损距离)。IR 无关(同族不同参数成绩相同)。
 */
export function edgeExecutor(edge = 0.006): (ir: StrategyIR) => AssetExecutor {
  return (ir) => async (x) => {
    const bars = x.dataset.bars.filter((b) => b.close_time >= x.from_ms && b.close_time <= x.to_ms), fee = Number(x.fees?.taker ?? x.execution.fee_rate);
    let eq = Number(x.execution.initial_cash);
    const equity: AssetRunEquity[] = [], trades: ReturnType<AssetExecutor> extends Promise<infer R> ? R extends { trades: infer T } ? T : never : never = [] as never;
    let k = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!, inPos = i % 6 >= 1 && i % 6 <= 3;
      if (i % 6 === 0 && i + 4 < bars.length) {
        const c = candidateSnapshot(ir, { symbol: x.symbol, as_of: b.close_time + 1, timeframe_ms: x.dataset.timeframe_ms, direction: 'long', entry: b.close, stop: (Number(b.close) * 0.98).toFixed(8), target: null, reward_risk: null });
        x.on_candidate?.(c, null);
      }
      if (i % 6 === 4) {
        const r = edge + (k++ % 3 === 0 ? -0.002 : 0.001) - 2 * fee, pnl = eq * r;
        (trades as unknown as object[]).push({ id: `t${i}`, symbol: x.symbol, side: 'long', entry_at: bars[i - 3]!.open_time, entry_price: Number(bars[i - 3]!.open), exit_at: b.close_time, exit_price: Number(b.close), qty: 1, pnl, return_pct: r, fees: eq * 2 * fee, bars_held: 3, exit_reason: 'tp' });
        eq += pnl;
      }
      equity.push({ at: b.close_time, equity: eq, holdings: inPos ? eq : 0, exposure: inPos ? 1 : 0 });
    }
    return { status: 'completed', error: null, engine_version: 'edge-stub/1', equity, trades, fees: 0 };
  };
}
