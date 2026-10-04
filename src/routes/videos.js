'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, VIDEO_DIR } = require('../db');
const {
  HttpError, wrap, requireActor, parseInt: parseIntMs,
  mapVideo, mapVideoStats, videoStatsSelect, getVideoOr404, listSegments
} = require('../util');

const router = express.Router();

const ALLOWED_MIME = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska'
]);

const MIME_EXT = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv'
};

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048);

const storage = multer.diskStorage({
  destination: VIDEO_DIR,
  filename: (req, file, cb) => {
    const ext = MIME_EXT[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `video_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new HttpError(415, 'unsupported_media_type',
        `不支持的视频类型：${file.mimetype}，仅支持 mp4 / webm / ogg / mov / mkv`));
    }
    cb(null, true);
  }
});

// GET /api/videos —— 视频列表（含片段统计）
router.get('/', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT v.*, ${videoStatsSelect}
      FROM videos v
      LEFT JOIN segments s ON s.video_id = v.id
     GROUP BY v.id
     ORDER BY v.created_at DESC, v.id DESC
  `).all();
  res.json(rows.map((r) => mapVideo(r, mapVideoStats(r))));
}));

// POST /api/videos —— 上传视频（multipart：video 文件 + title + duration_ms）
router.post('/', (req, res, next) => {
  upload.single('video')(req, res, (err) => {
    if (err) return next(err);
    next();
  });
}, wrap((req, res) => {
  if (!req.file) {
    throw new HttpError(400, 'file_required', '请选择要上传的视频文件（字段名 video）');
  }
  const title = String(req.body.title || '').trim()
    || path.parse(req.file.originalname).name;
  if (title.length > 200) {
    throw new HttpError(400, 'title_too_long', '标题不能超过 200 个字符');
  }
  const durationMs = parseIntMs(req.body.duration_ms, 'duration_ms');
  if (durationMs <= 0) {
    throw new HttpError(422, 'invalid_duration', '视频时长必须是大于 0 的毫秒整数');
  }

  const info = db.prepare(`
    INSERT INTO videos (title, filename, origin_name, mime_type, size_bytes, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, durationMs);

  res.status(201).json(loadVideo(info.lastInsertRowid));
}));

function loadVideo(id) {
  const row = db.prepare(`
    SELECT v.*, ${videoStatsSelect}
      FROM videos v
      LEFT JOIN segments s ON s.video_id = v.id
     WHERE v.id = ?
     GROUP BY v.id
  `).get(id);
  return mapVideo(row, mapVideoStats(row));
}

// GET /api/videos/:id —— 视频详情 + 全部草稿片段 + 已发布版本摘要
router.get('/:id', wrap((req, res) => {
  const id = parseIntMs(req.params.id, 'id');
  const video = getVideoOr404(db, id);
  const publications = db.prepare(`
    SELECT id, version, note, created_by, created_at,
           (SELECT COUNT(*) FROM published_segments ps WHERE ps.publication_id = publications.id) AS segment_count
      FROM publications
     WHERE video_id = ?
     ORDER BY version DESC
  `).all(id);
  res.json({
    ...loadVideo(id),
    segments: listSegments(db, video.id),
    publications
  });
}));

// DELETE /api/videos/:id —— 删除视频及其片段、发布版本与本机文件
router.delete('/:id', wrap((req, res) => {
  const id = parseIntMs(req.params.id, 'id');
  const video = getVideoOr404(db, id);
  db.prepare('DELETE FROM videos WHERE id = ?').run(id);
  fs.rm(path.join(VIDEO_DIR, video.filename), { force: true }, () => {});
  res.status(204).end();
}));

// GET /api/videos/:id/media —— 视频流（支持 Range 拖动）
router.get('/:id/media', wrap((req, res) => {
  const id = parseIntMs(req.params.id, 'id');
  const video = getVideoOr404(db, id);
  const filePath = path.join(VIDEO_DIR, video.filename);
  if (!fs.existsSync(filePath)) {
    throw new HttpError(410, 'file_missing', '视频文件在本机存储中缺失');
  }
  res.sendFile(filePath, {
    headers: {
      'Content-Type': video.mime_type,
      'Accept-Ranges': 'bytes'
    }
  });
}));

// GET /api/videos/:id/srt?version=draft|N —— 下载字幕
router.get('/:id/srt', wrap((req, res) => {
  const { buildSrt } = require('../srt');
  const id = parseIntMs(req.params.id, 'id');
  const video = getVideoOr404(db, id);
  const version = String(req.query.version || 'draft');

  let segments;
  let label;
  if (version === 'draft') {
    segments = listSegments(db, id);
    label = 'draft';
  } else {
    const versionNo = parseIntMs(version, 'version');
    const pub = db.prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?').get(id, versionNo);
    if (!pub) {
      throw new HttpError(404, 'publication_not_found', `视频没有已发布版本 v${versionNo}`);
    }
    segments = db.prepare(`
      SELECT seq, start_ms, end_ms, text
        FROM published_segments WHERE publication_id = ? ORDER BY seq
    `).all(pub.id);
    label = `v${pub.version}`;
  }

  const srt = buildSrt(segments);
  res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="video_${id}_${label}.srt"; filename*=UTF-8''video_${id}_${label}.srt`);
  res.send(Buffer.from(srt, 'utf8'));
}));

module.exports = { router, loadVideo };
