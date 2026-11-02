// Runs and sets. A run is a folder runs/<YYYY-MM-DD_HH-MM>_<name>/ with the images of this run
// ("<Name> (<class>) <uuid>.png", read-only), run.json (origin, result per entity) and the event log
// events.jsonl; immutable after the end. A set is a folder sets/<name>/ with all icons as hardlinks to
// the images of the runs (per entity the newest run in the chain with an image) and set.json (base, chain, files in the folder).
// `live` is the main set (pnpm thumbs:build reads it); experiments branch off live and are adopted
// by appending their runs to live's chain. No storage by content hash: renders are not bit-identical.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const LIVE: &str = "live";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct EntityResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// the images in the run folder, one per UUID
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct RunInfo {
    pub id: String,
    pub name: String,
    /// the set the run was started for
    pub set: String,
    pub node: String,
    pub started: String,
    #[serde(default)]
    pub finished: Option<String>,
    #[serde(default)]
    pub aborted: bool,
    /// Origin like run_start in the event log: filter, scope, invocation, hashes of render.py and addon, Blender, p4k
    #[serde(default)]
    pub origin: Value,
    #[serde(default)]
    pub entities: BTreeMap<String, EntityResult>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SetInfo {
    pub name: String,
    /// branched off from (None for live)
    #[serde(default)]
    pub base: Option<String>,
    /// the base's chain at the time of branching
    #[serde(default)]
    pub base_runs: Vec<String>,
    /// the own runs, oldest first
    #[serde(default)]
    pub runs: Vec<String>,
    /// files in the set folder -> run whose image the hardlink points to
    #[serde(default)]
    pub files: BTreeMap<String, String>,
}

impl SetInfo {
    pub fn chain(&self) -> impl Iterator<Item = &String> {
        self.base_runs.iter().chain(&self.runs)
    }
}

/// State of a set per entity
#[derive(Default)]
pub struct Resolved {
    /// Entity -> (run, files) of the newest run with an image
    pub image: HashMap<String, (String, Vec<String>)>,
    /// Entities whose newest attempt failed (even if an older image exists)
    pub failed: HashSet<String>,
}

impl Resolved {
    pub fn apply(&mut self, run: &str, entity: &str, r: &EntityResult) {
        if r.ok {
            self.image.insert(entity.to_string(), (run.to_string(), r.files.clone()));
            self.failed.remove(entity);
        } else {
            self.failed.insert(entity.to_string());
        }
    }
}

pub struct Store {
    pub root: PathBuf,
    runs: HashMap<String, RunInfo>,
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?).with_context(|| tmp.display().to_string())?;
    fs::rename(&tmp, path).with_context(|| path.display().to_string())
}

fn set_readonly(path: &Path, ro: bool) -> std::io::Result<()> {
    let mut p = fs::metadata(path)?.permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    p.set_readonly(ro);
    fs::set_permissions(path, p)
}

/// Removes a hardlink. Windows does not delete a read-only file, and the attribute belongs to the file (all
/// its links): so lift it briefly and set it again afterwards on the remaining link (`keep`)
fn remove_link(path: &Path, keep: Option<&Path>) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) if e.kind() == ErrorKind::PermissionDenied => {
            set_readonly(path, false)?;
            fs::remove_file(path).with_context(|| path.display().to_string())?;
            if let Some(k) = keep.filter(|k| k.exists()) {
                set_readonly(k, true)?;
            }
            Ok(())
        }
        Err(e) => Err(e).with_context(|| path.display().to_string()),
    }
}

/// Delete a folder including read-only files
pub(crate) fn remove_tree(dir: &Path) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for e in fs::read_dir(dir)?.flatten() {
        let p = e.path();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            remove_tree(&p)?;
        } else {
            remove_link(&p, None)?;
        }
    }
    fs::remove_dir(dir).with_context(|| dir.display().to_string())
}

/// Readable part of a name for folders: letters, digits, - and _
pub fn slug(s: &str) -> String {
    let s: String = s.trim().chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    s.chars().take(48).collect()
}

