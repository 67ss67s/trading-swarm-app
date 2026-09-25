//! 现货与主/子账户联动(`api` / `sapi`)—— **A1 的重点**。
//!
//! 设计 §3.5 待实测的三件事全在这里:
//! 1. Agentic virtual sub 是否出现在 `GET /sapi/v1/sub-account/list`,字段长什么样;
//! 2. `POST /sapi/v1/sub-account/universalTransfer` 能否对它划转;
//! 3. `GET /sapi/v3/sub-account/assets` 能否读到它的资产。
//!
//! 来源:8794 只用到 `/sapi/v1/copyTrading/*`(已剔除),这一模块基本是新写的,
//! 复用的是 [`BinanceRest`] 的签名/限频/错误分类底座。
//!
//! **本模块不实现任何提币端点**(`/sapi/v1/capital/withdraw/apply` 等)。
//! 设计 §16 Q7:主账户 API key 默认**不勾**提币,提币走 Binance UI 深链;
//! 真要一键提币,必须先配 IP 白名单 + WebUI 二次确认,并且在那时才添加代码。

use serde_json::Value;

use super::futures::truthy;
use super::rest::BinanceRest;
use crate::error::BinanceError;

pub struct SpotApi<'a>(pub(crate) &'a BinanceRest);

/// 划转的账户类型(`universalTransfer` 的 `fromAccountType` / `toAccountType`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountType {
    Spot,
    UsdtFuture,
    CoinFuture,
    Margin,
    IsolatedMargin,
}

impl AccountType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spot => "SPOT",
            Self::UsdtFuture => "USDT_FUTURE",
            Self::CoinFuture => "COIN_FUTURE",
            Self::Margin => "MARGIN",
            Self::IsolatedMargin => "ISOLATED_MARGIN",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        Ok(match value.trim().to_ascii_uppercase().as_str() {
            "SPOT" => Self::Spot,
            "USDT_FUTURE" => Self::UsdtFuture,
            "COIN_FUTURE" => Self::CoinFuture,
            "MARGIN" => Self::Margin,
            "ISOLATED_MARGIN" => Self::IsolatedMargin,
            other => {
                return Err(format!(
                    "未知账户类型 {other:?};可选 SPOT/USDT_FUTURE/COIN_FUTURE/MARGIN/ISOLATED_MARGIN"
                ));
            }
        })
    }
}

/// `GET /sapi/v1/account/apiRestrictions` 的解析结果。
///
/// `raw` 原样保留全部字段 —— 币安随时会加新权限位,A1 的报告要能看到它们。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ApiRestrictions {
    pub enable_reading: bool,
    pub enable_spot_and_margin_trading: bool,
    pub enable_futures: bool,
    pub enable_margin: bool,
    /// **设计默认不勾**。为 true 时探针会红字提示。
    pub enable_withdrawals: bool,
    pub enable_internal_transfer: bool,
    pub permits_universal_transfer: bool,
    pub enable_vanilla_options: bool,
    pub enable_portfolio_margin_trading: bool,
    pub ip_restrict: bool,
    /// key 创建时间(unix 毫秒)。
    pub create_time_ms: Option<i64>,
    /// 交易授权到期(unix 毫秒);`None` = 不过期。
    pub trading_authority_expiration_time_ms: Option<i64>,
    pub raw: Value,
}

impl ApiRestrictions {
    pub fn from_value(payload: &Value) -> Self {
        let flag = |name: &str| payload.get(name).map(truthy).unwrap_or(false);
        let ms = |name: &str| payload.get(name).and_then(crate::filters::f64_of).map(|v| v as i64);
        Self {
            enable_reading: flag("enableReading"),
            enable_spot_and_margin_trading: flag("enableSpotAndMarginTrading"),
            enable_futures: flag("enableFutures"),
            enable_margin: flag("enableMargin"),
            enable_withdrawals: flag("enableWithdrawals"),
            enable_internal_transfer: flag("enableInternalTransfer"),
            permits_universal_transfer: flag("permitsUniversalTransfer"),
            enable_vanilla_options: flag("enableVanillaOptions"),
            enable_portfolio_margin_trading: flag("enablePortfolioMarginTrading"),
            ip_restrict: flag("ipRestrict"),
            create_time_ms: ms("createTime"),
            trading_authority_expiration_time_ms: ms("tradingAuthorityExpirationTime"),
            raw: payload.clone(),
        }
    }

