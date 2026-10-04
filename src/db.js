'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const DB_FILE = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(VIDEO_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS videos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  filename    TEXT    NOT NULL,
  origin_name TEXT    NOT NULL,
  mime_type   TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms   INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms     INTEGER NOT NULL CHECK (end_ms > 0),
  text       TEXT    NOT NULL,
  reviewed   INTEGER NOT NULL DEFAULT 0,
  revision   INTEGER NOT NULL DEFAULT 1,
  created_by TEXT    NOT NULL,
  updated_by TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_segments_video ON segments(video_id, start_ms);

CREATE TABLE IF NOT EXISTS publications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_by TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(video_id, version)
);

CREATE TABLE IF NOT EXISTS published_segments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  video_id     INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  text         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pub_seg_pub ON published_segments(publication_id, seq);
`);

// next_version 作为发布时计算的聚合，不用触发器维护，避免“未发布版本号”被读者感知。

module.exports = { db, DATA_DIR, VIDEO_DIR, DB_FILE };