impl Store {
    /// Opens the store (runs/, sets/) and creates live if it is missing
    pub fn open(root: &Path) -> Result<Self> {
        for d in ["runs", "sets"] {
            fs::create_dir_all(root.join(d)).with_context(|| root.join(d).display().to_string())?;
        }
        let store = Self { root: root.to_path_buf(), runs: HashMap::new() };
        if !store.set_dir(LIVE).join("set.json").exists() {
            fs::create_dir_all(store.set_dir(LIVE))?;
            store.save_set(&SetInfo { name: LIVE.into(), ..Default::default() })?;
        }
        Ok(store)
    }

    pub fn run_dir(&self, id: &str) -> PathBuf {
        self.root.join("runs").join(id)
    }

    pub fn set_dir(&self, name: &str) -> PathBuf {
        self.root.join("sets").join(name)
    }

    pub fn sets(&self) -> Result<Vec<String>> {
        let mut out: Vec<String> = fs::read_dir(self.root.join("sets"))?
            .flatten()
            .filter(|e| e.path().join("set.json").exists())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        out.sort();
        Ok(out)
    }

    pub fn load_set(&self, name: &str) -> Result<SetInfo> {
        let path = self.set_dir(name).join("set.json");
        let bytes = fs::read(&path).with_context(|| format!("Set {name} not found ({})", path.display()))?;
        serde_json::from_slice(&bytes).with_context(|| path.display().to_string())
    }

    pub fn save_set(&self, set: &SetInfo) -> Result<()> {
        write_json(&self.set_dir(&set.name).join("set.json"), set)
    }

    pub fn run(&mut self, id: &str) -> Result<&RunInfo> {
        if !self.runs.contains_key(id) {
            let path = self.run_dir(id).join("run.json");
            let info: RunInfo = serde_json::from_slice(&fs::read(&path).with_context(|| path.display().to_string())?).with_context(|| path.display().to_string())?;
            self.runs.insert(id.to_string(), info);
        }
        Ok(&self.runs[id])
    }

    /// Node of a run without caching it (None if it has no readable run.json)
    pub fn peek_node(&self, id: &str) -> Option<String> {
        if let Some(r) = self.runs.get(id) {
            return Some(r.node.clone());
        }
        let info: RunInfo = serde_json::from_slice(&fs::read(self.run_dir(id).join("run.json")).ok()?).ok()?;
        Some(info.node)
    }

