//! MCP Streamable HTTP 客户端(手写,不用 rmcp)。
//!
//! 为什么手写:我们要精确控制**重试语义**——写路径任何情况下都不能自动重放
//! (设计 §12:MCP 无 ack,超时=不知道有没有到达 → `execution_unknown`),
//! 而通用 SDK 会在传输层帮你重试。
//!
//! 协议要点:
//! - 所有请求 `POST` 到同一个端点,`Accept: application/json, text/event-stream`;
//!   响应**可能是 JSON,也可能是 SSE**,两种都要能读。
//! - `initialize` 的响应头可能带 `Mcp-Session-Id`,之后每个请求都要带回去;
//!   服务端丢会话时返回 404 → `SessionLost` → 重新 initialize 并比对工具快照。
//! - 协商到的 `protocolVersion` 之后要放进 `MCP-Protocol-Version` 头。

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock};

use crate::auth::SharedAuth;
use crate::error::{Error, Result};
use crate::http;
use crate::secret::Secret;
use crate::snapshot::ToolsSnapshot;

/// 两种响应体都要接受。
pub const ACCEPT_VALUE: &str = "application/json, text/event-stream";

#[derive(Debug, Clone)]
pub struct McpConfig {
    pub endpoint: String,
    /// 先报这个版本;服务端回什么就用什么。
    pub protocol_version: String,
    /// 单次调用的截止时间(含读响应体)。
    pub call_timeout: Duration,
    pub client_name: String,
    pub client_version: String,
    /// 读路径遇到 429 时,`Retry-After` 不超过这个值才自动等一次;超过就把 `RateLimited` 抛给上层退避。
    pub max_auto_retry_after_ms: u64,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            endpoint: crate::BINANCE_MCP_ENDPOINT.to_string(),
            protocol_version: crate::DEFAULT_PROTOCOL_VERSION.to_string(),
            call_timeout: Duration::from_secs(20),
            client_name: crate::CLIENT_NAME.to_string(),
            client_version: crate::CLIENT_VERSION.to_string(),
            max_auto_retry_after_ms: 2_000,
        }
    }
}

/// 一次 initialize 之后的会话状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_info: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initialized_at_ms: Option<i64>,
}

impl SessionInfo {
    pub fn is_initialized(&self) -> bool {
        self.initialized_at_ms.is_some()
    }
}

/// 重试策略。**只有两个合法实例**:读用 `READ`,写用 `WRITE`。
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub refresh_on_unauthorized: bool,
    pub reinitialize_on_session_lost: bool,
    pub retry_transport: bool,
    pub retry_rate_limited: bool,
}

impl RetryPolicy {
    /// 读:401 刷一次重试一次;会话丢了重建一次重试一次;超时重试一次;429 短等一次。
    pub const READ: Self = Self {
        refresh_on_unauthorized: true,
        reinitialize_on_session_lost: true,
        retry_transport: true,
        retry_rate_limited: true,
    };
    /// 写:**一次都不重试、一次都不重放**。任何异常原样上抛,由 execd 走 `execution_unknown`。
    pub const WRITE: Self = Self {
        refresh_on_unauthorized: false,
        reinitialize_on_session_lost: false,
        retry_transport: false,
        retry_rate_limited: false,
    };
}

/// `tools/call` 的结果。`is_error` 是 MCP 工具级错误(不是传输错误)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallOutcome {
    pub tool: String,
    pub is_error: bool,
    #[serde(default)]
    pub content: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    pub raw: Value,
}

impl ToolCallOutcome {
    /// 把 content 里的 text 块拼起来(给 CLI 打印用)。
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub struct McpClient {
    http: reqwest::Client,
    auth: SharedAuth,
    cfg: McpConfig,
    session: RwLock<SessionInfo>,
    init_lock: Mutex<()>,
    next_id: AtomicI64,
}

impl std::fmt::Debug for McpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClient")
            .field("endpoint", &self.cfg.endpoint)
            .field("protocol_version", &self.cfg.protocol_version)
            .finish()
    }
}

