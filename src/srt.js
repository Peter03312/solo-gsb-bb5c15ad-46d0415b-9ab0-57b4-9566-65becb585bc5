'use strict';

// SRT 时间戳：HH:MM:SS,mmm
function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function formatTimestamp(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/**
 * 由已按起点排序的片段生成 SRT。
 * 片段需含 start_ms / end_ms / text；published_segments 用 seq 字段时先映射好顺序。
 * 输出 CRLF + UTF-8 BOM，兼容 Windows 常见播放器对中文字幕的识别。
 */
function buildSrt(segments) {
  const body = segments.map((s, i) => {
    const index = s.seq != null ? s.seq : i + 1;
    const lines = String(s.text)
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');
    return `${index}\r\n${formatTimestamp(s.start_ms)} --> ${formatTimestamp(s.end_ms)}\r\n${lines}`;
  }).join('\r\n\r\n');
  return '﻿' + body + (body ? '\r\n' : '');
}

module.exports = { formatTimestamp, buildSrt };
