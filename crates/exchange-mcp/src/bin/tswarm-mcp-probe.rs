//! `tswarm-mcp-probe` —— A1 的实测探针。
//!
//! 它只做**观察**:走一次真实 OAuth、拉 `tools/list` 快照、调只读工具。
//! 写类工具默认拒绝调用(要显式加 `--i-know-this-writes`,A1 阶段不会用)。
//!
//! 典型用法:
//! ```text
//! tswarm-mcp-probe discover                 # 不需要 token:看 PRM/AS 元数据与校验结果
//! tswarm-mcp-probe probe-client             # 不经浏览器:验证 CIMD client_id 是否已被接受
//! tswarm-mcp-probe oauth                    # 真实授权(会打开浏览器)
//! tswarm-mcp-probe status                   # 本地 token 状态
//! tswarm-mcp-probe tools --out docs/research/binance-mcp-tools.json
//! tswarm-mcp-probe call get_account '{}'
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use exchange_mcp::auth::{AuthManager, OAuthConfig, now_ms};
use exchange_mcp::classify::{self, ToolClass};
use exchange_mcp::error::Error;
use exchange_mcp::mcp::{McpClient, McpConfig};
use exchange_mcp::oauth::{self, AuthorizeRequest, CallbackServer};
use exchange_mcp::token_store::TokenStore;
use exchange_mcp::{DEFAULT_CLIENT_ID, discovery, http, snapshot};
use serde_json::Value;

#[derive(Parser, Debug)]
#[command(
    name = "tswarm-mcp-probe",
    about = "Binance MCP / OAuth 实测探针(A1)。默认只读;写类工具需显式解锁。",
    version
)]
struct Cli {
    /// CIMD 元数据文档 URL(= OAuth client_id)。
    #[arg(long, global = true, default_value = DEFAULT_CLIENT_ID, env = "TSWARM_MCP_CLIENT_ID")]
    client_id: String,

    /// MCP endpoint。
    #[arg(long, global = true, default_value = exchange_mcp::BINANCE_MCP_ENDPOINT)]
    endpoint: String,

    /// token 文件路径(默认 ~/.trading-swarm/secrets/oauth-binance.json)。
    #[arg(long, global = true)]
    token_file: Option<PathBuf>,

    /// 单次 MCP 调用的截止时间(秒)。
    #[arg(long, global = true, default_value_t = 20)]
    timeout_secs: u64,

    /// 打开 debug 日志(注意:日志里不会有 token,写了断言测试)。
    #[arg(short, long, global = true)]
    verbose: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// 只做发现:401 挑战头 → PRM → AS 元数据 → 校验。不需要 token。
    Discover,

    /// 不经浏览器验证 client_id:拿假 code 打 token 端点,看返回 invalid_client 还是 invalid_grant。
    ProbeClient,

    /// 走完整授权码 + PKCE 流程(会打开浏览器)。
    Oauth {
        /// 回环端口。必须与 CIMD 文档里的 redirect_uris 逐字匹配。
        #[arg(long, default_value_t = exchange_mcp::DEFAULT_CALLBACK_PORT)]
        port: u16,
        /// 空格分隔的 scope。官方没公布字符串,默认不传。
        #[arg(long)]
        scopes: Option<String>,
        /// 不自动开浏览器,只打印 URL。
        #[arg(long)]
        no_browser: bool,
        /// 只打印 authorize URL 与 state,不监听回调。
        #[arg(long)]
        print_only: bool,
        /// 等待回调的超时(秒)。
        #[arg(long, default_value_t = 300)]
        wait_secs: u64,
    },

    /// 本地 token 状态(不打印 token 本身)。
    Status,

    /// 强制刷新一次(需要 refresh_token)。
    Refresh,

    /// initialize + tools/list,落快照并打印标注表。
    Tools {
        #[arg(long, default_value = "docs/research/binance-mcp-tools.json")]
        out: PathBuf,
        /// 与已有快照比对,打印漂移报告。
        #[arg(long)]
        compare: Option<PathBuf>,
    },

