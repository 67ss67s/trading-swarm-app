//! exchange-mcp —— trading-swarm 的 **MCP / OAuth 半边**(工作包 A1)。
//!
//! 职责(设计 §3 包布局、§12 失败矩阵):
//! - OAuth 2.1 授权码 + PKCE(public client,client_id 走 CIMD 元数据文档)
//! - token 文件原子替换、0600、状态机(Fresh/Expiring/Expired/Revoked/Missing)
//! - **durable 单飞 refresh**:同一时刻只有一个刷新在飞,失败区分「已撤销」与「可重试」
//! - MCP Streamable HTTP 客户端(手写):initialize / tools/list 分页 / tools/call
//! - `tools/list` 快照钉版 + 漂移守卫
//!
//! 硬边界(AGENTS.md #1):**凭证只进 execd**。本 crate 是 token 的唯一持有者;
//! 任何日志、错误 Display、`Debug` 输出都不得出现 token / authorization code /
//! PKCE verifier(`tests/redaction.rs` 会断言)。
//!
//! 读写分离(AGENTS.md #4、设计 §12):
//! - [`mcp::McpClient::call_read`]:401 刷一次重试一次、会话丢重建一次、超时重试一次。
//! - [`mcp::McpClient::call_write`]:**一次都不重试、不重放**;超时的语义是
//!   「不知道有没有到达交易所」,必须由 execd 走 `execution_unknown` 靠 clientOrderId 对账。

pub mod auth;
pub mod classify;
pub mod discovery;
pub mod error;
pub mod http;
pub mod mcp;
pub mod oauth;
pub mod secret;
pub mod snapshot;
pub mod token_store;

pub use auth::{AuthManager, OAuthConfig, SharedAuth};
pub use error::{BearerChallenge, Error, Result};
pub use mcp::{McpClient, McpConfig, RetryPolicy, SessionInfo, ToolCallOutcome};
pub use secret::Secret;
pub use snapshot::{DriftReport, ToolsSnapshot, drift_check};
pub use token_store::{StoredToken, TokenState, TokenStatus, TokenStore};

use std::path::PathBuf;

// ---------------------------------------------------------------------------
// 已实测的 Binance 常量(2026-09-02)
// ---------------------------------------------------------------------------

/// MCP endpoint(Streamable HTTP)。未带 token 的 `POST initialize` 直接 401。
pub const BINANCE_MCP_ENDPOINT: &str = "https://agent.binance.com/mcp/agentic";

/// 401 的 `WWW-Authenticate` 指向的受保护资源元数据。
/// 注意路径是 `/gateway-mcp`,**不是**按资源路径推导出来的 `/mcp/agentic`。
pub const BINANCE_PRM_URL: &str =
    "https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp";

pub const BINANCE_ISSUER: &str = "https://agent.binance.com";
pub const BINANCE_AS_METADATA_URL: &str =
    "https://agent.binance.com/.well-known/oauth-authorization-server";
pub const BINANCE_AUTHORIZE_ENDPOINT: &str = "https://accounts.binance.com/agentic-oauth/authorize";
pub const BINANCE_TOKEN_ENDPOINT: &str = "https://accounts.binance.com/oauth-agentic/token";

/// 我们的 CIMD 元数据文档 URL(内容见 `deploy/cimd/trading-swarm-client.json`)。
/// AS 没有动态注册端点,client_id 只能是这个 URL;文档必须公网可达且逐字匹配。
pub const DEFAULT_CLIENT_ID: &str =
    "https://<bridge-domain>/guide/oauth/trading-swarm-client.json";

/// 回调端口固定 —— CIMD 文档里的 `redirect_uris` 必须逐字匹配。
pub const DEFAULT_CALLBACK_PORT: u16 = 18801;
pub const DEFAULT_CALLBACK_PATH: &str = "/oauth/callback";

/// 先报这个协议版本;服务端回什么就用什么。
pub const DEFAULT_PROTOCOL_VERSION: &str = "2025-11-25";

pub const CLIENT_NAME: &str = "trading-swarm-execd";
pub const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 运行时数据根目录 `~/.trading-swarm`(`TRADING_SWARM_HOME` 可覆盖,测试用)。
pub const HOME_ENV: &str = "TRADING_SWARM_HOME";

pub fn data_home() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var(HOME_ENV)
        && !dir.trim().is_empty()
    {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var("HOME")
        .map_err(|_| Error::Io("读不到 HOME,无法定位 ~/.trading-swarm".to_string()))?;
    Ok(PathBuf::from(home).join(".trading-swarm"))
}

/// 探针原始响应落盘目录 `~/.trading-swarm/probe`。
pub fn probe_dir() -> Result<PathBuf> {
    Ok(data_home()?.join("probe"))
}

/// 一次性搭好 `AuthManager` + `McpClient`(生产默认:系统代理 + 默认 token 路径)。
pub fn build_stack(client_id: &str) -> Result<(SharedAuth, McpClient)> {
    let http = http::default_client()?;
    let store = TokenStore::default_store()?;
    let auth = std::sync::Arc::new(AuthManager::new(
        http.clone(),
        store,
        OAuthConfig::binance_defaults(client_id),
    ));
    let client = McpClient::new(http, auth.clone(), McpConfig::default());
    Ok((auth, client))
}
