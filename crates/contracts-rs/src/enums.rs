//! `common.json` 里的全部枚举。每个枚举都有 `ALL`(对拍 schema 枚举值数)、`as_str`、`parse`。
//!
//! 变体名用 `#[serde(rename = "...")]` 逐个钉死(不用 rename_all),让 `as_str` 与 JSON 值
//! 在同一处定义,不可能漂移。

use std::fmt;

use serde::{Deserialize, Serialize};

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        pub enum $name {
            $( #[serde(rename = $text)] $variant ),+
        }

        impl $name {
            /// schema 里的全部取值,顺序与 schema 一致。
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// 对应的 JSON 字符串值。
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }

            /// 由 JSON 字符串值解析(逐字,不做大小写归一)。
            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some($name::$variant)),+, _ => None }
            }

            /// schema 名(`common.json#/$defs/<name>`)。
            pub const SCHEMA_NAME: &'static str = stringify!($name);
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl std::str::FromStr for $name {
            type Err = String;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::parse(s).ok_or_else(|| format!("{} 不认识的取值 {s:?}", stringify!($name)))
            }
        }
    };
}

string_enum!(
    /// main=主账户(用户,REST);sub=Agentic 子账户(agent,MCP)。
    AccountRef { Main => "main", Sub => "sub" }
);
string_enum!(Channel { Rest => "rest", Mcp => "mcp" });
string_enum!(ObservationSource { Rest => "rest", Ws => "ws", Mcp => "mcp", Cache => "cache" });
string_enum!(
    /// v1:USDⓈ-M 永续可交易;spot 只读。
    Product { UsdmPerp => "usdm_perp", Spot => "spot" }
);
string_enum!(Side { Buy => "buy", Sell => "sell" });
string_enum!(PositionSide { Both => "both", Long => "long", Short => "short" });
string_enum!(PositionMode { OneWay => "one_way", Hedge => "hedge" });
string_enum!(MarginType { Isolated => "isolated", Cross => "cross" });
string_enum!(OrderType {
    Market => "market",
    Limit => "limit",
    StopMarket => "stop_market",
    StopLimit => "stop_limit",
    TakeProfitMarket => "take_profit_market",
    TakeProfitLimit => "take_profit_limit",
    TrailingStopMarket => "trailing_stop_market",
});
string_enum!(TimeInForce { Gtc => "gtc", Ioc => "ioc", Fok => "fok", Gtx => "gtx" });
string_enum!(
    /// 条件单触发价来源。
    WorkingType { MarkPrice => "mark_price", ContractPrice => "contract_price" }
);
string_enum!(Wallet { Spot => "spot", UsdmFutures => "usdm_futures" });
string_enum!(
    /// ActorContext.principal(设计 §6.1)。
    Principal { User => "user", Model => "model", Cron => "cron", Scheduler => "scheduler", McpClient => "mcp_client" }
);
string_enum!(Surface { Rpc => "rpc", Model => "model", Mcp => "mcp", Internal => "internal" });
string_enum!(IntentKind {
    Open => "open",
    Close => "close",
    CancelOrder => "cancel_order",
    Protect => "protect",
    Transfer => "transfer",
});
string_enum!(
    /// 设计 §5.1 状态图;终态 rejected/recorded/completed/canceled/expired;execution_unknown 非终态。
    IntentStatus {
        Proposed => "proposed",
        Rejected => "rejected",
        AwaitingApproval => "awaiting_approval",
        Authorized => "authorized",
        Recorded => "recorded",
        Dispatching => "dispatching",
        ExecutionUnknown => "execution_unknown",
        Executing => "executing",
        Completed => "completed",
        Canceled => "canceled",
        Expired => "expired",
    }
);
string_enum!(AuthorizationStatus {
    Active => "active",
    Consumed => "consumed",
    Expired => "expired",
    Invalidated => "invalidated",
    Revoked => "revoked",
});
string_enum!(AttemptStage { BeforeSubmit => "before_submit", Submitted => "submitted", ResultPersisted => "result_persisted" });
string_enum!(AttemptResult {
    Pending => "pending",
    Acked => "acked",
    Rejected => "rejected",
    Unknown => "unknown",
    NotReceived => "not_received",
});
string_enum!(ExchangeOrderStatus {
    New => "new",
    PartiallyFilled => "partially_filled",
    Filled => "filled",
    Canceled => "canceled",
    Expired => "expired",
    Rejected => "rejected",
});
string_enum!(EffectStatus { Pending => "pending", Satisfied => "satisfied", Failed => "failed" });
string_enum!(Leg {
    Entry => "entry",
    Stop => "stop",
    TakeProfit => "take_profit",
    Cancel => "cancel",
    Close => "close",
    Transfer => "transfer",
});
string_enum!(OrderOrigin { Local => "local", Foreign => "foreign", Unknown => "unknown" });
string_enum!(Completeness { Complete => "complete", Partial => "partial", Missing => "missing" });
string_enum!(Consistency { Consistent => "consistent", Inconsistent => "inconsistent", Unavailable => "unavailable" });
string_enum!(PolicyMode { Run => "run", StopOpening => "stop_opening", FlattenOnly => "flatten_only", HaltAll => "halt_all" });
string_enum!(Authority { Observe => "observe", Draft => "draft", Paper => "paper", LiveCapped => "live_capped" });
string_enum!(ErrorKind {
    InvalidParams => "invalid_params",
    NotFound => "not_found",
    Forbidden => "forbidden",
    Halted => "halted",
    Stale => "stale",
    Unavailable => "unavailable",
    Conflict => "conflict",
    Expired => "expired",
    InvalidTransition => "invalid_transition",
    GateRejected => "gate_rejected",
    ExchangeRejected => "exchange_rejected",
    Unauthorized => "unauthorized",
    RateLimited => "rate_limited",
    TransportAmbiguous => "transport_ambiguous",
    Internal => "internal",
});

