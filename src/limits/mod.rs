//! The rate-limit engine.
//!
//! An upstream is eligible only if *every* one of its limits admits the
//! request. `frequency` and `tokens` are counted in time buckets;
//! `error_backoff` reads recent history and parks the upstream for a while.
//!
//! Token spend is only known after the response, so `tokens` limits reserve a
//! slot up front and settle the real cost in `finalize`.

pub mod bucket;

use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::params;

use crate::clock::LocalClock;
use crate::config::{AnchorSpec, Limit, TimeRange, TokenWeight, Upstream};
use crate::storage::db::Db;
use crate::storage::logs::Usage;

pub use bucket::{bucket_key, scoped_bucket_key};

/// Why an upstream was passed over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Denied {
    Disabled,
    FrequencyExceeded {
        limit_idx: usize,
    },
    TokensExceeded {
        limit_idx: usize,
    },
    BackedOff {
        limit_idx: usize,
        until: String,
    },
    /// Inside a forbidden wall-clock window. `until` is a local time, because
    /// that is the clock the rule was written against.
    OutsideAllowedHours {
        limit_idx: usize,
        window: String,
        until: String,
    },
}

impl Denied {
    pub fn reason(&self) -> String {
        match self {
            Denied::Disabled => "disabled".into(),
            Denied::FrequencyExceeded { limit_idx } => {
                format!("frequency limit #{limit_idx} exhausted")
            }
            Denied::TokensExceeded { limit_idx } => format!("token limit #{limit_idx} exhausted"),
            Denied::BackedOff { limit_idx, until } => {
                format!("backing off after errors (limit #{limit_idx}) until {until}")
            }
            Denied::OutsideAllowedHours {
                limit_idx,
                window,
                until,
            } => format!("inside forbidden window {window} (limit #{limit_idx}), until {until}"),
        }
    }
}

/// Bookkeeping handed back so a granted request can be settled afterwards.
#[derive(Debug, Clone)]
pub struct Grant {
    pub upstream_id: String,
    /// Token limits that reserved a slot: (bucket key, weights). The key alone
    /// identifies the row, so no array index is carried here — that is what
    /// made counters break when the config was edited mid-flight.
    reserved_tokens: Vec<(String, TokenWeight)>,
    /// Frequency limits already counted; rolled back if the attempt never ran.
    counted_frequency: Vec<String>,
}

pub struct Limiter {
    db: Db,
    /// The wall clock time-window limits are read against.
    clock: LocalClock,
}

impl Limiter {
    pub fn new(db: Db, clock: LocalClock) -> Self {
        Self { db, clock }
    }

    pub fn clock(&self) -> &LocalClock {
        &self.clock
    }

    /// Try to claim capacity on `upstream`. All limits must admit the request;
    /// if a later limit refuses, everything already claimed is released.
    pub fn acquire(
        &self,
        upstream: &Upstream,
        now: DateTime<Utc>,
    ) -> Result<Result<Grant, Denied>> {
        if !upstream.enabled {
            return Ok(Err(Denied::Disabled));
        }

        let mut grant = Grant {
            upstream_id: upstream.model.clone(),
            reserved_tokens: Vec::new(),
            counted_frequency: Vec::new(),
        };

        for (idx, limit) in upstream.limits.iter().enumerate() {
            let outcome = match limit {
                Limit::Frequency { count, period } => {
                    let key = scoped_bucket_key(
                        &limit.identity(),
                        now,
                        period.as_secs(),
                        Some(self.midnight_anchor(now)),
                    );
                    if self.try_count(&upstream.model, &key, count.get())? {
                        grant.counted_frequency.push(key);
                        Ok(())
                    } else {
                        Err(Denied::FrequencyExceeded { limit_idx: idx })
                    }
                }
                Limit::Tokens {
                    count,
                    period,
                    weight,
                } => {
                    let key = scoped_bucket_key(
                        &limit.identity(),
                        now,
                        period.as_secs(),
                        Some(self.midnight_anchor(now)),
                    );
                    if self.try_reserve_tokens(&upstream.model, &key, count.get())? {
                        grant
                            .reserved_tokens
                            .push((key, weight.unwrap_or_default()));
                        Ok(())
                    } else {
                        Err(Denied::TokensExceeded { limit_idx: idx })
                    }
                }
                Limit::TimeWindow { forbidden, days } => {
                    match self.forbidden_now(forbidden, days, now) {
                        Some((window, until)) => Err(Denied::OutsideAllowedHours {
                            limit_idx: idx,
                            window,
                            until,
                        }),
                        None => Ok(()),
                    }
                }
                Limit::ErrorBackoff { .. } => {
                    match self.blocked_until(&upstream.model, idx, now)? {
                        Some(until) => Err(Denied::BackedOff {
                            limit_idx: idx,
                            until,
                        }),
                        None => Ok(()),
                    }
                }
            };

            if let Err(denied) = outcome {
                self.release(&grant, true)?;
                return Ok(Err(denied));
            }
        }

        Ok(Ok(grant))
    }

