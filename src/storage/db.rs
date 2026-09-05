//! SQLite access. The database holds call history and runtime counters only —
//! configuration lives in the TOML file and is never mirrored here.

use anyhow::{Context, Result};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::{Path, PathBuf};

pub type Conn = r2d2::PooledConnection<SqliteConnectionManager>;

#[derive(Clone)]
pub struct Db {
    pool: Pool<SqliteConnectionManager>,
    path: PathBuf,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).ok();
            }
        }

        let manager = SqliteConnectionManager::file(path).with_init(|c| {
            // WAL keeps readers off the writer's back, which matters because
            // usage accounting runs after the response has been streamed.
            c.execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 PRAGMA busy_timeout=5000;
                 PRAGMA foreign_keys=ON;",
            )
        });
        let pool = Pool::builder()
            .max_size(8)
            .build(manager)
            .with_context(|| format!("failed to open database at {}", path.display()))?;

        let db = Db {
            pool,
            path: path.to_path_buf(),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self> {
        let manager = SqliteConnectionManager::memory();
        // A single connection, or each checkout would get its own empty database.
        let pool = Pool::builder().max_size(1).build(manager)?;
        let db = Db {
            pool,
            path: PathBuf::from(":memory:"),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn conn(&self) -> Result<Conn> {
        self.pool
            .get()
            .context("failed to check out a db connection")
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn()?;
        conn.execute_batch(
            r#"
            -- Call history: the only durable record in this database.
            CREATE TABLE IF NOT EXISTS request_logs (
              request_id      TEXT PRIMARY KEY,
              entry_model     TEXT,
              upstream_id     TEXT,
              upstream_model  TEXT,
              status          INTEGER,
              error_kind      TEXT,
              prompt_tokens   INTEGER,
              cached_tokens   INTEGER,
              completion_tokens INTEGER,
              total_tokens    INTEGER,
              latency_ms      INTEGER,
              created_at      TEXT NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_logs_created  ON request_logs(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_entry    ON request_logs(entry_model, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_upstream ON request_logs(upstream_id, created_at DESC);

            -- Rolling quota counters, one row per (upstream, limit, time bucket).
            -- `bucket_key` embeds the limit's own identity (type + quota +
            -- period + anchor), so a counter follows its limit through edits to
            -- the `limits` array. It deliberately does NOT include the array
            -- position: keying on position meant inserting or reordering a
            -- limit handed it whichever counter previously sat at that index,
            -- which could let an exhausted upstream serve again.
            CREATE TABLE IF NOT EXISTS quota_counters (
              upstream_id   TEXT NOT NULL,
              bucket_key    TEXT NOT NULL,
              used_count    INTEGER NOT NULL DEFAULT 0,
              used_weighted REAL    NOT NULL DEFAULT 0,
              in_flight     INTEGER NOT NULL DEFAULT 0,
              updated_at    TEXT NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (upstream_id, bucket_key)
            );
            CREATE INDEX IF NOT EXISTS idx_counters_updated ON quota_counters(updated_at);

            -- Transient error_backoff state; safe to delete at any time.
            CREATE TABLE IF NOT EXISTS upstream_states (
              upstream_id       TEXT NOT NULL,
              limit_idx         INTEGER NOT NULL,
              blocked_until     TEXT,
              consecutive_trips INTEGER NOT NULL DEFAULT 0,
              updated_at        TEXT NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (upstream_id, limit_idx)
            );
            "#,
        )
        .context("failed to run migrations")?;

        self.migrate_quota_counters_off_limit_idx(&conn)?;
        Ok(())
    }

    /// Drop the legacy positional `limit_idx` column from `quota_counters`.
    ///
    /// Old rows are keyed by array position, which is exactly the bug this
    /// change fixes — they cannot be rewritten into identity-keyed rows because
    /// the position alone does not say which limit they belonged to. They are
    /// therefore discarded rather than migrated: the cost is that quotas
    /// restart for the current period once, which is strictly safer than
    /// carrying a count that may belong to a different limit.
    fn migrate_quota_counters_off_limit_idx(&self, conn: &Conn) -> Result<()> {
        let has_legacy_column: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('quota_counters') WHERE name = 'limit_idx'")?
            .exists([])?;
        if !has_legacy_column {
            return Ok(());
        }

        conn.execute_batch(
            r#"
            BEGIN;
            DROP TABLE quota_counters;
            CREATE TABLE quota_counters (
              upstream_id   TEXT NOT NULL,
              bucket_key    TEXT NOT NULL,
              used_count    INTEGER NOT NULL DEFAULT 0,
              used_weighted REAL    NOT NULL DEFAULT 0,
              in_flight     INTEGER NOT NULL DEFAULT 0,
              updated_at    TEXT NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (upstream_id, bucket_key)
            );
            CREATE INDEX IF NOT EXISTS idx_counters_updated ON quota_counters(updated_at);
            COMMIT;
            "#,
        )
        .context("failed to migrate quota_counters off limit_idx")?;
        tracing::info!(
            "migrated quota_counters to identity-keyed buckets; current-period counts reset once"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let conn = db.conn().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN
                 ('request_logs','quota_counters','upstream_states')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 3);
    }
}
