/**
 * English override tables for the public review demo (TG_PUBLIC_LANG=en).
 *
 * The source constants in agent-registry.ts (AGENT_REGISTRY, CHAT_TOOL_CATALOG) and
 * bots.ts (SEEDS) are written in Chinese. For the English-speaking OKX review audience,
 * these tables replace that constant text at the HTTP response exit only. The database,
 * the model prompts and the source constants are left untouched.
 *
 * Coverage rules: every BotRole has an AGENT_EN and a BOT_EN entry, every AGENT_REGISTRY
 * graph node id has an entry in `nodes`, and every CHAT_TOOL_CATALOG key has a TOOL_EN entry.
 * `edges` is keyed `${from}->${to}` and only present when a source edge carries a label
 * (none currently do).
 */
import type { BotRole } from './bots.js';

export interface AgentEn {
  tagline: string;
  cadence: string;
  nodes: Record<string, string>;
  edges?: Record<string, string>;
}

export const AGENT_EN: Record<BotRole, AgentEn> = {
  gate_captain: {
    tagline: 'Summarizes team status, goals and to-dos',
    cadence: 'Checks the daily brief every 30 minutes',
    nodes: {
      trigger: 'Scheduled brief check',
      read: 'Team, risk and unread handoffs',
      work: 'Code compiles the daily brief',
      output: 'Brief and activity feed',
    },
  },
  radar: {
    tagline: 'Screens candidates and market information',
    cadence: 'Per screening cycle and info scout frequency',
    nodes: {
      trigger: 'Three-tier screen due / manual',
      read: 'Market data and strategy conditions',
      work: 'Hard-gate filtering and deterministic ranking',
      model: 'Shortlist when budget allows',
      output: 'Candidates and watchlist proposals',
      handoff: 'Hand off to Gate Captain for review',
    },
  },
  thread_manager: {
    tagline: 'Maintains trade theses and thread continuity',
    cadence: 'Events, candle closes and heartbeat',
    nodes: {
      trigger: 'Trigger / thread event',
      read: 'Evidence, threads and memory',
      work: 'Judge and update the trade thesis',
      gate: 'Code budget and risk gates',
      output: 'Judgment record and pending intent',
      handoff: 'Hand off to Executor once authorized',
    },
  },
  strategy_lab: {
    tagline: 'Research, experiments and strategy candidates',
    cadence: 'Checks experiment conditions every 30 minutes',
    nodes: {
      trigger: 'Due / new closes / manual',
      read: 'Strategy versions and historical data',
      work: 'Freeze experiment and compute results',
      output: 'Experiment results and candidate proposals',
      handoff: 'Hand off to Gate Captain for review',
    },
  },
  portfolio_manager: {
    tagline: 'Accounts for exposure, cluster concentration and risk budget',
    cadence: 'Account polling and proposal triggers',
    nodes: {
      trigger: 'Account poll / proposal',
      read: 'Account and thread snapshot',
      work: 'Exposure, clusters and stop-loss budget',
      gate: 'Portfolio hard gates and bounded sizing opinion',
      output: 'Portfolio snapshot and proposal opinion',
    },
  },
  risk_sentinel: {
    tagline: 'Checks invariants, alerts and rejection reasons',
    cadence: 'Triggered by account polling',
    nodes: {
      trigger: 'Account poll',
      read: 'Account, protection and channel health',
      work: 'Code checks risk invariants',
      gate: 'Reject new risk or tighten',
      output: 'Fingerprinted alerts and recovery conditions',
    },
  },
  reviewer: {
    tagline: 'Post-trade reviews and lessons pending approval',
    cadence: 'Close events and a check every 30 minutes',
    nodes: {
      trigger: 'Close / scheduled batch check',
      read: 'Close cards and existing lessons',
      work: 'Code review / distill when budget allows',
      output: 'Review cards and lessons pending approval',
      handoff: 'Hand off to Gate Captain for review',
      human: 'Operator approves lessons',
    },
  },
  executor: {
    tagline: 'Explains authorized execution, protection and reconciliation',
    cadence: 'Authorization requests and account polling',
    nodes: {
      trigger: 'Authorization request / reconciliation poll',
      gate: 'Execution controls and gate re-check',
      work: 'Submit and maintain protective legs',
      read: 'Receipts and order reconciliation',
      output: 'Intent, thread and settlement records',
    },
  },
  asp_agent: {
    tagline: 'Manages signal market inbound, delivery and after-sales',
    cadence: 'Task intake every minute; inbound polled per settings',
    nodes: {
      trigger: 'provider-tasks poll / inbound event',
      read: 'serviceId, tasks and subscription sets',
      gate: 'Handler, pause and parameter validation',
      work: 'Accept and deliver / fan out per service',
      output: 'Inbound, delivery and verification ledger',
      handoff: 'Escalate exceptions and after-sales to Gate Captain',
      human: 'Market page activation, payout claims and after-sales',
    },
  },
};

