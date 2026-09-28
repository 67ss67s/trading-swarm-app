// EvalCase → demo.EpisodeInputs. This is the seam that guarantees the eval feeds the *same* context
// builder the live loop uses; nothing about evidence or staleness is computed here.

import { demo } from '@trade-gate/gateway';
import type { EvalCase, Trigger } from './types.js';

/** `trigger:<kind>` 标签里合法的事件名(判断图的事件边就是按这个 kind 分的)。 */
const TRIGGER_KINDS = new Set(demo.JUDGMENT_GRAPH.event_edges.map((e) => e.event as string));

export function triggerFor(c: EvalCase): Trigger {
  const iso = new Date(c.as_of).toISOString().slice(0, 16).replace('T', ' ');
  // 09-12:标签里显式写了事件名就按它走(事件边覆盖用例需要 kline_close 之外的 kind);没写时维持旧默认。
  const kindTag = c.tags.find((t) => t.startsWith('trigger:'))?.slice('trigger:'.length);
  if (kindTag && TRIGGER_KINDS.has(kindTag)) {
    const kind = kindTag as Trigger['kind'];
    const detail = kind === 'order_filled' ? `入场成交后首次复查 ${iso} UTC` : kind === 'position_review' ? `持仓复查 ${iso} UTC` : kind === 'thread_review' ? `挂单复查 ${iso} UTC` : c.mode === 'scan' ? `${kind} 唤醒扫描 ${iso} UTC` : `${kind} 唤醒复查 ${iso} UTC`;
    return { kind, detail };
  }
  if (c.mode === 'scan') return { kind: 'kline_close', detail: `${c.timeframe} 收盘 ${iso} UTC` };
  return { kind: 'thread_review', detail: `挂单复查 ${iso} UTC` };
}

export function featureTfs(c: EvalCase): string[] {
  const tfs = [c.timeframe, '1h', '4h'];
  return tfs.filter((tf, i) => tfs.indexOf(tf) === i && c.visible.klines[tf] !== undefined);
}

export function caseToInputs(c: EvalCase): demo.EpisodeInputs {
  const v = c.visible;
  return {
    now: c.as_of,
    symbol: c.symbol,
    trigger: triggerFor(c),
    mode: c.mode,
    thread: c.mode === 'review' ? c.thread : null,
    open_threads: c.thread ? [c.thread] : [],
    account: v.account,
    market: v.market,
    features: featureTfs(c).map((tf) => demo.tfFeatures(tf, v.klines[tf]!)),
    oi_change_1h_pct: v.oi_change_1h_pct,
    ticker24h: v.ticker24h,
    market_state: v.market_state,
    playbook_text: v.playbook_text,
    last_judgment_summary: v.last_judgment_summary,
    halted: v.halted,
    // 09-12:`watch_only` 标签 → scan:watch_only 节点(判断图 v3),边覆盖用例需要它。
    watch_only: c.tags.includes('watch_only'),
    // v3 code-computed evidence, same as the live runtime (runtime.ts dailyRegimeFor / sessionInfo): without these
    // the model never saw a 日线状态 line while regime_agreement judged it against dailyRegime() — a 口径 bug
    // (docs/eval/results-2026-09-04.md v6 设计集段). Recorded cases without 1d bars build exactly as before.
    daily_regime: v.klines['1d'] && v.klines['1d'].length >= 30 ? demo.dailyRegime(v.klines['1d'], c.as_of) : null,
    session: demo.sessionInfo(c.as_of),
    // Long-term memory: the case carries the *recall result* (gen-memory picks it deliberately, including
    // memories real recall would never return), buildContext registers each one as a `记忆` evidence line.
    memories: v.memories ?? [],
  };
}

export interface BuiltCase {
  inputs: demo.EpisodeInputs;
  built: demo.BuiltContext;
  stale_refs: string[];
}

export function buildCase(c: EvalCase): BuiltCase {
  const inputs = caseToInputs(c);
  const built = demo.buildContext(inputs);
  return { inputs, built, stale_refs: built.evidence.filter((e) => e.stale).map((e) => e.ref) };
}
