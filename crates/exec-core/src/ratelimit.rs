//! 进程内 REST 令牌桶 + `RestGate::{Ready,Wait,Banned}`。
//!
//! 来源:8794 `binance.rs` 的 `RestRateLimiter` / `RestGate` / `parse_ban_remaining` /
//! `estimated_request_weight`(全部经 2026-08-03/04 那两次真实 20 分钟封禁打磨)。
//!
//! 两条纪律,一条都不能丢:
//! 1. **`Banned` 与 `Wait` 必须分开**——前者是交易所已经在拒绝我们,封禁期内每发
//!    一次请求就把封禁再续 120 秒;后者只是本地预算暂时不够,短等无害。
//! 2. **本地预算不足最多等 `MAX_ACQUIRE_WAIT`**,超过就显式失败,让上层退回
//!    缓存/WS 快照并标 stale,而不是把调用方挂住几分钟。
//!
//! 改写点:8794 的桶是 `static` 全局,这里是普通结构体(`Arc` 共享)。额度是
//! **per-IP** 的,所以同进程的所有 `BinanceRest` 默认共用 [`RestRateLimiter::shared`];
//! 测试与多实例部署可以各自 `new`。新增 `observe_used_weight`:读币安响应头
//! `X-MBX-USED-WEIGHT-1M` 把本地桶按交易所自己的账本压下去(同一 IP 上还有别的
//! 进程时,本地估值一定偏乐观)。

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::Value;

/// 币安公开上限 1200 weight/min(429 报文自报 IP 上限 2400);这里只用 720,
/// 给人工操作、时间同步与交易所侧口径变化留余量。
/// **桶是 per-process,额度是 per-IP**:同机器 N 个实例就是 N×720,必须用
/// `TG_REST_WEIGHT_PER_MINUTE` 把预算按实例数分摊。
pub const REST_WEIGHT_PER_MINUTE: f64 = 720.0;

/// 本地预算不足时最多等多久;超过直接失败。
pub const MAX_ACQUIRE_WAIT: Duration = Duration::from_secs(10);

/// 认账 `banned until` / `Retry-After` 的上限。时间戳异常时不至于把进程锁死。
pub const MAX_HONORED_BAN: Duration = Duration::from_secs(900);

/// 放行结论。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum RestGate {
    Ready,
    /// 本地预算不够,等这么久就能发。
    Wait(Duration),
    /// **交易所已经在拒绝我们**,一秒都不能等。
    Banned(Duration),
}

#[derive(Debug)]
struct RestRateState {
    tokens: f64,
    updated_at: Instant,
    blocked_until: Instant,
    /// `blocked_until` 是不是交易所**实证封禁**(而非本地预算不够)。
    blocked_by_exchange: bool,
    backoff_exp: u32,
    last_limited: Option<Instant>,
}

#[derive(Debug)]
pub struct RestRateLimiter {
    capacity: f64,
    refill_per_second: f64,
    state: std::sync::Mutex<RestRateState>,
}

impl RestRateLimiter {
    pub fn new(capacity: f64, per_minute: f64, now: Instant) -> Self {
        Self {
            capacity,
            refill_per_second: per_minute / 60.0,
            state: std::sync::Mutex::new(RestRateState {
                tokens: capacity,
                updated_at: now,
                blocked_until: now,
                blocked_by_exchange: false,
                backoff_exp: 0,
                last_limited: None,
            }),
        }
    }

    /// 进程级共享桶(默认)。额度是 per-IP 的,所以同进程的所有适配器共用一只。
    pub fn shared() -> Arc<Self> {
        static LIMITER: OnceLock<Arc<RestRateLimiter>> = OnceLock::new();
        LIMITER
            .get_or_init(|| {
                let budget = configured_weight_per_minute();
                Arc::new(RestRateLimiter::new(budget, budget, Instant::now()))
            })
            .clone()
    }

    pub fn capacity(&self) -> f64 {
        self.capacity
    }

