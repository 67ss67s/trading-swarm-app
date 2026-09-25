//! 测试用的假服务器:假授权服务器(AS)与假 MCP 服务器。
//! 全部跑在回环随机端口上,**不碰真实网络**。

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/// 回环 HTTP client:显式不走代理(Clash fake-IP 会劫持 127.0.0.1)。
pub fn loopback_client() -> reqwest::Client {
    exchange_mcp::http::build_client(&exchange_mcp::http::HttpConfig::loopback()).unwrap()
}

fn parse_form(body: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn json_response(status: u16, body: Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

// ---------------------------------------------------------------------------
// 假授权服务器
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum TokenReply {
    Success {
        access: String,
        refresh: Option<String>,
        expires_in: Option<u64>,
        scope: Option<String>,
    },
    Error {
        status: u16,
        error: String,
        description: Option<String>,
    },
    /// 先睡再回 200(用来把并发压到单飞锁上)。
    SlowSuccess {
        delay_ms: u64,
        access: String,
        refresh: Option<String>,
    },
}

impl TokenReply {
    pub fn ok(access: &str, refresh: Option<&str>) -> Self {
        TokenReply::Success {
            access: access.to_string(),
            refresh: refresh.map(|s| s.to_string()),
            expires_in: Some(3600),
            scope: None,
        }
    }
}

#[derive(Default)]
pub struct FakeAsState {
    /// 每次 /token 请求弹一个;空了用 `default_reply`。
    pub scripted: VecDeque<TokenReply>,
    pub default_reply: Option<TokenReply>,
    /// 收到的每次 /token 表单。
    pub token_requests: Vec<HashMap<String, String>>,
}

impl FakeAsState {
    pub fn token_request_count(&self) -> usize {
        self.token_requests.len()
    }
}

pub struct FakeAs {
    pub base: String,
    pub state: Arc<Mutex<FakeAsState>>,
}

impl FakeAs {
    pub async fn start(initial: FakeAsState) -> Self {
        let state = Arc::new(Mutex::new(initial));
        let app = Router::new()
            .route("/token", post(as_token))
            .route(
                "/.well-known/oauth-protected-resource/gateway-mcp",
                get(as_prm),
            )
            .route("/.well-known/oauth-authorization-server", get(as_metadata))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        FakeAs {
            base: format!("http://127.0.0.1:{}", addr.port()),
            state,
        }
    }

    pub fn token_endpoint(&self) -> String {
        format!("{}/token", self.base)
    }

    pub fn token_request_count(&self) -> usize {
        self.state.lock().unwrap().token_requests.len()
    }

    pub fn last_token_request(&self) -> Option<HashMap<String, String>> {
        self.state.lock().unwrap().token_requests.last().cloned()
    }

    pub fn push(&self, reply: TokenReply) {
        self.state.lock().unwrap().scripted.push_back(reply);
    }
}

async fn as_token(State(state): State<Arc<Mutex<FakeAsState>>>, body: String) -> Response {
    let form = parse_form(&body);
    let reply = {
        let mut s = state.lock().unwrap();
        s.token_requests.push(form.clone());
        s.scripted.pop_front().or_else(|| s.default_reply.clone())
    };
    match reply {
        Some(TokenReply::Success {
            access,
            refresh,
            expires_in,
            scope,
        }) => {
            let mut body = json!({ "access_token": access, "token_type": "Bearer" });
            if let Some(r) = refresh {
                body["refresh_token"] = json!(r);
            }
            if let Some(e) = expires_in {
                body["expires_in"] = json!(e);
            }
            if let Some(sc) = scope {
                body["scope"] = json!(sc);
            }
            json_response(200, body)
        }
        Some(TokenReply::SlowSuccess {
            delay_ms,
            access,
            refresh,
        }) => {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let mut body = json!({ "access_token": access, "token_type": "Bearer", "expires_in": 3600 });
            if let Some(r) = refresh {
                body["refresh_token"] = json!(r);
            }
            json_response(200, body)
        }
        Some(TokenReply::Error {
            status,
            error,
            description,
        }) => {
            let mut body = json!({ "error": error });
            if let Some(d) = description {
                body["error_description"] = json!(d);
            }
            json_response(status, body)
        }
        None => json_response(
            500,
            json!({ "error": "server_error", "error_description": "假 AS 没有脚本了" }),
        ),
    }
}

async fn as_prm(State(_s): State<Arc<Mutex<FakeAsState>>>, headers: HeaderMap) -> Response {
    // 用 Host 头拼 issuer,这样 issuer 校验能过。
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1");
    json_response(
        200,
        json!({
            "resource": format!("http://{host}/mcp/agentic"),
            "authorization_servers": [format!("http://{host}")],
        }),
    )
}

async fn as_metadata(State(_s): State<Arc<Mutex<FakeAsState>>>, headers: HeaderMap) -> Response {
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1");
    json_response(
        200,
        json!({
            "issuer": format!("http://{host}"),
            "authorization_endpoint": format!("http://{host}/authorize"),
            "token_endpoint": format!("http://{host}/token"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "client_id_metadata_document_supported": true,
        }),
    )
}

// ---------------------------------------------------------------------------
// 假 MCP 服务器
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum RpcReply {
    /// 正常 result。
    Result(Value),
    /// JSON-RPC error 对象。
    RpcError { code: i64, message: String },
    /// HTTP 401 + WWW-Authenticate。
    Unauthorized,
    /// HTTP 404(客户端带 session 时 = 会话丢失)。
    NotFound,
    /// HTTP 429。
    RateLimited { retry_after: Option<String> },
    /// 睡够久让客户端超时。
    Hang { delay_ms: u64 },
}

#[derive(Default)]
pub struct FakeMcpState {
    /// 服务端认可的 access token(Bearer)。
    pub valid_tokens: Vec<String>,
    /// 服务端当前会话 id;None = 不发 session 头。
    pub session_id: Option<String>,
    /// true = 响应体用 SSE。
    pub sse: bool,
    /// tools/list 的分页:每页 (tools, next_cursor)。
    pub tools_pages: Vec<(Vec<Value>, Option<String>)>,
    /// 按 method 排的脚本;弹空后走默认行为。
    pub scripted: HashMap<String, VecDeque<RpcReply>>,
    /// 收到的 (method, 是否带对的 token, session 头, 协议头)。
    pub requests: Vec<RecordedRequest>,
    pub protocol_version: String,
}

#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    pub authorization: Option<String>,
    pub session_header: Option<String>,
    pub protocol_header: Option<String>,
    pub params: Value,
}

impl FakeMcpState {
    pub fn count(&self, method: &str) -> usize {
        self.requests.iter().filter(|r| r.method == method).count()
    }
}

pub struct FakeMcp {
    pub url: String,
    pub state: Arc<Mutex<FakeMcpState>>,
}

impl FakeMcp {
    pub async fn start(mut initial: FakeMcpState) -> Self {
        if initial.protocol_version.is_empty() {
            initial.protocol_version = exchange_mcp::DEFAULT_PROTOCOL_VERSION.to_string();
        }
        let state = Arc::new(Mutex::new(initial));
        let app = Router::new()
            .route("/mcp", post(mcp_handler).delete(mcp_delete))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        FakeMcp {
            url: format!("http://127.0.0.1:{}/mcp", addr.port()),
            state,
        }
    }

    pub fn count(&self, method: &str) -> usize {
        self.state.lock().unwrap().count(method)
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.state.lock().unwrap().requests.clone()
    }

    pub fn push(&self, method: &str, reply: RpcReply) {
        self.state
            .lock()
            .unwrap()
            .scripted
            .entry(method.to_string())
            .or_default()
            .push_back(reply);
    }

    pub fn set_valid_token(&self, token: &str) {
        self.state.lock().unwrap().valid_tokens = vec![token.to_string()];
    }

    pub fn set_session(&self, id: Option<&str>) {
        self.state.lock().unwrap().session_id = id.map(|s| s.to_string());
    }
}

async fn mcp_delete() -> Response {
    Response::builder().status(StatusCode::OK).body(Body::empty()).unwrap()
}

async fn mcp_handler(
    State(state): State<Arc<Mutex<FakeMcpState>>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let method = msg
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let id = msg.get("id").and_then(|v| v.as_i64());
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    let auth = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());
    let session_header = headers
        .get("mcp-session-id")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());
    let protocol_header = headers
        .get("mcp-protocol-version")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    let (scripted, valid, sse, session_id, tools_pages, protocol_version) = {
        let mut s = state.lock().unwrap();
        s.requests.push(RecordedRequest {
            method: method.clone(),
            authorization: auth.clone(),
            session_header: session_header.clone(),
            protocol_header: protocol_header.clone(),
            params: params.clone(),
        });
        let scripted = s.scripted.get_mut(&method).and_then(|q| q.pop_front());
        let valid = s.valid_tokens.clone();
        (
            scripted,
            valid,
            s.sse,
            s.session_id.clone(),
            s.tools_pages.clone(),
            s.protocol_version.clone(),
        )
    };

    // 脚本优先(用来注入 401/404/429/超时)。
    if let Some(reply) = scripted {
        return render_scripted(reply, id, sse, &session_id).await;
    }

    // 默认:校验 token。
    let token_ok = valid.is_empty()
        || auth
            .as_deref()
            .and_then(|a| a.strip_prefix("Bearer "))
            .map(|t| valid.iter().any(|v| v == t))
            .unwrap_or(false);
    if !token_ok {
        return unauthorized_response();
    }

    // 通知没有 id,回 202 空体。
    let Some(id) = id else {
        return Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(Body::empty())
            .unwrap();
    };

    let result = match method.as_str() {
        "initialize" => json!({
            "protocolVersion": protocol_version,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fake-binance-mcp", "version": "0.0.1" },
        }),
        "tools/list" => {
            let cursor = params.get("cursor").and_then(|c| c.as_str());
            let index = match cursor {
                None => 0usize,
                Some(c) => c.trim_start_matches("page").parse::<usize>().unwrap_or(0),
            };
            let (tools, next) = tools_pages
                .get(index)
                .cloned()
                .unwrap_or_else(|| (Vec::new(), None));
            let mut r = json!({ "tools": tools });
            if let Some(n) = next {
                r["nextCursor"] = json!(n);
            }
            r
        }
        "tools/call" => json!({
            "content": [{ "type": "text", "text": "ok" }],
            "isError": false,
            "structuredContent": { "echo": params.get("arguments").cloned().unwrap_or(Value::Null) },
        }),
        _ => json!({}),
    };

    let payload = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    render_payload(payload, sse, if method == "initialize" { session_id.as_deref() } else { None })
}

