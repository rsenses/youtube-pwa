-- Catalog import probes only the next unimported list for this account.
CREATE INDEX IF NOT EXISTS idx_playlists_unimported
  ON playlists(account_id, id)
  WHERE source='youtube' AND items_synced_at IS NULL;

-- Covers the final remote-id comparison without fetching every item row.
CREATE INDEX IF NOT EXISTS idx_playlist_items_snapshot
  ON playlist_items(playlist_id, added_at, remote_item_id);
