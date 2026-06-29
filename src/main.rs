mod client;
mod commands;
mod config;
mod models;

use std::io::Read;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use client::VikunjaClient;
use config::Config;
use models::TaskWrite;
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
    /// List tasks in the current project
    List(ListArgs),
    /// Create a task in the current project
    Create(CreateArgs),
    /// Update a task's fields and/or assignee
    Modify(ModifyArgs),
    /// Add a comment to a task
    Comment(CommentArgs),
    /// List a task's attachments
    Attachments(AttachmentsArgs),
    /// Upload file attachment(s) to a task
    Attach(AttachArgs),
}

#[derive(Args)]
struct ListArgs {
    /// Filter by done status: --done true or --done false
    #[arg(long)]
    done: Option<bool>,
    /// Raw Vikunja filter expression, ANDed with the project filter
    #[arg(long)]
    filter: Option<String>,
    /// Sort field (e.g. id, title, done, due_date, priority, created, updated)
    #[arg(long)]
    sort_by: Option<String>,
    /// Sort direction: asc or desc
    #[arg(long)]
    order_by: Option<String>,
    /// Search task text
    #[arg(long, short = 's')]
    search: Option<String>,
    /// Maximum number of tasks to return
    #[arg(long, default_value_t = 50)]
    per_page: u32,
}

#[derive(Args)]
struct CreateArgs {
    /// Task title
    title: String,
    /// Description (use - to read from stdin)
    #[arg(long)]
    description: Option<String>,
    /// Priority, 0-5
    #[arg(long)]
    priority: Option<i64>,
    /// Due date, RFC3339 (e.g. 2026-07-01T17:00:00Z)
    #[arg(long)]
    due_date: Option<String>,
    /// Percent done, 0.0-1.0
    #[arg(long)]
    percent_done: Option<f64>,
}

#[derive(Args)]
struct ModifyArgs {
    /// Task id
    id: i64,
    /// New title
    #[arg(long)]
    title: Option<String>,
    /// New description (use - to read from stdin)
    #[arg(long)]
    description: Option<String>,
    /// Mark done/undone: --done true or --done false
    #[arg(long)]
    done: Option<bool>,
    /// Priority, 0-5
    #[arg(long)]
    priority: Option<i64>,
    /// Due date, RFC3339
    #[arg(long)]
    due_date: Option<String>,
    /// Percent done, 0.0-1.0
    #[arg(long)]
    percent_done: Option<f64>,
    /// Assign a user to the task: numeric id, or username (needs /users token scope)
    #[arg(long)]
    assignee: Option<String>,
}

#[derive(Args)]
struct CommentArgs {
    /// Task id
    id: i64,
    /// Comment text (use - to read from stdin)
    comment: String,
}

#[derive(Args)]
struct AttachmentsArgs {
    /// Task id
    id: i64,
}

#[derive(Args)]
struct AttachArgs {
    /// Task id
    id: i64,
    /// One or more files to upload
    #[arg(required = true)]
    files: Vec<std::path::PathBuf>,
    /// Also embed each uploaded image into the task description as markdown
    #[arg(long)]
    embed: bool,
}

/// A constructed client plus the unresolved project string from flags/config.
struct Ctx {
    client: VikunjaClient,
    project: Option<String>,
}

impl Ctx {
    /// Resolve the configured project (id or name) to a numeric id.
    fn project_id(&self) -> Result<i64> {
        let p = self
            .project
            .as_deref()
            .context("no project: pass --project or set `project:` in the config file")?;
        self.client.resolve_project(p)
    }
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

/// Resolve a text value, reading stdin when it is exactly "-".
fn read_dash(value: Option<String>) -> Result<Option<String>> {
    match value {
        Some(s) if s == "-" => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .context("reading from stdin")?;
            Ok(Some(buf))
        }
        other => Ok(other),
    }
}

fn print_json(v: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let out = match &cli.command {
        Command::Projects => cli.ctx()?.client.get("/projects", &[])?,

        Command::List(a) => {
            let ctx = cli.ctx()?;
            commands::list(
                &ctx.client,
                ctx.project_id()?,
                a.done,
                a.filter.as_deref(),
                a.sort_by.as_deref(),
                a.order_by.as_deref(),
                a.search.as_deref(),
                a.per_page,
            )?
        }

        Command::Create(a) => {
            let ctx = cli.ctx()?;
            let task = TaskWrite {
                title: Some(a.title.clone()),
                description: read_dash(a.description.clone())?,
                priority: a.priority,
                due_date: a.due_date.clone(),
                percent_done: a.percent_done,
                done: None,
            };
            commands::create(&ctx.client, ctx.project_id()?, &task)?
        }

        Command::Modify(a) => {
            let ctx = cli.ctx()?;
            let task = TaskWrite {
                title: a.title.clone(),
                description: read_dash(a.description.clone())?,
                done: a.done,
                priority: a.priority,
                due_date: a.due_date.clone(),
                percent_done: a.percent_done,
            };
            let assignee_id = match &a.assignee {
                Some(u) => Some(ctx.client.resolve_user(u).with_context(|| {
                    format!("resolving assignee '{u}' — pass a numeric user id if your token lacks /users access")
                })?),
                None => None,
            };
            commands::modify(&ctx.client, a.id, &task, assignee_id)?
        }

        Command::Comment(a) => {
            let ctx = cli.ctx()?;
            let text = read_dash(Some(a.comment.clone()))?.unwrap_or_default();
            commands::comment(&ctx.client, a.id, &text)?
        }

        Command::Attachments(a) => commands::attachments(&cli.ctx()?.client, a.id)?,

        Command::Attach(a) => {
            let ctx = cli.ctx()?;
            let uploaded = commands::attach(&ctx.client, a.id, &a.files)?;
            if a.embed {
                commands::embed_attachments(&ctx.client, a.id, &uploaded)?
            } else {
                uploaded
            }
        }
    };
    print_json(&out)
}
