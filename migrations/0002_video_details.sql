-- API details have their own freshness: an RSS refresh must not extend old API statistics.
ALTER TABLE videos ADD COLUMN is_live INTEGER CHECK (is_live IN (0,1));
ALTER TABLE videos ADD COLUMN details_fetched_at TEXT;
ALTER TABLE videos ADD COLUMN details_expires_at TEXT;
UPDATE videos SET is_live = 0 WHERE source = 'fixture';
CREATE INDEX idx_videos_details_expiry ON videos(details_expires_at) WHERE details_expires_at IS NOT NULL;
