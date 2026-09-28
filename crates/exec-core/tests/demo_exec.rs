//! `DemoExec`/`tgate-demo-exec` 集成测试。
//!
//! 假服务器是一个跑在回环随机端口上的 axum app(不碰真实网络);每个测试推自己的
//! 脚本化响应,再用 `DemoExec::handle` 或(测试 8)真的把 bin 跑起来去打它。
//! `/fapi/v1/time` 有默认回应(不用每个测试都手动 push),其它端点没脚本就是显式
//! 404,方便一眼看出"打到了没预期的端点"。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Uri};
use axum::response::Response;
use serde_json::{Value, json};

use exec_core::binance::rest::BinanceRest;
use exec_core::secrets::{MainCredentials, SecretString};
use exec_core::{DemoErrorKind, DemoExec};

// ---------------------------------------------------------------------------
// 假服务器
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct RecordedRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    body_form: HashMap<String, String>,
}

#[derive(Default)]
struct ServerState {
    requests: Vec<RecordedRequest>,
    /// 按 (METHOD, PATH) 排的脚本;弹空后落回默认行为(/fapi/v1/time 有默认 200,
    /// 其它一律 404,逼着每个测试显式声明自己要打的端点)。
    scripts: HashMap<(String, String), VecDeque<(u16, Value)>>,
}

struct FakeServer {
    base_url: String,
    state: Arc<Mutex<ServerState>>,
}

impl FakeServer {
    async fn start() -> Self {
        let state = Arc::new(Mutex::new(ServerState::default()));
        let app = Router::new().fallback(universal_handler).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        FakeServer { base_url: format!("http://127.0.0.1:{}", addr.port()), state }
    }

    fn push(&self, method: &str, path: &str, status: u16, body: Value) {
        self.state
            .lock()
            .expect("lock")
            .scripts
            .entry((method.to_owned(), path.to_owned()))
            .or_default()
            .push_back((status, body));
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.state.lock().expect("lock").requests.clone()
    }

    fn requests_matching(&self, method: &str, path: &str) -> Vec<RecordedRequest> {
        self.requests().into_iter().filter(|r| r.method == method && r.path == path).collect()
    }
}

async fn universal_handler(
    axum::extract::State(state): axum::extract::State<Arc<Mutex<ServerState>>>,
    method: Method,
    uri: Uri,
    _headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path().to_owned();
    let query = uri.query().map(parse_form).unwrap_or_default();
    let body_text = String::from_utf8_lossy(&body).into_owned();
    let body_form = parse_form(&body_text);

    let scripted = {
        let mut guard = state.lock().expect("lock");
        guard.requests.push(RecordedRequest {
            method: method.to_string(),
            path: path.clone(),
            query,
            body_form,
        });
        guard.scripts.get_mut(&(method.to_string(), path.clone())).and_then(|queue| queue.pop_front())
    };

    match scripted {
        Some((status, body)) => json_response(status, body),
        None if method == Method::GET && path == "/fapi/v1/time" => {
            json_response(200, json!({ "serverTime": now_ms() }))
        }
        None => json_response(
            404,
            json!({ "code": -404, "msg": format!("假服务器没有 {method} {path} 的脚本") }),
        ),
    }
}

fn json_response(status: u16, body: Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("build response")
}

/// `application/x-www-form-urlencoded` 形状的最小解析(query 与 POST body 都是这个形状)。
fn parse_form(input: &str) -> HashMap<String, String> {
    input
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn test_credentials() -> MainCredentials {
    MainCredentials { api_key: "demo-test-key".into(), api_secret: SecretString::new("demo-test-secret"), source: "test".into() }
}

fn client(base_url: &str) -> BinanceRest {
    BinanceRest::new(&test_credentials()).with_fapi_base(base_url)
}

// ---------------------------------------------------------------------------
// 1. hello + ping shape(hello 见测试 8;这里测库层的 ping op)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ping_returns_server_time_and_offset() {
    let server = FakeServer::start().await;
    server.push("GET", "/fapi/v1/time", 200, json!({ "serverTime": 1_700_000_000_000i64 }));
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec.handle("ping", json!({})).await.expect("ping ok");
    let server_time = result.get("server_time").and_then(Value::as_i64).expect("server_time");
    assert!((server_time - 1_700_000_000_000i64).abs() < 5_000, "server_time={server_time}");
    assert!(result.get("offset_ms").and_then(Value::as_i64).is_some());
}

// ---------------------------------------------------------------------------
// 2. place 缺 new_client_order_id → local_reject,零请求
// ---------------------------------------------------------------------------

