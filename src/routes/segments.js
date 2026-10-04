'use strict';

const express = require('express');
const { db } = require('../db');
const {
  HttpError, wrap, requireActor, parseInt: parseIntMs,
  validateSegment, assertRevision, getVideoOr404, getSegmentOr404,
  mapSegment, listSegments
} = require('../util');

const router = express.Router({ mergeParams: true });

function videoId(req) {
  return parseIntMs(req.params.id, 'id');
}

function loadOwnedSegment(id, segId) {
  const current = getSegmentOr404(db, segId);
  if (current.video_id !== id) {
    throw new HttpError(404, 'segment_not_found', '字幕片段不存在');
  }
  return current;
}

// GET /api/videos/:id/segments
router.get('/', wrap((req, res) => {
  const id = videoId(req);
  getVideoOr404(db, id);
  res.json(listSegments(db, id));
}));

// POST /api/videos/:id/segments —— 新增片段（非法则 422 并说明原因，不会产生任何数据）
router.post('/', wrap((req, res) => {
  const id = videoId(req);
  getVideoOr404(db, id);
  const actor = requireActor(req.body);
  const data = validateSegment(db, req.body, id, null);

  const info = db.prepare(`
    INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, created_by, updated_by)
    VALUES (?, ?, ?, ?, 0, 1, ?, ?)
  `).run(id, data.start_ms, data.end_ms, data.text, actor, actor);

  res.status(201).json(mapSegment(getSegmentOr404(db, info.lastInsertRowid)));
}));

// PUT /api/videos/:id/segments/:segId —— 修改片段（须携带 revision）
router.put('/:segId', wrap((req, res) => {
  const id = videoId(req);
  const segId = parseIntMs(req.params.segId, 'segId');
  getVideoOr404(db, id);
  const current = loadOwnedSegment(id, segId);

  const actor = requireActor(req.body);
  assertRevision(req.body.revision, current);
  const data = validateSegment(db, req.body, id, segId);

  // 内容确有变化才递增修订；对已审片段的任何改动都会撤销审校状态。
  const changed = current.start_ms !== data.start_ms
    || current.end_ms !== data.end_ms
    || current.text !== data.text;
  if (!changed) return res.json(mapSegment(current));

  db.prepare(`
    UPDATE segments
       SET start_ms = ?, end_ms = ?, text = ?,
           reviewed = 0,
           revision = revision + 1,
           updated_by = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(data.start_ms, data.end_ms, data.text, actor, segId);

  res.json(mapSegment(getSegmentOr404(db, segId)));
}));

// POST /api/videos/:id/segments/:segId/review —— 审校标记切换 {reviewed:boolean, revision}
router.post('/:segId/review', wrap((req, res) => {
  const id = videoId(req);
  const segId = parseIntMs(req.params.segId, 'segId');
  getVideoOr404(db, id);
  const current = loadOwnedSegment(id, segId);

  const actor = requireActor(req.body);
  assertRevision(req.body.revision, current);

  if (typeof req.body.reviewed !== 'boolean') {
    throw new HttpError(400, 'bad_request', 'reviewed 必须是布尔值');
  }
  const target = req.body.reviewed ? 1 : 0;
  if (current.reviewed === target) return res.json(mapSegment(current));

  db.prepare(`
    UPDATE segments
       SET reviewed = ?, revision = revision + 1, updated_by = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(target, actor, segId);

  res.json(mapSegment(getSegmentOr404(db, segId)));
}));

// DELETE /api/videos/:id/segments/:segId?revision=N —— 删除片段（须携带 revision）
router.delete('/:segId', wrap((req, res) => {
  const id = videoId(req);
  const segId = parseIntMs(req.params.segId, 'segId');
  getVideoOr404(db, id);
  const current = loadOwnedSegment(id, segId);

  // DELETE 没有语义化 body，revision 从 query 读取；前端删除前必须持有当前修订号
  assertRevision(req.query.revision, current);

  db.prepare('DELETE FROM segments WHERE id = ?').run(segId);
  res.status(204).end();
}));

module.exports = router;
