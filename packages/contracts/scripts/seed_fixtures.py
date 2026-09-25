#!/usr/bin/env python3
"""一次性种子:生成初始 fixtures(合法 + 非法)。之后新增语料直接手写 JSON 文件即可,不必改这里。

ID 约定(便于跨记录对照):
  intent  0f8fad5b-d9cb-469f-a165-70867728950e   (BTCUSDT 开仓,模型提议)
  plan    7c9e6679-7425-40de-944b-e07fc1f90ae7   plan_hash = fixtures/hash/vectors.json[order_limit_with_protection]
  auth    16fd2706-8baf-433b-82eb-8c7fada847da
  attempt 9b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b   clientOrderId tg-0f8fad5bd9cb-e0-1
"""
import copy
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
FIX = HERE.parent / "fixtures"
VECTORS = {v["name"]: v for v in json.loads((FIX / "hash" / "vectors.json").read_text())["vectors"]}

T0 = 1788350000000
INTENT = "0f8fad5b-d9cb-469f-a165-70867728950e"
PLAN = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
AUTH = "16fd2706-8baf-433b-82eb-8c7fada847da"
ATTEMPT = "9b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b"
OBS = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
FILL = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e"
EFFECT = "c3d4e5f6-a7b8-4c9d-ae0f-2a3b4c5d6e7f"
PLAN_HASH = VECTORS["order_limit_with_protection"]["sha256"]
ACCOUNT_VERSION = VECTORS["account_version_components"]["sha256"]
TOOLS_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
COID = "tg-0f8fad5bd9cb-e0-1"

valid = {}
invalid = {}

