-- One global weekly pass, continued in bounded pages by the existing cron.
-- Video-key lookups also bound FK cascade checks when deleting old rows.
CREATE INDEX idx_watch_states_video_owner ON watch_states(video_id, account_id, watched);
CREATE INDEX idx_account_video_metadata_video_owner ON account_video_metadata(video_id, account_id);
CREATE TABLE video_retention_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  next_run_at TEXT NOT NULL,
  cursor_date TEXT,
  cursor_id TEXT,
  claim_token TEXT,
  claim_expires_at TEXT
);
INSERT INTO video_retention_state(id,next_run_at) VALUES(1,'1970-01-01T00:00:00.000Z');
