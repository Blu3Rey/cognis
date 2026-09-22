/**
 * Migration 004 — quiz items, reviews, memory state.
 *
 * `review` is ATTESTED: it is the graded retrieval outcome the whole retention
 * model is fit on, and it is the one thing here that cannot be recomputed.
 * `quiz_item` and `memory_state` are derived — memory state is recomputable
 * from the review log at any time, which is what makes a scheduler upgrade or
 * a parameter refit safe (docs/adr/0006-fsrs-scheduling.md).
 *
 * Note the deliberate denormalisation on `review`: it snapshots the prompt
 * text and target concept, and `quiz_item_id` is NOT a foreign key. Items are
 * derived and get regenerated; the history of what was actually asked and
 * answered must survive that.
 */

export const id = '004_retention';

export const up = `
CREATE TABLE quiz_item (
  id                   TEXT PRIMARY KEY,
  concept_id           TEXT NOT NULL REFERENCES concept(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL
    CHECK (kind IN ('free_recall','cloze','application','synthesis')),
  prompt               TEXT NOT NULL,
  -- Rubric points, each carrying a citation into the corpus. An item whose
  -- answer cannot be located in its evidence is a defect, not a hard question,
  -- and fails validation before it ever reaches the user.
  expected_points_json TEXT NOT NULL,
  evidence_json        TEXT NOT NULL,
  difficulty_hint      REAL,
  -- Soft retirement: reviews reference items, so they are never deleted.
  retired_at           TEXT,
  retired_reason       TEXT,
  producer_version     TEXT NOT NULL,
  model_id             TEXT NOT NULL,
  prompt_version       TEXT NOT NULL,
  computed_at          TEXT NOT NULL
);
CREATE INDEX quiz_item_concept_idx ON quiz_item (concept_id) WHERE retired_at IS NULL;

CREATE TABLE review (
  id                    TEXT PRIMARY KEY,
  quiz_item_id          TEXT,          -- deliberately NOT a foreign key
  item_prompt_snapshot  TEXT NOT NULL,
  concept_id            TEXT NOT NULL,
  presented_at          TEXT NOT NULL,
  answered_at           TEXT,
  latency_ms            INTEGER,
  -- The user's own words, stored verbatim and never overwritten by a
  -- normalised form: the grade is a judgment that may be re-run, the answer is
  -- the evidence.
  answer_text           TEXT,
  self_rating           INTEGER CHECK (self_rating IS NULL OR self_rating BETWEEN 1 AND 4),
  machine_grade         REAL CHECK (machine_grade IS NULL OR (machine_grade >= 0 AND machine_grade <= 1)),
  machine_rating        INTEGER CHECK (machine_rating IS NULL OR machine_rating BETWEEN 1 AND 4),
  grade_rubric_version  TEXT,
  grade_model_id        TEXT,
  -- A user disagreeing with the grader is signal, not noise.
  user_grade_override   INTEGER CHECK (user_grade_override IS NULL OR user_grade_override BETWEEN 1 AND 4),
  scheduled_for         TEXT,
  -- Written at presentation time. Without it calibration can never be
  -- measured, and an uncalibrated retention model is exactly the false
  -- precision this design exists to avoid.
  predicted_recall      REAL CHECK (predicted_recall IS NULL OR (predicted_recall >= 0 AND predicted_recall <= 1)),
  interval_days         REAL
);
CREATE INDEX review_concept_idx ON review (concept_id, presented_at);
CREATE INDEX review_item_idx    ON review (quiz_item_id);

CREATE TABLE memory_state (
  scope             TEXT NOT NULL CHECK (scope IN ('item','concept')),
  scope_id          TEXT NOT NULL,
  stability         REAL NOT NULL,
  difficulty        REAL NOT NULL,
  last_review_at    TEXT,
  due_at            TEXT NOT NULL,
  reps              INTEGER NOT NULL,
  lapses            INTEGER NOT NULL,
  state             TEXT NOT NULL,
  -- The scheduler's own card, opaque to core. Pinning an implementation means
  -- persisting what it needs rather than a lossy projection of it.
  card_json         TEXT NOT NULL,
  scheduler         TEXT NOT NULL,
  scheduler_version TEXT NOT NULL,
  params_hash       TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
CREATE INDEX memory_state_due_idx ON memory_state (due_at) WHERE scope = 'item';
`;
