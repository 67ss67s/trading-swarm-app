//! 状态转移表(`packages/contracts/transitions/*.json`,README §6)。
//!
//! 表是唯一真相:`can_transition` / `next_state` / `is_terminal` 全部查表;强类型包装
//! (`IntentStatus::can_transition_to` 等)只是把字符串换成枚举。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde::Deserialize;

use crate::enums::{AttemptResult, AuthorizationStatus, ExchangeOrderStatus, IntentStatus};

#[derive(Debug, Clone, Deserialize)]
pub struct TransitionTable {
    pub machine: String,
    pub version: u32,
    #[serde(default)]
    pub description: String,
    pub initial: String,
    pub states: Vec<String>,
    pub terminal: Vec<String>,
    pub transitions: Vec<Transition>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Transition {
    pub from: String,
    pub to: String,
    pub event: String,
    #[serde(default)]
    pub note: Option<String>,
}

/// 四台机器的名字(与文件名/`machine` 字段一致)。
pub const MACHINES: &[&str] = &["intent_status", "authorization_status", "attempt_result", "exchange_order_status"];

const INTENT_STATUS: &str = include_str!("../../../packages/contracts/transitions/intent_status.json");
const AUTHORIZATION_STATUS: &str = include_str!("../../../packages/contracts/transitions/authorization_status.json");
const ATTEMPT_RESULT: &str = include_str!("../../../packages/contracts/transitions/attempt_result.json");
const EXCHANGE_ORDER_STATUS: &str = include_str!("../../../packages/contracts/transitions/exchange_order_status.json");

struct Compiled {
    table: TransitionTable,
    states: BTreeSet<String>,
    terminal: BTreeSet<String>,
    edges: BTreeSet<(String, String)>,
    by_event: BTreeMap<(String, String), String>,
}

fn compile(json: &str) -> Compiled {
    let table: TransitionTable = serde_json::from_str(json).expect("transitions 表合法");
    let states: BTreeSet<String> = table.states.iter().cloned().collect();
    let terminal: BTreeSet<String> = table.terminal.iter().cloned().collect();
    let mut edges = BTreeSet::new();
    let mut by_event = BTreeMap::new();
    for t in &table.transitions {
        edges.insert((t.from.clone(), t.to.clone()));
        by_event.insert((t.from.clone(), t.event.clone()), t.to.clone());
    }
    Compiled { table, states, terminal, edges, by_event }
}

fn all() -> &'static BTreeMap<&'static str, Compiled> {
    static ALL: OnceLock<BTreeMap<&'static str, Compiled>> = OnceLock::new();
    ALL.get_or_init(|| {
        let mut m = BTreeMap::new();
        m.insert("intent_status", compile(INTENT_STATUS));
        m.insert("authorization_status", compile(AUTHORIZATION_STATUS));
        m.insert("attempt_result", compile(ATTEMPT_RESULT));
        m.insert("exchange_order_status", compile(EXCHANGE_ORDER_STATUS));
        m
    })
}

fn machine(name: &str) -> &'static Compiled {
    all().get(name).unwrap_or_else(|| panic!("未知状态机 {name:?};可选 {MACHINES:?}"))
}

/// 原始表(测试与文档生成用)。
pub fn table(name: &str) -> &'static TransitionTable {
    &machine(name).table
}

pub fn machines() -> &'static [&'static str] {
    MACHINES
}

pub fn states(name: &str) -> &'static [String] {
    &machine(name).table.states
}

pub fn is_state(name: &str, state: &str) -> bool {
    machine(name).states.contains(state)
}

pub fn is_terminal(name: &str, state: &str) -> bool {
    machine(name).terminal.contains(state)
}

/// 表里是否有 from→to 这条边(自环恒 false:不是状态变化)。
pub fn can_transition(name: &str, from: &str, to: &str) -> bool {
    machine(name).edges.contains(&(from.to_owned(), to.to_owned()))
}

/// 在 from 状态收到 event 应到哪个状态;表里没有 → None。
pub fn next_state(name: &str, from: &str, event: &str) -> Option<&'static str> {
    machine(name).by_event.get(&(from.to_owned(), event.to_owned())).map(String::as_str)
}

/// from 的全部出边。
pub fn outgoing(name: &str, from: &str) -> Vec<&'static Transition> {
    machine(name).table.transitions.iter().filter(|t| t.from == from).collect()
}

/// 非法迁移的结构化错误(execd 映射成 ErrorKind::InvalidTransition)。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{machine}: {from} → {to} 不是合法迁移(事件 {event:?})")]
pub struct InvalidTransition {
    pub machine: &'static str,
    pub from: String,
    pub to: String,
    pub event: Option<String>,
}

macro_rules! typed_machine {
    ($ty:ty, $name:literal) => {
        impl $ty {
            pub const MACHINE: &'static str = $name;

            pub fn is_terminal(self) -> bool {
                is_terminal($name, self.as_str())
            }

            pub fn can_transition_to(self, to: Self) -> bool {
                can_transition($name, self.as_str(), to.as_str())
            }

            /// 校验并返回 to;非法则 Err。
            pub fn transition_to(self, to: Self, event: Option<&str>) -> Result<Self, InvalidTransition> {
                if self.can_transition_to(to) {
                    Ok(to)
                } else {
                    Err(InvalidTransition {
                        machine: $name,
                        from: self.as_str().to_owned(),
                        to: to.as_str().to_owned(),
                        event: event.map(str::to_owned),
                    })
                }
            }

            /// 按事件名查下一状态。
            pub fn on_event(self, event: &str) -> Option<Self> {
                next_state($name, self.as_str(), event).and_then(Self::parse)
            }
        }
    };
}

typed_machine!(IntentStatus, "intent_status");
typed_machine!(AuthorizationStatus, "authorization_status");
typed_machine!(AttemptResult, "attempt_result");
typed_machine!(ExchangeOrderStatus, "exchange_order_status");

impl ExchangeOrderStatus {
    /// 观察序列单调性:新观察 `next` 相对上一观察 `prev` 是否合法(同状态=合法,表有边=合法)。
    pub fn observation_consistent(prev: Self, next: Self) -> bool {
        prev == next || prev.can_transition_to(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_load_and_typed_wrappers_agree_with_raw() {
        assert!(IntentStatus::Proposed.can_transition_to(IntentStatus::AwaitingApproval));
        assert!(!IntentStatus::Completed.can_transition_to(IntentStatus::Proposed));
        assert!(IntentStatus::Completed.is_terminal());
        assert!(!IntentStatus::ExecutionUnknown.is_terminal(), "execution_unknown 非终态");
        assert_eq!(IntentStatus::AwaitingApproval.on_event("user_approved"), Some(IntentStatus::Authorized));
        assert_eq!(IntentStatus::AwaitingApproval.on_event("nope"), None);
        assert!(IntentStatus::Proposed.transition_to(IntentStatus::Executing, None).is_err());
        assert!(ExchangeOrderStatus::observation_consistent(ExchangeOrderStatus::PartiallyFilled, ExchangeOrderStatus::PartiallyFilled));
        assert!(!ExchangeOrderStatus::observation_consistent(ExchangeOrderStatus::Filled, ExchangeOrderStatus::New));
    }
}
