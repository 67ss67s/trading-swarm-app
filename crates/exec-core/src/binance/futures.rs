//! USDⓈ-M 合约(`fapi`)端点。
//!
//! 来源:8794 `binance.rs` 的 `get_balance` / `get_account_info` / `get_positions` /
//! `get_position_mode` / `set_position_mode` / `set_leverage` / `get_open_orders` /
//! `create_order` / `cancel_order` / `get_order_by_client_id` / `get_order_history` /
//! `get_trade_history` / `get_income_history` / `create_listen_key` /
//! `keepalive_listen_key` / `get_exchange_info` / `get_price` / `get_klines`。
//!
//! **没有复制**:跟单(`copy_trading_*`)、TWAP、algo/条件单专用端点族
//! (`/fapi/v1/algoOrder`、`openAlgoOrders`、`replace_algo_order`)、COIN-M(`dapi`)、
//! `test_order` 校验通道、hedge 运行时联锁、保护腿引擎、分档 split 三件套。
//! 条件单(STOP_MARKET / TAKE_PROFIT_MARKET)走**普通** `/fapi/v1/order`,
//! 这是 8794 里同样在用的路径,不需要 algo 端点。

use serde_json::Value;

use super::rest::BinanceRest;
use crate::error::BinanceError;
use crate::filters::{SymbolRules, exchange_symbol, f64_of, parse_symbol_rules};

pub struct FuturesApi<'a>(pub(crate) &'a BinanceRest);

// ───────────────────────── 订单参数的类型 ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Buy => "BUY",
            Self::Sell => "SELL",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderType {
    Market,
    Limit,
    StopMarket,
    TakeProfitMarket,
    Stop,
    TakeProfit,
    TrailingStopMarket,
}

impl OrderType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Market => "MARKET",
            Self::Limit => "LIMIT",
            Self::StopMarket => "STOP_MARKET",
            Self::TakeProfitMarket => "TAKE_PROFIT_MARKET",
            Self::Stop => "STOP",
            Self::TakeProfit => "TAKE_PROFIT",
            Self::TrailingStopMarket => "TRAILING_STOP_MARKET",
        }
    }

    /// 需要 `stopPrice` 的条件单类型。
    pub fn needs_stop_price(self) -> bool {
        matches!(self, Self::StopMarket | Self::TakeProfitMarket | Self::Stop | Self::TakeProfit)
    }

    /// 需要 `price` + `timeInForce` 的限价类型。
    pub fn needs_price(self) -> bool {
        matches!(self, Self::Limit | Self::Stop | Self::TakeProfit)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeInForce {
    Gtc,
    Ioc,
    Fok,
    /// Post-only。
    Gtx,
}

impl TimeInForce {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gtc => "GTC",
            Self::Ioc => "IOC",
            Self::Fok => "FOK",
            Self::Gtx => "GTX",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PositionSide {
    Both,
    Long,
    Short,
}

impl PositionSide {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Both => "BOTH",
            Self::Long => "LONG",
            Self::Short => "SHORT",
        }
    }
}

/// 条件单的触发价基准。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkingType {
    MarkPrice,
    ContractPrice,
}

impl WorkingType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MarkPrice => "MARK_PRICE",
            Self::ContractPrice => "CONTRACT_PRICE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RespType {
    Ack,
    Result,
}

impl RespType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ack => "ACK",
            Self::Result => "RESULT",
        }
    }
}

/// 账户持仓模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PositionMode {
    OneWay,
    Hedge,
}

impl PositionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OneWay => "one_way",
            Self::Hedge => "hedge",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::OneWay => "单向持仓",
            Self::Hedge => "双向持仓",
        }
    }
}

