//! tgate-demo-exec —— 唯一持有 Binance **Demo Trading**(假钱)API key 的进程
//! (设计 `docs/demo/README.md` §1/§4)。
//!
//! **协议**:stdin/stdout 是 NDJSON,单写者、严格顺序处理(一行处理完才读下一行)。
//! 请求 `{"id":<int>,"op":"<op>","params":{...}}`;响应
//! `{"id":<int>,"ok":true,"result":<json>}` 或
//! `{"id":<int>,"ok":false,"error":{"kind":..,"message":..,"code":..?,"ambiguous":bool}}`。
//! 启动时先同步一次服务器时间,再自发一行 `id:0` 的 hello:
//! `{"id":0,"ok":true,"result":{"hello":"tgate-demo-exec","base_url":..,"api_key_masked":..,"server_time_offset_ms":..}}`。
//! 无法解析成 `{id,op}` 形状的行 → 响应 `id:null` 的 local_reject 错误。日志全部走
//! stderr(tracing);stdout **只**输出协议行。stdin EOF → 退出码 0。
//!
//! **凭证**:只认 env `TG_DEMO_API_KEY`/`TG_DEMO_API_SECRET`,或文件
//! `~/.trade-gate/secrets/apikey-demo.json`(`{"api_key","api_secret"}`,必须 0600,
//! 否则拒读 —— 复用 [`exec_core::secrets::load_from_file`] 的权限检查)。**不接受命令行
//! 传密钥**。
//!
//! **base URL 硬编码** [`FAPI_DEMO`](exec_core::binance::rest::FAPI_DEMO)
//! (`https://demo-fapi.binance.com`),没有任何面向用户的覆盖开关 —— 这是本进程唯一
//! 持有 demo key 的存在意义,不能被一个环境变量指去别的域名。
//! 唯一例外仅供**集成测试**用:env `TG_DEMO_EXEC_TEST_BASE_URL` 只在其值以
//! `http://127.0.0.1` 开头时才会被采用,让测试把请求打到本机假服务器;任何其它取值
//! (包括真实域名、非回环 IP)一律被忽略并打一条 warn 日志,继续用 `FAPI_DEMO`。
//! 生产部署不会设置这个变量。

use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::{Value, json};

use exec_core::binance::rest::{BinanceRest, FAPI_DEMO};
use exec_core::secrets::{CredentialError, MainCredentials, SecretString, load_from_file, mask, trade_gate_home};

/// 仅测试用的 base URL 覆盖 env;生产绝不设置。
const TEST_BASE_URL_ENV: &str = "TG_DEMO_EXEC_TEST_BASE_URL";

fn default_demo_secrets_path() -> PathBuf {
    trade_gate_home().join("secrets").join("apikey-demo.json")
}

/// env 优先,其次 `apikey-demo.json`。形状与 [`exec_core::secrets::load_main_credentials`]
/// 相同,只是换了一套 env 名字与默认文件名 —— demo key 与主账户 key 必须是两把不同的
/// 凭证,不能共用 `apikey-main.json` 的加载路径。
fn load_demo_credentials() -> Result<MainCredentials, CredentialError> {
    let key = std::env::var("TG_DEMO_API_KEY").ok().filter(|v| !v.trim().is_empty());
    let secret = std::env::var("TG_DEMO_API_SECRET").ok().filter(|v| !v.trim().is_empty());
    if let (Some(api_key), Some(api_secret)) = (key, secret) {
        return Ok(MainCredentials {
            api_key: api_key.trim().to_owned(),
            api_secret: SecretString::new(api_secret.trim()),
            source: "env".to_owned(),
        });
    }
    let path = default_demo_secrets_path();
    if !path.exists() {
        eprintln!(
            "凭证加载失败:没有 demo 凭证。请设置 TG_DEMO_API_KEY/TG_DEMO_API_SECRET,或写入 {}(chmod 600)。demo key 在 https://demo.binance.com 的 API 管理页创建;不要用主账户 key。",
            path.display()
        );
        std::process::exit(2);
    }
    load_from_file(&path)
}

