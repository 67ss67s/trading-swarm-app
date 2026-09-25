//! R3:fixtures → Rust 结构 → 再序列化 → canonical 字节相等 + schema 校验;
//! invalid fixtures 必须被 serde 拒绝(少数语义类由 validate() 拒绝)。

mod common;

use contracts_rs::records::{Authorization, ExchangeOrderObservation, ExecEvent, ExecPolicy, ExecutionAttempt, Fill, PositionEffect};
use contracts_rs::rpc::RpcFrame;
use contracts_rs::{AccountSnapshot, ExecutableOrderPlan, Intent, canonical_json};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

/// 解析 → 再序列化为 Value;返回 (Ok(value) | Err(serde 错误))。
fn roundtrip_value<T: DeserializeOwned + Serialize>(text: &str) -> Result<Value, String> {
    let parsed: T = serde_json::from_str(text).map_err(|e| e.to_string())?;
    serde_json::to_value(&parsed).map_err(|e| e.to_string())
}

fn roundtrip_by_dir(dir: &str, text: &str) -> Result<Value, String> {
    match dir {
        "intent" => roundtrip_value::<Intent>(text),
        "plan" => roundtrip_value::<ExecutableOrderPlan>(text),
        "authorization" => roundtrip_value::<Authorization>(text),
        "attempt" => roundtrip_value::<ExecutionAttempt>(text),
        "exchange_order" => roundtrip_value::<ExchangeOrderObservation>(text),
        "fill" => roundtrip_value::<Fill>(text),
        "position_effect" => roundtrip_value::<PositionEffect>(text),
        "account_snapshot" => roundtrip_value::<AccountSnapshot>(text),
        "policy" => roundtrip_value::<ExecPolicy>(text),
        "events" => roundtrip_value::<ExecEvent>(text),
        "rpc" => roundtrip_value::<RpcFrame>(text),
        other => panic!("fixtures 目录 {other} 没有对应的 Rust 类型,补 roundtrip.rs"),
    }
}

/// 语义校验(schema 里的 if/then、const 等 serde 表达不了的部分)。
fn semantic_validate(dir: &str, text: &str) -> Result<(), String> {
    match dir {
        "authorization" => serde_json::from_str::<Authorization>(text).map_err(|e| e.to_string())?.validate(),
        "policy" => serde_json::from_str::<ExecPolicy>(text).map_err(|e| e.to_string())?.main_account.validate(),
        _ => Ok(()),
    }
}

const RECORD_DIRS: &[&str] = &[
    "intent",
    "plan",
    "authorization",
    "attempt",
    "exchange_order",
    "fill",
    "position_effect",
    "account_snapshot",
    "policy",
    "events",
    "rpc",
];

#[test]
fn every_schema_has_a_fixture_dir_or_is_common() {
    let mut names = common::schema_names();
    names.retain(|n| n != "common");
    let mut dirs: Vec<String> = RECORD_DIRS.iter().map(|s| s.to_string()).collect();
    dirs.sort();
    names.sort();
    assert_eq!(names, dirs, "schema 与 fixtures 目录/Rust 类型映射不一致");
}

#[test]
fn valid_fixtures_round_trip_byte_equal_and_schema_valid() {
    let validators = common::all_validators();
    let mut checked = 0;
    for dir in RECORD_DIRS {
        let validator = &validators[*dir];
        for (name, text) in common::fixture_files(dir) {
            let original: Value = serde_json::from_str(&text).unwrap();
            let reserialized = roundtrip_by_dir(dir, &text).unwrap_or_else(|e| panic!("{dir}/{name} 反序列化失败:{e}"));
            assert_eq!(
                canonical_json(&reserialized).unwrap(),
                canonical_json(&original).unwrap(),
                "{dir}/{name} 再序列化后 canonical 不相等"
            );
            let errors = common::schema_errors(validator, &reserialized);
            assert!(errors.is_empty(), "{dir}/{name} Rust 输出不过 schema:\n{}", errors.join("\n"));
            semantic_validate(dir, &text).unwrap_or_else(|e| panic!("{dir}/{name} 语义校验失败:{e}"));
            // 再序列化的文本里不得出现 null(RpcFailure.id 是唯一例外)
            let text_out = reserialized.to_string();
            if !(*dir == "rpc" && name.contains("null_id")) {
                assert!(!text_out.contains(":null"), "{dir}/{name} 输出了 null:{text_out}");
            }
            checked += 1;
        }
    }
    assert!(checked >= 30, "只跑了 {checked} 条,fixtures 是不是没找到");
}

/// serde 对这几条是宽松的(Option 接受 null、if/then、const),由 validate() 兜底。
const SEMANTIC_ONLY: &[&str] = &[
    "intent/null_optional.json",
    "authorization/user_without_confirm_echo.json",
    "policy/withdraw_enabled_true.json",
];

#[test]
fn invalid_fixtures_are_rejected() {
    let validators = common::all_validators();
    let mut checked = 0;
    for dir in RECORD_DIRS {
        let validator = &validators[*dir];
        for (name, text) in common::fixture_files(&format!("invalid/{dir}")) {
            let key = format!("{dir}/{name}");
            let original: Value = serde_json::from_str(&text).unwrap();
            // 原文一定不过 schema(python 仲裁已保证,这里再确认一次 Rust 端的 jsonschema 口径一致)
            assert!(!common::schema_errors(validator, &original).is_empty(), "{key} 原文竟然过了 schema");
            let serde_result = roundtrip_by_dir(dir, &text);
            if SEMANTIC_ONLY.contains(&key.as_str()) {
                if key.ends_with("null_optional.json") {
                    // 宽松接受 null,但输出必须把它去掉并重新合法
                    let v = serde_result.expect("Option 接受 null");
                    assert!(common::schema_errors(validator, &v).is_empty(), "{key} 去 null 后应合法");
                } else {
                    assert!(semantic_validate(dir, &text).is_err(), "{key} 应被 validate() 拒绝");
                }
            } else {
                assert!(serde_result.is_err(), "{key} 应被 serde 拒绝,却得到 {:?}", serde_result.ok());
            }
            checked += 1;
        }
    }
    assert!(checked >= 20, "只跑了 {checked} 条非法语料");
}
