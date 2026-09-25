//! OAuth 发现:401 挑战头 → 受保护资源元数据(RFC 9728)→ 授权服务器元数据(RFC 8414)。
//!
//! Binance 实测(2026-09-02):
//! - 未带 token `POST /mcp/agentic` 的 initialize → 401,
//!   `WWW-Authenticate: Bearer resource_metadata="https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp"`,body 空。
//! - PRM 只有 `resource` + `authorization_servers`,**没有 `scopes_supported`**。
//! - AS 元数据:PKCE S256、`token_endpoint_auth_methods_supported=["none"]`、
//!   `client_id_metadata_document_supported=true`、**`grant_types_supported` 里没有 `refresh_token`**、无 DCR。
//!
//! 注意 PRM 的 well-known 路径是 `/gateway-mcp` 而不是从资源 URL 推出来的 `/mcp/agentic`,
//! 所以**必须以 401 挑战头里的地址为准**,推导路径只作兜底。

use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{BearerChallenge, Error, Result};
use crate::http;

/// 受保护资源元数据(RFC 9728)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtectedResourceMetadata {
    pub resource: String,
    #[serde(default)]
    pub authorization_servers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes_supported: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer_methods_supported: Option<Vec<String>>,
    /// 原始 JSON,便于把没建模的字段一起落到报告里。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

/// 授权服务器元数据(RFC 8414)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationServerMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revocation_endpoint: Option<String>,
    #[serde(default)]
    pub response_types_supported: Vec<String>,
    #[serde(default)]
    pub grant_types_supported: Vec<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    pub token_endpoint_auth_methods_supported: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes_supported: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id_metadata_document_supported: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

impl AuthorizationServerMetadata {
    /// AS 是否**声明**支持 refresh_token grant。Binance 现在声明的是「不支持」,
    /// 但实际 token 响应里有没有 refresh_token 只能实测——所以这只是提示,不做硬校验。
    pub fn advertises_refresh(&self) -> bool {
        self.grant_types_supported.iter().any(|g| g == "refresh_token")
    }

    pub fn supports_cimd(&self) -> bool {
        self.client_id_metadata_document_supported.unwrap_or(false)
    }
}

/// 一次发现的完整结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Discovery {
    pub resource: String,
    pub prm_url: String,
    pub prm: ProtectedResourceMetadata,
    pub as_metadata_url: String,
    pub authorization_server: AuthorizationServerMetadata,
    /// 校验中发现但不致命的问题(比如 PRM 没有 scopes_supported)。
    pub warnings: Vec<String>,
}

/// 解析 `WWW-Authenticate: Bearer key="value", key2="value2"`。
/// 只认 `Bearer` scheme;大小写不敏感;支持带引号与不带引号的值。
pub fn parse_www_authenticate(header: &str) -> Option<BearerChallenge> {
    let trimmed = header.trim();
    let rest = if trimmed.len() >= 6 && trimmed[..6].eq_ignore_ascii_case("bearer") {
        trimmed[6..].trim_start()
    } else {
        return None;
    };

    let mut challenge = BearerChallenge::default();
    let mut key = String::new();
    let mut value = String::new();
    let mut in_value = false;
    let mut in_quotes = false;
    let mut chars = rest.chars().peekable();

    let flush = |key: &mut String, value: &mut String, challenge: &mut BearerChallenge| {
        let k = key.trim().to_ascii_lowercase();
        let v = value.trim().trim_matches('"').to_string();
        if !k.is_empty() {
            match k.as_str() {
                "resource_metadata" => challenge.resource_metadata = Some(v),
                "realm" => challenge.realm = Some(v),
                "error" => challenge.error = Some(v),
                "error_description" => challenge.error_description = Some(v),
                "scope" => challenge.scope = Some(v),
                _ => {}
            }
        }
        key.clear();
        value.clear();
    };

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                if in_value {
                    value.push(c);
                }
            }
            '=' if !in_quotes && !in_value => in_value = true,
            ',' if !in_quotes => {
                flush(&mut key, &mut value, &mut challenge);
                in_value = false;
            }
            _ => {
                if in_value {
                    value.push(c);
                } else {
                    key.push(c);
                }
            }
        }
    }
    flush(&mut key, &mut value, &mut challenge);

    Some(challenge)
}