impl McpClient {
    pub fn new(http: reqwest::Client, auth: SharedAuth, cfg: McpConfig) -> Self {
        Self {
            http,
            auth,
            cfg,
            session: RwLock::new(SessionInfo::default()),
            init_lock: Mutex::new(()),
            next_id: AtomicI64::new(1),
        }
    }

    pub fn config(&self) -> &McpConfig {
        &self.cfg
    }

    pub async fn session(&self) -> SessionInfo {
        self.session.read().await.clone()
    }

    // -----------------------------------------------------------------------
    // 握手
    // -----------------------------------------------------------------------

    /// `initialize` → 记录 session/协商版本 → `notifications/initialized`。
    pub async fn initialize(&self) -> Result<SessionInfo> {
        let _guard = self.init_lock.lock().await;
        self.initialize_locked().await
    }

    async fn initialize_locked(&self) -> Result<SessionInfo> {
        let token = self.auth.access_token().await?;
        let params = json!({
            "protocolVersion": self.cfg.protocol_version,
            "capabilities": {},
            "clientInfo": { "name": self.cfg.client_name, "version": self.cfg.client_version },
        });
        let (result, headers) = self
            .rpc_raw(&token, "initialize", Some(params), /* send_session */ false, /* send_protocol */ false)
            .await?;

        let session_id = http::header_str(&headers, "mcp-session-id");
        let negotiated = result
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let info = SessionInfo {
            session_id,
            protocol_version: negotiated.or_else(|| Some(self.cfg.protocol_version.clone())),
            server_info: result.get("serverInfo").cloned(),
            capabilities: result.get("capabilities").cloned(),
            instructions: result
                .get("instructions")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            initialized_at_ms: Some(crate::auth::now_ms()),
        };
        *self.session.write().await = info.clone();

        // 握手第三步:通知服务端我们准备好了(服务端通常回 202 空体)。
        if let Err(e) = self.send_initialized(&token).await {
            tracing::warn!(error = %e, "notifications/initialized 发送失败(继续,多数服务端不强制)");
        }

        tracing::info!(
            protocol = info.protocol_version.as_deref().unwrap_or("?"),
            has_session = info.session_id.is_some(),
            "MCP 会话已建立"
        );
        Ok(info)
    }

    async fn send_initialized(&self, token: &Secret) -> Result<()> {
        let body = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let req = self.request_builder(token, true, true).await?;
        let resp = tokio::time::timeout(self.cfg.call_timeout, req.json(&body).send())
            .await
            .map_err(|_| Error::Transport("notifications/initialized 超时".to_string()))??;
        let status = resp.status().as_u16();
        if let Some(err) = http::detect_waf(status, resp.headers()) {
            return Err(err);
        }
        if status == 401 {
            return Err(unauthorized_from(resp.headers()));
        }
        Ok(())
    }

    /// 会话没建立就建立一次(并发只会跑一次)。
    pub async fn ensure_initialized(&self) -> Result<SessionInfo> {
        {
            let s = self.session.read().await;
            if s.is_initialized() {
                return Ok(s.clone());
            }
        }
        let _guard = self.init_lock.lock().await;
        {
            let s = self.session.read().await;
            if s.is_initialized() {
                return Ok(s.clone());
            }
        }
        self.initialize_locked().await
    }

    async fn reset_session(&self) {
        *self.session.write().await = SessionInfo::default();
    }