    /// All finished runs in runs/, for other coordinators (ListRuns)
    pub fn summaries(&mut self) -> Vec<crate::net::RunSummary> {
        let Ok(dir) = fs::read_dir(self.root.join("runs")) else { return Vec::new() };
        let mut ids: Vec<String> = dir.flatten().filter(|e| e.path().join("run.json").exists()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        ids.sort();
        let mut out = Vec::new();
        for id in ids {
            let bytes = fs::read_dir(self.run_dir(&id)).map(|d| d.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0);
            let Ok(r) = self.run(&id) else { continue };
            out.push(crate::net::RunSummary {
                id: r.id.clone(),
                name: r.name.clone(),
                set: r.set.clone(),
                node: r.node.clone(),
                finished: r.finished.is_some(),
                images: r.entities.values().filter(|e| e.ok).count(),
                bytes,
            });
        }
        out
    }

    pub fn save_run(&mut self, info: &RunInfo) -> Result<()> {
        write_json(&self.run_dir(&info.id).join("run.json"), info)?;
        self.runs.insert(info.id.clone(), info.clone());
        Ok(())
    }

    /// Folder name of a new run: start time (minute) and name, on a tie with -2, -3, …
    pub fn new_run_id(&self, name: &str) -> String {
        let base = format!("{}_{}", chrono::Local::now().format("%Y-%m-%d_%H-%M"), slug(name));
        let mut id = base.clone();
        let mut k = 2;
        while self.run_dir(&id).exists() {
            id = format!("{base}-{k}");
            k += 1;
        }
        id
    }

    /// New set, branched off `base` (key n)
    pub fn create_set(&mut self, name: &str, base: &str) -> Result<SetInfo> {
        if slug(name) != name || name.is_empty() {
            bail!("Set name \"{name}\": only letters, digits, - and _");
        }
        if self.set_dir(name).join("set.json").exists() {
            bail!("Set {name} exists already");
        }
        let b = self.load_set(base)?;
        let mut set = SetInfo { name: name.into(), base: Some(base.into()), base_runs: b.chain().cloned().collect(), ..Default::default() };
        fs::create_dir_all(self.set_dir(name))?;
        self.sync(&mut set)?;
        Ok(set)
    }

    pub fn resolve(&mut self, set: &SetInfo) -> Result<Resolved> {
        let mut r = Resolved::default();
        for id in set.chain().cloned().collect::<Vec<_>>() {
            let run = self.run(&id)?;
            for (entity, res) in &run.entities {
                r.apply(&id, entity, res);
            }
        }
        Ok(r)
    }

    /// Builds the set folder from the chain: create, replace and remove hardlinks, foreign PNGs gone.
    /// Returns (created, removed)
    pub fn sync(&mut self, set: &mut SetInfo) -> Result<(usize, usize)> {
        let resolved = self.resolve(set)?;
        let mut want: BTreeMap<String, String> = BTreeMap::new();
        for (run, files) in resolved.image.values() {
            for f in files {
                want.insert(f.clone(), run.clone());
            }
        }
        let dir = self.set_dir(&set.name);
        fs::create_dir_all(&dir)?;
        let (mut added, mut removed) = (0, 0);
        for (f, run) in &set.files {
            if want.get(f) != Some(run) {
                let keep = self.run_dir(run).join(f);
                remove_link(&dir.join(f), Some(&keep))?;
                removed += 1;
            }
        }
        for e in fs::read_dir(&dir)?.flatten() {
            let f = e.file_name().to_string_lossy().to_string();
            if f.to_lowercase().ends_with(".png") && !want.contains_key(&f) && !set.files.contains_key(&f) {
                remove_link(&e.path(), None)?;
                removed += 1;
            }
        }
        for (f, run) in &want {
            let path = dir.join(f);
            if set.files.get(f) == Some(run) && path.exists() {
                continue;
            }
            let src = self.run_dir(run).join(f);
            remove_link(&path, Some(&src))?;
            fs::hard_link(&src, &path).with_context(|| format!("{} -> {}", src.display(), path.display()))?;
            added += 1;
        }
        set.files = want;
        self.save_set(set)?;
        Ok((added, removed))
    }

    /// What deleting a run changes in a set: (entities that fall back to an older run, entities that lose their image)
    pub fn removal_impact(&mut self, set: &SetInfo, id: &str) -> Result<(usize, usize)> {
        let before = self.resolve(set)?;
        let mut without = set.clone();
        without.base_runs.retain(|r| r != id);
        without.runs.retain(|r| r != id);
        let after = self.resolve(&without)?;
        let (mut older, mut gone) = (0, 0);
        for (entity, (run, _)) in &before.image {
            if run == id {
                if after.image.contains_key(entity) { older += 1 } else { gone += 1 }
            }
        }
        Ok((older, gone))
    }

    /// Link an entity's images from a run into the set (during a run), the entity's old ones gone
    pub fn link_entity(&self, set: &mut SetInfo, old: &[String], run: &str, files: &[String]) -> Result<()> {
        let dir = self.set_dir(&set.name);
        for f in old {
            if let Some(prev) = set.files.remove(f) {
                remove_link(&dir.join(f), Some(&self.run_dir(&prev).join(f)))?;
            }
        }
        for f in files {
            let src = self.run_dir(run).join(f);
            if let Some(prev) = set.files.remove(f) {
                remove_link(&dir.join(f), Some(&self.run_dir(&prev).join(f)))?;
            }
            fs::hard_link(&src, dir.join(f)).with_context(|| format!("{} -> {}", src.display(), dir.join(f).display()))?;
            set.files.insert(f.clone(), run.to_string());
        }
        Ok(())
    }

    /// Adopt an experiment into live (key l): append its runs in their order to live's chain
    pub fn adopt(&mut self, name: &str) -> Result<usize> {
        if name == LIVE {
            bail!("live cannot be adopted into itself");
        }
        let exp = self.load_set(name)?;
        let mut live = self.load_set(LIVE)?;
        let new: Vec<String> = exp.runs.iter().filter(|r| !live.runs.contains(r)).cloned().collect();
        live.runs.extend(new.iter().cloned());
        self.sync(&mut live)?;
        Ok(new.len())
    }

    /// Delete a run (key x): remove from all sets (older ones show through again), rebuild sets, folder gone.
    /// Returns the affected sets
    pub fn delete_run(&mut self, id: &str) -> Result<Vec<String>> {
        let mut touched = Vec::new();
        for name in self.sets()? {
            let mut set = self.load_set(&name)?;
            let before = set.base_runs.len() + set.runs.len();
            set.base_runs.retain(|r| r != id);
            set.runs.retain(|r| r != id);
            if set.base_runs.len() + set.runs.len() != before {
                self.sync(&mut set)?;
                touched.push(name);
            }
        }
        remove_tree(&self.run_dir(id))?;
        self.runs.remove(id);
        Ok(touched)
    }

    /// Delete an experiment set: the folder and its runs that no other set uses any more
    pub fn delete_set(&mut self, name: &str) -> Result<usize> {
        if name == LIVE {
            bail!("live cannot be deleted");
        }
        let set = self.load_set(name)?;
        remove_tree(&self.set_dir(name))?;
        let mut used = HashSet::new();
        for other in self.sets()? {
            used.extend(self.load_set(&other)?.chain().cloned());
        }
        let mut n = 0;
        for r in set.runs.iter().filter(|r| !used.contains(*r)) {
            remove_tree(&self.run_dir(r))?;
            self.runs.remove(r);
            n += 1;
        }
        Ok(n)
    }

    /// Take a finished image into the run: move (otherwise copy) as the first file, the further UUIDs as
    /// hardlinks to it, all read-only
    pub fn put_image(&self, run: &str, src: &Path, files: &[String]) -> Result<()> {
        let dir = self.run_dir(run);
        let Some(first) = files.first() else { return Ok(()) };
        let dst = dir.join(first);
        remove_link(&dst, None)?;
        if fs::rename(src, &dst).is_err() {
            fs::copy(src, &dst).with_context(|| format!("{} -> {}", src.display(), dst.display()))?;
            let _ = fs::remove_file(src);
        }
        set_readonly(&dst, true)?;
        for f in &files[1..] {
            let p = dir.join(f);
            remove_link(&p, None)?;
            if fs::hard_link(&dst, &p).is_err() {
                fs::copy(&dst, &p).with_context(|| p.display().to_string())?;
                set_readonly(&p, true)?;
            }
        }
        Ok(())
    }

    /// The newest event log (run folders sort by date)
    pub fn latest_events(&self) -> Option<PathBuf> {
        let mut dirs: Vec<PathBuf> = fs::read_dir(self.root.join("runs")).ok()?.flatten().map(|e| e.path().join("events.jsonl")).filter(|p| p.exists()).collect();
        dirs.sort();
        dirs.pop()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("packshot-test-{name}-{}", std::process::id()));
        let _ = remove_tree(&d);
        d
    }

