// Read-only log explorer shell: a folder tree (or one file), byte ranges of its files, and a watcher.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod spool;
mod watch;
mod xbdm;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use files::s_file_node;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};

// What reads are allowed: everything under a folder, one file, or several files shown together.
// All are canonical paths.
enum Root {
    Folder(PathBuf),
    File(PathBuf),
    Files(Vec<PathBuf>),
}

// A file or its sidecar (`<file>.json`).
fn file_or_sidecar(file: &Path, canonical: &Path) -> bool {
    let mut sidecar = file.as_os_str().to_owned();
    sidecar.push(".json");
    canonical == file || canonical.as_os_str() == sidecar
}

// The opened folder or file and its watcher. Every read is checked against it.
#[derive(Default)]
pub struct ExplorerState {
    root: Mutex<Option<Root>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    spool: Mutex<spool::SpoolState>,
}

impl ExplorerState {
    fn set_root(&self, root: &str) -> Result<PathBuf, String> {
        let canonical = Path::new(root)
            .canonicalize()
            .map_err(|error| format!("cannot open {root}: {error}"))?;
        if !canonical.is_dir() {
            return Err(format!("{root} is not a folder"));
        }
        let mut current = self.root.lock().unwrap();
        // opening the same folder again (a refresh) leaves a spool readable; opening another does not
        if !matches!(current.as_ref(), Some(Root::Folder(folder)) if *folder == canonical) {
            self.spool.lock().unwrap().readable = false;
        }
        *current = Some(Root::Folder(canonical.clone()));
        Ok(canonical)
    }

    // Opens a single file: it is the only thing that can be read afterwards.
    fn set_file(&self, path: &str) -> Result<PathBuf, String> {
        let canonical = Path::new(path)
            .canonicalize()
            .map_err(|error| format!("cannot open {path}: {error}"))?;
        if !canonical.is_file() {
            return Err(format!("{path} is not a file"));
        }
        let mut current = self.root.lock().unwrap();
        if !matches!(current.as_ref(), Some(Root::File(file)) if *file == canonical) {
            self.spool.lock().unwrap().readable = false;
        }
        *current = Some(Root::File(canonical.clone()));
        Ok(canonical)
    }

    // Opens several files to be read together. A spool stays readable: servers are among the sources.
    fn set_files(&self, paths: &[String]) -> Result<Vec<PathBuf>, String> {
        let mut files = Vec::with_capacity(paths.len());
        for path in paths {
            let canonical = Path::new(path)
                .canonicalize()
                .map_err(|error| format!("cannot open {path}: {error}"))?;
            if !canonical.is_file() {
                return Err(format!("{path} is not a file"));
            }
            files.push(canonical);
        }
        *self.root.lock().unwrap() = Some(Root::Files(files.clone()));
        Ok(files)
    }

    // Canonicalizes `path` and rejects anything outside the opened folder or file. A file's sidecar
    // (`<file>.json`) reads with it, and so does the spool folder while a spool is open.
    fn inside_root(&self, path: &str) -> Result<PathBuf, String> {
        let canonical = Path::new(path)
            .canonicalize()
            .map_err(|error| format!("cannot read {path}: {error}"))?;
        if self.spool.lock().unwrap().readable
            && spool::guard(&spool::spool_dir(), path).is_ok_and(|inside| inside == canonical)
        {
            return Ok(canonical);
        }
        let root = self.root.lock().unwrap();
        let root = root.as_ref().ok_or("no folder is open")?;
        let inside = match root {
            Root::Folder(folder) => canonical.starts_with(folder),
            Root::File(file) => file_or_sidecar(file, &canonical),
            Root::Files(files) => files.iter().any(|file| file_or_sidecar(file, &canonical)),
        };
        if inside {
            Ok(canonical)
        } else {
            Err(format!("{path} is outside the opened folder"))
        }
    }
}

// Opens `root` and returns its tree.
#[tauri::command]
fn list_tree(root: String, state: State<ExplorerState>) -> Result<Vec<s_file_node>, String> {
    let root = state.set_root(&root)?;
    Ok(files::tree_list(&root))
}

