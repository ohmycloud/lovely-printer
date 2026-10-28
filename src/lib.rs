pub mod api;
pub mod inspiration;
pub mod random_content;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{str::FromStr, sync::Arc, time::Duration};
use tokio::sync::broadcast;
use uuid::Uuid;

pub const MAX_TEXT_CHARS: usize = 4000;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Validation(String),
    #[error("Note not found")]
    NotFound,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Note {
    pub seq: i64,
    pub id: String,
    pub text: String,
    pub source: String,
    pub created_at: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub rotation: f64,
    pub z_index: i64,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrintRequest {
    pub text: String,
    #[serde(default = "default_source")]
    pub source: String,
}
fn default_source() -> String {
    "http".into()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct NotePatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub z_index: Option<i64>,
    pub archived: Option<bool>,
}

#[derive(Debug, Clone)]
pub enum PrinterEvent {
    Printed(Note),
    Updated(Note),
}

#[derive(Clone)]
pub struct Printer {
    pub pool: SqlitePool,
    events: broadcast::Sender<PrinterEvent>,
    pub inspiration: Arc<dyn inspiration::InspirationProvider>,
    pub random_content: Arc<random_content::RandomContentService>,
}

impl Printer {
    pub async fn open(url: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let options = SqliteConnectOptions::from_str(url)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        Ok(Self::new(pool))
    }

    pub fn new(pool: SqlitePool) -> Self {
        let (events, _) = broadcast::channel(256);
        let inspiration = inspiration::configured_provider();
        let random_content = Arc::new(random_content::RandomContentService::configured(
            inspiration.clone(),
        ));
        Self {
            pool,
            events,
            inspiration,
            random_content,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PrinterEvent> {
        self.events.subscribe()
    }

    /// The single print command used by HTTP and library consumers.
    /// Commit before broadcasting: a visible slip is always a persisted slip.
    pub async fn print(&self, request: PrintRequest) -> Result<Note, Error> {
        let text = request.text.replace("\r\n", "\n").replace('\r', "\n");
        if text.trim().is_empty() {
            return Err(Error::Validation("请输入要打印的文字".into()));
        }
        if text.chars().count() > MAX_TEXT_CHARS {
            return Err(Error::Validation(format!(
                "文字不能超过 {MAX_TEXT_CHARS} 个字符"
            )));
        }
        if request.source.len() > 64 || request.source.chars().any(char::is_control) {
            return Err(Error::Validation(
                "source must be at most 64 bytes without control characters".into(),
            ));
        }
        if text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err(Error::Validation("文字不能包含控制字符".into()));
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let rotation = (Uuid::new_v4().as_bytes()[0] as f64 / 255.0 - 0.5) * 2.0;
        let note = sqlx::query_as::<_, Note>(
            "INSERT INTO notes (id,text,source,created_at,rotation) VALUES (?,?,?,?,?) RETURNING *",
        )
        .bind(id)
        .bind(text)
        .bind(request.source)
        .bind(now)
        .bind(rotation)
        .fetch_one(&self.pool)
        .await?;
        let _ = self.events.send(PrinterEvent::Printed(note.clone()));
        Ok(note)
    }

    pub async fn list(
        &self,
        limit: i64,
        offset: i64,
        archived: Option<bool>,
    ) -> Result<Vec<Note>, Error> {
        Ok(sqlx::query_as::<_, Note>(
            "SELECT * FROM notes WHERE (? IS NULL OR archived = ?) ORDER BY seq DESC LIMIT ? OFFSET ?"
        ).bind(archived).bind(archived).bind(limit.clamp(1, 100)).bind(offset.max(0))
            .fetch_all(&self.pool).await?)
    }

    pub async fn visible(&self) -> Result<Vec<Note>, Error> {
        Ok(
            sqlx::query_as::<_, Note>("SELECT * FROM notes WHERE archived = 0 ORDER BY seq")
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub async fn update(&self, id: &str, patch: NotePatch) -> Result<Note, Error> {
        if patch.x.is_some() != patch.y.is_some() {
            return Err(Error::Validation(
                "x and y must be supplied together".into(),
            ));
        }
        for value in [patch.x, patch.y].into_iter().flatten() {
            if !value.is_finite() || !(0.0..=100_000.0).contains(&value) {
                return Err(Error::Validation(
                    "坐标必须为 0 到 100000 之间的有限数值".into(),
                ));
            }
        }
        if patch
            .z_index
            .is_some_and(|z| !(1..=2_000_000_000).contains(&z))
        {
            return Err(Error::Validation("Invalid z_index".into()));
        }
        let note = sqlx::query_as::<_, Note>(
            "UPDATE notes SET x=COALESCE(?,x),y=COALESCE(?,y),z_index=COALESCE(?,z_index),archived=COALESCE(?,archived) WHERE id=? RETURNING *"
        ).bind(patch.x).bind(patch.y).bind(patch.z_index).bind(patch.archived).bind(id)
            .fetch_optional(&self.pool).await?.ok_or(Error::NotFound)?;
        let _ = self.events.send(PrinterEvent::Updated(note.clone()));
        Ok(note)
    }
}
