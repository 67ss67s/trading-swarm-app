//! OAuth / token 仓 / 单飞 refresh 的确定性测试(假 AS,回环,不碰真实网络)。

mod common;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use common::{FakeAs, FakeAsState, TokenReply, loopback_client, oauth_config, stored_token};
use exchange_mcp::auth::{AuthManager, now_ms};
use exchange_mcp::error::Error;
use exchange_mcp::oauth::{self, AuthorizeRequest, CallbackServer, ClientProbe, TokenEndpoint};
use exchange_mcp::secret::Secret;
use exchange_mcp::token_store::{TokenState, TokenStore};
use sha2::{Digest, Sha256};

fn store_in(dir: &std::path::Path) -> TokenStore {
    TokenStore::new(dir.join("secrets").join("oauth-binance.json"))
}

// ---------------------------------------------------------------------------
// PKCE / authorize URL
// ---------------------------------------------------------------------------

#[test]
fn pkce_verifier_in_range_and_challenge_is_s256() {
    let pkce = oauth::generate_pkce();
    let verifier = pkce.verifier.expose();
    assert!(
        (43..=128).contains(&verifier.len()),
        "verifier 长度 {} 不在 RFC 7636 的 43..=128",
        verifier.len()
    );
    assert!(verifier.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
    let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    assert_eq!(pkce.challenge, expected);
    // 两次生成必须不同。
    assert_ne!(oauth::generate_pkce().verifier.expose(), verifier);
}

#[test]
fn state_is_random() {
    assert_ne!(oauth::generate_state(), oauth::generate_state());
}

#[test]
fn authorize_url_carries_pkce_resource_and_omits_scope_by_default() {
    let url = oauth::build_authorize_url(&AuthorizeRequest {
        authorization_endpoint: "https://accounts.binance.com/agentic-oauth/authorize".into(),
        client_id: "https://bridge.example/cimd.json".into(),
        redirect_uri: "http://127.0.0.1:18801/oauth/callback".into(),
        resource: "https://agent.binance.com/mcp/agentic".into(),
        scopes: None,
        state: "st".into(),
        code_challenge: "chal".into(),
    })
    .unwrap();
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["client_id"], "https://bridge.example/cimd.json");
    assert_eq!(q["redirect_uri"], "http://127.0.0.1:18801/oauth/callback");
    assert_eq!(q["code_challenge"], "chal");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["state"], "st");
    // RFC 8707 resource indicator:MCP 规范要求。
    assert_eq!(q["resource"], "https://agent.binance.com/mcp/agentic");
    assert!(!q.contains_key("scope"), "官方没公布 scope 字符串,默认不能传");

    let with_scope = oauth::build_authorize_url(&AuthorizeRequest {
        scopes: Some("market account".into()),
        ..AuthorizeRequest {
            authorization_endpoint: "https://x/authorize".into(),
            client_id: "c".into(),
            redirect_uri: "http://127.0.0.1:1/cb".into(),
            resource: "https://r".into(),
            scopes: None,
            state: "s".into(),
            code_challenge: "c".into(),
        }
    })
    .unwrap();
    let q2: std::collections::HashMap<_, _> = with_scope.query_pairs().into_owned().collect();
    assert_eq!(q2["scope"], "market account");
}

// ---------------------------------------------------------------------------
// 授权码交换
// ---------------------------------------------------------------------------

