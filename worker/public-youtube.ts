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
    if (isWebSubEnabled(env) && !isRecentEnough(s.publishedAt)) continue;
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
    (await getPublicVideo(env, accountId, videoId));
  let shared = !!(await env.DB.prepare(
    "SELECT 1 AS verified FROM public_read_cache WHERE cache_key=? AND expires_at>?",
  )
    .bind("public-video:" + videoId, nowIso())
    .first());
  const cacheKey = (isPublic: boolean) =>
    `search:v4:${isPublic ? videoId : accountId + ":" + videoId}`;
  let key = cacheKey(shared);
  let ids = await cachedIds(env, key);
  if (!ids) {
    // Tags are fetched only on demand and never persisted from an OAuth/private response.
    const source = await listVideos(credential(env), [videoId]);
    if (!Array.isArray(source.items))
      throw new ExternalError("invalid_response");
    const publicSource = source.items.find(
      (item) =>
        item.id === videoId &&
        item.status?.privacyStatus === "public" &&
        item.snippet?.title,
    );
    shared =
      !!publicSource &&
      (await storeVideos(env, [publicSource])).includes(videoId);
    const nextKey = cacheKey(shared);
    if (nextKey !== key) {
      key = nextKey;
      ids = await cachedIds(env, key);
    }
    if (!ids) {
      const queries = relatedQueries(
        publicSource?.snippet?.title
          ? { ...publicSource.snippet, title: publicSource.snippet.title }
          : video,
      );
      let candidates: string[] = [];
      for (const query of queries) {
        const results = await searchVideos(credential(env), query);
        if (!Array.isArray(results.items))
          throw new ExternalError("invalid_response");
        candidates = [
          ...new Set(
            results.items
              .map((item) => item.id?.videoId)
              .filter(
                (id): id is string =>
                  typeof id === "string" && VIDEO_ID.test(id) && id !== videoId,
              ),
          ),
        ].slice(0, env.SYNC_PROFILE === "free" ? 4 : 8);
        if (candidates.length) break;
      }
      if (candidates.length) {
        const details = await listVideos(credential(env), candidates);
        if (!Array.isArray(details.items))
          throw new ExternalError("invalid_response");
        ids = await storeVideos(
          env,
          details.items.filter((item) => candidates.includes(item.id || "")),
        );
      } else ids = [];
      await cacheIds(env, key, ids, shared ? undefined : accountId);
    }
  }
  const items = await Promise.all(
    ids
      .filter((id) => id !== videoId)
      .slice(0, limit)
      .map((id) => getVideo(env.DB, accountId, id, "external")),
  );
  return items.filter((v): v is Video => v !== null);
}
