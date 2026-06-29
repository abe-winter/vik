//! Command implementations. Each returns the raw API JSON for `main` to print.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use crate::client::VikunjaClient;
use crate::models::{AssigneeWrite, CommentWrite, TaskWrite};
use crate::TaskState;

/// Apply field overrides to a task with read-merge-write semantics.
///
/// Vikunja's `POST /tasks/{id}` resets omitted value-type fields (done,
/// priority, percent_done, ...) to their zero value instead of preserving them,
/// so a true partial update must re-send the whole task. We fetch the current
/// task, overlay the provided fields, and post the merged object back.
fn merge_and_update(c: &VikunjaClient, id: i64, overrides: &Value) -> Result<Value> {
    let mut full = c.get(&format!("/tasks/{id}"), &[])?;
    let obj = full
        .as_object_mut()
        .ok_or_else(|| anyhow!("task {id} response is not a JSON object"))?;
    if let Some(map) = overrides.as_object() {
        for (k, v) in map {
            obj.insert(k.clone(), v.clone());
        }
    }
    c.post_json(&format!("/tasks/{id}"), &full)
}

/// List tasks in a project via `GET /tasks`, scoped with a `project_id` filter
/// clause (optionally ANDed with a `done` status and a raw user filter).
#[allow(clippy::too_many_arguments)]
pub fn list(
    c: &VikunjaClient,
    project_id: i64,
    done: Option<TaskState>,
    assignee: Option<&str>,
    filter: Option<&str>,
    sort_by: Option<&str>,
    order_by: Option<&str>,
    search: Option<&str>,
    per_page: u32,
) -> Result<Value> {
    let mut clauses = vec![format!("project_id = {project_id}")];
    // Map the tri-state status onto done/percent_done (see TaskState).
    match done {
        Some(TaskState::Todo) => clauses.push("done = false && percent_done = 0".into()),
        Some(TaskState::Doing) => clauses.push("done = false && percent_done > 0".into()),
        Some(TaskState::Done) => clauses.push("done = true".into()),
        None => {}
    }
    if let Some(u) = assignee {
        // The filter query matches assignees by username (the assignees *endpoint*
        // uses numeric ids, but the filter does not).
        clauses.push(format!("assignees in {u}"));
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
    let tasks = c.get("/tasks", &query)?;

    // The /tasks filter endpoint returns 200 with an empty array both for a
    // genuinely empty project and for one the token can't access — silently
    // hiding a permission problem. When the result is empty, probe the project
    // directly so we can surface a real error instead of a misleading [].
    if tasks.as_array().is_some_and(|a| a.is_empty()) && !c.project_accessible(project_id)? {
        bail!(
            "no access to project {project_id} (it may not exist, or your token lacks permission)"
        );
    }
    Ok(tasks)
}

/// Reorder a task array (the `list` response) into blocker order via a
/// client-side topological sort: a task that blocks another comes first, with
/// task id as the tie-breaker. Edges come from each task's `related_tasks`
/// (`blocking` → this-before-that, `blocked` → that-before-this); relations to
/// tasks outside the result set are ignored. Any blocking cycle is broken by
/// appending the remaining tasks in id order so nothing is dropped.
pub fn topo_sort_blockers(tasks: &Value) -> Result<Value> {
    let arr = tasks
        .as_array()
        .ok_or_else(|| anyhow!("expected a task array to sort, got: {tasks}"))?;

    // id -> task object, for tasks with an integer id (BTreeMap keeps id order).
    let mut by_id: BTreeMap<i64, Value> = BTreeMap::new();
    for t in arr {
        if let Some(id) = t.get("id").and_then(Value::as_i64) {
            by_id.insert(id, t.clone());
        }
    }
    let present: BTreeSet<i64> = by_id.keys().copied().collect();

    // Collect edges (a, b) meaning "a must come before b" from blocking relations
    // between tasks that are both in the result set.
    let related_ids = |t: &Value, kind: &str| -> Vec<i64> {
        t.get("related_tasks")
            .and_then(|r| r.get(kind))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.get("id").and_then(Value::as_i64)).collect())
            .unwrap_or_default()
    };
    let mut edges: BTreeSet<(i64, i64)> = BTreeSet::new();
    for (&id, t) in &by_id {
        for j in related_ids(t, "blocking") {
            if id != j && present.contains(&j) {
                edges.insert((id, j));
            }
        }
        for j in related_ids(t, "blocked") {
            if id != j && present.contains(&j) {
                edges.insert((j, id));
            }
        }
    }

    // Kahn's algorithm, always taking the smallest available id.
    let mut adj: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    let mut indeg: BTreeMap<i64, usize> = present.iter().map(|&id| (id, 0)).collect();
    for &(a, b) in &edges {
        adj.entry(a).or_default().push(b);
        *indeg.get_mut(&b).unwrap() += 1;
    }
    let mut ready: BTreeSet<i64> = indeg
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(&id, _)| id)
        .collect();
    let mut order: Vec<i64> = Vec::with_capacity(present.len());
    while let Some(&n) = ready.iter().next() {
        ready.remove(&n);
        order.push(n);
        if let Some(succs) = adj.get(&n) {
            for &m in succs {
                let d = indeg.get_mut(&m).unwrap();
                *d -= 1;
                if *d == 0 {
                    ready.insert(m);
                }
            }
        }
    }
    // Anything left was part of a cycle — append in id order so nothing is lost.
    let placed: BTreeSet<i64> = order.iter().copied().collect();
    order.extend(present.iter().filter(|id| !placed.contains(id)));

    let sorted: Vec<Value> = order.iter().filter_map(|id| by_id.get(id).cloned()).collect();
    Ok(Value::Array(sorted))
}

