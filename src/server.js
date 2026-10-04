'use strict';

const express = require('express');
const path = require('path');
const { db } = require('./db');
const { HttpError } = require('./util');
const videosRouter = require('./routes/videos').router;
const segmentsRouter = require('./routes/segments');
const publishRouter = require('./routes/publish').router;

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---- API 路由 ----
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/videos', videosRouter);
app.use('/api/videos/:id/segments', segmentsRouter);
// 发布状态挂在 /publish 下，版本集合挂在 /publications 下
app.use('/api/videos/:id/publish', publishRouter);
app.use('/api/videos/:id/publications', publishRouter);

// ---- 前端静态页面 ----
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- 统一错误处理 ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // multer：文件超限
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = process.env.MAX_UPLOAD_MB || 2048;
    return res.status(413).json({
      error: { code: 'file_too_large', message: `视频文件超过大小上限 ${maxMb} MB` }
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details }
    });
  }
  // body-parser / JSON 解析错误
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: '请求体不是合法 JSON' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: '请求体过大' } });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'internal_error', message: '服务器内部错误' } });
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`字幕校对平台已启动: http://localhost:${PORT}`);
  console.log(`数据库: ${require('./db').DB_FILE}`);
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭……`);
  server.close(() => {
    try { db.close(); } catch (_) { /* ignore */ }
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