# ---------------- intent ----------------
intent_open = {
    "schema_version": 1,
    "intent_id": INTENT,
    "account": "sub",
    "principal": "model",
    "surface": "model",
    "session_id": "main",
    "run_id": "run-20260902-0001",
    "origin": "recipe:w4-judgment",
    "idempotency_key": "run-20260902-0001:BTCUSDT:1",
    "params": {
        "kind": "open",
        "product": "usdm_perp",
        "symbol": "BTCUSDT",
        "side": "buy",
        "position_side": "both",
        "size": {"mode": "hint", "hint": "full"},
        "entry": {"type": "limit", "price": "60000.5", "time_in_force": "gtc", "post_only": False},
        "stop": {"price": "59000", "trigger": "mark_price"},
        "take_profits": [{"price": "62000", "pct": "50", "trigger": "mark_price"}],
        "leverage": 2,
        "margin_type": "isolated",
        "thesis": "4h 结构回踩支撑,量能收缩",
        "evidence_refs": ["T7.E1", "T7.E3"],
        "invalidation": "收盘跌破 58800",
    },
    "status": "awaiting_approval",
    "gate_rejections": [],
    "current_plan_id": PLAN,
    "ttl_seconds": 600,
    "created_at": T0,
    "updated_at": T0 + 1000,
    "expires_at": T0 + 600000,
}
valid["intent/open_awaiting_approval"] = intent_open
valid["intent/open_minimal_proposed"] = {
    "schema_version": 1,
    "intent_id": "5e6f7081-92a3-4b4c-8d5e-6f708192a3b4",
    "account": "sub",
    "principal": "model",
    "surface": "model",
    "params": {
        "kind": "open",
        "product": "usdm_perp",
        "symbol": "SOLUSDT",
        "side": "sell",
        "size": {"mode": "hint", "hint": "quarter"},
        "entry": {"type": "market"},
        "stop": {"price": "150.25", "trigger": "mark_price"},
        "evidence_refs": ["T1.E2"],
    },
    "status": "proposed",
    "gate_rejections": [],
    "ttl_seconds": 120,
    "created_at": T0,
    "updated_at": T0,
}
valid["intent/close_user_main_completed"] = {
    "schema_version": 1,
    "intent_id": "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
    "account": "main",
    "principal": "user",
    "surface": "rpc",
    "origin": "ui:trade-page",
    "idempotency_key": "ui-7f3a-000042",
    "params": {
        "kind": "close",
        "product": "usdm_perp",
        "symbol": "ETHUSDT",
        "position_side": "both",
        "pct": "100",
        "order": {"type": "market", "max_slippage_bps": 30},
        "reason": "手动平仓",
    },
    "status": "completed",
    "gate_rejections": [],
    "current_plan_id": "8d9e6f70-8192-4a3b-9c4d-5e6f708192a3",
    "authorization_id": "27fe3817-9cb0-444c-93fc-9d8fadb958eb",
    "ttl_seconds": 120,
    "created_at": T0 + 5000,
    "updated_at": T0 + 9000,
    "expires_at": T0 + 125000,
    "terminal_at": T0 + 9000,
}
valid["intent/transfer_user_main_to_sub"] = {
    "schema_version": 1,
    "intent_id": "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f9a0",
    "account": "main",
    "principal": "user",
    "surface": "rpc",
    "origin": "ui:funding-page",
    "params": {
        "kind": "transfer",
        "asset": "USDT",
        "amount": "25",
        "from_account": "main",
        "from_wallet": "spot",
        "to_account": "sub",
        "to_wallet": "usdm_futures",
        "reason": "注资金丝雀",
    },
    "status": "proposed",
    "gate_rejections": [],
    "ttl_seconds": 300,
    "created_at": T0,
    "updated_at": T0,
}
valid["intent/cancel_order_gate_rejected"] = {
    "schema_version": 1,
    "intent_id": "3c4d5e6f-7081-4293-a4b5-c6d7e8f9a0b1",
    "account": "sub",
    "principal": "model",
    "surface": "model",
    "params": {
        "kind": "cancel_order",
        "product": "usdm_perp",
        "symbol": "BTCUSDT",
        "order_ref": {"client_order_id": COID},
        "reason": "入场失效",
    },
    "status": "rejected",
    "status_reason": "gate policy.mode",
    "gate_rejections": [
        {"gate": "policy.mode", "value": "halt_all", "limit": "run", "message": "HALT_ALL 期间拒绝一切新提议"}
    ],
    "ttl_seconds": 120,
    "created_at": T0,
    "updated_at": T0 + 20,
    "terminal_at": T0 + 20,
}
valid["intent/protect_scheduler_executing"] = {
    "schema_version": 1,
    "intent_id": "4d5e6f70-8192-4a3b-b4c5-d6e7f8a9b0c1",
    "account": "sub",
    "principal": "scheduler",
    "surface": "internal",
    "origin": "exit-dsl:thread-42",
    "params": {
        "kind": "protect",
        "product": "usdm_perp",
        "symbol": "ETHUSDT",
        "position_side": "both",
        "stop": {"price": "2900.10", "trigger": "mark_price"},
        "replace": True,
        "reason": "追踪止损上移",
    },
    "status": "executing",
    "gate_rejections": [],
    "current_plan_id": "9eaf7081-92a3-4b4c-8d5e-6f708192a3b5",
    "authorization_id": "38af4928-adc1-455d-a40d-ae9fbec069fc",
    "ttl_seconds": 60,
    "created_at": T0,
    "updated_at": T0 + 300,
}
bad = copy.deepcopy(intent_open)
bad["params"]["size"] = {"mode": "qty", "qty": 0.002}
invalid["intent/float_qty"] = bad
bad = copy.deepcopy(intent_open)
bad["foo"] = 1
invalid["intent/unknown_top_level_field"] = bad
bad = copy.deepcopy(intent_open)
del bad["params"]["stop"]
invalid["intent/open_without_stop"] = bad
bad = copy.deepcopy(intent_open)
bad["status"] = "AWAITING_APPROVAL"
invalid["intent/uppercase_status"] = bad
bad = copy.deepcopy(intent_open)
bad["created_at"] = "1788350000000"
invalid["intent/string_timestamp"] = bad
bad = copy.deepcopy(intent_open)
bad["params"]["kind"] = "withdraw"
invalid["intent/withdraw_kind_not_in_v1"] = bad
bad = copy.deepcopy(intent_open)
bad["current_plan_id"] = None
invalid["intent/null_optional"] = bad

