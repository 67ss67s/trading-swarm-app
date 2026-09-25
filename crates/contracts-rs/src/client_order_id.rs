//! clientOrderId 方案(docs/contracts/README.md §5,表 `tables/client_order_id.json`):
//! `tg-{intent12}-{leg_code}{leg_index}-{attempt_no}`,≤36;`tg-` = 本机,其余 = 外部。

use std::sync::OnceLock;

use crate::enums::{Leg, OrderOrigin};
use crate::scalars::{ClientOrderId, ScalarError, Uuid};

const TABLE_JSON: &str = include_str!("../../../packages/contracts/tables/client_order_id.json");

#[derive(Debug, serde::Deserialize)]
pub struct ClientOrderIdTable {
    pub prefix: String,
    pub max_len: usize,
    pub foreign_prefixes: Vec<String>,
    pub leg_codes: std::collections::BTreeMap<String, String>,
    pub examples: Vec<ClientOrderIdExample>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ClientOrderIdExample {
    pub intent_id: Uuid,
    pub leg: Leg,
    pub leg_index: u32,
    pub attempt_no: u32,
    pub client_order_id: ClientOrderId,
}

pub fn table() -> &'static ClientOrderIdTable {
    static TABLE: OnceLock<ClientOrderIdTable> = OnceLock::new();
    TABLE.get_or_init(|| serde_json::from_str(TABLE_JSON).expect("tables/client_order_id.json 合法"))
}

pub const LOCAL_PREFIX: &str = "tg-";

/// 生成本机 clientOrderId。
pub fn client_order_id(intent_id: &Uuid, leg: Leg, leg_index: u32, attempt_no: u32) -> Result<ClientOrderId, ScalarError> {
    let text = format!("{LOCAL_PREFIX}{}-{}{}-{}", intent_id.short12(), leg.code(), leg_index, attempt_no);
    ClientOrderId::new(text)
}

/// 解析出来的本机 id 组成部分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedClientOrderId {
    pub intent12: String,
    pub leg: Leg,
    pub leg_index: u32,
    pub attempt_no: u32,
}

/// 解析本机 id;不是本机格式返回 None。
pub fn parse_local(id: &str) -> Option<ParsedClientOrderId> {
    let rest = id.strip_prefix(LOCAL_PREFIX)?;
    let mut parts = rest.split('-');
    let intent12 = parts.next()?;
    let leg_part = parts.next()?;
    let attempt_part = parts.next()?;
    if parts.next().is_some() || intent12.len() != 12 || !intent12.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        return None;
    }
    let mut chars = leg_part.chars();
    let code = chars.next()?;
    let leg = Leg::ALL.iter().copied().find(|l| l.code() == code)?;
    let leg_index: u32 = chars.as_str().parse().ok()?;
    let attempt_no: u32 = attempt_part.parse().ok()?;
    Some(ParsedClientOrderId { intent12: intent12.to_owned(), leg, leg_index, attempt_no })
}

/// 按前缀判本机/外部。空串或不可判定 → Unknown。
pub fn classify_order_origin(id: Option<&str>) -> OrderOrigin {
    match id {
        None => OrderOrigin::Unknown,
        Some(s) if s.is_empty() => OrderOrigin::Unknown,
        Some(s) if parse_local(s).is_some() => OrderOrigin::Local,
        Some(_) => OrderOrigin::Foreign,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn examples_from_table_round_trip() {
        for ex in &table().examples {
            let id = client_order_id(&ex.intent_id, ex.leg, ex.leg_index, ex.attempt_no).unwrap();
            assert_eq!(id, ex.client_order_id);
            let parsed = parse_local(id.as_str()).unwrap();
            assert_eq!(parsed.leg, ex.leg);
            assert_eq!(parsed.leg_index, ex.leg_index);
            assert_eq!(parsed.attempt_no, ex.attempt_no);
            assert_eq!(parsed.intent12, ex.intent_id.short12());
        }
        assert_eq!(table().prefix, LOCAL_PREFIX);
        assert_eq!(table().max_len, 36);
    }

    #[test]
    fn origin_classification() {
        assert_eq!(classify_order_origin(Some("tg-0f8fad5bd9cb-e0-1")), OrderOrigin::Local);
        assert_eq!(classify_order_origin(Some("ts_abc")), OrderOrigin::Foreign, "8794 的前缀是外部");
        assert_eq!(classify_order_origin(Some("web_abc123")), OrderOrigin::Foreign);
        assert_eq!(classify_order_origin(Some("tg-zz")), OrderOrigin::Foreign, "像本机但解析不出=外部");
        assert_eq!(classify_order_origin(None), OrderOrigin::Unknown);
        assert_eq!(classify_order_origin(Some("")), OrderOrigin::Unknown);
    }

    #[test]
    fn generated_ids_fit_binance_limits() {
        let intent = Uuid::new("0f8fad5b-d9cb-469f-a165-70867728950e").unwrap();
        let id = client_order_id(&intent, Leg::TakeProfit, 3, 999).unwrap();
        assert!(id.as_str().len() <= 36);
        assert_eq!(id.as_str(), "tg-0f8fad5bd9cb-t3-999");
    }
}