    /// A1 判据:这把 key 够不够做「主账户手动交易 + 主/子划转」。
    pub fn missing_for_trading_swarm(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if !self.enable_reading {
            missing.push("enableReading(读)");
        }
        if !self.enable_futures {
            missing.push("enableFutures(合约交易)");
        }
        if !self.permits_universal_transfer {
            missing.push("permitsUniversalTransfer(子账户万能划转)");
        }
        missing
    }
}

/// `GET /sapi/v1/sub-account/list` 的一行。
///
/// **除 email 外的所有字段原样留在 `raw` 里** —— A1 就是要在里面找能标识
/// "Agentic" / "virtual" 的字段(`isManagedSubAccount` / `subAccountType` /
/// `isAssetManagementSubAccount` 之类),不能提前把它们丢掉。
#[derive(Debug, Clone)]
pub struct SubAccount {
    pub email: String,
    pub is_freeze: bool,
    pub create_time_ms: Option<i64>,
    pub raw: Value,
}

impl SubAccount {
    pub fn from_value(payload: &Value) -> Self {
        Self {
            email: payload.get("email").and_then(Value::as_str).unwrap_or_default().to_owned(),
            is_freeze: payload.get("isFreeze").map(truthy).unwrap_or(false),
            create_time_ms: payload
                .get("createTime")
                .and_then(crate::filters::f64_of)
                .map(|value| value as i64),
            raw: payload.clone(),
        }
    }
}

