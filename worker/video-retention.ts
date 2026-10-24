/** Weekly, global deletion of old watched videos. No per-account jobs or fanout. */
import type { Env } from "./types";
import { deleteVideoThumbnails } from "./feed-thumbnails";
import { oldestVideoDate } from "./rss";
import { isWebSubEnabled } from "./websub";

const PAGE_SIZE = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SHORT_REVIEW_MS = 30 * 24 * 60 * 60 * 1000;

/** A crash releases the claim by expiry; the cursor advances only with deletion. */
export async function runWeeklyVideoRetention(
  env: Env,
  now = new Date().toISOString(),
): Promise<number> {
  if (!isWebSubEnabled(env)) return 0;
  const claim = crypto.randomUUID();
  const state = await env.DB.prepare(
    `UPDATE video_retention_state
    SET claim_token=?,claim_expires_at=? WHERE id=1 AND next_run_at<=?
    AND (claim_token IS NULL OR claim_expires_at<=?) RETURNING cursor_date,cursor_id`,
  )
    .bind(claim, new Date(Date.parse(now) + 60000).toISOString(), now, now)
    .first<{ cursor_date: string | null; cursor_id: string | null }>();
  if (!state) return 0;
  const floor = oldestVideoDate(now);
  const shortFloor = new Date(Date.parse(now) - SHORT_REVIEW_MS).toISOString();
  // Page by publication date before checking relationships. A candidate gets
  // at least 30 days from discovery (created_at), even if published earlier.
  // The 1970 sentinel is an unknown publication date, not evidence of age.
  const page = await env.DB.prepare(
    `SELECT id,published_at FROM videos INDEXED BY idx_videos_feed
    WHERE published_at<? AND published_at>'1970-01-02' AND source<>'fixture'
    AND (published_at,id)>(?,?) ORDER BY published_at,id LIMIT ?`,
  )
    .bind(
      shortFloor,
      state.cursor_date || "1970-01-02",
      state.cursor_id || "",
      PAGE_SIZE,
    )
    .all<{ id: string; published_at: string }>();
  const rows = page.results || [];
  const statements: D1PreparedStatement[] = [];
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    // A tombstone is much smaller than the video and stops push/RSS discovery
    // from bringing a discarded candidate straight back. The batch is atomic.
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO short_video_tombstones(video_id,published_at)
         SELECT id,published_at FROM videos WHERE id IN (${placeholders})
         AND published_at>=? AND created_at<?
         AND short_candidate=1
         AND NOT EXISTS(SELECT 1 FROM playlist_items pi WHERE pi.video_id=videos.id)
         AND NOT EXISTS(SELECT 1 FROM watch_states ws WHERE ws.video_id=videos.id)
         AND NOT EXISTS(SELECT 1 FROM account_video_metadata pm WHERE pm.video_id=videos.id)`,
      ).bind(...ids, floor, shortFloor),
    );
    statements.push(
      env.DB.prepare(
        `DELETE FROM videos WHERE id IN (${placeholders})
      AND (published_at<? OR EXISTS(SELECT 1 FROM short_video_tombstones st WHERE st.video_id=videos.id))
      AND NOT EXISTS(SELECT 1 FROM playlist_items pi WHERE pi.video_id=videos.id)
      AND ((EXISTS(SELECT 1 FROM short_video_tombstones st WHERE st.video_id=videos.id)
        AND NOT EXISTS(SELECT 1 FROM watch_states selected WHERE selected.video_id=videos.id))
      OR (EXISTS(SELECT 1 FROM watch_states ws JOIN accounts a ON a.id=ws.account_id
        WHERE ws.video_id=videos.id AND ws.watched=1 AND a.mode='real' AND a.connected=1)
      AND NOT EXISTS(SELECT 1 FROM watch_states ws JOIN accounts a ON a.id=ws.account_id
        WHERE ws.video_id=videos.id AND ws.watched=0 AND a.mode='real' AND a.connected=1)
      AND NOT EXISTS(SELECT 1 FROM subscriptions s JOIN accounts a ON a.id=s.account_id
        WHERE s.channel_id=videos.channel_id AND s.active=1 AND a.mode='real' AND a.connected=1
        AND NOT EXISTS(SELECT 1 FROM watch_states ws WHERE ws.account_id=s.account_id AND ws.video_id=videos.id AND ws.watched=1))))
      AND NOT EXISTS(SELECT 1 FROM account_video_metadata pm WHERE pm.video_id=videos.id AND json_extract(pm.metadata,'$.publishedAt')>=?)
      AND EXISTS(SELECT 1 FROM video_retention_state WHERE id=1 AND claim_token=?) RETURNING id`,
      ).bind(...ids, floor, floor, claim),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE youtube_feed_state SET revision=revision+1,updated_at=? WHERE id=1 AND changes()>0`,
      ).bind(now),
    );
  }
  statements.push(env.DB.prepare(
    `DELETE FROM short_video_tombstones WHERE video_id IN
     (SELECT video_id FROM short_video_tombstones WHERE published_at<? LIMIT 50)`,
  ).bind(floor));
  const last = rows[rows.length - 1];
  statements.push(
    env.DB.prepare(
      `UPDATE video_retention_state SET cursor_date=?,cursor_id=?,next_run_at=?,claim_token=NULL,claim_expires_at=NULL
    WHERE id=1 AND claim_token=?`,
    ).bind(
      rows.length === PAGE_SIZE ? last.published_at : null,
      rows.length === PAGE_SIZE ? last.id : null,
      rows.length === PAGE_SIZE
        ? now
        : new Date(Date.parse(now) + WEEK_MS).toISOString(),
      claim,
    ),
  );
  const results = await env.DB.batch(statements);
  if (rows.length) await deleteVideoThumbnails(env, (results[1].results || []).map((row) => (row as { id: string }).id));
  return rows.length ? results[1].results?.length || 0 : 0;
}
