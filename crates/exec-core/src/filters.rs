//! `exchangeInfo` filters 归一化:数量/价格向下取整、最小量/最小名义校验、分档配额。
//!
//! 来源:8794 `binance.rs` 的 `SymbolRules` / `parse_symbol_rules` / `allocate_lots` /
//! `decimal_text` / `rounded_decimal`。
//!
//! 改写点:
//! - `SymbolRules` 补上 `max_qty` / `price_precision` / `qty_precision`(8794 只存四个字段,
//!   精度信息散在 `symbol_rows_from_exchange_info` 里);
//! - `validate` 返回 [`BinanceError`](crate::BinanceError) 的 `LocalReject`(8794 返回
//!   一个没有类别的 `Api` 错误,上层只能 grep 文案);
//! - 序列化时数量/价格按仓库约定输出**十进制字符串**,反序列化两种都吃。

use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::error::BinanceError;

/// 最短往返表示。
///
/// 8794 R36 实测回归:`{:.12}` 会把 `44937.9` 打成 `44937.900000000001`,
/// 币安按参数小数位判 **-1111** 拒单。只有未规范化的浮点尾巴(小数位 > 12)
/// 或科学计数法才退回 12 位截断。
pub fn decimal_text(value: f64) -> String {
    let shortest = format!("{value}");
    let needs_fallback = shortest.contains(['e', 'E'])
        || shortest.split_once('.').is_some_and(|(_, fraction)| fraction.len() > 12);
    if !needs_fallback {
        return shortest;
    }
    let text = format!("{value:.12}");
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() { "0".to_owned() } else { trimmed.to_owned() }
}

fn serialize_decimal<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&decimal_text(*value))
}

fn deserialize_decimal<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    f64_of(&value).ok_or_else(|| serde::de::Error::custom(format!("不是十进制数值:{value}")))
}

/// 币安报文里的数字既可能是字符串也可能是数字,一律吃。
pub fn f64_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn f64_at(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(f64_of)
}

/// 一个交易对的下单约束。数量/价格用 `f64` 做算术,对外序列化成十进制字符串。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SymbolRules {
    #[serde(serialize_with = "serialize_decimal", deserialize_with = "deserialize_decimal")]
    pub tick_size: f64,
    #[serde(serialize_with = "serialize_decimal", deserialize_with = "deserialize_decimal")]
    pub step_size: f64,
    #[serde(serialize_with = "serialize_decimal", deserialize_with = "deserialize_decimal")]
    pub min_qty: f64,
    #[serde(serialize_with = "serialize_decimal", deserialize_with = "deserialize_decimal")]
    pub max_qty: f64,
    #[serde(serialize_with = "serialize_decimal", deserialize_with = "deserialize_decimal")]
    pub min_notional: f64,
    pub price_precision: u32,
    pub qty_precision: u32,
}

impl SymbolRules {
    /// 数量 → 整数手数(向下取整;`1e-10` 是抵消 `12.39/0.1 = 123.89999…` 这类
    /// 二进制表示误差的容差,不是"多给一手")。
    pub fn quantity_lots(&self, quantity: f64) -> u64 {
        if !quantity.is_finite() || quantity <= 0.0 || self.step_size <= 0.0 {
            return 0;
        }
        ((quantity / self.step_size) + 1e-10).floor().max(0.0) as u64
    }

    pub fn quantity_from_lots(&self, lots: u64) -> f64 {
        rounded_decimal(lots as f64 * self.step_size, self.step_size)
    }

    /// 向下取整到 `step_size`。
    pub fn normalize_quantity(&self, quantity: f64) -> f64 {
        self.quantity_from_lots(self.quantity_lots(quantity))
    }

    /// 向下取整到 `tick_size`。
    pub fn normalize_price(&self, price: f64) -> f64 {
        if !price.is_finite() || price <= 0.0 || self.tick_size <= 0.0 {
            return 0.0;
        }
        let ticks = ((price / self.tick_size) + 1e-10).floor() as u64;
        rounded_decimal(ticks as f64 * self.tick_size, self.tick_size)
    }

    /// 归一化后的数量/价格是否可提交。**发送前拦下来**比吃一个 -1111/-4164 强。
    pub fn validate(&self, quantity: f64, price: Option<f64>) -> Result<(), BinanceError> {
        if quantity + 1e-12 < self.min_qty {
            return Err(BinanceError::local_reject(
                "min_qty",
                format!(
                    "下单数量向下取整后为 {},低于交易所最小数量 {};请增大金额或减少分档",
                    decimal_text(quantity),
                    decimal_text(self.min_qty)
                ),
            ));
        }
        if self.max_qty > 0.0 && quantity > self.max_qty + 1e-12 {
            return Err(BinanceError::local_reject(
                "max_qty",
                format!(
                    "下单数量 {} 超过交易所单笔上限 {};请拆单",
                    decimal_text(quantity),
                    decimal_text(self.max_qty)
                ),
            ));
        }
        if let Some(price) = price.filter(|value| *value > 0.0) {
            let notional = quantity * price;
            if self.min_notional > 0.0 && notional + 1e-10 < self.min_notional {
                return Err(BinanceError::local_reject(
                    "min_notional",
                    format!(
                        "下单名义价值 {} 低于交易所最小名义价值 {};请增大金额或减少分档",
                        decimal_text(notional),
                        decimal_text(self.min_notional)
                    ),
                ));
            }
        }
        Ok(())
    }
}

