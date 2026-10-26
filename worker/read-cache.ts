/**
 * Bounded per-account read-through cache for D1-backed feed metadata. D1 stays
 * authoritative and every cache hit re-reads watch state so progress never
 * becomes stale. Only metadata DTOs are stored; tokens and sessions never are.
 */
import { toNumber } from "./db";
import { isWebSubEnabled } from "./websub";
import { readGlobalFeedRevision } from "./channel-sync";
import { sha256Hex } from "./http";
import type { Env, PlaylistSummary, Video } from "./types";

type ReadCacheEnv = Env & { READ_CACHE?: KVNamespace };

export interface FeedPage {
  items: Video[];
  nextCursor: string | null;
}

export type ReadCacheState = "hit" | "miss" | "disabled";

export interface CachedRead<T> {
  value: T;
  cache: ReadCacheState;
}

const CACHE_STATE_TYPE = "cache:reads";
const CACHE_KEY_VERSION = "v1";
const CACHE_ENVELOPE_VERSION = 1;
const CACHE_TTL_SECONDS = 60;
const MAX_CACHE_ITEMS = 100;
// owner id + every video id must stay within D1's 100 bound parameters.
const MAX_FEED_ITEMS = MAX_CACHE_ITEMS - 1;
const MAX_PAYLOAD_LENGTH = 128_000;
// A fresh opaque generation avoids resurrecting old cache entries after account data is cleared.

type CacheKind = "feed" | "playlists";

interface CacheEnvelope<T> {
  v: number;
  kind: CacheKind;
  owner: string;
  generation: string;
  query: string;
  value: T;
}

interface WatchRow {
  videoId: string;
  watched: number;
  positionSeconds: number;
  percent: number;
  manual: number;
  revision: number;
}

function cacheKv(env: ReadCacheEnv): KVNamespace | undefined {
  return env.MODE === "real" ? env.READ_CACHE : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/** Rebuild a minimal Video DTO, stripping any account watch state. */
function cachedVideo(value: unknown): Video | null {
  if (!isRecord(value)) return null;
  const { id, title, channelId, channelTitle, thumbnailUrl, publishedAt } =
    value;
  const description = value.description;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof title !== "string" ||
    typeof channelId !== "string" ||
    typeof channelTitle !== "string" ||
    typeof thumbnailUrl !== "string" ||
    typeof publishedAt !== "string" ||
    typeof description !== "string"
  ) {
    return null;
  }
  const durationSeconds = nullableNumber(value.durationSeconds);
  if (durationSeconds === undefined) return null;
  const viewCount = nullableNumber(value.viewCount);
  if (viewCount === undefined) return null;
  const isLive = value.isLive;
  if (isLive !== null && typeof isLive !== "boolean") return null;
  const liveBroadcastContent = value.liveBroadcastContent;
  if (
    liveBroadcastContent !== null &&
    liveBroadcastContent !== "none" &&
    liveBroadcastContent !== "live" &&
    liveBroadcastContent !== "upcoming"
  ) {
    return null;
  }
  const playlistItemId = value.playlistItemId;
  if (
    playlistItemId !== undefined &&
    (typeof playlistItemId !== "string" || playlistItemId.length === 0)
  ) {
    return null;
  }
  const video: Video = {
    id,
    title,
    channelId,
    channelTitle,
    thumbnailUrl,
    publishedAt,
    description,
    durationSeconds,
    isLive,
    liveBroadcastContent,
    watched: false,
    positionSeconds: 0,
    percent: 0,
    manual: false,
    viewCount,
    revision: 0,
  };
  if (typeof playlistItemId === "string" && playlistItemId) {
    video.playlistItemId = playlistItemId;
  }
  return video;
}

function cachedFeedPage(value: unknown): FeedPage | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  if (value.items.length > MAX_FEED_ITEMS) return null;
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
    return null;
  }
  const items: Video[] = [];
  for (const item of value.items) {
    const video = cachedVideo(item);
    if (!video) return null;
    items.push(video);
  }
  return { items, nextCursor: value.nextCursor };
}

