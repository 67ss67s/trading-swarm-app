import { validKline } from './replay-stats.js';
import { strategyForBackend } from './strategies.js';
/** 独立零模型影子采样；不消费 episode 队列、paper 容量或模型预算。 */
import { SIGNAL_REGISTRY, nextSignalState, closedWeeks, type SignalState, type SignalFn } from './strategy-signals.js';
import { tfToMs, dailyRegime } from './market.js';
import { openShadowThread } from './strategy-loop.js';
import type { DemoStore } from './store.js';
import type { Kline } from './types.js';

export async function sampleShadow(store: DemoStore, deps: {
  shouldStop?: () => boolean;
  symbols: string[]; now: number; backend: string;
  fetchKlines: (symbol: string, tf: string, limit: number) => Promise<Kline[]>;
  signal?: SignalFn;
  fetchFunding?: (symbol: string) => Promise<{ at: number; rate: string }[]>;
  log?: (message: string) => void;
}): Promise<number> {
  let opened = 0;
  const specs = store.strategies.list().flatMap(h => store.strategies.versions(h.id)).filter(s => strategyForBackend(s, deps.backend).status === 'shadow');
  const cache = new Map<string, Promise<Kline[]>>();
  for (const spec of specs) for (const symbol of [...new Set(deps.symbols)]) {
    try {
      if (deps.shouldStop?.()) return opened;
      const tf = spec.trigger.min_timeframe;
      const generation = spec.health_by_backend?.[deps.backend]?.generation ?? 0;
      const key = `shadow.cursor:${spec.id}:${spec.version}:${spec.content_hash}:${deps.backend}:${generation}:${symbol}`;
      const stored = store.kvGet(key);
      let state: SignalState = stored ? JSON.parse(stored) as SignalState : { compression_bars: 0, armed: false, last_at: -1 };
      const bars: Record<string, Kline[]> = {};
      for (const frame of new Set([tf, ...spec.checklist.timeframes, '1d'])) {
        if (frame === '1w') continue;
        const depth = Math.max(frame === '1d' ? (spec.checklist.timeframes.includes('1w') ? 560 : 260) : frame === '1h' && frame !== tf ? 120 : frame === '4h' && frame !== tf ? 80 : 150, frame === tf ? spec.checklist.min_bars ?? 0 : 0);
        const ck = `${symbol}:${frame}:${depth}`;
        if (!cache.has(ck)) cache.set(ck, deps.fetchKlines(symbol, frame, depth));
        const raw = await cache.get(ck)!;
        if (deps.shouldStop?.()) return opened;
        const ms = tfToMs(frame);
        const closed = raw.filter(b => b.close_time < deps.now).sort((a,b) => a.open_time-b.open_time);
        if (!closed.length || closed.at(-1)!.close_time < Math.floor(deps.now/ms)*ms-1 || closed.some((b,i) => !validKline(b) || b.close_time !== b.open_time+ms-1 || (i > 0 && b.open_time !== closed[i-1]!.open_time+ms))) throw new Error(`${symbol} ${frame} 数据水位/连续性不足`);
        bars[frame] = closed;
      }
      bars['1w'] = closedWeeks(bars['1d']!, deps.now);
      const base = bars[tf]!;
      if (base.length < Math.max(51, spec.checklist.min_bars ?? 0)) continue;
      const at = base.at(-1)!.close_time;
      if (at <= state.last_at || at < (spec.health_by_backend?.[deps.backend]?.window_from ?? 0)) continue;
      // 首次与断线恢复均依次预热状态，只有最新闭合根产生在线样本。
      const funding = spec.family === 'derivatives' && deps.fetchFunding ? await deps.fetchFunding(symbol) : [];
      if (deps.shouldStop?.()) return opened;
      let setup: ReturnType<SignalFn> = null;
      for (let i = 0; i < base.length; i++) {
        const t = base[i]!.close_time;
        if (t <= state.last_at) continue;
        const visible = Object.fromEntries(Object.entries(bars).map(([frame, bs]) => { const limit = frame === tf ? Math.max(frame === '1d' ? 260 : 150, spec.checklist.min_bars ?? 0) : frame === '1h' ? 120 : frame === '4h' || frame === '1w' ? 80 : 260; return [frame, bs.filter(b => b.close_time <= t).slice(-limit)]; }));
        const ctx = { bars: visible, params: spec.params, derivatives: { funding: funding.filter(f => f.at <= t), oi_change_pct: null }, regime: dailyRegime(visible['1d'] ?? [], t)?.regime ?? null, timeframe: tf, confirmation: spec.checklist.timeframes.filter(f => f !== tf), state };
        if (t === at) setup = (deps.signal ?? SIGNAL_REGISTRY[spec.family])(ctx);
        state = spec.family === 'volatility' ? nextSignalState(ctx) : { ...state, last_at: t };
      }
      store.kvSet(key, JSON.stringify(state));
      const lastOpen = store.shadowThreads.forVersion(spec.id, spec.version).find(t => t.symbol === symbol && t.backend === deps.backend && (t.generation ?? 0) === generation)?.opened_at;
      if (lastOpen !== undefined && at - lastOpen < spec.trigger.cooldown_bars * tfToMs(tf)) continue;
      if (!setup || store.shadowThreads.openFor(spec.id, spec.version, symbol, deps.backend, generation)) continue;
      const t = openShadowThread({ spec, symbol, timeframe: tf, side: setup.direction, at, snapshot: { timeframe: tf, last_close: Number(setup.reference_price), mark: null, atr14: setup.atr, swing_high_20: Number(setup.reference_price), swing_low_20: Number(setup.reference_price), ema20_1h: null, ema50_1h: null } });
      store.shadowThreads.save({ ...t, generation, setup, backend: deps.backend, score_kind: 'full_strategy' });
      opened++;
    } catch (e) { deps.log?.((e as Error).message); }
  }
  return opened;
}
