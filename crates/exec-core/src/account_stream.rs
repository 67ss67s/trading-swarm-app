//! 用户数据流 WS + 账户读缓存。
//!
//! 来源:8794 `console-api/src/account_stream.rs`(整份逻辑与两个单测)。
//!
//! **一条纪律,不许打折**:断流即 stale。缓存只在 WS 在线时才算新鲜;
//! 断线后一次成功的节流 REST 对账只在同一个 10 秒窗口内权威,窗口一关,
//! 所有安全引擎必须停下来等下一次 REST 读,**绝不静默相信旧缓存**。
//!
//! 改写点:
//! - 剥掉 `TradingCore` —— worker 改成拿 [`BinanceRest`] + 缓存句柄 + 一个事件回调,
//!   由 execd(A2)决定怎么落库/告警;
//! - 事件解析产出本 crate 的最小结构 [`OrderUpdate`] / [`PositionUpdate`]
//!   (8794 直接塞 `Value`),字段 snake_case、金额十进制字符串、时间戳毫秒整数;
//! - keepalive 保持 30 分钟,新增 `listenKeyExpired` 立即重建。

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::binance::rest::BinanceRest;
use crate::network::connect_ws_via_proxy;

/// WS 在线时缓存的最大寿命。
pub const STALE_AFTER_SECONDS: f64 = 600.0;
/// 断线后 REST 对账的节流窗口,也是断线态缓存的最大寿命。
pub const REST_FALLBACK_SECONDS: f64 = 10.0;
/// listenKey 续期间隔(交易所 60 分钟过期)。
pub const KEEPALIVE_INTERVAL_SECONDS: u64 = 30 * 60;

// ───────────────────────── 事件的最小结构 ─────────────────────────

/// `ORDER_TRADE_UPDATE` 的 `o` 字段。金额/数量是十进制字符串,时间戳是毫秒整数。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct OrderUpdate {
    pub symbol: String,
    pub client_order_id: String,
    pub order_id: i64,
    pub side: String,
    pub order_type: String,
    pub time_in_force: String,
    pub orig_qty: String,
    pub executed_qty: String,
    pub last_filled_qty: String,
    pub price: String,
    pub avg_price: String,
    pub stop_price: String,
    /// `NEW` / `PARTIALLY_FILLED` / `FILLED` / `CANCELED` / `EXPIRED` / `REJECTED` …
    pub status: String,
    /// `NEW` / `TRADE` / `CANCELED` / `EXPIRED` …
    pub execution_type: String,
    pub position_side: String,
    pub reduce_only: bool,
    pub close_position: bool,
    pub update_time_ms: i64,
}

impl OrderUpdate {
    pub fn from_ws(raw: &Value) -> Self {
        Self {
            symbol: text(raw, "s"),
            client_order_id: text(raw, "c"),
            order_id: int(raw, "i"),
            side: text(raw, "S"),
            order_type: text(raw, "o"),
            time_in_force: text(raw, "f"),
            orig_qty: decimal(raw, "q"),
            executed_qty: decimal(raw, "z"),
            last_filled_qty: decimal(raw, "l"),
            price: decimal(raw, "p"),
            avg_price: decimal(raw, "ap"),
            stop_price: decimal(raw, "sp"),
            status: text(raw, "X"),
            execution_type: text(raw, "x"),
            position_side: text(raw, "ps"),
            reduce_only: truthy(raw.get("R")),
            close_position: truthy(raw.get("cp")),
            update_time_ms: int(raw, "T"),
        }
    }

    /// 是否已终态。终态订单从挂单缓存里移除。
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "FILLED" | "CANCELED" | "EXPIRED" | "REJECTED" | "EXPIRED_IN_MATCH"
        )
    }

    /// 与 REST `openOrders` 同形状的行(便于与 REST 快照合并)。
    pub fn to_row(&self) -> Value {
        let mut row = json!({
            "symbol": self.symbol,
            "clientOrderId": self.client_order_id,
            "side": self.side,
            "type": self.order_type,
            "timeInForce": self.time_in_force,
            "origQty": self.orig_qty,
            "executedQty": self.executed_qty,
            "lastFilledQty": self.last_filled_qty,
            "price": self.price,
            "avgPrice": self.avg_price,
            "stopPrice": self.stop_price,
            "status": self.status,
            "executionType": self.execution_type,
            "positionSide": self.position_side,
            "reduceOnly": self.reduce_only,
            "closePosition": self.close_position,
            "updateTime": self.update_time_ms,
        });
        // 交易所回执延迟时 `i` 可能是 0 占位;0 不是真 orderId,不写进行里,免得覆盖 REST 给的真值。
        if self.order_id != 0 {
            row["orderId"] = json!(self.order_id);
        }
        row
    }
}

