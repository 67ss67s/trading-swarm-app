//! `tables/error_codes.json`:ErrorKind ↔ JSON-RPC error.code。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use crate::enums::ErrorKind;

const TABLE_JSON: &str = include_str!("../../../packages/contracts/tables/error_codes.json");

#[derive(Debug, serde::Deserialize)]
pub struct ErrorCodeTable {
    pub jsonrpc: BTreeMap<String, i64>,
    pub kinds: BTreeMap<String, i64>,
    pub retryable_default: BTreeMap<String, bool>,
}

pub fn table() -> &'static ErrorCodeTable {
    static TABLE: OnceLock<ErrorCodeTable> = OnceLock::new();
    TABLE.get_or_init(|| serde_json::from_str(TABLE_JSON).expect("tables/error_codes.json 合法"))
}

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

impl ErrorKind {
    /// JSON-RPC error.code。
    pub fn code(self) -> i64 {
        *table().kinds.get(self.as_str()).unwrap_or_else(|| panic!("error_codes.json 缺 {}", self.as_str()))
    }

    /// 由 code 反查(标准 JSON-RPC 码也映射:-32602→invalid_params,其余标准码→internal)。
    pub fn from_code(code: i64) -> Option<ErrorKind> {
        if let Some((k, _)) = table().kinds.iter().find(|(_, c)| **c == code) {
            return ErrorKind::parse(k);
        }
        match code {
            PARSE_ERROR | INVALID_REQUEST | METHOD_NOT_FOUND => Some(ErrorKind::InvalidParams),
            INTERNAL_ERROR => Some(ErrorKind::Internal),
            _ => None,
        }
    }

    pub fn retryable_default(self) -> bool {
        *table().retryable_default.get(self.as_str()).unwrap_or(&false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_has_a_code_and_codes_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for kind in ErrorKind::ALL {
            let code = kind.code();
            assert!(seen.insert(code), "code {code} 重复");
            assert_eq!(ErrorKind::from_code(code), Some(*kind));
            let _ = kind.retryable_default();
        }
        assert_eq!(table().kinds.len(), ErrorKind::ALL.len(), "表里有 schema 之外的 kind");
        assert_eq!(ErrorKind::InvalidParams.code(), INVALID_PARAMS);
        assert_eq!(ErrorKind::Internal.code(), INTERNAL_ERROR);
        assert_eq!(ErrorKind::from_code(PARSE_ERROR), Some(ErrorKind::InvalidParams));
        assert!(ErrorKind::Stale.retryable_default());
        assert!(!ErrorKind::Conflict.retryable_default());
    }
}