/// RFC 9728 §3.1 的路径推导:资源 `https://h/mcp/agentic`
/// → `https://h/.well-known/oauth-protected-resource/mcp/agentic`。
/// Binance 不按这个来(它给的是 `/gateway-mcp`),所以只作兜底。
pub fn derive_prm_urls(resource: &str) -> Result<Vec<String>> {
    let url = Url::parse(resource)?;
    let origin = format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or_default().to_string()
            + &url.port().map(|p| format!(":{p}")).unwrap_or_default()
    );
    let path = url.path().trim_end_matches('/');
    let mut out = Vec::new();
    if !path.is_empty() && path != "/" {
        out.push(format!("{origin}/.well-known/oauth-protected-resource{path}"));
    }
    out.push(format!("{origin}/.well-known/oauth-protected-resource"));
    Ok(out)
}

/// RFC 8414 §3.1:issuer `https://h` → `https://h/.well-known/oauth-authorization-server`;
/// issuer 带 path 时把 well-known 插在 path 前面。另附 OIDC 兜底。
pub fn derive_as_metadata_urls(issuer: &str) -> Result<Vec<String>> {
    let url = Url::parse(issuer)?;
    let origin = format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or_default().to_string()
            + &url.port().map(|p| format!(":{p}")).unwrap_or_default()
    );
    let path = url.path().trim_end_matches('/');
    let mut out = Vec::new();
    if path.is_empty() || path == "/" {
        out.push(format!("{origin}/.well-known/oauth-authorization-server"));
        out.push(format!("{origin}/.well-known/openid-configuration"));
    } else {
        out.push(format!("{origin}/.well-known/oauth-authorization-server{path}"));
        out.push(format!("{origin}{path}/.well-known/oauth-authorization-server"));
        out.push(format!("{origin}{path}/.well-known/openid-configuration"));
    }
    Ok(out)
}

