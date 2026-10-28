//! Provider boundary: add lyrics/poetry providers without touching printing or storage.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InspirationKind {
    Love,
    Poetry,
    Lyrics,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Inspiration {
    pub text: String,
    pub provider: String,
}
#[async_trait]
pub trait InspirationProvider: Send + Sync {
    async fn generate(&self, kind: InspirationKind) -> Inspiration;
}

pub struct LocalProvider {
    cursor: AtomicUsize,
}
impl Default for LocalProvider {
    fn default() -> Self {
        Self {
            cursor: AtomicUsize::new(Uuid::new_v4().as_bytes()[0] as usize),
        }
    }
}
#[async_trait]
impl InspirationProvider for LocalProvider {
    async fn generate(&self, kind: InspirationKind) -> Inspiration {
        let collection: &[&str] = match kind {
            InspirationKind::Love => &[
                "想把今天的风，\n和一句喜欢你，\n一起寄给你。",
                "在所有平常的日子里，\n你是我最不平常的欢喜。",
                "慢一点也没有关系，\n我们还有好多日落可以一起看。",
                "把心事写在纸上，\n把你放在心上。",
                "今天没有什么大事，\n只是又想起了你。",
                "世界很大，\n而我想留下的，\n是与你有关的小小瞬间。",
                "愿我们在各自的生活里闪光，\n也在彼此的宇宙里相逢。",
                "这一张纸很轻，\n但想念有一点重。",
                "留一点温柔给明天，\n留一个拥抱给你。",
                "把日子过成一封长信，\n收件人一直是你。",
                "你来时，\n连沉默都有了回声。",
                "不赶时间，\n只想和你把一杯茶喝完。",
            ],
            InspirationKind::Poetry => &[
                "海上生明月，天涯共此时。\n情人怨遥夜，竟夕起相思。\n—— 张九龄《望月怀远》",
                "愿君多采撷，此物最相思。\n—— 王维《相思》",
                "此时相望不相闻，愿逐月华流照君。\n—— 张若虚《春江花月夜》",
                "何须浅碧深红色，自是花中第一流。\n—— 李清照《鹧鸪天·桂花》",
                "山中何事？松花酿酒，春水煎茶。\n—— 张可久《人月圆·山中书事》",
            ],
            // Original short lyrics, not copied from copyrighted songs.
            InspirationKind::Lyrics => &[
                "晚风翻过这一页，\n你是没写完的诗。\n—— 原创小调",
                "把月光折成船，\n载着晚安去你身旁。\n—— 原创小调",
                "城市的灯一盏盏，\n我的心有你一站。\n—— 原创小调",
            ],
        };
        let draw = Uuid::new_v4().as_bytes()[0] as usize % collection.len();
        let mut previous = self.cursor.load(Ordering::Relaxed);
        let index = loop {
            let next = if draw == previous {
                (draw + 1) % collection.len()
            } else {
                draw
            };
            match self.cursor.compare_exchange_weak(
                previous,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break next,
                Err(actual) => previous = actual,
            }
        };
        Inspiration {
            text: collection[index].into(),
            provider: "local".into(),
        }
    }
}

struct HttpProvider {
    url: String,
    client: reqwest::Client,
    fallback: LocalProvider,
}
#[async_trait]
impl InspirationProvider for HttpProvider {
    async fn generate(&self, kind: InspirationKind) -> Inspiration {
        let result = self
            .client
            .post(&self.url)
            .json(&serde_json::json!({"kind":kind}))
            .send()
            .await;
        if let Ok(response) = result
            && let Ok(response) = response.error_for_status()
            && let Ok(message) = response.json::<serde_json::Value>().await
            && let Some(text) = message.get("text").and_then(|v| v.as_str())
            && !text.trim().is_empty()
            && text.chars().count() <= crate::MAX_TEXT_CHARS
            && !text
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Inspiration {
                text: text.into(),
                provider: "http".into(),
            };
        }
        tracing::warn!("Inspiration provider unavailable; using local collection");
        self.fallback.generate(kind).await
    }
}
pub fn configured_provider() -> Arc<dyn InspirationProvider> {
    match std::env::var("NOTE_PROVIDER_URL")
        .ok()
        .filter(|s| !s.is_empty())
    {
        Some(url) => Arc::new(HttpProvider {
            url,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .build()
                .expect("HTTP client"),
            fallback: LocalProvider::default(),
        }),
        None => Arc::new(LocalProvider::default()),
    }
}