impl SpotApi<'_> {
    fn base(&self) -> String {
        self.0.api_base.clone()
    }

    /// `GET /sapi/v1/account/apiRestrictions` —— **key 权限探测**。
    /// 向导第 4b 步与探针的第一个判据。
    pub async fn api_restrictions(&self) -> Result<ApiRestrictions, BinanceError> {
        let payload = self.0.signed_get(&self.base(), "/sapi/v1/account/apiRestrictions", &[]).await?;
        Ok(ApiRestrictions::from_value(&payload))
    }

    /// `GET /api/v3/account` —— 现货余额。
    pub async fn spot_account(&self) -> Result<Value, BinanceError> {
        self.0.signed_get(&self.base(), "/api/v3/account", &[]).await
    }

    /// `GET /sapi/v1/sub-account/list`。
    ///
    /// A1 判据 ①:Agentic virtual sub 会不会出现在这里。出现 → execd 多一条独立于
    /// OAuth 的子账户真相来源;不出现 → Funding 页退化为 Binance UI 深链。
    pub async fn sub_account_list(
        &self,
        email: Option<&str>,
        page: i64,
        limit: i64,
    ) -> Result<Vec<SubAccount>, BinanceError> {
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(email) = email {
            params.push(("email".into(), email.to_owned()));
        }
        params.push(("page".into(), page.max(1).to_string()));
        params.push(("limit".into(), limit.clamp(1, 200).to_string()));
        let payload = self.0.signed_get(&self.base(), "/sapi/v1/sub-account/list", &params).await?;
        Ok(payload
            .get("subAccounts")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().map(SubAccount::from_value).collect())
            .unwrap_or_default())
    }

    /// `GET /sapi/v3/sub-account/assets?email=` —— 某个子账户的现货资产。
    ///
    /// A1 判据 ③:能读到 Agentic 子账户就多一条对账用的真相来源(不动钱)。
    pub async fn sub_account_assets(&self, email: &str) -> Result<Value, BinanceError> {
        self.0
            .signed_get(&self.base(), "/sapi/v3/sub-account/assets", &[("email".into(), email.to_owned())])
            .await
    }

    /// `GET /sapi/v1/sub-account/spotSummary` —— 全部子账户的现货总览(可选)。
    pub async fn sub_account_spot_summary(&self, page: i64, size: i64) -> Result<Value, BinanceError> {
        let params = vec![
            ("page".to_owned(), page.max(1).to_string()),
            ("size".to_owned(), size.clamp(1, 20).to_string()),
        ];
        self.0.signed_get(&self.base(), "/sapi/v1/sub-account/spotSummary", &params).await
    }

    /// `GET /sapi/v1/sub-account/universalTransfer` —— 划转历史。
    ///
    /// 只读,探针默认会跑:历史里出现过的 `fromAccountType`/`toAccountType` 组合
    /// 就是这把 key 实际被允许的划转形状。
    pub async fn universal_transfer_history(
        &self,
        from_email: Option<&str>,
        to_email: Option<&str>,
        limit: i64,
    ) -> Result<Value, BinanceError> {
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(email) = from_email {
            params.push(("fromEmail".into(), email.to_owned()));
        }
        if let Some(email) = to_email {
            params.push(("toEmail".into(), email.to_owned()));
        }
        params.push(("limit".into(), limit.clamp(1, 500).to_string()));
        self.0.signed_get(&self.base(), "/sapi/v1/sub-account/universalTransfer", &params).await
    }

    /// `POST /sapi/v1/sub-account/universalTransfer` —— **动钱**。
    ///
    /// 主/子之间划转。`from_email` 为空 = 从主账户出;`to_email` 为空 = 转入主账户。
    ///
    /// 调用纪律(设计 §3.5 / §5.1):只接受 `principal=user` 且带 structured confirm
    /// 的 intent;agent 会话的 effective catalog 里**没有**任何调到这里的工具。
    /// 探针默认路径也不会走它(要 `--transfer-test` + `TG_ALLOW_TRANSFER=1` 双开关)。
    #[allow(clippy::too_many_arguments)]
    pub async fn universal_transfer(
        &self,
        from_email: Option<&str>,
        to_email: Option<&str>,
        from_account_type: AccountType,
        to_account_type: AccountType,
        asset: &str,
        amount: &str,
        client_tran_id: Option<&str>,
    ) -> Result<Value, BinanceError> {
        if from_email.is_none() && to_email.is_none() {
            return Err(BinanceError::local_reject(
                "transfer_no_counterparty",
                "universalTransfer 至少要给 fromEmail 或 toEmail 之一(两边都空 = 主账户转给自己)",
            ));
        }
        if !is_positive_decimal(amount) {
            return Err(BinanceError::local_reject(
                "transfer_bad_amount",
                format!("划转金额必须是正的十进制字符串,当前为 {amount:?}"),
            ));
        }
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(email) = from_email {
            params.push(("fromEmail".into(), email.to_owned()));
        }
        if let Some(email) = to_email {
            params.push(("toEmail".into(), email.to_owned()));
        }
        params.push(("fromAccountType".into(), from_account_type.as_str().to_owned()));
        params.push(("toAccountType".into(), to_account_type.as_str().to_owned()));
        params.push(("asset".into(), asset.trim().to_ascii_uppercase()));
        params.push(("amount".into(), amount.trim().to_owned()));
        if let Some(id) = client_tran_id {
            params.push(("clientTranId".into(), id.to_owned()));
        }
        self.0.signed_post(&self.base(), "/sapi/v1/sub-account/universalTransfer", &params).await
    }

    /// `POST /sapi/v1/asset/transfer` —— **主账户内部** spot ↔ USDⓈ-M 合约钱包。
    /// `transfer_type` 用 [`MAIN_UMFUTURE`](MAIN_UMFUTURE) / [`UMFUTURE_MAIN`](UMFUTURE_MAIN)。
    pub async fn asset_transfer(
        &self,
        transfer_type: &str,
        asset: &str,
        amount: &str,
    ) -> Result<Value, BinanceError> {
        if !matches!(transfer_type, MAIN_UMFUTURE | UMFUTURE_MAIN) {
            return Err(BinanceError::local_reject(
                "transfer_bad_type",
                format!("本模块只允许主账户 spot↔USDⓈ-M 划转({MAIN_UMFUTURE}/{UMFUTURE_MAIN}),当前为 {transfer_type:?}"),
            ));
        }
        if !is_positive_decimal(amount) {
            return Err(BinanceError::local_reject(
                "transfer_bad_amount",
                format!("划转金额必须是正的十进制字符串,当前为 {amount:?}"),
            ));
        }
        let params = vec![
            ("type".to_owned(), transfer_type.to_owned()),
            ("asset".to_owned(), asset.trim().to_ascii_uppercase()),
            ("amount".to_owned(), amount.trim().to_owned()),
        ];
        self.0.signed_post(&self.base(), "/sapi/v1/asset/transfer", &params).await
    }
}