    /// Settle a grant once the attempt has finished.
    ///
    /// `usage` is `None` when the attempt never produced a billable response;
    /// the reservation is then released and the request refunded, so a request
    /// that failed over to another upstream does not burn quota here.
    pub fn finalize(
        &self,
        upstream: &Upstream,
        grant: &Grant,
        usage: Option<&Usage>,
        status: Option<u16>,
        error_kind: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        match usage {
            Some(u) => {
                for (key, weight) in &grant.reserved_tokens {
                    let cost = weighted_cost(u, *weight);
                    self.settle_tokens(&grant.upstream_id, key, cost)?;
                }
            }
            None => self.release(grant, false)?,
        }

        self.apply_error_backoff(upstream, status, error_kind, now)?;
        Ok(())
    }

    /// Undo the claims held by a grant. `refund_frequency` also gives back the
    /// counted requests, which is right when a *later* limit refused and the
    /// attempt never happened.
    fn release(&self, grant: &Grant, refund_frequency: bool) -> Result<()> {
        let conn = self.db.conn()?;
        for (key, _) in &grant.reserved_tokens {
            conn.execute(
                "UPDATE quota_counters SET in_flight = max(0, in_flight - 1),
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  WHERE upstream_id=?1 AND bucket_key=?2",
                params![grant.upstream_id, key],
            )?;
        }
        if refund_frequency {
            for key in &grant.counted_frequency {
                conn.execute(
                    "UPDATE quota_counters SET used_count = max(0, used_count - 1),
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                      WHERE upstream_id=?1 AND bucket_key=?2",
                    params![grant.upstream_id, key],
                )?;
            }
        }
        Ok(())
    }

    /// Increment a request counter if it is still under `max`.
    /// The guard lives in the UPDATE's WHERE clause, so concurrent callers can
    /// never both squeeze past the limit.
    fn try_count(&self, upstream_id: &str, key: &str, max: u64) -> Result<bool> {
        let conn = self.db.conn()?;
        conn.execute(
            "INSERT INTO quota_counters(upstream_id, bucket_key)
             VALUES(?1,?2) ON CONFLICT DO NOTHING",
            params![upstream_id, key],
        )?;
        let n = conn.execute(
            "UPDATE quota_counters SET used_count = used_count + 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE upstream_id=?1 AND bucket_key=?2
                AND used_count + 1 <= ?3",
            params![upstream_id, key, max as i64],
        )?;
        Ok(n == 1)
    }

    /// Reserve a token slot. Spend is unknown until the response arrives, so we
    /// admit while under budget and cap concurrent unsettled requests at one to
    /// keep a single large call from blowing far past the limit.
    fn try_reserve_tokens(&self, upstream_id: &str, key: &str, max: u64) -> Result<bool> {
        let conn = self.db.conn()?;
        conn.execute(
            "INSERT INTO quota_counters(upstream_id, bucket_key)
             VALUES(?1,?2) ON CONFLICT DO NOTHING",
            params![upstream_id, key],
        )?;
        let n = conn.execute(
            "UPDATE quota_counters SET in_flight = in_flight + 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE upstream_id=?1 AND bucket_key=?2
                AND used_weighted < ?3 AND in_flight = 0",
            params![upstream_id, key, max as f64],
        )?;
        Ok(n == 1)
    }

    fn settle_tokens(&self, upstream_id: &str, key: &str, cost: f64) -> Result<()> {
        let conn = self.db.conn()?;
        conn.execute(
            "UPDATE quota_counters
                SET used_weighted = used_weighted + ?3,
                    used_count = used_count + 1,
                    in_flight = max(0, in_flight - 1),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE upstream_id=?1 AND bucket_key=?2",
            params![upstream_id, key, cost],
        )?;
        Ok(())
    }