#[tokio::test]
async fn place_without_client_order_id_is_rejected_locally_and_touches_no_network() {
    let server = FakeServer::start().await;
    let exec = DemoExec::new(client(&server.base_url));

    let params = json!({ "symbol": "BTCUSDT", "side": "buy", "order_type": "market", "quantity": "0.01" });
    let error = exec.handle("place", params).await.expect_err("must be rejected locally");
    assert_eq!(error.kind, DemoErrorKind::LocalReject);
    assert!(!error.ambiguous);
    assert!(server.requests().is_empty(), "假服务器不应收到任何请求:{:?}", server.requests());

    // 空字符串同样必须拒。
    let params = json!({ "symbol": "BTCUSDT", "side": "buy", "order_type": "market", "quantity": "0.01", "new_client_order_id": "" });
    let error = exec.handle("place", params).await.expect_err("empty id must be rejected too");
    assert_eq!(error.kind, DemoErrorKind::LocalReject);
    assert!(server.requests().is_empty());
}

// ---------------------------------------------------------------------------
// 3. place 带 id → 命中 /fapi/v1/order,参数与回执原样透传
// ---------------------------------------------------------------------------

#[tokio::test]
async fn place_with_client_order_id_hits_order_endpoint_and_passes_response_through() {
    let server = FakeServer::start().await;
    server.push(
        "POST",
        "/fapi/v1/order",
        200,
        json!({ "orderId": 123456, "clientOrderId": "tg-abcdef012345-e-0", "status": "NEW" }),
    );
    let exec = DemoExec::new(client(&server.base_url));

    let params = json!({
        "symbol": "BTCUSDT",
        "side": "sell",
        "order_type": "market",
        "quantity": "0.01",
        "reduce_only": true,
        "new_client_order_id": "tg-abcdef012345-e-0",
    });
    let result = exec.handle("place", params).await.expect("place ok");
    assert_eq!(result["clientOrderId"], json!("tg-abcdef012345-e-0"));
    assert_eq!(result["status"], json!("NEW"));

    let orders = server.requests_matching("POST", "/fapi/v1/order");
    assert_eq!(orders.len(), 1, "必须恰好一次下单请求");
    let form = &orders[0].body_form;
    assert_eq!(form.get("symbol").map(String::as_str), Some("BTCUSDT"));
    assert_eq!(form.get("side").map(String::as_str), Some("SELL"));
    assert_eq!(form.get("type").map(String::as_str), Some("MARKET"));
    assert_eq!(form.get("quantity").map(String::as_str), Some("0.01"));
    assert_eq!(form.get("reduceOnly").map(String::as_str), Some("true"));
    assert_eq!(form.get("newClientOrderId").map(String::as_str), Some("tg-abcdef012345-e-0"));
}

// ---------------------------------------------------------------------------
// 4. POST 5xx → kind=transport, ambiguous=true
// ---------------------------------------------------------------------------

#[tokio::test]
async fn place_order_5xx_is_transport_and_ambiguous() {
    let server = FakeServer::start().await;
    server.push("POST", "/fapi/v1/order", 503, json!({ "code": -1000, "msg": "server busy" }));
    let exec = DemoExec::new(client(&server.base_url));

    let params = json!({
        "symbol": "BTCUSDT", "side": "buy", "order_type": "market", "quantity": "0.01",
        "new_client_order_id": "tg-abcdef012345-e-1",
    });
    let error = exec.handle("place", params).await.expect_err("must fail");
    assert_eq!(error.kind, DemoErrorKind::Transport);
    assert!(error.ambiguous, "5xx 必须标 ambiguous:发送状态未知");
}

// ---------------------------------------------------------------------------
// 5. POST 400 {code:-2010} → kind=rejected, ambiguous=false
// ---------------------------------------------------------------------------

#[tokio::test]
async fn place_order_400_rejection_is_not_ambiguous() {
    let server = FakeServer::start().await;
    server.push("POST", "/fapi/v1/order", 400, json!({ "code": -2010, "msg": "Account has insufficient balance" }));
    let exec = DemoExec::new(client(&server.base_url));

    let params = json!({
        "symbol": "BTCUSDT", "side": "buy", "order_type": "market", "quantity": "0.01",
        "new_client_order_id": "tg-abcdef012345-e-2",
    });
    let error = exec.handle("place", params).await.expect_err("must fail");
    assert_eq!(error.kind, DemoErrorKind::Rejected);
    assert!(!error.ambiguous);
    assert_eq!(error.code, Some(-2010));
}

