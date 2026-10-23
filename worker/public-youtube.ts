// Public YouTube reads and cached related searches; no OAuth writes or scraping.
import type { Env, Video } from "./types";
import { isWebSubEnabled } from "./websub";
import { isRecentEnough } from "./rss";
import { relatedQueries } from "./related-query";
import {
  ExternalError,
  HttpError,
  isoInDays,
  nowIso,
  sanitizeText,
} from "./http";
import {
  getSubscription,
  getVideo,
  subscribeLocal,
  externalChannelStatement,
  externalVideoStatement,
} from "./db";
import {
  searchVideos,
  listVideos,
  parseIsoDuration,
  pickThumbnailUrl,
  type YouTubeVideoItem,
} from "./youtube";

const EXAMPLES = ["M7lc1UVf-VE", "aqz-KE-bpKQ", "jNQXAC9IVRw"];
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function credential(env: Env) {
  if (!env.YOUTUBE_API_KEY)
    throw new HttpError(
      501,
      "PUBLIC_API_NOT_CONFIGURED",
      "Configura YOUTUBE_API_KEY en el backend local.",
    );
  return { apiKey: env.YOUTUBE_API_KEY };
}

async function cachedIds(env: Env, key: string): Promise<string[] | null> {
  await env.DB.prepare("DELETE FROM public_read_cache WHERE expires_at <= ?")
    .bind(nowIso())
    .run();
  const cached = await env.DB.prepare(
    "SELECT payload FROM public_read_cache WHERE cache_key = ?",
  )
    .bind(key)
    .first<{ payload: string }>();
  if (!cached) return null;
  const ids: unknown = JSON.parse(cached.payload);
  return Array.isArray(ids) &&
    ids.every((id) => typeof id === "string" && VIDEO_ID.test(id))
    ? ids
    : null;
}

function cacheIdsStatement(
  env: Env,
  key: string,
  ids: string[],
  ownerId?: string,
) {
  return env.DB.prepare(
    `INSERT INTO public_read_cache (cache_key,payload,expires_at) ${ownerId ? "SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND connected=1)" : "VALUES (?,?,?)"}
    ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at`,
  ).bind(
    key,
    JSON.stringify(ids),
    new Date(Date.now() + 3600000).toISOString(),
    ...(ownerId ? [ownerId] : []),
  );
}
async function cacheIds(
  env: Env,
  key: string,
  ids: string[],
  ownerId?: string,
) {
  await cacheIdsStatement(env, key, ids, ownerId).run();
}

export async function storeVideos(
  env: Env,
  items: YouTubeVideoItem[],
  allowOld = false,
): Promise<string[]> {
  const ids: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    const s = item.snippet;
    if (
      item.status?.privacyStatus !== "public" ||
      !item.id ||
      !VIDEO_ID.test(item.id) ||
      !s?.channelId ||
      !CHANNEL_ID.test(s.channelId) ||
      !s.title ||
      !s.publishedAt ||
      !Number.isFinite(Date.parse(s.publishedAt))
    )
      continue;
    if (!allowOld && isWebSubEnabled(env) && !isRecentEnough(s.publishedAt))
      continue;
    const expiresAt = isoInDays(25);
    statements.push(
      externalChannelStatement(
        env.DB,
        {
          id: s.channelId,
          title: sanitizeText(s.channelTitle, 300),
          description: "",
          thumbnailUrl: null,
        },
        expiresAt,
      ),
    );
    statements.push(
      externalVideoStatement(
        env.DB,
        {
          id: item.id,
          channelId: s.channelId,
          channelTitle: sanitizeText(s.channelTitle, 300),
          title: sanitizeText(s.title, 500),
          description: sanitizeText(s.description, 5000),
          thumbnailUrl: pickThumbnailUrl(s.thumbnails),
          publishedAt: new Date(s.publishedAt).toISOString(),
          durationSeconds: parseIsoDuration(item.contentDetails?.duration),
          viewCount:
            item.statistics?.viewCount &&
            /^\d{1,15}$/.test(item.statistics.viewCount)
              ? Number(item.statistics.viewCount)
              : null,
          isLive: s.liveBroadcastContent !== "none",
          liveBroadcastContent: s?.liveBroadcastContent ?? null,
          source: "youtube",
        },
        expiresAt,
      ),
    );
    statements.push(
      cacheIdsStatement(env, `public-video:${item.id}`, [item.id]),
    );
    ids.push(item.id);
  }
  if (statements.length) await env.DB.batch(statements);
  return ids;
}

