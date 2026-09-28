//! token 文件仓:`~/.trade-gate/secrets/oauth-binance.json`(目录 0700、文件 0600)。
//!
//! 写入是**原子替换**:同目录写临时文件 → fsync → rename。崩溃在 rename 之前,
//! 旧 token 完好;崩溃在 rename 之后,新 token 完整。绝不原地截断重写。
//!
//! 路径可注入(`TokenStore::new`),测试用 tempdir。

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::secret::Secret;

/// 距过期不足这个时长即视为 `Expiring`(该提前刷了)。
pub const EXPIRING_WINDOW_MS: i64 = 10 * 60 * 1000;

/// 落盘的 token 记录。敏感字段用 `Secret`(Debug 不外泄),但 `Serialize` 是明文——
/// 文件本身 0600 且只有 execd 读。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredToken {
    pub access_token: Secret,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<Secret>,
    pub token_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// token 响应里的 `expires_in`(秒),原样留存以便写报告。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_in_secs: Option<u64>,
    /// 由 `obtained_at_ms + expires_in` 算出;AS 不给 expires_in 时为 None(= 不知道何时过期)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    pub obtained_at_ms: i64,
    pub client_id: String,
    pub resource: String,
    pub token_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_server: Option<String>,
    /// 被撤销(refresh 收到 invalid_grant / 用户在 Binance UI Disconnect)的时刻。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_reason: Option<String>,
    /// token 响应里除敏感字段外的其余键(便于 A1 报告里如实记录服务端形状)。
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub response_extras: serde_json::Map<String, serde_json::Value>,
}

impl StoredToken {
    pub fn scopes(&self) -> Vec<String> {
        self.scope
            .as_deref()
            .map(|s| s.split_whitespace().map(|x| x.to_string()).collect())
            .unwrap_or_default()
    }

    pub fn has_refresh(&self) -> bool {
        self.refresh_token.as_ref().is_some_and(|t| !t.is_empty())
    }

    pub fn state_at(&self, now_ms: i64) -> TokenState {
        if self.revoked_at_ms.is_some() {
            return TokenState::Revoked;
        }
        if self.access_token.is_empty() {
            return TokenState::Missing;
        }
        match self.expires_at_ms {
            // 没有 expires_in:无法判断过期,只能当 Fresh 用,401 时再触发刷新。
            None => TokenState::Fresh,
            Some(exp) if now_ms >= exp => TokenState::Expired,
            Some(exp) if exp - now_ms <= EXPIRING_WINDOW_MS => TokenState::Expiring,
            Some(_) => TokenState::Fresh,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenState {
    Fresh,
    /// 距过期 < 10 分钟。
    Expiring,
    Expired,
    /// 服务端已撤销(invalid_grant / 用户 Disconnect)。人不重新授权就恢复不了。
    Revoked,
    /// 本地压根没有 token 文件。
    Missing,
}

impl TokenState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TokenState::Fresh => "fresh",
            TokenState::Expiring => "expiring",
            TokenState::Expired => "expired",
            TokenState::Revoked => "revoked",
            TokenState::Missing => "missing",
        }
    }

    /// 可以直接拿来发请求吗(Expiring 可以,但应触发后台刷新)。
    pub fn usable(&self) -> bool {
        matches!(self, TokenState::Fresh | TokenState::Expiring)
    }
}

/// 对外暴露的状态摘要——**不含任何 token 内容**。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenStatus {
    pub state: TokenState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_ms: Option<i64>,
    pub has_refresh: bool,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub obtained_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_reason: Option<String>,
    /// token 指纹(sha256 前 4 字节),用来在日志里判断「是不是同一个 token」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token_fingerprint: Option<String>,
}

impl TokenStatus {
    pub fn missing() -> Self {
        Self {
            state: TokenState::Missing,
            valid_until_ms: None,
            expires_in_ms: None,
            has_refresh: false,
            scopes: Vec::new(),
            token_type: None,
            obtained_at_ms: None,
            client_id: None,
            resource: None,
            revoked_reason: None,
            access_token_fingerprint: None,
        }
    }

