mod client;
mod commands;
mod config;
mod md;
mod models;

use std::io::Read;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
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

    /// Your user id or username, for --mine (overrides config `username`)
    #[arg(long, global = true)]
    username: Option<String>,

    /// Path to a config file (default: ./.vikunja.yaml, ./vikunja.yaml, ~/.vikunja.yaml)
    #[arg(long, global = true)]
    config: Option<std::path::PathBuf>,

    /// Log each API request (method, URL, body) and response status to stderr
    #[arg(long, global = true)]
    debug: bool,

    #[command(subcommand)]
    command: Command,
}

/// Tri-state task status. Vikunja has no native "in progress" field, so we map
/// the middle state onto `percent_done`: a not-done task with any progress > 0 is
/// "doing". (todo = not done & 0%, doing = not done & >0%, done = done.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum TaskState {
    Todo,
    Doing,
    Done,
}

/// The `percent_done` value used to mark a task as "doing" when no explicit
/// `--percent-done` is given. Halfway reads as "in progress" in the Vikunja UI.
const DOING_PERCENT: f64 = 0.5;

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
    /// List a task's comments
    Comments(CommentsArgs),
    /// List a task's attachments
    Attachments(AttachmentsArgs),
    /// Upload file attachment(s) to a task
    Attach(AttachArgs),
}

#[derive(Args)]
struct ListArgs {
    /// Filter by status: --done todo, doing, or done
    #[arg(long, value_enum)]
    done: Option<TaskState>,
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
    /// Only tasks assigned to me (the configured username/id)
    #[arg(long)]
    mine: bool,
    /// Reorder results in blocker order (client-side topological sort, id tie-break)
    #[arg(long)]
    topo_sort: bool,
    /// Trim each task to a few high-signal fields to save context
    #[arg(long)]
    compact: bool,
    /// Convert each task's HTML description to markdown in the output (needs pandoc)
    #[arg(long)]
    md: bool,
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
    /// Treat --description as markdown and convert it to HTML before sending
    /// (and convert the returned description back to markdown); needs pandoc
    #[arg(long)]
    md: bool,
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
    /// Set status: --done todo, doing, or done. "doing" sets percent_done (see
    /// --percent-done to override the value).
    #[arg(long, value_enum)]
    done: Option<TaskState>,
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
    #[arg(long, conflicts_with = "mine")]
    assignee: Option<String>,
    /// Assign the task to me (the configured username/id)
    #[arg(long)]
    mine: bool,
    /// Trim the returned task to a few high-signal fields to save context
    #[arg(long)]
    compact: bool,
    /// Treat --description as markdown and convert it to HTML before sending
    /// (and convert the returned description back to markdown); needs pandoc
    #[arg(long)]
    md: bool,
}

#[derive(Args)]
struct CommentArgs {
    /// Task id
    id: i64,
    /// Comment text (use - to read from stdin)
    comment: String,
    /// Treat the comment text as markdown and convert it to HTML before sending
    /// (needs pandoc)
    #[arg(long)]
    md: bool,
}

#[derive(Args)]
struct CommentsArgs {
    /// Task id
    id: i64,
    /// Convert each comment's HTML to markdown in the output (needs pandoc)
    #[arg(long)]
    md: bool,
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

/// A constructed client plus the unresolved project/username from flags/config.
struct Ctx {
    client: VikunjaClient,
    project: Option<String>,
    username: Option<String>,
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

    /// The configured username/id (for --mine). Required when --mine is used.
    fn me(&self) -> Result<&str> {
        self.username
            .as_deref()
            .context("no username: pass --username or set `username:` in config (needed for --mine)")
    }

    /// Resolve "me" to a numeric user id, for assigning via the assignees
    /// endpoint. A numeric value skips the /users lookup, same as --assignee.
    fn me_id(&self) -> Result<i64> {
        let u = self.me()?;
        self.client.resolve_user(u).with_context(|| {
            format!("resolving username '{u}' — set a numeric user id in config if your token lacks /users access")
        })
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
        let username = self.username.clone().or(cfg.username);
        Ok(Ctx {
            client: VikunjaClient::new(&server, &token, self.debug)?,
            project,
            username,
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
            let project_id = ctx.project_id()?;
            let mine = if a.mine { Some(ctx.me()?.to_string()) } else { None };
            let tasks = commands::list(
                &ctx.client,
                project_id,
                a.done,
                mine.as_deref(),
                a.filter.as_deref(),
                a.sort_by.as_deref(),
                a.order_by.as_deref(),
                a.search.as_deref(),
                a.per_page,
            )?;
            let tasks = if a.topo_sort {
                commands::topo_sort_blockers(&tasks)?
            } else {
                tasks
            };
            let mut tasks = if a.compact {
                commands::compact_tasks(&tasks)
            } else {
                tasks
            };
            if a.md {
                md::field_to_md(&mut tasks, "description")?;
            }
            tasks
        }

        Command::Create(a) => {
            let ctx = cli.ctx()?;
            let mut description = read_dash(a.description.clone())?;
            if a.md {
                description = description.map(|d| md::md_to_html(&d)).transpose()?;
            }
            let task = TaskWrite {
                title: Some(a.title.clone()),
                description,
                priority: a.priority,
                due_date: a.due_date.clone(),
                percent_done: a.percent_done,
                done: None,
            };
            let mut created = commands::create(&ctx.client, ctx.project_id()?, &task)?;
            if a.md {
                md::field_to_md(&mut created, "description")?;
            }
            created
        }

        Command::Modify(a) => {
            let ctx = cli.ctx()?;
            // Translate the tri-state status into the underlying done/percent_done
            // fields. An explicit --percent-done overrides the state's default.
            let (done, mut percent_done) = match a.done {
                Some(TaskState::Todo) => (Some(false), Some(0.0)),
                Some(TaskState::Doing) => (Some(false), Some(DOING_PERCENT)),
                Some(TaskState::Done) => (Some(true), None),
                None => (None, None),
            };
            if a.percent_done.is_some() {
                percent_done = a.percent_done;
            }
            let mut description = read_dash(a.description.clone())?;
            if a.md {
                description = description.map(|d| md::md_to_html(&d)).transpose()?;
            }
            let task = TaskWrite {
                title: a.title.clone(),
                description,
                done,
                priority: a.priority,
                due_date: a.due_date.clone(),
                percent_done,
            };
            let assignee_id = if a.mine {
                Some(ctx.me_id()?)
            } else {
                match &a.assignee {
                    Some(u) => Some(ctx.client.resolve_user(u).with_context(|| {
                        format!("resolving assignee '{u}' — pass a numeric user id if your token lacks /users access")
                    })?),
                    None => None,
                }
            };
            let updated = commands::modify(&ctx.client, a.id, &task, assignee_id)?;
            let mut updated = if a.compact {
                commands::compact_task(&updated)
            } else {
                updated
            };
            if a.md {
                md::field_to_md(&mut updated, "description")?;
            }
            updated
        }

        Command::Comment(a) => {
            let ctx = cli.ctx()?;
            let mut text = read_dash(Some(a.comment.clone()))?.unwrap_or_default();
            if a.md {
                text = md::md_to_html(&text)?;
            }
            commands::comment(&ctx.client, a.id, &text)?
        }

        Command::Comments(a) => {
            let mut comments = commands::comments(&cli.ctx()?.client, a.id)?;
            if a.md {
                md::field_to_md(&mut comments, "comment")?;
            }
            comments
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