    pub fn gate_at(&self, weight: f64, now: Instant) -> RestGate {
        let mut state = self.state.lock().expect("rest rate limiter poisoned");
        let elapsed = now.saturating_duration_since(state.updated_at).as_secs_f64();
        state.tokens = (state.tokens + elapsed * self.refill_per_second).min(self.capacity);
        state.updated_at = now;
        if state.blocked_until > now {
            let remaining = state.blocked_until.duration_since(now);
            return if state.blocked_by_exchange {
                RestGate::Banned(remaining)
            } else {
                RestGate::Wait(remaining)
            };
        }
        state.blocked_by_exchange = false;
        let weight = weight.clamp(1.0, self.capacity);
        if state.tokens >= weight {
            state.tokens -= weight;
            RestGate::Ready
        } else {
            RestGate::Wait(Duration::from_secs_f64((weight - state.tokens) / self.refill_per_second))
        }
    }

    /// 拿到放行 → `Ok(())`;等不起 → `Err(还要等多久)`,由调用方转成一次显式失败。
    /// **绝不在交易所封禁期内睡等**。
    pub async fn acquire(&self, weight: u32) -> Result<(), Duration> {
        loop {
            match self.gate_at(weight as f64, Instant::now()) {
                RestGate::Ready => return Ok(()),
                RestGate::Banned(remaining) => return Err(remaining),
                RestGate::Wait(wait) if wait > MAX_ACQUIRE_WAIT => return Err(wait),
                RestGate::Wait(wait) => tokio::time::sleep(wait).await,
            }
        }
    }

    /// 吃到 -1003/418/429。`ban_for` 是从报文 `banned until <epoch_ms>` 或
    /// `Retry-After` 头解析出的**确切解封时长**;拿得到就直接关到那一刻,
    /// 拿不到才退回指数退避(1/2/4/…/32 秒)。
    pub fn rate_limited_for(&self, now: Instant, ban_for: Option<Duration>) -> Duration {
        let mut state = self.state.lock().expect("rest rate limiter poisoned");
        if state
            .last_limited
            .is_some_and(|last| now.saturating_duration_since(last) > Duration::from_secs(300))
        {
            state.backoff_exp = 0;
        }
        state.backoff_exp = (state.backoff_exp + 1).min(6);
        state.last_limited = Some(now);
        let backoff = Duration::from_secs(1u64 << (state.backoff_exp - 1));
        let honored = ban_for
            .map(|span| (span + Duration::from_secs(1)).min(MAX_HONORED_BAN))
            .unwrap_or(Duration::ZERO);
        let delay = backoff.max(honored);
        state.blocked_until = state.blocked_until.max(now + delay);
        state.blocked_by_exchange = true;
        delay
    }

    /// 读币安响应头 `X-MBX-USED-WEIGHT-1M` 自适应:交易所自己的账本比本地估值权威
    /// (同一 IP 上还有别的进程/别的 key 在打)。只**收紧**不放松——本地桶剩余
    /// 取 `min(本地剩余, 容量 - 交易所已用)`。
    pub fn observe_used_weight(&self, used_weight: f64, now: Instant) {
        if !used_weight.is_finite() || used_weight < 0.0 {
            return;
        }
        let mut state = self.state.lock().expect("rest rate limiter poisoned");
        let elapsed = now.saturating_duration_since(state.updated_at).as_secs_f64();
        state.tokens = (state.tokens + elapsed * self.refill_per_second).min(self.capacity);
        state.updated_at = now;
        let exchange_remaining = (self.capacity - used_weight).max(0.0);
        state.tokens = state.tokens.min(exchange_remaining);
    }

    #[cfg(test)]
    fn wait_for_at(&self, weight: f64, now: Instant) -> Duration {
        match self.gate_at(weight, now) {
            RestGate::Ready => Duration::ZERO,
            RestGate::Wait(wait) | RestGate::Banned(wait) => wait,
        }
    }

    #[cfg(test)]
    fn rate_limited(&self, now: Instant) -> Duration {
        self.rate_limited_for(now, None)
    }
}

pub fn configured_weight_per_minute() -> f64 {
    std::env::var("TG_REST_WEIGHT_PER_MINUTE")
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(REST_WEIGHT_PER_MINUTE)
}

