# vik — design / approach (vik-eev.1)

A small Rust CLI that wraps the Vikunja REST API for agent use. See
`docs/vikunja-api.md` for the endpoint mapping.

## CLI framework: `clap` v4 (derive)

- De-facto standard; derive macros give us subcommands + help for free.
- Built-in env-var fallback satisfies the "viper-like override" requirement:
  `#[arg(long, env = "VIKUNJA_TOKEN")]` reads the flag, then the env var.
- Global options: `--server`, `--project`, `--config`, `--token`.

## OpenAPI consumption: hand-written client (no generator)

Decision: **do not** run a code generator. Reasons:
- The spec is **Swagger 2.0** (`openapi: null`, `swagger: "2.0"`). `progenitor` (the
  main Rust generator) wants OpenAPI 3.x, so we'd need a 2.0→3.0 conversion step.
- 126 endpoints / 424 KB of spec; we need ~10. Generators pull the whole model graph
  and emit a large, awkward surface. vik-eev.2 explicitly says "only implement the
  methods we need".
- Hand-writing ~10 typed methods + a few serde structs is smaller, clearer, and easy to
  keep aligned with the README features. The raw spec stays in `docs/` as reference.

## HTTP: `reqwest` (blocking) + `json`, `multipart`, `rustls-tls`

- Blocking client → no async runtime needed for a simple CLI.
- `multipart` for attachment upload (vik-eev.4); `json` for everything else.
- `rustls-tls` (not native-tls) to avoid a system OpenSSL dependency — friendlier in
  the nono sandbox / for static-ish builds.

## Serialization: `serde` + `serde_json`

- Models derive `Serialize`/`Deserialize`.
- Partial updates (modify) use `Option<T>` with `#[serde(skip_serializing_if = "Option::is_none")]`
  so we only send changed fields.

## Config: `serde_yaml`

`Config { username, server, project }` (token is NOT stored in config).

Discovery order (first match wins), per README "vikunja.yaml and .vikunja.yaml paths":
1. `--config <path>` if given
2. `./.vikunja.yaml`, `./vikunja.yaml`
3. `$HOME/.vikunja.yaml`, `$HOME/vikunja.yaml`

**Precedence for each setting: CLI flag > env var > config file.**
`project` may be an id or a name/identifier; resolved to an id via `GET /projects`.

## Errors & output

- `anyhow` for ergonomic `?` + context; non-zero exit with message on stderr.
- **Output is raw JSON on stdout** (README: pipe to `jq`). Commands print the API
  response body verbatim (pretty-printed). No human-formatting layer in v0.
- `--description -` reads the description from stdin (README requirement).

## Markdown conversion (`--md`)

Vikunja stores task descriptions and comments as HTML, but models prefer terse
markdown. `--md` shells out to `pandoc` (gfm ↔ html): on setters (`create`,
`modify`, `comment`) it converts the given markdown to HTML before sending; on
getters (`list`, `comments`, and the task returned by `create`/`modify`) it
converts the HTML fields back to markdown. Lives in `md.rs`. If pandoc is missing
the command fails with a clear error (acceptable — it's an opt-in flag).

## Module layout

```
src/
  main.rs      clap definitions, arg precedence, dispatch to commands
  config.rs    Config struct, file discovery/load, Settings (resolved server/token/project)
  client.rs    VikunjaClient: reqwest wrapper, base url + bearer auth, request helpers
  models.rs    serde structs: Task, Project, TaskComment, TaskAttachment, ...
  commands.rs  one fn per verb: list, create, modify, comment (attachments in vik-eev.4)
  md.rs        markdown <-> html conversion via pandoc, for the --md flag
```

## Crates (initial)

```toml
clap        = { version = "4", features = ["derive", "env"] }
reqwest     = { version = "0.12", default-features = false, features = ["blocking", "json", "multipart", "rustls-tls"] }
serde       = { version = "1", features = ["derive"] }
serde_json  = "1"
serde_yaml  = "0.9"   # archived but stable; revisit if it causes friction
anyhow      = "1"
```
