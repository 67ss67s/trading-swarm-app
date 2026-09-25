//! intent 的 A0 逻辑:校验 → 幂等 → 落库(proposed)→ 按 policy 立即迁移(halt_all → rejected;
//! agent 提议在 Observe → recorded);plan 物化与授权是 A2。所有迁移只走 transitions 表。

use std::sync::Arc;

use contracts_rs::records::{EventName, ExecPolicy};
use contracts_rs::rpc::{
    IntentAuthorizeParams, IntentAuthorizeResult, IntentBundle, IntentGetParams, IntentListParams, IntentListResult,
    IntentProposeParams, IntentProposeResult, IntentRejectParams, IntentRejectResult, RpcError,
};
use contracts_rs::{
    AccountRef, Authority, ErrorKind, GateRejection, Intent, IntentParams, IntentStatus, PolicyMode, Principal, Surface,
    Uuid, canonical_json_of,
};
use serde_json::json;

use crate::events::{EventBus, make_event};
use crate::paths::now_ms;
use crate::store::{IntentFilter, Store};

pub const DEFAULT_TTL_SECONDS: u32 = 120;

pub struct IntentService {
    pub store: Arc<Store>,
    pub bus: EventBus,
}

fn parse_pct(text: &str) -> Option<f64> {
    text.parse::<f64>().ok()
}

/// 语义校验(schema 之外的规矩)。
pub fn validate_propose(p: &IntentProposeParams) -> Result<(), RpcError> {
    let invalid = |msg: String| RpcError::from_kind(ErrorKind::InvalidParams, msg);
    let forbidden = |msg: String| RpcError::from_kind(ErrorKind::Forbidden, msg);
    if p.account == AccountRef::Main && p.principal != Principal::User {
        return Err(forbidden("主账户只接受 principal=user 的提议;agent 没有任何主账户写工具(设计 §3.5)".into()));
    }
    match &p.params {
        IntentParams::Transfer(t) => {
            if p.principal != Principal::User || p.surface != Surface::Rpc {
                return Err(forbidden("transfer 只允许 principal=user 且 surface=rpc(设计 §3.5)".into()));
            }
            if t.from_account == t.to_account && t.from_wallet == t.to_wallet {
                return Err(invalid("transfer 的来源与目的完全相同".into()));
            }
            if p.account != t.from_account {
                return Err(invalid(format!("transfer 的 account 必须等于 from_account({})", t.from_account.as_str())));
            }
            match parse_pct(t.amount.as_str()) {
                Some(v) if v > 0.0 => {}
                _ => return Err(invalid("transfer.amount 必须 > 0".into())),
            }
        }
        IntentParams::Close(c) => match parse_pct(c.pct.as_str()) {
            Some(v) if v > 0.0 && v <= 100.0 => {}
            _ => return Err(invalid("close.pct 必须在 (0,100]".into())),
        },
        IntentParams::CancelOrder(c) => {
            if c.order_ref.is_empty() {
                return Err(invalid("cancel_order.order_ref 至少给 exchange_order_id 或 client_order_id 之一".into()));
            }
        }
        IntentParams::Open(o) => {
            if let Some(tps) = &o.take_profits {
                let mut total = 0.0;
                for tp in tps {
                    match parse_pct(tp.pct.as_str()) {
                        Some(v) if v > 0.0 && v <= 100.0 => total += v,
                        _ => return Err(invalid("take_profits[].pct 必须在 (0,100]".into())),
                    }
                }
                if total > 100.0 + 1e-9 {
                    return Err(invalid("take_profits 的 pct 合计不得超过 100".into()));
                }
            }
            if let Some(lev) = o.leverage
                && lev == 0
            {
                return Err(invalid("leverage 必须 ≥ 1".into()));
            }
        }
        IntentParams::Protect(pr) => {
            if pr.stop.is_none() && pr.take_profits.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
                return Err(invalid("protect 至少要有 stop 或一条 take_profit".into()));
            }
        }
    }
    if let Some(ttl) = p.ttl_seconds
        && !(1..=86_400).contains(&ttl)
    {
        return Err(invalid("ttl_seconds 必须在 1..=86400".into()));
    }
    Ok(())
}

impl IntentService {
    pub fn new(store: Arc<Store>, bus: EventBus) -> Self {
        Self { store, bus }
    }

    fn policy_or_default(&self) -> Result<ExecPolicy, RpcError> {
        Ok(self.store.load_policy().map_err(internal)?.unwrap_or_else(|| crate::policy::default_policy(now_ms())))
    }

