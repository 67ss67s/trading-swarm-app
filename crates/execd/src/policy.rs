//! policy 的默认值、set 校验与紧急停收紧(设计 §10;金丝雀期默认取 Codex 保守值 §17.2)。

use contracts_rs::records::{CanaryPolicy, Caps, ExecPolicy, MainAccountPolicy};
use contracts_rs::rpc::{EmergencyMode, PolicyConfirm, RpcError};
use contracts_rs::{Authority, ErrorKind, PolicyMode, Product, UnsignedDecimal};

fn udec(s: &str) -> UnsignedDecimal {
    UnsignedDecimal::new(s).expect("常量合法")
}

/// 没有 policy 行时的初值:Observe + 保守上限;symbol 白名单空(向导第 5 步显式填)。
pub fn default_policy(now_ms: i64) -> ExecPolicy {
    ExecPolicy {
        schema_version: 1,
        version: 0,
        updated_at: now_ms,
        mode: PolicyMode::Run,
        authority: Authority::Observe,
        emergency_stop: false,
        live_capped_enabled: false,
        symbol_allowlist: vec![],
        product_allowlist: vec![Product::UsdmPerp],
        caps: Caps {
            max_leverage: 2,
            risk_pct_per_trade: udec("0.25"),
            max_order_notional: udec("200"),
            max_position_notional: udec("400"),
            max_daily_opens: 2,
            daily_loss_stop_pct: udec("1"),
            symbol_cooldown_seconds: 3600,
            max_naked_seconds: 20,
            account_truth_max_age_ms: 15_000,
            market_max_age_ms: 5_000,
            authorization_ttl_market_seconds: 30,
            authorization_ttl_limit_seconds: 120,
            max_price_deviation_bps: 55,
            ntp_drift_block_ms: 2_000,
            ntp_drift_halt_ms: 10_000,
        },
        main_account: MainAccountPolicy { manual_trading_enabled: false, transfers_enabled: false, withdraw_enabled: false },
        canary: CanaryPolicy { enabled: false, max_loss_quote: None, max_notional_quote: None, max_leverage: None, funded_balance_quote: None },
    }
}

/// `policy.set` 的校验:confirm 逐字回填、version 严格 +1、v1 不变量。
pub fn validate_set(current: &ExecPolicy, next: &ExecPolicy, confirm: &PolicyConfirm) -> Result<(), RpcError> {
    if confirm.mode != next.mode.as_str() || confirm.authority != next.authority.as_str() {
        return Err(RpcError::from_kind(
            ErrorKind::Conflict,
            format!(
                "confirm 必须逐字回填新 policy 的 mode/authority:期望 {}/{},回填 {}/{}",
                next.mode.as_str(),
                next.authority.as_str(),
                confirm.mode,
                confirm.authority
            ),
        ));
    }
    if next.version != current.version + 1 {
        return Err(RpcError::from_kind(
            ErrorKind::Conflict,
            format!("policy.version 必须是当前 {} + 1,实得 {}", current.version, next.version),
        ));
    }
    if let Err(msg) = next.main_account.validate() {
        return Err(RpcError::from_kind(ErrorKind::InvalidParams, msg));
    }
    if next.live_capped_enabled {
        return Err(RpcError::from_kind(
            ErrorKind::Forbidden,
            "live_capped_enabled 在 v1 保持关闭,延后到设计 §16 Q6(Binance 对 standing authorization 的书面口径)解决",
        ));
    }
    if next.authority == Authority::LiveCapped {
        return Err(RpcError::from_kind(
            ErrorKind::Forbidden,
            "authority=live_capped 需要 live_capped_enabled,v1 不可用(延后到 §16 Q6)",
        ));
    }
    if next.caps.max_naked_seconds == 0 {
        return Err(RpcError::from_kind(ErrorKind::InvalidParams, "max_naked_seconds 必须 ≥ 1"));
    }
    Ok(())
}

/// 紧急停:只能收紧,不能放松;总是置 emergency_stop=true。
pub fn apply_emergency(current: &ExecPolicy, mode: EmergencyMode, now_ms: i64) -> Result<ExecPolicy, RpcError> {
    let target = mode.as_policy_mode();
    if target.severity() < current.mode.severity() {
        return Err(RpcError::from_kind(
            ErrorKind::Forbidden,
            format!(
                "emergency_stop 只能收紧:当前 {} 严于 {},放松请走 policy.set + confirm",
                current.mode.as_str(),
                target.as_str()
            ),
        ));
    }
    let mut next = current.clone();
    next.mode = target;
    next.emergency_stop = true;
    next.version = current.version + 1;
    next.updated_at = now_ms;
    Ok(next)
}

/// 当前 policy 是否"停机"(health.halted)。
pub fn is_halted(policy: &ExecPolicy) -> bool {
    policy.emergency_stop || policy.mode == PolicyMode::HaltAll
}

#[cfg(test)]
mod tests {
    use super::*;

    fn confirm(p: &ExecPolicy) -> PolicyConfirm {
        PolicyConfirm { mode: p.mode.as_str().into(), authority: p.authority.as_str().into() }
    }

    #[test]
    fn default_is_observe_and_conservative() {
        let p = default_policy(1);
        assert_eq!(p.authority, Authority::Observe);
        assert_eq!(p.mode, PolicyMode::Run);
        assert!(!p.live_capped_enabled);
        assert!(!p.main_account.withdraw_enabled);
        assert_eq!(p.caps.max_daily_opens, 2);
        assert_eq!(serde_json::to_value(&p).unwrap()["caps"]["risk_pct_per_trade"], "0.25");
    }

    #[test]
    fn set_requires_exact_confirm_and_version_bump() {
        let cur = default_policy(1);
        let mut next = cur.clone();
        next.version = 1;
        next.authority = Authority::Draft;
        assert!(validate_set(&cur, &next, &confirm(&next)).is_ok());
        let bad = PolicyConfirm { mode: "run".into(), authority: "observe".into() };
        assert_eq!(validate_set(&cur, &next, &bad).unwrap_err().data.kind, ErrorKind::Conflict);
        let mut stale = next.clone();
        stale.version = 5;
        assert_eq!(validate_set(&cur, &stale, &confirm(&stale)).unwrap_err().data.kind, ErrorKind::Conflict);
        let mut live = next.clone();
        live.authority = Authority::LiveCapped;
        assert_eq!(validate_set(&cur, &live, &confirm(&live)).unwrap_err().data.kind, ErrorKind::Forbidden);
        let mut withdraw = next.clone();
        withdraw.main_account.withdraw_enabled = true;
        assert_eq!(validate_set(&cur, &withdraw, &confirm(&withdraw)).unwrap_err().data.kind, ErrorKind::InvalidParams);
    }

    #[test]
    fn emergency_only_tightens() {
        let cur = default_policy(1);
        let halted = apply_emergency(&cur, EmergencyMode::FlattenOnly, 2).unwrap();
        assert_eq!(halted.mode, PolicyMode::FlattenOnly);
        assert!(halted.emergency_stop);
        assert_eq!(halted.version, 1);
        let err = apply_emergency(&halted, EmergencyMode::StopOpening, 3).unwrap_err();
        assert_eq!(err.data.kind, ErrorKind::Forbidden);
        assert!(apply_emergency(&halted, EmergencyMode::FlattenOnly, 3).is_ok(), "同级允许(幂等重按)");
        assert!(is_halted(&halted));
        assert!(!is_halted(&cur));
    }
}
