/** One Queue message advances one durable, bounded step. No credentials in messages/state. */
import type { AccountRow, Env } from "./types";
import {
  ExternalError,
  HttpError,
  fetchWithTimeout,
  isoInDays,
  nowIso,
  readLimitedText,
  sanitizeText,
} from "./http";
import { getValidAccessToken, requireConnectedAccount } from "./auth";
import {
  externalVideoStatement,
  purgeExpiredMetadata,
  type ExternalVideo,
} from "./db";
import { privateVideoStatements } from "./private-metadata";
import {
  MAX_FEED_BYTES,
  channelFeedUrl,
  parseAtomFeed,
  type AtomEntry,
} from "./rss";
import {
  listPlaylists,
  getRemotePlaylist,
  listPlaylistItems,
  listVideos,
  parseIsoDuration,
  pickThumbnailUrl,
  type YouTubeVideoItem,
} from "./youtube";
import { storeVideos } from "./public-youtube";
import { syncSubscriptionStep, type SyncType } from "./sync";

export type SyncMessage = { jobId: string; version: number };
type Phase =
  | "subscriptions"
  | "rss"
  | "playlists"
  | "playlist_items"
  | "metadata"
  | "done";
type Status =
  "queued" | "running" | "retrying" | "paused" | "success" | "error";
interface State {
  phase: Phase;
  requested: SyncType;
  force: boolean;
  startedAt: string;
  lastSuccessAt?: string | null;
  since?: string | null;
  knownChannels?: string[];
  playlistId?: string;
  generation: string;
  pageToken?: string;
  rssCursor?: string;
  rss?: {
    id: string;
    title: string;
    entries: AtomEntry[];
    offset: number;
    etag: string | null;
    modified: string | null;
  };
  playlistCursor?: string;
  playlist?: {
    id: string;
    remoteId: string;
    generation: string;
    startedAt: string;
    pageToken?: string;
    position: number;
  };
  metadataScope?: "public" | "owned";
  metadataCursor?: string;
  items: number;
  processedChannels: number;
  processedPlaylists: number;
  failedChannels?: number;
  failedPlaylists?: number;
  currentChannelId?: string;
}
interface Job {
  id: string;
  account_id: string;
  type: SyncType;
  status: Status;
  state: string;
  version: number;
  enqueued_version: number;
  dispatched_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  message: string | null;
  created_at: string;
  updated_at: string;
}
export interface SyncJobSummary {
  id: string;
  type: SyncType;
  playlistId?: string;
  status: Status;
  phase: Phase;
  items: number;
  processedChannels: number;
  processedPlaylists: number;
  message: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}
const ACTIVE = "('queued','running','retrying','paused')";
const PAGE_SIZE = 10;
const AUTO_INTERVAL_MS = 12 * 3600000;
const STALE_MS = 5 * 60000;
const LEASE_MS = 2 * 60000;
const MAX_ATTEMPTS = 5;
const ID = /^[A-Za-z0-9_-]{11}$/;