# ---------------- plan ----------------
plan = {
    "schema_version": 1,
    "plan_id": PLAN,
    "intent_id": INTENT,
    "version": 1,
    "plan_hash": PLAN_HASH,
    "account": "sub",
    "channel": "mcp",
    "economic": VECTORS["order_limit_with_protection"]["input"],
    "basis": {
        "filters": {
            "tick_size": "0.1",
            "step_size": "0.001",
            "min_qty": "0.001",
            "max_qty": "1000",
            "min_notional": "100",
            "price_precision": 1,
            "qty_precision": 3,
            "observed_at": T0 - 10000,
        },
        "sizing": {
            "method": "risk_pct_by_stop_distance",
            "equity": "1000",
            "risk_pct": "0.25",
            "stop_distance": "1000.5",
            "reference_price": "60000.5",
            "raw_qty": "0.0024987",
            "rounding": "down",
        },
        "account_version": ACCOUNT_VERSION,
        "market_ref": {"mark_price": "60010.2", "last_price": "60008.9", "observed_at": T0 - 1000},
        "position_mode_observed": "one_way",
        "policy_version": 3,
        "notes": ["risk 0.25% × 1000 = 2.5 USDT", "raw_qty 0.0024987 → step 0.001 向下 → 0.002"],
    },
    "authorization_ttl_seconds": 120,
    "created_at": T0 + 1000,
    "expires_at": T0 + 601000,
}
valid["plan/order_limit_with_protection"] = plan
valid["plan/transfer_main_to_sub"] = {
    "schema_version": 1,
    "plan_id": "af5a1c02-2ea9-4c4b-9c1a-6d2a5c1b7e01",
    "intent_id": "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f9a0",
    "version": 1,
    "plan_hash": VECTORS["transfer_main_to_sub"]["sha256"],
    "account": "main",
    "channel": "rest",
    "economic": VECTORS["transfer_main_to_sub"]["input"],
    "basis": {"notes": ["主账户 spot 可用 USDT 2500 ≥ 25"]},
    "authorization_ttl_seconds": 120,
    "created_at": T0 + 100,
    "expires_at": T0 + 300100,
}
valid["plan/protect_replace"] = {
    "schema_version": 1,
    "plan_id": "9eaf7081-92a3-4b4c-8d5e-6f708192a3b5",
    "intent_id": "4d5e6f70-8192-4a3b-b4c5-d6e7f8a9b0c1",
    "version": 2,
    "plan_hash": VECTORS["protect_replace"]["sha256"],
    "account": "sub",
    "channel": "mcp",
    "economic": VECTORS["protect_replace"]["input"],
    "basis": {"position_mode_observed": "one_way", "notes": ["替换旧止损 123456789/123456790"]},
    "authorization_ttl_seconds": 30,
    "created_at": T0 + 50,
    "expires_at": T0 + 60050,
}
bad = copy.deepcopy(plan)
bad["plan_hash"] = PLAN_HASH.upper()
invalid["plan/uppercase_hash"] = bad
bad = copy.deepcopy(plan)
del bad["economic"]["protection"]
invalid["plan/order_without_protection_object"] = bad
bad = copy.deepcopy(plan)
bad["economic"]["qty"] = "0.002 "
invalid["plan/qty_with_space"] = bad
bad = copy.deepcopy(plan)
bad["economic"]["kind"] = "cancel"
invalid["plan/kind_mismatch_fields"] = bad

# ---------------- authorization ----------------
auth = {
    "schema_version": 1,
    "authorization_id": AUTH,
    "intent_id": INTENT,
    "plan_id": PLAN,
    "plan_hash": PLAN_HASH,
    "by": "user",
    "principal": "user",
    "surface": "rpc",
    "actor_ref": "ws-conn:7f3a",
    "status": "consumed",
    "confirm_echo": {
        "plan_hash": PLAN_HASH,
        "symbol": "BTCUSDT",
        "side": "buy",
        "qty": "0.002",
        "order_type": "limit",
        "price": "60000.5",
        "leverage": "2",
        "reduce_only": "false",
    },
    "granted_at": T0 + 100000,
    "expires_at": T0 + 220000,
    "consumed_at": T0 + 105000,
    "consumed_by_attempt_id": ATTEMPT,
}
valid["authorization/user_consumed"] = auth
valid["authorization/policy_active"] = {
    "schema_version": 1,
    "authorization_id": "38af4928-adc1-455d-a40d-ae9fbec069fc",
    "intent_id": "4d5e6f70-8192-4a3b-b4c5-d6e7f8a9b0c1",
    "plan_id": "9eaf7081-92a3-4b4c-8d5e-6f708192a3b5",
    "plan_hash": VECTORS["protect_replace"]["sha256"],
    "by": "policy",
    "actor_ref": "policy:v3:emergency_reduce",
    "status": "active",
    "granted_at": T0 + 60,
    "expires_at": T0 + 30060,
}
bad = copy.deepcopy(auth)
del bad["confirm_echo"]
invalid["authorization/user_without_confirm_echo"] = bad
bad = copy.deepcopy(auth)
bad["confirm_echo"]["qty"] = 0.002
invalid["authorization/echo_value_not_string"] = bad