#[tokio::test]
async fn exchange_code_success_writes_0600_token_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    let fake = FakeAs::start(FakeAsState {
        scripted: [TokenReply::Success {
            access: "access-1".into(),
            refresh: Some("refresh-1".into()),
            expires_in: Some(3600),
            scope: Some("market account".into()),
        }]
        .into(),
        ..Default::default()
    })
    .await;

    let auth = AuthManager::new(
        loopback_client(),
        store,
        oauth_config(&fake.token_endpoint(), "https://agent.binance.com/mcp/agentic"),
    );
    let token = auth
        .complete_authorization_code(
            &Secret::new("the-code"),
            "http://127.0.0.1:18801/oauth/callback",
            &Secret::new("the-verifier"),
        )
        .await
        .unwrap();

    assert_eq!(token.access_token.expose(), "access-1");
    assert!(token.has_refresh());
    assert_eq!(token.scopes(), vec!["market", "account"]);
    assert!(token.expires_at_ms.unwrap() > now_ms());

    // 文件与目录权限。
    assert_eq!(auth.store().mode().unwrap(), 0o600, "token 文件必须 0600");
    let dir_mode = std::fs::metadata(dir.path().join("secrets"))
        .unwrap()
        .permissions();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(dir_mode.mode() & 0o777, 0o700, "secrets 目录必须 0700");

    // 发出去的表单必须齐全(PKCE + resource + client_id)。
    let form = fake.last_token_request().unwrap();
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["code"], "the-code");
    assert_eq!(form["code_verifier"], "the-verifier");
    assert_eq!(form["redirect_uri"], "http://127.0.0.1:18801/oauth/callback");
    assert_eq!(form["resource"], "https://agent.binance.com/mcp/agentic");
    assert_eq!(form["client_id"], "https://example.test/cimd.json");

    // 状态。
    let status = auth.status().unwrap();
    assert_eq!(status.state, TokenState::Fresh);
    assert!(status.has_refresh);
}

#[tokio::test]
async fn exchange_code_invalid_grant_is_oauth_error_not_revoked() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeAs::start(FakeAsState {
        scripted: [TokenReply::Error {
            status: 400,
            error: "invalid_grant".into(),
            description: Some("code expired".into()),
        }]
        .into(),
        ..Default::default()
    })
    .await;
    let auth = AuthManager::new(
        loopback_client(),
        store_in(dir.path()),
        oauth_config(&fake.token_endpoint(), "res"),
    );
    let err = auth
        .complete_authorization_code(&Secret::new("c"), "http://127.0.0.1:1/cb", &Secret::new("v"))
        .await
        .unwrap_err();
    // 换码失败 ≠ 已撤销:不应污染 token 状态。
    assert!(matches!(err, Error::OAuth { ref error, .. } if error == "invalid_grant"), "{err:?}");
    assert_eq!(auth.status().unwrap().state, TokenState::Missing);
}

#[tokio::test]
async fn invalid_client_is_its_own_category() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeAs::start(FakeAsState {
        scripted: [TokenReply::Error {
            status: 401,
            error: "invalid_client".into(),
            description: None,
        }]
        .into(),
        ..Default::default()
    })
    .await;
    let auth = AuthManager::new(
        loopback_client(),
        store_in(dir.path()),
        oauth_config(&fake.token_endpoint(), "res"),
    );
    let err = auth
        .complete_authorization_code(&Secret::new("c"), "http://127.0.0.1:1/cb", &Secret::new("v"))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidClient(_)), "{err:?}");
    assert_eq!(err.kind(), "invalid_client");
}

