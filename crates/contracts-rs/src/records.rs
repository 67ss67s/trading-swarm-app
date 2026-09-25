//! 其余五种记录:Authorization / ExecutionAttempt / ExchangeOrderObservation / Fill / PositionEffect,
//! 以及 ExecPolicy 与 ExecEvent(各对应同名 schema 文件)。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::enums::{
    AccountRef, AttemptResult, AttemptStage, Authority, Channel, EffectStatus, ErrorInfo, ExchangeOrderStatus,
    IntentKind, Leg, ObservationSource, OrderOrigin, OrderType, PolicyMode, PositionSide, Principal, Product, Side,
    Surface, TimeInForce, WorkingType, schema_version,
};
use crate::scalars::{Asset, ClientOrderId, Decimal, Hash256, Symbol, TimestampMs, UnsignedDecimal, Uuid};

// ---------------------------------------------------------------------------
// authorization.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizedBy {
    User,
    Policy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Authorization {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub authorization_id: Uuid,
    pub intent_id: Uuid,
    pub plan_id: Uuid,
    pub plan_hash: Hash256,
    pub by: AuthorizedBy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal: Option<Principal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<Surface>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_ref: Option<String>,
    pub status: crate::enums::AuthorizationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
    /// 审批面回填的字段;by=user 必填(schema if/then,见 [`Authorization::validate`])。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_echo: Option<BTreeMap<String, String>>,
    pub granted_at: TimestampMs,
    pub expires_at: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumed_at: Option<TimestampMs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumed_by_attempt_id: Option<Uuid>,
}

impl Authorization {
    /// schema 的 `if by==user then required [confirm_echo, principal, surface]`。
    pub fn validate(&self) -> Result<(), String> {
        if self.by == AuthorizedBy::User {
            if self.confirm_echo.is_none() {
                return Err("by=user 的授权必须带 confirm_echo".into());
            }
            if self.principal.is_none() || self.surface.is_none() {
                return Err("by=user 的授权必须带 principal 与 surface".into());
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// attempt.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionAttempt {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub attempt_id: Uuid,
    pub intent_id: Uuid,
    pub plan_id: Uuid,
    pub plan_hash: Hash256,
    pub attempt_no: u32,
    pub leg: Leg,
    pub leg_index: u32,
    pub account: AccountRef,
    pub channel: Channel,
    pub client_order_id: ClientOrderId,
    /// canonical_json(实际发送给交易所的参数,脱敏)。
    pub order_fingerprint: String,
    pub writer_instance_id: String,
    pub lease_epoch: u64,
    pub fencing_token: String,
    pub stage: AttemptStage,
    pub result: AttemptResult,
    pub created_at: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitted_at: Option<TimestampMs>,
    pub deadline_at: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_at: Option<TimestampMs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_hash: Option<Hash256>,
}

// ---------------------------------------------------------------------------
// exchange_order.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExchangeOrderObservation {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub observation_id: Uuid,
    pub account: AccountRef,
    pub channel: Channel,
    pub source: ObservationSource,
    pub product: Product,
    pub symbol: Symbol,
    pub exchange_order_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_order_id: Option<ClientOrderId>,
    pub status: ExchangeOrderStatus,
    pub side: Side,
    pub position_side: PositionSide,
    pub order_type: OrderType,
    pub orig_qty: UnsignedDecimal,
    pub executed_qty: UnsignedDecimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cum_quote: Option<UnsignedDecimal>,
    pub reduce_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_position: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_in_force: Option<TimeInForce>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_type: Option<WorkingType>,
    pub origin: OrderOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_update_time: Option<TimestampMs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_create_time: Option<TimestampMs>,
    pub observed_at: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_hash: Option<Hash256>,
}

// ---------------------------------------------------------------------------
// fill.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fill {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub fill_id: Uuid,
    pub account: AccountRef,
    pub channel: Channel,
    pub source: ObservationSource,
    pub product: Product,
    pub symbol: Symbol,
    pub exchange_order_id: String,
    pub trade_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_order_id: Option<ClientOrderId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<Uuid>,
    pub side: Side,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_side: Option<PositionSide>,
    pub qty: UnsignedDecimal,
    pub price: UnsignedDecimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_qty: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commission: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commission_asset: Option<Asset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realized_pnl: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_maker: Option<bool>,
    pub trade_time: TimestampMs,
    pub observed_at: TimestampMs,
}

// ---------------------------------------------------------------------------
// position_effect.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PositionEffect {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub effect_id: Uuid,
    pub intent_id: Uuid,
    pub plan_id: Uuid,
    pub kind: IntentKind,
    pub account: AccountRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<Symbol>,
    pub status: EffectStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_qty: Option<UnsignedDecimal>,
    pub filled_qty: UnsignedDecimal,
    pub remaining_qty: UnsignedDecimal,
    pub remaining_canceled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_fill_price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_fill_at: Option<TimestampMs>,
    pub protection_required: bool,
    pub protection_confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection_confirmed_at: Option<TimestampMs>,
    pub protection_order_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub naked_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compensation_close_attempt_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_qty_after: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    pub evaluated_at: TimestampMs,
}

