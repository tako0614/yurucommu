-- Takoform applies each migration file atomically with foreign keys enabled.
-- Rebuild the sole referencing table first so replacing activities cannot
-- cascade-delete inbox rows. This is the D1-safe form of the locked core
-- package migration, whose connection-level FK disable is ineffective on D1.

PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE inbox_new (
  actor_ap_id TEXT NOT NULL REFERENCES actors(ap_id) ON DELETE CASCADE,
  activity_ap_id TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (actor_ap_id, activity_ap_id)
);

INSERT INTO inbox_new (actor_ap_id, activity_ap_id, read, created_at)
SELECT actor_ap_id, activity_ap_id, read, created_at FROM inbox;

DROP TABLE inbox;
ALTER TABLE inbox_new RENAME TO inbox;

CREATE INDEX idx_inbox_actor_read ON inbox(actor_ap_id, read, created_at DESC);
CREATE INDEX idx_inbox_activity ON inbox(activity_ap_id);

CREATE TABLE IF NOT EXISTS activities (
  ap_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor_ap_id TEXT NOT NULL,
  object_ap_id TEXT,
  object_json TEXT,
  target_ap_id TEXT,
  raw_json TEXT NOT NULL,
  direction TEXT,
  processed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activities_new (
  ap_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor_ap_id TEXT NOT NULL,
  object_ap_id TEXT,
  object_json TEXT,
  target_ap_id TEXT,
  raw_json TEXT NOT NULL,
  direction TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO activities_new (
  ap_id,
  type,
  actor_ap_id,
  object_ap_id,
  object_json,
  target_ap_id,
  raw_json,
  direction,
  processed,
  created_at
)
SELECT
  ap_id,
  type,
  actor_ap_id,
  object_ap_id,
  object_json,
  target_ap_id,
  raw_json,
  direction,
  COALESCE(processed, 0),
  COALESCE(created_at, datetime('now'))
FROM activities;

DROP TABLE activities;
ALTER TABLE activities_new RENAME TO activities;

CREATE INDEX IF NOT EXISTS idx_activities_actor ON activities(actor_ap_id);
CREATE INDEX IF NOT EXISTS idx_activities_object ON activities(object_ap_id);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
CREATE INDEX IF NOT EXISTS idx_activities_type_created ON activities(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_direction_processed ON activities(direction, processed);
CREATE INDEX IF NOT EXISTS idx_activities_direction_processed_created ON activities(direction, processed, created_at);
