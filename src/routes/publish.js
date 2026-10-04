'use strict';

const express = require('express');
const { db } = require('../db');
const {
  HttpError, wrap, requireActor, parseInt: parseIntMs,
  assertPublishable, getVideoOr404, listSegments, mapSegment
} = require('../util');

const router = express.Router({ mergeParams: true });

function mapPublication(row, segments) {
  return {
    id: row.id,
    video_id: row.video_id,
    version: row.version,
    note: row.note,
    created_by: row.created_by,
    created_at: row.created_at,
    segments: segments
      ? segments.map((s) => ({
          seq: s.seq,
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          text: s.text
        }))
      : undefined
  };
}

// GET /api/videos/:id/publish/status —— 发布前检查
router.get('/status', wrap((req, res) => {
  const id = parseIntMs(req.params.id, 'id');
  const video = getVideoOr404(db, id);
  const segments = listSegments(db, id);
  const problems = collectProblems(segments, video.duration_ms);
  res.json({
    publishable: problems.length === 0,
    segment_count: segments.length,
    reviewed_count: segments.filter((s) => s.reviewed).length,
    problems
  });
}));

function collectProblems(segments, durationMs) {
  const problems = [];
  if (segments.length === 0) {
    problems.push('至少需要一个字幕片段');
    return problems;
  }
  const unreviewed = [];
  let lastEnd = -1;
  let lastId = null;
  for (const s of segments) {
    if (!s.reviewed) unreviewed.push(s.id);
    if (s.start_ms < 0 || s.end_ms <= s.start_ms || s.end_ms > durationMs) {
      problems.push(`片段 #${s.id} 时间不合法（${s.start_ms}–${s.end_ms} ms）`);
    }
    if (lastId !== null && s.start_ms < lastEnd) {
      problems.push(`片段 #${lastId} 与片段 #${s.id} 时间重叠`);
    }
    lastEnd = s.end_ms;
    lastId = s.id;
  }
  if (unreviewed.length) problems.push(`还有 ${unreviewed.length} 个片段未审校`);
  return problems;
}

// GET /api/videos/:id/publications —— 发布版本列表（不含正文，正文按版本号取）
router.get('/', wrap((req, res) => {
  const id = parseIntMs(req.params.id, 'id');
  getVideoOr404(db, id);
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM published_segments ps WHERE ps.publication_id = p.id) AS segment_count
      FROM publications p WHERE video_id = ? ORDER BY version DESC
  `).all(id);
  res.json(rows.map((r) => ({
    id: r.id,
    version: r.version,
    note: r.note,
    created_by: r.created_by,
    created_at: r.created_at,
    segment_count: r.segment_count
  })));
}));

// GET /api/videos/:id/publications/:version —— 某版本快照
router.get('/:version', wrap((req, res) => {
  const id = parseIntMs(req.params.id, 'id');
  const version = parseIntMs(req.params.version, 'version');
  getVideoOr404(db, id);
  const pub = db.prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?').get(id, version);
  if (!pub) throw new HttpError(404, 'publication_not_found', `已发布版本 v${version} 不存在`);
  const segments = db.prepare('SELECT seq, start_ms, end_ms, text FROM published_segments WHERE publication_id = ? ORDER BY seq').all(pub.id);
  res.json(mapPublication(pub, segments));
}));

// POST /api/videos/:id/publications —— 发布不可变版本
router.post('/', wrap((req, res) => {
  const id = parseIntMs(req.params.id, 'id');
  const video = getVideoOr404(db, id);
  const actor = requireActor(req.body);
  const note = String(req.body.note == null ? '' : req.body.note).trim();
  if (note.length > 500) throw new HttpError(400, 'note_too_long', '发布备注不能超过 500 个字符');

  const create = db.transaction(() => {
    const segments = listSegments(db, id);
    assertPublishable(segments, video.duration_ms);

    const row = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM publications WHERE video_id = ?').get(id);
    const version = row.next_version;

    const info = db.prepare(`
      INSERT INTO publications (video_id, version, note, created_by) VALUES (?, ?, ?, ?)
    `).run(id, version, note, actor);
    const insertSeg = db.prepare(`
      INSERT INTO published_segments (publication_id, video_id, seq, start_ms, end_ms, text)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    segments.forEach((s, i) => insertSeg.run(info.lastInsertRowid, id, i + 1, s.start_ms, s.end_ms, s.text));

    const pub = db.prepare('SELECT * FROM publications WHERE id = ?').get(info.lastInsertRowid);
    const frozen = db.prepare('SELECT seq, start_ms, end_ms, text FROM published_segments WHERE publication_id = ? ORDER BY seq').all(pub.id);
    return { pub, frozen };
  });

  const { pub, frozen } = create();
  res.status(201).json(mapPublication(pub, frozen));
}));

module.exports = { router: router, mapPublication };
