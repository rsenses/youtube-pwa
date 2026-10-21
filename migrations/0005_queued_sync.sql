-- Durable jobs are the source of truth; Queue messages are disposable wake-ups.
CREATE TABLE sync_jobs (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 type TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','retrying','paused','success','error')),
 state TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0,
 enqueued_version INTEGER NOT NULL DEFAULT -1,
 dispatched_at TEXT,
 lease_owner TEXT,
 lease_expires_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT,
 message TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_sync_jobs_active ON sync_jobs(account_id)
 WHERE status IN ('queued','running','retrying','paused');
CREATE INDEX idx_sync_jobs_account_time ON sync_jobs(account_id, created_at DESC);
CREATE INDEX idx_sync_jobs_recovery ON sync_jobs(status, next_attempt_at, dispatched_at);
CREATE TABLE sync_queue_budget (
 day TEXT PRIMARY KEY,
 sent INTEGER NOT NULL DEFAULT 0
);

-- OAuth can expose private/unlisted metadata. Never publish it in shared rows.
CREATE TABLE account_video_metadata (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
 metadata TEXT NOT NULL,
 fetched_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 details_fetched_at TEXT,
 PRIMARY KEY(account_id,video_id)
);
CREATE INDEX idx_account_video_metadata_expiry ON account_video_metadata(account_id,expires_at);
INSERT INTO account_video_metadata(account_id,video_id,metadata,fetched_at,expires_at,details_fetched_at)
SELECT DISTINCT p.account_id,v.id,
 json_object('channelId',v.channel_id,'channelTitle',v.channel_title,'title',v.title,
 'description',v.description,'thumbnailUrl',v.thumbnail_url,'publishedAt',v.published_at,
 'durationSeconds',v.duration_seconds,'viewCount',v.view_count,'isLive',v.is_live),
 v.fetched_at,COALESCE(v.expires_at,v.fetched_at),v.details_fetched_at
FROM playlists p JOIN playlist_items pi ON pi.playlist_id=p.id JOIN videos v ON v.id=pi.video_id
WHERE p.source='youtube' AND v.source<>'fixture';

-- Existing public RSS/key-verified metadata remains shared. Unknown/private
-- metadata is retained ONLY in the owner rows above, not exposed across users.
DELETE FROM public_read_cache;
UPDATE videos SET title='Vídeo de YouTube',description='',thumbnail_url='',channel_id='',channel_title='',
 duration_seconds=NULL,view_count=NULL,is_live=NULL,details_fetched_at=NULL,details_expires_at=NULL,
 purged_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE source='youtube';
