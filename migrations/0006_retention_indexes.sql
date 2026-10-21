-- Retention runs on API reads, including status polling: use range scans, not full scans.
CREATE INDEX idx_account_metadata_global_expiry ON account_video_metadata(expires_at);
CREATE INDEX idx_account_metadata_global_details ON account_video_metadata(details_fetched_at) WHERE details_fetched_at IS NOT NULL;
CREATE INDEX idx_playlist_metadata_expiry ON playlists(fetched_at) WHERE source='youtube';
CREATE INDEX idx_video_discoveries_seen ON video_discoveries(last_seen_at);
