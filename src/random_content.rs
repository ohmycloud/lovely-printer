//! Unified third-party boundary: fetch → normalize → deduplicate → cache → wrap.
//! No upstream-specific field leaks into the printer, browser or CLI.
use crate::{
    Error,
    inspiration::{InspirationKind, InspirationProvider},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

pub const DEFAULT_LYRICS_QUERY: &str = "海阔天空";
const CACHE_TTL: Duration = Duration::from_secs(600);
const RETRY_DELAY: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RandomContent {
    #[serde(rename = "type")]
    pub kind: InspirationKind,
    pub title: String,
    pub author: String,
    pub content: String,
    pub source: String,
}
impl RandomContent {
    pub fn print_text(&self) -> String {
        format!("{}\n\n—— {}《{}》", self.content, self.author, self.title)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    kind: InspirationKind,
    query: String,
}
struct Entry {
    items: Vec<RandomContent>,
    expires: Instant,
    retry_after: Instant,
    previous: String,
    recent_poems: VecDeque<String>,
}
impl Default for Entry {
    fn default() -> Self {
        Self {
            items: vec![],
            expires: Instant::now(),
            retry_after: Instant::now(),
            previous: String::new(),
            recent_poems: VecDeque::new(),
        }
    }
}

pub struct RandomContentService {
    client: reqwest::Client,
    poetry_url: String,
    lyrics_url: String,
    love: Arc<dyn InspirationProvider>,
    cache: Mutex<HashMap<Key, Arc<Mutex<Entry>>>>,
}
impl RandomContentService {
    pub fn configured(love: Arc<dyn InspirationProvider>) -> Self {
        Self::new(
            std::env::var("POETRY_API_URL")
                .unwrap_or_else(|_| "https://www.rddh.cn/api/hitokoto".into()),
            std::env::var("LYRICS_API_URL")
                .unwrap_or_else(|_| "https://lrclib.net/api/search".into()),
            love,
        )
    }
    /// Endpoint injection keeps integration tests deterministic and supports mirrors.
    pub fn new(poetry_url: String, lyrics_url: String, love: Arc<dyn InspirationProvider>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent("LovelyPrinter/0.1 (personal note printer; LRCLIB client)")
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(6))
                .build()
                .expect("content HTTP client"),
            poetry_url,
            lyrics_url,
            love,
            cache: Mutex::new(HashMap::new()),
        }
    }
    pub async fn random(
        &self,
        kind: InspirationKind,
        query: Option<&str>,
    ) -> Result<RandomContent, Error> {
        let query = query.unwrap_or(DEFAULT_LYRICS_QUERY).trim();
        if query.chars().count() > 100 || query.chars().any(char::is_control) {
            return Err(Error::Validation(
                "搜索词最多 100 个字符，且不能包含控制字符".into(),
            ));
        }
        if kind == InspirationKind::Love {
            let message = self.love.generate(kind).await;
            return Ok(RandomContent {
                kind,
                title: "写给你的小情话".into(),
                author: "MotoPager".into(),
                content: wrap(&clean(&message.text), 32),
                source: message.provider,
            });
        }
        let key = Key {
            kind,
            query: if kind == InspirationKind::Lyrics {
                if query.is_empty() {
                    DEFAULT_LYRICS_QUERY.into()
                } else {
                    query.into()
                }
            } else {
                String::new()
            },
        };
        let entry = {
            let mut cache = self.cache.lock().await;
            if cache.len() >= 64
                && !cache.contains_key(&key)
                && let Some(oldest) = cache.keys().next().cloned()
            {
                cache.remove(&oldest);
            }
            cache
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(Entry::default())))
                .clone()
        };
        // Single flight per search, without blocking requests to other sources/queries.
        let mut entry = entry.lock().await;
        let now = Instant::now();
        // The poetry endpoint returns one random item, so fetch a new item each time.
        // Its rolling cache is retained for outages; LRCLIB's search batch has a TTL.
        if now >= entry.retry_after && (kind == InspirationKind::Poetry || now >= entry.expires) {
            match self.fetch(&key).await {
                Ok(items) if !items.is_empty() => {
                    if kind == InspirationKind::Lyrics {
                        entry.items.clear();
                    }
                    for item in items {
                        if !entry
                            .items
                            .iter()
                            .any(|old| fingerprint(old) == fingerprint(&item))
                        {
                            entry.items.push(item);
                        }
                    }
                    if entry.items.len() > 64 {
                        let n = entry.items.len() - 64;
                        entry.items.drain(..n);
                    }
                    entry.expires = Instant::now() + CACHE_TTL;
                }
                result => {
                    tracing::warn!(?kind, error = ?result.err(), "Content source unavailable; using cached/local content");
                    entry.retry_after = Instant::now() + RETRY_DELAY;
                }
            }
        }
        let mut pool = if entry.items.is_empty() {
            local_items(kind)
        } else {
            entry.items.clone()
        };
        // A healthy HTTP response may still be a stuck single-result upstream.
        // Never recycle that result just because it is the only cached candidate.
        if kind == InspirationKind::Poetry
            && pool
                .iter()
                .all(|item| entry.recent_poems.contains(&fingerprint(item)))
        {
            for item in local_items(kind) {
                if !pool
                    .iter()
                    .any(|old| fingerprint(old) == fingerprint(&item))
                {
                    pool.push(item);
                }
            }
        }
        let eligible: Vec<_> = pool
            .iter()
            .filter(|item| {
                let key = fingerprint(item);
                if kind == InspirationKind::Poetry {
                    !entry.recent_poems.contains(&key)
                } else {
                    key != entry.previous
                }
            })
            .collect();
        let candidates: Vec<_> = if eligible.is_empty() {
            pool.iter().collect()
        } else {
            eligible
        };
        let mut item = candidates[random_index(candidates.len())].clone();
        entry.previous = fingerprint(&item);
        if kind == InspirationKind::Poetry {
            let selected = entry.previous.clone();
            entry.recent_poems.push_back(selected);
            if entry.recent_poems.len() > 16 {
                entry.recent_poems.pop_front();
            }
        }
        // Print a manageable random four-line excerpt, never an entire long song.
        if kind == InspirationKind::Lyrics {
            let lines: Vec<_> = item
                .content
                .lines()
                .filter(|line| !line.is_empty())
                .collect();
            let count = lines.len().min(4);
            let start = random_index(lines.len() - count + 1);
            item.content = lines[start..start + count].join("\n");
        }
        item.content = wrap(&item.content, 32);
        Ok(item)
    }
    async fn fetch(
        &self,
        key: &Key,
    ) -> Result<Vec<RandomContent>, Box<dyn std::error::Error + Send + Sync>> {
        let request = match key.kind {
            InspirationKind::Poetry => self.client.get(&self.poetry_url).query(&[
                ("type", "i"),
                ("encode", "json"),
                ("max_length", "30"),
            ]),
            InspirationKind::Lyrics => self
                .client
                .get(&self.lyrics_url)
                .query(&[("q", key.query.as_str())]),
            InspirationKind::Love => unreachable!(),
        };
        let mut response = request.send().await?.error_for_status()?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err("Upstream response too large".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("Upstream response too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let data: serde_json::Value = serde_json::from_slice(&bytes)?;
        Ok(match key.kind {
            InspirationKind::Poetry => normalize_poetry(&data).into_iter().collect(),
            InspirationKind::Lyrics => normalize_lyrics(&data),
            InspirationKind::Love => unreachable!(),
        })
    }
}
fn random_index(len: usize) -> usize {
    u64::from_le_bytes(
        Uuid::new_v4().as_bytes()[..8]
            .try_into()
            .expect("UUID length"),
    ) as usize
        % len.max(1)
}
fn fingerprint(item: &RandomContent) -> String {
    format!("{}\0{}\0{}", item.title, item.author, item.content)
}
fn field(data: &serde_json::Value, key: &str, fallback: &str) -> String {
    data.get(key)
        .and_then(|s| s.as_str())
        .map(clean)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.into())
        .chars()
        .take(100)
        .collect()
}
fn normalize_poetry(data: &serde_json::Value) -> Option<RandomContent> {
    // RDDH currently serves this id=0 default even with cache-busting requests.
    // It is not a random poem; do not cache or relabel it as one.
    if data.get("id").and_then(|v| v.as_i64()) == Some(0)
        && data.get("from").and_then(|v| v.as_str()) == Some("名言警句")
    {
        return None;
    }
    let content = clean(data.get("hitokoto")?.as_str()?);
    if content.is_empty() {
        return None;
    }
    Some(RandomContent {
        kind: InspirationKind::Poetry,
        title: field(data, "from", "无题"),
        author: field(data, "from_who", "佚名"),
        content,
        source: "poetry".into(),
    })
}
fn normalize_lyrics(data: &serde_json::Value) -> Vec<RandomContent> {
    let mut unique = HashSet::new();
    data.as_array()
        .into_iter()
        .flatten()
        .filter_map(|song| {
            if song.get("instrumental").and_then(|b| b.as_bool()) == Some(true) {
                return None;
            }
            let plain = song
                .get("plainLyrics")
                .and_then(|s| s.as_str())
                .map(clean)
                .unwrap_or_default();
            let raw = if plain.is_empty() {
                song.get("syncedLyrics")
                    .and_then(|s| s.as_str())
                    .map(clean)
                    .unwrap_or_default()
            } else {
                plain
            };
            let mut lines = HashSet::new();
            let content = raw
                .lines()
                .filter(|line| !line.is_empty() && lines.insert(line.to_string()))
                .collect::<Vec<_>>()
                .join("\n");
            if content.is_empty() {
                return None;
            }
            let item = RandomContent {
                kind: InspirationKind::Lyrics,
                title: field(song, "trackName", "无题"),
                author: field(song, "artistName", "未知歌手"),
                content,
                source: "lrclib".into(),
            };
            unique.insert(fingerprint(&item)).then_some(item)
        })
        .collect()
}
/// Normalize line endings, invisible/control characters, LRC timestamps and metadata.
fn clean(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text: String = text
        .chars()
        .filter(|c| {
            (!c.is_control() || *c == '\n' || *c == '\t') && !matches!(c, '\u{feff}' | '\u{200b}')
        })
        .take(3000)
        .collect();
    text.lines()
        .filter_map(|line| {
            let mut line = line.trim();
            while line.starts_with('[') {
                let Some(end) = line.find(']') else {
                    break;
                };
                let tag = &line[1..end];
                if tag.starts_with(|c: char| c.is_ascii_digit()) && tag.contains(':') {
                    line = line[end + 1..].trim();
                } else if ["ar:", "ti:", "al:", "by:", "offset:"]
                    .iter()
                    .any(|prefix| tag.starts_with(prefix))
                {
                    return None;
                } else {
                    break;
                }
            }
            (!line.is_empty()).then(|| line.split_whitespace().collect::<Vec<_>>().join(" "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}
/// 32 monospace cells match the receipt's content width; CJK uses two cells.
fn wrap(text: &str, cells: usize) -> String {
    text.lines()
        .map(|line| {
            let mut output = String::new();
            let mut width = 0;
            for ch in line.chars() {
                let size = if ch.is_ascii() { 1 } else { 2 };
                if width + size > cells {
                    output.push('\n');
                    width = 0;
                }
                output.push(ch);
                width += size;
            }
            output
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn local_items(kind: InspirationKind) -> Vec<RandomContent> {
    let entries = match kind {
        InspirationKind::Poetry => vec![
            (
                "静夜思",
                "李白",
                "床前明月光，疑是地上霜。\n举头望明月，低头思故乡。",
            ),
            (
                "相思",
                "王维",
                "红豆生南国，春来发几枝。\n愿君多采撷，此物最相思。",
            ),
            ("望月怀远", "张九龄", "海上生明月，天涯共此时。"),
            ("鹿柴", "王维", "空山不见人，但闻人语响。"),
            ("鸟鸣涧", "王维", "人闲桂花落，夜静春山空。"),
            ("竹里馆", "王维", "独坐幽篁里，弹琴复长啸。"),
            ("山居秋暝", "王维", "明月松间照，清泉石上流。"),
            ("春晓", "孟浩然", "春眠不觉晓，处处闻啼鸟。"),
            ("宿建德江", "孟浩然", "野旷天低树，江清月近人。"),
            ("登鹳雀楼", "王之涣", "白日依山尽，黄河入海流。"),
            ("江雪", "柳宗元", "孤舟蓑笠翁，独钓寒江雪。"),
            ("寻隐者不遇", "贾岛", "松下问童子，言师采药去。"),
            ("山中", "王勃", "长江悲已滞，万里念将归。"),
            ("秋夕", "杜牧", "天阶夜色凉如水，卧看牵牛织女星。"),
            ("望庐山瀑布", "李白", "日照香炉生紫烟，遥看瀑布挂前川。"),
            ("望天门山", "李白", "两岸青山相对出，孤帆一片日边来。"),
            ("题西林壁", "苏轼", "不识庐山真面目，只缘身在此山中。"),
            ("饮湖上初晴后雨", "苏轼", "欲把西湖比西子，淡妆浓抹总相宜。"),
            ("定风波", "苏轼", "竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。"),
            ("游山西村", "陆游", "山重水复疑无路，柳暗花明又一村。"),
            ("小池", "杨万里", "小荷才露尖尖角，早有蜻蜓立上头。"),
        ],
        _ => vec![
            (
                "晚安的船",
                "MotoPager · 原创",
                "把月光折成船，\n载着晚安去你身旁。",
            ),
            (
                "晚风这一页",
                "MotoPager · 原创",
                "晚风翻过这一页，\n你是没写完的诗。",
            ),
            (
                "城市的灯",
                "MotoPager · 原创",
                "城市的灯一盏盏，\n我的心有你一站。",
            ),
        ],
    };
    entries
        .into_iter()
        .map(|(title, author, content)| RandomContent {
            kind,
            title: title.into(),
            author: author.into(),
            content: content.into(),
            source: if kind == InspirationKind::Poetry {
                "local:poetry"
            } else {
                "local:lyrics"
            }
            .into(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn poetry_maps_nullable_author_without_inventing_attribution() {
        let item = normalize_poetry(
            &json!({"hitokoto":" 海上生明月。\r\n天涯共此时。 ","from":"望月怀远","from_who":null}),
        )
        .unwrap();
        assert_eq!(item.author, "佚名");
        assert_eq!(item.source, "poetry");
        assert_eq!(item.content, "海上生明月。\n天涯共此时。");
    }
    #[test]
    fn lyrics_clean_timestamps_metadata_instrumentals_and_duplicates() {
        let song = json!({"trackName":"测试曲","artistName":"测试歌手","syncedLyrics":"[ar:测试]\n[00:01.20][00:02.00]第一行\n[00:03.00]第二行\n[00:04.00]第一行"});
        let items = normalize_lyrics(
            &json!([song.clone(),song,{"instrumental":true,"plainLyrics":"skip"}]),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].content, "第一行\n第二行");
        assert_eq!(wrap("一二三四五", 6), "一二三\n四五");
    }
}
