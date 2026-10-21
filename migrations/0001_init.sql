-- Local-only PWA schema. Timestamps are ISO-8601 UTC strings.
-- External YouTube metadata is renewable (expires_at) and can be soft-purged
-- without losing the user's own watch state.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'real')),
  name TEXT NOT NULL DEFAULT '',
  youtube_channel_id TEXT,
  connected INTEGER NOT NULL DEFAULT 0 CHECK (connected IN (0, 1)),
  scopes TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_youtube_channel
  ON accounts(youtube_channel_id) WHERE youtube_channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_attempts_expires ON oauth_attempts(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_attempts_session ON oauth_attempts(session_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  scopes TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  key_version TEXT NOT NULL DEFAULT 'v1',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT,
  source TEXT NOT NULL DEFAULT 'fixture' CHECK (source IN ('fixture', 'youtube')),
  fetched_at TEXT,
  expires_at TEXT,
  purged_at TEXT,
  last_synced_at TEXT,
  rss_etag TEXT,
  rss_last_modified TEXT,
  rss_failures INTEGER NOT NULL DEFAULT 0 CHECK (rss_failures >= 0),
  rss_next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_expires ON channels(expires_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  remote_subscription_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  generation TEXT,
  last_verified_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_channel ON subscriptions(channel_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(account_id, active);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_title TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  view_count INTEGER CHECK (view_count IS NULL OR view_count >= 0),
  source TEXT NOT NULL DEFAULT 'fixture' CHECK (source IN ('fixture', 'youtube', 'rss')),
  fetched_at TEXT NOT NULL,
  expires_at TEXT,
  purged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_feed ON videos(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_videos_channel_feed ON videos(channel_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_expires ON videos(expires_at);

CREATE TABLE IF NOT EXISTS watch_states (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  watched INTEGER NOT NULL DEFAULT 0 CHECK (watched IN (0, 1)),
  watched_at TEXT,
  position_seconds REAL NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  percent REAL NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100),
  manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_watch_states_watched ON watch_states(account_id, watched);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('local', 'youtube')),
  remote_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  privacy_status TEXT,
  remote_item_count INTEGER,
  fetched_at TEXT,
  items_synced_at TEXT,
  seeded INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playlists_account ON playlists(account_id);
-- Nullable remote_id: SQLite treats NULLs as distinct, so many local playlists
-- can coexist while remote ids stay unique per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_remote ON playlists(account_id, remote_id);

CREATE TABLE IF NOT EXISTS playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  remote_item_id TEXT,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  sync_generation TEXT,
  added_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playlist_items_order ON playlist_items(playlist_id, position, id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_video ON playlist_items(video_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_items_remote ON playlist_items(playlist_id, remote_item_id);

CREATE TABLE IF NOT EXISTS preferences (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  watch_threshold INTEGER NOT NULL DEFAULT 90 CHECK (watch_threshold BETWEEN 1 AND 100),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  cursor TEXT,
  last_run_at TEXT,
  last_status TEXT,
  PRIMARY KEY (account_id, type)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'error', 'noop')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  items INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  detail TEXT,
  mode TEXT NOT NULL DEFAULT 'real' CHECK (mode IN ('demo', 'real'))
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_account_time ON sync_runs(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_state_lease ON sync_state(lease_expires_at);
