//! The v2 configuration model.
//!
//! Shape: `upstreams` own their rate limits (they own the real quota), and
//! `groups` are pure references from an entry model to upstream model names.
//! Every limit is a tagged union so new limit types can be added without
//! touching existing config files.

use serde::{Deserialize, Serialize};

use super::units::{ClockSpec, CountSpec, DurationSpec};

pub const CURRENT_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub upstreams: Vec<Upstream>,
    #[serde(default)]
    pub groups: Vec<Group>,
}

fn default_version() -> u32 {
    CURRENT_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub port: u16,
    /// One prefix for everything this process serves: the web UI, the admin
    /// API, `/v1/*` and `/mcp`. `base_path` is accepted as the old name.
    #[serde(alias = "base_path")]
    pub path_prefix: String,
    pub upstream_base_url: String,
    pub database_path: String,
    pub log_level: String,
    /// IANA name for the wall clock that time-window limits and the UI use.
    /// Empty means "whatever the host's timezone is at startup".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub timezone: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: 3001,
            path_prefix: "/".into(),
            upstream_base_url: String::new(),
            database_path: "./data/gateway.sqlite".into(),
            log_level: "info".into(),
            timezone: String::new(),
        }
    }
}

impl ServerConfig {
    /// Normalised prefix: either empty (mounted at the root) or `/foo` with no
    /// trailing slash, which is the form both axum's `nest` and the UI want.
    pub fn normalized_prefix(&self) -> String {
        normalize_prefix(&self.path_prefix)
    }
}

/// Accepts the shapes users actually write — `/`, `gw`, `/gw/`, `//gw//` —
/// and returns `""` or `/gw`.
pub fn normalize_prefix(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("/{trimmed}")
    }
}

/// An upstream model together with the quota it owns. The model name is also
/// its unique identity and is what routes refer to and send upstream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Upstream {
    pub model: String,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub enabled: bool,
    #[serde(default)]
    pub limits: Vec<Limit>,
    /// Unknown keys are preserved rather than rejected so that downgrading the
    /// binary never silently drops a newer field on the next config write.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_true() -> bool {
    true
}

fn is_true(v: &bool) -> bool {
    *v
}

/// An entry model exposed to clients, plus prioritised upstream references.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub entry_model: String,
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    /// References `Upstream::model`.
    pub upstream: String,
    #[serde(default)]
    pub priority: i64,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub enabled: bool,
}

/// One rate limit. All limits on an upstream must pass for it to be used:
/// any single limit being hit takes the upstream out of the running.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Limit {
    /// Cap on the number of requests per period.
    Frequency {
        count: CountSpec,
        period: DurationSpec,
    },
    /// Cap on token spend per period, optionally weighting output and cached
    /// input tokens relative to uncached input tokens.
    Tokens {
        count: CountSpec,
        period: DurationSpec,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        weight: Option<TokenWeight>,
    },
    /// Block the upstream during the listed wall-clock windows. Times are
    /// local (`server.timezone`), so a "no calls between 08:00 and 10:00" rule
    /// means what the operator reads on their own clock.
    TimeWindow {
        /// Windows in which the upstream must NOT be used.
        #[serde(default, rename = "forbidden", alias = "forbid")]
        forbidden: Vec<TimeRange>,
        /// Restrict the rule to these weekdays (1 = Monday … 7 = Sunday).
        /// Empty means every day.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        days: Vec<u8>,
    },
    /// Take the upstream out of rotation after repeated failures.
    ErrorBackoff {
        /// How many recent calls to look at.
        #[serde(default = "default_window")]
        window: u32,
        /// How many of those must match before backing off.
        #[serde(default = "default_threshold")]
        threshold: u32,
        #[serde(default)]
        backoff: Backoff,
    },
}

fn default_window() -> u32 {
    1
}

fn default_threshold() -> u32 {
    1
}

