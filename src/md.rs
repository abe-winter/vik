//! Markdown <-> HTML conversion via pandoc.
//!
//! Vikunja stores task descriptions and comments as HTML. Models tend to prefer
//! terse markdown, so `--md` lets callers write markdown (converted to HTML on
//! the way in) and read markdown (converted from HTML on the way out). We shell
//! out to `pandoc`; if it isn't installed the command fails with a clear error.

use std::io::Write;
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};
use serde_json::Value;

/// GitHub-flavored markdown is a good middle ground: terse for models, and a
/// close-enough match for the HTML Vikunja's editor produces.
const MARKDOWN: &str = "gfm";
const HTML: &str = "html";

/// Run pandoc converting `input` from format `from` to format `to`, piping via
/// stdin/stdout. Errors clearly when pandoc is missing or exits non-zero.
fn pandoc(from: &str, to: &str, input: &str) -> Result<String> {
    let mut child = Command::new("pandoc")
        .args(["-f", from, "-t", to])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("running pandoc for --md conversion (is pandoc installed? https://pandoc.org)")?;
    // Take and drop stdin after writing so pandoc sees EOF and produces output.
    child
        .stdin
        .take()
        .expect("stdin was piped")
        .write_all(input.as_bytes())
        .context("writing to pandoc stdin")?;
    let out = child.wait_with_output().context("waiting for pandoc")?;
    if !out.status.success() {
        bail!("pandoc failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let text = String::from_utf8(out.stdout).context("pandoc output was not utf-8")?;
    Ok(text.trim_end().to_string())
}

/// Convert markdown to HTML (for setters: description/comment on the way in).
pub fn md_to_html(md: &str) -> Result<String> {
    pandoc(MARKDOWN, HTML, md)
}

/// Convert HTML to markdown (for getters: description/comment on the way out).
pub fn html_to_md(html: &str) -> Result<String> {
    pandoc(HTML, MARKDOWN, html)
}

/// In an API response, convert a named HTML field to markdown in place. Handles
/// both a single object and an array of objects (e.g. a task list or comment
/// list). Empty/missing/non-string fields are left untouched.
pub fn field_to_md(v: &mut Value, field: &str) -> Result<()> {
    match v {
        Value::Array(arr) => {
            for item in arr {
                field_to_md(item, field)?;
            }
        }
        Value::Object(map) => {
            if let Some(Value::String(html)) = map.get(field) {
                if !html.is_empty() {
                    let md = html_to_md(html)?;
                    map.insert(field.to_string(), Value::String(md));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{field_to_md, html_to_md, md_to_html};
    use serde_json::json;

    #[test]
    fn md_html_roundtrip() {
        let html = md_to_html("some **bold** text").unwrap();
        assert_eq!(html, "<p>some <strong>bold</strong> text</p>");
        assert_eq!(html_to_md(&html).unwrap(), "some **bold** text");
    }

    #[test]
    fn field_to_md_handles_array_and_skips_empty() {
        let mut v = json!([
            {"id": 1, "description": "<p>hi <em>there</em></p>"},
            {"id": 2, "description": ""},
            {"id": 3},
        ]);
        field_to_md(&mut v, "description").unwrap();
        assert_eq!(v[0]["description"], json!("hi *there*"));
        // empty and missing fields are left untouched
        assert_eq!(v[1]["description"], json!(""));
        assert_eq!(v[2].get("description"), None);
    }
}
