pub mod model;
pub mod store;
pub mod units;

pub use model::{
    normalize_prefix, Backoff, Config, Group, Limit, Route, ServerConfig, TimeRange, TokenWeight,
    Upstream,
};
pub use store::ConfigStore;
pub use units::{AnchorSpec, ClockSpec, CountSpec, DurationSpec};

use anyhow::{bail, Result};
use std::collections::HashSet;

/// Structural checks that serde cannot express: unique models, resolvable route
/// references, and limits that are actually enforceable.
pub fn validate(cfg: &Config) -> Result<()> {
    if cfg.version != model::CURRENT_VERSION {
        bail!(
            "config version {} is not supported (expected {})",
            cfg.version,
            model::CURRENT_VERSION
        );
    }
    if cfg.server.upstream_base_url.trim().is_empty() {
        bail!("server.upstream_base_url must be set");
    }
    if cfg.server.path_prefix.contains(char::is_whitespace) {
        bail!(
            "server.path_prefix `{}` must not contain whitespace",
            cfg.server.path_prefix
        );
    }
    // Catch a bad timezone here rather than at the first request that needs it.
    if let Err(e) = crate::clock::LocalClock::resolve(&cfg.server.timezone) {
        bail!("server.timezone: {e}");
    }

    let mut seen_models = HashSet::new();
    for up in &cfg.upstreams {
        if up.model.trim().is_empty() {
            bail!("every upstream needs a non-empty model");
        }
        if !seen_models.insert(up.model.as_str()) {
            bail!("duplicate upstream model `{}`", up.model);
        }
        for (idx, limit) in up.limits.iter().enumerate() {
            validate_limit(&up.model, idx, limit)?;
        }
    }

    let mut seen_entries = HashSet::new();
    for group in &cfg.groups {
        if group.entry_model.trim().is_empty() {
            bail!("every group needs a non-empty entry_model");
        }
        if !seen_entries.insert(group.entry_model.as_str()) {
            bail!("duplicate group entry_model `{}`", group.entry_model);
        }
        let mut seen_refs = HashSet::new();
        for route in &group.routes {
            if !seen_models.contains(route.upstream.as_str()) {
                bail!(
                    "group `{}` references unknown upstream `{}`",
                    group.entry_model,
                    route.upstream
                );
            }
            if !seen_refs.insert(route.upstream.as_str()) {
                bail!(
                    "group `{}` lists upstream `{}` more than once",
                    group.entry_model,
                    route.upstream
                );
            }
        }
    }

    Ok(())
}

