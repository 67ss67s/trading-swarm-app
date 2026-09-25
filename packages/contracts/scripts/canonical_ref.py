#!/usr/bin/env python3
"""第三方仲裁实现:canonical JSON + sha256(不依赖 TS/Rust 任何一方)。

规则(docs/contracts/README.md「canonical_json」):
1. 递归删除值为 null 的对象成员(数组里的 null 保留——契约里不应出现,出现即 schema 不过);
2. 对象成员按 key 的 Unicode 码位升序排序(所有契约 key 都是 ASCII);
3. 紧凑输出:无空白;字符串按 JSON 规范转义,非 ASCII 不转义(ensure_ascii=False);
4. 数字只允许整数(金额等一律字符串);
5. sha256 → 小写 hex。

用法:
  python3 canonical_ref.py canon  < in.json     # 输出 canonical 字符串
  python3 canonical_ref.py hash   < in.json     # 输出 sha256
  python3 canonical_ref.py vectors                # 重新生成 fixtures/hash/vectors.json
"""
import hashlib
import json
import pathlib
import sys


def strip_nulls(value):
    if isinstance(value, dict):
        return {k: strip_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [strip_nulls(v) for v in value]
    if isinstance(value, float):
        raise ValueError("canonical json 不允许浮点数,金额请用十进制字符串")
    return value


def canonical(value) -> str:
    return json.dumps(strip_nulls(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE.parent / "fixtures"


def build_vectors():
    order = {
        "kind": "order",
        "product": "usdm_perp",
        "symbol": "BTCUSDT",
        "side": "buy",
        "position_side": "both",
        "position_mode": "one_way",
        "order_type": "limit",
        "qty": "0.002",
        "price": "60000.5",
        "time_in_force": "gtc",
        "reduce_only": False,
        "close_position": False,
        "leverage": 2,
        "margin_type": "isolated",
        "protection": {
            "stop": {
                "order_type": "stop_market",
                "trigger_price": "59000",
                "working_type": "mark_price",
                "close_position": True,
            },
            "take_profits": [
                {
                    "order_type": "take_profit_market",
                    "trigger_price": "62000",
                    "qty": "0.001",
                    "working_type": "mark_price",
                    "close_position": False,
                }
            ],
        },
        "max_naked_seconds": 20,
    }
    order_with_nulls = dict(order)
    order_with_nulls["trigger_price"] = None
    order_with_nulls["working_type"] = None
    transfer = {
        "kind": "transfer",
        "asset": "USDT",
        "amount": "25",
        "from_account": "main",
        "from_wallet": "spot",
        "to_account": "sub",
        "to_wallet": "usdm_futures",
    }
    cancel = {
        "kind": "cancel",
        "product": "usdm_perp",
        "symbol": "ETHUSDT",
        "client_order_id": "tg-0f8fad5bd9cb-e0-1",
    }
    protect = {
        "kind": "protect",
        "product": "usdm_perp",
        "symbol": "ETHUSDT",
        "position_side": "both",
        "legs": [
            {
                "order_type": "stop_market",
                "trigger_price": "2900.10",
                "working_type": "mark_price",
                "close_position": True,
            }
        ],
        "replace_order_ids": ["123456789", "123456790"],
    }
    unicode_note = {"kind": "cancel", "product": "spot", "symbol": "BTCUSDT", "exchange_order_id": "注释-☃-1"}
    account_components = {
        "balances": [
            {"asset": "USDT", "wallet": "usdm_futures", "wallet_balance": "1000.5", "available": "900"},
        ],
        "positions": [],
        "open_orders": [],
        "position_mode": {"mode": "one_way"},
    }
    vectors = []
    for name, value in [
        ("order_limit_with_protection", order),
        ("order_same_but_null_optionals", order_with_nulls),
        ("transfer_main_to_sub", transfer),
        ("cancel_by_client_order_id", cancel),
        ("protect_replace", protect),
        ("unicode_passthrough", unicode_note),
        ("account_version_components", account_components),
    ]:
        c = canonical(value)
        vectors.append({"name": name, "input": value, "canonical": c, "sha256": sha256_hex(c)})
    out = {
        "version": 1,
        "description": "由 scripts/canonical_ref.py 生成;TS 与 Rust 的 canonical_json/plan_hash/account_version 必须逐条等于这里的值。",
        "vectors": vectors,
    }
    (FIXTURES / "hash").mkdir(parents=True, exist_ok=True)
    path = FIXTURES / "hash" / "vectors.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path} ({len(vectors)} vectors)")


def main(argv):
    if len(argv) < 2 or argv[1] not in {"canon", "hash", "vectors"}:
        print(__doc__)
        return 2
    if argv[1] == "vectors":
        build_vectors()
        return 0
    value = json.load(sys.stdin)
    c = canonical(value)
    print(c if argv[1] == "canon" else sha256_hex(c))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