# ---------------- attempt ----------------
attempt = {
    "schema_version": 1,
    "attempt_id": ATTEMPT,
    "intent_id": INTENT,
    "plan_id": PLAN,
    "plan_hash": PLAN_HASH,
    "attempt_no": 1,
    "leg": "entry",
    "leg_index": 0,
    "account": "sub",
    "channel": "mcp",
    "client_order_id": COID,
    "order_fingerprint": '{"newClientOrderId":"tg-0f8fad5bd9cb-e0-1","price":"60000.5","quantity":"0.002","side":"BUY","symbol":"BTCUSDT","timeInForce":"GTC","type":"LIMIT"}',
    "writer_instance_id": "execd-mba-2026",
    "lease_epoch": 7,
    "fencing_token": "7:execd-mba-2026:1788350105000",
    "stage": "result_persisted",
    "result": "acked",
    "created_at": T0 + 105000,
    "submitted_at": T0 + 105120,
    "deadline_at": T0 + 125000,
    "result_at": T0 + 105480,
    "exchange_order_id": "8389765123456789",
    "tool_name": "futures_place_order",
    "tools_hash": TOOLS_HASH,
}
valid["attempt/entry_acked"] = attempt
valid["attempt/stop_leg_unknown"] = {
    "schema_version": 1,
    "attempt_id": "ad3e4f50-6172-4839-9a0b-1c2d3e4f5a6b",
    "intent_id": INTENT,
    "plan_id": PLAN,
    "plan_hash": PLAN_HASH,
    "attempt_no": 1,
    "leg": "stop",
    "leg_index": 0,
    "account": "sub",
    "channel": "mcp",
    "client_order_id": "tg-0f8fad5bd9cb-s0-1",
    "order_fingerprint": '{"closePosition":"true","newClientOrderId":"tg-0f8fad5bd9cb-s0-1","side":"SELL","stopPrice":"59000","symbol":"BTCUSDT","type":"STOP_MARKET","workingType":"MARK_PRICE"}',
    "writer_instance_id": "execd-mba-2026",
    "lease_epoch": 7,
    "fencing_token": "7:execd-mba-2026:1788350106500",
    "stage": "submitted",
    "result": "unknown",
    "created_at": T0 + 106500,
    "submitted_at": T0 + 106520,
    "deadline_at": T0 + 126500,
    "result_at": T0 + 126500,
    "error": {"kind": "transport_ambiguous", "message": "MCP tools/call 超时(20s),不知道是否到达", "retryable": False},
    "tool_name": "futures_place_order",
    "tools_hash": TOOLS_HASH,
}
valid["attempt/transfer_before_submit"] = {
    "schema_version": 1,
    "attempt_id": "be4f5061-7283-4940-8b1c-2d3e4f5a6b7c",
    "intent_id": "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f9a0",
    "plan_id": "af5a1c02-2ea9-4c4b-9c1a-6d2a5c1b7e01",
    "plan_hash": VECTORS["transfer_main_to_sub"]["sha256"],
    "attempt_no": 1,
    "leg": "transfer",
    "leg_index": 0,
    "account": "main",
    "channel": "rest",
    "client_order_id": "tg-2b3c4d5e6f70-f0-1",
    "order_fingerprint": '{"amount":"25","asset":"USDT","fromAccountType":"SPOT","toAccountType":"USDT_FUTURE","toEmail":"<sub>"}',
    "writer_instance_id": "execd-mba-2026",
    "lease_epoch": 7,
    "fencing_token": "7:execd-mba-2026:1788350200000",
    "stage": "before_submit",
    "result": "pending",
    "created_at": T0 + 200000,
    "deadline_at": T0 + 215000,
}
bad = copy.deepcopy(attempt)
bad["client_order_id"] = "tg-" + "x" * 40
invalid["attempt/client_order_id_too_long"] = bad
bad = copy.deepcopy(attempt)
bad["result"] = "lost"
invalid["attempt/result_lost_not_a_state"] = bad

