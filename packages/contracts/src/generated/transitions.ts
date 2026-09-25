/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: packages/contracts/{schema,transitions,tables}/*.json
 * Regenerate: `npm run generate` in packages/contracts (`npm run generate:check` verifies in CI).
 * Changing schema/transitions/tables is a main-line-only change — see docs/contracts/README.md §10.
 */

export const transitions = {
  "attempt_result": {
    "machine": "attempt_result",
    "version": 1,
    "description": "一次写调用的结果。unknown 非终态:只由 reconciler 按 clientOrderId 收敛;never 盲重放。",
    "initial": "pending",
    "states": [
      "pending",
      "acked",
      "rejected",
      "unknown",
      "not_received"
    ],
    "terminal": [
      "acked",
      "rejected",
      "not_received"
    ],
    "transitions": [
      {
        "from": "pending",
        "to": "acked",
        "event": "exchange_acked"
      },
      {
        "from": "pending",
        "to": "rejected",
        "event": "exchange_rejected"
      },
      {
        "from": "pending",
        "to": "unknown",
        "event": "ambiguous",
        "note": "超时/断连/401 发生在 submit 之后"
      },
      {
        "from": "pending",
        "to": "not_received",
        "event": "never_submitted",
        "note": "崩溃恢复时 stage 仍是 before_submit"
      },
      {
        "from": "unknown",
        "to": "acked",
        "event": "reconciled_found"
      },
      {
        "from": "unknown",
        "to": "rejected",
        "event": "reconciled_rejected"
      },
      {
        "from": "unknown",
        "to": "not_received",
        "event": "confirmed_not_received"
      }
    ]
  },
  "authorization_status": {
    "machine": "authorization_status",
    "version": 1,
    "description": "授权生命周期。授权只能被消费/过期/作废/撤销,不能被修改;经济字段变化 = 作废 + 新 plan + 新授权。",
    "initial": "active",
    "states": [
      "active",
      "consumed",
      "expired",
      "invalidated",
      "revoked"
    ],
    "terminal": [
      "consumed",
      "expired",
      "invalidated",
      "revoked"
    ],
    "transitions": [
      {
        "from": "active",
        "to": "consumed",
        "event": "dispatched"
      },
      {
        "from": "active",
        "to": "expired",
        "event": "ttl_elapsed"
      },
      {
        "from": "active",
        "to": "invalidated",
        "event": "plan_changed"
      },
      {
        "from": "active",
        "to": "invalidated",
        "event": "regate_rejected"
      },
      {
        "from": "active",
        "to": "invalidated",
        "event": "account_version_changed"
      },
      {
        "from": "active",
        "to": "revoked",
        "event": "user_revoked"
      },
      {
        "from": "active",
        "to": "revoked",
        "event": "emergency_stop"
      }
    ]
  },
  "exchange_order_status": {
    "machine": "exchange_order_status",
    "version": 1,
    "description": "交易所订单状态的合法前进方向,用于校验观察序列的单调性(乱序/倒退 → ORDER_STATE_UNKNOWN attention)。同状态的新观察(如更多部分成交)不是状态变化。",
    "initial": "new",
    "states": [
      "new",
      "partially_filled",
      "filled",
      "canceled",
      "expired",
      "rejected"
    ],
    "terminal": [
      "filled",
      "canceled",
      "expired",
      "rejected"
    ],
    "transitions": [
      {
        "from": "new",
        "to": "partially_filled",
        "event": "partial_fill"
      },
      {
        "from": "new",
        "to": "filled",
        "event": "fill"
      },
      {
        "from": "new",
        "to": "canceled",
        "event": "cancel"
      },
      {
        "from": "new",
        "to": "expired",
        "event": "expire"
      },
      {
        "from": "new",
        "to": "rejected",
        "event": "reject"
      },
      {
        "from": "partially_filled",
        "to": "filled",
        "event": "fill"
      },
      {
        "from": "partially_filled",
        "to": "canceled",
        "event": "cancel",
        "note": "部分成交后撤单:executed_qty 保留"
      },
      {
        "from": "partially_filled",
        "to": "expired",
        "event": "expire"
      }
    ]
  },
  "intent_status": {
    "machine": "intent_status",
    "version": 1,
    "description": "设计 §5.1 状态图的可执行表。自环(部分成交、unknown 轮询继续)不是状态变化,不在表里。同一 (from,to) 可有多个 event。终态无出边。",
    "initial": "proposed",
    "states": [
      "proposed",
      "rejected",
      "awaiting_approval",
      "authorized",
      "recorded",
      "dispatching",
      "execution_unknown",
      "executing",
      "completed",
      "canceled",
      "expired"
    ],
    "terminal": [
      "rejected",
      "recorded",
      "completed",
      "canceled",
      "expired"
    ],
    "transitions": [
      {
        "from": "proposed",
        "to": "rejected",
        "event": "gate_rejected"
      },
      {
        "from": "proposed",
        "to": "awaiting_approval",
        "event": "plan_materialized"
      },
      {
        "from": "proposed",
        "to": "authorized",
        "event": "policy_auto_authorized",
        "note": "仅 LiveCapped 且上限内;v1 feature gate 关闭"
      },
      {
        "from": "proposed",
        "to": "recorded",
        "event": "observe_only"
      },
      {
        "from": "proposed",
        "to": "expired",
        "event": "proposal_ttl_elapsed"
      },
      {
        "from": "awaiting_approval",
        "to": "authorized",
        "event": "user_approved"
      },
      {
        "from": "awaiting_approval",
        "to": "expired",
        "event": "approval_ttl_elapsed"
      },
      {
        "from": "awaiting_approval",
        "to": "rejected",
        "event": "user_rejected"
      },
      {
        "from": "awaiting_approval",
        "to": "rejected",
        "event": "regate_rejected"
      },
      {
        "from": "authorized",
        "to": "dispatching",
        "event": "executor_claimed"
      },
      {
        "from": "authorized",
        "to": "rejected",
        "event": "regate_rejected",
        "note": "批后执行前账户版本变了且重闸不过:拒绝并作废授权,不改 plan"
      },
      {
        "from": "authorized",
        "to": "expired",
        "event": "authorization_ttl_elapsed"
      },
      {
        "from": "authorized",
        "to": "canceled",
        "event": "halted_before_dispatch"
      },
      {
        "from": "dispatching",
        "to": "executing",
        "event": "exchange_acked"
      },
      {
        "from": "dispatching",
        "to": "rejected",
        "event": "exchange_rejected"
      },
      {
        "from": "dispatching",
        "to": "rejected",
        "event": "regate_rejected"
      },
      {
        "from": "dispatching",
        "to": "execution_unknown",
        "event": "submit_ambiguous",
        "note": "超时/断连/进程死在 after_submit"
      },
      {
        "from": "dispatching",
        "to": "canceled",
        "event": "halted_before_submit"
      },
      {
        "from": "execution_unknown",
        "to": "executing",
        "event": "reconciled_found",
        "note": "按 clientOrderId 在 history/fills/open orders 找到"
      },
      {
        "from": "execution_unknown",
        "to": "canceled",
        "event": "confirmed_not_received",
        "note": "history 无且超 recvWindow,确认交易所从未收到"
      },
      {
        "from": "executing",
        "to": "completed",
        "event": "effect_satisfied",
        "note": "PositionEffect.status=satisfied(含保护腿确认)"
      },
      {
        "from": "executing",
        "to": "canceled",
        "event": "cancel_confirmed"
      },
      {
        "from": "executing",
        "to": "canceled",
        "event": "expired_on_exchange"
      },
      {
        "from": "executing",
        "to": "canceled",
        "event": "compensation_close",
        "note": "max_naked_seconds 内保护腿未确认 → 补偿平仓后归 canceled"
      }
    ]
  }
} as const;