/// Project a task list down to a few high-signal fields to save agent context.
/// Keeps id, title, done, priority, description, assignee usernames, attachment
/// {id,name}, and related-task {id,title} per relation kind. Empty/zero/null
/// fields are dropped entirely (the raw response is mostly unset date columns).
pub fn compact_tasks(tasks: &Value) -> Value {
    match tasks.as_array() {
        Some(arr) => Value::Array(arr.iter().map(compact_task).collect()),
        None => tasks.clone(),
    }
}

fn compact_task(t: &Value) -> Value {
    let mut o = serde_json::Map::new();
    let mut put = |k: &str, v: Value| {
        o.insert(k.to_string(), v);
    };

    if let Some(v) = t.get("id") {
        put("id", v.clone());
    }
    if let Some(v) = t.get("title") {
        put("title", v.clone());
    }
    // done is central to task state, so always include it.
    if let Some(v) = t.get("done") {
        put("done", v.clone());
    }
    if let Some(p) = t.get("priority").and_then(Value::as_i64) {
        if p != 0 {
            put("priority", json!(p));
        }
    }
    if let Some(d) = t.get("description").and_then(Value::as_str) {
        if !d.is_empty() {
            put("description", json!(d));
        }
    }
    if let Some(arr) = t.get("assignees").and_then(Value::as_array) {
        let names: Vec<Value> = arr
            .iter()
            .filter_map(|a| a.get("username").cloned())
            .collect();
        if !names.is_empty() {
            put("assignees", Value::Array(names));
        }
    }
    if let Some(arr) = t.get("attachments").and_then(Value::as_array) {
        let items: Vec<Value> = arr
            .iter()
            .map(|a| json!({ "id": a.get("id"), "name": a.get("file").and_then(|f| f.get("name")) }))
            .collect();
        if !items.is_empty() {
            put("attachments", Value::Array(items));
        }
    }
    if let Some(map) = t.get("related_tasks").and_then(Value::as_object) {
        let mut rel = serde_json::Map::new();
        for (kind, related) in map {
            if let Some(arr) = related.as_array() {
                let items: Vec<Value> = arr
                    .iter()
                    .map(|rt| json!({ "id": rt.get("id"), "title": rt.get("title") }))
                    .collect();
                if !items.is_empty() {
                    rel.insert(kind.clone(), Value::Array(items));
                }
            }
        }
        if !rel.is_empty() {
            put("related_tasks", Value::Object(rel));
        }
    }
    Value::Object(o)
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
    // Serialize to a JSON object containing only the fields the user set
    // (TaskWrite skips None), then merge onto the current task.
    let overrides = serde_json::to_value(task)?;
    let changed_fields = !overrides.as_object().map(|m| m.is_empty()).unwrap_or(true);
    if !changed_fields && assignee_id.is_none() {
        bail!("nothing to modify: pass a field to change or --assignee");
    }
    if changed_fields {
        merge_and_update(c, id, &overrides)?;
    }
    if let Some(uid) = assignee_id {
        if let Err(e) = c.put_json(
            &format!("/tasks/{id}/assignees"),
            &AssigneeWrite { user_id: uid },
        ) {
            // Claiming a task you already hold is a no-op success, not a failure:
            // Vikunja error code 4021 ("already assigned"). Anything else is real.
            if !e.to_string().contains("4021") {
                return Err(e);
            }
        }
    }
    // Return the resulting task (not the terse assignee-PUT response, which was
    // just `{"Created": ..., "user_id": N}`) so the caller can see what changed.
    c.get(&format!("/tasks/{id}"), &[])
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

/// List a task's comments via `GET /tasks/{id}/comments` (for reading a task's
/// pseudo-chat thread).
pub fn comments(c: &VikunjaClient, task_id: i64) -> Result<Value> {
    c.get(&format!("/tasks/{task_id}/comments"), &[])
}

/// List a task's attachments via `GET /tasks/{id}/attachments`.
pub fn attachments(c: &VikunjaClient, task_id: i64) -> Result<Value> {
    c.get(&format!("/tasks/{task_id}/attachments"), &[])
}

/// Upload files to a task via `PUT /tasks/{id}/attachments`.
pub fn attach(c: &VikunjaClient, task_id: i64, files: &[PathBuf]) -> Result<Value> {
    c.put_multipart_files(&format!("/tasks/{task_id}/attachments"), files)
}

/// Append markdown image embeds for freshly-uploaded attachments to the task's
/// description. Vikunja embeds attachments as
/// `![name](/api/v1/tasks/{taskID}/attachments/{attachmentID})`. Returns the
/// updated task.
pub fn embed_attachments(c: &VikunjaClient, task_id: i64, uploaded: &Value) -> Result<Value> {
    // The upload response wraps the created attachments in a `success` array.
    let items = uploaded
        .get("success")
        .and_then(Value::as_array)
        .or_else(|| uploaded.get("attachments").and_then(Value::as_array))
        .or_else(|| uploaded.as_array())
        .ok_or_else(|| anyhow!("could not find created attachments in upload response: {uploaded}"))?;

    let mut embeds = Vec::new();
    for a in items {
        let aid = a
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow!("attachment missing id: {a}"))?;
        let name = a
            .get("file")
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("attachment");
        embeds.push(format!(
            "![{name}](/api/v1/tasks/{task_id}/attachments/{aid})"
        ));
    }

    let task = c.get(&format!("/tasks/{task_id}"), &[])?;
    let mut description = task
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !description.is_empty() {
        description.push_str("\n\n");
    }
    description.push_str(&embeds.join("\n"));

    // Merge so we don't reset the task's done/priority/etc. (see merge_and_update).
    merge_and_update(c, task_id, &json!({ "description": description }))
}