    /// 调一个工具。写类工具需要 --i-know-this-writes。
    Call {
        tool: String,
        /// JSON 参数,默认 `{}`。
        #[arg(default_value = "{}")]
        args: String,
        /// 解锁写类工具(A1 阶段不要用)。
        #[arg(long)]
        i_know_this_writes: bool,
    },

    /// 删除本地 token 文件。
    Revoke,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    init_tracing(cli.verbose);
    if let Err(e) = run(cli).await {
        eprintln!("\n失败({}):{e}", e.kind());
        std::process::exit(1);
    }
}

fn init_tracing(verbose: bool) {
    let filter = if verbose { "debug" } else { "info" };
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(filter)),
        )
        .with_target(false)
        .with_writer(std::io::stderr)
        .try_init();
}

async fn run(cli: Cli) -> exchange_mcp::Result<()> {
    let http_client = http::default_client()?;
    let store = match &cli.token_file {
        Some(p) => TokenStore::new(p.clone()),
        None => TokenStore::default_store()?,
    };
    let mut config = OAuthConfig::binance_defaults(cli.client_id.clone());
    config.resource = cli.endpoint.clone();
    let auth = Arc::new(AuthManager::new(http_client.clone(), store, config));
    let mcp_cfg = McpConfig {
        endpoint: cli.endpoint.clone(),
        call_timeout: Duration::from_secs(cli.timeout_secs),
        ..Default::default()
    };

    match cli.command {
        Command::Discover => cmd_discover(&http_client, &cli.endpoint).await,
        Command::ProbeClient => cmd_probe_client(&auth).await,
        Command::Oauth {
            port,
            scopes,
            no_browser,
            print_only,
            wait_secs,
        } => {
            cmd_oauth(
                &http_client,
                &auth,
                &cli.endpoint,
                port,
                scopes,
                no_browser,
                print_only,
                wait_secs,
            )
            .await
        }
        Command::Status => cmd_status(&auth),
        Command::Refresh => cmd_refresh(&auth).await,
        Command::Tools { out, compare } => {
            let client = McpClient::new(http_client, auth, mcp_cfg);
            cmd_tools(&client, out, compare).await
        }
        Command::Call {
            tool,
            args,
            i_know_this_writes,
        } => {
            let client = McpClient::new(http_client, auth, mcp_cfg);
            cmd_call(&client, &tool, &args, i_know_this_writes).await
        }
        Command::Revoke => cmd_revoke(&auth),
    }
}

// ---------------------------------------------------------------------------

async fn cmd_discover(http_client: &reqwest::Client, endpoint: &str) -> exchange_mcp::Result<()> {
    println!("== 1. 未授权 initialize(期望 401 + WWW-Authenticate)==");
    let hint = match discovery::probe_challenge(http_client, endpoint).await {
        Ok(Some(c)) => {
            println!("  challenge: {c:?}");
            c.resource_metadata
        }
        Ok(None) => {
            println!("  服务端没有返回 401(异常)");
            None
        }
        Err(e) => {
            println!("  探测失败:{e}");
            None
        }
    };

    println!("\n== 2. 发现流程 ==");
    let d = discovery::discover(http_client, endpoint, hint.as_deref()).await?;
    println!("  PRM URL      : {}", d.prm_url);
    println!("  resource     : {}", d.prm.resource);
    println!("  AS           : {:?}", d.prm.authorization_servers);
    println!("  scopes       : {:?}", d.prm.scopes_supported);
    println!("  AS 元数据 URL : {}", d.as_metadata_url);
    let m = &d.authorization_server;
    println!("  authorize    : {}", m.authorization_endpoint);
    println!("  token        : {}", m.token_endpoint);
    println!("  PKCE         : {:?}", m.code_challenge_methods_supported);
    println!("  auth methods : {:?}", m.token_endpoint_auth_methods_supported);
    println!("  grants       : {:?}", m.grant_types_supported);
    println!("  CIMD 支持     : {}", m.supports_cimd());
    println!("  DCR 端点      : {:?}", m.registration_endpoint);
    if !d.warnings.is_empty() {
        println!("\n  提醒:");
        for w in &d.warnings {
            println!("   - {w}");
        }
    }
    Ok(())
}