/// 一张待提交的新订单。
///
/// 数量/价格是**十进制字符串**(仓库约定):调用方先用
/// [`SymbolRules::normalize_quantity`] / [`crate::decimal_text`] 归一化,
/// 这里不做隐式浮点转换 —— 8794 的 -1111 事故根因正是格式化时冒出浮点尾巴。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NewOrderRequest {
    pub symbol: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_price: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_in_force: Option<TimeInForce>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduce_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_position: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_side: Option<PositionSide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_type: Option<WorkingType>,
    /// **调用前必须持久化**(设计 §4 硬规则):对账只认它。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_client_order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_order_resp_type: Option<RespType>,
}

impl NewOrderRequest {
    pub fn new(symbol: impl Into<String>, side: OrderSide, order_type: OrderType) -> Self {
        Self {
            symbol: symbol.into(),
            side,
            order_type,
            quantity: None,
            price: None,
            stop_price: None,
            time_in_force: None,
            reduce_only: None,
            close_position: None,
            position_side: None,
            working_type: None,
            new_client_order_id: None,
            new_order_resp_type: None,
        }
    }

    /// 构造发送参数,顺带把**发送前就能判死的形状**拦下来。
    ///
    /// 三条不变式(前两条来自 8794 的实盘事故):
    /// 1. 双向持仓(`positionSide` = LONG/SHORT)下**不许带 `reduceOnly`** ——
    ///    币安直接 -1106/-4061,而在单向下它又是必需的;两种方言不能混。
    /// 2. `closePosition=true` 与 `quantity` 互斥。
    /// 3. `clientOrderId` 必须符合币安字符集/长度,否则整单 -1100。
    pub fn to_params(&self) -> Result<Vec<(String, String)>, BinanceError> {
        let mut params: Vec<(String, String)> = vec![
            ("symbol".into(), exchange_symbol(&self.symbol)),
            ("side".into(), self.side.as_str().to_owned()),
            ("type".into(), self.order_type.as_str().to_owned()),
        ];
        let hedge = matches!(self.position_side, Some(PositionSide::Long) | Some(PositionSide::Short));
        if hedge && self.reduce_only == Some(true) {
            return Err(BinanceError::local_reject(
                "hedge_invariant",
                "双向持仓下不得同时发送 reduceOnly 与 positionSide:方向由 positionSide 决定",
            ));
        }
        if self.close_position == Some(true) && self.quantity.is_some() {
            return Err(BinanceError::local_reject(
                "close_position_invariant",
                "closePosition=true 与 quantity 互斥",
            ));
        }
        if self.close_position != Some(true) && self.quantity.is_none() {
            return Err(BinanceError::local_reject("missing_quantity", "非 closePosition 订单必须带 quantity"));
        }
        if self.order_type.needs_stop_price() && self.stop_price.is_none() {
            return Err(BinanceError::local_reject(
                "missing_stop_price",
                format!("{} 订单必须带 stop_price", self.order_type.as_str()),
            ));
        }
        if self.order_type.needs_price() && self.price.is_none() {
            return Err(BinanceError::local_reject(
                "missing_price",
                format!("{} 订单必须带 price", self.order_type.as_str()),
            ));
        }
        if let Some(id) = &self.new_client_order_id
            && !crate::ids::is_valid_client_order_id(id)
        {
            return Err(BinanceError::local_reject(
                "bad_client_order_id",
                format!("clientOrderId {id:?} 不满足 ^[\\.A-Z\\:/a-z0-9_-]{{1,36}}$"),
            ));
        }

        if let Some(quantity) = &self.quantity {
            params.push(("quantity".into(), quantity.clone()));
        }
        if let Some(price) = &self.price {
            params.push(("price".into(), price.clone()));
        }
        if let Some(stop_price) = &self.stop_price {
            params.push(("stopPrice".into(), stop_price.clone()));
        }
        if let Some(tif) = self.time_in_force {
            params.push(("timeInForce".into(), tif.as_str().to_owned()));
        }
        if self.reduce_only == Some(true) {
            params.push(("reduceOnly".into(), "true".into()));
        }
        if self.close_position == Some(true) {
            params.push(("closePosition".into(), "true".into()));
        }
        if let Some(position_side) = self.position_side {
            params.push(("positionSide".into(), position_side.as_str().to_owned()));
        }
        if let Some(working_type) = self.working_type {
            params.push(("workingType".into(), working_type.as_str().to_owned()));
        }
        if let Some(id) = &self.new_client_order_id {
            params.push(("newClientOrderId".into(), id.clone()));
        }
        // 默认 RESULT:ACK 只回 orderId,拿不到状态/成交量,对账要多打一次 REST。
        params.push((
            "newOrderRespType".into(),
            self.new_order_resp_type.unwrap_or(RespType::Result).as_str().to_owned(),
        ));
        Ok(params)
    }
}

