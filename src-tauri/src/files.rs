// Folder listing and byte-range reads.
#![allow(non_camel_case_types)]

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

const SKIPPED_DIRECTORIES: [&str; 2] = ["node_modules", ".git"];
const DEPTH_MAXIMUM: usize = 12;
const ENTRIES_MAXIMUM: usize = 50_000;
// One read call never returns more than this.
const READ_MAXIMUM: u64 = 256 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct s_file_node {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub children: Vec<s_file_node>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct s_file_stat {
    pub size: u64,
    pub modified_ms: u64,
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64)
}

pub fn path_text(path: &Path) -> String {
    let text = path.to_string_lossy();
    // drop the verbatim prefix canonicalize adds on Windows
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn directory_read(path: &Path, depth: usize, budget: &mut usize) -> Vec<s_file_node> {
    let Ok(entries) = fs::read_dir(path) else {
        return Vec::new();
    };
    let mut nodes = Vec::new();
    for entry in entries.flatten() {
        if *budget == 0 {
            break;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = metadata.is_dir();
        if is_dir && SKIPPED_DIRECTORIES.contains(&name.as_str()) {
            continue;
        }
        *budget -= 1;
        let entry_path = entry.path();
        let children = if is_dir && depth < DEPTH_MAXIMUM {
            directory_read(&entry_path, depth + 1, budget)
        } else {
            Vec::new()
        };
        nodes.push(s_file_node {
            path: path_text(&entry_path),
            name,
            is_dir,
            size: if is_dir { 0 } else { metadata.len() },
            modified_ms: modified_ms(&metadata),
            children,
        });
    }
    // directories first, then by name
    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    nodes
}

// The node of one file, as the tree would list it.
pub fn file_node(path: &Path) -> Result<s_file_node, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(s_file_node {
        path: path_text(path),
        name: path
            .file_name()
            .map_or_else(String::new, |name| name.to_string_lossy().to_string()),
        is_dir: false,
        size: metadata.len(),
        modified_ms: modified_ms(&metadata),
        children: Vec::new(),
    })
}

pub fn tree_list(root: &Path) -> Vec<s_file_node> {
    let mut budget = ENTRIES_MAXIMUM;
    directory_read(root, 0, &mut budget)
}

pub fn file_stat(path: &Path) -> Result<s_file_stat, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(s_file_stat {
        size: metadata.len(),
        modified_ms: modified_ms(&metadata),
    })
}

pub fn file_read_range(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    if offset >= size {
        return Ok(Vec::new());
    }
    let length = length.min(size - offset).min(READ_MAXIMUM);
    file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(length)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}