# ---------------- exchange_order ----------------
order_obs = {
    "schema_version": 1,
    "observation_id": OBS,
    "account": "sub",
    "channel": "mcp",
    "source": "mcp",
    "product": "usdm_perp",
    "symbol": "BTCUSDT",
    "exchange_order_id": "8389765123456789",
    "client_order_id": COID,
    "status": "partially_filled",
    "side": "buy",
    "position_side": "both",
    "order_type": "limit",
    "orig_qty": "0.002",
    "executed_qty": "0.001",
    "avg_price": "60000.5",
    "price": "60000.5",
    "cum_quote": "60.0005",
    "reduce_only": False,
    "close_position": False,
    "time_in_force": "gtc",
    "origin": "local",
    "attempt_id": ATTEMPT,
    "exchange_update_time": T0 + 106000,
    "exchange_create_time": T0 + 105400,
    "observed_at": T0 + 106200,
    "raw_hash": TOOLS_HASH,
}
valid["exchange_order/local_partially_filled"] = order_obs
valid["exchange_order/foreign_new_from_ws"] = {
    "schema_version": 1,
    "observation_id": "d4e5f607-b8c9-4dae-8f01-3b4c5d6e7f80",
    "account": "main",
    "channel": "rest",
    "source": "ws",
    "product": "usdm_perp",
    "symbol": "ETHUSDT",
    "exchange_order_id": "112233445566",
    "client_order_id": "web_abc123",
    "status": "new",
    "side": "sell",
    "position_side": "both",
    "order_type": "stop_market",
    "orig_qty": "0.5",
    "executed_qty": "0",
    "stop_price": "2900.1",
    "reduce_only": True,
    "close_position": True,
    "working_type": "mark_price",
    "origin": "foreign",
    "exchange_update_time": T0 + 300,
    "observed_at": T0 + 320,
}
bad = copy.deepcopy(order_obs)
bad["status"] = "NEW"
invalid["exchange_order/uppercase_status"] = bad
bad = copy.deepcopy(order_obs)
bad["executed_qty"] = "-0.001"
invalid["exchange_order/negative_executed_qty"] = bad

# ---------------- fill ----------------
fill = {
    "schema_version": 1,
    "fill_id": FILL,
    "account": "sub",
    "channel": "mcp",
    "source": "mcp",
    "product": "usdm_perp",
    "symbol": "BTCUSDT",
    "exchange_order_id": "8389765123456789",
    "trade_id": "557711223",
    "client_order_id": COID,
    "attempt_id": ATTEMPT,
    "side": "buy",
    "position_side": "both",
    "qty": "0.001",
    "price": "60000.5",
    "quote_qty": "60.0005",
    "commission": "0.01200010",
    "commission_asset": "USDT",
    "realized_pnl": "0",
    "is_maker": True,
    "trade_time": T0 + 106000,
    "observed_at": T0 + 106200,
}
valid["fill/local_maker"] = fill
bad = copy.deepcopy(fill)
bad["trade_id"] = 557711223
invalid["fill/numeric_trade_id"] = bad

