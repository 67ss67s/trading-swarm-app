//! confirm_fields(docs/contracts/README.md §4,表 `tables/confirm_fields.json`)。
//!
//! 审批面必须逐字回填的 `Map<String,String>`;execd 在 authorize 时与这里派生的 map 逐字比对。
//! 值转字符串规则:缺省不出现;布尔 `true/false`;整数十进制;字符串原样;数组/对象写 canonical_json。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde_json::Value;

use crate::canonical::{canonical_json, CanonicalError};
use crate::plan::ExecutableOrderPlan;

const CONFIRM_FIELDS_JSON: &str = include_str!("../../../packages/contracts/tables/confirm_fields.json");

#[derive(Debug, serde::Deserialize)]
struct ConfirmTable {
    always: Vec<String>,
    by_kind: BTreeMap<String, Vec<String>>,
}

fn table() -> &'static ConfirmTable {
    static TABLE: OnceLock<ConfirmTable> = OnceLock::new();
    TABLE.get_or_init(|| serde_json::from_str(CONFIRM_FIELDS_JSON).expect("tables/confirm_fields.json 合法"))
}

/// 表里某个 kind 的字段列表(测试与 UI 用)。
pub fn fields_for_kind(kind: &str) -> Option<&'static [String]> {
    table().by_kind.get(kind).map(Vec::as_slice)
}

pub fn always_fields() -> &'static [String] {
    table().always.as_slice()
}

fn scalar_text(value: &Value) -> Result<Option<String>, CanonicalError> {
    Ok(match value {
        Value::Null => None,
        Value::Bool(b) => Some(if *b { "true".into() } else { "false".into() }),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        Value::Array(_) | Value::Object(_) => Some(canonical_json(value)?),
    })
}

/// 由 plan 派生 confirm_fields。
pub fn confirm_fields(plan: &ExecutableOrderPlan) -> Result<BTreeMap<String, String>, CanonicalError> {
    let economic = serde_json::to_value(&plan.economic).map_err(|e| CanonicalError::Serialize(e.to_string()))?;
    let kind = plan.economic.kind_str();
    let mut out = BTreeMap::new();
    for field in always_fields() {
        if field == "plan_hash" {
            out.insert(field.clone(), plan.plan_hash.as_str().to_owned());
        }
    }
    if let Some(fields) = fields_for_kind(kind) {
        for field in fields {
            if let Some(value) = economic.get(field)
                && let Some(text) = scalar_text(value)?
            {
                out.insert(field.clone(), text);
            }
        }
    }
    Ok(out)
}

/// 逐字比对回填(多字段、少字段、任何差异都算不匹配),返回差异描述。
pub fn confirm_echo_matches(
    expected: &BTreeMap<String, String>,
    echo: &BTreeMap<String, String>,
) -> Result<(), Vec<String>> {
    let mut diffs = Vec::new();
    for (k, v) in expected {
        match echo.get(k) {
            None => diffs.push(format!("缺少字段 {k}")),
            Some(got) if got != v => diffs.push(format!("字段 {k} 不一致:期望 {v:?},回填 {got:?}")),
            _ => {}
        }
    }
    for k in echo.keys() {
        if !expected.contains_key(k) {
            diffs.push(format!("多出字段 {k}"));
        }
    }
    if diffs.is_empty() { Ok(()) } else { Err(diffs) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_loads_and_has_all_kinds() {
        for kind in ["order", "protect", "cancel", "transfer"] {
            assert!(fields_for_kind(kind).is_some(), "{kind}");
        }
        assert_eq!(always_fields(), &["plan_hash".to_string()]);
    }

    #[test]
    fn echo_diff_reports_missing_extra_and_mismatch() {
        let expected: BTreeMap<String, String> = [("a", "1"), ("b", "2")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        let echo: BTreeMap<String, String> = [("a", "1"), ("c", "3")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        let diffs = confirm_echo_matches(&expected, &echo).unwrap_err();
        assert_eq!(diffs, vec!["缺少字段 b".to_string(), "多出字段 c".to_string()]);
        assert!(confirm_echo_matches(&expected, &expected).is_ok());
    }
}
