import type { Env } from "./types";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_IMAGE_BYTES = 512 * 1024;

const key = (accountId: string, videoId: string) => `v1/${accountId}/${videoId}`;
export const feedThumbnailPath = (videoId: string) => `/api/feed/thumbnails/${videoId}`;

async function eligibleAccounts(env: Env, videoId: string, accountId?: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT a.id FROM videos v
     JOIN subscriptions s ON s.channel_id=v.channel_id AND s.active=1 AND s.excluded=0
     JOIN accounts a ON a.id=s.account_id AND a.mode='real' AND a.connected=1
     LEFT JOIN watch_states w ON w.account_id=a.id AND w.video_id=v.id
     WHERE v.id=? AND v.source<>'fixture' AND v.purged_at IS NULL
       AND v.short_candidate=0 AND COALESCE(w.watched,0)=0
       ${accountId ? "AND a.id=?" : ""}`,
  ).bind(...(accountId ? [videoId, accountId] : [videoId])).all<{ id: string }>();
  return (rows.results || []).map((row) => row.id);
}

/** Image failures never make video ingestion fail. A later image request retries. */
export async function warmFeedThumbnails(env: Env, videoIds: string[], accountId?: string): Promise<void> {
  if (!env.FEED_IMAGES) return;
  for (const videoId of [...new Set(videoIds)]) {
    if (!VIDEO_ID.test(videoId)) continue;
    try {
      const accounts = await eligibleAccounts(env, videoId, accountId);
      const missing: string[] = [];
      for (const id of accounts) if (!(await env.FEED_IMAGES.head(key(id, videoId)))) missing.push(id);
      if (!missing.length) continue;
      const response = await fetch(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg")) continue;
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > MAX_IMAGE_BYTES) continue;
      if (!response.body) continue;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) { await reader.cancel(); break; }
        chunks.push(value);
      }
      if (!size || size > MAX_IMAGE_BYTES) continue;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      for (const id of missing) {
        await env.FEED_IMAGES.put(key(id, videoId), bytes, { httpMetadata: { contentType: "image/jpeg" } });
      }
    } catch (error) {
      console.warn("Feed thumbnail cache failed", videoId, error);
    }
  }
}

export async function serveFeedThumbnail(env: Env, accountId: string, videoId: string): Promise<Response> {
  if (!VIDEO_ID.test(videoId)) return new Response(null, { status: 404 });
  const fallback = () => Response.redirect(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, 302);
  if (!env.FEED_IMAGES) return fallback();
  try {
    let image = await env.FEED_IMAGES.get(key(accountId, videoId));
    if (!image) {
      await warmFeedThumbnails(env, [videoId], accountId);
      image = await env.FEED_IMAGES.get(key(accountId, videoId));
    }
    if (!image) return fallback();
    return new Response(image.body, {
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    console.warn("Feed thumbnail read failed", videoId, error);
    return fallback();
  }
}

export async function deleteFeedThumbnail(env: Env, accountId: string, videoId: string): Promise<void> {
  if (!env.FEED_IMAGES || !VIDEO_ID.test(videoId)) return;
  try { await env.FEED_IMAGES.delete(key(accountId, videoId)); }
  catch (error) { console.warn("Feed thumbnail deletion failed", videoId, error); }
}

export async function deleteVideoThumbnails(env: Env, videoIds: string[]): Promise<void> {
  if (!env.FEED_IMAGES || !videoIds.length) return;
  try {
    const accounts = await env.DB.prepare("SELECT id FROM accounts WHERE mode='real'").all<{ id: string }>();
    const keys = (accounts.results || []).flatMap(({ id }) => videoIds.map((v) => key(id, v)));
    for (let i = 0; i < keys.length; i += 1000) await env.FEED_IMAGES.delete(keys.slice(i, i + 1000));
  } catch (error) { console.warn("Feed thumbnail cleanup failed", error); }
}

export async function deleteWatchedThumbnails(env: Env, accountId: string): Promise<void> {
  if (!env.FEED_IMAGES) return;
  try {
    let cursor: string | undefined;
    do {
      const page = await env.FEED_IMAGES.list({ prefix: `v1/${accountId}/`, cursor, limit: 1000 });
      const ids = page.objects.map((object) => object.key.split("/").at(-1)!).filter((id) => VIDEO_ID.test(id));
      if (ids.length) {
        const watched = await env.DB.prepare(`SELECT video_id FROM watch_states WHERE account_id=? AND watched=1 AND video_id IN (${ids.map(() => "?").join(",")})`).bind(accountId, ...ids).all<{ video_id: string }>();
        const keys = (watched.results || []).map(({ video_id }) => key(accountId, video_id));
        if (keys.length) await env.FEED_IMAGES.delete(keys);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (error) { console.warn("Feed thumbnail bulk cleanup failed", error); }
}