// ---------------------------------------------------------------------------
// policy.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecPolicy {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub version: u32,
    pub updated_at: TimestampMs,
    pub mode: PolicyMode,
    pub authority: Authority,
    pub emergency_stop: bool,
    /// feature gate;v1 保持 false,延后到 §16 Q6 解决。
    pub live_capped_enabled: bool,
    pub symbol_allowlist: Vec<Symbol>,
    pub product_allowlist: Vec<Product>,
    pub caps: Caps,
    pub main_account: MainAccountPolicy,
    pub canary: CanaryPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Caps {
    pub max_leverage: u8,
    pub risk_pct_per_trade: UnsignedDecimal,
    pub max_order_notional: UnsignedDecimal,
    pub max_position_notional: UnsignedDecimal,
    pub max_daily_opens: u32,
    pub daily_loss_stop_pct: UnsignedDecimal,
    pub symbol_cooldown_seconds: u32,
    pub max_naked_seconds: u32,
    pub account_truth_max_age_ms: u64,
    pub market_max_age_ms: u64,
    pub authorization_ttl_market_seconds: u32,
    pub authorization_ttl_limit_seconds: u32,
    pub max_price_deviation_bps: u32,
    pub ntp_drift_block_ms: u64,
    pub ntp_drift_halt_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MainAccountPolicy {
    pub manual_trading_enabled: bool,
    pub transfers_enabled: bool,
    /// v1 恒 false(schema `const false`);见 [`MainAccountPolicy::validate`]。
    pub withdraw_enabled: bool,
}

impl MainAccountPolicy {
    pub fn validate(&self) -> Result<(), String> {
        if self.withdraw_enabled {
            return Err("withdraw_enabled 在 v1 契约里恒为 false(§16 Q7 默认不勾提币)".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanaryPolicy {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_loss_quote: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_notional_quote: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_leverage: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub funded_balance_quote: Option<UnsignedDecimal>,
}

// ---------------------------------------------------------------------------
// events.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecEvent {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub seq: u64,
    pub event: EventName,
    pub at: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<Symbol>,
    /// 事件专属载荷(schema:任意对象)。
    pub payload: serde_json::Map<String, Value>,
}

macro_rules! event_names {
    ($($variant:ident => $text:literal),+ $(,)?) => {
        /// `events.json#/$defs/EventName`。
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum EventName {
            $( #[serde(rename = $text)] $variant ),+
        }

        impl EventName {
            pub const ALL: &'static [EventName] = &[$(EventName::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $(EventName::$variant => $text),+ }
            }
            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some(EventName::$variant)),+, _ => None }
            }
        }

        impl std::fmt::Display for EventName {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

event_names!(
    IntentCreated => "intent.created",
    IntentRejected => "intent.rejected",
    IntentAwaitingApproval => "intent.awaiting_approval",
    IntentAuthorized => "intent.authorized",
    IntentRecorded => "intent.recorded",
    IntentDispatching => "intent.dispatching",
    IntentExecuting => "intent.executing",
    IntentExecutionUnknown => "intent.execution_unknown",
    IntentCompleted => "intent.completed",
    IntentCanceled => "intent.canceled",
    IntentExpired => "intent.expired",
    PlanMaterialized => "plan.materialized",
    AuthorizationGranted => "authorization.granted",
    AuthorizationConsumed => "authorization.consumed",
    AuthorizationInvalidated => "authorization.invalidated",
    AuthorizationExpired => "authorization.expired",
    AuthorizationRevoked => "authorization.revoked",
    AttemptSubmitting => "attempt.submitting",
    AttemptSubmitted => "attempt.submitted",
    AttemptResolved => "attempt.resolved",
    OrderObserved => "order.observed",
    FillObserved => "fill.observed",
    EffectEvaluated => "effect.evaluated",
    ProtectionConfirmed => "protection.confirmed",
    ProtectionMissing => "protection.missing",
    ProtectionCompensated => "protection.compensated",
    AccountUpdated => "account.updated",
    AccountStale => "account.stale",
    AccountInconsistent => "account.inconsistent",
    ForeignActivityDetected => "foreign_activity.detected",
    ExchangeAuthExpiring => "exchange.auth.expiring",
    ExchangeAuthExpired => "exchange.auth.expired",
    ExchangeAuthRevoked => "exchange.auth.revoked",
    ExchangeAuthRefreshed => "exchange.auth.refreshed",
    ExchangeToolsDrift => "exchange.tools.drift",
    ExchangeChannelDegraded => "exchange.channel.degraded",
    ExchangeChannelRecovered => "exchange.channel.recovered",
    PolicyChanged => "policy.changed",
    HaltChanged => "halt.changed",
    WriterFenced => "writer.fenced",
    CorruptionDetected => "corruption.detected",
    Health => "health",
);

impl EventName {
    /// intent 状态 → 对应事件名(状态迁移与事件写入在同一事务里用)。
    pub fn for_intent_status(status: crate::enums::IntentStatus) -> EventName {
        use crate::enums::IntentStatus as S;
        match status {
            S::Proposed => EventName::IntentCreated,
            S::Rejected => EventName::IntentRejected,
            S::AwaitingApproval => EventName::IntentAwaitingApproval,
            S::Authorized => EventName::IntentAuthorized,
            S::Recorded => EventName::IntentRecorded,
            S::Dispatching => EventName::IntentDispatching,
            S::ExecutionUnknown => EventName::IntentExecutionUnknown,
            S::Executing => EventName::IntentExecuting,
            S::Completed => EventName::IntentCompleted,
            S::Canceled => EventName::IntentCanceled,
            S::Expired => EventName::IntentExpired,
        }
    }
}
