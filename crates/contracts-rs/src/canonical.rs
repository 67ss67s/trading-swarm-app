//! canonical_json 与三个哈希(docs/contracts/README.md §3)。
//!
//! 规则:①递归删除对象中值为 null 的成员;②对象 key 码位升序(`serde_json::Map` 默认是
//! `BTreeMap`,天然有序——本 crate **不能**开 `preserve_order` feature);③紧凑输出;
//! ④非 ASCII 不转义(serde_json 默认如此);⑤不允许浮点数(金额一律字符串)。

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::plan::PlanEconomics;
use crate::scalars::Hash256;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CanonicalError {
    #[error("canonical json 不允许浮点数(路径 {0});金额请用十进制字符串")]
    FloatNotAllowed(String),
    #[error("序列化失败:{0}")]
    Serialize(String),
}

/// 递归删 null 成员、检查浮点。返回的 `Value` 用 `to_string` 即为 canonical 形式。
pub fn canonicalize(value: &Value) -> Result<Value, CanonicalError> {
    fn walk(value: &Value, path: &mut Vec<String>) -> Result<Value, CanonicalError> {
        match value {
            Value::Object(map) => {
                let mut out = serde_json::Map::new();
                for (k, v) in map {
                    if v.is_null() {
                        continue;
                    }
                    path.push(k.clone());
                    let child = walk(v, path)?;
                    path.pop();
                    out.insert(k.clone(), child);
                }
                Ok(Value::Object(out))
            }
            Value::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    path.push(i.to_string());
                    out.push(walk(item, path)?);
                    path.pop();
                }
                Ok(Value::Array(out))
            }
            Value::Number(n) if !n.is_i64() && !n.is_u64() => {
                Err(CanonicalError::FloatNotAllowed(path.join("/")))
            }
            other => Ok(other.clone()),
        }
    }
    let mut path = Vec::new();
    walk(value, &mut path)
}

pub fn canonical_json(value: &Value) -> Result<String, CanonicalError> {
    Ok(canonicalize(value)?.to_string())
}

/// 任意可序列化对象的 canonical 字符串。
pub fn canonical_json_of<T: Serialize>(value: &T) -> Result<String, CanonicalError> {
    let v = serde_json::to_value(value).map_err(|e| CanonicalError::Serialize(e.to_string()))?;
    canonical_json(&v)
}

pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// `plan_hash = sha256_hex(canonical_json(plan.economic))`。
pub fn plan_hash(economic: &PlanEconomics) -> Result<Hash256, CanonicalError> {
    let text = canonical_json_of(economic)?;
    Ok(Hash256::new(sha256_hex(&text)).expect("sha256 hex 必然合法"))
}

/// `account_version = sha256_hex(canonical_json({balances, positions, open_orders, position_mode}))`,
/// 四个参数是对应组件的 `data`(任一缺失 → None,快照不能是 consistent)。
pub fn account_version<B: Serialize, P: Serialize, O: Serialize, M: Serialize>(
    balances: Option<&B>,
    positions: Option<&P>,
    open_orders: Option<&O>,
    position_mode: Option<&M>,
) -> Result<Option<Hash256>, CanonicalError> {
    let (Some(b), Some(p), Some(o), Some(m)) = (balances, positions, open_orders, position_mode) else {
        return Ok(None);
    };
    let to_value = |x: &dyn erased::ErasedSerialize| x.to_json();
    let v = serde_json::json!({
        "balances": to_value(&b),
        "positions": to_value(&p),
        "open_orders": to_value(&o),
        "position_mode": to_value(&m),
    });
    let text = canonical_json(&v)?;
    Ok(Some(Hash256::new(sha256_hex(&text)).expect("sha256 hex 必然合法")))
}

/// 直接由 [`crate::account_snapshot::AccountSnapshot`] 的组件算 account_version。
pub fn account_version_of(
    snapshot: &crate::account_snapshot::AccountSnapshot,
) -> Result<Option<Hash256>, CanonicalError> {
    let c = &snapshot.components;
    account_version(
        c.balances.data.as_ref(),
        c.positions.data.as_ref(),
        c.open_orders.data.as_ref(),
        c.position_mode.data.as_ref(),
    )
}

/// 小工具:把泛型 Serialize 擦成 Value(避免为 account_version 写四套泛型分支)。
mod erased {
    use serde::Serialize;
    use serde_json::Value;

    pub trait ErasedSerialize {
        fn to_json(&self) -> Value;
    }

    impl<T: Serialize> ErasedSerialize for T {
        fn to_json(&self) -> Value {
            serde_json::to_value(self).unwrap_or(Value::Null)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_nulls_sorts_keys_compact_and_keeps_unicode() {
        let v = json!({"b": 1, "a": {"z": null, "y": [1, {"k": null, "j": "注释-☃"}]}, "c": null});
        assert_eq!(canonical_json(&v).unwrap(), r#"{"a":{"y":[1,{"j":"注释-☃"}]},"b":1}"#);
    }

    #[test]
    fn floats_are_rejected_with_path() {
        let v = json!({"x": {"qty": 0.002}});
        assert_eq!(
            canonical_json(&v).unwrap_err(),
            CanonicalError::FloatNotAllowed("x/qty".into())
        );
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
