-- A channel feed may contain a video owned by another channel.
-- Preserve discovery provenance without falsifying the video's owner.
CREATE TABLE video_discoveries (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (video_id, channel_id)
);
CREATE INDEX idx_discoveries_channel_video ON video_discoveries(channel_id, video_id);
INSERT INTO video_discoveries (video_id, channel_id, last_seen_at)
SELECT v.id, v.channel_id, v.fetched_at FROM videos v
JOIN channels c ON c.id = v.channel_id WHERE v.source = 'rss';
-- Re-read old feeds once so formerly discarded cross-channel entries are recovered.
UPDATE channels SET rss_etag = NULL, rss_last_modified = NULL WHERE source <> 'fixture';
