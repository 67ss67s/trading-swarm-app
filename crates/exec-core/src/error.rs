//! 交易所错误的**分类**——上层用 `kind` 决策,不靠 grep 文案。
//!
//! 来源:8794 `binance.rs::BinanceError`(`is_rate_limited` / `is_transport_ambiguous` /
//! `local_reject` / `local_block` 的语义)。改写:那边是 `enum { Api, CredentialsMissing }`
//! 外挂一堆判定函数,这里收成**一个结构体 + 一个 `kind` 枚举**,让 A2 的状态机
//! 可以直接 `match`。

use serde_json::Value;

/// 一次交易所交互的失败类别。**顺序即优先级**(见 [`BinanceErrorKind::classify`])。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BinanceErrorKind {
    /// 本地缺凭证 / 参数不自洽 —— 请求**从未发出**,一定没有账户效果。
    LocalReject,
    /// 交易所缺凭证或权限:HTTP 401/403、-2015(key/IP/权限)、-2014(key 格式)。
    Unauthorized,
    /// 时钟漂移:-1021(timestamp 超出 recvWindow)、-1022(签名无效,常与漂移同因)。
    /// 处置是**重新同步服务器时间后原样重签一次**——交易所在参数校验阶段就拒了,
    /// 不可能已经撮合,重试不会造成重复下单。
    ClockSkew,
    /// 限频/封禁:HTTP 418/429、-1003,或本地闸的预拦截。
    /// **一秒都不许等着去撞**:封禁期内每发一次请求都会把封禁再续 120 秒。
    RateLimited,
    /// **发送状态未知**(ambiguous):连接在请求发出后断掉、HTTP ≥500、-1007。
    /// 交易所**可能已经收下**这一单 —— 调用方必须用幂等 `clientOrderId` 回查定生死,
    /// 绝不能当成"没发出去"直接重发。
    Transport,
    /// 交易所明确拒绝(带 code),没有账户效果。
    Rejected,
}

impl BinanceErrorKind {
    /// 由 HTTP 状态 + 币安错误码判类别。
    ///
    /// 优先级刻意如此:ClockSkew / Unauthorized 先于 RateLimited(它们的处置完全不同),
    /// RateLimited 先于 Transport(429 常伴 5xx 网关页),Transport 先于 Rejected
    /// (**方向安全**:宁可多做一次幂等回查,也不要把"可能已成交"记成"已被拒")。
    pub fn classify(status: Option<u16>, code: Option<i64>) -> Self {
        if matches!(code, Some(-1021) | Some(-1022)) {
            return Self::ClockSkew;
        }
        if matches!(code, Some(-2015) | Some(-2014)) || matches!(status, Some(401) | Some(403)) {
            return Self::Unauthorized;
        }
        if matches!(status, Some(418) | Some(429)) || code == Some(-1003) {
            return Self::RateLimited;
        }
        // -1007 = "Timeout waiting for response... execution status UNKNOWN";
        // 全部 5xx 同理(币安文档口径)。8794 R60 实锤:带 JSON body 的 5xx 曾被
        // 记成 exchange_rejected,漏掉幂等回查 → 幽灵活单。
        if code == Some(-1007) || matches!(status, Some(s) if s >= 500) {
            return Self::Transport;
        }
        if code.is_some() || status.is_some() {
            return Self::Rejected;
        }
        Self::Transport
    }
}

/// 一次 Binance REST 交互的失败。
#[derive(Debug, Clone, thiserror::Error)]
#[error("{msg}")]
pub struct BinanceError {
    /// HTTP 状态码(传输层失败时为 `None`)。
    pub status: Option<u16>,
    /// 币安业务错误码(如 -1003 / -1021 / -2015 / -1111)。
    pub code: Option<i64>,
    /// 人可读消息(优先取报文 `msg`)。
    pub msg: String,
    pub kind: BinanceErrorKind,
    /// 交易所原始报文(或本地打标),便于取证;**绝不含凭证**。
    pub payload: Value,
}

impl BinanceError {
    pub fn new(status: Option<u16>, code: Option<i64>, msg: impl Into<String>, payload: Value) -> Self {
        Self { status, code, msg: msg.into(), kind: BinanceErrorKind::classify(status, code), payload }
    }

    /// 本地拒单:请求**根本没发出去**。用结构化 payload 打标,不靠调用方 grep 文案。
    pub fn local_reject(kind: &'static str, msg: impl Into<String>) -> Self {
        Self {
            status: None,
            code: None,
            msg: msg.into(),
            kind: BinanceErrorKind::LocalReject,
            payload: serde_json::json!({ "local_reject": kind }),
        }
    }