# ---------------- position_effect ----------------
effect = {
    "schema_version": 1,
    "effect_id": EFFECT,
    "intent_id": INTENT,
    "plan_id": PLAN,
    "kind": "open",
    "account": "sub",
    "symbol": "BTCUSDT",
    "status": "pending",
    "target_qty": "0.002",
    "filled_qty": "0.001",
    "remaining_qty": "0.001",
    "remaining_canceled": False,
    "avg_fill_price": "60000.5",
    "first_fill_at": T0 + 106000,
    "protection_required": True,
    "protection_confirmed": True,
    "protection_confirmed_at": T0 + 108000,
    "protection_order_ids": ["8389765123456790"],
    "naked_seconds": 2,
    "position_qty_after": "0.001",
    "evaluated_at": T0 + 110000,
}
valid["position_effect/open_pending_protected"] = effect
valid["position_effect/open_failed_compensated"] = {
    "schema_version": 1,
    "effect_id": "e5f60718-c9da-4ebf-9012-4c5d6e7f8091",
    "intent_id": "5e6f7081-92a3-4b4c-8d5e-6f708192a3b4",
    "plan_id": "bf6b2d13-3fba-4d5c-8d2b-7e3b6d2c8f12",
    "kind": "open",
    "account": "sub",
    "symbol": "SOLUSDT",
    "status": "failed",
    "target_qty": "1.5",
    "filled_qty": "1.5",
    "remaining_qty": "0",
    "remaining_canceled": True,
    "first_fill_at": T0 + 500,
    "protection_required": True,
    "protection_confirmed": False,
    "protection_order_ids": [],
    "naked_seconds": 21,
    "compensation_close_attempt_id": "cf7c3e24-40cb-4e6d-9e3c-8f4c7e3d9a23",
    "position_qty_after": "0",
    "failure_reason": "max_naked_seconds=20 内保护腿未确认,已 reduce-only 市价补偿平仓",
    "evaluated_at": T0 + 22000,
}
bad = copy.deepcopy(effect)
bad["status"] = "done"
invalid["position_effect/bad_status"] = bad

# ---------------- account_snapshot ----------------
comps = VECTORS["account_version_components"]["input"]
snap = {
    "schema_version": 1,
    "account": "sub",
    "channel": "mcp",
    "computed_at": T0,
    "consistency": "consistent",
    "account_version": ACCOUNT_VERSION,
    "span_ms": 350,
    "components": {
        "balances": {"observed_at": T0 - 100, "fetched_from": T0 - 350, "fetched_to": T0 - 100, "completeness": "complete", "source": "mcp", "data": comps["balances"]},
        "positions": {"observed_at": T0 - 50, "fetched_from": T0 - 300, "fetched_to": T0 - 50, "completeness": "complete", "source": "mcp", "data": comps["positions"]},
        "open_orders": {"observed_at": T0, "fetched_from": T0 - 200, "fetched_to": T0, "completeness": "complete", "source": "mcp", "data": comps["open_orders"]},
        "position_mode": {"observed_at": T0 - 350, "fetched_from": T0 - 400, "fetched_to": T0 - 350, "completeness": "complete", "source": "mcp", "data": comps["position_mode"]},
        "recent_fills": {"observed_at": T0 - 10, "fetched_from": T0 - 200, "fetched_to": T0 - 10, "completeness": "complete", "source": "mcp", "data": []},
        "margin": {
            "observed_at": T0 - 100,
            "fetched_from": T0 - 350,
            "fetched_to": T0 - 100,
            "completeness": "partial",
            "source": "mcp",
            "error": {"kind": "unavailable", "message": "margin ratio 字段缺失", "retryable": True},
            "data": {"margin_balance": "1000.5", "available_balance": "900"},
        },
    },
    "summary": {
        "quote_asset": "USDT",
        "wallet_balance": "1000.5",
        "margin_balance": "1000.5",
        "available_balance": "900",
        "unrealized_pnl": "0",
        "open_position_count": 0,
        "open_order_count": 0,
    },
}
valid["account_snapshot/sub_consistent"] = snap
valid["account_snapshot/main_unavailable"] = {
    "schema_version": 1,
    "account": "main",
    "channel": "rest",
    "computed_at": T0,
    "consistency": "unavailable",
    "consistency_reason": "REST -1021 时钟漂移;用户数据流断开 > 600s",
    "components": {
        "balances": {"observed_at": T0 - 700000, "fetched_from": T0 - 700100, "fetched_to": T0 - 700000, "completeness": "missing", "source": "cache", "error": {"kind": "stale", "message": "cache age 700s > 15s", "retryable": True, "exchange_code": -1021, "http_status": 400}},
        "positions": {"observed_at": T0 - 700000, "fetched_from": T0 - 700100, "fetched_to": T0 - 700000, "completeness": "missing", "source": "cache", "error": {"kind": "stale", "message": "cache age 700s", "retryable": True}},
        "open_orders": {"observed_at": T0 - 700000, "fetched_from": T0 - 700100, "fetched_to": T0 - 700000, "completeness": "missing", "source": "cache", "error": {"kind": "stale", "message": "cache age 700s", "retryable": True}},
        "position_mode": {"observed_at": T0 - 700000, "fetched_from": T0 - 700100, "fetched_to": T0 - 700000, "completeness": "missing", "source": "cache", "error": {"kind": "stale", "message": "cache age 700s", "retryable": True}},
    },
}
valid["account_snapshot/main_with_position"] = {
    "schema_version": 1,
    "account": "main",
    "channel": "rest",
    "computed_at": T0,
    "consistency": "consistent",
    "account_version": "0" * 64,
    "span_ms": 40,
    "components": {
        "balances": {"observed_at": T0 - 40, "fetched_from": T0 - 90, "fetched_to": T0 - 40, "completeness": "complete", "source": "rest", "data": [
            {"asset": "USDT", "wallet": "usdm_futures", "wallet_balance": "2500", "available": "2100.25", "unrealized_pnl": "-12.5"},
            {"asset": "USDT", "wallet": "spot", "wallet_balance": "300", "available": "300"},
        ]},
        "positions": {"observed_at": T0 - 30, "fetched_from": T0 - 80, "fetched_to": T0 - 30, "completeness": "complete", "source": "ws", "data": [
            {"symbol": "ETHUSDT", "product": "usdm_perp", "position_side": "both", "qty": "-0.5", "entry_price": "2950.4", "mark_price": "2975.4", "unrealized_pnl": "-12.5", "leverage": 3, "margin_type": "isolated", "isolated_margin": "491.7", "liquidation_price": "3890.2", "notional": "-1487.7", "exchange_update_time": T0 - 31}
        ]},
        "open_orders": {"observed_at": T0, "fetched_from": T0 - 20, "fetched_to": T0, "completeness": "complete", "source": "ws", "data": [
            {"exchange_order_id": "112233445566", "client_order_id": "web_abc123", "symbol": "ETHUSDT", "product": "usdm_perp", "side": "buy", "position_side": "both", "order_type": "stop_market", "status": "new", "orig_qty": "0.5", "executed_qty": "0", "stop_price": "3100", "reduce_only": True, "close_position": True, "working_type": "mark_price", "origin": "foreign", "exchange_update_time": T0 - 5000}
        ]},
        "position_mode": {"observed_at": T0 - 40, "fetched_from": T0 - 45, "fetched_to": T0 - 40, "completeness": "complete", "source": "rest", "data": {"mode": "one_way"}},
    },
    "summary": {"quote_asset": "USDT", "wallet_balance": "2500", "margin_balance": "2487.5", "available_balance": "2100.25", "unrealized_pnl": "-12.5", "today_realized_pnl": "3.2", "open_position_count": 1, "open_order_count": 1},
}
bad = copy.deepcopy(snap)
del bad["components"]["position_mode"]
invalid["account_snapshot/missing_position_mode"] = bad
bad = copy.deepcopy(snap)
bad["components"]["balances"]["data"][0]["wallet_balance"] = 1000.5
invalid["account_snapshot/float_balance"] = bad