/// 把父单手数按百分比分档,**手数守恒**:最后一档吃掉全部余数,零档保持零。
pub fn allocate_lots(parent_lots: u64, percents: &[f64]) -> Vec<u64> {
    if percents.is_empty() {
        return Vec::new();
    }
    let total = percents.iter().copied().filter(|value| *value > 0.0).sum::<f64>();
    if total <= 0.0 {
        return vec![0; percents.len()];
    }
    let mut allocated = 0u64;
    let mut result = Vec::with_capacity(percents.len());
    for (index, percent) in percents.iter().enumerate() {
        let lots = if index + 1 == percents.len() {
            parent_lots.saturating_sub(allocated)
        } else {
            ((parent_lots as f64 * percent.max(0.0) / total) + 1e-10).floor() as u64
        };
        allocated = allocated.saturating_add(lots);
        result.push(lots);
    }
    debug_assert_eq!(result.iter().sum::<u64>(), parent_lots);
    result
}

fn rounded_decimal(value: f64, quantum: f64) -> f64 {
    let decimals = format!("{quantum:.12}")
        .trim_end_matches('0')
        .split_once('.')
        .map(|(_, fraction)| fraction.len() as i32)
        .unwrap_or(0);
    let factor = 10f64.powi(decimals);
    (value * factor).round() / factor
}

/// 交易对符号归一:`BTC/USDT` / `btc-usdt` → `BTCUSDT`。
pub fn exchange_symbol(symbol: &str) -> String {
    symbol.replace(['/', '-'], "").to_ascii_uppercase()
}

