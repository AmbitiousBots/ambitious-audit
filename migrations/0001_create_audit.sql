CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  collected_at TEXT NOT NULL,
  json TEXT NOT NULL
) STRICT;

CREATE TABLE baselines (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  set_at TEXT NOT NULL
) STRICT;

CREATE TABLE findings (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  rule_id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, rule_id)
) STRICT;

CREATE TABLE recommendations (
  id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, id)
) STRICT;

CREATE TABLE suppressions (
  fingerprint TEXT PRIMARY KEY,
  until TEXT NOT NULL
) STRICT;

CREATE TABLE reports (
  report_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  state TEXT NOT NULL CHECK (state IN ('built', 'reviewed', 'sent', 'acked', 'failed')),
  review_required INTEGER NOT NULL CHECK (review_required IN (0, 1)),
  failures INTEGER NOT NULL CHECK (failures >= 0),
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  fingerprints_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE report_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL REFERENCES reports(report_id),
  state TEXT NOT NULL CHECK (state IN ('built', 'reviewed', 'sent', 'acked', 'failed')),
  at TEXT NOT NULL
) STRICT;
