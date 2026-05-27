use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server_url: String,
    pub account_id: String,
    pub api_token: String,
    pub kdf_salt_b64: String,
}

impl Config {
    pub fn path() -> Result<PathBuf> {
        let dirs = ProjectDirs::from("dev", "rune", "rune")
            .ok_or_else(|| anyhow!("cannot resolve config dir"))?;
        Ok(dirs.config_dir().join("config.toml"))
    }

    pub fn exists() -> Result<bool> {
        Ok(Self::path()?.exists())
    }

    pub fn load() -> Result<Self> {
        let path = Self::path()?;
        let s = fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?;
        toml::from_str(&s).context("parse config.toml")
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let s = toml::to_string_pretty(self)?;
        fs::write(&path, s).with_context(|| format!("write {}", path.display()))?;
        Ok(())
    }

    pub fn delete() -> Result<()> {
        let path = Self::path()?;
        if path.exists() {
            fs::remove_file(&path)?;
        }
        Ok(())
    }
}
