-- User preferences stay local to Alveo; original YouTube memberships remain intact.
ALTER TABLE subscriptions ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0,1));
ALTER TABLE playlists ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0,1));
CREATE INDEX idx_subscriptions_included_channel ON subscriptions(channel_id,account_id)
  WHERE active=1 AND excluded=0;
CREATE INDEX idx_playlists_account_excluded ON playlists(account_id,excluded,source,id);

