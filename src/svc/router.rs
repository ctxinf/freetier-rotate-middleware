//! Candidate selection: which upstreams to try, in what order.

use parking_lot::Mutex;
use std::collections::HashMap;

use crate::config::{Config, Upstream};

/// Round-robin cursors, keyed by `entry_model::priority`, so equal-priority
/// upstreams take turns instead of always hammering the first one.
#[derive(Default)]
pub struct Router {
    cursors: Mutex<HashMap<String, usize>>,
}

impl Router {
    pub fn new() -> Self {
        Self::default()
    }

    /// Upstreams for `entry_model`, highest priority first, with equal
    /// priorities rotated. Disabled routes and upstreams are dropped here so
    /// the limiter only ever sees plausible candidates.
    pub fn candidates<'a>(&self, cfg: &'a Config, entry_model: &str) -> Vec<&'a Upstream> {
        let Some(group) = cfg.group(entry_model) else {
            return Vec::new();
        };

        let mut eligible: Vec<(i64, &Upstream)> = group
            .routes
            .iter()
            .filter(|r| r.enabled)
            .filter_map(|r| cfg.upstream(&r.upstream).map(|u| (r.priority, u)))
            .filter(|(_, u)| u.enabled)
            .collect();

        // Descending priority; ties keep config order for a stable rotation.
        eligible.sort_by(|a, b| b.0.cmp(&a.0));

        let mut out: Vec<&Upstream> = Vec::with_capacity(eligible.len());
        let mut i = 0;
        while i < eligible.len() {
            let prio = eligible[i].0;
            let start = i;
            while i < eligible.len() && eligible[i].0 == prio {
                i += 1;
            }
            let tier: Vec<&Upstream> = eligible[start..i].iter().map(|(_, u)| *u).collect();

            if tier.len() <= 1 {
                out.extend(tier);
                continue;
            }

            let key = format!("{entry_model}::{prio}");
            let offset = {
                let mut cursors = self.cursors.lock();
                let c = cursors.entry(key).or_insert(0);
                let offset = *c % tier.len();
                *c = (offset + 1) % tier.len();
                offset
            };
            out.extend(tier[offset..].iter().chain(tier[..offset].iter()));
        }

        out
    }

    pub fn has_entry_model(cfg: &Config, entry_model: &str) -> bool {
        cfg.group(entry_model).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Group, Route, ServerConfig, Upstream};

    fn cfg_with(routes: Vec<(&str, i64)>, disabled: &[&str]) -> Config {
        Config {
            version: 2,
            server: ServerConfig::default(),
            upstreams: routes
                .iter()
                .map(|(model, _)| Upstream {
                    model: (*model).into(),
                    enabled: !disabled.contains(model),
                    limits: vec![],
                    extra: Default::default(),
                })
                .collect(),
            groups: vec![Group {
                entry_model: "g".into(),
                routes: routes
                    .iter()
                    .map(|(id, p)| Route {
                        upstream: (*id).into(),
                        priority: *p,
                        enabled: true,
                    })
                    .collect(),
                extra: Default::default(),
            }],
        }
    }

    fn ids(ups: &[&Upstream]) -> Vec<String> {
        ups.iter().map(|u| u.model.clone()).collect()
    }

    #[test]
    fn orders_by_priority_descending() {
        let cfg = cfg_with(vec![("low", 1), ("high", 100), ("mid", 50)], &[]);
        let r = Router::new();
        assert_eq!(ids(&r.candidates(&cfg, "g")), ["high", "mid", "low"]);
    }

    #[test]
    fn rotates_within_one_priority_tier() {
        let cfg = cfg_with(vec![("a", 10), ("b", 10), ("c", 10)], &[]);
        let r = Router::new();
        assert_eq!(ids(&r.candidates(&cfg, "g")), ["a", "b", "c"]);
        assert_eq!(ids(&r.candidates(&cfg, "g")), ["b", "c", "a"]);
        assert_eq!(ids(&r.candidates(&cfg, "g")), ["c", "a", "b"]);
        assert_eq!(ids(&r.candidates(&cfg, "g")), ["a", "b", "c"]);
    }

    #[test]
    fn higher_tier_stays_ahead_of_a_rotating_tier() {
        let cfg = cfg_with(vec![("top", 99), ("a", 10), ("b", 10)], &[]);
        let r = Router::new();
        assert_eq!(ids(&r.candidates(&cfg, "g"))[0], "top");
        assert_eq!(ids(&r.candidates(&cfg, "g"))[0], "top");
    }

    #[test]
    fn drops_disabled_upstreams() {
        let cfg = cfg_with(vec![("a", 10), ("b", 5)], &["a"]);
        let r = Router::new();
        assert_eq!(ids(&r.candidates(&cfg, "g")), ["b"]);
    }

    #[test]
    fn unknown_entry_model_yields_nothing() {
        let cfg = cfg_with(vec![("a", 1)], &[]);
        let r = Router::new();
        assert!(r.candidates(&cfg, "nope").is_empty());
        assert!(!Router::has_entry_model(&cfg, "nope"));
        assert!(Router::has_entry_model(&cfg, "g"));
    }
}
