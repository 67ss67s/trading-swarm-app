//! `plan.json` —— 审批前物化的可执行计划;`economic` 进 plan_hash,`basis` 不进。

use serde::{Deserialize, Serialize};

use crate::enums::{
    AccountRef, Channel, MarginType, OrderType, PositionMode, PositionSide, Product, Side, TimeInForce, Wallet,
    WorkingType, schema_version,
};
use crate::scalars::{Asset, ClientOrderId, Decimal, Hash256, Symbol, TimestampMs, UnsignedDecimal, Uuid};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutableOrderPlan {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub plan_id: Uuid,
    pub intent_id: Uuid,
    pub version: u32,
    pub plan_hash: Hash256,
    pub account: AccountRef,
    pub channel: Channel,
    pub economic: PlanEconomics,
    pub basis: PlanBasis,
    /// 授权有效期:市价 30s / 限价 120s(设计 §10.3)。
    pub authorization_ttl_seconds: u32,
    pub created_at: TimestampMs,
    pub expires_at: TimestampMs,
}

/// 进哈希的经济字段,按 `kind` 判别。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlanEconomics {
    Order(OrderEconomics),
    Protect(ProtectEconomics),
    Cancel(CancelEconomics),
    Transfer(TransferEconomics),
}

impl PlanEconomics {
    pub fn kind_str(&self) -> &'static str {
        match self {
            PlanEconomics::Order(_) => "order",
            PlanEconomics::Protect(_) => "protect",
            PlanEconomics::Cancel(_) => "cancel",
            PlanEconomics::Transfer(_) => "transfer",
        }
    }
}

/// 交易所原生保护腿;永远 reduce-only(执行层强制,不作为字段)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectionLeg {
    pub order_type: ProtectionOrderType,
    pub trigger_price: UnsignedDecimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<UnsignedDecimal>,
    /// close_position=false 时必填;true 时不填(全平)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qty: Option<UnsignedDecimal>,
    pub working_type: WorkingType,
    pub close_position: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtectionOrderType {
    StopMarket,
    StopLimit,
    TakeProfitMarket,
    TakeProfitLimit,
}

impl ProtectionOrderType {
    pub fn as_order_type(self) -> OrderType {
        match self {
            ProtectionOrderType::StopMarket => OrderType::StopMarket,
            ProtectionOrderType::StopLimit => OrderType::StopLimit,
            ProtectionOrderType::TakeProfitMarket => OrderType::TakeProfitMarket,
            ProtectionOrderType::TakeProfitLimit => OrderType::TakeProfitLimit,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Protection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<ProtectionLeg>,
    pub take_profits: Vec<ProtectionLeg>,
}

/// open / close 两类 intent 的计划;close 时 reduce_only=true 且 protection 为空。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderEconomics {
    pub product: Product,
    pub symbol: Symbol,
    pub side: Side,
    pub position_side: PositionSide,
    pub position_mode: PositionMode,
    pub order_type: OrderType,
    /// 已按 step_size 向下取整。
    pub qty: UnsignedDecimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_in_force: Option<TimeInForce>,
    pub reduce_only: bool,
    pub close_position: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leverage: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_type: Option<MarginType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_type: Option<WorkingType>,
    pub protection: Protection,
    /// 首笔成交后保护腿必须在此秒数内确认在交易所,否则补偿平仓(设计 §5.4,默认 20)。
    pub max_naked_seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectEconomics {
    pub product: Product,
    pub symbol: Symbol,
    pub position_side: PositionSide,
    pub legs: Vec<ProtectionLeg>,
    /// 先撤再挂的本机保护单 exchange_order_id 列表(replace=false 时为空)。
    pub replace_order_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelEconomics {
    pub product: Product,
    pub symbol: Symbol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_order_id: Option<ClientOrderId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferEconomics {
    pub asset: Asset,
    pub amount: UnsignedDecimal,
    pub from_account: AccountRef,
    pub from_wallet: Wallet,
    pub to_account: AccountRef,
    pub to_wallet: Wallet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SymbolFilters {
    pub tick_size: UnsignedDecimal,
    pub step_size: UnsignedDecimal,
    pub min_qty: UnsignedDecimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_qty: Option<UnsignedDecimal>,
    pub min_notional: UnsignedDecimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_precision: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qty_precision: Option<u8>,
    pub observed_at: TimestampMs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SizingMethod {
    RiskPctByStopDistance,
    ExplicitQty,
    ExplicitNotional,
    PctOfPosition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rounding {
    Down,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SizingBasis {
    pub method: SizingMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equity: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_pct: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_distance: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_qty_before: Option<Decimal>,
    pub raw_qty: UnsignedDecimal,
    pub rounding: Rounding,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarketRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark_price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_price: Option<UnsignedDecimal>,
    pub observed_at: TimestampMs,
}

/// 物化依据,给 UI/审计看;不进 plan_hash。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanBasis {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<SymbolFilters>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sizing: Option<SizingBasis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_version: Option<Hash256>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub market_ref: Option<MarketRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_mode_observed: Option<PositionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_version: Option<u32>,
    pub notes: Vec<String>,
}