    pub fn propose(&self, p: IntentProposeParams) -> Result<IntentProposeResult, RpcError> {
        validate_propose(&p)?;
        let now = now_ms();
        let policy = self.policy_or_default()?;

        // 幂等:同键同内容返回原 intent;同键不同内容 = corruption。
        if let Some(key) = &p.idempotency_key
            && let Some(existing) = self.store.find_intent_by_idempotency(p.principal, key).map_err(internal)?
        {
            let same = existing.account == p.account
                && existing.surface == p.surface
                && canonical_json_of(&existing.params).map_err(internal)? == canonical_json_of(&p.params).map_err(internal)?;
            if same {
                return Ok(IntentProposeResult { gate_rejections: existing.gate_rejections.clone(), intent: existing, plan: None });
            }
            let mut event = make_event(
                EventName::CorruptionDetected,
                now,
                Some(p.account),
                Some(&existing.intent_id),
                existing.params.symbol(),
                json!({
                    "reason": "idempotency_key 相同但内容不同",
                    "principal": p.principal.as_str(),
                    "idempotency_key": key,
                }),
            );
            let events = self
                .store
                .transaction(|tx| {
                    Store::tx_insert_event(tx, &mut event)?;
                    Ok(vec![event.clone()])
                })
                .map_err(internal)?;
            self.bus.publish(events);
            return Err(RpcError::from_kind(
                ErrorKind::Conflict,
                format!("idempotency_key {key:?} 已被不同内容的 intent {} 占用(corruption.detected 已记录)", existing.intent_id),
            ));
        }

        let ttl = p.ttl_seconds.unwrap_or(DEFAULT_TTL_SECONDS);
        let mut intent = Intent {
            schema_version: 1,
            intent_id: new_uuid(),
            account: p.account,
            principal: p.principal,
            surface: p.surface,
            session_id: p.session_id.clone(),
            run_id: p.run_id.clone(),
            origin: p.origin.clone(),
            idempotency_key: p.idempotency_key.clone(),
            params: p.params.clone(),
            status: IntentStatus::Proposed,
            status_reason: None,
            gate_rejections: vec![],
            current_plan_id: None,
            authorization_id: None,
            ttl_seconds: ttl,
            created_at: now,
            updated_at: now,
            expires_at: Some(now + i64::from(ttl) * 1000),
            terminal_at: None,
        };

        // A0 的即时闸:HALT / emergency_stop 拒一切新提议;agent 提议在 Observe 只落库。
        let mut gate_rejections: Vec<GateRejection> = Vec::new();
        let mut next_status: Option<(IntentStatus, &'static str)> = None;
        if policy.mode == PolicyMode::HaltAll || policy.emergency_stop {
            gate_rejections.push(GateRejection {
                gate: if policy.emergency_stop { "policy.emergency_stop".into() } else { "policy.mode".into() },
                value: Some(if policy.emergency_stop { "true".into() } else { policy.mode.as_str().into() }),
                limit: Some(if policy.emergency_stop { "false".into() } else { "run".into() }),
                message: "HALT 期间拒绝一切新提议".into(),
            });
            next_status = Some((IntentStatus::Rejected, "gate_rejected"));
        } else if p.principal != Principal::User && policy.authority == Authority::Observe {
            next_status = Some((IntentStatus::Recorded, "observe_only"));
        }

        let symbol = intent.params.symbol().cloned();
        let events = self
            .store
            .transaction(|tx| {
                Store::tx_insert_intent(tx, &intent)?;
                let mut events = Vec::new();
                let mut created = make_event(
                    EventName::IntentCreated,
                    now,
                    Some(intent.account),
                    Some(&intent.intent_id),
                    symbol.as_ref(),
                    json!({ "status": "proposed", "kind": intent.kind().as_str(), "principal": intent.principal.as_str() }),
                );
                Store::tx_insert_event(tx, &mut created)?;
                events.push(created);
                if let Some((to, event_name)) = next_status {
                    let to = intent.status.transition_to(to, Some(event_name)).map_err(|e| anyhow::anyhow!(e))?;
                    intent.status = to;
                    intent.updated_at = now;
                    intent.terminal_at = if to.is_terminal() { Some(now) } else { None };
                    if to == IntentStatus::Rejected {
                        intent.status_reason = Some(format!("gate {}", gate_rejections[0].gate));
                        intent.gate_rejections = gate_rejections.clone();
                    } else {
                        intent.status_reason = Some("authority=observe:只落库不执行".into());
                    }
                    Store::tx_update_intent(tx, &intent)?;
                    let mut ev = make_event(
                        EventName::for_intent_status(to),
                        now,
                        Some(intent.account),
                        Some(&intent.intent_id),
                        symbol.as_ref(),
                        json!({ "status": to.as_str(), "event": event_name, "gate_rejections": gate_rejections }),
                    );
                    Store::tx_insert_event(tx, &mut ev)?;
                    events.push(ev);
                }
                Ok(events)
            })
            .map_err(internal)?;
        self.bus.publish(events);
        Ok(IntentProposeResult { intent, plan: None, gate_rejections })
    }

    pub fn reject(&self, p: IntentRejectParams) -> Result<IntentRejectResult, RpcError> {
        let mut intent = self
            .store
            .get_intent(p.intent_id.as_str())
            .map_err(internal)?
            .ok_or_else(|| RpcError::from_kind(ErrorKind::NotFound, format!("intent {} 不存在", p.intent_id)))?;
        let event_name = if p.principal == Principal::User { "user_rejected" } else { "regate_rejected" };
        let to = intent
            .status
            .transition_to(IntentStatus::Rejected, Some(event_name))
            .map_err(|e| RpcError::from_kind(ErrorKind::InvalidTransition, e.to_string()))?;
        let now = now_ms();
        intent.status = to;
        intent.status_reason = Some(format!("{}: {}", event_name, p.reason));
        intent.updated_at = now;
        intent.terminal_at = Some(now);
        let symbol = intent.params.symbol().cloned();
        let events = self
            .store
            .transaction(|tx| {
                Store::tx_update_intent(tx, &intent)?;
                let mut ev = make_event(
                    EventName::IntentRejected,
                    now,
                    Some(intent.account),
                    Some(&intent.intent_id),
                    symbol.as_ref(),
                    json!({ "status": "rejected", "event": event_name, "reason": p.reason, "principal": p.principal.as_str(), "surface": p.surface.as_str() }),
                );
                Store::tx_insert_event(tx, &mut ev)?;
                Ok(vec![ev])
            })
            .map_err(internal)?;
        self.bus.publish(events);
        Ok(IntentRejectResult { intent })
    }

    pub fn get(&self, p: IntentGetParams) -> Result<IntentBundle, RpcError> {
        let intent = self
            .store
            .get_intent(p.intent_id.as_str())
            .map_err(internal)?
            .ok_or_else(|| RpcError::from_kind(ErrorKind::NotFound, format!("intent {} 不存在", p.intent_id)))?;
        let id = intent.intent_id.as_str().to_owned();
        let plan = match &intent.current_plan_id {
            Some(pid) => self.store.get_plan(pid.as_str()).map_err(internal)?,
            None => None,
        };
        let authorization = match &intent.authorization_id {
            Some(aid) => self.store.get_authorization(aid.as_str()).map_err(internal)?,
            None => None,
        };
        Ok(IntentBundle {
            attempts: self.store.attempts_for_intent(&id).map_err(internal)?,
            orders: self.store.orders_for_intent(&id).map_err(internal)?,
            fills: self.store.fills_for_intent(&id).map_err(internal)?,
            effect: self.store.effect_for_intent(&id).map_err(internal)?,
            intent,
            plan,
            authorization,
        })
    }

    pub fn list(&self, p: IntentListParams) -> Result<IntentListResult, RpcError> {
        let filter = IntentFilter {
            status: p.status,
            account: p.account.map(|a| a.as_str().to_owned()),
            kind: p.kind.map(|k| k.as_str().to_owned()),
            since: p.since,
            limit: p.limit.unwrap_or(100),
        };
        Ok(IntentListResult { intents: self.store.list_intents(&filter).map_err(internal)? })
    }

    /// A2 交付:plan 物化 + 结构化确认。A0 明确返回 unavailable,而不是假装成功。
    pub fn authorize(&self, _p: IntentAuthorizeParams) -> Result<IntentAuthorizeResult, RpcError> {
        Err(RpcError::from_kind(ErrorKind::Unavailable, "exec.intent.authorize 在 A2 交付(plan 物化 + confirm_fields 比对)").with_retryable(false))
    }
}

pub fn internal(e: impl std::fmt::Display) -> RpcError {
    RpcError::from_kind(ErrorKind::Internal, e.to_string())
}

pub fn new_uuid() -> Uuid {
    Uuid::new(uuid::Uuid::new_v4().to_string()).expect("uuid v4 合法")
}
