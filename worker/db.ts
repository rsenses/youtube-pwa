/**
 * D1 persistence. All personal data is scoped by account id; SQL is prepared
 * and every mutation validates inputs before reaching this module.
 */
import type {
  Channel,
  PlaylistDetail,
  PlaylistSummary,
  Settings,
  Video,
  SessionRow,
  AccountRow,
} from "./types";
import { isoInDays, nowIso, randomToken, sha256Hex } from "./http";
import type { VideoType } from "../shared/video-type";

export type FeedStatus = "all" | "pending" | "watched";
export type VideoScope = "fixture" | "external";

function videoSourceCondition(scope: VideoScope, alias = "v"): string {
  return scope === "fixture"
    ? `${alias}.source = 'fixture'`
    : `${alias}.source <> 'fixture'`;
}

// OAuth playlist metadata is not necessarily public. Share only RSS/public-key
// verified videos; private imported records remain scoped to their owner's lists.
// Public-key enrichment leaves details_expires_at on the shared row, while
// OAuth-imported placeholders keep it NULL. The production Free profile does not
// import private playlists for other users.
const OWNED_VIDEO_JOIN = `LEFT JOIN account_video_metadata pm ON pm.video_id=v.id AND pm.account_id=?
  AND pm.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const ACCOUNT_VIDEO_CONDITION = `(pm.video_id IS NOT NULL OR (v.purged_at IS NULL AND
  (v.source IN ('fixture','rss')
  OR (v.source='youtube' AND v.details_expires_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM public_read_cache pc WHERE pc.cache_key='public-video:' || v.id
    AND pc.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))))`;

const DEFAULT_SETTINGS: Settings = { theme: "system" };

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

// Feed membership is owner-based: a video belongs to the channel YouTube reports
// as its owner, never to the feed channel that happened to surface it. The feed
// scan is pinned to idx_videos_feed so the date-ordered LIMIT stops early.
const SUBSCRIBED_VIDEO_CONDITION = `v.channel_id IN
  (SELECT channel_id FROM subscriptions WHERE account_id = ? AND active = 1 AND excluded = 0)`;
const CHANNEL_VIDEO_CONDITION = `v.channel_id = ?`;

const VIDEO_COLUMNS = `
  v.id AS id,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.title ELSE COALESCE(json_extract(pm.metadata,'$.title'),v.title) END AS title,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.channel_id ELSE COALESCE(json_extract(pm.metadata,'$.channelId'),v.channel_id) END AS channelId,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.channel_title ELSE COALESCE(json_extract(pm.metadata,'$.channelTitle'),v.channel_title) END AS channelTitle,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.thumbnail_url ELSE COALESCE(json_extract(pm.metadata,'$.thumbnailUrl'),v.thumbnail_url) END AS thumbnailUrl,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.published_at ELSE COALESCE(json_extract(pm.metadata,'$.publishedAt'),v.published_at) END AS publishedAt,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.description ELSE COALESCE(json_extract(pm.metadata,'$.description'),v.description) END AS description,
  CASE WHEN pm.details_fetched_at IS NOT NULL AND pm.details_fetched_at>COALESCE(v.details_fetched_at,'') THEN COALESCE(json_extract(pm.metadata,'$.durationSeconds'),v.duration_seconds) ELSE COALESCE(v.duration_seconds,json_extract(pm.metadata,'$.durationSeconds')) END AS durationSeconds,
  CASE WHEN pm.details_fetched_at IS NOT NULL AND pm.details_fetched_at>COALESCE(v.details_fetched_at,'') THEN COALESCE(json_extract(pm.metadata,'$.isLive'),v.is_live) ELSE COALESCE(v.is_live,json_extract(pm.metadata,'$.isLive')) END AS isLive,
  CASE WHEN pm.details_fetched_at IS NOT NULL AND pm.details_fetched_at>COALESCE(v.details_fetched_at,'') THEN COALESCE(json_extract(pm.metadata,'$.liveBroadcastContent'),v.live_broadcast_content) ELSE COALESCE(v.live_broadcast_content,json_extract(pm.metadata,'$.liveBroadcastContent')) END AS liveBroadcastContent,
  COALESCE(ws.watched, 0) AS watched,
  COALESCE(ws.position_seconds, 0) AS positionSeconds,
  COALESCE(ws.percent, 0) AS percent,
  COALESCE(ws.manual, 0) AS manual,
  CASE WHEN pm.details_fetched_at IS NOT NULL AND pm.details_fetched_at>COALESCE(v.details_fetched_at,'') THEN COALESCE(json_extract(pm.metadata,'$.viewCount'),v.view_count) ELSE COALESCE(v.view_count,json_extract(pm.metadata,'$.viewCount')) END AS viewCount,
  COALESCE(ws.revision, 0) AS revision`;

export function mapVideoRow(row: Record<string, unknown>): Video {
  const video: Video = {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    channelId: String(row.channelId ?? ""),
    channelTitle: String(row.channelTitle ?? ""),
    thumbnailUrl: String(row.thumbnailUrl ?? ""),
    publishedAt: String(row.publishedAt ?? ""),
    description: String(row.description ?? ""),
    durationSeconds: toNullableNumber(row.durationSeconds),
    isLive: row.isLive == null ? null : toNumber(row.isLive) === 1,
    liveBroadcastContent:
      (row.liveBroadcastContent as Video["liveBroadcastContent"]) ?? null,
    watched: toNumber(row.watched) === 1,
    positionSeconds: Math.max(0, toNumber(row.positionSeconds)),
    percent: Math.max(
      0,
      Math.min(100, Math.round(toNumber(row.percent) * 100) / 100),
    ),
    manual: toNumber(row.manual) === 1,
    viewCount: toNullableNumber(row.viewCount),
    revision: toNumber(row.revision),
  };
  if (typeof row.playlistItemId === "string" && row.playlistItemId) {
    video.playlistItemId = row.playlistItemId;
  }
  return video;
}

/* ------------------------------------------------------------------ */
/* Accounts, sessions, settings                                       */
/* ------------------------------------------------------------------ */

export async function ensureDemoAccount(
  db: D1Database,
  now: string = nowIso(),
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO accounts
        (id, mode, name, youtube_channel_id, connected, scopes, token_expires_at, created_at, updated_at)
       VALUES ('demo', 'demo', 'Demo local', NULL, 0, '', NULL, ?, ?)`,
    )
    .bind(now, now)
    .run();
  await ensurePreferences(db, "demo", now);
}

