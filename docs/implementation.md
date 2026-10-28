# 实现说明与验收

## 参考站点观察

已在浏览器中实际操作参考站点的文字输入、PRINT、红心灵感、便签拖动，并检查浏览器可访问的样式、动画与 Web Audio 实现。

- 机身：圆角米色塑料、混凝土颗粒、底部厚度、内高光和地面投影。
- 黑色凹陷屏幕：VT323 字体、琥珀文字、闪烁块状光标；中文使用系统中文字体回退。
- 下方按钮：凹槽中的清空按钮、白色红心按钮、带物理按压位移的大 PRINT 按钮。
- 纸张：320px 原生宽度、Space Mono、锯齿边、ID／时间、虚线和斜纹条码、End of Transmission。
- 出纸：线性运动，`max(1500ms, 字符数 × 20ms)`。本项目按 Unicode 码点计数，避免 emoji 被算成两个字符。
- 打字：高通噪声点击（约 1200 Hz）与 100→50 Hz 三角波碰撞声。
- 回车：180→60 Hz 锯齿波滑落声、低通滤波和一次较重的机械点击。
- 原站打印声：500 Hz 锯齿波电机，40 Hz 方波调频、80 Hz 齿轮低鸣、3000 Hz 带通纸张噪声，以及结尾切纸声。

声音是 Web Audio 合成而非下载录音，噪声和音高含随机变化。复现的是声学结构与参数，不承诺跨浏览器、扬声器的逐采样一致性。

## 按 README 作出的调整

1. 机身严格使用 `rgb(229, 225, 214)`；PRINT 严格使用 `rgb(195, 102, 73)`，优先于原站网页中略有差别的颜色。
2. 默认音效为 README 要求的“噗噗噗”。想听参考站点音效，在右上角设置选择「原站 · 热敏打印机」。
3. 不沿用原站写死的机身高度估算。测量真实打印机顶边与纸张高度，使纸张从正确位置出纸。
4. 长纸张会等比缩小，以确保整张纸留在可见画布中；超长内容的易读全文可以在历史面板查看。这是可见性与物理尺寸之间的明确取舍。
5. 加入历史、设置、静音、连接状态、键盘快捷键、触屏拖动和减少动画选项，保持机身正面布局简洁。
6. 不冒用 Gemini 服务标识。默认离线生成原创情话、原创短歌词与公版古诗；可通过后端适配任意文本生成 API。
7. 不复制原站无法完全显示的欢迎便签问题。欢迎便签是临时引导，不占用真实打印历史。

## 架构

```text
Web / CLI / HTTP client
        │ POST /api/print
        ▼
Axum handlers ── Printer::print (统一验证及打印命令)
                       │
                       ├── SQLx → SQLite WAL → 持久化便签
                       └── broadcast → SSE → 网页打印队列

InspirationProvider
        ├── LocalProvider（离线随机、避免连续重复）
        └── HttpProvider（远程 API，8 秒超时，失败回退）
```

### 代码位置

| 路径 | 用途 |
|---|---|
| `src/lib.rs` | 打印服务、请求与便签类型、SQLx 数据访问、事件 |
| `src/api.rs` | Axum 路由、静态资源、SSE、JSON 错误处理 |
| `src/inspiration.rs` | 可替换的灵感来源接口与本地／远程实现 |
| `src/main.rs` | 启动服务、CLI 子命令 |
| `migrations/0001_notes.sql` | 自动执行的数据库迁移 |
| `static/index.html` | 打印机、画布、历史与设置面板 |
| `static/app.css` | 外观、字体、阴影、响应式样式 |
| `static/app.js` | 表单、动画、打印队列、拖动、SSE 同步 |
| `static/audio.js` | Web Audio 合成、自定义音频解码、IndexedDB |
| `tests/printer.rs` | Rust 服务与 HTTP 集成测试 |
| `tests/browser/printer.spec.js` | 浏览器端到端测试 |

### 持久化和同步约定