/// 币安 -1003 的报文形如
/// `Way too many requests; IP(1.2.3.4) banned until 1785823439669. Please use...`。
/// 解出毫秒时间戳 → 还要封多久;解不出返回 `None`(退回指数退避)。
pub fn parse_ban_remaining(payload: &Value, now_ms: f64) -> Option<Duration> {
    let message = payload.get("msg").and_then(Value::as_str).unwrap_or_default();
    let tail = message.split("banned until").nth(1)?;
    let digits: String = tail.trim_start().chars().take_while(char::is_ascii_digit).collect();
    let until_ms: f64 = digits.parse().ok()?;
    let remaining_ms = until_ms - now_ms;
    (remaining_ms > 0.0).then(|| Duration::from_secs_f64(remaining_ms / 1000.0))
}

/// `Retry-After: <秒>`。HTTP 日期形式不解析(币安不用),返回 `None` 退回其它来源。
pub fn parse_retry_after(header: Option<&str>) -> Option<Duration> {
    let seconds: u64 = header?.trim().parse().ok()?;
    Some(Duration::from_secs(seconds).min(MAX_HONORED_BAN))
}

/// 币安 U 本位合约 / spot-sapi 的 IP weight。**按交易所文档的真实值**。
///
/// 8794 R64 取证:旧表把最热的 `/fapi/v1/openOrders`(不带 symbol,真实 **40**)
/// 记成 3、`/fapi/v1/income`(**30**)和 `/fapi/v1/positionSide/dual`(**30**)
/// 落在 `_ => 1` —— 桶对最贵的端点松了 13 倍,等于没进桶。
/// 未知路径兜底 **5**(按账户级读处理),不再静默按 1 记。
pub fn estimated_request_weight(url: &reqwest::Url) -> u32 {
    let path = url.path();
    let query = |name: &str| -> Option<String> {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .filter(|value| !value.is_empty())
    };
    let has_symbol = query("symbol").is_some();
    let limit = query("limit").and_then(|value| value.parse::<i64>().ok());
    if path.ends_with("/klines") || path.ends_with("/markPriceKlines") || path.ends_with("/indexPriceKlines") {
        return match limit.unwrap_or(500) {
            0..=99 => 1,
            100..=499 => 2,
            500..=1000 => 5,
            _ => 10,
        };
    }
    if path == "/fapi/v1/depth" {
        return match limit.unwrap_or(500) {
            0..=50 => 2,
            51..=100 => 5,
            101..=500 => 10,
            _ => 20,
        };
    }
    match path {
        // ── 账户/仓位读
        "/fapi/v2/positionRisk" | "/fapi/v3/positionRisk" => 5,
        "/fapi/v2/account" | "/fapi/v3/account" => 5,
        "/fapi/v2/balance" | "/fapi/v3/balance" => 5,
        // 不带 symbol = 全账户扫描,交易所按 40 计(8794 旧表 3,头号漏计)
        "/fapi/v1/openOrders" | "/fapi/v1/openAlgoOrders" => {
            if has_symbol { 1 } else { 40 }
        }
        "/fapi/v1/allOrders" | "/fapi/v1/userTrades" | "/fapi/v1/allAlgoOrders" => {
            if has_symbol { 5 } else { 40 }
        }
        "/fapi/v1/leverageBracket" => {
            if has_symbol { 1 } else { 40 }
        }
        "/fapi/v1/income" => 30,
        "/fapi/v1/positionSide/dual" => 30,
        "/fapi/v1/multiAssetsMargin" => 30,
        "/fapi/v1/commissionRate" => 20,
        "/fapi/v1/adlQuantile" => 5,
        "/fapi/v1/forceOrders" => {
            if has_symbol { 20 } else { 50 }
        }
        // ── 单张订单的增删查(下单另有独立的 order rate limit)
        "/fapi/v1/order" | "/fapi/v1/allOpenOrders" | "/fapi/v1/leverage"
        | "/fapi/v1/marginType" | "/fapi/v1/positionMargin" | "/fapi/v1/listenKey" => 1,
        "/fapi/v1/batchOrders" => 5,
        "/fapi/v1/countdownCancelAll" => 10,
        // ── 公开行情
        "/fapi/v1/exchangeInfo" | "/fapi/v1/time" | "/fapi/v1/ping" | "/fapi/v1/fundingRate" => 1,
        "/fapi/v1/ticker/price" | "/fapi/v1/ticker/bookTicker" => {
            if has_symbol { 1 } else { 2 }
        }
        "/fapi/v1/premiumIndex" => {
            if has_symbol { 1 } else { 10 }
        }
        "/fapi/v1/ticker/24hr" => {
            if has_symbol { 1 } else { 40 }
        }
        // ── spot / sapi(A1 主账户探测用;spot 与 fapi 的 IP 账本不同源,
        //    但共用一只桶只会更保守,不会更松)
        "/api/v3/account" => 20,
        "/api/v3/time" | "/api/v3/ping" => 1,
        "/sapi/v1/account/apiRestrictions" => 1,
        "/sapi/v1/sub-account/list" => 1,
        "/sapi/v3/sub-account/assets" => 1,
        "/sapi/v1/sub-account/spotSummary" => 1,
        "/sapi/v1/sub-account/universalTransfer" => 1,
        "/sapi/v1/asset/transfer" => 1,
        _ => 5,
    }
}

