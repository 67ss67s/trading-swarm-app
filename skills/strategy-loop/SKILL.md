---
title: strategy-loop
description: Drive Trading Swarm's chat-to-strategy loop from any host agent — recommend assets per short/mid/long horizon from radar + market scan, run a matrix study (assets × timeframes × strategy families × pure-code vs code+Jev arms) with a locked holdout, read the diagnose→change→result iterations, release the holdout once, adopt a finalist as a strategy, and make it the agent's current strategy — through the local gateway's HTTP API. Use for "what should I trade", "which strategy fits SOL on 4h", "test this idea on these coins", "let the agent run this strategy", matrix study, judge / Jev decisions, or switching the agent's current strategy.
metadata:
  version: 0.1.0
  author: 67ss67s
license: MIT
---

# strategy-loop skill

Trading Swarm turns "I want to trade X" into a strategy the
agent actually runs. The loop is code-first: recommendations, backtests, gates and the holdout test
are deterministic; a **decision model** (Jev, OpenRouter `typesafe/jev-1.13`, typed probabilities, no
text) is only used as the *judge* element inside a strategy (follow / skip a code candidate), and the
same `judgeCandidate` runs in backtest and live, so the two cannot drift.

The gateway (default `http://127.0.0.1:18800`, started by `scripts/dev.sh`) owns every ledger. **Always go through it**; never compute a strategy by
hand and paste it into "my strategies".

Design and acceptance: `docs/design/chat-to-strategy-loop-2026-09-25.md`. Contract:
`docs/demo/v3-ui-contract.md` §9.52 (model connections), §9.53 (recommend / matrix study / IR judge),
§9.54 (agent current strategy). Evaluation protocol: `docs/research/chat-to-strategy-eval-protocol.md`.
UI: chat recommendation card → `#matrix-study` → `#my-strategies` → current-strategy chip on the
Agent page and the floor.

## Red lines

1. **"No candidate" is a valid answer.** Past research found that nothing survived multiple testing.
   Never loosen gates, re-slice windows, or keep re-running until something passes. Report the cause
   distribution (`cost_dominated` / `insufficient_evidence` / `unsupported_execution` /
   `underperform_hold`) instead.
2. **The holdout is looked at once.** `finalize` releases it for the frozen finalists only; after that
   the lineage cannot search again. Never call finalize "to see how it's doing".
3. Every number you say comes from a tool result. n < 30 is an observation, not a conclusion. Always
   pair a return with drawdown and trade count. Never "guaranteed / risk-free / 稳赚 / 保证收益".
4. Switching the agent's current strategy changes what the agent trades. Do it only after the user
   says so explicitly. A live channel additionally needs the user to type `LIVE` in the UI — you can't.
5. Paid decision calls have budgets (per study `budget.max_judge_usd`, per run per UTC day, and the
   global `workflow.decision_daily_usd_cap`). Quote the estimate before starting a study.
