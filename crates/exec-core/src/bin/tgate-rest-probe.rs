//! tgate-rest-probe —— A1 主账户 API key 探针(设计 §3.5「三件事」+ §14 向导 4b 权限探测)。
//!
//! 默认流程**全部只读**:服务器时间偏移 → key 权限位 → 现货余额概要 → 合约账户概要 +
//! 持仓模式 → 子账户列表(找 Agentic virtual sub 的标识字段)→ 每个子账户的资产 →
//! 万能划转历史。**只有** `--transfer-test` + 环境变量 `TG_ALLOW_TRANSFER=1` 双开关同时给出
//! 才会发一笔 `universalTransfer`(这是动钱,Jacky 给 key 后由主线亲自跑)。
//!
//! 凭证来源只有 env `TG_MAIN_API_KEY`/`TG_MAIN_API_SECRET` 或 `~/.trade-gate/secrets/apikey-main.json`
//! (0600);**不接受命令行传密钥**。输出:stdout markdown 报告 + `--json-out` 脱敏 JSON。

use std::path::PathBuf;

use clap::Parser;
use serde_json::{Value, json};

use exec_core::binance::rest::BinanceRest;
use exec_core::binance::spot_sapi::{AccountType, email_fingerprint, mask_email};
use exec_core::secrets::{load_main_credentials, mask};

#[derive(Parser, Debug)]
#[command(name = "tgate-rest-probe", about = "trade-gate A1:主账户 key 权限与主/子账户联动探针(默认只读)")]
struct Cli {
    /// 凭证文件路径(默认 ~/.trade-gate/secrets/apikey-main.json;env 优先)
    #[arg(long)]
    secrets: Option<PathBuf>,
    /// 打印真实金额(默认只打印条数,金额脱敏)
    #[arg(long)]
    show_balances: bool,
    /// 把脱敏 JSON 报告写到这里(建议 docs/research/a1-main-key-probe.json)
    #[arg(long)]
    json_out: Option<PathBuf>,
    /// recvWindow(毫秒)
    #[arg(long, default_value_t = 5_000)]
    recv_window: i64,
    /// 子账户列表分页大小
    #[arg(long, default_value_t = 50)]
    sub_limit: i64,
    /// 【动钱】执行一次 universalTransfer 测试;还必须 env TG_ALLOW_TRANSFER=1
    #[arg(long)]
    transfer_test: bool,
    #[arg(long, requires = "transfer_test")]
    asset: Option<String>,
    #[arg(long, requires = "transfer_test")]
    amount: Option<String>,
    /// 目标子账户 email(主 → 子);与 --from-email 二选一
    #[arg(long, requires = "transfer_test")]
    to_email: Option<String>,
    /// 来源子账户 email(子 → 主)
    #[arg(long, requires = "transfer_test")]
    from_email: Option<String>,
    #[arg(long, default_value = "SPOT")]
    from_type: String,
    #[arg(long, default_value = "SPOT")]
    to_type: String,
}

#[derive(Debug, serde::Serialize)]
struct Step {
    name: &'static str,
    ok: bool,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
struct Report {
    generated_at_ms: i64,
    key_source: String,
    key_masked: String,
    show_balances: bool,
    steps: Vec<Step>,
    /// A1 三件事的结论(能自动判的先判,判不了写 unknown)
    findings: Value,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::String(s) => matches!(s.to_ascii_lowercase().as_str(), "true" | "1" | "yes"),
        Value::Number(n) => n.as_f64().map(|v| v != 0.0).unwrap_or(false),
        _ => false,
    }
}

fn f64_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn hide_amount(show: bool, value: &Value) -> Value {
    if show { value.clone() } else { Value::String("<hidden>".into()) }
}