    pub fn from_token(token: &StoredToken, now_ms: i64) -> Self {
        Self {
            state: token.state_at(now_ms),
            valid_until_ms: token.expires_at_ms,
            expires_in_ms: token.expires_at_ms.map(|e| e - now_ms),
            has_refresh: token.has_refresh(),
            scopes: token.scopes(),
            token_type: Some(token.token_type.clone()),
            obtained_at_ms: Some(token.obtained_at_ms),
            client_id: Some(token.client_id.clone()),
            resource: Some(token.resource.clone()),
            revoked_reason: token.revoked_reason.clone(),
            access_token_fingerprint: if token.access_token.is_empty() {
                None
            } else {
                Some(token.access_token.fingerprint())
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct TokenStore {
    path: PathBuf,
}

impl TokenStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// `~/.trade-gate/secrets/oauth-binance.json`;`TRADE_GATE_HOME` 可覆盖根目录。
    pub fn default_path() -> Result<PathBuf> {
        Ok(crate::data_home()?.join("secrets").join("oauth-binance.json"))
    }

    pub fn default_store() -> Result<Self> {
        Ok(Self::new(Self::default_path()?))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    pub fn load(&self) -> Result<Option<StoredToken>> {
        match fs::read_to_string(&self.path) {
            Ok(text) => {
                let token: StoredToken = serde_json::from_str(&text)
                    .map_err(|e| Error::Io(format!("token 文件解析失败({}):{e}", self.path.display())))?;
                Ok(Some(token))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Io(format!("读 token 文件失败({}):{e}", self.path.display()))),
        }
    }

    /// 原子替换:临时文件(0600)→ fsync → rename。
    pub fn save(&self, token: &StoredToken) -> Result<()> {
        let dir = self
            .path
            .parent()
            .ok_or_else(|| Error::Io(format!("token 路径没有父目录:{}", self.path.display())))?;
        fs::create_dir_all(dir)?;
        // 目录 0700(只有 execd 这个用户能进)。
        let mut dir_perm = fs::metadata(dir)?.permissions();
        if dir_perm.mode() & 0o777 != 0o700 {
            dir_perm.set_mode(0o700);
            fs::set_permissions(dir, dir_perm)?;
        }

        let json = serde_json::to_string_pretty(token)
            .map_err(|e| Error::Io(format!("token 序列化失败:{e}")))?;

        let tmp_path = dir.join(format!(
            "{}.tmp.{}.{}",
            self.path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "token.json".to_string()),
            std::process::id(),
            crate::oauth::random_token(6)
        ));
        {
            let mut f = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&tmp_path)?;
            f.write_all(json.as_bytes())?;
            f.flush()?;
            f.sync_all()?;
        }
        fs::rename(&tmp_path, &self.path)?;
        // rename 保留临时文件的 0600;显式再设一次,防某些 umask/文件系统怪相。
        let mut perm = fs::metadata(&self.path)?.permissions();
        if perm.mode() & 0o777 != 0o600 {
            perm.set_mode(0o600);
            fs::set_permissions(&self.path, perm)?;
        }
        // 目录项也 fsync 一下,保证 rename 落盘。
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    }

    /// 删除本地 token(`revoke` 子命令)。返回是否真的删掉了文件。
    pub fn delete(&self) -> Result<bool> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Error::Io(format!("删 token 文件失败:{e}"))),
        }
    }

    pub fn status(&self, now_ms: i64) -> Result<TokenStatus> {
        Ok(match self.load()? {
            Some(token) => TokenStatus::from_token(&token, now_ms),
            None => TokenStatus::missing(),
        })
    }

    /// 文件权限位(测试断言 0600 用)。
    pub fn mode(&self) -> Result<u32> {
        Ok(fs::metadata(&self.path)?.permissions().mode() & 0o777)
    }
}