    /// The forbidden window `now` falls in, if any, as (window, local end time).
    ///
    /// Purely a function of the clock — no database round-trip — so it costs
    /// nothing on the request path.
    pub fn forbidden_now(
        &self,
        forbidden: &[TimeRange],
        days: &[u8],
        now: DateTime<Utc>,
    ) -> Option<(String, String)> {
        let secs = self.clock.secs_of_day(now);
        let weekday = self.clock.weekday(now);
        let hit = forbidden.iter().find(|r| {
            if !r.contains(secs) {
                return false;
            }

            // A wrapping window belongs to the weekday on which it starts.
            // Thus Thursday 22:00-05:00 still applies at 02:00 on Friday,
            // while Tuesday 02:00 belongs to Monday's window.
            let starts_previous_day = r.start.secs() > r.end.secs() && secs < r.end.secs();
            let start_weekday = if starts_previous_day {
                if weekday == 1 {
                    7
                } else {
                    weekday - 1
                }
            } else {
                weekday
            };
            days.is_empty() || days.contains(&start_weekday)
        })?;
        let until = self
            .clock
            .local_after(now, hit.seconds_until_end(secs) as i64);
        Some((hit.to_string(), until))
    }

    /// Frequency periods always tile from 00:00 on the gateway's wall clock.
    fn midnight_anchor(&self, now: DateTime<Utc>) -> AnchorSpec {
        AnchorSpec {
            time_of_day_secs: 0,
            utc_offset_secs: self.clock.offset_secs(now),
        }
    }

    fn blocked_until(
        &self,
        upstream_id: &str,
        idx: usize,
        now: DateTime<Utc>,
    ) -> Result<Option<String>> {
        let conn = self.db.conn()?;
        let until: Option<String> = conn
            .query_row(
                "SELECT blocked_until FROM upstream_states
                  WHERE upstream_id=?1 AND limit_idx=?2",
                params![upstream_id, idx as i64],
                |r| r.get(0),
            )
            .ok()
            .flatten();

        Ok(match until {
            Some(ts) if ts.as_str() > now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string().as_str() => {
                Some(ts)
            }
            _ => None,
        })
    }

    /// Re-evaluate every error_backoff limit against the recent call history.
    fn apply_error_backoff(
        &self,
        upstream: &Upstream,
        status: Option<u16>,
        error_kind: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        for (idx, limit) in upstream.limits.iter().enumerate() {
            let Limit::ErrorBackoff {
                window,
                threshold,
                backoff,
            } = limit
            else {
                continue;
            };

            // Include the attempt just finished: it is logged asynchronously and
            // may not be readable yet.
            let failed = error_kind.is_some() || status.map(|s| s >= 400).unwrap_or(true);
            let mut matches = u32::from(failed);
            let mut seen = 1u32;

            // Scoped so the read connection is back in the pool before the
            // write below asks for one; holding both at once deadlocks a
            // saturated pool.
            {
                let conn = self.db.conn()?;
                let mut stmt = conn.prepare(
                    "SELECT status, error_kind FROM request_logs
                      WHERE upstream_id=?1 ORDER BY created_at DESC LIMIT ?2",
                )?;
                let rows = stmt.query_map(
                    params![upstream.model, window.saturating_sub(1) as i64],
                    |r| Ok((r.get::<_, Option<u16>>(0)?, r.get::<_, Option<String>>(1)?)),
                )?;
                for row in rows {
                    let (s, k) = row?;
                    seen += 1;
                    if k.is_some() || s.map(|code| code >= 400).unwrap_or(true) {
                        matches += 1;
                    }
                }
            }

            let conn = self.db.conn()?;
            if matches >= *threshold && seen >= *threshold {
                // Trip: extend the streak and block for the next interval.
                conn.execute(
                    "INSERT INTO upstream_states(upstream_id, limit_idx, consecutive_trips)
                     VALUES(?1,?2,1)
                     ON CONFLICT(upstream_id, limit_idx) DO UPDATE SET
                       consecutive_trips = consecutive_trips + 1",
                    params![upstream.model, idx as i64],
                )?;
                let trips: u32 = conn.query_row(
                    "SELECT consecutive_trips FROM upstream_states
                      WHERE upstream_id=?1 AND limit_idx=?2",
                    params![upstream.model, idx as i64],
                    |r| r.get(0),
                )?;
                let until = now
                    + chrono::Duration::from_std(backoff.duration_for(trips))
                        .unwrap_or_else(|_| chrono::Duration::hours(24));
                conn.execute(
                    "UPDATE upstream_states
                        SET blocked_until=?3,
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                      WHERE upstream_id=?1 AND limit_idx=?2",
                    params![
                        upstream.model,
                        idx as i64,
                        until.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
                    ],
                )?;
            } else if error_kind.is_none() && status.map(|s| s < 400).unwrap_or(false) {
                // A clean success clears the streak.
                conn.execute(
                    "DELETE FROM upstream_states WHERE upstream_id=?1 AND limit_idx=?2",
                    params![upstream.model, idx as i64],
                )?;
            }
        }
        Ok(())
    }
}

