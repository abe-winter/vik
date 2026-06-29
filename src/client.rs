//! Minimal hand-written Vikunja API client (see docs/vikunja-api.md).
//!
//! Methods return `serde_json::Value` so callers can print the raw API response
//! (the README wants raw JSON on stdout for piping to `jq`). Typed request
//! bodies live in `models`. A couple of resolution helpers parse just enough of
//! a response to turn a project/user name into an id.

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use reqwest::blocking::multipart::{Form, Part};
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::Serialize;
use serde_json::Value;

pub struct VikunjaClient {
    base: String, // {server}/api/v1
    token: String,
    http: Client,
    debug: bool,
}

impl VikunjaClient {
    pub fn new(server: &str, token: &str, debug: bool) -> Result<Self> {
        // Default to https when the configured server omits a scheme, otherwise
        // reqwest rejects the relative URL.
        let server = if server.contains("://") {
            server.to_string()
        } else {
            format!("https://{server}")
        };
        let base = format!("{}/api/v1", server.trim_end_matches('/'));
        let http = Client::builder().build().context("building http client")?;
        Ok(Self {
            base,
            token: token.to_string(),
            http,
            debug,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn send(&self, rb: RequestBuilder) -> Result<Value> {
        let req = rb
            .bearer_auth(&self.token)
            .build()
            .context("building request")?;
        if self.debug {
            // Token is sent in the Authorization header, which we deliberately
            // do not log.
            eprintln!("[vik] {} {}", req.method(), req.url());
            if let Some(body) = req.body().and_then(|b| b.as_bytes()) {
                eprintln!("[vik] body: {}", String::from_utf8_lossy(body));
            }
        }
        let resp = self
            .http
            .execute(req)
            .context("sending request to vikunja")?;
        if self.debug {
            eprintln!("[vik] -> {}", resp.status());
        }
        Self::handle(resp)
    }

    fn handle(resp: Response) -> Result<Value> {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        if !status.is_success() {
            bail!("vikunja API returned {}: {}", status, text.trim());
        }
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).with_context(|| format!("parsing API response: {text}"))
    }

    // --- raw verb helpers ---

    pub fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        self.send(self.http.get(self.url(path)).query(query))
    }

    pub fn put_json<T: Serialize>(&self, path: &str, body: &T) -> Result<Value> {
        self.send(self.http.put(self.url(path)).json(body))
    }

    pub fn post_json<T: Serialize>(&self, path: &str, body: &T) -> Result<Value> {
        self.send(self.http.post(self.url(path)).json(body))
    }

    /// Upload one or more files as multipart form-data under the `files` field.
    pub fn put_multipart_files(&self, path: &str, files: &[PathBuf]) -> Result<Value> {
        let mut form = Form::new();
        for f in files {
            let part = Part::file(f).with_context(|| format!("reading {}", f.display()))?;
            form = form.part("files", part);
        }
        self.send(self.http.put(self.url(path)).multipart(form))
    }

    // --- name -> id resolution ---

    /// Resolve a project given an id ("5") or a name/identifier. Numeric input is
    /// returned as-is; otherwise we search `/projects` and match title/identifier.
    pub fn resolve_project(&self, project: &str) -> Result<i64> {
        if let Ok(id) = project.parse::<i64>() {
            return Ok(id);
        }
        let list = self.get("/projects", &[("s", project.to_string())])?;
        let arr = list
            .as_array()
            .ok_or_else(|| anyhow!("unexpected /projects response: {list}"))?;
        for p in arr {
            let title = p.get("title").and_then(Value::as_str);
            let ident = p.get("identifier").and_then(Value::as_str);
            if title == Some(project) || ident == Some(project) {
                if let Some(id) = p.get("id").and_then(Value::as_i64) {
                    return Ok(id);
                }
            }
        }
        bail!("no project matching '{project}' (searched by title and identifier)")
    }

    /// Resolve a user id from a numeric id or an exact username via `/users`.
    pub fn resolve_user(&self, username: &str) -> Result<i64> {
        if let Ok(id) = username.parse::<i64>() {
            return Ok(id);
        }
        let list = self.get("/users", &[("s", username.to_string())])?;
        let arr = list
            .as_array()
            .ok_or_else(|| anyhow!("unexpected /users response: {list}"))?;
        for u in arr {
            if u.get("username").and_then(Value::as_str) == Some(username) {
                if let Some(id) = u.get("id").and_then(Value::as_i64) {
                    return Ok(id);
                }
            }
        }
        bail!("no user matching '{username}'")
    }
}
