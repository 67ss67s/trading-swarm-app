//! exec.sqlite 的 DAO。rusqlite 是同步的:连接放 `Mutex` 里,事务短小;状态迁移与事件写入永远在同一事务
//! (`Store::transaction`),广播在 commit 之后由调用方做。

use std::path::Path;
use std::sync::Mutex;

use anyhow::Context;
use contracts_rs::records::{Authorization, ExchangeOrderObservation, ExecEvent, ExecPolicy, ExecutionAttempt, Fill, PositionEffect};
use contracts_rs::{ExecutableOrderPlan, Intent, IntentStatus, Principal};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::paths::now_ms;

pub struct Store {
    conn: Mutex<Connection>,
}

/// intents.list 的过滤条件。
#[derive(Debug, Default, Clone)]
pub struct IntentFilter {
    pub status: Option<Vec<IntentStatus>>,
    pub account: Option<String>,
    pub kind: Option<String>,
    pub since: Option<i64>,
    pub limit: u32,
}

impl Store {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let mut conn = crate::db::open(path)?;
        crate::db::migrate(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn in_memory() -> anyhow::Result<Self> {
        let mut conn = crate::db::open_in_memory()?;
        crate::db::migrate(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 只读/单语句用。
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> anyhow::Result<T>) -> anyhow::Result<T> {
        let guard = self.conn.lock().map_err(|_| anyhow::anyhow!("store mutex poisoned"))?;
        f(&guard)
    }

    /// 事务:闭包 Ok 则 commit,Err 则回滚。
    pub fn transaction<T>(&self, f: impl FnOnce(&Transaction) -> anyhow::Result<T>) -> anyhow::Result<T> {
        let mut guard = self.conn.lock().map_err(|_| anyhow::anyhow!("store mutex poisoned"))?;
        let tx = guard.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    pub fn db_ok(&self) -> bool {
        self.with_conn(|c| Ok(c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))? == 1)).unwrap_or(false)
    }

    // ------------------------------------------------------------------ policy

    pub fn load_policy(&self) -> anyhow::Result<Option<ExecPolicy>> {
        self.with_conn(|c| {
            let json: Option<String> = c.query_row("SELECT json FROM policy WHERE id = 1", [], |r| r.get(0)).optional()?;
            Ok(match json {
                Some(text) => Some(serde_json::from_str(&text).context("policy 行不是合法 ExecPolicy")?),
                None => None,
            })
        })
    }

    pub fn tx_upsert_policy(tx: &Transaction, policy: &ExecPolicy) -> anyhow::Result<()> {
        tx.execute(
            "INSERT INTO policy(id, version, json, updated_at) VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at",
            params![policy.version, serde_json::to_string(policy)?, policy.updated_at],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------------ events

    /// 插入事件并把分配到的 seq 写回 `event.seq`。
    pub fn tx_insert_event(tx: &Transaction, event: &mut ExecEvent) -> anyhow::Result<u64> {
        tx.execute(
            "INSERT INTO events(event, at, account, intent_id, json) VALUES (?1, ?2, ?3, ?4, '{}')",
            params![
                event.event.as_str(),
                event.at,
                event.account.map(|a| a.as_str().to_owned()),
                event.intent_id.as_ref().map(|u| u.as_str().to_owned()),
            ],
        )?;
        let seq = tx.last_insert_rowid() as u64;
        event.seq = seq;
        tx.execute("UPDATE events SET json = ?1 WHERE seq = ?2", params![serde_json::to_string(event)?, seq as i64])?;
        Ok(seq)
    }

    pub fn events_since(&self, since_seq: u64, limit: u32) -> anyhow::Result<Vec<ExecEvent>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare("SELECT json FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2")?;
            let rows = stmt.query_map(params![since_seq as i64, limit as i64], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(serde_json::from_str(&row?)?);
            }
            Ok(out)
        })
    }

