//! 枚举对拍:`common.json` 每个枚举的每个值都能反序列化进对应 Rust 枚举,且变体数相等;
//! `events.json` 的 EventName、`rpc.json` 的 Method 同理。

use contracts_rs::enums::*;
use contracts_rs::records::EventName;
use contracts_rs::rpc::Method;
use serde_json::Value;

fn common_defs() -> Value {
    serde_json::from_str(&std::fs::read_to_string(contracts_rs::contracts_dir().join("schema/common.json")).unwrap()).unwrap()
}

fn enum_values(doc: &Value, pointer: &str) -> Vec<String> {
    doc.pointer(pointer)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("缺枚举 {pointer}"))
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

macro_rules! check_enum {
    ($doc:expr, $ty:ty, $def:literal) => {{
        let values = enum_values(&$doc, concat!("/$defs/", $def, "/enum"));
        assert_eq!(values.len(), <$ty>::ALL.len(), "{} 变体数 != schema 值数", $def);
        for v in &values {
            let parsed: $ty = serde_json::from_value(Value::String(v.clone()))
                .unwrap_or_else(|e| panic!("{}: {v:?} 反序列化失败 {e}", $def));
            assert_eq!(parsed.as_str(), v, "{}: as_str 与 JSON 值不一致", $def);
            assert!(<$ty>::ALL.contains(&parsed));
        }
        // 顺序也一致(便于 UI 与文档)
        let ours: Vec<&str> = <$ty>::ALL.iter().map(|x| x.as_str()).collect();
        assert_eq!(ours, values.iter().map(String::as_str).collect::<Vec<_>>(), "{} 顺序不一致", $def);
    }};
}

#[test]
fn every_common_enum_matches() {
    let doc = common_defs();
    check_enum!(doc, AccountRef, "AccountRef");
    check_enum!(doc, Channel, "Channel");
    check_enum!(doc, ObservationSource, "ObservationSource");
    check_enum!(doc, Product, "Product");
    check_enum!(doc, Side, "Side");
    check_enum!(doc, PositionSide, "PositionSide");
    check_enum!(doc, PositionMode, "PositionMode");
    check_enum!(doc, MarginType, "MarginType");
    check_enum!(doc, OrderType, "OrderType");
    check_enum!(doc, TimeInForce, "TimeInForce");
    check_enum!(doc, WorkingType, "WorkingType");
    check_enum!(doc, Wallet, "Wallet");
    check_enum!(doc, Principal, "Principal");
    check_enum!(doc, Surface, "Surface");
    check_enum!(doc, IntentKind, "IntentKind");
    check_enum!(doc, IntentStatus, "IntentStatus");
    check_enum!(doc, AuthorizationStatus, "AuthorizationStatus");
    check_enum!(doc, AttemptStage, "AttemptStage");
    check_enum!(doc, AttemptResult, "AttemptResult");
    check_enum!(doc, ExchangeOrderStatus, "ExchangeOrderStatus");
    check_enum!(doc, EffectStatus, "EffectStatus");
    check_enum!(doc, Leg, "Leg");
    check_enum!(doc, OrderOrigin, "OrderOrigin");
    check_enum!(doc, Completeness, "Completeness");
    check_enum!(doc, Consistency, "Consistency");
    check_enum!(doc, PolicyMode, "PolicyMode");
    check_enum!(doc, Authority, "Authority");
    check_enum!(doc, ErrorKind, "ErrorKind");
}

#[test]
fn no_common_enum_is_forgotten() {
    // common.json 里每个带 enum 的 $def 都必须出现在上面的清单里(防止 schema 新增枚举而 Rust 没跟)。
    let doc = common_defs();
    let mut named: Vec<String> = doc["$defs"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, v)| v.get("enum").is_some())
        .map(|(k, _)| k.clone())
        .collect();
    named.sort();
    let covered = [
        "AccountRef", "Channel", "ObservationSource", "Product", "Side", "PositionSide", "PositionMode", "MarginType",
        "OrderType", "TimeInForce", "WorkingType", "Wallet", "Principal", "Surface", "IntentKind", "IntentStatus",
        "AuthorizationStatus", "AttemptStage", "AttemptResult", "ExchangeOrderStatus", "EffectStatus", "Leg",
        "OrderOrigin", "Completeness", "Consistency", "PolicyMode", "Authority", "ErrorKind",
    ];
    let mut covered: Vec<String> = covered.iter().map(|s| s.to_string()).collect();
    covered.sort();
    assert_eq!(named, covered, "common.json 的枚举清单变了,补 Rust 枚举与本测试");
}

#[test]
fn event_names_and_methods_match_their_schemas() {
    let events: Value = serde_json::from_str(&std::fs::read_to_string(contracts_rs::contracts_dir().join("schema/events.json")).unwrap()).unwrap();
    let values = enum_values(&events, "/$defs/EventName/enum");
    assert_eq!(values.len(), EventName::ALL.len(), "EventName 变体数");
    for v in &values {
        let parsed: EventName = serde_json::from_value(Value::String(v.clone())).unwrap_or_else(|e| panic!("{v}: {e}"));
        assert_eq!(parsed.as_str(), v);
    }
    let rpc: Value = serde_json::from_str(&std::fs::read_to_string(contracts_rs::contracts_dir().join("schema/rpc.json")).unwrap()).unwrap();
    let values = enum_values(&rpc, "/$defs/Method/enum");
    assert_eq!(values.len(), Method::ALL.len(), "Method 变体数");
    for v in &values {
        let parsed: Method = serde_json::from_value(Value::String(v.clone())).unwrap_or_else(|e| panic!("{v}: {e}"));
        assert_eq!(parsed.as_str(), v);
    }
}