# ---------------- policy ----------------
policy = {
    "schema_version": 1,
    "version": 3,
    "updated_at": T0 - 10000000,
    "mode": "run",
    "authority": "draft",
    "emergency_stop": False,
    "live_capped_enabled": False,
    "symbol_allowlist": ["BTCUSDT", "ETHUSDT"],
    "product_allowlist": ["usdm_perp"],
    "caps": {
        "max_leverage": 2,
        "risk_pct_per_trade": "0.25",
        "max_order_notional": "200",
        "max_position_notional": "400",
        "max_daily_opens": 2,
        "daily_loss_stop_pct": "1",
        "symbol_cooldown_seconds": 3600,
        "max_naked_seconds": 20,
        "account_truth_max_age_ms": 15000,
        "market_max_age_ms": 5000,
        "authorization_ttl_market_seconds": 30,
        "authorization_ttl_limit_seconds": 120,
        "max_price_deviation_bps": 55,
        "ntp_drift_block_ms": 2000,
        "ntp_drift_halt_ms": 10000,
    },
    "main_account": {"manual_trading_enabled": True, "transfers_enabled": False, "withdraw_enabled": False},
    "canary": {"enabled": False},
}
valid["policy/canary_defaults_draft"] = policy
p2 = copy.deepcopy(policy)
p2.update({"version": 4, "mode": "halt_all", "authority": "observe", "emergency_stop": True})
p2["canary"] = {"enabled": True, "max_loss_quote": "30", "max_notional_quote": "150", "max_leverage": 2, "funded_balance_quote": "100"}
valid["policy/halted_with_canary_limits"] = p2
bad = copy.deepcopy(policy)
bad["main_account"]["withdraw_enabled"] = True
invalid["policy/withdraw_enabled_true"] = bad
bad = copy.deepcopy(policy)
bad["caps"]["risk_pct_per_trade"] = 0.25
invalid["policy/float_risk_pct"] = bad