export async function ensurePreferences(
  db: D1Database,
  accountId: string,
  now: string = nowIso(),
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO preferences (account_id, theme, updated_at)
       VALUES (?, ?, ?)`,
    )
    .bind(
      accountId,
      DEFAULT_SETTINGS.theme,
      now,
    )
    .run();
}

export async function getAccount(
  db: D1Database,
  accountId: string,
): Promise<AccountRow | null> {
  const row = await db
    .prepare("SELECT * FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<AccountRow>();
  return row ?? null;
}

export async function insertSession(
  db: D1Database,
  accountId: string | null,
  now: string = nowIso(),
): Promise<{ token: string; session: SessionRow }> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const csrfToken = randomToken(32);
  const expiresAt = isoInDays(30);
  await db
    .prepare(
      `INSERT INTO sessions (id, account_id, csrf_token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, accountId, csrfToken, now, expiresAt)
    .run();
  return {
    token,
    session: {
      id,
      account_id: accountId,
      csrf_token: csrfToken,
      created_at: now,
      expires_at: expiresAt,
    },
  };
}

export async function getSessionByHash(
  db: D1Database,
  sessionHash: string,
): Promise<SessionRow | null> {
  const row = await db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(sessionHash)
    .first<SessionRow>();
  return row ?? null;
}

export async function deleteSession(
  db: D1Database,
  sessionHash: string,
): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionHash).run();
}

export async function linkSessionAccount(
  db: D1Database,
  sessionHash: string,
  accountId: string,
): Promise<void> {
  await db
    .prepare("UPDATE sessions SET account_id = ? WHERE id = ?")
    .bind(accountId, sessionHash)
    .run();
}

