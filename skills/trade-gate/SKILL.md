---
title: trade-gate
description: Drive the trade-gate trading agent (market state, strategy threads, proposals, reviews, workflow settings) from any host agent through its local HTTP API. Use when the user asks about what the trading agent is doing, wants to propose or close a trade idea, or wants to change the agent's watch list / risk / playbook.
metadata:
  version: 0.1.0
  author: 67ss67s
license: MIT
---

# trade-gate skill

trade-gate is a local gateway at `http://127.0.0.1:18800` (start with `npm run dev`). All money-moving
calls only *propose*; sizing, gates and execution are done by the gateway's code.

## Read state
- `GET /api/overview` — loop state, workflow, account, markets, latest market state, open threads, queue.
- `GET /api/market-state` — the information officer's latest summary (regime, bias, key points, news, candidates).
- `GET /api/threads?status=open|all` and `GET /api/threads/{id}` — strategy threads with their episodes.
- `GET /api/episodes?symbol=BTCUSDT&limit=20` and `GET /api/episodes/{id}` — decision replay (evidence, exact model context, judgment, gates).

## Act (all guarded by the gateway)
- `POST /api/scan-now {"symbol":"BTCUSDT"}` — ask for a fresh scan.
- `POST /api/info/run-now` — run the information officer now.
- `POST /api/threads/{id}/review` — review a thread now; `POST /api/threads/{id}/close` — flatten/cancel it.
- `POST /api/chat/messages {"text":"..."}` — talk to the agent; it may call its own tools (propose_thread, set_workflow...).
- `POST /api/workflow {partial}` — change watch list, timeframe, risk_pct, leverage, margin_mode, max_open_threads, max_opens_per_day, daily_loss_stop_pct, auto_approve, brain, playbook_text, paused. Values are clamped to safe bounds; errors come back in `errors`.
- `POST /api/orders {"symbol","side":"long|short","action":"open|close","type":"market|limit","price?","margin_usdt?","leverage?","qty?","tp?","sl?"}` — manual order through the same execution chain.

## Rules for the host agent
- Never call `/api/halt` unless the user explicitly asks for an emergency stop; it requires `{"confirm":"HALT"}`.
- Quote numbers from the API, do not invent prices.
- Prefer `WATCH`/`NO_TRADE` framing: if the gateway says no, explain the gate reason rather than retrying.
