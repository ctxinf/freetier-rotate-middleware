//! Loading and saving the TOML config.
//!
//! Runtime edits must land back in the file without destroying the comments the
//! user wrote, so saving goes through `toml_edit`, which keeps the original
//! document tree — comments, spacing and key order included — and rewrites only
//! the values that actually changed.

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use toml_edit::{DocumentMut, Item};

use super::{model::Config, validate};

pub struct ConfigStore {
    path: PathBuf,
    current: ArcSwap<Config>,
    /// Serialises read-modify-write cycles against the file on disk.
    write_lock: parking_lot::Mutex<()>,
}

impl ConfigStore {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let cfg = read_and_validate(&path)?;
        Ok(Self {
            path,
            current: ArcSwap::from_pointee(cfg),
            write_lock: parking_lot::Mutex::new(()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Cheap, lock-free snapshot for the request path.
    pub fn snapshot(&self) -> Arc<Config> {
        self.current.load_full()
    }

    /// Apply `edit` to a copy of the config, validate it, persist it, and only
    /// then publish it. A rejected edit leaves both the file and the in-memory
    /// config untouched.
    pub fn update<F>(&self, edit: F) -> Result<Arc<Config>>
    where
        F: FnOnce(&mut Config) -> Result<()>,
    {
        let _guard = self.write_lock.lock();

        let mut next = (*self.current.load_full()).clone();
        edit(&mut next)?;
        validate(&next).context("rejected config edit")?;

        let original = std::fs::read_to_string(&self.path)
            .with_context(|| format!("failed to read {}", self.path.display()))?;
        let rendered = render_preserving_comments(&original, &next)?;

        // Re-read what we are about to publish so a malformed write can never
        // leave the file and memory out of sync.
        let reparsed: Config = toml::from_str(&rendered)
            .context("internal error: config write produced invalid TOML")?;
        validate(&reparsed).context("internal error: config write produced an invalid config")?;

        write_atomically(&self.path, &rendered)?;

        let arc = Arc::new(reparsed);
        self.current.store(arc.clone());
        Ok(arc)
    }

    /// Discard in-memory state and re-read the file from disk.
    pub fn reload(&self) -> Result<Arc<Config>> {
        let _guard = self.write_lock.lock();
        let cfg = Arc::new(read_and_validate(&self.path)?);
        self.current.store(cfg.clone());
        Ok(cfg)
    }
}

fn read_and_validate(path: &Path) -> Result<Config> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read config at {}", path.display()))?;
    let cfg = parse_config(&raw).with_context(|| format!("invalid TOML in {}", path.display()))?;
    validate(&cfg).with_context(|| format!("invalid config in {}", path.display()))?;
    Ok(cfg)
}

/// Accept the pre-model-identity shape during upgrades. Legacy `id` values are
/// translated only in memory; the next normal config edit writes the canonical
/// model-only form through the existing comment-preserving merger.
fn parse_config(raw: &str) -> Result<Config> {
    let mut value: toml::Value = toml::from_str(raw)?;
    let mut legacy = std::collections::HashMap::new();
    if let Some(upstreams) = value.get_mut("upstreams").and_then(|v| v.as_array_mut()) {
        for upstream in upstreams {
            if let Some(table) = upstream.as_table_mut() {
                if let (Some(id), Some(model)) = (
                    table.get("id").and_then(|v| v.as_str()).map(str::to_owned),
                    table
                        .get("model")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                ) {
                    legacy.insert(id, model);
                }
                table.remove("id");
            }
        }
    }
    if let Some(groups) = value.get_mut("groups").and_then(|v| v.as_array_mut()) {
        for group in groups {
            let Some(routes) = group.get_mut("routes").and_then(|v| v.as_array_mut()) else {
                continue;
            };
            for route in routes {
                let Some(name) = route.get("upstream").and_then(|v| v.as_str()) else {
                    continue;
                };
                if let Some(model) = legacy.get(name) {
                    route
                        .as_table_mut()
                        .unwrap()
                        .insert("upstream".into(), model.clone().into());
                }
            }
        }
    }
    Ok(value.try_into()?)
}

/// Write via a temp file + rename so a crash mid-write cannot truncate the
/// user's config.
fn write_atomically(path: &Path, contents: &str) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config.toml")
    ));
    std::fs::write(&tmp, contents).with_context(|| format!("failed to write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("failed to replace {}", path.display()))?;
    Ok(())
}

/// Merge `next` into the existing document, touching only what changed.
///
/// `toml_edit` owns the formatting: every comment, blank line and key order in
/// the original file is part of the document tree, so replacing one value
/// leaves the rest byte-identical.
fn render_preserving_comments(original: &str, next: &Config) -> Result<String> {
    let mut doc: DocumentMut = original.parse().context("config file is not valid TOML")?;

    // `to_document` emits everything inline (`server = { port = ... }`).
    // Re-parsing its output gives the same data as block tables, which is what
    // the original document uses and what we need to merge against.
    let serialised =
        toml_edit::ser::to_string_pretty(next).context("failed to serialise config")?;
    let target: DocumentMut = serialised
        .parse()
        .context("internal error: serialised config is not valid TOML")?;

    for (key, value) in target.iter() {
        match doc.get_mut(key) {
            Some(existing) => merge_item(existing, value),
            None => {
                doc.insert(key, value.clone());
            }
        }
    }

    // Drop any top-level key that no longer exists in the config.
    let keep: Vec<String> = target.iter().map(|(k, _)| k.to_string()).collect();
    let stale: Vec<String> = doc
        .iter()
        .map(|(k, _)| k.to_string())
        .filter(|k| !keep.contains(k))
        .collect();
    for key in stale {
        doc.remove(&key);
    }

    Ok(doc.to_string())
}

/// Recursively copy `src` into `dst`, preserving `dst`'s decor (comments and
/// whitespace) wherever the structure lines up.
///
/// The two sides may disagree on representation — the original file might use a
/// block `[server]` table where the serialised form used an inline one, or hold
/// `limits` as an inline array where the target has an array of tables. Those
/// pairs are matched on content, not on representation, so an unchanged value
/// keeps the original's formatting.
fn merge_item(dst: &mut Item, src: &Item) {
    // Tables, in whichever representation each side happens to use.
    if let (true, Some(src_table)) = (as_table_like(dst).is_some(), as_table_like(src)) {
        let src_keys: Vec<String> = src_table.iter().map(|(k, _)| k.to_string()).collect();
        let src_values: Vec<Item> = src_table.iter().map(|(_, v)| v.clone()).collect();

        let Some(dst_table) = as_table_like_mut(dst) else {
            return;
        };
        for (key, src_value) in src_keys.iter().zip(src_values.iter()) {
            match dst_table.get_mut(key) {
                Some(dst_value) => merge_item(dst_value, src_value),
                None => {
                    let mut fresh = src_value.clone();
                    if let Some(v) = fresh.as_value_mut() {
                        compact_new_array(v);
                    }
                    dst_table.insert(key, fresh);
                }
            }
        }
        let stale: Vec<String> = dst_table
            .iter()
            .map(|(k, _)| k.to_string())
            .filter(|k| !src_keys.contains(k))
            .collect();
        for key in stale {
            dst_table.remove(&key);
        }
        return;
    }

    // Arrays, likewise: `[[upstreams]]` blocks on one side may be an inline
    // array on the other. Entries are matched positionally so editing one
    // upstream leaves its neighbours' comments alone.
    if let (Some(dst_len), Some(src_items)) = (array_len(dst), array_items(src)) {
        if dst_len > src_items.len() {
            truncate_array(dst, src_items.len());
        }
        for (i, src_item) in src_items.iter().enumerate() {
            // Merge into a working copy, then write it back: block and inline
            // representations do not share a mutable view.
            match array_get_mut(dst, i) {
                Some(mut merged) => {
                    merge_item(&mut merged, src_item);
                    array_set(dst, i, merged);
                }
                // A brand-new element carries no user formatting to preserve.
                None => {
                    let mut fresh = src_item.clone();
                    if let Some(v) = fresh.as_value_mut() {
                        compact_new_array(v);
                    }
                    array_push(dst, fresh);
                }
            }
        }
        return;
    }

    // Scalars: overwrite, keeping the original's decor so a trailing
    // `# comment` on the line stays put.
    let decor = dst.as_value().map(|v| v.decor().clone());
    *dst = src.clone();
    if let Some(v) = dst.as_value_mut() {
        // This whole value is new content, so nothing here has user formatting
        // to protect: keep it on one line rather than letting the serialiser
        // give every element its own.
        compact_new_array(v);
        if let Some(decor) = decor {
            *v.decor_mut() = decor;
        }
    }
}

fn as_table_like(item: &Item) -> Option<&dyn toml_edit::TableLike> {
    match item {
        Item::Table(t) => Some(t),
        Item::Value(toml_edit::Value::InlineTable(t)) => Some(t),
        _ => None,
    }
}

fn as_table_like_mut(item: &mut Item) -> Option<&mut dyn toml_edit::TableLike> {
    match item {
        Item::Table(t) => Some(t),
        Item::Value(toml_edit::Value::InlineTable(t)) => Some(t),
        _ => None,
    }
}

/// Items of an array, whether written as `[[x]]` blocks or an inline array.
fn array_items(item: &Item) -> Option<Vec<Item>> {
    match item {
        Item::ArrayOfTables(a) => Some(a.iter().map(|t| Item::Table(t.clone())).collect()),
        Item::Value(toml_edit::Value::Array(a)) => {
            Some(a.iter().map(|v| Item::Value(v.clone())).collect())
        }
        _ => None,
    }
}

fn array_len(item: &Item) -> Option<usize> {
    match item {
        Item::ArrayOfTables(a) => Some(a.len()),
        Item::Value(toml_edit::Value::Array(a)) => Some(a.len()),
        _ => None,
    }
}

fn array_get_mut(item: &mut Item, i: usize) -> Option<Item> {
    match item {
        Item::ArrayOfTables(a) => a.get(i).map(|t| Item::Table(t.clone())),
        Item::Value(toml_edit::Value::Array(a)) => a.get(i).map(|v| Item::Value(v.clone())),
        _ => None,
    }
}

fn array_set(item: &mut Item, i: usize, value: Item) {
    match item {
        Item::ArrayOfTables(a) => {
            if let (Some(slot), Item::Table(t)) = (a.get_mut(i), to_block_table(&value)) {
                *slot = t;
            }
        }
        Item::Value(toml_edit::Value::Array(a)) => {
            if let Some(v) = to_inline_value(&value) {
                // Keep the original entry's decor so per-line comments survive.
                let decor = a.get(i).map(|old| old.decor().clone());
                a.replace(i, v);
                if let (Some(decor), Some(slot)) = (decor, a.get_mut(i)) {
                    *slot.decor_mut() = decor;
                }
            }
        }
        _ => {}
    }
}

fn array_push(item: &mut Item, value: Item) {
    match item {
        Item::ArrayOfTables(a) => {
            if let Item::Table(t) = to_block_table(&value) {
                a.push(t);
            }
        }
        Item::Value(toml_edit::Value::Array(a)) => {
            if let Some(v) = to_inline_value(&value) {
                a.push(v);
            }
        }
        _ => {}
    }
}

fn truncate_array(item: &mut Item, len: usize) {
    match item {
        Item::ArrayOfTables(a) => {
            while a.len() > len {
                a.remove(a.len() - 1);
            }
        }
        Item::Value(toml_edit::Value::Array(a)) => {
            while a.len() > len {
                a.remove(a.len() - 1);
            }
        }
        _ => {}
    }
}

/// Represent an item as a block table, converting from inline if needed.
fn to_block_table(item: &Item) -> Item {
    match item {
        Item::Table(_) => item.clone(),
        Item::Value(toml_edit::Value::InlineTable(t)) => Item::Table(t.clone().into_table()),
        other => other.clone(),
    }
}

/// Collapse a freshly-inserted array onto one line.
///
/// `toml_edit` gives a newly serialised array a multi-line layout, which is
/// jarring next to the hand-written single-line arrays around it. Values the
/// user already had keep whatever decor they came with; this only touches
/// arrays we are inserting for the first time.
fn compact_new_array(value: &mut toml_edit::Value) {
    match value {
        toml_edit::Value::Array(arr) => {
            for i in 0..arr.len() {
                if let Some(item) = arr.get_mut(i) {
                    compact_new_array(item);
                    // A leading newline is what makes an entry claim its own
                    // line; a single space keeps it beside its neighbour.
                    let prefix = if i == 0 { "" } else { " " };
                    *item.decor_mut() = toml_edit::Decor::new(prefix, "");
                }
            }
            arr.set_trailing("");
            arr.set_trailing_comma(false);
        }
        // Arrays also hide inside inline tables (`{ days = [...] }`), so the
        // walk has to descend through them too.
        toml_edit::Value::InlineTable(table) => {
            for (_, item) in table.iter_mut() {
                compact_new_array(item);
            }
        }
        _ => {}
    }
}

/// Represent an item as an inline value, converting from a block table if needed.
fn to_inline_value(item: &Item) -> Option<toml_edit::Value> {
    let mut value = match item {
        Item::Value(v) => v.clone(),
        Item::Table(t) => toml_edit::Value::InlineTable(t.clone().into_inline_table()),
        _ => return None,
    };
    // The serialiser lays arrays out one element per line, which reads fine as
    // a `[[block]]` table but not once flattened into an inline entry.
    compact_new_array(&mut value);
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::model::{Group, Limit, Route, TimeRange, Upstream};

    const SAMPLE: &str = r#"version = 2

# How the gateway listens.
[server]
port = 3001
path_prefix = "/"
upstream_base_url = "http://localhost:3000"
database_path = "./data/gateway.sqlite"
log_level = "info"

# Upstream models and the quota each one owns.
[[upstreams]]
model = "doubao-pro"   # the upstream name and unique identity
enabled = true
limits = [
  # 30 requests per minute.
  { type = "frequency", count = 30, period = "1min" },
]

[[upstreams]]
model = "glm"
enabled = true
limits = []

[[groups]]
entry_model = "group-free"
routes = [
  { upstream = "doubao-pro", priority = 100 },
  { upstream = "glm", priority = 50 },
]
"#;

    fn store_with(contents: &str) -> (tempfile::TempDir, ConfigStore) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, contents).unwrap();
        let store = ConfigStore::load(&path).unwrap();
        (dir, store)
    }

    #[test]
    fn loads_and_parses_the_sample() {
        let (_d, store) = store_with(SAMPLE);
        let cfg = store.snapshot();
        assert_eq!(cfg.upstreams.len(), 2);
        assert_eq!(cfg.upstreams[0].model, "doubao-pro");
        assert_eq!(cfg.groups[0].entry_model, "group-free");
    }

    #[test]
    fn editing_one_upstream_preserves_every_comment() {
        let (_d, store) = store_with(SAMPLE);
        store
            .update(|cfg| {
                cfg.upstream_mut("glm").unwrap().enabled = false;
                Ok(())
            })
            .unwrap();

        let on_disk = std::fs::read_to_string(store.path()).unwrap();
        for comment in [
            "# How the gateway listens.",
            "# Upstream models and the quota each one owns.",
            "# the upstream name and unique identity",
            "# 30 requests per minute.",
        ] {
            assert!(
                on_disk.contains(comment),
                "lost comment {comment}:\n{on_disk}"
            );
        }
        assert!(
            !ConfigStore::load(store.path())
                .unwrap()
                .snapshot()
                .upstream("glm")
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn adding_a_group_keeps_existing_formatting() {
        let (_d, store) = store_with(SAMPLE);
        store
            .update(|cfg| {
                cfg.groups.push(Group {
                    entry_model: "group-fast".into(),
                    routes: vec![Route {
                        upstream: "glm".into(),
                        priority: 10,
                        enabled: true,
                    }],
                    extra: Default::default(),
                });
                Ok(())
            })
            .unwrap();

        let on_disk = std::fs::read_to_string(store.path()).unwrap();
        assert!(on_disk.contains("# 30 requests per minute."));
        assert!(on_disk.contains("group-fast"));

        let reloaded = ConfigStore::load(store.path()).unwrap();
        assert_eq!(reloaded.snapshot().groups.len(), 2);
    }

    #[test]
    fn rejected_edits_leave_file_and_memory_untouched() {
        let (_d, store) = store_with(SAMPLE);
        let before = std::fs::read_to_string(store.path()).unwrap();

        let err = store.update(|cfg| {
            cfg.groups[0].routes[0].upstream = "does-not-exist".into();
            Ok(())
        });
        assert!(err.is_err());

        assert_eq!(std::fs::read_to_string(store.path()).unwrap(), before);
        assert_eq!(store.snapshot().groups[0].routes[0].upstream, "doubao-pro");
    }

    #[test]
    fn adding_an_upstream_round_trips() {
        let (_d, store) = store_with(SAMPLE);
        store
            .update(|cfg| {
                cfg.upstreams.push(Upstream {
                    model: "new-model".into(),
                    enabled: true,
                    limits: vec![],
                    extra: Default::default(),
                });
                Ok(())
            })
            .unwrap();

        let cfg = ConfigStore::load(store.path()).unwrap().snapshot();
        assert_eq!(cfg.upstreams.len(), 3);
        assert!(cfg.upstreams.iter().any(|u| u.model == "new-model"));
    }

    #[test]
    fn removing_an_upstream_removes_its_table() {
        let (_d, store) = store_with(SAMPLE);
        store
            .update(|cfg| {
                // The group referencing it must go too, or validation refuses.
                cfg.groups[0].routes.retain(|r| r.upstream != "glm");
                cfg.upstreams.retain(|u| u.model != "glm");
                Ok(())
            })
            .unwrap();

        let cfg = ConfigStore::load(store.path()).unwrap().snapshot();
        assert_eq!(cfg.upstreams.len(), 1);
        let on_disk = std::fs::read_to_string(store.path()).unwrap();
        assert!(!on_disk.contains("model = \"glm\""));
        // The surviving upstream kept its comments.
        assert!(on_disk.contains("# 30 requests per minute."));
    }

    #[test]
    fn an_unrelated_edit_leaves_other_entries_byte_identical() {
        let (_d, store) = store_with(SAMPLE);
        // Toggling `glm` must not reformat `doubao-pro` at all.
        store
            .update(|cfg| {
                cfg.upstream_mut("glm").unwrap().enabled = false;
                Ok(())
            })
            .unwrap();

        let on_disk = std::fs::read_to_string(store.path()).unwrap();
        assert!(
            on_disk.contains(r#"model = "doubao-pro"   # the upstream name and unique identity"#),
            "untouched entry was reformatted:\n{on_disk}"
        );
        assert!(on_disk.contains("{ type = \"frequency\", count = 30, period = \"1min\" }"));
    }

    #[test]
    fn writes_omit_defaults_and_keep_unit_suffixes() {
        const WITH_UNITS: &str = r#"version = 2

[server]
upstream_base_url = "http://localhost:3000"

[[upstreams]]
model = "m"
limits = [
  { type = "tokens", count = "5M", period = "1d", weight = { output = 10 } },
]

[[groups]]
entry_model = "g"
routes = [ { upstream = "m", priority = 1 } ]
"#;
        let (_d, store) = store_with(WITH_UNITS);
        store
            .update(|cfg| {
                cfg.group_mut("g").unwrap().routes[0].priority = 5;
                Ok(())
            })
            .unwrap();

        let on_disk = std::fs::read_to_string(store.path()).unwrap();
        // "5M" must not expand to 5000000 just because the file was rewritten.
        assert!(
            on_disk.contains(r#"count = "5M""#),
            "lost unit suffix:\n{on_disk}"
        );
        // Defaults stay out of the file.
        assert!(
            !on_disk.contains("cache_write"),
            "wrote a default weight:\n{on_disk}"
        );
        assert!(
            !on_disk.contains("enabled = true"),
            "wrote a default enabled:\n{on_disk}"
        );
        assert!(on_disk.contains("priority = 5"));
    }

    #[test]
    fn legacy_ids_are_mapped_to_model_names() {
        let legacy = r#"version = 2
[server]
upstream_base_url = "http://localhost:3000"
[[upstreams]]
id = "short-name"
model = "provider/full-name"
[[groups]]
entry_model = "entry"
routes = [{ upstream = "short-name", priority = 1 }]
"#;
        let (_d, store) = store_with(legacy);
        let cfg = store.snapshot();
        assert_eq!(cfg.upstreams[0].model, "provider/full-name");
        assert_eq!(cfg.groups[0].routes[0].upstream, "provider/full-name");
    }

    #[test]
    fn a_time_window_limit_round_trips_and_stays_readable() {
        use crate::config::units::ClockSpec;
        let (_d, store) = store_with(SAMPLE);
        store
            .update(|cfg| {
                cfg.upstream_mut("glm")
                    .unwrap()
                    .limits
                    .push(Limit::TimeWindow {
                        forbidden: vec![
                            TimeRange {
                                start: ClockSpec::parse("08:00").unwrap(),
                                end: ClockSpec::parse("10:00").unwrap(),
                            },
                            TimeRange {
                                start: ClockSpec::parse("22:00").unwrap(),
                                end: ClockSpec::parse("02:00").unwrap(),
                            },
                        ],
                        days: vec![1, 2, 3, 4, 5],
                    });
                Ok(())
            })
            .unwrap();

        let on_disk = std::fs::read_to_string(store.path()).unwrap();
        // A new array must not explode into one line per element.
        assert!(
            on_disk.contains("days = [1, 2, 3, 4, 5]"),
            "days array was not written inline:\n{on_disk}"
        );
        assert!(
            on_disk.contains("# 30 requests per minute."),
            "lost a comment"
        );

        let cfg = ConfigStore::load(store.path()).unwrap().snapshot();
        match &cfg.upstream("glm").unwrap().limits[0] {
            Limit::TimeWindow { forbidden, days } => {
                assert_eq!(forbidden.len(), 2);
                assert_eq!(forbidden[0].to_string(), "08:00-10:00");
                // The midnight-crossing window survives verbatim.
                assert_eq!(forbidden[1].to_string(), "22:00-02:00");
                assert_eq!(days, &[1, 2, 3, 4, 5]);
            }
            other => panic!("expected a time_window limit, got {other:?}"),
        }
    }

    #[test]
    fn repeated_edits_do_not_accumulate_drift() {
        let (_d, store) = store_with(SAMPLE);
        for i in 0..5 {
            store
                .update(|cfg| {
                    cfg.upstream_mut("glm").unwrap().enabled = i % 2 == 0;
                    Ok(())
                })
                .unwrap();
        }
        let on_disk = std::fs::read_to_string(store.path()).unwrap();
        assert!(on_disk.contains("# How the gateway listens."));
        assert!(on_disk.contains("# 30 requests per minute."));
        // One toggled key must not have duplicated any table.
        assert_eq!(on_disk.matches("[[upstreams]]").count(), 2);
        assert_eq!(on_disk.matches("[[groups]]").count(), 1);
    }
}

#[cfg(test)]
mod example_config_tests {
    use super::*;

    /// The shipped example must always be loadable and editable — it is the
    /// starting point every user copies.
    #[test]
    fn shipped_example_loads_and_survives_an_edit() {
        let src = concat!(env!("CARGO_MANIFEST_DIR"), "/config.example.toml");
        let raw = std::fs::read_to_string(src).expect("example config is missing");

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, &raw).unwrap();

        let store = ConfigStore::load(&path).unwrap();
        let cfg = store.snapshot();
        assert_eq!(cfg.upstreams.len(), 4);
        assert_eq!(cfg.groups.len(), 1);

        // Routes are listed highest priority first.
        let routes = &cfg.group("group-test").unwrap().routes;
        let order: Vec<&str> = routes.iter().map(|r| r.upstream.as_str()).collect();
        assert_eq!(
            order,
            [
                "gpt-5-nano",
                "gemini-3.1-flash-lite",
                "qwen3.8-27b",
                "qwen3.6-27b"
            ]
        );
        assert!(
            routes.windows(2).all(|w| w[0].priority > w[1].priority),
            "example priorities must be strictly descending"
        );

        // The per-minute request caps parsed as intended.
        for id in ["gpt-5-nano", "qwen3.8-27b", "qwen3.6-27b"] {
            match &cfg.upstream(id).unwrap().limits[0] {
                crate::config::Limit::Frequency { count, period, .. } => {
                    assert_eq!(count.get(), 5, "{id}");
                    assert_eq!(period.as_secs(), 60, "{id}");
                }
                other => panic!("{id}: expected a frequency limit, got {other:?}"),
            }
        }

        // The shipped time-window sample parses into local wall-clock hours.
        match &cfg.upstream("qwen3.6-27b").unwrap().limits[1] {
            crate::config::Limit::TimeWindow { forbidden, days } => {
                assert_eq!(forbidden.len(), 1);
                assert_eq!(forbidden[0].to_string(), "08:00-10:00");
                assert!(days.is_empty(), "the sample window applies every day");
            }
            other => panic!("expected a time_window limit, got {other:?}"),
        }

        // And the hourly token budget.
        match &cfg.upstream("gemini-3.1-flash-lite").unwrap().limits[0] {
            crate::config::Limit::Tokens {
                count,
                period,
                weight,
                ..
            } => {
                assert_eq!(count.get(), 100_000);
                assert_eq!(period.as_secs(), 3_600);
                assert!(weight.is_none(), "unweighted: every token counts once");
            }
            other => panic!("expected a tokens limit, got {other:?}"),
        }

        // Toggling an upstream keeps every comment in the file.
        store
            .update(|c| {
                c.upstream_mut("qwen3.6-27b").unwrap().enabled = false;
                Ok(())
            })
            .unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        for comment in [
            "# freetier-rotate-middleware v2 configuration.",
            "# Upstreams: the models the gateway can route to",
            "# Dispatch: highest priority first",
        ] {
            assert!(after.contains(comment), "lost comment: {comment}");
        }
        assert!(
            !ConfigStore::load(&path)
                .unwrap()
                .snapshot()
                .upstream("qwen3.6-27b")
                .unwrap()
                .enabled
        );
    }
}