/** Bounded cleanup; never deletes more than 50 rows per call. */
export async function cleanupExpiredAuthRows(
  db: D1Database,
  now: string = nowIso(),
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at <= ? LIMIT 50)`,
    )
    .bind(now)
    .run();
  await db
    .prepare(
      `DELETE FROM oauth_attempts
       WHERE state_hash IN (SELECT state_hash FROM oauth_attempts WHERE expires_at <= ? LIMIT 50)`,
    )
    .bind(now)
    .run();
}

export async function getPreferences(
  db: D1Database,
  accountId: string,
): Promise<Settings> {
  const row = await db
    .prepare(
      "SELECT theme FROM preferences WHERE account_id = ?",
    )
    .bind(accountId)
    .first<{ theme: string }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  const theme =
    row.theme === "light" || row.theme === "dark" ? row.theme : "system";
  return { theme };
}

export async function savePreferences(
  db: D1Database,
  accountId: string,
  settings: Settings,
  now: string = nowIso(),
): Promise<Settings> {
  await db
    .prepare(
      `INSERT INTO preferences (account_id, theme, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         theme = excluded.theme,
         updated_at = excluded.updated_at`,
    )
    .bind(accountId, settings.theme, now)
    .run();
  return settings;
}

/* ------------------------------------------------------------------ */
/* Metadata retention                                                 */
/* ------------------------------------------------------------------ */

/**
 * Soft purge: external metadata past its retention deadline is blanked so it
 * cannot be served, while the video row and the user's watch state survive.
 * Fixture rows have expires_at = NULL and are never touched.
 */
export async function purgeExpiredMetadata(
  db: D1Database,
  now: string = nowIso(),
): Promise<{ videos: number; channels: number }> {
  const maintenance = await db.batch([
    db
      .prepare(
        "UPDATE account_video_metadata SET metadata=json_set(json_remove(metadata,'$.durationSeconds','$.viewCount','$.isLive','$.liveBroadcastContent'),'$._detailsExpired',1),details_fetched_at=NULL WHERE details_fetched_at IS NOT NULL AND details_fetched_at<=?",
      )
      .bind(isoInDays(-25, new Date(now))),
    db
      .prepare("DELETE FROM account_video_metadata WHERE expires_at <= ?")
      .bind(now),
    db
      .prepare(
      `UPDATE videos SET duration_seconds = CASE WHEN short_candidate=1 THEN duration_seconds ELSE NULL END, view_count = NULL, is_live = NULL, live_broadcast_content = NULL,
      details_fetched_at = NULL
      WHERE details_fetched_at IS NOT NULL AND details_expires_at IS NOT NULL AND details_expires_at <= ?`,
      )
      .bind(now),
    db
      .prepare("DELETE FROM video_discoveries WHERE last_seen_at <= ?")
      .bind(isoInDays(-30, new Date(now))),
  ]);
  const videos = await db
    .prepare(
      `UPDATE videos SET
         title = '', description = '', channel_title = '', thumbnail_url = '',
         duration_seconds = NULL, view_count = NULL,
         purged_at = ?, updated_at = ?
       WHERE expires_at IS NOT NULL AND expires_at <= ? AND purged_at IS NULL`,
    )
    .bind(now, now, now)
    .run();
  const channels = await db
    .prepare(
      `UPDATE channels SET
         title = '', description = '', thumbnail_url = NULL,
         purged_at = ?, updated_at = ?,
         rss_etag = NULL, rss_last_modified = NULL
       WHERE expires_at IS NOT NULL AND expires_at <= ? AND purged_at IS NULL`,
    )
    .bind(now, now, now)
    .run();
  if (
    (videos.meta.changes || 0) +
      (channels.meta.changes || 0) +
      maintenance.reduce((n, r) => n + (r.meta.changes || 0), 0) >
    0
  ) {
    await db
      .prepare("UPDATE sync_state SET cursor=? WHERE type='cache:reads'")
      .bind(crypto.randomUUID())
      .run();
  }
  return {
    videos: videos.meta.changes ?? 0,
    channels: channels.meta.changes ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Feed, videos, watch state                                          */
/* ------------------------------------------------------------------ */

export interface FeedOptions {
  types?: VideoType[];
  status: FeedStatus;
  channelId: string | null;
  cursor: { publishedAt: string; id: string } | null;
  limit: number;
}

export async function listFeed(
  db: D1Database,
  accountId: string,
  options: FeedOptions,
  scope: VideoScope,
): Promise<{ items: Video[]; hasMore: boolean }> {
  const conditions = [
    "(v.purged_at IS NULL OR pm.video_id IS NOT NULL)",
    videoSourceCondition(scope),
    ACCOUNT_VIDEO_CONDITION,
  ];
  const params: Array<string | number> = [accountId, accountId];

  // The unified feed honors subscriptions; an explicit channel page can
  // show known videos even when the user does not follow that channel.
  if (!options.channelId) {
    conditions.unshift(SUBSCRIBED_VIDEO_CONDITION);
    params.push(accountId);
  }

  if (options.channelId) {
    conditions.push(CHANNEL_VIDEO_CONDITION);
    params.push(options.channelId);
    conditions.push("NOT EXISTS(SELECT 1 FROM subscriptions hidden WHERE hidden.account_id=? AND hidden.channel_id=v.channel_id AND hidden.excluded=1)");
    params.push(accountId);
  }
  if (options.status === "watched") {
    conditions.push("COALESCE(ws.watched, 0) = 1");
  } else if (options.status === "pending") {
    conditions.push("COALESCE(ws.watched, 0) = 0");
  }
  if (options.cursor) {
    conditions.push(
      "(v.published_at < ? OR (v.published_at = ? AND v.id < ?))",
    );
    params.push(
      options.cursor.publishedAt,
      options.cursor.publishedAt,
      options.cursor.id,
    );
  }
  const typeCondition =
    options.types === undefined
      ? ""
      : options.types.length === 0
        ? "WHERE 0"
        : `WHERE (CASE WHEN liveBroadcastContent='live' THEN 'live' WHEN durationSeconds>0 AND durationSeconds<180 THEN 'short' ELSE 'video' END) IN (${options.types.map(() => "?").join(",")})`;
  if (options.types) params.push(...options.types);
  params.push(options.limit + 1);

  const sql = `
    SELECT * FROM (SELECT ${VIDEO_COLUMNS}, v.published_at AS feedPublishedAt
    FROM videos v ${options.channelId ? "" : "INDEXED BY idx_videos_feed"}
    LEFT JOIN watch_states ws ON ws.video_id = v.id AND ws.account_id = ?
    ${OWNED_VIDEO_JOIN}
    WHERE ${conditions.join(" AND ")}
    ) visible ${typeCondition}
    ORDER BY feedPublishedAt DESC, id DESC
    LIMIT ?`;
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const hasMore = rows.length > options.limit;
  return { items: rows.slice(0, options.limit).map(mapVideoRow), hasMore };
}

export async function getVideo(
  db: D1Database,
  accountId: string,
  videoId: string,
  scope: VideoScope,
): Promise<Video | null> {
  const row = await db
    .prepare(
      `SELECT ${VIDEO_COLUMNS}
       FROM videos v
       LEFT JOIN watch_states ws ON ws.video_id = v.id AND ws.account_id = ?
       ${OWNED_VIDEO_JOIN}
       WHERE v.id = ? AND (v.purged_at IS NULL OR pm.video_id IS NOT NULL) AND ${videoSourceCondition(scope)} AND ${ACCOUNT_VIDEO_CONDITION}`,
    )
    .bind(accountId, accountId, videoId)
    .first<Record<string, unknown>>();
  return row ? mapVideoRow(row) : null;
}

/** Personal state for a bounded page of public YouTube previews, in one indexed read. */
export async function getKnownVideoStates(
  db: D1Database,
  accountId: string,
  ids: string[],
): Promise<Map<string, Pick<Video, "watched" | "positionSeconds" | "percent" | "manual" | "revision"> & { persisted: boolean }>> {
  if (!ids.length) return new Map();
  const rows = await db.prepare(
    `SELECT v.id, COALESCE(ws.watched,0) AS watched,
      COALESCE(ws.position_seconds,0) AS positionSeconds,
      COALESCE(ws.percent,0) AS percent,
      COALESCE(ws.manual,0) AS manual,
      COALESCE(ws.revision,0) AS revision,
      CASE WHEN ${ACCOUNT_VIDEO_CONDITION} THEN 1 ELSE 0 END AS persisted
     FROM videos v
     LEFT JOIN watch_states ws ON ws.video_id=v.id AND ws.account_id=?
     ${OWNED_VIDEO_JOIN}
     WHERE v.id IN (${ids.map(() => "?").join(",")})
       AND ${videoSourceCondition("external")}
       AND (${ACCOUNT_VIDEO_CONDITION} OR ws.video_id IS NOT NULL)`,
  ).bind(accountId, accountId, ...ids).all<Record<string, unknown>>();
  return new Map((rows.results ?? []).map((row) => [String(row.id), {
    watched: toNumber(row.watched) === 1,
    positionSeconds: Math.max(0, toNumber(row.positionSeconds)),
    percent: Math.max(0, Math.min(100, toNumber(row.percent))),
    manual: toNumber(row.manual) === 1,
    revision: toNumber(row.revision),
    persisted: toNumber(row.persisted) === 1,
  }]));
}

export async function getSuggestions(
  db: D1Database,
  accountId: string,
  videoId: string,
  limit: number,
  scope: VideoScope,
): Promise<Video[]> {
  const row = await db
    .prepare("SELECT channel_id FROM videos WHERE id = ?")
    .bind(videoId)
    .first<{ channel_id: string }>();
  if (!row) return [];
  const conditions = [
    "(v.purged_at IS NULL OR pm.video_id IS NOT NULL)",
    videoSourceCondition(scope),
    ACCOUNT_VIDEO_CONDITION,
    "v.id <> ?",
  ];
  const params: Array<string | number> = [accountId, accountId, videoId];
  if (scope === "external") {
    conditions.push(
      "(v.channel_id = ? OR v.channel_id IN (SELECT channel_id FROM subscriptions WHERE account_id = ? AND active = 1))",
    );
    params.push(row.channel_id, accountId);
  }
  params.push(row.channel_id, Math.min(20, Math.max(1, limit)));
  const result = await db
    .prepare(
      `SELECT ${VIDEO_COLUMNS}
       FROM videos v
       LEFT JOIN watch_states ws ON ws.video_id = v.id AND ws.account_id = ?
       ${OWNED_VIDEO_JOIN}
       WHERE ${conditions.join(" AND ")}
       ORDER BY CASE WHEN v.channel_id = ? THEN 0 ELSE 1 END, v.published_at DESC, v.id DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(mapVideoRow);
}