/// Cost of a response under the configured weights. Uncached input is the 1.0
/// baseline; output and cached input scale from it.
fn weighted_cost(usage: &Usage, w: TokenWeight) -> f64 {
    let cached = usage.cached_tokens.unwrap_or(0).max(0) as f64;
    let prompt = usage.prompt_tokens.unwrap_or(0).max(0) as f64;
    let uncached = (prompt - cached).max(0.0);
    let output = usage.completion_tokens.unwrap_or(0).max(0) as f64;

    // Fall back to total_tokens when the upstream reports no breakdown.
    if prompt == 0.0 && output == 0.0 {
        return usage.total_tokens.unwrap_or(0).max(0) as f64;
    }

    uncached + output * w.output + cached * w.cache_read
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::units::{CountSpec, DurationSpec};
    use crate::config::{Backoff, Limit, Upstream};
    use crate::storage::logs::{self, LogEntry};
    use chrono::TimeZone;

    /// A fixed zone keeps the wall-clock assertions independent of the machine
    /// the tests happen to run on.
    fn test_clock() -> LocalClock {
        LocalClock::resolve("Asia/Shanghai").unwrap()
    }

    fn up(model: &str, limits: Vec<Limit>) -> Upstream {
        Upstream {
            model: model.into(),
            enabled: true,
            limits,
            extra: Default::default(),
        }
    }

    fn freq(count: u64, period: &str) -> Limit {
        Limit::Frequency {
            count: CountSpec(count),
            period: DurationSpec::parse(period).unwrap(),
        }
    }

    fn tokens(count: u64, period: &str, weight: Option<TokenWeight>) -> Limit {
        Limit::Tokens {
            count: CountSpec(count),
            period: DurationSpec::parse(period).unwrap(),
            weight,
        }
    }

    fn usage(prompt: i64, cached: i64, completion: i64) -> Usage {
        Usage {
            prompt_tokens: Some(prompt),
            cached_tokens: Some(cached),
            completion_tokens: Some(completion),
            total_tokens: Some(prompt + completion),
        }
    }

    #[test]
    fn frequency_limit_admits_then_refuses() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let u = up("a", vec![freq(2, "1min")]);
        let now = Utc::now();

        assert!(l.acquire(&u, now).unwrap().is_ok());
        assert!(l.acquire(&u, now).unwrap().is_ok());
        assert_eq!(
            l.acquire(&u, now).unwrap().unwrap_err(),
            Denied::FrequencyExceeded { limit_idx: 0 }
        );
    }

    #[test]
    fn frequency_limit_resets_in_the_next_bucket() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let u = up("a", vec![freq(1, "1min")]);
        let now = Utc::now();

        assert!(l.acquire(&u, now).unwrap().is_ok());
        assert!(l.acquire(&u, now).unwrap().is_err());
        // A minute later the bucket rolls over.
        assert!(l
            .acquire(&u, now + chrono::Duration::seconds(61))
            .unwrap()
            .is_ok());
    }

    #[test]
    fn disabled_upstream_is_never_eligible() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let mut u = up("a", vec![]);
        u.enabled = false;
        assert_eq!(
            l.acquire(&u, Utc::now()).unwrap().unwrap_err(),
            Denied::Disabled
        );
    }

    #[test]
    fn all_limits_must_pass_and_a_refusal_refunds_the_earlier_ones() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db.clone(), test_clock());
        // The frequency limit admits; the token limit is already exhausted.
        let u = up("a", vec![freq(100, "1min"), tokens(10, "1d", None)]);
        let now = Utc::now();

        let g = l.acquire(&u, now).unwrap().unwrap();
        l.finalize(&u, &g, Some(&usage(10, 0, 5)), Some(200), None, now)
            .unwrap();

        // Budget is spent, so the whole upstream is refused...
        assert_eq!(
            l.acquire(&u, now).unwrap().unwrap_err(),
            Denied::TokensExceeded { limit_idx: 1 }
        );

        // ...and the frequency counter was refunded, not left inflated.
        let conn = db.conn().unwrap();
        let used: i64 = conn
            .query_row(
                "SELECT used_count FROM quota_counters
                  WHERE upstream_id='a' AND bucket_key LIKE 'frequency:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            used, 1,
            "the refused attempt must not consume frequency quota"
        );
    }

    #[test]
    fn token_weights_price_output_and_cache_reads() {
        let w = TokenWeight {
            output: 10.0,
            cache_read: 0.1,
            cache_write: 1.0,
        };
        // 1000 prompt of which 800 cached, 100 output
        // => 200*1 + 100*10 + 800*0.1 = 1280
        assert_eq!(weighted_cost(&usage(1000, 800, 100), w), 1280.0);

        // Without weights every token counts once: 1000 + 100.
        assert_eq!(
            weighted_cost(&usage(1000, 800, 100), TokenWeight::default()),
            1100.0
        );
    }

    #[test]
    fn token_cost_falls_back_to_total_when_no_breakdown() {
        let u = Usage {
            total_tokens: Some(500),
            ..Default::default()
        };
        assert_eq!(weighted_cost(&u, TokenWeight::default()), 500.0);
    }

    #[test]
    fn a_failed_attempt_refunds_its_token_reservation() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db.clone(), test_clock());
        let u = up("a", vec![tokens(1000, "1d", None)]);
        let now = Utc::now();

        let g = l.acquire(&u, now).unwrap().unwrap();
        // Upstream blew up: no usage to bill.
        l.finalize(&u, &g, None, Some(502), Some("upstream_error"), now)
            .unwrap();

        let conn = db.conn().unwrap();
        let (used, in_flight): (f64, i64) = conn
            .query_row(
                "SELECT used_weighted, in_flight FROM quota_counters
                  WHERE upstream_id='a' AND bucket_key LIKE 'tokens:%'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(used, 0.0, "a failed attempt must not burn token quota");
        assert_eq!(in_flight, 0, "the reservation must be released");
    }

    fn window(start: &str, end: &str) -> TimeRange {
        use crate::config::ClockSpec;
        TimeRange {
            start: ClockSpec::parse(start).unwrap(),
            end: ClockSpec::parse(end).unwrap(),
        }
    }

    /// A UTC instant chosen so that the Shanghai (+08:00) local hour is `local_h`.
    fn utc_for_local_hour(local_h: u32) -> DateTime<Utc> {
        let utc_h = (local_h + 24 - 8) % 24;
        Utc.with_ymd_and_hms(2026, 9, 2, utc_h, 30, 0).unwrap()
    }

    #[test]
    fn time_window_blocks_inside_the_forbidden_hours() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let u = up(
            "a",
            vec![Limit::TimeWindow {
                forbidden: vec![window("8:00", "10:00")],
                days: vec![],
            }],
        );

        // 08:30 local: blocked.
        match l.acquire(&u, utc_for_local_hour(8)).unwrap().unwrap_err() {
            Denied::OutsideAllowedHours {
                limit_idx, window, ..
            } => {
                assert_eq!(limit_idx, 0);
                assert_eq!(window, "08:00-10:00");
            }
            other => panic!("expected a time-window denial, got {other:?}"),
        }
        // 07:30 and 10:30 local: allowed.
        assert!(l.acquire(&u, utc_for_local_hour(7)).unwrap().is_ok());
        assert!(l.acquire(&u, utc_for_local_hour(10)).unwrap().is_ok());
    }

    #[test]
    fn time_window_reports_a_local_end_time() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let hit = l
            .forbidden_now(&[window("8:00", "10:00")], &[], utc_for_local_hour(9))
            .expect("09:30 local is inside 08:00-10:00");
        // The operator reads their own clock, not UTC.
        assert!(hit.1.contains("10:00:00 +08:00"), "got: {}", hit.1);
    }

    #[test]
    fn several_forbidden_windows_are_all_honoured() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let u = up(
            "a",
            vec![Limit::TimeWindow {
                forbidden: vec![window("8:00", "10:00"), window("22:00", "2:00")],
                days: vec![],
            }],
        );
        assert!(l.acquire(&u, utc_for_local_hour(9)).unwrap().is_err());
        assert!(l.acquire(&u, utc_for_local_hour(23)).unwrap().is_err());
        assert!(l.acquire(&u, utc_for_local_hour(1)).unwrap().is_err());
        assert!(l.acquire(&u, utc_for_local_hour(12)).unwrap().is_ok());
    }

    #[test]
    fn a_day_restricted_window_only_applies_on_those_days() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        // 2026-09-02 is a Wednesday (ISO 3) in UTC; 12:30 local is the same day.
        let wednesday = utc_for_local_hour(12);
        let thursday = wednesday + chrono::Duration::days(1);

        let forbidden = [window("00:00", "24:00")];
        assert!(l.forbidden_now(&forbidden, &[3], wednesday).is_some());
        assert!(l.forbidden_now(&forbidden, &[3], thursday).is_none());
        // No day list means every day.
        assert!(l.forbidden_now(&forbidden, &[], thursday).is_some());
    }

    #[test]
    fn a_cross_midnight_window_uses_the_day_on_which_it_starts() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        // 2026-09-02 is Wednesday locally. The early-morning half belongs to
        // Tuesday's window; the late-night half belongs to Wednesday's.
        let wednesday_02 = Utc.with_ymd_and_hms(2026, 9, 1, 18, 30, 0).unwrap();
        let wednesday_22 = Utc.with_ymd_and_hms(2026, 9, 2, 14, 30, 0).unwrap();
        let forbidden = [window("08:00", "05:00")];

        assert!(l.forbidden_now(&forbidden, &[2], wednesday_02).is_some());
        assert!(l.forbidden_now(&forbidden, &[3], wednesday_02).is_none());
        assert!(l.forbidden_now(&forbidden, &[3], wednesday_22).is_some());
        assert!(l.forbidden_now(&forbidden, &[2], wednesday_22).is_none());
    }

    #[test]
    fn a_time_window_denial_refunds_earlier_limits() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db.clone(), test_clock());
        // The frequency limit is claimed first, then the time window refuses.
        let u = up(
            "a",
            vec![
                freq(10, "1min"),
                Limit::TimeWindow {
                    forbidden: vec![window("8:00", "10:00")],
                    days: vec![],
                },
            ],
        );
        assert!(l.acquire(&u, utc_for_local_hour(9)).unwrap().is_err());

        let conn = db.conn().unwrap();
        let used: i64 = conn
            .query_row(
                "SELECT coalesce(used_count, 0) FROM quota_counters
                  WHERE upstream_id='a' AND bucket_key LIKE 'frequency:%'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        assert_eq!(used, 0, "a blocked window must not consume frequency quota");
    }

    /// Reproduces the reported bug: editing an upstream's limits shifts the
    /// positional `limit_idx`, so a limit can inherit the counter row of a
    /// different limit that used to sit at that index.
    #[test]
    fn editing_limits_must_not_let_a_limit_inherit_another_ones_counter() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let now = Utc::now();

        // Start with one frequency limit and burn it down.
        let before = up("a", vec![freq(1, "5min")]);
        assert!(l.acquire(&before, now).unwrap().is_ok());
        assert!(
            l.acquire(&before, now).unwrap().is_err(),
            "1/1 is exhausted"
        );

        // The operator now prepends a token limit. The token limit lands at
        // idx 0 -- where the *frequency* counter already sits at 1 use.
        let after = up("a", vec![tokens(1000, "1d", None), freq(1, "5min")]);
        let outcome = l.acquire(&after, now).unwrap();

        // The token limit has spent nothing, but the frequency limit is still
        // exhausted, so the upstream must stay refused.
        assert!(
            outcome.is_err(),
            "an exhausted frequency limit must keep refusing after an unrelated edit"
        );
    }

    #[test]
    fn reordering_limits_preserves_each_ones_usage() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let now = Utc::now();

        // Burn the frequency limit while it sits second.
        let before = up("a", vec![tokens(100_000, "1d", None), freq(1, "5min")]);
        assert!(l.acquire(&before, now).unwrap().is_ok());
        assert!(l.acquire(&before, now).unwrap().is_err());

        // Swap the order. The frequency limit is the same limit, so it stays
        // exhausted rather than being handed the token limit's fresh counter.
        let after = up("a", vec![freq(1, "5min"), tokens(100_000, "1d", None)]);
        assert!(
            l.acquire(&after, now).unwrap().is_err(),
            "reordering must not reset an exhausted limit"
        );
    }

    #[test]
    fn deleting_a_limit_does_not_reset_the_survivors() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let now = Utc::now();

        let before = up("a", vec![tokens(100_000, "1d", None), freq(1, "5min")]);
        assert!(l.acquire(&before, now).unwrap().is_ok());
        assert!(l.acquire(&before, now).unwrap().is_err());

        // Drop the token limit; the frequency limit shifts from idx 1 to idx 0.
        let after = up("a", vec![freq(1, "5min")]);
        assert!(
            l.acquire(&after, now).unwrap().is_err(),
            "deleting an unrelated limit must not refill the remaining one"
        );
    }

    #[test]
    fn raising_a_quota_starts_a_fresh_budget() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let now = Utc::now();

        let before = up("a", vec![freq(1, "5min")]);
        assert!(l.acquire(&before, now).unwrap().is_ok());
        assert!(l.acquire(&before, now).unwrap().is_err());

        // Changing the quota is a deliberate act: the new limit is a different
        // limit and gets its own counter, which is what an operator raising a
        // cap expects to happen.
        let after = up("a", vec![freq(10, "5min")]);
        assert!(l.acquire(&after, now).unwrap().is_ok());
    }

    #[test]
    fn changing_only_the_token_weight_keeps_the_spend_already_booked() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let now = Utc::now();

        // Spend the whole budget.
        let before = up("a", vec![tokens(1000, "1d", None)]);
        let g = l.acquire(&before, now).unwrap().unwrap();
        l.finalize(&before, &g, Some(&usage(900, 0, 200)), Some(200), None, now)
            .unwrap();
        assert!(l.acquire(&before, now).unwrap().is_err(), "budget is spent");

        // Re-pricing future tokens must not refund what was already consumed.
        let after = up(
            "a",
            vec![tokens(
                1000,
                "1d",
                Some(TokenWeight {
                    output: 10.0,
                    cache_read: 0.1,
                    cache_write: 1.0,
                }),
            )],
        );
        assert!(
            l.acquire(&after, now).unwrap().is_err(),
            "changing weight must not wipe spend already booked this period"
        );
    }

    /// The status page reads these counters with its own query. It once
    /// filtered on a column the limiter no longer writes, so a fully-spent
    /// budget rendered as `0 used` — the limiter was right and the page
    /// disagreed with it. Assert the two see the same number.
    #[test]
    fn spent_budget_is_visible_through_the_same_key_the_status_page_uses() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db.clone(), test_clock());
        let now = Utc::now();

        let u = up("a", vec![tokens(1000, "1d", None)]);
        let g = l.acquire(&u, now).unwrap().unwrap();
        l.finalize(&u, &g, Some(&usage(2450, 0, 1284)), Some(200), None, now)
            .unwrap();

        // Rebuild the key exactly as the status handler does.
        let Limit::Tokens { period, .. } = &u.limits[0] else {
            panic!("expected a tokens limit");
        };
        let key = scoped_bucket_key(
            &u.limits[0].identity(),
            now,
            period.as_secs(),
            Some(l.midnight_anchor(now)),
        );

        let conn = db.conn().unwrap();
        let used: f64 = conn
            .query_row(
                "SELECT used_weighted FROM quota_counters
                  WHERE upstream_id=?1 AND bucket_key=?2",
                params!["a", key],
                |r| r.get(0),
            )
            .expect("the status query must find the row the limiter wrote");
        assert_eq!(used, 3734.0, "status page must see the real spend");
    }

    #[test]
    fn error_backoff_blocks_then_expires() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let u = up(
            "a",
            vec![Limit::ErrorBackoff {
                window: 1,
                threshold: 1,
                backoff: Backoff::Fixed {
                    value: DurationSpec::parse("5min").unwrap(),
                },
            }],
        );
        let now = Utc::now();

        let g = l.acquire(&u, now).unwrap().unwrap();
        l.finalize(&u, &g, None, Some(429), None, now).unwrap();

        // Parked for five minutes.
        match l.acquire(&u, now).unwrap().unwrap_err() {
            Denied::BackedOff { limit_idx, .. } => assert_eq!(limit_idx, 0),
            other => panic!("expected a backoff denial, got {other:?}"),
        }
        // Still parked just before the deadline, free again after it.
        assert!(l
            .acquire(&u, now + chrono::Duration::minutes(4))
            .unwrap()
            .is_err());
        assert!(l
            .acquire(&u, now + chrono::Duration::minutes(6))
            .unwrap()
            .is_ok());
    }

    #[test]
    fn error_backoff_grows_exponentially_and_a_success_resets_it() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db, test_clock());
        let u = up(
            "a",
            vec![Limit::ErrorBackoff {
                window: 1,
                threshold: 1,
                backoff: Backoff::Exponential {
                    start: DurationSpec::parse("60s").unwrap(),
                    max: DurationSpec::parse("24h").unwrap(),
                },
            }],
        );
        let t0 = Utc::now();

        let g = l.acquire(&u, t0).unwrap().unwrap();
        l.finalize(&u, &g, None, Some(500), None, t0).unwrap();
        // First trip: 60s.
        assert!(l
            .acquire(&u, t0 + chrono::Duration::seconds(30))
            .unwrap()
            .is_err());

        let t1 = t0 + chrono::Duration::seconds(61);
        let g = l.acquire(&u, t1).unwrap().unwrap();
        l.finalize(&u, &g, None, Some(500), None, t1).unwrap();
        // Second trip doubles to 120s, so 90s in it is still blocked.
        assert!(l
            .acquire(&u, t1 + chrono::Duration::seconds(90))
            .unwrap()
            .is_err());

        let t2 = t1 + chrono::Duration::seconds(121);
        let g = l.acquire(&u, t2).unwrap().unwrap();
        l.finalize(&u, &g, Some(&usage(10, 0, 10)), Some(200), None, t2)
            .unwrap();
        // The success cleared the streak, so the next trip starts at 60s again.
        let t3 = t2 + chrono::Duration::seconds(1);
        let g = l.acquire(&u, t3).unwrap().unwrap();
        l.finalize(&u, &g, None, Some(500), None, t3).unwrap();
        assert!(l
            .acquire(&u, t3 + chrono::Duration::seconds(30))
            .unwrap()
            .is_err());
        assert!(l
            .acquire(&u, t3 + chrono::Duration::seconds(61))
            .unwrap()
            .is_ok());
    }

    #[test]
    fn error_backoff_needs_threshold_matches_within_the_window() {
        let db = Db::open_in_memory().unwrap();
        let l = Limiter::new(db.clone(), test_clock());
        let u = up(
            "a",
            vec![Limit::ErrorBackoff {
                window: 3,
                threshold: 2,
                backoff: Backoff::Fixed {
                    value: DurationSpec::parse("5min").unwrap(),
                },
            }],
        );
        let now = Utc::now();

        // A single 429 is under the threshold of 2.
        logs::record(
            &db,
            &LogEntry {
                request_id: "r1".into(),
                entry_model: "g".into(),
                upstream_id: Some("a".into()),
                upstream_model: Some("m".into()),
                status: Some(200),
                error_kind: None,
                usage: Usage::default(),
                latency_ms: None,
            },
        )
        .unwrap();
        let g = l.acquire(&u, now).unwrap().unwrap();
        l.finalize(&u, &g, None, Some(429), None, now).unwrap();
        assert!(
            l.acquire(&u, now).unwrap().is_ok(),
            "one 429 must not trip a threshold of 2"
        );

        // Log that 429, then a second one crosses the threshold.
        logs::record(
            &db,
            &LogEntry {
                request_id: "r2".into(),
                entry_model: "g".into(),
                upstream_id: Some("a".into()),
                upstream_model: Some("m".into()),
                status: Some(429),
                error_kind: None,
                usage: Usage::default(),
                latency_ms: None,
            },
        )
        .unwrap();
        let g = l.acquire(&u, now).unwrap().unwrap();
        l.finalize(&u, &g, None, Some(429), None, now).unwrap();
        assert!(
            l.acquire(&u, now).unwrap().is_err(),
            "two 429s in the window must trip"
        );
    }
}