#[tokio::test]
async fn probe_client_distinguishes_cimd_rejection_from_bad_code() {
    let fake = FakeAs::start(FakeAsState {
        scripted: [
            TokenReply::Error {
                status: 401,
                error: "invalid_client".into(),
                description: Some("client metadata unreachable".into()),
            },
            TokenReply::Error {
                status: 400,
                error: "invalid_grant".into(),
                description: Some("bad code".into()),
            },
        ]
        .into(),
        ..Default::default()
    })
    .await;
    let endpoint = TokenEndpoint::new(
        loopback_client(),
        fake.token_endpoint(),
        "https://example.test/cimd.json",
        "res",
    );

    // CIMD 文档还没上线 → invalid_client。
    assert!(matches!(endpoint.probe_client().await, ClientProbe::ClientRejected { .. }));
    // CIMD 生效后 → 它只抱怨 code。
    assert!(matches!(endpoint.probe_client().await, ClientProbe::ClientAccepted { .. }));
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

#[tokio::test]
async fn refresh_success_replaces_token_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    store
        .save(&stored_token("old-access", Some("old-refresh"), Some(now_ms() + 60_000)))
        .unwrap();

    let fake = FakeAs::start(FakeAsState {
        scripted: [TokenReply::Success {
            access: "new-access".into(),
            refresh: Some("new-refresh".into()),
            expires_in: Some(7200),
            scope: None,
        }]
        .into(),
        ..Default::default()
    })
    .await;
    let auth = AuthManager::new(
        loopback_client(),
        store_in(dir.path()),
        oauth_config(&fake.token_endpoint(), "res"),
    );

    let refreshed = auth.force_refresh().await.unwrap();
    assert_eq!(refreshed.access_token.expose(), "new-access");
    assert_eq!(refreshed.refresh_token.as_ref().unwrap().expose(), "new-refresh");
    assert_eq!(auth.store().mode().unwrap(), 0o600);
    assert_eq!(auth.generation(), 1);

    let form = fake.last_token_request().unwrap();
    assert_eq!(form["grant_type"], "refresh_token");
    assert_eq!(form["refresh_token"], "old-refresh");

    // 没有临时文件残留在目录里。
    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("secrets"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
        .collect();
    assert!(leftovers.is_empty(), "rename 之后不该留临时文件");
}

#[tokio::test]
async fn refresh_keeps_old_refresh_token_when_server_omits_it() {
    let dir = tempfile::tempdir().unwrap();
    store_in(dir.path())
        .save(&stored_token("old", Some("keep-me"), Some(now_ms() + 60_000)))
        .unwrap();
    let fake = FakeAs::start(FakeAsState {
        scripted: [TokenReply::Success {
            access: "new".into(),
            refresh: None,
            expires_in: None,
            scope: None,
        }]
        .into(),
        ..Default::default()
    })
    .await;
    let auth = AuthManager::new(
        loopback_client(),
        store_in(dir.path()),
        oauth_config(&fake.token_endpoint(), "res"),
    );
    let t = auth.force_refresh().await.unwrap();
    assert_eq!(t.refresh_token.as_ref().unwrap().expose(), "keep-me");
    // 没有 expires_in 时不能瞎猜有效期。
    assert!(t.expires_at_ms.is_none());
    assert_eq!(t.state_at(now_ms()), TokenState::Fresh);
}

#[tokio::test]
async fn refresh_invalid_grant_transitions_to_revoked_and_persists() {
    let dir = tempfile::tempdir().unwrap();
    store_in(dir.path())
        .save(&stored_token("old", Some("dead-refresh"), Some(now_ms() + 60_000)))
        .unwrap();
    let fake = FakeAs::start(FakeAsState {
        scripted: [TokenReply::Error {
            status: 400,
            error: "invalid_grant".into(),
            description: Some("revoked by user".into()),
        }]
        .into(),
        ..Default::default()
    })
    .await;
    let auth = AuthManager::new(
        loopback_client(),
        store_in(dir.path()),
        oauth_config(&fake.token_endpoint(), "res"),
    );

    let err = auth.force_refresh().await.unwrap_err();
    assert!(matches!(err, Error::Revoked));

    let status = auth.status().unwrap();
    assert_eq!(status.state, TokenState::Revoked);
    assert!(!status.has_refresh, "撤销后不该再留 refresh_token");
    assert!(status.revoked_reason.is_some());

    // 撤销是终态:再刷一次不许再打网络。
    let before = fake.token_request_count();
    assert!(matches!(auth.force_refresh().await.unwrap_err(), Error::Revoked));
    assert_eq!(fake.token_request_count(), before, "Revoked 之后不该再发 refresh");
    // access_token() 也必须直接拒绝(上层据此 HALT 写路径)。
    assert!(matches!(auth.access_token().await.unwrap_err(), Error::Revoked));
}

#[tokio::test]
async fn refresh_network_error_is_retryable_and_leaves_state_untouched() {
    let dir = tempfile::tempdir().unwrap();
    // 1 小时后过期:落在 Fresh 区(Expiring 窗口是 10 分钟),网络错误后必须仍是 Fresh
    store_in(dir.path())
        .save(&stored_token("old", Some("r"), Some(now_ms() + 3_600_000)))
        .unwrap();
    let fake = FakeAs::start(FakeAsState {
        scripted: [TokenReply::Error {
            status: 503,
            error: "temporarily_unavailable".into(),
            description: None,
        }]
        .into(),
        ..Default::default()
    })
    .await;
    let auth = AuthManager::new(
        loopback_client(),
        store_in(dir.path()),
        oauth_config(&fake.token_endpoint(), "res"),
    );
    let err = auth.force_refresh().await.unwrap_err();
    assert!(!matches!(err, Error::Revoked), "5xx 不是撤销:{err:?}");
    assert_eq!(auth.status().unwrap().state, TokenState::Fresh, "状态不该被网络错误改掉");
}

#[tokio::test]
async fn ten_concurrent_refreshes_issue_exactly_one_request() {
    let dir = tempfile::tempdir().unwrap();
    store_in(dir.path())
        .save(&stored_token("old-access", Some("old-refresh"), Some(now_ms() - 1)))
        .unwrap();

    // 只脚本一条成功;第二个请求会拿到 500,测试立刻失败。
    let fake = FakeAs::start(FakeAsState {
        scripted: [TokenReply::SlowSuccess {
            delay_ms: 120,
            access: "new-access".into(),
            refresh: Some("new-refresh".into()),
        }]
        .into(),
        ..Default::default()
    })
    .await;
    let auth = Arc::new(AuthManager::new(
        loopback_client(),
        store_in(dir.path()),
        oauth_config(&fake.token_endpoint(), "res"),
    ));

    let mut handles = Vec::new();
    for _ in 0..10 {
        let auth = auth.clone();
        handles.push(tokio::spawn(async move {
            auth.refresh_for(Some("old-access")).await
        }));
    }
    for h in handles {
        let token = h.await.unwrap().expect("单飞下所有等待者都应拿到新 token");
        assert_eq!(token.access_token.expose(), "new-access");
    }
    assert_eq!(fake.token_request_count(), 1, "单飞:10 个并发只能打 1 个 refresh");
    assert_eq!(auth.generation(), 1);
}

#[tokio::test]
async fn expired_token_without_refresh_token_refuses_instead_of_guessing() {
    let dir = tempfile::tempdir().unwrap();
    store_in(dir.path())
        .save(&stored_token("expired", None, Some(now_ms() - 1000)))
        .unwrap();
    let fake = FakeAs::start(FakeAsState::default()).await;
    let auth = AuthManager::new(
        loopback_client(),
        store_in(dir.path()),
        oauth_config(&fake.token_endpoint(), "res"),
    );
    assert_eq!(auth.status().unwrap().state, TokenState::Expired);
    let err = auth.access_token().await.unwrap_err();
    assert!(matches!(err, Error::TokenUnavailable(_)), "{err:?}");
    assert_eq!(fake.token_request_count(), 0);
}

#[tokio::test]
async fn expiring_window_is_ten_minutes() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    store
        .save(&stored_token("a", None, Some(now_ms() + 9 * 60_000)))
        .unwrap();
    assert_eq!(store.status(now_ms()).unwrap().state, TokenState::Expiring);
    store
        .save(&stored_token("a", None, Some(now_ms() + 11 * 60_000)))
        .unwrap();
    assert_eq!(store.status(now_ms()).unwrap().state, TokenState::Fresh);
}

