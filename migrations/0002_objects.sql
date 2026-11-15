-- 无 R2 时，备份、文件和大同步快照分块存进 D1。
CREATE TABLE IF NOT EXISTS stored_objects (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  metadata TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS object_chunks (
  key TEXT NOT NULL REFERENCES stored_objects(key) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key, part)
);