function cachedPlaylistSummary(value: unknown): PlaylistSummary | null {
  if (!isRecord(value)) return null;
  const { id, title, description, source } = value;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof title !== "string" ||
    typeof description !== "string" ||
    (source !== "local" && source !== "youtube")
  ) {
    return null;
  }
  const itemCount = nullableNumber(value.itemCount);
  if (itemCount === undefined || itemCount === null || itemCount < 0) {
    return null;
  }
  return { id, title, description, source, itemCount,
    ...(typeof value.followed === "boolean" ? { followed: value.followed } : {}),
  };
}

function cachedPlaylistSummaries(value: unknown): PlaylistSummary[] | null {
  if (!Array.isArray(value) || value.length > MAX_CACHE_ITEMS) return null;
  const summaries: PlaylistSummary[] = [];
  for (const item of value) {
    const summary = cachedPlaylistSummary(item);
    if (!summary) return null;
    summaries.push(summary);
  }
  return summaries;
}

function decodeEnvelope(
  raw: string,
  kind: CacheKind,
  owner: string,
  generation: string,
  query: string,
): unknown | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (
    parsed.v !== CACHE_ENVELOPE_VERSION ||
    parsed.kind !== kind ||
    parsed.owner !== owner ||
    parsed.generation !== generation ||
    parsed.query !== query
  ) {
    return null;
  }
  return parsed.value === undefined ? null : parsed.value;
}

async function cacheKey(
  kind: CacheKind,
  owner: string,
  generation: string,
  query: string,
): Promise<string> {
  const queryHash = await sha256Hex(query);
  return `read-cache:${CACHE_KEY_VERSION}:${encodeURIComponent(owner)}:${encodeURIComponent(generation)}:${kind}:${queryHash}`;
}

async function readGeneration(
  db: D1Database,
  ownerId: string,
): Promise<string> {
  const row = await db
    .prepare("SELECT cursor FROM sync_state WHERE account_id = ? AND type = ?")
    .bind(ownerId, CACHE_STATE_TYPE)
    .first<{ cursor: string | null }>();
  if (typeof row?.cursor === "string" && row.cursor) return row.cursor;
  await db
    .prepare(
      `INSERT INTO sync_state(account_id,type,cursor) SELECT id,?,? FROM accounts WHERE id=? AND mode='real' AND connected=1 ON CONFLICT(account_id, type) DO NOTHING`,
    )
    .bind(CACHE_STATE_TYPE, crypto.randomUUID(), ownerId)
    .run();
  const created = await db
    .prepare("SELECT cursor FROM sync_state WHERE account_id = ? AND type = ?")
    .bind(ownerId, CACHE_STATE_TYPE)
    .first<{ cursor: string | null }>();
  return created?.cursor || crypto.randomUUID();
}

async function kvGet(kv: KVNamespace, key: string): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