    /// Create a run with images: per entity (name, ok, content)
    fn add_run(store: &mut Store, set: &mut SetInfo, id: &str, items: &[(&str, bool, &str)]) {
        fs::create_dir_all(store.run_dir(id)).unwrap();
        let mut info = RunInfo { id: id.into(), name: id.into(), set: set.name.clone(), ..Default::default() };
        for (entity, ok, content) in items {
            let mut files = Vec::new();
            if *ok {
                let src = store.root.join("render.png");
                fs::write(&src, content).unwrap();
                files.push(format!("{entity} 0000.png"));
                store.put_image(id, &src, &files).unwrap();
            }
            info.entities.insert(entity.to_string(), EntityResult { ok: *ok, error: (!ok).then(|| "x".into()), files });
        }
        store.save_run(&info).unwrap();
        set.runs.push(id.into());
        store.sync(set).unwrap();
    }

    fn read(store: &Store, set: &str, entity: &str) -> Option<String> {
        fs::read_to_string(store.set_dir(set).join(format!("{entity} 0000.png"))).ok()
    }

    #[test]
    fn chain_branch_adopt_delete() {
        let root = tmp("chain");
        let mut store = Store::open(&root).unwrap();
        let mut live = store.load_set(LIVE).unwrap();
        add_run(&mut store, &mut live, "r1", &[("a", true, "a1"), ("b", true, "b1"), ("c", false, "")]);
        add_run(&mut store, &mut live, "r2", &[("a", true, "a2"), ("b", false, "")]);
        assert_eq!(read(&store, LIVE, "a").as_deref(), Some("a2"));
        // b: old image stays, but counts as failed
        assert_eq!(read(&store, LIVE, "b").as_deref(), Some("b1"));
        let r = store.resolve(&live).unwrap();
        assert!(r.failed.contains("b") && r.failed.contains("c") && !r.failed.contains("a"));
        // images read-only, also via the set link
        assert!(fs::metadata(store.set_dir(LIVE).join("a 0000.png")).unwrap().permissions().readonly());

        // experiment: branches off, own run overrides only there
        let mut exp = store.create_set("exp", LIVE).unwrap();
        assert_eq!(read(&store, "exp", "a").as_deref(), Some("a2"));
        add_run(&mut store, &mut exp, "r3", &[("a", true, "a3"), ("c", true, "c3")]);
        assert_eq!(read(&store, "exp", "a").as_deref(), Some("a3"));
        assert_eq!(read(&store, LIVE, "a").as_deref(), Some("a2"));
        assert_eq!(read(&store, LIVE, "c"), None);

        // adopt: r3 attaches to live
        assert_eq!(store.adopt("exp").unwrap(), 1);
        let live = store.load_set(LIVE).unwrap();
        assert_eq!(live.runs, vec!["r1", "r2", "r3"]);
        assert_eq!(read(&store, LIVE, "a").as_deref(), Some("a3"));
        assert_eq!(read(&store, LIVE, "c").as_deref(), Some("c3"));

        // delete a run from the middle of live: r1 shows through for b, a still comes from r3
        let touched = store.delete_run("r2").unwrap();
        assert_eq!(touched, vec!["exp".to_string(), LIVE.to_string()]);
        assert_eq!(read(&store, LIVE, "b").as_deref(), Some("b1"));
        assert!(!store.resolve(&store.load_set(LIVE).unwrap()).unwrap().failed.contains("b"));
        assert!(!store.run_dir("r2").exists());
        // r1's images are still read-only after the links are removed
        assert!(fs::metadata(store.run_dir("r1").join("b 0000.png")).unwrap().permissions().readonly());

        // delete r3: a falls back to r1, c is missing again
        store.delete_run("r3").unwrap();
        assert_eq!(read(&store, LIVE, "a").as_deref(), Some("a1"));
        assert_eq!(read(&store, LIVE, "c"), None);

        // delete set: folder gone, live stays
        store.delete_set("exp").unwrap();
        assert!(!store.set_dir("exp").exists());
        assert_eq!(store.sets().unwrap(), vec![LIVE.to_string()]);
        remove_tree(&root).unwrap();
    }

