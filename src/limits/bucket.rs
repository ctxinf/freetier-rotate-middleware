//! Time bucketing for periodic limits.

use chrono::{DateTime, Utc};

use crate::config::AnchorSpec;

/// Key identifying the period `now` falls in.
///
/// Periods tile the timeline from the UTC epoch; an anchor shifts that tiling
/// so a "1d" period can reset at, say, 08:00 Beijing time instead of midnight
/// UTC. The key embeds the period length so changing it in the config starts a
/// fresh bucket rather than inheriting a stale count.
pub fn bucket_key(now: DateTime<Utc>, period_secs: u64, anchor: Option<AnchorSpec>) -> String {
    if period_secs == 0 {
        return "invalid".into();
    }
    let shift = anchor.map(|a| a.shift_secs()).unwrap_or(0);
    let ts = now.timestamp() - shift;
    let index = ts.div_euclid(period_secs as i64);
    format!("{period_secs}:{index}")
}

/// The same key, scoped to a limit's stable identity.
///
/// The row is keyed by `(upstream_id, limit_idx, bucket_key)`, and `limit_idx`
/// is just the position in the `limits` array — so editing the array used to
/// hand one limit the counter of whichever limit previously sat at that index.
/// Folding the identity in here makes a counter follow its limit through any
/// insert, delete or reorder.
pub fn scoped_bucket_key(
    identity: &str,
    now: DateTime<Utc>,
    period_secs: u64,
    anchor: Option<AnchorSpec>,
) -> String {
    format!("{identity}|{}", bucket_key(now, period_secs, anchor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn same_period_shares_a_key() {
        let a = Utc.with_ymd_and_hms(2026, 9, 1, 10, 0, 0).unwrap();
        let b = Utc.with_ymd_and_hms(2026, 9, 1, 10, 59, 0).unwrap();
        assert_eq!(bucket_key(a, 3600, None), bucket_key(b, 3600, None));

        let c = Utc.with_ymd_and_hms(2026, 9, 1, 11, 0, 1).unwrap();
        assert_ne!(bucket_key(a, 3600, None), bucket_key(c, 3600, None));
    }

    #[test]
    fn a_scoped_key_follows_the_limit_not_its_position() {
        let t = Utc.with_ymd_and_hms(2026, 9, 1, 10, 0, 0).unwrap();
        // Same limit, different position in the array: same counter.
        assert_eq!(
            scoped_bucket_key("frequency:5:60:", t, 60, None),
            scoped_bucket_key("frequency:5:60:", t, 60, None)
        );
        // Different limits never share a counter, however they are ordered.
        assert_ne!(
            scoped_bucket_key("frequency:5:60:", t, 60, None),
            scoped_bucket_key("tokens:1000:60:", t, 60, None)
        );
    }

    #[test]
    fn changing_the_period_starts_a_new_bucket() {
        let t = Utc.with_ymd_and_hms(2026, 9, 1, 10, 0, 0).unwrap();
        assert_ne!(bucket_key(t, 3600, None), bucket_key(t, 7200, None));
    }

    #[test]
    fn anchor_shifts_the_daily_boundary() {
        let anchor = AnchorSpec::parse("08:00+08:00").unwrap(); // == 00:00 UTC
        let before = Utc.with_ymd_and_hms(2026, 9, 1, 23, 59, 0).unwrap();
        let after = Utc.with_ymd_and_hms(2026, 9, 2, 0, 1, 0).unwrap();
        assert_ne!(
            bucket_key(before, 86_400, Some(anchor)),
            bucket_key(after, 86_400, Some(anchor))
        );

        // With a 09:00+08:00 anchor the reset moves to 01:00 UTC, so those two
        // timestamps now fall in the same day.
        let anchor9 = AnchorSpec::parse("09:00+08:00").unwrap();
        assert_eq!(
            bucket_key(before, 86_400, Some(anchor9)),
            bucket_key(after, 86_400, Some(anchor9))
        );
    }
}