- 打印成功写入 SQLite 后才广播事件；没有网页在线时也会保留记录。
- 服务重启／网页重连时，SSE 先返回活动便签快照，不重新播放历史的声音和动画。
- 快照查询前先订阅广播，避免连接握手期间漏掉新打印；前端按 UUID 去重，避免 POST 响应和 SSE 产生两张纸。
- 同一网页按队列顺序出纸，不让多张纸同时挤出。
- 慢客户端的广播缓冲落后时，服务端重新发送活动便签快照。
- 拖动在本地逐帧渲染，放手时保存坐标和层级；其他网页收到更新后同步位置。多端同时拖动同一便签时使用最后写入的坐标。
- “×”仅把便签收起，不删除数据库记录；历史可放回桌面或创建一条新的打印记录。
- 纸张保存的是 CSS 像素坐标，换屏幕尺寸后会重新约束到当前画布，不保证不同设备上的绝对坐标完全相同。
- 自定义音频保存在当前浏览器 IndexedDB，偏好在 localStorage；不同浏览器／设备不共享音频。
- SQLite 是单机实例方案；多服务实例部署需要共享事件总线和数据库改造。

## API

### 打印

```http
POST /api/print
Content-Type: application/json

{"text":"想把今天的风，和一句喜欢你一起寄给你。","source":"http"}
```

返回 `201 Created` 和完整 `Note`。`source` 可省略（默认 `http`），最大 64 字节。

- 允许多行、制表符和首尾空格；纯空白会拒绝。
- CRLF 与 CR 统一为 LF。
- 最多 4000 个 Unicode 码点；其他控制字符会拒绝。
- 请求体最多 32 KiB；SQL 使用绑定参数。
- 验证错误为 `400`、便签不存在为 `404`、数据库失败为 `500`，这些业务响应使用 `{"error":"..."}`。
- 每次成功 POST 都代表一条新的打印命令，不提供跨请求幂等键；网络超时后重试可能创建新记录。

```json
{
  "seq": 1,
  "id": "82142e7b-2ba4-4002-9309-32b2073e3f28",
  "text": "Hello, paper.",
  "source": "http",
  "created_at": "2026-10-28T12:00:00+00:00",
  "x": null,
  "y": null,
  "rotation": 0.5,
  "z_index": 1,
  "archived": false
}
```

### 其他路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/api/notes?limit=20&offset=0` | 历史，按 seq 倒序；limit 1–100 |
| GET | `/api/notes?archived=false` | 筛选仍在桌面的便签；省略 archived 则返回全部 |
| PATCH | `/api/notes/{id}` | 更新 `x`、`y`、`z_index`、`archived`，均可选；坐标必须成对提供 |
| GET | `/api/inspire?kind=love` | 灵感；kind 可选 `love`、`poetry`、`lyrics`；不自动打印 |
| GET | `/api/events` | SSE：`sync`、`printed`、`updated`；15 秒保活 |

坐标范围为 0–100000 的有限数；z_index 为 1–2000000000 的整数。

### 替换灵感 API

```bash
NOTE_PROVIDER_URL=https://your-service.example/generate cargo run -- serve
```

服务端向该地址 POST `{"kind":"poetry"}`，对方返回 `{"text":"生成的文字"}`。生成文本会验证长度、空白和控制字符，失败时返回本地内容。API 密钥不要写入前端；需要特殊鉴权、流式响应或不同响应结构时，在 `InspirationProvider` 后增加适配器即可，打印代码不变。

## 资源出处

- Space Mono、VT323：Google Fonts，OFL 字体许可证随文件存放在 `static/assets/*-LICENSE.txt`。
- 塑料与纸张颗粒：与参考站一致的 Transparent Textures `concrete-wall.png` 和 `notebook.png`；来源 <https://www.transparenttextures.com/>，使用时请保留此出处说明。
- 字体、纹理和前端代码均由 Rust 编译时嵌入二进制，启动不依赖 CDN、npm 或 Node.js。

## 验证

```bash
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings

# Node.js 只用于开发测试，运行应用不需要
npm ci
npx playwright install chromium
npm run test:e2e
```

浏览器测试会启动独立的 `127.0.0.1:3918` 测试服务，使用系统临时目录中的独立 SQLite 数据库，不读取默认 `printer.db`。

已覆盖：

- Rust：持久化与重启恢复、验证、Unicode、分页、归档和恢复、并发打印、HTTP 契约、SSE、灵感种类、静态资源白名单。
- Chromium：指定 RGB、空文本禁用、打印与出纸、拖动持久化、红心逐字输入、键盘快捷键、HTTP／CLI 实时出纸与去重、历史恢复和重打、失败保留输入。
- 布局：1200×800、390×844、375×667、844×390，超长便签保持在画布内。
- 音频：上传自定义 WAV 后刷新仍可使用；分析实际波形能量，验证噗噗和热敏两种合成模式确实输出音频。

尚未进行 Safari／Firefox、真实手机扬声器与长时间压力测试；不同平台的中文字体、音频设备与 Web Audio 实现可能带来细微差异。