export interface WatchSnapshot {
  watched: number;
  manual: number;
  revision: number;
  positionSeconds: number;
  durationSeconds: number | null;
  percent: number;
}

export async function getWatchSnapshot(
  db: D1Database,
  accountId: string,
  videoId: string,
): Promise<WatchSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT watched, manual, revision, position_seconds, duration_seconds, percent
       FROM watch_states WHERE account_id = ? AND video_id = ?`,
    )
    .bind(accountId, videoId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    watched: toNumber(row.watched),
    manual: toNumber(row.manual),
    revision: toNumber(row.revision),
    positionSeconds: toNumber(row.position_seconds),
    durationSeconds: toNullableNumber(row.duration_seconds),
    percent: toNumber(row.percent),
  };
}

export async function setManualWatchState(
  db: D1Database,
  accountId: string,
  videoId: string,
  watched: boolean,
  now: string = nowIso(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watch_states
         (account_id, video_id, watched, watched_at, position_seconds, duration_seconds, percent, manual, revision, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, 0, 1, 1, ?)
       ON CONFLICT(account_id, video_id) DO UPDATE SET
         watched = excluded.watched,
         watched_at = CASE WHEN excluded.watched = 1 THEN excluded.watched_at ELSE NULL END,
         manual = 1,
         revision = watch_states.revision + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(accountId, videoId, watched ? 1 : 0, watched ? now : null, now)
    .run();
}

export interface ProgressWrite {
  positionSeconds: number;
  durationSeconds: number | null;
  percent: number;
}

export async function setProgress(
  db: D1Database,
  accountId: string,
  videoId: string,
  progress: ProgressWrite,
  now: string = nowIso(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watch_states
         (account_id, video_id, position_seconds, duration_seconds, percent, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(account_id, video_id) DO UPDATE SET
         position_seconds = excluded.position_seconds,
         duration_seconds = COALESCE(excluded.duration_seconds, watch_states.duration_seconds),
         percent = CASE WHEN excluded.duration_seconds IS NULL THEN watch_states.percent ELSE excluded.percent END,
         revision = watch_states.revision + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(
      accountId,
      videoId,
      progress.positionSeconds,
      progress.durationSeconds,
      progress.percent,
      now,
    )
    .run();
}

export type BulkScope = "all" | "channel" | "before";

export async function bulkWatchState(
  db: D1Database,
  accountId: string,
  options: {
    scope: BulkScope;
    channelId: string | null;
    before: string | null;
    watched: boolean;
  },
  now: string = nowIso(),
): Promise<number> {
  const conditions = [
    "v.purged_at IS NULL",
    SUBSCRIBED_VIDEO_CONDITION,
    ACCOUNT_VIDEO_CONDITION,
  ];
  const params: Array<string | number | null> = [
    accountId,
    options.watched ? 1 : 0,
    options.watched ? now : null,
    now,
    accountId,
    accountId,
  ];
  if (options.scope === "channel" && options.channelId) {
    conditions.push(CHANNEL_VIDEO_CONDITION);
    params.push(options.channelId);
  }
  if (options.scope === "before" && options.before) {
    conditions.push("v.published_at < ?");
    params.push(options.before);
  }
  const sql = `
    INSERT INTO watch_states
      (account_id, video_id, watched, watched_at, position_seconds, duration_seconds, percent, manual, revision, updated_at)
    SELECT ?, v.id, ?, ?, 0, NULL, 0, 1, 1, ?
    FROM videos v
    ${OWNED_VIDEO_JOIN}
    WHERE ${conditions.join(" AND ")}
    ON CONFLICT(account_id, video_id) DO UPDATE SET
      watched = excluded.watched,
      watched_at = CASE WHEN excluded.watched = 1 THEN excluded.watched_at ELSE NULL END,
      manual = 1,
      revision = watch_states.revision + 1,
      updated_at = excluded.updated_at`;
  const result = await db
    .prepare(sql)
    .bind(...params)
    .run();
  return result.meta.changes ?? 0;
}

/* ------------------------------------------------------------------ */
/* Channels and subscriptions                                         */
/* ------------------------------------------------------------------ */

export async function getChannelRow(
  db: D1Database,
  channelId: string,
): Promise<{
  id: string;
  title: string;
  thumbnail_url: string | null;
  description: string;
  source: string;
  purged_at: string | null;
} | null> {
  const row = await db
    .prepare(
      "SELECT id, title, thumbnail_url, description, source, purged_at FROM channels WHERE id = ?",
    )
    .bind(channelId)
    .first<{
      id: string;
      title: string;
      thumbnail_url: string | null;
      description: string;
      source: string;
      purged_at: string | null;
    }>();
  return row ?? null;
}

export async function listChannels(
  db: D1Database,
  accountId: string,
  query: string | null,
  scope: VideoScope,
  excluded = false,
): Promise<Channel[]> {
  const conditions = [
    "c.purged_at IS NULL",
    scope === "fixture" ? "c.source = 'fixture'" : "c.source <> 'fixture'",
    `COALESCE(s.excluded, 0) = ${excluded ? 1 : 0}`,
    `(s.active = 1 OR s.excluded = 1 OR EXISTS (
        SELECT 1 FROM videos v WHERE v.channel_id = c.id AND v.purged_at IS NULL
          AND ${videoSourceCondition(scope)}
      ))`,
  ];
  const params: Array<string | number> = [accountId];
  if (query) {
    conditions.push(`c.title LIKE ? ESCAPE '\\'`);
    params.push(`%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  }
  const result = await db
    .prepare(
      `SELECT c.id AS id, c.title AS title, c.thumbnail_url AS thumbnailUrl,
              c.description AS description,
              CASE WHEN s.active = 1 THEN 1 ELSE 0 END AS subscribed,
              s.last_synced_at AS lastSyncedAt,
              COALESCE(s.excluded, 0) AS excluded
       FROM channels c
       LEFT JOIN subscriptions s ON s.channel_id = c.id AND s.account_id = ?
       WHERE ${conditions.join(" AND ")}
       ORDER BY CASE WHEN s.active = 1 THEN 0 ELSE 1 END, c.title COLLATE NOCASE ASC`,
    )
    .bind(...params)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    thumbnailUrl:
      row.thumbnailUrl === null || row.thumbnailUrl === undefined
        ? ""
        : String(row.thumbnailUrl),
    description: String(row.description ?? ""),
    subscribed: toNumber(row.subscribed) === 1,
    lastSyncedAt:
      row.lastSyncedAt === null || row.lastSyncedAt === undefined
        ? null
        : String(row.lastSyncedAt),
    excluded: toNumber(row.excluded) === 1,
  }));
}

