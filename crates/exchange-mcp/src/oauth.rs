//! OAuth 2.1 授权码 + PKCE(public client,CIMD client_id)。
//!
//! Binance 侧的两个坑(2026-09-02 实测):
//! - `accounts.binance.com/agentic-oauth/authorize` 前面挂 AWS WAF,非浏览器 UA 会拿到
//!   HTTP 202 + `x-amzn-waf-action: challenge`。**授权那一步只能在真实浏览器里点**。
//! - `accounts.binance.com/oauth-agentic/token` 对普通 HTTP 客户端**不** challenge:
//!   拿假 code + 我们的 CIMD client_id 打过去返回 `401 {"error":"invalid_client"}`
//!   (CIMD 文档还没上线时的形态)。所以 token 交换/刷新用 reqwest 直连即可。
//!
//! `invalid_client`(我们的注册有问题)与 `invalid_grant`(用户撤销/code 失效)必须分开:
//! 前者是部署问题,后者是 HALT + 重新授权。

use std::collections::BTreeMap;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use crate::error::{Error, Result};
use crate::http;
use crate::secret::Secret;

// ---------------------------------------------------------------------------
// PKCE / state
// ---------------------------------------------------------------------------

/// PKCE 对。verifier 长度 86(RFC 7636 要求 43..=128)。
#[derive(Debug, Clone)]
pub struct PkcePair {
    pub verifier: Secret,
    pub challenge: String,
}

pub fn generate_pkce() -> PkcePair {
    let verifier = random_token(64); // 64 字节 → base64url 86 字符
    let digest = Sha256::digest(verifier.as_bytes());
    PkcePair {
        challenge: URL_SAFE_NO_PAD.encode(digest),
        verifier: Secret::new(verifier),
    }
}

/// CSRF state。
pub fn generate_state() -> String {
    random_token(24)
}

/// 密码学安全随机 → base64url 无填充。`bytes` 是熵的字节数。
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

// ---------------------------------------------------------------------------
// authorize URL
// ---------------------------------------------------------------------------

/// 一次授权尝试的全部参数(state/verifier 要在回调校验时用)。
#[derive(Debug, Clone)]
pub struct AuthorizeRequest {
    pub authorization_endpoint: String,
    pub client_id: String,
    pub redirect_uri: String,
    /// RFC 8707 resource indicator;MCP 规范要求带上,免得 token 被别的资源复用。
    pub resource: String,
    /// 官方没公布 scope 字符串(只说分类 market data/account/trade/transfer),
    /// 默认 **不传**;实测出来后再传。
    pub scopes: Option<String>,
    pub state: String,
    pub code_challenge: String,
}

pub fn build_authorize_url(req: &AuthorizeRequest) -> Result<Url> {
    let mut url = Url::parse(&req.authorization_endpoint)?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", &req.client_id);
        q.append_pair("redirect_uri", &req.redirect_uri);
        q.append_pair("code_challenge", &req.code_challenge);
        q.append_pair("code_challenge_method", "S256");
        q.append_pair("state", &req.state);
        q.append_pair("resource", &req.resource);
        if let Some(scopes) = req.scopes.as_deref().filter(|s| !s.trim().is_empty()) {
            q.append_pair("scope", scopes);
        }
    }
    Ok(url)
}

// ---------------------------------------------------------------------------
// 回环回调服务器
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct CallbackResult {
    pub code: Secret,
    pub state: String,
}

/// 只服务一次授权回调的极简 HTTP/1.1 服务器。
///
/// 行为:非回调路径(浏览器会顺手要 `/favicon.ico`)一律 404 并继续等;
/// 命中回调路径就校验 state、回一页 HTML、然后收摊。
pub struct CallbackServer {
    listener: TcpListener,
    path: String,
    redirect_uri: String,
}

