//! 事件总线:落库(同事务)在 store 里做,这里只管 commit 之后的广播与构造。

use contracts_rs::records::{EventName, ExecEvent};
use contracts_rs::{AccountRef, Symbol, Uuid};
use serde_json::{Map, Value};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<ExecEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(4096);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ExecEvent> {
        self.tx.subscribe()
    }

    /// commit 之后调用;没有订阅者也不算错。
    pub fn publish(&self, events: Vec<ExecEvent>) {
        for event in events {
            let _ = self.tx.send(event);
        }
    }
}

/// 构造一条待落库的事件(seq 由 store 分配)。
pub fn make_event(name: EventName, at: i64, account: Option<AccountRef>, intent_id: Option<&Uuid>, symbol: Option<&Symbol>, payload: Value) -> ExecEvent {
    let payload = match payload {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => {
            let mut map = Map::new();
            map.insert("value".into(), other);
            map
        }
    };
    ExecEvent {
        schema_version: 1,
        seq: 0,
        event: name,
        at,
        account,
        intent_id: intent_id.cloned(),
        plan_id: None,
        attempt_id: None,
        symbol: symbol.cloned(),
        payload,
    }
}