// Opens `path` as a single file and returns its node.
#[tauri::command]
fn open_file(path: String, state: State<ExplorerState>) -> Result<s_file_node, String> {
    let file = state.set_file(&path)?;
    files::file_node(&file)
}

// Opens several files to be read together and returns their nodes, in the order given.
#[tauri::command]
fn open_files(paths: Vec<String>, state: State<ExplorerState>) -> Result<Vec<s_file_node>, String> {
    state.set_files(&paths)?.iter().map(|file| files::file_node(file)).collect()
}

// What a typed path is, so the toolbar can open it as a folder or a file.
#[tauri::command]
fn path_kind(path: String) -> &'static str {
    let path = Path::new(&path);
    if path.is_dir() {
        "folder"
    } else if path.is_file() {
        "file"
    } else {
        "missing"
    }
}

#[tauri::command]
fn file_stat(path: String, state: State<ExplorerState>) -> Result<files::s_file_stat, String> {
    files::file_stat(&state.inside_root(&path)?)
}

#[tauri::command]
fn read_file_range(
    path: String,
    offset: u64,
    length: u64,
    state: State<ExplorerState>,
) -> Result<Response, String> {
    let bytes = files::file_read_range(&state.inside_root(&path)?, offset, length)?;
    Ok(Response::new(bytes))
}

// Watches the opened folder, or for a single file its folder, reporting that file alone.
#[tauri::command]
fn watch_path(path: String, app: AppHandle, state: State<ExplorerState>) -> Result<(), String> {
    let canonical = Path::new(&path)
        .canonicalize()
        .map_err(|error| format!("cannot watch {path}: {error}"))?;
    let watcher = if canonical.is_dir() {
        let root = state.set_root(&path)?;
        watch::folder_watch(app, &root, None)?
    } else {
        let file = state.set_file(&path)?;
        let parent = file.parent().ok_or("the file has no folder")?;
        watch::folder_watch(app, parent, Some(file.clone()))?
    };
    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(())
}

#[tauri::command]
fn unwatch_path(state: State<ExplorerState>) {
    // dropping the watcher closes its channel, which ends the debounce thread
    *state.watcher.lock().unwrap() = None;
}

// --- the spool of a live session (see spool.rs)

// Makes a log and its sidecar in the temp folder and gives the log's path.
#[tauri::command]
fn spool_create(name: String, state: State<ExplorerState>) -> Result<String, String> {
    let path = state.spool.lock().unwrap().create(&name)?;
    Ok(files::path_text(&path))
}

// The newest spool of a server (its prefix URL), if one is there.
#[tauri::command]
fn spool_find(prefix: String, state: State<ExplorerState>) -> Option<String> {
    let path = spool::find(&spool::spool_dir(), &prefix)?;
    state.spool.lock().unwrap().readable = true;
    Some(files::path_text(&path))
}

#[tauri::command]
fn spool_resume(path: String, state: State<ExplorerState>) -> Result<(), String> {
    state.spool.lock().unwrap().resume(&path).map(|_| ())
}

// The bytes are the request body; the path is in a header, percent-encoded.
#[tauri::command]
fn spool_append(request: Request<'_>, state: State<ExplorerState>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("the bytes to append must be sent as the body".to_owned());
    };
    let path = request
        .headers()
        .get("path")
        .and_then(|value| value.to_str().ok())
        .and_then(spool::percent_decode)
        .ok_or("no path")?;
    state.spool.lock().unwrap().append(&path, bytes)
}

#[tauri::command]
fn spool_finish(path: String, state: State<ExplorerState>) -> Result<(), String> {
    state.spool.lock().unwrap().finish(&path)
}

// Copies a spool's log (not its sidecar) to `dest`; gives the bytes of the log.
#[tauri::command]
fn spool_copy(path: String, dest: String) -> Result<u64, String> {
    spool::copy(&spool::spool_dir(), &path, &dest)
}