function publicPreview(item: YouTubeVideoItem): Video | null {
  const s = item.snippet;
  if (
    item.status?.privacyStatus !== "public" ||
    item.status.embeddable === false ||
    !item.id ||
    !VIDEO_ID.test(item.id) ||
    !s?.channelId ||
    !CHANNEL_ID.test(s.channelId) ||
    !s.title ||
    !s.publishedAt ||
    !Number.isFinite(Date.parse(s.publishedAt))
  )
    return null;
  return {
    id: item.id,
    transient: true,
    title: sanitizeText(s.title, 500),
    channelId: s.channelId,
    channelTitle: sanitizeText(s.channelTitle, 300),
    thumbnailUrl: pickThumbnailUrl(s.thumbnails),
    publishedAt: new Date(s.publishedAt).toISOString(),
    description: sanitizeText(s.description, 5000),
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    isLive: s.liveBroadcastContent !== "none",
    liveBroadcastContent: s.liveBroadcastContent ?? null,
    watched: false,
    positionSeconds: 0,
    percent: 0,
    manual: false,
    viewCount:
      item.statistics?.viewCount && /^\d{1,15}$/.test(item.statistics.viewCount)
        ? Number(item.statistics.viewCount)
        : null,
    revision: 0,
  };
}

async function cachedPreviews(env: Env, key: string): Promise<Video[] | null> {
  if (!env.READ_CACHE) return null;
  try {
    const raw = await env.READ_CACHE.get(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.length > 8 ||
      !value.every(
        (v) =>
          v &&
          typeof v === "object" &&
          typeof v.id === "string" &&
          VIDEO_ID.test(v.id) &&
          v.transient === true,
      )
    )
      return null;
    return value as Video[];
  } catch {
    return null;
  }
}

async function cachePreviews(
  env: Env,
  key: string,
  videos: Video[],
): Promise<void> {
  try {
    await env.READ_CACHE?.put(key, JSON.stringify(videos), {
      expirationTtl: videos.length ? 3600 : 60,
    });
  } catch {
    // Optional cache; a KV outage must not hide YouTube results.
  }
}

/** Public API metadata without creating feed, watch-state or playlist rows. */
export async function getPublicPreview(env: Env, id: string): Promise<Video> {
  if (!VIDEO_ID.test(id))
    throw new HttpError(
      400,
      "INVALID_VIDEO_ID",
      "Identificador de vídeo inválido.",
    );
  const key = `youtube-preview:v1:${id}`;
  const cached = await cachedPreviews(env, key);
  if (cached?.[0]) return cached[0];
  const response = await listVideos(credential(env), [id]);
  if (!Array.isArray(response.items))
    throw new ExternalError("invalid_response");
  const video = publicPreview(
    response.items.find((item) => item.id === id) || {},
  );
  if (!video)
    throw new HttpError(
      404,
      "VIDEO_NOT_FOUND",
      "Este vídeo no está disponible públicamente en YouTube.",
    );
  await cachePreviews(env, key, [video]);
  return video;
}

export async function getPublicVideo(
  env: Env,
  accountId: string,
  id: string,
): Promise<Video> {
  if (!VIDEO_ID.test(id))
    throw new HttpError(
      400,
      "INVALID_VIDEO_ID",
      "Identificador de vídeo inválido.",
    );
  const existing = await getVideo(env.DB, accountId, id, "external");
  const row = await env.DB.prepare(
    "SELECT details_fetched_at FROM videos WHERE id = ? AND source = ?",
  )
    .bind(id, "youtube")
    .first<{ details_fetched_at: string | null }>();
  if (
    existing &&
    row?.details_fetched_at &&
    Date.parse(row.details_fetched_at) > Date.now() - 3600000
  )
    return existing;
  try {
    const response = await listVideos(credential(env), [id]);
    if (!Array.isArray(response.items))
      throw new ExternalError("invalid_response");
    const ids = await storeVideos(
      env,
      response.items.filter((item) => item.id === id),
      true,
    );
    if (!ids.length)
      throw new HttpError(
        404,
        "VIDEO_NOT_FOUND",
        "Este vídeo no está disponible públicamente en YouTube.",
      );
  } catch (error) {
    // A brief outage must not replace known real content with fictional data.
    if (existing && error instanceof ExternalError) return existing;
    throw error;
  }
  const video = await getVideo(env.DB, accountId, id, "external");
  if (!video)
    throw new HttpError(
      404,
      "VIDEO_NOT_FOUND",
      "No se han podido recuperar los metadatos del vídeo.",
    );
  return video;
}

/** Public demo replaces the three playable fixture records with actual metadata.
 * The chosen sample channels are followed only locally, never on YouTube.
 * Inactive local follows are tombstones and are not re-enabled by bootstrap.
 */
