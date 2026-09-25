//! `account_snapshot.json` —— 分组件的账户真相(Codex review #6)。

use serde::{Deserialize, Serialize};

use crate::enums::{
    AccountRef, Channel, Completeness, Consistency, ErrorInfo, ExchangeOrderStatus, MarginType, ObservationSource,
    OrderOrigin, OrderType, PositionMode, PositionSide, Product, Side, TimeInForce, Wallet, WorkingType,
    schema_version,
};
use crate::scalars::{Asset, ClientOrderId, Decimal, Hash256, Symbol, TimestampMs, UnsignedDecimal};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountSnapshot {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub account: AccountRef,
    pub channel: Channel,
    pub computed_at: TimestampMs,
    pub consistency: Consistency,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consistency_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_version: Option<Hash256>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_ms: Option<u64>,
    pub components: AccountComponents,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<AccountSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountComponents {
    pub balances: Component<Vec<BalanceRow>>,
    pub positions: Component<Vec<PositionRow>>,
    pub open_orders: Component<Vec<OrderRow>>,
    pub position_mode: Component<PositionModeData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recent_fills: Option<Component<Vec<FillRow>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_history: Option<Component<Vec<OrderRow>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin: Option<Component<MarginInfo>>,
}

/// 每个组件各自的取数元信息 + 数据(schema 里每个组件是独立定义,形状相同)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Component<T> {
    pub observed_at: TimestampMs,
    pub fetched_from: TimestampMs,
    pub fetched_to: TimestampMs,
    pub completeness: Completeness,
    pub source: ObservationSource,
    // 泛型字段不能加 serde(default)(会给 T 加 Default 约束);Option 缺失时 serde 本就当 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PositionModeData {
    pub mode: PositionMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BalanceRow {
    pub asset: Asset,
    pub wallet: Wallet,
    pub wallet_balance: Decimal,
    pub available: Decimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unrealized_pnl: Option<Decimal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PositionRow {
    pub symbol: Symbol,
    pub product: Product,
    pub position_side: PositionSide,
    /// one_way 下带符号(空头为负);hedge 下按 position_side 为正。
    pub qty: Decimal,
    pub entry_price: UnsignedDecimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark_price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unrealized_pnl: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leverage: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_type: Option<MarginType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolated_margin: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub liquidation_price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notional: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_update_time: Option<TimestampMs>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderRow {
    pub exchange_order_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_order_id: Option<ClientOrderId>,
    pub symbol: Symbol,
    pub product: Product,
    pub side: Side,
    pub position_side: PositionSide,
    pub order_type: OrderType,
    pub status: ExchangeOrderStatus,
    pub orig_qty: UnsignedDecimal,
    pub executed_qty: UnsignedDecimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_price: Option<UnsignedDecimal>,
    pub reduce_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_position: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_in_force: Option<TimeInForce>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_type: Option<WorkingType>,
    pub origin: OrderOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_update_time: Option<TimestampMs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_create_time: Option<TimestampMs>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FillRow {
    pub trade_id: String,
    pub exchange_order_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_order_id: Option<ClientOrderId>,
    pub symbol: Symbol,
    pub product: Product,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarginInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_ratio: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maintenance_margin: Option<UnsignedDecimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_balance: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_balance: Option<Decimal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountSummary {
    pub quote_asset: Asset,
    pub wallet_balance: Decimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_balance: Option<Decimal>,
    pub available_balance: Decimal,
    pub unrealized_pnl: Decimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub today_realized_pnl: Option<Decimal>,
    pub open_position_count: u32,
    pub open_order_count: u32,
}

impl AccountSnapshot {
    /// 四个必需组件的 data 是否齐全(account_version 只在齐全时有意义)。
    pub fn economic_components_complete(&self) -> bool {
        let c = &self.components;
        c.balances.data.is_some()
            && c.positions.data.is_some()
            && c.open_orders.data.is_some()
            && c.position_mode.data.is_some()
    }
}
