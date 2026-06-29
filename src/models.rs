//! Request bodies we serialize to the API. Field names match the Vikunja models
//! (see docs/vikunja-api.md). Optional fields are skipped when `None` so a
//! partial update (`modify`) only sends the fields the user actually set.

use serde::Serialize;

#[derive(Debug, Default, Serialize)]
pub struct TaskWrite {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent_done: Option<f64>,
}

impl TaskWrite {
    /// Whether any field is set (i.e. there is something to send).
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.description.is_none()
            && self.done.is_none()
            && self.priority.is_none()
            && self.due_date.is_none()
            && self.percent_done.is_none()
    }
}

#[derive(Debug, Serialize)]
pub struct CommentWrite {
    pub comment: String,
}

#[derive(Debug, Serialize)]
pub struct AssigneeWrite {
    pub user_id: i64,
}
