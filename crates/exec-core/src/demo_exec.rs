//! `tswarm-demo-exec` 的核心逻辑 —— `docs/demo/README.md` §4 协议的 op 分发。
//!
//! `DemoExec` 只包一个 [`BinanceRest`](crate::binance::rest::BinanceRest)(base URL 由
//! bin 硬编码到 `FAPI_DEMO`,本模块不关心)。`handle` 是唯一入口,bin 把 stdin 每一行
//! NDJSON 的 `op`/`params` 转发进来,拿到的 `Result<Value, DemoError>` 直接序列化成
//! 响应行的 `result` 或 `error`。
//!
//! 错误分类完全借 [`crate::error::BinanceErrorKind`]:`ambiguous=true` 只在
//! `Transport`(发送状态未知)时成立 —— 这是 gateway 决定要不要按 `clientOrderId`
//! 回查、以及**绝不重发**的唯一依据。

use serde::Deserialize;
use serde_json::{Value, json};

use crate::binance::futures::{PositionSide, NewOrderRequest, OrderRef, OrderSide, OrderType};
use crate::binance::rest::BinanceRest;
use crate::error::{BinanceError, BinanceErrorKind};
use crate::filters::{decimal_text, exchange_symbol, f64_of};

/// README §4 错误 JSON 的 `kind` 枚举,`snake_case` 直出。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DemoErrorKind {
    LocalReject,
    Unauthorized,
    ClockSkew,
    RateLimited,
    Transport,
    Rejected,
}

impl From<BinanceErrorKind> for DemoErrorKind {
    fn from(kind: BinanceErrorKind) -> Self {
        match kind {
            BinanceErrorKind::LocalReject => Self::LocalReject,
            BinanceErrorKind::Unauthorized => Self::Unauthorized,
            BinanceErrorKind::ClockSkew => Self::ClockSkew,
            BinanceErrorKind::RateLimited => Self::RateLimited,
            BinanceErrorKind::Transport => Self::Transport,
            BinanceErrorKind::Rejected => Self::Rejected,
        }
    }
}

/// 一次 `handle` 失败。`to_json` 就是协议里 `{"ok":false,"error":…}` 的 `error` 字段。
#[derive(Debug, Clone)]
pub struct DemoError {
    pub kind: DemoErrorKind,
    pub message: String,
    pub code: Option<i64>,
    /// 请求是否可能已经在交易所生效(只有 `Transport` 为 true)。
    pub ambiguous: bool,
}

impl DemoError {
    pub fn to_json(&self) -> Value {
        json!({
            "kind": self.kind,
            "message": self.message,
            "code": self.code,
            "ambiguous": self.ambiguous,
        })
    }

    /// 本地拒绝:请求根本没发出去,永不 ambiguous。
    fn local_reject(message: impl Into<String>) -> Self {
        Self { kind: DemoErrorKind::LocalReject, message: message.into(), code: None, ambiguous: false }
    }

    fn unknown_op(op: &str) -> Self {
        Self::local_reject(format!("未知 op:{op:?}"))
    }

    fn bad_params(error: serde_json::Error) -> Self {
        Self::local_reject(format!("params 形状不对:{error}"))
    }
}

impl From<BinanceError> for DemoError {
    fn from(error: BinanceError) -> Self {
        let ambiguous = error.kind == BinanceErrorKind::Transport;
        Self { kind: error.kind.into(), message: error.msg, code: error.code, ambiguous }
    }
}

/// `params.symbol` 必填、非空字符串。
fn required_symbol(params: &Value) -> Result<String, DemoError> {
    params
        .get("symbol")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| DemoError::local_reject("params.symbol 必须是非空字符串"))
}

/// `params.symbol` 可省;给了就必须是非空字符串(空串按未给处理)。
fn optional_symbol(params: &Value) -> Result<Option<String>, DemoError> {
    match params.get("symbol") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            Ok(if trimmed.is_empty() { None } else { Some(trimmed.to_owned()) })
        }
        Some(_) => Err(DemoError::local_reject("params.symbol 必须是字符串")),
    }
}

