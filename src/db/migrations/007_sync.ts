/**
 * Migration 007 — sync state and change tracking.
 *
 * Change tracking uses SQLite triggers rather than threading an outbox write
 * through every pipeline. A trigger cannot be forgotten by a new call site,
 * which matters: a sync that silently misses rows because someone added a
 * write path is the kind of bug that surfaces months later as "my other phone
 * is missing March".
 *
 * Only ATTESTED tables are tracked. Derived data is not synced at all — it is
 * recomputed on the receiving device, which is both cheaper than shipping
 * vectors over the wire and the reason the attested/derived split exists.
 */

export const id = '007_sync';

export const up = `
CREATE TABLE sync_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  device_id     TEXT NOT NULL,
  keyset_json   TEXT,
  -- Relay cursor: everything up to here has been pulled and merged.
  pull_cursor   TEXT,
  last_push_at  TEXT,
  last_pull_at  TEXT
);

CREATE TABLE sync_dirty (
  table_name TEXT NOT NULL,
  row_id     TEXT NOT NULL,
  marked_at  TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id)
);
CREATE INDEX sync_dirty_marked_idx ON sync_dirty (marked_at);

-- Attested tables only. Each gets insert and update triggers; deletes are not
-- tracked, because deletion is deliberately local (docs/09): a corpus deleted
-- on one device is not automatically deleted everywhere, and a user who wants
-- that does it per device.
CREATE TRIGGER source_dirty_ins AFTER INSERT ON source BEGIN
  INSERT INTO sync_dirty (table_name, row_id, marked_at)
  VALUES ('source', NEW.id, datetime('now'))
  ON CONFLICT (table_name, row_id) DO UPDATE SET marked_at = datetime('now');
END;
CREATE TRIGGER source_dirty_upd AFTER UPDATE ON source BEGIN
  INSERT INTO sync_dirty (table_name, row_id, marked_at)
  VALUES ('source', NEW.id, datetime('now'))
  ON CONFLICT (table_name, row_id) DO UPDATE SET marked_at = datetime('now');
END;

CREATE TRIGGER ingestion_event_dirty_ins AFTER INSERT ON ingestion_event BEGIN
  INSERT INTO sync_dirty (table_name, row_id, marked_at)
  VALUES ('ingestion_event', NEW.id, datetime('now'))
  ON CONFLICT (table_name, row_id) DO UPDATE SET marked_at = datetime('now');
END;
CREATE TRIGGER ingestion_event_dirty_upd AFTER UPDATE ON ingestion_event BEGIN
  INSERT INTO sync_dirty (table_name, row_id, marked_at)
  VALUES ('ingestion_event', NEW.id, datetime('now'))
  ON CONFLICT (table_name, row_id) DO UPDATE SET marked_at = datetime('now');
END;

CREATE TRIGGER annotation_dirty_ins AFTER INSERT ON annotation BEGIN
  INSERT INTO sync_dirty (table_name, row_id, marked_at)
  VALUES ('annotation', NEW.id, datetime('now'))
  ON CONFLICT (table_name, row_id) DO UPDATE SET marked_at = datetime('now');
END;

CREATE TRIGGER reading_session_dirty_ins AFTER INSERT ON reading_session BEGIN
  INSERT INTO sync_dirty (table_name, row_id, marked_at)
  VALUES ('reading_session', NEW.id, datetime('now'))
  ON CONFLICT (table_name, row_id) DO UPDATE SET marked_at = datetime('now');
END;

CREATE TRIGGER review_dirty_ins AFTER INSERT ON review BEGIN
  INSERT INTO sync_dirty (table_name, row_id, marked_at)
  VALUES ('review', NEW.id, datetime('now'))
  ON CONFLICT (table_name, row_id) DO UPDATE SET marked_at = datetime('now');
END;
CREATE TRIGGER review_dirty_upd AFTER UPDATE ON review BEGIN
  INSERT INTO sync_dirty (table_name, row_id, marked_at)
  VALUES ('review', NEW.id, datetime('now'))
  ON CONFLICT (table_name, row_id) DO UPDATE SET marked_at = datetime('now');
END;

CREATE TRIGGER user_assertion_dirty_ins AFTER INSERT ON user_assertion BEGIN
  INSERT INTO sync_dirty (table_name, row_id, marked_at)
  VALUES ('user_assertion', NEW.id, datetime('now'))
  ON CONFLICT (table_name, row_id) DO UPDATE SET marked_at = datetime('now');
END;
`;
