-- Purged rows and cleared detail records must leave the ranges scanned on later retention passes.
DROP INDEX idx_videos_expires;
CREATE INDEX idx_videos_expires ON videos(expires_at) WHERE purged_at IS NULL;
DROP INDEX idx_channels_expires;
CREATE INDEX idx_channels_expires ON channels(expires_at) WHERE purged_at IS NULL;
DROP INDEX idx_videos_details_expiry;
CREATE INDEX idx_videos_details_expiry ON videos(details_expires_at) WHERE details_fetched_at IS NOT NULL;
