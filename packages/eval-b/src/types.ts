import { demo } from '@trading-swarm/gateway';

export interface EvalCase {
  id: string;
  set: string;
  tags: string[];
  symbol: string;
  timeframe: string;
  as_of: number;
  mode: 'scan' | 'review';
  thread: demo.StrategyThread | null;
  visible: {
    /** Exact strategy versions resolved for this episode; never load current DB heads in replay. */
    strategies?: demo.StrategySpec[];
    invalidation_confirm_bars?: number;
    invalidation_buffer_atr?: number;
    klines: Record<string, demo.Kline[]>;
    market: demo.MarketView;
    ticker24h: { priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string };
    oi_change_1h_pct: number | null;
    market_state: demo.MarketState | null;
    account: demo.AccountView;
    playbook_text: string;
    last_judgment_summary: string | null;
    halted: boolean;
    stale_all: boolean;
  };
  hidden: {
    future_klines: demo.Kline[];
    horizon_bars: number;
    rubric: { expected_any_of?: demo.Action[]; must_not?: demo.Action[]; note?: string } | null;
    mirror_of: string | null;
  };
}

export interface ValidationAttempt {
  raw: string;
  errors: string[];
  valid: boolean;
  cache_hit: boolean;
  usage: demo.BrainResult;
}

export interface EvalEpisode {
  version: 1;
  case_id: string;
  case_hash: string;
  case_file: string;
  tags: string[];
  mode: EvalCase['mode'];
  symbol: string;
  timeframe: string;
  as_of: number;
  context_text: string;
  context_hash: string;
  prompt_version: string;
  evidence: demo.Evidence[];
  allowed_actions: string[];
  brain: string;
  model: string;
  raw: string;
  judgment: demo.Judgment;
  first_attempt: ValidationAttempt;
  repair_attempt: ValidationAttempt | null;
  schema_valid_first: boolean;
  schema_valid_after_repair: boolean;
  fail_closed: boolean;
  errors: string[];
  gates: demo.GateResult[];
  reducer: demo.ReviewDecision | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
    estimated_cost_usd: number;
    cache_hits: number;
    calls: number;
  };
}

export interface RunManifest {
  version: 1;
  harness: '@trading-swarm/eval-b';
  cases_dir: string;
  brain: string;
  prompt_version: string;
  selected_tags: string[];
  limit: number | null;
  case_ids: string[];
  episode_count: number;
}

export type MetricStatus = 'PASS' | 'FAIL' | 'NOT_IMPLEMENTED';

export interface Metric {
  value: unknown;
  status: MetricStatus;
  threshold: string;
  examples: { case_id: string; reason: string }[];
}

export interface EvalReport {
  version: 1;
  harness: '@trading-swarm/eval-b';
  run_dir: string;
  brain: string;
  episode_count: number;
  promotion: 'PROMOTE_CANDIDATE' | 'HOLD';
  metrics: Record<string, Metric>;
}

export interface SimulatedOutcome {
  filled: boolean;
  fill_bar_index: number | null;
  entry_price: number | null;
  exit: 'stop' | 'take_profit' | 'expiry' | 'unfilled';
  r: number | null;
  mae_r: number | null;
  mfe_r: number | null;
  target_first: boolean;
}
