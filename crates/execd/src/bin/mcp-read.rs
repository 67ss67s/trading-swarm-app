//! Narrow read-only bridge. Credentials never cross stdout, TS, argv or environment.
use exchange_mcp::{
    auth::{now_ms, AuthManager, OAuthConfig},
    mcp::{McpClient, McpConfig},
    secret::Secret,
    token_store::TokenStore,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read},
    process::Command,
    sync::Arc,
};

fn credential(root: &Value) -> Result<String, &'static str> {
    let entries = root
        .get("mcpOAuth")
        .and_then(Value::as_object)
        .ok_or("missing_auth")?;
    let matches: Vec<_> = entries
        .values()
        .filter(|v| {
            v.get("serverName").and_then(Value::as_str) == Some("binance-mcp-server")
                && v.get("serverUrl").and_then(Value::as_str)
                    == Some(exchange_mcp::BINANCE_MCP_ENDPOINT)
        })
        .collect();
    if matches.len() != 1 {
        return Err("ambiguous_or_missing_auth");
    }
    let v = matches[0];
    if let Some(exp) = v.get("expiresAt").and_then(Value::as_i64) {
        if exp <= now_ms() {
            return Err("expired_auth");
        }
    }
    let token = v
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("missing_auth")?;
    Ok(token.to_owned())
}

fn load_credential() -> Result<String, &'static str> {
    if !cfg!(target_os = "macos") {
        return Err("unsupported_credential_store");
    }
    let out = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .map_err(|_| "keychain_unavailable")?;
    if !out.status.success() {
        return Err("keychain_unavailable");
    }
    let root: Value =
        serde_json::from_slice(&out.stdout).map_err(|_| "invalid_credential_format")?;
    credential(&root)
}

