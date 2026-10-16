// Folder watcher: raw notify events are batched for 150 ms, then emitted as one
// `datamine-explorer://changed` event with the touched paths and the strongest kind.
#![allow(non_camel_case_types)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::files::path_text;

const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Serialize, Clone)]
struct s_changed {
    paths: Vec<String>,
    kind: &'static str,
}

// Higher wins when a batch mixes kinds: the tree must refresh for anything above modify.
fn kind_rank(kind: &str) -> u8 {
    match kind {
        "remove" => 4,
        "rename" => 3,
        "create" => 2,
        "modify" => 1,
        _ => 0,
    }
}

fn kind_name(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Remove(_) => "remove",
        EventKind::Modify(ModifyKind::Name(
            RenameMode::Any | RenameMode::From | RenameMode::To | RenameMode::Both,
        )) => "rename",
        EventKind::Modify(_) => "modify",
        _ => "other",
    }
}

// With `only` set, just that file's events are reported (its folder is watched, not below it).
pub fn folder_watch(
    app: AppHandle,
    root: &Path,
    only: Option<PathBuf>,
) -> Result<RecommendedWatcher, String> {
    let (sender, receiver) = mpsc::channel::<Event>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if let Ok(event) = event {
            let _ = sender.send(event);
        }
    })
    .map_err(|error| error.to_string())?;
    let mode = if only.is_some() {
        RecursiveMode::NonRecursive
    } else {
        RecursiveMode::Recursive
    };
    watcher.watch(root, mode).map_err(|error| error.to_string())?;
    let only = only.map(|file| path_text(&file).to_lowercase());

    std::thread::spawn(move || {
        // ends when the watcher (and with it the sender) is dropped
        while let Ok(first) = receiver.recv() {
            let mut paths = BTreeSet::new();
            let mut kind = "other";
            let mut take = |event: Event| {
                let name = kind_name(&event.kind);
                if kind_rank(name) > kind_rank(kind) {
                    kind = name;
                }
                for path in event.paths {
                    let text = path_text(&path);
                    if only.as_ref().is_none_or(|file| &text.to_lowercase() == file) {
                        paths.insert(text);
                    }
                }
            };
            take(first);
            loop {
                match receiver.recv_timeout(DEBOUNCE) {
                    Ok(event) => take(event),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            // other files in the folder changed, nothing to report
            if paths.is_empty() {
                continue;
            }
            let payload = s_changed {
                paths: paths.into_iter().collect(),
                kind,
            };
            if app.emit("datamine-explorer://changed", payload).is_err() {
                return;
            }
        }
    });
    Ok(watcher)
}
