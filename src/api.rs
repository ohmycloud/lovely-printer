use crate::{Error, NotePatch, PrintRequest, Printer, PrinterEvent, inspiration::InspirationKind};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State, rejection::JsonRejection},
    http::{StatusCode, header},
    response::{
        Html, IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, patch, post},
};
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use std::{convert::Infallible, time::Duration};
use tokio_stream::wrappers::BroadcastStream;

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Error::Validation(message) => (StatusCode::BAD_REQUEST, message),
            Error::NotFound => (StatusCode::NOT_FOUND, "Note not found".into()),
            Error::Database(error) => {
                tracing::error!(%error, "Database operation failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "数据库暂时不可用，请稍后重试".into(),
                )
            }
        };
        (status, Json(serde_json::json!({"error":message}))).into_response()
    }
}
fn json<T>(payload: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    payload
        .map(|Json(value)| value)
        .map_err(|e| Error::Validation(e.body_text()))
}

pub fn router(printer: Printer) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async { Html(include_str!("../static/index.html")) }),
        )
        .route(
            "/app.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../static/app.css"),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../static/app.js"),
                )
            }),
        )
        .route(
            "/audio.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../static/audio.js"),
                )
            }),
        )
        .route("/assets/{name}", get(asset))
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .route("/api/print", post(print))
        .route("/api/notes", get(list))
        .route("/api/notes/{id}", patch(update))
        .route("/api/inspire", get(inspire))
        .route("/api/events", get(events))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(printer)
}
async fn print(
    State(printer): State<Printer>,
    payload: Result<Json<PrintRequest>, JsonRejection>,
) -> Result<impl IntoResponse, Error> {
    Ok((
        StatusCode::CREATED,
        Json(printer.print(json(payload)?).await?),
    ))
}
#[derive(Default, Deserialize)]
struct ListQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    archived: Option<bool>,
}
async fn list(
    State(printer): State<Printer>,
    Query(q): Query<ListQuery>,
) -> Result<impl IntoResponse, Error> {
    Ok(Json(
        printer
            .list(q.limit.unwrap_or(50), q.offset.unwrap_or(0), q.archived)
            .await?,
    ))
}
async fn update(
    State(printer): State<Printer>,
    Path(id): Path<String>,
    payload: Result<Json<NotePatch>, JsonRejection>,
) -> Result<impl IntoResponse, Error> {
    Ok(Json(printer.update(&id, json(payload)?).await?))
}
#[derive(Deserialize)]
struct InspireQuery {
    kind: Option<InspirationKind>,
}
async fn inspire(
    State(printer): State<Printer>,
    Query(q): Query<InspireQuery>,
) -> impl IntoResponse {
    Json(
        printer
            .inspiration
            .generate(q.kind.unwrap_or(InspirationKind::Love))
            .await,
    )
}
async fn events(State(printer): State<Printer>) -> Result<impl IntoResponse, Error> {
    // Subscribe before the snapshot query: no print can disappear in the handshake gap.
    let receiver = printer.subscribe();
    let snapshot = printer.visible().await?;
    let initial = stream::once(async move {
        Ok::<_, Infallible>(
            Event::default()
                .event("sync")
                .json_data(snapshot)
                .expect("serialize snapshot"),
        )
    });
    let live = BroadcastStream::new(receiver).then(move |event| {
        let printer = printer.clone();
        async move {
            let event = match event {
                Ok(PrinterEvent::Printed(note)) => {
                    Event::default().event("printed").json_data(note)
                }
                Ok(PrinterEvent::Updated(note)) => {
                    Event::default().event("updated").json_data(note)
                }
                Err(_) => match printer.visible().await {
                    Ok(notes) => Event::default().event("sync").json_data(notes),
                    Err(_) => {
                        return Ok(Event::default()
                            .event("retry-sync")
                            .data("database unavailable"));
                    }
                },
            }
            .expect("serialize printer event");
            Ok::<_, Infallible>(event)
        }
    });
    Ok(
        Sse::new(initial.chain(live))
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15))),
    )
}
async fn asset(Path(name): Path<String>) -> Response {
    let (mime, bytes): (&str, &[u8]) = match name.as_str() {
        "concrete-wall.png" => (
            "image/png",
            include_bytes!("../static/assets/concrete-wall.png"),
        ),
        "notebook.png" => ("image/png", include_bytes!("../static/assets/notebook.png")),
        "space-mono.ttf" => (
            "font/ttf",
            include_bytes!("../static/assets/space-mono.ttf"),
        ),
        "space-mono-bold.ttf" => (
            "font/ttf",
            include_bytes!("../static/assets/space-mono-bold.ttf"),
        ),
        "vt323.ttf" => ("font/ttf", include_bytes!("../static/assets/vt323.ttf")),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes,
    )
        .into_response()
}