async function kvPut<T>(
  kv: KVNamespace,
  key: string,
  envelope: CacheEnvelope<T>,
): Promise<void> {
  try {
    const raw = JSON.stringify(envelope);
    if (raw.length > MAX_PAYLOAD_LENGTH) return;
    await kv.put(key, raw, { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // The cache is optional; quota and transient KV failures must not fail reads.
  }
}

/** One primary-key lookup for at most MAX_FEED_ITEMS videos. */
async function hydrateFeed(
  db: D1Database,
  ownerId: string,
  items: Video[],
): Promise<Video[]> {
  if (items.length === 0) return items;
  const placeholders = items.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT video_id AS videoId, watched, position_seconds AS positionSeconds,
              percent, manual, revision
       FROM watch_states WHERE account_id = ? AND video_id IN (${placeholders})`,
    )
    .bind(ownerId, ...items.map((item) => item.id))
    .all<WatchRow>();
  const states = new Map<string, WatchRow>();
  for (const row of result.results ?? []) {
    states.set(String(row.videoId), row);
  }
  return items.map((video) => {
    const state = states.get(video.id);
    return {
      ...video,
      watched: toNumber(state?.watched) === 1,
      positionSeconds: Math.max(0, toNumber(state?.positionSeconds)),
      percent: Math.max(
        0,
        Math.min(100, Math.round(toNumber(state?.percent) * 100) / 100),
      ),
      manual: toNumber(state?.manual) === 1,
      revision: toNumber(state?.revision),
    };
  });
}

async function feedGeneration(env: Env, ownerId: string): Promise<string> {
  const account = await readGeneration(env.DB, ownerId);
  return isWebSubEnabled(env)
    ? `${account}:global:${await readGlobalFeedRevision(env.DB)}`
    : account;
}

/** Cheap authenticated polling: one account key and one singleton, no feed scan. */
export async function feedRevision(env: Env, ownerId: string): Promise<string> {
  return sha256Hex(await feedGeneration(env, ownerId));
}

export async function cachedFeed(
  env: ReadCacheEnv,
  ownerId: string,
  normalizedQueryKey: string,
  load: () => Promise<FeedPage>,
): Promise<CachedRead<FeedPage>> {
  const kv = cacheKv(env);
  if (!kv) return { value: await load(), cache: "disabled" };

  const generation = await feedGeneration(env, ownerId);
  const key = await cacheKey("feed", ownerId, generation, normalizedQueryKey);
  const raw = await kvGet(kv, key);
  if (raw !== null) {
    const stored = decodeEnvelope(
      raw,
      "feed",
      ownerId,
      generation,
      normalizedQueryKey,
    );
    const page = cachedFeedPage(stored);
    if (page) {
      const items = await hydrateFeed(env.DB, ownerId, page.items);
      return {
        value: { items, nextCursor: page.nextCursor },
        cache: "hit",
      };
    }
  }

  const value = await load();
  const cacheable = cachedFeedPage(value);
  if (cacheable) {
    await kvPut<FeedPage>(kv, key, {
      v: CACHE_ENVELOPE_VERSION,
      kind: "feed",
      owner: ownerId,
      generation,
      query: normalizedQueryKey,
      value: cacheable,
    });
  }
  return { value, cache: "miss" };
}

export function cachedPlaylists(
  env: ReadCacheEnv,
  ownerId: string,
  normalizedQueryKey: string,
  load: () => Promise<PlaylistSummary[]>,
): Promise<CachedRead<PlaylistSummary[]>>;
export function cachedPlaylists(
  env: ReadCacheEnv,
  ownerId: string,
  load: () => Promise<PlaylistSummary[]>,
): Promise<CachedRead<PlaylistSummary[]>>;
export async function cachedPlaylists(
  env: ReadCacheEnv,
  ownerId: string,
  normalizedQueryKeyOrLoad: string | (() => Promise<PlaylistSummary[]>),
  maybeLoad?: () => Promise<PlaylistSummary[]>,
): Promise<CachedRead<PlaylistSummary[]>> {
  const normalizedQueryKey =
    typeof normalizedQueryKeyOrLoad === "string"
      ? normalizedQueryKeyOrLoad
      : "";
  const load =
    typeof normalizedQueryKeyOrLoad === "function"
      ? normalizedQueryKeyOrLoad
      : maybeLoad;
  if (!load) throw new TypeError("cachedPlaylists requires a loader");

  const kv = cacheKv(env);
  if (!kv) return { value: await load(), cache: "disabled" };

  const generation = await readGeneration(env.DB, ownerId);
  const key = await cacheKey(
    "playlists",
    ownerId,
    generation,
    normalizedQueryKey,
  );
  const raw = await kvGet(kv, key);
  if (raw !== null) {
    const stored = decodeEnvelope(
      raw,
      "playlists",
      ownerId,
      generation,
      normalizedQueryKey,
    );
    const summaries = cachedPlaylistSummaries(stored);
    if (summaries) return { value: summaries, cache: "hit" };
  }

  const value = await load();
  const cacheable = cachedPlaylistSummaries(value);
  if (cacheable) {
    await kvPut<PlaylistSummary[]>(kv, key, {
      v: CACHE_ENVELOPE_VERSION,
      kind: "playlists",
      owner: ownerId,
      generation,
      query: normalizedQueryKey,
      value: cacheable,
    });
  }
  return { value, cache: "miss" };
}

/** Advance the account generation; old KV entries expire unreferenced. */
export async function invalidateReads(
  env: ReadCacheEnv,
  ownerId: string,
): Promise<void> {
  if (!cacheKv(env)) return;
  await env.DB.prepare(
    `INSERT INTO sync_state (account_id, type, cursor)
     SELECT id, ?, ? FROM accounts
     WHERE id = ? AND mode = 'real' AND connected = 1
     ON CONFLICT(account_id, type) DO UPDATE SET cursor = excluded.cursor`,
  )
    .bind(CACHE_STATE_TYPE, crypto.randomUUID(), ownerId)
    .run();
}