// ---------------------------------------------------------------------------
// 原子替换 / 崩溃模拟
// ---------------------------------------------------------------------------

#[test]
fn crash_before_rename_leaves_old_token_readable() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    store.save(&stored_token("old-access", Some("old-r"), None)).unwrap();

    // 模拟「写完临时文件但还没 rename 就崩了」。
    let secrets = dir.path().join("secrets");
    let orphan = secrets.join("oauth-binance.json.tmp.9999.abcdef");
    std::fs::write(
        &orphan,
        serde_json::to_string(&stored_token("half-written", None, None)).unwrap(),
    )
    .unwrap();

    let loaded = store.load().unwrap().unwrap();
    assert_eq!(loaded.access_token.expose(), "old-access", "启动必须读到旧 token");

    // 残留的临时文件不影响后续写入。
    store.save(&stored_token("newer", None, None)).unwrap();
    assert_eq!(store.load().unwrap().unwrap().access_token.expose(), "newer");
    assert_eq!(store.mode().unwrap(), 0o600);
}

#[test]
fn missing_file_is_missing_not_error() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    assert!(store.load().unwrap().is_none());
    assert_eq!(store.status(now_ms()).unwrap().state, TokenState::Missing);
    assert!(!store.delete().unwrap());
}

#[test]
fn delete_removes_token_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    store.save(&stored_token("a", None, None)).unwrap();
    assert!(store.delete().unwrap());
    assert!(!store.exists());
}

