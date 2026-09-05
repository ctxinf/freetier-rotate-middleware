//! Parsing for the human-friendly scalar forms used across the config file:
//! durations ("1min", "24h"), token counts ("5M", "500K") and cycle anchors
//! ("08:00+08:00"). All of them deserialize from either a string or a number so
//! that a bare `count = 30` in the config is accepted alongside `count = "5M"`.

use std::fmt;
use std::time::Duration;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A duration written as `<number><unit>`, e.g. `30s`, `1min`, `24h`, `7d`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct DurationSpec(pub Duration);

impl DurationSpec {
    pub fn as_secs(self) -> u64 {
        self.0.as_secs()
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        let s = raw.trim().to_ascii_lowercase();
        if s.is_empty() {
            return Err("duration must not be empty".into());
        }

        let split = s
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .ok_or_else(|| format!("duration `{raw}` is missing a unit (e.g. `30s`, `1min`)"))?;
        let (num, unit) = s.split_at(split);
        let value: f64 = num
            .parse()
            .map_err(|_| format!("duration `{raw}` has an invalid number"))?;
        if value <= 0.0 {
            return Err(format!("duration `{raw}` must be positive"));
        }

        // `m` is deliberately rejected: it reads as both minute and month.
        let secs = match unit {
            "s" | "sec" | "secs" | "second" | "seconds" => value,
            "min" | "mins" | "minute" | "minutes" => value * 60.0,
            "h" | "hr" | "hrs" | "hour" | "hours" => value * 3600.0,
            "d" | "day" | "days" => value * 86_400.0,
            "w" | "week" | "weeks" => value * 604_800.0,
            "m" => {
                return Err(format!(
                    "duration `{raw}`: unit `m` is ambiguous, use `min` for minutes"
                ))
            }
            other => return Err(format!("duration `{raw}` has unknown unit `{other}`")),
        };

        Ok(DurationSpec(Duration::from_secs_f64(secs)))
    }
}

impl fmt::Display for DurationSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let secs = self.0.as_secs();
        if secs % 86_400 == 0 {
            write!(f, "{}d", secs / 86_400)
        } else if secs % 3_600 == 0 {
            write!(f, "{}h", secs / 3_600)
        } else if secs % 60 == 0 {
            write!(f, "{}min", secs / 60)
        } else {
            write!(f, "{secs}s")
        }
    }
}

impl Serialize for DurationSpec {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for DurationSpec {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = DurationSpec;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a duration such as `30s`, `1min`, `24h`, `7d`")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                DurationSpec::parse(v).map_err(E::custom)
            }
            // A bare `60` in the config is an integer; treat it as seconds.
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(DurationSpec(Duration::from_secs(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                if v <= 0 {
                    return Err(E::custom("duration must be positive"));
                }
                Ok(DurationSpec(Duration::from_secs(v as u64)))
            }
        }
        d.deserialize_any(V)
    }
}

/// A token/request count written as a plain number or with a `K`/`M`/`B` suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CountSpec(pub u64);

impl CountSpec {
    pub fn get(self) -> u64 {
        self.0
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        let s = raw.trim().replace('_', "").to_ascii_uppercase();
        if s.is_empty() {
            return Err("count must not be empty".into());
        }

        let (num, mult) = match s.chars().last() {
            Some('K') => (&s[..s.len() - 1], 1_000f64),
            Some('M') => (&s[..s.len() - 1], 1_000_000f64),
            Some('B') | Some('G') => (&s[..s.len() - 1], 1_000_000_000f64),
            _ => (s.as_str(), 1f64),
        };

        let value: f64 = num
            .parse()
            .map_err(|_| format!("count `{raw}` is not a number"))?;
        if value <= 0.0 {
            return Err(format!("count `{raw}` must be positive"));
        }
        Ok(CountSpec((value * mult).round() as u64))
    }
}

impl fmt::Display for CountSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let v = self.0;
        if v >= 1_000_000 && v % 1_000_000 == 0 {
            write!(f, "{}M", v / 1_000_000)
        } else if v >= 1_000 && v % 1_000 == 0 {
            write!(f, "{}K", v / 1_000)
        } else {
            write!(f, "{v}")
        }
    }
}

impl Serialize for CountSpec {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // Round numbers keep their "5M" / "500K" form so a config rewrite does
        // not expand what the user wrote into a wall of digits.
        let text = self.to_string();
        if text.ends_with(['K', 'M']) {
            s.serialize_str(&text)
        } else {
            s.serialize_u64(self.0)
        }
    }
}

impl<'de> Deserialize<'de> for CountSpec {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = CountSpec;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a count such as `30`, `500K`, `5M`")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                CountSpec::parse(v).map_err(E::custom)
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(CountSpec(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                if v <= 0 {
                    return Err(E::custom("count must be positive"));
                }
                Ok(CountSpec(v as u64))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                if v <= 0.0 {
                    return Err(E::custom("count must be positive"));
                }
                Ok(CountSpec(v.round() as u64))
            }
        }
        d.deserialize_any(V)
    }
}