    /// 主动关会话(DELETE)。失败不算错——服务端可能不支持。
    pub async fn close_session(&self) -> Result<()> {
        let session_id = self.session.read().await.session_id.clone();
        let Some(session_id) = session_id else {
            return Ok(());
        };
        let token = self.auth.access_token().await?;
        let resp = self
            .http
            .delete(&self.cfg.endpoint)
            .bearer_auth(token.expose())
            .header("Mcp-Session-Id", session_id)
            .send()
            .await;
        if let Err(e) = resp {
            tracing::debug!(error = %e, "DELETE 会话失败(忽略)");
        }
        self.reset_session().await;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // tools
    // -----------------------------------------------------------------------

    /// `tools/list`,自动翻 `nextCursor`。
    pub async fn list_tools(&self) -> Result<Vec<Value>> {
        self.ensure_initialized().await?;
        let mut tools: Vec<Value> = Vec::new();
        let mut cursor: Option<String> = None;
        // 分页保护:防服务端 cursor 环。
        for _ in 0..64 {
            let params = cursor
                .as_ref()
                .map(|c| json!({ "cursor": c }))
                .unwrap_or_else(|| json!({}));
            let result = self.rpc_read("tools/list", Some(params)).await?;
            if let Some(arr) = result.get("tools").and_then(|t| t.as_array()) {
                tools.extend(arr.iter().cloned());
            }
            match result.get("nextCursor").and_then(|c| c.as_str()) {
                Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
                _ => return Ok(tools),
            }
        }
        Err(Error::Protocol("tools/list 分页超过 64 页,疑似 cursor 环".to_string()))
    }

    /// 拿一份工具快照(含钉版哈希),用于漂移守卫。
    pub async fn snapshot_tools(&self) -> Result<ToolsSnapshot> {
        let tools = self.list_tools().await?;
        let session = self.session().await;
        Ok(ToolsSnapshot::new(
            session.protocol_version.unwrap_or_default(),
            session.server_info.unwrap_or(Value::Null),
            tools,
        ))
    }

    /// **只读**工具调用:401 刷一次重试一次;会话丢重建一次;超时重试一次;429 短等一次。
    pub async fn call_read(&self, tool: &str, args: Value) -> Result<ToolCallOutcome> {
        self.call_tool(tool, args, RetryPolicy::READ).await
    }

    /// **写**工具调用:一次都不重试、不重放。401/超时原样返回,由上层走 `execution_unknown`。
    pub async fn call_write(&self, tool: &str, args: Value) -> Result<ToolCallOutcome> {
        self.call_tool(tool, args, RetryPolicy::WRITE).await
    }

    pub async fn call_tool(&self, tool: &str, args: Value, policy: RetryPolicy) -> Result<ToolCallOutcome> {
        let params = json!({ "name": tool, "arguments": args });
        let result = self.rpc_with_policy("tools/call", Some(params), policy).await?;
        Ok(ToolCallOutcome {
            tool: tool.to_string(),
            is_error: result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false),
            content: result
                .get("content")
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default(),
            structured_content: result.get("structuredContent").cloned(),
            raw: result,
        })
    }

    // -----------------------------------------------------------------------
    // JSON-RPC
    // -----------------------------------------------------------------------

    /// 读语义的通用 RPC(带读重试策略)。
    pub async fn rpc_read(&self, method: &str, params: Option<Value>) -> Result<Value> {
        self.rpc_with_policy(method, params, RetryPolicy::READ).await
    }