async fn cmd_probe_client(auth: &Arc<AuthManager>) -> exchange_mcp::Result<()> {
    println!("用一个必然无效的 authorization_code 打 token 端点,只看它抱怨 client 还是抱怨 code。");
    println!("client_id: {}", auth.config().client_id);
    let verdict = auth.token_endpoint().probe_client().await;
    println!("\n结论:{}", verdict.headline());
    println!("原始:{}", serde_json::to_string(&verdict).unwrap_or_default());
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn cmd_oauth(
    http_client: &reqwest::Client,
    auth: &Arc<AuthManager>,
    endpoint: &str,
    port: u16,
    scopes: Option<String>,
    no_browser: bool,
    print_only: bool,
    wait_secs: u64,
) -> exchange_mcp::Result<()> {
    // 先做一次发现,拿到真实端点(拿不到就用已实测的常量兜底)。
    let (authorize_endpoint, token_endpoint) =
        match discovery::discover(http_client, endpoint, Some(exchange_mcp::BINANCE_PRM_URL)).await {
            Ok(d) => {
                for w in &d.warnings {
                    println!("提醒:{w}");
                }
                (
                    d.authorization_server.authorization_endpoint.clone(),
                    d.authorization_server.token_endpoint.clone(),
                )
            }
            Err(e) => {
                println!("发现流程失败({e}),退回已实测的常量端点");
                (
                    exchange_mcp::BINANCE_AUTHORIZE_ENDPOINT.to_string(),
                    exchange_mcp::BINANCE_TOKEN_ENDPOINT.to_string(),
                )
            }
        };

    let pkce = oauth::generate_pkce();
    let state = oauth::generate_state();

    // print_only 不监听端口,但 redirect_uri 必须与真实流程一致。
    let (redirect_uri, server) = if print_only {
        (
            format!("http://127.0.0.1:{port}{}", exchange_mcp::DEFAULT_CALLBACK_PATH),
            None,
        )
    } else {
        let server = CallbackServer::bind(port, exchange_mcp::DEFAULT_CALLBACK_PATH).await?;
        (server.redirect_uri().to_string(), Some(server))
    };

    let url = oauth::build_authorize_url(&AuthorizeRequest {
        authorization_endpoint: authorize_endpoint,
        client_id: auth.config().client_id.clone(),
        redirect_uri: redirect_uri.clone(),
        resource: endpoint.to_string(),
        scopes,
        state: state.clone(),
        code_challenge: pkce.challenge.clone(),
    })?;

    println!("\nauthorize URL:\n{url}\n");
    println!("state       : {state}");
    println!("redirect_uri: {redirect_uri}");
    println!("client_id   : {}", auth.config().client_id);
    println!("token 端点   : {token_endpoint}");
    println!("(PKCE verifier 不打印。)");

    let Some(server) = server else {
        println!("\n--print-only:不监听回调,到此为止。");
        return Ok(());
    };

    if !no_browser {
        open_browser(url.as_str());
    } else {
        println!("\n--no-browser:请手动把上面的 URL 粘进桌面浏览器。");
    }

    println!("\n等待浏览器回调({wait_secs}s)…(authorize 页面有 AWS WAF,必须真实浏览器)");
    let callback = server
        .wait_for_code(&state, Duration::from_secs(wait_secs))
        .await?;

    println!("拿到授权码,正在换 token…");
    let token = auth
        .complete_authorization_code(&callback.code, &redirect_uri, &pkce.verifier)
        .await?;

    println!("\n== token 概要(不打印 token 本身)==");
    print_status(&exchange_mcp::TokenStatus::from_token(&token, now_ms()));
    println!("  response 其余字段: {}", serde_json::to_string(&token.response_extras).unwrap_or_default());
    println!("\n落盘: {}", auth.store().path().display());
    println!("下一步: tswarm-mcp-probe tools --out docs/research/binance-mcp-tools.json");
    Ok(())
}

fn cmd_status(auth: &Arc<AuthManager>) -> exchange_mcp::Result<()> {
    let status = auth.status()?;
    println!("token 文件: {}", auth.store().path().display());
    if auth.store().exists() {
        println!("权限位    : {:#o}", auth.store().mode()?);
    }
    print_status(&status);
    Ok(())
}

fn print_status(status: &exchange_mcp::TokenStatus) {
    println!("  状态        : {}", status.state.as_str());
    println!("  token 指纹   : {:?}", status.access_token_fingerprint);
    println!("  token_type  : {:?}", status.token_type);
    println!("  有 refresh   : {}", status.has_refresh);
    println!("  scopes      : {:?}", status.scopes);
    match (status.valid_until_ms, status.expires_in_ms) {
        (Some(until), Some(left)) => println!(
            "  有效期至     : {until}(剩 {} 分钟)",
            left / 60_000
        ),
        _ => println!("  有效期至     : 未知(token 响应没有 expires_in)"),
    }
    if let Some(reason) = &status.revoked_reason {
        println!("  撤销原因     : {reason}");
    }
}

async fn cmd_refresh(auth: &Arc<AuthManager>) -> exchange_mcp::Result<()> {
    match auth.force_refresh().await {
        Ok(token) => {
            println!("刷新成功。");
            print_status(&exchange_mcp::TokenStatus::from_token(&token, now_ms()));
            Ok(())
        }
        Err(Error::Revoked) => {
            println!("刷新被拒:invalid_grant —— 授权已被撤销(或 refresh token 过期)。");
            println!("处理:写路径 HALT,去 Binance UI 重新授权后再跑 `oauth`。");
            Err(Error::Revoked)
        }
        Err(e) => Err(e),
    }
}

async fn cmd_tools(
    client: &McpClient,
    out: PathBuf,
    compare: Option<PathBuf>,
) -> exchange_mcp::Result<()> {
    let session = client.initialize().await?;
    println!("协议版本 : {:?}", session.protocol_version);
    println!("会话 id  : {:?}", session.session_id);
    println!("serverInfo: {}", serde_json::to_string(&session.server_info).unwrap_or_default());

    let snap = client.snapshot_tools().await?;
    println!("\n工具数   : {}", snap.tools.len());
    println!("tools_hash: {}", snap.tools_hash);

    let annotations: Vec<_> = snap.tools.iter().map(classify::annotate).collect();
    print_tool_table(&annotations);

    let writes: Vec<_> = annotations.iter().filter(|a| a.class == ToolClass::Write).collect();
    println!("\n== 写类工具({})与幂等字段 ==", writes.len());
    if writes.is_empty() {
        println!("  (没有识别出写类工具)");
    }
    for a in &writes {
        let fields = if a.idempotency_fields.is_empty() {
            "**没有找到 clientOrderId 类字段**".to_string()
        } else {
            a.idempotency_fields.join(", ")
        };
        println!("  {:<32} {fields}", a.name);
    }

    let identity: Vec<_> = annotations.iter().filter(|a| a.looks_like_identity).collect();
    println!("\n== 可能给出账户/子账户标识的工具({})==", identity.len());
    for a in &identity {
        println!("  {:<32} {}", a.name, a.description_line);
    }

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&snap).unwrap_or_default())?;
    println!("\n快照已写入 {}", out.display());

    if let Some(path) = compare {
        let saved: snapshot::ToolsSnapshot = serde_json::from_str(&std::fs::read_to_string(&path)?)
            .map_err(|e| Error::Io(format!("读旧快照失败:{e}")))?;
        let report = snapshot::drift_check(&saved, &snap);
        println!("\n== 漂移比对 vs {} ==", path.display());
        println!("{}", report.summary());
        println!("破坏性: {}", report.is_breaking());
    }
    Ok(())
}

