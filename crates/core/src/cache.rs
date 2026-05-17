use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use shared::Notebook;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Cache {
    pub version: i64,
    pub notebook: Notebook,
}

pub fn path() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("dev", "vtdl", "vtdl")
        .ok_or_else(|| anyhow!("cannot resolve data dir"))?;
    Ok(dirs.data_dir().join("state.json"))
}

pub fn load() -> Result<Cache> {
    let p = path()?;
    if !p.exists() {
        return Ok(Cache::default());
    }
    let s = fs::read_to_string(&p).with_context(|| format!("read {}", p.display()))?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

pub fn save(cache: &Cache) -> Result<()> {
    let p = path()?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(cache)?)?;
    fs::rename(&tmp, &p)?;
    Ok(())
}

pub fn delete() -> Result<()> {
    let p = path()?;
    if p.exists() {
        fs::remove_file(&p)?;
    }
    Ok(())
}