function summarize(row: Job): SyncJobSummary {
  const s: State = JSON.parse(row.state);
  return {
    id: row.id,
    type: row.type,
    playlistId: s.playlistId,
    status: row.status,
    phase: s.phase,
    items: s.items,
    processedChannels: s.processedChannels,
    processedPlaylists: s.processedPlaylists,
    message: row.message,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
async function getJob(env: Env, id: string): Promise<Job | null> {
  return env.DB.prepare("SELECT * FROM sync_jobs WHERE id=?")
    .bind(id)
    .first<Job>();
}
function tomorrow(): string {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5),
  ).toISOString();
}
async function pauseBudget(env: Env, job: Job) {
  await env.DB.prepare(
    "UPDATE sync_jobs SET status='paused',next_attempt_at=?,message=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND version=?",
  )
    .bind(
      tomorrow(),
      "Presupuesto diario de cola agotado; los datos y el progreso se conservan.",
      nowIso(),
      job.id,
      job.version,
    )
    .run();
}
/** Persistent publication marker closes the commit/send crash window. Duplicates are harmless. */
async function dispatch(env: Env, job: Job, recover = false): Promise<void> {
  if (!env.SYNC_QUEUE || job.status === "success" || job.status === "error")
    return;
  if (job.next_attempt_at && Date.parse(job.next_attempt_at) > Date.now())
    return;
  if (!recover && job.enqueued_version >= job.version) return;
  const cap = Number(env.SYNC_QUEUE_DAILY_CAP || "2600");
  if (!Number.isInteger(cap) || cap < 1 || cap > 2600)
    throw new Error("Invalid queue budget");
  const permit = await env.DB.prepare(
    `INSERT INTO sync_queue_budget(day,sent) VALUES (?,1)
 ON CONFLICT(day) DO UPDATE SET sent=sent+1 WHERE sent<? RETURNING sent`,
  )
    .bind(nowIso().slice(0, 10), cap)
    .first<{ sent: number }>();
  if (!permit) {
    await pauseBudget(env, job);
    return;
  }
  try {
    await env.SYNC_QUEUE.send({ jobId: job.id, version: job.version });
  } catch {
    // Covers account-wide Queue quota as well as temporary broker outages.
    await env.DB.prepare(
      "UPDATE sync_jobs SET status='paused',next_attempt_at=?,message=?,updated_at=? WHERE id=? AND version=?",
    )
      .bind(
        new Date(Date.now() + 3600000).toISOString(),
        "No se pudo publicar el siguiente paso; se reintentará automáticamente.",
        nowIso(),
        job.id,
        job.version,
      )
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE sync_jobs SET enqueued_version=?,dispatched_at=?,status=CASE WHEN status='paused' THEN 'queued' ELSE status END,
 next_attempt_at=NULL,updated_at=? WHERE id=? AND version=?`,
  )
    .bind(job.version, nowIso(), nowIso(), job.id, job.version)
    .run();
}
export async function startQueuedSync(
  env: Env,
  account: AccountRow,
  type: SyncType,
  force = false,
  playlistId?: string,
) {
  requireConnectedAccount(account);
  const existing = await env.DB.prepare(
    `SELECT * FROM sync_jobs WHERE account_id=? AND status IN ${ACTIVE}`,
  )
    .bind(account.id)
    .first<Job>();
  if (
    existing &&
    (existing.type !== type ||
      JSON.parse(existing.state).playlistId !== playlistId)
  )
    throw new HttpError(
      409,
      "SYNC_BUSY",
      "Hay otra sincronización en curso. Espera a que termine.",
    );
  if (playlistId) {
    const p = await env.DB.prepare(
      "SELECT id FROM playlists WHERE id=? AND account_id=? AND source='youtube' AND remote_id IS NOT NULL",
    )
      .bind(playlistId, account.id)
      .first();
    if (!p)
      throw new HttpError(
        404,
        "PLAYLIST_NOT_FOUND",
        "Lista de YouTube no encontrada.",
      );
  }
  let row = existing;
  if (!row) {
    const now = nowIso();
    const previous = await env.DB.prepare(
      "SELECT last_run_at FROM sync_state WHERE account_id=? AND type IN (?, 'queue:all') AND last_status='success' ORDER BY last_run_at DESC LIMIT 1",
    )
      .bind(account.id, "queue:" + type)
      .first<{ last_run_at: string }>();
    const legacy = previous
      ? null
      : await env.DB.prepare(
          "SELECT created_at AS last_run_at FROM sync_jobs WHERE account_id=? AND type IN (?,'all') AND status='success' ORDER BY created_at DESC LIMIT 1",
        )
          .bind(account.id, type)
          .first<{ last_run_at: string }>();
    const lastSuccessAt = previous?.last_run_at || legacy?.last_run_at || null;
    const known =
      type === "all" || type === "rss"
        ? await env.DB.prepare(
            "SELECT channel_id FROM subscriptions WHERE account_id=? AND active=1 AND last_synced_at IS NOT NULL",
          )
            .bind(account.id)
            .all<{ channel_id: string }>()
        : { results: [] };
    const state: State = {
      phase:
        type === "rss"
          ? "rss"
          : type === "playlists"
            ? "playlists"
            : "subscriptions",
      requested: type,
      force,
      startedAt: now,
      lastSuccessAt,
      playlistId,
      metadataScope: playlistId ? "owned" : undefined,
      knownChannels: (known.results || []).map((row) => row.channel_id),
      since: lastSuccessAt,
      generation: crypto.randomUUID(),
      items: 0,
      processedChannels: 0,
      processedPlaylists: 0,
    };
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO sync_jobs(id,account_id,type,status,state,created_at,updated_at)
   VALUES (?,?,?,'queued',?,?,?)`,
    )
      .bind(id, account.id, type, JSON.stringify(state), now, now)
      .run();
    row = await env.DB.prepare(
      `SELECT * FROM sync_jobs WHERE account_id=? AND status IN ${ACTIVE}`,
    )
      .bind(account.id)
      .first<Job>();
  }
  if (!row)
    throw new HttpError(
      500,
      "SYNC_QUEUE_ERROR",
      "No se pudo registrar la sincronización.",
    );
  await dispatch(env, row);
  const current = (await getJob(env, row.id))!;
  return {
    type,
    mode: "real" as const,
    status: "running" as const,
    items: 0,
    message: "Sincronización en cola; continuará aunque cierres la app.",
    job: summarize(current),
  };
}
export async function queuedSyncStatus(
  env: Env,
  accountId: string,
): Promise<SyncJobSummary[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM sync_jobs WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 10",
  )
    .bind(accountId)
    .all<Job>();
  return (r.results || []).map(summarize);
}