export interface ToolEn {
  summary: string;
  doc: string;
}

/** Build a doc string as `${example}:${summary}` so the two never drift apart. */
function t(example: string, summary: string): ToolEn {
  return { summary, doc: `${example}:${summary}` };
}

export const TOOL_EN: Record<string, ToolEn> = {
  get_state: t('get_state{}', 'Account, market, workflow, queue and the latest info scout summary.'),
  list_threads: t('list_threads{"status":"open|all"}', 'List of strategy threads.'),
  get_thread: t('get_thread{"id":"thr-…"}', "One thread's details, judgment records and activity feed."),
  get_episode: t(
    'get_episode{"id":"ep-…"}',
    'The evidence a judgment record saw at the time (E1…En verbatim), the judgment it produced and the code gate results. Use this when the user asks "why was this judged this way".',
  ),
  list_history: t(
    'list_history{"limit":20}',
    'Closed trades (PnL, R multiple, holding time, close reason) and stats (win rate, payoff ratio, breakdown by coin/source). Use when the user wants a review.',
  ),
  propose_thread: t(
    'propose_thread{"symbol":"BTCUSDT","side":"long|short","entry":"market|limit","limit_price":"… or null","stop_price":"…","take_profits":["…"],"thesis":"one sentence"}',
    'Propose a thread. Size is computed by code and the same gates apply. If workflow auto-execution is off, it waits for the user to confirm in the UI.',
  ),
  close_thread: t('close_thread{"id":"thr-…"}', 'Close / cancel a thread (market).'),
  set_workflow: t(
    'set_workflow{"patch":{…}}',
    'narrate / info_every_ms / heartbeat_every_ms / review_every_close / scan_mode(triggered|every_close) / fast_move_pct / paused=true take effect immediately. watchlist / watch_only / timeframe / playbook_text / paused=false / brain / brain_model / cheap_brain / cheap_brain_model only create a "settings proposal" card that takes effect after the user confirms it in the UI (returns proposal_id). Risk, leverage, stop distance, net R:R, position and daily-open limits, the daily loss stop and position sizing belong to the execution policy: change them with set_execution_policy. Auto-execution and the execution channel can only be changed by the user in the UI.',
  ),
  get_execution_policy: t(
    'get_execution_policy{}',
    'Execution policy shared by every source: risk per trade, leverage, min/max stop distance and the ATR minimum, net R:R, max open positions and daily opens, the daily loss stop and the sizing mode, plus the allowed ranges, the range you may set directly, and today\'s usage. Check this first when the user asks why a candidate was blocked or where a setting lives.',
  ),
  set_execution_policy: t(
    'set_execution_policy{"patch":{"min_stop_pct":0.4,"min_net_rr":1.8}}',
    'Change the execution policy (keys: risk_pct, leverage, margin_mode, min_stop_pct, max_stop_pct, min_stop_atr, min_net_rr, max_open_threads, max_opens_per_day, daily_loss_stop_pct, sizing_agent). On a demo account with every value inside your direct range it applies right away; outside that range or on a live account it only creates a "settings proposal" card the user confirms in the UI (returns proposal_id). Only call it when the user explicitly asks. Do not lower the minimum stop just so one trade can go through; suggest widening the strategy\'s stop multiple first.',
  ),
  run_scan: t('run_scan{"symbol":"optional"}', 'Scan one coin or the whole watchlist now.'),
  run_info: t('run_info{}', 'Run the info scout once now.'),
  run_review: t('run_review{"id":"thr-…"}', 'Re-check a thread now.'),
  remember: t(
    'remember{"content":"one sentence","kind":"preference|lesson|fact","symbol":"BTCUSDT or null","tags":["…"]}',
    'Use when the user explicitly asks to "remember" a preference or lesson. What the user says takes effect directly; do not use it for your own conclusions (leave those to post-trade review distillation).',
  ),
  recall: t(
    'recall{"query":"keyword (>=3 chars)","symbol":"optional"}',
    'Search long-term memory (approved lessons, preferences and trade facts).',
  ),
  forget_memory: t('forget_memory{"id":"mem-…"}', 'Use when the user asks to forget a memory.'),
  get_team: t('get_team{}', 'Status, recent tasks and unread handoffs of the nine roles.'),
  get_portfolio: t(
    'get_portfolio{}',
    'Account-level exposure snapshot (gross/net/cluster/stop-loss budget/unprotected legs) and portfolio policy.',
  ),
  get_risk_alerts: t(
    'get_risk_alerts{}',
    "Risk Sentinel's open alerts and severity. When any are high/critical, new positions are blocked; tell the user why first.",
  ),
  get_screen: t(
    'get_screen{"horizon":"short|swing|weekly"}',
    "Radar's latest screen (candidates, fit and proposals).",
  ),
  get_brief: t('get_brief{}', "Gate Captain's latest duty brief."),
  get_reviewer_cards: t(
    'get_reviewer_cards{"limit":20}',
    'Review cards for recent closes (R, exit reason, whether protection was in place) and batch decisions.',
  ),
  run_screen: t(
    'run_screen{"horizon":"short|swing|weekly"}',
    'Have Radar run a screen now, subject to budget and dedup.',
  ),
  ack_handoff: t('ack_handoff{"id":"hof-…"}', 'Mark a handoff as read after the user has seen it (not an approval).'),
  list_intents: t(
    'list_intents{"status":"pending_approval"}',
    'Order intents (open, close) awaiting user confirmation or in progress.',
  ),
  approve_intent: t(
    'approve_intent{"id":"int-…"}',
    'Approve a pending_approval intent when the user explicitly asks you to execute. By default this really places the order on the current execution channel (code re-runs every gate before execution; if rejected, tell the user why). If the user has enabled "chat execution requires human approval" in settings, it does not place an order and only pushes a confirmation card to the UI for the user to click. Before approving, call list_intents to verify symbol/side/size/stop and restate them verbatim in your reply. Do not call it unless the user explicitly said "execute / approve / place the order".',
  ),
  reject_intent: t('reject_intent{"id":"int-…"}', 'Reject a pending intent.'),
  request_execution: t(
    'request_execution{"id":"int-…"}',
    'Does not place an order; only pushes a confirmation card to the UI (use when the user wants to click it themselves).',
  ),
  get_judgment_ledger: t(
    'get_judgment_ledger{"dim":"strategy|trigger_kind|prompt_version|holding_reason|all","since_days":30,"source":"online|replay|trader|backfill|all","strategy_id":"optional"}',
    'Judgment ledger jl-v2 summary: per layer, sample size, judgment uplift (model vs council/mechanical), and mean/median/trimmed mean of regret_hold (should have exited but held) and regret_exit (exited but should have held). Use when the user asks "is the model\'s judgment worth it / is holding or exiting costlier".',
  ),
  list_candidates: t(
    'list_candidates{"limit":20,"symbol":"optional","strategy_id":"optional"}',
    'Recent shadow candidates (strategy candidates that place no orders) plus a summary (planned-leg / chandelier-leg expectancy, candidate x model pairing).',
  ),
  list_my_strategies: t(
    'list_my_strategies{"q":"optional search","filter":"all|live|watchlist|alerts|archived","limit":20}',
    'Research-side "My Strategies" objects and their latest backtest summaries.',
  ),
  get_backtest_report: t(
    'get_backtest_report{"id":"report id"} or {"strategy_id":"research strategy id"}',
    'Summary of one backtest report (total return, max drawdown, trade count, win rate, average holding time, mean/median/trimmed mean of per-trade return, segments).',
  ),
  get_evolution: t(
    'get_evolution{"role":"optional role, e.g. thread_manager","days":30}',
    "Evolution page grid summary (each role's recent daily red/yellow/green and today's judgment usage).",
  ),
  get_universe_scan: t(
    'get_universe_scan{"limit":20}',
    'Latest result of the daily OKX full-market scan (how many scanned, top candidates).',
  ),
  recommend_assets: t(
    'recommend_assets{"symbols":["SOL","DOGE"],"horizons":["short","mid","long"],"market":"perp"}',
    'Asset x short-term (3m/5m/15m) / mid-term (1h/4h) / long-term (12h/1d) recommendations: for each cell, whether it fits, direction, suggested strategy family, and evidence (turnover / daily regime / scan rank, all computed by code). Without symbols it takes the top_n (default 8) from the full-market scan. Call it first when the user asks "what to trade / recommend a few coins / is X better for short or long term / what strategy fits". The UI renders a recommendation card with a "Verify in Research" button that automatically starts a matrix study. In your answer, pick only the highlights and state which cells do not fit and why (e.g. no short-term trading on small caps). A recommendation only means "worth researching", not "profitable"; profitability depends on the research results.',
  ),
  run_review_batch: t(
    'run_review_batch{}',
    'Have Reviewer run a batch post-trade review, subject to pause, budget and dedup.',
  ),
  run_experiment: t('run_experiment{}', 'Have Strategy Lab run one reproducible experiment.'),
  start_matrix_study: t(
    'start_matrix_study{"recommendation_id":"optional","symbols":["BTC"],"timeframes":["4h"],"families":["breakout"],"arms":["code","code_judge"],"market":"spot|perp"}',
    'Start a matrix study asynchronously; pass only the parameters you need to override. Reports back to this session when done.',
  ),
  get_matrix_study: t(
    'get_matrix_study{"id":"optional"}',
    'Read matrix study progress, conclusions and finalists.',
  ),
  adopt_matrix_finalist: t(
    'adopt_matrix_finalist{"study_id":"…","finalist_id":"…"}',
    'After user consent, save a finalist that passed pre-checks as a research strategy.',
  ),
  get_agent_strategy: t('get_agent_strategy{}', "Read the agent's current strategy and mode."),
  set_agent_strategy: t(
    'set_agent_strategy{"kind":"free|strategy","strategy_id":"optional","version":1,"mode":"agent|jev|auto|signal_only"}',
    'Switch the current strategy only after explicit user consent; live-trading confirmation is done by the user in the UI. The "confirm each order" mode has been retired.',
  ),
  get_asp_overview: t(
    'get_asp_overview{}',
    'Read-only ASP identity, listing, services, subscription groups, publishing, task-intake polling, claimable revenue and errors; blocks that are not ready return ready:false.',
  ),
  list_asp_services: t(
    'list_asp_services{}',
    'Read-only serviceId, English name, description, pricing, registration and delivery stats for the seven external services.',
  ),
  list_asp_tasks: t(
    'list_asp_tasks{"status":"open|all","limit":20}',
    'Read-only provider per-call / subscription task intake and delivery ledger, including remote verification status.',
  ),
  list_asp_subscribers: t(
    'list_asp_subscribers{"limit":20}',
    'Read-only list of seller-side subscriber groups; buyer identifiers are masked.',
  ),
  list_market_inbox: t(
    'list_market_inbox{"limit":20}',
    'Read-only recent buyer-side inbound signals and their parse status.',
  ),
};

