mod client;
mod config;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use client::VikunjaClient;
use config::Config;
use serde_json::Value;

/// vikunja cli client for agents. Output is raw JSON on stdout (pipe to `jq`).
#[derive(Parser)]
#[command(name = "vik", version, about)]
struct Cli {
    /// Vikunja server base URL, e.g. https://try.vikunja.io (overrides config `server`)
    #[arg(long, global = true)]
    server: Option<String>,

    /// API token (defaults to the VIKUNJA_TOKEN env var)
    #[arg(long, env = "VIKUNJA_TOKEN", global = true, hide_env_values = true)]
    token: Option<String>,

    /// Project id or name/identifier (overrides config `project`)
    #[arg(long, global = true)]
    project: Option<String>,

    /// Path to a config file (default: ./.vikunja.yaml, ./vikunja.yaml, ~/.vikunja.yaml)
    #[arg(long, global = true)]
    config: Option<std::path::PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List projects you have access to (helper to find a project id)
    Projects,
}

/// A constructed client plus the unresolved project string from flags/config.
struct Ctx {
    client: VikunjaClient,
    project: Option<String>,
}

impl Cli {
    /// Resolve server/token/project from flags (highest precedence) then config.
    fn ctx(&self) -> Result<Ctx> {
        let cfg = Config::load(self.config.as_deref())?;
        let server = self
            .server
            .clone()
            .or(cfg.server)
            .context("no server: pass --server or set `server:` in the config file")?;
        let token = self
            .token
            .clone()
            .context("no token: pass --token or set VIKUNJA_TOKEN")?;
        let project = self.project.clone().or(cfg.project);
        Ok(Ctx {
            client: VikunjaClient::new(&server, &token)?,
            project,
        })
    }
}

fn print_json(v: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match &cli.command {
        Command::Projects => {
            let ctx = cli.ctx()?;
            print_json(&ctx.client.get("/projects", &[])?)?;
        }
    }
    Ok(())
}