export async function subscribeLocal(
  db: D1Database,
  accountId: string,
  channelId: string,
  now: string = nowIso(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions
         (account_id, channel_id, remote_subscription_id, active, generation, last_verified_at, last_synced_at, created_at, updated_at)
       VALUES (?, ?, NULL, 1, 'local', ?, NULL, ?, ?)
       ON CONFLICT(account_id, channel_id) DO UPDATE SET
         last_synced_at=CASE WHEN subscriptions.active=0 THEN NULL ELSE subscriptions.last_synced_at END,
         active = 1,
         last_verified_at = excluded.last_verified_at,
         updated_at = excluded.updated_at`,
    )
    .bind(accountId, channelId, now, now, now)
    .run();
}

export async function unsubscribeRow(
  db: D1Database,
  accountId: string,
  channelId: string,
): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE subscriptions SET active = 0, updated_at = ? WHERE account_id = ? AND channel_id = ?",
    )
    .bind(nowIso(), accountId, channelId)
    .run();
  return result.meta.changes ?? 0;
}

export async function getSubscription(
  db: D1Database,
  accountId: string,
  channelId: string,
): Promise<{ remote_subscription_id: string | null; active: number } | null> {
  const row = await db
    .prepare(
      "SELECT remote_subscription_id, active FROM subscriptions WHERE account_id = ? AND channel_id = ?",
    )
    .bind(accountId, channelId)
    .first<{ remote_subscription_id: string | null; active: number }>();
  return row ?? null;
}

export async function upsertRemoteSubscription(
  db: D1Database,
  accountId: string,
  channelId: string,
  remoteId: string | null,
  now: string = nowIso(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions
         (account_id, channel_id, remote_subscription_id, active, generation, last_verified_at, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'local', ?, NULL, ?, ?)
       ON CONFLICT(account_id, channel_id) DO UPDATE SET
         remote_subscription_id = COALESCE(excluded.remote_subscription_id, subscriptions.remote_subscription_id),
         last_synced_at=CASE WHEN subscriptions.active=0 THEN NULL ELSE subscriptions.last_synced_at END,
         active = 1,
         last_verified_at = excluded.last_verified_at,
         updated_at = excluded.updated_at`,
    )
    .bind(accountId, channelId, remoteId, now, now, now)
    .run();
}