#[derive(Debug, Deserialize)]
struct SetLeverageParams {
    symbol: String,
    leverage: i64,
}

#[derive(Debug, Deserialize)]
struct OrderIdParams {
    symbol: String,
    client_order_id: String,
}

#[derive(Debug, Deserialize)]
struct ClosePositionParams {
    symbol: String,
    /// 平仓这一单的 `newClientOrderId`。**必填** —— 对账只认它。
    client_order_id: String,
}

#[derive(Debug, Deserialize)]
struct SetMarginTypeParams {
    symbol: String,
    /// `"cross"` / `"isolated"`(`FuturesApi::set_margin_type` 负责映射成
    /// 币安要的 `CROSSED`/`ISOLATED`)。
    margin_type: String,
}

#[derive(Debug, Deserialize)]
struct AllOrdersParams {
    symbol: String,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct UserTradesParams {
    symbol: String,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    start_time: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct IncomeParams {
    #[serde(default)]
    symbol: Option<String>,
    #[serde(default)]
    income_type: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    start_time: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct LeverageBracketParams {
    symbol: String,
}

/// README §4 表格给的默认 `limit`(params 未给时用)。
const DEFAULT_ALL_ORDERS_LIMIT: i64 = 50;
const DEFAULT_USER_TRADES_LIMIT: i64 = 50;
const DEFAULT_INCOME_LIMIT: i64 = 100;

/// 币安「保证金模式已经是目标模式」的业务码 —— 不是失败,调用方按已达成处理。
const MARGIN_TYPE_UNCHANGED_CODE: i64 = -4046;

/// `tswarm-demo-exec` 的执行核心。只持有一个 [`BinanceRest`],不做任何进程内状态。
pub struct DemoExec {
    rest: BinanceRest,
}

impl DemoExec {
    pub fn new(rest: BinanceRest) -> Self {
        Self { rest }
    }

    pub fn rest(&self) -> &BinanceRest {
        &self.rest
    }

    /// README §4 表格的唯一入口。每个 op 一个分支;未知 op → `local_reject`。
    pub async fn handle(&self, op: &str, params: Value) -> Result<Value, DemoError> {
        match op {
            "ping" => self.ping().await,
            "account" => Ok(self.rest.futures().account().await?),
            "balance" => Ok(self.rest.futures().balance().await?),
            "positions" => {
                let symbol = optional_symbol(&params)?;
                Ok(self.rest.futures().position_risk(symbol.as_deref()).await?)
            }
            "open_orders" => {
                let symbol = optional_symbol(&params)?;
                Ok(self.rest.futures().open_orders(symbol.as_deref()).await?)
            }
            "symbol_rules" => self.symbol_rules(&params).await,
            "mark_price" => {
                let symbol = required_symbol(&params)?;
                Ok(self.rest.futures().premium_index(Some(&symbol)).await?)
            }
            "set_leverage" => self.set_leverage(params).await,
            "place" => self.place(params).await,
            "get_order" => self.get_order(params).await,
            "cancel" => self.cancel(params).await,
            "cancel_all" => self.cancel_all(&params).await,
            "close_position" => self.close_position(params).await,
            "set_margin_type" => self.set_margin_type(params).await,
            "all_orders" => self.all_orders(params).await,
            "user_trades" => self.user_trades(params).await,
            "income" => self.income(params).await,
            "exchange_info_symbols" => self.exchange_info_symbols().await,
            "leverage_bracket" => self.leverage_bracket(params).await,
            other => Err(DemoError::unknown_op(other)),
        }
    }

    async fn ping(&self) -> Result<Value, DemoError> {
        let offset_ms = self.rest.sync_server_time(false).await?;
        let server_time = crate::binance::rest::local_now_ms() + offset_ms;
        Ok(json!({ "server_time": server_time, "offset_ms": offset_ms }))
    }

    async fn symbol_rules(&self, params: &Value) -> Result<Value, DemoError> {
        let symbol = required_symbol(params)?;
        let key = exchange_symbol(&symbol);
        let rules = self.rest.futures().symbol_rules().await?;
        let rule = rules.get(&key).ok_or_else(|| DemoError {
            kind: DemoErrorKind::Rejected,
            message: format!("未知交易对:{key}"),
            code: None,
            ambiguous: false,
        })?;
        Ok(json!({
            "step_size": decimal_text(rule.step_size),
            "tick_size": decimal_text(rule.tick_size),
            "min_qty": decimal_text(rule.min_qty),
            "min_notional": decimal_text(rule.min_notional),
            "price_precision": rule.price_precision,
            "qty_precision": rule.qty_precision,
        }))
    }

    async fn set_leverage(&self, params: Value) -> Result<Value, DemoError> {
        let request: SetLeverageParams = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        Ok(self.rest.futures().set_leverage(&request.symbol, request.leverage).await?)
    }

    /// `place`:反序列化成 [`NewOrderRequest`],**`new_client_order_id` 缺失/空串直接
    /// local_reject** —— 这一步在任何网络调用之前,假服务器必须记零次请求。
    async fn place(&self, params: Value) -> Result<Value, DemoError> {
        let order: NewOrderRequest = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        match order.new_client_order_id.as_deref().map(str::trim) {
            Some(id) if !id.is_empty() => {}
            _ => return Err(DemoError::local_reject("place 必须带非空 new_client_order_id")),
        }
        Ok(self.rest.futures().place_order(&order).await?)
    }

    async fn get_order(&self, params: Value) -> Result<Value, DemoError> {
        let request: OrderIdParams = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        let reference = OrderRef::ClientOrderId(request.client_order_id);
        Ok(self.rest.futures().get_order(&request.symbol, &reference).await?)
    }

    async fn cancel(&self, params: Value) -> Result<Value, DemoError> {
        let request: OrderIdParams = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        let reference = OrderRef::ClientOrderId(request.client_order_id);
        Ok(self.rest.futures().cancel_order(&request.symbol, &reference).await?)
    }

    async fn cancel_all(&self, params: &Value) -> Result<Value, DemoError> {
        let symbol = required_symbol(params)?;
        Ok(self.rest.futures().cancel_all_open_orders(&symbol).await?)
    }

    /// `close_position`:读 positionRisk,净持仓非零就发一张市价 reduceOnly 反向单。
    async fn close_position(&self, params: Value) -> Result<Value, DemoError> {
        let request: ClosePositionParams = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        if request.client_order_id.trim().is_empty() {
            return Err(DemoError::local_reject("close_position 必须带非空 client_order_id"));
        }
        let key = exchange_symbol(&request.symbol);
        let rows = self.rest.futures().position_risk(Some(&request.symbol)).await?;
        // One-way mode: a single BOTH row → reduceOnly market order for the net amount.
        // Hedge mode: LONG/SHORT rows → one order per side carrying positionSide and NO reduceOnly
        // (Binance rejects reduceOnly in dual-side mode). Never net the two sides against each other.
        let mut legs: Vec<(String, f64)> = Vec::new();
        for row in rows.as_array().into_iter().flatten() {
            if row.get("symbol").and_then(Value::as_str).map(exchange_symbol).as_deref() != Some(key.as_str()) {
                continue;
            }
            let amt = row.get("positionAmt").and_then(f64_of).unwrap_or(0.0);
            if amt == 0.0 {
                continue;
            }
            let side = row.get("positionSide").and_then(Value::as_str).unwrap_or("BOTH").to_owned();
            legs.push((side, amt));
        }
        if legs.is_empty() {
            return Ok(json!({ "closed": false }));
        }
        let mut receipts = Vec::new();
        for (i, (pside, amt)) in legs.iter().enumerate() {
            let side = if *amt > 0.0 { OrderSide::Sell } else { OrderSide::Buy };
            let mut order = NewOrderRequest::new(request.symbol.clone(), side, OrderType::Market);
            order.quantity = Some(decimal_text(amt.abs()));
            let cid = if i == 0 { request.client_order_id.clone() } else { format!("{}{}", request.client_order_id, i) };
            order.new_client_order_id = Some(cid);
            match pside.as_str() {
                "LONG" => order.position_side = Some(PositionSide::Long),
                "SHORT" => order.position_side = Some(PositionSide::Short),
                _ => order.reduce_only = Some(true),
            }
            let receipt = self.rest.futures().place_order(&order).await?;
            receipts.push(receipt);
        }
        let first = receipts.first().cloned().unwrap_or(Value::Null);
        Ok(json!({ "closed": true, "receipt": first, "receipts": receipts }))
    }

    /// `set_margin_type`:已经是目标模式时币安回 -4046,按「已达成」处理成
    /// `{unchanged:true}` 而不是把它当错误网上抛。
    async fn set_margin_type(&self, params: Value) -> Result<Value, DemoError> {
        let request: SetMarginTypeParams = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        match self.rest.futures().set_margin_type(&request.symbol, &request.margin_type).await {
            Ok(result) => Ok(result),
            Err(error) if error.code == Some(MARGIN_TYPE_UNCHANGED_CODE) => Ok(json!({ "unchanged": true })),
            Err(error) => Err(error.into()),
        }
    }

    async fn all_orders(&self, params: Value) -> Result<Value, DemoError> {
        let request: AllOrdersParams = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        let limit = request.limit.unwrap_or(DEFAULT_ALL_ORDERS_LIMIT);
        Ok(self.rest.futures().all_orders(&request.symbol, limit, None, None).await?)
    }

    async fn user_trades(&self, params: Value) -> Result<Value, DemoError> {
        let request: UserTradesParams = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        let limit = request.limit.unwrap_or(DEFAULT_USER_TRADES_LIMIT);
        Ok(self.rest.futures().user_trades(&request.symbol, limit, request.start_time, None).await?)
    }

    async fn income(&self, params: Value) -> Result<Value, DemoError> {
        let request: IncomeParams = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        let limit = request.limit.unwrap_or(DEFAULT_INCOME_LIMIT);
        Ok(self
            .rest
            .futures()
            .income(request.symbol.as_deref(), request.income_type.as_deref(), limit, request.start_time, None)
            .await?)
    }

    /// `exchange_info_symbols`:符号选择器用的紧凑列表 —— 只留 USDT 本位永续,
    /// 只留下单归一化需要的字段。
    async fn exchange_info_symbols(&self) -> Result<Value, DemoError> {
        let info = self.rest.futures().exchange_info().await?;
        let symbols = info.get("symbols").and_then(Value::as_array).cloned().unwrap_or_default();
        let rows: Vec<Value> = symbols.iter().filter_map(compact_perpetual_symbol).collect();
        Ok(Value::Array(rows))
    }

    async fn leverage_bracket(&self, params: Value) -> Result<Value, DemoError> {
        let request: LeverageBracketParams = serde_json::from_value(params).map_err(DemoError::bad_params)?;
        Ok(self.rest.futures().leverage_bracket(&request.symbol).await?)
    }
}

/// `exchange_info_symbols` 的每行过滤 + 抽取。只收 `contractType == "PERPETUAL"`
/// 且 `quoteAsset == "USDT"` 的行;filters 缺失时对应字段留 `0`(不丢整行 ——
/// 符号选择器只是列出来给人挑,不像下单归一化那样必须拒绝不完整的规则)。
fn compact_perpetual_symbol(symbol: &Value) -> Option<Value> {
    if symbol.get("contractType").and_then(Value::as_str) != Some("PERPETUAL") {
        return None;
    }
    if symbol.get("quoteAsset").and_then(Value::as_str) != Some("USDT") {
        return None;
    }
    let name = symbol.get("symbol").and_then(Value::as_str)?;
    let filters = symbol.get("filters").and_then(Value::as_array).cloned().unwrap_or_default();
    let filter_field = |filter_type: &str, key: &str| -> f64 {
        filters
            .iter()
            .find(|row| row.get("filterType").and_then(Value::as_str) == Some(filter_type))
            .and_then(|row| row.get(key))
            .and_then(f64_of)
            .unwrap_or(0.0)
    };
    let min_notional = {
        let notional = filter_field("MIN_NOTIONAL", "notional");
        if notional > 0.0 { notional } else { filter_field("NOTIONAL", "notional") }
    };
    Some(json!({
        "symbol": name,
        "status": symbol.get("status").and_then(Value::as_str).unwrap_or_default(),
        "price_precision": symbol.get("pricePrecision").and_then(f64_of).unwrap_or(0.0) as u32,
        "qty_precision": symbol.get("quantityPrecision").and_then(f64_of).unwrap_or(0.0) as u32,
        "step_size": decimal_text(filter_field("LOT_SIZE", "stepSize")),
        "tick_size": decimal_text(filter_field("PRICE_FILTER", "tickSize")),
        "min_qty": decimal_text(filter_field("LOT_SIZE", "minQty")),
        "min_notional": decimal_text(min_notional),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_symbol_trims_and_rejects_empty() {
        assert_eq!(required_symbol(&json!({ "symbol": " BTCUSDT " })).unwrap(), "BTCUSDT");
        assert!(required_symbol(&json!({})).is_err());
        assert!(required_symbol(&json!({ "symbol": "" })).is_err());
        assert!(required_symbol(&json!({ "symbol": 1 })).is_err());
    }

    #[test]
    fn optional_symbol_treats_missing_and_empty_as_none() {
        assert_eq!(optional_symbol(&json!({})).unwrap(), None);
        assert_eq!(optional_symbol(&json!({ "symbol": null })).unwrap(), None);
        assert_eq!(optional_symbol(&json!({ "symbol": "" })).unwrap(), None);
        assert_eq!(optional_symbol(&json!({ "symbol": "ethusdt" })).unwrap(), Some("ethusdt".to_owned()));
        assert!(optional_symbol(&json!({ "symbol": 5 })).is_err());
    }

    /// transport_ambiguous 精确映射到 README 的 `ambiguous`;其它 kind 一律 false。
    #[test]
    fn demo_error_ambiguous_flag_matches_transport_only() {
        let transport = DemoError::from(BinanceError::transport("read timeout", true));
        assert_eq!(transport.kind, DemoErrorKind::Transport);
        assert!(transport.ambiguous);

        let rejected = DemoError::from(BinanceError::new(Some(400), Some(-2010), "bad", json!({})));
        assert_eq!(rejected.kind, DemoErrorKind::Rejected);
        assert!(!rejected.ambiguous);

        let unauthorized = DemoError::from(BinanceError::new(Some(401), Some(-2015), "no key", json!({})));
        assert_eq!(unauthorized.kind, DemoErrorKind::Unauthorized);
        assert!(!unauthorized.ambiguous);

        let local = DemoError::local_reject("missing id");
        assert_eq!(local.kind, DemoErrorKind::LocalReject);
        assert!(!local.ambiguous);
    }

    #[test]
    fn to_json_shape_matches_the_protocol() {
        let error = DemoError { kind: DemoErrorKind::RateLimited, message: "慢点".into(), code: Some(-1003), ambiguous: false };
        let value = error.to_json();
        assert_eq!(value["kind"], json!("rate_limited"));
        assert_eq!(value["message"], json!("慢点"));
        assert_eq!(value["code"], json!(-1003));
        assert_eq!(value["ambiguous"], json!(false));
    }
}
