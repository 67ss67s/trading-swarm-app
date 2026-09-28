//! 数据目录布局 `~/.trade-gate/`(设计 §3):`exec.sqlite` 只有 execd 打开;`secrets/` 0700 只有 execd 读;
//! `run/execd.sock` 0600;`run/execd.lock` 单实例锁。

use std::path::{Path, PathBuf};

use anyhow::Context;

#[derive(Debug, Clone)]
pub struct DataDir {
    pub root: PathBuf,
    pub run: PathBuf,
    pub secrets: PathBuf,
    pub logs: PathBuf,
    pub db_path: PathBuf,
    pub socket_path: PathBuf,
    pub lock_path: PathBuf,
}

impl DataDir {
    pub fn new(root: impl Into<PathBuf>, socket_override: Option<PathBuf>) -> Self {
        let root = root.into();
        let run = root.join("run");
        Self {
            secrets: root.join("secrets"),
            logs: root.join("logs"),
            db_path: root.join("exec.sqlite"),
            socket_path: socket_override.unwrap_or_else(|| run.join("execd.sock")),
            lock_path: run.join("execd.lock"),
            run,
            root,
        }
    }

    /// 默认 `$TRADE_GATE_HOME` 或 `~/.trade-gate`。
    pub fn default_root() -> PathBuf {
        if let Ok(v) = std::env::var("TRADE_GATE_HOME")
            && !v.trim().is_empty()
        {
            return PathBuf::from(v);
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".trade-gate")
    }

    /// 建目录并收紧权限(root 0700,run/secrets 0700,logs 0700)。
    pub fn ensure(&self) -> anyhow::Result<()> {
        for dir in [&self.root, &self.run, &self.secrets, &self.logs] {
            std::fs::create_dir_all(dir).with_context(|| format!("建目录 {}", dir.display()))?;
            set_mode(dir, 0o700)?;
        }
        if let Some(parent) = self.socket_path.parent() {
            std::fs::create_dir_all(parent).with_context(|| format!("建目录 {}", parent.display()))?;
        }
        Ok(())
    }
}

#[cfg(unix)]
pub fn set_mode(path: &Path, mode: u32) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .with_context(|| format!("chmod {:o} {}", mode, path.display()))
}

#[cfg(not(unix))]
pub fn set_mode(_path: &Path, _mode: u32) -> anyhow::Result<()> {
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