async function subscriptionStep(env: Env, account: AccountRow, s: State) {
  const result = await syncSubscriptionStep(env, account);
  s.items += result.items;
  if (!result.more) s.phase = s.requested === "subscriptions" ? "done" : "rss";
}
async function rssStep(env: Env, account: AccountRow, s: State) {
  const now = nowIso();
  if (!s.rss) {
    const row = await env.DB.prepare(
      `SELECT c.id,c.title,c.rss_etag,c.rss_last_modified,(SELECT last_run_at FROM sync_state WHERE account_id=sub.account_id AND type='queue:rss:' || c.id) AS rss_synced_at,
 EXISTS(SELECT 1 FROM video_discoveries d WHERE d.channel_id=c.id AND d.last_seen_at<=?) AS revalidate FROM subscriptions sub JOIN channels c ON c.id=sub.channel_id
   WHERE sub.account_id=? AND sub.active=1 AND sub.channel_id>? ORDER BY sub.channel_id LIMIT 1`,
    )
      .bind(
        isoInDays(-24, new Date(s.startedAt)),
        account.id,
        s.rssCursor || "",
      )
      .first<{
        id: string;
        title: string;
        rss_etag: string | null;
        rss_last_modified: string | null;
        rss_synced_at: string | null;
        revalidate: number;
      }>();
    if (!row) {
      s.phase = s.requested === "rss" ? "done" : "metadata";
      return;
    }
    s.currentChannelId = row.id;
    const headers: Record<string, string> = {
      accept: "application/atom+xml,application/xml",
    };
    const bootstrap =
      !s.since ||
      (s.knownChannels
        ? !s.knownChannels.includes(row.id)
        : !row.rss_synced_at);
    if (!bootstrap && !row.revalidate && row.rss_etag)
      headers["if-none-match"] = row.rss_etag;
    if (!bootstrap && !row.revalidate && row.rss_last_modified)
      headers["if-modified-since"] = row.rss_last_modified;
    const response = await fetchWithTimeout(channelFeedUrl(row.id), {
      headers,
    });
    if (response.status === 304) {
      await env.DB.prepare(
        "UPDATE channels SET last_synced_at=?,rss_failures=0,rss_next_attempt_at=NULL WHERE id=?",
      )
        .bind(now, row.id)
        .run();
      await env.DB.prepare(
        "INSERT INTO sync_state(account_id,type,last_run_at,last_status) SELECT account_id,'queue:rss:' || channel_id,?,'success' FROM subscriptions WHERE account_id=? AND channel_id=? AND active=1 ON CONFLICT(account_id,type) DO UPDATE SET last_run_at=excluded.last_run_at,last_status='success'",
      )
        .bind(now, account.id, row.id)
        .run();
      s.rssCursor = row.id;
      s.processedChannels++;
      delete s.currentChannelId;
      return;
    }
    if (!response.ok)
      throw new ExternalError(
        "feed_http_" + response.status,
        "YouTube RSS no disponible.",
      );
    const feed = parseAtomFeed(await readLimitedText(response, MAX_FEED_BYTES));
    // Bad entries must not quietly become a successful truncated snapshot.
    if (feed.skipped)
      throw new ExternalError(
        "incomplete_feed",
        "El feed contiene entradas incompletas.",
      );
    const maintenanceIds = new Set<string>();
    if (!bootstrap) {
      const oldIds = feed.entries
        .filter((e) => e.publishedAt < s.since!)
        .map((e) => e.videoId);
      if (oldIds.length) {
        const due = await env.DB.prepare(
          `SELECT v.id,(v.expires_at<=? OR d.video_id IS NULL OR d.last_seen_at<=?) AS due FROM videos v LEFT JOIN video_discoveries d ON d.video_id=v.id AND d.channel_id=?
 WHERE v.id IN (${oldIds.map(() => "?").join(",")})`,
        )
          .bind(
            isoInDays(1, new Date(s.startedAt)),
            isoInDays(-24, new Date(s.startedAt)),
            row.id,
            ...oldIds,
          )
          .all<{ id: string; due: number }>();
        const knownIds = new Set((due.results || []).map((v) => v.id));
        for (const id of oldIds) if (!knownIds.has(id)) maintenanceIds.add(id);
        for (const v of due.results || []) if (v.due) maintenanceIds.add(v.id);
      }
    }
    s.rss = {
      id: row.id,
      title: sanitizeText(feed.title || row.title, 300),
      entries: bootstrap
        ? feed.entries
        : feed.entries.filter(
            (entry) =>
              entry.publishedAt >= s.since! ||
              maintenanceIds.has(entry.videoId),
          ),
      offset: 0,
      etag: response.headers.get("etag")?.slice(0, 500) || null,
      modified: response.headers.get("last-modified")?.slice(0, 500) || null,
    };
  }
  const feed = s.rss;
  const entries = feed.entries.slice(feed.offset, feed.offset + 15);
  const statements: D1PreparedStatement[] = [];
  for (const e of entries) {
    // videos.channel_id is not an FK. Owner channel details are fetched on demand,
    // avoiding an extra per-entry statement while preserving discovery provenance.
    statements.push(
      externalVideoStatement(
        env.DB,
        {
          id: e.videoId,
          channelId: e.channelId || feed.id,
          channelTitle: e.channelTitle || feed.title,
          title: e.title,
          description: e.description,
          thumbnailUrl: e.thumbnailUrl,
          publishedAt: e.publishedAt,
          durationSeconds: e.durationSeconds,
          viewCount: e.viewCount,
          source: "rss",
        },
        isoInDays(25),
        now,
      ),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO video_discoveries(video_id,channel_id,last_seen_at) VALUES (?,?,?)
   ON CONFLICT(video_id,channel_id) DO UPDATE SET last_seen_at=excluded.last_seen_at WHERE video_discoveries.last_seen_at<=?`,
      ).bind(e.videoId, feed.id, now, isoInDays(-1)),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  feed.offset += entries.length;
  s.items += entries.length;
  if (feed.offset >= feed.entries.length) {
    await env.DB.prepare(
      `UPDATE channels SET title=?,last_synced_at=?,expires_at=?,purged_at=NULL,
   rss_etag=?,rss_last_modified=?,rss_failures=0,rss_next_attempt_at=NULL,updated_at=? WHERE id=?`,
    )
      .bind(
        feed.title,
        now,
        isoInDays(25),
        feed.etag,
        feed.modified,
        now,
        feed.id,
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO sync_state(account_id,type,last_run_at,last_status) SELECT account_id,'queue:rss:' || channel_id,?,'success' FROM subscriptions WHERE account_id=? AND channel_id=? AND active=1 ON CONFLICT(account_id,type) DO UPDATE SET last_run_at=excluded.last_run_at,last_status='success'",
    )
      .bind(now, account.id, feed.id)
      .run();
    s.rssCursor = feed.id;
    s.processedChannels++;
    delete s.rss;
    delete s.currentChannelId;
  }
}
async function playlistSummaries(env: Env, account: AccountRow, s: State) {
  const token = await getValidAccessToken(env, account.id);
  const scoped = s.playlistId
    ? await env.DB.prepare(
        "SELECT remote_id FROM playlists WHERE id=? AND account_id=? AND source='youtube'",
      )
        .bind(s.playlistId, account.id)
        .first<{ remote_id: string }>()
    : null;
  if (s.playlistId && !scoped)
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "La lista ya no existe.");
  const data = scoped
    ? await getRemotePlaylist(token, scoped.remote_id)
    : await listPlaylists(token, s.pageToken, PAGE_SIZE);
  if (scoped && !data.items?.some((p) => p.id === scoped.remote_id))
    throw new ExternalError(
      "playlist_unavailable",
      "No se pudo consultar esta lista. Los datos anteriores se conservan.",
    );
  if (!Array.isArray(data.items)) throw new ExternalError("invalid_response");
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const p of data.items.filter(
    (p) => !scoped || p.id === scoped.remote_id,
  )) {
    if (p.id === "WL" || p.id === "HL") continue;
    if (!p.id || !/^[-\w]{1,64}$/.test(p.id) || !p.snippet?.title)
      throw new ExternalError("incomplete_playlist");
    const privacy = p.status?.privacyStatus;
    statements.push(
      env.DB.prepare(
        `INSERT INTO playlists(id,account_id,source,remote_id,title,description,privacy_status,remote_item_count,fetched_at,created_at,updated_at)
   SELECT ?,?,'youtube',?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND connected=1) AND (?='' OR EXISTS(SELECT 1 FROM playlists target WHERE target.id=? AND target.account_id=?)) ON CONFLICT(account_id,remote_id) DO UPDATE SET
   title=excluded.title,description=excluded.description,privacy_status=excluded.privacy_status,
   remote_item_count=excluded.remote_item_count,fetched_at=excluded.fetched_at,
   items_synced_at=CASE WHEN playlists.remote_item_count IS NOT excluded.remote_item_count THEN NULL ELSE playlists.items_synced_at END,
   updated_at=excluded.updated_at WHERE playlists.updated_at<=?`,
      ).bind(
        s.playlistId || crypto.randomUUID(),
        account.id,
        p.id,
        sanitizeText(p.snippet.title, 500),
        sanitizeText(p.snippet.description, 5000),
        ["public", "private", "unlisted"].includes(privacy || "")
          ? privacy!
          : null,
        p.contentDetails?.itemCount ?? null,
        now,
        now,
        now,
        account.id,
        s.playlistId || "",
        s.playlistId || "",
        account.id,
        s.startedAt,
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  s.pageToken = data.nextPageToken;
  if (!s.pageToken) {
    // Only a complete remote snapshot may remove remote lists. Local edits newer
    // than the snapshot start are preserved; local lists are never reconciled here.
    if (!s.playlistId)
      await env.DB.prepare(
        "DELETE FROM playlists WHERE account_id=? AND source='youtube' AND fetched_at<? AND updated_at<?",
      )
        .bind(account.id, s.startedAt, s.startedAt)
        .run();
    s.phase = s.playlistId ? "playlist_items" : "done";
  }
}
function videoFromApi(item: YouTubeVideoItem): ExternalVideo | null {
  const p = item.snippet;
  if (
    !item.id ||
    !ID.test(item.id) ||
    !p?.title ||
    !p.publishedAt ||
    !Number.isFinite(Date.parse(p.publishedAt))
  )
    return null;
  return {
    id: item.id,
    channelId: p.channelId || "",
    channelTitle: sanitizeText(p.channelTitle, 300),
    title: sanitizeText(p.title, 500),
    description: sanitizeText(p.description, 5000),
    thumbnailUrl: pickThumbnailUrl(p.thumbnails),
    publishedAt: new Date(p.publishedAt).toISOString(),
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    viewCount:
      item.statistics?.viewCount && /^\d{1,15}$/.test(item.statistics.viewCount)
        ? Number(item.statistics.viewCount)
        : null,
    isLive: p.liveBroadcastContent !== "none",
    liveBroadcastContent: p?.liveBroadcastContent ?? null,
    source: "youtube",
  };
}
async function playlistItemsStep(env: Env, account: AccountRow, s: State) {
  const now = nowIso();
  if (!s.playlist) {
    const p = await env.DB.prepare(
      `SELECT id,remote_id FROM playlists WHERE account_id=? AND source='youtube' AND id>?
   AND remote_id IS NOT NULL AND id=? AND (?=1 OR items_synced_at IS NULL OR items_synced_at<=?) ORDER BY id LIMIT 1`,
    )
      .bind(
        account.id,
        s.playlistCursor || "",
        s.playlistId || "",
        s.force ? 1 : 0,
        isoInDays(-1),
      )
      .first<{ id: string; remote_id: string }>();
    if (!p) {
      s.phase = s.playlistId ? "metadata" : "done";
      return;
    }
    s.playlist = {
      id: p.id,
      remoteId: p.remote_id,
      generation: crypto.randomUUID(),
      startedAt: now,
      position: 0,
    };
  }
  const p = s.playlist;
  const owned = await env.DB.prepare(
    "SELECT id FROM playlists WHERE id=? AND account_id=? AND source='youtube'",
  )
    .bind(p.id, account.id)
    .first();
  if (!owned) {
    s.playlistCursor = p.id;
    delete s.playlist;
    return;
  }
  const data = await listPlaylistItems(
    await getValidAccessToken(env, account.id),
    p.remoteId,
    p.pageToken,
    PAGE_SIZE,
  );
  if (!Array.isArray(data.items)) throw new ExternalError("invalid_response");
  const statements: D1PreparedStatement[] = [];
  for (const entry of data.items) {
    const id =
      entry.contentDetails?.videoId || entry.snippet?.resourceId?.videoId;
    const snippet = entry.snippet;
    const date = entry.contentDetails?.videoPublishedAt || snippet?.publishedAt;
    if (
      !id ||
      !ID.test(id) ||
      !entry.id ||
      entry.id.length > 200 ||
      !snippet?.title ||
      !date ||
      !Number.isFinite(Date.parse(date))
    )
      throw new ExternalError("incomplete_playlist_item");
    const v: ExternalVideo = {
      id,
      channelId: snippet.videoOwnerChannelId || "",
      channelTitle:
        sanitizeText(snippet.videoOwnerChannelTitle, 300) || "YouTube",
      title: sanitizeText(snippet.title, 500),
      description: sanitizeText(snippet.description, 5000),
      thumbnailUrl: pickThumbnailUrl(snippet.thumbnails),
      publishedAt: new Date(date).toISOString(),
      durationSeconds: null,
      viewCount: null,
      source: "youtube",
    };
    statements.push(
      ...privateVideoStatements(env.DB, account.id, v, now, isoInDays(25)),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO playlist_items(id,playlist_id,video_id,remote_item_id,position,sync_generation,added_at)
   VALUES (?,?,?,?,?,?,?) ON CONFLICT(playlist_id,remote_item_id) DO UPDATE SET video_id=excluded.video_id,
   position=excluded.position,sync_generation=excluded.sync_generation`,
      ).bind(
        crypto.randomUUID(),
        p.id,
        id,
        entry.id,
        Math.max(0, Math.floor(snippet.position ?? p.position)),
        p.generation,
        now,
      ),
    );
    p.position++;
    s.items++;
  }
  if (statements.length) await env.DB.batch(statements);
  p.pageToken = data.nextPageToken;
  if (!p.pageToken) {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM playlist_items WHERE playlist_id=? AND added_at<? AND sync_generation IS NOT NULL AND sync_generation<>?",
      ).bind(p.id, p.startedAt, p.generation),
      env.DB.prepare(
        "UPDATE playlists SET items_synced_at=?,remote_item_count=(SELECT count(*) FROM playlist_items WHERE playlist_id=?),updated_at=? WHERE id=? AND account_id=?",
      ).bind(now, p.id, now, p.id, account.id),
    ]);
    s.playlistCursor = p.id;
    s.processedPlaylists++;
    delete s.playlist;
  }
}
async function metadataStep(env: Env, account: AccountRow, s: State) {
  const owned = s.metadataScope === "owned";
  const cursor = s.metadataCursor || "";
  const since = s.lastSuccessAt || "0000";
  const baseline = s.lastSuccessAt || "0000";
  const maintenance = isoInDays(1, new Date(s.startedAt));
  const recent = new Date(Date.parse(s.startedAt) - 3600000).toISOString();
  const live = new Date(Date.parse(s.startedAt) - 300000).toISOString();
  const rows = owned
    ? await env.DB.prepare(
        `SELECT pm.video_id AS id FROM account_video_metadata pm WHERE pm.account_id=? AND pm.video_id>?
 AND (?='' OR EXISTS(SELECT 1 FROM playlist_items scoped WHERE scoped.playlist_id=? AND scoped.video_id=pm.video_id))
 AND (pm.expires_at<=? OR pm.details_fetched_at<=? OR json_extract(pm.metadata,'$._detailsExpired')=1
 OR (json_extract(pm.metadata,'$.publishedAt')>=? AND pm.details_fetched_at<=?)
 OR (pm.details_fetched_at IS NULL AND (?<>'' OR json_extract(pm.metadata,'$.publishedAt')>=? OR EXISTS(
   SELECT 1 FROM playlist_items pi JOIN playlists p ON p.id=pi.playlist_id
   WHERE pi.video_id=pm.video_id AND p.account_id=pm.account_id AND pi.added_at>=?)))
 OR ((json_extract(pm.metadata,'$.liveBroadcastContent') IN ('live','upcoming') OR (json_extract(pm.metadata,'$.liveBroadcastContent') IS NULL AND json_extract(pm.metadata,'$.isLive')=1)) AND (pm.details_fetched_at IS NULL OR pm.details_fetched_at<=?)))
 ORDER BY pm.video_id LIMIT 8`,
      )
        .bind(
          account.id,
          cursor,
          s.playlistId || "",
          s.playlistId || "",
          maintenance,
          isoInDays(-24, new Date(s.startedAt)),
          since,
          recent,
          s.playlistId || "",
          since,
          baseline,
          live,
        )
        .all<{ id: string }>()
    : await env.DB.prepare(
        `SELECT v.id FROM videos v WHERE v.source<>'fixture' AND v.id>?
 AND (v.expires_at<=? OR v.details_expires_at<=?
 OR (v.published_at>=? AND v.details_fetched_at<=?)
 OR (v.details_fetched_at IS NULL AND (v.published_at>=? OR v.created_at>=? OR v.fetched_at>=? OR EXISTS(
   SELECT 1 FROM playlist_items pi JOIN playlists p ON p.id=pi.playlist_id
   WHERE pi.video_id=v.id AND p.account_id=? AND pi.added_at>=?)))
 OR ((v.live_broadcast_content IN ('live','upcoming') OR (v.live_broadcast_content IS NULL AND v.is_live=1)) AND (v.details_fetched_at IS NULL OR v.details_fetched_at<=?)))
 AND (v.source='rss' OR EXISTS(SELECT 1 FROM video_discoveries d WHERE d.video_id=v.id))
 AND (EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.account_id=? AND sub.channel_id=v.channel_id AND sub.active=1)
   OR EXISTS(SELECT 1 FROM playlist_items pi JOIN playlists p ON p.id=pi.playlist_id WHERE p.account_id=? AND pi.video_id=v.id)
   OR EXISTS(SELECT 1 FROM video_discoveries vd CROSS JOIN subscriptions sub WHERE vd.video_id=v.id AND sub.channel_id=vd.channel_id AND sub.account_id=? AND sub.active=1))
 ORDER BY v.id LIMIT 8`,
      )
        .bind(
          cursor,
          maintenance,
          maintenance,
          since,
          recent,
          since,
          baseline,
          s.startedAt,
          account.id,
          baseline,
          live,
          account.id,
          account.id,
          account.id,
        )
        .all<{ id: string }>();
  const ids = (rows.results || []).map((r) => r.id);
  if (!ids.length) {
    if (!owned) {
      s.metadataScope = "owned";
      delete s.metadataCursor;
      return;
    }
    await purgeExpiredMetadata(env.DB);
    s.phase = "done";
    return;
  }
  const credential = owned
    ? await getValidAccessToken(env, account.id)
    : env.YOUTUBE_API_KEY
      ? { apiKey: env.YOUTUBE_API_KEY }
      : await getValidAccessToken(env, account.id);
  const data = await listVideos(credential, ids);
  if (!Array.isArray(data.items)) throw new ExternalError("invalid_response");
  const seen = new Set<string>();
  const now = nowIso();
  if (owned) {
    const statements: D1PreparedStatement[] = [];
    for (const entry of data.items) {
      if (!entry.id || !ids.includes(entry.id)) continue;
      const v = videoFromApi(entry);
      if (!v) throw new ExternalError("incomplete_video");
      seen.add(v.id);
      statements.push(
        ...privateVideoStatements(
          env.DB,
          account.id,
          v,
          now,
          isoInDays(25),
          true,
        ),
      );
    }
    for (const id of ids)
      if (!seen.has(id))
        statements.push(
          env.DB.prepare(
            "DELETE FROM account_video_metadata WHERE account_id=? AND video_id=?",
          ).bind(account.id, id),
        );
    if (statements.length) await env.DB.batch(statements);
  } else {
    const entries = data.items.filter(
      (e) => e.id && ids.includes(e.id) && e.status?.privacyStatus === "public",
    );
    for (const id of await storeVideos(env, entries)) seen.add(id);
    const missing = ids.filter((id) => !seen.has(id));
    if (missing.length)
      await env.DB.batch(
        missing.flatMap((id) => [
          env.DB.prepare(
            "UPDATE videos SET title='',description='',channel_title='',thumbnail_url='',duration_seconds=NULL,view_count=NULL,is_live=NULL,live_broadcast_content=NULL,details_fetched_at=NULL,details_expires_at=NULL,purged_at=?,expires_at=? WHERE id=?",
          ).bind(now, isoInDays(25), id),
          env.DB.prepare(
            "DELETE FROM public_read_cache WHERE cache_key=?",
          ).bind("public-video:" + id),
        ]),
      );
  }
  s.items += seen.size;
  s.metadataCursor = ids[ids.length - 1];
}
async function step(env: Env, account: AccountRow, s: State) {
  s.since = s.lastSuccessAt || null;
  if (
    s.requested !== "playlists" &&
    (s.phase === "playlists" || s.phase === "playlist_items")
  ) {
    s.phase = "metadata";
    delete s.playlist;
  }
  if (s.phase === "subscriptions") return subscriptionStep(env, account, s);
  if (s.phase === "rss") return rssStep(env, account, s);
  if (s.phase === "playlists") return playlistSummaries(env, account, s);
  if (s.phase === "playlist_items") return playlistItemsStep(env, account, s);
  if (s.phase === "metadata") return metadataStep(env, account, s);
  if (s.phase !== "done")
    throw new HttpError(
      500,
      "INVALID_SYNC_STATE",
      "Estado de sincronización no válido.",
    );
}