/// 把一行资产/余额脱敏:保留资产名与"是否非零",金额按开关。
fn redact_balance_row(show: bool, row: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for (key, value) in row.as_object().into_iter().flatten() {
        let lowered = key.to_ascii_lowercase();
        let is_amount = lowered.contains("balance")
            || lowered.contains("free")
            || lowered.contains("locked")
            || lowered.contains("margin")
            || lowered.contains("pnl")
            || lowered.contains("amount")
            || lowered.contains("value")
            || lowered.contains("equity");
        if is_amount {
            let nonzero = f64_of(value).map(|v| v != 0.0).unwrap_or(false);
            out.insert(key.clone(), hide_amount(show, value));
            out.insert(format!("{key}_nonzero"), Value::Bool(nonzero));
        } else if lowered.contains("email") {
            out.insert(key.clone(), Value::String(mask_email(value.as_str().unwrap_or(""))));
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

fn err_step(name: &'static str, error: &exec_core::BinanceError) -> Step {
    Step {
        name,
        ok: false,
        summary: format!("{:?} {}", error.kind, error.msg),
        data: None,
        error: Some(error.to_json()),
        warnings: Vec::new(),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    if let Err(error) = run(cli).await {
        eprintln!("探针失败:{error:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    let credentials = load_main_credentials(cli.secrets.as_deref())?;
    let rest = BinanceRest::new(&credentials).with_recv_window(cli.recv_window);
    let show = cli.show_balances;
    let mut steps: Vec<Step> = Vec::new();
    let mut agentic_candidates: Vec<Value> = Vec::new();
    let mut sub_emails: Vec<String> = Vec::new();

    // 1. 服务器时间与本机偏移
    match rest.sync_server_time(true).await {
        Ok(offset) => {
            let mut warnings = Vec::new();
            if offset.abs() > 10_000 {
                warnings.push(format!("本机与币安时钟偏移 {offset} ms > 10s:设计 §10.3 口径应 HALT;先校时"));
            } else if offset.abs() > 2_000 {
                warnings.push(format!("时钟偏移 {offset} ms > 2s:禁新增风险阈值;Clash fake-IP 曾让 macOS 校时静默失效"));
            }
            steps.push(Step {
                name: "server_time",
                ok: true,
                summary: format!("offset {offset} ms"),
                data: Some(json!({ "offset_ms": offset })),
                error: None,
                warnings,
            });
        }
        Err(error) => steps.push(err_step("server_time", &error)),
    }

    // 2. key 权限位
    let mut permits_universal_transfer = None;
    match rest.spot().api_restrictions().await {
        Ok(restrictions) => {
            let mut warnings = Vec::new();
            if restrictions.enable_withdrawals {
                warnings.push("⚠️ enableWithdrawals=true:设计 §16 Q7 默认**不勾提币**;若确要一键提币必须 IP 白名单 + WebUI 二次确认".into());
            }
            if !restrictions.ip_restrict {
                warnings.push("ipRestrict=false:建议给这把 key 配 IP 白名单(主账户 key 爆炸半径大于子账户 OAuth)".into());
            }
            for missing in restrictions.missing_for_trade_gate() {
                warnings.push(format!("缺权限:{missing}"));
            }
            permits_universal_transfer = Some(restrictions.permits_universal_transfer);
            steps.push(Step {
                name: "api_restrictions",
                ok: true,
                summary: format!(
                    "reading={} spot_margin={} futures={} universal_transfer={} withdrawals={} ip_restrict={}",
                    restrictions.enable_reading,
                    restrictions.enable_spot_and_margin_trading,
                    restrictions.enable_futures,
                    restrictions.permits_universal_transfer,
                    restrictions.enable_withdrawals,
                    restrictions.ip_restrict
                ),
                data: Some(restrictions.raw.clone()),
                error: None,
                warnings,
            });
        }
        Err(error) => steps.push(err_step("api_restrictions", &error)),
    }

    // 3. 现货余额概要
    match rest.spot().spot_account().await {
        Ok(account) => {
            let balances = account.get("balances").and_then(Value::as_array).cloned().unwrap_or_default();
            let nonzero: Vec<Value> = balances
                .iter()
                .filter(|row| {
                    let free = row.get("free").and_then(f64_of).unwrap_or(0.0);
                    let locked = row.get("locked").and_then(f64_of).unwrap_or(0.0);
                    free != 0.0 || locked != 0.0
                })
                .map(|row| redact_balance_row(show, row))
                .collect();
            let permissions = account.get("permissions").cloned().unwrap_or(Value::Null);
            steps.push(Step {
                name: "spot_account",
                ok: true,
                summary: format!("{} 种资产,{} 种非零;permissions={}", balances.len(), nonzero.len(), permissions),
                data: Some(json!({
                    "asset_count": balances.len(),
                    "nonzero": nonzero,
                    "permissions": permissions,
                    "account_type": account.get("accountType").cloned().unwrap_or(Value::Null),
                    "can_trade": account.get("canTrade").map(truthy),
                    "can_withdraw": account.get("canWithdraw").map(truthy),
                })),
                error: None,
                warnings: Vec::new(),
            });
        }
        Err(error) => steps.push(err_step("spot_account", &error)),
    }

    // 4. 合约账户概要 + 持仓模式
    match rest.futures().account().await {
        Ok(account) => {
            let positions = account
                .get("positions")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter(|row| row.get("positionAmt").and_then(f64_of).map(|v| v != 0.0).unwrap_or(false))
                        .map(|row| redact_balance_row(show, row))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let summary_keys = ["totalWalletBalance", "totalMarginBalance", "availableBalance", "totalUnrealizedProfit"];
            let mut summary = serde_json::Map::new();
            for key in summary_keys {
                if let Some(value) = account.get(key) {
                    summary.insert(key.to_owned(), hide_amount(show, value));
                }
            }
            steps.push(Step {
                name: "futures_account",
                ok: true,
                summary: format!("{} 个非零持仓;canTrade={:?}", positions.len(), account.get("canTrade").map(truthy)),
                data: Some(json!({ "summary": summary, "open_positions": positions })),
                error: None,
                warnings: Vec::new(),
            });
        }
        Err(error) => steps.push(err_step("futures_account", &error)),
    }
    match rest.futures().position_mode().await {
        Ok(mode) => steps.push(Step {
            name: "futures_position_mode",
            ok: true,
            summary: format!("{} ({})", mode.as_str(), mode.label()),
            data: Some(json!({ "mode": mode.as_str() })),
            error: None,
            warnings: Vec::new(),
        }),
        Err(error) => steps.push(err_step("futures_position_mode", &error)),
    }

    // 5. 子账户列表 —— A1 判据①
    match rest.spot().sub_account_list(None, 1, cli.sub_limit).await {
        Ok(subs) => {
            let mut rows = Vec::new();
            let mut warnings = Vec::new();
            for sub in &subs {
                sub_emails.push(sub.email.clone());
                let mut raw = sub.raw.clone();
                if let Some(obj) = raw.as_object_mut() {
                    obj.remove("email");
                }
                let raw_text = raw.to_string().to_ascii_lowercase();
                let looks_agentic = raw_text.contains("agentic")
                    || raw_text.contains("virtual")
                    || sub.email.to_ascii_lowercase().contains("agent");
                let row = json!({
                    "email_masked": mask_email(&sub.email),
                    "email_fingerprint": email_fingerprint(&sub.email),
                    "is_freeze": sub.is_freeze,
                    "create_time_ms": sub.create_time_ms,
                    "other_fields": raw,
                    "looks_agentic": looks_agentic,
                });
                if looks_agentic {
                    agentic_candidates.push(row.clone());
                }
                rows.push(row);
            }
            if subs.is_empty() {
                warnings.push("子账户列表为空:要么这把 key 没开子账户权限,要么 Agentic virtual sub 不在这个列表里(判据①=不通),也可能还没做过一次 OAuth(子账户在首次授权时才创建)".into());
            } else if agentic_candidates.is_empty() {
                warnings.push("列表非空但没有一行像 Agentic/virtual:请人工看 other_fields 的字段名(subAccountType / isManagedSubAccount 等)".into());
            }
            steps.push(Step {
                name: "sub_account_list",
                ok: true,
                summary: format!("{} 个子账户,{} 个疑似 Agentic", subs.len(), agentic_candidates.len()),
                data: Some(json!({ "count": subs.len(), "rows": rows })),
                error: None,
                warnings,
            });
        }
        Err(error) => steps.push(err_step("sub_account_list", &error)),
    }

    // 6. 每个子账户的资产 —— A1 判据③
    for email in sub_emails.clone() {
        let masked = mask_email(&email);
        match rest.spot().sub_account_assets(&email).await {
            Ok(assets) => {
                let balances = assets.get("balances").and_then(Value::as_array).cloned().unwrap_or_default();
                let nonzero: Vec<Value> = balances
                    .iter()
                    .filter(|row| {
                        let free = row.get("free").and_then(f64_of).unwrap_or(0.0);
                        let locked = row.get("locked").and_then(f64_of).unwrap_or(0.0);
                        free != 0.0 || locked != 0.0
                    })
                    .map(|row| redact_balance_row(show, row))
                    .collect();
                steps.push(Step {
                    name: "sub_account_assets",
                    ok: true,
                    summary: format!("{masked}: {} 种资产,{} 种非零", balances.len(), nonzero.len()),
                    data: Some(json!({
                        "email_masked": masked,
                        "email_fingerprint": email_fingerprint(&email),
                        "asset_count": balances.len(),
                        "nonzero": nonzero,
                    })),
                    error: None,
                    warnings: Vec::new(),
                });
            }
            Err(error) => {
                let mut step = err_step("sub_account_assets", &error);
                step.summary = format!("{masked}: {}", step.summary);
                steps.push(step);
            }
        }
    }

    // 7. 万能划转历史 —— 判据②的旁证
    match rest.spot().universal_transfer_history(None, None, 50).await {
        Ok(history) => {
            let rows = history
                .get("result")
                .and_then(Value::as_array)
                .cloned()
                .or_else(|| history.as_array().cloned())
                .unwrap_or_default();
            let shapes: Vec<Value> = rows
                .iter()
                .map(|row| {
                    json!({
                        "from": row.get("fromAccountType"),
                        "to": row.get("toAccountType"),
                        "from_email": row.get("fromEmail").and_then(Value::as_str).map(mask_email),
                        "to_email": row.get("toEmail").and_then(Value::as_str).map(mask_email),
                        "asset": row.get("asset"),
                        "status": row.get("status"),
                        "create_time": row.get("createTimeStamp"),
                    })
                })
                .collect();
            steps.push(Step {
                name: "universal_transfer_history",
                ok: true,
                summary: format!("{} 条历史", rows.len()),
                data: Some(json!({ "count": rows.len(), "recent": shapes })),
                error: None,
                warnings: Vec::new(),
            });
        }
        Err(error) => steps.push(err_step("universal_transfer_history", &error)),
    }

    // 8. 【动钱】划转测试:双开关
    if cli.transfer_test {
        let allowed = std::env::var("TG_ALLOW_TRANSFER").map(|v| v == "1").unwrap_or(false);
        let asset = cli.asset.clone().unwrap_or_default();
        let amount = cli.amount.clone().unwrap_or_default();
        if !allowed {
            steps.push(Step {
                name: "universal_transfer_test",
                ok: false,
                summary: "跳过:需要 env TG_ALLOW_TRANSFER=1(双开关)".into(),
                data: None,
                error: None,
                warnings: vec!["这是动钱操作;A 阶段由主线在 Jacky 放行后亲自跑".into()],
            });
        } else if asset.is_empty() || amount.is_empty() || (cli.to_email.is_none() && cli.from_email.is_none()) {
            anyhow::bail!("--transfer-test 需要 --asset --amount 以及 --to-email 或 --from-email 之一");
        } else {
            let from_type = AccountType::parse(&cli.from_type).map_err(anyhow::Error::msg)?;
            let to_type = AccountType::parse(&cli.to_type).map_err(anyhow::Error::msg)?;
            let client_tran_id = format!("tg-probe-{}", now_ms());
            match rest
                .spot()
                .universal_transfer(
                    cli.from_email.as_deref(),
                    cli.to_email.as_deref(),
                    from_type,
                    to_type,
                    &asset,
                    &amount,
                    Some(&client_tran_id),
                )
                .await
            {
                Ok(receipt) => {
                    // 立刻回查一次历史确认
                    let confirm = rest
                        .spot()
                        .universal_transfer_history(cli.from_email.as_deref(), cli.to_email.as_deref(), 5)
                        .await
                        .ok();
                    steps.push(Step {
                        name: "universal_transfer_test",
                        ok: true,
                        summary: format!("tranId={:?} clientTranId={client_tran_id}", receipt.get("tranId")),
                        data: Some(json!({ "receipt": receipt, "history_after": confirm })),
                        error: None,
                        warnings: Vec::new(),
                    });
                }
                Err(error) => steps.push(err_step("universal_transfer_test", &error)),
            }
        }
    }

    let sub_visible = steps.iter().any(|s| s.name == "sub_account_list" && s.ok);
    let assets_readable = steps.iter().any(|s| s.name == "sub_account_assets" && s.ok);
    let transfer_tested = steps.iter().find(|s| s.name == "universal_transfer_test").map(|s| s.ok);
    let findings = json!({
        "q1_agentic_sub_visible_in_list": if !sub_visible { "unknown(list 调用失败)" } else if !agentic_candidates.is_empty() { "yes(见 sub_account_list.rows[].looks_agentic)" } else if sub_emails.is_empty() { "no_or_not_yet(列表为空)" } else { "manual_check(列表非空,字段里没看到 agentic/virtual 字样)" },
        "q2_universal_transfer_to_agentic_sub": match transfer_tested {
            Some(true) => "yes(本次实测成功)",
            Some(false) => "no(本次实测被拒,看 error)",
            None => if permits_universal_transfer == Some(true) { "untested(key 有 permitsUniversalTransfer;需 --transfer-test 双开关实测)" } else { "blocked(key 没有 permitsUniversalTransfer)" },
        },
        "q3_sub_account_assets_readable": if assets_readable { "yes" } else if sub_emails.is_empty() { "unknown(没有子账户可读)" } else { "no(全部 assets 调用失败)" },
        "agentic_candidates": agentic_candidates,
    });

    let report = Report {
        generated_at_ms: now_ms(),
        key_source: credentials.source.clone(),
        key_masked: mask(&credentials.api_key),
        show_balances: show,
        steps,
        findings,
    };
    print_markdown(&report);
    if let Some(path) = &cli.json_out {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(&report)? + "\n")?;
        eprintln!("JSON 报告已写入 {}", path.display());
    }
    Ok(())
}

fn print_markdown(report: &Report) {
    println!("# tgate-rest-probe 报告");
    println!();
    println!("- 时间:{} ms  - key:{}({})  - 金额显示:{}", report.generated_at_ms, report.key_masked, report.key_source, report.show_balances);
    println!();
    println!("| 步骤 | 结果 | 摘要 |");
    println!("|---|---|---|");
    for step in &report.steps {
        println!("| {} | {} | {} |", step.name, if step.ok { "✅" } else { "❌" }, step.summary.replace('|', "\\|"));
    }
    println!();
    for step in &report.steps {
        for warning in &step.warnings {
            println!("- ⚠️ [{}] {}", step.name, warning);
        }
        if let Some(error) = &step.error {
            println!("- ❌ [{}] {}", step.name, error);
        }
    }
    println!();
    println!("## A1 三件事");
    println!("```json");
    println!("{}", serde_json::to_string_pretty(&report.findings).unwrap_or_default());
    println!("```");
}