// ---------------------------------------------------------------------------
// 6. close_position:有仓位发反向 reduceOnly 市价单;无仓位 {closed:false} 不下单
// ---------------------------------------------------------------------------

#[tokio::test]
async fn close_position_sends_reduce_only_market_order_when_position_is_open() {
    let server = FakeServer::start().await;
    server.push(
        "GET",
        "/fapi/v2/positionRisk",
        200,
        json!([{ "symbol": "BTCUSDT", "positionAmt": "0.010", "entryPrice": "50000" }]),
    );
    server.push("POST", "/fapi/v1/order", 200, json!({ "orderId": 1, "status": "FILLED" }));
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec
        .handle("close_position", json!({ "symbol": "BTCUSDT", "client_order_id": "tg-abcdef012345-c-0" }))
        .await
        .expect("close_position ok");
    assert_eq!(result["closed"], json!(true));

    let orders = server.requests_matching("POST", "/fapi/v1/order");
    assert_eq!(orders.len(), 1);
    let form = &orders[0].body_form;
    assert_eq!(form.get("side").map(String::as_str), Some("SELL"), "多头 → 反向卖出平仓");
    assert_eq!(form.get("type").map(String::as_str), Some("MARKET"));
    assert_eq!(form.get("quantity").map(String::as_str), Some("0.01"));
    assert_eq!(form.get("reduceOnly").map(String::as_str), Some("true"));
    assert_eq!(form.get("newClientOrderId").map(String::as_str), Some("tg-abcdef012345-c-0"));
}

#[tokio::test]
async fn close_position_reports_flat_and_places_no_order() {
    let server = FakeServer::start().await;
    server.push("GET", "/fapi/v2/positionRisk", 200, json!([{ "symbol": "BTCUSDT", "positionAmt": "0", "entryPrice": "0" }]));
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec
        .handle("close_position", json!({ "symbol": "BTCUSDT", "client_order_id": "tg-abcdef012345-c-1" }))
        .await
        .expect("close_position ok");
    assert_eq!(result, json!({ "closed": false }));
    assert!(server.requests_matching("POST", "/fapi/v1/order").is_empty(), "flat 时不许下单");
}

// ---------------------------------------------------------------------------
// 7. cancel_all → DELETE /fapi/v1/allOpenOrders?symbol=…
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancel_all_hits_delete_all_open_orders_with_symbol() {
    let server = FakeServer::start().await;
    server.push("DELETE", "/fapi/v1/allOpenOrders", 200, json!({ "code": 200, "msg": "The operation of cancel all open order is done." }));
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec.handle("cancel_all", json!({ "symbol": "BTCUSDT" })).await.expect("cancel_all ok");
    assert_eq!(result["code"], json!(200));

    let calls = server.requests_matching("DELETE", "/fapi/v1/allOpenOrders");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].query.get("symbol").map(String::as_str), Some("BTCUSDT"));
}

// ---------------------------------------------------------------------------
// 8. set_margin_type:cross → CROSSED;-4046(已是目标模式)→ {unchanged:true}
// ---------------------------------------------------------------------------

#[tokio::test]
async fn set_margin_type_maps_cross_to_crossed() {
    let server = FakeServer::start().await;
    server.push("POST", "/fapi/v1/marginType", 200, json!({ "code": 200, "msg": "success" }));
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec
        .handle("set_margin_type", json!({ "symbol": "BTCUSDT", "margin_type": "cross" }))
        .await
        .expect("set_margin_type ok");
    assert_eq!(result["code"], json!(200));

    let calls = server.requests_matching("POST", "/fapi/v1/marginType");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].body_form.get("symbol").map(String::as_str), Some("BTCUSDT"));
    assert_eq!(calls[0].body_form.get("marginType").map(String::as_str), Some("CROSSED"));
}

#[tokio::test]
async fn set_margin_type_treats_minus_4046_as_unchanged_not_an_error() {
    let server = FakeServer::start().await;
    server.push("POST", "/fapi/v1/marginType", 400, json!({ "code": -4046, "msg": "No need to change margin type." }));
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec
        .handle("set_margin_type", json!({ "symbol": "BTCUSDT", "margin_type": "isolated" }))
        .await
        .expect("must be treated as success, not an error");
    assert_eq!(result, json!({ "unchanged": true }));

    let calls = server.requests_matching("POST", "/fapi/v1/marginType");
    assert_eq!(calls[0].body_form.get("marginType").map(String::as_str), Some("ISOLATED"));
}

