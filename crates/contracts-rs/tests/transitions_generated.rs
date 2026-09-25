//! R6:由 `transitions/*.json` 生成的状态机测试(docs/contracts/README.md §6 六条规则)+ 枚举对拍。

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use contracts_rs::enums::{AttemptResult, AuthorizationStatus, ExchangeOrderStatus, IntentStatus};
use contracts_rs::transitions::{MACHINES, can_transition, is_terminal, next_state, outgoing, states, table};

fn schema_enum_values(def: &str) -> Vec<String> {
    let text = std::fs::read_to_string(contracts_rs::contracts_dir().join("schema/common.json")).unwrap();
    let common: serde_json::Value = serde_json::from_str(&text).unwrap();
    common["$defs"][def]["enum"]
        .as_array()
        .unwrap_or_else(|| panic!("common.json 缺枚举 {def}"))
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

fn enum_for_machine(machine: &str) -> &'static str {
    match machine {
        "intent_status" => "IntentStatus",
        "authorization_status" => "AuthorizationStatus",
        "attempt_result" => "AttemptResult",
        "exchange_order_status" => "ExchangeOrderStatus",
        other => panic!("未知机器 {other}"),
    }
}

#[test]
fn rule1_every_ordered_pair_agrees_with_table() {
    for machine in MACHINES {
        let t = table(machine);
        let edges: BTreeSet<(String, String)> = t.transitions.iter().map(|x| (x.from.clone(), x.to.clone())).collect();
        for from in &t.states {
            for to in &t.states {
                let expected = edges.contains(&(from.clone(), to.clone()));
                assert_eq!(can_transition(machine, from, to), expected, "{machine}: {from} -> {to}");
                if from == to {
                    assert!(!expected, "{machine}: 自环 {from} 不该出现在表里");
                }
            }
        }
    }
}

#[test]
fn rule2_terminal_states_have_no_outgoing_and_nonterminal_have_some() {
    for machine in MACHINES {
        let t = table(machine);
        for state in &t.states {
            let out = outgoing(machine, state);
            if is_terminal(machine, state) {
                assert!(out.is_empty(), "{machine}: 终态 {state} 有出边 {:?}", out.iter().map(|x| &x.to).collect::<Vec<_>>());
            } else {
                assert!(!out.is_empty(), "{machine}: 非终态 {state} 没有出边");
            }
        }
        for terminal in &t.terminal {
            assert!(t.states.contains(terminal), "{machine}: terminal {terminal} 不在 states 里");
        }
    }
}

#[test]
fn rule3_every_state_reachable_from_initial() {
    for machine in MACHINES {
        let t = table(machine);
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut queue = VecDeque::from([t.initial.clone()]);
        while let Some(s) = queue.pop_front() {
            if !seen.insert(s.clone()) {
                continue;
            }
            for e in outgoing(machine, &s) {
                queue.push_back(e.to.clone());
            }
        }
        for state in &t.states {
            assert!(seen.contains(state), "{machine}: {state} 从 {} 不可达", t.initial);
        }
        assert!(t.states.contains(&t.initial));
    }
}

#[test]
fn rule4_from_event_pairs_are_unique() {
    for machine in MACHINES {
        let t = table(machine);
        let mut seen: BTreeMap<(String, String), String> = BTreeMap::new();
        for tr in &t.transitions {
            let key = (tr.from.clone(), tr.event.clone());
            if let Some(prev) = seen.insert(key.clone(), tr.to.clone()) {
                panic!("{machine}: ({}, {}) 同时指向 {prev} 与 {}", tr.from, tr.event, tr.to);
            }
            assert!(t.states.contains(&tr.from) && t.states.contains(&tr.to), "{machine}: 边引用了未知状态");
        }
    }
}

#[test]
fn rule5_next_state_follows_table_and_rejects_unknown_events() {
    for machine in MACHINES {
        let t = table(machine);
        for tr in &t.transitions {
            assert_eq!(next_state(machine, &tr.from, &tr.event), Some(tr.to.as_str()), "{machine}: {} --{}-->", tr.from, tr.event);
        }
        for state in &t.states {
            assert_eq!(next_state(machine, state, "__no_such_event__"), None);
        }
    }
}

#[test]
fn rule6_schema_enums_equal_table_states() {
    for machine in MACHINES {
        let from_schema: BTreeSet<String> = schema_enum_values(enum_for_machine(machine)).into_iter().collect();
        let from_table: BTreeSet<String> = states(machine).iter().cloned().collect();
        assert_eq!(from_schema, from_table, "{machine}: schema 枚举与表 states 不一致");
    }
}

#[test]
fn typed_wrappers_cover_every_state() {
    for s in IntentStatus::ALL {
        assert!(states("intent_status").contains(&s.as_str().to_owned()));
        assert_eq!(s.is_terminal(), is_terminal("intent_status", s.as_str()));
    }
    for s in AuthorizationStatus::ALL {
        assert_eq!(s.is_terminal(), is_terminal("authorization_status", s.as_str()));
    }
    for s in AttemptResult::ALL {
        assert_eq!(s.is_terminal(), is_terminal("attempt_result", s.as_str()));
    }
    for s in ExchangeOrderStatus::ALL {
        assert_eq!(s.is_terminal(), is_terminal("exchange_order_status", s.as_str()));
    }
    // 设计 §5.1 的几条不变量
    assert!(!IntentStatus::ExecutionUnknown.is_terminal(), "execution_unknown 非终态,没有 LOST");
    assert!(IntentStatus::ExecutionUnknown.can_transition_to(IntentStatus::Executing));
    assert!(IntentStatus::ExecutionUnknown.can_transition_to(IntentStatus::Canceled));
    assert!(!IntentStatus::Authorized.can_transition_to(IntentStatus::Executing), "必须经过 dispatching");
    assert!(AuthorizationStatus::Active.can_transition_to(AuthorizationStatus::Invalidated));
}