/// 订单标识:交易所 orderId 或本机 clientOrderId(对账只认后者)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderRef {
    OrderId(i64),
    ClientOrderId(String),
}

impl OrderRef {
    fn params(&self) -> Vec<(String, String)> {
        match self {
            Self::OrderId(id) => vec![("orderId".into(), id.to_string())],
            Self::ClientOrderId(id) => vec![("origClientOrderId".into(), id.clone())],
        }
    }
}

impl FuturesApi<'_> {
    fn base(&self) -> String {
        self.0.fapi_base.clone()
    }

    // ── 账户 ──────────────────────────────────────────────

    /// `GET /fapi/v3/account`。
    pub async fn account(&self) -> Result<Value, BinanceError> {
        self.0.signed_get(&self.base(), "/fapi/v3/account", &[]).await
    }

    /// `GET /fapi/v3/balance`。
    pub async fn balance(&self) -> Result<Value, BinanceError> {
        self.0.signed_get(&self.base(), "/fapi/v3/balance", &[]).await
    }

    /// `GET /fapi/v2/positionRisk`(v3 少了 `leverage`/`marginType`,所以 v2 优先)。
    ///
    /// 8794 R64:**被限频时立刻放弃降级链** —— 封禁期里连打三个端点只是把封禁
    /// 再续 120 秒,降级链本身就是个放大器。
    pub async fn position_risk(&self, symbol: Option<&str>) -> Result<Value, BinanceError> {
        let params: Vec<(String, String)> = symbol
            .map(|value| vec![("symbol".to_owned(), exchange_symbol(value))])
            .unwrap_or_default();
        let mut last_error = None;
        for endpoint in ["/fapi/v2/positionRisk", "/fapi/v3/positionRisk"] {
            match self.0.signed_get(&self.base(), endpoint, &params).await {
                Ok(rows) => return Ok(rows),
                Err(error) if error.is_rate_limited() => return Err(error),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.expect("loop ran at least once"))
    }

    /// `GET /fapi/v1/positionSide/dual` → 账户实际持仓模式。
    pub async fn position_mode(&self) -> Result<PositionMode, BinanceError> {
        let payload = self.0.signed_get(&self.base(), "/fapi/v1/positionSide/dual", &[]).await?;
        let dual = payload.get("dualSidePosition").map(truthy).unwrap_or(false);
        Ok(if dual { PositionMode::Hedge } else { PositionMode::OneWay })
    }

    /// `POST /fapi/v1/positionSide/dual`。有持仓或挂单时交易所会拒(-4067/-4068)。
    pub async fn set_position_mode(&self, mode: PositionMode) -> Result<Value, BinanceError> {
        let dual = matches!(mode, PositionMode::Hedge);
        self.0
            .signed_post(
                &self.base(),
                "/fapi/v1/positionSide/dual",
                &[("dualSidePosition".into(), dual.to_string())],
            )
            .await
    }

    /// `POST /fapi/v1/leverage`。
    pub async fn set_leverage(&self, symbol: &str, leverage: i64) -> Result<Value, BinanceError> {
        self.0
            .signed_post(
                &self.base(),
                "/fapi/v1/leverage",
                &[
                    ("symbol".into(), exchange_symbol(symbol)),
                    ("leverage".into(), leverage.to_string()),
                ],
            )
            .await
    }

    /// `POST /fapi/v1/marginType`,`margin_type` ∈ `ISOLATED` / `CROSSED`。
    /// 已经是目标模式时币安回 -4046(`No need to change margin type`),
    /// 调用方按"已达成"处理即可。
    pub async fn set_margin_type(&self, symbol: &str, margin_type: &str) -> Result<Value, BinanceError> {
        let normalized = match margin_type.trim().to_ascii_lowercase().as_str() {
            "isolated" | "逐仓" => "ISOLATED",
            "cross" | "crossed" | "全仓" => "CROSSED",
            other => {
                return Err(BinanceError::local_reject(
                    "bad_margin_type",
                    format!("margin_type 只能是 isolated/cross,当前为 {other:?}"),
                ));
            }
        };
        self.0
            .signed_post(
                &self.base(),
                "/fapi/v1/marginType",
                &[
                    ("symbol".into(), exchange_symbol(symbol)),
                    ("marginType".into(), normalized.to_owned()),
                ],
            )
            .await
    }

    // ── 订单 ──────────────────────────────────────────────

    /// `GET /fapi/v1/openOrders`(不带 symbol 是 40 weight 的全账户扫描)。
    pub async fn open_orders(&self, symbol: Option<&str>) -> Result<Value, BinanceError> {
        let params: Vec<(String, String)> = symbol
            .map(|value| vec![("symbol".to_owned(), exchange_symbol(value))])
            .unwrap_or_default();
        self.0.signed_get(&self.base(), "/fapi/v1/openOrders", &params).await
    }

    /// `POST /fapi/v1/order`。
    ///
    /// **调用前必须已经持久化 `new_client_order_id`**:这条请求失败成
    /// [`BinanceErrorKind::Transport`](crate::BinanceErrorKind::Transport) 时,
    /// 交易所可能已经收下,唯一的找回途径就是按该 id 回查。
    pub async fn place_order(&self, order: &NewOrderRequest) -> Result<Value, BinanceError> {
        let params = order.to_params()?;
        self.0.signed_post(&self.base(), "/fapi/v1/order", &params).await
    }

    /// `GET /fapi/v1/order`,按 orderId 或 origClientOrderId 查单。
    pub async fn get_order(&self, symbol: &str, reference: &OrderRef) -> Result<Value, BinanceError> {
        let mut params = vec![("symbol".to_owned(), exchange_symbol(symbol))];
        params.extend(reference.params());
        self.0.signed_get(&self.base(), "/fapi/v1/order", &params).await
    }

    /// `DELETE /fapi/v1/order`。
    pub async fn cancel_order(&self, symbol: &str, reference: &OrderRef) -> Result<Value, BinanceError> {
        let mut params = vec![("symbol".to_owned(), exchange_symbol(symbol))];
        params.extend(reference.params());
        self.0.signed_delete(&self.base(), "/fapi/v1/order", &params).await
    }

    /// `DELETE /fapi/v1/allOpenOrders`:撤某交易对全部挂单(tswarm-demo-exec `cancel_all`)。
    pub async fn cancel_all_open_orders(&self, symbol: &str) -> Result<Value, BinanceError> {
        self.0
            .signed_delete(&self.base(), "/fapi/v1/allOpenOrders", &[("symbol".into(), exchange_symbol(symbol))])
            .await
    }

    /// `GET /fapi/v1/allOrders`(含已终态的历史单)。
    pub async fn all_orders(
        &self,
        symbol: &str,
        limit: i64,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) -> Result<Value, BinanceError> {
        let mut params = vec![
            ("symbol".to_owned(), exchange_symbol(symbol)),
            ("limit".to_owned(), limit.clamp(1, 1000).to_string()),
        ];
        push_range(&mut params, start_ms, end_ms);
        self.0.signed_get(&self.base(), "/fapi/v1/allOrders", &params).await
    }

    /// `GET /fapi/v1/userTrades`(成交明细/fills)。
    pub async fn user_trades(
        &self,
        symbol: &str,
        limit: i64,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) -> Result<Value, BinanceError> {
        let mut params = vec![
            ("symbol".to_owned(), exchange_symbol(symbol)),
            ("limit".to_owned(), limit.clamp(1, 1000).to_string()),
        ];
        push_range(&mut params, start_ms, end_ms);
        self.0.signed_get(&self.base(), "/fapi/v1/userTrades", &params).await
    }

    /// `GET /fapi/v1/income`(资金流水:realized pnl / funding / commission …)。
    pub async fn income(
        &self,
        symbol: Option<&str>,
        income_type: Option<&str>,
        limit: i64,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) -> Result<Value, BinanceError> {
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(symbol) = symbol {
            params.push(("symbol".into(), exchange_symbol(symbol)));
        }
        if let Some(income_type) = income_type {
            params.push(("incomeType".into(), income_type.to_owned()));
        }
        params.push(("limit".into(), limit.clamp(1, 1000).to_string()));
        push_range(&mut params, start_ms, end_ms);
        self.0.signed_get(&self.base(), "/fapi/v1/income", &params).await
    }

    /// `GET /fapi/v1/leverageBracket`(单交易对的杠杆分层与维持保证金率;
    /// weight 1,见 `ratelimit::estimated_request_weight`)。
    pub async fn leverage_bracket(&self, symbol: &str) -> Result<Value, BinanceError> {
        self.0
            .signed_get(&self.base(), "/fapi/v1/leverageBracket", &[("symbol".into(), exchange_symbol(symbol))])
            .await
    }

    // ── 用户数据流 listenKey(带 key、不签名)──────────────

    pub async fn create_listen_key(&self) -> Result<String, BinanceError> {
        let payload = self
            .0
            .keyed_request(reqwest::Method::POST, &self.base(), "/fapi/v1/listenKey", &[])
            .await?;
        let key = payload.get("listenKey").and_then(Value::as_str).unwrap_or_default();
        if key.is_empty() {
            return Err(BinanceError::new(None, None, "listenKey 响应里没有 key", payload));
        }
        Ok(key.to_owned())
    }

    /// 30 分钟一次;不续期 60 分钟后交易所会断流。
    pub async fn keepalive_listen_key(&self) -> Result<(), BinanceError> {
        self.0
            .keyed_request(reqwest::Method::PUT, &self.base(), "/fapi/v1/listenKey", &[])
            .await
            .map(|_| ())
    }

    pub async fn close_listen_key(&self) -> Result<(), BinanceError> {
        self.0
            .keyed_request(reqwest::Method::DELETE, &self.base(), "/fapi/v1/listenKey", &[])
            .await
            .map(|_| ())
    }

    /// 用户数据流 WS 根,必须跟随交易环境 —— 混接等于把两套账户的事件当成一份。
    pub fn user_stream_ws_base(&self) -> &'static str {
        if self.0.fapi_base.contains("demo-") || self.0.fapi_base.contains("testnet") {
            "wss://demo-fstream.binance.com/ws"
        } else {
            "wss://fstream.binance.com/ws"
        }
    }

    // ── 公共行情 ─────────────────────────────────────────

    /// `GET /fapi/v1/exchangeInfo` → 每个交易对的 [`SymbolRules`]。
    pub async fn symbol_rules(&self) -> Result<std::collections::HashMap<String, SymbolRules>, BinanceError> {
        let info = self.0.public_get(&self.base(), "/fapi/v1/exchangeInfo", &[]).await?;
        Ok(parse_symbol_rules(&info))
    }

    pub async fn exchange_info(&self) -> Result<Value, BinanceError> {
        self.0.public_get(&self.base(), "/fapi/v1/exchangeInfo", &[]).await
    }

    /// `GET /fapi/v1/premiumIndex`(标记价 / 资金费率)。
    pub async fn premium_index(&self, symbol: Option<&str>) -> Result<Value, BinanceError> {
        let params: Vec<(String, String)> = symbol
            .map(|value| vec![("symbol".to_owned(), exchange_symbol(value))])
            .unwrap_or_default();
        self.0.public_get(&self.base(), "/fapi/v1/premiumIndex", &params).await
    }

    /// `GET /fapi/v1/ticker/price`。
    pub async fn ticker_price(&self, symbol: Option<&str>) -> Result<Value, BinanceError> {
        let params: Vec<(String, String)> = symbol
            .map(|value| vec![("symbol".to_owned(), exchange_symbol(value))])
            .unwrap_or_default();
        self.0.public_get(&self.base(), "/fapi/v1/ticker/price", &params).await
    }

    /// `GET /fapi/v1/klines` → `[[openTime, o, h, l, c, v, closeTime, ...], ...]`。
    pub async fn klines(
        &self,
        symbol: &str,
        interval: &str,
        limit: i64,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) -> Result<Value, BinanceError> {
        let mut params = vec![
            ("symbol".to_owned(), exchange_symbol(symbol)),
            ("interval".to_owned(), interval.to_owned()),
            ("limit".to_owned(), limit.clamp(1, 1500).to_string()),
        ];
        push_range(&mut params, start_ms, end_ms);
        self.0.public_get(&self.base(), "/fapi/v1/klines", &params).await
    }

    /// `GET /fapi/v1/time` → 交易所毫秒时间戳(公共端点,不需要 key)。
    pub async fn server_time(&self) -> Result<i64, BinanceError> {
        let payload = self.0.public_get(&self.base(), "/fapi/v1/time", &[]).await?;
        payload
            .get("serverTime")
            .and_then(f64_of)
            .map(|value| value as i64)
            .ok_or_else(|| BinanceError::new(None, None, "服务器时间响应缺少 serverTime", payload))
    }
}