// ---------------------------------------------------------------------------
// 9. all_orders / user_trades / income:passthrough + 默认 limit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn all_orders_hits_all_orders_endpoint_with_default_limit() {
    let server = FakeServer::start().await;
    server.push("GET", "/fapi/v1/allOrders", 200, json!([{ "orderId": 1, "status": "FILLED" }]));
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec.handle("all_orders", json!({ "symbol": "BTCUSDT" })).await.expect("all_orders ok");
    assert_eq!(result[0]["orderId"], json!(1));

    let calls = server.requests_matching("GET", "/fapi/v1/allOrders");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].query.get("symbol").map(String::as_str), Some("BTCUSDT"));
    assert_eq!(calls[0].query.get("limit").map(String::as_str), Some("50"), "默认 limit 必须是 50");
}

#[tokio::test]
async fn user_trades_hits_user_trades_endpoint_with_default_limit_and_forwards_start_time() {
    let server = FakeServer::start().await;
    server.push("GET", "/fapi/v1/userTrades", 200, json!([{ "id": 9, "qty": "0.01" }]));
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec
        .handle("user_trades", json!({ "symbol": "ETHUSDT", "start_time": 1_700_000_000_000i64 }))
        .await
        .expect("user_trades ok");
    assert_eq!(result[0]["id"], json!(9));

    let calls = server.requests_matching("GET", "/fapi/v1/userTrades");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].query.get("symbol").map(String::as_str), Some("ETHUSDT"));
    assert_eq!(calls[0].query.get("limit").map(String::as_str), Some("50"), "默认 limit 必须是 50");
    assert_eq!(calls[0].query.get("startTime").map(String::as_str), Some("1700000000000"));
}

#[tokio::test]
async fn income_hits_income_endpoint_with_default_limit_and_no_symbol_when_omitted() {
    let server = FakeServer::start().await;
    server.push("GET", "/fapi/v1/income", 200, json!([{ "incomeType": "REALIZED_PNL", "income": "1.23" }]));
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec.handle("income", json!({})).await.expect("income ok");
    assert_eq!(result[0]["incomeType"], json!("REALIZED_PNL"));

    let calls = server.requests_matching("GET", "/fapi/v1/income");
    assert_eq!(calls.len(), 1);
    assert!(calls[0].query.get("symbol").is_none(), "未给 symbol 不应该拼进去");
    assert_eq!(calls[0].query.get("limit").map(String::as_str), Some("100"), "默认 limit 必须是 100");
}

// ---------------------------------------------------------------------------
// 10. exchange_info_symbols:只留 USDT 本位永续,紧凑形状
// ---------------------------------------------------------------------------

#[tokio::test]
async fn exchange_info_symbols_filters_to_usdt_perpetuals_with_compact_shape() {
    let server = FakeServer::start().await;
    server.push(
        "GET",
        "/fapi/v1/exchangeInfo",
        200,
        json!({
            "symbols": [
                {
                    "symbol": "BTCUSDT", "status": "TRADING", "contractType": "PERPETUAL", "quoteAsset": "USDT",
                    "pricePrecision": 2, "quantityPrecision": 3,
                    "filters": [
                        { "filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001", "maxQty": "1000" },
                        { "filterType": "PRICE_FILTER", "tickSize": "0.10" },
                        { "filterType": "MIN_NOTIONAL", "notional": "5" }
                    ]
                },
                {
                    // 币本位永续:quoteAsset 不是 USDT,必须过滤掉。
                    "symbol": "ETHUSD_PERP", "status": "TRADING", "contractType": "PERPETUAL", "quoteAsset": "USD",
                    "pricePrecision": 2, "quantityPrecision": 3, "filters": []
                },
                {
                    // 交割合约,不是 PERPETUAL,必须过滤掉。
                    "symbol": "BTCUSDT_240927", "status": "TRADING", "contractType": "CURRENT_QUARTER",
                    "quoteAsset": "USDT", "pricePrecision": 1, "quantityPrecision": 3, "filters": []
                },
                {
                    // USDT 永续但没有 filters:字段留 0,整行仍然保留(给人挑的列表,不做下单校验)。
                    "symbol": "NEWUSDT", "status": "TRADING", "contractType": "PERPETUAL", "quoteAsset": "USDT",
                    "pricePrecision": 4, "quantityPrecision": 0, "filters": []
                }
            ]
        }),
    );
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec.handle("exchange_info_symbols", json!({})).await.expect("exchange_info_symbols ok");
    let rows = result.as_array().expect("array");
    assert_eq!(rows.len(), 2, "只留 BTCUSDT 与 NEWUSDT:{rows:?}");

    let btc = rows.iter().find(|row| row["symbol"] == json!("BTCUSDT")).expect("BTCUSDT present");
    assert_eq!(
        btc,
        &json!({
            "symbol": "BTCUSDT", "status": "TRADING",
            "price_precision": 2, "qty_precision": 3,
            "step_size": "0.001", "tick_size": "0.1", "min_qty": "0.001", "min_notional": "5",
        })
    );

    let new_symbol = rows.iter().find(|row| row["symbol"] == json!("NEWUSDT")).expect("NEWUSDT present");
    assert_eq!(
        new_symbol,
        &json!({
            "symbol": "NEWUSDT", "status": "TRADING",
            "price_precision": 4, "qty_precision": 0,
            "step_size": "0", "tick_size": "0", "min_qty": "0", "min_notional": "0",
        })
    );
}