export async function ensurePublicExamples(env: Env, accountId: string) {
  if (env.MODE !== "demo" || !env.YOUTUBE_API_KEY) return;
  if (await cachedIds(env, "examples")) return;
  const response = await listVideos(credential(env), EXAMPLES);
  if (!Array.isArray(response.items))
    throw new ExternalError("invalid_response");
  const ids = await storeVideos(
    env,
    response.items.filter((item) => EXAMPLES.includes(item.id || "")),
  );
  for (const id of ids) {
    const video = await getVideo(env.DB, accountId, id, "external");
    if (video && !(await getSubscription(env.DB, accountId, video.channelId)))
      await subscribeLocal(env.DB, accountId, video.channelId);
  }
  await cacheIds(env, "examples", ids);
}

export async function getPublicSuggestions(
  env: Env,
  accountId: string,
  videoId: string,
  limit = 6,
): Promise<Video[]> {
  const video =
    (await getVideo(env.DB, accountId, videoId, "external")) ??
    (await getPublicPreview(env, videoId));
  const cacheKey = `youtube-suggestions:v5:${videoId}`;
  const cached = await cachedPreviews(env, cacheKey);
  if (cached) return cached.slice(0, limit);
  // Tags are used only on demand and are never persisted.
  const source = await listVideos(credential(env), [videoId]);
  if (!Array.isArray(source.items)) throw new ExternalError("invalid_response");
  const publicSource = source.items.find(
    (item) =>
      item.id === videoId &&
      item.status?.privacyStatus === "public" &&
      item.snippet?.title,
  );
  const queries = relatedQueries(
    publicSource?.snippet?.title
      ? { ...publicSource.snippet, title: publicSource.snippet.title }
      : video,
  );
  let suggestions: Video[] = [];
  for (const query of queries) {
    const results = await searchVideos(credential(env), query);
    if (!Array.isArray(results.items))
      throw new ExternalError("invalid_response");
    const ids = [
      ...new Set(
        results.items
          .map((item) => item.id?.videoId)
          .filter(
            (id): id is string =>
              typeof id === "string" && VIDEO_ID.test(id) && id !== videoId,
          ),
      ),
    ].slice(0, env.SYNC_PROFILE === "free" ? 4 : 8);
    if (!ids.length) continue;
    const details = await listVideos(credential(env), ids);
    if (!Array.isArray(details.items))
      throw new ExternalError("invalid_response");
    const byId = new Map(
      details.items.map((item) => [item.id, publicPreview(item)]),
    );
    suggestions = ids
      .map((id) => byId.get(id))
      .filter((v): v is Video => v != null);
    if (suggestions.length) break;
  }
  if (publicSource) await cachePreviews(env, cacheKey, suggestions);
  return suggestions.slice(0, limit);
}

/** A public text search reads YouTube directly; only an explicit list save writes D1. */
export async function searchPublicVideos(
  env: Env,
  query: string,
  pageToken?: string,
): Promise<{ items: Video[]; nextPageToken: string | null }> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${query.toLocaleLowerCase()}\n${pageToken || ""}`));
  const key = `youtube-search:v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (env.READ_CACHE) {
    try {
      const raw = await env.READ_CACHE.get(key);
      if (raw) {
        const cached: unknown = JSON.parse(raw);
        if (
          cached && typeof cached === "object" &&
          "items" in cached && Array.isArray(cached.items) &&
          cached.items.length <= 20 &&
          cached.items.every((item: unknown) =>
            item && typeof item === "object" && "id" in item &&
            typeof item.id === "string" && VIDEO_ID.test(item.id) &&
            "transient" in item && item.transient === true,
          ) &&
          "nextPageToken" in cached &&
          (cached.nextPageToken === null || typeof cached.nextPageToken === "string")
        ) return cached as { items: Video[]; nextPageToken: string | null };
      }
    } catch { /* Cache is optional. */ }
  }
  const results = await searchVideos(credential(env), query, { maxResults: 20, pageToken });
  if (!Array.isArray(results.items)) throw new ExternalError("invalid_response");
  const ids = [...new Set(results.items.map((item) => item.id?.videoId).filter(
    (id): id is string => typeof id === "string" && VIDEO_ID.test(id),
  ))];
  const details = ids.length ? await listVideos(credential(env), ids) : { items: [] };
  if (!Array.isArray(details.items)) throw new ExternalError("invalid_response");
  const byId = new Map(details.items.map((item) => [item.id, publicPreview(item)]));
  const value = {
    items: ids.map((id) => byId.get(id)).filter((item): item is Video => item != null),
    nextPageToken: typeof results.nextPageToken === "string" ? results.nextPageToken : null,
  };
  try {
    await env.READ_CACHE?.put(key, JSON.stringify(value), { expirationTtl: value.items.length ? 600 : 60 });
  } catch { /* Cache is optional. */ }
  return value;
}