async fn render_scripted(
    reply: RpcReply,
    id: Option<i64>,
    sse: bool,
    session_id: &Option<String>,
) -> Response {
    match reply {
        RpcReply::Result(result) => render_payload(
            json!({ "jsonrpc": "2.0", "id": id.unwrap_or(1), "result": result }),
            sse,
            session_id.as_deref(),
        ),
        RpcReply::RpcError { code, message } => render_payload(
            json!({ "jsonrpc": "2.0", "id": id.unwrap_or(1), "error": { "code": code, "message": message } }),
            sse,
            None,
        ),
        RpcReply::Unauthorized => unauthorized_response(),
        RpcReply::NotFound => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("content-type", "application/json")
            .body(Body::from(json!({"error":"session not found"}).to_string()))
            .unwrap(),
        RpcReply::RateLimited { retry_after } => {
            let mut b = Response::builder().status(StatusCode::TOO_MANY_REQUESTS);
            if let Some(ra) = retry_after {
                b = b.header("retry-after", ra);
            }
            b.body(Body::from("rate limited")).unwrap()
        }
        RpcReply::Hang { delay_ms } => {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            render_payload(
                json!({ "jsonrpc": "2.0", "id": id.unwrap_or(1), "result": {} }),
                sse,
                None,
            )
        }
    }
}

