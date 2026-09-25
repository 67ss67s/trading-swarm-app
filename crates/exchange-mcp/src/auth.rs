//! 凭证管理:token 的持有、状态判断、**durable 单飞 refresh 状态机**。
//!
//! 设计 §12 的要求:
//! - 同一时刻只有一个 refresh 在飞(tokio `Mutex`);后到的等锁,醒来发现 token 已被换过就直接用新的,
//!   **不再发第二个网络请求**。
//! - 成功后**原子替换** token 文件(临时文件 + rename,0600)。
//! - 失败要分清:`invalid_grant` = 已撤销 → `Revoked`(HALT 写路径 + 带外告警 + 引导重新授权);
//!   网络错误 = 可重试,状态不变。
//! - `invalid_client` = 我们的 CIMD 注册有问题,不是用户撤销,单独一类。

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Mutex;

use crate::error::{Error, Result};
use crate::oauth::{TokenEndpoint, TokenResponse};
use crate::secret::Secret;
use crate::token_store::{StoredToken, TokenState, TokenStatus, TokenStore};

/// 一次授权所需的全部端点/标识。
#[derive(Debug, Clone)]
pub struct OAuthConfig {
    pub client_id: String,
    pub resource: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub authorization_server: Option<String>,
    pub redirect_port: u16,
    pub redirect_path: String,
    /// 默认 None(官方没公布 scope 字符串)。
    pub scopes: Option<String>,
}

impl OAuthConfig {
    /// Binance 的已知端点(2026-09-02 从 AS 元数据实测)。真实运行时仍应走 discovery 覆盖。
    pub fn binance_defaults(client_id: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            resource: crate::BINANCE_MCP_ENDPOINT.to_string(),
            authorization_endpoint: crate::BINANCE_AUTHORIZE_ENDPOINT.to_string(),
            token_endpoint: crate::BINANCE_TOKEN_ENDPOINT.to_string(),
            authorization_server: Some(crate::BINANCE_ISSUER.to_string()),
            redirect_port: crate::DEFAULT_CALLBACK_PORT,
            redirect_path: crate::DEFAULT_CALLBACK_PATH.to_string(),
            scopes: None,
        }
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.redirect_port, self.redirect_path)
    }
}

pub struct AuthManager {
    endpoint: TokenEndpoint,
    store: TokenStore,
    config: OAuthConfig,
    /// 单飞闸门。
    refresh_lock: Mutex<()>,
    external_access: Option<Secret>,
    /// 每次成功保存 +1,只用于日志与测试观察。
    generation: AtomicU64,
}

impl std::fmt::Debug for AuthManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthManager")
            .field("token_path", &self.store.path())
            .field("client_id", &self.config.client_id)
            .field("resource", &self.config.resource)
            .field("generation", &self.generation.load(Ordering::Relaxed))
            .finish()
    }
}

impl AuthManager {
    pub fn new(http: reqwest::Client, store: TokenStore, config: OAuthConfig) -> Self {
        let endpoint = TokenEndpoint::new(
            http,
            config.token_endpoint.clone(),
            config.client_id.clone(),
            config.resource.clone(),
        );
        Self {
            endpoint,
            store,
            config,
            refresh_lock: Mutex::new(()),
            external_access: None,
            generation: AtomicU64::new(0),
        }
    }

    /// Borrow a token from a local credential owner without impersonating its client_id,
    /// refreshing its token, or persisting a second copy. Only the fixed resource is contacted.
    pub fn with_external_access(mut self, token: Secret) -> Self {
        self.external_access = Some(token);
        self
    }

    pub fn config(&self) -> &OAuthConfig {
        &self.config
    }

    pub fn store(&self) -> &TokenStore {
        &self.store
    }