// ---------------------------------------------------------------------------
// 11. leverage_bracket:passthrough
// ---------------------------------------------------------------------------

#[tokio::test]
async fn leverage_bracket_hits_leverage_bracket_endpoint_with_symbol() {
    let server = FakeServer::start().await;
    server.push(
        "GET",
        "/fapi/v1/leverageBracket",
        200,
        json!([{ "symbol": "BTCUSDT", "brackets": [{ "bracket": 1, "initialLeverage": 125 }] }]),
    );
    let exec = DemoExec::new(client(&server.base_url));

    let result = exec.handle("leverage_bracket", json!({ "symbol": "BTCUSDT" })).await.expect("leverage_bracket ok");
    assert_eq!(result[0]["symbol"], json!("BTCUSDT"));

    let calls = server.requests_matching("GET", "/fapi/v1/leverageBracket");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].query.get("symbol").map(String::as_str), Some("BTCUSDT"));
}

// ---------------------------------------------------------------------------
// 12. bin 级:真的把 tgate-demo-exec 跑起来,走 NDJSON 协议
// ---------------------------------------------------------------------------

#[test]
fn bin_ndjson_protocol_round_trips_against_a_fake_server() {
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let server = runtime.block_on(FakeServer::start());
    server.push("GET", "/fapi/v3/balance", 200, json!([{ "asset": "USDT", "balance": "1000" }]));

    let mut child = Command::new(env!("CARGO_BIN_EXE_tgate-demo-exec"))
        .env("TG_DEMO_API_KEY", "demo-test-key")
        .env("TG_DEMO_API_SECRET", "demo-test-secret")
        .env("TG_DEMO_EXEC_TEST_BASE_URL", &server.base_url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn tgate-demo-exec");

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);

    let hello = read_json_line(&mut reader);
    assert_eq!(hello["id"], json!(0));
    assert_eq!(hello["ok"], json!(true));
    assert_eq!(hello["result"]["hello"], json!("tgate-demo-exec"));
    assert_eq!(hello["result"]["base_url"], json!(server.base_url));
    let masked = hello["result"]["api_key_masked"].as_str().expect("api_key_masked string");
    assert!(!masked.is_empty());
    assert!(!masked.contains("demo-test-secret"), "hello 行绝不能带出 secret");
    assert!(hello["result"]["server_time_offset_ms"].is_i64() || hello["result"]["server_time_offset_ms"].is_u64());

    writeln!(stdin, "{}", json!({ "id": 1, "op": "ping", "params": {} })).expect("write ping");
    stdin.flush().expect("flush");
    let response1 = read_json_line(&mut reader);
    assert_eq!(response1["id"], json!(1));
    assert_eq!(response1["ok"], json!(true));
    assert!(response1["result"]["server_time"].is_i64() || response1["result"]["server_time"].is_u64());

    writeln!(stdin, "{}", json!({ "id": 2, "op": "balance", "params": {} })).expect("write balance");
    stdin.flush().expect("flush");
    let response2 = read_json_line(&mut reader);
    assert_eq!(response2["id"], json!(2));
    assert_eq!(response2["ok"], json!(true));
    assert_eq!(response2["result"][0]["asset"], json!("USDT"));

    drop(stdin); // EOF → 干净退出
    let status = child.wait().expect("wait for child");
    assert!(status.success(), "退出码应为 0:{status:?}");
}

fn read_json_line(reader: &mut impl BufRead) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).expect("read a line from child stdout");
    assert!(!line.trim().is_empty(), "读到空行,子进程可能提前退出了");
    serde_json::from_str(line.trim()).unwrap_or_else(|error| panic!("响应行不是合法 JSON:{error}\n行内容:{line:?}"))
}
