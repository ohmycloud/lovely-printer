use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use lovely_printer::{
    Note, NotePatch, PrintRequest, Printer, PrinterEvent, api,
    inspiration::{InspirationKind, InspirationProvider, LocalProvider},
};
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePoolOptions;
use tower::ServiceExt;

async fn printer() -> Printer {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();
    Printer::new(pool)
}
fn request(text: &str) -> PrintRequest {
    PrintRequest {
        text: text.into(),
        source: "test".into(),
    }
}
async fn json_response(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
#[tokio::test]
async fn print_persists_before_broadcast_and_preserves_whitespace() {
    let p = printer().await;
    let mut receiver = p.subscribe();
    let note = p.print(request("  你好\r\nRust 🦀  ")).await.unwrap();
    assert_eq!(note.text, "  你好\nRust 🦀  ");
    match receiver.recv().await.unwrap() {
        PrinterEvent::Printed(event) => assert_eq!(event.id, note.id),
        _ => panic!("expected print event"),
    }
    assert_eq!(p.list(50, 0, None).await.unwrap()[0].id, note.id);
}
#[tokio::test]
async fn rejects_empty_oversized_and_control_text_without_records() {
    let p = printer().await;
    for text in [
        "".into(),
        " \n\t".into(),
        "爱".repeat(4001),
        "hello\0world".into(),
    ] {
        assert!(p.print(request(&text)).await.is_err());
    }
    assert!(p.visible().await.unwrap().is_empty());
    assert!(p.print(request(&"爱".repeat(4000))).await.is_ok());
}
#[tokio::test]
async fn position_and_archive_are_persisted_and_history_is_retained() {
    let p = printer().await;
    let note = p.print(request("keep me")).await.unwrap();
    let update = p
        .update(
            &note.id,
            NotePatch {
                x: Some(123.5),
                y: Some(64.0),
                z_index: Some(1002),
                archived: Some(true),
            },
        )
        .await
        .unwrap();
    assert_eq!(update.x, Some(123.5));
    assert!(p.visible().await.unwrap().is_empty());
    assert_eq!(p.list(10, 0, Some(true)).await.unwrap().len(), 1);
    assert!(
        p.update(
            &note.id,
            NotePatch {
                x: Some(f64::NAN),
                y: Some(0.0),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
    assert!(
        p.update(
            &note.id,
            NotePatch {
                x: Some(-1.0),
                y: Some(0.0),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
    assert!(
        p.update(
            &note.id,
            NotePatch {
                x: Some(1.0),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
    p.update(
        &note.id,
        NotePatch {
            archived: Some(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(p.visible().await.unwrap().len(), 1);
}
#[tokio::test]
async fn paginated_history_is_newest_first() {
    let p = printer().await;
    for n in 0..4 {
        p.print(request(&format!("note {n}"))).await.unwrap();
    }
    let notes = p.list(2, 1, None).await.unwrap();
    assert_eq!(
        notes.iter().map(|n| n.text.as_str()).collect::<Vec<_>>(),
        ["note 2", "note 1"]
    );
}
#[tokio::test]
async fn database_survives_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", directory.path().join("notes.db").display());
    let p = Printer::open(&url).await.unwrap();
    let note = p.print(request("a lasting moment")).await.unwrap();
    p.pool.close().await;
    let reopened = Printer::open(&url).await.unwrap();
    assert_eq!(reopened.visible().await.unwrap()[0].id, note.id);
}
#[tokio::test]
async fn http_print_and_validation_contract() {
    let app = api::router(printer().await);
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/print")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"text":"<script>alert('safe')</script>"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let note = json_response(response).await;
    assert_eq!(note["source"], "http");
    for body in ["{}", "{broken", "{\"text\":\"  \"}"] {
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/print")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(json_response(response).await["error"].is_string());
    }
    let response = app
        .oneshot(
            Request::patch("/api/notes/missing")
                .header("content-type", "application/json")
                .body(Body::from("{\"archived\":true}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn concurrent_commands_produce_unique_ordered_slips() {
    let p = printer().await;
    let tasks: Vec<_> = (0..20)
        .map(|n| {
            let p = p.clone();
            tokio::spawn(async move { p.print(request(&format!("job {n}"))).await.unwrap() })
        })
        .collect();
    for task in tasks {
        task.await.unwrap();
    }
    let notes = p.visible().await.unwrap();
    assert_eq!(notes.len(), 20);
    assert!(notes.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    assert_eq!(
        notes
            .iter()
            .map(|n| &n.id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        20
    );
}
#[tokio::test]
async fn sse_delivers_initial_snapshot_and_live_print() {
    let p = printer().await;
    p.print(request("already here")).await.unwrap();
    let response = api::router(p.clone())
        .oneshot(Request::get("/api/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut body = response.into_body();
    let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
    let first = String::from_utf8(first.to_vec()).unwrap();
    assert!(first.contains("event: sync"));
    assert!(first.contains("already here"));
    let note = p.print(request("from terminal")).await.unwrap();
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    let event = String::from_utf8(event.to_vec()).unwrap();
    assert!(event.contains("event: printed"));
    assert!(event.contains(&note.id));
}
#[tokio::test]
async fn inspirations_support_all_kinds_and_do_not_immediately_repeat() {
    let provider = LocalProvider::default();
    let first = provider.generate(InspirationKind::Love).await;
    let second = provider.generate(InspirationKind::Love).await;
    assert_ne!(first.text, second.text);
    for kind in [
        InspirationKind::Love,
        InspirationKind::Poetry,
        InspirationKind::Lyrics,
    ] {
        assert!(!provider.generate(kind).await.text.trim().is_empty());
    }
}
#[tokio::test]
async fn static_assets_are_embedded_and_paths_are_allowlisted() {
    let app = api::router(printer().await);
    for path in [
        "/",
        "/app.js",
        "/audio.js",
        "/app.css",
        "/assets/space-mono.ttf",
        "/assets/concrete-wall.png",
    ] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
    }
    let response = app
        .oneshot(
            Request::get("/assets/printer.db")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn note_response_round_trips_for_cli_clients() {
    let p = printer().await;
    let note = p.print(request("hello")).await.unwrap();
    let copy: Note = serde_json::from_str(&serde_json::to_string(&note).unwrap()).unwrap();
    assert_eq!(copy.id, note.id);
}
