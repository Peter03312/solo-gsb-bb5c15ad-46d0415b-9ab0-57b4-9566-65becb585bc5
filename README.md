# 字幕校对台 Subtitle Studio

供小团队在浏览器里协作校对视频字幕的 Web 应用：上传本机视频 → 在时间轴上按毫秒增删改字幕片段 → 审校 → 发布不可变版本 → 下载 SRT。视频文件与 SQLite 数据库都保存在运行服务的本机磁盘上，不依赖任何外部服务。

## 功能一览

- **视频管理**：浏览器上传（mp4 / webm / ogg / mov / mkv），本机存储，浏览器内播放（支持拖动进度条的 Range 请求）。
- **毫秒级片段编辑**：按起点/终点毫秒增、删、改字幕，时间支持 `HH:MM:SS.mmm` 或直接填毫秒；可从视频当前播放位置一键取时。
- **可视化时间轴**：片段按时间比例渲染，点击跳转、双击编辑，播放时画面上叠加当前字幕。
- **合法性强校验（服务端 + 界面）**：
  - 起点必须严格早于终点；
  - 起点/终点不得为负，终点不得超过视频时长；
  - 同一视频片段时间区间不得重叠（允许首尾相接，如 `[0,1000)` 与 `[1000,2000)`）；
  - 字幕文本不能为空。
  - 非法修改返回 **422 并逐条说明原因**，数据库中**原稿原样保留**，表单内容也不丢失。
- **乐观并发控制（修订号）**：每个片段带 `revision`，新增即为修订 #1。**修改、审校、删除都必须携带当前所见修订号**；修订过期返回 **409 冲突、提示是谁改的、并附上服务端当前内容**，前端弹出“你的原稿 vs 当前内容”对比窗，可基于最新修订重试或放弃——绝不会静默覆盖他人修改。界面每 5 秒自动拉取一次最新数据（正在输入时不打断）。
- **审校状态**：片段可标记“已审 / 取消审校”；**修改已审片段的任一字段会自动撤销审校状态**，需要重新审校。
- **发布门禁与不可变版本**：仅当“至少 1 个片段、全部已审、时间合法且无重叠”时才能发布。发布把当前片段**快照**为不可变版本（v1、v2……），之后的编辑只影响草稿，历史版本永不改变。
- **SRT 导出**：可下载**草稿**或任意**已发布版本**的 SRT（CRLF + UTF-8 BOM，中文友好）。

## 技术栈

Node.js 20 + Express + better-sqlite3（同步事务，WAL）+ 原生 HTML/CSS/JS 时间轴界面，无前端构建步骤。

## 一键启动（Docker Compose，推荐）

前置：已安装 Docker 与 Docker Compose v2。

```bash
docker compose up -d --build
```

首次启动会自动构建镜像、安装依赖，并在容器启动时**自动建表初始化 SQLite 数据库**。

访问地址：<http://localhost:3000>

停止：`docker compose down`（数据保留在本机 `./data`，不会删除）。

## 本机直接运行（Node.js）

要求 Node.js >= 20。

```bash
npm install
npm start
```

访问地址：<http://localhost:3000>

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口（Compose 中可用同名环境变量改宿主机映射端口，如 `PORT=8080 docker compose up -d`） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data`（本机）/ `/data`（容器） | 数据根目录：`app.db`（SQLite）与 `videos/`（上传的视频文件）都在其中 |
| `MAX_UPLOAD_MB` | `2048` | 单个视频上传大小上限（MB） |

## 数据与备份

- `data/app.db`：全部字幕数据（视频记录、草稿片段、发布版本快照）。
- `data/videos/`：上传的视频原文件。
- 备份时停服或利用 SQLite WAL 快照复制整个 `data/` 目录即可。

## 主要 HTTP API

所有写操作都要求 JSON 字段 `actor`（操作人，1–64 字符，用于修订留痕）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/videos` | 视频列表（含片段/审校/版本统计） |
| POST | `/api/videos` | 上传视频（multipart：`video` 文件、`title`、`duration_ms`） |
| GET | `/api/videos/:id` | 视频详情 + 草稿片段 + 版本列表 |
| DELETE | `/api/videos/:id` | 删除视频及全部数据与文件 |
| GET | `/api/videos/:id/media` | 视频流（支持 `Range`） |
| GET | `/api/videos/:id/segments` | 草稿片段列表 |
| POST | `/api/videos/:id/segments` | 新增片段 `{start_ms,end_ms,text,actor}` |
| PUT | `/api/videos/:id/segments/:segId` | 修改片段（须带 `revision`） |
| POST | `/api/videos/:id/segments/:segId/review` | 审校/取消（须带 `revision`、`reviewed`） |
| DELETE | `/api/videos/:id/segments/:segId?revision=N` | 删除片段（须带修订号） |
| GET | `/api/videos/:id/publish/status` | 是否满足发布条件及原因 |
| POST | `/api/videos/:id/publications` | 发布不可变版本 `{actor,note?}` |
| GET | `/api/videos/:id/publications` | 已发布版本列表 |
| GET | `/api/videos/:id/publications/:version` | 指定版本快照 |
| GET | `/api/videos/:id/srt?version=draft\|N` | 下载草稿或某版本 SRT |

冲突响应示例（HTTP 409）：

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "修订冲突：该片段已被 Bob 修改（你持有的是修订 #1，当前为修订 #2）",
    "details": { "current": { "id": 1, "revision": 2, "text": "……" } }
  }
}
```

## 目录结构

```
├── Dockerfile
├── docker-compose.yml
├── package.json
├── src/
│   ├── server.js          # Express 入口、错误处理、优雅退出
│   ├── db.js              # SQLite 连接与建表初始化
│   ├── util.js            # 校验、乐观锁、发布门禁
│   ├── srt.js             # SRT 生成
│   └── routes/
│       ├── videos.js      # 上传/列表/媒体流/SRT 下载
│       ├── segments.js    # 片段增删改 + 审校（修订号）
│       └── publish.js     # 发布状态/版本快照
└── public/                # 浏览器时间轴界面（无构建）
    ├── index.html
    ├── styles.css
    └── app.js
```
