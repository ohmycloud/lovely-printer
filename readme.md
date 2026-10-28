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

环境变量：`PRINTER_BIND`（监听地址）、`DATABASE_URL`（SQLite URL）、`PRINTER_URL`（CLI 目标服务）、`NOTE_PROVIDER_URL`（可选灵感 API）、`RUST_LOG`（日志级别）。

## 使用

- 屏幕输入文字，按 **PRINT** 或 **⌘ / Ctrl + Enter** 打印。
- **红心**：随机生成一段文字，逐字写入琥珀屏幕；来源可选情话、古诗、原创短歌词。
- **小红按钮**：清空输入。
- 便签打印完成后可用鼠标／触屏拖动；聚焦便签后也可用方向键移动，Shift 加速。
- 便签右上角 **×** 收起到历史，不会删除数据库记录。
- 右上角 **历史** 可恢复便签或重新打印；**设置** 可调节音量、上传自定义音频、选择灵感类型和减少动画。
- **默认打印声是“噗噗噗”**。要使用参考站声音，设置中选择 **「原站 · 热敏打印机」**。
- 浏览器要求用户先点击一次页面才能播放声音；静音、自动播放限制不会阻止打印。

## 命令行打印

保持服务与网页打开，在另一个终端执行：

```bash
cargo run -- print '今天也要好好生活。'
printf '第一行\n第二行\n' | cargo run -- print -
cargo run -- history --limit 20
cargo run -- inspire --kind poetry --print
```

如果服务用了其他端口，附加 `--server http://127.0.0.1:3917`，或设置 `PRINTER_URL`。服务接收后先存入 SQLite，再通过 SSE 通知已打开的网页依次出纸；网页离线时仍保存记录。

## HTTP 打印

```bash
curl -X POST http://127.0.0.1:3000/api/print \
  -H 'Content-Type: application/json' \
  -d '{"text":"把想说的话，留在纸上。","source":"http"}'

curl 'http://127.0.0.1:3000/api/notes?limit=20&offset=0'
curl 'http://127.0.0.1:3000/api/inspire?kind=poetry'
```

网页、CLI 和 HTTP 最终都使用同一个 Rust `Printer::print` 打印服务，而不是各写一套存储逻辑。

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