#[cfg(test)]
mod tests {
    use super::{compact_task, topo_sort_blockers};
    use serde_json::{json, Value};

    #[test]
    fn compact_drops_empty_and_keeps_signal() {
        // The sample task from the feature request: only set fields survive.
        let task = json!({
            "assignees": [{"id": 1, "name": "", "username": "awinter"}],
            "attachments": null,
            "bucket_id": 0,
            "created_by": {"id": 1, "username": "awinter"},
            "description": "<p>(user does this manually)</p>",
            "done": false,
            "done_at": "0001-01-01T00:00:00Z",
            "due_date": "0001-01-01T00:00:00Z",
            "id": 4,
            "identifier": "#4",
            "labels": null,
            "priority": 0,
            "project_id": 4,
            "related_tasks": {},
            "title": "decide on sim approach and describe initial test layout",
        });
        let got = compact_task(&task);
        assert_eq!(
            got,
            json!({
                "id": 4,
                "title": "decide on sim approach and describe initial test layout",
                "done": false,
                "description": "<p>(user does this manually)</p>",
                "assignees": ["awinter"],
            })
        );
    }

    #[test]
    fn compact_keeps_priority_attachments_and_relations() {
        let task = json!({
            "id": 7,
            "title": "build",
            "done": true,
            "priority": 4,
            "attachments": [{"id": 9, "file": {"name": "diagram.png", "size": 70}}],
            "related_tasks": {
                "blocking": [{"id": 8, "title": "ship", "description": "ignored"}],
            },
        });
        let got = compact_task(&task);
        assert_eq!(
            got,
            json!({
                "id": 7,
                "title": "build",
                "done": true,
                "priority": 4,
                "attachments": [{"id": 9, "name": "diagram.png"}],
                "related_tasks": {"blocking": [{"id": 8, "title": "ship"}]},
            })
        );
    }

