//! 单实例锁:`run/execd.lock` 上的 `flock(LOCK_EX|LOCK_NB)`。同一数据目录第二个 execd 必须启动失败
//! (设计 §8.4:同一账户只有一个写者;主机级排他先用文件锁,账户级 fencing epoch 在 writer_lease 表)。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("另一个 execd 已持有 {path}(pid {holder:?});同一数据目录只允许一个实例")]
    Held { path: PathBuf, holder: Option<String> },
    #[error("锁文件 {path} 操作失败:{source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// 持有期间文件保持打开;drop 即释放(进程死亡也释放,这是 flock 的好处)。
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
    path: PathBuf,
}

impl InstanceLock {
    pub fn acquire(path: &Path, instance_id: &str) -> Result<Self, LockError> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|source| LockError::Io { path: path.to_path_buf(), source })?;
        // SAFETY: 合法的已打开 fd;flock 不接管所有权。
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            let holder = std::fs::read_to_string(path).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
            return Err(LockError::Held { path: path.to_path_buf(), holder });
        }
        file.set_len(0).map_err(|source| LockError::Io { path: path.to_path_buf(), source })?;
        writeln!(file, "{} {}", std::process::id(), instance_id)
            .and_then(|_| file.flush())
            .map_err(|source| LockError::Io { path: path.to_path_buf(), source })?;
        crate::paths::set_mode(path, 0o600).ok();
        Ok(Self { _file: file, path: path.to_path_buf() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_fails_until_first_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("execd.lock");
        let first = InstanceLock::acquire(&path, "a").unwrap();
        let err = InstanceLock::acquire(&path, "b").unwrap_err();
        assert!(matches!(err, LockError::Held { .. }), "{err}");
        assert!(err.to_string().contains(" a"), "锁文件里要写持有者:{err}");
        drop(first);
        InstanceLock::acquire(&path, "c").unwrap();
    }
}