impl Limit {
    /// A stable identity for this limit, independent of where it sits in the
    /// `limits` array.
    ///
    /// Counters used to be keyed by array position, which meant inserting,
    /// deleting or reordering a limit silently handed one limit's counter row
    /// to a different limit — an edit could let an exhausted upstream serve
    /// again. Keying on the limit's own defining parameters instead means an
    /// untouched limit keeps its usage across edits, while a genuinely changed
    /// one starts a fresh count (which is what changing a quota should do).
    ///
    /// `error_backoff` is excluded: its state is transient and keyed
    /// separately, and rebuilding it costs nothing.
    pub fn identity(&self) -> String {
        match self {
            Limit::Frequency { count, period } => {
                format!("frequency:{}:{}:00:00", count.get(), period.as_secs())
            }
            // `weight` is deliberately left out: it prices spend that has
            // already been settled, so changing it must not wipe the budget
            // already consumed this period.
            Limit::Tokens { count, period, .. } => {
                format!("tokens:{}:{}:00:00", count.get(), period.as_secs())
            }
            Limit::TimeWindow { forbidden, days } => format!(
                "time_window:{}:{}",
                forbidden
                    .iter()
                    .map(|r| r.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
                days.iter()
                    .map(|d| d.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Limit::ErrorBackoff { .. } => "error_backoff".into(),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Limit::Frequency { .. } => "frequency",
            Limit::Tokens { .. } => "tokens",
            Limit::TimeWindow { .. } => "time_window",
            Limit::ErrorBackoff { .. } => "error_backoff",
        }
    }
}

/// A half-open local-time window `[start, end)`.
///
/// `end <= start` reads as crossing midnight, so `{start = "22:00", end =
/// "02:00"}` is the four hours around midnight rather than an empty window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub start: ClockSpec,
    pub end: ClockSpec,
}

impl TimeRange {
    /// Is `secs_of_day` (local seconds since midnight) inside this window?
    pub fn contains(&self, secs_of_day: u32) -> bool {
        let (s, e) = (self.start.secs(), self.end.secs());
        if s == e {
            // A zero-width window blocks nothing; `00:00`-`24:00` blocks all day.
            false
        } else if s < e {
            (s..e).contains(&secs_of_day)
        } else {
            // Wraps past midnight: everything at or after `start`, plus
            // everything before `end` the next morning.
            secs_of_day >= s || secs_of_day < e
        }
    }

    /// Seconds from `secs_of_day` until this window ends. Only meaningful when
    /// the window currently contains that time; used to tell the operator when
    /// the upstream comes back.
    pub fn seconds_until_end(&self, secs_of_day: u32) -> u32 {
        let e = self.end.secs();
        if e > secs_of_day {
            e - secs_of_day
        } else {
            // The end is tomorrow.
            86_400 - secs_of_day + e
        }
    }
}

impl std::fmt::Display for TimeRange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}-{}", self.start, self.end)
    }
}

/// Relative cost of each token class. Uncached input is always the 1.0
/// baseline; omitting the whole struct means every class counts equally.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct TokenWeight {
    #[serde(skip_serializing_if = "is_unit_weight")]
    pub output: f64,
    #[serde(skip_serializing_if = "is_unit_weight")]
    pub cache_read: f64,
    #[serde(skip_serializing_if = "is_unit_weight")]
    pub cache_write: f64,
}

/// A weight of 1.0 is the default, so it is left out of the written config.
fn is_unit_weight(v: &f64) -> bool {
    (*v - 1.0).abs() < f64::EPSILON
}

