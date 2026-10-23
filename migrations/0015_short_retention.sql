-- Keep only the ID of a discarded short candidate until it ages out of RSS.
ALTER TABLE videos ADD COLUMN short_candidate INTEGER NOT NULL DEFAULT 0 CHECK(short_candidate IN (0,1));
UPDATE videos SET short_candidate=1
  WHERE duration_seconds>0 AND duration_seconds<180
    AND COALESCE(is_live,0)=0 AND COALESCE(live_broadcast_content,'none')='none';
UPDATE videos SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+31 days')
  WHERE short_candidate=1 AND expires_at IS NOT NULL
    AND expires_at<strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+31 days');
CREATE TABLE short_video_tombstones (
  video_id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL
);
CREATE INDEX idx_short_video_tombstones_published ON short_video_tombstones(published_at);
