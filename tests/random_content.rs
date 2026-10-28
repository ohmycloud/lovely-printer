use axum::{Json, Router, extract::Query, routing::get};
use http_body_util::BodyExt;
use lovely_printer::{
    Printer, api,
    inspiration::{InspirationKind, LocalProvider},
    random_content::RandomContentService,
};
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePoolOptions;
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;

async fn mock_server() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let placeholder_count = calls.clone();
    let healthy_count = calls.clone();
    let rate_count = calls.clone();
    let app = Router::new()
        .route("/poetry", get(|Query(q): Query<HashMap<String,String>>| async move {
            assert_eq!(q.get("type").map(String::as_str), Some("i"));
            assert_eq!(q.get("encode").map(String::as_str), Some("json"));
            assert_eq!(q.get("max_length").map(String::as_str), Some("30"));
            Json(json!({"hitokoto":" 床前明月光，\r\n疑是地上霜。 ", "from":"静夜思", "from_who":"李白"}))
        }))
        .route("/lyrics", get(move |Query(q): Query<HashMap<String,String>>| {
            let count = count.clone();
            async move {
                count.fetch_add(1,Ordering::Relaxed);
                assert_eq!(q.get("q").map(String::as_str), Some("海阔天空"));
                // Original test fixtures, not third-party lyrics.
                Json(json!([
                    {"trackName":"测试曲甲","artistName":"测试歌手甲","plainLyrics":"第一行\n第二行\n第三行\n第四行\n第一行"},
                    {"trackName":"测试曲甲","artistName":"测试歌手甲","plainLyrics":"第一行\n第二行\n第三行\n第四行\n第一行"},
                    {"trackName":"测试曲乙","artistName":"测试歌手乙","syncedLyrics":"[ar:测试]\n[00:01]另一行\n[00:02]再一行"},
                    {"trackName":"纯音乐","instrumental":true}
                ]))
            }
        }))
        .route("/placeholder", get(move || {
            let count = placeholder_count.clone();
            async move {
                count.fetch_add(1, Ordering::Relaxed);
                Json(json!({"id":0,"hitokoto":"海纳百川，有容乃大。","type":"i","from":"名言警句","from_who":null,"dynasty":null}))
            }
        }))
        .route("/counted-poetry", get(move || {
            let count = healthy_count.clone();
            async move {
                count.fetch_add(1, Ordering::Relaxed);
                Json(json!({"id":"P100347","hitokoto":"床前明月光，疑是地上霜。","from":"《静夜思》","from_who":"李白"}))
            }
        }))
        .route("/rate-limited", get(move || {
            let count = rate_count.clone();
            async move {
                count.fetch_add(1, Ordering::Relaxed);
                (axum::http::StatusCode::TOO_MANY_REQUESTS, [(axum::http::header::RETRY_AFTER, "120")], "rate limited")
            }
        }))
        .route("/empty", get(||async { Json(json!([])) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, calls, server)
}
fn service(base: &str) -> RandomContentService {
    RandomContentService::new(
        format!("{base}/poetry"),
        format!("{base}/lyrics"),
        Arc::new(LocalProvider::default()),
    )
}
#[tokio::test]
async fn third_party_adapters_normalize_poetry_and_cache_deduplicate_lyrics() {
    let (base, calls, server) = mock_server().await;
    let service = service(&base);
    let poem = service.random(InspirationKind::Poetry, None).await.unwrap();
    assert_eq!(
        serde_json::to_value(&poem).unwrap(),
        json!({"type":"poetry","title":"静夜思","author":"李白","content":"床前明月光，\n疑是地上霜。","source":"poetry"})
    );
    let first = service.random(InspirationKind::Lyrics, None).await.unwrap();
    let second = service
        .random(InspirationKind::Lyrics, Some("海阔天空"))
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert_ne!(first.title, second.title);
    assert_eq!(first.source, "lrclib");
    assert!(!first.content.contains('['));
    assert!(first.content.lines().count() <= 4);
    server.abort();
}
#[tokio::test]
async fn empty_and_unavailable_sources_use_explicitly_labelled_local_fallbacks() {
    let (base, _, server) = mock_server().await;
    let service = RandomContentService::new(
        format!("{base}/missing"),
        format!("{base}/empty"),
        Arc::new(LocalProvider::default()),
    );
    let poem = service.random(InspirationKind::Poetry, None).await.unwrap();
    let song = service.random(InspirationKind::Lyrics, None).await.unwrap();
    assert_eq!(poem.source, "local:poetry");
    assert_eq!(song.source, "local:lyrics");
    assert!(!song.content.is_empty());
    assert!(
        service
            .random(InspirationKind::Lyrics, Some(&"字".repeat(101)))
            .await
            .is_err()
    );
    server.abort();
}
#[tokio::test]
async fn normalized_get_contract_does_not_create_a_print_record_and_legacy_api_still_works() {
    let (base, _, server) = mock_server().await;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();
    let mut printer = Printer::new(pool);
    printer.random_content = Arc::new(service(&base));
    let app = api::router(printer.clone());
    for uri in [
        "/api/print/random?type=poetry",
        "/api/print/random?kind=poetry",
    ] {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::get(uri)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let item: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(item.as_object().unwrap().len(), 5);
        assert_eq!(item["type"], "poetry");
        assert!(!item["title"].as_str().unwrap().is_empty());
        assert!(!item["author"].as_str().unwrap().is_empty());
    }
    let legacy = app
        .clone()
        .oneshot(
            axum::http::Request::get("/api/inspire?kind=poetry")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let legacy: Value =
        serde_json::from_slice(&legacy.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(legacy["text"].as_str().unwrap().contains("\n\n—— "));
    assert!(legacy["provider"].is_string());
    for uri in ["/api/print/random?type=unknown", "/api/print/random?q=%00"] {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::get(uri)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
    }
    assert!(printer.visible().await.unwrap().is_empty());
    server.abort();
}

#[tokio::test]
async fn rddh_fixed_default_is_rejected_and_twelve_requests_return_distinct_real_poems() {
    let (base, calls, server) = mock_server().await;
    let service = RandomContentService::new(
        format!("{base}/placeholder"),
        format!("{base}/lyrics"),
        Arc::new(LocalProvider::default()),
    );
    let mut contents = std::collections::HashSet::new();
    for _ in 0..12 {
        let item = service.random(InspirationKind::Poetry, None).await.unwrap();
        assert_eq!(item.source, "local:poetry");
        assert_ne!(item.title, "名言警句");
        assert!(!item.content.contains("海纳百川"));
        assert!(contents.insert(item.content), "recent poem must not repeat");
    }
    assert_eq!(
        calls.load(Ordering::Relaxed),
        1,
        "degraded upstream is throttled"
    );
    server.abort();
}

#[tokio::test]
async fn stuck_valid_poetry_source_does_not_force_repeating_a_single_cached_candidate() {
    let (base, _, server) = mock_server().await;
    let service = service(&base);
    let mut contents = std::collections::HashSet::new();
    for index in 0..12 {
        let item = service.random(InspirationKind::Poetry, None).await.unwrap();
        assert_eq!(
            item.source,
            if index == 0 { "poetry" } else { "local:poetry" }
        );
        assert!(
            contents.insert(item.content),
            "a single-item upstream must not repeat"
        );
    }
    server.abort();
}

#[tokio::test]
async fn healthy_poetry_upstream_is_not_burst_called_by_concurrent_random_requests() {
    let (base, calls, server) = mock_server().await;
    let service = Arc::new(RandomContentService::new(
        format!("{base}/counted-poetry"),
        format!("{base}/lyrics"),
        Arc::new(LocalProvider::default()),
    ));
    let tasks: Vec<_> = (0..12)
        .map(|_| {
            let service = service.clone();
            tokio::spawn(
                async move { service.random(InspirationKind::Poetry, None).await.unwrap() },
            )
        })
        .collect();
    let mut contents = std::collections::HashSet::new();
    for task in tasks {
        assert!(contents.insert(task.await.unwrap().content));
    }
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    server.abort();
}

#[tokio::test]
async fn upstream_429_falls_back_without_retry_storms_or_client_errors() {
    let (base, calls, server) = mock_server().await;
    let service = RandomContentService::new(
        format!("{base}/rate-limited"),
        format!("{base}/lyrics"),
        Arc::new(LocalProvider::default()),
    );
    for _ in 0..12 {
        let item = service.random(InspirationKind::Poetry, None).await.unwrap();
        assert_eq!(item.source, "local:poetry");
        assert!(!item.content.is_empty());
    }
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    server.abort();
}