impl CallbackServer {
    /// `port = 0` 表示随机端口(测试用)。生产固定 18801,因为 CIMD 文档里的
    /// redirect_uris 必须逐字匹配。
    pub async fn bind(port: u16, path: &str) -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| Error::Callback(format!("回环 {port} 端口监听失败:{e}(端口被占?)")))?;
        let actual = listener
            .local_addr()
            .map_err(|e| Error::Callback(e.to_string()))?
            .port();
        Ok(Self {
            listener,
            path: path.to_string(),
            redirect_uri: format!("http://127.0.0.1:{actual}{path}"),
        })
    }

    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    /// 等一次回调。`timeout` 到了还没来就报错(用户没点完)。
    pub async fn wait_for_code(self, expected_state: &str, timeout: Duration) -> Result<CallbackResult> {
        tokio::time::timeout(timeout, self.accept_loop(expected_state))
            .await
            .map_err(|_| Error::Callback(format!("等待浏览器回调超时({}s)", timeout.as_secs())))?
    }

    async fn accept_loop(self, expected_state: &str) -> Result<CallbackResult> {
        loop {
            let (mut stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|e| Error::Callback(format!("accept 失败:{e}")))?;

            let Some(request_target) = read_request_target(&mut stream).await? else {
                continue;
            };
            // 请求行里是 origin-form(`/oauth/callback?...`),拼个 base 才能解析。
            let url = Url::parse("http://127.0.0.1")
                .and_then(|b| b.join(&request_target))
                .map_err(|e| Error::Callback(format!("回调 URL 解析失败:{e}")))?;

            if url.path() != self.path {
                write_response(&mut stream, 404, "text/plain; charset=utf-8", "not found").await;
                continue;
            }

            let params: BTreeMap<String, String> = url
                .query_pairs()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();

            if let Some(err) = params.get("error") {
                let desc = params.get("error_description").cloned();
                write_response(
                    &mut stream,
                    400,
                    "text/html; charset=utf-8",
                    &page("授权失败", &format!("授权服务器返回 {err}。可以关掉这个窗口了。")),
                )
                .await;
                return Err(Error::OAuth {
                    error: err.clone(),
                    description: desc,
                });
            }

            let state = params.get("state").cloned().unwrap_or_default();
            if state != expected_state {
                write_response(
                    &mut stream,
                    400,
                    "text/html; charset=utf-8",
                    &page("state 不匹配", "这次回调与本地发起的授权对不上,已拒绝。"),
                )
                .await;
                return Err(Error::OAuth {
                    error: "state_mismatch".to_string(),
                    // 不打印任何一边的 state 值。
                    description: Some("回调里的 state 与本地生成的不一致(可能是并发授权或 CSRF)".to_string()),
                });
            }

            let Some(code) = params.get("code").cloned().filter(|c| !c.is_empty()) else {
                write_response(
                    &mut stream,
                    400,
                    "text/html; charset=utf-8",
                    &page("缺少授权码", "回调里没有 code 参数。"),
                )
                .await;
                return Err(Error::OAuth {
                    error: "missing_code".to_string(),
                    description: None,
                });
            };

            write_response(
                &mut stream,
                200,
                "text/html; charset=utf-8",
                &page(
                    "授权完成",
                    "Trading Swarm 已经拿到授权码,可以关掉这个窗口回终端了。",
                ),
            )
            .await;

            return Ok(CallbackResult {
                code: Secret::new(code),
                state,
            });
        }
    }
}

/// 读到 `\r\n\r\n` 为止,取请求行的 target。只读头,不读体(回调是 GET)。
async fn read_request_target(stream: &mut tokio::net::TcpStream) -> Result<Option<String>> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| Error::Callback(format!("读回调请求失败:{e}")))?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return Err(Error::Callback("回调请求头过大".to_string()));
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let line = text.lines().next().unwrap_or_default();
    let mut parts = line.split_whitespace();
    let _method = parts.next();
    Ok(parts.next().map(|t| t.to_string()))
}

