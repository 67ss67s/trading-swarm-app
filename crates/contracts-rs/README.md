# contracts-rs —— 契约的 Rust 侧

与 `packages/contracts/schema/*.json` 逐字段对拍的手写 serde 结构(规则见 `docs/contracts/README.md`)。运行时不依赖 packages 目录:四张转移表与三张小表都 `include_str!` 进二进制。

- `scalars`:`Uuid`/`Decimal`/`UnsignedDecimal`/`Hash256`/`Symbol`/`Asset`/`ClientOrderId` 带校验 newtype(反序列化即校验,序列化透明);
- `enums`:common.json 全部枚举(`ALL`/`as_str`/`parse`);`ErrorInfo`/`GateRejection`;
- `intent` / `plan` / `records`(Authorization、ExecutionAttempt、ExchangeOrderObservation、Fill、PositionEffect、ExecPolicy、ExecEvent)/ `account_snapshot` / `rpc`(帧、Method、18 个方法的 Params/Result、NDJSON 编解码);
- `canonical`:`canonical_json`、`plan_hash`、`account_version`;`confirm`:`confirm_fields` / `confirm_echo_matches`;`client_order_id`;`transitions`(`can_transition`/`next_state` + 强类型 `IntentStatus::transition_to` 等);`error_codes`。

测试:`CARGO_TARGET_DIR=target/a0-rust cargo test -p contracts-rs`(R3 fixtures 双向字节相等 + jsonschema 校验、R4 全字段实例过 schema、R5 哈希向量、R6 表生成六条规则、枚举对拍)。给 TS 侧的 R4 产物:`cargo test -p contracts-rs --test emit_roundtrip -- --ignored` → `target/roundtrip/<schema>/rust_*.json`。
