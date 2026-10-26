-- Locally followed YouTube playlists are read-only and survive owned catalog syncs.
ALTER TABLE playlists ADD COLUMN followed INTEGER NOT NULL DEFAULT 0 CHECK (followed IN (0,1));
CREATE INDEX idx_playlists_owned_remote ON playlists(account_id,source,followed,remote_id)
  WHERE source='youtube';
