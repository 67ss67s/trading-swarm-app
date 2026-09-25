//! `clientOrderId` 生成与识别 —— **订单身份的唯一机制**。
//!
//! 设计 §12:发送状态未知时,对账**只认 `clientOrderId`**(快照差分不是身份机制)。
//! 所以这个 id 必须在调用前持久化、必须能反查、必须能区分本机与外部写者。
//!
//! 格式:`tg-<intent_id 前 12 位 hex>-<leg>-<attempt>`,总长 ≤ 36,
//! 满足币安的 `^[\.A-Z\:/a-z0-9_-]{1,36}$`。
//!
//! 来源:8794 `binance.rs::client_order_id`(前缀 `ts_` + 字符净化 + 截 36)。
//! 改写点:8794 只做「前缀 + 净化」,**没有结构**——出了事只能靠前缀判本机/外部;
//! 这里把 intent / 腿 / 重试次数编进去,让对账能从交易所回执反推是哪一次尝试。

use std::fmt;

/// 本仓库产生的订单前缀。
pub const LOCAL_PREFIX: &str = "tg-";

/// 8794(trade-switch 控制台)的前缀。同账户上看到它 = 另一个写者在动这个账户。
pub const TRADE_SWITCH_PREFIX: &str = "ts_";

/// 币安 `clientOrderId` 长度上限。
pub const MAX_LEN: usize = 36;

const INTENT_HEX_LEN: usize = 12;

/// 一笔 intent 里的腿。单字符编码进 id。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Leg {
    /// 入场腿。
    Entry,
    /// 止损腿。
    Stop,
    /// 止盈腿。
    TakeProfit,
    /// 平仓腿。
    Close,
    /// 其它/实验腿。
    Extra,
}

impl Leg {
    pub fn code(self) -> char {
        match self {
            Self::Entry => 'e',
            Self::Stop => 's',
            Self::TakeProfit => 't',
            Self::Close => 'c',
            Self::Extra => 'x',
        }
    }

    pub fn from_code(code: char) -> Option<Self> {
        Some(match code {
            'e' => Self::Entry,
            's' => Self::Stop,
            't' => Self::TakeProfit,
            'c' => Self::Close,
            'x' => Self::Extra,
            _ => return None,
        })
    }
}

/// 一个已解析的本机 `clientOrderId`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientOrderId {
    pub intent_prefix: String,
    pub leg: Leg,
    pub attempt: u32,
}

impl ClientOrderId {
    /// 生成。`intent_id` 取其**十六进制字符**的前 12 位(UUID 的连字符会被跳过);
    /// 不足 12 位右补 `0`,保证长度恒定、可反查。
    ///
    /// `attempt` 上限 999999:再往上 id 会超 36 字符,而"同一条腿重试一百万次"
    /// 本身就该是 HALT 而不是继续编号。
    pub fn new(intent_id: &str, leg: Leg, attempt: u32) -> Result<Self, IdError> {
        let hex: String = intent_id
            .chars()
            .filter(char::is_ascii_hexdigit)
            .map(|item| item.to_ascii_lowercase())
            .take(INTENT_HEX_LEN)
            .collect();
        if hex.is_empty() {
            return Err(IdError::NoHexInIntentId);
        }
        if attempt > 999_999 {
            return Err(IdError::AttemptTooLarge(attempt));
        }
        let mut intent_prefix = hex;
        while intent_prefix.len() < INTENT_HEX_LEN {
            intent_prefix.push('0');
        }
        Ok(Self { intent_prefix, leg, attempt })
    }

    /// 反解。不是本机格式返回 `None`(外部订单一律走 `is_foreign`)。
    pub fn parse(id: &str) -> Option<Self> {
        let rest = id.strip_prefix(LOCAL_PREFIX)?;
        let mut parts = rest.split('-');
        let intent_prefix = parts.next()?;
        let leg = parts.next()?;
        let attempt = parts.next()?;
        if parts.next().is_some() {
            return None;
        }
        if intent_prefix.len() != INTENT_HEX_LEN || !intent_prefix.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
            return None;
        }
        let mut leg_chars = leg.chars();
        let leg = Leg::from_code(leg_chars.next()?)?;
        if leg_chars.next().is_some() {
            return None;
        }
        Some(Self { intent_prefix: intent_prefix.to_owned(), leg, attempt: attempt.parse().ok()? })
    }
}

impl fmt::Display for ClientOrderId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{LOCAL_PREFIX}{}-{}-{}", self.intent_prefix, self.leg.code(), self.attempt)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    #[error("intent_id 里没有任何十六进制字符,无法生成 clientOrderId")]
    NoHexInIntentId,
    #[error("attempt={0} 过大:同一条腿重试到这个次数应当 HALT,而不是继续编号")]
    AttemptTooLarge(u32),
}

/// 这个 `clientOrderId` 是本仓库(trading-swarm)产生的吗?
pub fn is_local(id: &str) -> bool {
    id.starts_with(LOCAL_PREFIX)
}