fn decode(v: Value, depth: usize) -> Result<Value, &'static str> {
    if depth > 8 {
        return Err("invalid_payload");
    }
    if let Some(s) = v.as_str() {
        return decode(
            serde_json::from_str(s).map_err(|_| "non_json_payload")?,
            depth + 1,
        );
    }
    if let Some(code) = v.get("code").and_then(Value::as_i64) {
        if code == -2013 {
            return Err("order_not_found");
        }
        if code < 0 {
            return Err("exchange_error");
        }
    }
    if v.get("success") == Some(&Value::Bool(false)) || v.get("isError") == Some(&Value::Bool(true))
    {
        return Err("tool_error");
    }
    if let Some(rows) = v.as_array() {
        if !rows.is_empty()
            && rows
                .iter()
                .all(|r| r.get("type").and_then(Value::as_str) == Some("text"))
        {
            let text = rows
                .iter()
                .filter_map(|r| r.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            return decode(Value::String(text), depth + 1);
        }
    }
    if let Some(data) = v.get("data") {
        return decode(data.clone(), depth + 1);
    }
    Ok(v)
}
fn stringify_ids(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (key, value) in map {
                if ["id", "orderId", "tradeId", "tranId", "algoId"].contains(&key.as_str())
                    && value.is_number()
                {
                    *value = Value::String(value.to_string());
                } else {
                    stringify_ids(value);
                }
            }
        }
        Value::Array(rows) => {
            for row in rows {
                stringify_ids(row);
            }
        }
        _ => {}
    }
}
async fn call(client: &McpClient, tool: &str, args: Value) -> Result<Value, &'static str> {
    const ALLOWED: &[&str] = &[
        "futures_usds.accountInformationV3",
        "futures_usds.positionInformationV2",
        "futures_usds.currentAllOpenOrders",
        "futures_usds.currentAllAlgoOpenOrders",
        "futures_usds.accountTradeList",
        "futures_usds.getIncomeHistory",
        "futures_usds.queryOrder",
    ];
    if !ALLOWED.contains(&tool) {
        return Err("read_not_allowed");
    }
    let r = client
        .call_read("tool_execute", json!({"toolName":tool,"arguments":args}))
        .await
        .map_err(|e| match e.kind() {
            "unauthorized" | "token_unavailable" => "auth_required",
            _ => "mcp_read_failed",
        })?;
    let is_error = r.is_error;
    let decoded = decode(
        r.structured_content.unwrap_or_else(|| {
            Value::String(
                r.content
                    .iter()
                    .filter_map(|v| v.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        }),
        0,
    );
    if is_error {
        if tool == "futures_usds.queryOrder" && matches!(decoded, Err("order_not_found")) {
            return Err("order_not_found");
        }
        return Err("tool_error");
    }
    decoded
}
fn rows(v: Value) -> Result<Vec<Value>, &'static str> {
    v.as_array().cloned().ok_or("expected_array")
}
fn symbol(req: &Value) -> Result<&str, &'static str> {
    req.get("symbol")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 30
                && s.chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        })
        .ok_or("invalid_symbol")
}
// Recursively split full time windows rather than silently truncate a 1000-row page.
// A full single-millisecond bucket fails closed: no incomplete result is cached.
async fn history(
    client: &McpClient,
    tool: &str,
    sym: &str,
    start: i64,
    end: i64,
    funding: bool,
) -> Result<Vec<Value>, &'static str> {
    let mut windows = vec![(start, end)];
    let mut out = Vec::new();
    let mut calls = 0;
    while let Some((a, b)) = windows.pop() {
        calls += 1;
        if calls > 64 {
            return Err("history_page_limit");
        }
        let mut args = json!({"symbol":sym,"startTime":a,"endTime":b,"limit":1000});
        if funding {
            args["incomeType"] = json!("FUNDING_FEE");
        }
        let page = rows(call(client, tool, args).await?)?;
        if page.len() >= 1000 {
            if a == b {
                return Err("history_truncated");
            }
            let mid = a + (b - a) / 2;
            windows.push((mid + 1, b));
            windows.push((a, mid));
        } else {
            out.extend(page);
        }
    }
    Ok(out)
}
async fn run(req: Value) -> Result<Value, &'static str> {
    let op = req
        .get("op")
        .and_then(Value::as_str)
        .ok_or("invalid_operation")?;
    if ![
        "status",
        "account",
        "settlement",
        "get_order",
        "list_algo_orders",
        "query_algo_orders",
        "get_leverage",
    ]
    .contains(&op)
    {
        return Err("read_not_allowed");
    }
    let token = load_credential()?;
    let namespace = format!("{:x}", Sha256::digest(token.as_bytes()));
    if op == "status" {
        return Ok(json!({"namespace":namespace,"mode":"direct_read_only"}));
    }
    let http = exchange_mcp::http::default_client().map_err(|_| "http_unavailable")?;
    let store = TokenStore::new(std::path::PathBuf::from("/dev/null")); // never accessed in borrowed-token mode
    let auth = Arc::new(
        AuthManager::new(
            http.clone(),
            store,
            OAuthConfig::binance_defaults(exchange_mcp::DEFAULT_CLIENT_ID),
        )
        .with_external_access(Secret::new(token)),
    );
    let client = McpClient::new(http, auth, McpConfig::default());
    let at = now_ms();
    let mut data = match op {
        "account" => {
            let account = call(&client, "futures_usds.accountInformationV3", json!({})).await?;
            let positions =
                rows(call(&client, "futures_usds.positionInformationV2", json!({})).await?)?;
            let orders =
                rows(call(&client, "futures_usds.currentAllOpenOrders", json!({})).await?)?;
            let algos =
                rows(call(&client, "futures_usds.currentAllAlgoOpenOrders", json!({})).await?)?;
            json!({"account":account,"positions":positions,"orders":orders,"algos":algos})
        }
        "settlement" => {
            let sym = symbol(&req)?;
            let start = req
                .get("start_ms")
                .and_then(Value::as_i64)
                .ok_or("invalid_window")?;
            let end = req
                .get("end_ms")
                .and_then(Value::as_i64)
                .ok_or("invalid_window")?;
            if start < 0 || end < start || end - start > 7 * 86400_000 {
                return Err("invalid_window");
            }
            let trades = history(
                &client,
                "futures_usds.accountTradeList",
                sym,
                start,
                end,
                false,
            )
            .await?;
            let funding = history(
                &client,
                "futures_usds.getIncomeHistory",
                sym,
                start,
                end,
                true,
            )
            .await?;
            json!({"trades":trades,"funding":funding})
        }
        "get_order" => {
            let id = req
                .get("client_order_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 64)
                .ok_or("invalid_order")?;
            match call(
                &client,
                "futures_usds.queryOrder",
                json!({"symbol":symbol(&req)?,"origClientOrderId":id}),
            )
            .await
            {
                Ok(v) => v,
                Err("order_not_found") => Value::Null,
                Err(e) => return Err(e),
            }
        }
        "get_leverage" => {
            call(
                &client,
                "futures_usds.positionInformationV2",
                json!({"symbol":symbol(&req)?}),
            )
            .await?
        }
        _ => {
            call(
                &client,
                "futures_usds.currentAllAlgoOpenOrders",
                json!({"symbol":symbol(&req)?}),
            )
            .await?
        }
    };
    stringify_ids(&mut data);
    Ok(json!({"namespace":namespace,"observed_at":at,"data":data}))
}
#[tokio::main]
async fn main() {
    let mut input = String::new();
    let result =
        if io::stdin().take(16385).read_to_string(&mut input).is_err() || input.len() > 16384 {
            Err("invalid_request")
        } else {
            match serde_json::from_str(&input) {
                Ok(req) => run(req).await,
                Err(_) => Err("invalid_request"),
            }
        };
    match result {
        Ok(v) => println!("{}", json!({"ok":true,"result":v})),
        Err(code) => {
            println!("{}", json!({"ok":false,"error":code}));
            std::process::exit(1);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_bound_to_server_and_resource() {
        let good = json!({"mcpOAuth":{"a":{"serverName":"binance-mcp-server","serverUrl":exchange_mcp::BINANCE_MCP_ENDPOINT,"accessToken":"test-token"}}});
        assert_eq!(credential(&good).unwrap(), "test-token");
        let mut wrong = good.clone();
        wrong["mcpOAuth"]["a"]["serverUrl"] = json!("https://example.com");
        assert!(credential(&wrong).is_err());
        let mut duplicate = good.clone();
        duplicate["mcpOAuth"]["b"] = good["mcpOAuth"]["a"].clone();
        assert!(credential(&duplicate).is_err());
    }
    #[test]
    fn native_ids_keep_integer_precision() {
        let mut v: Value = serde_json::from_str(r#"{"orderId":9223372036854775807,"rows":[{"tranId":9223372036854775806}],"time":1700000000000}"#).unwrap();
        stringify_ids(&mut v);
        assert_eq!(v["orderId"], json!("9223372036854775807"));
        assert_eq!(v["rows"][0]["tranId"], json!("9223372036854775806"));
        assert!(v["time"].is_number());
    }
    #[test]
    fn known_missing_order_remains_distinct_from_unknown_error() {
        assert_eq!(decode(json!({"code":-2013}),0), Err("order_not_found"));
        assert_eq!(decode(json!({"code":-2011}),0), Err("exchange_error"));
    }
    #[test]
    fn decode_is_fail_closed() {
        assert!(decode(json!({"code":-1,"msg":"failed"}), 0).is_err());
        assert!(decode(json!({"isError":true}), 0).is_err());
        assert_eq!(
            decode(json!([{"type":"text","text":"[]"}]), 0).unwrap(),
            json!([])
        );
    }
}