/// `ACCOUNT_UPDATE` 的 `a.P[]` 一行。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PositionUpdate {
    pub symbol: String,
    pub position_side: String,
    pub position_amt: String,
    pub entry_price: String,
    pub breakeven_price: String,
    pub unrealized_pnl: String,
    pub margin_type: String,
    pub isolated_wallet: String,
}

impl PositionUpdate {
    pub fn from_ws(raw: &Value) -> Self {
        Self {
            symbol: text(raw, "s"),
            position_side: text(raw, "ps"),
            position_amt: decimal(raw, "pa"),
            entry_price: decimal(raw, "ep"),
            breakeven_price: decimal(raw, "bep"),
            unrealized_pnl: decimal(raw, "up"),
            margin_type: text(raw, "mt"),
            isolated_wallet: decimal(raw, "iw"),
        }
    }

    pub fn is_flat(&self) -> bool {
        self.position_amt.trim().parse::<f64>().map(|value| value == 0.0).unwrap_or(true)
    }

    pub fn to_row(&self) -> Value {
        json!({
            "symbol": self.symbol,
            "positionSide": self.position_side,
            "positionAmt": self.position_amt,
            "entryPrice": self.entry_price,
            "breakEvenPrice": self.breakeven_price,
            "unrealizedProfit": self.unrealized_pnl,
            "marginType": self.margin_type,
            "isolatedWallet": self.isolated_wallet,
        })
    }
}

/// 用户数据流里我们关心的事件。
#[derive(Debug, Clone, PartialEq)]
pub enum UserStreamEvent {
    Order(OrderUpdate),
    Position(Vec<PositionUpdate>),
    /// listenKey 失效,worker 会重建。
    ListenKeyExpired,
    Connected,
    /// 断流:账户读**立刻**降级为节流 REST。
    Degraded(String),
}

// ───────────────────────── 缓存 ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountReadKind {
    Orders,
    Positions,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestFallbackState {
    Permit,
    /// 已经有人在打这条 REST,别再打第二条。
    InFlight,
    /// 10 秒节流窗口内,不许再打。
    Throttled,
}

#[derive(Debug, Default)]
pub struct AccountStreamCache {
    connected: bool,
    orders_initialized: bool,
    positions_initialized: bool,
    orders: Vec<Value>,
    positions: Vec<Value>,
    orders_reconciled_at: f64,
    positions_reconciled_at: f64,
    last_event_at: f64,
    last_orders_rest_at: f64,
    last_positions_rest_at: f64,
    orders_rest_in_flight_at: f64,
    positions_rest_in_flight_at: f64,
    last_degraded_warning_at: f64,
}

impl AccountStreamCache {
    pub fn mark_connected(&mut self) {
        self.connected = true;
    }

    pub fn mark_disconnected(&mut self) {
        self.connected = false;
    }

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    pub fn reconcile(&mut self, orders: Vec<Value>, positions: Vec<Value>, now: f64) {
        self.replace_orders(orders, now);
        self.replace_positions(positions, now);
    }

    pub fn replace_orders(&mut self, orders: Vec<Value>, now: f64) {
        self.orders = orders;
        self.orders_reconciled_at = now;
        self.orders_initialized = true;
    }

    pub fn replace_positions(&mut self, positions: Vec<Value>, now: f64) {
        self.positions = positions;
        self.positions_reconciled_at = now;
        self.positions_initialized = true;
    }

    pub fn orders(&self) -> &[Value] {
        &self.orders
    }

    pub fn positions(&self) -> &[Value] {
        &self.positions
    }