/* ------------------------------------------------------------------ */
/* Playlists                                                          */
/* ------------------------------------------------------------------ */

interface PlaylistRow extends Record<string, unknown> {
  id: string;
  title: string;
  description: string;
  source: "local" | "youtube";
  remote_id: string | null;
  privacy_status: string | null;
  item_count: number;
  excluded: number;
}

function mapPlaylistSummary(row: PlaylistRow): PlaylistSummary {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    source: row.source === "youtube" ? "youtube" : "local",
    itemCount: toNumber(row.item_count),
    excluded: toNumber(row.excluded) === 1,
  };
}

export async function listPlaylists(
  db: D1Database,
  accountId: string,
  scope: VideoScope,
  excluded = false,
): Promise<PlaylistSummary[]> {
  const result = await db
    .prepare(
      `SELECT p.id, p.title, p.description, p.source, p.remote_id, p.privacy_status, p.excluded,
              CASE WHEN p.source='youtube' AND p.remote_item_count IS NOT NULL THEN p.remote_item_count ELSE
                (SELECT COUNT(*) FROM playlist_items pi JOIN videos v ON v.id=pi.video_id
                 WHERE pi.playlist_id=p.id AND (v.purged_at IS NULL OR EXISTS(
                   SELECT 1 FROM account_video_metadata own WHERE own.video_id=v.id AND own.account_id=p.account_id
                   AND own.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
                   AND ${videoSourceCondition(scope)})
              END AS item_count
       FROM playlists p
       WHERE p.account_id = ? AND p.excluded = ${excluded ? 1 : 0}
       ORDER BY p.source ASC, p.title COLLATE NOCASE ASC`,
    )
    .bind(accountId)
    .all<PlaylistRow>();
  return (result.results ?? []).map(mapPlaylistSummary);
}

export async function getPlaylistRow(
  db: D1Database,
  accountId: string,
  playlistId: string,
  scope: VideoScope,
): Promise<PlaylistRow | null> {
  const row = await db
    .prepare(
      `SELECT p.id, p.title, p.description, p.source, p.remote_id, p.privacy_status, p.excluded,
              CASE WHEN p.source='youtube' AND p.remote_item_count IS NOT NULL THEN p.remote_item_count ELSE
                (SELECT COUNT(*) FROM playlist_items pi JOIN videos v ON v.id=pi.video_id
                 WHERE pi.playlist_id=p.id AND (v.purged_at IS NULL OR EXISTS(
                   SELECT 1 FROM account_video_metadata own WHERE own.video_id=v.id AND own.account_id=p.account_id
                   AND own.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
                   AND ${videoSourceCondition(scope)})
              END AS item_count
       FROM playlists p WHERE p.id = ? AND p.account_id = ?`,
    )
    .bind(playlistId, accountId)
    .first<PlaylistRow>();
  return row ?? null;
}

export async function getPlaylistItems(
  db: D1Database,
  accountId: string,
  playlistId: string,
  scope: VideoScope,
): Promise<Video[]> {
  const result = await db
    .prepare(
      `SELECT pi.id AS playlistItemId, ${VIDEO_COLUMNS}
       FROM playlist_items pi
       JOIN videos v ON v.id = pi.video_id
       LEFT JOIN watch_states ws ON ws.video_id = v.id AND ws.account_id = ?
       ${OWNED_VIDEO_JOIN}
       WHERE pi.playlist_id = ? AND ${videoSourceCondition(scope)}
       ORDER BY pi.position ASC, pi.id ASC`,
    )
    .bind(accountId, accountId, playlistId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => {
    const video = mapVideoRow(row);
    if (!video.title) video.title = "Vídeo sin metadatos";
    return video;
  });
}

export async function getPlaylistDetail(
  db: D1Database,
  accountId: string,
  playlistId: string,
  scope: VideoScope,
): Promise<PlaylistDetail | null> {
  const row = await getPlaylistRow(db, accountId, playlistId, scope);
  if (!row) return null;
  return {
    ...mapPlaylistSummary(row),
    items: await getPlaylistItems(db, accountId, playlistId, scope),
  };
}

export async function setChannelExcluded(
  db: D1Database,
  accountId: string,
  channelId: string,
  excluded: boolean,
): Promise<void> {
  // A known, unsubscribed channel may still appear through a saved video.
  await db.prepare(
    `INSERT INTO subscriptions(account_id,channel_id,active,excluded,created_at,updated_at)
     SELECT ?,id,0,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
     FROM channels WHERE id=?
     ON CONFLICT(account_id,channel_id) DO UPDATE SET excluded=excluded.excluded,
       updated_at=excluded.updated_at`,
  ).bind(accountId, excluded ? 1 : 0, channelId).run();
}