async fn write_response(stream: &mut tokio::net::TcpStream, status: u16, content_type: &str, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.as_bytes().len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

fn page(title: &str, message: &str) -> String {
    format!(
        "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>{title}</title>\
<style>body{{font:16px -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#0b0e11;color:#eaecef}}\
.card{{max-width:32rem;padding:2rem;border:1px solid #2b3139;border-radius:12px;background:#161a1e}}\
h1{{font-size:1.15rem;margin:0 0 .5rem}}p{{margin:0;color:#b7bdc6;line-height:1.6}}</style></head>\
<body><div class=\"card\"><h1>{title}</h1><p>{message}</p></div></body></html>"
    )
}

// ---------------------------------------------------------------------------
// token endpoint
// ---------------------------------------------------------------------------

/// token 端点的原始响应(敏感字段已包进 `Secret`)。
#[derive(Debug, Clone)]
pub struct TokenResponse {
    pub access_token: Secret,
    pub refresh_token: Option<Secret>,
    pub token_type: String,
    pub expires_in: Option<u64>,
    pub scope: Option<String>,
    /// 除敏感字段外的其余键,原样留存写进 A1 报告。
    pub extras: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RawTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<serde_json::Value>,
    scope: Option<String>,
    #[serde(flatten)]
    extras: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
struct RawTokenError {
    error: Option<String>,
    error_description: Option<String>,
}

/// token 端点客户端。
#[derive(Debug, Clone)]
pub struct TokenEndpoint {
    http: reqwest::Client,
    pub token_endpoint: String,
    pub client_id: String,
    pub resource: String,
}

impl TokenEndpoint {
    pub fn new(
        http: reqwest::Client,
        token_endpoint: impl Into<String>,
        client_id: impl Into<String>,
        resource: impl Into<String>,
    ) -> Self {
        Self {
            http,
            token_endpoint: token_endpoint.into(),
            client_id: client_id.into(),
            resource: resource.into(),
        }
    }

    /// 授权码换 token。
    pub async fn exchange_code(
        &self,
        code: &Secret,
        redirect_uri: &str,
        verifier: &Secret,
    ) -> Result<TokenResponse> {
        let form = vec![
            ("grant_type", "authorization_code"),
            ("code", code.expose()),
            ("redirect_uri", redirect_uri),
            ("client_id", self.client_id.as_str()),
            ("code_verifier", verifier.expose()),
            ("resource", self.resource.as_str()),
        ];
        self.post(form).await
    }

    /// 刷新。AS 元数据没声明 refresh_token grant,所以这条路径**可能根本不存在**;
    /// 调用方要能接受 `unsupported_grant_type` / `invalid_request` 这类返回。
    pub async fn refresh(&self, refresh_token: &Secret) -> Result<TokenResponse> {
        let form = vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.expose()),
            ("client_id", self.client_id.as_str()),
            ("resource", self.resource.as_str()),
        ];
        match self.post(form).await {
            // invalid_grant on refresh = 授权已被撤销(用户 Disconnect / refresh 过期)。
            Err(Error::OAuth { ref error, .. }) if error == "invalid_grant" => Err(Error::Revoked),
            other => other,
        }
    }

    /// 不经浏览器验证 client_id 是否已被 AS 接受:拿一个必然无效的 code 去换。
    /// - `invalid_client` → CIMD 文档不可达/不匹配(client_id 还没生效)
    /// - `invalid_grant` → client_id 被接受了,只是 code 是假的(= CIMD 通了)
    pub async fn probe_client(&self) -> ClientProbe {
        let bogus = Secret::new(format!("tswarm-probe-{}", random_token(9)));
        let verifier = generate_pkce().verifier;
        match self
            .exchange_code(&bogus, "http://127.0.0.1:18801/oauth/callback", &verifier)
            .await
        {
            Ok(_) => ClientProbe::Unexpected {
                detail: "假 code 居然换到了 token —— 这不该发生,立刻停下来查".to_string(),
            },
            Err(Error::InvalidClient(desc)) => ClientProbe::ClientRejected { detail: desc },
            Err(Error::OAuth { error, description }) if error == "invalid_grant" => {
                ClientProbe::ClientAccepted {
                    detail: description.unwrap_or_else(|| "invalid_grant".to_string()),
                }
            }
            Err(Error::OAuth { error, description }) => ClientProbe::Other {
                error,
                detail: description.unwrap_or_default(),
            },
            Err(Error::WafChallenge { status, action }) => ClientProbe::Waf { status, action },
            Err(e) => ClientProbe::Other {
                error: e.kind().to_string(),
                detail: e.to_string(),
            },
        }
    }

    async fn post(&self, form: Vec<(&str, &str)>) -> Result<TokenResponse> {
        let resp = self
            .http
            .post(&self.token_endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&form)
            .send()
            .await?;

        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        if let Some(err) = http::detect_waf(status, &headers) {
            return Err(err);
        }
        let content_type = http::header_str(&headers, "content-type").unwrap_or_default();
        let text = resp.text().await.map_err(|e| Error::Transport(e.to_string()))?;

        // 非 JSON 的 HTML 页面 = WAF / 网关中间层,别当业务错误。
        if content_type.contains("text/html") {
            return Err(Error::WafChallenge {
                status,
                action: Some("html_response".to_string()),
            });
        }

        if (200..300).contains(&status) {
            let raw: RawTokenResponse = serde_json::from_str(&text)
                .map_err(|e| Error::Protocol(format!("token 响应不是预期 JSON:{e}")))?;
            let access_token = raw
                .access_token
                .filter(|t| !t.is_empty())
                .ok_or_else(|| Error::Protocol("token 响应里没有 access_token".to_string()))?;
            let expires_in = raw.expires_in.as_ref().and_then(parse_expires_in);
            let mut extras = raw.extras;
            extras.remove("access_token");
            extras.remove("refresh_token");
            return Ok(TokenResponse {
                access_token: Secret::new(access_token),
                refresh_token: raw.refresh_token.filter(|t| !t.is_empty()).map(Secret::new),
                token_type: raw.token_type.unwrap_or_else(|| "Bearer".to_string()),
                expires_in,
                scope: raw.scope,
                extras,
            });
        }

        let parsed: RawTokenError = serde_json::from_str(&text).unwrap_or_default();
        match parsed.error.as_deref() {
            Some("invalid_client") => Err(Error::InvalidClient(
                parsed
                    .error_description
                    .unwrap_or_else(|| format!("HTTP {status}")),
            )),
            Some(err) => Err(Error::OAuth {
                error: err.to_string(),
                description: parsed.error_description,
            }),
            None => Err(Error::http(status, &text)),
        }
    }
}