    /// 强制让**挂单**缓存失效:刚往交易所写过单的引擎必须调它。
    ///
    /// 8794 08-20 生产实证:延挂腿提交成功、DB 已置在场,补缺引擎在同一条串行链里
    /// 拿到的却是**提交前**那份 fresh 缓存 → 算出覆盖为 0 → 又补一张,场上双份。
    /// 失效之后下一次读要么走 REST 拿新快照,要么被节流判 stale —— 补缺引擎见
    /// stale 就跳过本轮,双写变成"晚一轮补"。
    pub fn invalidate_orders(&mut self) {
        // 写完单后挂单缓存必须视为未初始化:is_fresh 立即为 false,下一次读一定走 REST。
        self.orders_initialized = false;
        self.orders_reconciled_at = 0.0;
        self.last_orders_rest_at = 0.0;
    }

    /// **断流即 stale**。在线时 600 秒;断线后只认最近一次 REST 对账的 10 秒窗口。
    pub fn is_fresh(&self, kind: AccountReadKind, now: f64) -> bool {
        let (initialized, reconciled_at) = match kind {
            AccountReadKind::Orders => (self.orders_initialized, self.orders_reconciled_at),
            AccountReadKind::Positions => (self.positions_initialized, self.positions_reconciled_at),
        };
        let max_age = if self.connected { STALE_AFTER_SECONDS } else { REST_FALLBACK_SECONDS };
        initialized && now - reconciled_at <= max_age
    }

    pub fn begin_rest_fallback(&mut self, kind: AccountReadKind, now: f64) -> RestFallbackState {
        let (last, in_flight) = match kind {
            AccountReadKind::Orders => (&self.last_orders_rest_at, &mut self.orders_rest_in_flight_at),
            AccountReadKind::Positions => {
                (&self.last_positions_rest_at, &mut self.positions_rest_in_flight_at)
            }
        };
        // 被取消的 HTTP future 不许把这条资源永久卡住:币安请求的重试预算有界,
        // 60 秒之后允许新调用方接手。
        if *in_flight > 0.0 && now - *in_flight <= 60.0 {
            return RestFallbackState::InFlight;
        }
        *in_flight = 0.0;
        if *last > 0.0 && now - *last < REST_FALLBACK_SECONDS {
            return RestFallbackState::Throttled;
        }
        *in_flight = now;
        RestFallbackState::Permit
    }

    pub fn finish_rest_fallback(&mut self, kind: AccountReadKind, now: f64) {
        match kind {
            AccountReadKind::Orders => {
                self.orders_rest_in_flight_at = 0.0;
                self.last_orders_rest_at = now;
            }
            AccountReadKind::Positions => {
                self.positions_rest_in_flight_at = 0.0;
                self.last_positions_rest_at = now;
            }
        }
    }

    /// 降级告警限流(60 秒一次),免得断流期刷屏。
    pub fn should_warn_degraded(&mut self, now: f64) -> bool {
        if self.last_degraded_warning_at > 0.0 && now - self.last_degraded_warning_at < 60.0 {
            false
        } else {
            self.last_degraded_warning_at = now;
            true
        }
    }

    pub fn orders_payload(&self, symbol: Option<&str>, now: f64) -> Value {
        let fresh = self.is_fresh(AccountReadKind::Orders, now);
        let wanted = symbol.map(crate::filters::exchange_symbol);
        let rows: Vec<Value> = self
            .orders
            .iter()
            .filter(|row| {
                wanted.as_ref().is_none_or(|want| {
                    row.get("symbol").and_then(Value::as_str).unwrap_or_default() == want
                })
            })
            .cloned()
            .collect();
        json!({
            "ok": fresh,
            "orders": rows,
            "source": "websocket",
            "fetched_at_ms": (self.last_event_at.max(self.orders_reconciled_at) * 1000.0) as i64,
            "stale": !fresh,
        })
    }

    pub fn positions_payload(&self, now: f64) -> Value {
        let fresh = self.is_fresh(AccountReadKind::Positions, now);
        json!({
            "ok": fresh,
            "positions": self.positions,
            "source": "websocket",
            "fetched_at_ms": (self.last_event_at.max(self.positions_reconciled_at) * 1000.0) as i64,
            "stale": !fresh,
        })
    }