/// 从 MCP 端点拿 401 挑战(不带 token 发一个最小 initialize)。
/// 返回 `Ok(Some(challenge))` = 拿到了 401;`Ok(None)` = 服务端没要求鉴权(不该发生)。
pub async fn probe_challenge(client: &reqwest::Client, endpoint: &str) -> Result<Option<BearerChallenge>> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": crate::DEFAULT_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": crate::CLIENT_NAME, "version": crate::CLIENT_VERSION }
        }
    });
    let resp = client
        .post(endpoint)
        .header(reqwest::header::ACCEPT, crate::mcp::ACCEPT_VALUE)
        .json(&body)
        .send()
        .await?;
    let status = resp.status().as_u16();
    if let Some(err) = http::detect_waf(status, resp.headers()) {
        return Err(err);
    }
    if status != 401 {
        return Ok(None);
    }
    Ok(http::header_str(resp.headers(), "www-authenticate").and_then(|h| parse_www_authenticate(&h)))
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Result<serde_json::Value> {
    let resp = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?;
    let status = resp.status().as_u16();
    let headers = resp.headers().clone();
    if let Some(err) = http::detect_waf(status, &headers) {
        return Err(err);
    }
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(Error::http(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| Error::Discovery(format!("{url} 返回的不是 JSON:{e}")))
}

/// 完整发现流程。`prm_hint` 通常来自 401 的 `resource_metadata`。
pub async fn discover(
    client: &reqwest::Client,
    resource: &str,
    prm_hint: Option<&str>,
) -> Result<Discovery> {
    let mut warnings = Vec::new();

    let mut candidates: Vec<String> = Vec::new();
    if let Some(hint) = prm_hint {
        candidates.push(hint.to_string());
    }
    candidates.extend(derive_prm_urls(resource)?);

    let mut last_err: Option<Error> = None;
    let mut prm_url = String::new();
    let mut prm_raw: Option<serde_json::Value> = None;
    for candidate in &candidates {
        match fetch_json(client, candidate).await {
            Ok(v) => {
                prm_url = candidate.clone();
                prm_raw = Some(v);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let prm_raw = prm_raw.ok_or_else(|| {
        Error::Discovery(format!(
            "受保护资源元数据取不到(试过 {:?}):{}",
            candidates,
            last_err.map(|e| e.to_string()).unwrap_or_default()
        ))
    })?;

    let mut prm: ProtectedResourceMetadata = serde_json::from_value(prm_raw.clone())
        .map_err(|e| Error::Discovery(format!("PRM 结构不认识:{e}")))?;
    prm.raw = Some(prm_raw);

    if normalize(&prm.resource) != normalize(resource) {
        warnings.push(format!(
            "PRM.resource({})与我们要访问的资源({})不一致",
            prm.resource, resource
        ));
    }
    if prm.scopes_supported.is_none() {
        warnings.push("PRM 没有 scopes_supported —— scope 字符串只能实测或不传".to_string());
    }

    let as_issuer = prm
        .authorization_servers
        .first()
        .cloned()
        .ok_or_else(|| Error::Discovery("PRM 没有 authorization_servers".to_string()))?;

    let as_candidates = derive_as_metadata_urls(&as_issuer)?;
    let mut as_url = String::new();
    let mut as_raw: Option<serde_json::Value> = None;
    let mut last_err: Option<Error> = None;
    for candidate in &as_candidates {
        match fetch_json(client, candidate).await {
            Ok(v) => {
                as_url = candidate.clone();
                as_raw = Some(v);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let as_raw = as_raw.ok_or_else(|| {
        Error::Discovery(format!(
            "授权服务器元数据取不到(试过 {:?}):{}",
            as_candidates,
            last_err.map(|e| e.to_string()).unwrap_or_default()
        ))
    })?;

    let mut meta: AuthorizationServerMetadata = serde_json::from_value(as_raw.clone())
        .map_err(|e| Error::Discovery(format!("AS 元数据结构不认识:{e}")))?;
    meta.raw = Some(as_raw);

    validate_as_metadata(&meta, &as_issuer, &mut warnings)?;

    Ok(Discovery {
        resource: resource.to_string(),
        prm_url,
        prm,
        as_metadata_url: as_url,
        authorization_server: meta,
        warnings,
    })
}

/// AS 元数据硬校验(不满足就没法安全走 PKCE public client 流程)。
pub fn validate_as_metadata(
    meta: &AuthorizationServerMetadata,
    expected_issuer: &str,
    warnings: &mut Vec<String>,
) -> Result<()> {
    if normalize(&meta.issuer) != normalize(expected_issuer) {
        return Err(Error::Discovery(format!(
            "issuer 不匹配:元数据说 {},PRM 指向 {}",
            meta.issuer, expected_issuer
        )));
    }
    if !meta
        .code_challenge_methods_supported
        .iter()
        .any(|m| m.eq_ignore_ascii_case("S256"))
    {
        return Err(Error::Discovery(
            "授权服务器不支持 PKCE S256,拒绝继续(public client 没有 S256 就不安全)".to_string(),
        ));
    }
    if !meta
        .token_endpoint_auth_methods_supported
        .iter()
        .any(|m| m == "none")
    {
        return Err(Error::Discovery(
            "token_endpoint_auth_methods_supported 不含 none —— 我们是没有 secret 的 public client".to_string(),
        ));
    }
    if !meta.response_types_supported.is_empty()
        && !meta.response_types_supported.iter().any(|r| r == "code")
    {
        return Err(Error::Discovery(
            "response_types_supported 不含 code".to_string(),
        ));
    }
    if !meta.advertises_refresh() {
        warnings.push(
            "AS 未声明 refresh_token grant —— token 响应里可能没有 refresh_token,过期即需重新授权"
                .to_string(),
        );
    }
    if !meta.supports_cimd() && meta.registration_endpoint.is_none() {
        warnings.push("AS 既不支持 CIMD 也没有动态注册端点,client_id 只能预注册".to_string());
    }
    Ok(())
}

/// URL 归一化比较:去掉末尾斜杠、小写 scheme/host。
fn normalize(url: &str) -> String {
    match Url::parse(url) {
        Ok(u) => {
            let mut s = format!(
                "{}://{}{}",
                u.scheme().to_ascii_lowercase(),
                u.host_str().unwrap_or_default().to_ascii_lowercase(),
                u.port().map(|p| format!(":{p}")).unwrap_or_default()
            );
            let path = u.path().trim_end_matches('/');
            s.push_str(path);
            s
        }
        Err(_) => url.trim_end_matches('/').to_ascii_lowercase(),
    }
}