    #[test]
    fn sync_repairs_folder() {
        let root = tmp("sync");
        let mut store = Store::open(&root).unwrap();
        let mut live = store.load_set(LIVE).unwrap();
        add_run(&mut store, &mut live, "r1", &[("a", true, "a1"), ("b", true, "b1")]);
        // deleted link comes back, foreign PNG gets thrown out
        remove_link(&store.set_dir(LIVE).join("a 0000.png"), None).unwrap();
        fs::write(store.set_dir(LIVE).join("stray.png"), "x").unwrap();
        let (added, removed) = store.sync(&mut live).unwrap();
        assert_eq!((added, removed), (1, 1));
        assert_eq!(read(&store, LIVE, "a").as_deref(), Some("a1"));
        assert!(!store.set_dir(LIVE).join("stray.png").exists());
        remove_tree(&root).unwrap();
    }

    #[test]
    fn link_entity_replaces_old_names() {
        let root = tmp("link");
        let mut store = Store::open(&root).unwrap();
        let mut live = store.load_set(LIVE).unwrap();
        add_run(&mut store, &mut live, "r1", &[("a", true, "a1")]);
        // new display name: different file, the old one disappears
        fs::create_dir_all(store.run_dir("r2")).unwrap();
        let src = root.join("render.png");
        fs::write(&src, "a2").unwrap();
        let files = vec!["A neu 0000.png".to_string()];
        store.put_image("r2", &src, &files).unwrap();
        store.link_entity(&mut live, &["a 0000.png".to_string()], "r2", &files).unwrap();
        assert!(!store.set_dir(LIVE).join("a 0000.png").exists());
        assert_eq!(fs::read_to_string(store.set_dir(LIVE).join("A neu 0000.png")).unwrap(), "a2");
        assert!(fs::metadata(store.run_dir("r1").join("a 0000.png")).unwrap().permissions().readonly());
        remove_tree(&root).unwrap();
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("arms legs, helmet"), "arms-legs-helmet");
        assert_eq!(slug("_arms_"), "_arms_");
        assert_eq!(slug("  "), "");
    }
}