    fn ids(v: &Value) -> Vec<i64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].as_i64().unwrap())
            .collect()
    }

    #[test]
    fn no_relations_sorts_by_id() {
        let tasks = json!([{"id":3}, {"id":1}, {"id":2}]);
        assert_eq!(ids(&topo_sort_blockers(&tasks).unwrap()), vec![1, 2, 3]);
    }

    #[test]
    fn blocking_comes_before_blocked() {
        // 2 blocks 1: blocker 2 must come first even though 1 < 2.
        let tasks = json!([
            {"id":1},
            {"id":2, "related_tasks": {"blocking": [{"id":1}]}},
        ]);
        assert_eq!(ids(&topo_sort_blockers(&tasks).unwrap()), vec![2, 1]);
    }

    #[test]
    fn blocked_direction_is_equivalent() {
        // 1 is blocked by 2 -> 2 before 1.
        let tasks = json!([
            {"id":1, "related_tasks": {"blocked": [{"id":2}]}},
            {"id":2},
        ]);
        assert_eq!(ids(&topo_sort_blockers(&tasks).unwrap()), vec![2, 1]);
    }

    #[test]
    fn chain_with_id_tiebreak() {
        // 10 blocks 5, 5 blocks 1, plus standalone 2. Ties broken by id.
        let tasks = json!([
            {"id":1},
            {"id":5, "related_tasks": {"blocking": [{"id":1}]}},
            {"id":10, "related_tasks": {"blocking": [{"id":5}]}},
            {"id":2},
        ]);
        assert_eq!(ids(&topo_sort_blockers(&tasks).unwrap()), vec![2, 10, 5, 1]);
    }

    #[test]
    fn relations_outside_set_are_ignored() {
        // 2 blocks 99 (absent) -> no constraint, fall back to id order.
        let tasks = json!([
            {"id":2, "related_tasks": {"blocking": [{"id":99}]}},
            {"id":1},
        ]);
        assert_eq!(ids(&topo_sort_blockers(&tasks).unwrap()), vec![1, 2]);
    }

    #[test]
    fn cycle_keeps_all_tasks() {
        // 1<->2 blocking cycle: broken by id order, nothing dropped.
        let tasks = json!([
            {"id":1, "related_tasks": {"blocking": [{"id":2}]}},
            {"id":2, "related_tasks": {"blocking": [{"id":1}]}},
        ]);
        assert_eq!(ids(&topo_sort_blockers(&tasks).unwrap()), vec![1, 2]);
    }
}