    pub fn credentials_missing(msg: impl Into<String>) -> Self {
        Self::local_reject("credentials_missing", msg)
    }

    /// 传输层失败。`ambiguous=false` 只用于**连接从未建立**(TCP/TLS 握手失败):
    /// 那种情况请求确定没送到交易所,可以安全重试。
    pub fn transport(msg: impl Into<String>, ambiguous: bool) -> Self {
        Self {
            status: None,
            code: None,
            msg: msg.into(),
            kind: if ambiguous { BinanceErrorKind::Transport } else { BinanceErrorKind::LocalReject },
            payload: serde_json::json!({ "transport_ambiguous": ambiguous }),
        }
    }

    pub fn local_reject_kind(&self) -> Option<&str> {
        self.payload.get("local_reject").and_then(Value::as_str)
    }

    pub fn is_rate_limited(&self) -> bool {
        self.kind == BinanceErrorKind::RateLimited
    }

    /// 这次失败是否「可能已经在交易所生效」。为 true 时必须走 clientOrderId 回查。
    pub fn is_transport_ambiguous(&self) -> bool {
        self.kind == BinanceErrorKind::Transport
    }

    /// 本地闸主动拦下的限频(还没发出去)。
    pub fn local_rate_limit(wait_seconds: u64) -> Self {
        Self {
            status: Some(429),
            code: Some(-1003),
            msg: format!("本地限频保护:币安 IP 额度不足,约 {wait_seconds} 秒后可重试"),
            kind: BinanceErrorKind::RateLimited,
            payload: serde_json::json!({
                "local_rate_limit": true,
                "retry_after_seconds": wait_seconds,
            }),
        }
    }

    /// 结构化摘要(用于事件/日志/探针 JSON)。
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "kind": self.kind,
            "status": self.status,
            "code": self.code,
            "message": self.msg,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_skew_codes_are_not_confused_with_rejections() {
        assert_eq!(BinanceErrorKind::classify(Some(400), Some(-1021)), BinanceErrorKind::ClockSkew);
        assert_eq!(BinanceErrorKind::classify(Some(400), Some(-1022)), BinanceErrorKind::ClockSkew);
    }

    #[test]
    fn auth_codes_map_to_unauthorized() {
        assert_eq!(BinanceErrorKind::classify(Some(401), Some(-2015)), BinanceErrorKind::Unauthorized);
        assert_eq!(BinanceErrorKind::classify(Some(400), Some(-2014)), BinanceErrorKind::Unauthorized);
        assert_eq!(BinanceErrorKind::classify(Some(403), None), BinanceErrorKind::Unauthorized);
    }

    #[test]
    fn rate_limit_status_and_code_both_count() {
        assert_eq!(BinanceErrorKind::classify(Some(429), None), BinanceErrorKind::RateLimited);
        assert_eq!(BinanceErrorKind::classify(Some(418), None), BinanceErrorKind::RateLimited);
        assert_eq!(BinanceErrorKind::classify(Some(400), Some(-1003)), BinanceErrorKind::RateLimited);
    }

    /// R60 回归:带 JSON body 的 5xx / -1007 必须判「发送状态未知」,
    /// 否则「可能已成交」会被记成「已被拒」,留下无人跟踪的幽灵活单。
    #[test]
    fn ambiguous_send_beats_plain_rejection() {
        assert_eq!(BinanceErrorKind::classify(Some(503), Some(-1008)), BinanceErrorKind::Transport);
        assert_eq!(BinanceErrorKind::classify(Some(200), Some(-1007)), BinanceErrorKind::Transport);
        assert!(BinanceError::new(Some(502), None, "bad gateway", Value::Null).is_transport_ambiguous());
    }

    #[test]
    fn plain_business_rejection_stays_rejected() {
        let error = BinanceError::new(Some(400), Some(-1111), "precision", Value::Null);
        assert_eq!(error.kind, BinanceErrorKind::Rejected);
        assert!(!error.is_transport_ambiguous());
        assert!(!error.is_rate_limited());
    }

    #[test]
    fn local_reject_is_tagged_and_never_ambiguous() {
        let error = BinanceError::local_reject("hedge_invariant", "positionSide 缺失");
        assert_eq!(error.local_reject_kind(), Some("hedge_invariant"));
        assert!(!error.is_transport_ambiguous());
        // 连接从未建立 = 请求确定没送到 → 不是 ambiguous
        assert!(!BinanceError::transport("connect reset", false).is_transport_ambiguous());
        assert!(BinanceError::transport("read timeout", true).is_transport_ambiguous());
    }
}
