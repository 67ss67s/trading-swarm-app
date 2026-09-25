/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: packages/contracts/{schema,transitions,tables}/*.json
 * Regenerate: `npm run generate` in packages/contracts (`npm run generate:check` verifies in CI).
 * Changing schema/transitions/tables is a main-line-only change — see docs/contracts/README.md §10.
 */

export const tables = {
  "client_order_id": {
    "version": 1,
    "description": "本机 clientOrderId 方案。调用前持久化;按前缀分本机/外部(设计 §8.4 外部订单检测,借 8794 detect_order_origins 口径)。",
    "prefix": "tg-",
    "format": "tg-{intent12}-{leg_code}{leg_index}-{attempt_no}",
    "intent12": "intent_id 去掉连字符后的前 12 个小写 hex",
    "leg_codes": {
      "entry": "e",
      "stop": "s",
      "take_profit": "t",
      "cancel": "c",
      "close": "x",
      "transfer": "f"
    },
    "max_len": 36,
    "charset": "^[\\.A-Z:/a-z0-9_-]{1,36}$",
    "foreign_prefixes": [
      "ts_"
    ],
    "examples": [
      {
        "intent_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
        "leg": "entry",
        "leg_index": 0,
        "attempt_no": 1,
        "client_order_id": "tg-0f8fad5bd9cb-e0-1"
      },
      {
        "intent_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
        "leg": "take_profit",
        "leg_index": 1,
        "attempt_no": 2,
        "client_order_id": "tg-0f8fad5bd9cb-t1-2"
      }
    ]
  },
  "confirm_fields": {
    "version": 1,
    "description": "结构化确认(设计 §10.4):审批面必须逐字回填这些字段;execd 用 plan.economic 派生同一张 map 逐字比对。值一律字符串:缺省(null/undefined)字段不出现;布尔写 'true'/'false';整数十进制;数组/对象字段写 canonical_json 字符串。plan_hash 永远参与。",
    "always": [
      "plan_hash"
    ],
    "by_kind": {
      "order": [
        "symbol",
        "side",
        "qty",
        "order_type",
        "price",
        "trigger_price",
        "leverage",
        "reduce_only"
      ],
      "protect": [
        "symbol",
        "position_side",
        "legs"
      ],
      "cancel": [
        "symbol",
        "exchange_order_id",
        "client_order_id"
      ],
      "transfer": [
        "asset",
        "amount",
        "from_account",
        "to_account"
      ]
    }
  },
  "error_codes": {
    "version": 1,
    "description": "ErrorKind ↔ JSON-RPC error.code 的唯一映射;两种语言都从这张表生成/校验。",
    "jsonrpc": {
      "parse_error": -32700,
      "invalid_request": -32600,
      "method_not_found": -32601,
      "invalid_params": -32602,
      "internal_error": -32603
    },
    "kinds": {
      "invalid_params": -32602,
      "internal": -32603,
      "not_found": 1001,
      "forbidden": 1002,
      "halted": 1003,
      "stale": 1004,
      "unavailable": 1005,
      "conflict": 1006,
      "expired": 1007,
      "invalid_transition": 1008,
      "gate_rejected": 1009,
      "exchange_rejected": 1010,
      "unauthorized": 1011,
      "rate_limited": 1012,
      "transport_ambiguous": 1013
    },
    "retryable_default": {
      "invalid_params": false,
      "internal": false,
      "not_found": false,
      "forbidden": false,
      "halted": false,
      "stale": true,
      "unavailable": true,
      "conflict": false,
      "expired": false,
      "invalid_transition": false,
      "gate_rejected": false,
      "exchange_rejected": false,
      "unauthorized": false,
      "rate_limited": true,
      "transport_ambiguous": false
    }
  }
} as const;
