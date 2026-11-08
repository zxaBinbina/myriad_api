-- 万象同步与备份所需的表。Worker 首次访问时也会执行同样的 CREATE ... IF NOT EXISTS，
-- 所以没跑迁移也能用；保留迁移文件便于 `wrangler d1 migrations` 管理。

-- 每个同步文档的已合并快照：id <= upto 的更新都已合并进 state
CREATE TABLE IF NOT EXISTS sync_docs (
  id TEXT PRIMARY KEY,
  state BLOB,
  state_r2 TEXT,
  upto INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 客户端推送的 Yjs 增量更新（只追加，定期压缩进快照）
CREATE TABLE IF NOT EXISTS sync_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc TEXT NOT NULL,
  data BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_updates_doc ON sync_updates (doc, id);

-- 杂项设置（备份保留份数等），值为 JSON
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