/// 主账户现货 → USDⓈ-M 合约钱包。
pub const MAIN_UMFUTURE: &str = "MAIN_UMFUTURE";
/// 主账户 USDⓈ-M 合约钱包 → 现货。
pub const UMFUTURE_MAIN: &str = "UMFUTURE_MAIN";

/// 划转金额必须是**正的十进制字符串**:不接受科学计数法、`Infinity`、负数、空串
/// —— 这些形状进了签名串,币安要么拒要么按你想不到的值执行。
fn is_positive_decimal(value: &str) -> bool {
    let text = value.trim();
    if text.is_empty() || text.len() > 32 {
        return false;
    }
    if !text.chars().all(|item| item.is_ascii_digit() || item == '.') {
        return false;
    }
    if text.matches('.').count() > 1 {
        return false;
    }
    text.parse::<f64>().map(|parsed| parsed > 0.0).unwrap_or(false)
}

/// 邮箱脱敏:`abcd@example.com` → `ab***@ex`。**所有对外输出必须过这层**。
pub fn mask_email(email: &str) -> String {
    let (local, domain) = email.split_once('@').unwrap_or((email, ""));
    let head: String = local.chars().take(2).collect();
    // 只取域名主体(点之前)的前两个字符,`b.com` → `b` 而不是 `b.`
    let domain_name = domain.split('.').next().unwrap_or("");
    let domain_head: String = domain_name.chars().take(2).collect();
    format!("{head}***@{domain_head}")
}