    async fn rpc_with_policy(&self, method: &str, params: Option<Value>, policy: RetryPolicy) -> Result<Value> {
        let mut refreshed = false;
        let mut reinitialized = false;
        let mut transport_retried = false;
        let mut rate_limited_retried = false;

        loop {
            // 握手不是「重试」——写路径也需要一个已建立的会话。
            self.ensure_initialized().await?;
            let token = self.auth.access_token().await?;

            match self
                .rpc_raw(&token, method, params.clone(), true, true)
                .await
                .map(|(result, _)| result)
            {
                Ok(result) => return Ok(result),

                Err(Error::Unauthorized(_)) if policy.refresh_on_unauthorized && !refreshed => {
                    refreshed = true;
                    tracing::info!(method, "收到 401,触发单飞 refresh 后重试一次");
                    self.auth.refresh_for(Some(token.expose())).await?;
                    continue;
                }

                Err(Error::SessionLost) if policy.reinitialize_on_session_lost && !reinitialized => {
                    reinitialized = true;
                    tracing::warn!(method, "MCP 会话失效,重新 initialize 后重试一次(上层需比对工具快照)");
                    self.reset_session().await;
                    continue;
                }

                Err(Error::Transport(msg)) if policy.retry_transport && !transport_retried => {
                    transport_retried = true;
                    tracing::warn!(method, detail = %msg, "读路径传输失败,重试一次");
                    continue;
                }

                Err(Error::RateLimited { retry_after_ms })
                    if policy.retry_rate_limited
                        && !rate_limited_retried
                        && retry_after_ms.unwrap_or(0) <= self.cfg.max_auto_retry_after_ms =>
                {
                    rate_limited_retried = true;
                    let wait = retry_after_ms.unwrap_or(200);
                    tracing::warn!(method, wait_ms = wait, "429,短等后重试一次");
                    tokio::time::sleep(Duration::from_millis(wait)).await;
                    continue;
                }

                Err(e) => return Err(e),
            }
        }
    }

    async fn request_builder(
        &self,
        token: &Secret,
        send_session: bool,
        send_protocol: bool,
    ) -> Result<reqwest::RequestBuilder> {
        let mut req = self
            .http
            .post(&self.cfg.endpoint)
            .bearer_auth(token.expose())
            .header(reqwest::header::ACCEPT, ACCEPT_VALUE)
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        let session = self.session.read().await;
        if send_session && let Some(id) = session.session_id.as_deref() {
            req = req.header("Mcp-Session-Id", id);
        }
        if send_protocol && let Some(v) = session.protocol_version.as_deref() {
            req = req.header("MCP-Protocol-Version", v);
        }
        Ok(req)
    }

    /// 发一个 JSON-RPC 请求,返回 `result` 与响应头。**不含任何重试。**
    async fn rpc_raw(
        &self,
        token: &Secret,
        method: &str,
        params: Option<Value>,
        send_session: bool,
        send_protocol: bool,
    ) -> Result<(Value, reqwest::header::HeaderMap)> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut body = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(p) = params {
            body["params"] = p;
        }

        let req = self.request_builder(token, send_session, send_protocol).await?;
        let deadline = self.cfg.call_timeout;

        let resp = tokio::time::timeout(deadline, req.json(&body).send())
            .await
            .map_err(|_| {
                Error::Transport(format!("{method} 请求超时({}s):不确定服务端是否已收到", deadline.as_secs()))
            })??;

        let status = resp.status().as_u16();
        let headers = resp.headers().clone();

        if let Some(err) = http::detect_waf(status, &headers) {
            return Err(err);
        }

        match status {
            401 => return Err(unauthorized_from(&headers)),
            404 => {
                let had_session = self.session.read().await.session_id.is_some();
                return Err(if had_session {
                    Error::SessionLost
                } else {
                    let text = resp.text().await.unwrap_or_default();
                    Error::http(404, &text)
                });
            }
            429 => {
                return Err(Error::RateLimited {
                    retry_after_ms: http::retry_after_ms(&headers),
                });
            }
            s if !(200..300).contains(&s) => {
                let text = resp.text().await.unwrap_or_default();
                return Err(Error::http(s, &text));
            }
            _ => {}
        }

        let content_type = http::header_str(&headers, "content-type").unwrap_or_default();
        let value = if content_type.contains("text/event-stream") {
            read_sse_response(resp, id, deadline).await?
        } else {
            let text = tokio::time::timeout(deadline, resp.text())
                .await
                .map_err(|_| Error::Transport(format!("{method} 读响应体超时")))?
                .map_err(|e| Error::Transport(format!("{method} 读响应体失败:{e}")))?;
            if text.trim().is_empty() {
                return Err(Error::Protocol(format!("{method} 返回空响应体(status={status})")));
            }
            serde_json::from_str::<Value>(&text)
                .map_err(|e| Error::Protocol(format!("{method} 响应不是 JSON:{e}")))?
        };