/// 外部写者产生的吗?**8794 的 `ts_` 前缀也算 foreign** —— 同一账户上出现它
/// 就是多写者,必须走账户级多写者检测,而不是当成自家的孤儿单去清理。
pub fn is_foreign(id: &str) -> bool {
    !is_local(id)
}

/// 是否满足币安对 `clientOrderId` 的字符集与长度要求 `^[\.A-Z\:/a-z0-9_-]{1,36}$`。
pub fn is_valid_client_order_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_LEN
        && id
            .chars()
            .all(|item| item.is_ascii_alphanumeric() || matches!(item, '.' | ':' | '/' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_fit_binance_charset_and_length() {
        let id = ClientOrderId::new("0f3a9c7e-1b2d-4c5e-8a9b-0123456789ab", Leg::Entry, 1)
            .expect("generate")
            .to_string();
        assert_eq!(id, "tg-0f3a9c7e1b2d-e-1");
        assert!(id.len() <= MAX_LEN);
        assert!(is_valid_client_order_id(&id));

        // 最长的合法形状也必须留在 36 以内
        let longest = ClientOrderId::new("ffffffffffffffff", Leg::TakeProfit, 999_999)
            .expect("generate")
            .to_string();
        assert_eq!(longest, "tg-ffffffffffff-t-999999");
        assert!(longest.len() <= MAX_LEN, "{longest} = {} 字符", longest.len());
    }

    #[test]
    fn every_leg_code_round_trips() {
        for leg in [Leg::Entry, Leg::Stop, Leg::TakeProfit, Leg::Close, Leg::Extra] {
            let id = ClientOrderId::new("abcdef012345", leg, 0).expect("generate");
            let text = id.to_string();
            assert!(is_valid_client_order_id(&text));
            assert_eq!(ClientOrderId::parse(&text), Some(id));
        }
        assert_eq!(Leg::from_code('q'), None);
    }

    #[test]
    fn short_or_dirty_intent_ids_still_produce_a_stable_12_hex_prefix() {
        let id = ClientOrderId::new("ab", Leg::Stop, 3).expect("generate");
        assert_eq!(id.to_string(), "tg-ab0000000000-s-3");
        // 非 hex 字符被跳过而不是替换,长度仍然恒定
        let id = ClientOrderId::new("zz-1a-zz-2b", Leg::Close, 0).expect("generate");
        assert_eq!(id.to_string(), "tg-1a2b00000000-c-0");
        assert_eq!(ClientOrderId::new("zzzz", Leg::Entry, 0), Err(IdError::NoHexInIntentId));
        assert!(matches!(
            ClientOrderId::new("abcdef012345", Leg::Entry, 1_000_000),
            Err(IdError::AttemptTooLarge(1_000_000))
        ));
    }

    #[test]
    fn local_and_foreign_prefixes_are_distinguished() {
        let mine = ClientOrderId::new("abcdef012345", Leg::Entry, 0).expect("generate").to_string();
        assert!(is_local(&mine));
        assert!(!is_foreign(&mine));
        // 8794 的实盘前缀:同账户上看到它 = 另一个写者
        assert!(is_foreign("ts_ord_1"));
        assert!(!is_local("ts_ord_1"));
        // 币安 UI / 其它客户端
        assert!(is_foreign("web_abc123"));
        assert!(is_foreign("x-15PRW3ns"));
        assert!(is_foreign(""));
    }

    #[test]
    fn parse_rejects_anything_that_is_not_our_shape() {
        assert_eq!(ClientOrderId::parse("ts_ord_1"), None);
        assert_eq!(ClientOrderId::parse("tg-短-e-1"), None);
        assert_eq!(ClientOrderId::parse("tg-abcdef012345-e"), None, "缺 attempt");
        assert_eq!(ClientOrderId::parse("tg-abcdef012345-e-1-2"), None, "多一段");
        assert_eq!(ClientOrderId::parse("tg-abcdef01234-e-1"), None, "hex 只有 11 位");
        assert_eq!(ClientOrderId::parse("tg-ABCDEF012345-e-1"), None, "大写 hex 不是我们生成的");
        assert_eq!(ClientOrderId::parse("tg-abcdef012345-q-1"), None, "未知腿代码");
        assert_eq!(ClientOrderId::parse("tg-abcdef012345-e-x"), None, "attempt 不是数字");
    }

    #[test]
    fn charset_guard_matches_binance_regex() {
        assert!(is_valid_client_order_id("tg-abcdef012345-e-0"));
        assert!(is_valid_client_order_id("a.b:c/d_e-f"));
        assert!(!is_valid_client_order_id(""));
        assert!(!is_valid_client_order_id("有中文"));
        assert!(!is_valid_client_order_id("has space"));
        assert!(!is_valid_client_order_id(&"a".repeat(MAX_LEN + 1)));
        assert!(is_valid_client_order_id(&"a".repeat(MAX_LEN)));
    }
}
