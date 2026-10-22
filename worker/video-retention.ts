/** Weekly, global deletion of old watched videos. No per-account jobs or fanout. */
import type { Env } from "./types";
import { oldestVideoDate } from "./rss";
import { isWebSubEnabled } from "./websub";

const PAGE_SIZE = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
  // Page by the existing date index *before* checking relationships. This also
  // bounds a pass whose old videos are all pending or in playlists. The 1970
  // sentinel is an unknown publication date, not evidence of a one-year-old video.
  const page = await env.DB.prepare(
    `SELECT id,published_at FROM videos INDEXED BY idx_videos_feed
    WHERE published_at<? AND published_at>'1970-01-02' AND source<>'fixture'
    AND (published_at,id)>(?,?) ORDER BY published_at,id LIMIT ?`,
  )
    .bind(
      floor,
      state.cursor_date || "1970-01-02",
      state.cursor_id || "",
      PAGE_SIZE,
    )
    .all<{ id: string; published_at: string }>();
  const rows = page.results || [];
  const statements: D1PreparedStatement[] = [];
  if (rows.length) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM videos WHERE id IN (${rows.map(() => "?").join(",")})
      AND published_at<?
      AND NOT EXISTS(SELECT 1 FROM playlist_items pi WHERE pi.video_id=videos.id)
      AND EXISTS(SELECT 1 FROM watch_states ws JOIN accounts a ON a.id=ws.account_id
        WHERE ws.video_id=videos.id AND ws.watched=1 AND a.mode='real' AND a.connected=1)
      AND NOT EXISTS(SELECT 1 FROM watch_states ws JOIN accounts a ON a.id=ws.account_id
        WHERE ws.video_id=videos.id AND ws.watched=0 AND a.mode='real' AND a.connected=1)
      AND NOT EXISTS(SELECT 1 FROM subscriptions s JOIN accounts a ON a.id=s.account_id
        WHERE s.channel_id=videos.channel_id AND s.active=1 AND a.mode='real' AND a.connected=1
        AND NOT EXISTS(SELECT 1 FROM watch_states ws WHERE ws.account_id=s.account_id AND ws.video_id=videos.id AND ws.watched=1))
      AND NOT EXISTS(SELECT 1 FROM account_video_metadata pm WHERE pm.video_id=videos.id AND json_extract(pm.metadata,'$.publishedAt')>=?)
      AND EXISTS(SELECT 1 FROM video_retention_state WHERE id=1 AND claim_token=?) RETURNING id`,
      ).bind(...rows.map((r) => r.id), floor, floor, claim),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE youtube_feed_state SET revision=revision+1,updated_at=? WHERE id=1 AND changes()>0`,
      ).bind(now),
    );
  }
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
  return rows.length ? results[0].results?.length || 0 : 0;
}
