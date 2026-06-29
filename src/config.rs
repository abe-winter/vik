//! Config file discovery and loading.
//!
//! Looks at `.vikunja.yaml` / `vikunja.yaml` in the current dir then `$HOME`
//! (README). The token is never read from config — it comes from `--token` /
//! `VIKUNJA_TOKEN`. CLI flags override config values (handled in `main`).

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Deserialize)]
pub struct Config {
    pub username: Option<String>,
    pub server: Option<String>,
    pub project: Option<String>,
}

impl Config {
    /// Load config from an explicit path, or the first existing candidate path.
    /// Returns a default (empty) config when nothing is found.
    pub fn load(explicit: Option<&Path>) -> Result<Config> {
        if let Some(p) = explicit {
            return Self::read(p).with_context(|| format!("reading config {}", p.display()));
        }
        for p in Self::candidate_paths() {
            if p.exists() {
                return Self::read(&p).with_context(|| format!("reading config {}", p.display()));
            }
        }
        Ok(Config::default())
    }

    fn read(p: &Path) -> Result<Config> {
        let text = std::fs::read_to_string(p)?;
        let cfg = serde_yaml::from_str(&text)?;
        Ok(cfg)
    }

    fn candidate_paths() -> Vec<PathBuf> {
        let mut v = vec![PathBuf::from(".vikunja.yaml"), PathBuf::from("vikunja.yaml")];
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            v.push(home.join(".vikunja.yaml"));
            v.push(home.join("vikunja.yaml"));
        }
        v
    }
}
