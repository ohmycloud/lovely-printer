# MotoPager · Lovely Printer

## 快速开始

```bash
cargo run -- serve
# 浏览器打开 http://127.0.0.1:3000
```

默认会在当前目录创建 `printer.db`，启动时自动执行迁移。也可直接 `cargo run` 使用相同默认配置。

自定义端口与数据库：

```bash
cargo run -- serve --bind 127.0.0.1:3917 --database sqlite://printer.db
# 浏览器打开 http://127.0.0.1:3917
```

环境变量：`PRINTER_BIND`（监听地址）、`DATABASE_URL`（SQLite URL）、`PRINTER_URL`（CLI 目标服务）、`NOTE_PROVIDER_URL`（可选情话 API）、`POETRY_API_URL` / `LYRICS_API_URL`（可选上游镜像地址）、`RUST_LOG`（日志级别）。

## 使用

- 屏幕输入文字，按 **PRINT** 或 **⌘ / Ctrl + Enter** 打印。
- **红心**：随机生成一段文字，逐字写入琥珀屏幕；来源可选情话、RDDH 随机诗词和 LRCLIB 随机歌词。歌词支持自定义歌曲／歌手搜索词，默认「海阔天空」。
- **小红按钮**：清空输入。
- 便签打印完成后可用鼠标／触屏拖动；聚焦便签后也可用方向键移动，Shift 加速。
- 便签右上角 **×** 收起到历史，不会删除数据库记录。
- 右上角 **历史** 可恢复便签或重新打印；**设置 → 声音与设置** 可调节音量、上传自定义音频、选择灵感类型和减少动画。
- **设置 → 主题配色** 提供「奶油复古」「晴空蓝」「鼠尾草绿」，可单独修改机身、按钮、屏幕、纸张、正文、背景及 Header / Footer 颜色，并编辑画布与便签的页眉页脚文案；设置自动保存在当前浏览器。
- 便签正文基准字号保持 **14px**；按最新视觉调整，打印机输入字号从 23.52px 缩小为 **20px**。点击便签不会出现虚线边框。
- 清空按钮和红心水平居中；工具栏使用等尺寸 SVG，不再显示多余的小圆点。设置中的两个下拉框固定从按钮下方向下展开，支持键盘操作，不使用方向由操作系统决定的原生弹出菜单。
- **默认打印声是“噗噗噗”**。要使用参考站声音，设置中选择 **「原站 · 热敏打印机」**。
- 浏览器要求用户先点击一次页面才能播放声音；静音、自动播放限制不会阻止打印。

主题预览：[晴空蓝](docs/preview-sky.png) · [主题设置面板](docs/theme-settings.png)

## 命令行打印

保持服务与网页打开，在另一个终端执行：

```bash
cargo run -- print '今天也要好好生活。'
printf '第一行\n第二行\n' | cargo run -- print -
cargo run -- history --limit 20
cargo run -- inspire --kind poetry --print
cargo run -- inspire --kind lyrics --query '海阔天空' --print
```

如果服务用了其他端口，附加 `--server http://127.0.0.1:3917`，或设置 `PRINTER_URL`。服务接收后先存入 SQLite，再通过 SSE 通知已打开的网页依次出纸；网页离线时仍保存记录。

## HTTP 打印

```bash
curl -X POST http://127.0.0.1:3000/api/print \
  -H 'Content-Type: application/json' \
  -d '{"text":"把想说的话，留在纸上。","source":"http"}'

curl 'http://127.0.0.1:3000/api/notes?limit=20&offset=0'
curl 'http://127.0.0.1:3000/api/print/random?type=poetry'
curl --get 'http://127.0.0.1:3000/api/print/random' \
  --data-urlencode 'type=lyrics' --data-urlencode 'q=海阔天空'
```

网页、CLI 和 HTTP 最终都使用同一个 Rust `Printer::print` 打印服务，而不是各写一套存储逻辑。

### 统一随机内容接口

`GET /api/print/random?type=poetry` 返回统一结构：

```json
{
  "type": "poetry",
  "title": "静夜思",
  "author": "李白",
  "content": "床前明月光，疑是地上霜。",
  "source": "poetry"
}
```

该 GET **只取内容，不创建打印记录**。网页红心会将正文及作者／标题写入屏幕，再由用户点击 PRINT；CLI 的 `inspire --print` 会执行取内容及打印两步。

- `type` 支持 `love`、`poetry`（默认）、`lyrics`，兼容别名 `kind`。
- 诗词上游：`https://www.rddh.cn/api/hitokoto?type=i&encode=json&max_length=30`。
- 歌词上游：`https://lrclib.net/api/search?q=海阔天空`，`q` 可自定义；随机选择搜索结果及最多四行歌词片段。
- Rust 数据层负责格式归一、LRC 时间戳与控制字符清洗、去重、按纸张宽度换行、缓存和失败回退。来源如实返回 `poetry` / `lrclib`；本地备用为 `local:poetry` / `local:lyrics`，不会伪装成在线结果。
- LRCLIB 搜索结果缓存 10 分钟；诗词每次请求尝试取新句，并保留最近内容用于断网回退。上游请求最多 6 秒，失败后暂停访问该来源／搜索词 30 秒。
- 会过滤 RDDH 的 `id=0 / 名言警句` 固定兜底响应。如果上游一直只给同一句，也会自动从 **21 条本地公版诗词**中随机补充候选，避免重复最近 **16 条**诗词，并如实标注 `local:poetry`，而不是一直输出“海纳百川，有容乃大。”。
- 原 `GET /api/inspire?kind=...` 保留兼容，由相同数据层转换为旧的 `text/provider` 结构。

完整实现、缓存边界与测试说明见 [docs/implementation.md](docs/implementation.md)。

## 验证

```bash
cargo test
cargo clippy --all-targets -- -D warnings

# 可选浏览器端到端测试
npm ci
npx playwright install chromium
npm run test:e2e
```

## 发布

```bash
cargo build --release
./target/release/lovely-printer serve
```

复制二进制到其他位置即可运行。SQLite 文件保存在启动目录，备份时请停止服务后复制数据库，或使用 SQLite backup API；运行中的 WAL 数据不能只通过复制主 `.db` 文件保证完整。

默认仅监听本机。若用 `--bind 0.0.0.0:3000` 开放给局域网，须注意：当前是个人／可信网络应用，**没有账户、权限隔离或公网鉴权**。不要直接暴露到公网；需要公网访问时请在反向代理配置 HTTPS、认证与限流，并关闭 SSE 路径的代理缓冲。