    /// 应用一条用户数据流事件。返回它被解析成了什么(`None` = 我们不关心的事件)。
    pub fn apply_event(&mut self, event: &Value, now: f64) -> Option<UserStreamEvent> {
        let parsed = match event.get("e").and_then(Value::as_str).unwrap_or_default() {
            "ORDER_TRADE_UPDATE" => {
                let raw = event.get("o")?;
                let update = OrderUpdate::from_ws(raw);
                let row = update.to_row();
                let id = update.order_id;
                let client_id = update.client_order_id.clone();
                let same = |current: &Value| {
                    current.get("orderId").and_then(Value::as_i64) == Some(id)
                        || (!client_id.is_empty()
                            && current.get("clientOrderId").and_then(Value::as_str) == Some(client_id.as_str()))
                };
                if update.is_terminal() {
                    self.orders.retain(|current| !same(current));
                } else if let Some(current) = self.orders.iter_mut().find(|item| same(item)) {
                    merge_non_empty(current, &row);
                } else {
                    self.orders.push(row);
                }
                UserStreamEvent::Order(update)
            }
            "ACCOUNT_UPDATE" => {
                let mut updates = Vec::new();
                for raw in event.pointer("/a/P").and_then(Value::as_array).cloned().unwrap_or_default() {
                    let update = PositionUpdate::from_ws(&raw);
                    let row = update.to_row();
                    let symbol = update.symbol.clone();
                    let side = update.position_side.clone();
                    let same = |current: &Value| {
                        current.get("symbol").and_then(Value::as_str) == Some(symbol.as_str())
                            && current.get("positionSide").and_then(Value::as_str) == Some(side.as_str())
                    };
                    if update.is_flat() {
                        self.positions.retain(|current| !same(current));
                    } else if let Some(current) = self.positions.iter_mut().find(|item| same(item)) {
                        merge_non_empty(current, &row);
                    } else {
                        self.positions.push(row);
                    }
                    updates.push(update);
                }
                UserStreamEvent::Position(updates)
            }
            "listenKeyExpired" => UserStreamEvent::ListenKeyExpired,
            _ => return None,
        };
        self.last_event_at = now;
        Some(parsed)
    }
}

/// WS 增量不许把 REST 才有的字段(leverage / marginType 等)抹掉。
fn merge_non_empty(target: &mut Value, update: &Value) {
    let (Some(target), Some(update)) = (target.as_object_mut(), update.as_object()) else {
        return;
    };
    for (key, value) in update {
        if value.is_null() || value.as_str().is_some_and(str::is_empty) {
            continue;
        }
        target.insert(key.clone(), value.clone());
    }
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// 金额/数量:币安 WS 给的是字符串,但数字形态也出现过。统一成十进制字符串。
fn decimal(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => {
            crate::filters::decimal_text(number.as_f64().unwrap_or(0.0))
        }
        _ => "0".to_owned(),
    }
}

fn int(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(crate::filters::f64_of).map(|item| item as i64).unwrap_or(0)
}

fn truthy(value: Option<&Value>) -> bool {
    value.map(crate::binance::futures::truthy).unwrap_or(false)
}

pub fn now_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs_f64())
        .unwrap_or(0.0)
}

// ───────────────────────── worker ─────────────────────────

