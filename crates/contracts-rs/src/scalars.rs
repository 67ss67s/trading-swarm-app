//! 带校验的字符串标量(对应 `common.json` 里的 Uuid / Decimal / Hash256 / Symbol / Asset / ClientOrderId)。
//!
//! 反序列化时按 schema 的正则口径校验,保证"能进 Rust 结构的值一定过 schema";
//! 序列化是 `transparent`,JSON 形状与 TS 完全一致(就是字符串)。

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

/// 标量校验失败。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{kind} 格式不合法: {value:?}")]
pub struct ScalarError {
    pub kind: &'static str,
    pub value: String,
}

/// unix 毫秒时间戳(schema:整数,0 ≤ v ≤ 2^53-1)。
pub type TimestampMs = i64;

fn is_lower_hex(c: char) -> bool {
    c.is_ascii_digit() || ('a'..='f').contains(&c)
}

fn valid_uuid(s: &str) -> bool {
    let b: Vec<char> = s.chars().collect();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *c != '-' {
                    return false;
                }
            }
            14 => {
                if !('1'..='8').contains(c) {
                    return false;
                }
            }
            19 => {
                if !matches!(c, '8' | '9' | 'a' | 'b') {
                    return false;
                }
            }
            _ => {
                if !is_lower_hex(*c) {
                    return false;
                }
            }
        }
    }
    true
}

/// `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`(`allow_negative=false` 时无 `-`)。
fn valid_decimal(s: &str, allow_negative: bool) -> bool {
    let mut rest = s;
    if let Some(stripped) = rest.strip_prefix('-') {
        if !allow_negative {
            return false;
        }
        rest = stripped;
    }
    let (int_part, frac_part) = match rest.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (rest, None),
    };
    if int_part.is_empty() || !int_part.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if int_part.len() > 1 && int_part.starts_with('0') {
        return false;
    }
    match frac_part {
        Some(f) => !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()),
        None => true,
    }
}

fn valid_hash256(s: &str) -> bool {
    s.len() == 64 && s.chars().all(is_lower_hex)
}

fn valid_symbol(s: &str) -> bool {
    (2..=20).contains(&s.len()) && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn valid_asset(s: &str) -> bool {
    (1..=12).contains(&s.len()) && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn valid_client_order_id(s: &str) -> bool {
    (1..=36).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '/' | '_' | '-'))
}

macro_rules! validated_string {
    ($(#[$meta:meta])* $name:ident, $validator:expr) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ScalarError> {
                let value = value.into();
                if ($validator)(value.as_str()) {
                    Ok(Self(value))
                } else {
                    Err(ScalarError { kind: stringify!($name), value })
                }
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }

            pub fn is_valid(value: &str) -> bool {
                ($validator)(value)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({:?})", stringify!($name), self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl std::str::FromStr for $name {
            type Err = ScalarError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::new(s)
            }
        }

        impl TryFrom<String> for $name {
            type Error = ScalarError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = ScalarError;
            fn try_from(value: &str) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }
    };
}

validated_string!(
    /// 小写 UUID(v1-v8,变体 8/9/a/b)。
    Uuid,
    valid_uuid
);
validated_string!(
    /// 十进制字符串,可带负号;不用 float。
    Decimal,
    |s: &str| valid_decimal(s, true)
);
validated_string!(
    /// 非负十进制字符串。
    UnsignedDecimal,
    |s: &str| valid_decimal(s, false)
);
validated_string!(
    /// sha256 小写 hex。
    Hash256,
    valid_hash256
);
validated_string!(
    /// 交易所符号,如 BTCUSDT。
    Symbol,
    valid_symbol
);
validated_string!(
    /// 资产名,如 USDT。
    Asset,
    valid_asset
);
validated_string!(
    /// Binance 允许的 clientOrderId 字符集,≤36。
    ClientOrderId,
    valid_client_order_id
);

impl Uuid {
    /// clientOrderId 用的 `intent12`:去掉连字符后的前 12 个 hex。
    pub fn short12(&self) -> String {
        self.0.chars().filter(|c| *c != '-').take(12).collect()
    }
}

impl From<Decimal> for String {
    fn from(value: Decimal) -> Self {
        value.0
    }
}

impl From<UnsignedDecimal> for Decimal {
    fn from(value: UnsignedDecimal) -> Self {
        Decimal(value.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_rules() {
        assert!(Uuid::is_valid("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!Uuid::is_valid("0F8FAD5B-D9CB-469F-A165-70867728950E"), "大写拒");
        assert!(!Uuid::is_valid("0f8fad5b-d9cb-069f-a165-70867728950e"), "version 0 拒");
        assert!(!Uuid::is_valid("0f8fad5b-d9cb-469f-c165-70867728950e"), "变体 c 拒");
        assert_eq!(Uuid::new("0f8fad5b-d9cb-469f-a165-70867728950e").unwrap().short12(), "0f8fad5bd9cb");
    }

    #[test]
    fn decimal_rules() {
        for ok in ["0", "1", "10", "0.5", "60000.5", "0.01200010", "-12.5", "-0"] {
            assert!(Decimal::is_valid(ok), "{ok}");
        }
        for bad in ["", " 1", "1 ", "01", "1.", ".5", "1e3", "+1", "1,5", "Infinity", "NaN", "--1"] {
            assert!(!Decimal::is_valid(bad), "{bad}");
        }
        assert!(!UnsignedDecimal::is_valid("-1"));
        assert!(UnsignedDecimal::is_valid("0.002"));
    }

    #[test]
    fn other_scalars() {
        assert!(Hash256::is_valid(&"a".repeat(64)));
        assert!(!Hash256::is_valid(&"A".repeat(64)));
        assert!(!Hash256::is_valid(&"a".repeat(63)));
        assert!(Symbol::is_valid("BTCUSDT"));
        assert!(!Symbol::is_valid("btcusdt"));
        assert!(!Symbol::is_valid("B"));
        assert!(Asset::is_valid("USDT"));
        assert!(!Asset::is_valid("usdt"));
        assert!(ClientOrderId::is_valid("tg-0f8fad5bd9cb-e0-1"));
        assert!(ClientOrderId::is_valid("web_abc123"));
        assert!(!ClientOrderId::is_valid(""));
        assert!(!ClientOrderId::is_valid(&"x".repeat(37)));
        assert!(!ClientOrderId::is_valid("has space"));
    }

    #[test]
    fn serde_transparent_and_validating() {
        let d: Decimal = serde_json::from_str("\"60000.5\"").unwrap();
        assert_eq!(serde_json::to_string(&d).unwrap(), "\"60000.5\"");
        assert!(serde_json::from_str::<Decimal>("60000.5").is_err(), "数字不是字符串");
        assert!(serde_json::from_str::<Decimal>("\"1e3\"").is_err());
        let printed = format!("{:?}", d);
        assert_eq!(printed, "Decimal(\"60000.5\")");
    }
}
