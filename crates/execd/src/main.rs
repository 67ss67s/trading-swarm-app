//! `execd --data-dir ~/.trade-gate [--socket <path>] [--log-level info]`

use std::path::PathBuf;

use clap::Parser;
use execd::{DataDir, Runtime};
use tokio::sync::watch;

#[derive(Parser, Debug)]
#[command(name = "execd", about = "trade-gate 执行服务(唯一凭证持有者与账户写者)")]
struct Cli {
    /// 数据目录(默认 $TRADE_GATE_HOME 或 ~/.trade-gate)
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// UDS 路径(默认 <data-dir>/run/execd.sock;macOS 路径上限 104 字节)
    #[arg(long)]
    socket: Option<PathBuf>,
    /// 日志级别(也可用 RUST_LOG)
    #[arg(long, default_value = "info")]
    log_level: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(cli.log_level.clone()));
    tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).init();

    let root = cli.data_dir.unwrap_or_else(DataDir::default_root);
    let data = DataDir::new(root, cli.socket);
    let runtime = Runtime::bootstrap(data)?;

    let (tx, rx) = watch::channel(false);
    tokio::spawn(async move {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! {
                _ = ctrl_c => tracing::info!("收到 SIGINT"),
                _ = term.recv() => tracing::info!("收到 SIGTERM"),
            }
        }
        #[cfg(not(unix))]
        {
            let _ = ctrl_c.await;
        }
        let _ = tx.send(true);
    });

    runtime.run(rx).await
}
