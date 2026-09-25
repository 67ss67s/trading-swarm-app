//! 进程级状态:store、事件总线、写者身份、policy 操作、health。

use std::sync::Arc;

use contracts_rs::records::{EventName, ExecPolicy};
use contracts_rs::rpc::{
    ChannelHealth, ChannelState, Channels, EmergencyStopParams, EmergencyStopResult, HealthResult, PolicyGetResult,
    PolicySetParams, PolicySetResult, RpcError,
};
use serde_json::json;

use crate::events::{EventBus, make_event};
use crate::intents::{IntentService, internal};
use crate::paths::now_ms;
use crate::policy::{apply_emergency, default_policy, is_halted, validate_set};
use crate::store::Store;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const LANES: &[&str] = &["main", "sub"];
/// 写者租约有效期(A0 只在启动时抢一次;A2 的执行队列会续租)。
pub const LEASE_TTL_MS: i64 = 24 * 3600 * 1000;

pub struct App {
    pub store: Arc<Store>,
    pub bus: EventBus,
    pub intents: IntentService,
    pub instance_id: String,
    pub lease_epoch: u64,
    pub started_at: i64,
}

impl App {
    pub fn new(store: Store, instance_id: String) -> anyhow::Result<Arc<Self>> {
        let store = Arc::new(store);
        let bus = EventBus::new();
        let mut epoch = 0;
        for lane in LANES {
            epoch = epoch.max(store.bump_writer_lease(lane, &instance_id, now_ms() + LEASE_TTL_MS)?);
        }
        let intents = IntentService::new(store.clone(), bus.clone());
        Ok(Arc::new(Self { store, bus, intents, instance_id, lease_epoch: epoch, started_at: now_ms() }))
    }

    pub fn current_policy(&self) -> Result<ExecPolicy, RpcError> {
        Ok(self.store.load_policy().map_err(internal)?.unwrap_or_else(|| default_policy(now_ms())))
    }

    pub fn health(&self) -> HealthResult {
        let policy = self.current_policy().unwrap_or_else(|_| default_policy(now_ms()));
        let db_ok = self.store.db_ok();
        HealthResult {
            ok: db_ok,
            version: VERSION.to_owned(),
            writer_instance_id: self.instance_id.clone(),
            lease_epoch: self.lease_epoch,
            started_at: self.started_at,
            now: now_ms(),
            db_ok,
            mode: policy.mode,
            halted: is_halted(&policy),
            open_intents: self.store.count_open_intents().unwrap_or(0),
            unknown_attempts: self.store.count_unknown_attempts().unwrap_or(0),
            channels: Channels {
                main: ChannelHealth { state: ChannelState::Unconfigured, detail: Some("A1/A3:主账户 key 未配置".into()), last_ok_at: None },
                sub: ChannelHealth { state: ChannelState::Unconfigured, detail: Some("A1/A3:Binance OAuth 未完成".into()), last_ok_at: None },
            },
        }
    }

    pub fn policy_get(&self) -> Result<PolicyGetResult, RpcError> {
        Ok(PolicyGetResult { policy: self.current_policy()? })
    }

    pub fn policy_set(&self, p: PolicySetParams) -> Result<PolicySetResult, RpcError> {
        let current = self.current_policy()?;
        validate_set(&current, &p.policy, &p.confirm)?;
        let mut next = p.policy.clone();
        next.updated_at = now_ms();
        let events = self
            .store
            .transaction(|tx| {
                Store::tx_upsert_policy(tx, &next)?;
                let mut ev = make_event(
                    EventName::PolicyChanged,
                    next.updated_at,
                    None,
                    None,
                    None,
                    json!({
                        "version": next.version,
                        "mode": next.mode.as_str(),
                        "authority": next.authority.as_str(),
                        "emergency_stop": next.emergency_stop,
                        "principal": p.principal.as_str(),
                        "surface": p.surface.as_str(),
                    }),
                );
                Store::tx_insert_event(tx, &mut ev)?;
                let mut events = vec![ev];
                if is_halted(&current) != is_halted(&next) {
                    let mut halt = make_event(EventName::HaltChanged, next.updated_at, None, None, None, json!({ "halted": is_halted(&next), "mode": next.mode.as_str() }));
                    Store::tx_insert_event(tx, &mut halt)?;
                    events.push(halt);
                }
                Ok(events)
            })
            .map_err(internal)?;
        self.bus.publish(events);
        Ok(PolicySetResult { policy: next })
    }

    pub fn emergency_stop(&self, p: EmergencyStopParams) -> Result<EmergencyStopResult, RpcError> {
        let current = self.current_policy()?;
        let next = apply_emergency(&current, p.mode, now_ms())?;
        let events = self
            .store
            .transaction(|tx| {
                Store::tx_upsert_policy(tx, &next)?;
                let mut ev = make_event(
                    EventName::HaltChanged,
                    next.updated_at,
                    None,
                    None,
                    None,
                    json!({ "halted": true, "mode": next.mode.as_str(), "reason": p.reason, "principal": p.principal.as_str(), "surface": p.surface.as_str() }),
                );
                Store::tx_insert_event(tx, &mut ev)?;
                let mut pc = make_event(EventName::PolicyChanged, next.updated_at, None, None, None, json!({ "version": next.version, "mode": next.mode.as_str(), "authority": next.authority.as_str(), "emergency_stop": true }));
                Store::tx_insert_event(tx, &mut pc)?;
                Ok(vec![ev, pc])
            })
            .map_err(internal)?;
        self.bus.publish(events);
        Ok(EmergencyStopResult { policy: next })
    }
}