fn parse_expires_in(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Number(n) => n.as_u64(),
        // 有的实现给字符串,别在这里挑食。
        serde_json::Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
}

/// `probe_client` 的结论。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum ClientProbe {
    /// client_id 被接受(CIMD 文档已生效)。
    ClientAccepted { detail: String },
    /// client_id 被拒(CIMD 文档没上线 / URL 不匹配 / 字段不合规)。
    ClientRejected { detail: String },
    Waf { status: u16, action: Option<String> },
    Other { error: String, detail: String },
    Unexpected { detail: String },
}

impl ClientProbe {
    pub fn headline(&self) -> String {
        match self {
            ClientProbe::ClientAccepted { .. } => {
                "CIMD client_id 已被 Binance 接受(返回 invalid_grant,说明它读到了元数据文档)".into()
            }
            ClientProbe::ClientRejected { detail } => {
                format!("client_id 被拒(invalid_client):{detail} —— 检查 CIMD 文档是否已上线且 URL 逐字一致")
            }
            ClientProbe::Waf { status, action } => {
                format!("token 端点返回 WAF 挑战(status={status}, action={action:?})")
            }
            ClientProbe::Other { error, detail } => format!("其他返回:{error} {detail}"),
            ClientProbe::Unexpected { detail } => format!("异常:{detail}"),
        }
    }
}
