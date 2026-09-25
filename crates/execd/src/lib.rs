//! execd —— 唯一凭证持有者与账户写者(设计 §3)。A0 交付:数据目录、单实例锁、exec.sqlite 迁移、
//! 写者租约、UDS JSON-RPC 骨架、policy/紧急停、intent 的 propose/reject/get/list(无 plan 物化)、
//! 事件落库 + 订阅回放。A2 在此之上加六记录状态机、durable 队列、两条交易所通道、对账。

pub mod app;
pub mod db;
pub mod events;
pub mod intents;
pub mod lock;
pub mod paths;
pub mod policy;
pub mod rpc_server;
pub mod store;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use tokio::net::UnixListener;
use tokio::sync::watch;

pub use app::App;
pub use paths::DataDir;
pub use store::Store;

/// 一个可运行的 execd 实例(main 与集成测试共用)。
pub struct Runtime {
    pub app: Arc<App>,
    pub data: DataDir,
    _lock: lock::InstanceLock,
    listener: Option<UnixListener>,
}

impl Runtime {
    /// 建目录 → 抢锁 → 开库迁移 → 抢租约 → 绑 socket(删旧的、0600)。
    pub fn bootstrap(data: DataDir) -> anyhow::Result<Self> {
        data.ensure()?;
        let instance_id = format!("execd-{}-{}", hostname(), std::process::id());
        let lock = lock::InstanceLock::acquire(&data.lock_path, &instance_id)?;
        let store = Store::open(&data.db_path)?;
        let app = App::new(store, instance_id)?;
        if data.socket_path.exists() {
            std::fs::remove_file(&data.socket_path).with_context(|| format!("删旧 socket {}", data.socket_path.display()))?;
        }
        let std_listener = std::os::unix::net::UnixListener::bind(&data.socket_path)
            .with_context(|| format!("绑定 {}", data.socket_path.display()))?;
        std_listener.set_nonblocking(true)?;
        paths::set_mode(&data.socket_path, 0o600)?;
        let listener = UnixListener::from_std(std_listener)?;
        tracing::info!(socket = %data.socket_path.display(), db = %data.db_path.display(), instance = %app.instance_id, epoch = app.lease_epoch, "execd 就绪");
        Ok(Self { app, data, _lock: lock, listener: Some(listener) })
    }

    /// 跑到 shutdown 信号为 true;退出时删 socket。
    pub async fn run(mut self, shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
        let listener = self.listener.take().expect("listener 只取一次");
        let result = rpc_server::serve(self.app.clone(), listener, shutdown).await;
        let _ = std::fs::remove_file(&self.data.socket_path);
        result
    }

    pub fn socket_path(&self) -> PathBuf {
        self.data.socket_path.clone()
    }
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_owned())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "host".into())
        .split('.')
        .next()
        .unwrap_or("host")
        .to_owned()
}
