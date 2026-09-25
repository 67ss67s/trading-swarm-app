/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: packages/contracts/{schema,transitions,tables}/*.json
 * Regenerate: `npm run generate` in packages/contracts (`npm run generate:check` verifies in CI).
 * Changing schema/transitions/tables is a main-line-only change — see docs/contracts/README.md §10.
 */

export const schemas = {
  "account_snapshot": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/account_snapshot.json",
    "title": "AccountSnapshot",
    "description": "账户真相(设计 §6.2 account.truth / Codex review #6):每个组件各自 observed_at、取数区间、completeness;经济组件哈希 = account_version;组件缺失或跨度过大 → inconsistent(gate 拒开仓);不可得 → unavailable。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "account",
      "channel",
      "computed_at",
      "consistency",
      "components"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "computed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "consistency": {
        "$ref": "common.json#/$defs/Consistency"
      },
      "consistency_reason": {
        "type": "string",
        "maxLength": 500
      },
      "account_version": {
        "$ref": "common.json#/$defs/Hash256",
        "description": "sha256(canonical_json({balances,positions,open_orders,position_mode} 的 data)),见 docs/contracts/README.md"
      },
      "span_ms": {
        "type": "integer",
        "minimum": 0,
        "description": "各必需组件 observed_at 的最大差"
      },
      "components": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "balances",
          "positions",
          "open_orders",
          "position_mode"
        ],
        "properties": {
          "balances": {
            "$ref": "#/$defs/BalancesComponent"
          },
          "positions": {
            "$ref": "#/$defs/PositionsComponent"
          },
          "open_orders": {
            "$ref": "#/$defs/OrdersComponent"
          },
          "position_mode": {
            "$ref": "#/$defs/PositionModeComponent"
          },
          "recent_fills": {
            "$ref": "#/$defs/FillsComponent"
          },
          "order_history": {
            "$ref": "#/$defs/OrdersComponent"
          },
          "margin": {
            "$ref": "#/$defs/MarginComponent"
          }
        }
      },
      "summary": {
        "$ref": "#/$defs/AccountSummary"
      }
    },
    "$defs": {
      "BalanceRow": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "asset",
          "wallet",
          "wallet_balance",
          "available"
        ],
        "properties": {
          "asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "wallet": {
            "$ref": "common.json#/$defs/Wallet"
          },
          "wallet_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "available": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "unrealized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          }
        }
      },
      "PositionRow": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "symbol",
          "product",
          "position_side",
          "qty",
          "entry_price"
        ],
        "properties": {
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "qty": {
            "$ref": "common.json#/$defs/Decimal",
            "description": "one_way 下带符号(空头为负);hedge 下按 position_side 为正"
          },
          "entry_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "mark_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "unrealized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "margin_type": {
            "$ref": "common.json#/$defs/MarginType"
          },
          "isolated_margin": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "liquidation_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "notional": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "exchange_update_time": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "OrderRow": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "exchange_order_id",
          "symbol",
          "product",
          "side",
          "position_side",
          "order_type",
          "status",
          "orig_qty",
          "executed_qty",
          "reduce_only",
          "origin"
        ],
        "properties": {
          "exchange_order_id": {
            "type": "string",
            "maxLength": 64
          },
          "client_order_id": {
            "$ref": "common.json#/$defs/ClientOrderId"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "side": {
            "$ref": "common.json#/$defs/Side"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "order_type": {
            "$ref": "common.json#/$defs/OrderType"
          },
          "status": {
            "$ref": "common.json#/$defs/ExchangeOrderStatus"
          },
          "orig_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "executed_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "avg_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "stop_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "reduce_only": {
            "type": "boolean"
          },
          "close_position": {
            "type": "boolean"
          },
          "time_in_force": {
            "$ref": "common.json#/$defs/TimeInForce"
          },
          "working_type": {
            "$ref": "common.json#/$defs/WorkingType"
          },
          "origin": {
            "$ref": "common.json#/$defs/OrderOrigin"
          },
          "exchange_update_time": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "exchange_create_time": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "FillRow": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "trade_id",
          "exchange_order_id",
          "symbol",
          "product",
          "side",
          "qty",
          "price",
          "trade_time"
        ],
        "properties": {
          "trade_id": {
            "type": "string",
            "maxLength": 64
          },
          "exchange_order_id": {
            "type": "string",
            "maxLength": 64
          },
          "client_order_id": {
            "$ref": "common.json#/$defs/ClientOrderId"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "side": {
            "$ref": "common.json#/$defs/Side"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "quote_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "commission": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "commission_asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "realized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "is_maker": {
            "type": "boolean"
          },
          "trade_time": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "MarginInfo": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "margin_ratio": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "maintenance_margin": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "margin_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "available_balance": {
            "$ref": "common.json#/$defs/Decimal"
          }
        }
      },
      "BalancesComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BalanceRow"
            }
          }
        }
      },
      "PositionsComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PositionRow"
            }
          }
        }
      },
      "OrdersComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/OrderRow"
            }
          }
        }
      },
      "PositionModeComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode"
            ],
            "properties": {
              "mode": {
                "$ref": "common.json#/$defs/PositionMode"
              }
            }
          }
        }
      },
      "FillsComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/FillRow"
            }
          }
        }
      },
      "MarginComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "$ref": "#/$defs/MarginInfo"
          }
        }
      },
      "AccountSummary": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "quote_asset",
          "wallet_balance",
          "available_balance",
          "unrealized_pnl",
          "open_position_count",
          "open_order_count"
        ],
        "properties": {
          "quote_asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "wallet_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "margin_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "available_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "unrealized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "today_realized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "open_position_count": {
            "type": "integer",
            "minimum": 0
          },
          "open_order_count": {
            "type": "integer",
            "minimum": 0
          }
        }
      }
    }
  },
  "attempt": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/attempt.json",
    "title": "ExecutionAttempt",
    "description": "一次对交易所的写调用(设计 §5.1)。clientOrderId 与完整订单指纹在调用前持久化(stage=before_submit);同 id 重发必须是交易所级幂等,否则不重发;结果 unknown 非终态,由 reconciler 按 clientOrderId 收敛。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "attempt_id",
      "intent_id",
      "plan_id",
      "plan_hash",
      "attempt_no",
      "leg",
      "leg_index",
      "account",
      "channel",
      "client_order_id",
      "order_fingerprint",
      "writer_instance_id",
      "lease_epoch",
      "fencing_token",
      "stage",
      "result",
      "created_at",
      "deadline_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "attempt_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_hash": {
        "$ref": "common.json#/$defs/Hash256"
      },
      "attempt_no": {
        "type": "integer",
        "minimum": 1
      },
      "leg": {
        "$ref": "common.json#/$defs/Leg"
      },
      "leg_index": {
        "type": "integer",
        "minimum": 0,
        "description": "同类腿的序号,如第 2 个止盈腿"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "client_order_id": {
        "$ref": "common.json#/$defs/ClientOrderId",
        "description": "tg-<intent_id 前 12 hex>-<leg 码 e|s|t|c|x|f>-<attempt_no>;transfer 类放 transfer 的 client tran id"
      },
      "order_fingerprint": {
        "type": "string",
        "maxLength": 1024,
        "description": "canonical_json(实际发送给交易所的参数,脱敏)——对账时与交易所回显逐字比对"
      },
      "writer_instance_id": {
        "type": "string",
        "maxLength": 128
      },
      "lease_epoch": {
        "type": "integer",
        "minimum": 0
      },
      "fencing_token": {
        "type": "string",
        "maxLength": 128
      },
      "stage": {
        "$ref": "common.json#/$defs/AttemptStage"
      },
      "result": {
        "$ref": "common.json#/$defs/AttemptResult"
      },
      "created_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "submitted_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "deadline_at": {
        "$ref": "common.json#/$defs/TimestampMs",
        "description": "调用截止;超过仍无结果 → result=unknown"
      },
      "result_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "exchange_order_id": {
        "type": "string",
        "maxLength": 64
      },
      "exchange_ref": {
        "type": "string",
        "maxLength": 128,
        "description": "非订单类效果的交易所引用,如 transfer 的 tranId"
      },
      "error": {
        "$ref": "common.json#/$defs/ErrorInfo"
      },
      "tool_name": {
        "type": "string",
        "maxLength": 128,
        "description": "MCP 通道:实际调用的工具名(来自钉版快照)"
      },
      "tools_hash": {
        "$ref": "common.json#/$defs/Hash256",
        "description": "MCP 通道:调用时的 tools/list 快照哈希(漂移守卫)"
      }
    }
  },
  "authorization": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/authorization.json",
    "title": "Authorization",
    "description": "对某个 plan_hash 的授权(设计 §5.1)。by=user 需要 confirm_echo(结构化确认:审批面逐字回填关键字段,execd 与 plan 派生的 confirm_fields 逐字比对);by=policy 只在 LiveCapped 且上限内出现(v1 feature-gate 关闭)。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "authorization_id",
      "intent_id",
      "plan_id",
      "plan_hash",
      "by",
      "status",
      "granted_at",
      "expires_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "authorization_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_hash": {
        "$ref": "common.json#/$defs/Hash256"
      },
      "by": {
        "type": "string",
        "enum": [
          "user",
          "policy"
        ]
      },
      "principal": {
        "$ref": "common.json#/$defs/Principal"
      },
      "surface": {
        "$ref": "common.json#/$defs/Surface"
      },
      "actor_ref": {
        "type": "string",
        "maxLength": 256,
        "description": "谁批的:设备/会话/RPC 连接标识;by=policy 时为 policy 版本"
      },
      "status": {
        "$ref": "common.json#/$defs/AuthorizationStatus"
      },
      "status_reason": {
        "type": "string",
        "maxLength": 1000
      },
      "confirm_echo": {
        "type": "object",
        "additionalProperties": {
          "type": "string",
          "maxLength": 200
        },
        "description": "审批面回填的字段(见 docs/contracts/README.md「confirm_fields」);by=user 必填"
      },
      "granted_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "expires_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "consumed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "consumed_by_attempt_id": {
        "$ref": "common.json#/$defs/Uuid"
      }
    },
    "if": {
      "properties": {
        "by": {
          "const": "user"
        }
      },
      "required": [
        "by"
      ]
    },
    "then": {
      "required": [
        "confirm_echo",
        "principal",
        "surface"
      ]
    }
  },
  "common": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/common.json",
    "title": "Common",
    "description": "所有契约共享的基础类型。金额/价格/数量一律十进制字符串,时间戳一律 unix 毫秒整数,枚举一律小写 snake_case。",
    "$defs": {
      "Uuid": {
        "type": "string",
        "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        "description": "小写 UUID(v4 为主)"
      },
      "Decimal": {
        "type": "string",
        "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$",
        "description": "十进制字符串;不用 float,便于两种语言得到相同的 canonical JSON 与哈希"
      },
      "UnsignedDecimal": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
      },
      "TimestampMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991,
        "description": "unix 毫秒;上限为 JS 安全整数"
      },
      "Hash256": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$",
        "description": "sha256 小写 hex"
      },
      "Symbol": {
        "type": "string",
        "pattern": "^[A-Z0-9]{2,20}$",
        "description": "交易所符号,如 BTCUSDT"
      },
      "Asset": {
        "type": "string",
        "pattern": "^[A-Z0-9]{1,12}$"
      },
      "ClientOrderId": {
        "type": "string",
        "pattern": "^[\\.A-Z:/a-z0-9_-]{1,36}$",
        "description": "Binance 允许的 clientOrderId 字符集与长度;本仓库生成的以 tg- 开头"
      },
      "AccountRef": {
        "type": "string",
        "enum": [
          "main",
          "sub"
        ],
        "description": "main=主账户(用户,REST);sub=Agentic 子账户(agent,MCP)"
      },
      "Channel": {
        "type": "string",
        "enum": [
          "rest",
          "mcp"
        ]
      },
      "ObservationSource": {
        "type": "string",
        "enum": [
          "rest",
          "ws",
          "mcp",
          "cache"
        ]
      },
      "Product": {
        "type": "string",
        "enum": [
          "usdm_perp",
          "spot"
        ],
        "description": "v1:USDⓈ-M 永续可交易;spot 只读"
      },
      "Side": {
        "type": "string",
        "enum": [
          "buy",
          "sell"
        ]
      },
      "PositionSide": {
        "type": "string",
        "enum": [
          "both",
          "long",
          "short"
        ]
      },
      "PositionMode": {
        "type": "string",
        "enum": [
          "one_way",
          "hedge"
        ]
      },
      "MarginType": {
        "type": "string",
        "enum": [
          "isolated",
          "cross"
        ]
      },
      "OrderType": {
        "type": "string",
        "enum": [
          "market",
          "limit",
          "stop_market",
          "stop_limit",
          "take_profit_market",
          "take_profit_limit",
          "trailing_stop_market"
        ]
      },
      "TimeInForce": {
        "type": "string",
        "enum": [
          "gtc",
          "ioc",
          "fok",
          "gtx"
        ]
      },
      "WorkingType": {
        "type": "string",
        "enum": [
          "mark_price",
          "contract_price"
        ],
        "description": "条件单触发价来源:mark=标记价,contract=最新成交价"
      },
      "Wallet": {
        "type": "string",
        "enum": [
          "spot",
          "usdm_futures"
        ]
      },
      "Principal": {
        "type": "string",
        "enum": [
          "user",
          "model",
          "cron",
          "scheduler",
          "mcp_client"
        ],
        "description": "ActorContext.principal(设计 §6.1)"
      },
      "Surface": {
        "type": "string",
        "enum": [
          "rpc",
          "model",
          "mcp",
          "internal"
        ]
      },
      "IntentKind": {
        "type": "string",
        "enum": [
          "open",
          "close",
          "cancel_order",
          "protect",
          "transfer"
        ]
      },
      "IntentStatus": {
        "type": "string",
        "enum": [
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
        "description": "设计 §5.1 状态图;终态 rejected/recorded/completed/canceled/expired;execution_unknown 非终态"
      },
      "AuthorizationStatus": {
        "type": "string",
        "enum": [
          "active",
          "consumed",
          "expired",
          "invalidated",
          "revoked"
        ]
      },
      "AttemptStage": {
        "type": "string",
        "enum": [
          "before_submit",
          "submitted",
          "result_persisted"
        ],
        "description": "崩溃边界:clientOrderId 在 before_submit 时已持久化;submitted 后不知结果即 unknown"
      },
      "AttemptResult": {
        "type": "string",
        "enum": [
          "pending",
          "acked",
          "rejected",
          "unknown",
          "not_received"
        ]
      },
      "ExchangeOrderStatus": {
        "type": "string",
        "enum": [
          "new",
          "partially_filled",
          "filled",
          "canceled",
          "expired",
          "rejected"
        ]
      },
      "EffectStatus": {
        "type": "string",
        "enum": [
          "pending",
          "satisfied",
          "failed"
        ]
      },
      "Leg": {
        "type": "string",
        "enum": [
          "entry",
          "stop",
          "take_profit",
          "cancel",
          "close",
          "transfer"
        ],
        "description": "一个 intent 可能产生多条腿;每条腿各自有 ExecutionAttempt"
      },
      "OrderOrigin": {
        "type": "string",
        "enum": [
          "local",
          "foreign",
          "unknown"
        ],
        "description": "按 clientOrderId 前缀判定:tg- 为本机;其他(含 8794 的 ts_)为外部"
      },
      "Completeness": {
        "type": "string",
        "enum": [
          "complete",
          "partial",
          "missing"
        ]
      },
      "Consistency": {
        "type": "string",
        "enum": [
          "consistent",
          "inconsistent",
          "unavailable"
        ]
      },
      "PolicyMode": {
        "type": "string",
        "enum": [
          "run",
          "stop_opening",
          "flatten_only",
          "halt_all"
        ]
      },
      "Authority": {
        "type": "string",
        "enum": [
          "observe",
          "draft",
          "paper",
          "live_capped"
        ]
      },
      "ErrorKind": {
        "type": "string",
        "enum": [
          "invalid_params",
          "not_found",
          "forbidden",
          "halted",
          "stale",
          "unavailable",
          "conflict",
          "expired",
          "invalid_transition",
          "gate_rejected",
          "exchange_rejected",
          "unauthorized",
          "rate_limited",
          "transport_ambiguous",
          "internal"
        ]
      },
      "ErrorInfo": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "message",
          "retryable"
        ],
        "properties": {
          "kind": {
            "$ref": "#/$defs/ErrorKind"
          },
          "message": {
            "type": "string",
            "maxLength": 2000
          },
          "retryable": {
            "type": "boolean"
          },
          "exchange_code": {
            "type": "integer",
            "description": "交易所错误码(如 Binance -2021),有则带"
          },
          "http_status": {
            "type": "integer",
            "minimum": 100,
            "maximum": 599
          }
        }
      },
      "GateRejection": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "gate",
          "message"
        ],
        "properties": {
          "gate": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_.]{1,63}$",
            "description": "闸名,如 policy.mode / freshness.account / risk.max_leverage"
          },
          "value": {
            "type": "string",
            "maxLength": 200,
            "description": "被拒时的实际值(字符串化)"
          },
          "limit": {
            "type": "string",
            "maxLength": 200,
            "description": "阈值(字符串化)"
          },
          "message": {
            "type": "string",
            "maxLength": 1000
          }
        }
      },
      "SchemaVersion": {
        "type": "integer",
        "const": 1
      }
    }
  },
  "demo_portfolio_capacity": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/demo_portfolio_capacity.json",
    "title": "DemoPortfolioCapacity",
    "description": "Portfolio Manager 典型止损容量估算；不是执行授权。金额为十进制字符串，不能计算的字段显式 null。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "snapshot_id",
      "computed_at",
      "basis",
      "snapshot_quality",
      "equity",
      "available",
      "risk_pct",
      "leverage",
      "default_stop_distance_pct",
      "slots_total",
      "slots_used",
      "slots_free",
      "margin_budget",
      "binding_constraint",
      "by_symbol"
    ],
    "properties": {
      "schema_version": {
        "const": 1
      },
      "snapshot_id": {
        "type": "string"
      },
      "computed_at": {
        "type": "integer",
        "minimum": 0
      },
      "basis": {
        "const": "typical_stop_estimate"
      },
      "snapshot_quality": {
        "enum": [
          "ok",
          "stale",
          "inconsistent",
          "incomplete"
        ]
      },
      "equity": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
          },
          {
            "type": "null"
          }
        ]
      },
      "available": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
          },
          {
            "type": "null"
          }
        ]
      },
      "risk_pct": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
      },
      "leverage": {
        "type": "number",
        "exclusiveMinimum": 0
      },
      "default_stop_distance_pct": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
      },
      "slots_total": {
        "type": "integer",
        "minimum": 0
      },
      "slots_used": {
        "type": "integer",
        "minimum": 0
      },
      "slots_free": {
        "type": "integer",
        "minimum": 0
      },
      "margin_budget": {
        "$ref": "#/$defs/DemoCapacityMargin"
      },
      "binding_constraint": {
        "$ref": "#/$defs/DemoCapacityConstraint"
      },
      "by_symbol": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/DemoSymbolCapacity"
        }
      }
    },
    "$defs": {
      "DemoCapacityConstraint": {
        "enum": [
          "thread_slots",
          "margin_budget",
          "available_margin",
          "min_size_risk",
          "rules_unknown",
          "market_unavailable",
          "watchlist",
          "snapshot_unavailable"
        ]
      },
      "DemoCapacityMargin": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "max_margin_ratio",
          "limit_usdt",
          "committed_usdt",
          "reserved_usdt",
          "free_usdt",
          "required_for_free_slots_usdt",
          "slots_supported",
          "witness_symbols"
        ],
        "properties": {
          "max_margin_ratio": {
            "type": "number",
            "exclusiveMinimum": 0,
            "maximum": 1
          },
          "limit_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "committed_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "reserved_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "free_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "required_for_free_slots_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "slots_supported": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0
          },
          "witness_symbols": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      "DemoSymbolCapacity": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "symbol",
          "verdict",
          "watch_only",
          "occupied",
          "price",
          "rules_source",
          "rules_observed_at",
          "stop_distance_pct",
          "stop_source",
          "min_qty",
          "min_viable_notional",
          "min_size_risk",
          "required_equity",
          "equity_shortfall",
          "margin_per_thread",
          "risk_budget",
          "budget_margin_per_thread"
        ],
        "properties": {
          "symbol": {
            "type": "string"
          },
          "verdict": {
            "enum": [
              "ok",
              "needs_equity",
              "rules_unknown",
              "unavailable"
            ]
          },
          "watch_only": {
            "type": "boolean"
          },
          "occupied": {
            "type": "boolean"
          },
          "price": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "rules_source": {
            "enum": [
              "exchange",
              "paper",
              null
            ]
          },
          "rules_observed_at": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0
          },
          "stop_distance_pct": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "stop_source": {
            "enum": [
              "atr",
              "default",
              null
            ]
          },
          "min_qty": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "min_viable_notional": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "min_size_risk": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "required_equity": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "equity_shortfall": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "margin_per_thread": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "risk_budget": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "budget_margin_per_thread": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      }
    }
  },
  "events": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/events.json",
    "title": "ExecEvent",
    "description": "execd 发出的事件(UDS 通知 exec.event,同时落 exec.sqlite events 表,seq 单调,支持 since_seq 回放)。gateway 把它桥接到自己的事件总线与 events 表——'事件即审计'口径(设计 §4)。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "seq",
      "event",
      "at",
      "payload"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "seq": {
        "type": "integer",
        "minimum": 1
      },
      "event": {
        "$ref": "#/$defs/EventName"
      },
      "at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "attempt_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "symbol": {
        "$ref": "common.json#/$defs/Symbol"
      },
      "payload": {
        "type": "object",
        "description": "事件专属载荷(通常是对应记录本身或其差分)"
      }
    },
    "$defs": {
      "EventName": {
        "type": "string",
        "enum": [
          "intent.created",
          "intent.rejected",
          "intent.awaiting_approval",
          "intent.authorized",
          "intent.recorded",
          "intent.dispatching",
          "intent.executing",
          "intent.execution_unknown",
          "intent.completed",
          "intent.canceled",
          "intent.expired",
          "plan.materialized",
          "authorization.granted",
          "authorization.consumed",
          "authorization.invalidated",
          "authorization.expired",
          "authorization.revoked",
          "attempt.submitting",
          "attempt.submitted",
          "attempt.resolved",
          "order.observed",
          "fill.observed",
          "effect.evaluated",
          "protection.confirmed",
          "protection.missing",
          "protection.compensated",
          "account.updated",
          "account.stale",
          "account.inconsistent",
          "foreign_activity.detected",
          "exchange.auth.expiring",
          "exchange.auth.expired",
          "exchange.auth.revoked",
          "exchange.auth.refreshed",
          "exchange.tools.drift",
          "exchange.channel.degraded",
          "exchange.channel.recovered",
          "policy.changed",
          "halt.changed",
          "writer.fenced",
          "corruption.detected",
          "health"
        ]
      }
    }
  },
  "exchange_order": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/exchange_order.json",
    "title": "ExchangeOrderObservation",
    "description": "交易所订单的观察值(设计 §5.1):不可变、按 observed_at 追加;订单状态从最新观察派生。同一 exchange_order_id 的观察序列必须满足 transitions/exchange_order_status.json 的单调性,否则标 ORDER_STATE_UNKNOWN。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "observation_id",
      "account",
      "channel",
      "source",
      "product",
      "symbol",
      "exchange_order_id",
      "status",
      "side",
      "position_side",
      "order_type",
      "orig_qty",
      "executed_qty",
      "reduce_only",
      "origin",
      "observed_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "observation_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "source": {
        "$ref": "common.json#/$defs/ObservationSource"
      },
      "product": {
        "$ref": "common.json#/$defs/Product"
      },
      "symbol": {
        "$ref": "common.json#/$defs/Symbol"
      },
      "exchange_order_id": {
        "type": "string",
        "maxLength": 64
      },
      "client_order_id": {
        "$ref": "common.json#/$defs/ClientOrderId"
      },
      "status": {
        "$ref": "common.json#/$defs/ExchangeOrderStatus"
      },
      "side": {
        "$ref": "common.json#/$defs/Side"
      },
      "position_side": {
        "$ref": "common.json#/$defs/PositionSide"
      },
      "order_type": {
        "$ref": "common.json#/$defs/OrderType"
      },
      "orig_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "executed_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "avg_price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "stop_price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "cum_quote": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "reduce_only": {
        "type": "boolean"
      },
      "close_position": {
        "type": "boolean"
      },
      "time_in_force": {
        "$ref": "common.json#/$defs/TimeInForce"
      },
      "working_type": {
        "$ref": "common.json#/$defs/WorkingType"
      },
      "origin": {
        "$ref": "common.json#/$defs/OrderOrigin"
      },
      "attempt_id": {
        "$ref": "common.json#/$defs/Uuid",
        "description": "按 client_order_id 归属到的本机 attempt;foreign 订单为空"
      },
      "exchange_update_time": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "exchange_create_time": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "observed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "raw_hash": {
        "$ref": "common.json#/$defs/Hash256",
        "description": "原始交易所响应的 sha256(原文按保留策略另存)"
      }
    }
  },
  "fill": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/fill.json",
    "title": "Fill",
    "description": "成交观察值(设计 §5.1),不可变;(account, exchange_order_id, trade_id) 唯一。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "fill_id",
      "account",
      "channel",
      "source",
      "product",
      "symbol",
      "exchange_order_id",
      "trade_id",
      "side",
      "qty",
      "price",
      "trade_time",
      "observed_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "fill_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "source": {
        "$ref": "common.json#/$defs/ObservationSource"
      },
      "product": {
        "$ref": "common.json#/$defs/Product"
      },
      "symbol": {
        "$ref": "common.json#/$defs/Symbol"
      },
      "exchange_order_id": {
        "type": "string",
        "maxLength": 64
      },
      "trade_id": {
        "type": "string",
        "maxLength": 64
      },
      "client_order_id": {
        "$ref": "common.json#/$defs/ClientOrderId"
      },
      "attempt_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "side": {
        "$ref": "common.json#/$defs/Side"
      },
      "position_side": {
        "$ref": "common.json#/$defs/PositionSide"
      },
      "qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "quote_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "commission": {
        "$ref": "common.json#/$defs/Decimal"
      },
      "commission_asset": {
        "$ref": "common.json#/$defs/Asset"
      },
      "realized_pnl": {
        "$ref": "common.json#/$defs/Decimal"
      },
      "is_maker": {
        "type": "boolean"
      },
      "trade_time": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "observed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      }
    }
  },
  "intent": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/intent.json",
    "title": "Intent",
    "description": "动钱的唯一提议记录(设计 §5.1)。模型/UI/Exit DSL 只能提议;经济字段在 ExecutableOrderPlan 里物化并哈希;状态只按 transitions/intent_status.json 迁移。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "intent_id",
      "account",
      "principal",
      "surface",
      "params",
      "status",
      "gate_rejections",
      "ttl_seconds",
      "created_at",
      "updated_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef",
        "description": "效果落在哪个账户;transfer 类以 from_account 为 lane"
      },
      "principal": {
        "$ref": "common.json#/$defs/Principal"
      },
      "surface": {
        "$ref": "common.json#/$defs/Surface"
      },
      "session_id": {
        "type": "string",
        "maxLength": 128
      },
      "run_id": {
        "type": "string",
        "maxLength": 128
      },
      "origin": {
        "type": "string",
        "maxLength": 256,
        "description": "来源说明,如 recipe:w4-judgment / ui:trade-page / exit-dsl:thread-42"
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 128,
        "description": "提议方幂等键;execd 按 (principal, idempotency_key) 去重,同键不同内容 = corruption"
      },
      "params": {
        "$ref": "#/$defs/IntentParams"
      },
      "status": {
        "$ref": "common.json#/$defs/IntentStatus"
      },
      "status_reason": {
        "type": "string",
        "maxLength": 1000
      },
      "gate_rejections": {
        "type": "array",
        "items": {
          "$ref": "common.json#/$defs/GateRejection"
        },
        "description": "每次闸拒都追加,不覆盖"
      },
      "current_plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "authorization_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "ttl_seconds": {
        "type": "integer",
        "minimum": 1,
        "maximum": 86400,
        "description": "提议有效期;到期未进入 authorized 即 expired"
      },
      "created_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "updated_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "expires_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "terminal_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      }
    },
    "$defs": {
      "IntentParams": {
        "oneOf": [
          {
            "$ref": "#/$defs/OpenParams"
          },
          {
            "$ref": "#/$defs/CloseParams"
          },
          {
            "$ref": "#/$defs/CancelOrderParams"
          },
          {
            "$ref": "#/$defs/ProtectParams"
          },
          {
            "$ref": "#/$defs/TransferParams"
          }
        ]
      },
      "SizeSpec": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode",
              "hint"
            ],
            "properties": {
              "mode": {
                "const": "hint"
              },
              "hint": {
                "type": "string",
                "enum": [
                  "full",
                  "half",
                  "quarter"
                ],
                "description": "模型只给档位;qty 由代码按止损距离与风险预算反推"
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode",
              "qty"
            ],
            "properties": {
              "mode": {
                "const": "qty"
              },
              "qty": {
                "$ref": "common.json#/$defs/UnsignedDecimal"
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode",
              "notional"
            ],
            "properties": {
              "mode": {
                "const": "notional"
              },
              "notional": {
                "$ref": "common.json#/$defs/UnsignedDecimal",
                "description": "计价币名义(USDT)"
              }
            }
          }
        ]
      },
      "EntrySpec": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type"
            ],
            "properties": {
              "type": {
                "const": "market"
              },
              "max_slippage_bps": {
                "type": "integer",
                "minimum": 0,
                "maximum": 10000
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type",
              "price"
            ],
            "properties": {
              "type": {
                "const": "limit"
              },
              "price": {
                "$ref": "common.json#/$defs/UnsignedDecimal"
              },
              "time_in_force": {
                "$ref": "common.json#/$defs/TimeInForce"
              },
              "post_only": {
                "type": "boolean"
              }
            }
          }
        ]
      },
      "StopRef": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "price",
          "trigger"
        ],
        "properties": {
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "trigger": {
            "$ref": "common.json#/$defs/WorkingType"
          }
        }
      },
      "TakeProfitSpec": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "price",
          "pct"
        ],
        "properties": {
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "pct": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "占仓位百分比 (0,100]"
          },
          "trigger": {
            "$ref": "common.json#/$defs/WorkingType"
          }
        }
      },
      "OrderRef": {
        "type": "object",
        "additionalProperties": false,
        "minProperties": 1,
        "properties": {
          "exchange_order_id": {
            "type": "string",
            "maxLength": 64
          },
          "client_order_id": {
            "$ref": "common.json#/$defs/ClientOrderId"
          }
        }
      },
      "OpenParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "side",
          "size",
          "entry",
          "stop",
          "evidence_refs"
        ],
        "properties": {
          "kind": {
            "const": "open"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "side": {
            "$ref": "common.json#/$defs/Side"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "size": {
            "$ref": "#/$defs/SizeSpec"
          },
          "entry": {
            "$ref": "#/$defs/EntrySpec"
          },
          "stop": {
            "$ref": "#/$defs/StopRef",
            "description": "开仓必须带止损(设计 §5.4 保护腿协议)"
          },
          "take_profits": {
            "type": "array",
            "maxItems": 4,
            "items": {
              "$ref": "#/$defs/TakeProfitSpec"
            }
          },
          "leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "margin_type": {
            "$ref": "common.json#/$defs/MarginType"
          },
          "thesis": {
            "type": "string",
            "maxLength": 2000
          },
          "evidence_refs": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            },
            "description": "必须 ⊆ 本轮/上一轮 evidence registry(设计 §7.3);用户手动单可为空数组"
          },
          "invalidation": {
            "type": "string",
            "maxLength": 1000
          }
        }
      },
      "CloseParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "pct",
          "order"
        ],
        "properties": {
          "kind": {
            "const": "close"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "pct": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "平掉当前持仓的百分比 (0,100];reduce-only,不得翻仓"
          },
          "order": {
            "$ref": "#/$defs/EntrySpec"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          },
          "evidence_refs": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            }
          }
        }
      },
      "CancelOrderParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "order_ref"
        ],
        "properties": {
          "kind": {
            "const": "cancel_order"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "order_ref": {
            "$ref": "#/$defs/OrderRef"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          }
        }
      },
      "ProtectParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "replace"
        ],
        "properties": {
          "kind": {
            "const": "protect"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "stop": {
            "$ref": "#/$defs/StopRef"
          },
          "take_profits": {
            "type": "array",
            "maxItems": 4,
            "items": {
              "$ref": "#/$defs/TakeProfitSpec"
            }
          },
          "replace": {
            "type": "boolean",
            "description": "true=撤掉本机已有保护腿后重挂;false=只补缺"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          }
        }
      },
      "TransferParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "asset",
          "amount",
          "from_account",
          "from_wallet",
          "to_account",
          "to_wallet"
        ],
        "properties": {
          "kind": {
            "const": "transfer"
          },
          "asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "amount": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "from_account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "from_wallet": {
            "$ref": "common.json#/$defs/Wallet"
          },
          "to_account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "to_wallet": {
            "$ref": "common.json#/$defs/Wallet"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          }
        },
        "description": "只允许 principal=user 且 surface=rpc;agent 没有任何划转工具(设计 §3.5)。提币不在 v1 契约内(§16 Q7,延后到 Jacky 拍板 + IP 白名单)。"
      }
    }
  },
  "plan": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/plan.json",
    "title": "ExecutableOrderPlan",
    "description": "审批前物化的可执行计划(设计 §5.1)。审批绑定的是 plan_hash = sha256(canonical_json(economic));basis 不进哈希。重闸只能拒绝,不能改 economic;经济字段实质变化 → 新 plan(version+1)+ 作废旧授权。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "plan_id",
      "intent_id",
      "version",
      "plan_hash",
      "account",
      "channel",
      "economic",
      "basis",
      "authorization_ttl_seconds",
      "created_at",
      "expires_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "version": {
        "type": "integer",
        "minimum": 1
      },
      "plan_hash": {
        "$ref": "common.json#/$defs/Hash256"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "economic": {
        "$ref": "#/$defs/PlanEconomics"
      },
      "basis": {
        "$ref": "#/$defs/PlanBasis"
      },
      "authorization_ttl_seconds": {
        "type": "integer",
        "minimum": 5,
        "maximum": 3600,
        "description": "授权有效期:市价 30s / 限价 120s(设计 §10.3)"
      },
      "created_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "expires_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      }
    },
    "$defs": {
      "PlanEconomics": {
        "oneOf": [
          {
            "$ref": "#/$defs/OrderEconomics"
          },
          {
            "$ref": "#/$defs/ProtectEconomics"
          },
          {
            "$ref": "#/$defs/CancelEconomics"
          },
          {
            "$ref": "#/$defs/TransferEconomics"
          }
        ]
      },
      "ProtectionLeg": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "order_type",
          "trigger_price",
          "working_type",
          "close_position"
        ],
        "properties": {
          "order_type": {
            "type": "string",
            "enum": [
              "stop_market",
              "stop_limit",
              "take_profit_market",
              "take_profit_limit"
            ]
          },
          "trigger_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "*_limit 类的委托价"
          },
          "qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "close_position=false 时必填;true 时不填(全平)"
          },
          "working_type": {
            "$ref": "common.json#/$defs/WorkingType"
          },
          "close_position": {
            "type": "boolean"
          }
        },
        "description": "交易所原生保护腿;永远 reduce-only(执行层强制,不作为字段)"
      },
      "Protection": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "take_profits"
        ],
        "properties": {
          "stop": {
            "$ref": "#/$defs/ProtectionLeg"
          },
          "take_profits": {
            "type": "array",
            "maxItems": 4,
            "items": {
              "$ref": "#/$defs/ProtectionLeg"
            }
          }
        }
      },
      "OrderEconomics": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "side",
          "position_side",
          "position_mode",
          "order_type",
          "qty",
          "reduce_only",
          "close_position",
          "protection",
          "max_naked_seconds"
        ],
        "properties": {
          "kind": {
            "const": "order"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "side": {
            "$ref": "common.json#/$defs/Side"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "position_mode": {
            "$ref": "common.json#/$defs/PositionMode"
          },
          "order_type": {
            "$ref": "common.json#/$defs/OrderType"
          },
          "qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "已按 step_size 向下取整"
          },
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "time_in_force": {
            "$ref": "common.json#/$defs/TimeInForce"
          },
          "reduce_only": {
            "type": "boolean"
          },
          "close_position": {
            "type": "boolean"
          },
          "leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "margin_type": {
            "$ref": "common.json#/$defs/MarginType"
          },
          "trigger_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "working_type": {
            "$ref": "common.json#/$defs/WorkingType"
          },
          "protection": {
            "$ref": "#/$defs/Protection"
          },
          "max_naked_seconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 600,
            "description": "首笔成交后保护腿必须在此秒数内确认在交易所,否则补偿平仓(设计 §5.4,默认 20)"
          }
        },
        "description": "open / close 两类 intent 的计划;close 时 reduce_only=true 且 protection 为空"
      },
      "ProtectEconomics": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "position_side",
          "legs",
          "replace_order_ids"
        ],
        "properties": {
          "kind": {
            "const": "protect"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "legs": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "items": {
              "$ref": "#/$defs/ProtectionLeg"
            }
          },
          "replace_order_ids": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            },
            "description": "先撤再挂的本机保护单 exchange_order_id 列表(replace=false 时为空)"
          }
        }
      },
      "CancelEconomics": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol"
        ],
        "anyOf": [
          {
            "required": [
              "exchange_order_id"
            ]
          },
          {
            "required": [
              "client_order_id"
            ]
          }
        ],
        "properties": {
          "kind": {
            "const": "cancel"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "exchange_order_id": {
            "type": "string",
            "maxLength": 64
          },
          "client_order_id": {
            "$ref": "common.json#/$defs/ClientOrderId"
          }
        }
      },
      "TransferEconomics": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "asset",
          "amount",
          "from_account",
          "from_wallet",
          "to_account",
          "to_wallet"
        ],
        "properties": {
          "kind": {
            "const": "transfer"
          },
          "asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "amount": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "from_account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "from_wallet": {
            "$ref": "common.json#/$defs/Wallet"
          },
          "to_account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "to_wallet": {
            "$ref": "common.json#/$defs/Wallet"
          }
        }
      },
      "SymbolFilters": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "tick_size",
          "step_size",
          "min_qty",
          "min_notional",
          "observed_at"
        ],
        "properties": {
          "tick_size": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "step_size": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "min_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "max_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "min_notional": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "price_precision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 18
          },
          "qty_precision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 18
          },
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "SizingBasis": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "method",
          "raw_qty",
          "rounding"
        ],
        "properties": {
          "method": {
            "type": "string",
            "enum": [
              "risk_pct_by_stop_distance",
              "explicit_qty",
              "explicit_notional",
              "pct_of_position"
            ]
          },
          "equity": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "risk_pct": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "stop_distance": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "reference_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "position_qty_before": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "raw_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "rounding": {
            "type": "string",
            "enum": [
              "down"
            ]
          }
        }
      },
      "MarketRef": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at"
        ],
        "properties": {
          "mark_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "last_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "PlanBasis": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "notes"
        ],
        "properties": {
          "filters": {
            "$ref": "#/$defs/SymbolFilters"
          },
          "sizing": {
            "$ref": "#/$defs/SizingBasis"
          },
          "account_version": {
            "$ref": "common.json#/$defs/Hash256",
            "description": "物化时的 AccountSnapshot.account_version;派发前变了要重闸"
          },
          "market_ref": {
            "$ref": "#/$defs/MarketRef"
          },
          "position_mode_observed": {
            "$ref": "common.json#/$defs/PositionMode"
          },
          "policy_version": {
            "type": "integer",
            "minimum": 0
          },
          "notes": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 500
            }
          }
        },
        "description": "物化依据,给 UI/审计看;不进 plan_hash"
      }
    }
  },
  "policy": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/policy.json",
    "title": "ExecPolicy",
    "description": "execd 持有的 policy 子集(设计 §10):模式、authority、上限。gateway 的 gate v2 与 execd 的重闸读同一份;改动需 policy.set + confirm 回填。金丝雀期默认值取 Codex 保守值(§17.2),向导里显式输入。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "version",
      "updated_at",
      "mode",
      "authority",
      "emergency_stop",
      "live_capped_enabled",
      "symbol_allowlist",
      "product_allowlist",
      "caps",
      "main_account",
      "canary"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "version": {
        "type": "integer",
        "minimum": 0
      },
      "updated_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "mode": {
        "$ref": "common.json#/$defs/PolicyMode"
      },
      "authority": {
        "$ref": "common.json#/$defs/Authority"
      },
      "emergency_stop": {
        "type": "boolean"
      },
      "live_capped_enabled": {
        "type": "boolean",
        "description": "feature gate;v1 保持 false,延后到 §16 Q6(Binance 对 standing authorization 的书面口径)解决"
      },
      "symbol_allowlist": {
        "type": "array",
        "items": {
          "$ref": "common.json#/$defs/Symbol"
        }
      },
      "product_allowlist": {
        "type": "array",
        "items": {
          "$ref": "common.json#/$defs/Product"
        }
      },
      "caps": {
        "$ref": "#/$defs/Caps"
      },
      "main_account": {
        "$ref": "#/$defs/MainAccountPolicy"
      },
      "canary": {
        "$ref": "#/$defs/CanaryPolicy"
      }
    },
    "$defs": {
      "Caps": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "max_leverage",
          "risk_pct_per_trade",
          "max_order_notional",
          "max_position_notional",
          "max_daily_opens",
          "daily_loss_stop_pct",
          "symbol_cooldown_seconds",
          "max_naked_seconds",
          "account_truth_max_age_ms",
          "market_max_age_ms",
          "authorization_ttl_market_seconds",
          "authorization_ttl_limit_seconds",
          "max_price_deviation_bps",
          "ntp_drift_block_ms",
          "ntp_drift_halt_ms"
        ],
        "properties": {
          "max_leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "risk_pct_per_trade": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "单笔风险占权益百分比,金丝雀默认 0.25"
          },
          "max_order_notional": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "max_position_notional": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "max_daily_opens": {
            "type": "integer",
            "minimum": 0,
            "description": "金丝雀期默认 2,之后 6"
          },
          "daily_loss_stop_pct": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "默认 1"
          },
          "symbol_cooldown_seconds": {
            "type": "integer",
            "minimum": 0,
            "description": "默认 3600"
          },
          "max_naked_seconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 600,
            "description": "默认 20"
          },
          "account_truth_max_age_ms": {
            "type": "integer",
            "minimum": 1000,
            "description": "默认 15000"
          },
          "market_max_age_ms": {
            "type": "integer",
            "minimum": 500,
            "description": "默认 5000"
          },
          "authorization_ttl_market_seconds": {
            "type": "integer",
            "minimum": 5,
            "maximum": 3600,
            "description": "默认 30"
          },
          "authorization_ttl_limit_seconds": {
            "type": "integer",
            "minimum": 5,
            "maximum": 3600,
            "description": "默认 120"
          },
          "max_price_deviation_bps": {
            "type": "integer",
            "minimum": 0,
            "maximum": 10000,
            "description": "下单价 vs 现价偏离上限"
          },
          "ntp_drift_block_ms": {
            "type": "integer",
            "minimum": 0,
            "description": "默认 2000:超过禁新增风险"
          },
          "ntp_drift_halt_ms": {
            "type": "integer",
            "minimum": 0,
            "description": "默认 10000:超过 HALT"
          }
        }
      },
      "MainAccountPolicy": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "manual_trading_enabled",
          "transfers_enabled",
          "withdraw_enabled"
        ],
        "properties": {
          "manual_trading_enabled": {
            "type": "boolean"
          },
          "transfers_enabled": {
            "type": "boolean",
            "description": "main↔sub 划转(A1 验证可行后才开)"
          },
          "withdraw_enabled": {
            "type": "boolean",
            "const": false,
            "description": "v1 恒 false(§16 Q7 默认不勾提币;提币走 Binance UI 深链)"
          }
        }
      },
      "CanaryPolicy": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "enabled"
        ],
        "properties": {
          "enabled": {
            "type": "boolean"
          },
          "max_loss_quote": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "§16 Q2,未答前为空 = 不允许真钱"
          },
          "max_notional_quote": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "max_leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "funded_balance_quote": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          }
        }
      }
    }
  },
  "position_effect": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/position_effect.json",
    "title": "PositionEffect",
    "description": "intent 的经济完成定义(设计 §5.1):开仓=目标数量成交且剩余已撤且保护腿已确认在交易所;平仓=数量核实;保护=腿存在;撤单=订单终态;划转=交易所回执可查。由 reconciler 按读派生并落库,intent 只在 status=satisfied 时才 completed。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "effect_id",
      "intent_id",
      "plan_id",
      "kind",
      "account",
      "status",
      "filled_qty",
      "remaining_qty",
      "remaining_canceled",
      "protection_required",
      "protection_confirmed",
      "protection_order_ids",
      "evaluated_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "effect_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "kind": {
        "$ref": "common.json#/$defs/IntentKind"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "symbol": {
        "$ref": "common.json#/$defs/Symbol"
      },
      "status": {
        "$ref": "common.json#/$defs/EffectStatus"
      },
      "target_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "filled_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "remaining_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "remaining_canceled": {
        "type": "boolean",
        "description": "未成交部分是否已确认撤销(或本就无剩余)"
      },
      "avg_fill_price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "first_fill_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "protection_required": {
        "type": "boolean"
      },
      "protection_confirmed": {
        "type": "boolean"
      },
      "protection_confirmed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "protection_order_ids": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 64
        }
      },
      "naked_seconds": {
        "type": "integer",
        "minimum": 0,
        "description": "首笔成交到保护腿确认(或到现在)的秒数"
      },
      "compensation_close_attempt_id": {
        "$ref": "common.json#/$defs/Uuid",
        "description": "超过 max_naked_seconds 触发的补偿平仓 attempt"
      },
      "position_qty_after": {
        "$ref": "common.json#/$defs/Decimal"
      },
      "exchange_ref": {
        "type": "string",
        "maxLength": 128
      },
      "failure_reason": {
        "type": "string",
        "maxLength": 1000
      },
      "evaluated_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      }
    }
  },
  "research-backtest": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.local/schema/research-backtest.json",
    "title": "ResearchBacktest",
    "anyOf": [
      {
        "$ref": "#/$defs/BacktestReport"
      },
      {
        "$ref": "#/$defs/BacktestReportSummary"
      }
    ],
    "$defs": {
      "BacktestSegmentName": {
        "enum": [
          "in_sample",
          "out_of_sample"
        ]
      },
      "BacktestMetrics": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "total_return": {
            "type": "number",
            "description": "窗口总收益,小数"
          },
          "cagr": {
            "type": [
              "number",
              "null"
            ],
            "description": "年化复合收益(365 天),窗口<30 天为 null"
          },
          "max_drawdown": {
            "type": "number",
            "description": "最大回撤,正数小数"
          },
          "sharpe": {
            "type": [
              "number",
              "null"
            ],
            "description": "日收益 Sharpe×√365,rf=0;日收益<30 为 null"
          },
          "sortino": {
            "type": [
              "number",
              "null"
            ],
            "description": "下行偏差 sqrt(Σmin(r,0)²/N) 口径"
          },
          "calmar": {
            "type": [
              "number",
              "null"
            ],
            "description": "cagr / max_drawdown"
          },
          "volatility": {
            "type": [
              "number",
              "null"
            ],
            "description": "日收益标准差×√365"
          },
          "win_rate": {
            "type": [
              "number",
              "null"
            ],
            "description": "已平仓位胜率"
          },
          "profit_factor": {
            "type": [
              "number",
              "null"
            ],
            "description": "盈利合计/|亏损合计|,无亏损为 null"
          },
          "avg_win": {
            "type": [
              "number",
              "null"
            ],
            "description": "盈利仓位平均单笔收益(净盈亏/入场名义),小数"
          },
          "avg_loss": {
            "type": [
              "number",
              "null"
            ],
            "description": "亏损仓位平均单笔收益,负数小数"
          },
          "risk_reward": {
            "type": [
              "number",
              "null"
            ],
            "description": "avg_win/|avg_loss|"
          },
          "expectancy": {
            "type": [
              "number",
              "null"
            ],
            "description": "全部仓位平均单笔收益,小数"
          },
          "max_win_streak": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "max_loss_streak": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "time_in_drawdown": {
            "type": "number",
            "description": "净值低于前高的时间占比"
          },
          "max_drawdown_duration_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "前高到收复(或窗口末)的最长时长"
          },
          "trades": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "已平仓位数(同一仓位多次减仓合并)"
          },
          "exposure": {
            "type": "number",
            "description": "持仓市值/净值 的逐根均值"
          },
          "avg_holding_ms": {
            "type": [
              "number",
              "null"
            ],
            "description": "平均持仓时长"
          },
          "best_trade": {
            "type": [
              "number",
              "null"
            ],
            "description": "最好单笔收益,小数"
          },
          "worst_trade": {
            "type": [
              "number",
              "null"
            ],
            "description": "最差单笔收益,小数"
          },
          "net_pnl": {
            "type": "number",
            "description": "净盈亏,报价币(USDT)"
          },
          "fees": {
            "type": "number",
            "description": "实付手续费,报价币"
          },
          "benchmark_return": {
            "type": [
              "number",
              "null"
            ],
            "description": "同窗口买入持有收益(含同样费用与滑点)"
          },
          "excess_return": {
            "type": [
              "number",
              "null"
            ],
            "description": "total_return - benchmark_return"
          },
          "alpha": {
            "type": [
              "number",
              "null"
            ],
            "description": "对基准日收益 OLS 截距×365"
          },
          "beta": {
            "type": [
              "number",
              "null"
            ],
            "description": "对基准日收益 OLS 斜率"
          },
          "time_in_market": {
            "type": "number",
            "description": "有持仓的 bar 占比"
          }
        },
        "required": [
          "total_return",
          "cagr",
          "max_drawdown",
          "sharpe",
          "sortino",
          "calmar",
          "volatility",
          "win_rate",
          "profit_factor",
          "avg_win",
          "avg_loss",
          "risk_reward",
          "expectancy",
          "max_win_streak",
          "max_loss_streak",
          "time_in_drawdown",
          "max_drawdown_duration_ms",
          "trades",
          "exposure",
          "time_in_market",
          "avg_holding_ms",
          "best_trade",
          "worst_trade",
          "net_pnl",
          "fees",
          "benchmark_return",
          "excess_return",
          "alpha",
          "beta"
        ]
      },
      "BacktestEquityPoint": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "equity": {
            "type": "number"
          },
          "pnl_pct": {
            "type": "number"
          },
          "drawdown": {
            "type": "number"
          },
          "benchmark_pct": {
            "type": [
              "number",
              "null"
            ]
          },
          "exposure": {
            "type": "number"
          }
        },
        "required": [
          "at",
          "equity",
          "pnl_pct",
          "drawdown",
          "benchmark_pct",
          "exposure"
        ]
      },
      "BacktestTrade": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 4000
          },
          "symbol": {
            "type": "string",
            "maxLength": 4000
          },
          "side": {
            "enum": [
              "long",
              "short"
            ]
          },
          "entry_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "entry_price": {
            "type": "number"
          },
          "exit_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "exit_price": {
            "type": "number"
          },
          "qty": {
            "type": "number"
          },
          "pnl": {
            "type": "number"
          },
          "return_pct": {
            "type": "number"
          },
          "fees": {
            "type": "number"
          },
          "bars_held": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "exit_reason": {
            "type": "string",
            "maxLength": 4000
          },
          "segment": {
            "$ref": "#/$defs/BacktestSegmentName"
          }
        },
        "required": [
          "id",
          "symbol",
          "side",
          "entry_at",
          "entry_price",
          "exit_at",
          "exit_price",
          "qty",
          "pnl",
          "return_pct",
          "fees",
          "bars_held",
          "exit_reason",
          "segment"
        ]
      },
      "BacktestSegment": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "name": {
            "$ref": "#/$defs/BacktestSegmentName"
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "name",
          "from_ms",
          "to_ms"
        ]
      },
      "BacktestSegmentMetrics": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "name": {
            "$ref": "#/$defs/BacktestSegmentName"
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "metrics": {
            "$ref": "#/$defs/BacktestMetrics"
          }
        },
        "required": [
          "name",
          "from_ms",
          "to_ms",
          "metrics"
        ]
      },
      "BacktestPeriodReturn": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "period": {
            "type": "string",
            "maxLength": 16
          },
          "return": {
            "type": "number"
          },
          "benchmark": {
            "type": [
              "number",
              "null"
            ]
          }
        },
        "required": [
          "period",
          "return",
          "benchmark"
        ]
      },
      "BacktestTradeStats": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "exit_reasons": {
            "type": "object",
            "additionalProperties": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "holding_histogram": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "bins": {
                "type": "array",
                "items": {
                  "type": "number"
                },
                "maxItems": 64
              },
              "counts": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "maxItems": 64
              }
            },
            "required": [
              "bins",
              "counts"
            ]
          },
          "return_histogram": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "bins": {
                "type": "array",
                "items": {
                  "type": "number"
                },
                "maxItems": 64
              },
              "counts": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "maxItems": 64
              }
            },
            "required": [
              "bins",
              "counts"
            ]
          },
          "long_trades": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "short_trades": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "pnl_by_exit_reason": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/BacktestExitReasonPnl"
            }
          }
        },
        "required": [
          "exit_reasons",
          "holding_histogram",
          "return_histogram",
          "long_trades",
          "short_trades"
        ]
      },
      "BacktestDataProvenance": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "source": {
            "type": "string",
            "maxLength": 4000
          },
          "first_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "last_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "bars": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "timeframe": {
            "type": "string",
            "maxLength": 4000
          },
          "dataset_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000,
            "description": "research_datasets 里保存的整段 K 线(含预热),回放 candles 从这里取"
          },
          "snapshot_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000,
            "description": "研究 loop 价格快照 id(如果来自 loop)"
          },
          "warmup_bars": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "warmup_borrowed": {
            "type": "boolean",
            "description": "预热是否向窗口之前的数据借"
          },
          "trading_from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "market": {
            "$ref": "research-orders.json#/$defs/OrderMarket",
            "description": "数据市场;缺省 spot"
          },
          "perp": {
            "anyOf": [
              {
                "$ref": "#/$defs/BacktestPerpProvenance"
              },
              {
                "type": "null"
              }
            ],
            "description": "market=perp 时的永续溯源"
          }
        },
        "required": [
          "source",
          "first_at",
          "last_at",
          "bars",
          "timeframe",
          "dataset_id",
          "snapshot_id",
          "warmup_bars",
          "warmup_borrowed",
          "trading_from_ms"
        ]
      },
      "BacktestAssetKind": {
        "enum": [
          "single",
          "basket"
        ]
      },
      "BacktestAssetStatus": {
        "enum": [
          "completed",
          "failed",
          "data_missing"
        ]
      },
      "BacktestAsset": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "key": {
            "type": "string",
            "maxLength": 4000
          },
          "label": {
            "type": "string",
            "maxLength": 4000
          },
          "kind": {
            "$ref": "#/$defs/BacktestAssetKind"
          },
          "symbols": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 4000
            },
            "maxItems": 16
          },
          "status": {
            "$ref": "#/$defs/BacktestAssetStatus"
          },
          "error": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "metrics": {
            "anyOf": [
              {
                "$ref": "#/$defs/BacktestMetrics"
              },
              {
                "type": "null"
              }
            ]
          },
          "segments": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestSegmentMetrics"
            },
            "maxItems": 8
          },
          "equity": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestEquityPoint"
            },
            "maxItems": 5000
          },
          "trades": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestTrade"
            },
            "maxItems": 20000
          },
          "monthly_returns": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestPeriodReturn"
            },
            "maxItems": 2000
          },
          "yearly_returns": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestPeriodReturn"
            },
            "maxItems": 200
          },
          "trade_stats": {
            "anyOf": [
              {
                "$ref": "#/$defs/BacktestTradeStats"
              },
              {
                "type": "null"
              }
            ]
          },
          "data": {
            "anyOf": [
              {
                "$ref": "#/$defs/BacktestDataProvenance"
              },
              {
                "type": "null"
              }
            ]
          },
          "window": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "from_ms": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "to_ms": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "from_ms",
                  "to_ms"
                ]
              },
              {
                "type": "null"
              }
            ],
            "description": "该资产的交易窗口(预热之后的首根决策 bar 收盘 → 最后一根已收盘 bar)"
          },
          "plans": {
            "type": "array",
            "items": {
              "$ref": "research-orders.json#/$defs/BacktestPlan"
            },
            "maxItems": 20000,
            "description": "订单周期执行核(WP-F)产出的订单计划;默认执行器不产出"
          },
          "plan_stats": {
            "anyOf": [
              {
                "$ref": "research-orders.json#/$defs/BacktestPlanStats"
              },
              {
                "type": "null"
              }
            ]
          },
          "engine_version": {
            "type": "string",
            "maxLength": 4000,
            "description": "该资产执行器的口径版本"
          },
          "side_breakdown": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "long": {
                "$ref": "#/$defs/BacktestSideStats"
              },
              "short": {
                "$ref": "#/$defs/BacktestSideStats"
              }
            },
            "required": [
              "long",
              "short"
            ]
          },
          "per_symbol": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestSymbolContribution"
            },
            "maxItems": 16
          },
          "daily_pnl": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestDailyPnl"
            },
            "maxItems": 3000,
            "description": "UTC 日净值收益(最近 ≤3000 天)"
          },
          "capital_usage": {
            "anyOf": [
              {
                "$ref": "#/$defs/BacktestCapitalUsage"
              },
              {
                "type": "null"
              }
            ]
          },
          "strategy_capacity": {
            "anyOf": [
              {
                "$ref": "#/$defs/BacktestCapacity"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "key",
          "label",
          "kind",
          "symbols",
          "status",
          "error",
          "metrics",
          "segments",
          "equity",
          "trades",
          "monthly_returns",
          "yearly_returns",
          "trade_stats",
          "data"
        ]
      },
      "BacktestScoreLabel": {
        "enum": [
          "excellent",
          "good",
          "fair",
          "needs_work",
          "poor"
        ]
      },
      "BacktestConfidence": {
        "enum": [
          "low",
          "medium",
          "high"
        ]
      },
      "BacktestScoreComponent": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "key": {
            "type": "string",
            "maxLength": 4000
          },
          "value": {
            "type": "number"
          },
          "weight": {
            "type": "number"
          },
          "note": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "required": [
          "key",
          "value",
          "weight",
          "note"
        ]
      },
      "BacktestScore": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "value": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100
          },
          "label": {
            "$ref": "#/$defs/BacktestScoreLabel"
          },
          "confidence": {
            "$ref": "#/$defs/BacktestConfidence"
          },
          "confidence_reason": {
            "type": "string",
            "maxLength": 4000
          },
          "components": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestScoreComponent"
            },
            "maxItems": 16
          }
        },
        "required": [
          "value",
          "label",
          "confidence",
          "confidence_reason",
          "components"
        ]
      },
      "BacktestExecution": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "initial_cash": {
            "type": "number"
          },
          "fee_rate": {
            "type": "number"
          },
          "slippage_bps": {
            "type": "number"
          },
          "sizing_mode": {
            "type": "string",
            "maxLength": 4000
          },
          "fill_model": {
            "type": "string",
            "maxLength": 4000
          },
          "basket_weighting": {
            "type": "string",
            "maxLength": 4000
          },
          "market": {
            "$ref": "research-orders.json#/$defs/OrderMarket"
          },
          "leverage": {
            "type": "number",
            "minimum": 0
          },
          "view_bars": {
            "type": "string",
            "maxLength": 4000,
            "description": "每根决策可见的历史长度口径"
          }
        },
        "required": [
          "initial_cash",
          "fee_rate",
          "slippage_bps",
          "sizing_mode",
          "fill_model",
          "basket_weighting",
          "market",
          "leverage"
        ]
      },
      "BacktestReport": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 4000
          },
          "created_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "engine_version": {
            "type": "string",
            "maxLength": 4000
          },
          "title": {
            "type": "string",
            "maxLength": 4000
          },
          "description": {
            "type": "string",
            "maxLength": 4000
          },
          "strategy_ir_hash": {
            "type": "string",
            "maxLength": 4000
          },
          "strategy_ir": {
            "$ref": "research.json#/$defs/StrategyIR"
          },
          "timeframe": {
            "type": "string",
            "maxLength": 4000
          },
          "window": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "from_ms": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "to_ms": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "from_ms",
              "to_ms"
            ]
          },
          "segments": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestSegment"
            },
            "maxItems": 8
          },
          "execution": {
            "$ref": "#/$defs/BacktestExecution"
          },
          "primary_key": {
            "type": "string",
            "maxLength": 4000
          },
          "assets": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestAsset"
            },
            "maxItems": 16
          },
          "score": {
            "$ref": "#/$defs/BacktestScore"
          },
          "run_ids": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 4000
            },
            "maxItems": 32
          },
          "inquiry_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "session_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "strategy_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "strategy_version": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "warnings": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 4000
            },
            "maxItems": 64
          }
        },
        "required": [
          "id",
          "created_at",
          "engine_version",
          "title",
          "description",
          "strategy_ir_hash",
          "strategy_ir",
          "timeframe",
          "window",
          "segments",
          "execution",
          "primary_key",
          "assets",
          "score",
          "run_ids",
          "inquiry_id",
          "session_id",
          "strategy_id",
          "strategy_version",
          "warnings"
        ]
      },
      "BacktestReportSummary": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 4000
          },
          "created_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "title": {
            "type": "string",
            "maxLength": 4000
          },
          "timeframe": {
            "type": "string",
            "maxLength": 4000
          },
          "primary_key": {
            "type": "string",
            "maxLength": 4000
          },
          "strategy_ir_hash": {
            "type": "string",
            "maxLength": 4000
          },
          "strategy_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "strategy_version": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "score": {
            "$ref": "#/$defs/BacktestScore"
          },
          "metrics": {
            "anyOf": [
              {
                "$ref": "#/$defs/BacktestMetrics"
              },
              {
                "type": "null"
              }
            ]
          },
          "sparkline": {
            "type": "array",
            "items": {
              "type": "number"
            },
            "maxItems": 200
          }
        },
        "required": [
          "id",
          "created_at",
          "title",
          "timeframe",
          "primary_key",
          "strategy_ir_hash",
          "strategy_id",
          "strategy_version",
          "score",
          "metrics",
          "sparkline"
        ]
      },
      "BacktestSideStats": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "trades": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "total_pnl": {
            "type": "number",
            "description": "报价币"
          },
          "win_rate": {
            "type": [
              "number",
              "null"
            ]
          },
          "avg_return": {
            "type": [
              "number",
              "null"
            ],
            "description": "平均单笔收益,小数"
          }
        },
        "required": [
          "trades",
          "total_pnl",
          "win_rate",
          "avg_return"
        ]
      },
      "BacktestExitReasonPnl": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "count": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "pnl": {
            "type": "number",
            "description": "该退出原因的净盈亏合计,报价币"
          },
          "avg_return": {
            "type": [
              "number",
              "null"
            ]
          }
        },
        "required": [
          "count",
          "pnl",
          "avg_return"
        ]
      },
      "BacktestSymbolContribution": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "symbol": {
            "type": "string",
            "maxLength": 4000
          },
          "trades": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "pnl": {
            "type": "number",
            "description": "该腿净值变化(含期末未平仓盯市),报价币"
          },
          "win_rate": {
            "type": [
              "number",
              "null"
            ]
          },
          "contribution": {
            "type": "number",
            "description": "pnl / 篮子初始资金;各腿之和 = 篮子 total_return"
          }
        },
        "required": [
          "symbol",
          "trades",
          "pnl",
          "win_rate",
          "contribution"
        ]
      },
      "BacktestDailyPnl": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "day": {
            "type": "string",
            "maxLength": 10
          },
          "pnl_pct": {
            "type": "number"
          }
        },
        "required": [
          "day",
          "pnl_pct"
        ]
      },
      "BacktestCapitalUsage": {
        "type": "object",
        "additionalProperties": false,
        "description": "资金使用:avg/max_exposure = 持仓市值/净值;time_in_market = 有持仓的 bar 占比;avg_concurrent_positions = 逐根同时持仓数均值;idle_fraction = 没有任何持仓的 bar 占比",
        "properties": {
          "avg_exposure": {
            "type": "number"
          },
          "max_exposure": {
            "type": "number"
          },
          "time_in_market": {
            "type": "number"
          },
          "avg_concurrent_positions": {
            "type": "number"
          },
          "idle_fraction": {
            "type": "number"
          }
        },
        "required": [
          "avg_exposure",
          "max_exposure",
          "time_in_market",
          "avg_concurrent_positions",
          "idle_fraction"
        ]
      },
      "BacktestCapacity": {
        "type": "object",
        "additionalProperties": false,
        "description": "策略容量粗估:单笔入场名义不超过窗口内 bar 成交额中位数 × 参与率 ⇒ 可容纳资金 ≈ 中位成交额 × 参与率 / 平均单笔入场占净值比例",
        "properties": {
          "capacity_usd": {
            "type": [
              "number",
              "null"
            ]
          },
          "participation_rate": {
            "type": "number"
          },
          "median_bar_quote_volume": {
            "type": [
              "number",
              "null"
            ]
          },
          "avg_entry_fraction": {
            "type": [
              "number",
              "null"
            ]
          },
          "method": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "required": [
          "capacity_usd",
          "participation_rate",
          "median_bar_quote_volume",
          "avg_entry_fraction",
          "method"
        ]
      },
      "BacktestFundingSegment": {
        "type": "object",
        "additionalProperties": false,
        "description": "资金费序列里连续同源的一段",
        "properties": {
          "source": {
            "enum": [
              "okx_archive",
              "okx_rest",
              "binance_proxy"
            ],
            "description": "okx_archive=OKX 月度归档(UTC+8 月);okx_rest=OKX 资金费 REST(近约 3 个月);binance_proxy=币安 U 本位同名合约代理(OKX 官方覆盖不到的时段)"
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "points": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "source",
          "from_ms",
          "to_ms",
          "points"
        ]
      },
      "BacktestPerpProvenance": {
        "type": "object",
        "additionalProperties": false,
        "description": "永续回测的数据溯源(WP-F):成交价/标记价 K 线覆盖、资金费分界与重叠期偏差、维持保证金分档",
        "properties": {
          "instrument": {
            "type": "string",
            "maxLength": 200,
            "description": "OKX instId,如 BTC-USDT-SWAP"
          },
          "source": {
            "type": "string",
            "maxLength": 4000
          },
          "mark_coverage": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "from_ms": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "to_ms": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "from_ms",
                  "to_ms"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "mark_missing_bars": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "没有标记价的根数(强平退回成交价)"
          },
          "funding_coverage": {
            "enum": [
              "complete",
              "partial",
              "missing"
            ]
          },
          "funding_note": {
            "type": "string",
            "maxLength": 4000,
            "description": "资金费来源分界的一句话(哪段 OKX 官方 / OKX 归档 / 币安代理)"
          },
          "funding_segments": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestFundingSegment"
            },
            "maxItems": 200
          },
          "funding_gaps": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "from_ms": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "to_ms": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "from_ms",
                "to_ms"
              ]
            },
            "maxItems": 200
          },
          "proxy_until_ms": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "币安代理用到哪一期(null=没用代理)"
          },
          "deviation_note": {
            "type": "string",
            "maxLength": 4000,
            "description": "OKX 与币安同期资金费对照(相关、平均差、累计差)"
          },
          "max_lever": {
            "type": [
              "number",
              "null"
            ]
          },
          "maintenance_margin": {
            "type": "string",
            "maxLength": 4000,
            "description": "维持保证金分档口径(当前值,不是历史值)"
          },
          "flags": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 200
            },
            "maxItems": 50
          },
          "notes": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 4000
            },
            "maxItems": 50
          }
        },
        "required": [
          "instrument",
          "source",
          "mark_coverage",
          "mark_missing_bars",
          "funding_coverage",
          "funding_note",
          "funding_segments",
          "proxy_until_ms",
          "deviation_note",
          "max_lever",
          "maintenance_margin",
          "flags",
          "notes"
        ]
      }
    }
  },
  "research-batch": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.local/schema/research-batch.json",
    "title": "ResearchBatchPortfolioPrimitive",
    "description": "批量策略研究(docs/research/batch-study-2026-09-23.md)用的组合级原语:横截面动量调仓(portfolio_xsmom)、永续资金费套利两腿(portfolio_carry)。它们作用在资产池上,不是单资产 StrategyIR 的一段,所以不进 research.json 的原语表;实现见 packages/gateway/src/demo/research/primitives/portfolio-*.ts。",
    "anyOf": [
      {
        "$ref": "#/$defs/PortfolioXsmomNode"
      },
      {
        "$ref": "#/$defs/PortfolioCarryNode"
      }
    ],
    "$defs": {
      "PortfolioXsmomNode": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "primitive": {
            "const": "portfolio_xsmom"
          },
          "params": {
            "$ref": "#/$defs/PortfolioXsmomParams"
          }
        },
        "required": [
          "primitive",
          "params"
        ]
      },
      "PortfolioCarryNode": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "primitive": {
            "const": "portfolio_carry"
          },
          "params": {
            "$ref": "#/$defs/PortfolioCarryParams"
          }
        },
        "required": [
          "primitive",
          "params"
        ]
      },
      "PortfolioXsmomParams": {
        "type": "object",
        "additionalProperties": false,
        "description": "横截面动量:每个调仓时刻按过去 lookback_days 天收益给资产池排名,等权持有前 top_k(long_short 时另做空后 top_k,多空各占一半权益);调仓时刻收盘排名、下一根开盘成交,成本按换手额 ×(手续费 + 滑点)。只用调仓时刻及以前已收盘的 K 线。",
        "properties": {
          "lookback_days": {
            "type": "integer",
            "minimum": 1,
            "maximum": 365,
            "description": "排名用的回看天数(按日历时间,取正好 lookback_days 天前那根收盘)"
          },
          "top_k": {
            "type": "integer",
            "minimum": 1,
            "maximum": 30,
            "description": "持有名数;可排名资产不足时按实际数"
          },
          "rebalance": {
            "enum": [
              "weekly",
              "daily"
            ],
            "description": "weekly = 每周一 00:00 UTC 开盘调仓(周日最后一根收盘排名);daily = 每个 UTC 日开盘调仓"
          },
          "abs_filter": {
            "type": "boolean",
            "description": "绝对动量过滤:回看收益 ≤ 0 的名额留现金(做空一侧对称:回看收益 ≥ 0 的不做空)。缺省 false"
          },
          "side": {
            "enum": [
              "long_only",
              "long_short"
            ],
            "description": "long_only(现货)/ long_short(永续:多前 top_k、空后 top_k,计资金费)。缺省 long_only"
          },
          "select": {
            "enum": [
              "momentum",
              "random"
            ],
            "description": "random = 随机入场基线:同调仓时刻、同名数,随机挑资产(固定种子)。缺省 momentum"
          },
          "seed": {
            "type": "integer",
            "minimum": 0,
            "description": "select=random 时的种子"
          }
        },
        "required": [
          "lookback_days",
          "top_k",
          "rebalance"
        ]
      },
      "PortfolioCarryParams": {
        "type": "object",
        "additionalProperties": false,
        "description": "永续资金费套利(最小可用版):每个资产现货多 + 永续空等名义,资金 50/50 分给现货与永续保证金(1 倍);每个资金费结算时刻看最近 window 期(按 8h 等效折算)平均费率,高于 min_rate 就持有、否则空仓;进出场各付两腿吃单费 + 滑点;持仓中两腿名义偏离权益一半超过 rebalance_band 就调回;收益 = 收到的资金费 + 基差变化 − 成本。",
        "properties": {
          "window": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500,
            "description": "平均的资金费期数(含当期刚结算的一期)"
          },
          "min_rate": {
            "type": "number",
            "minimum": -0.01,
            "maximum": 0.01,
            "description": "8h 等效费率门槛(小数,0.0001 = 1bp/8h ≈ 年化 11%);严格大于才持有"
          },
          "spot_fee_rate": {
            "type": "number",
            "minimum": 0,
            "maximum": 0.01,
            "description": "现货吃单费率,缺省 0.001"
          },
          "perp_fee_rate": {
            "type": "number",
            "minimum": 0,
            "maximum": 0.01,
            "description": "永续吃单费率,缺省 0.0005"
          },
          "slippage_bps": {
            "type": "number",
            "minimum": 0,
            "maximum": 100,
            "description": "每腿每次成交的不利滑点,缺省 5"
          },
          "rebalance_band": {
            "type": "number",
            "minimum": 0.01,
            "maximum": 1,
            "description": "持仓期间两腿名义偏离「权益的一半」超过这个比例就调回(按吃单费 + 滑点计成本),缺省 0.2;等价于把现货浮盈划给永续保证金,1 倍空头不会被强平"
          }
        },
        "required": [
          "window",
          "min_rate"
        ]
      }
    }
  },
  "research-binding": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.local/schema/research-binding.json",
    "title": "ResearchStrategyBinding",
    "description": "§9.47 StrategyBinding:研究台策略版本(StrategyIR,唯一真源)编译出来的实盘绑定(只读编译产物)。字段对齐 docs/design/strategy-apply-spec-2026-09-23.md §3 与 Codex 复审修订;实盘侧(radar / 候选生成 / holding-policy / gates)按这些字段消费,字段名保持稳定。部署模式、仓位 cap 不在这里(属于部署,由实盘注册表管)。",
    "anyOf": [
      {
        "$ref": "#/$defs/StrategyBindingResponse"
      },
      {
        "$ref": "#/$defs/BuiltinImportResult"
      }
    ],
    "$defs": {
      "BindingExecutor": {
        "description": "这条规则由谁执行:code = 代码逐根算/挂单/改单,不叫模型;model = 模型判断(只在 judge 切片出现,且只决定做/不做)",
        "enum": [
          "code",
          "model"
        ]
      },
      "BindingRole": {
        "description": "规则拆给哪个角色:radar 唤醒 / judge 入场过滤(模型)/ geometry 止损止盈放置 / risk 仓位与杠杆 / holding 持仓管理 / execution 下单方式",
        "enum": [
          "radar",
          "judge",
          "geometry",
          "risk",
          "holding",
          "execution"
        ]
      },
      "BindingRule": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "text": {
            "type": "string",
            "maxLength": 4000
          },
          "executor": {
            "$ref": "#/$defs/BindingExecutor"
          },
          "ref": {
            "description": "来自 IR 的哪个位置(如 signal[0]、order.entry.price、risk.stop);编译器补的缺省规则为 null",
            "type": [
              "string",
              "null"
            ],
            "maxLength": 200
          },
          "primitive": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          }
        },
        "required": [
          "text",
          "executor",
          "ref",
          "primitive"
        ]
      },
      "BindingRoleSlice": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "role": {
            "$ref": "#/$defs/BindingRole"
          },
          "title": {
            "type": "string",
            "maxLength": 200
          },
          "summary": {
            "type": "string",
            "maxLength": 2000
          },
          "rules": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BindingRule"
            },
            "maxItems": 60
          }
        },
        "required": [
          "role",
          "title",
          "summary",
          "rules"
        ]
      },
      "BindingUnmapped": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "code": {
            "type": "string",
            "maxLength": 120
          },
          "path": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 200
          },
          "severity": {
            "description": "block = 编译失败、不能下发(不近似);warn = 能下发,但语义有损或需要实盘侧补能力",
            "enum": [
              "block",
              "warn"
            ]
          },
          "message": {
            "type": "string",
            "maxLength": 2000
          },
          "source": {
            "description": "compiler = IR 里实盘不支持的原语/字段;import = 内置策略译成 IR 时丢掉的原规则语义",
            "enum": [
              "compiler",
              "import"
            ]
          }
        },
        "required": [
          "code",
          "path",
          "severity",
          "message",
          "source"
        ]
      },
      "BindingEvidenceIndicator": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "description": "规范化 id:<indicator>(<args>)[.<output>]@<timeframe>,同一条线去重",
            "type": "string",
            "maxLength": 200
          },
          "indicator": {
            "type": "string",
            "maxLength": 40
          },
          "args": {
            "type": "object",
            "additionalProperties": {
              "type": "number"
            }
          },
          "output": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 40
          },
          "timeframe": {
            "type": "string",
            "maxLength": 16
          },
          "from": {
            "description": "由哪些 IR 位置推导出来",
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 200
            },
            "maxItems": 30
          }
        },
        "required": [
          "id",
          "indicator",
          "args",
          "output",
          "timeframe",
          "from"
        ]
      },
      "BindingEvidencePlan": {
        "description": "模型做入场过滤时看的证据:全部由 IR 原语的输入推导,不手填",
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "indicators": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BindingEvidenceIndicator"
            },
            "maxItems": 60
          },
          "structure": {
            "description": "结构证据:swing_pivots / order_blocks / htf_structure@<tf> / volume_ratio 等",
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 80
            },
            "maxItems": 30
          },
          "info_topics": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 40
            },
            "maxItems": 12
          }
        },
        "required": [
          "indicators",
          "structure",
          "info_topics"
        ]
      },
      "BindingTarget": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "source": {
            "$ref": "research.json#/$defs/StrategyPrimitive"
          },
          "size_pct": {
            "type": "number",
            "exclusiveMinimum": 0,
            "maximum": 1
          },
          "kind": {
            "description": "chart = 图上价位(前高/摆动高点/结构阻力);indicator = 用户指定的指标线;r_multiple = 用户原话要求的 R 倍数",
            "enum": [
              "chart",
              "indicator",
              "r_multiple"
            ]
          }
        },
        "required": [
          "source",
          "size_pct",
          "kind"
        ]
      },
      "StrategyBinding": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "schema_version": {
            "const": "strategy-binding/v1"
          },
          "compiler_version": {
            "type": "string",
            "maxLength": 80
          },
          "strategy_id": {
            "type": "string",
            "maxLength": 4000
          },
          "version": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "ir_hash": {
            "type": "string",
            "maxLength": 200
          },
          "content_hash": {
            "description": "绑定内容哈希(不含 compiled_at 与 content_hash 本身);同 IR + 同编译器/库版本 → 同哈希",
            "type": "string",
            "maxLength": 200
          },
          "compiled_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "libs": {
            "description": "编译时的原语库/订单门口径/策略规范/周期策略版本;任一变化都可能让同一 IR 产出不同候选",
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "primitive_registry": {
                "type": "string",
                "maxLength": 200
              },
              "order_gate": {
                "enum": [
                  "structure",
                  "legacy"
                ]
              },
              "strategy_spec": {
                "type": "string",
                "maxLength": 80
              },
              "horizon_policy": {
                "type": "string",
                "maxLength": 80
              }
            },
            "required": [
              "primitive_registry",
              "order_gate",
              "strategy_spec",
              "horizon_policy"
            ]
          },
          "horizon": {
            "description": "从 IR 主周期推;1m/3m/5m(scalp)不接受,为 null 并在 unmapped 里 block",
            "enum": [
              "intraday",
              "swing",
              "position",
              null
            ]
          },
          "timeframe": {
            "type": "string",
            "maxLength": 16
          },
          "confirm_timeframe": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 16
          },
          "symbol": {
            "type": "string",
            "maxLength": 64
          },
          "market": {
            "enum": [
              "spot",
              "perp"
            ]
          },
          "direction": {
            "enum": [
              "long",
              "short",
              "both"
            ]
          },
          "trigger": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "primitives": {
                "type": "array",
                "items": {
                  "$ref": "research.json#/$defs/StrategyPrimitive"
                },
                "maxItems": 30
              },
              "regime": {
                "anyOf": [
                  {
                    "$ref": "research.json#/$defs/StrategyPrimitive"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "short_primitives": {
                "type": "array",
                "items": {
                  "$ref": "research.json#/$defs/StrategyPrimitive"
                },
                "maxItems": 30
              },
              "short_regime": {
                "anyOf": [
                  {
                    "$ref": "research.json#/$defs/StrategyPrimitive"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "eval_on": {
                "const": "bar_close"
              },
              "cooldown_bars": {
                "description": "IR 没有冷却字段:null = 不另设冷却,同向新信号按 entry.on_new_signal 处理",
                "type": [
                  "integer",
                  "null"
                ],
                "minimum": 0,
                "maximum": 100000
              }
            },
            "required": [
              "primitives",
              "regime",
              "short_primitives",
              "short_regime",
              "eval_on",
              "cooldown_bars"
            ]
          },
          "evidence_plan": {
            "$ref": "#/$defs/BindingEvidencePlan"
          },
          "entry": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "type": {
                "enum": [
                  "market",
                  "limit"
                ]
              },
              "price": {
                "anyOf": [
                  {
                    "$ref": "research.json#/$defs/StrategyPrimitive"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "expiry_bars": {
                "type": [
                  "integer",
                  "null"
                ],
                "minimum": 1,
                "maximum": 5000
              },
              "on_new_signal": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "unfilled": {
                    "enum": [
                      "replace",
                      "keep"
                    ]
                  },
                  "filled": {
                    "enum": [
                      "roll",
                      "add",
                      "ignore"
                    ]
                  }
                },
                "required": [
                  "unfilled",
                  "filled"
                ]
              },
              "max_adds": {
                "type": "integer",
                "minimum": 0,
                "maximum": 5
              },
              "chase_atr_max": {
                "type": [
                  "number",
                  "null"
                ]
              }
            },
            "required": [
              "type",
              "price",
              "expiry_bars",
              "on_new_signal",
              "max_adds",
              "chase_atr_max"
            ]
          },
          "stop": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "primitive": {
                "$ref": "research.json#/$defs/StrategyPrimitive"
              },
              "buffer_atr": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "is_invalidation": {
                "description": "一条线:硬止损 = 失效线(+ buffer)",
                "const": true
              },
              "min_stop_atr": {
                "description": "结构口径:止损离入场不到 k×ATR(14) 的单子不做(不把止损挪远);旧口径为 null",
                "type": [
                  "number",
                  "null"
                ]
              }
            },
            "required": [
              "primitive",
              "buffer_atr",
              "is_invalidation",
              "min_stop_atr"
            ]
          },
          "targets": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BindingTarget"
            },
            "description": "最多 5 档(order.take_profits 上限)"
          },
          "target_policy": {
            "description": "chart = 图上价位止盈,算不出就不设、交给追踪止损;user_r = 用户原话要求的 R 倍数;signal_exit = 止盈由用户的信号离场决定,不补价位;trail_only = 只有追踪止损",
            "enum": [
              "chart",
              "user_r",
              "signal_exit",
              "trail_only"
            ]
          },
          "trail": {
            "anyOf": [
              {
                "$ref": "research.json#/$defs/StrategyPrimitive"
              },
              {
                "type": "null"
              }
            ]
          },
          "breakeven_after_tp": {
            "type": "boolean"
          },
          "breakeven_after_r": {
            "type": [
              "number",
              "null"
            ]
          },
          "max_holding_bars": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1,
            "maximum": 100000
          },
          "signal_exits": {
            "type": "array",
            "items": {
              "$ref": "research.json#/$defs/StrategyPrimitive"
            },
            "maxItems": 30
          },
          "min_rr": {
            "description": "只有用户硬约束(order.min_rr)才有值、才拦单;结构口径下盈亏比只计算展示",
            "type": [
              "number",
              "null"
            ]
          },
          "risk": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "sizing": {
                "$ref": "research.json#/$defs/StrategyPrimitive"
              },
              "leverage": {
                "type": "number",
                "minimum": 1,
                "maximum": 125
              },
              "leverage_cap": {
                "description": "实盘杠杆上限(研究侧 MAX_RESEARCH_LEVERAGE);IR 超过它编译 block",
                "type": "number"
              },
              "max_risk_fraction": {
                "description": "单笔初始风险占权益上限(订单门 max_risk_fraction,小数字符串)",
                "type": "string",
                "maxLength": 20
              }
            },
            "required": [
              "sizing",
              "leverage",
              "leverage_cap",
              "max_risk_fraction"
            ]
          },
          "model": {
            "description": "模型在这条策略里的角色(Codex 复审:agent_mode 拆成 entry_filter / exit_discretion)。缺省 entry_filter=on、exit_discretion=off:模型只决定做/不做,不改任何价位,持仓期零模型调用;最终取值由 A/C 臂配对证据定,属于部署决定",
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "entry_filter": {
                "enum": [
                  "on",
                  "off"
                ]
              },
              "exit_discretion": {
                "enum": [
                  "on",
                  "off"
                ]
              },
              "outputs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 40
                },
                "maxItems": 10
              },
              "forbidden": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 200
                },
                "maxItems": 20
              }
            },
            "required": [
              "entry_filter",
              "exit_discretion",
              "outputs",
              "forbidden"
            ]
          },
          "roles": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BindingRoleSlice"
            },
            "description": "固定六片,顺序 radar / judge / geometry / risk / holding / execution"
          },
          "unmapped": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BindingUnmapped"
            },
            "maxItems": 100
          },
          "deployable": {
            "description": "unmapped 里没有 block;false = 编译失败,不能下发",
            "type": "boolean"
          },
          "evidence_refs": {
            "description": "evidence 会变,不嵌进绑定:只存这版的回测报告 id",
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "report_ids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "maxLength": 4000
                },
                "maxItems": 500
              }
            },
            "required": [
              "report_ids"
            ]
          }
        },
        "required": [
          "schema_version",
          "compiler_version",
          "strategy_id",
          "version",
          "ir_hash",
          "content_hash",
          "compiled_at",
          "libs",
          "horizon",
          "timeframe",
          "confirm_timeframe",
          "symbol",
          "market",
          "direction",
          "trigger",
          "evidence_plan",
          "entry",
          "stop",
          "targets",
          "target_policy",
          "trail",
          "breakeven_after_tp",
          "breakeven_after_r",
          "max_holding_bars",
          "signal_exits",
          "min_rr",
          "risk",
          "model",
          "roles",
          "unmapped",
          "deployable",
          "evidence_refs"
        ]
      },
      "StrategyBindingResponse": {
        "description": "GET /api/research/strategies/:id/binding[?version=] 只读编译结果;策略还没有 IR(规则未编码的草稿)时 binding=null,unmapped 说明缺什么",
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "strategy_id": {
            "type": "string",
            "maxLength": 4000
          },
          "version": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "lab_strategy_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "binding": {
            "anyOf": [
              {
                "$ref": "#/$defs/StrategyBinding"
              },
              {
                "type": "null"
              }
            ]
          },
          "unmapped": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BindingUnmapped"
            },
            "maxItems": 100
          }
        },
        "required": [
          "strategy_id",
          "version",
          "lab_strategy_id",
          "binding",
          "unmapped"
        ]
      },
      "BuiltinImportItem": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "builtin_id": {
            "type": "string",
            "maxLength": 80
          },
          "strategy_id": {
            "type": "string",
            "maxLength": 4000
          },
          "created": {
            "description": "true = 本次新建;false = 已存在(幂等,不重复建)",
            "type": "boolean"
          },
          "version": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "translation": {
            "description": "full = 整条译成 IR;partial = 部分可译,其余进 unmapped;none = 规则未编码(缺原语),只建草稿",
            "enum": [
              "full",
              "partial",
              "none"
            ]
          },
          "report_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "error": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 2000
          }
        },
        "required": [
          "builtin_id",
          "strategy_id",
          "created",
          "version",
          "translation",
          "report_id",
          "error"
        ]
      },
      "BuiltinImportResult": {
        "description": "POST /api/research/strategies/import-builtin {backtest?, ids?} 的结果;按 origin.source='import' + lab_strategy_id=<内置 id> 幂等",
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BuiltinImportItem"
            },
            "maxItems": 50
          }
        },
        "required": [
          "items"
        ]
      }
    }
  },
  "research-improve": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.local/schema/research-improve.json",
    "title": "ResearchImproveObject",
    "description": "策略自动改进与复验环(Improver)第一阶段:POST/GET /api/research/improve 的请求与响应,SSE 事件 research.improve。设计见 docs/research/improver-design-2026-09-23.md。",
    "anyOf": [
      {
        "$ref": "#/$defs/ImproveJobDetail"
      },
      {
        "$ref": "#/$defs/ImproveJobList"
      },
      {
        "$ref": "#/$defs/ImproveAccepted"
      },
      {
        "$ref": "#/$defs/ImproveJobSummary"
      },
      {
        "$ref": "#/$defs/ImproveEvent"
      }
    ],
    "$defs": {
      "ImproveRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "strategy_id": {
            "type": "string",
            "maxLength": 80
          },
          "strategy_version": {
            "type": "integer",
            "minimum": 1
          },
          "strategy_ir": {
            "$ref": "research.json#/$defs/StrategyIR"
          },
          "timeframe": {
            "type": "string",
            "maxLength": 16
          },
          "universe": {
            "type": "array",
            "minItems": 1,
            "maxItems": 30,
            "items": {
              "type": "string",
              "maxLength": 40
            }
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0
          },
          "objective": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "min_trades_per_fold": {
                "type": "integer",
                "minimum": 0
              },
              "min_trades_total": {
                "type": "integer",
                "minimum": 0
              },
              "max_drawdown": {
                "type": "number"
              },
              "require_stress_positive": {
                "type": "boolean"
              },
              "require_beats_exposure_matched_hold": {
                "type": "boolean"
              },
              "plateau_ratio": {
                "type": "number"
              },
              "stability_penalty": {
                "type": "number"
              }
            }
          },
          "budget": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "generations": {
                "type": "integer",
                "minimum": 0
              },
              "candidates_per_generation": {
                "type": "integer",
                "minimum": 0
              },
              "promote_per_generation": {
                "type": "integer",
                "minimum": 0
              },
              "wall_clock_ms": {
                "type": "integer",
                "minimum": 0
              },
              "model_calls": {
                "type": "integer",
                "minimum": 0
              },
              "patience": {
                "type": "integer",
                "minimum": 0
              }
            }
          },
          "generators": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "items": {
              "enum": [
                "baseline",
                "diagnosis",
                "neighborhood",
                "swap",
                "oracle",
                "model"
              ]
            }
          },
          "dataset_ids": {
            "type": "object",
            "additionalProperties": {
              "type": "string",
              "maxLength": 64
            }
          },
          "random_entry_runs": {
            "type": "integer",
            "minimum": 0
          },
          "seed": {
            "type": "integer",
            "minimum": 0
          },
          "write_version": {
            "type": "boolean"
          }
        },
        "required": []
      },
      "ImproveAccepted": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "job_id": {
            "type": "string",
            "maxLength": 80
          }
        },
        "required": [
          "job_id"
        ]
      },
      "ImproveObjective": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "min_trades_per_fold": {
            "type": "integer",
            "minimum": 0
          },
          "min_trades_total": {
            "type": "integer",
            "minimum": 0
          },
          "max_drawdown": {
            "type": "number"
          },
          "require_stress_positive": {
            "type": "boolean"
          },
          "require_beats_exposure_matched_hold": {
            "type": "boolean"
          },
          "plateau_ratio": {
            "type": "number"
          },
          "stability_penalty": {
            "type": "number"
          }
        },
        "required": [
          "min_trades_per_fold",
          "min_trades_total",
          "max_drawdown",
          "require_stress_positive",
          "require_beats_exposure_matched_hold",
          "plateau_ratio"
        ]
      },
      "ImproveBudget": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "generations": {
            "type": "integer",
            "minimum": 0
          },
          "candidates_per_generation": {
            "type": "integer",
            "minimum": 0
          },
          "promote_per_generation": {
            "type": "integer",
            "minimum": 0
          },
          "wall_clock_ms": {
            "type": "integer",
            "minimum": 0
          },
          "model_calls": {
            "type": "integer",
            "minimum": 0
          },
          "patience": {
            "type": "integer",
            "minimum": 0
          },
          "allow_explore": {
            "type": "boolean",
            "description": "多步搜索(缺省 true):没有 promote 的代,训练目标高于父策略的最好候选(门槛没过也行)作下一代父策略;冠军只从门槛全过且验证段优于基线的候选里选"
          }
        },
        "required": [
          "generations",
          "candidates_per_generation",
          "promote_per_generation",
          "wall_clock_ms",
          "model_calls"
        ]
      },
      "ImproveSpec": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "strategy_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          },
          "strategy_version": {
            "type": [
              "integer",
              "null"
            ]
          },
          "strategy_ir": {
            "$ref": "research.json#/$defs/StrategyIR"
          },
          "timeframe": {
            "type": "string",
            "maxLength": 16
          },
          "universe": {
            "type": "array",
            "maxItems": 30,
            "items": {
              "type": "string",
              "maxLength": 40
            }
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0
          },
          "objective": {
            "$ref": "#/$defs/ImproveObjective"
          },
          "budget": {
            "$ref": "#/$defs/ImproveBudget"
          },
          "generators": {
            "type": "array",
            "maxItems": 5,
            "items": {
              "enum": [
                "baseline",
                "diagnosis",
                "neighborhood",
                "swap",
                "oracle",
                "model"
              ]
            }
          },
          "dataset_ids": {
            "type": [
              "object",
              "null"
            ],
            "additionalProperties": {
              "type": "string",
              "maxLength": 64
            }
          },
          "random_entry_runs": {
            "type": "integer",
            "minimum": 0
          },
          "seed": {
            "type": "integer",
            "minimum": 0
          },
          "write_version": {
            "type": "boolean"
          }
        },
        "required": [
          "strategy_id",
          "strategy_version",
          "strategy_ir",
          "timeframe",
          "universe",
          "from_ms",
          "to_ms",
          "objective",
          "budget",
          "generators",
          "dataset_ids",
          "random_entry_runs",
          "seed",
          "write_version"
        ]
      },
      "ImproveFrozen": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "universe": {
            "type": "array",
            "maxItems": 30,
            "items": {
              "type": "string",
              "maxLength": 40
            }
          },
          "timeframe": {
            "type": "string",
            "maxLength": 16
          },
          "timeframe_ms": {
            "type": "integer",
            "minimum": 0
          },
          "warmup_bars": {
            "type": "integer",
            "minimum": 0
          },
          "segments": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "folds": {
                "type": "array",
                "maxItems": 20,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "from_ms": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "to_ms": {
                      "type": "integer",
                      "minimum": 0
                    }
                  },
                  "required": [
                    "from_ms",
                    "to_ms"
                  ]
                }
              },
              "train": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "from_ms": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "to_ms": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "from_ms",
                  "to_ms"
                ]
              },
              "validation": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "from_ms": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "to_ms": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "from_ms",
                  "to_ms"
                ]
              },
              "holdout": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "from_ms": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "to_ms": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "from_ms",
                  "to_ms"
                ]
              }
            },
            "required": [
              "folds",
              "train",
              "validation",
              "holdout"
            ]
          },
          "dataset_ids": {
            "type": "object",
            "additionalProperties": {
              "type": "string",
              "maxLength": 64
            }
          },
          "bars": {
            "type": "object",
            "additionalProperties": {
              "type": "integer",
              "minimum": 0
            }
          },
          "market": {
            "enum": [
              "spot",
              "perp"
            ]
          }
        },
        "required": [
          "universe",
          "timeframe",
          "timeframe_ms",
          "warmup_bars",
          "segments",
          "dataset_ids",
          "bars"
        ]
      },
      "ImproveSegmentScore": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "segment": {
            "type": "string",
            "maxLength": 40
          },
          "trades": {
            "type": "integer",
            "minimum": 0
          },
          "total_return": {
            "type": "number"
          },
          "sharpe": {
            "type": [
              "number",
              "null"
            ]
          },
          "max_drawdown": {
            "type": "number"
          },
          "exposure": {
            "type": "number"
          },
          "exposure_matched_hold": {
            "type": [
              "number",
              "null"
            ]
          },
          "stressed_return": {
            "type": [
              "number",
              "null"
            ]
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0
          },
          "hold_return": {
            "type": [
              "number",
              "null"
            ]
          },
          "btc_hold_return": {
            "type": [
              "number",
              "null"
            ]
          },
          "daily_sharpe": {
            "type": [
              "number",
              "null"
            ]
          },
          "days": {
            "type": "integer",
            "minimum": 0
          },
          "win_rate": {
            "type": [
              "number",
              "null"
            ]
          },
          "profit_factor": {
            "type": [
              "number",
              "null"
            ]
          },
          "fees": {
            "type": "number"
          },
          "per_asset": {
            "type": "array",
            "maxItems": 50,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "symbol": {
                  "type": "string",
                  "maxLength": 40
                },
                "total_return": {
                  "type": "number"
                },
                "trades": {
                  "type": "integer",
                  "minimum": 0
                },
                "hold_return": {
                  "type": [
                    "number",
                    "null"
                  ]
                },
                "status": {
                  "type": "string",
                  "maxLength": 40
                }
              },
              "required": [
                "symbol",
                "total_return",
                "trades",
                "hold_return",
                "status"
              ]
            }
          }
        },
        "required": [
          "segment",
          "trades",
          "total_return",
          "sharpe",
          "max_drawdown",
          "exposure",
          "exposure_matched_hold",
          "stressed_return"
        ]
      },
      "ImproveGateResult": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "name": {
            "type": "string",
            "maxLength": 80
          },
          "ok": {
            "type": "boolean"
          },
          "value": {
            "type": [
              "number",
              "null"
            ]
          },
          "threshold": {
            "type": [
              "number",
              "null"
            ]
          },
          "note": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "required": [
          "name",
          "ok",
          "value",
          "threshold"
        ]
      },
      "ImproveEvaluation": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "candidate_id": {
            "type": "string",
            "maxLength": 80
          },
          "folds": {
            "type": "array",
            "maxItems": 20,
            "items": {
              "$ref": "#/$defs/ImproveSegmentScore"
            }
          },
          "train": {
            "$ref": "#/$defs/ImproveSegmentScore"
          },
          "validation": {
            "$ref": "#/$defs/ImproveSegmentScore"
          },
          "holdout": {
            "$ref": "#/$defs/ImproveSegmentScore"
          },
          "objective": {
            "type": [
              "number",
              "null"
            ]
          },
          "gates": {
            "type": "array",
            "maxItems": 20,
            "items": {
              "$ref": "#/$defs/ImproveGateResult"
            }
          },
          "passed": {
            "type": "boolean"
          }
        },
        "required": [
          "candidate_id",
          "folds",
          "objective",
          "gates",
          "passed"
        ]
      },
      "ImproveDiff": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string",
            "maxLength": 200
          },
          "from": {},
          "to": {}
        },
        "required": [
          "path",
          "from",
          "to"
        ]
      },
      "ImproveCandidate": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 80
          },
          "parent_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          },
          "generation": {
            "type": "integer",
            "minimum": 0
          },
          "generator": {
            "enum": [
              "baseline",
              "diagnosis",
              "neighborhood",
              "swap",
              "oracle",
              "model"
            ]
          },
          "status": {
            "enum": [
              "rejected",
              "evaluated",
              "gated_out",
              "plateau_failed",
              "validated",
              "parent",
              "explore_parent",
              "champion"
            ]
          },
          "ir_hash": {
            "type": "string",
            "maxLength": 128
          },
          "strategy_ir": {
            "$ref": "research.json#/$defs/StrategyIR"
          },
          "diff": {
            "type": "array",
            "maxItems": 50,
            "items": {
              "$ref": "#/$defs/ImproveDiff"
            }
          },
          "rationale": {
            "type": "string",
            "maxLength": 4000
          },
          "evidence": {
            "type": [
              "object",
              "null"
            ]
          },
          "evaluation": {
            "anyOf": [
              {
                "$ref": "#/$defs/ImproveEvaluation"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "parent_id",
          "generation",
          "generator",
          "status",
          "ir_hash",
          "strategy_ir",
          "diff",
          "rationale",
          "evidence",
          "evaluation"
        ]
      },
      "ImproveLeaderboardRow": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 80
          },
          "generation": {
            "type": "integer",
            "minimum": 0
          },
          "generator": {
            "enum": [
              "baseline",
              "diagnosis",
              "neighborhood",
              "swap",
              "oracle",
              "model"
            ]
          },
          "status": {
            "enum": [
              "rejected",
              "evaluated",
              "gated_out",
              "plateau_failed",
              "validated",
              "parent",
              "explore_parent",
              "champion"
            ]
          },
          "objective": {
            "type": [
              "number",
              "null"
            ]
          },
          "passed": {
            "type": "boolean"
          },
          "failed_gates": {
            "type": "array",
            "maxItems": 20,
            "items": {
              "type": "string",
              "maxLength": 80
            }
          },
          "train_return": {
            "type": [
              "number",
              "null"
            ]
          },
          "train_sharpe": {
            "type": [
              "number",
              "null"
            ]
          },
          "train_trades": {
            "type": [
              "integer",
              "null"
            ]
          },
          "validation_return": {
            "type": [
              "number",
              "null"
            ]
          },
          "validation_sharpe": {
            "type": [
              "number",
              "null"
            ]
          },
          "holdout_return": {
            "type": [
              "number",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "generation",
          "generator",
          "status",
          "objective",
          "passed",
          "failed_gates",
          "train_return",
          "train_sharpe",
          "train_trades",
          "validation_return",
          "validation_sharpe",
          "holdout_return"
        ]
      },
      "ImproveGenerationProgress": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 0
          },
          "parent_id": {
            "type": "string",
            "maxLength": 80
          },
          "candidates": {
            "type": "integer",
            "minimum": 0
          },
          "evaluated": {
            "type": "integer",
            "minimum": 0
          },
          "passed": {
            "type": "integer",
            "minimum": 0
          },
          "promoted": {
            "type": "array",
            "maxItems": 20,
            "items": {
              "type": "string",
              "maxLength": 80
            }
          },
          "improved": {
            "type": "boolean"
          },
          "best_candidate_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          },
          "best_objective": {
            "type": [
              "number",
              "null"
            ]
          },
          "note": {
            "type": "string",
            "maxLength": 4000
          },
          "mode": {
            "enum": [
              "promote",
              "explore",
              null
            ],
            "description": "这一代怎么选出下一代父策略:promote=门槛全过且验证段优于冠军;explore=训练目标更高的多步搜索父策略(不能当冠军);null=都没有"
          },
          "champion_id": {
            "type": "string",
            "maxLength": 80,
            "description": "这一代结束时的冠军"
          }
        },
        "required": [
          "generation",
          "parent_id",
          "candidates",
          "evaluated",
          "passed",
          "promoted",
          "improved",
          "best_candidate_id",
          "best_objective",
          "note"
        ]
      },
      "ImproveProgress": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "phase": {
            "type": "string",
            "maxLength": 40
          },
          "message": {
            "type": "string",
            "maxLength": 4000
          },
          "generation": {
            "type": "integer",
            "minimum": 0
          },
          "generations": {
            "type": "array",
            "maxItems": 20,
            "items": {
              "$ref": "#/$defs/ImproveGenerationProgress"
            }
          },
          "trials": {
            "type": "integer",
            "minimum": 0
          },
          "single_runs": {
            "type": "integer",
            "minimum": 0
          },
          "started_at": {
            "type": [
              "integer",
              "null"
            ]
          },
          "elapsed_ms": {
            "type": "integer",
            "minimum": 0
          },
          "stop_reason": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          },
          "notes": {
            "type": "array",
            "maxItems": 200,
            "items": {
              "type": "string",
              "maxLength": 4000
            }
          }
        },
        "required": [
          "phase",
          "message",
          "generation",
          "generations",
          "trials",
          "single_runs",
          "started_at",
          "elapsed_ms",
          "stop_reason",
          "notes"
        ]
      },
      "ImproveRandomEntry": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "runs": {
            "type": "integer",
            "minimum": 0
          },
          "seed": {
            "type": "integer",
            "minimum": 0
          },
          "segment": {
            "type": "string",
            "maxLength": 40
          },
          "returns": {
            "type": "array",
            "maxItems": 200,
            "items": {
              "type": "number"
            }
          },
          "trades": {
            "type": "array",
            "maxItems": 200,
            "items": {
              "type": "integer",
              "minimum": 0
            }
          },
          "sharpes": {
            "type": "array",
            "maxItems": 200,
            "items": {
              "type": [
                "number",
                "null"
              ]
            }
          },
          "median_return": {
            "type": [
              "number",
              "null"
            ]
          },
          "champion_return": {
            "type": "number"
          },
          "champion_percentile": {
            "type": [
              "number",
              "null"
            ]
          },
          "note": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "required": [
          "runs",
          "seed",
          "segment",
          "returns",
          "trades",
          "sharpes",
          "median_return",
          "champion_return",
          "champion_percentile",
          "note"
        ]
      },
      "ImproveLedger": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "trials": {
            "type": "integer",
            "minimum": 0
          },
          "deflated_sharpe": {
            "type": [
              "number",
              "null"
            ]
          },
          "pbo": {
            "type": [
              "number",
              "null"
            ]
          },
          "random_entry_baseline": {
            "anyOf": [
              {
                "$ref": "#/$defs/ImproveSegmentScore"
              },
              {
                "type": "null"
              }
            ]
          },
          "notes": {
            "type": "array",
            "maxItems": 50,
            "items": {
              "type": "string",
              "maxLength": 4000
            }
          },
          "deflated_inputs": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "sharpe": {
                    "type": "number"
                  },
                  "sharpe_variance": {
                    "type": "number"
                  },
                  "expected_max_sharpe": {
                    "type": "number"
                  },
                  "days": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "skew": {
                    "type": "number"
                  },
                  "kurtosis": {
                    "type": "number"
                  }
                },
                "required": [
                  "sharpe",
                  "sharpe_variance",
                  "expected_max_sharpe",
                  "days",
                  "skew",
                  "kurtosis"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "plateau_checks": {
            "type": "integer",
            "minimum": 0
          },
          "random_entry": {
            "anyOf": [
              {
                "$ref": "#/$defs/ImproveRandomEntry"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "trials",
          "deflated_sharpe",
          "pbo",
          "random_entry_baseline",
          "notes"
        ]
      },
      "ImproveResult": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "champion_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          },
          "baseline_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          },
          "champion_is_baseline": {
            "type": "boolean"
          },
          "holdout": {
            "anyOf": [
              {
                "$ref": "#/$defs/ImproveSegmentScore"
              },
              {
                "type": "null"
              }
            ]
          },
          "baseline_validation": {
            "anyOf": [
              {
                "$ref": "#/$defs/ImproveSegmentScore"
              },
              {
                "type": "null"
              }
            ]
          },
          "strategy_version_written": {
            "type": [
              "integer",
              "null"
            ]
          },
          "stop_reason": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          },
          "summary": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "required": [
          "champion_id",
          "baseline_id",
          "champion_is_baseline",
          "holdout",
          "baseline_validation",
          "strategy_version_written",
          "stop_reason",
          "summary"
        ]
      },
      "ImproveJobSummary": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 80
          },
          "status": {
            "enum": [
              "queued",
              "running",
              "completed",
              "failed",
              "cancelled",
              "interrupted"
            ]
          },
          "strategy_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          },
          "strategy_version": {
            "type": [
              "integer",
              "null"
            ]
          },
          "label": {
            "type": "string",
            "maxLength": 300
          },
          "timeframe": {
            "type": "string",
            "maxLength": 16
          },
          "universe": {
            "type": "array",
            "maxItems": 30,
            "items": {
              "type": "string",
              "maxLength": 40
            }
          },
          "created_at": {
            "type": "integer",
            "minimum": 0
          },
          "updated_at": {
            "type": "integer",
            "minimum": 0
          },
          "finished_at": {
            "type": [
              "integer",
              "null"
            ]
          },
          "phase": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 40
          },
          "message": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "generation": {
            "type": "integer",
            "minimum": 0
          },
          "trials": {
            "type": "integer",
            "minimum": 0
          },
          "champion_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 80
          },
          "summary": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "error": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          }
        },
        "required": [
          "id",
          "status",
          "strategy_id",
          "strategy_version",
          "label",
          "timeframe",
          "universe",
          "created_at",
          "updated_at",
          "finished_at",
          "phase",
          "message",
          "generation",
          "trials",
          "champion_id",
          "summary",
          "error"
        ]
      },
      "ImproveJobList": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "jobs": {
            "type": "array",
            "maxItems": 200,
            "items": {
              "$ref": "#/$defs/ImproveJobSummary"
            }
          }
        },
        "required": [
          "jobs"
        ]
      },
      "ImproveJobDetail": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "job": {
            "$ref": "#/$defs/ImproveJobSummary"
          },
          "spec": {
            "$ref": "#/$defs/ImproveSpec"
          },
          "frozen": {
            "anyOf": [
              {
                "$ref": "#/$defs/ImproveFrozen"
              },
              {
                "type": "null"
              }
            ]
          },
          "progress": {
            "anyOf": [
              {
                "$ref": "#/$defs/ImproveProgress"
              },
              {
                "type": "null"
              }
            ]
          },
          "ledger": {
            "anyOf": [
              {
                "$ref": "#/$defs/ImproveLedger"
              },
              {
                "type": "null"
              }
            ]
          },
          "result": {
            "anyOf": [
              {
                "$ref": "#/$defs/ImproveResult"
              },
              {
                "type": "null"
              }
            ]
          },
          "lineage": {
            "type": "array",
            "maxItems": 500,
            "items": {
              "$ref": "#/$defs/ImproveCandidate"
            }
          },
          "leaderboard": {
            "type": "array",
            "maxItems": 50,
            "items": {
              "$ref": "#/$defs/ImproveLeaderboardRow"
            }
          },
          "generators_available": {
            "type": "array",
            "maxItems": 10,
            "items": {
              "enum": [
                "baseline",
                "diagnosis",
                "neighborhood",
                "swap",
                "oracle",
                "model"
              ]
            }
          }
        },
        "required": [
          "job",
          "spec",
          "frozen",
          "progress",
          "ledger",
          "result",
          "lineage",
          "leaderboard",
          "generators_available"
        ]
      },
      "ImproveEvent": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "job_id": {
            "type": "string",
            "maxLength": 80
          },
          "phase": {
            "type": "string",
            "maxLength": 40
          },
          "generation": {
            "type": "integer",
            "minimum": 0
          },
          "message": {
            "type": "string",
            "maxLength": 4000
          },
          "trials": {
            "type": "integer",
            "minimum": 0
          },
          "status": {
            "type": "string",
            "maxLength": 40
          },
          "candidate": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 80
              },
              "generator": {
                "enum": [
                  "baseline",
                  "diagnosis",
                  "neighborhood",
                  "swap",
                  "oracle",
                  "model"
                ]
              },
              "objective": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "passed": {
                "type": "boolean"
              },
              "status": {
                "enum": [
                  "rejected",
                  "evaluated",
                  "gated_out",
                  "plateau_failed",
                  "validated",
                  "parent",
                  "explore_parent",
                  "champion"
                ]
              }
            },
            "required": [
              "id",
              "generator",
              "objective",
              "passed",
              "status"
            ]
          }
        },
        "required": [
          "job_id",
          "phase",
          "generation",
          "message",
          "trials"
        ]
      }
    }
  },
  "research-loop": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.local/schema/research-loop.json",
    "title": "ResearchLoop",
    "anyOf": [
      {
        "$ref": "#/$defs/LoopPlan"
      },
      {
        "$ref": "#/$defs/LoopSnapshot"
      },
      {
        "$ref": "#/$defs/LoopArtifact"
      }
    ],
    "$defs": {
      "LoopJson": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "boolean"
          },
          {
            "type": "string"
          },
          {
            "type": "number"
          },
          {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopJson"
            }
          },
          {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/LoopJson"
            }
          }
        ]
      },
      "LoopObject": {
        "type": "object",
        "additionalProperties": {
          "$ref": "#/$defs/LoopJson"
        }
      },
      "LoopRefs": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "LoopWindow": {
        "type": "object",
        "properties": {
          "from_ms": {
            "type": "integer",
            "minimum": 0
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0
          }
        },
        "required": [
          "from_ms",
          "to_ms"
        ],
        "additionalProperties": false
      },
      "LoopContext": {
        "type": "object",
        "properties": {
          "instrument_refs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "selected_artifact_id": {
            "type": "string"
          },
          "selected_inquiry_id": {
            "type": "string"
          },
          "selected_run_id": {
            "type": "string"
          },
          "selected_window": {
            "$ref": "#/$defs/LoopWindow"
          }
        },
        "required": [
          "instrument_refs"
        ],
        "additionalProperties": false
      },
      "LoopTaskKind": {
        "enum": [
          "market",
          "compare",
          "validate",
          "diagnose"
        ]
      },
      "LoopResearchMode": {
        "enum": [
          "validate_single",
          "validate_multi",
          "compare_assets",
          "market_leverage",
          "diagnose",
          "parameter_sweep",
          "pattern_frequency"
        ]
      },
      "LoopConceptStatus": {
        "enum": [
          "mapped",
          "acquired",
          "proxy",
          "unmapped"
        ]
      },
      "LoopConceptCategory": {
        "enum": [
          "indicator",
          "pattern",
          "structure",
          "data_metric",
          "comparison",
          "timeframe",
          "asset",
          "risk"
        ]
      },
      "LoopConceptSource": {
        "enum": [
          "primitive_registry",
          "lexicon",
          "data_catalog",
          "acquired",
          "none"
        ]
      },
      "LoopConcept": {
        "type": "object",
        "properties": {
          "term": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "concept_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "category": {
            "$ref": "#/$defs/LoopConceptCategory"
          },
          "status": {
            "$ref": "#/$defs/LoopConceptStatus"
          },
          "source": {
            "$ref": "#/$defs/LoopConceptSource"
          },
          "target": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 200
          },
          "note": {
            "type": "string",
            "maxLength": 2000
          }
        },
        "required": [
          "term",
          "concept_id",
          "category",
          "status",
          "source",
          "target",
          "note"
        ],
        "additionalProperties": false
      },
      "LoopStatus": {
        "enum": [
          "queued",
          "planning",
          "running",
          "validating",
          "completed",
          "awaiting_input",
          "cancelling",
          "cancelled",
          "failed",
          "incomplete"
        ]
      },
      "LoopBudget": {
        "type": "object",
        "properties": {
          "max_model_calls": {
            "type": "integer",
            "minimum": 0
          },
          "max_data_calls": {
            "type": "integer",
            "minimum": 0
          },
          "max_backtests": {
            "type": "integer",
            "minimum": 0
          },
          "wall_clock_ms": {
            "type": "integer",
            "minimum": 0
          }
        },
        "required": [
          "max_model_calls",
          "max_data_calls",
          "max_backtests",
          "wall_clock_ms"
        ],
        "additionalProperties": false
      },
      "LoopUsage": {
        "type": "object",
        "properties": {
          "max_model_calls": {
            "type": "integer",
            "minimum": 0
          },
          "max_data_calls": {
            "type": "integer",
            "minimum": 0
          },
          "max_backtests": {
            "type": "integer",
            "minimum": 0
          },
          "wall_clock_ms": {
            "type": "integer",
            "minimum": 0
          },
          "unknown_cost": {
            "type": "boolean"
          }
        },
        "required": [
          "max_model_calls",
          "max_data_calls",
          "max_backtests",
          "wall_clock_ms",
          "unknown_cost"
        ],
        "additionalProperties": false
      },
      "LoopCheckpoint": {
        "type": "object",
        "properties": {
          "completed_step_keys": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "snapshot_refs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "artifact_refs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "concepts": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopConcept"
            },
            "maxItems": 200
          }
        },
        "required": [
          "completed_step_keys",
          "snapshot_refs",
          "artifact_refs"
        ],
        "additionalProperties": false
      },
      "LoopPlanStep": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9_-]+$"
          },
          "title": {
            "type": "string"
          },
          "tool": {
            "type": "string"
          },
          "args": {
            "$ref": "#/$defs/LoopObject"
          },
          "depends_on": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "key",
          "title",
          "tool",
          "args",
          "depends_on"
        ],
        "additionalProperties": false
      },
      "LoopPlan": {
        "type": "object",
        "properties": {
          "task_kind": {
            "$ref": "#/$defs/LoopTaskKind"
          },
          "mode": {
            "$ref": "#/$defs/LoopResearchMode"
          },
          "instruments": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "window": {
            "$ref": "#/$defs/LoopWindow"
          },
          "timeframe": {
            "type": "string"
          },
          "plan": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopPlanStep"
            }
          },
          "clarify": {
            "type": "string"
          },
          "source": {
            "enum": [
              "model",
              "fallback_rules"
            ]
          },
          "command": {
            "$ref": "#/$defs/LoopRevisionCommand"
          }
        },
        "required": [
          "task_kind",
          "instruments",
          "window",
          "timeframe",
          "plan"
        ],
        "additionalProperties": false
      },
      "LoopInstrument": {
        "type": "object",
        "properties": {
          "canonical_id": {
            "type": "string"
          },
          "asset_class": {
            "const": "crypto"
          },
          "venue": {
            "const": "okx"
          },
          "market_type": {
            "enum": [
              "spot",
              "perp"
            ]
          },
          "base": {
            "type": "string"
          },
          "quote": {
            "type": "string"
          },
          "timezone": {
            "const": "UTC"
          },
          "ccxt_symbol": {
            "type": "string"
          },
          "display": {
            "type": "string"
          }
        },
        "required": [
          "canonical_id",
          "asset_class",
          "venue",
          "market_type",
          "base",
          "quote",
          "timezone",
          "ccxt_symbol",
          "display"
        ],
        "additionalProperties": false
      },
      "LoopAvailability": {
        "enum": [
          "available",
          "partial",
          "missing",
          "not_applicable",
          "stale"
        ]
      },
      "LoopCoverage": {
        "type": "object",
        "properties": {
          "availability": {
            "$ref": "#/$defs/LoopAvailability"
          },
          "earliest": {
            "type": [
              "integer",
              "null"
            ]
          },
          "latest": {
            "type": [
              "integer",
              "null"
            ]
          },
          "note": {
            "type": "string"
          }
        },
        "required": [
          "availability",
          "note"
        ],
        "additionalProperties": false
      },
      "LoopUnits": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        }
      },
      "LoopRows": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": {
            "anyOf": [
              {
                "type": "number"
              },
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      },
      "LoopSnapshot": {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "price",
              "funding",
              "open_interest",
              "liquidations"
            ]
          },
          "provider": {
            "const": "okx"
          },
          "instrument": {
            "$ref": "#/$defs/LoopInstrument"
          },
          "requested_window": {
            "$ref": "#/$defs/LoopWindow"
          },
          "actual_window": {
            "anyOf": [
              {
                "$ref": "#/$defs/LoopWindow"
              },
              {
                "type": "null"
              }
            ]
          },
          "as_of": {
            "type": "integer",
            "minimum": 0
          },
          "fetched_at": {
            "type": "integer",
            "minimum": 0
          },
          "frequency": {
            "type": [
              "string",
              "null"
            ]
          },
          "units": {
            "$ref": "#/$defs/LoopUnits"
          },
          "coverage": {
            "$ref": "#/$defs/LoopAvailability"
          },
          "quality_flags": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "rows": {
            "$ref": "#/$defs/LoopRows"
          },
          "checksum": {
            "type": "string",
            "minLength": 1
          },
          "method_version": {
            "type": "string"
          }
        },
        "required": [
          "kind",
          "provider",
          "instrument",
          "requested_window",
          "actual_window",
          "as_of",
          "fetched_at",
          "frequency",
          "units",
          "coverage",
          "quality_flags",
          "rows",
          "checksum",
          "method_version"
        ],
        "additionalProperties": false
      },
      "LoopSeriesMode": {
        "enum": [
          "line",
          "line+markers",
          "bar",
          "scatter"
        ],
        "description": "序列画法:折线 / 带点折线 / 柱 / 散点"
      },
      "LoopSeriesRole": {
        "enum": [
          "strategy",
          "benchmark",
          "asset",
          "basket",
          "alt",
          "positive",
          "negative",
          "neutral",
          "split"
        ],
        "description": "颜色角色:前端按角色取色(策略=主色、持有=蓝、正=绿、负=红…),不在数据里写死颜色"
      },
      "LoopYUnit": {
        "enum": [
          "$",
          "%",
          "count",
          "ratio",
          "none"
        ],
        "description": "纵轴数值单位:$ 按 $10k/9.97k 缩写,% 为已乘 100 的百分数"
      },
      "LoopChartTemplate": {
        "enum": [
          "equity_comparison",
          "drawdown_comparison",
          "exit_reason_pnl",
          "asset_pnl",
          "trade_scatter",
          "monthly_heatmap",
          "strategies_equity",
          "strategies_drawdown"
        ],
        "description": "研究图表模板(research/loop/charts.ts):由回测报告确定性生成"
      },
      "LoopChartAnnotation": {
        "type": "object",
        "properties": {
          "type": {
            "enum": [
              "vline",
              "hline"
            ]
          },
          "x": {
            "type": [
              "number",
              "string"
            ]
          },
          "y": {
            "type": "number"
          },
          "label": {
            "type": "string",
            "maxLength": 80
          },
          "role": {
            "$ref": "#/$defs/LoopSeriesRole"
          }
        },
        "required": [
          "type"
        ],
        "additionalProperties": false,
        "description": "x 分界竖线(vline,如样本内/外)或 y 参考横线(hline,如 0 线)"
      },
      "LoopChartSeries": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "mode": {
            "$ref": "#/$defs/LoopSeriesMode"
          },
          "role": {
            "$ref": "#/$defs/LoopSeriesRole"
          },
          "points": {
            "type": "array",
            "items": {
              "type": "array",
              "items": {
                "type": [
                  "number",
                  "string",
                  "null"
                ]
              },
              "minItems": 2,
              "maxItems": 2
            },
            "maxItems": 5000
          },
          "labels": {
            "type": "array",
            "items": {
              "type": [
                "string",
                "null"
              ]
            },
            "maxItems": 5000,
            "description": "与 points 对齐的文字标签(柱顶笔数等)"
          },
          "point_roles": {
            "type": "array",
            "items": {
              "enum": [
                "positive",
                "negative",
                "neutral"
              ]
            },
            "maxItems": 5000,
            "description": "逐点颜色角色(散点盈绿亏红、柱正负)"
          },
          "hover": {
            "type": "array",
            "items": {
              "type": [
                "string",
                "null"
              ]
            },
            "maxItems": 5000,
            "description": "与 points 对齐的悬停附注(如交易日期)"
          }
        },
        "required": [
          "name",
          "mode",
          "role",
          "points"
        ],
        "additionalProperties": false
      },
      "LoopChart": {
        "type": "object",
        "description": "研究图表产物的内容(artifact.content):由模板从回测报告确定性生成,前端按 Horizon 风格渲染(统一悬停、底部图例、坐标轴标题、分界线、柱顶标签)",
        "properties": {
          "kind": {
            "const": "chart"
          },
          "version": {
            "const": "research-chart/v1"
          },
          "template": {
            "$ref": "#/$defs/LoopChartTemplate"
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "type": {
            "enum": [
              "line",
              "bar",
              "scatter",
              "heatmap"
            ]
          },
          "x": {
            "enum": [
              "time",
              "category",
              "linear"
            ],
            "description": "time=毫秒时间戳;category=等距类目;linear=数值(如 Trade #)"
          },
          "x_title": {
            "type": "string",
            "maxLength": 120
          },
          "y_title": {
            "type": "string",
            "maxLength": 120
          },
          "y_unit": {
            "$ref": "#/$defs/LoopYUnit"
          },
          "series": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopChartSeries"
            },
            "maxItems": 24
          },
          "annotations": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopChartAnnotation"
            },
            "maxItems": 24
          },
          "heatmap": {
            "type": "object",
            "properties": {
              "x": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "maxItems": 24
              },
              "y": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "maxItems": 64
              },
              "z": {
                "type": "array",
                "items": {
                  "type": "array",
                  "items": {
                    "type": [
                      "number",
                      "null"
                    ]
                  }
                },
                "maxItems": 64
              }
            },
            "required": [
              "x",
              "y",
              "z"
            ],
            "additionalProperties": false
          },
          "caption": {
            "type": "string",
            "maxLength": 400,
            "description": "代码生成的一句说明(带数值)"
          },
          "note": {
            "type": "string",
            "maxLength": 400
          },
          "report_id": {
            "type": "string"
          },
          "report_ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "maxItems": 32
          },
          "asset": {
            "type": "string"
          },
          "base_capital": {
            "type": "number",
            "description": "金额换算基数(统一按 $10k 本金)"
          }
        },
        "required": [
          "kind",
          "version",
          "template",
          "title",
          "type",
          "x",
          "x_title",
          "y_title",
          "y_unit",
          "series",
          "annotations"
        ],
        "additionalProperties": false
      },
      "LoopSpec": {
        "type": "object",
        "properties": {
          "type": {
            "enum": [
              "line",
              "bar",
              "candlestick",
              "table",
              "comparison",
              "scatter",
              "heatmap"
            ]
          },
          "x": {
            "type": "string"
          },
          "y": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            ]
          },
          "series": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "field": {
                      "type": "string"
                    },
                    "axis": {
                      "type": "string"
                    },
                    "label": {
                      "type": "string"
                    },
                    "mode": {
                      "$ref": "#/$defs/LoopSeriesMode"
                    },
                    "role": {
                      "$ref": "#/$defs/LoopSeriesRole"
                    },
                    "text_field": {
                      "type": "string",
                      "description": "柱顶/点旁文字标签取自哪个字段(如「28T」笔数标签)"
                    }
                  },
                  "required": [
                    "field"
                  ],
                  "additionalProperties": false
                }
              }
            ]
          },
          "axis_units": {
            "$ref": "#/$defs/LoopUnits"
          },
          "y_unit": {
            "$ref": "#/$defs/LoopYUnit"
          },
          "x_title": {
            "type": "string",
            "maxLength": 120
          },
          "y_title": {
            "type": "string",
            "maxLength": 120
          },
          "template": {
            "$ref": "#/$defs/LoopChartTemplate"
          },
          "report_id": {
            "type": "string",
            "description": "图表由哪份全窗口回测报告确定性生成(溯源)"
          },
          "report_ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "maxItems": 32,
            "description": "多策略横比图引用的报告"
          },
          "encoding": {
            "$ref": "#/$defs/LoopObject"
          },
          "legend": {
            "$ref": "#/$defs/LoopJson"
          },
          "annotations": {
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "$ref": "#/$defs/LoopChartAnnotation"
                },
                {
                  "$ref": "#/$defs/LoopObject"
                }
              ]
            }
          },
          "interaction": {
            "$ref": "#/$defs/LoopObject"
          }
        },
        "required": [
          "type"
        ],
        "additionalProperties": false
      },
      "LoopBlocks": {
        "type": "array",
        "items": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "text"
                },
                "text": {
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "text"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "next_question"
                },
                "text": {
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "text"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "enum": [
                    "chart_ref",
                    "table_ref",
                    "report_ref",
                    "comparison_ref"
                  ]
                },
                "artifact_id": {
                  "type": "string"
                },
                "caption": {
                  "type": "string",
                  "maxLength": 300,
                  "description": "这张图的一句说明(模型写的不得含数字;模板写的由代码从报告算出)"
                }
              },
              "required": [
                "kind",
                "artifact_id"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "step_ref"
                },
                "step_id": {
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "step_id"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "strategy_ref"
                },
                "run_id": {
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "run_id"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "data_gap"
                },
                "metric": {
                  "type": "string"
                },
                "availability": {
                  "$ref": "#/$defs/LoopAvailability"
                },
                "note": {
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "metric",
                "availability",
                "note"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "run_status"
                },
                "inquiry_id": {
                  "type": "string"
                },
                "status": {
                  "$ref": "#/$defs/LoopStatus"
                }
              },
              "required": [
                "kind",
                "inquiry_id",
                "status"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "plan"
                },
                "task_kind": {
                  "$ref": "#/$defs/LoopTaskKind"
                },
                "steps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string"
                      },
                      "title": {
                        "type": "string"
                      },
                      "tool": {
                        "type": "string"
                      },
                      "status": {
                        "enum": [
                          "pending",
                          "running",
                          "succeeded",
                          "failed",
                          "skipped",
                          "cancelled"
                        ]
                      }
                    },
                    "required": [
                      "key",
                      "title",
                      "tool",
                      "status"
                    ],
                    "additionalProperties": false
                  }
                }
              },
              "required": [
                "kind",
                "task_kind",
                "steps"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "LoopErrorCode": {
        "enum": [
          "UNSUPPORTED_ASSET",
          "DATA_MISSING",
          "DATA_STALE",
          "RATE_LIMIT",
          "BUDGET_EXHAUSTED",
          "PROVIDER_ERROR",
          "SCHEMA_MISMATCH",
          "UNIT_MISMATCH",
          "NOT_COMPARABLE",
          "CANCELLED",
          "TIMEOUT"
        ]
      },
      "LoopResult": {
        "type": "object",
        "properties": {
          "status": {
            "enum": [
              "ok",
              "partial",
              "missing",
              "not_applicable",
              "stale",
              "error"
            ]
          },
          "output": {
            "$ref": "#/$defs/LoopJson"
          },
          "snapshot_refs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "artifact_refs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "coverage": {
            "$ref": "#/$defs/LoopCoverage"
          },
          "warnings": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "units": {
            "$ref": "#/$defs/LoopUnits"
          },
          "error_code": {
            "$ref": "#/$defs/LoopErrorCode"
          },
          "retryable": {
            "type": "boolean"
          },
          "latency_ms": {
            "type": "integer",
            "minimum": 0
          }
        },
        "required": [
          "status",
          "output",
          "snapshot_refs",
          "artifact_refs",
          "warnings",
          "latency_ms"
        ],
        "additionalProperties": false
      },
      "LoopResolveInput": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string"
          },
          "symbols": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "market": {
            "enum": [
              "spot",
              "perp"
            ]
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "LoopResolveOutput": {
        "type": "object",
        "properties": {
          "instruments": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopInstrument"
            }
          }
        },
        "required": [
          "instruments"
        ],
        "additionalProperties": false
      },
      "LoopDataInput": {
        "type": "object",
        "properties": {
          "instrument": {
            "$ref": "#/$defs/LoopInstrument"
          },
          "window": {
            "$ref": "#/$defs/LoopWindow"
          },
          "timeframe": {
            "type": "string"
          },
          "metric": {
            "enum": [
              "price",
              "funding",
              "open_interest",
              "liquidations",
              "liquidation_estimates",
              "orderbook"
            ]
          }
        },
        "required": [
          "instrument",
          "window"
        ],
        "additionalProperties": false
      },
      "LoopSnapshotOutput": {
        "type": "object",
        "properties": {
          "snapshot_id": {
            "type": "string"
          }
        },
        "required": [
          "snapshot_id"
        ],
        "additionalProperties": false
      },
      "LoopLeverageInput": {
        "type": "object",
        "properties": {
          "price_snapshot": {
            "type": "string"
          },
          "funding_snapshot": {
            "type": "string"
          },
          "oi_snapshot": {
            "type": "string"
          },
          "liquidations_snapshot": {
            "type": "string"
          }
        },
        "required": [
          "price_snapshot"
        ],
        "additionalProperties": false
      },
      "LoopStrengthInput": {
        "type": "object",
        "properties": {
          "instruments": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "benchmark": {
            "type": "string"
          },
          "timeframe": {
            "type": "string"
          },
          "window": {
            "$ref": "#/$defs/LoopWindow"
          },
          "snapshot_refs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "instruments",
          "benchmark",
          "timeframe",
          "window"
        ],
        "additionalProperties": false
      },
      "LoopCompareInput": {
        "type": "object",
        "properties": {
          "run_id": {
            "type": "string"
          },
          "arm": {
            "enum": [
              "a_rules",
              "b_agent",
              "c_filter"
            ]
          }
        },
        "required": [
          "run_id",
          "arm"
        ],
        "additionalProperties": false
      },
      "LoopCompileInput": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string"
          },
          "ir": {
            "$ref": "#/$defs/LoopObject"
          },
          "timeframe": {
            "type": "string"
          },
          "dataset_id": {
            "type": "string"
          },
          "acquired": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopObject"
            },
            "maxItems": 8
          }
        },
        "required": [
          "timeframe"
        ],
        "additionalProperties": false
      },
      "LoopBacktestInput": {
        "type": "object",
        "properties": {
          "instrument": {
            "$ref": "#/$defs/LoopInstrument"
          },
          "window": {
            "$ref": "#/$defs/LoopWindow"
          },
          "timeframe": {
            "type": "string"
          },
          "ir": {
            "$ref": "#/$defs/LoopObject"
          },
          "price_snapshot": {
            "type": "string"
          }
        },
        "required": [
          "instrument",
          "window",
          "timeframe",
          "ir"
        ],
        "additionalProperties": false
      },
      "LoopRenderInput": {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "chart",
              "table"
            ]
          },
          "spec": {
            "$ref": "#/$defs/LoopSpec"
          },
          "snapshot_refs": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "minItems": 1
          },
          "title": {
            "type": "string"
          },
          "question": {
            "type": "string"
          }
        },
        "required": [
          "kind",
          "spec",
          "snapshot_refs",
          "title",
          "question"
        ],
        "additionalProperties": false
      },
      "LoopComposeInput": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string"
          },
          "steps": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopObject"
            }
          },
          "artifact_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "metrics": {
            "$ref": "#/$defs/LoopObject"
          }
        },
        "required": [
          "question",
          "steps",
          "artifact_ids",
          "metrics"
        ],
        "additionalProperties": false
      },
      "LoopComposeOutput": {
        "type": "object",
        "properties": {
          "blocks": {
            "$ref": "#/$defs/LoopBlocks"
          }
        },
        "required": [
          "blocks"
        ],
        "additionalProperties": false
      },
      "LoopArtifact": {
        "type": "object",
        "properties": {
          "inquiry_id": {
            "type": "string"
          },
          "snapshot_refs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "data_kind": {
            "enum": [
              "observed",
              "derived",
              "estimated",
              "synthetic"
            ]
          },
          "availability": {
            "$ref": "#/$defs/LoopAvailability"
          },
          "question": {
            "type": "string"
          },
          "spec": {
            "$ref": "#/$defs/LoopSpec"
          },
          "caption": {
            "type": "string"
          },
          "kind": {
            "enum": [
              "chart",
              "table",
              "markdown"
            ]
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300
          },
          "content": {
            "$ref": "#/$defs/LoopObject"
          },
          "run_id": {
            "type": "string"
          }
        },
        "required": [
          "inquiry_id",
          "snapshot_refs",
          "data_kind",
          "availability",
          "question",
          "spec",
          "caption",
          "kind",
          "title",
          "content"
        ],
        "additionalProperties": false
      },
      "LoopMetric": {
        "type": "object",
        "properties": {
          "value": {
            "type": [
              "number",
              "null"
            ]
          },
          "unit": {
            "type": "string",
            "minLength": 1
          },
          "status": {
            "enum": [
              "ok",
              "insufficient",
              "not_applicable"
            ]
          },
          "note": {
            "type": "string"
          }
        },
        "required": [
          "value",
          "unit",
          "status"
        ],
        "additionalProperties": false
      },
      "LoopMetrics": {
        "type": "object",
        "additionalProperties": {
          "$ref": "#/$defs/LoopMetric"
        }
      },
      "LoopAnalysisOutput": {
        "type": "object",
        "properties": {
          "analysis": {
            "$ref": "#/$defs/LoopObject"
          },
          "metrics": {
            "$ref": "#/$defs/LoopMetrics"
          }
        },
        "required": [
          "analysis",
          "metrics"
        ],
        "additionalProperties": false
      },
      "LoopCompileOutput": {
        "type": "object",
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "ir": {
            "type": [
              "object",
              "null"
            ]
          },
          "checks": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopObject"
            }
          }
        },
        "required": [
          "ok",
          "ir",
          "checks"
        ],
        "additionalProperties": {
          "$ref": "#/$defs/LoopJson"
        }
      },
      "LoopBacktestOutput": {
        "type": "object",
        "properties": {
          "run_id": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "closed_trades": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0
          },
          "metrics": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/LoopObject"
            }
          }
        },
        "required": [
          "run_id",
          "status"
        ],
        "additionalProperties": false
      },
      "LoopRenderOutput": {
        "type": "object",
        "properties": {
          "artifact_id": {
            "type": "string"
          }
        },
        "required": [
          "artifact_id"
        ],
        "additionalProperties": false
      },
      "LoopRevisionCommand": {
        "type": "object",
        "properties": {
          "mode": {
            "enum": [
              "revise",
              "optimize",
              "rerun"
            ]
          },
          "baseline_run_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "instruction": {
            "type": "string",
            "minLength": 1,
            "maxLength": 20000
          },
          "max_candidates": {
            "type": "integer",
            "minimum": 1,
            "maximum": 2
          },
          "execution_overrides": {
            "type": "object",
            "properties": {
              "initial_cash": {
                "type": "string",
                "pattern": "^\\d+(\\.\\d+)?$",
                "maxLength": 30
              },
              "fee_rate": {
                "type": "string",
                "pattern": "^\\d+(\\.\\d+)?$",
                "maxLength": 30
              },
              "slippage_bps": {
                "type": "string",
                "pattern": "^\\d+(\\.\\d+)?$",
                "maxLength": 30
              },
              "risk_fraction": {
                "type": "string",
                "pattern": "^\\d+(\\.\\d+)?$",
                "maxLength": 30
              },
              "max_allocation": {
                "type": "string",
                "pattern": "^\\d+(\\.\\d+)?$",
                "maxLength": 30
              }
            },
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "mode",
          "baseline_run_id",
          "instruction",
          "max_candidates"
        ],
        "additionalProperties": false
      },
      "LoopRunInput": {
        "type": "object",
        "properties": {
          "run_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          }
        },
        "required": [
          "run_id"
        ],
        "additionalProperties": false
      },
      "LoopRevisionCompileInput": {
        "type": "object",
        "properties": {
          "baseline_run_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "instruction": {
            "type": "string",
            "minLength": 1,
            "maxLength": 20000
          },
          "candidate_index": {
            "type": "integer",
            "minimum": 1,
            "maximum": 2
          }
        },
        "required": [
          "baseline_run_id",
          "instruction",
          "candidate_index"
        ],
        "additionalProperties": false
      },
      "LoopRevisionRunInput": {
        "type": "object",
        "properties": {
          "baseline_run_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "draft_artifact_id": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "baseline_run_id",
          "draft_artifact_id"
        ],
        "additionalProperties": false
      },
      "LoopRunPairInput": {
        "type": "object",
        "properties": {
          "baseline_run_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "candidate_run_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          }
        },
        "required": [
          "baseline_run_id",
          "candidate_run_id"
        ],
        "additionalProperties": false
      },
      "LoopAcquireInput": {
        "type": "object",
        "properties": {
          "concept": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "category": {
            "$ref": "#/$defs/LoopConceptCategory"
          },
          "question": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "required": [
          "concept"
        ],
        "additionalProperties": false
      },
      "LoopAcquireOutput": {
        "type": "object",
        "properties": {
          "concept": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "definition": {
            "type": "string",
            "maxLength": 4000
          },
          "implementation": {
            "type": "object",
            "properties": {
              "kind": {
                "enum": [
                  "primitive",
                  "indicator_row",
                  "pine",
                  "unsupported"
                ]
              },
              "target": {
                "type": [
                  "string",
                  "null"
                ],
                "maxLength": 200
              },
              "params": {
                "anyOf": [
                  {
                    "$ref": "#/$defs/LoopObject"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "expression": {
                "type": [
                  "string",
                  "null"
                ],
                "maxLength": 4000
              },
              "note": {
                "type": "string",
                "maxLength": 4000
              }
            },
            "required": [
              "kind",
              "target",
              "params",
              "expression",
              "note"
            ],
            "additionalProperties": false
          },
          "provenance": {
            "type": "object",
            "properties": {
              "source": {
                "enum": [
                  "lexicon",
                  "brain",
                  "web"
                ]
              },
              "detail": {
                "type": "string",
                "maxLength": 500
              },
              "retrieved_at": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "source",
              "detail",
              "retrieved_at"
            ],
            "additionalProperties": false
          },
          "concept_status": {
            "$ref": "#/$defs/LoopConcept"
          },
          "tried_sources": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "maxItems": 10
          },
          "offline_sources": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "maxItems": 10
          }
        },
        "required": [
          "concept",
          "definition",
          "implementation",
          "provenance",
          "concept_status",
          "tried_sources",
          "offline_sources"
        ],
        "additionalProperties": false
      },
      "LoopPatternInput": {
        "type": "object",
        "properties": {
          "price_snapshot": {
            "type": "string",
            "minLength": 1
          },
          "primitive": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "params": {
            "$ref": "#/$defs/LoopObject"
          },
          "horizon_bars": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500
          },
          "label": {
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "price_snapshot",
          "primitive",
          "horizon_bars"
        ],
        "additionalProperties": false
      }
    }
  },
  "research-orders": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.local/schema/research-orders.json",
    "title": "ResearchOrders",
    "anyOf": [
      {
        "$ref": "#/$defs/BacktestReplay"
      },
      {
        "$ref": "#/$defs/BacktestPlan"
      }
    ],
    "$defs": {
      "OrderSide": {
        "enum": [
          "long",
          "short"
        ]
      },
      "OrderMarket": {
        "enum": [
          "spot",
          "perp"
        ]
      },
      "OrderEntryType": {
        "enum": [
          "market",
          "limit"
        ]
      },
      "OrderPlanStatus": {
        "enum": [
          "pending",
          "filled",
          "no_fill",
          "replaced",
          "cancelled",
          "blocked"
        ],
        "description": "pending=挂单中(数据末仍在时效内);filled=已成交(看 exit);no_fill=时效内未触价;replaced=成交前被同向新计划整体替换(8794 v8);cancelled=成交前被反向计划撤销或跳空使止损/止盈失效;blocked=放置前盈亏比低于 min_rr 或无有效止损,没下单(只进统计与回放,不影响净值)"
      },
      "OrderExitReason": {
        "enum": [
          "tp",
          "sl",
          "trail",
          "signal_exit",
          "time",
          "rolled",
          "flipped",
          "liquidation",
          "breakeven",
          "end_of_data",
          "open"
        ]
      },
      "OrderLevelSource": {
        "enum": [
          "structure_support",
          "structure_resistance",
          "atr",
          "rr",
          "indicator",
          "fixed_pct",
          "user",
          "trail"
        ]
      },
      "BacktestPlanLevel": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "price": {
            "type": "number"
          },
          "size_pct": {
            "type": "number",
            "description": "该档占计划仓位的比例,小数(0.5=50%);止损档恒为 1"
          },
          "source": {
            "$ref": "#/$defs/OrderLevelSource"
          },
          "note": {
            "type": "string",
            "maxLength": 4000
          },
          "filled_at": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "fill_price": {
            "type": [
              "number",
              "null"
            ]
          }
        },
        "required": [
          "price",
          "size_pct",
          "source",
          "note",
          "filled_at",
          "fill_price"
        ]
      },
      "BacktestPlanEventKind": {
        "enum": [
          "placed",
          "filled",
          "no_fill",
          "replaced",
          "stop_moved",
          "tp_moved",
          "tp_hit",
          "sl_hit",
          "rolled_in",
          "rolled_out",
          "added",
          "flipped",
          "liquidated",
          "funding",
          "closed",
          "cancelled",
          "blocked"
        ]
      },
      "BacktestPlanEvent": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "kind": {
            "$ref": "#/$defs/BacktestPlanEventKind"
          },
          "price": {
            "type": [
              "number",
              "null"
            ]
          },
          "note": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "required": [
          "at",
          "kind",
          "price",
          "note"
        ]
      },
      "BacktestPlanLeg": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "price": {
            "type": "number"
          },
          "qty_frac": {
            "type": "number"
          }
        },
        "required": [
          "at",
          "price",
          "qty_frac"
        ]
      },
      "BacktestPlanExit": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "price": {
            "type": "number"
          },
          "reason": {
            "$ref": "#/$defs/OrderExitReason"
          }
        },
        "required": [
          "at",
          "price",
          "reason"
        ]
      },
      "BacktestPricePoint": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "price": {
            "type": "number"
          }
        },
        "required": [
          "at",
          "price"
        ]
      },
      "BacktestPlan": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 4000
          },
          "symbol": {
            "type": "string",
            "maxLength": 4000
          },
          "side": {
            "$ref": "#/$defs/OrderSide"
          },
          "market": {
            "$ref": "#/$defs/OrderMarket"
          },
          "leverage": {
            "type": "number"
          },
          "placed_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "reason": {
            "type": "string",
            "maxLength": 4000
          },
          "entry_type": {
            "$ref": "#/$defs/OrderEntryType"
          },
          "entry_price": {
            "type": [
              "number",
              "null"
            ],
            "description": "限价单的挂单价;市价单为 null"
          },
          "reference_price": {
            "type": "number",
            "description": "信号那根的收盘价"
          },
          "expires_at": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "status": {
            "$ref": "#/$defs/OrderPlanStatus"
          },
          "filled_at": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "fill_price": {
            "type": [
              "number",
              "null"
            ],
            "description": "首腿成交价(含滑点);rolled_in 计划为结转价(下一根 open)"
          },
          "fill_gap": {
            "type": "boolean"
          },
          "legs": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestPlanLeg"
            },
            "maxItems": 50,
            "description": "入场腿;qty_frac 为相对首腿的数量比例(等权加仓=1)"
          },
          "stop": {
            "anyOf": [
              {
                "$ref": "#/$defs/BacktestPlanLevel"
              },
              {
                "type": "null"
              }
            ],
            "description": "初始止损(放置时);移动见 stop_path"
          },
          "take_profits": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestPlanLevel"
            },
            "maxItems": 10
          },
          "stop_path": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestPricePoint"
            },
            "maxItems": 5000
          },
          "planned_rr": {
            "type": [
              "number",
              "null"
            ],
            "description": "放置时:按档位加权的止盈距离 / 止损距离,以限价(市价单用信号收盘价)为锚"
          },
          "min_rr": {
            "type": [
              "number",
              "null"
            ],
            "description": "本计划适用的最小盈亏比(用户硬约束优先,否则规范默认);planned_rr 低于它 → status=blocked"
          },
          "exit": {
            "anyOf": [
              {
                "$ref": "#/$defs/BacktestPlanExit"
              },
              {
                "type": "null"
              }
            ]
          },
          "pnl_pct": {
            "type": [
              "number",
              "null"
            ],
            "description": "净收益 / 计划占用保证金,小数(0.0143=1.43%);含杠杆、手续费、已知资金费。现货杠杆 1 时即名义收益"
          },
          "r_multiple": {
            "type": [
              "number",
              "null"
            ],
            "description": "8794 口径:(加权出场价-均价)×方向 / |均价-初始止损|,毛价格 R,不含费用与杠杆;无止损为 null"
          },
          "mfe_pct": {
            "type": [
              "number",
              "null"
            ],
            "description": "8794 v11 口径:成交根到出场根(含)逐根恰好计一次,锚定最终均价,不含杠杆,小数,恒 ≥0"
          },
          "mae_pct": {
            "type": [
              "number",
              "null"
            ],
            "description": "同 mfe_pct,恒 ≤0"
          },
          "funding_pct": {
            "type": [
              "number",
              "null"
            ],
            "description": "资金费对本计划的净影响 / 保证金,小数,正=收到、负=支付;现货或资金费序列缺失时为 null(不当 0)"
          },
          "fees_pct": {
            "type": "number",
            "description": "手续费合计 / 保证金,小数,恒 ≥0;rolled 结转不重复收费"
          },
          "bars_held": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "成交根到出场根的根数差"
          },
          "rolled_from": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "rolled_to": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "replaced_by": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "segment": {
            "$ref": "research-backtest.json#/$defs/BacktestSegmentName"
          },
          "events": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestPlanEvent"
            },
            "maxItems": 500
          },
          "price_move_pct": {
            "type": [
              "number",
              "null"
            ],
            "description": "不含杠杆与费用的价格变动:(加权出场价-均价)×方向/均价,小数;与 8794 的 pnl_pct(÷100)同口径"
          },
          "gross_pct": {
            "type": [
              "number",
              "null"
            ],
            "description": "毛收益 / 保证金(含杠杆,不含费用与资金费),小数"
          },
          "funding_status": {
            "enum": [
              "complete",
              "partial",
              "missing",
              "not_applicable"
            ],
            "description": "本计划持仓区间的资金费覆盖:complete=序列覆盖整段;partial=只覆盖一部分(已知期已计入);missing=没有序列(funding_pct=null);not_applicable=现货"
          },
          "funding_periods": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "已计入的资金费期数"
          },
          "liquidation_price": {
            "type": [
              "number",
              "null"
            ],
            "description": "逐仓强平价(按均价、杠杆与维持保证金率);现货为 null"
          },
          "qty": {
            "type": "number",
            "description": "合计成交数量(base)"
          },
          "margin": {
            "type": "number",
            "description": "计划占用保证金(报价币),pnl_pct 的分母"
          },
          "entry_source": {
            "anyOf": [
              {
                "$ref": "#/$defs/OrderLevelSource"
              },
              {
                "type": "null"
              }
            ],
            "description": "限价来源;市价单为 null"
          },
          "blocked_reason": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000,
            "description": "status=blocked/cancelled 的原因代码(min_rr/no_target/no_stop/stop_side/stop_too_close/target_side/gap_invalidated/opposite_signal);stop_too_close=止损离入场不到 min_stop_atr×ATR(14)(结构口径)"
          }
        },
        "required": [
          "id",
          "symbol",
          "side",
          "market",
          "leverage",
          "placed_at",
          "reason",
          "entry_type",
          "entry_price",
          "reference_price",
          "expires_at",
          "status",
          "filled_at",
          "fill_price",
          "fill_gap",
          "legs",
          "stop",
          "take_profits",
          "stop_path",
          "planned_rr",
          "min_rr",
          "exit",
          "pnl_pct",
          "r_multiple",
          "mfe_pct",
          "mae_pct",
          "funding_pct",
          "fees_pct",
          "bars_held",
          "rolled_from",
          "rolled_to",
          "replaced_by",
          "segment",
          "events"
        ]
      },
      "BacktestCandle": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "t": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "o": {
            "type": "number"
          },
          "h": {
            "type": "number"
          },
          "l": {
            "type": "number"
          },
          "c": {
            "type": "number"
          },
          "v": {
            "type": "number"
          }
        },
        "required": [
          "t",
          "o",
          "h",
          "l",
          "c",
          "v"
        ]
      },
      "BacktestReplay": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "report_id": {
            "type": "string",
            "maxLength": 4000
          },
          "asset_key": {
            "type": "string",
            "maxLength": 4000
          },
          "symbol": {
            "type": "string",
            "maxLength": 4000
          },
          "timeframe": {
            "type": "string",
            "maxLength": 4000
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "truncated": {
            "type": "boolean"
          },
          "candles": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestCandle"
            },
            "maxItems": 20000
          },
          "plans": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BacktestPlan"
            },
            "maxItems": 20000
          }
        },
        "required": [
          "report_id",
          "asset_key",
          "symbol",
          "timeframe",
          "from_ms",
          "to_ms",
          "truncated",
          "candles",
          "plans"
        ]
      },
      "BacktestPlanStats": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "placed": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "真正挂出的计划数(不含 blocked)"
          },
          "filled": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "no_fill": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "replaced": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "rolled": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "added": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "成交的加仓腿数"
          },
          "flipped": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "liquidated": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "fill_rate": {
            "type": [
              "number",
              "null"
            ],
            "description": "filled / (filled + no_fill):只算走完时效的计划;replaced/cancelled/blocked/pending 不进分母"
          },
          "avg_planned_rr": {
            "type": [
              "number",
              "null"
            ]
          },
          "avg_realized_r": {
            "type": [
              "number",
              "null"
            ]
          },
          "tp_hit_rate": {
            "type": [
              "number",
              "null"
            ],
            "description": "已结算计划中至少命中一档止盈的比例"
          },
          "sl_hit_rate": {
            "type": [
              "number",
              "null"
            ],
            "description": "已结算计划中以止损(含 trail/breakeven 之外的初始或移动止损)离场的比例"
          },
          "blocked": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "放置前被 min_rr / 无止损拦下的计划数"
          },
          "blocked_by": {
            "type": "object",
            "additionalProperties": {
              "type": "integer",
              "minimum": 0
            },
            "description": "被拦计划按原因计数(research-orders-v2 起;含超出行数上限只计数的部分)"
          },
          "ignored": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "已成交时同向新信号按 ignore(或加仓已满)丢弃的次数"
          },
          "cancelled": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "成交前被撤销(反向信号/跳空失效)"
          },
          "pending": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "数据末仍挂着的计划数"
          },
          "breakeven": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "保本离场数"
          },
          "funding_missing": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "永续计划里资金费缺失或部分缺失的计划数"
          },
          "funding_pnl": {
            "type": [
              "number",
              "null"
            ],
            "description": "永续计划资金费现金合计(报价币),正=收到、负=支付;现货或资金费全缺时为 null"
          },
          "funding_periods": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991,
            "description": "永续计划计入的资金费期数合计"
          },
          "liquidation_loss": {
            "type": [
              "number",
              "null"
            ],
            "description": "强平计划的净亏损合计(报价币,≤0);没有强平为 null"
          }
        },
        "required": [
          "placed",
          "filled",
          "no_fill",
          "replaced",
          "rolled",
          "added",
          "flipped",
          "liquidated",
          "fill_rate",
          "avg_planned_rr",
          "avg_realized_r",
          "tp_hit_rate",
          "sl_hit_rate"
        ]
      }
    }
  },
  "research-strategy": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.local/schema/research-strategy.json",
    "title": "ResearchStrategyObject",
    "anyOf": [
      {
        "$ref": "#/$defs/ResearchStrategyList"
      },
      {
        "$ref": "#/$defs/ResearchStrategyDetail"
      }
    ],
    "$defs": {
      "ResearchStrategyStatus": {
        "enum": [
          "draft",
          "backtested",
          "paper",
          "live",
          "published",
          "archived"
        ]
      },
      "ResearchStrategyOrigin": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "session_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "inquiry_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "source": {
            "enum": [
              "research_loop",
              "manual",
              "import"
            ]
          }
        },
        "required": [
          "session_id",
          "inquiry_id",
          "source"
        ]
      },
      "ResearchStrategySummary": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "total_return": {
            "type": [
              "number",
              "null"
            ]
          },
          "sharpe": {
            "type": [
              "number",
              "null"
            ]
          },
          "max_drawdown": {
            "type": [
              "number",
              "null"
            ]
          },
          "win_rate": {
            "type": [
              "number",
              "null"
            ]
          },
          "trades": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "score": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "score_label": {
            "anyOf": [
              {
                "$ref": "research-backtest.json#/$defs/BacktestScoreLabel"
              },
              {
                "type": "null"
              }
            ]
          },
          "sparkline": {
            "type": "array",
            "items": {
              "type": "number"
            },
            "maxItems": 200
          },
          "report_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "backtested_at": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "total_return",
          "sharpe",
          "max_drawdown",
          "win_rate",
          "trades",
          "score",
          "score_label",
          "sparkline",
          "report_id",
          "backtested_at"
        ]
      },
      "ResearchStrategy": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 4000
          },
          "name": {
            "type": "string",
            "maxLength": 4000
          },
          "description": {
            "type": "string",
            "maxLength": 4000
          },
          "status": {
            "$ref": "#/$defs/ResearchStrategyStatus"
          },
          "symbol": {
            "type": "string",
            "maxLength": 4000
          },
          "timeframe": {
            "type": "string",
            "maxLength": 4000
          },
          "watchlist": {
            "type": "boolean"
          },
          "alerts": {
            "type": "boolean"
          },
          "current_version": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "created_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "updated_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "origin": {
            "$ref": "#/$defs/ResearchStrategyOrigin"
          },
          "summary": {
            "anyOf": [
              {
                "$ref": "#/$defs/ResearchStrategySummary"
              },
              {
                "type": "null"
              }
            ]
          },
          "lab_strategy_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "published_listing_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          },
          "session_bound": {
            "description": "经 attach-session 绑定到研究会话:该会话后续回测报告都挂到这条策略",
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "name",
          "description",
          "status",
          "symbol",
          "timeframe",
          "watchlist",
          "alerts",
          "current_version",
          "created_at",
          "updated_at",
          "origin",
          "summary",
          "lab_strategy_id",
          "published_listing_id"
        ]
      },
      "ResearchStrategyVersion": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "strategy_id": {
            "type": "string",
            "maxLength": 4000
          },
          "version": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "ir_hash": {
            "type": "string",
            "maxLength": 4000
          },
          "strategy_ir": {
            "anyOf": [
              {
                "$ref": "research.json#/$defs/StrategyIR"
              },
              {
                "type": "null"
              }
            ]
          },
          "note": {
            "type": "string",
            "maxLength": 4000
          },
          "created_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "report_ids": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 4000
            },
            "maxItems": 500
          },
          "run_ids": {
            "description": "「策略 → 版本 → run」链:该版本回测报告引用的 research_runs.id,以及 manifest.request.strategy_ir 同哈希的 run",
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 4000
            },
            "maxItems": 500
          },
          "revision_refs": {
            "description": "研究 loop 修订草稿(research_artifacts 里 view=strategy_draft 且 IR 同哈希)的 artifact id",
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 4000
            },
            "maxItems": 200
          },
          "lab_strategy_ref": {
            "description": "该版本所用 run 的 source_strategy(交易侧 lab 策略库 id@version),只读留痕",
            "type": [
              "string",
              "null"
            ],
            "maxLength": 4000
          }
        },
        "required": [
          "strategy_id",
          "version",
          "ir_hash",
          "strategy_ir",
          "note",
          "created_at",
          "report_ids"
        ]
      },
      "ResearchStrategyEventKind": {
        "enum": [
          "created",
          "version_added",
          "backtested",
          "transition",
          "renamed",
          "flag_changed",
          "archived",
          "session_attached"
        ]
      },
      "ResearchStrategyEvent": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "kind": {
            "$ref": "#/$defs/ResearchStrategyEventKind"
          },
          "from": {
            "anyOf": [
              {
                "$ref": "#/$defs/ResearchStrategyStatus"
              },
              {
                "type": "null"
              }
            ]
          },
          "to": {
            "anyOf": [
              {
                "$ref": "#/$defs/ResearchStrategyStatus"
              },
              {
                "type": "null"
              }
            ]
          },
          "version": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "note": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "required": [
          "at",
          "kind",
          "from",
          "to",
          "version",
          "note"
        ]
      },
      "ResearchStrategyCounts": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "all": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "live": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "watchlist": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "alerts": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "draft": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "all",
          "live",
          "watchlist",
          "alerts",
          "draft"
        ]
      },
      "ResearchStrategyList": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "strategies": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchStrategy"
            },
            "maxItems": 5000
          },
          "counts": {
            "$ref": "#/$defs/ResearchStrategyCounts"
          }
        },
        "required": [
          "strategies",
          "counts"
        ]
      },
      "ResearchStrategyDetail": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "strategy": {
            "$ref": "#/$defs/ResearchStrategy"
          },
          "versions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchStrategyVersion"
            },
            "maxItems": 1000
          },
          "report": {
            "anyOf": [
              {
                "$ref": "research-backtest.json#/$defs/BacktestReport"
              },
              {
                "type": "null"
              }
            ]
          },
          "reports": {
            "type": "array",
            "items": {
              "$ref": "research-backtest.json#/$defs/BacktestReportSummary"
            },
            "maxItems": 500
          },
          "events": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchStrategyEvent"
            },
            "maxItems": 2000
          },
          "allowed_transitions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchStrategyStatus"
            },
            "maxItems": 8
          }
        },
        "required": [
          "strategy",
          "versions",
          "report",
          "reports",
          "events",
          "allowed_transitions"
        ]
      },
      "ResearchStrategyCreate": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "name": {
            "type": "string",
            "maxLength": 4000
          },
          "description": {
            "type": "string",
            "maxLength": 4000
          },
          "symbol": {
            "type": "string",
            "maxLength": 4000
          },
          "timeframe": {
            "type": "string",
            "maxLength": 4000
          },
          "strategy_ir": {
            "$ref": "research.json#/$defs/StrategyIR"
          }
        },
        "required": [
          "name"
        ]
      },
      "ResearchStrategyPatch": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "name": {
            "type": "string",
            "maxLength": 4000
          },
          "description": {
            "type": "string",
            "maxLength": 4000
          },
          "watchlist": {
            "type": "boolean"
          },
          "alerts": {
            "type": "boolean"
          }
        },
        "required": []
      },
      "ResearchStrategyTransition": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "to": {
            "$ref": "#/$defs/ResearchStrategyStatus"
          },
          "confirm": {
            "type": "string",
            "maxLength": 64
          },
          "note": {
            "type": "string",
            "maxLength": 4000
          }
        },
        "required": [
          "to"
        ]
      },
      "ResearchStrategyBacktestRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "version": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "symbols": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 4000
            },
            "maxItems": 8
          },
          "timeframe": {
            "type": "string",
            "maxLength": 4000
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": []
      },
      "ResearchStrategyAttachSession": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "session_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000
          }
        },
        "required": [
          "session_id"
        ]
      }
    }
  },
  "research": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.local/schema/research.json",
    "title": "ResearchContract",
    "oneOf": [
      {
        "$ref": "#/$defs/ResearchRequest"
      },
      {
        "$ref": "#/$defs/ResearchDataset"
      },
      {
        "$ref": "#/$defs/ResearchFilterDecision"
      },
      {
        "$ref": "#/$defs/ResearchChatRequest"
      },
      {
        "$ref": "#/$defs/ResearchToolCall"
      },
      {
        "$ref": "#/$defs/ResearchStudy"
      },
      {
        "$ref": "#/$defs/ResearchPolicy"
      },
      {
        "$ref": "#/$defs/ResearchUniverseRequest"
      },
      {
        "$ref": "#/$defs/ResearchUniverse"
      },
      {
        "$ref": "#/$defs/ResearchScreen"
      },
      {
        "$ref": "#/$defs/ResearchFactorResult"
      },
      {
        "$ref": "#/$defs/ResearchTrend"
      },
      {
        "$ref": "#/$defs/StrategyIR"
      },
      {
        "$ref": "#/$defs/StrategyCompileRequest"
      },
      {
        "$ref": "#/$defs/StrategyCompileResult"
      },
      {
        "$ref": "#/$defs/ResearchAttribution"
      },
      {
        "$ref": "#/$defs/ResearchRecordedDecision"
      },
      {
        "$ref": "#/$defs/ResearchPrecheckRequest"
      }
    ],
    "$defs": {
      "ResearchBar": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "open_time": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "close_time": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "available_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "open": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "high": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "low": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "close": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "volume": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          }
        },
        "required": [
          "open_time",
          "close_time",
          "available_at",
          "open",
          "high",
          "low",
          "close",
          "volume"
        ]
      },
      "ResearchDataset": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "venue": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_]{1,40}$"
          },
          "market": {
            "type": "string",
            "enum": [
              "spot",
              "perp"
            ],
            "description": "perp = OKX USDT 线性永续成交价 K 线(研究回测永续路径,symbol 用 BTC-USDT-SWAP 形式,不与现货数据集混用)"
          },
          "symbol": {
            "type": "string",
            "maxLength": 60
          },
          "timeframe_ms": {
            "type": "integer",
            "minimum": 60000,
            "maximum": 86400000
          },
          "source": {
            "type": "string",
            "maxLength": 2000
          },
          "retrieved_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "bars": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchBar"
            },
            "maxItems": 50000
          },
          "calendar": {
            "enum": [
              "crypto_24_7",
              "us_equity_rth"
            ]
          },
          "adjusted": {
            "type": "boolean"
          },
          "risk_free_per_bar": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$"
          }
        },
        "required": [
          "venue",
          "market",
          "symbol",
          "timeframe_ms",
          "source",
          "retrieved_at",
          "bars"
        ]
      },
      "ResearchPolicy": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "label": {
            "type": "string",
            "maxLength": 120
          },
          "description": {
            "type": "string",
            "maxLength": 6000
          },
          "interpretation": {
            "type": "string",
            "enum": [
              "donchian_close_long_v1"
            ]
          },
          "lookback": {
            "type": "integer",
            "minimum": 2,
            "maximum": 400
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 100
          },
          "stop_atr": {
            "type": "number",
            "exclusiveMinimum": 0,
            "maximum": 20
          },
          "take_profit_r": {
            "type": "number",
            "exclusiveMinimum": 0,
            "maximum": 20
          },
          "volume_multiple": {
            "type": "number",
            "minimum": 0,
            "maximum": 20
          },
          "holding_bars": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500
          }
        },
        "required": [
          "label",
          "description",
          "interpretation",
          "lookback",
          "atr_period",
          "stop_atr",
          "take_profit_r",
          "volume_multiple",
          "holding_bars"
        ]
      },
      "ResearchExecution": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "initial_cash": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "risk_fraction": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "max_allocation": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "fee_rate": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "slippage_bps": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "qty_step": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "min_notional": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "max_opens_per_day": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "max_positions": {
            "type": "integer",
            "minimum": 1,
            "maximum": 30,
            "default": 3
          },
          "allocation": {
            "enum": [
              "equal_risk",
              "equal_notional"
            ],
            "default": "equal_risk"
          },
          "sizing_mode": {
            "type": "string",
            "enum": [
              "unit_notional",
              "risk_fraction"
            ]
          }
        },
        "required": [
          "initial_cash",
          "risk_fraction",
          "max_allocation",
          "fee_rate",
          "slippage_bps",
          "qty_step",
          "min_notional",
          "max_opens_per_day"
        ]
      },
      "ResearchRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "idempotency_key": {
            "type": "string",
            "maxLength": 120
          },
          "dataset_id": {
            "type": "string",
            "maxLength": 80
          },
          "source_strategy_ref": {
            "type": "string",
            "maxLength": 120
          },
          "policy": {
            "$ref": "#/$defs/ResearchPolicy"
          },
          "execution": {
            "$ref": "#/$defs/ResearchExecution"
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "arms": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "a_rules",
                "b_agent",
                "c_filter"
              ]
            },
            "minItems": 1,
            "maxItems": 3,
            "uniqueItems": true
          },
          "repeats": {
            "type": "integer",
            "minimum": 1,
            "maximum": 5
          },
          "max_model_calls": {
            "type": "integer",
            "minimum": 0,
            "maximum": 5000
          },
          "timeout_ms": {
            "type": "integer",
            "minimum": 1000,
            "maximum": 3600000
          },
          "purpose": {
            "type": "string",
            "enum": [
              "development",
              "validation",
              "holdout"
            ]
          },
          "study_id": {
            "type": "string",
            "maxLength": 120
          },
          "parent_run_id": {
            "type": "string",
            "maxLength": 120
          },
          "acknowledge_adaptive_search": {
            "type": "boolean"
          },
          "universe_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "model_call_timeout_ms": {
            "type": "integer",
            "minimum": 1,
            "maximum": 300000,
            "default": 120000
          },
          "strategy_ir": {
            "$ref": "#/$defs/StrategyIR"
          },
          "order_gate": {
            "$ref": "#/$defs/OrderGateParams"
          },
          "precheck_overrides": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "maxItems": 20
          },
          "shortlist": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "top_n": {
                "type": "integer",
                "minimum": 1,
                "maximum": 500
              },
              "by": {
                "enum": [
                  "composite",
                  "residual_sharpe"
                ]
              }
            },
            "required": [
              "top_n",
              "by"
            ]
          },
          "spec_version": {
            "type": "string",
            "maxLength": 40
          }
        },
        "required": [
          "idempotency_key",
          "execution",
          "from_ms",
          "to_ms",
          "arms",
          "repeats",
          "max_model_calls",
          "timeout_ms",
          "purpose",
          "study_id",
          "acknowledge_adaptive_search"
        ],
        "allOf": [
          {
            "oneOf": [
              {
                "required": [
                  "dataset_id"
                ]
              },
              {
                "required": [
                  "universe_id"
                ]
              }
            ]
          },
          {
            "oneOf": [
              {
                "required": [
                  "policy"
                ]
              },
              {
                "required": [
                  "strategy_ir"
                ]
              }
            ]
          }
        ]
      },
      "ResearchFilterDecision": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "action": {
            "type": "string",
            "enum": [
              "follow",
              "skip"
            ]
          },
          "reason": {
            "type": "string",
            "maxLength": 2000
          },
          "evidence_refs": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 80
            },
            "maxItems": 30,
            "minItems": 1
          }
        },
        "required": [
          "action",
          "reason",
          "evidence_refs"
        ]
      },
      "ResearchEquity": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "cash": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "holdings": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "equity": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "exposure": {
            "type": "number"
          },
          "drawdown": {
            "type": "number"
          },
          "by_symbol": {
            "type": "object",
            "additionalProperties": {
              "type": "string",
              "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
              "maxLength": 32
            }
          }
        },
        "required": [
          "at",
          "cash",
          "holdings",
          "equity",
          "exposure",
          "drawdown"
        ]
      },
      "ResearchTrade": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 120
          },
          "candidate_id": {
            "type": "string",
            "maxLength": 120
          },
          "entry_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "exit_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "entry_price": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "exit_price": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "qty": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "gross_pnl": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "fees": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "net_pnl": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "initial_risk": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "net_r": {
            "type": [
              "number",
              "null"
            ]
          },
          "reason": {
            "type": "string",
            "enum": [
              "stop",
              "target",
              "agent_exit",
              "agent_reduce",
              "horizon",
              "trend_break",
              "time_stop",
              "fixed_r_target",
              "chandelier_trail",
              "swing_structure_stop",
              "breakeven_after_r",
              "trail",
              "structure",
              "breakeven",
              "time"
            ]
          },
          "timing": {
            "type": "string",
            "enum": [
              "open",
              "intrabar_unknown"
            ]
          },
          "position_id": {
            "type": "string",
            "maxLength": 120
          },
          "symbol": {
            "type": "string"
          },
          "mae_r": {
            "type": [
              "number",
              "null"
            ]
          },
          "mfe_r": {
            "type": [
              "number",
              "null"
            ]
          },
          "holding_bars": {
            "type": "integer",
            "minimum": 0
          },
          "slippage_est": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "capped": {
            "type": "boolean"
          },
          "return_pct": {
            "type": "number"
          },
          "fit": {
            "$ref": "#/$defs/ResearchEntry/properties/fit"
          },
          "stop": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "target": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                "maxLength": 32
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "candidate_id",
          "entry_at",
          "exit_at",
          "entry_price",
          "exit_price",
          "qty",
          "gross_pnl",
          "fees",
          "net_pnl",
          "initial_risk",
          "net_r",
          "reason",
          "timing",
          "position_id"
        ]
      },
      "ResearchDecision": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "maxLength": 120
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "arm": {
            "type": "string",
            "maxLength": 80
          },
          "candidate_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "action": {
            "type": "string",
            "enum": [
              "enter",
              "follow",
              "skip",
              "hold",
              "exit",
              "reduce",
              "no_trade",
              "blocked",
              "model_error"
            ]
          },
          "reason": {
            "type": "string",
            "maxLength": 8000
          },
          "input_hash": {
            "type": "string",
            "maxLength": 80
          },
          "decision_hash": {
            "type": "string",
            "maxLength": 80
          },
          "evidence_refs": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 80
            },
            "maxItems": 100
          },
          "gate_errors": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 4000
            },
            "maxItems": 100
          },
          "symbol": {
            "type": "string"
          },
          "screen_rank": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1
          },
          "fit": {
            "$ref": "#/$defs/ResearchEntry/properties/fit"
          },
          "spec_violations": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 80
            },
            "maxItems": 20
          }
        },
        "required": [
          "id",
          "at",
          "arm",
          "candidate_id",
          "action",
          "reason",
          "input_hash",
          "decision_hash",
          "evidence_refs",
          "gate_errors"
        ]
      },
      "ResearchMetrics": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "net_return": {
            "type": "number"
          },
          "max_drawdown": {
            "type": "number"
          },
          "avg_exposure": {
            "type": "number"
          },
          "turnover": {
            "type": "number"
          },
          "closed_trades": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "win_rate": {
            "type": [
              "number",
              "null"
            ]
          },
          "profit_factor": {
            "type": [
              "number",
              "null"
            ]
          },
          "net_pnl": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "fees": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "open_position": {
            "type": "boolean"
          },
          "daily_sharpe": {
            "type": [
              "number",
              "null"
            ]
          },
          "sharpe_status": {
            "type": "string",
            "enum": [
              "insufficient",
              "estimated"
            ]
          },
          "avg_net_r": {
            "type": [
              "number",
              "null"
            ]
          },
          "per_trade_return_pct": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "avg": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "median": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "std": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "best": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "worst": {
                "type": [
                  "number",
                  "null"
                ]
              }
            },
            "required": [
              "avg",
              "median",
              "std",
              "best",
              "worst"
            ]
          },
          "expectancy_pct": {
            "type": [
              "number",
              "null"
            ]
          },
          "trade_return_histogram": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "bins": {
                "type": "array",
                "items": {
                  "type": "number"
                }
              },
              "counts": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 0
                }
              }
            },
            "required": [
              "bins",
              "counts"
            ]
          }
        },
        "required": [
          "net_return",
          "max_drawdown",
          "avg_exposure",
          "turnover",
          "closed_trades",
          "win_rate",
          "profit_factor",
          "net_pnl",
          "fees",
          "open_position",
          "daily_sharpe",
          "sharpe_status",
          "avg_net_r"
        ]
      },
      "ResearchArmResult": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "arm": {
            "type": "string",
            "maxLength": 80
          },
          "metrics": {
            "$ref": "#/$defs/ResearchMetrics"
          },
          "decisions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchDecision"
            },
            "maxItems": 100000
          },
          "trades": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchTrade"
            },
            "maxItems": 100000
          },
          "equity": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchEquity"
            },
            "maxItems": 100000
          },
          "pending_at_end": {
            "type": "boolean"
          },
          "by_symbol": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchSymbolResult"
            }
          },
          "diagnostics": {
            "$ref": "#/$defs/ResearchDiagnostics"
          }
        },
        "required": [
          "arm",
          "metrics",
          "decisions",
          "trades",
          "equity",
          "pending_at_end"
        ]
      },
      "ResearchEvent": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "seq": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "run_id": {
            "type": "string",
            "maxLength": 120
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "event": {
            "type": "string",
            "maxLength": 80
          },
          "data": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "required": [
          "seq",
          "run_id",
          "at",
          "event",
          "data"
        ]
      },
      "ResearchToolCall": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "tool": {
            "type": "string",
            "enum": [
              "runs.list",
              "runs.metrics",
              "runs.trades",
              "runs.decisions",
              "runs.compare",
              "policy.draft",
              "experiments.run_candidate",
              "datasets.list",
              "studies.get",
              "policies.create",
              "experiments.start",
              "strategies.compile",
              "primitives.list",
              "research.write_file",
              "research.execute",
              "research.read_file",
              "research.list_files",
              "research.register_artifact",
              "strategies.precheck"
            ]
          },
          "args": {
            "type": "object",
            "additionalProperties": true
          },
          "task": {
            "type": "string",
            "maxLength": 300
          },
          "parent_task_id": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 100
          }
        },
        "required": [
          "tool",
          "args"
        ]
      },
      "ResearchChatRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "message": {
            "type": "string",
            "maxLength": 12000
          },
          "run_id": {
            "type": "string",
            "maxLength": 120
          },
          "max_rounds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 24
          }
        },
        "required": [
          "message",
          "max_rounds"
        ]
      },
      "ResearchStudy": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "dataset_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "development_to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "validation_from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "validation_to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "holdout_from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "purge_bars": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1000
          },
          "max_trials": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1000
          }
        },
        "required": [
          "id",
          "dataset_id",
          "from_ms",
          "development_to_ms",
          "validation_from_ms",
          "validation_to_ms",
          "holdout_from_ms",
          "to_ms",
          "purge_bars",
          "max_trials"
        ]
      },
      "ResearchFactorDefinition": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": {
            "enum": [
              "btc",
              "btc_eth_capw",
              "equal_weight_universe"
            ]
          },
          "symbols": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[A-Z0-9]{5,20}$"
            },
            "minItems": 1,
            "maxItems": 500,
            "uniqueItems": true
          },
          "weights": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            }
          },
          "note": {
            "type": "string"
          }
        },
        "required": [
          "kind",
          "symbols",
          "weights"
        ]
      },
      "ResearchUniverseRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "symbols": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[A-Z0-9]{5,20}$"
            },
            "minItems": 1,
            "maxItems": 500,
            "uniqueItems": true
          },
          "timeframe": {
            "enum": [
              "1m",
              "3m",
              "5m",
              "15m",
              "30m",
              "1h",
              "2h",
              "4h",
              "6h",
              "12h",
              "1d"
            ]
          },
          "from_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "to_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "market_factor": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "enum": [
                  "btc",
                  "btc_eth_capw",
                  "equal_weight_universe"
                ]
              },
              "symbols": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^[A-Z0-9]{5,20}$"
                },
                "minItems": 1,
                "maxItems": 500,
                "uniqueItems": true
              }
            },
            "required": [
              "kind",
              "symbols"
            ]
          },
          "filter": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "exchange": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9_]{1,40}$"
              },
              "quote": {
                "type": "string",
                "pattern": "^[A-Z0-9]{2,15}$"
              },
              "min_quote_volume_30d": {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$"
              },
              "listed_before_ms": {
                "type": "integer",
                "minimum": 0
              },
              "exclude": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "maxItems": 500
              }
            },
            "required": [
              "exchange",
              "quote",
              "min_quote_volume_30d",
              "listed_before_ms",
              "exclude"
            ]
          }
        },
        "required": [
          "timeframe",
          "from_ms",
          "to_ms",
          "market_factor"
        ],
        "anyOf": [
          {
            "required": [
              "symbols"
            ]
          },
          {
            "required": [
              "filter"
            ]
          }
        ]
      },
      "ResearchUniverseMember": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "symbol": {
            "type": "string",
            "pattern": "^[A-Z0-9]{5,20}$"
          },
          "dataset_id": {
            "type": "string"
          },
          "bars": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "first_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "last_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "symbol",
          "dataset_id",
          "bars",
          "first_at",
          "last_at"
        ]
      },
      "ResearchUniverse": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string"
          },
          "timeframe_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "members": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchUniverseMember"
            },
            "maxItems": 500
          },
          "market_factor": {
            "$ref": "#/$defs/ResearchFactorDefinition"
          },
          "aligned_bars": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "first_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "last_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "retrieved_at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "aligned_close_times": {
            "type": "array",
            "items": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "missing": {
            "type": "object",
            "additionalProperties": {
              "type": "array",
              "items": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            }
          },
          "selection_as_of": {
            "type": "integer"
          },
          "selection_note": {
            "type": "string"
          },
          "filter": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "exchange": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9_]{1,40}$"
              },
              "quote": {
                "type": "string",
                "pattern": "^[A-Z0-9]{2,15}$"
              },
              "min_quote_volume_30d": {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$"
              },
              "listed_before_ms": {
                "type": "integer",
                "minimum": 0
              },
              "exclude": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "maxItems": 500
              }
            },
            "required": [
              "exchange",
              "quote",
              "min_quote_volume_30d",
              "listed_before_ms",
              "exclude"
            ]
          },
          "eligibility": {
            "type": "object",
            "additionalProperties": {
              "type": "object",
              "properties": {
                "listed_at": {
                  "type": [
                    "integer",
                    "null"
                  ]
                },
                "eligible_close_times": {
                  "type": "array",
                  "items": {
                    "type": "integer"
                  }
                }
              },
              "required": [
                "listed_at",
                "eligible_close_times"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "id",
          "timeframe_ms",
          "members",
          "market_factor",
          "aligned_bars",
          "first_at",
          "last_at",
          "retrieved_at",
          "aligned_close_times",
          "missing"
        ]
      },
      "ResearchFactorMetrics": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "total_return": {
            "type": "number"
          },
          "max_drawdown": {
            "type": "number"
          },
          "drawdown_area": {
            "type": "number"
          },
          "ulcer_index": {
            "type": "number"
          },
          "sharpe": {
            "type": [
              "number",
              "null"
            ]
          },
          "sortino": {
            "type": [
              "number",
              "null"
            ]
          },
          "information_ratio": {
            "type": [
              "number",
              "null"
            ]
          },
          "volatility": {
            "type": "number"
          }
        },
        "required": [
          "total_return",
          "max_drawdown",
          "drawdown_area",
          "ulcer_index",
          "sharpe",
          "sortino",
          "information_ratio",
          "volatility"
        ]
      },
      "ResearchFactorResult": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "status": {
            "enum": [
              "ok",
              "insufficient"
            ]
          },
          "beta": {
            "type": "number"
          },
          "alpha_per_bar": {
            "type": "number"
          },
          "alpha_annualized": {
            "type": "number"
          },
          "r2": {
            "type": "number"
          },
          "residual_returns": {
            "type": "array",
            "items": {
              "type": "number"
            }
          },
          "raw": {
            "$ref": "#/$defs/ResearchFactorMetrics"
          },
          "residual": {
            "$ref": "#/$defs/ResearchFactorMetrics"
          },
          "alpha_share": {
            "type": [
              "number",
              "null"
            ]
          },
          "beta_share": {
            "type": [
              "number",
              "null"
            ]
          },
          "rolling": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "at_index": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "beta": {
                  "type": "number"
                },
                "alpha_annualized": {
                  "type": "number"
                },
                "r2": {
                  "type": "number"
                }
              },
              "required": [
                "at_index",
                "beta",
                "alpha_annualized",
                "r2"
              ]
            }
          },
          "note": {
            "type": "string"
          }
        },
        "required": [
          "status",
          "note"
        ]
      },
      "ResearchTrend": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "state": {
            "enum": [
              "up",
              "down",
              "range"
            ]
          },
          "adx": {
            "type": "number"
          },
          "ema_slope": {
            "type": "number"
          },
          "donchian_pos": {
            "type": "number"
          },
          "htf_state": {
            "enum": [
              "up",
              "down",
              "range"
            ]
          },
          "status": {
            "enum": [
              "ok",
              "insufficient"
            ]
          }
        },
        "required": [
          "state",
          "adx",
          "ema_slope",
          "donchian_pos",
          "htf_state",
          "status"
        ]
      },
      "ResearchScreenRow": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "symbol": {
            "type": "string",
            "pattern": "^[A-Z0-9]{5,20}$"
          },
          "bars": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "status": {
            "enum": [
              "ok",
              "insufficient"
            ]
          },
          "beta": {
            "type": "number"
          },
          "alpha_annualized": {
            "type": "number"
          },
          "r2": {
            "type": "number"
          },
          "raw": {
            "$ref": "#/$defs/ResearchFactorMetrics"
          },
          "residual": {
            "$ref": "#/$defs/ResearchFactorMetrics"
          },
          "alpha_share": {
            "type": [
              "number",
              "null"
            ]
          },
          "beta_share": {
            "type": [
              "number",
              "null"
            ]
          },
          "trend": {
            "$ref": "#/$defs/ResearchTrend"
          },
          "momentum_12_1": {
            "type": [
              "number",
              "null"
            ]
          },
          "rank": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "residual_sharpe": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "alpha_share": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "composite": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "residual_sharpe",
              "alpha_share",
              "composite"
            ]
          },
          "htf_structure": {
            "$ref": "#/$defs/ResearchStructure"
          }
        },
        "required": [
          "symbol",
          "bars",
          "status",
          "trend",
          "momentum_12_1"
        ]
      },
      "ResearchScreen": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "universe_id": {
            "type": "string"
          },
          "as_of": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "window_bars": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "lookback_bars": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "market_factor": {
            "$ref": "#/$defs/ResearchFactorDefinition"
          },
          "rows": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchScreenRow"
            }
          },
          "note": {
            "type": "string"
          }
        },
        "required": [
          "universe_id",
          "as_of",
          "window_bars",
          "lookback_bars",
          "market_factor",
          "rows",
          "note"
        ]
      },
      "ResearchSymbolResult": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "symbol": {
            "type": "string"
          },
          "closed_trades": {
            "type": "integer",
            "minimum": 0
          },
          "net_pnl": {
            "type": "string",
            "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "win_rate": {
            "type": [
              "number",
              "null"
            ]
          },
          "avg_net_r": {
            "type": [
              "number",
              "null"
            ]
          },
          "contribution": {
            "type": [
              "number",
              "null"
            ]
          }
        },
        "required": [
          "symbol",
          "closed_trades",
          "net_pnl",
          "win_rate",
          "avg_net_r",
          "contribution"
        ]
      },
      "StrategyPrimitive": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "primitive": {
            "type": "string",
            "maxLength": 80
          },
          "params": {
            "type": "object",
            "additionalProperties": true
          },
          "optional": {
            "type": "boolean"
          }
        },
        "required": [
          "primitive",
          "params"
        ]
      },
      "StrategyIR": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "version": {
            "enum": [
              1,
              2
            ]
          },
          "label": {
            "type": "string",
            "maxLength": 160
          },
          "description": {
            "type": "string",
            "maxLength": 5000
          },
          "universe": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "screen": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "require_trend": {
                    "type": "array",
                    "items": {
                      "enum": [
                        "up",
                        "down",
                        "range"
                      ]
                    },
                    "maxItems": 30
                  },
                  "min_residual_sharpe": {
                    "type": "number"
                  },
                  "max_beta": {
                    "type": "number"
                  },
                  "top_n": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 30
                  }
                },
                "required": []
              }
            },
            "required": [
              "screen"
            ]
          },
          "signal": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StrategyPrimitive"
            },
            "maxItems": 30,
            "minItems": 1
          },
          "entry": {
            "$ref": "#/$defs/StrategyPrimitive"
          },
          "risk": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "stop": {
                "$ref": "#/$defs/StrategyPrimitive"
              },
              "sizing": {
                "$ref": "#/$defs/StrategyPrimitive"
              }
            },
            "required": [
              "stop",
              "sizing"
            ]
          },
          "exit": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StrategyPrimitive"
            },
            "maxItems": 30,
            "minItems": 0,
            "description": "带 order 块且给了止盈(order.take_profits)时可以为空:止损 + 多档止盈就是完整出场周期;不带 order 块时 checkIR 的 state_machine 仍要求走势跟踪出场或信号离场"
          },
          "regime": {
            "$ref": "#/$defs/StrategyPrimitive"
          },
          "compatibility": {
            "enum": [
              "donchian_close_long_v1"
            ]
          },
          "order": {
            "$ref": "#/$defs/StrategyOrder"
          },
          "judge": {
            "$ref": "#/$defs/StrategyJudge"
          }
        },
        "required": [
          "version",
          "label",
          "description",
          "signal",
          "entry",
          "risk",
          "exit"
        ],
        "allOf": [
          {
            "if": {
              "properties": {
                "version": {
                  "const": 1
                }
              }
            },
            "then": {
              "not": {
                "required": [
                  "judge"
                ]
              }
            },
            "else": {
              "required": [
                "judge",
                "order"
              ]
            }
          }
        ]
      },
      "StrategyCompileRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "text": {
            "type": "string",
            "minLength": 1,
            "maxLength": 20000
          },
          "ir": {
            "$ref": "#/$defs/StrategyIR"
          },
          "timeframe": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$"
          },
          "dataset_id": {
            "type": "string"
          },
          "execution": {
            "$ref": "#/$defs/ResearchExecution"
          },
          "order_gate": {
            "$ref": "#/$defs/OrderGateParams"
          }
        },
        "required": [
          "timeframe"
        ],
        "anyOf": [
          {
            "required": [
              "text"
            ]
          },
          {
            "required": [
              "ir"
            ]
          }
        ]
      },
      "StrategyCompileResult": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "ir": {
            "anyOf": [
              {
                "$ref": "#/$defs/StrategyIR"
              },
              {
                "type": "null"
              }
            ]
          },
          "checks": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "name": {
                  "type": "string"
                },
                "ok": {
                  "type": "boolean"
                },
                "message": {
                  "type": "string"
                }
              },
              "required": [
                "name",
                "ok"
              ]
            },
            "maxItems": 30
          },
          "ok": {
            "type": "boolean"
          },
          "hash": {
            "type": [
              "string",
              "null"
            ]
          },
          "summary": {
            "type": "string"
          },
          "unmapped": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "maxItems": 30
          },
          "constraints": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "symbol": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "timeframe": {
                "type": "string"
              },
              "round_trip_cost_pct": {
                "type": "number"
              },
              "stop_floor_pct": {
                "type": "number"
              },
              "min_rr": {
                "type": "number"
              },
              "atr_pct_median": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "min_atr_multiple": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "strategy_stop_pct_median": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "stop_fit_rate": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "note": {
                "type": "string"
              },
              "min_stop_atr": {
                "type": [
                  "number",
                  "null"
                ],
                "description": "结构口径:止损离入场不得小于该倍数×ATR(14),更近的单子不做;null/缺省=旧口径(成本下限+最小盈亏比)"
              },
              "stop_too_close_rate": {
                "type": [
                  "number",
                  "null"
                ],
                "description": "结构口径:本策略原始止损离收盘不到 min_stop_atr×ATR(14) 的信号比例(这些信号不做)"
              }
            },
            "required": [
              "symbol",
              "timeframe",
              "round_trip_cost_pct",
              "stop_floor_pct",
              "min_rr",
              "atr_pct_median",
              "min_atr_multiple",
              "strategy_stop_pct_median",
              "stop_fit_rate",
              "note"
            ]
          },
          "spec": {
            "$ref": "#/$defs/StrategySpecReport"
          },
          "rules": {
            "type": "array",
            "maxItems": 40,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "category": {
                  "type": "string",
                  "enum": [
                    "signal",
                    "entry",
                    "stop",
                    "sizing",
                    "exit",
                    "regime"
                  ]
                },
                "primitive": {
                  "type": "string",
                  "maxLength": 80
                },
                "text": {
                  "type": "string",
                  "maxLength": 1000
                },
                "optional": {
                  "type": "boolean"
                }
              },
              "required": [
                "category",
                "primitive",
                "text"
              ]
            }
          }
        },
        "required": [
          "ir",
          "checks",
          "ok",
          "hash",
          "summary",
          "unmapped"
        ]
      },
      "ResearchPrimitiveDescription": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "name": {
            "type": "string"
          },
          "category": {
            "enum": [
              "signal",
              "entry",
              "stop",
              "sizing",
              "exit",
              "regime",
              "screen"
            ]
          },
          "params_schema": {
            "type": "object",
            "additionalProperties": true
          },
          "description": {
            "type": "string"
          },
          "warmup_note": {
            "type": "string"
          }
        },
        "required": [
          "name",
          "category",
          "params_schema",
          "description",
          "warmup_note"
        ]
      },
      "PrimitiveParamsDonchianBreakout": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "lookback": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "basis": {
            "enum": [
              "close",
              "high"
            ]
          },
          "direction": {
            "enum": [
              "up",
              "down"
            ],
            "description": "up(缺省)=收盘/最高价突破此前 lookback 根最高价;down=收盘/最低价跌破此前 lookback 根最低价(做空触发,如「跌破 20 日低点」);basis=high 时向下用最低价"
          }
        },
        "required": [
          "lookback",
          "basis"
        ]
      },
      "PrimitiveParamsVolumeSurge": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "lookback": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "multiple": {
            "type": "number",
            "minimum": 0,
            "maximum": 100
          }
        },
        "required": [
          "lookback",
          "multiple"
        ]
      },
      "PrimitiveParamsEmaCross": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "fast": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "slow": {
            "type": "integer",
            "minimum": 3,
            "maximum": 5000
          }
        },
        "required": [
          "fast",
          "slow"
        ]
      },
      "PrimitiveParamsRsiThreshold": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 100
          },
          "operator": {
            "enum": [
              "above",
              "below"
            ]
          }
        },
        "required": [
          "period",
          "threshold",
          "operator"
        ]
      },
      "PrimitiveParamsHigherLowSequence": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "count": {
            "type": "integer",
            "minimum": 2,
            "maximum": 100
          }
        },
        "required": [
          "count"
        ]
      },
      "PrimitiveParamsMacdCross": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "fast": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "slow": {
            "type": "integer",
            "minimum": 3,
            "maximum": 5000
          },
          "signal": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          }
        },
        "required": [
          "fast",
          "slow",
          "signal"
        ]
      },
      "PrimitiveParamsMacdDivergence": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "fast": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "slow": {
            "type": "integer",
            "minimum": 3,
            "maximum": 5000
          },
          "signal": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          },
          "lookback": {
            "type": "integer",
            "minimum": 5,
            "maximum": 5000
          },
          "source": {
            "enum": [
              "histogram",
              "macd"
            ]
          },
          "htf": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$",
            "description": "可选(2026-09-23 夜):在高周期上判背离。按 htf 把已收盘的执行周期 K 线分桶聚成完整高周期 K 线(未收完的桶不用),背离在高周期 K 线上判,确认那根高周期 K 线收盘的执行周期 K 线当根触发;不受决策视图 5000 根上限约束。缺省 = 在执行周期上判(旧口径)"
          },
          "direction": {
            "enum": [
              "bullish",
              "bearish"
            ],
            "description": "可选(2026-09-23 夜):bullish(缺省)=底背离(价格更低的已确认 pivot low、MACD 抬高),做多触发;bearish=顶背离(价格更高的已确认 pivot high、MACD 走低),可作 short_signal 做空触发"
          }
        },
        "required": [
          "fast",
          "slow",
          "signal",
          "swing_length",
          "lookback"
        ]
      },
      "PrimitiveParamsMacdDivergenceExit": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "fast": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "slow": {
            "type": "integer",
            "minimum": 3,
            "maximum": 5000
          },
          "signal": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          },
          "lookback": {
            "type": "integer",
            "minimum": 5,
            "maximum": 5000
          },
          "source": {
            "enum": [
              "histogram",
              "macd"
            ]
          },
          "htf": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$",
            "description": "可选(2026-09-23 夜):在高周期上判背离。按 htf 把已收盘的执行周期 K 线分桶聚成完整高周期 K 线(未收完的桶不用),背离在高周期 K 线上判,确认那根高周期 K 线收盘的执行周期 K 线当根触发;不受决策视图 5000 根上限约束。缺省 = 在执行周期上判(旧口径)"
          }
        },
        "required": [
          "fast",
          "slow",
          "signal",
          "swing_length",
          "lookback"
        ]
      },
      "PrimitiveParamsPineSeries": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "script_id": {
            "type": "string",
            "maxLength": 128
          },
          "inputs": {
            "type": "array",
            "maxItems": 16,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "name": {
                  "type": "string",
                  "maxLength": 64
                },
                "value": {}
              },
              "required": [
                "name",
                "value"
              ]
            }
          },
          "output": {
            "type": "string",
            "maxLength": 64
          },
          "operator": {
            "enum": [
              "above",
              "below",
              "cross_above",
              "cross_below"
            ]
          },
          "threshold": {
            "type": "number"
          },
          "compare_to": {
            "enum": [
              "close",
              "zero",
              "threshold",
              "output"
            ]
          },
          "compare_output": {
            "type": "string",
            "maxLength": 64
          },
          "warmup_bars": {
            "type": "integer",
            "minimum": 1,
            "maximum": 5000
          }
        },
        "required": [
          "script_id",
          "output",
          "operator",
          "warmup_bars"
        ]
      },
      "PrimitiveParamsIndicatorCross": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "indicator": {
            "enum": [
              "ad",
              "adx",
              "ao",
              "aroon",
              "atr",
              "bbands",
              "cci",
              "chaikin",
              "chop",
              "cmf",
              "dema",
              "donchian",
              "elder_ray",
              "ema",
              "hma",
              "ichimoku",
              "kama",
              "keltner",
              "macd",
              "mfi",
              "momentum",
              "natr",
              "obv",
              "price",
              "psar",
              "roc",
              "rsi",
              "sma",
              "smma",
              "stdev",
              "stoch",
              "stochrsi",
              "supertrend",
              "tema",
              "trix",
              "uo",
              "volume_ratio",
              "vortex",
              "vwap",
              "vwma",
              "willr",
              "wma"
            ],
            "description": "指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。"
          },
          "args": {
            "type": "object",
            "additionalProperties": false,
            "description": "指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。",
            "properties": {
              "period": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_2": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_3": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "fast": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "slow": {
                "type": "integer",
                "minimum": 2,
                "maximum": 5000
              },
              "signal": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "multiple": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 100
              },
              "step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              },
              "max_step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              }
            },
            "required": []
          },
          "output": {
            "type": "string",
            "maxLength": 32,
            "description": "指标输出线名;省略或不认识时回落到该指标的主输出。"
          },
          "compare_to": {
            "enum": [
              "indicator",
              "price",
              "constant"
            ],
            "description": "被穿越的对象:另一个指标、价格序列或固定常数。"
          },
          "compare_indicator": {
            "enum": [
              "ad",
              "adx",
              "ao",
              "aroon",
              "atr",
              "bbands",
              "cci",
              "chaikin",
              "chop",
              "cmf",
              "dema",
              "donchian",
              "elder_ray",
              "ema",
              "hma",
              "ichimoku",
              "kama",
              "keltner",
              "macd",
              "mfi",
              "momentum",
              "natr",
              "obv",
              "price",
              "psar",
              "roc",
              "rsi",
              "sma",
              "smma",
              "stdev",
              "stoch",
              "stochrsi",
              "supertrend",
              "tema",
              "trix",
              "uo",
              "volume_ratio",
              "vortex",
              "vwap",
              "vwma",
              "willr",
              "wma"
            ],
            "description": "compare_to=indicator 时的第二个指标;省略则复用同一个指标(用 compare_args 换参数,如 SMA50 穿 SMA200)。"
          },
          "compare_args": {
            "type": "object",
            "additionalProperties": false,
            "description": "第二条线的指标参数,键同 args。",
            "properties": {
              "period": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_2": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_3": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "fast": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "slow": {
                "type": "integer",
                "minimum": 2,
                "maximum": 5000
              },
              "signal": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "multiple": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 100
              },
              "step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              },
              "max_step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              }
            },
            "required": []
          },
          "compare_output": {
            "type": "string",
            "maxLength": 32,
            "description": "指标输出线名;省略或不认识时回落到该指标的主输出。"
          },
          "compare_price": {
            "enum": [
              "close",
              "open",
              "high",
              "low",
              "hl2",
              "hlc3",
              "ohlc4"
            ],
            "description": "compare_to=price 时用哪个价格,默认 close。"
          },
          "constant": {
            "type": "number",
            "description": "compare_to=constant 时的常数,默认 0(如 MACD 柱上穿 0 轴)。"
          },
          "direction": {
            "enum": [
              "cross_above",
              "cross_below",
              "above",
              "below"
            ],
            "description": "cross_above/cross_below 是单根穿越事件;above/below 是状态(这一根主线在比较线上方/下方即成立),用于「回踩均线挂限价」这类要求持续处于趋势中的入场"
          }
        },
        "required": [
          "indicator",
          "compare_to",
          "direction"
        ]
      },
      "PrimitiveParamsIndicatorCrossExit": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "indicator": {
            "enum": [
              "ad",
              "adx",
              "ao",
              "aroon",
              "atr",
              "bbands",
              "cci",
              "chaikin",
              "chop",
              "cmf",
              "dema",
              "donchian",
              "elder_ray",
              "ema",
              "hma",
              "ichimoku",
              "kama",
              "keltner",
              "macd",
              "mfi",
              "momentum",
              "natr",
              "obv",
              "price",
              "psar",
              "roc",
              "rsi",
              "sma",
              "smma",
              "stdev",
              "stoch",
              "stochrsi",
              "supertrend",
              "tema",
              "trix",
              "uo",
              "volume_ratio",
              "vortex",
              "vwap",
              "vwma",
              "willr",
              "wma"
            ],
            "description": "指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。"
          },
          "args": {
            "type": "object",
            "additionalProperties": false,
            "description": "指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。",
            "properties": {
              "period": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_2": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_3": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "fast": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "slow": {
                "type": "integer",
                "minimum": 2,
                "maximum": 5000
              },
              "signal": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "multiple": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 100
              },
              "step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              },
              "max_step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              }
            },
            "required": []
          },
          "output": {
            "type": "string",
            "maxLength": 32,
            "description": "指标输出线名;省略或不认识时回落到该指标的主输出。"
          },
          "compare_to": {
            "enum": [
              "indicator",
              "price",
              "constant"
            ],
            "description": "被穿越的对象:另一个指标、价格序列或固定常数。"
          },
          "compare_indicator": {
            "enum": [
              "ad",
              "adx",
              "ao",
              "aroon",
              "atr",
              "bbands",
              "cci",
              "chaikin",
              "chop",
              "cmf",
              "dema",
              "donchian",
              "elder_ray",
              "ema",
              "hma",
              "ichimoku",
              "kama",
              "keltner",
              "macd",
              "mfi",
              "momentum",
              "natr",
              "obv",
              "price",
              "psar",
              "roc",
              "rsi",
              "sma",
              "smma",
              "stdev",
              "stoch",
              "stochrsi",
              "supertrend",
              "tema",
              "trix",
              "uo",
              "volume_ratio",
              "vortex",
              "vwap",
              "vwma",
              "willr",
              "wma"
            ],
            "description": "compare_to=indicator 时的第二个指标;省略则复用同一个指标(用 compare_args 换参数,如 SMA50 穿 SMA200)。"
          },
          "compare_args": {
            "type": "object",
            "additionalProperties": false,
            "description": "第二条线的指标参数,键同 args。",
            "properties": {
              "period": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_2": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_3": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "fast": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "slow": {
                "type": "integer",
                "minimum": 2,
                "maximum": 5000
              },
              "signal": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "multiple": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 100
              },
              "step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              },
              "max_step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              }
            },
            "required": []
          },
          "compare_output": {
            "type": "string",
            "maxLength": 32,
            "description": "指标输出线名;省略或不认识时回落到该指标的主输出。"
          },
          "compare_price": {
            "enum": [
              "close",
              "open",
              "high",
              "low",
              "hl2",
              "hlc3",
              "ohlc4"
            ],
            "description": "compare_to=price 时用哪个价格,默认 close。"
          },
          "constant": {
            "type": "number",
            "description": "compare_to=constant 时的常数,默认 0(如 MACD 柱上穿 0 轴)。"
          },
          "direction": {
            "enum": [
              "cross_above",
              "cross_below"
            ]
          }
        },
        "required": [
          "indicator",
          "compare_to",
          "direction"
        ]
      },
      "PrimitiveParamsIndicatorThreshold": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "indicator": {
            "enum": [
              "ad",
              "adx",
              "ao",
              "aroon",
              "atr",
              "bbands",
              "cci",
              "chaikin",
              "chop",
              "cmf",
              "dema",
              "donchian",
              "elder_ray",
              "ema",
              "hma",
              "ichimoku",
              "kama",
              "keltner",
              "macd",
              "mfi",
              "momentum",
              "natr",
              "obv",
              "price",
              "psar",
              "roc",
              "rsi",
              "sma",
              "smma",
              "stdev",
              "stoch",
              "stochrsi",
              "supertrend",
              "tema",
              "trix",
              "uo",
              "volume_ratio",
              "vortex",
              "vwap",
              "vwma",
              "willr",
              "wma"
            ],
            "description": "指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。"
          },
          "args": {
            "type": "object",
            "additionalProperties": false,
            "description": "指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。",
            "properties": {
              "period": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_2": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_3": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "fast": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "slow": {
                "type": "integer",
                "minimum": 2,
                "maximum": 5000
              },
              "signal": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "multiple": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 100
              },
              "step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              },
              "max_step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              }
            },
            "required": []
          },
          "output": {
            "type": "string",
            "maxLength": 32,
            "description": "指标输出线名;省略或不认识时回落到该指标的主输出。"
          },
          "operator": {
            "enum": [
              "above",
              "below",
              "cross_above",
              "cross_below"
            ],
            "description": "above/below 是状态(每根都可能成立),cross_* 是单根事件。"
          },
          "threshold": {
            "type": "number"
          }
        },
        "required": [
          "indicator",
          "operator",
          "threshold"
        ]
      },
      "PrimitiveParamsIndicatorThresholdExit": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "indicator": {
            "enum": [
              "ad",
              "adx",
              "ao",
              "aroon",
              "atr",
              "bbands",
              "cci",
              "chaikin",
              "chop",
              "cmf",
              "dema",
              "donchian",
              "elder_ray",
              "ema",
              "hma",
              "ichimoku",
              "kama",
              "keltner",
              "macd",
              "mfi",
              "momentum",
              "natr",
              "obv",
              "price",
              "psar",
              "roc",
              "rsi",
              "sma",
              "smma",
              "stdev",
              "stoch",
              "stochrsi",
              "supertrend",
              "tema",
              "trix",
              "uo",
              "volume_ratio",
              "vortex",
              "vwap",
              "vwma",
              "willr",
              "wma"
            ],
            "description": "指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。"
          },
          "args": {
            "type": "object",
            "additionalProperties": false,
            "description": "指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。",
            "properties": {
              "period": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_2": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_3": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "fast": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "slow": {
                "type": "integer",
                "minimum": 2,
                "maximum": 5000
              },
              "signal": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "multiple": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 100
              },
              "step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              },
              "max_step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              }
            },
            "required": []
          },
          "output": {
            "type": "string",
            "maxLength": 32,
            "description": "指标输出线名;省略或不认识时回落到该指标的主输出。"
          },
          "operator": {
            "enum": [
              "above",
              "below",
              "cross_above",
              "cross_below"
            ],
            "description": "above/below 是状态(每根都可能成立),cross_* 是单根事件。"
          },
          "threshold": {
            "type": "number"
          }
        },
        "required": [
          "indicator",
          "operator",
          "threshold"
        ]
      },
      "PrimitiveParamsIndicatorDivergence": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "indicator": {
            "enum": [
              "ad",
              "adx",
              "ao",
              "aroon",
              "atr",
              "bbands",
              "cci",
              "chaikin",
              "chop",
              "cmf",
              "dema",
              "donchian",
              "elder_ray",
              "ema",
              "hma",
              "ichimoku",
              "kama",
              "keltner",
              "macd",
              "mfi",
              "momentum",
              "natr",
              "obv",
              "price",
              "psar",
              "roc",
              "rsi",
              "sma",
              "smma",
              "stdev",
              "stoch",
              "stochrsi",
              "supertrend",
              "tema",
              "trix",
              "uo",
              "volume_ratio",
              "vortex",
              "vwap",
              "vwma",
              "willr",
              "wma"
            ],
            "description": "指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。"
          },
          "args": {
            "type": "object",
            "additionalProperties": false,
            "description": "指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。",
            "properties": {
              "period": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_2": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_3": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "fast": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "slow": {
                "type": "integer",
                "minimum": 2,
                "maximum": 5000
              },
              "signal": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "multiple": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 100
              },
              "step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              },
              "max_step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              }
            },
            "required": []
          },
          "output": {
            "type": "string",
            "maxLength": 32,
            "description": "指标输出线名;省略或不认识时回落到该指标的主输出。"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          },
          "lookback": {
            "type": "integer",
            "minimum": 5,
            "maximum": 5000
          }
        },
        "required": [
          "indicator",
          "swing_length",
          "lookback"
        ]
      },
      "PrimitiveParamsIndicatorDivergenceExit": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "indicator": {
            "enum": [
              "ad",
              "adx",
              "ao",
              "aroon",
              "atr",
              "bbands",
              "cci",
              "chaikin",
              "chop",
              "cmf",
              "dema",
              "donchian",
              "elder_ray",
              "ema",
              "hma",
              "ichimoku",
              "kama",
              "keltner",
              "macd",
              "mfi",
              "momentum",
              "natr",
              "obv",
              "price",
              "psar",
              "roc",
              "rsi",
              "sma",
              "smma",
              "stdev",
              "stoch",
              "stochrsi",
              "supertrend",
              "tema",
              "trix",
              "uo",
              "volume_ratio",
              "vortex",
              "vwap",
              "vwma",
              "willr",
              "wma"
            ],
            "description": "指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。"
          },
          "args": {
            "type": "object",
            "additionalProperties": false,
            "description": "指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。",
            "properties": {
              "period": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_2": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_3": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "fast": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "slow": {
                "type": "integer",
                "minimum": 2,
                "maximum": 5000
              },
              "signal": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "multiple": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 100
              },
              "step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              },
              "max_step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              }
            },
            "required": []
          },
          "output": {
            "type": "string",
            "maxLength": 32,
            "description": "指标输出线名;省略或不认识时回落到该指标的主输出。"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          },
          "lookback": {
            "type": "integer",
            "minimum": 5,
            "maximum": 5000
          }
        },
        "required": [
          "indicator",
          "swing_length",
          "lookback"
        ]
      },
      "PrimitiveParamsDoubleBottom": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          },
          "lookback": {
            "type": "integer",
            "minimum": 5,
            "maximum": 5000
          },
          "tolerance_pct": {
            "type": "number",
            "minimum": 0,
            "maximum": 50,
            "description": "两个对称极值之间允许的价格偏差百分比。"
          }
        },
        "required": [
          "swing_length",
          "lookback",
          "tolerance_pct"
        ]
      },
      "PrimitiveParamsDoubleTopExit": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          },
          "lookback": {
            "type": "integer",
            "minimum": 5,
            "maximum": 5000
          },
          "tolerance_pct": {
            "type": "number",
            "minimum": 0,
            "maximum": 50,
            "description": "两个对称极值之间允许的价格偏差百分比。"
          }
        },
        "required": [
          "swing_length",
          "lookback",
          "tolerance_pct"
        ]
      },
      "PrimitiveParamsHeadAndShouldersInverse": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          },
          "lookback": {
            "type": "integer",
            "minimum": 5,
            "maximum": 5000
          },
          "tolerance_pct": {
            "type": "number",
            "minimum": 0,
            "maximum": 50,
            "description": "两个对称极值之间允许的价格偏差百分比。"
          }
        },
        "required": [
          "swing_length",
          "lookback",
          "tolerance_pct"
        ]
      },
      "PrimitiveParamsBullishEngulfing": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "min_body_ratio": {
            "type": "number",
            "minimum": 0,
            "maximum": 100,
            "description": "当根实体至少是前一根实体的多少倍。"
          }
        },
        "required": [
          "min_body_ratio"
        ]
      },
      "PrimitiveParamsBearishEngulfingExit": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "min_body_ratio": {
            "type": "number",
            "minimum": 0,
            "maximum": 100,
            "description": "当根实体至少是前一根实体的多少倍。"
          }
        },
        "required": [
          "min_body_ratio"
        ]
      },
      "PrimitiveParamsPinBar": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "tail_ratio": {
            "type": "number",
            "minimum": 0.1,
            "maximum": 100,
            "description": "下影至少是实体的多少倍。"
          },
          "max_body_pct": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "实体占整根振幅的上限。"
          },
          "max_upper_pct": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "上影占整根振幅的上限。"
          }
        },
        "required": [
          "tail_ratio",
          "max_body_pct",
          "max_upper_pct"
        ]
      },
      "PrimitiveParamsFairValueGap": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "min_gap_pct": {
            "type": "number",
            "minimum": 0,
            "maximum": 100,
            "description": "缺口宽度相对收盘价的百分比下限。"
          }
        },
        "required": [
          "min_gap_pct"
        ]
      },
      "PrimitiveParamsInsideBarBreakout": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "max_inside_bars": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "母线之后最多回溯多少根内包线。"
          }
        },
        "required": [
          "max_inside_bars"
        ]
      },
      "PrimitiveParamsNextOpenMarket": {
        "type": "object",
        "additionalProperties": false,
        "properties": {},
        "required": []
      },
      "PrimitiveParamsAtrStop": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "multiple": {
            "type": "number",
            "minimum": 0.01,
            "maximum": 100
          }
        },
        "required": [
          "atr_period",
          "multiple"
        ]
      },
      "PrimitiveParamsSwingLowStop": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "lookback": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          }
        },
        "required": [
          "lookback"
        ]
      },
      "PrimitiveParamsChandelierTrail": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "multiple": {
            "type": "number",
            "minimum": 0.01,
            "maximum": 100
          }
        },
        "required": [
          "atr_period",
          "multiple"
        ]
      },
      "PrimitiveParamsSwingStructureStop": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "lookback": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          }
        },
        "required": [
          "lookback"
        ]
      },
      "PrimitiveParamsTrendBreak": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "ema_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "htf": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$"
          }
        },
        "required": [
          "ema_period",
          "htf"
        ]
      },
      "PrimitiveParamsBreakevenAfterR": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "r": {
            "type": "number",
            "minimum": 0.01,
            "maximum": 100
          }
        },
        "required": [
          "r"
        ]
      },
      "PrimitiveParamsTimeStop": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "bars": {
            "type": "integer",
            "minimum": 1,
            "maximum": 10000
          }
        },
        "required": [
          "bars"
        ]
      },
      "PrimitiveParamsFixedRTarget": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "r": {
            "type": "number",
            "minimum": 0.01,
            "maximum": 100
          }
        },
        "required": [
          "r"
        ]
      },
      "PrimitiveParamsRiskFraction": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "fraction": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$"
          },
          "max_allocation": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$"
          }
        },
        "required": [
          "fraction",
          "max_allocation"
        ]
      },
      "PrimitiveParamsEqualNotional": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "max_allocation": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$"
          }
        },
        "required": [
          "max_allocation"
        ]
      },
      "PrimitiveParamsVolTarget": {
        "type": "object",
        "additionalProperties": false,
        "description": "波动率目标仓位(2026-09-23):每笔 100% 可用资金 × min(1, target_vol / 入场前已收盘 K 线的实现年化波动);lookback_bars 缺省 = 20 天折算根数",
        "properties": {
          "target_vol": {
            "type": "number",
            "minimum": 0.05,
            "maximum": 5
          },
          "lookback_bars": {
            "type": "integer",
            "minimum": 5,
            "maximum": 4000
          }
        },
        "required": [
          "target_vol"
        ]
      },
      "PrimitiveParamsResidualSharpeMin": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "minimum": {
            "type": "number"
          }
        },
        "required": [
          "minimum"
        ]
      },
      "PrimitiveParamsBetaMax": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "maximum": {
            "type": "number"
          }
        },
        "required": [
          "maximum"
        ]
      },
      "PrimitiveParamsTrendRequired": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "states": {
            "type": "array",
            "items": {
              "enum": [
                "up",
                "down",
                "range"
              ]
            },
            "maxItems": 30
          }
        },
        "required": [
          "states"
        ]
      },
      "PrimitiveParamsTrendState": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "adx_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "adx_min": {
            "type": "number",
            "minimum": 0,
            "maximum": 100
          },
          "ema_fast": {
            "type": "integer",
            "minimum": 2,
            "maximum": 5000
          },
          "ema_slow": {
            "type": "integer",
            "minimum": 3,
            "maximum": 5000
          },
          "htf": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$"
          }
        },
        "required": [
          "adx_period",
          "adx_min",
          "ema_fast",
          "ema_slow",
          "htf"
        ]
      },
      "PrimitiveParamsHtfMaState": {
        "type": "object",
        "additionalProperties": false,
        "description": "高周期均线状态(2026-09-23 夜,regime):最近一根已收盘的 htf K 线收盘价在其 MA(period) 之上(side=above)/之下(side=below)。高周期 K 线由已收盘的执行周期 K 线按 htf 分桶聚成,只用完整的桶;从整段已收盘 K 线计算,不受决策视图 5000 根上限约束。可作 regime(做多)与 order.short_regime(做空)",
        "properties": {
          "htf": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$",
            "description": "高周期,必须 ≥ 执行周期且可整除,如 1d / 4h"
          },
          "period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 1000,
            "description": "均线周期(高周期根数),如 60 = 日线 MA60"
          },
          "ma": {
            "enum": [
              "sma",
              "ema"
            ],
            "description": "缺省 sma"
          },
          "side": {
            "enum": [
              "above",
              "below"
            ],
            "description": "缺省 above;做空方向门用 below"
          }
        },
        "required": [
          "htf",
          "period"
        ]
      },
      "ResearchDiagnostics": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "exit_reasons": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "reason": {
                  "type": "string"
                },
                "count": {
                  "type": "integer",
                  "minimum": 0
                },
                "avg_net_r": {
                  "type": [
                    "number",
                    "null"
                  ]
                },
                "net_pnl": {
                  "type": "string",
                  "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                  "maxLength": 32
                }
              },
              "required": [
                "reason",
                "count",
                "avg_net_r",
                "net_pnl"
              ]
            }
          },
          "r_histogram": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "bins": {
                "type": "array",
                "items": {
                  "type": "number"
                }
              },
              "counts": {
                "type": "array",
                "items": {
                  "type": "integer",
                  "minimum": 0
                }
              }
            },
            "required": [
              "bins",
              "counts"
            ]
          },
          "mae_mfe": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "avg_mae_r": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "avg_mfe_r": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "winners_avg_mfe_r": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "losers_avg_mfe_r": {
                "type": [
                  "number",
                  "null"
                ]
              }
            },
            "required": [
              "avg_mae_r",
              "avg_mfe_r",
              "winners_avg_mfe_r",
              "losers_avg_mfe_r"
            ]
          },
          "cost_share": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "fees": {
                "type": "string",
                "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                "maxLength": 32
              },
              "slippage_est": {
                "type": "string",
                "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                "maxLength": 32
              },
              "gross_pnl": {
                "type": "string",
                "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                "maxLength": 32
              },
              "cost_over_gross_abs": {
                "type": [
                  "number",
                  "null"
                ]
              }
            },
            "required": [
              "fees",
              "slippage_est",
              "gross_pnl",
              "cost_over_gross_abs"
            ]
          },
          "factor": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "status": {
                "enum": [
                  "ok",
                  "insufficient"
                ]
              },
              "beta": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "alpha_annualized": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "alpha_share": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "beta_share": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "residual_max_dd": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "residual_sharpe": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "r2": {
                "type": [
                  "number",
                  "null"
                ]
              }
            },
            "required": [
              "status"
            ]
          },
          "holding_bars": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "avg": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "median": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "max": {
                "type": [
                  "number",
                  "null"
                ]
              }
            },
            "required": [
              "avg",
              "median",
              "max"
            ]
          },
          "note": {
            "type": "string"
          },
          "gate_stats": {
            "type": "object",
            "properties": {
              "evaluated": {
                "type": "integer"
              },
              "blocked_by": {
                "type": "object",
                "additionalProperties": {
                  "type": "integer"
                }
              },
              "passed": {
                "type": "integer"
              },
              "adjusted": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "stop_widened": {
                    "type": "integer"
                  },
                  "target_fallback": {
                    "type": "integer"
                  }
                },
                "required": [
                  "stop_widened",
                  "target_fallback"
                ]
              }
            },
            "required": [
              "evaluated",
              "blocked_by"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "exit_reasons",
          "r_histogram",
          "mae_mfe",
          "cost_share",
          "factor",
          "holding_bars"
        ]
      },
      "ResearchAttribution": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "parent_run_id": {
            "type": "string"
          },
          "child_run_id": {
            "type": "string"
          },
          "base_net_return": {
            "type": "number"
          },
          "child_net_return": {
            "type": "number"
          },
          "components": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "section": {
                  "enum": [
                    "signal",
                    "entry",
                    "risk",
                    "exit",
                    "sizing",
                    "regime",
                    "screen"
                  ]
                },
                "changed": {
                  "type": "boolean"
                },
                "solo_net_return": {
                  "type": "number"
                },
                "delta": {
                  "type": "number"
                }
              },
              "required": [
                "section",
                "changed",
                "solo_net_return",
                "delta"
              ]
            }
          },
          "interaction": {
            "type": "number"
          },
          "note": {
            "type": "string"
          }
        },
        "required": [
          "parent_run_id",
          "child_run_id",
          "base_net_return",
          "child_net_return",
          "components",
          "interaction",
          "note"
        ]
      },
      "ResearchEntry": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "candidate_id": {
            "type": "string"
          },
          "stop": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
            "maxLength": 32
          },
          "target": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                "maxLength": 32
              },
              {
                "type": "null"
              }
            ]
          },
          "target_r": {
            "type": "number",
            "exclusiveMinimum": 0
          },
          "screen_rank": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1
          },
          "reason": {
            "type": "string"
          },
          "fit": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "stop_source": {
                "type": "string",
                "enum": [
                  "strategy",
                  "cost_floor"
                ]
              },
              "target_source": {
                "type": "string",
                "enum": [
                  "strategy",
                  "fallback_r",
                  "none"
                ]
              },
              "strategy_stop": {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                "maxLength": 32
              },
              "strategy_target": {
                "anyOf": [
                  {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                    "maxLength": 32
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "stop_pct": {
                "type": "number"
              },
              "target_pct": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "rr": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "floor_pct": {
                "type": "number"
              }
            },
            "required": [
              "stop_source",
              "target_source",
              "strategy_stop",
              "strategy_target",
              "stop_pct",
              "target_pct",
              "rr",
              "floor_pct"
            ]
          }
        },
        "required": [
          "candidate_id",
          "stop",
          "target",
          "reason"
        ]
      },
      "ResearchDecisionView": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "arm": {
            "type": "string"
          },
          "symbol": {
            "type": "string"
          },
          "timeframe_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "bars": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ResearchBar"
            }
          },
          "policy": {
            "$ref": "#/$defs/ResearchPolicy"
          },
          "candidate": {
            "anyOf": [
              {
                "$ref": "#/$defs/ResearchEntry"
              },
              {
                "type": "null"
              }
            ]
          },
          "account": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "cash": {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                "maxLength": 32
              },
              "equity": {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                "maxLength": 32
              }
            },
            "required": [
              "cash",
              "equity"
            ]
          },
          "position": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "entry_at": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "entry_price": {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                    "maxLength": 32
                  },
                  "qty": {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                    "maxLength": 32
                  },
                  "stop": {
                    "type": "string",
                    "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                    "maxLength": 32
                  },
                  "target": {
                    "anyOf": [
                      {
                        "type": "string",
                        "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                        "maxLength": 32
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "bars_held": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "entry_at",
                  "entry_price",
                  "qty",
                  "stop",
                  "target",
                  "bars_held"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "strategy_ir": {
            "$ref": "#/$defs/StrategyIR"
          },
          "screen": {
            "$ref": "#/$defs/ResearchScreenRow"
          },
          "trend": {
            "$ref": "#/$defs/ResearchTrend"
          },
          "portfolio": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "symbol": {
                  "type": "string"
                },
                "holdings": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$",
                  "maxLength": 32
                }
              },
              "required": [
                "symbol",
                "holdings"
              ]
            }
          },
          "previous_summary": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "opens_today": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "htf_structure": {
            "$ref": "#/$defs/ResearchStructure"
          }
        },
        "required": [
          "at",
          "arm",
          "symbol",
          "timeframe_ms",
          "bars",
          "policy",
          "candidate",
          "account",
          "position",
          "previous_summary",
          "opens_today"
        ]
      },
      "ResearchAgentAction": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "action": {
            "type": "string",
            "enum": [
              "enter",
              "follow",
              "skip",
              "hold",
              "exit",
              "reduce",
              "no_trade",
              "blocked",
              "model_error"
            ]
          },
          "reason": {
            "type": "string"
          },
          "gate_errors": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "evidence_refs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "entry": {
            "$ref": "#/$defs/ResearchEntry"
          }
        },
        "required": [
          "action",
          "reason",
          "gate_errors",
          "evidence_refs"
        ]
      },
      "ResearchRecordedDecision": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "input": {
            "$ref": "#/$defs/ResearchDecisionView"
          },
          "input_hash": {
            "type": "string"
          },
          "output": {
            "$ref": "#/$defs/ResearchAgentAction"
          }
        },
        "required": [
          "input",
          "input_hash",
          "output"
        ]
      },
      "OrderGateParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "min_rr": {
            "type": "number",
            "minimum": 0,
            "maximum": 100
          },
          "min_stop_cost_multiple": {
            "type": "number",
            "minimum": 0,
            "maximum": 1000
          },
          "max_risk_fraction": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$"
          },
          "require_target": {
            "type": "boolean"
          },
          "stop_floor": {
            "type": "string",
            "enum": [
              "widen",
              "block",
              "none"
            ],
            "description": "策略止损窄于成本下限时:widen=把止损放宽到 min_stop_cost_multiple×往返成本(旧缺省),block=直接拦,none=成本下限只作展示、不放宽也不拦(2026-09-23 结构口径缺省)"
          },
          "target_fallback_r": {
            "type": [
              "number",
              "null"
            ],
            "minimum": 0,
            "maximum": 100,
            "description": "策略没给出止盈(结构上方无阻力块)时,用止损距离的固定倍数补止盈;null=不补,直接 no_target"
          },
          "risk_cap_sizing": {
            "type": "string",
            "enum": [
              "risk_fraction_only",
              "all"
            ],
            "description": "单笔风险上限适用范围:默认只对 risk_fraction 仓位法;unit_notional 已剔除仓位因素不套"
          },
          "min_stop_atr": {
            "type": [
              "number",
              "null"
            ],
            "minimum": 0,
            "maximum": 10,
            "description": "结构口径(2026-09-23):止损离入场(市价=信号收盘价,限价=挂单价)不到 min_stop_atr×ATR(14,Wilder) 的单子直接不做(blocked stop_too_close),代码不会把止损挪远;缺省 0.5。字段存在(非 null)即启用结构口径:不再用盈亏比拦单(只认 IR 的 order.min_rr)、不放宽止损、不按 R 倍数补止盈"
          }
        },
        "required": [
          "min_rr",
          "min_stop_cost_multiple",
          "max_risk_fraction",
          "require_target"
        ]
      },
      "ResearchStructure": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "as_of": {
            "type": [
              "integer",
              "null"
            ]
          },
          "status": {
            "enum": [
              "ok",
              "insufficient"
            ]
          },
          "support": {
            "type": [
              "object",
              "null"
            ],
            "additionalProperties": false,
            "properties": {
              "lower": {
                "type": "string"
              },
              "upper": {
                "type": "string"
              },
              "formed_at": {
                "type": "integer"
              }
            },
            "required": [
              "lower",
              "upper",
              "formed_at"
            ]
          },
          "resistance": {
            "type": [
              "object",
              "null"
            ],
            "additionalProperties": false,
            "properties": {
              "lower": {
                "type": "string"
              },
              "upper": {
                "type": "string"
              },
              "formed_at": {
                "type": "integer"
              }
            },
            "required": [
              "lower",
              "upper",
              "formed_at"
            ]
          },
          "position": {
            "type": [
              "number",
              "null"
            ]
          },
          "bos_direction": {
            "enum": [
              "up",
              "down",
              null
            ]
          },
          "pivot_low": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "as_of",
          "status",
          "support",
          "resistance",
          "position",
          "bos_direction",
          "pivot_low"
        ]
      },
      "PrimitiveParamsStructurePivots": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ]
          },
          "zone": {
            "enum": [
              "body",
              "wick"
            ]
          }
        },
        "required": [
          "swing_length"
        ]
      },
      "PrimitiveParamsStructureBos": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ]
          },
          "zone": {
            "enum": [
              "body",
              "wick"
            ]
          }
        },
        "required": [
          "swing_length"
        ]
      },
      "PrimitiveParamsOrderBlocks": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ]
          },
          "zone": {
            "enum": [
              "body",
              "wick"
            ]
          }
        },
        "required": [
          "swing_length"
        ]
      },
      "PrimitiveParamsHtfStructure": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ]
          },
          "zone": {
            "enum": [
              "body",
              "wick"
            ]
          },
          "htf": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$"
          }
        },
        "required": [
          "swing_length"
        ]
      },
      "PrimitiveParamsStructureTarget": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ]
          },
          "zone": {
            "enum": [
              "body",
              "wick"
            ]
          },
          "htf": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$"
          }
        },
        "required": [
          "swing_length"
        ]
      },
      "PrimitiveParamsPivotTarget": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "确认 pivot 左右各几根(与几何实验室 pivots(L=R) 同定义,最右等值为准)"
          },
          "lookback": {
            "type": "integer",
            "minimum": 20,
            "maximum": 5000,
            "description": "在最近多少根里找摆动高点,缺省 480(与几何实验室视图一致)"
          },
          "min_atr": {
            "type": "number",
            "minimum": 0,
            "maximum": 50,
            "description": "目标离入场至少几倍 ATR(14),缺省 1"
          },
          "max_atr": {
            "type": "number",
            "minimum": 0,
            "maximum": 100,
            "description": "目标离入场至多几倍 ATR(14),缺省 6;更远视为图上没有近端目标,不设止盈"
          },
          "unswept": {
            "type": "boolean",
            "description": "只取之后没被扫过(没有更高的高点越过)的摆动高点,缺省 true;false 时与几何实验室 arm A 的目标同一规则"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 500,
            "description": "ATR 周期,缺省 14(Wilder)"
          }
        },
        "required": [
          "swing_length"
        ]
      },
      "PrimitiveParamsPivotStop": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "确认 pivot 左右各几根(与几何实验室 pivots(L=R) 同定义)"
          },
          "pick": {
            "enum": [
              "recent",
              "nearest"
            ],
            "description": "recent(缺省)=按时间最近的一个摆动低点(上一个更高低点);nearest=价格最接近收盘的摆动低点(= 几何实验室 D 臂菜单 1h swing low #1)"
          },
          "lookback": {
            "type": "integer",
            "minimum": 20,
            "maximum": 5000,
            "description": "在最近多少根里找摆动低点,缺省 480"
          },
          "buffer_atr": {
            "type": "number",
            "minimum": 0,
            "maximum": 10,
            "description": "摆动低点下方再让出几倍 ATR(14),缺省 0.1(几何实验室同口径)"
          },
          "fallback_lookback": {
            "type": "integer",
            "minimum": 2,
            "maximum": 500,
            "description": "视图里没有低于现价的已确认摆动低点时,退回最近 N 根最低价(再减缓冲),缺省 10"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 500,
            "description": "ATR 周期,缺省 14(Wilder)"
          }
        },
        "required": [
          "swing_length"
        ]
      },
      "ResearchPrecheckRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "ir": {
            "$ref": "#/$defs/StrategyIR"
          },
          "dataset_id": {
            "type": "string"
          },
          "universe_id": {
            "type": "string"
          },
          "from_ms": {
            "type": "integer"
          },
          "to_ms": {
            "type": "integer"
          },
          "execution": {
            "$ref": "#/$defs/ResearchExecution"
          },
          "order_gate": {
            "$ref": "#/$defs/OrderGateParams"
          },
          "thresholds": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "min_trades": {
                "type": "integer",
                "minimum": 1
              },
              "min_gate_pass_rate": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              },
              "min_holding_bars": {
                "type": "number",
                "minimum": 0
              },
              "min_regime_coverage": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              },
              "max_stop_fit_rate": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              }
            }
          }
        },
        "required": [
          "ir",
          "from_ms",
          "to_ms",
          "execution"
        ],
        "oneOf": [
          {
            "required": [
              "dataset_id"
            ],
            "not": {
              "required": [
                "universe_id"
              ]
            }
          },
          {
            "required": [
              "universe_id"
            ],
            "not": {
              "required": [
                "dataset_id"
              ]
            }
          }
        ]
      },
      "ResearchPrecheckResult": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "items": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "name": {
                  "type": "string"
                },
                "ok": {
                  "type": "boolean"
                },
                "value": {
                  "type": [
                    "number",
                    "null"
                  ]
                },
                "threshold": {
                  "type": "number"
                },
                "note": {
                  "type": "string"
                }
              },
              "required": [
                "name",
                "ok",
                "value"
              ]
            }
          },
          "suggestions": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "ok",
          "items",
          "suggestions"
        ]
      },
      "ResearchAsset": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "symbol": {
            "type": "string"
          },
          "exchange": {
            "type": "string"
          },
          "ccxt_symbol": {
            "type": "string"
          },
          "quote": {
            "type": "string"
          },
          "first_available_at": {
            "type": [
              "integer",
              "null"
            ]
          },
          "quote_volume_30d": {
            "type": [
              "string",
              "null"
            ]
          },
          "volume_bars": {
            "type": "integer"
          },
          "status": {
            "enum": [
              "ok",
              "unavailable"
            ]
          },
          "note": {
            "type": "string"
          }
        },
        "required": [
          "symbol",
          "exchange",
          "ccxt_symbol",
          "quote",
          "first_available_at",
          "quote_volume_30d",
          "volume_bars",
          "status"
        ]
      },
      "ResearchArtifactSummary": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string"
          },
          "kind": {
            "enum": [
              "chart",
              "table",
              "markdown"
            ]
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "kind",
          "title"
        ]
      },
      "ResearchArtifact": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string"
          },
          "chat_id": {
            "type": "string"
          },
          "run_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "kind": {
            "enum": [
              "chart",
              "table",
              "markdown"
            ]
          },
          "title": {
            "type": "string"
          },
          "content": {},
          "created_at": {
            "type": "integer"
          }
        },
        "required": [
          "id",
          "chat_id",
          "run_id",
          "kind",
          "title",
          "content",
          "created_at"
        ]
      },
      "ResearchChatTask": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string"
          },
          "parent_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "title": {
            "type": "string"
          },
          "status": {
            "enum": [
              "running",
              "done",
              "failed"
            ]
          },
          "detail": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "parent_id",
          "title",
          "status",
          "detail"
        ]
      },
      "ResearchChatEvent": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "chat_id": {
            "type": "string"
          },
          "seq": {
            "type": "integer",
            "minimum": 1
          },
          "at": {
            "type": "integer"
          },
          "event": {
            "enum": [
              "task",
              "tool",
              "artifact",
              "final",
              "error"
            ]
          },
          "data": {}
        },
        "required": [
          "chat_id",
          "seq",
          "at",
          "event",
          "data"
        ]
      },
      "PrimitiveParamsHtfStructureRegime": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "htf": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ]
          },
          "zone": {
            "enum": [
              "body",
              "wick"
            ]
          },
          "max_position": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "当前价在高周期支撑块上沿到阻力块下沿之间的位置上限(0=贴支撑,1=贴阻力);高于此值离阻力太近不做多"
          },
          "require_bos": {
            "type": "boolean",
            "description": "是否要求高周期最近一次结构突破向上(BOS up / CHoCH up)"
          }
        },
        "required": [
          "htf",
          "swing_length"
        ]
      },
      "StrategySpecReport": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "version": {
            "type": "string"
          },
          "ok": {
            "type": "boolean"
          },
          "violations": {
            "type": "array",
            "maxItems": 40,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "code": {
                  "type": "string",
                  "maxLength": 80
                },
                "severity": {
                  "type": "string",
                  "enum": [
                    "block",
                    "warn"
                  ]
                },
                "message": {
                  "type": "string",
                  "maxLength": 2000
                },
                "field": {
                  "type": "string",
                  "maxLength": 120
                }
              },
              "required": [
                "code",
                "severity",
                "message"
              ]
            }
          },
          "text": {
            "type": "string",
            "maxLength": 20000
          }
        },
        "required": [
          "version",
          "ok",
          "violations",
          "text"
        ]
      },
      "StrategyOrderEntry": {
        "type": "object",
        "additionalProperties": false,
        "description": "入场单:market=信号下一根 open 市价成交;limit=在 expiry_bars 根内触价才成交(开盘已越过按 open,钳制到当根),否则 no_fill",
        "properties": {
          "type": {
            "enum": [
              "market",
              "limit"
            ]
          },
          "price": {
            "$ref": "#/$defs/StrategyPrimitive",
            "description": "限价来源(价位原语):structure_level(回踩支撑近端)/indicator_level(回踩某指标线)/atr_offset_level(收盘价回撤 N×ATR)/pct_offset_level;limit 必填"
          },
          "expiry_bars": {
            "type": "integer",
            "minimum": 1,
            "maximum": 5000,
            "description": "挂单时效(根);缺省按周期分档:≤1h 24 小时、≤3h 48 小时、≥4h 72 小时(对齐 8794)"
          }
        },
        "required": [
          "type"
        ]
      },
      "StrategyOrderTakeProfit": {
        "type": "object",
        "additionalProperties": false,
        "description": "一档止盈:限价单,跳空按更优 open 成交",
        "properties": {
          "source": {
            "$ref": "#/$defs/StrategyPrimitive",
            "description": "止盈价位原语:structure_target(上方阻力/做空时下方支撑)/fixed_r_target(按初始止损 R 倍数)/indicator_level(如布林上轨)/atr_offset_level/pct_offset_level/structure_level"
          },
          "size_pct": {
            "type": "number",
            "exclusiveMinimum": 0,
            "maximum": 1,
            "description": "该档平掉的仓位比例,小数;各档缺省等权,合计不为 1 时按比例归一"
          }
        },
        "required": [
          "source"
        ]
      },
      "StrategyOrderOnNewSignal": {
        "type": "object",
        "additionalProperties": false,
        "description": "同一资产同向新信号到来时:unfilled=前一计划尚未成交(replace 整体替换 / keep 保留旧单);filled=已成交(roll 旧计划按下一根 open 结转、新计划的止损止盈接管仓位 / add 等权加仓腿 / ignore 忽略)。缺省 replace / roll(8794 v7/v8)",
        "properties": {
          "unfilled": {
            "enum": [
              "replace",
              "keep"
            ]
          },
          "filled": {
            "enum": [
              "roll",
              "add",
              "ignore"
            ]
          }
        },
        "required": []
      },
      "StrategyOrder": {
        "type": "object",
        "additionalProperties": false,
        "description": "可选的订单周期块。有它时回测按「计划 → 限价/市价 → 止损 + 多档止盈 → 结转/加仓/反手」逐单模拟,并出 K 线回放;没有它时行为与旧 IR 完全相同。止损仍用 risk.stop(做空时同一原语镜像到上方),止盈缺省=结构阻力(structure_target)单档",
        "properties": {
          "direction": {
            "enum": [
              "long",
              "short",
              "both"
            ],
            "description": "short/both 仅限 market=perp;short 时 signal 就是做空条件;both 时 signal 做多、short_signal 做空"
          },
          "market": {
            "enum": [
              "spot",
              "perp"
            ],
            "description": "spot 禁止做空与杠杆;perp 计资金费(8h 真实序列)与逐仓强平"
          },
          "leverage": {
            "type": "number",
            "minimum": 1,
            "maximum": 125,
            "description": "杠杆倍数,缺省 1;spot 必须为 1"
          },
          "entry": {
            "$ref": "#/$defs/StrategyOrderEntry"
          },
          "take_profits": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StrategyOrderTakeProfit"
            },
            "minItems": 1,
            "maxItems": 5
          },
          "min_rr": {
            "type": "number",
            "minimum": 0,
            "maximum": 50,
            "description": "用户硬约束盈亏比:放置时加权止盈距离/止损距离低于它就不下单(计入 blocked 统计);缺省用策略规范的最小盈亏比"
          },
          "on_new_signal": {
            "$ref": "#/$defs/StrategyOrderOnNewSignal"
          },
          "max_adds": {
            "type": "integer",
            "minimum": 0,
            "maximum": 5,
            "description": "filled=add 时最多加仓腿数;每腿等权,首腿只占 1/(max_adds+1) 的仓位额度。缺省 2"
          },
          "max_holding_bars": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100000,
            "description": "周期上限:持仓满这么多根后下一根 open 按 time 出场;缺省取 exit 里 time_stop 的 bars"
          },
          "breakeven_after_tp": {
            "type": "boolean",
            "description": "首档止盈成交后把剩余仓位止损移到入场均价(8794 breakeven 口径),缺省 false"
          },
          "short_signal": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/StrategyPrimitive"
            },
            "minItems": 1,
            "maxItems": 30,
            "description": "direction=both 时的做空条件(同一根 AND,按原文在真实 K 线上判定)"
          },
          "short_regime": {
            "$ref": "#/$defs/StrategyPrimitive",
            "description": "direction=both 时做空一侧的方向门;缺省不设门(regime 只作用于 signal 一侧)"
          }
        },
        "required": [
          "direction",
          "market"
        ]
      },
      "PrimitiveParamsIndicatorLevel": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "indicator": {
            "enum": [
              "ad",
              "adx",
              "ao",
              "aroon",
              "atr",
              "bbands",
              "cci",
              "chaikin",
              "chop",
              "cmf",
              "dema",
              "donchian",
              "elder_ray",
              "ema",
              "hma",
              "ichimoku",
              "kama",
              "keltner",
              "macd",
              "mfi",
              "momentum",
              "natr",
              "obv",
              "price",
              "psar",
              "roc",
              "rsi",
              "sma",
              "smma",
              "stdev",
              "stoch",
              "stochrsi",
              "supertrend",
              "tema",
              "trix",
              "uo",
              "volume_ratio",
              "vortex",
              "vwap",
              "vwma",
              "willr",
              "wma"
            ],
            "description": "指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。"
          },
          "args": {
            "type": "object",
            "additionalProperties": false,
            "description": "指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。",
            "properties": {
              "period": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_2": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "period_3": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "fast": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "slow": {
                "type": "integer",
                "minimum": 2,
                "maximum": 5000
              },
              "signal": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000
              },
              "multiple": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 100
              },
              "step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              },
              "max_step": {
                "type": "number",
                "minimum": 0.001,
                "maximum": 1
              }
            },
            "required": []
          },
          "output": {
            "type": "string",
            "maxLength": 32,
            "description": "指标输出线名;省略或不认识时回落到该指标的主输出。"
          },
          "buffer_atr": {
            "type": "number",
            "minimum": 0,
            "maximum": 10,
            "description": "止损角色时向外让出的 ATR 倍数(多单往下、空单往上),缺省 0"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500,
            "description": "buffer_atr 用的 ATR 周期,缺省 14"
          }
        },
        "required": [
          "indicator"
        ]
      },
      "PrimitiveParamsStructureLevel": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "swing_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ]
          },
          "zone": {
            "enum": [
              "body",
              "wick"
            ]
          },
          "htf": {
            "type": "string",
            "pattern": "^[1-9][0-9]*(m|h|d)$",
            "description": "结构所在周期,缺省为基础周期"
          },
          "buffer_atr": {
            "type": "number",
            "minimum": 0,
            "maximum": 10,
            "description": "止损角色时向外让出的 ATR 倍数(多单往下、空单往上),缺省 0"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500,
            "description": "buffer_atr 用的 ATR 周期,缺省 14"
          }
        },
        "required": [
          "swing_length"
        ]
      },
      "PrimitiveParamsAtrOffsetLevel": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "atr_period": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500
          },
          "multiple": {
            "type": "number",
            "minimum": 0,
            "maximum": 50
          }
        },
        "required": [
          "atr_period",
          "multiple"
        ]
      },
      "PrimitiveParamsPctOffsetLevel": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "pct": {
            "type": "number",
            "exclusiveMinimum": 0,
            "maximum": 0.9,
            "description": "相对收盘价的比例,小数(0.02=2%)"
          }
        },
        "required": [
          "pct"
        ]
      },
      "PrimitiveParamsNoStop": {
        "type": "object",
        "additionalProperties": false,
        "properties": {},
        "description": "用户明确说不设止损时用;止损价放在收盘价的 0.01%(等于不触发),风险 R 不再有意义"
      },
      "PrimitiveParamsSmcBos": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "scope": {
            "enum": [
              "internal",
              "swing"
            ],
            "description": "结构级别:internal 内部结构 / swing 摆动结构,缺省 internal"
          },
          "direction": {
            "enum": [
              "bullish",
              "bearish"
            ],
            "description": "方向:bullish 看涨(缺省)/ bearish 看跌"
          },
          "kind": {
            "enum": [
              "bos",
              "choch",
              "any"
            ],
            "description": "bos 顺势突破 / choch 反转突破 / any 都算(缺省)"
          },
          "internal_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "内部结构 pivot 左右各几根,缺省 5"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 2,
            "maximum": 200,
            "description": "摆动结构 pivot 左右各几根,缺省 50"
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "结构突破确认口径:收盘(缺省)或影线"
          },
          "mitigation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "订单块失效口径:影线穿过远端(缺省)或收盘穿过"
          },
          "ob_filter": {
            "enum": [
              "atr",
              "range",
              "none"
            ],
            "description": "挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 1000,
            "description": "高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200"
          },
          "eq_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "等高等低 pivot 左右各几根,缺省 3"
          },
          "eq_threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "description": "等高等低容差 = eq_threshold × ATR,缺省 0.1"
          },
          "fvg_auto": {
            "type": "boolean",
            "description": "FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true"
          }
        }
      },
      "PrimitiveParamsSmcObRetest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "scope": {
            "enum": [
              "internal",
              "swing"
            ],
            "description": "结构级别:internal 内部结构 / swing 摆动结构,缺省 internal"
          },
          "direction": {
            "enum": [
              "bullish",
              "bearish"
            ],
            "description": "方向:bullish 看涨(缺省)/ bearish 看跌"
          },
          "internal_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "内部结构 pivot 左右各几根,缺省 5"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 2,
            "maximum": 200,
            "description": "摆动结构 pivot 左右各几根,缺省 50"
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "结构突破确认口径:收盘(缺省)或影线"
          },
          "mitigation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "订单块失效口径:影线穿过远端(缺省)或收盘穿过"
          },
          "ob_filter": {
            "enum": [
              "atr",
              "range",
              "none"
            ],
            "description": "挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 1000,
            "description": "高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200"
          },
          "eq_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "等高等低 pivot 左右各几根,缺省 3"
          },
          "eq_threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "description": "等高等低容差 = eq_threshold × ATR,缺省 0.1"
          },
          "fvg_auto": {
            "type": "boolean",
            "description": "FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true"
          }
        }
      },
      "PrimitiveParamsSmcFvgFill": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "direction": {
            "enum": [
              "bullish",
              "bearish"
            ],
            "description": "方向:bullish 看涨(缺省)/ bearish 看跌"
          },
          "mode": {
            "enum": [
              "touch",
              "fill"
            ],
            "description": "touch 首次触及缺口(缺省)/ fill 完全回补到缺口远端"
          },
          "internal_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "内部结构 pivot 左右各几根,缺省 5"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 2,
            "maximum": 200,
            "description": "摆动结构 pivot 左右各几根,缺省 50"
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "结构突破确认口径:收盘(缺省)或影线"
          },
          "mitigation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "订单块失效口径:影线穿过远端(缺省)或收盘穿过"
          },
          "ob_filter": {
            "enum": [
              "atr",
              "range",
              "none"
            ],
            "description": "挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 1000,
            "description": "高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200"
          },
          "eq_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "等高等低 pivot 左右各几根,缺省 3"
          },
          "eq_threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "description": "等高等低容差 = eq_threshold × ATR,缺省 0.1"
          },
          "fvg_auto": {
            "type": "boolean",
            "description": "FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true"
          }
        }
      },
      "PrimitiveParamsSmcDiscount": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "zone": {
            "enum": [
              "discount",
              "premium",
              "equilibrium"
            ],
            "description": "discount 折价区(区间下半,缺省)/ premium 溢价区(上半)/ equilibrium 均衡区(中线 ±2.5%)"
          },
          "internal_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "内部结构 pivot 左右各几根,缺省 5"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 2,
            "maximum": 200,
            "description": "摆动结构 pivot 左右各几根,缺省 50"
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "结构突破确认口径:收盘(缺省)或影线"
          },
          "mitigation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "订单块失效口径:影线穿过远端(缺省)或收盘穿过"
          },
          "ob_filter": {
            "enum": [
              "atr",
              "range",
              "none"
            ],
            "description": "挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 1000,
            "description": "高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200"
          },
          "eq_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "等高等低 pivot 左右各几根,缺省 3"
          },
          "eq_threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "description": "等高等低容差 = eq_threshold × ATR,缺省 0.1"
          },
          "fvg_auto": {
            "type": "boolean",
            "description": "FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true"
          }
        }
      },
      "PrimitiveParamsSmcTrend": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "scope": {
            "enum": [
              "internal",
              "swing"
            ],
            "description": "结构级别:internal 内部结构 / swing 摆动结构,缺省 swing"
          },
          "direction": {
            "enum": [
              "bullish",
              "bearish"
            ],
            "description": "方向:bullish 看涨(缺省)/ bearish 看跌"
          },
          "internal_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "内部结构 pivot 左右各几根,缺省 5"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 2,
            "maximum": 200,
            "description": "摆动结构 pivot 左右各几根,缺省 50"
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "结构突破确认口径:收盘(缺省)或影线"
          },
          "mitigation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "订单块失效口径:影线穿过远端(缺省)或收盘穿过"
          },
          "ob_filter": {
            "enum": [
              "atr",
              "range",
              "none"
            ],
            "description": "挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 1000,
            "description": "高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200"
          },
          "eq_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "等高等低 pivot 左右各几根,缺省 3"
          },
          "eq_threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "description": "等高等低容差 = eq_threshold × ATR,缺省 0.1"
          },
          "fvg_auto": {
            "type": "boolean",
            "description": "FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true"
          }
        }
      },
      "PrimitiveParamsSmcObLevel": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "scope": {
            "enum": [
              "internal",
              "swing"
            ],
            "description": "结构级别:internal 内部结构 / swing 摆动结构,缺省 internal"
          },
          "buffer_atr": {
            "type": "number",
            "minimum": 0,
            "maximum": 10,
            "description": "止损角色向外让出的 ATR 倍数,缺省 0"
          },
          "internal_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "内部结构 pivot 左右各几根,缺省 5"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 2,
            "maximum": 200,
            "description": "摆动结构 pivot 左右各几根,缺省 50"
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "结构突破确认口径:收盘(缺省)或影线"
          },
          "mitigation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "订单块失效口径:影线穿过远端(缺省)或收盘穿过"
          },
          "ob_filter": {
            "enum": [
              "atr",
              "range",
              "none"
            ],
            "description": "挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 1000,
            "description": "高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200"
          },
          "eq_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "等高等低 pivot 左右各几根,缺省 3"
          },
          "eq_threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "description": "等高等低容差 = eq_threshold × ATR,缺省 0.1"
          },
          "fvg_auto": {
            "type": "boolean",
            "description": "FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true"
          }
        }
      },
      "PrimitiveParamsSmcLiquidityTarget": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "scope": {
            "enum": [
              "internal",
              "swing"
            ],
            "description": "结构级别:internal 内部结构 / swing 摆动结构,缺省 swing"
          },
          "source": {
            "enum": [
              "liquidity",
              "swing",
              "equal",
              "premium",
              "prev_day",
              "prev_week"
            ],
            "description": "止盈来源:liquidity 最近的流动性(未扫 pivot/等高点/区间顶取最近,缺省)/ swing 未扫 pivot / equal 等高(低)点 / premium 溢价区(空单为折价区)/ prev_day 前日高(低)/ prev_week 前周高(低)"
          },
          "internal_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "内部结构 pivot 左右各几根,缺省 5"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 2,
            "maximum": 200,
            "description": "摆动结构 pivot 左右各几根,缺省 50"
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "结构突破确认口径:收盘(缺省)或影线"
          },
          "mitigation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "订单块失效口径:影线穿过远端(缺省)或收盘穿过"
          },
          "ob_filter": {
            "enum": [
              "atr",
              "range",
              "none"
            ],
            "description": "挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 1000,
            "description": "高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200"
          },
          "eq_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "等高等低 pivot 左右各几根,缺省 3"
          },
          "eq_threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "description": "等高等低容差 = eq_threshold × ATR,缺省 0.1"
          },
          "fvg_auto": {
            "type": "boolean",
            "description": "FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true"
          }
        }
      },
      "PrimitiveParamsSmcChochExit": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "scope": {
            "enum": [
              "internal",
              "swing"
            ],
            "description": "结构级别:internal 内部结构 / swing 摆动结构,缺省 internal"
          },
          "kind": {
            "enum": [
              "choch",
              "any"
            ],
            "description": "choch 只认反向 CHoCH(缺省)/ any 反向 BOS 也离场"
          },
          "internal_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "内部结构 pivot 左右各几根,缺省 5"
          },
          "swing_length": {
            "type": "integer",
            "minimum": 2,
            "maximum": 200,
            "description": "摆动结构 pivot 左右各几根,缺省 50"
          },
          "confirmation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "结构突破确认口径:收盘(缺省)或影线"
          },
          "mitigation": {
            "enum": [
              "close",
              "wick"
            ],
            "description": "订单块失效口径:影线穿过远端(缺省)或收盘穿过"
          },
          "ob_filter": {
            "enum": [
              "atr",
              "range",
              "none"
            ],
            "description": "挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤"
          },
          "atr_period": {
            "type": "integer",
            "minimum": 2,
            "maximum": 1000,
            "description": "高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200"
          },
          "eq_length": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "等高等低 pivot 左右各几根,缺省 3"
          },
          "eq_threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "description": "等高等低容差 = eq_threshold × ATR,缺省 0.1"
          },
          "fvg_auto": {
            "type": "boolean",
            "description": "FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true"
          }
        }
      },
      "SmcOverlay": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "params": {
            "type": "object",
            "additionalProperties": true
          },
          "structures": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "at": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "from": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "level": {
                  "type": "number"
                },
                "kind": {
                  "enum": [
                    "BOS",
                    "CHoCH"
                  ]
                },
                "scope": {
                  "enum": [
                    "internal",
                    "swing"
                  ]
                },
                "dir": {
                  "enum": [
                    "bullish",
                    "bearish"
                  ]
                }
              },
              "required": [
                "at",
                "from",
                "level",
                "kind",
                "scope",
                "dir"
              ]
            }
          },
          "order_blocks": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "from": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "formed_at": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "to": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "top": {
                  "type": "number"
                },
                "bottom": {
                  "type": "number"
                },
                "dir": {
                  "enum": [
                    "bullish",
                    "bearish"
                  ]
                },
                "scope": {
                  "enum": [
                    "internal",
                    "swing"
                  ]
                },
                "mitigated_at": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "from",
                "formed_at",
                "to",
                "top",
                "bottom",
                "dir",
                "scope",
                "mitigated_at"
              ]
            }
          },
          "fvgs": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "from": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "formed_at": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "top": {
                  "type": "number"
                },
                "bottom": {
                  "type": "number"
                },
                "dir": {
                  "enum": [
                    "bullish",
                    "bearish"
                  ]
                },
                "touched_at": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "filled_at": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "from",
                "formed_at",
                "top",
                "bottom",
                "dir",
                "touched_at",
                "filled_at"
              ]
            }
          },
          "eq": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "kind": {
                  "enum": [
                    "EQH",
                    "EQL"
                  ]
                },
                "from": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "to": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "level": {
                  "type": "number"
                },
                "confirmed_at": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "swept_at": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind",
                "from",
                "to",
                "level",
                "confirmed_at",
                "swept_at"
              ]
            }
          },
          "zones": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "from": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "to": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "premium": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "top": {
                        "type": "number"
                      },
                      "bottom": {
                        "type": "number"
                      }
                    },
                    "required": [
                      "top",
                      "bottom"
                    ]
                  },
                  "equilibrium": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "top": {
                        "type": "number"
                      },
                      "bottom": {
                        "type": "number"
                      }
                    },
                    "required": [
                      "top",
                      "bottom"
                    ]
                  },
                  "discount": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "top": {
                        "type": "number"
                      },
                      "bottom": {
                        "type": "number"
                      }
                    },
                    "required": [
                      "top",
                      "bottom"
                    ]
                  },
                  "strong_high": {
                    "type": "boolean"
                  },
                  "strong_low": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "from",
                  "to",
                  "premium",
                  "equilibrium",
                  "discount",
                  "strong_high",
                  "strong_low"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "htf_levels": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "kind": {
                  "enum": [
                    "PDH",
                    "PDL",
                    "PWH",
                    "PWL"
                  ]
                },
                "from": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "to": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "level": {
                  "type": "number"
                }
              },
              "required": [
                "kind",
                "from",
                "to",
                "level"
              ]
            }
          },
          "trend": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "internal": {
                "anyOf": [
                  {
                    "enum": [
                      "bullish",
                      "bearish"
                    ]
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "swing": {
                "anyOf": [
                  {
                    "enum": [
                      "bullish",
                      "bearish"
                    ]
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "internal",
              "swing"
            ]
          }
        },
        "required": [
          "params",
          "structures",
          "order_blocks",
          "fvgs",
          "eq",
          "zones",
          "htf_levels",
          "trend"
        ],
        "description": "回放图层(GET /api/research/backtests/:id/replay?overlay=smc 的 smc_overlay 字段):时间一律为 K 线 open_time(ms)"
      },
      "JudgeStateField": {
        "enum": [
          "candidate.direction",
          "candidate.stop_distance_atr",
          "candidate.reward_risk",
          "features.trend",
          "features.volatility",
          "features.volume_ratio",
          "features.funding",
          "features.market_regime"
        ]
      },
      "JudgeQuestion": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "key": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_]{0,47}$"
          },
          "type": {
            "enum": [
              "noul",
              "choice",
              "score"
            ]
          },
          "instructions": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          },
          "criteria": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            },
            "minItems": 2,
            "maxItems": 16
          },
          "state_fields": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/JudgeStateField"
            },
            "minItems": 1,
            "maxItems": 8,
            "uniqueItems": true
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_]{0,47}$"
            },
            "minItems": 2,
            "maxItems": 16,
            "uniqueItems": true
          }
        },
        "required": [
          "key",
          "type",
          "instructions",
          "criteria",
          "state_fields"
        ],
        "allOf": [
          {
            "if": {
              "properties": {
                "type": {
                  "const": "noul"
                }
              }
            },
            "then": {
              "not": {
                "required": [
                  "labels"
                ]
              }
            },
            "else": {
              "required": [
                "labels"
              ]
            }
          }
        ]
      },
      "JudgePredicate": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "question_key": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_]{0,47}$"
          },
          "label": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_]{0,47}$"
          },
          "operator": {
            "enum": [
              "gte",
              "lte"
            ]
          },
          "threshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "margin": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          }
        },
        "required": [
          "question_key",
          "label",
          "operator",
          "threshold",
          "margin"
        ]
      },
      "JudgeAllRule": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "all": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/JudgePredicate"
            },
            "minItems": 1,
            "maxItems": 16
          }
        },
        "required": [
          "all"
        ]
      },
      "StrategyJudge": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "version": {
            "const": 1
          },
          "engine": {
            "enum": [
              "jev",
              "llm"
            ]
          },
          "model_profile_ref": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "state_schema_version": {
            "const": "judge_state_v1"
          },
          "questions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/JudgeQuestion"
            },
            "minItems": 1,
            "maxItems": 8
          },
          "rule": {
            "$ref": "#/$defs/JudgeAllRule"
          },
          "on_uncertain": {
            "const": "skip"
          },
          "on_error": {
            "const": "skip"
          },
          "timeout_ms": {
            "type": "integer",
            "minimum": 100,
            "maximum": 60000
          },
          "max_attempts": {
            "const": 1
          }
        },
        "required": [
          "version",
          "engine",
          "model_profile_ref",
          "state_schema_version",
          "questions",
          "rule",
          "on_uncertain",
          "on_error",
          "timeout_ms",
          "max_attempts"
        ]
      },
      "FrozenModelProfile": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "ref": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "connection_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "connection_revision": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "model": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "model_revision": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "routing": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "parser_version": {
            "const": "judge_answers_v1"
          },
          "max_call_usd": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,12})?$"
          },
          "retry_policy": {
            "const": "none"
          }
        },
        "required": [
          "ref",
          "connection_id",
          "connection_revision",
          "model",
          "model_revision",
          "routing",
          "parser_version",
          "max_call_usd",
          "retry_policy"
        ]
      },
      "JudgeCandidateSnapshot": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "symbol": {
            "type": "string",
            "pattern": "^[A-Z0-9]+USDT$"
          },
          "as_of": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "timeframe_ms": {
            "type": "integer",
            "minimum": 1
          },
          "direction": {
            "enum": [
              "long",
              "short"
            ]
          },
          "entry": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,12})?$"
          },
          "stop": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,12})?$"
          },
          "target": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,12})?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "reward_risk": {
            "anyOf": [
              {
                "type": "number",
                "minimum": 0
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "symbol",
          "as_of",
          "timeframe_ms",
          "direction",
          "entry",
          "stop",
          "target",
          "reward_risk"
        ]
      },
      "JudgeStateV1": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "version": {
            "const": "judge_state_v1"
          },
          "as_of": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "timeframe_ms": {
            "type": "integer",
            "minimum": 1
          },
          "candidate": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "direction": {
                "enum": [
                  "long",
                  "short"
                ]
              },
              "stop_distance_atr": {
                "type": "number",
                "minimum": 0
              },
              "reward_risk": {
                "type": "number",
                "minimum": 0
              }
            },
            "required": []
          },
          "features": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "trend": {
                "enum": [
                  "up",
                  "down"
                ]
              },
              "volatility": {
                "type": "number",
                "minimum": 0
              },
              "volume_ratio": {
                "type": "number",
                "minimum": 0
              },
              "funding": {
                "type": "number"
              },
              "market_regime": {
                "enum": [
                  "up",
                  "down",
                  "volatile"
                ]
              }
            },
            "required": []
          }
        },
        "required": [
          "version",
          "as_of",
          "timeframe_ms",
          "candidate",
          "features"
        ]
      },
      "NormalizedAnswer": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "question_key": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "probabilities": {
            "type": "object",
            "additionalProperties": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            }
          }
        },
        "required": [
          "question_key",
          "probabilities"
        ]
      },
      "PredicateEvaluation": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "question_key": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "probability": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "conservative": {
            "type": "number"
          },
          "passed": {
            "type": "boolean"
          }
        },
        "required": [
          "question_key",
          "label",
          "probability",
          "conservative",
          "passed"
        ]
      },
      "JudgeResult": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "status": {
            "enum": [
              "ok",
              "uncertain",
              "error"
            ]
          },
          "action": {
            "enum": [
              "follow",
              "skip"
            ]
          },
          "decision_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160
          },
          "state_hash": {
            "type": "string"
          },
          "request_hash": {
            "type": "string"
          },
          "raw_response_ref": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1,
                "maxLength": 160
              },
              {
                "type": "null"
              }
            ]
          },
          "answers": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/NormalizedAnswer"
            }
          },
          "predicates": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PredicateEvaluation"
            }
          },
          "model_revision": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1,
                "maxLength": 160
              },
              {
                "type": "null"
              }
            ]
          },
          "latency_ms": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "cost_usd": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]{1,12})?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "cost_status": {
            "enum": [
              "actual",
              "estimated",
              "unknown"
            ]
          },
          "reason_codes": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "status",
          "action",
          "decision_id",
          "state_hash",
          "request_hash",
          "raw_response_ref",
          "answers",
          "predicates",
          "model_revision",
          "latency_ms",
          "cost_usd",
          "cost_status",
          "reason_codes"
        ]
      }
    },
    "description": " IR v1 不加字段、不改哈希；v2 必须含 judge，只有订单执行核支持 judge。"
  },
  "rpc": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/rpc.json",
    "title": "ExecutionServiceRpc",
    "description": "gateway ↔ execd 的 UDS 契约:JSON-RPC 2.0,每帧一行(newline-delimited,UTF-8,单帧 ≤ 4 MiB)。execd 监听 ~/.trading-swarm/run/execd.sock(0600)。请求方法见 Method;execd → gateway 的通知只有 exec.event。错误码映射见 tables/error_codes.json。",
    "oneOf": [
      {
        "$ref": "#/$defs/RpcRequest"
      },
      {
        "$ref": "#/$defs/RpcSuccess"
      },
      {
        "$ref": "#/$defs/RpcFailure"
      },
      {
        "$ref": "#/$defs/RpcNotification"
      }
    ],
    "$defs": {
      "Method": {
        "type": "string",
        "enum": [
          "exec.health",
          "exec.intent.propose",
          "exec.intent.get",
          "exec.intent.list",
          "exec.intent.authorize",
          "exec.intent.reject",
          "exec.account.snapshot",
          "exec.exchange.status",
          "exec.policy.get",
          "exec.policy.set",
          "exec.emergency_stop",
          "exec.events.subscribe",
          "exec.oauth.start",
          "exec.oauth.status",
          "exec.oauth.revoke",
          "exec.credentials.public_key",
          "exec.credentials.set",
          "exec.credentials.status"
        ]
      },
      "RpcId": {
        "oneOf": [
          {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          {
            "type": "integer",
            "minimum": 0
          }
        ]
      },
      "RpcRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "jsonrpc",
          "id",
          "method",
          "params"
        ],
        "properties": {
          "jsonrpc": {
            "const": "2.0"
          },
          "id": {
            "$ref": "#/$defs/RpcId"
          },
          "method": {
            "$ref": "#/$defs/Method"
          },
          "params": {
            "type": "object"
          }
        }
      },
      "RpcSuccess": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "jsonrpc",
          "id",
          "result"
        ],
        "properties": {
          "jsonrpc": {
            "const": "2.0"
          },
          "id": {
            "$ref": "#/$defs/RpcId"
          },
          "result": {
            "type": "object"
          }
        }
      },
      "RpcErrorData": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "retryable"
        ],
        "properties": {
          "kind": {
            "$ref": "common.json#/$defs/ErrorKind"
          },
          "retryable": {
            "type": "boolean"
          },
          "details": {
            "type": "object"
          }
        }
      },
      "RpcError": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "code",
          "message",
          "data"
        ],
        "properties": {
          "code": {
            "type": "integer"
          },
          "message": {
            "type": "string",
            "maxLength": 2000
          },
          "data": {
            "$ref": "#/$defs/RpcErrorData"
          }
        }
      },
      "RpcFailure": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "jsonrpc",
          "id",
          "error"
        ],
        "properties": {
          "jsonrpc": {
            "const": "2.0"
          },
          "id": {
            "oneOf": [
              {
                "$ref": "#/$defs/RpcId"
              },
              {
                "type": "null"
              }
            ]
          },
          "error": {
            "$ref": "#/$defs/RpcError"
          }
        }
      },
      "RpcNotification": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "jsonrpc",
          "method",
          "params"
        ],
        "properties": {
          "jsonrpc": {
            "const": "2.0"
          },
          "method": {
            "const": "exec.event"
          },
          "params": {
            "$ref": "events.json"
          }
        }
      },
      "ChannelHealth": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "state"
        ],
        "properties": {
          "state": {
            "type": "string",
            "enum": [
              "ok",
              "degraded",
              "down",
              "unconfigured"
            ]
          },
          "detail": {
            "type": "string",
            "maxLength": 500
          },
          "last_ok_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "HealthParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "HealthResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ok",
          "version",
          "writer_instance_id",
          "lease_epoch",
          "started_at",
          "now",
          "db_ok",
          "mode",
          "halted",
          "open_intents",
          "unknown_attempts",
          "channels"
        ],
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "version": {
            "type": "string",
            "maxLength": 64
          },
          "writer_instance_id": {
            "type": "string",
            "maxLength": 128
          },
          "lease_epoch": {
            "type": "integer",
            "minimum": 0
          },
          "started_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "now": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "db_ok": {
            "type": "boolean"
          },
          "mode": {
            "$ref": "common.json#/$defs/PolicyMode"
          },
          "halted": {
            "type": "boolean"
          },
          "open_intents": {
            "type": "integer",
            "minimum": 0
          },
          "unknown_attempts": {
            "type": "integer",
            "minimum": 0
          },
          "channels": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "main",
              "sub"
            ],
            "properties": {
              "main": {
                "$ref": "#/$defs/ChannelHealth"
              },
              "sub": {
                "$ref": "#/$defs/ChannelHealth"
              }
            }
          }
        }
      },
      "IntentProposeParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "account",
          "principal",
          "surface",
          "params"
        ],
        "properties": {
          "account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          },
          "session_id": {
            "type": "string",
            "maxLength": 128
          },
          "run_id": {
            "type": "string",
            "maxLength": 128
          },
          "origin": {
            "type": "string",
            "maxLength": 256
          },
          "idempotency_key": {
            "type": "string",
            "maxLength": 128
          },
          "params": {
            "$ref": "intent.json#/$defs/IntentParams"
          },
          "ttl_seconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 86400
          }
        }
      },
      "IntentProposeResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent",
          "gate_rejections"
        ],
        "properties": {
          "intent": {
            "$ref": "intent.json"
          },
          "plan": {
            "$ref": "plan.json"
          },
          "gate_rejections": {
            "type": "array",
            "items": {
              "$ref": "common.json#/$defs/GateRejection"
            }
          }
        }
      },
      "IntentGetParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent_id"
        ],
        "properties": {
          "intent_id": {
            "$ref": "common.json#/$defs/Uuid"
          }
        }
      },
      "IntentBundle": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent",
          "attempts",
          "orders",
          "fills"
        ],
        "properties": {
          "intent": {
            "$ref": "intent.json"
          },
          "plan": {
            "$ref": "plan.json"
          },
          "authorization": {
            "$ref": "authorization.json"
          },
          "attempts": {
            "type": "array",
            "items": {
              "$ref": "attempt.json"
            }
          },
          "orders": {
            "type": "array",
            "items": {
              "$ref": "exchange_order.json"
            }
          },
          "fills": {
            "type": "array",
            "items": {
              "$ref": "fill.json"
            }
          },
          "effect": {
            "$ref": "position_effect.json"
          }
        }
      },
      "IntentListParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "status": {
            "type": "array",
            "items": {
              "$ref": "common.json#/$defs/IntentStatus"
            }
          },
          "account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "kind": {
            "$ref": "common.json#/$defs/IntentKind"
          },
          "since": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500
          }
        }
      },
      "IntentListResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intents"
        ],
        "properties": {
          "intents": {
            "type": "array",
            "items": {
              "$ref": "intent.json"
            }
          }
        }
      },
      "IntentAuthorizeParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent_id",
          "plan_hash",
          "principal",
          "surface",
          "confirm_echo"
        ],
        "properties": {
          "intent_id": {
            "$ref": "common.json#/$defs/Uuid"
          },
          "plan_hash": {
            "$ref": "common.json#/$defs/Hash256"
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          },
          "actor_ref": {
            "type": "string",
            "maxLength": 256
          },
          "confirm_echo": {
            "type": "object",
            "additionalProperties": {
              "type": "string",
              "maxLength": 200
            }
          }
        },
        "description": "只接受 principal=user;plan_hash 或 confirm_echo 与当前 plan 不符 → conflict"
      },
      "IntentAuthorizeResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent",
          "authorization"
        ],
        "properties": {
          "intent": {
            "$ref": "intent.json"
          },
          "authorization": {
            "$ref": "authorization.json"
          }
        }
      },
      "IntentRejectParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent_id",
          "reason",
          "principal",
          "surface"
        ],
        "properties": {
          "intent_id": {
            "$ref": "common.json#/$defs/Uuid"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        }
      },
      "IntentRejectResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent"
        ],
        "properties": {
          "intent": {
            "$ref": "intent.json"
          }
        }
      },
      "AccountSnapshotParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "account"
        ],
        "properties": {
          "account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "max_age_ms": {
            "type": "integer",
            "minimum": 0
          },
          "force_refresh": {
            "type": "boolean"
          }
        }
      },
      "AccountSnapshotResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "snapshot"
        ],
        "properties": {
          "snapshot": {
            "$ref": "account_snapshot.json"
          }
        }
      },
      "OauthState": {
        "type": "string",
        "enum": [
          "missing",
          "fresh",
          "expiring",
          "expired",
          "revoked"
        ]
      },
      "OauthStatus": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "state",
          "has_refresh"
        ],
        "properties": {
          "state": {
            "$ref": "#/$defs/OauthState"
          },
          "expires_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "has_refresh": {
            "type": "boolean"
          },
          "scopes": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            }
          },
          "client_id": {
            "type": "string",
            "maxLength": 512
          },
          "obtained_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "MainKeyPermissions": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "reading": {
            "type": "boolean"
          },
          "spot_margin_trading": {
            "type": "boolean"
          },
          "futures": {
            "type": "boolean"
          },
          "universal_transfer": {
            "type": "boolean"
          },
          "withdrawals": {
            "type": "boolean"
          },
          "ip_restricted": {
            "type": "boolean"
          }
        }
      },
      "MainChannelStatus": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "configured",
          "user_stream",
          "rest_gate"
        ],
        "properties": {
          "configured": {
            "type": "boolean"
          },
          "key_fingerprint": {
            "type": "string",
            "maxLength": 32,
            "description": "sha256(api_key) 前 16 hex,只用于识别不是密钥"
          },
          "permissions": {
            "$ref": "#/$defs/MainKeyPermissions"
          },
          "user_stream": {
            "type": "string",
            "enum": [
              "connected",
              "stale",
              "disconnected",
              "unconfigured"
            ]
          },
          "time_offset_ms": {
            "type": "integer"
          },
          "rest_gate": {
            "type": "string",
            "enum": [
              "ready",
              "wait",
              "banned",
              "unconfigured"
            ]
          },
          "last_verified_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "SubChannelStatus": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "configured",
          "oauth",
          "mcp_session",
          "drift"
        ],
        "properties": {
          "configured": {
            "type": "boolean"
          },
          "oauth": {
            "$ref": "#/$defs/OauthStatus"
          },
          "mcp_session": {
            "type": "string",
            "enum": [
              "active",
              "none",
              "lost"
            ]
          },
          "tools_hash": {
            "$ref": "common.json#/$defs/Hash256"
          },
          "tools_pinned_hash": {
            "$ref": "common.json#/$defs/Hash256"
          },
          "tools_count": {
            "type": "integer",
            "minimum": 0
          },
          "drift": {
            "type": "boolean",
            "description": "tools_hash != tools_pinned_hash → 写路径 HALT"
          },
          "subaccount_ref": {
            "type": "string",
            "maxLength": 128,
            "description": "Agentic 子账户稳定标识(A1 实测 MCP 是否暴露)"
          }
        }
      },
      "ExchangeStatusParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "ExchangeStatusResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "main",
          "sub",
          "writer"
        ],
        "properties": {
          "main": {
            "$ref": "#/$defs/MainChannelStatus"
          },
          "sub": {
            "$ref": "#/$defs/SubChannelStatus"
          },
          "writer": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "instance_id",
              "lease_epoch",
              "since"
            ],
            "properties": {
              "instance_id": {
                "type": "string",
                "maxLength": 128
              },
              "lease_epoch": {
                "type": "integer",
                "minimum": 0
              },
              "since": {
                "$ref": "common.json#/$defs/TimestampMs"
              }
            }
          }
        }
      },
      "PolicyGetParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "PolicyGetResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "policy"
        ],
        "properties": {
          "policy": {
            "$ref": "policy.json"
          }
        }
      },
      "PolicySetParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "policy",
          "confirm",
          "principal",
          "surface"
        ],
        "properties": {
          "policy": {
            "$ref": "policy.json"
          },
          "confirm": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode",
              "authority"
            ],
            "properties": {
              "mode": {
                "type": "string",
                "maxLength": 32
              },
              "authority": {
                "type": "string",
                "maxLength": 32
              }
            },
            "description": "逐字回填新 policy 的 mode/authority(设计 §10.4)"
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        }
      },
      "PolicySetResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "policy"
        ],
        "properties": {
          "policy": {
            "$ref": "policy.json"
          }
        }
      },
      "EmergencyStopParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "mode",
          "reason",
          "principal",
          "surface"
        ],
        "properties": {
          "mode": {
            "type": "string",
            "enum": [
              "stop_opening",
              "flatten_only",
              "halt_all"
            ]
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        },
        "description": "只能收紧;放松要走 policy.set + confirm"
      },
      "EmergencyStopResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "policy"
        ],
        "properties": {
          "policy": {
            "$ref": "policy.json"
          }
        }
      },
      "EventsSubscribeParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "since_seq": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "EventsSubscribeResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ok",
          "current_seq"
        ],
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "current_seq": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "OauthStartParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "scopes": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            }
          },
          "open_browser": {
            "type": "boolean"
          }
        }
      },
      "OauthStartResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "authorize_url",
          "state",
          "expires_at"
        ],
        "properties": {
          "authorize_url": {
            "type": "string",
            "maxLength": 4096
          },
          "state": {
            "type": "string",
            "maxLength": 128
          },
          "expires_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        },
        "description": "回调由 execd 自己在回环端口接收;code/verifier 不经过 gateway"
      },
      "OauthStatusParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "OauthStatusResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "oauth"
        ],
        "properties": {
          "oauth": {
            "$ref": "#/$defs/OauthStatus"
          }
        }
      },
      "OauthRevokeParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "principal",
          "surface"
        ],
        "properties": {
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        }
      },
      "OauthRevokeResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ok"
        ],
        "properties": {
          "ok": {
            "type": "boolean"
          }
        }
      },
      "SealedSecret": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "alg",
          "ephemeral_public_key",
          "iv",
          "ciphertext"
        ],
        "properties": {
          "alg": {
            "const": "ecdh-p256-hkdf-sha256-aes256gcm"
          },
          "ephemeral_public_key": {
            "type": "string",
            "maxLength": 200,
            "description": "base64,65 字节未压缩点"
          },
          "iv": {
            "type": "string",
            "maxLength": 32,
            "description": "base64,12 字节"
          },
          "ciphertext": {
            "type": "string",
            "maxLength": 8192,
            "description": "base64;明文是 UTF-8 JSON {api_key, api_secret}"
          }
        },
        "description": "浏览器用 execd 的 P-256 公钥做 ECDH → HKDF-SHA256(salt 空, info 'trading-swarm/credentials/v1') → AES-256-GCM;gateway 只转发密文,TS 进程永远拿不到明文(AGENTS.md 规矩 1)"
      },
      "CredentialsPublicKeyParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "CredentialsPublicKeyResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "alg",
          "public_key",
          "expires_at"
        ],
        "properties": {
          "alg": {
            "const": "ecdh-p256-hkdf-sha256-aes256gcm"
          },
          "public_key": {
            "type": "string",
            "maxLength": 200
          },
          "expires_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "CredentialsSetParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "sealed",
          "principal",
          "surface"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "main_api_key"
            ]
          },
          "sealed": {
            "$ref": "#/$defs/SealedSecret"
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        }
      },
      "CredentialsSetResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ok"
        ],
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "key_fingerprint": {
            "type": "string",
            "maxLength": 32
          },
          "permissions": {
            "$ref": "#/$defs/MainKeyPermissions"
          }
        }
      },
      "CredentialsStatusParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "CredentialsStatusResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "main_api_key",
          "oauth"
        ],
        "properties": {
          "main_api_key": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "present"
            ],
            "properties": {
              "present": {
                "type": "boolean"
              },
              "key_fingerprint": {
                "type": "string",
                "maxLength": 32
              },
              "permissions": {
                "$ref": "#/$defs/MainKeyPermissions"
              },
              "last_verified_at": {
                "$ref": "common.json#/$defs/TimestampMs"
              }
            }
          },
          "oauth": {
            "$ref": "#/$defs/OauthStatus"
          }
        }
      }
    }
  }
} as const;