    pub fn current_seq(&self) -> anyhow::Result<u64> {
        self.with_conn(|c| Ok(c.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get::<_, i64>(0))? as u64))
    }

    // ------------------------------------------------------------------ intents

    pub fn tx_insert_intent(tx: &Transaction, intent: &Intent) -> anyhow::Result<()> {
        tx.execute(
            "INSERT INTO intents(intent_id, account, kind, principal, surface, status, idempotency_key, symbol, json, created_at, updated_at, terminal_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                intent.intent_id.as_str(),
                intent.account.as_str(),
                intent.kind().as_str(),
                intent.principal.as_str(),
                intent.surface.as_str(),
                intent.status.as_str(),
                intent.idempotency_key,
                intent.params.symbol().map(|s| s.as_str().to_owned()),
                serde_json::to_string(intent)?,
                intent.created_at,
                intent.updated_at,
                intent.terminal_at,
            ],
        )?;
        Ok(())
    }

    pub fn tx_update_intent(tx: &Transaction, intent: &Intent) -> anyhow::Result<()> {
        let n = tx.execute(
            "UPDATE intents SET status = ?2, json = ?3, updated_at = ?4, terminal_at = ?5 WHERE intent_id = ?1",
            params![
                intent.intent_id.as_str(),
                intent.status.as_str(),
                serde_json::to_string(intent)?,
                intent.updated_at,
                intent.terminal_at,
            ],
        )?;
        anyhow::ensure!(n == 1, "intent {} 不存在", intent.intent_id);
        Ok(())
    }

    pub fn get_intent(&self, intent_id: &str) -> anyhow::Result<Option<Intent>> {
        self.with_conn(|c| {
            let json: Option<String> =
                c.query_row("SELECT json FROM intents WHERE intent_id = ?1", params![intent_id], |r| r.get(0)).optional()?;
            Ok(match json {
                Some(text) => Some(serde_json::from_str(&text)?),
                None => None,
            })
        })
    }

    pub fn find_intent_by_idempotency(&self, principal: Principal, key: &str) -> anyhow::Result<Option<Intent>> {
        self.with_conn(|c| {
            let json: Option<String> = c
                .query_row(
                    "SELECT json FROM intents WHERE principal = ?1 AND idempotency_key = ?2",
                    params![principal.as_str(), key],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(match json {
                Some(text) => Some(serde_json::from_str(&text)?),
                None => None,
            })
        })
    }

    pub fn list_intents(&self, filter: &IntentFilter) -> anyhow::Result<Vec<Intent>> {
        self.with_conn(|c| {
            let mut sql = String::from("SELECT json FROM intents WHERE 1=1");
            let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(statuses) = &filter.status
                && !statuses.is_empty()
            {
                let placeholders: Vec<String> = statuses.iter().enumerate().map(|(i, _)| format!("?{}", args.len() + i + 1)).collect();
                sql.push_str(&format!(" AND status IN ({})", placeholders.join(",")));
                for s in statuses {
                    args.push(Box::new(s.as_str().to_owned()));
                }
            }
            if let Some(account) = &filter.account {
                args.push(Box::new(account.clone()));
                sql.push_str(&format!(" AND account = ?{}", args.len()));
            }
            if let Some(kind) = &filter.kind {
                args.push(Box::new(kind.clone()));
                sql.push_str(&format!(" AND kind = ?{}", args.len()));
            }
            if let Some(since) = filter.since {
                args.push(Box::new(since));
                sql.push_str(&format!(" AND created_at >= ?{}", args.len()));
            }
            args.push(Box::new(filter.limit.clamp(1, 500) as i64));
            sql.push_str(&format!(" ORDER BY created_at DESC LIMIT ?{}", args.len()));
            let mut stmt = c.prepare(&sql)?;
            let params_ref: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
            let rows = stmt.query_map(params_ref.as_slice(), |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(serde_json::from_str(&row?)?);
            }
            Ok(out)
        })
    }

    pub fn count_open_intents(&self) -> anyhow::Result<u32> {
        let terminal: Vec<String> = IntentStatus::ALL.iter().filter(|s| s.is_terminal()).map(|s| format!("'{}'", s.as_str())).collect();
        let sql = format!("SELECT COUNT(*) FROM intents WHERE status NOT IN ({})", terminal.join(","));
        self.with_conn(|c| Ok(c.query_row(&sql, [], |r| r.get::<_, i64>(0))? as u32))
    }

    pub fn count_unknown_attempts(&self) -> anyhow::Result<u32> {
        self.with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM attempts WHERE result = 'unknown'", [], |r| r.get::<_, i64>(0))? as u32))
    }

    // ------------------------------------------------------------------ bundle 读取(A0 里通常为空)

    pub fn get_plan(&self, plan_id: &str) -> anyhow::Result<Option<ExecutableOrderPlan>> {
        self.with_conn(|c| {
            let json: Option<String> = c.query_row("SELECT json FROM plans WHERE plan_id = ?1", params![plan_id], |r| r.get(0)).optional()?;
            Ok(match json {
                Some(t) => Some(serde_json::from_str(&t)?),
                None => None,
            })
        })
    }

    pub fn get_authorization(&self, authorization_id: &str) -> anyhow::Result<Option<Authorization>> {
        self.with_conn(|c| {
            let json: Option<String> = c
                .query_row("SELECT json FROM authorizations WHERE authorization_id = ?1", params![authorization_id], |r| r.get(0))
                .optional()?;
            Ok(match json {
                Some(t) => Some(serde_json::from_str(&t)?),
                None => None,
            })
        })
    }

    pub fn attempts_for_intent(&self, intent_id: &str) -> anyhow::Result<Vec<ExecutionAttempt>> {
        self.json_rows("SELECT json FROM attempts WHERE intent_id = ?1 ORDER BY created_at ASC", intent_id)
    }

    pub fn orders_for_intent(&self, intent_id: &str) -> anyhow::Result<Vec<ExchangeOrderObservation>> {
        self.json_rows(
            "SELECT o.json FROM exchange_orders o JOIN attempts a ON a.client_order_id = o.client_order_id WHERE a.intent_id = ?1 ORDER BY o.observed_at ASC",
            intent_id,
        )
    }

    pub fn fills_for_intent(&self, intent_id: &str) -> anyhow::Result<Vec<Fill>> {
        self.json_rows(
            "SELECT f.json FROM fills f JOIN attempts a ON a.client_order_id = json_extract(f.json, '$.client_order_id') WHERE a.intent_id = ?1 ORDER BY f.trade_time ASC",
            intent_id,
        )
    }

    pub fn effect_for_intent(&self, intent_id: &str) -> anyhow::Result<Option<PositionEffect>> {
        self.with_conn(|c| {
            let json: Option<String> =
                c.query_row("SELECT json FROM position_effects WHERE intent_id = ?1", params![intent_id], |r| r.get(0)).optional()?;
            Ok(match json {
                Some(t) => Some(serde_json::from_str(&t)?),
                None => None,
            })
        })
    }

    fn json_rows<T: serde::de::DeserializeOwned>(&self, sql: &str, arg: &str) -> anyhow::Result<Vec<T>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare(sql)?;
            let rows = stmt.query_map(params![arg], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(serde_json::from_str(&row?)?);
            }
            Ok(out)
        })
    }

    // ------------------------------------------------------------------ writer lease

    /// 启动时为每条 lane 抢租约:epoch+1,写入本实例。返回新 epoch。
    pub fn bump_writer_lease(&self, lane: &str, instance_id: &str, until: i64) -> anyhow::Result<u64> {
        self.transaction(|tx| {
            let current: Option<i64> =
                tx.query_row("SELECT epoch FROM writer_lease WHERE lane = ?1", params![lane], |r| r.get(0)).optional()?;
            let next = current.unwrap_or(0) + 1;
            tx.execute(
                "INSERT INTO writer_lease(lane, instance_id, epoch, until) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(lane) DO UPDATE SET instance_id = excluded.instance_id, epoch = excluded.epoch, until = excluded.until",
                params![lane, instance_id, next, until],
            )?;
            Ok(next as u64)
        })
    }

    pub fn kv_set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO kv(key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value, now_ms()],
            )?;
            Ok(())
        })
    }

    pub fn kv_get(&self, key: &str) -> anyhow::Result<Option<String>> {
        self.with_conn(|c| Ok(c.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0)).optional()?))
    }
}