impl PolicyMode {
    /// 严格程度:run < stop_opening < flatten_only < halt_all。emergency_stop 只能升不能降。
    pub fn severity(self) -> u8 {
        match self {
            PolicyMode::Run => 0,
            PolicyMode::StopOpening => 1,
            PolicyMode::FlattenOnly => 2,
            PolicyMode::HaltAll => 3,
        }
    }
}

impl Leg {
    /// clientOrderId 里的单字母腿码(`tables/client_order_id.json`)。
    pub fn code(self) -> char {
        match self {
            Leg::Entry => 'e',
            Leg::Stop => 's',
            Leg::TakeProfit => 't',
            Leg::Cancel => 'c',
            Leg::Close => 'x',
            Leg::Transfer => 'f',
        }
    }
}

/// 交易所/内部错误信息(`common.json#/$defs/ErrorInfo`)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorInfo {
    pub kind: ErrorKind,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

/// 闸拒绝记录(`common.json#/$defs/GateRejection`)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateRejection {
    pub gate: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    pub message: String,
}

/// 所有记录的 `schema_version`(schema 里是 `const 1`)。
pub const SCHEMA_VERSION: u8 = 1;

/// `schema_version` 字段的 serde 辅助:反序列化时校验 == 1。
pub mod schema_version {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u8, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u8, D::Error> {
        let value = u8::deserialize(deserializer)?;
        if value != super::SCHEMA_VERSION {
            return Err(serde::de::Error::custom(format!(
                "schema_version 必须是 {},实得 {value}",
                super::SCHEMA_VERSION
            )));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_json_values_are_snake_case_and_round_trip() {
        for status in IntentStatus::ALL {
            let json = serde_json::to_string(status).unwrap();
            assert_eq!(json, format!("\"{}\"", status.as_str()));
            let back: IntentStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(back, *status);
            assert_eq!(IntentStatus::parse(status.as_str()), Some(*status));
        }
        assert_eq!(IntentStatus::ALL.len(), 11);
        assert!(serde_json::from_str::<IntentStatus>("\"AWAITING_APPROVAL\"").is_err());
    }

    #[test]
    fn policy_mode_severity_is_total_order() {
        assert!(PolicyMode::Run.severity() < PolicyMode::StopOpening.severity());
        assert!(PolicyMode::StopOpening.severity() < PolicyMode::FlattenOnly.severity());
        assert!(PolicyMode::FlattenOnly.severity() < PolicyMode::HaltAll.severity());
    }
}