# ---------------- events ----------------
valid["events/intent_awaiting_approval"] = {
    "schema_version": 1,
    "seq": 4181,
    "event": "intent.awaiting_approval",
    "at": T0 + 1000,
    "account": "sub",
    "intent_id": INTENT,
    "plan_id": PLAN,
    "symbol": "BTCUSDT",
    "payload": {"status": "awaiting_approval", "plan_hash": PLAN_HASH, "authorization_ttl_seconds": 120},
}
valid["events/protection_missing"] = {
    "schema_version": 1,
    "seq": 4190,
    "event": "protection.missing",
    "at": T0 + 22000,
    "account": "sub",
    "intent_id": "5e6f7081-92a3-4b4c-8d5e-6f708192a3b4",
    "symbol": "SOLUSDT",
    "payload": {"naked_seconds": 21, "max_naked_seconds": 20, "action": "compensation_close"},
}
valid["events/health"] = {"schema_version": 1, "seq": 1, "event": "health", "at": T0, "payload": {"ok": True}}
bad = {"schema_version": 1, "seq": 2, "event": "intent.foo", "at": T0, "payload": {}}
invalid["events/unknown_event_name"] = bad

# ---------------- rpc ----------------
valid["rpc/request_intent_propose"] = {
    "jsonrpc": "2.0",
    "id": "req-0001",
    "method": "exec.intent.propose",
    "params": {
        "account": "sub",
        "principal": "model",
        "surface": "model",
        "session_id": "main",
        "run_id": "run-20260902-0001",
        "origin": "recipe:w4-judgment",
        "idempotency_key": "run-20260902-0001:BTCUSDT:1",
        "params": intent_open["params"],
        "ttl_seconds": 600,
    },
}
valid["rpc/success_health"] = {
    "jsonrpc": "2.0",
    "id": 7,
    "result": {
        "ok": True,
        "version": "0.1.0",
        "writer_instance_id": "execd-mba-2026",
        "lease_epoch": 7,
        "started_at": T0 - 3600000,
        "now": T0,
        "db_ok": True,
        "mode": "run",
        "halted": False,
        "open_intents": 1,
        "unknown_attempts": 0,
        "channels": {"main": {"state": "ok", "last_ok_at": T0 - 500}, "sub": {"state": "degraded", "detail": "oauth expiring in 8m"}},
    },
}
valid["rpc/failure_conflict"] = {
    "jsonrpc": "2.0",
    "id": "req-0002",
    "error": {
        "code": 1006,
        "message": "plan_hash mismatch: authorization refers to a superseded plan",
        "data": {"kind": "conflict", "retryable": False, "details": {"expected": PLAN_HASH, "got": "0" * 64}},
    },
}
valid["rpc/failure_parse_error_null_id"] = {
    "jsonrpc": "2.0",
    "id": None,
    "error": {"code": -32700, "message": "parse error", "data": {"kind": "invalid_params", "retryable": False}},
}
valid["rpc/notification_event"] = {
    "jsonrpc": "2.0",
    "method": "exec.event",
    "params": valid["events/intent_awaiting_approval"],
}
invalid["rpc/unknown_method"] = {"jsonrpc": "2.0", "id": 1, "method": "exec.nope", "params": {}}
invalid["rpc/notification_with_id"] = {"jsonrpc": "2.0", "id": 1, "method": "exec.event", "params": valid["events/health"]}
invalid["rpc/success_and_error"] = {"jsonrpc": "2.0", "id": 1, "result": {}, "error": {"code": 1, "message": "x", "data": {"kind": "internal", "retryable": False}}}


def write(base: pathlib.Path, table: dict):
    for rel, doc in table.items():
        path = base / (rel + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


write(FIX, valid)
write(FIX / "invalid", invalid)
print(f"wrote {len(valid)} valid + {len(invalid)} invalid fixtures")
