'use strict';

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// 把抛出异常（含异步）的路由统一交给错误中间件处理
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const NAME_RE = /^[\w一-龥][\w一-龥 .\-]{0,63}$/u;

function requireActor(body) {
  const actor = String((body && body.actor) || '').trim();
  if (!actor) {
    throw new HttpError(400, 'actor_required', '请填写操作人（用于修订留痕）');
  }
  if (!NAME_RE.test(actor)) {
    throw new HttpError(400, 'actor_invalid', '操作人长度 1-64，仅支持中英文、数字、空格、点、连字符与下划线');
  }
  return actor;
}

function parseInt(value, field) {
  // 只接受十进制整数（拒绝 1.5、1e3、0x10 等写法）
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    throw new HttpError(400, 'invalid_integer', `参数 ${field} 必须是整数毫秒值`);
  }
  const n = Number(value.trim());
  if (!Number.isSafeInteger(n)) {
    throw new HttpError(400, 'invalid_integer', `参数 ${field} 超出整数范围`);
  }
  return n;
}

/**
 * 校验单条字幕片段。
 * 规则：
 *  - 文本非空，长度 1-2000
 *  - 起点 >= 0，终点 <= 视频时长
 *  - 起点必须严格早于终点
 *  - 同一视频内片段时间区间不得重叠（允许端点相接：[0,1000) 与 [1000,2000) 合法）
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{start_ms:number,end_ms:number,text:string}} input
 * @param {number} videoId
 * @param {number|null} selfId 更新时传入当前片段 id，以排除自身
 * @returns {{start_ms:number,end_ms:number,text:string}} 规整后的数据
 */
function validateSegment(db, input, videoId, selfId) {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'bad_request', '请求体必须是 JSON 对象');
  }
  const startMs = parseInt(input.start_ms, 'start_ms');
  const endMs = parseInt(input.end_ms, 'end_ms');
  const text = typeof input.text === 'string' ? input.text.replace(/\r\n/g, '\n').trim() : '';

  const errors = [];
  if (startMs < 0) errors.push('起点时间不能为负');
  if (text.length === 0) {
    errors.push('字幕文本不能为空');
  } else if (text.length > 2000) {
    errors.push('字幕文本不能超过 2000 个字符');
  }

  const video = db.prepare('SELECT duration_ms FROM videos WHERE id = ?').get(videoId);
  if (!video) throw new HttpError(404, 'video_not_found', '视频不存在');

  if (startMs >= endMs) {
    errors.push(`起点（${startMs} ms）必须严格早于终点（${endMs} ms）`);
  }
  if (endMs > video.duration_ms) {
    errors.push(`终点（${endMs} ms）超出视频时长（${video.duration_ms} ms）`);
  }
  if (startMs > video.duration_ms) {
    errors.push(`起点（${startMs} ms）超出视频时长（${video.duration_ms} ms）`);
  }

  if (errors.length) {
    throw new HttpError(422, 'segment_invalid', '字幕片段不合法：' + errors.join('；'), { errors });
  }

  // 区间重叠：[a,b) 与 [c,d) 重叠当且仅当 a < d && c < b
  const overlap = db.prepare(`
    SELECT id, start_ms, end_ms, text, revision
      FROM segments
     WHERE video_id = ?
       AND (? IS NULL OR id <> ?)
       AND start_ms < ? AND end_ms > ?
     LIMIT 1
  `).get(videoId, selfId, selfId, endMs, startMs);

  if (overlap) {
    throw new HttpError(422, 'segment_overlap',
      `时间区间与片段 #${overlap.id} 重叠（${overlap.start_ms}–${overlap.end_ms} ms），请先调整另一片段`,
      { conflicts_with: mapSegment(overlap) });
  }

  return { start_ms: startMs, end_ms: endMs, text };
}

function mapSegment(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    text: row.text,
    reviewed: !!row.reviewed,
    revision: row.revision,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function mapVideo(row, stats) {
  return {
    id: row.id,
    title: row.title,
    origin_name: row.origin_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stats: stats || mapVideoStats(row)
  };
}

// 视频列表用 join 聚合，详情用独立计数
const videoStatsSelect = `
  COUNT(s.id) AS segment_count,
  COALESCE(SUM(s.reviewed), 0) AS reviewed_count,
  (SELECT COUNT(*) FROM publications p WHERE p.video_id = v.id) AS published_count
`;

function mapVideoStats(row) {
  return {
    segment_count: row.segment_count ?? 0,
    reviewed_count: row.reviewed_count ?? 0,
    published_count: row.published_count ?? 0
  };
}

function getVideoOr404(db, id) {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!video) throw new HttpError(404, 'video_not_found', '视频不存在');
  return video;
}

function getSegmentOr404(db, id) {
  const seg = db.prepare('SELECT * FROM segments WHERE id = ?').get(id);
  if (!seg) throw new HttpError(404, 'segment_not_found', '字幕片段不存在');
  return seg;
}

function listSegments(db, videoId) {
  return db.prepare('SELECT * FROM segments WHERE video_id = ? ORDER BY start_ms, id').all(videoId).map(mapSegment);
}

/**
 * 乐观并发：所有编辑/审校/删除都必须携带“所见修订号”。
 * 修订不一致时返回 409 及当前内容，由用户决定如何处理，绝不覆盖他人修改。
 */
function assertRevision(clientRevision, current) {
  const expected = parseInt(clientRevision, 'revision');
  if (expected !== current.revision) {
    throw new HttpError(409, 'revision_conflict',
      `修订冲突：该片段已被 ${current.updated_by} 修改（你持有的是修订 #${expected}，当前为修订 #${current.revision}）`,
      { current: mapSegment(current) });
  }
}

/**
 * 发布前整体校验：至少一个片段、时间合法、全部已审、无重叠。
 * 单条写入时已做过强校验，这里再做一次完整事务级复核。
 */
function assertPublishable(segments, durationMs) {
  const problems = [];
  if (segments.length === 0) problems.push('至少需要一个字幕片段');

  let unreviewed = 0;
  let lastEnd = -1;
  let lastId = null;
  for (const s of segments) {
    if (!s.reviewed) unreviewed++;
    if (s.start_ms < 0 || s.end_ms <= s.start_ms || s.end_ms > durationMs) {
      problems.push(`片段 #${s.id} 时间不合法（${s.start_ms}–${s.end_ms} ms）`);
    }
    if (lastId !== null && s.start_ms < lastEnd) {
      problems.push(`片段 #${lastId} 与片段 #${s.id} 时间重叠`);
    }
    lastEnd = s.end_ms;
    lastId = s.id;
  }
  if (unreviewed > 0) problems.push(`还有 ${unreviewed} 个片段未审校`);

  if (problems.length) {
    throw new HttpError(409, 'not_publishable', '当前草稿不满足发布条件', { problems });
  }
}

module.exports = {
  HttpError,
  wrap,
  requireActor,
  parseInt,
  validateSegment,
  assertRevision,
  assertPublishable,
  mapSegment,
  mapVideo,
  mapVideoStats,
  videoStatsSelect,
  getVideoOr404,
  getSegmentOr404,
  listSegments
};