// ---------------------------------------------------------------------------
// 回环回调服务器
// ---------------------------------------------------------------------------

async fn get(url: &str) -> (u16, String) {
    let resp = loopback_client().get(url).send().await.unwrap();
    let status = resp.status().as_u16();
    (status, resp.text().await.unwrap_or_default())
}

#[tokio::test]
async fn callback_server_ignores_favicon_then_accepts_code() {
    let server = CallbackServer::bind(0, "/oauth/callback").await.unwrap();
    let port = server.port();
    assert_eq!(server.redirect_uri(), format!("http://127.0.0.1:{port}/oauth/callback"));

    let waiter = tokio::spawn(async move {
        server.wait_for_code("st-1", Duration::from_secs(5)).await
    });

    // 浏览器先要 favicon —— 不能把它当成回调。
    let (status, _) = get(&format!("http://127.0.0.1:{port}/favicon.ico")).await;
    assert_eq!(status, 404);

    let (status, body) = get(&format!(
        "http://127.0.0.1:{port}/oauth/callback?code=the-code&state=st-1"
    ))
    .await;
    assert_eq!(status, 200);
    assert!(body.contains("授权完成"));

    let result = waiter.await.unwrap().unwrap();
    assert_eq!(result.code.expose(), "the-code");
    assert_eq!(result.state, "st-1");
}

#[tokio::test]
async fn callback_rejects_state_mismatch() {
    let server = CallbackServer::bind(0, "/oauth/callback").await.unwrap();
    let port = server.port();
    let waiter = tokio::spawn(async move {
        server.wait_for_code("expected", Duration::from_secs(5)).await
    });
    let (status, _) = get(&format!(
        "http://127.0.0.1:{port}/oauth/callback?code=c&state=attacker"
    ))
    .await;
    assert_eq!(status, 400);
    let err = waiter.await.unwrap().unwrap_err();
    assert!(matches!(err, Error::OAuth { ref error, .. } if error == "state_mismatch"), "{err:?}");
    // 报错里不许出现任何一边的 state 值。
    let text = err.to_string();
    assert!(!text.contains("attacker") && !text.contains("expected"));
}

#[tokio::test]
async fn callback_surfaces_authorization_server_error() {
    let server = CallbackServer::bind(0, "/oauth/callback").await.unwrap();
    let port = server.port();
    let waiter = tokio::spawn(async move {
        server.wait_for_code("st", Duration::from_secs(5)).await
    });
    let _ = get(&format!(
        "http://127.0.0.1:{port}/oauth/callback?error=access_denied&error_description=user+said+no&state=st"
    ))
    .await;
    let err = waiter.await.unwrap().unwrap_err();
    assert!(matches!(err, Error::OAuth { ref error, .. } if error == "access_denied"), "{err:?}");
}