    pub fn token_endpoint(&self) -> &TokenEndpoint {
        &self.endpoint
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub fn status(&self) -> Result<TokenStatus> {
        self.store.status(now_ms())
    }

    pub fn load(&self) -> Result<Option<StoredToken>> {
        self.store.load()
    }

    /// 拿一个可用的 access token:
    /// - Missing/Revoked → 报错(上层 HALT 写路径 + 引导重新授权)
    /// - Expired → 必须先刷;没有 refresh_token 就报错
    /// - Expiring → 尽力刷一次,刷不动就先用旧的(还没真过期)
    pub async fn access_token(&self) -> Result<Secret> {
        if let Some(token) = &self.external_access { return Ok(token.clone()); }
        let token = self
            .store
            .load()?
            .ok_or_else(|| Error::TokenUnavailable("还没做过 OAuth 授权".to_string()))?;
        match token.state_at(now_ms()) {
            TokenState::Fresh => Ok(token.access_token),
            TokenState::Expiring => {
                if !token.has_refresh() {
                    return Ok(token.access_token);
                }
                match self.refresh_for(Some(token.access_token.expose())).await {
                    Ok(fresh) => Ok(fresh.access_token),
                    // 还没真过期,刷不动先用旧的;真 401 了 call_read 会再触发一次。
                    Err(Error::Revoked) => Err(Error::Revoked),
                    Err(e) => {
                        tracing::warn!(error = %e, "临期刷新失败,继续使用尚未过期的 token");
                        Ok(token.access_token)
                    }
                }
            }
            TokenState::Expired => {
                if !token.has_refresh() {
                    return Err(Error::TokenUnavailable(
                        "access token 已过期且没有 refresh_token,必须重新走浏览器授权".to_string(),
                    ));
                }
                Ok(self.refresh_for(Some(token.access_token.expose())).await?.access_token)
            }
            TokenState::Revoked => Err(Error::Revoked),
            TokenState::Missing => Err(Error::TokenUnavailable("token 文件里没有 access_token".to_string())),
        }
    }

    /// 单飞刷新。`observed` = 调用方手上那个(已失效的)access token。
    ///
    /// 拿到锁后重读磁盘:如果盘上的 token 已经不是 `observed`,说明别人刚刷过,直接返回,
    /// **不发网络请求**。10 个并发 401 只会打出 1 个 refresh。
    pub async fn refresh_for(&self, observed: Option<&str>) -> Result<StoredToken> {
        if self.external_access.is_some() { return Err(Error::TokenUnavailable("本机币安授权已失效，请在原客户端重新登录".into())); }
        let _guard = self.refresh_lock.lock().await;

        let current = self
            .store
            .load()?
            .ok_or_else(|| Error::TokenUnavailable("token 文件不存在,无法刷新".to_string()))?;

        if current.revoked_at_ms.is_some() {
            return Err(Error::Revoked);
        }
        if let Some(observed) = observed
            && current.access_token.expose() != observed
        {
            tracing::debug!(
                fp = %current.access_token.fingerprint(),
                "已有其他任务刷过 token,单飞直接复用"
            );
            return Ok(current);
        }

        self.do_refresh(current).await
    }

    /// 无条件刷一次(CLI `refresh` 子命令)。仍然走单飞锁。
    pub async fn force_refresh(&self) -> Result<StoredToken> {
        let _guard = self.refresh_lock.lock().await;
        let current = self
            .store
            .load()?
            .ok_or_else(|| Error::TokenUnavailable("token 文件不存在,无法刷新".to_string()))?;
        if current.revoked_at_ms.is_some() {
            return Err(Error::Revoked);
        }
        self.do_refresh(current).await
    }

    async fn do_refresh(&self, current: StoredToken) -> Result<StoredToken> {
        let refresh_token = current.refresh_token.clone().ok_or_else(|| {
            Error::TokenUnavailable(
                "没有 refresh_token(Binance AS 未声明 refresh_token grant),只能重新走浏览器授权".to_string(),
            )
        })?;

        match self.endpoint.refresh(&refresh_token).await {
            Ok(resp) => {
                // 有的 AS 刷新时不回 refresh_token,表示旧的继续用。
                let next = self.materialize(resp, Some(&current));
                self.store.save(&next)?;
                self.generation.fetch_add(1, Ordering::Relaxed);
                tracing::info!(
                    fp = %next.access_token.fingerprint(),
                    has_refresh = next.has_refresh(),
                    "refresh 成功,token 已原子替换"
                );
                Ok(next)
            }
            Err(Error::Revoked) => {
                self.persist_revoked(&current, "refresh 返回 invalid_grant(授权已被撤销或过期)")?;
                Err(Error::Revoked)
            }
            Err(e @ Error::InvalidClient(_)) => {
                // 不是用户撤销,是我们的 CIMD 注册出问题;不要污染 token 状态。
                tracing::error!(error = %e, "refresh 被拒:client_id 不被接受");
                Err(e)
            }
            Err(e) => {
                tracing::warn!(error = %e, kind = e.kind(), "refresh 失败(可重试),token 状态不变");
                Err(e)
            }
        }
    }

    /// 授权码换 token 并落盘。
    pub async fn complete_authorization_code(
        &self,
        code: &Secret,
        redirect_uri: &str,
        verifier: &Secret,
    ) -> Result<StoredToken> {
        let resp = self.endpoint.exchange_code(code, redirect_uri, verifier).await?;
        let token = self.materialize(resp, None);
        self.store.save(&token)?;
        self.generation.fetch_add(1, Ordering::Relaxed);
        Ok(token)
    }

    /// 把服务端撤销的事实写进 token 文件(清空两个 token,状态置 Revoked)。
    pub fn persist_revoked(&self, current: &StoredToken, reason: &str) -> Result<()> {
        let mut revoked = current.clone();
        revoked.access_token = Secret::new(String::new());
        revoked.refresh_token = None;
        revoked.revoked_at_ms = Some(now_ms());
        revoked.revoked_reason = Some(reason.to_string());
        self.store.save(&revoked)?;
        self.generation.fetch_add(1, Ordering::Relaxed);
        tracing::error!(reason, "OAuth 授权已失效:写路径必须 HALT,需要用户重新授权");
        Ok(())
    }

    fn materialize(&self, resp: TokenResponse, previous: Option<&StoredToken>) -> StoredToken {
        let obtained_at_ms = now_ms();
        let expires_at_ms = resp
            .expires_in
            .map(|secs| obtained_at_ms + (secs as i64) * 1000);
        StoredToken {
            access_token: resp.access_token,
            refresh_token: resp
                .refresh_token
                .or_else(|| previous.and_then(|p| p.refresh_token.clone())),
            token_type: resp.token_type,
            scope: resp.scope.or_else(|| previous.and_then(|p| p.scope.clone())),
            expires_in_secs: resp.expires_in,
            expires_at_ms,
            obtained_at_ms,
            client_id: self.config.client_id.clone(),
            resource: self.config.resource.clone(),
            token_endpoint: self.config.token_endpoint.clone(),
            authorization_server: self.config.authorization_server.clone(),
            revoked_at_ms: None,
            revoked_reason: None,
            response_extras: resp.extras,
        }
    }
}

/// 共享句柄:MCP client 与 CLI 共用同一个单飞状态机。
pub type SharedAuth = Arc<AuthManager>;

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
