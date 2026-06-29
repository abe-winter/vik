//! Command implementations. Each returns the raw API JSON for `main` to print.

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::client::VikunjaClient;
use crate::models::{AssigneeWrite, CommentWrite, TaskWrite};

/// List tasks in a project via `GET /tasks`, scoped with a `project_id` filter
/// clause (optionally ANDed with a `done` status and a raw user filter).
#[allow(clippy::too_many_arguments)]
pub fn list(
    c: &VikunjaClient,
    project_id: i64,
    done: Option<bool>,
    filter: Option<&str>,
    sort_by: Option<&str>,
    order_by: Option<&str>,
    search: Option<&str>,
    per_page: u32,
) -> Result<Value> {
    let mut clauses = vec![format!("project_id = {project_id}")];
    if let Some(d) = done {
        clauses.push(format!("done = {d}"));
    }
    if let Some(f) = filter {
        clauses.push(format!("({f})"));
    }

    let mut query: Vec<(&str, String)> = vec![
        ("filter", clauses.join(" && ")),
        ("per_page", per_page.to_string()),
    ];
    if let Some(s) = search {
        query.push(("s", s.to_string()));
    }
    if let Some(s) = sort_by {
        query.push(("sort_by", s.to_string()));
    }
    if let Some(o) = order_by {
        query.push(("order_by", o.to_string()));
    }
    c.get("/tasks", &query)
}

/// Create a task in a project via `PUT /projects/{id}/tasks`.
pub fn create(c: &VikunjaClient, project_id: i64, task: &TaskWrite) -> Result<Value> {
    c.put_json(&format!("/projects/{project_id}/tasks"), task)
}

/// Update a task via `POST /tasks/{id}` and/or add an assignee via
/// `PUT /tasks/{id}/assignees`. Returns the task response when fields changed,
/// otherwise the assignee response.
pub fn modify(
    c: &VikunjaClient,
    id: i64,
    task: &TaskWrite,
    assignee_id: Option<i64>,
) -> Result<Value> {
    let mut result: Option<Value> = None;
    if !task.is_empty() {
        result = Some(c.post_json(&format!("/tasks/{id}"), task)?);
    }
    if let Some(uid) = assignee_id {
        let r = c.put_json(
            &format!("/tasks/{id}/assignees"),
            &AssigneeWrite { user_id: uid },
        )?;
        result = result.or(Some(r));
    }
    result.ok_or_else(|| anyhow!("nothing to modify: pass a field to change or --assignee"))
}

/// Add a comment to a task via `PUT /tasks/{id}/comments`.
pub fn comment(c: &VikunjaClient, id: i64, text: &str) -> Result<Value> {
    c.put_json(
        &format!("/tasks/{id}/comments"),
        &CommentWrite {
            comment: text.to_string(),
        },
    )
}
