//! exec.sqlite 打开与迁移。WAL、外键、busy_timeout;迁移按版本号一个事务一条,幂等。

use std::path::Path;

use anyhow::Context;
use rusqlite::{Connection, OpenFlags, params};

/// (版本, SQL)。新迁移只追加,不改旧的。
pub const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/0001_init.sql"))];

pub fn open(path: &Path) -> anyhow::Result<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags).with_context(|| format!("打开 {}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    crate::paths::set_mode(path, 0o600).ok();
    Ok(conn)
}

pub fn open_in_memory() -> anyhow::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

/// 跑所有未应用的迁移;返回应用了几条。
pub fn migrate(conn: &mut Connection) -> anyhow::Result<usize> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
    )?;
    let mut applied = 0;
    for (version, sql) in MIGRATIONS {
        let exists: bool = conn
            .query_row("SELECT 1 FROM schema_migrations WHERE version = ?1", params![version], |_| Ok(()))
            .is_ok();
        if exists {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql).with_context(|| format!("迁移 {version} 执行失败"))?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![version, crate::paths::now_ms()],
        )?;
        tx.commit()?;
        applied += 1;
    }
    Ok(applied)
}

pub fn current_version(conn: &Connection) -> anyhow::Result<i64> {
    Ok(conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))
        .unwrap_or(0))
}

pub fn table_names(conn: &Connection) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent_and_create_all_tables() {
        let mut conn = open_in_memory().unwrap();
        assert_eq!(migrate(&mut conn).unwrap(), MIGRATIONS.len());
        assert_eq!(migrate(&mut conn).unwrap(), 0, "第二遍不该再应用");
        assert_eq!(current_version(&conn).unwrap(), 1);
        let tables = table_names(&conn).unwrap();
        for expected in [
            "intents", "plans", "authorizations", "attempts", "exchange_orders", "fills", "position_effects",
            "account_snapshots", "ops_queue", "writer_lease", "events", "policy", "kv", "schema_migrations",
        ] {
            assert!(tables.contains(&expected.to_string()), "缺表 {expected}:{tables:?}");
        }
    }

    #[test]
    fn file_db_opens_in_wal_mode() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("exec.sqlite")).unwrap();
        migrate(&mut conn).unwrap();
        let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let fk: i64 = conn.pragma_query_value(None, "foreign_keys", |r| r.get(0)).unwrap();
        assert_eq!(fk, 1);
    }
}
