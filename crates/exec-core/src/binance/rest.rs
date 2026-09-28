//! 签名、时间偏移、令牌桶、错误分类 —— 所有 Binance REST 端点共用的底座。
//!
//! 来源:8794 `binance.rs` 的 `signed_query` / `sync_server_time` /
//! `request_json_with_attempts` / `signed_request`(-1021 重签一次)/ `urlencode` /
//! `quote_plus` / `retryable`。
//!
//! 改写点:
//! - 凭证从 `Value` + env 名改成显式 [`MainCredentials`](crate::secrets::MainCredentials),
//!   secret 用 [`SecretString`] 包住(8794 的 `api_secret()` 返回裸 `String`);
//! - 时间偏移与令牌桶从进程 `static` 改成实例字段(`Arc` 共享),测试不再互相污染;
//! - 新增 `X-MBX-USED-WEIGHT-1M` / `Retry-After` 响应头自适应;
//! - 删掉 `test_order` / `allow_live_orders` / hedge 运行时联锁 / CM(币本位)探测 /
//!   copy_trading 端点 —— trade-gate 的闸门在 execd 的 gate v2,不在适配器里。

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::error::{BinanceError, BinanceErrorKind};
use crate::network::shared_http_client;
use crate::ratelimit::{
    RestRateLimiter, estimated_request_weight, is_official_binance_host, parse_ban_remaining,
    parse_retry_after,
};
use crate::secrets::{MainCredentials, SecretString, mask};

pub const FAPI_LIVE: &str = "https://fapi.binance.com";
pub const API_LIVE: &str = "https://api.binance.com";
/// 币安 USDⓈ-M 的**演示环境**。trade-gate 的 Agentic 子账户底座没有 testnet
/// (设计 §0),这里保留常量只为主账户侧的连通性排查。
pub const FAPI_DEMO: &str = "https://demo-fapi.binance.com";

/// 默认 recvWindow。8794 实盘用 60000(网络抖动大时短窗口会把签名请求全打掉);
/// 这里取币安默认 5000,由调用方按环境放宽 —— 窗口越大,时钟被人动过时越晚发现。
pub const DEFAULT_RECV_WINDOW_MS: i64 = 5_000;

/// 每 30 分钟同步一次服务器时间(-1021 会立即强制重同步)。
const SERVER_TIME_SYNC_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// 传输层重试预算(仅对**幂等**请求生效,见 [`retryable`])。
const DEFAULT_MAX_ATTEMPTS: u32 = 5;

#[derive(Debug)]
struct ServerTimeState {
    offset_ms: AtomicI64,
    last_attempt_ms: AtomicI64,
    sync_lock: tokio::sync::Mutex<()>,
}

impl Default for ServerTimeState {
    fn default() -> Self {
        Self {
            offset_ms: AtomicI64::new(0),
            last_attempt_ms: AtomicI64::new(0),
            sync_lock: tokio::sync::Mutex::new(()),
        }
    }
}

/// 主账户 REST 客户端。
///
/// `Clone` 共享同一份时间偏移、令牌桶与连接池 —— 额度是 per-IP 的,拆开只会互相饿死。
#[derive(Clone)]
pub struct BinanceRest {
    api_key: String,
    secret: SecretString,
    /// USDⓈ-M 合约根。
    pub fapi_base: String,
    /// 现货 / sapi 根。
    pub api_base: String,
    pub recv_window: i64,
    time_offset: Arc<ServerTimeState>,
    gate: Arc<RestRateLimiter>,
    client: reqwest::Client,
}

impl std::fmt::Debug for BinanceRest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BinanceRest")
            .field("api_key", &mask(&self.api_key))
            .field("secret", &self.secret)
            .field("fapi_base", &self.fapi_base)
            .field("api_base", &self.api_base)
            .field("recv_window", &self.recv_window)
            .field("time_offset_ms", &self.time_offset_ms())
            .finish()
    }
}