export interface BotEn {
  name: string;
  description: string;
  memory_note: string | null;
  approval_boundary: string;
  note: string | null;
}

export const BOT_EN: Record<BotRole, BotEn> = {
  gate_captain: {
    name: 'Gate Captain / Coordinator',
    description: 'User goals, task routing, result summaries, to-dos and the approval inbox',
    memory_note: 'User preferences, communication style, team run summaries',
    approval_boundary: 'Cannot approve its own proposals and cannot touch the exchange directly',
    note: 'dispatcher-lite: inbox (pending handoffs) + daily brief (cards assembled by code, zero model calls); chat still goes through chat.ts; council fan-out / hash approval is a separate safety prerequisite and is not built yet.',
  },
  radar: {
    name: 'Radar / Info & Discovery',
    description: 'Market regime, news, candidates and MonitorSpec; short-term screen every 12 hours, mid/long-term screens every 3 days / weekly',
    memory_note: 'Info source quality, candidate performance, summary preferences',
    approval_boundary: 'Read-only, generates no orders; watchlist proposals require a human to click "Apply" by default',
    note: null,
  },
  thread_manager: {
    name: 'Thread Manager / Trade Thesis',
    description: 'Thesis continuity of a StrategyThread from setup to close',
    memory_note: 'Lessons isolated by symbol/strategy/thread',
    approval_boundary: 'Proposes only; size, leverage and whether it is allowed are decided by code',
    note: null,
  },
  strategy_lab: {
    name: 'Strategy Lab / Research & Optimization',
    description: 'StrategySpec, experiment hypotheses, backtest jobs and promotion proposals',
    memory_note: 'Research log, failed hypotheses, experiment results; never reads live credentials',
    approval_boundary: 'Can only move into DRAFT/BACKTEST/PAPER; promotion requires human approval',
    note: 'strategy-lab.ts: every 7 days or after >=10 new closes, runs one pre-registered reproducible experiment across all strategy versions using mechanical forward expectancy (zero model calls, never changes or promotes a strategy); the attribution/brief model part is not built yet.',
  },
  portfolio_manager: {
    name: 'Portfolio Manager / Portfolio',
    description: 'Gross/net/cluster exposure, risk budget, capital allocation and portfolio plan',
    memory_note: 'Portfolio goals and user preferences; current positions are always fetched live',
    approval_boundary: 'Outputs a PortfolioPlan and never produces exchange effects directly',
    note: 'Code computes exposure / cluster concentration / stop-loss budget and enforces the portfolio hard gates; on PROPOSE a cheap brain may give a bounded sizing opinion, advisory only by default.',
  },
  risk_sentinel: {
    name: 'Risk Sentinel / Risk',
    description: 'Real-time invariants, gate verdicts, incidents and alerts',
    memory_note: 'Alert dedup and explanation templates; real-time metrics never enter long-term memory',
    approval_boundary: 'Code can reject/tighten; the model can never loosen',
    note: 'Pure code: risk.ts evaluates invariants on every account poll into fingerprinted alerts, and stops new risk at high and above; zero model calls.',
  },
  reviewer: {
    name: 'Reviewer / Evaluation & Review',
    description: 'Adversarial review, post-trade review, memory/skill/strategy candidates',
    memory_note: 'Approved lessons and evaluation conclusions',
    approval_boundary: 'Cannot change active strategies or risk parameters; can only propose a diff',
    note: 'reviewer.ts / reviewer-agent.ts: close review cards (code) + batch lesson distillation (cheap brain, >=5 trades or 24h, <=2 runs/day, <=2 lessons per run, awaiting human approval); adversarial review of proposals is not built yet.',
  },
  executor: {
    name: 'Executor / Execution Service',
    description: 'Consumes authorized plans, places orders, protective legs, receipts and reconciliation',
    memory_note: 'No free-text memory; stores only the six records, checkpoints and receipts',
    approval_boundary: 'Accepts only structured requests with complete plan_hash/account_version/authorization',
    note: null,
  },
  asp_agent: {
    name: 'ASP Agent / Signal Market',
    description: 'OKX.AI inbound, publishing, identity, payout claims and after-sales',
    memory_note: 'Market ledger and subscription configuration',
    approval_boundary: 'Never connects to the exchange directly and never forwards external signals; after-sales decisions are made by a human',
    note: 'Code-driven; zero model calls in this batch',
  },
};

