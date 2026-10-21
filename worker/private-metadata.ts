/** OAuth metadata is account-scoped; shared rows are identity-only placeholders. */
import type { ExternalVideo } from "./db";
import { isoInDays } from "./http";

export function privateVideoStatements(
  db: D1Database,
  accountId: string,
  video: ExternalVideo,
  now: string,
  expiresAt: string,
  details = false,
): D1PreparedStatement[] {
  const metadata: Record<string, unknown> = {
    ...(details ? { _detailsExpired: null } : {}),
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    title: video.title,
    description: video.description,
    thumbnailUrl: video.thumbnailUrl,
    publishedAt: video.publishedAt,
  };
  if (details || video.durationSeconds != null)
    metadata.durationSeconds = video.durationSeconds;
  if (details || video.viewCount != null) metadata.viewCount = video.viewCount;
  if (details || video.isLive != null) metadata.isLive = video.isLive ?? null;
  if (details || video.liveBroadcastContent != null)
    metadata.liveBroadcastContent = video.liveBroadcastContent ?? null;
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO videos
 (id,channel_id,title,published_at,source,fetched_at,expires_at,created_at,updated_at)
 SELECT ?,'','Vídeo de YouTube','1970-01-01T00:00:00.000Z','youtube',?,?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND connected=1)`,
      )
      .bind(video.id, now, expiresAt, now, now, accountId),
    db
      .prepare(
        `INSERT INTO account_video_metadata
 (account_id,video_id,metadata,fetched_at,expires_at,details_fetched_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND connected=1)
 ON CONFLICT(account_id,video_id) DO UPDATE SET
 metadata=json_patch(account_video_metadata.metadata,excluded.metadata),
 fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,
 details_fetched_at=COALESCE(excluded.details_fetched_at,account_video_metadata.details_fetched_at)
 WHERE json_patch(account_video_metadata.metadata,excluded.metadata)<>account_video_metadata.metadata
 OR account_video_metadata.expires_at<=?
 OR (excluded.details_fetched_at IS NOT NULL AND account_video_metadata.details_fetched_at IS NULL)`,
      )
      .bind(
        accountId,
        video.id,
        JSON.stringify(metadata),
        now,
        expiresAt,
        details ? now : null,
        accountId,
        isoInDays(3, new Date(now)),
      ),
  ];
}