// The first command line argument that is a folder or a file.
#[tauri::command]
fn startup_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && Path::new(arg).exists())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ExplorerState::default())
        .manage(xbdm::XbdmState::default())
        .setup(|_app| {
            // spools left by earlier runs, before this one makes any
            std::thread::spawn(|| spool::cleanup(&spool::spool_dir(), &std::collections::HashSet::new()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tree,
            open_file,
            open_files,
            path_kind,
            file_stat,
            read_file_range,
            watch_path,
            unwatch_path,
            startup_path,
            spool_create,
            spool_find,
            spool_resume,
            spool_append,
            spool_finish,
            spool_copy,
            xbdm::xbdm_open,
            xbdm::xbdm_close,
            xbdm::xbdm_close_all
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Datamine Explorer");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn single_file_root_allows_only_that_file() {
        let dir = std::env::temp_dir().join(format!("dmv-root-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let wanted = dir.join("wanted.log");
        let other = dir.join("other.log");
        fs::write(&wanted, "a").unwrap();
        fs::write(&other, "b").unwrap();

        let state = ExplorerState::default();
        assert!(state.set_file(dir.to_str().unwrap()).is_err());
        state.set_file(wanted.to_str().unwrap()).unwrap();
        assert!(state.inside_root(wanted.to_str().unwrap()).is_ok());
        assert!(state.inside_root(other.to_str().unwrap()).is_err());

        // the sidecar next to it reads too, and nothing else of that name
        let sidecar = dir.join("wanted.log.json");
        fs::write(&sidecar, "{}").unwrap();
        assert!(state.inside_root(sidecar.to_str().unwrap()).is_ok());
        let stray = dir.join("other.log.json");
        fs::write(&stray, "{}").unwrap();
        assert!(state.inside_root(stray.to_str().unwrap()).is_err());

        // a folder root still allows everything under it
        state.set_root(dir.to_str().unwrap()).unwrap();
        assert!(state.inside_root(other.to_str().unwrap()).is_ok());
        assert!(state.set_root(wanted.to_str().unwrap()).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn several_files_read_together_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("dmv-root-files-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let first = dir.join("first.log");
        let second = dir.join("second.log");
        let other = dir.join("other.log");
        for file in [&first, &second, &other] {
            fs::write(file, "a").unwrap();
        }
        let state = ExplorerState::default();
        let paths = [first.to_str().unwrap().to_owned(), second.to_str().unwrap().to_owned()];
        state.set_files(&paths).unwrap();
        assert!(state.inside_root(first.to_str().unwrap()).is_ok());
        assert!(state.inside_root(second.to_str().unwrap()).is_ok());
        assert!(state.inside_root(other.to_str().unwrap()).is_err());
        assert!(state.set_files(&[dir.to_str().unwrap().to_owned()]).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_spool_folder_is_readable_while_a_spool_is_open() {
        let dir = std::env::temp_dir().join(format!("dmv-root-spool-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let state = ExplorerState::default();
        state.set_root(dir.to_str().unwrap()).unwrap();
        let name = format!("root_test_{}.txt", std::process::id());
        let log = state.spool.lock().unwrap().create(&name).unwrap();
        // the spool is outside the opened folder but readable
        assert!(state.inside_root(log.to_str().unwrap()).is_ok());
        // opening the same folder again (a refresh) keeps it readable; another folder does not
        state.set_root(dir.to_str().unwrap()).unwrap();
        assert!(state.inside_root(log.to_str().unwrap()).is_ok());
        let other = std::env::temp_dir().join(format!("dmv-root-other-{}", std::process::id()));
        fs::create_dir_all(&other).unwrap();
        state.set_root(other.to_str().unwrap()).unwrap();
        assert!(state.inside_root(log.to_str().unwrap()).is_err());
        state.spool.lock().unwrap().finish(log.to_str().unwrap()).unwrap();
        fs::remove_file(&log).unwrap();
        fs::remove_file(format!("{}.json", log.display())).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&other).unwrap();
    }
}