/// A wall-clock time of day, written `8:00`, `08:00` or `08:00:30`.
///
/// Unlike `AnchorSpec` this carries no UTC offset: it is read against
/// `server.timezone`, so `08:00` is 08:00 wherever the gateway is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ClockSpec {
    /// Seconds since local midnight, in `0..86_400`.
    pub secs: u32,
}

impl ClockSpec {
    pub fn secs(self) -> u32 {
        self.secs
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        let s = raw.trim();
        if s.is_empty() {
            return Err("time must not be empty".into());
        }
        let mut parts = s.split(':');
        let hh: u32 = parts
            .next()
            .unwrap_or_default()
            .trim()
            .parse()
            .map_err(|_| format!("time `{raw}` has invalid hours"))?;
        let mm: u32 = match parts.next() {
            Some(v) => v
                .trim()
                .parse()
                .map_err(|_| format!("time `{raw}` has invalid minutes"))?,
            None => 0,
        };
        let ss: u32 = match parts.next() {
            Some(v) => v
                .trim()
                .parse()
                .map_err(|_| format!("time `{raw}` has invalid seconds"))?,
            None => 0,
        };
        if parts.next().is_some() {
            return Err(format!("time `{raw}` has too many `:` parts"));
        }
        // 24:00 is allowed as "end of day" so a window can cover the full day.
        if hh > 24 || mm > 59 || ss > 59 || (hh == 24 && (mm > 0 || ss > 0)) {
            return Err(format!("time `{raw}` is out of range (00:00..24:00)"));
        }
        Ok(ClockSpec {
            secs: hh * 3600 + mm * 60 + ss,
        })
    }
}

impl fmt::Display for ClockSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (h, m, s) = (self.secs / 3600, (self.secs % 3600) / 60, self.secs % 60);
        if s == 0 {
            write!(f, "{h:02}:{m:02}")
        } else {
            write!(f, "{h:02}:{m:02}:{s:02}")
        }
    }
}

impl Serialize for ClockSpec {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for ClockSpec {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = ClockSpec;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a local time of day such as `8:00` or `22:30`")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                ClockSpec::parse(v).map_err(E::custom)
            }
            // A bare `8` would be ambiguous (8 o'clock? 8 seconds?); refuse it.
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Err(E::custom(format!(
                    "time was written as the number {v}; quote it, e.g. \"08:00\""
                )))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Err(E::custom(format!(
                    "time was written as the number {v}; quote it, e.g. \"08:00\""
                )))
            }
        }
        d.deserialize_any(V)
    }
}

/// Where a limit's period starts, e.g. `08:00+08:00` = 08:00 Beijing time.
/// Without an anchor a period is aligned to the UTC epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnchorSpec {
    /// Offset from midnight, in seconds.
    pub time_of_day_secs: i64,
    /// UTC offset of the wall clock the anchor is expressed in, in seconds.
    pub utc_offset_secs: i32,
}

impl AnchorSpec {
    /// Total shift to apply to a UTC timestamp before bucketing.
    pub fn shift_secs(self) -> i64 {
        self.time_of_day_secs - self.utc_offset_secs as i64
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        let s = raw.trim();
        // Split the timezone suffix off: `08:00+08:00`, `08:00Z`, `08:00-05:00`.
        let (time_part, tz_part) = if let Some(rest) = s.strip_suffix('Z') {
            (rest, "+00:00")
        } else {
            match s.rfind(['+', '-']) {
                // A leading sign is part of the time, not a timezone.
                Some(idx) if idx > 0 => (&s[..idx], &s[idx..]),
                _ => (s, "+00:00"),
            }
        };

        let mut hm = time_part.split(':');
        let hh: i64 = hm
            .next()
            .ok_or("anchor is missing hours")?
            .trim()
            .parse()
            .map_err(|_| format!("anchor `{raw}` has invalid hours"))?;
        let mm: i64 = match hm.next() {
            Some(v) => v
                .trim()
                .parse()
                .map_err(|_| format!("anchor `{raw}` has invalid minutes"))?,
            None => 0,
        };
        if !(0..24).contains(&hh) || !(0..60).contains(&mm) {
            return Err(format!("anchor `{raw}` is out of range"));
        }

        let sign = if tz_part.starts_with('-') {
            -1i32
        } else {
            1i32
        };
        let tz_body = &tz_part[1..];
        let mut tz = tz_body.split(':');
        let tzh: i32 = tz
            .next()
            .unwrap_or("0")
            .trim()
            .parse()
            .map_err(|_| format!("anchor `{raw}` has an invalid UTC offset"))?;
        let tzm: i32 = match tz.next() {
            Some(v) => v
                .trim()
                .parse()
                .map_err(|_| format!("anchor `{raw}` has an invalid UTC offset"))?,
            None => 0,
        };

        Ok(AnchorSpec {
            time_of_day_secs: hh * 3600 + mm * 60,
            utc_offset_secs: sign * (tzh * 3600 + tzm * 60),
        })
    }
}