/// 用户数据流 worker。
///
/// 生命周期:`create_listen_key` → WS 连接(经代理隧道)→ **握手成功后**做一次
/// 全量 REST 锚定 → 标 connected → 事件循环(keepalive 30min / 定期对账 5min)。
///
/// 注意"握手成功后才锚定"是有意的:握手本身失败时不该额外打两条 REST,
/// 否则故障期会自己制造请求风暴。
pub async fn run_user_stream(
    rest: BinanceRest,
    cache: Arc<Mutex<AccountStreamCache>>,
    events: tokio::sync::mpsc::UnboundedSender<UserStreamEvent>,
) {
    let mut reconnect_delay = 1u64;
    loop {
        let degrade = |reason: String| {
            let events = events.clone();
            let cache = Arc::clone(&cache);
            async move {
                cache.lock().await.mark_disconnected();
                let _ = events.send(UserStreamEvent::Degraded(reason));
            }
        };

        let listen_key = match rest.futures().create_listen_key().await {
            Ok(key) => key,
            Err(error) => {
                degrade(format!("listenKey 创建失败,账户读取降级为节流 REST:{}", error.msg)).await;
                tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay)).await;
                reconnect_delay = (reconnect_delay * 2).min(60);
                continue;
            }
        };

        let url = format!("{}/{listen_key}", rest.futures().user_stream_ws_base());
        let connection =
            tokio::time::timeout(std::time::Duration::from_secs(45), connect_ws_via_proxy(&url)).await;
        let mut socket = match connection {
            Ok(Ok((socket, _))) => socket,
            Ok(Err(error)) => {
                degrade(format!("用户数据流连接失败:{error}")).await;
                tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay)).await;
                reconnect_delay = (reconnect_delay * 2).min(60);
                continue;
            }
            Err(_) => {
                degrade("用户数据流连接超时".to_owned()).await;
                tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay)).await;
                reconnect_delay = (reconnect_delay * 2).min(60);
                continue;
            }
        };
        reconnect_delay = 1;

        if let Err(error) = reconcile_once(&rest, &cache).await {
            degrade(format!("首次对账失败:{error}")).await;
            tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay)).await;
            continue;
        }
        cache.lock().await.mark_connected();
        let _ = events.send(UserStreamEvent::Connected);

        let mut keepalive =
            tokio::time::interval(std::time::Duration::from_secs(KEEPALIVE_INTERVAL_SECONDS));
        keepalive.tick().await;
        let mut reconcile = tokio::time::interval(std::time::Duration::from_secs(5 * 60));
        reconcile.tick().await;

        loop {
            tokio::select! {
                message = socket.next() => match message {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                        let Ok(event) = serde_json::from_str::<Value>(&text) else { continue };
                        let parsed = cache.lock().await.apply_event(&event, now_seconds());
                        match parsed {
                            Some(UserStreamEvent::ListenKeyExpired) => {
                                let _ = events.send(UserStreamEvent::ListenKeyExpired);
                                break;
                            }
                            Some(parsed) => { let _ = events.send(parsed); }
                            None => {}
                        }
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(payload))) => {
                        let _ = socket.send(tokio_tungstenite::tungstenite::Message::Pong(payload)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                },
                _ = keepalive.tick() => {
                    if rest.futures().keepalive_listen_key().await.is_err() {
                        break;
                    }
                }
                _ = reconcile.tick() => {
                    if let Err(error) = reconcile_once(&rest, &cache).await {
                        let _ = events.send(UserStreamEvent::Degraded(format!("周期对账失败:{error}")));
                    }
                }
            }
        }

        cache.lock().await.mark_disconnected();
        let _ = socket.close(None).await;
        let _ = events
            .send(UserStreamEvent::Degraded("用户数据流已断开,重建 listenKey".to_owned()));
        tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay)).await;
        reconnect_delay = (reconnect_delay * 2).min(60);
    }
}