/**
 * English labels for execution-policy.ts REASON_LABELS (reason codes shown on the trading page's source cards:
 * top_reasons / not_taken). Keyed by reason code; public-en.ts zips them with the Chinese labels.
 * The test walks REASON_LABELS, so a new code without an entry here fails.
 */
export const REASON_EN: Record<string, string> = {
  stop_distance: 'Stop below the minimum distance',
  stop_atr: 'Stop smaller than the ATR minimum',
  stop_too_wide: 'Stop wider than the maximum distance',
  min_net_rr: 'Net R:R too low',
  max_open_threads: 'Max open positions reached',
  max_opens_per_day: 'Daily entry limit reached',
  daily_loss_stop: 'Daily loss limit hit',
  symbol_open: 'Coin already has an open trade or position',
  halted: 'Emergency stop',
  paused: 'Paused',
  portfolio_limit: 'Portfolio limit',
  risk_sentinel: 'Risk monitor alert',
  sizing: 'Order size not valid',
  event_blackout: 'Event blackout',
  stop_side: 'Stop on the wrong side',
  tp_side: 'Take-profit on the wrong side',
  stale: 'Evidence or market data out of date',
  position_exists: 'Coin already has a position',
  confidence: 'Confidence too low',
  spot_no_short: 'Spot cannot go short',
  market_not_enabled: 'Market not enabled',
  current_strategy: 'Current strategy handles entries',
  unknown_order: 'An order has unknown status',
  council: 'Strategy consensus not reached',
  entry_style: 'Entry type not allowed',
  holding_atr: 'Holding plan ATR scale',
  invalidation: 'Invalidation price not valid',
  holding_plan: 'Holding plan missing',
  tier_limit: 'Per-tier quota',
  preflight: 'Final check before the order',
  other_gate: 'Other code check',
  no_add: 'Adding to a position not allowed',
  already_open: 'This run already holds the coin',
  max_open: 'This run is at its position limit',
  ambiguous_position: 'Several trades on one coin need reconciling',
  min_rr: 'R:R below the strategy minimum',
  position_unsettled: 'Trade on this coin needs reconciling',
  new_signal: 'New signal waiting to be handled',
  screen_filter: 'Screen filter not passed',
  ir_judge_skip: "Strategy's judge step skipped",
  jev_skip: 'Jev judge skipped',
  jev_unavailable: 'Jev not available (treated as skip)',
  agent_skip: 'LLM judge skipped',
  no_trade: 'Model decided not to trade',
  bars_pending: 'Market data not in yet',
  entry_expired: 'Limit order expired unfilled',
  ai_scan_paused: 'AI Scan paused',
  watch: 'Model decided to watch',
  model_failed: 'Model call failed',
  transient: 'Temporary failure (retried)',
  execution_unknown: 'Order result unknown',
  execution_error: 'Execution error',
  unknown: 'Unclassified',
};
