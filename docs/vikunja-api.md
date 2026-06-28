# Vikunja API notes (for `vik`)

Source: OpenAPI/Swagger 2.0 spec fetched from `https://try.vikunja.io/api/v1/docs.json`
(saved alongside this file as `vikunja-swagger.json`, API version `v2.3.0-816-g8d0814e4`).

- **Swagger 2.0**, `basePath: /api/v1`. The full base URL is `{server}/api/v1`.
- All responses are JSON. Lists return a bare JSON array; pagination metadata is in
  response headers (`x-pagination-total-pages`, `x-pagination-result-count`).

## Auth

`securityDefinitions.JWTKeyAuth` = an apiKey passed in the `Authorization` header.
For an API token (the `VIKUNJA_TOKEN` use-case) send:

```
Authorization: Bearer <token>
```

The same header works for JWTs from password login; we only need the API-token path.
Vikunja API tokens are created in the web UI (Settings → API Tokens) and look like
`tk_...`. Each token is scoped to a set of permissions, so list/create/comment/attach
must all be enabled on the token.

## Features → endpoints

README feature mapping. `{server}/api/v1` prefix omitted below.

### Resolve the configured project (name/identifier → id)

`project` in config may be a numeric id or a name/identifier. To resolve a non-numeric
value, list projects and match on `title` or `identifier`:

- `GET /projects` → `[]models.Project` (`id`, `title`, `identifier`, `description`,
  `is_archived`). Query: `s` (search), `is_archived`, `page`, `per_page`.

### List tasks in current project

Two options return `[]models.Task`:

1. `GET /tasks` — "all tasks on any project the user has access to". Supports
   `filter`, `sort_by`, `order_by`, `s`, `page`, `per_page`. **Not project-scoped on its
   own** — must add `filter=project_id = <id>`.
2. `GET /projects/{id}/views/{view}/tasks` — tasks within a project view. Same query
   params. Requires a **view id** (current Vikunja attaches tasks to views, not the
   project directly).

**Decision: use `/tasks` with `filter=project_id = <id>`.** It avoids the extra
round-trip to discover a view id and keeps "list" a single call. View ids can be
discovered via `GET /projects/{project}/views` if we ever need view-specific ordering.

Filtering by status (README "filter by status"): Vikunja has no separate status enum —
"done" is a boolean. Map a `--status done|undone` flag to a filter clause:

- `--status done`   → `filter=done = true`
- `--status undone` → `filter=done = false`

Combine with the project clause: `filter=project_id = 5 && done = false`.
Filter syntax docs: https://vikunja.io/docs/filters (fields, `&&`/`||`, comparisons).

Sort (README "maybe take a sort key"): `sort_by=<field>&order_by=asc|desc`. Sortable
fields include `id, title, done, due_date, priority, percent_done, created, updated`,
etc. `sort_by` can be repeated for multi-key sorts.

### Create a task in current project

`PUT /projects/{id}/tasks` with body `models.Task`. Minimum useful body: `{ "title": ... }`.
Other writable fields: `description`, `done`, `priority` (0–5), `due_date` (RFC3339),
`percent_done` (0–1), `start_date`, `end_date`, `hex_color`, `bucket_id`. Returns the
created `models.Task` (with `id`, `identifier`, `index`).

### Modify a task (state, etc.)

`POST /tasks/{id}` with body `models.Task` (partial update — send only fields to change).
Use for `done`, `title`, `description`, `priority`, `percent_done`, `due_date`, …
`GET /tasks/{id}` fetches one task (query `expand=subtasks|comments|reactions|buckets`).

### Change owner / assignee

"Change owner" in README ≈ assignees. A task has `assignees: []user.User`.

- `PUT /tasks/{taskID}/assignees` body `models.TaskAssginee` = `{ "user_id": <int> }`
  (note: the spec misspells it "Assginee"). Adds one assignee.
- `DELETE /tasks/{taskID}/assignees/{userID}` removes one.
- `POST /tasks/{taskID}/assignees/bulk` to set the full assignee list at once.

`user_id` is numeric. To resolve a username → id use `GET /users?s=<username>` (search
users). The created-by/owner field `created_by` is set by the server and not directly
reassignable, so "change owner" is implemented as managing assignees.

### Comment on a task

- `GET  /tasks/{taskID}/comments` → `[]models.TaskComment` (query `order_by`).
- `PUT  /tasks/{taskID}/comments` body `models.TaskComment` = `{ "comment": "<text/html>" }`.
  Returns the created comment (`id`, `comment`, `author`, `created`).
- `POST /tasks/{taskID}/comments/{commentID}` to edit, `DELETE` to remove.

Comment body is rendered as HTML/markdown by Vikunja.

### File attachments / embeds (later — vik-eev.4)

- `GET  /tasks/{id}/attachments` → `[]models.TaskAttachment`
  (`id`, `task_id`, `file` = `files.File`, `created_by`).
- `PUT  /tasks/{id}/attachments` — **multipart/form-data**, form field `files`
  (repeatable for multiple files). Returns the created attachment(s).
- `GET  /tasks/{id}/attachments/{attachmentID}` downloads the raw file bytes.
- `DELETE /tasks/{id}/attachments/{attachmentID}` removes it.

**Embeds:** to embed an image/PDF in a task description or comment, first upload it as an
attachment, then reference it in the markdown/HTML. Vikunja's editor links attachments
via the attachment download URL
(`{server}/api/v1/tasks/{id}/attachments/{attachmentID}`) — e.g.
`![alt]({server}/api/v1/tasks/{id}/attachments/{attachmentID})`. Exact embed markup to be
confirmed against the running server during vik-eev.4.

## Key model shapes (fields we use)

```
models.Task         id, identifier, index, project_id, title, description, done, done_at,
                    priority, percent_done, due_date, start_date, end_date, hex_color,
                    bucket_id, assignees[], labels[], attachments[], created, updated
models.Project      id, title, identifier, description, is_archived
models.TaskComment  id, comment, author(user.User), created, updated
models.TaskAssginee user_id, created            (sic — misspelled in API)
models.TaskAttachment  id, task_id, file(files.File), created_by(user.User), created
models.ProjectView  id, title, project_id, view_kind
```

## Endpoints summary table

| verb (vik) | HTTP | path | body / key params |
|---|---|---|---|
| list   | GET    | `/tasks` | `filter`, `sort_by`, `order_by`, `s`, `page`, `per_page` |
| create | PUT    | `/projects/{id}/tasks` | `models.Task` (`title` required) |
| modify | POST   | `/tasks/{id}` | partial `models.Task` |
| show   | GET    | `/tasks/{id}` | `expand` |
| assign | PUT    | `/tasks/{taskID}/assignees` | `{user_id}` |
| comment list | GET | `/tasks/{taskID}/comments` | `order_by` |
| comment add  | PUT | `/tasks/{taskID}/comments` | `{comment}` |
| attach list  | GET | `/tasks/{id}/attachments` | — |
| attach add   | PUT | `/tasks/{id}/attachments` | multipart `files` |
| projects | GET | `/projects` | `s`, `is_archived` |
| users    | GET | `/users` | `s` |
```