async fn reconcile_once(
    rest: &BinanceRest,
    cache: &Arc<Mutex<AccountStreamCache>>,
) -> Result<(), String> {
    let futures_api = rest.futures();
    let (orders, positions) = tokio::join!(futures_api.open_orders(None), futures_api.position_risk(None));
    let orders = orders.map_err(|error| error.msg)?.as_array().cloned().unwrap_or_default();
    let positions = positions.map_err(|error| error.msg)?.as_array().cloned().unwrap_or_default();
    cache.lock().await.reconcile(orders, positions, now_seconds());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 8794 原测试:断流即 stale + REST 降级的三态节流。
    #[test]
    fn disconnect_marks_cache_stale_and_throttles_rest_fallback() {
        let mut cache = AccountStreamCache::default();
        cache.reconcile(vec![json!({"symbol":"BTCUSDT"})], vec![], 100.0);
        cache.mark_connected();
        assert!(cache.is_fresh(AccountReadKind::Orders, 101.0));
        cache.mark_disconnected();
        assert!(cache.is_fresh(AccountReadKind::Orders, 105.0), "10 秒窗口内仍权威");
        assert!(!cache.is_fresh(AccountReadKind::Orders, 111.0), "窗口一关就 stale");
        assert_eq!(cache.begin_rest_fallback(AccountReadKind::Orders, 111.0), RestFallbackState::Permit);
        assert_eq!(cache.begin_rest_fallback(AccountReadKind::Orders, 115.0), RestFallbackState::InFlight);
        cache.finish_rest_fallback(AccountReadKind::Orders, 115.0);
        assert_eq!(cache.begin_rest_fallback(AccountReadKind::Orders, 121.0), RestFallbackState::Throttled);
        assert_eq!(cache.begin_rest_fallback(AccountReadKind::Orders, 126.0), RestFallbackState::Permit);
    }

    /// 在线时 600 秒才 stale;从来没对账过 = 永远不 fresh。
    #[test]
    fn connected_cache_has_a_long_but_finite_life() {
        let mut cache = AccountStreamCache::default();
        assert!(!cache.is_fresh(AccountReadKind::Positions, 0.0), "没初始化过绝不算新鲜");
        cache.mark_connected();
        cache.reconcile(vec![], vec![], 0.0);
        assert!(cache.is_fresh(AccountReadKind::Positions, 599.0));
        assert!(!cache.is_fresh(AccountReadKind::Positions, 601.0));
    }

    /// 8794 08-20 生产回归:写完单必须让挂单缓存失效,否则补缺引擎会拿提交前的
    /// 快照再补一张。
    #[test]
    fn invalidating_orders_forces_the_next_read_to_go_out() {
        let mut cache = AccountStreamCache::default();
        cache.mark_connected();
        cache.reconcile(vec![json!({"symbol":"BTCUSDT"})], vec![], 100.0);
        cache.finish_rest_fallback(AccountReadKind::Orders, 100.0);
        assert!(cache.is_fresh(AccountReadKind::Orders, 101.0));
        cache.invalidate_orders();
        assert!(!cache.is_fresh(AccountReadKind::Orders, 101.0));
        // 节流也被一起清掉:写完单正是该立刻取新快照的时刻
        assert_eq!(cache.begin_rest_fallback(AccountReadKind::Orders, 101.0), RestFallbackState::Permit);
        // 持仓缓存不受影响
        assert!(cache.is_fresh(AccountReadKind::Positions, 101.0));
    }

    /// 8794 原测试:订单/持仓事件的增删改,且 WS 增量不许抹掉 REST 才有的字段。
    #[test]
    fn order_and_position_events_update_and_remove_rows() {
        let mut cache = AccountStreamCache::default();
        cache.reconcile(
            vec![],
            vec![json!({"symbol":"ETHUSDT","positionAmt":"1","positionSide":"LONG","leverage":"5"})],
            10.0,
        );
        cache.mark_connected();
        cache.apply_event(
            &json!({"e":"ORDER_TRADE_UPDATE","o":{"s":"BTCUSDT","c":"tg-abcdef012345-e-0","i":7,"X":"NEW","q":"1"}}),
            11.0,
        );
        assert_eq!(cache.orders().len(), 1);
        cache.apply_event(
            &json!({"e":"ORDER_TRADE_UPDATE","o":{"s":"BTCUSDT","c":"tg-abcdef012345-e-0","i":7,"X":"FILLED"}}),
            12.0,
        );
        assert!(cache.orders().is_empty(), "终态订单从挂单缓存移除");

        cache.apply_event(
            &json!({"e":"ACCOUNT_UPDATE","a":{"P":[{"s":"ETHUSDT","pa":"2","ps":"LONG","ep":"100"}]}}),
            13.0,
        );
        assert_eq!(cache.positions().len(), 1);
        assert_eq!(cache.positions()[0]["leverage"], "5", "WS 增量必须保留 REST 才有的字段");
        assert_eq!(cache.positions()[0]["positionAmt"], "2");
        cache.apply_event(
            &json!({"e":"ACCOUNT_UPDATE","a":{"P":[{"s":"ETHUSDT","pa":"0","ps":"LONG"}]}}),
            14.0,
        );
        assert!(cache.positions().is_empty(), "归零的持仓行被删掉");
    }

    /// 同一张单可能只带 clientOrderId(交易所回执延迟),按 id 或 clientId 任一匹配。
    #[test]
    fn orders_match_by_either_identity() {
        let mut cache = AccountStreamCache::default();
        cache.reconcile(vec![json!({"clientOrderId":"tg-abcdef012345-s-0","orderId":9,"status":"NEW"})], vec![], 0.0);
        cache.apply_event(
            &json!({"e":"ORDER_TRADE_UPDATE","o":{"s":"BTCUSDT","c":"tg-abcdef012345-s-0","i":0,"X":"PARTIALLY_FILLED","z":"0.5"}}),
            1.0,
        );
        assert_eq!(cache.orders().len(), 1, "按 clientOrderId 命中,不许新增一行");
        assert_eq!(cache.orders()[0]["executedQty"], "0.5");
        assert_eq!(cache.orders()[0]["orderId"], 9, "0 是占位值,不许覆盖真 orderId");
    }

    #[test]
    fn order_update_parses_into_the_minimal_struct() {
        let raw = json!({
            "s":"BTCUSDT","c":"tg-abcdef012345-t-1","i":123456789i64,"S":"SELL","o":"TAKE_PROFIT_MARKET",
            "f":"GTE_GTC","q":"0.003","z":"0.001","l":"0.001","p":"0","ap":"64000.5","sp":"65000",
            "X":"PARTIALLY_FILLED","x":"TRADE","ps":"LONG","R":false,"cp":false,"T":1_756_000_000_000i64
        });
        let update = OrderUpdate::from_ws(&raw);
        assert_eq!(update.symbol, "BTCUSDT");
        assert_eq!(update.client_order_id, "tg-abcdef012345-t-1");
        assert_eq!(update.order_id, 123_456_789);
        assert_eq!(update.avg_price, "64000.5");
        assert_eq!(update.stop_price, "65000");
        assert_eq!(update.update_time_ms, 1_756_000_000_000);
        assert!(!update.is_terminal());
        assert!(crate::ids::is_local(&update.client_order_id));
        // 缺字段不 panic,给出安全默认
        let sparse = OrderUpdate::from_ws(&json!({ "s": "ETHUSDT" }));
        assert_eq!(sparse.orig_qty, "0");
        assert_eq!(sparse.order_id, 0);
        assert!(!sparse.is_terminal());
    }

    #[test]
    fn position_update_parses_and_detects_flat() {
        let update = PositionUpdate::from_ws(&json!({
            "s":"ETHUSDT","ps":"SHORT","pa":"-1.5","ep":"4200","bep":"4195","up":"-12.5","mt":"isolated","iw":"300"
        }));
        assert_eq!(update.position_amt, "-1.5");
        assert_eq!(update.unrealized_pnl, "-12.5");
        assert!(!update.is_flat());
        assert!(PositionUpdate::from_ws(&json!({"s":"ETHUSDT","ps":"LONG","pa":"0"})).is_flat());
        assert!(PositionUpdate::from_ws(&json!({"s":"ETHUSDT"})).is_flat(), "读不出来按空仓,但调用方应查 stale");
    }

    #[test]
    fn unknown_events_are_ignored_without_touching_freshness() {
        let mut cache = AccountStreamCache::default();
        cache.mark_connected();
        cache.reconcile(vec![], vec![], 0.0);
        assert_eq!(cache.apply_event(&json!({"e":"MARGIN_CALL"}), 5.0), None);
        assert_eq!(
            cache.apply_event(&json!({"e":"listenKeyExpired"}), 6.0),
            Some(UserStreamEvent::ListenKeyExpired)
        );
    }

    #[test]
    fn payloads_report_staleness_and_filter_by_symbol() {
        let mut cache = AccountStreamCache::default();
        cache.mark_connected();
        cache.reconcile(
            vec![json!({"symbol":"BTCUSDT"}), json!({"symbol":"ETHUSDT"})],
            vec![],
            100.0,
        );
        let payload = cache.orders_payload(Some("BTC/USDT"), 101.0);
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["stale"], false);
        assert_eq!(payload["orders"].as_array().expect("array").len(), 1);
        assert_eq!(payload["fetched_at_ms"], 100_000);

        cache.mark_disconnected();
        let payload = cache.orders_payload(None, 200.0);
        assert_eq!(payload["ok"], false);
        assert_eq!(payload["stale"], true, "断流即 stale,绝不静默信缓存");
        assert_eq!(cache.positions_payload(200.0)["stale"], true);
    }

    #[test]
    fn degraded_warnings_are_throttled_to_one_per_minute() {
        let mut cache = AccountStreamCache::default();
        assert!(cache.should_warn_degraded(100.0));
        assert!(!cache.should_warn_degraded(120.0));
        assert!(cache.should_warn_degraded(161.0));
    }
}