impl BinanceRest {
    pub fn new(credentials: &MainCredentials) -> Self {
        Self {
            api_key: credentials.api_key.clone(),
            secret: credentials.api_secret.clone(),
            fapi_base: FAPI_LIVE.to_owned(),
            api_base: API_LIVE.to_owned(),
            recv_window: DEFAULT_RECV_WINDOW_MS,
            time_offset: Arc::new(ServerTimeState::default()),
            gate: RestRateLimiter::shared(),
            client: shared_http_client().clone(),
        }
    }

    /// 只读公共端点用(无凭证)。签名端点会以 `LocalReject` 立即失败。
    pub fn anonymous() -> Self {
        Self::new(&MainCredentials {
            api_key: String::new(),
            api_secret: SecretString::new(""),
            source: "anonymous".to_owned(),
        })
    }

    pub fn with_fapi_base(mut self, base: impl Into<String>) -> Self {
        self.fapi_base = base.into().trim_end_matches('/').to_owned();
        self
    }

    pub fn with_api_base(mut self, base: impl Into<String>) -> Self {
        self.api_base = base.into().trim_end_matches('/').to_owned();
        self
    }

    pub fn with_recv_window(mut self, recv_window_ms: i64) -> Self {
        self.recv_window = recv_window_ms;
        self
    }

    /// 独立令牌桶(测试或多实例分摊预算时用)。默认共享进程级桶。
    pub fn with_gate(mut self, gate: Arc<RestRateLimiter>) -> Self {
        self.gate = gate;
        self
    }

    pub fn with_client(mut self, client: reqwest::Client) -> Self {
        self.client = client;
        self
    }

    pub fn has_credentials(&self) -> bool {
        !self.api_key.is_empty() && !self.secret.is_empty()
    }

    pub fn api_key_masked(&self) -> String {
        mask(&self.api_key)
    }

    pub fn gate(&self) -> &Arc<RestRateLimiter> {
        &self.gate
    }

    /// 当前 `服务器时间 - 本机时间` 估计值(毫秒)。
    pub fn time_offset_ms(&self) -> i64 {
        self.time_offset.offset_ms.load(Ordering::Acquire)
    }