/// 只有真正的币安 host 才进桶:本地 mock / 自定义网关不共享币安的 IP 额度,
/// 把它们塞进同一只桶会让并行测试反过来饿死真请求。
pub fn is_official_binance_host(url: &reqwest::Url) -> bool {
    matches!(
        url.host_str(),
        Some(
            "fapi.binance.com"
                | "demo-fapi.binance.com"
                | "dapi.binance.com"
                | "demo-dapi.binance.com"
                | "api.binance.com"
                | "api1.binance.com"
                | "api2.binance.com"
                | "api3.binance.com"
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_bucket_consumes_refills_and_blocks_after_exchange_limit() {
        let start = Instant::now();
        let limiter = RestRateLimiter::new(10.0, 60.0, start);
        assert_eq!(limiter.wait_for_at(7.0, start), Duration::ZERO);
        assert_eq!(limiter.wait_for_at(3.0, start), Duration::ZERO);
        assert!(limiter.wait_for_at(1.0, start) >= Duration::from_secs(1));
        assert_eq!(limiter.wait_for_at(1.0, start + Duration::from_secs(1)), Duration::ZERO);
        let backoff = limiter.rate_limited(start + Duration::from_secs(1));
        assert_eq!(backoff, Duration::from_secs(1));
        assert!(limiter.wait_for_at(1.0, start + Duration::from_millis(1500)) >= Duration::from_millis(500));
        assert_eq!(limiter.rate_limited(start + Duration::from_secs(2)), Duration::from_secs(2));
    }

    /// 8794 R64 回归:**被限频时不许出现重试风暴**。实盘形状(2026-08-04):
    /// 币安在 -1003 里写明 `banned until <epoch_ms>`(最短 120 秒),旧实现只做
    /// 1/2/4…64 秒指数退避,退避一到继续打,而封禁期内**每一次**请求都会把封禁
    /// 再续 120 秒 —— ban_until 被自己一路顶了 20 分钟。
    #[test]
    fn exchange_ban_window_is_honored_instead_of_retried() {
        let start = Instant::now();
        let limiter = RestRateLimiter::new(100.0, 6000.0, start);

        let payload = serde_json::json!({
            "code": -1003,
            "msg": "Way too many requests; IP(103.172.183.81) banned until 1785823439669. Please use the websocket for live updates to avoid bans.",
        });
        let remaining = parse_ban_remaining(&payload, 1785823439669.0 - 120_000.0)
            .expect("banned until 必须解析成功");
        assert_eq!(remaining.as_secs(), 120);
        assert!(parse_ban_remaining(&serde_json::json!({ "msg": "Too many requests" }), 0.0).is_none());
        assert!(parse_ban_remaining(&payload, 1785823439669.0 + 1.0).is_none());

        // 认账时间戳:退避 = 封禁剩余 +1 秒余量,不是 1 秒。
        assert_eq!(limiter.rate_limited_for(start, Some(Duration::from_secs(120))), Duration::from_secs(121));

        // 封禁期内**任何**请求都必须判 Banned 并立刻失败。
        for elapsed in [0u64, 1, 30, 119] {
            assert!(
                matches!(limiter.gate_at(1.0, start + Duration::from_secs(elapsed)), RestGate::Banned(_)),
                "封禁第 {elapsed} 秒仍必须拒发"
            );
        }
        assert_eq!(limiter.gate_at(1.0, start + Duration::from_secs(122)), RestGate::Ready);

        // 没给时间戳时不得比指数退避更松。
        let later = start + Duration::from_secs(200);
        assert_eq!(limiter.rate_limited_for(later, None), Duration::from_secs(2));
        assert_eq!(limiter.rate_limited_for(later + Duration::from_secs(3), None), Duration::from_secs(4));

        // 荒唐的时间戳不许把进程锁死。
        let far = later + Duration::from_secs(600);
        assert_eq!(limiter.rate_limited_for(far, Some(Duration::from_secs(86_400))), MAX_HONORED_BAN);
    }

    #[test]
    fn retry_after_header_is_honored_and_capped() {
        assert_eq!(parse_retry_after(Some("120")), Some(Duration::from_secs(120)));
        assert_eq!(parse_retry_after(Some(" 5 ")), Some(Duration::from_secs(5)));
        assert_eq!(parse_retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT")), None);
        assert_eq!(parse_retry_after(None), None);
        assert_eq!(parse_retry_after(Some("99999")), Some(MAX_HONORED_BAN));
    }

    /// 8794 R64 回归:本地预算耗尽只等一小会儿,超过上限直接失败——不能把调用方
    /// 挂住几分钟(挂住等于把并发请求全堆在桶口上)。
    #[test]
    fn local_budget_shortfall_fails_fast_instead_of_hanging() {
        let start = Instant::now();
        let limiter = RestRateLimiter::new(40.0, 1.0, start);
        assert_eq!(limiter.gate_at(40.0, start), RestGate::Ready);
        match limiter.gate_at(40.0, start) {
            RestGate::Wait(wait) => assert!(wait > MAX_ACQUIRE_WAIT, "应超过等待上限,实得 {wait:?}"),
            other => panic!("预算不足应判 Wait,实得 {other:?}"),
        }
    }

    /// 交易所响应头比本地估值权威(同一 IP 上还有别的进程)。只收紧不放松。
    #[test]
    fn used_weight_header_only_tightens_the_bucket() {
        let start = Instant::now();
        let limiter = RestRateLimiter::new(100.0, 6000.0, start);
        // 交易所说这一分钟已经用了 95 → 本地只剩 5
        limiter.observe_used_weight(95.0, start);
        assert_eq!(limiter.gate_at(5.0, start), RestGate::Ready);
        assert!(matches!(limiter.gate_at(5.0, start), RestGate::Wait(_)));
        // 反向的乐观读数不许把桶重新灌满
        let later = start + Duration::from_millis(10);
        limiter.observe_used_weight(0.0, later);
        assert!(matches!(limiter.gate_at(50.0, later), RestGate::Wait(_)));
        // 非法读数直接忽略
        limiter.observe_used_weight(f64::NAN, later);
        limiter.observe_used_weight(-1.0, later);
    }

    /// 权重表必须按币安真实口径。
    #[test]
    fn request_weights_match_binance_documented_values() {
        let weight = |url: &str| estimated_request_weight(&reqwest::Url::parse(url).expect("url"));
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/openOrders"), 40);
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/openOrders?symbol=BTCUSDT"), 1);
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/income?limit=100"), 30);
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/positionSide/dual"), 30);
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/leverageBracket"), 40);
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/userTrades?symbol=BTCUSDT"), 5);
        assert_eq!(weight("https://fapi.binance.com/fapi/v2/positionRisk"), 5);
        assert_eq!(weight("https://fapi.binance.com/fapi/v3/account"), 5);
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&limit=1500"), 10);
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&limit=50"), 1);
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT"), 1);
        assert_eq!(weight("https://api.binance.com/api/v3/account"), 20);
        assert_eq!(weight("https://api.binance.com/sapi/v1/sub-account/list"), 1);
        // 未知端点兜底 5,不再静默按 1 记
        assert_eq!(weight("https://fapi.binance.com/fapi/v1/somethingNew"), 5);
    }

    #[test]
    fn only_official_hosts_share_the_ip_budget() {
        let url = |value: &str| reqwest::Url::parse(value).expect("url");
        assert!(is_official_binance_host(&url("https://fapi.binance.com/fapi/v1/time")));
        assert!(is_official_binance_host(&url("https://api.binance.com/api/v3/account")));
        assert!(!is_official_binance_host(&url("http://127.0.0.1:8080/fapi/v1/time")));
        assert!(!is_official_binance_host(&url("https://fapi.binance.com.evil.example/fapi/v1/time")));
    }
}