export async function setPlaylistExcluded(
  db: D1Database,
  accountId: string,
  playlistId: string,
  excluded: boolean,
): Promise<number> {
  const result = await db.prepare(
    "UPDATE playlists SET excluded=?,updated_at=? WHERE account_id=? AND id=?",
  ).bind(excluded ? 1 : 0, nowIso(), accountId, playlistId).run();
  return result.meta.changes ?? 0;
}

export interface NewPlaylist {
  accountId: string;
  title: string;
  description: string;
  source: "local" | "youtube";
  remoteId?: string | null;
  privacyStatus?: string | null;
  remoteItemCount?: number | null;
  seeded?: boolean;
}

export async function createPlaylist(
  db: D1Database,
  input: NewPlaylist,
  now: string = nowIso(),
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO playlists
         (id, account_id, source, remote_id, title, description, privacy_status, remote_item_count,
          fetched_at, items_synced_at, seeded, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .bind(
      id,
      input.accountId,
      input.source,
      input.remoteId ?? null,
      input.title,
      input.description,
      input.privacyStatus ?? null,
      input.remoteItemCount ?? null,
      now,
      input.seeded ? 1 : 0,
      now,
      now,
    )
    .run();
  return id;
}

export async function updatePlaylistRow(
  db: D1Database,
  playlistId: string,
  input: { title: string; description: string },
  now: string = nowIso(),
): Promise<void> {
  await db
    .prepare(
      "UPDATE playlists SET title = ?, description = ?, updated_at = ? WHERE id = ?",
    )
    .bind(input.title, input.description, now, playlistId)
    .run();
}

export async function deletePlaylistRow(
  db: D1Database,
  playlistId: string,
): Promise<void> {
  await db.prepare("DELETE FROM playlists WHERE id = ?").bind(playlistId).run();
}

export async function nextPlaylistPosition(
  db: D1Database,
  playlistId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_items WHERE playlist_id = ?",
    )
    .bind(playlistId)
    .first<{ next: number }>();
  return toNumber(row?.next);
}

export async function addPlaylistItemRow(
  db: D1Database,
  playlistId: string,
  videoId: string,
  position: number,
  remoteItemId: string | null = null,
  now: string = nowIso(),
): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO playlist_items (id, playlist_id, video_id, remote_item_id, position, sync_generation, added_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(id, playlistId, videoId, remoteItemId, position, now),
    db
      .prepare(
        "UPDATE playlists SET remote_item_count=COALESCE(remote_item_count,0)+1,updated_at=? WHERE id=? AND source='youtube'",
      )
      .bind(now, playlistId),
  ]);
  return id;
}

export async function getPlaylistItem(
  db: D1Database,
  accountId: string,
  playlistId: string,
  itemId: string,
): Promise<{
  id: string;
  remote_item_id: string | null;
  source: "local" | "youtube";
} | null> {
  const row = await db
    .prepare(
      `SELECT pi.id AS id, pi.remote_item_id AS remote_item_id, p.source AS source
       FROM playlist_items pi
       JOIN playlists p ON p.id = pi.playlist_id
       WHERE pi.id = ? AND pi.playlist_id = ? AND p.account_id = ?`,
    )
    .bind(itemId, playlistId, accountId)
    .first<{
      id: string;
      remote_item_id: string | null;
      source: "local" | "youtube";
    }>();
  return row ?? null;
}

export async function deletePlaylistItemRow(
  db: D1Database,
  itemId: string,
  playlistId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare("DELETE FROM playlist_items WHERE id = ? AND playlist_id=?")
      .bind(itemId, playlistId),
    db
      .prepare(
        "UPDATE playlists SET remote_item_count=MAX(0,COALESCE(remote_item_count,0)-1),updated_at=? WHERE id=? AND source='youtube'",
      )
      .bind(nowIso(), playlistId),
  ]);
}

/* ------------------------------------------------------------------ */
/* External metadata upserts (used by sync and explicit API writes)   */
/* ------------------------------------------------------------------ */

export interface ExternalVideo {
  id: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  publishedAt: string;
  durationSeconds: number | null;
  viewCount: number | null;
  source: "youtube" | "rss";
  isLive?: boolean;
  liveBroadcastContent?: "none" | "live" | "upcoming" | null;
}

export async function upsertExternalVideo(
  db: D1Database,
  video: ExternalVideo,
  expiresAt: string,
  now: string = nowIso(),
): Promise<void> {
  await externalVideoStatement(db, video, expiresAt, now).run();
}

