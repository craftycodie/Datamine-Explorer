// The spool of a live session: a log file and its sidecar (`<file>.json`) in the OS temp folder,
// `<temp>/datamine-viewer/live/`. The explorer's log worker appends to them as entries arrive, reads
// them back like any file, and the user can copy them elsewhere with "Save session as". Nothing
// outside that folder can be written, and old ones are tidied away at start-up.
#![allow(non_camel_case_types)]

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const SIDECAR_SUFFIX: &str = ".json";
// A spool older than this goes at start-up.
pub const AGE_MAXIMUM_MS: u64 = 7 * 24 * 60 * 60 * 1000;
// Of the rest, this many of the newest stay.
pub const KEEP: usize = 5;
// The first line of a sidecar says which server the spool is from.
const HEAD_BYTES: u64 = 8192;

// The folder keeps the app's old name, Datamine Viewer, so spools from earlier installs are still found.
pub fn spool_dir() -> PathBuf {
    std::env::temp_dir().join("datamine-viewer").join("live")
}

// The spools being written, and whether the folder can be read. Reads stay allowed once a spool has
// been opened, until the explorer opens another folder or file.
#[derive(Default)]
pub struct SpoolState {
    open: HashMap<PathBuf, File>,
    pub readable: bool,
}

// `path` must be a file directly inside `dir`: its folder canonicalizes to the spool folder, so a
// `..`, a symlinked folder or a sub folder does not get through.
pub fn guard(dir: &Path, path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let name = match path.components().next_back() {
        Some(Component::Normal(name)) => name.to_owned(),
        _ => return Err(format!("{} is not a file", path.display())),
    };
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| format!("{} is not in the spool folder", path.display()))?;
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("{} is not in the spool folder: {error}", path.display()))?;
    let dir = dir
        .canonicalize()
        .map_err(|error| format!("the spool folder does not exist: {error}"))?;
    if parent != dir {
        return Err(format!("{} is not in the spool folder", path.display()));
    }
    Ok(dir.join(name))
}

fn sidecar_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(SIDECAR_SUFFIX);
    PathBuf::from(name)
}

// A name the spool folder can hold: plain characters, no folders.
fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64)
}

// The server (prefix URL) a sidecar's first line names, when it is a spool's.
fn server_of(sidecar: &Path) -> Option<String> {
    let mut head = Vec::new();
    File::open(sidecar).ok()?.take(HEAD_BYTES).read_to_end(&mut head).ok()?;
    let line = head.split(|byte| *byte == b'\n').next()?;
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    if value.get("kind")?.as_str()? != "spool" {
        return None;
    }
    Some(value.get("prefix")?.as_str()?.to_owned())
}

impl SpoolState {
    // Makes the log and its sidecar. A name already taken gets a number.
    pub fn create(&mut self, name: &str) -> Result<PathBuf, String> {
        if !name_valid(name) {
            return Err(format!("{name} is not a spool name"));
        }
        let dir = spool_dir();
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let dir = dir.canonicalize().map_err(|error| error.to_string())?;
        let (stem, extension) = match name.rsplit_once('.') {
            Some((stem, extension)) => (stem, format!(".{extension}")),
            None => (name, String::new()),
        };
        for attempt in 0.. {
            let candidate = if attempt == 0 {
                name.to_owned()
            } else {
                format!("{stem}_{attempt}{extension}")
            };
            let path = dir.join(&candidate);
            let sidecar = sidecar_of(&path);
            let options = || {
                let mut options = OpenOptions::new();
                options.create_new(true).append(true);
                options
            };
            let Ok(text_file) = options().open(&path) else {
                if attempt > 1000 {
                    return Err("no free spool name".to_owned());
                }
                continue;
            };
            let sidecar_file = options().open(&sidecar).map_err(|error| error.to_string())?;
            self.open.insert(path.clone(), text_file);
            self.open.insert(sidecar, sidecar_file);
            self.readable = true;
            return Ok(path);
        }
        unreachable!()
    }

