//! 敏感字符串包装:token / authorization code / PKCE verifier 一律用它装。
//!
//! 硬规则:`Debug` 与 `Display` **永远**不输出明文(测试 `tests/redaction.rs` 会断言)。
//! 只有 `expose()` 能拿到明文,调用点必须是「拼 HTTP 头 / 写 0600 文件」这类地方。
//! `Serialize` 是透明的——token 文件需要落明文,但那个文件是 0600 且只有 execd 读。

use std::fmt;

use serde::{Deserialize, Serialize};

/// 打日志/报错时统一用这个占位符,便于 grep。
pub const REDACTED: &str = "<redacted>";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// 拿明文。**只在真正需要发出去或落盘的地方调用。**
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// 给日志用的稳定指纹(sha256 前 8 hex),用来判断「是不是同一个 token」而不泄露内容。
    pub fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(self.0.as_bytes());
        hex::encode(&digest[..4])
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Secret({REDACTED}, len={}, fp={})", self.0.len(), self.fingerprint())
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}