    pub fn futures(&self) -> super::futures::FuturesApi<'_> {
        super::futures::FuturesApi(self)
    }

    pub fn spot(&self) -> super::spot_sapi::SpotApi<'_> {
        super::spot_sapi::SpotApi(self)
    }

    fn require_credentials(&self) -> Result<(), BinanceError> {
        if self.has_credentials() {
            Ok(())
        } else {
            Err(BinanceError::credentials_missing(
                "缺少主账户 API key/secret:设置 TG_MAIN_API_KEY/TG_MAIN_API_SECRET 或写入 ~/.trade-gate/secrets/apikey-main.json",
            ))
        }
    }

    /// 拼出 `<params>&recvWindow=..&timestamp=..&signature=..`。
    ///
    /// **顺序稳定**:按调用方给的插入顺序,再追加 recvWindow / timestamp,最后签名。
    /// 币安只要求签名串与实际发送串逐字节一致,不要求排序 —— 但确定性顺序是可
    /// 回放/可对拍的前提,所以这里绝不用 HashMap。
    pub fn signed_query(&self, params: &[(String, String)]) -> Result<String, BinanceError> {
        self.signed_query_at(params, local_now_ms() + self.time_offset_ms())
    }

    /// 固定时间戳版本(测试与签名向量用)。
    pub fn signed_query_at(
        &self,
        params: &[(String, String)],
        timestamp_ms: i64,
    ) -> Result<String, BinanceError> {
        self.require_credentials()?;
        let mut signed = params.to_vec();
        signed.push(("recvWindow".into(), self.recv_window.to_string()));
        signed.push(("timestamp".into(), timestamp_ms.to_string()));
        let body = urlencode(&signed);
        let signature = sign_payload(self.secret.expose(), &body)?;
        Ok(format!("{body}&signature={signature}"))
    }

    /// 惰性刷新时钟偏移。取请求本地发/收时刻的**中点**,抵掉一半 RTT。
    pub async fn sync_server_time(&self, force: bool) -> Result<i64, BinanceError> {
        let state = &self.time_offset;
        let interval_ms = SERVER_TIME_SYNC_INTERVAL.as_millis() as i64;
        let fresh_enough = |state: &ServerTimeState| {
            local_now_ms().saturating_sub(state.last_attempt_ms.load(Ordering::Acquire)) < interval_ms
        };
        if !force && fresh_enough(state) {
            return Ok(state.offset_ms.load(Ordering::Acquire));
        }
        let _guard = state.sync_lock.lock().await;
        if !force && fresh_enough(state) {
            return Ok(state.offset_ms.load(Ordering::Acquire));
        }

        let started_ms = local_now_ms();
        let result = self
            .public_get(&self.fapi_base.clone(), "/fapi/v1/time", &[])
            .await
            .and_then(|payload| {
                payload
                    .get("serverTime")
                    .and_then(crate::filters::f64_of)
                    .map(|value| value as i64)
                    .ok_or_else(|| {
                        BinanceError::new(None, None, "服务器时间响应缺少 serverTime", payload.clone())
                    })
            });
        let finished_ms = local_now_ms();
        state.last_attempt_ms.store(finished_ms, Ordering::Release);
        let server_ms = result?;
        let midpoint_ms = started_ms + finished_ms.saturating_sub(started_ms) / 2;
        let offset_ms = server_ms.saturating_sub(midpoint_ms);
        state.offset_ms.store(offset_ms, Ordering::Release);
        tracing::debug!(offset_ms, rtt_ms = finished_ms.saturating_sub(started_ms), "binance.server_time_synced");
        Ok(offset_ms)
    }

    async fn ensure_server_time(&self) {
        if let Err(error) = self.sync_server_time(false).await {
            // 公共时间端点的一次抖动不该让所有签名端点变成一场故障:留用上一份
            // 偏移,真出 -1021 时下面会立刻强制重同步。
            tracing::warn!(error = %error, "binance.server_time_sync_failed");
        }
    }

    /// 公共(不签名)GET。
    pub async fn public_get(
        &self,
        base_url: &str,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, BinanceError> {
        let url = if params.is_empty() {
            format!("{base_url}{path}")
        } else {
            format!("{base_url}{path}?{}", urlencode(params))
        };
        self.execute(self.client.get(url), DEFAULT_MAX_ATTEMPTS, None).await
    }

    /// 只带 `X-MBX-APIKEY`、不签名的端点(listenKey 三件套)。
    pub async fn keyed_request(
        &self,
        method: reqwest::Method,
        base_url: &str,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, BinanceError> {
        if self.api_key.is_empty() {
            return Err(BinanceError::credentials_missing("该端点需要 API key"));
        }
        let url = if params.is_empty() {
            format!("{base_url}{path}")
        } else {
            format!("{base_url}{path}?{}", urlencode(params))
        };
        let attempts = if method == reqwest::Method::GET { DEFAULT_MAX_ATTEMPTS } else { 1 };
        self.execute(
            self.client.request(method, url).header("X-MBX-APIKEY", &self.api_key),
            attempts,
            None,
        )
        .await
    }

    /// 签名请求。**-1021 会重新同步时钟后原样重签、重试恰好一次** ——
    /// 币安在 timestamp 参数校验阶段就拒了,不可能已经撮合,所以这次重试不会重复下单。
    /// 其它任何错误码都不进这条路。
    pub async fn signed_request(
        &self,
        method: reqwest::Method,
        base_url: &str,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, BinanceError> {
        // 缺凭证必须先失败,不要为一个配置错误先去打一次公共时间端点。
        self.require_credentials()?;
        self.ensure_server_time().await;
        let first = self.signed_request_once(&method, base_url, path, params).await;
        let original = match first {
            Ok(payload) => return Ok(payload),
            Err(error) if error.kind == BinanceErrorKind::ClockSkew => error,
            Err(error) => return Err(error),
        };
        if let Err(sync_error) = self.sync_server_time(true).await {
            tracing::warn!(error = %sync_error, "binance.server_time_resync_failed_after_clock_skew");
            return Err(original);
        }
        self.signed_request_once(&method, base_url, path, params).await
    }

    async fn signed_request_once(
        &self,
        method: &reqwest::Method,
        base_url: &str,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, BinanceError> {
        let signed = self.signed_query(params)?;
        let is_body = matches!(*method, reqwest::Method::POST | reqwest::Method::PUT);
        let url = if is_body { format!("{base_url}{path}") } else { format!("{base_url}{path}?{signed}") };
        let mut request =
            self.client.request(method.clone(), url).header("X-MBX-APIKEY", &self.api_key);
        if is_body {
            request = request
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(signed.clone());
        }
        // 权重按 URL 估;POST/PUT 的参数在 body 里,用一份等价 URL 让估值看得到 symbol。
        let weight_url = format!("{base_url}{path}?{signed}");
        // 非幂等方法**绝不重试**:重试可能造成重复下单,宁可让上层用幂等
        // clientOrderId 回查兜底(设计 §12 `execution_unknown`)。
        let attempts = if is_body || *method == reqwest::Method::DELETE { 1 } else { DEFAULT_MAX_ATTEMPTS };
        self.execute(request, attempts, Some(&weight_url)).await
    }

    pub async fn signed_get(
        &self,
        base_url: &str,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, BinanceError> {
        self.signed_request(reqwest::Method::GET, base_url, path, params).await
    }

    pub async fn signed_post(
        &self,
        base_url: &str,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, BinanceError> {
        self.signed_request(reqwest::Method::POST, base_url, path, params).await
    }

    pub async fn signed_delete(
        &self,
        base_url: &str,
        path: &str,
        params: &[(String, String)],
    ) -> Result<Value, BinanceError> {
        self.signed_request(reqwest::Method::DELETE, base_url, path, params).await
    }

    /// 发请求:进桶 → 有界重试 → 读响应头自适应 → 分类错误。
    async fn execute(
        &self,
        request: reqwest::RequestBuilder,
        max_attempts: u32,
        weight_url: Option<&str>,
    ) -> Result<Value, BinanceError> {
        let built = request
            .build()
            .map_err(|error| BinanceError::transport(format!("请求构造失败:{error}"), false))?;
        let url = built.url().clone();
        let method = built.method().clone();
        let managed = is_official_binance_host(&url);
        if managed {
            let weight_source = weight_url
                .and_then(|value| reqwest::Url::parse(value).ok())
                .unwrap_or_else(|| url.clone());
            let weight = estimated_request_weight(&weight_source);
            if let Err(wait) = self.gate.acquire(weight).await {
                // 要么交易所正在封禁我们(再发就把封禁再续 120 秒),要么本地预算
                // 短缺得离谱。两种都**立刻显式失败**,让上层退回缓存并标 stale。
                return Err(BinanceError::local_rate_limit(wait.as_secs().max(1)));
            }
        }

        let mut last_error: Option<reqwest::Error> = None;
        let mut response = None;
        if built.try_clone().is_none() {
            match self.client.execute(built).await {
                Ok(item) => response = Some(item),
                Err(error) => last_error = Some(error),
            }
        } else {
            for attempt in 0..max_attempts.max(1) {
                if attempt > 0 {
                    tokio::time::sleep(Duration::from_millis(200 << (attempt - 1))).await;
                }
                let cloned = built.try_clone().expect("checked cloneable above");
                match self.client.execute(cloned).await {
                    Ok(item) => {
                        response = Some(item);
                        break;
                    }
                    Err(error) => {
                        let retry = retryable(&error, &method);
                        last_error = Some(error);
                        if !retry {
                            break;
                        }
                    }
                }
            }
        }

        let response = match response {
            Some(item) => item,
            None => {
                let error = last_error.expect("no response implies an error");
                // **连接从未建立** = 请求确定没送到交易所,可以安全重发;
                // 其它(已发出后断开/超时)一律 ambiguous,必须走 clientOrderId 回查。
                let ambiguous = !error.is_connect();
                let hint = if error.is_connect() {
                    "(到币安的连接被重置/握手失败,已自动重试仍不通;与 API key 无关。若依赖代理上网请确认代理可用)"
                } else if error.is_timeout() {
                    "(请求超时;发送状态未知,必须按 clientOrderId 回查)"
                } else {
                    ""
                };
                return Err(BinanceError::transport(format!("币安网络错误:{error}{hint}"), ambiguous));
            }
        };

        let status = response.status();
        let header = |name: &str| {
            response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned)
        };
        let used_weight = header("x-mbx-used-weight-1m").and_then(|v| v.trim().parse::<f64>().ok());
        let retry_after = parse_retry_after(header("retry-after").as_deref());
        if managed && let Some(used) = used_weight {
            self.gate.observe_used_weight(used, Instant::now());
        }

        let raw = response.text().await.map_err(|error| {
            BinanceError::new(
                Some(status.as_u16()),
                None,
                format!("币安响应读取失败:{error}"),
                json!({ "transport_ambiguous": true }),
            )
        })?;

        if !status.is_success() {
            let payload: Value = serde_json::from_str(&raw)
                .unwrap_or_else(|_| json!({ "code": status.as_u16(), "msg": status.to_string() }));
            let code = payload.get("code").and_then(crate::filters::f64_of).map(|value| value as i64);
            let kind = BinanceErrorKind::classify(Some(status.as_u16()), code);
            if managed && kind == BinanceErrorKind::RateLimited {
                // 币安在 -1003 里直接给了解封时刻。认这个时间戳,不要用指数退避去撞
                // 一个 120 秒起步的封禁 —— 封禁期内每发一次都把封禁再续 120 秒。
                let ban_for = parse_ban_remaining(&payload, local_now_ms() as f64)
                    .into_iter()
                    .chain(retry_after)
                    .max();
                let backoff = self.gate.rate_limited_for(Instant::now(), ban_for);
                tracing::warn!(
                    status = status.as_u16(),
                    code,
                    backoff_seconds = backoff.as_secs(),
                    endpoint = url.path(),
                    "exchange.rate_limited"
                );
            }
            let message = payload
                .get("msg")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Binance HTTP {}", status.as_u16()));
            return Err(BinanceError::new(Some(status.as_u16()), code, message, payload));
        }

        if raw.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&raw).map_err(|error| {
            BinanceError::new(
                Some(status.as_u16()),
                None,
                format!("币安响应 JSON 无效:{error}"),
                json!({ "transport_ambiguous": true }),
            )
        })
    }
}

/// HMAC-SHA256(secret, payload) 的小写 hex。
pub fn sign_payload(secret: &str, payload: &str) -> Result<String, BinanceError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|error| BinanceError::local_reject("hmac_init", format!("HMAC 初始化失败:{error}")))?;
    mac.update(payload.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// `application/x-www-form-urlencoded`(空格 → `+`)。
pub fn urlencode(params: &[(String, String)]) -> String {
    params
        .iter()
        .map(|(key, value)| format!("{}={}", quote_plus(key), quote_plus(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn quote_plus(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => {
                result.push(byte as char)
            }
            b' ' => result.push('+'),
            other => result.push_str(&format!("%{other:02X}")),
        }
    }
    result
}

pub fn local_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

/// 这次失败能否安全重试?
/// - 连接建立失败(TCP/TLS 握手,请求从未发出)→ 任何方法都能重试;
/// - 请求已发出但中断 → **只有 GET**(幂等)能重试;POST 重试可能重复下单,
///   宁可让上层的 `execution_unknown` 对账兜底。
fn retryable(error: &reqwest::Error, method: &reqwest::Method) -> bool {
    if error.is_connect() {
        return true;
    }
    (error.is_timeout() || error.is_request()) && *method == reqwest::Method::GET
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 币安官方文档的经典签名向量(SPOT API `Endpoint security type` 一节)。
    /// 任何对签名串拼接顺序或编码的改动都会在这里炸。
    const DOC_SECRET: &str = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const DOC_KEY: &str = "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A";
    const DOC_QUERY: &str = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    const DOC_SIGNATURE: &str = "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71";

    fn doc_client() -> BinanceRest {
        BinanceRest::new(&MainCredentials {
            api_key: DOC_KEY.into(),
            api_secret: SecretString::new(DOC_SECRET),
            source: "test".into(),
        })
    }

    #[test]
    fn hmac_matches_the_binance_documentation_vector() {
        assert_eq!(sign_payload(DOC_SECRET, DOC_QUERY).expect("sign"), DOC_SIGNATURE);
    }

    /// 同一份参数,经 `signed_query_at` 拼出来的串必须与文档向量逐字节一致 ——
    /// 这同时钉死了「recvWindow / timestamp 追加在最后」这个顺序。
    #[test]
    fn signed_query_reproduces_the_documentation_vector() {
        let client = doc_client();
        let params: Vec<(String, String)> = [
            ("symbol", "LTCBTC"),
            ("side", "BUY"),
            ("type", "LIMIT"),
            ("timeInForce", "GTC"),
            ("quantity", "1"),
            ("price", "0.1"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        let signed = client.signed_query_at(&params, 1_499_827_319_559).expect("sign");
        assert_eq!(signed, format!("{DOC_QUERY}&signature={DOC_SIGNATURE}"));
    }

    #[test]
    fn query_string_order_is_insertion_order_not_sorted() {
        let client = doc_client().with_recv_window(60_000);
        let params: Vec<(String, String)> =
            vec![("z".into(), "1".into()), ("a".into(), "2".into()), ("m".into(), "3".into())];
        let signed = client.signed_query_at(&params, 111).expect("sign");
        assert!(signed.starts_with("z=1&a=2&m=3&recvWindow=60000&timestamp=111&signature="), "{signed}");
    }

    #[test]
    fn urlencoding_matches_python_quote_plus() {
        let params = vec![
            ("symbol".to_owned(), "BTC/USDT".to_owned()),
            ("note".to_owned(), "a b+c".to_owned()),
            ("id".to_owned(), "tg-abcdef012345-e-0".to_owned()),
            ("cn".to_owned(), "中".to_owned()),
        ];
        assert_eq!(
            urlencode(&params),
            "symbol=BTC%2FUSDT&note=a+b%2Bc&id=tg-abcdef012345-e-0&cn=%E4%B8%AD"
        );
    }

    #[test]
    fn missing_credentials_fail_locally_without_touching_the_network() {
        let client = BinanceRest::anonymous();
        let error = client.signed_query(&[]).expect_err("必须缺凭证失败");
        assert_eq!(error.kind, BinanceErrorKind::LocalReject);
        assert_eq!(error.local_reject_kind(), Some("credentials_missing"));
        assert!(!client.has_credentials());
    }

    #[test]
    fn debug_never_prints_the_secret() {
        let printed = format!("{:?}", doc_client());
        assert!(printed.contains("vmPU...Eh8A"), "{printed}");
        assert!(!printed.contains(DOC_SECRET), "secret 泄漏到 Debug:{printed}");
        assert!(printed.contains("SecretString(***)"), "{printed}");
    }

    #[test]
    fn base_urls_drop_trailing_slash_so_paths_never_double_up() {
        let client = doc_client().with_fapi_base("https://fapi.binance.com/").with_api_base("http://127.0.0.1:9/");
        assert_eq!(client.fapi_base, "https://fapi.binance.com");
        assert_eq!(client.api_base, "http://127.0.0.1:9");
    }
}
