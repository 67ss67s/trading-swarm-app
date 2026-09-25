//! `intent.json` —— 动钱的唯一提议记录(设计 §5.1)。

use serde::{Deserialize, Serialize};

use crate::enums::{
    AccountRef, GateRejection, IntentKind, IntentStatus, MarginType, PositionSide, Principal, Product, Side,
    Surface, TimeInForce, Wallet, WorkingType, schema_version,
};
use crate::scalars::{Asset, ClientOrderId, Symbol, TimestampMs, UnsignedDecimal, Uuid};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    #[serde(with = "schema_version")]
    pub schema_version: u8,
    pub intent_id: Uuid,
    pub account: AccountRef,
    pub principal: Principal,
    pub surface: Surface,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub params: IntentParams,
    pub status: IntentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
    pub gate_rejections: Vec<GateRejection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_plan_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_id: Option<Uuid>,
    pub ttl_seconds: u32,
    pub created_at: TimestampMs,
    pub updated_at: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<TimestampMs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_at: Option<TimestampMs>,
}

impl Intent {
    pub fn kind(&self) -> IntentKind {
        self.params.kind()
    }
}

/// 按 `kind` 判别的提议参数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum IntentParams {
    Open(OpenParams),
    Close(CloseParams),
    CancelOrder(CancelOrderParams),
    Protect(ProtectParams),
    Transfer(TransferParams),
}

impl IntentParams {
    pub fn kind(&self) -> IntentKind {
        match self {
            IntentParams::Open(_) => IntentKind::Open,
            IntentParams::Close(_) => IntentKind::Close,
            IntentParams::CancelOrder(_) => IntentKind::CancelOrder,
            IntentParams::Protect(_) => IntentKind::Protect,
            IntentParams::Transfer(_) => IntentKind::Transfer,
        }
    }

    /// 涉及的交易对(transfer 没有)。
    pub fn symbol(&self) -> Option<&Symbol> {
        match self {
            IntentParams::Open(p) => Some(&p.symbol),
            IntentParams::Close(p) => Some(&p.symbol),
            IntentParams::CancelOrder(p) => Some(&p.symbol),
            IntentParams::Protect(p) => Some(&p.symbol),
            IntentParams::Transfer(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum SizeSpec {
    Hint { hint: SizeHint },
    Qty { qty: UnsignedDecimal },
    Notional { notional: UnsignedDecimal },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SizeHint {
    Full,
    Half,
    Quarter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum EntrySpec {
    Market {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_slippage_bps: Option<u32>,
    },
    Limit {
        price: UnsignedDecimal,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        time_in_force: Option<TimeInForce>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        post_only: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StopRef {
    pub price: UnsignedDecimal,
    pub trigger: WorkingType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TakeProfitSpec {
    pub price: UnsignedDecimal,
    /// 占仓位百分比 (0,100]。
    pub pct: UnsignedDecimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<WorkingType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_order_id: Option<ClientOrderId>,
}

impl OrderRef {
    /// schema `minProperties: 1`。
    pub fn is_empty(&self) -> bool {
        self.exchange_order_id.is_none() && self.client_order_id.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenParams {
    pub product: Product,
    pub symbol: Symbol,
    pub side: Side,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_side: Option<PositionSide>,
    pub size: SizeSpec,
    pub entry: EntrySpec,
    /// 开仓必须带止损(设计 §5.4)。
    pub stop: StopRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_profits: Option<Vec<TakeProfitSpec>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leverage: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_type: Option<MarginType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thesis: Option<String>,
    pub evidence_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invalidation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloseParams {
    pub product: Product,
    pub symbol: Symbol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_side: Option<PositionSide>,
    /// 平掉当前持仓的百分比 (0,100];reduce-only,不得翻仓。
    pub pct: UnsignedDecimal,
    pub order: EntrySpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_refs: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelOrderParams {
    pub product: Product,
    pub symbol: Symbol,
    pub order_ref: OrderRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectParams {
    pub product: Product,
    pub symbol: Symbol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_side: Option<PositionSide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<StopRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_profits: Option<Vec<TakeProfitSpec>>,
    /// true=撤掉本机已有保护腿后重挂;false=只补缺。
    pub replace: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 只允许 principal=user 且 surface=rpc;agent 没有任何划转工具(设计 §3.5)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferParams {
    pub asset: Asset,
    pub amount: UnsignedDecimal,
    pub from_account: AccountRef,
    pub from_wallet: Wallet,
    pub to_account: AccountRef,
    pub to_wallet: Wallet,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_tag_is_kind_and_unknown_fields_rejected() {
        let json = r#"{"kind":"cancel_order","product":"usdm_perp","symbol":"BTCUSDT","order_ref":{"client_order_id":"tg-0f8fad5bd9cb-e0-1"}}"#;
        let params: IntentParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.kind(), IntentKind::CancelOrder);
        let back = serde_json::to_value(&params).unwrap();
        assert_eq!(back["kind"], "cancel_order");
        assert!(back.get("reason").is_none(), "None 不得输出 null");
        let bad = r#"{"kind":"cancel_order","product":"usdm_perp","symbol":"BTCUSDT","order_ref":{},"foo":1}"#;
        assert!(serde_json::from_str::<IntentParams>(bad).is_err());
    }

    #[test]
    fn size_and_entry_are_internally_tagged() {
        let s: SizeSpec = serde_json::from_str(r#"{"mode":"hint","hint":"half"}"#).unwrap();
        assert_eq!(s, SizeSpec::Hint { hint: SizeHint::Half });
        let e: EntrySpec = serde_json::from_str(r#"{"type":"market"}"#).unwrap();
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"market"}"#);
        assert!(serde_json::from_str::<SizeSpec>(r#"{"mode":"qty","qty":0.002}"#).is_err(), "float 拒");
    }
}
