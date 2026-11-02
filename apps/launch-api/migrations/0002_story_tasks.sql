-- Story-writing tasks (add / rewrite) and per-story progress, for the frontend.
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  site_slug   TEXT NOT NULL,
  kind        TEXT NOT NULL,                       -- add | rewrite
  status      TEXT NOT NULL DEFAULT 'queued',      -- queued | planning | writing | deploying | complete | failed
  total       INTEGER NOT NULL DEFAULT 0,
  written     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  run_key     TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS tasks_site ON tasks(site_slug, created_at);

CREATE TABLE IF NOT EXISTS task_items (
  task_id     TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  slug        TEXT NOT NULL,
  category    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending | writing | written | published | failed
  error       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (task_id, idx)
);