/// 脱敏后仍需区分不同子账户时用的稳定指纹(sha256 前 8 位 hex)。
pub fn email_fingerprint(email: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(email.trim().to_ascii_lowercase().as_bytes());
    hex::encode(&digest[..4])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn api_restrictions_parse_binance_shape_and_keep_raw() {
        let payload = json!({
            "ipRestrict": false,
            "createTime": 1_698_000_000_000i64,
            "enableInternalTransfer": true,
            "enableWithdrawals": false,
            "enableReading": true,
            "enableFutures": true,
            "enableSpotAndMarginTrading": true,
            "permitsUniversalTransfer": true,
            "someBrandNewFlag": true
        });
        let restrictions = ApiRestrictions::from_value(&payload);
        assert!(restrictions.enable_reading);
        assert!(restrictions.enable_futures);
        assert!(restrictions.permits_universal_transfer);
        assert!(!restrictions.enable_withdrawals);
        assert_eq!(restrictions.create_time_ms, Some(1_698_000_000_000));
        assert_eq!(restrictions.missing_for_trading_swarm(), Vec::<&str>::new());
        // 未知的新权限位必须原样留着,不能被解析吃掉
        assert_eq!(restrictions.raw.get("someBrandNewFlag"), Some(&json!(true)));
    }

    #[test]
    fn missing_permissions_are_named_precisely() {
        let restrictions = ApiRestrictions::from_value(&json!({ "enableReading": true }));
        assert_eq!(
            restrictions.missing_for_trading_swarm(),
            vec!["enableFutures(合约交易)", "permitsUniversalTransfer(子账户万能划转)"]
        );
    }

    /// A1 的核心:子账户行里**除 email 外一个字段都不许丢** ——
    /// 标识 Agentic/virtual 的字段名现在还不知道叫什么。
    #[test]
    fn sub_account_rows_preserve_every_unknown_field() {
        let row = json!({
            "email": "virtual-agent-1@binanceagent.local",
            "isFreeze": false,
            "createTime": 1_756_000_000_000i64,
            "isManagedSubAccount": false,
            "isAssetManagementSubAccount": false,
            "subAccountType": "AGENTIC_VIRTUAL"
        });
        let account = SubAccount::from_value(&row);
        assert_eq!(account.email, "virtual-agent-1@binanceagent.local");
        assert!(!account.is_freeze);
        assert_eq!(account.create_time_ms, Some(1_756_000_000_000));
        assert_eq!(account.raw, row, "整行必须原样保留");
        assert_eq!(mask_email(&account.email), "vi***@bi");
    }

    #[test]
    fn email_masking_and_fingerprints() {
        assert_eq!(mask_email("abcd@example.com"), "ab***@ex");
        assert_eq!(mask_email("a@b.com"), "a***@b");
        assert_eq!(mask_email("noatsign"), "no***@");
        // 两个不同邮箱脱敏后可能撞成同一串,指纹用来区分
        assert_eq!(mask_email("abc@xx.com"), mask_email("abd@xx.net"));
        assert_ne!(email_fingerprint("abc@xx.com"), email_fingerprint("abd@xx.net"));
        // 指纹稳定且大小写无关
        assert_eq!(email_fingerprint("A@B.com"), email_fingerprint("a@b.com"));
        assert_eq!(email_fingerprint("a@b.com").len(), 8);
    }

    #[test]
    fn transfer_amount_guard_rejects_the_shapes_binance_would_misread() {
        assert!(is_positive_decimal("1"));
        assert!(is_positive_decimal("0.5"));
        assert!(is_positive_decimal(" 12.25 "));
        assert!(!is_positive_decimal(""));
        assert!(!is_positive_decimal("0"));
        assert!(!is_positive_decimal("-1"));
        assert!(!is_positive_decimal("1e3"), "科学计数法进签名串会被币安按别的值理解");
        assert!(!is_positive_decimal("1.2.3"));
        assert!(!is_positive_decimal("abc"));
        assert!(!is_positive_decimal("Infinity"));
        assert!(!is_positive_decimal(&"1".repeat(33)));
    }

    #[tokio::test]
    async fn transfer_guards_fire_before_any_network_call() {
        // anonymous 客户端连签名都做不了 —— 能拿到 local_reject 就证明守卫在签名之前
        let rest = BinanceRest::anonymous();
        let spot = rest.spot();
        let error = spot
            .universal_transfer(None, None, AccountType::Spot, AccountType::Spot, "USDT", "1", None)
            .await
            .expect_err("两边都没 email 必须拒");
        assert_eq!(error.local_reject_kind(), Some("transfer_no_counterparty"));

        let error = spot
            .universal_transfer(
                None,
                Some("sub@x.com"),
                AccountType::Spot,
                AccountType::UsdtFuture,
                "USDT",
                "-1",
                None,
            )
            .await
            .expect_err("负数必须拒");
        assert_eq!(error.local_reject_kind(), Some("transfer_bad_amount"));

        let error = spot
            .asset_transfer("MAIN_MARGIN", "USDT", "1")
            .await
            .expect_err("只允许 spot↔UMFUTURE");
        assert_eq!(error.local_reject_kind(), Some("transfer_bad_type"));
    }

    #[test]
    fn account_types_round_trip() {
        for value in ["SPOT", "USDT_FUTURE", "COIN_FUTURE", "MARGIN", "ISOLATED_MARGIN"] {
            assert_eq!(AccountType::parse(value).expect("parse").as_str(), value);
        }
        assert_eq!(AccountType::parse("spot").expect("小写也吃"), AccountType::Spot);
        assert!(AccountType::parse("FUNDING").is_err());
    }
}
