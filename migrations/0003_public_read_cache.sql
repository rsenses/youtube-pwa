-- Public API response indexes only; never OAuth tokens or private responses.
CREATE TABLE public_read_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_public_read_cache_expiry ON public_read_cache(expires_at);