        let result = extract_result(value, id)?;
        Ok((result, headers))
    }
}

fn unauthorized_from(headers: &reqwest::header::HeaderMap) -> Error {
    let challenge = http::header_str(headers, "www-authenticate")
        .and_then(|h| crate::discovery::parse_www_authenticate(&h));
    Error::unauthorized(challenge)
}

/// 从 JSON-RPC 报文里取 `result`;`error` 转成 `Error::Rpc`。支持批量响应(取匹配 id 的那条)。
fn extract_result(value: Value, id: i64) -> Result<Value> {
    let message = match value {
        Value::Array(items) => items
            .into_iter()
            .find(|m| m.get("id").and_then(|v| v.as_i64()) == Some(id))
            .ok_or_else(|| Error::Protocol(format!("批量响应里没有 id={id} 的消息")))?,
        other => other,
    };
    if let Some(err) = message.get("error") {
        return Err(Error::Rpc {
            code: err.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
            message: err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown")
                .to_string(),
            data: err.get("data").cloned(),
        });
    }
    match message.get("result") {
        Some(r) => Ok(r.clone()),
        None => Err(Error::Protocol(format!(
            "响应既没有 result 也没有 error(id={id})"
        ))),
    }
}

/// 读 SSE 响应体,拿到匹配 id 的 JSON-RPC 消息就返回(不等流关闭)。
/// 忽略注释行(`:` keepalive)与非 message 事件。
async fn read_sse_response(resp: reqwest::Response, id: i64, deadline: Duration) -> Result<Value> {
    let fut = async {
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();
        let mut data_lines: Vec<String> = Vec::new();

        loop {
            let Some(chunk) = stream.next().await else {
                break;
            };
            let chunk = chunk.map_err(|e| Error::Transport(format!("SSE 流读失败:{e}")))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // 逐行消费:事件以空行分隔。
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim_end_matches('\r').to_string();
                buffer.drain(..pos + 1);

                if line.is_empty() {
                    if !data_lines.is_empty() {
                        let payload = data_lines.join("\n");
                        data_lines.clear();
                        if let Some(v) = match_message(&payload, id)? {
                            return Ok(v);
                        }
                    }
                    continue;
                }
                if line.starts_with(':') {
                    continue; // keepalive 注释
                }
                if let Some(rest) = line.strip_prefix("data:") {
                    data_lines.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
                }
                // event:/id:/retry: 字段对我们没用。
            }
        }

        // 流结束前最后一个事件可能没有空行收尾。
        if !data_lines.is_empty()
            && let Some(v) = match_message(&data_lines.join("\n"), id)?
        {
            return Ok(v);
        }
        Err(Error::Transport(format!(
            "SSE 流结束但没等到 id={id} 的响应:不确定服务端是否已处理"
        )))
    };

    tokio::time::timeout(deadline, fut)
        .await
        .map_err(|_| Error::Transport(format!("等待 SSE 响应超时(id={id}):不确定服务端是否已处理")))?
}

/// 一个 SSE data 载荷是不是我们要的那条响应。是 → Some;不是(通知/别人的响应)→ None。
fn match_message(payload: &str, id: i64) -> Result<Option<Value>> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        // 服务端可能夹带非 JSON 的心跳文本,跳过而不是报错。
        Err(_) => return Ok(None),
    };
    let matches = match &value {
        Value::Array(items) => items
            .iter()
            .any(|m| m.get("id").and_then(|v| v.as_i64()) == Some(id)),
        other => other.get("id").and_then(|v| v.as_i64()) == Some(id),
    };
    if matches { Ok(Some(value)) } else { Ok(None) }
}