fn validate_limit(upstream_id: &str, idx: usize, limit: &Limit) -> Result<()> {
    let at = format!("upstream `{upstream_id}` limits[{idx}]");
    match limit {
        Limit::Frequency { count, period } | Limit::Tokens { count, period, .. } => {
            if count.get() == 0 {
                bail!("{at}: count must be > 0");
            }
            if period.as_secs() == 0 {
                bail!("{at}: period must be > 0");
            }
        }
        Limit::TimeWindow { forbidden, days } => {
            if forbidden.is_empty() {
                bail!("{at}: forbidden must list at least one time window");
            }
            for (i, range) in forbidden.iter().enumerate() {
                if range.start == range.end {
                    bail!(
                        "{at}: forbidden[{i}] is empty ({} == {}); to block the whole day use 00:00-24:00",
                        range.start,
                        range.end
                    );
                }
            }
            for d in days {
                if !(1..=7).contains(d) {
                    bail!("{at}: days must be 1-7 (1 = Monday, 7 = Sunday), got {d}");
                }
            }
        }
        Limit::ErrorBackoff {
            window, threshold, ..
        } => {
            if *window == 0 {
                bail!("{at}: window must be >= 1");
            }
            if *threshold == 0 {
                bail!("{at}: threshold must be >= 1");
            }
            if threshold > window {
                bail!("{at}: threshold ({threshold}) cannot exceed window ({window})");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_cfg() -> Config {
        Config {
            version: model::CURRENT_VERSION,
            server: ServerConfig {
                upstream_base_url: "http://localhost:3000".into(),
                ..Default::default()
            },
            upstreams: vec![Upstream {
                model: "model-a".into(),
                enabled: true,
                limits: vec![],
                extra: Default::default(),
            }],
            groups: vec![Group {
                entry_model: "g".into(),
                routes: vec![Route {
                    upstream: "model-a".into(),
                    priority: 100,
                    enabled: true,
                }],
                extra: Default::default(),
            }],
        }
    }

    #[test]
    fn accepts_a_well_formed_config() {
        assert!(validate(&base_cfg()).is_ok());
    }

    #[test]
    fn rejects_dangling_route_reference() {
        let mut cfg = base_cfg();
        cfg.groups[0].routes[0].upstream = "missing".into();
        let err = validate(&cfg).unwrap_err().to_string();
        assert!(err.contains("unknown upstream"), "got: {err}");
    }

    #[test]
    fn rejects_duplicate_upstream_models() {
        let mut cfg = base_cfg();
        let dup = cfg.upstreams[0].clone();
        cfg.upstreams.push(dup);
        assert!(validate(&cfg)
            .unwrap_err()
            .to_string()
            .contains("duplicate"));
    }

    #[test]
    fn rejects_threshold_greater_than_window() {
        let mut cfg = base_cfg();
        cfg.upstreams[0].limits.push(Limit::ErrorBackoff {
            window: 2,
            threshold: 5,
            backoff: Backoff::default(),
        });
        assert!(validate(&cfg)
            .unwrap_err()
            .to_string()
            .contains("cannot exceed"));
    }

    #[test]
    fn path_prefixes_normalise_to_one_canonical_form() {
        for (raw, want) in [
            ("/", ""),
            ("", ""),
            ("  ", ""),
            ("gw", "/gw"),
            ("/gw", "/gw"),
            ("/gw/", "/gw"),
            ("//gw//", "/gw"),
            ("/api/gw", "/api/gw"),
        ] {
            assert_eq!(model::normalize_prefix(raw), want, "prefix `{raw}`");
        }
    }

    #[test]
    fn the_old_base_path_spelling_still_loads() {
        let cfg: Config = toml::from_str(
            r#"version = 2
[server]
base_path = "/gw"
upstream_base_url = "http://x:3000"
"#,
        )
        .unwrap();
        assert_eq!(cfg.server.normalized_prefix(), "/gw");
    }

    #[test]
    fn rejects_an_empty_time_window() {
        let mut cfg = base_cfg();
        cfg.upstreams[0].limits.push(Limit::TimeWindow {
            forbidden: vec![],
            days: vec![],
        });
        assert!(validate(&cfg)
            .unwrap_err()
            .to_string()
            .contains("at least one time window"));
    }

    #[test]
    fn rejects_a_zero_width_time_window() {
        use crate::config::units::ClockSpec;
        let mut cfg = base_cfg();
        cfg.upstreams[0].limits.push(Limit::TimeWindow {
            forbidden: vec![TimeRange {
                start: ClockSpec::parse("08:00").unwrap(),
                end: ClockSpec::parse("08:00").unwrap(),
            }],
            days: vec![],
        });
        // Silently blocking nothing would be a confusing way to fail.
        assert!(validate(&cfg).unwrap_err().to_string().contains("is empty"));
    }

    #[test]
    fn rejects_an_out_of_range_weekday() {
        use crate::config::units::ClockSpec;
        let mut cfg = base_cfg();
        cfg.upstreams[0].limits.push(Limit::TimeWindow {
            forbidden: vec![TimeRange {
                start: ClockSpec::parse("08:00").unwrap(),
                end: ClockSpec::parse("10:00").unwrap(),
            }],
            days: vec![0],
        });
        assert!(validate(&cfg)
            .unwrap_err()
            .to_string()
            .contains("days must be 1-7"));
    }

    #[test]
    fn rejects_an_unknown_timezone() {
        let mut cfg = base_cfg();
        cfg.server.timezone = "Mars/Olympus".into();
        assert!(validate(&cfg)
            .unwrap_err()
            .to_string()
            .contains("unknown timezone"));
    }
}