6. Short horizon (3m/5m/15m) is only for high-liquidity perps; 3m/5m are research-only (the runner
   can't execute them yet). Order-book / liquidation features are `live_only`: they cannot be
   backtested and must pass forward validation (G3) before a live strategy relies on them.

## 1. Recommend (assets × horizon)

`POST /api/recommendations` `{symbols?: string[], horizons?: ('short'|'mid'|'long')[], market?: 'perp'|'spot', top_n?: number}`
→ `AssetRecommendation {id, as_of, source:{universe_scan_at, regime_at, radar_at}, rows[], warnings[]}`.
Empty `symbols` = radar top-3 per tier ∪ OKX full-market daily scan top `top_n` (default 8, max 12).

Each row: `regime` (daily bull/bear/range/volatile), `scan` rank, `radar` ranks per horizon
(**short ← radar short tier, mid ← swing tier, long ← weekly tier**), and per horizon
`{eligible, reason, direction, families[], evidence[]}`. `reason`: `liquidity` (short needs perp 24h
volume ≥ 300M and ±0.5% depth ≥ 2M), `history` (long needs ≥ 1 year listed), `regime` (e.g. spot in a
downtrend), `excluded`, `unknown_asset`, `no_market`. Evidence strings carry the source numbers.
`GET /api/recommendations/{id}` returns the stored result (the chat card renders from it).

## 2. Matrix study

- Prefill from a recommendation: `GET /api/research/matrix-studies/prefill?recommendation_id=` →
  `{spec, notes, estimate}` (only eligible cells).
- Estimate (no write): `POST /api/research/matrix-studies/estimate` `{spec}` or `{recommendation_id}` →
  `{spec, estimate:{cells:{total,applicable,not_applicable,research_only}, matrix_trials,
  iteration_trials_max, variants, judge_calls, judge_usd, data:{series,bars,cold_fetch_ms_upper},
  within_budget, warnings[]}, cells[]}`. Tell the user trials, Jev calls/USD and cold-fetch time.
- Create: `POST /api/research/matrix-studies` `{spec, idempotency_key}` (or `{recommendation_id}`) → 201
  study view. Refused when over `budget.max_variants`, no applicable cell, or the holdout range was
  already used by the same research program.
- Spec essentials: `symbols` (≤ 6), `timeframes` (`15m` short / `4h` mid / `1d` long runnable; `3m`/`5m`
  research-only), `families` (`breakout`, `ma_trend`, `ema_cross`, `pullback`, `mean_reversion`, `smc`;
  portfolio families `xsmom`/`carry` are not per-cell), `market`, `sides`, `arms` (`code`,
  `code_judge`), `split {train, selection, holdout}` (time-ordered, holdout last), `iterate`, `budget`.
- Read: `GET /api/research/matrix-studies/{id}` → `{status, stage, progress, holdout_state, cells[]
  (each with result: verdict pass|near|fail|ineligible, cause, selection score, gates, dsr,
  judge_delta {mean_daily, ci95, kept_ratio}), generations[] ({diagnosis, change, selection,
  promoted}), finalists[], conclusion, usage, ledger (attempt/trial counts; DSR uses the full trial
  count), manifest_hash, …}`. Events: `GET …/{id}/events?after_seq=` or SSE `research.matrix_study`.
- Status flow: `queued → running (data → matrix → iterate) → ready_to_finalize → finalizing →
  completed` (+ `cancelled` / `failed` / `interrupted`; `POST …/{id}/resume` continues an interrupted
  one without resetting counts or spend). `POST …/{id}/cancel` stops new work.
- Iteration: near-miss cells (positive expectancy, some gate failing) go through diagnose → generate
  variant → re-evaluate on the selection segment. Every new variant counts as a new trial.

## 3. Holdout, portfolio replay, adopt

1. When `status = ready_to_finalize`: `POST /api/research/matrix-studies/{id}/finalize`
   `{expected_manifest_hash}` (from the study view) → 202. The holdout is released once for all
   frozen finalists; Holm correction across them; each finalist gets `holdout`, `test {p_value,
   holm_threshold, rejected}`, `passed`, and a **portfolio replay** (same account, `risk_pct`,
   `max_open`, Jev follow/skip from recorded decisions, fees/slippage/funding):
   `portfolio {total_return, max_drawdown, trades, skipped_by_judge, skipped_by_capacity, exposure}`.
2. Report to the user: holdout result (the only real out-of-sample number), portfolio replay,
   code+Jev vs code delta with its interval, and the horizon (short/mid/long) and source.
3. Adopt (user agrees): `POST …/{id}/adopt` `{finalist_id, name?}` → `{strategy_id, version,
   preflight:{deployable, warnings[]}}`. The gateway runs the strategy-run preflight first and refuses
   with a readable reason if anything blocks; don't retry with a different finalist to force it.

## 4. Make it the agent's current strategy

- `GET /api/agent/strategy` → `{kind:'free'|'strategy', strategy_id, version, name, run_id,
  run_status, mode, slices[] (binding per role: radar / judge / geometry / risk / holding /
  execution), role_engines {role: code|decision|llm}, legacy_pool_ignored[]}`.
- `PUT /api/agent/strategy` `{kind:'strategy', strategy_id, version?, mode?:'agent'|'auto'|'confirm',
  symbols?, risk_pct?, max_open?, confirm?}` starts (or reuses) the strategy run and stops the previous
  current one; open positions exit under the version they opened with. `{kind:'free'}` goes back to
  free judgment (playbook + model). While a strategy is current, free judgment only reviews existing
  threads and never opens. SSE `agent.strategy`.
- Preflight before switching: `GET /api/strategy-runs/preflight?strategy_id=&version=` (blockers /
  warnings / defaults / execution channel / `requires_live_confirm`).
- Watch it run: `GET /api/strategy-runs`, `GET /api/strategy-runs/{run_id}/events` (scan, candidate,
  judge follow/skip with probabilities, order opened/rejected, exit).

## 5. Models behind each role

`GET /api/models` → connections (API key or local CLI; keys never returned) + 7 role bindings
(`chat`, `judge`, `research`, `filter`, `reviewer`, `utility`, `decision`) + `effective`. The judge
element uses the `decision` binding pinned to a fixed model version; if the binding changes, strategies
whose `judge.model_profile_ref` no longer matches skip (and say so) instead of silently using another
model.