impl Default for TokenWeight {
    fn default() -> Self {
        Self {
            output: 1.0,
            cache_read: 1.0,
            cache_write: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Backoff {
    /// Doubles on each consecutive trip, capped at `max`.
    Exponential {
        start: DurationSpec,
        max: DurationSpec,
    },
    Fixed {
        value: DurationSpec,
    },
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff::Exponential {
            start: DurationSpec(std::time::Duration::from_secs(60)),
            max: DurationSpec(std::time::Duration::from_secs(24 * 3600)),
        }
    }
}

impl Backoff {
    /// How long to stay blocked after `trips` consecutive trips (1-based).
    pub fn duration_for(&self, trips: u32) -> std::time::Duration {
        match self {
            Backoff::Fixed { value } => value.0,
            Backoff::Exponential { start, max } => {
                let shift = trips.saturating_sub(1).min(32);
                let scaled = start.as_secs().saturating_mul(1u64 << shift);
                std::time::Duration::from_secs(scaled.min(max.as_secs()))
            }
        }
    }
}

impl Config {
    pub fn upstream(&self, model: &str) -> Option<&Upstream> {
        self.upstreams.iter().find(|u| u.model == model)
    }

    pub fn upstream_mut(&mut self, model: &str) -> Option<&mut Upstream> {
        self.upstreams.iter_mut().find(|u| u.model == model)
    }

    pub fn group_mut(&mut self, entry_model: &str) -> Option<&mut Group> {
        self.groups
            .iter_mut()
            .find(|g| g.entry_model == entry_model)
    }

    pub fn group(&self, entry_model: &str) -> Option<&Group> {
        self.groups.iter().find(|g| g.entry_model == entry_model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(start: &str, end: &str) -> TimeRange {
        TimeRange {
            start: ClockSpec::parse(start).unwrap(),
            end: ClockSpec::parse(end).unwrap(),
        }
    }

    fn at(h: u32, m: u32) -> u32 {
        h * 3600 + m * 60
    }

    #[test]
    fn a_window_is_half_open() {
        let r = range("8:00", "10:00");
        assert!(!r.contains(at(7, 59)));
        assert!(r.contains(at(8, 0)));
        assert!(r.contains(at(9, 59)));
        // The end itself is already outside, so back-to-back windows do not overlap.
        assert!(!r.contains(at(10, 0)));
    }

    #[test]
    fn a_window_may_cross_midnight() {
        let r = range("22:00", "2:00");
        assert!(r.contains(at(23, 30)));
        assert!(r.contains(at(0, 30)));
        assert!(r.contains(at(1, 59)));
        assert!(!r.contains(at(2, 0)));
        assert!(!r.contains(at(12, 0)));
    }

    #[test]
    fn a_full_day_window_blocks_everything() {
        let r = range("00:00", "24:00");
        assert!(r.contains(0));
        assert!(r.contains(at(12, 0)));
        assert!(r.contains(86_399));
    }

    #[test]
    fn a_zero_width_window_blocks_nothing() {
        let r = range("08:00", "08:00");
        assert!(!r.contains(at(8, 0)));
        assert!(!r.contains(at(0, 0)));
    }

    #[test]
    fn seconds_until_end_handles_the_midnight_wrap() {
        assert_eq!(range("8:00", "10:00").seconds_until_end(at(9, 0)), 3600);
        // 23:00 inside a 22:00-02:00 window: three hours left.
        assert_eq!(
            range("22:00", "2:00").seconds_until_end(at(23, 0)),
            3 * 3600
        );
        assert_eq!(range("22:00", "2:00").seconds_until_end(at(1, 0)), 3600);
    }

    #[test]
    fn exponential_backoff_doubles_and_caps() {
        let b = Backoff::Exponential {
            start: DurationSpec(std::time::Duration::from_secs(60)),
            max: DurationSpec(std::time::Duration::from_secs(24 * 3600)),
        };
        assert_eq!(b.duration_for(1).as_secs(), 60);
        assert_eq!(b.duration_for(2).as_secs(), 120);
        assert_eq!(b.duration_for(3).as_secs(), 240);
        // Caps rather than overflowing.
        assert_eq!(b.duration_for(99).as_secs(), 24 * 3600);
    }

    #[test]
    fn fixed_backoff_ignores_trip_count() {
        let b = Backoff::Fixed {
            value: DurationSpec(std::time::Duration::from_secs(300)),
        };
        assert_eq!(b.duration_for(1).as_secs(), 300);
        assert_eq!(b.duration_for(10).as_secs(), 300);
    }
}
