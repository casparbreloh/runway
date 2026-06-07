CREATE TABLE IF NOT EXISTS credentials (
  provider TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  agent TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
