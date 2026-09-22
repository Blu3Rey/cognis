/**
 * Migration 006 — telemetry quality columns.
 *
 * A reading session is attested: it is what the device observed. Whether that
 * observation is *usable* is a judgment, and it is recorded alongside rather
 * than applied by silently dropping rows — a phone left open on an article
 * produces a real session that is useless as evidence, and the distinction
 * between "did not happen" and "happened but is not trustworthy" matters when
 * the retention model is later fit on this data.
 */

export const id = '006_telemetry';

export const up = `
ALTER TABLE reading_session ADD COLUMN plausible INTEGER NOT NULL DEFAULT 1
  CHECK (plausible IN (0,1));
ALTER TABLE reading_session ADD COLUMN implausible_reason TEXT;
-- Active time after the plausible-reading-rate cap is applied. The raw
-- active_ms is kept unchanged: it is what was observed.
ALTER TABLE reading_session ADD COLUMN capped_active_ms INTEGER;
-- Expected reading time for the content, from word count and a reading rate.
ALTER TABLE reading_session ADD COLUMN expected_reading_ms INTEGER;
ALTER TABLE reading_session ADD COLUMN producer_version TEXT;

CREATE INDEX reading_session_plausible_idx ON reading_session (plausible);
`;