impl fmt::Display for AnchorSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let hh = self.time_of_day_secs / 3600;
        let mm = (self.time_of_day_secs % 3600) / 60;
        let sign = if self.utc_offset_secs < 0 { '-' } else { '+' };
        let off = self.utc_offset_secs.abs();
        write!(
            f,
            "{hh:02}:{mm:02}{sign}{:02}:{:02}",
            off / 3600,
            (off % 3600) / 60
        )
    }
}

impl Serialize for AnchorSpec {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for AnchorSpec {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = AnchorSpec;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an anchor such as `08:00+08:00` or `00:00Z`")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                AnchorSpec::parse(v).map_err(E::custom)
            }
            // An anchor must be quoted; a bare number cannot express one.
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Err(E::custom(format!(
                    "anchor was written as the number {v}; quote it, e.g. anchor = \"08:00+08:00\""
                )))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Err(E::custom(format!(
                    "anchor was written as the number {v}; quote it, e.g. anchor = \"08:00+08:00\""
                )))
            }
        }
        d.deserialize_any(V)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_durations() {
        assert_eq!(DurationSpec::parse("30s").unwrap().as_secs(), 30);
        assert_eq!(DurationSpec::parse("1min").unwrap().as_secs(), 60);
        assert_eq!(DurationSpec::parse("24h").unwrap().as_secs(), 86_400);
        assert_eq!(DurationSpec::parse("7d").unwrap().as_secs(), 604_800);
        assert!(
            DurationSpec::parse("5m").is_err(),
            "`m` must be rejected as ambiguous"
        );
        assert!(DurationSpec::parse("abc").is_err());
        assert!(DurationSpec::parse("0s").is_err());
    }

    #[test]
    fn duration_round_trips_through_display() {
        for raw in ["30s", "5min", "12h", "7d"] {
            let d = DurationSpec::parse(raw).unwrap();
            assert_eq!(d.to_string(), raw);
        }
    }

    #[test]
    fn parses_counts() {
        assert_eq!(CountSpec::parse("30").unwrap().get(), 30);
        assert_eq!(CountSpec::parse("5M").unwrap().get(), 5_000_000);
        assert_eq!(CountSpec::parse("500K").unwrap().get(), 500_000);
        assert_eq!(CountSpec::parse("1_000").unwrap().get(), 1_000);
        assert_eq!(CountSpec::parse("2.5M").unwrap().get(), 2_500_000);
        assert!(CountSpec::parse("-1").is_err());
    }

    #[test]
    fn parses_clock_times() {
        assert_eq!(ClockSpec::parse("8:00").unwrap().secs(), 8 * 3600);
        assert_eq!(ClockSpec::parse("08:00").unwrap().secs(), 8 * 3600);
        assert_eq!(ClockSpec::parse("22:30").unwrap().secs(), 22 * 3600 + 1800);
        assert_eq!(ClockSpec::parse("00:00:30").unwrap().secs(), 30);
        // End-of-day marker so a window can span the whole day.
        assert_eq!(ClockSpec::parse("24:00").unwrap().secs(), 86_400);
        assert!(ClockSpec::parse("24:01").is_err());
        assert!(ClockSpec::parse("25:00").is_err());
        assert!(ClockSpec::parse("8:70").is_err());
        assert!(ClockSpec::parse("").is_err());
    }

    #[test]
    fn clock_round_trips_through_display() {
        // `8:00` normalises to a zero-padded form; the rest survive unchanged.
        assert_eq!(ClockSpec::parse("8:00").unwrap().to_string(), "08:00");
        for raw in ["00:00", "09:30", "22:15", "24:00"] {
            assert_eq!(ClockSpec::parse(raw).unwrap().to_string(), raw);
        }
        assert_eq!(
            ClockSpec::parse("06:15:30").unwrap().to_string(),
            "06:15:30"
        );
    }

    #[test]
    fn parses_anchors() {
        let a = AnchorSpec::parse("08:00+08:00").unwrap();
        assert_eq!(a.time_of_day_secs, 8 * 3600);
        assert_eq!(a.utc_offset_secs, 8 * 3600);
        // 08:00 Beijing == 00:00 UTC, so the net shift is zero.
        assert_eq!(a.shift_secs(), 0);

        let z = AnchorSpec::parse("00:00Z").unwrap();
        assert_eq!(z.shift_secs(), 0);

        let west = AnchorSpec::parse("09:30-05:00").unwrap();
        assert_eq!(west.shift_secs(), 9 * 3600 + 1800 + 5 * 3600);
    }
}
