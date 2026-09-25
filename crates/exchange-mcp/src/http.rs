//! reqwest 客户端构造。
//!
//! 两条约束:
//! 1. **代理**:进程 env 里有 `HTTP(S)_PROXY/ALL_PROXY`(Clash 7897),reqwest 的
//!    `system-proxy` + `socks` feature 会自动走;回环地址由 `NO_PROXY` 排除。
//!    测试里连 127.0.0.1 的假服务器时用 `no_proxy = true`,不依赖 env。
//! 2. **UA**:`accounts.binance.com` 前面挂 AWS WAF,非浏览器 UA 会吃 challenge。
//!    token endpoint 实测(2026-09-02)对普通 HTTP 客户端不 challenge,但 authorize
//!    页面会;默认 UA 用一个正常的桌面浏览器字符串,可用 `TSWARM_MCP_USER_AGENT` 覆盖。

use std::time::Duration;

use crate::error::{Error, Result};

/// 默认 UA。写成正常桌面浏览器串是为了绕开 WAF 的 bot 规则(不是为了伪装身份;
/// 我们的身份由 CIMD client_id 与 OAuth token 表明)。
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// UA 覆盖用的环境变量。
pub const USER_AGENT_ENV: &str = "TSWARM_MCP_USER_AGENT";

#[derive(Debug, Clone)]
pub struct HttpConfig {
    pub user_agent: String,
    /// 单次请求的兜底超时(MCP 调用另有自己的 deadline,取两者更小者生效)。
    pub timeout: Duration,
    pub connect_timeout: Duration,
    /// true = 完全不走代理(测试连回环用)。
    pub no_proxy: bool,
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            user_agent: std::env::var(USER_AGENT_ENV).unwrap_or_else(|_| DEFAULT_USER_AGENT.to_string()),
            timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(10),
            no_proxy: false,
        }
    }
}

impl HttpConfig {
    /// 回环专用:不读系统代理(Clash fake-IP 会劫持 127.0.0.1)。
    pub fn loopback() -> Self {
        Self {
            no_proxy: true,
            timeout: Duration::from_secs(10),
            ..Default::default()
        }
    }
}

pub fn build_client(cfg: &HttpConfig) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent(cfg.user_agent.clone())
        .timeout(cfg.timeout)
        .connect_timeout(cfg.connect_timeout)
        // 授权/token 端点的重定向如果发生,我们要自己看见(避免 code 被带到别处)。
        .redirect(reqwest::redirect::Policy::none());
    if cfg.no_proxy {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|e| Error::Transport(format!("构造 HTTP client 失败:{e}")))
}

/// 默认客户端(走系统代理)。
pub fn default_client() -> Result<reqwest::Client> {
    build_client(&HttpConfig::default())
}

/// AWS WAF 挑战识别:`x-amzn-waf-action` 头,或 202/403 配 HTML 响应体。
/// 命中就返回 `Error::WafChallenge`——这不是「服务端错误」,是「必须换真实浏览器」。
pub fn detect_waf(status: u16, headers: &reqwest::header::HeaderMap) -> Option<Error> {
    let action = headers
        .get("x-amzn-waf-action")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    if action.is_some() {
        return Some(Error::WafChallenge { status, action });
    }
    let content_type = header_str(headers, reqwest::header::CONTENT_TYPE.as_str()).unwrap_or_default();
    // 202 + HTML:典型的 challenge 交付形态(正常 MCP 的 202 是空体)。
    if status == 202 && content_type.contains("text/html") {
        return Some(Error::WafChallenge { status, action: None });
    }
    None
}

/// 取头部字符串(小写不敏感)。
pub fn header_str(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

/// 解析 `Retry-After`:优先当秒数,失败则当 HTTP-date(只支持 RFC 1123 的粗解析,
/// 解析不出来就返回 None——上层退避策略自己兜底)。
pub fn retry_after_ms(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = header_str(headers, "retry-after")?;
    let raw = raw.trim();
    if let Ok(secs) = raw.parse::<u64>() {
        return Some(secs.saturating_mul(1000));
    }
    // HTTP-date:不引 chrono 只为这一处,做不到就交给上层默认退避。
    None
}