#[tokio::test]
async fn callback_times_out_without_hanging_forever() {
    let server = CallbackServer::bind(0, "/oauth/callback").await.unwrap();
    let err = server
        .wait_for_code("st", Duration::from_millis(150))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Callback(_)), "{err:?}");
}

// ---------------------------------------------------------------------------
// 发现流程
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discovery_validates_metadata_and_warns_about_missing_pieces() {
    let fake = FakeAs::start(FakeAsState::default()).await;
    let resource = format!("{}/mcp/agentic", fake.base);
    let hint = format!("{}/.well-known/oauth-protected-resource/gateway-mcp", fake.base);

    let d = exchange_mcp::discovery::discover(&loopback_client(), &resource, Some(&hint))
        .await
        .unwrap();

    assert_eq!(d.prm_url, hint);
    assert_eq!(d.authorization_server.token_endpoint, fake.token_endpoint());
    assert!(d.authorization_server.supports_cimd());
    assert!(!d.authorization_server.advertises_refresh());
    // 两条提醒都必须出现:没有 scopes_supported、没声明 refresh_token。
    assert!(d.warnings.iter().any(|w| w.contains("scopes_supported")), "{:?}", d.warnings);
    assert!(d.warnings.iter().any(|w| w.contains("refresh_token")), "{:?}", d.warnings);
}

#[test]
fn parses_binance_www_authenticate_header() {
    let header = r#"Bearer resource_metadata="https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp""#;
    let c = exchange_mcp::discovery::parse_www_authenticate(header).unwrap();
    assert_eq!(
        c.resource_metadata.as_deref(),
        Some("https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp")
    );

    let with_error = r#"Bearer realm="mcp", error="invalid_token", error_description="expired", resource_metadata="https://x/.well-known/y""#;
    let c2 = exchange_mcp::discovery::parse_www_authenticate(with_error).unwrap();
    assert_eq!(c2.error.as_deref(), Some("invalid_token"));
    assert_eq!(c2.error_description.as_deref(), Some("expired"));
    assert_eq!(c2.realm.as_deref(), Some("mcp"));
    assert_eq!(c2.resource_metadata.as_deref(), Some("https://x/.well-known/y"));

    assert!(exchange_mcp::discovery::parse_www_authenticate("Basic realm=x").is_none());
}

#[test]
fn derives_wellknown_paths_per_rfc() {
    let prm = exchange_mcp::discovery::derive_prm_urls("https://agent.binance.com/mcp/agentic").unwrap();
    assert_eq!(
        prm[0],
        "https://agent.binance.com/.well-known/oauth-protected-resource/mcp/agentic"
    );
    assert_eq!(prm[1], "https://agent.binance.com/.well-known/oauth-protected-resource");

    let as_urls = exchange_mcp::discovery::derive_as_metadata_urls("https://agent.binance.com").unwrap();
    assert_eq!(as_urls[0], "https://agent.binance.com/.well-known/oauth-authorization-server");
}

#[test]
fn rejects_authorization_server_without_pkce_s256() {
    let meta: exchange_mcp::discovery::AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
        "issuer": "https://as.test",
        "authorization_endpoint": "https://as.test/a",
        "token_endpoint": "https://as.test/t",
        "code_challenge_methods_supported": ["plain"],
        "token_endpoint_auth_methods_supported": ["none"],
    }))
    .unwrap();
    let mut warnings = Vec::new();
    let err = exchange_mcp::discovery::validate_as_metadata(&meta, "https://as.test", &mut warnings)
        .unwrap_err();
    assert!(err.to_string().contains("S256"));
}

#[test]
fn rejects_issuer_mismatch() {
    let meta: exchange_mcp::discovery::AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
        "issuer": "https://evil.test",
        "authorization_endpoint": "https://as.test/a",
        "token_endpoint": "https://as.test/t",
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    }))
    .unwrap();
    let mut warnings = Vec::new();
    assert!(
        exchange_mcp::discovery::validate_as_metadata(&meta, "https://as.test", &mut warnings).is_err()
    );
}