fn unauthorized_response() -> Response {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(
            "www-authenticate",
            r#"Bearer resource_metadata="https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp", error="invalid_token""#,
        )
        .body(Body::empty())
        .unwrap()
}

fn render_payload(payload: Value, sse: bool, session_id: Option<&str>) -> Response {
    let mut builder = Response::builder().status(StatusCode::OK);
    if let Some(id) = session_id {
        builder = builder.header("mcp-session-id", id);
    }
    if sse {
        // 故意夹一条 keepalive 注释和一条无关通知,验证解析器会跳过。
        let body = format!(
            ": keepalive\n\nevent: message\ndata: {}\n\nevent: message\ndata: {}\n\n",
            json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": {} }),
            payload
        );
        builder
            .header("content-type", "text/event-stream")
            .body(Body::from(body))
            .unwrap()
    } else {
        builder
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap()
    }
}

// ---------------------------------------------------------------------------
// 组装被测对象
// ---------------------------------------------------------------------------

pub fn oauth_config(token_endpoint: &str, resource: &str) -> exchange_mcp::OAuthConfig {
    exchange_mcp::OAuthConfig {
        client_id: "https://example.test/cimd.json".to_string(),
        resource: resource.to_string(),
        authorization_endpoint: "https://example.test/authorize".to_string(),
        token_endpoint: token_endpoint.to_string(),
        authorization_server: Some("https://example.test".to_string()),
        redirect_port: exchange_mcp::DEFAULT_CALLBACK_PORT,
        redirect_path: exchange_mcp::DEFAULT_CALLBACK_PATH.to_string(),
        scopes: None,
    }
}

pub fn stored_token(access: &str, refresh: Option<&str>, expires_at_ms: Option<i64>) -> exchange_mcp::StoredToken {
    exchange_mcp::StoredToken {
        access_token: exchange_mcp::Secret::new(access),
        refresh_token: refresh.map(exchange_mcp::Secret::new),
        token_type: "Bearer".to_string(),
        scope: None,
        expires_in_secs: Some(3600),
        expires_at_ms,
        obtained_at_ms: exchange_mcp::auth::now_ms(),
        client_id: "https://example.test/cimd.json".to_string(),
        resource: "http://127.0.0.1/mcp".to_string(),
        token_endpoint: "http://127.0.0.1/token".to_string(),
        authorization_server: None,
        revoked_at_ms: None,
        revoked_reason: None,
        response_extras: Default::default(),
    }
}

pub fn tool(name: &str, description: &str, properties: Value, required: Vec<&str>) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
        }
    })
}
