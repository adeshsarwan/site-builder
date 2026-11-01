CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  domain        TEXT NOT NULL UNIQUE,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',   -- queued | running | waiting | live | live_with_warnings | failed
  current_step  TEXT,
  progress      INTEGER NOT NULL DEFAULT 0,
  input_json    TEXT NOT NULL,
  zone_id       TEXT,
  nameservers   TEXT,                             -- JSON array
  live_url      TEXT,
  error         TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS steps (
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  position    INTEGER NOT NULL,
  label       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending | running | waiting | done | warning | skipped | failed
  detail      TEXT,
  output_json TEXT,
  started_at  TEXT,
  finished_at TEXT,
  PRIMARY KEY (site_id, key)
);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id  TEXT NOT NULL,
  ts       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  step     TEXT,
  status   TEXT,
  message  TEXT
);
CREATE INDEX IF NOT EXISTS events_site ON events(site_id, id);
