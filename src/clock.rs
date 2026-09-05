//! The gateway's local wall clock.
//!
//! Time-window limits are written the way an operator reads a clock ("no calls
//! between 08:00 and 10:00"), so they need a concrete timezone. It is resolved
//! once at startup — from `server.timezone` if set, otherwise from the host —
//! and everything else (limiter, status API, UI) uses that single answer, so a
//! rule and the log line explaining it can never disagree.

use chrono::{DateTime, Datelike, Offset, Timelike, Utc};
use chrono_tz::Tz;

#[derive(Debug, Clone)]
pub struct LocalClock {
    tz: Tz,
    /// How the timezone was determined, for the startup log and the UI.
    source: &'static str,
}

impl LocalClock {
    /// Resolve the timezone, preferring an explicit config value.
    ///
    /// An unknown name is a config mistake worth surfacing rather than silently
    /// falling back, so the caller gets the error.
    pub fn resolve(configured: &str) -> Result<Self, String> {
        let name = configured.trim();
        if !name.is_empty() {
            let tz: Tz = name.parse().map_err(|_| {
                format!("unknown timezone `{name}` (use an IANA name like `Asia/Shanghai`)")
            })?;
            return Ok(Self {
                tz,
                source: "config",
            });
        }
        Ok(Self::from_system())
    }

    /// The host's timezone, falling back to UTC when it cannot be read.
    pub fn from_system() -> Self {
        match iana_time_zone::get_timezone()
            .ok()
            .and_then(|n| n.parse::<Tz>().ok())
        {
            Some(tz) => Self {
                tz,
                source: "system",
            },
            None => Self {
                tz: Tz::UTC,
                source: "fallback",
            },
        }
    }

    pub fn tz(&self) -> Tz {
        self.tz
    }

    pub fn name(&self) -> String {
        self.tz.name().to_string()
    }

    pub fn source(&self) -> &'static str {
        self.source
    }

    /// Current UTC offset in seconds, at `now`. Not a constant: a zone with
    /// daylight saving shifts through the year.
    pub fn offset_secs(&self, now: DateTime<Utc>) -> i32 {
        now.with_timezone(&self.tz).offset().fix().local_minus_utc()
    }

    /// Seconds since local midnight — the coordinate time-window limits compare against.
    pub fn secs_of_day(&self, now: DateTime<Utc>) -> u32 {
        let local = now.with_timezone(&self.tz);
        local.hour() * 3600 + local.minute() * 60 + local.second()
    }

    /// ISO weekday, 1 = Monday … 7 = Sunday, matching what `days` accepts.
    pub fn weekday(&self, now: DateTime<Utc>) -> u8 {
        now.with_timezone(&self.tz).weekday().number_from_monday() as u8
    }

    /// `2026-09-02 16:21:45 +08:00`, for log lines and API payloads that a
    /// person reads directly.
    pub fn format_local(&self, now: DateTime<Utc>) -> String {
        now.with_timezone(&self.tz)
            .format("%Y-%m-%d %H:%M:%S %:z")
            .to_string()
    }

    /// A UTC instant `secs` from now, rendered as a local wall-clock time.
    pub fn local_after(&self, now: DateTime<Utc>, secs: i64) -> String {
        self.format_local(now + chrono::Duration::seconds(secs))
    }
}

impl Default for LocalClock {
    fn default() -> Self {
        Self::from_system()
    }
}

/// What the frontend needs to render every UTC timestamp in the gateway's zone.
pub fn describe(clock: &LocalClock, now: DateTime<Utc>) -> serde_json::Value {
    serde_json::json!({
        "timezone": clock.name(),
        "source": clock.source(),
        "offset_secs": clock.offset_secs(now),
        "now_utc": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "now_local": clock.format_local(now),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, min, 0).unwrap()
    }

    #[test]
    fn an_explicit_timezone_wins_over_the_host() {
        let c = LocalClock::resolve("Asia/Shanghai").unwrap();
        assert_eq!(c.name(), "Asia/Shanghai");
        assert_eq!(c.source(), "config");
        // 00:30 UTC is 08:30 in Shanghai.
        assert_eq!(c.secs_of_day(utc(2026, 9, 2, 0, 30)), 8 * 3600 + 1800);
        assert_eq!(c.offset_secs(utc(2026, 9, 2, 0, 30)), 8 * 3600);
    }

    #[test]
    fn an_unknown_timezone_is_an_error_not_a_silent_fallback() {
        let err = LocalClock::resolve("Mars/Olympus").unwrap_err();
        assert!(err.contains("unknown timezone"), "got: {err}");
    }

    #[test]
    fn an_empty_setting_falls_back_to_the_host() {
        let c = LocalClock::resolve("  ").unwrap();
        assert!(matches!(c.source(), "system" | "fallback"));
    }

    #[test]
    fn local_midnight_rolls_the_day_over() {
        let c = LocalClock::resolve("Asia/Shanghai").unwrap();
        // 16:00 UTC is midnight the next day in Shanghai.
        assert_eq!(c.secs_of_day(utc(2026, 9, 2, 16, 0)), 0);
        // 2026-09-02 is a Wednesday; 16:00 UTC is already Thursday locally.
        assert_eq!(c.weekday(utc(2026, 9, 2, 16, 0)), 4);
        assert_eq!(c.weekday(utc(2026, 9, 2, 8, 0)), 3);
    }

    #[test]
    fn daylight_saving_changes_the_offset_through_the_year() {
        let c = LocalClock::resolve("Europe/Berlin").unwrap();
        assert_eq!(c.offset_secs(utc(2026, 1, 15, 12, 0)), 3600);
        assert_eq!(c.offset_secs(utc(2026, 7, 15, 12, 0)), 2 * 3600);
    }

    #[test]
    fn local_formatting_carries_the_offset() {
        let c = LocalClock::resolve("Asia/Shanghai").unwrap();
        assert_eq!(
            c.format_local(utc(2026, 9, 2, 8, 21)),
            "2026-09-02 16:21:00 +08:00"
        );
    }
}
