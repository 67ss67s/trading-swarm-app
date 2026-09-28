//! contracts-rs —— trade-gate 契约的 Rust 侧(与 `packages/contracts` 的 JSON Schema 逐字段对拍)。
//!
//! 唯一契约源是 `packages/contracts/schema/*.json`;本 crate 的每个结构都是手写 serde
//! 镜像,由 `tests/` 里的 round-trip(R3/R4/R5/R6)保证不漂移。规则见 `docs/contracts/README.md`:
//! - 所有 struct `deny_unknown_fields`;可选字段 `Option` + `skip_serializing_if`,绝不输出 null
//!   (唯一例外:`RpcFailure.id` 允许 null,schema 如此);
//! - 金额/价格/数量是带校验的十进制字符串 newtype;时间戳 unix 毫秒 i64;
//! - 状态只按 `transitions/*.json` 迁移;哈希按 `canonical` 模块。

pub mod account_snapshot;
pub mod canonical;
pub mod client_order_id;
pub mod confirm;
pub mod enums;
pub mod error_codes;
pub mod intent;
pub mod plan;
pub mod records;
pub mod rpc;
pub mod scalars;
pub mod transitions;

pub use account_snapshot::{AccountComponents, AccountSnapshot, AccountSummary, BalanceRow, Component, FillRow, MarginInfo, OrderRow, PositionRow};
pub use canonical::{CanonicalError, account_version, account_version_of, canonical_json, canonical_json_of, canonicalize, plan_hash, sha256_hex};
pub use client_order_id::{ParsedClientOrderId, classify_order_origin, client_order_id, parse_local};
pub use confirm::{confirm_echo_matches, confirm_fields};
pub use enums::*;
pub use intent::{CancelOrderParams, CloseParams, EntrySpec, Intent, IntentParams, OpenParams, OrderRef, ProtectParams, SizeHint, SizeSpec, StopRef, TakeProfitSpec, TransferParams};
pub use plan::{CancelEconomics, ExecutableOrderPlan, MarketRef, OrderEconomics, PlanBasis, PlanEconomics, ProtectEconomics, Protection, ProtectionLeg, ProtectionOrderType, SizingBasis, SizingMethod, SymbolFilters, TransferEconomics};
pub use records::{Authorization, AuthorizedBy, CanaryPolicy, Caps, EventName, ExchangeOrderObservation, ExecEvent, ExecPolicy, ExecutionAttempt, Fill, MainAccountPolicy, PositionEffect};
pub use rpc::{FrameDecoder, Method, RpcError, RpcFailure, RpcFrame, RpcId, RpcNotification, RpcRequest, RpcSuccess, encode_frame};
pub use scalars::{Asset, ClientOrderId, Decimal, Hash256, ScalarError, Symbol, TimestampMs, UnsignedDecimal, Uuid};
pub use transitions::{InvalidTransition, can_transition, is_terminal, next_state};

/// `packages/contracts` 在磁盘上的位置(测试与工具用;运行时不依赖它,表都已 include_str!)。
pub fn contracts_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts")
}