/// `GET /fapi/v1/exchangeInfo` → 每个交易对的 [`SymbolRules`]。
///
/// 只收 `step_size`/`tick_size`/`min_qty` 三者都为正的行 —— 缺任何一个都无法安全
/// 归一化,宁可让上层报「没有规则」也不要用 0 去除。
pub fn parse_symbol_rules(info: &Value) -> HashMap<String, SymbolRules> {
    let mut result = HashMap::new();
    for symbol in info.get("symbols").and_then(Value::as_array).cloned().unwrap_or_default() {
        let filters: HashMap<String, Value> = symbol
            .get("filters")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|row| {
                        (row.get("filterType").and_then(Value::as_str).unwrap_or_default().to_owned(), row.clone())
                    })
                    .collect()
            })
            .unwrap_or_default();
        let empty = Value::Object(Default::default());
        let lot = filters.get("LOT_SIZE").unwrap_or(&empty);
        let price = filters.get("PRICE_FILTER").unwrap_or(&empty);
        let notional = filters.get("MIN_NOTIONAL").or_else(|| filters.get("NOTIONAL")).unwrap_or(&empty);
        let rules = SymbolRules {
            step_size: f64_at(lot, "stepSize").unwrap_or(0.0),
            tick_size: f64_at(price, "tickSize").unwrap_or(0.0),
            min_qty: f64_at(lot, "minQty").unwrap_or(0.0),
            max_qty: f64_at(lot, "maxQty").unwrap_or(0.0),
            min_notional: f64_at(notional, "notional")
                .or_else(|| f64_at(notional, "minNotional"))
                .unwrap_or(0.0),
            price_precision: f64_at(&symbol, "pricePrecision").unwrap_or(0.0) as u32,
            qty_precision: f64_at(&symbol, "quantityPrecision").unwrap_or(0.0) as u32,
        };
        if rules.step_size > 0.0 && rules.tick_size > 0.0 && rules.min_qty > 0.0 {
            let key = symbol.get("symbol").and_then(Value::as_str).unwrap_or_default();
            if !key.is_empty() {
                result.insert(exchange_symbol(key), rules);
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 8794 R36 矩阵 A 实测回归:大数带小数不得暴露浮点尾巴
    /// (旧 `{:.12}` 打成 `44937.900000000001` → 币安 -1111)。
    #[test]
    fn decimal_text_never_leaks_float_tails() {
        assert_eq!(decimal_text(0.0031), "0.0031");
        assert_eq!(decimal_text(95000.0), "95000");
        assert_eq!(decimal_text(0.1 + 0.2), "0.3");
        assert_eq!(decimal_text(44937.9), "44937.9");
        assert_eq!(decimal_text(41728.1), "41728.1");
        assert_eq!(decimal_text(30814.6), "30814.6");
        assert_eq!(decimal_text(0.0), "0");
        // 科学计数法必须展开成币安能解析的十进制
        assert_eq!(decimal_text(1e-9), "0.000000001");
        assert!(!decimal_text(1.0 / 3.0).contains('e'));
    }

    #[test]
    fn exchange_info_rules_normalize_dynamic_quantity_and_price() {
        let rules = parse_symbol_rules(&json!({
            "symbols": [
                { "symbol": "XRPUSDT", "pricePrecision": 4, "quantityPrecision": 1, "filters": [
                    { "filterType": "LOT_SIZE", "stepSize": "0.1", "minQty": "0.1", "maxQty": "10000" },
                    { "filterType": "PRICE_FILTER", "tickSize": "0.0001" },
                    { "filterType": "MIN_NOTIONAL", "notional": "5" }
                ]},
                { "symbol": "SOLUSDT", "pricePrecision": 2, "quantityPrecision": 2, "filters": [
                    { "filterType": "LOT_SIZE", "stepSize": "0.01", "minQty": "0.01", "maxQty": "1000" },
                    { "filterType": "PRICE_FILTER", "tickSize": "0.01" }
                ]},
                // 缺 tickSize:无法安全归一化 → 整行丢弃,不许用 0 去除
                { "symbol": "BROKENUSDT", "filters": [
                    { "filterType": "LOT_SIZE", "stepSize": "1", "minQty": "1" }
                ]}
            ]
        }));
        let xrp = &rules["XRPUSDT"];
        assert_eq!(xrp.normalize_quantity(12.39), 12.3);
        assert_eq!(xrp.normalize_price(0.51239), 0.5123);
        assert_eq!(xrp.min_notional, 5.0);
        assert_eq!(xrp.max_qty, 10000.0);
        assert_eq!(xrp.price_precision, 4);
        assert_eq!(xrp.qty_precision, 1);
        assert_eq!(rules["SOLUSDT"].normalize_quantity(0.159), 0.15);
        assert!(!rules.contains_key("BROKENUSDT"));
    }

    #[test]
    fn too_small_quantity_and_notional_are_rejected_without_raise() {
        let rules = SymbolRules {
            step_size: 0.001,
            tick_size: 0.1,
            min_qty: 0.001,
            max_qty: 1000.0,
            min_notional: 100.0,
            price_precision: 1,
            qty_precision: 3,
        };
        let quantity = rules.normalize_quantity(0.0009);
        assert_eq!(quantity, 0.0);
        let too_small = rules.validate(quantity, Some(95_000.0)).unwrap_err();
        assert_eq!(too_small.local_reject_kind(), Some("min_qty"));
        let below_notional = rules.validate(0.001, Some(95_000.0)).unwrap_err();
        assert_eq!(below_notional.local_reject_kind(), Some("min_notional"));
        let too_big = rules.validate(1001.0, None).unwrap_err();
        assert_eq!(too_big.local_reject_kind(), Some("max_qty"));
        rules.validate(0.002, Some(95_000.0)).expect("0.002 × 95000 = 190 ≥ 100");
    }

    #[test]
    fn parent_lots_are_conserved_and_zero_tiers_stay_zero() {
        let lots = allocate_lots(1, &[50.0, 50.0]);
        assert_eq!(lots, vec![0, 1]);
        assert_eq!(allocate_lots(7, &[30.0, 30.0, 40.0]).iter().sum::<u64>(), 7);
        assert_eq!(allocate_lots(7, &[50.0, 0.0, 50.0]), vec![3, 0, 4]);
        assert_eq!(allocate_lots(10, &[]), Vec::<u64>::new());
        assert_eq!(allocate_lots(10, &[0.0, 0.0]), vec![0, 0]);
    }

    #[test]
    fn symbol_normalization_accepts_the_shapes_the_ui_sends() {
        assert_eq!(exchange_symbol("BTC/USDT"), "BTCUSDT");
        assert_eq!(exchange_symbol("btc-usdt"), "BTCUSDT");
        assert_eq!(exchange_symbol("ETHUSDT"), "ETHUSDT");
    }

    /// 仓库约定:对外结构里数量/价格是十进制字符串。
    #[test]
    fn rules_serialize_as_decimal_strings_and_round_trip() {
        let rules = SymbolRules {
            step_size: 0.001,
            tick_size: 0.1,
            min_qty: 0.001,
            max_qty: 1000.0,
            min_notional: 5.0,
            price_precision: 1,
            qty_precision: 3,
        };
        let text = serde_json::to_string(&rules).expect("serialize");
        assert!(text.contains(r#""step_size":"0.001""#), "{text}");
        assert!(text.contains(r#""min_notional":"5""#), "{text}");
        assert!(text.contains(r#""price_precision":1"#), "{text}");
        assert_eq!(serde_json::from_str::<SymbolRules>(&text).expect("round trip"), rules);
        // 数字形式也要吃(币安 exchangeInfo 两种都出现过)
        let from_numbers: SymbolRules = serde_json::from_value(json!({
            "tick_size": 0.1, "step_size": 0.001, "min_qty": 0.001,
            "max_qty": 1000, "min_notional": 5, "price_precision": 1, "qty_precision": 3
        }))
        .expect("numeric form");
        assert_eq!(from_numbers, rules);
    }
}