export async function consumeSyncQueue(
  batch: MessageBatch<SyncMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body;
    if (
      !body ||
      typeof body.jobId !== "string" ||
      body.jobId.length > 100 ||
      !Number.isSafeInteger(body.version) ||
      body.version < 0
    ) {
      msg.ack();
      continue;
    }
    const job = await getJob(env, body.jobId);
    if (!job || job.status === "success" || job.status === "error") {
      msg.ack();
      continue;
    }
    if (job.next_attempt_at && Date.parse(job.next_attempt_at) > Date.now()) {
      msg.ack();
      continue;
    }
    if (body.version !== job.version) {
      if (body.version < job.version) await dispatch(env, job);
      msg.ack();
      continue;
    }
    if (job.attempts >= MAX_ATTEMPTS) {
      await env.DB.prepare(
        "UPDATE sync_jobs SET status='error',message=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
      )
        .bind(
          "No se pudo completar este paso tras varios intentos; puedes volver a actualizar.",
          nowIso(),
          job.id,
        )
        .run();
      msg.ack();
      continue;
    }
    const owner = crypto.randomUUID();
    const now = nowIso();
    const lock = await env.DB.prepare(
      `UPDATE sync_jobs SET lease_owner=?,lease_expires_at=?,attempts=attempts+1,status='running',updated_at=?
   WHERE id=? AND version=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)`,
    )
      .bind(
        owner,
        new Date(Date.now() + LEASE_MS).toISOString(),
        now,
        job.id,
        job.version,
        now,
      )
      .run();
    if (!lock.meta.changes) {
      msg.retry({ delaySeconds: 30 });
      continue;
    }
    let state: State | undefined;
    try {
      const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=?")
        .bind(job.account_id)
        .first<AccountRow>();
      if (!account || !account.connected)
        throw new HttpError(
          401,
          "RECONNECT_REQUIRED",
          "Vuelve a conectar Google.",
        );
      const s: State = JSON.parse(job.state);
      state = s;
      await step(env, account, s);
      const done = s.phase === "done";
      const save = env.DB.prepare(
        `UPDATE sync_jobs SET state=?,version=version+1,status=?,attempts=0,message=?,
    next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND version=? AND lease_owner=?`,
      ).bind(
        JSON.stringify(s),
        done
          ? s.failedChannels || s.failedPlaylists
            ? "error"
            : "success"
          : "running",
        done
          ? s.failedChannels || s.failedPlaylists
            ? `Finalizada con incidencias: ${s.failedChannels || 0} canales y ${s.failedPlaylists || 0} listas pendientes. El resto se ha conservado.`
            : "Sincronización completada."
          : null,
        nowIso(),
        job.id,
        job.version,
        owner,
      );
      const statements = [save];
      if (done && !s.failedChannels && !s.failedPlaylists)
        statements.push(
          env.DB.prepare(
            `INSERT INTO sync_state(account_id,type,last_run_at,last_status)
 SELECT account_id,'queue:' || type,json_extract(state,'$.startedAt'),'success' FROM sync_jobs
 WHERE id=? AND version=? AND status='success' AND EXISTS(SELECT 1 FROM accounts WHERE id=sync_jobs.account_id AND connected=1)
 ON CONFLICT(account_id,type) DO UPDATE SET last_run_at=MAX(COALESCE(sync_state.last_run_at,''),excluded.last_run_at),last_status='success'`,
          ).bind(job.id, job.version + 1),
        );
      if (done && env.READ_CACHE)
        statements.push(
          env.DB.prepare(
            `INSERT INTO sync_state(account_id,type,cursor)
 SELECT j.account_id,'cache:reads',? FROM sync_jobs j JOIN accounts a ON a.id=j.account_id
 WHERE j.id=? AND j.version=? AND j.status IN ('success','error') AND a.connected=1
 ON CONFLICT(account_id,type) DO UPDATE SET cursor=excluded.cursor`,
          ).bind(crypto.randomUUID(), job.id, job.version + 1),
        );
      const [saved] = await env.DB.batch(statements);
      if (saved.meta.changes && !done)
        await dispatch(env, (await getJob(env, job.id))!);
      msg.ack();
    } catch (error) {
      const reason = error instanceof ExternalError ? error.reason : "";
      const permanentFeed = /^feed_http_(404|410)$/.test(reason);
      const finalAttempt = job.attempts + 1 >= MAX_ATTEMPTS;
      if (
        state &&
        (permanentFeed || finalAttempt) &&
        error instanceof ExternalError &&
        !["quotaexceeded", "dailylimitexceeded", "invalid_grant"].includes(
          reason,
        ) &&
        ((state.phase === "rss" && state.currentChannelId) ||
          (state.phase === "playlist_items" && state.playlist))
      ) {
        if (state.phase === "rss") {
          const channel = state.currentChannelId!;
          await env.DB.prepare(
            "UPDATE channels SET rss_failures=rss_failures+1,rss_next_attempt_at=? WHERE id=?",
          )
            .bind(new Date(Date.now() + 3600000).toISOString(), channel)
            .run();
          state.rssCursor = channel;
          state.processedChannels++;
          state.failedChannels = (state.failedChannels || 0) + 1;
          delete state.rss;
          delete state.currentChannelId;
        } else {
          state.playlistCursor = state.playlist!.id;
          state.failedPlaylists = (state.failedPlaylists || 0) + 1;
          delete state.playlist;
        }
        const skipped = await env.DB.prepare(
          "UPDATE sync_jobs SET state=?,version=version+1,status='running',attempts=0,message=?,next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND version=? AND lease_owner=?",
        )
          .bind(
            JSON.stringify(state),
            "Se conserva la información del elemento que falló y se continúa con los demás.",
            nowIso(),
            job.id,
            job.version,
            owner,
          )
          .run();
        if (skipped.meta.changes)
          await dispatch(env, (await getJob(env, job.id))!);
        msg.ack();
        continue;
      }
      if (
        state &&
        ["invalidpagetoken", "invalid_page_token"].includes(reason)
      ) {
        if (state.phase === "subscriptions")
          await env.DB.prepare(
            "UPDATE sync_state SET cursor=NULL WHERE account_id=? AND type='subscriptions'",
          )
            .bind(job.account_id)
            .run();
        else if (state.phase === "playlists") delete state.pageToken;
        else if (state.playlist) {
          delete state.playlist.pageToken;
          state.playlist.generation = crypto.randomUUID();
          state.playlist.startedAt = nowIso();
          state.playlist.position = 0;
        }
        await env.DB.prepare(
          "UPDATE sync_jobs SET state=? WHERE id=? AND lease_owner=?",
        )
          .bind(JSON.stringify(state), job.id, owner)
          .run();
      }
      const reconnect =
        error instanceof HttpError && error.code === "RECONNECT_REQUIRED";
      const exhausted = job.attempts + 1 >= MAX_ATTEMPTS;
      const quota =
        error instanceof ExternalError &&
        ["quotaexceeded", "dailylimitexceeded"].includes(error.reason);
      const delay = quota ? 3600 : Math.min(900, 30 * 2 ** job.attempts);
      const status: Status =
        reconnect || exhausted ? "error" : quota ? "paused" : "retrying";
      const text = reconnect
        ? "Vuelve a conectar Google para sincronizar."
        : quota
          ? "Cuota YouTube agotada; se reintentará sin perder progreso."
          : exhausted
            ? "No se pudo completar el paso tras varios intentos. Vuelve a actualizar."
            : "Error temporal; se reintentará conservando los datos.";
      await env.DB.prepare(
        `UPDATE sync_jobs SET status=?,message=?,next_attempt_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?`,
      )
        .bind(
          status,
          text,
          status === "error"
            ? null
            : new Date(Date.now() + delay * 1000).toISOString(),
          nowIso(),
          job.id,
          owner,
        )
        .run();
      if (status === "retrying") msg.retry({ delaySeconds: delay });
      else msg.ack();
    }
  }
}

