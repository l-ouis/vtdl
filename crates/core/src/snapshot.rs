use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use shared::Notebook;

/// Lightweight, listable description of a saved snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotMeta {
    pub id: String,
    pub label: String,
    /// ISO-8601 timestamp the snapshot was taken.
    pub created_at: String,
    /// The notebook's `today_date` at capture time (for display).
    pub today_date: String,
    /// True if the app took this automatically before a destructive action.
    pub auto: bool,
}

/// A full snapshot: metadata plus the captured notebook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub meta: SnapshotMeta,
    pub version: i64,
    pub notebook: Notebook,
}

pub fn dir() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("dev", "vtdl", "vtdl")
        .ok_or_else(|| anyhow!("cannot resolve data dir"))?;
    Ok(dirs.data_dir().join("snapshots"))
}

fn file_path(id: &str) -> Result<PathBuf> {
    // IDs are app-generated, but never trust them for path building.
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(anyhow!("invalid snapshot id"));
    }
    Ok(dir()?.join(format!("{id}.json")))
}

pub fn save(snap: &Snapshot) -> Result<()> {
    let d = dir()?;
    fs::create_dir_all(&d)?;
    let p = file_path(&snap.meta.id)?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(snap)?)?;
    fs::rename(&tmp, &p)?;
    Ok(())
}

/// List snapshot metadata, newest first. Unreadable files are skipped.
pub fn list() -> Result<Vec<SnapshotMeta>> {
    let d = dir()?;
    if !d.exists() {
        return Ok(Vec::new());
    }
    let mut metas = Vec::new();
    for entry in fs::read_dir(&d)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(s) = fs::read_to_string(&path) {
            if let Ok(snap) = serde_json::from_str::<Snapshot>(&s) {
                metas.push(snap.meta);
            }
        }
    }
    // created_at is ISO-8601, so a lexical sort is chronological.
    metas.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(metas)
}

pub fn load(id: &str) -> Result<Snapshot> {
    let p = file_path(id)?;
    let s = fs::read_to_string(&p).with_context(|| format!("read {}", p.display()))?;
    serde_json::from_str(&s).context("parse snapshot")
}

pub fn delete(id: &str) -> Result<()> {
    let p = file_path(id)?;
    if p.exists() {
        fs::remove_file(&p)?;
    }
    Ok(())
}
