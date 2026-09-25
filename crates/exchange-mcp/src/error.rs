//! 错误分类。**语义比措辞重要**:上层(execd)按变体决定是否重试、是否进 `execution_unknown`。

use serde::{Deserialize, Serialize};

/// HTTP 响应体截断长度(报错里带一点上下文,但不带整页 HTML)。
const BODY_EXCERPT_LIMIT: usize = 512;

pub type Result<T> = std::result::Result<T, Error>;

/// `WWW-Authenticate: Bearer ...` 解析结果(RFC 9728 §5.1)。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BearerChallenge {
    /// `resource_metadata="https://.../.well-known/oauth-protected-resource/..."`
    pub resource_metadata: Option<String>,
    pub realm: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 401。附解析后的挑战头;上层可据此发现 PRM 地址。
    #[error("未授权(401);challenge={0:?}")]
    Unauthorized(Box<Option<BearerChallenge>>),

    /// 404 且我们带着 `Mcp-Session-Id`——会话被服务端丢弃,需要重新 initialize。
    #[error("MCP 会话失效(404,带 session);需要重新 initialize 并比对工具快照")]
    SessionLost,

    /// 429。`retry_after_ms` 来自 `Retry-After`(秒或 HTTP-date)。
    #[error("被限频(429);retry_after_ms={retry_after_ms:?}")]
    RateLimited { retry_after_ms: Option<u64> },

    /// **不知道请求有没有到达交易所**——超时、连接断、TLS 失败、响应体截断。
    /// 写路径遇到它必须走 `execution_unknown`,禁止盲重放。
    #[error("传输失败(不确定请求是否已到达交易所):{0}")]
    Transport(String),

    /// JSON-RPC 层面的错误对象。
    #[error("JSON-RPC 错误 code={code}:{message}")]
    Rpc {
        code: i64,
        message: String,
        data: Option<serde_json::Value>,
    },

    /// AWS WAF 挑战(HTTP 202 + `x-amzn-waf-action: challenge`,或返回挑战 HTML)。
    /// 已知会发生在 `accounts.binance.com` 的 authorize 页面——那一步只能在真实浏览器里走完。
    #[error("被 WAF 挑战拦截(status={status}, action={action:?});该端点需要真实浏览器")]
    WafChallenge { status: u16, action: Option<String> },

    /// 报文不符合 MCP / JSON-RPC 约定。
    #[error("协议错误:{0}")]
    Protocol(String),

    /// PRM / AS 元数据发现或校验失败。
    #[error("OAuth 发现流程失败:{0}")]
    Discovery(String),

    /// 授权服务器返回的标准 OAuth 错误(非 invalid_grant / invalid_client)。
    #[error("OAuth 错误 {error}{}", .description.as_ref().map(|d| format!(":{d}")).unwrap_or_default())]
    OAuth {
        error: String,
        description: Option<String>,
    },

    /// `invalid_client`:client_id(CIMD 文档 URL)不被 AS 接受——文档未上线 / 404 / 字段不匹配。
    /// 与 `Revoked` 严格区分:这是**我们的注册**有问题,不是用户撤销。
    #[error("client_id 不被授权服务器接受(invalid_client);多半是 CIMD 元数据文档不可达或与请求不匹配:{0}")]
    InvalidClient(String),

    /// `invalid_grant` on refresh:授权已失效(用户在 Binance UI Disconnect,或 refresh token 过期)。
    /// 上层动作:HALT 写路径 + 带外告警 + 引导重新授权。
    #[error("授权已失效(invalid_grant);需要用户重新授权")]
    Revoked,

    /// 本地没有可用 token(没授权过 / 已过期且无 refresh_token)。
    #[error("本地无可用 token:{0}")]
    TokenUnavailable(String),

    #[error("token 仓库 IO 失败:{0}")]
    Io(String),

    #[error("HTTP {status}:{body_excerpt}")]
    Http { status: u16, body_excerpt: String },

    #[error("回调服务器:{0}")]
    Callback(String),
}

impl Error {
    pub fn unauthorized(challenge: Option<BearerChallenge>) -> Self {
        Error::Unauthorized(Box::new(challenge))
    }

    pub fn http(status: u16, body: &str) -> Self {
        Error::Http {
            status,
            body_excerpt: excerpt(body),
        }
    }

    /// 是否「不知道请求有没有到达」——写路径据此进 `execution_unknown`。
    pub fn is_indeterminate(&self) -> bool {
        matches!(self, Error::Transport(_))
    }

    /// 读路径是否值得重试。
    pub fn is_retryable_read(&self) -> bool {
        matches!(
            self,
            Error::Transport(_) | Error::RateLimited { .. } | Error::SessionLost | Error::Unauthorized(_)
        )
    }

    /// 给上层告警/状态机用的稳定分类串(不含任何敏感内容)。
    pub fn kind(&self) -> &'static str {
        match self {
            Error::Unauthorized(_) => "unauthorized",
            Error::SessionLost => "session_lost",
            Error::RateLimited { .. } => "rate_limited",
            Error::Transport(_) => "transport",
            Error::Rpc { .. } => "rpc",
            Error::WafChallenge { .. } => "waf_challenge",
            Error::Protocol(_) => "protocol",
            Error::Discovery(_) => "discovery",
            Error::OAuth { .. } => "oauth",
            Error::InvalidClient(_) => "invalid_client",
            Error::Revoked => "revoked",
            Error::TokenUnavailable(_) => "token_unavailable",
            Error::Io(_) => "io",
            Error::Http { .. } => "http",
            Error::Callback(_) => "callback",
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Error::Io(value.to_string())
    }
}

impl From<reqwest::Error> for Error {
    fn from(value: reqwest::Error) -> Self {
        // reqwest 的超时/连接错误一律归入 Transport(语义:不确定是否到达)。
        if value.is_timeout() || value.is_connect() || value.is_request() || value.is_body() {
            Error::Transport(scrub(&value.to_string()))
        } else {
            Error::Protocol(scrub(&value.to_string()))
        }
    }
}

impl From<url::ParseError> for Error {
    fn from(value: url::ParseError) -> Self {
        Error::Discovery(format!("URL 解析失败:{value}"))
    }
}

/// 截断响应体,避免把整页 WAF HTML 塞进日志。
pub fn excerpt(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= BODY_EXCERPT_LIMIT {
        return scrub(trimmed);
    }
    let cut: String = trimmed.chars().take(BODY_EXCERPT_LIMIT).collect();
    format!("{}…(截断,共 {} 字符)", scrub(&cut), trimmed.chars().count())
}

/// 兜底洗一遍:URL query 里如果出现 code/token/verifier 参数,值替换成占位符。
/// (正常路径不会把这些拼进错误串,这里是防御性的第二道。)
pub fn scrub(input: &str) -> String {
    const KEYS: &[&str] = &[
        "code=",
        "access_token=",
        "refresh_token=",
        "code_verifier=",
        "client_secret=",
        "id_token=",
    ];
    let mut out = input.to_string();
    for key in KEYS {
        let mut cursor = 0usize;
        loop {
            let lower = out.to_ascii_lowercase();
            let Some(rel) = lower[cursor..].find(key) else {
                break;
            };
            let value_start = cursor + rel + key.len();
            let value_end = out[value_start..]
                .find(['&', ' ', '"', '\'', '\n', ',', '}'])
                .map(|i| value_start + i)
                .unwrap_or(out.len());
            if value_end > value_start {
                out.replace_range(value_start..value_end, crate::secret::REDACTED);
            }
            cursor = value_start + crate::secret::REDACTED.len();
            if cursor >= out.len() {
                break;
            }
        }
    }
    out
}
