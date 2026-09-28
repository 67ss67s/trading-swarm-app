//! 主账户凭证的读取。**凭证只进 execd**(AGENTS.md 硬规则 1)。
//!
//! 两个来源,只有这两个:
//! 1. env `TG_MAIN_API_KEY` / `TG_MAIN_API_SECRET`;
//! 2. `~/.trade-gate/secrets/apikey-main.json`,**文件权限必须不对 group/other 开放**
//!    (即 `chmod 600`),否则拒读。
//!
//! **绝不接受命令行参数传密钥** —— argv 在 `ps` 里对同机器的任何用户可见,
//! 还会进 shell history。

use std::path::{Path, PathBuf};

/// 一个不会被 `Debug`/`Display` 打出来的字符串。
///
/// 没引第三方 `secrecy`:本 crate 只需要"Debug 脱敏 + 显式 expose"这两件事,
/// 为它加一条 workspace 依赖不划算。
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// 显式取出明文。**调用点即审计点** —— 只应出现在签名与 HTTP 头构造处。
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(if self.0.is_empty() { "SecretString(<empty>)" } else { "SecretString(***)" })
    }
}

impl std::fmt::Display for SecretString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("***")
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

/// 主账户 API 凭证。
#[derive(Clone)]
pub struct MainCredentials {
    pub api_key: String,
    pub api_secret: SecretString,
    /// 来源标签:`env` 或 `file:<path>`。进探针报告,不进日志。
    pub source: String,
}

impl std::fmt::Debug for MainCredentials {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MainCredentials")
            .field("api_key", &mask(&self.api_key))
            .field("api_secret", &self.api_secret)
            .field("source", &self.source)
            .finish()
    }
}

/// `abcd...wxyz`;≤8 字符全打星,免得短串反而暴露。
pub fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        String::new()
    } else if chars.len() <= 8 {
        "*".repeat(chars.len())
    } else {
        let head: String = chars[..4].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{head}...{tail}")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("没有主账户凭证:请设置 TG_MAIN_API_KEY/TG_MAIN_API_SECRET,或写入 {0}(chmod 600)")]
    Missing(PathBuf),
    #[error("凭证文件 {path} 权限过宽({mode:04o}):对 group/other 可读。请 chmod 600 后重试")]
    Permissions { path: PathBuf, mode: u32 },
    #[error("凭证文件 {path} 读取失败:{source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("凭证文件 {path} 不是合法 JSON 或缺少 api_key/api_secret:{reason}")]
    Malformed { path: PathBuf, reason: String },
}

/// 运行时数据目录 `~/.trade-gate`(可用 `TG_HOME` 覆盖,测试用)。
pub fn trade_gate_home() -> PathBuf {
    if let Ok(value) = std::env::var("TG_HOME")
        && !value.trim().is_empty()
    {
        return PathBuf::from(value);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_owned());
    PathBuf::from(home).join(".trade-gate")
}

pub fn default_secrets_path() -> PathBuf {
    trade_gate_home().join("secrets").join("apikey-main.json")
}

/// env 优先,其次凭证文件。
pub fn load_main_credentials(path: Option<&Path>) -> Result<MainCredentials, CredentialError> {
    let key = std::env::var("TG_MAIN_API_KEY").ok().filter(|v| !v.trim().is_empty());
    let secret = std::env::var("TG_MAIN_API_SECRET").ok().filter(|v| !v.trim().is_empty());
    if let (Some(api_key), Some(api_secret)) = (key, secret) {
        return Ok(MainCredentials {
            api_key: api_key.trim().to_owned(),
            api_secret: SecretString::new(api_secret.trim()),
            source: "env".to_owned(),
        });
    }
    let path = path.map(Path::to_path_buf).unwrap_or_else(default_secrets_path);
    load_from_file(&path)
}

