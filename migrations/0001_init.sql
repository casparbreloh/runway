CREATE TABLE IF NOT EXISTS credentials (
  provider TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repo_map (
  workspace TEXT NOT NULL,
  key TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (workspace, key)
);

CREATE TABLE IF NOT EXISTS workspace_config (
  workspace TEXT PRIMARY KEY,
  default_repo TEXT,
  default_agent TEXT,
  default_base TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  agent TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
