// Eval-side domain types (docs/eval/README.md §2). Everything the gateway already defines is taken
// from `demo` so the case files are literally the runtime's own shapes.

import type { demo } from '@trade-gate/gateway';
import type { EpisodeGraph } from './graph.js';
import type { GateEnv } from './gate-coverage.js';

export type Kline = demo.Kline;
export type Action = demo.Action;
export type Direction = demo.Direction;
export type StrategyThread = demo.StrategyThread;
export type MarketView = demo.MarketView;
export type MarketState = demo.MarketState;
export type AccountView = demo.AccountView;
export type Judgment = demo.Judgment;
export type Evidence = demo.Evidence;
export type GateResult = demo.GateResult;
export type Trigger = demo.Trigger;
export type MemoryItem = demo.MemoryItem;
export type MemoryKind = demo.MemoryKind;

export interface Ticker24h {
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
}

export interface CaseRubric {
  expected_any_of?: Action[];
  must_not?: Action[];
  note?: string;
}

export interface EvalCase {
  id: string;
  set: string;
  /** Generation provenance; absent on legacy case sets. Kept equal to the top-level set. */
  meta?: { set: string };
  /** 'scan' | 'review' | 'stale' | 'halted' | 'mirror' | 'chain:<chain_id>:<n>' | status/direction tags */
  tags: string[];
  symbol: string;
  timeframe: string;
  as_of: number;
  mode: 'scan' | 'review';
  thread: StrategyThread | null;
  visible: {
    klines: Record<string, Kline[]>;
    market: MarketView;
    ticker24h: Ticker24h;
    oi_change_1h_pct: number | null;
    market_state: MarketState | null;
    account: AccountView;
    playbook_text: string;
    last_judgment_summary: string | null;
    halted: boolean;
    stale_all: boolean;
    /**
     * Long-term memories to inject for this case (`gen-memory` variants only; absent on plain cases).
     * They are handed to `demo.buildContext({ memories })` verbatim, so each one becomes an evidence line
     * `E<n> [记忆 <id>·<kind>]` the judgment may cite like any other E.
     */
    memories?: MemoryItem[];
    /**
     * 定向闸用例(`cases/v4-gates`)才写的运行时环境:paused / opens_today / 其它线程 / 议会模式 …
     * 缺席时 harness 只跑 `demo.evaluateGates`,与 09-12 之前逐字一致(docs/eval/gate-coverage-2026-09-12.md)。
     */
    gate_env?: GateEnv;
  };
  hidden: {
    future_klines: Kline[];
    horizon_bars: number;
    rubric: CaseRubric | null;
    mirror_of: string | null;
    /** Memory variant → the case it was derived from (`gen-memory`); null/absent on every other case. */
    memory_of?: string | null;
    /** 这个 case 想验证的闸 / 边(只是标注,报告里用来说明「谁负责覆盖谁」)。 */
    covers?: string[];
  };
}

/** Which memories were put in front of the model and which ones the judgment actually cited. */
export interface EpisodeMemory {
  injected: string[];
  cited: string[];
}

export interface EpisodeUsage {
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  /** Model calls actually made (or served from cache) for this episode: 1, or 2 with a repair round. */
  model_calls: number;
  cost_estimate: string;
  currency: string;
}

export interface ReviewOutcome {
  accepted: boolean;
  reason: string;
  effect: string;
}

export interface EpisodeRecord {
  case_id: string;
  set: string;
  tags: string[];
  symbol: string;
  timeframe: string;
  as_of: number;
  mode: 'scan' | 'review';
  brain: string;
  model: string;
  prompt_version: string;
  trigger: Trigger;
  context_text: string;
  context_hash: string;
  evidence: Evidence[];
  allowed_actions: string[];
  stale_refs: string[];
  raw: string;
  raw_repair: string | null;
  errors_first: string[];
  errors_repair: string[];
  judgment_source: 'first' | 'repair' | 'fail_closed';
  judgment: Judgment;
  /**
   * v3.5 strategy library: the strategy the judgment named (mirrors `judgment.strategy_id`, hoisted so a
   * report can group by it without digging). Absent on runs recorded before the library existed.
   */
  strategy_id?: string | null;
  gates: GateResult[];
  gates_passed: boolean;
  review: ReviewOutcome | null;
  /**
   * Where this episode sat in the judgment graph (docs/design/graph-engineering-v2.md §2). Optional
   * because runs made before the graph landed (`runs/pi-v1`, `runs/pi-v3`) have none — the report
   * back-fills those from (mode, thread, halted) + judgment + gates and says so.
   */
  graph?: EpisodeGraph;
  /** Optional for the same reason as `graph`: runs made before long-term memory landed have none. */
  memory?: EpisodeMemory;
  usage: EpisodeUsage;
  brain_error: string | null;
  /**
   * Multi-sample runs (docs/eval/denoise-plan-2026-09-04.md): every sample of the SAME context. The top-level
   * judgment/raw/errors/source/brain_error are those of the MODE sample (most frequent action; ties → lowest k).
   * Absent on single-sample runs (runs/pi-v1, pi-v3, pi-v3-mem), which the report treats as N=1, agreement 1.
   */
  samples?: SampleRecord[];
  /** mode votes / N. */
  agreement?: number;
  actions_seen?: Record<string, number>;
  mode_tie?: boolean;
}

export interface SampleRecord {
  k: number;
  raw: string;
  raw_repair: string | null;
  errors_first: string[];
  errors_repair: string[];
  judgment_source: 'first' | 'repair' | 'fail_closed';
  judgment: Judgment;
  brain_error: string | null;
  usage: EpisodeUsage;
  /** Memory ids this sample's judgment cited (same rule as EpisodeMemory.cited). */
  memory_cited: string[];
}

export interface RunMeta {
  run_id: string;
  brain: string;
  model: string;
  prompt_version: string;
  cases_dir: string;
  set: string;
  limit: number | null;
  tags: string[];
  /** `--only` id list this run was narrowed to (absent/empty = the whole set). */
  only?: string[];
  concurrency: number;
  started_at: number;
  finished_at: number;
  wall_ms: number;
  episodes: number;
  cache_hits: number;
  cache_misses: number;
  brain_errors: number;
}