export function externalVideoStatement(
  db: D1Database,
  video: ExternalVideo,
  expiresAt: string,
  now: string = nowIso(),
  insertOnly = false,
): D1PreparedStatement {
  const insert = `INSERT INTO videos
         (id, channel_id, channel_title, title, description, thumbnail_url, published_at,
         duration_seconds, view_count, source, fetched_at, expires_at, purged_at, created_at, updated_at,
          is_live, details_fetched_at, details_expires_at, live_broadcast_content, short_candidate)`;
  const valuesSql = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?`;
  const shortCandidate = video.durationSeconds !== null && video.durationSeconds > 0 &&
    video.durationSeconds < 180 && video.isLive !== true &&
    (video.liveBroadcastContent == null || video.liveBroadcastContent === "none");
  const retentionDate = shortCandidate
    ? isoInDays(31, new Date(now))
    : expiresAt;
  const values = [
    video.id,
    video.channelId,
    video.channelTitle,
    video.title,
    video.description,
    video.thumbnailUrl,
    video.publishedAt,
    video.durationSeconds,
    video.viewCount,
    video.source,
    now,
    retentionDate,
    now,
    now,
    video.isLive === undefined ? null : video.isLive ? 1 : 0,
    video.isLive === undefined ? null : now,
    video.isLive === undefined ? null : expiresAt,
    video.liveBroadcastContent ?? null,
    shortCandidate ? 1 : 0,
  ] as const;
  // RSS imports only durable new video rows; an existing row keeps its details
  // and watch state untouched. The normal upsert remains for metadata reads.
  if (insertOnly)
    return db.prepare(`${insert} SELECT ${valuesSql} WHERE NOT EXISTS
      (SELECT 1 FROM short_video_tombstones WHERE video_id = ?)
      ON CONFLICT(id) DO NOTHING`).bind(...values, video.id);
  return db
    .prepare(
      `${insert} VALUES (${valuesSql})
       ON CONFLICT(id) DO UPDATE SET
         channel_id = excluded.channel_id,
         channel_title = CASE WHEN excluded.channel_title <> '' THEN excluded.channel_title ELSE videos.channel_title END,
         title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE videos.title END,
         description = CASE WHEN excluded.source='youtube' THEN excluded.description WHEN excluded.source='rss' AND videos.details_fetched_at IS NOT NULL THEN videos.description WHEN excluded.description <> '' THEN excluded.description ELSE videos.description END,
         thumbnail_url = CASE WHEN excluded.source='rss' AND videos.details_fetched_at IS NOT NULL THEN videos.thumbnail_url WHEN excluded.thumbnail_url <> '' THEN excluded.thumbnail_url ELSE videos.thumbnail_url END,
         published_at = excluded.published_at,
         duration_seconds = CASE WHEN excluded.source='youtube' THEN excluded.duration_seconds ELSE COALESCE(excluded.duration_seconds, videos.duration_seconds) END,
         view_count = CASE WHEN excluded.source='youtube' THEN excluded.view_count WHEN excluded.source='rss' AND videos.details_fetched_at IS NOT NULL THEN videos.view_count ELSE COALESCE(excluded.view_count, videos.view_count) END,
         is_live = COALESCE(excluded.is_live, videos.is_live),
         live_broadcast_content = CASE WHEN excluded.source='youtube' THEN excluded.live_broadcast_content ELSE videos.live_broadcast_content END,
         short_candidate = CASE WHEN excluded.source='youtube' THEN excluded.short_candidate
           WHEN excluded.duration_seconds IS NOT NULL THEN excluded.short_candidate ELSE videos.short_candidate END,
         details_fetched_at = COALESCE(excluded.details_fetched_at, videos.details_fetched_at),
         details_expires_at = COALESCE(excluded.details_expires_at, videos.details_expires_at),
         source = CASE WHEN excluded.source='rss' AND videos.details_fetched_at IS NOT NULL THEN videos.source ELSE excluded.source END,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at,
         purged_at = NULL,
         updated_at = excluded.updated_at
       WHERE excluded.source<>'rss' OR videos.purged_at IS NOT NULL
         OR videos.expires_at<=? OR videos.channel_id<>excluded.channel_id OR videos.title<>excluded.title OR (excluded.channel_title<>'' AND videos.channel_title<>excluded.channel_title)
         OR (videos.details_fetched_at IS NULL AND excluded.description<>'' AND videos.description<>excluded.description)
         OR (videos.details_fetched_at IS NULL AND excluded.thumbnail_url<>'' AND videos.thumbnail_url<>excluded.thumbnail_url)`,
    )
    .bind(...values, isoInDays(3, new Date(now)));
}

export interface ExternalChannel {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
}

export async function upsertExternalChannel(
  db: D1Database,
  channel: ExternalChannel,
  expiresAt: string,
  now: string = nowIso(),
): Promise<void> {
  await externalChannelStatement(db, channel, expiresAt, now).run();
}

export function externalChannelStatement(
  db: D1Database,
  channel: ExternalChannel,
  expiresAt: string,
  now: string = nowIso(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO channels
         (id, title, description, thumbnail_url, source, fetched_at, expires_at, purged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'youtube', ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE channels.title END,
         description = CASE WHEN excluded.description <> '' THEN excluded.description ELSE channels.description END,
         thumbnail_url = CASE WHEN excluded.thumbnail_url IS NOT NULL AND excluded.thumbnail_url <> ''
                              THEN excluded.thumbnail_url ELSE channels.thumbnail_url END,
         source = 'youtube',
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at,
         purged_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      channel.id,
      channel.title,
      channel.description,
      channel.thumbnailUrl,
      now,
      expiresAt,
      now,
      now,
    );
}

export async function getRawVideo(
  db: D1Database,
  videoId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare("SELECT * FROM videos WHERE id = ? AND purged_at IS NULL")
    .bind(videoId)
    .first<Record<string, unknown>>();
  return row ?? null;
}

export async function getRawChannel(
  db: D1Database,
  channelId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare("SELECT * FROM channels WHERE id = ?")
    .bind(channelId)
    .first<Record<string, unknown>>();
  return row ?? null;
}