    // Opens an existing log and its sidecar to append to.
    pub fn resume(&mut self, path: &str) -> Result<PathBuf, String> {
        let path = guard(&spool_dir(), path)?;
        for file in [path.clone(), sidecar_of(&path)] {
            if !self.open.contains_key(&file) {
                let handle = OpenOptions::new()
                    .append(true)
                    .open(&file)
                    .map_err(|error| format!("cannot open {}: {error}", file.display()))?;
                self.open.insert(file, handle);
            }
        }
        self.readable = true;
        Ok(path)
    }

    pub fn append(&mut self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let path = guard(&spool_dir(), path)?;
        let file = self
            .open
            .get_mut(&path)
            .ok_or_else(|| format!("{} is not open for writing", path.display()))?;
        file.write_all(bytes).map_err(|error| error.to_string())
    }

    // Both files are written out and closed; they stay on disk.
    pub fn finish(&mut self, path: &str) -> Result<(), String> {
        let path = guard(&spool_dir(), path)?;
        for file in [path.clone(), sidecar_of(&path)] {
            if let Some(handle) = self.open.remove(&file) {
                handle.sync_data().map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}

// The newest spool of a server, by its sidecar's first line.
pub fn find(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let dir = dir.canonicalize().ok()?;
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in fs::read_dir(&dir).ok()?.flatten() {
        let sidecar = entry.path();
        let Some(name) = sidecar.file_name()?.to_str().map(str::to_owned) else {
            continue;
        };
        let Some(text) = name.strip_suffix(SIDECAR_SUFFIX) else {
            continue;
        };
        let text = dir.join(text);
        if !text.is_file() || server_of(&sidecar).as_deref() != Some(prefix) {
            continue;
        }
        let modified = modified_ms(&sidecar);
        if best.as_ref().is_none_or(|(newest, _)| modified > *newest) {
            best = Some((modified, text));
        }
    }
    best.map(|(_, path)| path)
}

// Copies the log to `dest`, and only the log: the sidecar is the explorer's own working file. A spool that
// is still being written is copied as far as it is written.
pub fn copy(dir: &Path, path: &str, dest: &str) -> Result<u64, String> {
    let source = guard(dir, path)?;
    let dest = PathBuf::from(dest);
    let dir = dir.canonicalize().map_err(|error| error.to_string())?;
    if dest.parent().is_some_and(|parent| parent.canonicalize().is_ok_and(|parent| parent == dir)) {
        return Err("choose a place outside the spool folder".to_owned());
    }
    let length = fs::metadata(&source).map_err(|error| error.to_string())?.len();
    copy_up_to(&source, &dest, length)
}

fn copy_up_to(source: &Path, dest: &Path, length: u64) -> Result<u64, String> {
    let mut input = File::open(source).map_err(|error| error.to_string())?.take(length);
    let mut output = File::create(dest).map_err(|error| format!("cannot write {}: {error}", dest.display()))?;
    std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())
}

// The header value the path travels in is percent-encoded (headers are ASCII).
pub fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = text.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ---- tidying

#[derive(Clone, Debug, PartialEq)]
pub struct s_spool_group {
    pub name: String,
    pub modified_ms: u64,
    pub server: Option<String>,
}

// The names to delete. A spool goes when it is older than a week, or when it is not among the
// newest few; the newest of each server stays however many servers there are, since the next
// connection to it carries on there. A spool being written now is never listed.
pub fn cleanup_plan(groups: &[s_spool_group], now_ms: u64, running: &HashSet<String>) -> Vec<String> {
    let mut idle: Vec<&s_spool_group> = groups.iter().filter(|group| !running.contains(&group.name)).collect();
    idle.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.name.cmp(&b.name)));
    let mut newest: HashSet<&str> = idle.iter().take(KEEP).map(|group| group.name.as_str()).collect();
    let mut servers = HashSet::new();
    for group in &idle {
        if let Some(server) = &group.server {
            if servers.insert(server.as_str()) {
                newest.insert(group.name.as_str());
            }
        }
    }
    idle.iter()
        .filter(|group| now_ms.saturating_sub(group.modified_ms) > AGE_MAXIMUM_MS || !newest.contains(group.name.as_str()))
        .map(|group| group.name.clone())
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

// Deletes the spools that are old or past the newest few. Run once, before anything is spooled.
pub fn cleanup(dir: &Path, running: &HashSet<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut modified: HashMap<String, u64> = HashMap::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let base = name.strip_suffix(SIDECAR_SUFFIX).unwrap_or(&name).to_owned();
        let time = modified_ms(&entry.path());
        let slot = modified.entry(base).or_insert(0);
        *slot = (*slot).max(time);
    }
    let groups: Vec<s_spool_group> = modified
        .into_iter()
        .map(|(name, modified_ms)| {
            let server = server_of(&sidecar_of(&dir.join(&name)));
            s_spool_group { name, modified_ms, server }
        })
        .collect();
    for name in cleanup_plan(&groups, now_ms(), running) {
        let _ = fs::remove_file(dir.join(&name));
        let _ = fs::remove_file(sidecar_of(&dir.join(&name)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dmv-spool-test-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn guard_accepts_only_files_directly_in_the_folder() {
        let dir = scratch("guard");
        let inside = dir.join("a.txt");
        fs::write(&inside, "x").unwrap();
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let outside = scratch("guard-outside");
        fs::write(outside.join("b.txt"), "y").unwrap();

        assert!(guard(&dir, inside.to_str().unwrap()).is_ok());
        // a file that does not exist yet is fine
        assert!(guard(&dir, dir.join("new.txt").to_str().unwrap()).is_ok());
        // traversal out, a sibling folder, a sub folder, a bare name and the folder itself are not
        let traversal = format!("{}/../{}/b.txt", dir.display(), outside.file_name().unwrap().to_str().unwrap());
        assert!(guard(&dir, &traversal).is_err());
        assert!(guard(&dir, outside.join("b.txt").to_str().unwrap()).is_err());
        assert!(guard(&dir, sub.join("c.txt").to_str().unwrap()).is_err());
        assert!(guard(&dir, "a.txt").is_err());
        assert!(guard(&dir, dir.to_str().unwrap()).is_err());
        assert!(guard(&dir, &format!("{}/..", dir.display())).is_err());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn names_are_plain() {
        assert!(name_valid("127.0.0.1_32557_20261016_235959.txt"));
        assert!(!name_valid("../x.txt"));
        assert!(!name_valid("a/b.txt"));
        assert!(!name_valid(".hidden"));
        assert!(!name_valid(""));
    }

    #[test]
    fn percent_decoding_restores_paths() {
        assert_eq!(percent_decode("C%3A%5CUsers%5Cj%C3%B6rg%5Cx.txt").as_deref(), Some("C:\\Users\\j\u{f6}rg\\x.txt"));
        assert_eq!(percent_decode("plain").as_deref(), Some("plain"));
        assert!(percent_decode("%zz").is_none());
        assert!(percent_decode("%4").is_none());
    }

    #[test]
    fn copy_takes_only_the_log_and_refuses_the_spool_folder() {
        let dir = scratch("copy");
        let target = scratch("copy-target");
        let log = dir.join("s.txt");
        fs::write(&log, "line 1\r\nline 2\r\n").unwrap();
        fs::write(sidecar_of(&log), "{\"kind\":\"spool\"}\n").unwrap();

        let dest = target.join("saved.txt");
        let bytes = copy(&dir, log.to_str().unwrap(), dest.to_str().unwrap()).unwrap();
        assert_eq!(bytes, 16);
        assert_eq!(fs::read_to_string(&dest).unwrap(), "line 1\r\nline 2\r\n");
        // the sidecar stays where it is
        assert!(!sidecar_of(&dest).exists());
        assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
        assert!(copy(&dir, log.to_str().unwrap(), dir.join("again.txt").to_str().unwrap()).is_err());
        assert!(copy(&dir, target.join("saved.txt").to_str().unwrap(), dir.join("x.txt").to_str().unwrap()).is_err());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn find_matches_the_server_in_the_sidecar_and_takes_the_newest() {
        let dir = scratch("find");
        for (name, prefix) in [("a.txt", "http://h:1/datamine"), ("b.txt", "http://h:2/datamine"), ("c.txt", "http://h:1/datamine")] {
            fs::write(dir.join(name), "x").unwrap();
            fs::write(
                dir.join(format!("{name}.json")),
                format!("{{\"kind\":\"spool\",\"prefix\":\"{prefix}\"}}\n{{\"ordinal\":0}}\n"),
            )
            .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // a file with no sidecar, and a sidecar with no file
        fs::write(dir.join("d.txt"), "x").unwrap();
        fs::write(dir.join("e.txt.json"), "{\"kind\":\"spool\",\"prefix\":\"http://h:1/datamine\"}\n").unwrap();

        let found = find(&dir, "http://h:1/datamine").unwrap();
        assert_eq!(found.file_name().unwrap(), "c.txt");
        assert_eq!(find(&dir, "http://h:2/datamine").unwrap().file_name().unwrap(), "b.txt");
        assert!(find(&dir, "http://h:3/datamine").is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    fn group(name: &str, age_days: u64, server: Option<&str>) -> s_spool_group {
        s_spool_group {
            name: name.to_owned(),
            modified_ms: 100 * 24 * 60 * 60 * 1000 - age_days * 24 * 60 * 60 * 1000,
            server: server.map(str::to_owned),
        }
    }

    #[test]
    fn cleanup_drops_old_and_beyond_the_newest_five_but_keeps_each_servers_newest() {
        let now = 100 * 24 * 60 * 60 * 1000;
        let none = HashSet::new();
        // eight spools of one server, one a day: the newest five stay, then the age rule
        let groups: Vec<s_spool_group> = (0..8).map(|n| group(&format!("s{n}"), n, Some("x"))).collect();
        assert_eq!(cleanup_plan(&groups, now, &none), vec!["s5", "s6", "s7"]);
        // the newest of another server stays even when it is far down the order, but not past a week
        let mut groups = groups;
        groups.push(group("other", 6, Some("y")));
        groups.push(group("stale", 9, Some("z")));
        groups.push(group("loose", 1, None));
        assert_eq!(cleanup_plan(&groups, now, &none), vec!["s4", "s5", "s6", "s7", "stale"]);
        // one being written is never deleted
        let running: HashSet<String> = ["s7".to_owned()].into();
        assert!(!cleanup_plan(&groups, now, &running).contains(&"s7".to_owned()));
    }

    #[test]
    fn a_spool_is_written_found_and_read_back() {
        // the state works on the real temp folder, so use a name no other test does
        let mut state = SpoolState::default();
        let name = format!("unit_test_{}.txt", std::process::id());
        let path = state.create(&name).unwrap();
        assert!(state.readable);
        state.append(path.to_str().unwrap(), b"hello\r\n").unwrap();
        state.append(sidecar_of(&path).to_str().unwrap(), b"{\"kind\":\"spool\",\"prefix\":\"unit-test-server\"}\n").unwrap();
        // a path outside the folder cannot be written, and neither can one not opened
        assert!(state.append(std::env::temp_dir().join("outside.txt").to_str().unwrap(), b"x").is_err());
        state.finish(path.to_str().unwrap()).unwrap();
        assert!(state.append(path.to_str().unwrap(), b"x").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello\r\n");
        assert_eq!(find(&spool_dir(), "unit-test-server").unwrap(), path);
        state.resume(path.to_str().unwrap()).unwrap();
        state.append(path.to_str().unwrap(), b"more\r\n").unwrap();
        state.finish(path.to_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello\r\nmore\r\n");
        fs::remove_file(&path).unwrap();
        fs::remove_file(sidecar_of(&path)).unwrap();
    }
}