fn print_tool_table(annotations: &[classify::ToolAnnotation]) {
    let name_w = annotations.iter().map(|a| a.name.len()).max().unwrap_or(4).clamp(4, 40);
    println!("\n{:<width$}  {:<5}  {}", "NAME", "CLASS", "DESCRIPTION / INPUT", width = name_w);
    println!("{}", "-".repeat(name_w + 60));
    for a in annotations {
        println!(
            "{:<width$}  {:<5}  {}",
            a.name,
            a.class.as_str(),
            a.description_line,
            width = name_w
        );
        println!(
            "{:<width$}         args: {}",
            "",
            if a.top_level_properties.is_empty() {
                "(无)".to_string()
            } else {
                a.top_level_properties.join(", ")
            },
            width = name_w
        );
    }
    println!("\n(* = required;class 是启发式,不是权限墙)");
}

async fn cmd_call(
    client: &McpClient,
    tool: &str,
    args: &str,
    unlocked: bool,
) -> exchange_mcp::Result<()> {
    let args: Value = serde_json::from_str(args)
        .map_err(|e| Error::Protocol(format!("参数不是合法 JSON:{e}")))?;

    let class = classify::classify_name(tool);
    if class == ToolClass::Write && !unlocked {
        return Err(Error::Protocol(format!(
            "`{tool}` 看起来是写类工具(会动钱或改账户状态),探针默认拒绝。\
确实要调就加 --i-know-this-writes(A1 阶段不该用到)。"
        )));
    }

    let outcome = if class == ToolClass::Write {
        println!("!! 写类调用:不会自动重试、不会重放。超时的语义是「不知道有没有到达」。");
        client.call_write(tool, args).await?
    } else {
        client.call_read(tool, args).await?
    };

    println!("isError: {}", outcome.is_error);
    let text = outcome.text();
    if !text.is_empty() {
        println!("\n-- content --\n{text}");
    }
    println!(
        "\n-- raw --\n{}",
        serde_json::to_string_pretty(&outcome.raw).unwrap_or_default()
    );

    let dir = exchange_mcp::probe_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}-{}.json", sanitize(tool), now_ms()));
    write_0600(&path, &serde_json::to_string_pretty(&outcome.raw).unwrap_or_default())?;
    println!("\n原始响应已存 {}", path.display());
    Ok(())
}

fn cmd_revoke(auth: &Arc<AuthManager>) -> exchange_mcp::Result<()> {
    let removed = auth.store().delete()?;
    if removed {
        println!("已删除本地 token 文件:{}", auth.store().path().display());
    } else {
        println!("本地没有 token 文件,无需删除。");
    }
    println!(
        "\n注意:这只删本地凭证,**不等于服务端撤销**。\n\
要真正断开 agent 授权,去 Binance UI:Profile → Agentic / Disconnect agents。\n\
服务端撤销后,任何 refresh 都会返回 invalid_grant(本 crate 会置 Revoked 并要求重新授权)。"
    );
    Ok(())
}

// ---------------------------------------------------------------------------

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(not(unix))]
    let result: std::io::Result<std::process::Child> =
        Err(std::io::Error::other("不支持的平台"));

    match result {
        Ok(_) => println!("已尝试用系统浏览器打开。"),
        Err(e) => println!("打不开浏览器({e}),请手动粘贴 URL。"),
    }
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn write_0600(path: &std::path::Path, content: &str) -> exchange_mcp::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(content.as_bytes())?;
    Ok(())
}
