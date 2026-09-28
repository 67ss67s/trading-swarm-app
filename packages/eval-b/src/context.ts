import { demo } from '@trade-gate/gateway';

import type { EvalCase } from './types.js';
import { sha256 } from './util.js';

const STALE_SHIFT_MS = 10 * 60_000;

function forceStaleRegistry(context: demo.BuiltContext): demo.BuiltContext {
  const evidence = context.evidence.map((item) =>
    item.kind === 'market' || item.kind === 'structure' ? { ...item, stale: true } : item,
  );
  const staleRefs = new Set(evidence.filter((item) => item.stale).map((item) => item.ref));
  const markLines = (text: string): string =>
    text
      .split('\n')
      .map((line) => {
        const match = /^(E\d+) \[/.exec(line);
        return match?.[1] && staleRefs.has(match[1]) && !line.endsWith(' (STALE)') ? `${line} (STALE)` : line;
      })
      .join('\n');
  const userText = markLines(context.user_text);
  const contextText = `[system]\n${context.system_text}\n\n[user]\n${userText}`;
  return { ...context, evidence, user_text: userText, context_text: contextText, context_hash: sha256(contextText) };
}

/** Builds exactly one model context, filtering future bars before production feature computation. */
export function buildEvalContext(evalCase: EvalCase): demo.BuiltContext {
  const klines = Object.fromEntries(Object.entries(evalCase.visible.klines).map(([tf, bars]) => [tf, bars.filter((kline) => kline.close_time <= evalCase.as_of)]));
  const features = Object.entries(klines).map(([timeframe, visible]) => {
    if (visible.length < 5) throw new Error(`${evalCase.id}: ${timeframe} needs at least five closed bars`);
    const feature = demo.tfFeatures(timeframe, visible);
    return evalCase.visible.stale_all ? { ...feature, last_open_time: feature.last_open_time - STALE_SHIFT_MS } : feature;
  });
  const market = {
    ...evalCase.visible.market,
    as_of: evalCase.visible.stale_all
      ? Math.min(evalCase.visible.market.as_of, evalCase.as_of - STALE_SHIFT_MS)
      : evalCase.visible.market.as_of,
  };
  const built = demo.buildContext({
    now: evalCase.as_of,
    symbol: evalCase.symbol,
    trigger: {
      kind: evalCase.mode === 'review' ? 'thread_review' : 'scan',
      detail: evalCase.mode === 'review' ? 'eval 连续复查' : 'eval 历史扫描',
    },
    mode: evalCase.mode,
    thread: evalCase.thread,
    open_threads: evalCase.thread ? [evalCase.thread] : [],
    account: evalCase.visible.account,
    market,
    features,
    klines,
    strategies: evalCase.visible.strategies,
    invalidation_confirm_bars: evalCase.visible.invalidation_confirm_bars,
    invalidation_buffer_atr: evalCase.visible.invalidation_buffer_atr,
    oi_change_1h_pct: evalCase.visible.oi_change_1h_pct,
    ticker24h: evalCase.visible.ticker24h,
    market_state: evalCase.visible.market_state,
    playbook_text: evalCase.visible.playbook_text,
    last_judgment_summary: evalCase.visible.last_judgment_summary,
    halted: evalCase.visible.halted,
  });
  // Production currently treats structure features as explicitly fresh. stale_all is an adversarial
  // eval transform, so the harness marks the deliberately aged market/structure registry entries.
  return evalCase.visible.stale_all ? forceStaleRegistry(built) : built;
}