/// base URL 只能是 `FAPI_DEMO`,除非测试覆盖 env 显式给了一个回环地址。
fn resolve_base_url() -> String {
    if let Ok(value) = std::env::var(TEST_BASE_URL_ENV) {
        let trimmed = value.trim();
        // Strict: scheme+host must be exactly http://127.0.0.1 followed by ':' / '/' / end, and no userinfo.
        let rest = trimmed.strip_prefix("http://127.0.0.1").unwrap_or("!");
        let loopback_only = (rest.is_empty() || rest.starts_with(':') || rest.starts_with('/')) && !trimmed.contains('@');
        if loopback_only {
            tracing::warn!(base_url = trimmed, "demo_exec.test_base_url_override_active");
            return trimmed.trim_end_matches('/').to_owned();
        }
        if !trimmed.is_empty() {
            tracing::warn!(
                value = trimmed,
                "demo_exec.test_base_url_override_rejected:只允许 http://127.0.0.1 开头,已继续用 FAPI_DEMO"
            );
        }
    }
    FAPI_DEMO.to_owned()
}

#[derive(Debug, serde::Deserialize)]
struct RequestLine {
    id: Value,
    op: String,
    #[serde(default)]
    params: Value,
}

/// 一行一个 JSON 对象;stdout 上不允许出现除协议行以外的任何内容。
fn write_line(out: &mut impl Write, value: &Value) {
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

async fn handle_line(exec: &exec_core::DemoExec, line: &str) -> Value {
    let request: RequestLine = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(error = %error, line, "demo_exec.malformed_request_line");
            return json!({
                "id": Value::Null,
                "ok": false,
                "error": {
                    "kind": "local_reject",
                    "message": format!("请求行不是合法 JSON 或缺少 id/op 字段:{error}"),
                    "code": Value::Null,
                    "ambiguous": false,
                },
            });
        }
    };
    let id = request.id.clone();
    tracing::debug!(?id, op = request.op.as_str(), "demo_exec.request");
    match exec.handle(&request.op, request.params).await {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
        Err(error) => {
            tracing::warn!(
                ?id,
                op = request.op.as_str(),
                kind = ?error.kind,
                message = error.message.as_str(),
                "demo_exec.request_failed"
            );
            json!({ "id": id, "ok": false, "error": error.to_json() })
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let credentials = match load_demo_credentials() {
        Ok(credentials) => credentials,
        Err(error) => {
            eprintln!("凭证加载失败:{error}");
            std::process::exit(1);
        }
    };

    let base_url = resolve_base_url();
    let rest = BinanceRest::new(&credentials).with_fapi_base(base_url.clone());
    if let Err(error) = rest.sync_server_time(true).await {
        tracing::warn!(error = %error, "demo_exec.initial_server_time_sync_failed");
    }
    let offset_ms = rest.time_offset_ms();
    let exec = exec_core::DemoExec::new(rest);

    let mut stdout = std::io::stdout();
    write_line(
        &mut stdout,
        &json!({
            "id": 0,
            "ok": true,
            "result": {
                "hello": "tgate-demo-exec",
                "base_url": base_url,
                "api_key_masked": mask(&credentials.api_key),
                "server_time_offset_ms": offset_ms,
            },
        }),
    );

    // 同步阻塞读 stdin:本进程唯一的并发是"处理一行请求时可能在等网络",与"等下一行
    // 输入"从不重叠(严格顺序、单写者),没有别的 tokio 任务需要在阻塞期间被调度,
    // 所以不需要 tokio 的异步 stdin(那要多加 `io-std` feature)。
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        match line {
            Ok(line) => {
                if line.trim().is_empty() {
                    continue;
                }
                let response = handle_line(&exec, &line).await;
                write_line(&mut stdout, &response);
            }
            Err(error) => {
                tracing::error!(error = %error, "demo_exec.stdin_read_failed");
                std::process::exit(1);
            }
        }
    }
    // stdin EOF:干净退出。
    std::process::exit(0);
}