pub fn load_from_file(path: &Path) -> Result<MainCredentials, CredentialError> {
    if !path.exists() {
        return Err(CredentialError::Missing(path.to_path_buf()));
    }
    let metadata = std::fs::metadata(path)
        .map_err(|source| CredentialError::Io { path: path.to_path_buf(), source })?;
    let mode = file_mode(&metadata);
    // 0600 的实质要求是"group/other 一位都不许有";0400 同样满足。
    if mode & 0o077 != 0 {
        return Err(CredentialError::Permissions { path: path.to_path_buf(), mode: mode & 0o777 });
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|source| CredentialError::Io { path: path.to_path_buf(), source })?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| CredentialError::Malformed { path: path.to_path_buf(), reason: error.to_string() })?;
    let field = |name: &str| {
        parsed.get(name).and_then(serde_json::Value::as_str).map(str::trim).filter(|v| !v.is_empty())
    };
    let (Some(api_key), Some(api_secret)) = (field("api_key"), field("api_secret")) else {
        return Err(CredentialError::Malformed {
            path: path.to_path_buf(),
            reason: "需要非空的 api_key 与 api_secret 两个字符串字段".to_owned(),
        });
    };
    Ok(MainCredentials {
        api_key: api_key.to_owned(),
        api_secret: SecretString::new(api_secret),
        source: format!("file:{}", path.display()),
    })
}

#[cfg(unix)]
fn file_mode(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode()
}

#[cfg(not(unix))]
fn file_mode(_metadata: &std::fs::Metadata) -> u32 {
    // 非 unix 上没有 mode 概念,按"已满足"处理(execd 目标平台是 macOS/Linux)。
    0o600
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_secret_file(dir: &Path, mode: u32, body: &str) -> PathBuf {
        let path = dir.join("apikey-main.json");
        let mut file = std::fs::File::create(&path).expect("create");
        file.write_all(body.as_bytes()).expect("write");
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).expect("chmod");
        }
        let _ = mode;
        path
    }

    #[test]
    fn secret_never_prints_itself() {
        let secret = SecretString::new("NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP");
        assert_eq!(format!("{secret:?}"), "SecretString(***)");
        assert_eq!(format!("{secret}"), "***");
        assert!(!format!("{secret:?}").contains("Nhq"));
        assert_eq!(secret.expose(), "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP");

        let credentials = MainCredentials {
            api_key: "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A".into(),
            api_secret: secret,
            source: "env".into(),
        };
        let printed = format!("{credentials:?}");
        assert!(printed.contains("vmPU...Eh8A"), "{printed}");
        assert!(!printed.contains("NhqPtmd"), "secret 泄漏到 Debug:{printed}");
    }

    #[test]
    fn mask_keeps_short_values_fully_hidden() {
        assert_eq!(mask(""), "");
        assert_eq!(mask("abcd"), "****");
        assert_eq!(mask("abcdefgh"), "********");
        assert_eq!(mask("abcdefghi"), "abcd...fghi");
    }

    #[cfg(unix)]
    #[test]
    fn world_readable_secret_file_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_secret_file(dir.path(), 0o644, r#"{"api_key":"k","api_secret":"s"}"#);
        match load_from_file(&path) {
            Err(CredentialError::Permissions { mode, .. }) => assert_eq!(mode, 0o644),
            other => panic!("0644 必须被拒,实得 {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn well_formed_0600_file_loads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_secret_file(dir.path(), 0o600, r#"{"api_key":" k ","api_secret":"s"}"#);
        let credentials = load_from_file(&path).expect("load");
        assert_eq!(credentials.api_key, "k", "两端空白必须去掉:签名会因此全挂");
        assert_eq!(credentials.api_secret.expose(), "s");
        assert!(credentials.source.starts_with("file:"));
        // 0400 同样满足"group/other 一位都没有"
        let path = write_secret_file(dir.path(), 0o400, r#"{"api_key":"k","api_secret":"s"}"#);
        assert!(load_from_file(&path).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn malformed_and_missing_files_report_precisely() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_secret_file(dir.path(), 0o600, r#"{"api_key":"k"}"#);
        assert!(matches!(load_from_file(&path), Err(CredentialError::Malformed { .. })));
        let path = write_secret_file(dir.path(), 0o600, "not json");
        assert!(matches!(load_from_file(&path), Err(CredentialError::Malformed { .. })));
        assert!(matches!(
            load_from_file(&dir.path().join("nope.json")),
            Err(CredentialError::Missing(_))
        ));
    }
}