/** Cron repairs the publication gap, expired broker messages and quota pauses. */
export async function recoverAndScheduleSync(env: Env): Promise<void> {
  if (!env.SYNC_QUEUE || env.MODE !== "real") return;
  const now = nowIso();
  const stale = await env.DB.prepare(
    `SELECT * FROM sync_jobs WHERE status IN ${ACTIVE}
  AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND (next_attempt_at IS NULL OR next_attempt_at<=?)
  AND (enqueued_version<version OR dispatched_at IS NULL OR dispatched_at<=?) ORDER BY updated_at LIMIT 3`,
  )
    .bind(now, now, new Date(Date.now() - STALE_MS).toISOString())
    .all<Job>();
  for (const job of stale.results || []) await dispatch(env, job, true);
  const account = await env.DB.prepare(
    `SELECT * FROM accounts a WHERE mode='real' AND connected=1
  AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.account_id=a.id AND j.status IN ${ACTIVE})
  AND COALESCE((SELECT MAX(created_at) FROM sync_jobs j WHERE j.account_id=a.id),'')<=?
  ORDER BY COALESCE((SELECT MAX(created_at) FROM sync_jobs j WHERE j.account_id=a.id),'') LIMIT 1`,
  )
    .bind(new Date(Date.now() - AUTO_INTERVAL_MS).toISOString())
    .first<AccountRow>();
  if (account) await startQueuedSync(env, account, "all", false);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sync_queue_budget WHERE day<?").bind(
      isoInDays(-7).slice(0, 10),
    ),
    env.DB.prepare(
      "DELETE FROM sync_jobs WHERE status IN ('success','error') AND updated_at<?",
    ).bind(isoInDays(-7)),
  ]);
}