fn push_range(params: &mut Vec<(String, String)>, start_ms: Option<i64>, end_ms: Option<i64>) {
    if let Some(start) = start_ms {
        params.push(("startTime".into(), start.to_string()));
    }
    if let Some(end) = end_ms {
        params.push(("endTime".into(), end.to_string()));
    }
}

/// 币安的布尔既可能是 `true` 也可能是 `"true"`。
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|item| item != 0.0),
        Value::String(text) => {
            matches!(text.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "y" | "on")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params_text(order: &NewOrderRequest) -> String {
        order
            .to_params()
            .expect("params")
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&")
    }

    #[test]
    fn market_entry_shape() {
        let mut order = NewOrderRequest::new("BTC/USDT", OrderSide::Buy, OrderType::Market);
        order.quantity = Some("0.0031".into());
        order.new_client_order_id = Some("tg-abcdef012345-e-0".into());
        assert_eq!(
            params_text(&order),
            "symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.0031&newClientOrderId=tg-abcdef012345-e-0&newOrderRespType=RESULT"
        );
    }

    #[test]
    fn limit_order_carries_price_and_tif() {
        let mut order = NewOrderRequest::new("ETHUSDT", OrderSide::Sell, OrderType::Limit);
        order.quantity = Some("1.25".into());
        order.price = Some("4200.5".into());
        order.time_in_force = Some(TimeInForce::Ioc);
        order.reduce_only = Some(true);
        assert_eq!(
            params_text(&order),
            "symbol=ETHUSDT&side=SELL&type=LIMIT&quantity=1.25&price=4200.5&timeInForce=IOC&reduceOnly=true&newOrderRespType=RESULT"
        );
    }

    #[test]
    fn stop_market_close_position_shape() {
        let mut order = NewOrderRequest::new("BTCUSDT", OrderSide::Sell, OrderType::StopMarket);
        order.stop_price = Some("58000".into());
        order.close_position = Some(true);
        order.working_type = Some(WorkingType::MarkPrice);
        order.new_order_resp_type = Some(RespType::Ack);
        assert_eq!(
            params_text(&order),
            "symbol=BTCUSDT&side=SELL&type=STOP_MARKET&stopPrice=58000&closePosition=true&workingType=MARK_PRICE&newOrderRespType=ACK"
        );
    }

    /// 8794 R58 的方言不变式:双向持仓靠 `positionSide` 表达方向,
    /// **不许再带 `reduceOnly`**(币安会整单拒)。
    #[test]
    fn hedge_dialect_refuses_reduce_only() {
        let mut order = NewOrderRequest::new("BTCUSDT", OrderSide::Sell, OrderType::Market);
        order.quantity = Some("0.01".into());
        order.position_side = Some(PositionSide::Long);
        order.reduce_only = Some(true);
        let error = order.to_params().expect_err("必须本地拒");
        assert_eq!(error.local_reject_kind(), Some("hedge_invariant"));

        // 去掉 reduceOnly 后是合法的 hedge 平多腿
        order.reduce_only = None;
        assert_eq!(
            params_text(&order),
            "symbol=BTCUSDT&side=SELL&type=MARKET&quantity=0.01&positionSide=LONG&newOrderRespType=RESULT"
        );
        // BOTH(单向)下 reduceOnly 仍然合法且必需
        order.position_side = Some(PositionSide::Both);
        order.reduce_only = Some(true);
        assert!(params_text(&order).contains("reduceOnly=true"));
    }

    #[test]
    fn malformed_orders_are_rejected_before_sending() {
        let mut order = NewOrderRequest::new("BTCUSDT", OrderSide::Buy, OrderType::Market);
        assert_eq!(order.to_params().unwrap_err().local_reject_kind(), Some("missing_quantity"));

        order.quantity = Some("1".into());
        order.close_position = Some(true);
        assert_eq!(order.to_params().unwrap_err().local_reject_kind(), Some("close_position_invariant"));

        let mut order = NewOrderRequest::new("BTCUSDT", OrderSide::Sell, OrderType::TakeProfitMarket);
        order.quantity = Some("1".into());
        assert_eq!(order.to_params().unwrap_err().local_reject_kind(), Some("missing_stop_price"));
        order.stop_price = Some("70000".into());
        assert!(order.to_params().is_ok());

        let mut order = NewOrderRequest::new("BTCUSDT", OrderSide::Sell, OrderType::Stop);
        order.quantity = Some("1".into());
        order.stop_price = Some("70000".into());
        assert_eq!(order.to_params().unwrap_err().local_reject_kind(), Some("missing_price"));

        let mut order = NewOrderRequest::new("BTCUSDT", OrderSide::Buy, OrderType::Market);
        order.quantity = Some("1".into());
        order.new_client_order_id = Some("有中文".into());
        assert_eq!(order.to_params().unwrap_err().local_reject_kind(), Some("bad_client_order_id"));
    }

    #[test]
    fn order_ref_params_pick_the_right_identity_field() {
        assert_eq!(OrderRef::OrderId(7).params(), vec![("orderId".to_owned(), "7".to_owned())]);
        assert_eq!(
            OrderRef::ClientOrderId("tg-abcdef012345-e-0".into()).params(),
            vec![("origClientOrderId".to_owned(), "tg-abcdef012345-e-0".to_owned())]
        );
    }

    #[test]
    fn user_stream_domains_are_isolated_by_environment() {
        let live = crate::binance::BinanceRest::anonymous();
        assert_eq!(live.futures().user_stream_ws_base(), "wss://fstream.binance.com/ws");
        let demo = crate::binance::BinanceRest::anonymous().with_fapi_base(super::super::rest::FAPI_DEMO);
        assert_eq!(demo.futures().user_stream_ws_base(), "wss://demo-fstream.binance.com/ws");
    }

    #[test]
    fn binance_booleans_come_in_both_shapes() {
        assert!(truthy(&Value::Bool(true)));
        assert!(truthy(&Value::String("true".into())));
        assert!(truthy(&serde_json::json!(1)));
        assert!(!truthy(&Value::String("false".into())));
        assert!(!truthy(&Value::Null));
    }
}
