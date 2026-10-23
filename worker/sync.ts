/**
 * Bounded synchronization with atomic D1 leases.
 *
 * Every run records a sync_runs row. A partial snapshot never deactivates
 * subscriptions or deletes playlist items. RSS is fetched only from the
 * YouTube channel feed derived from a stored channel id (no arbitrary URLs).
 */
import { isWebSubEnabled } from "./websub";
import { isRecentEnough, oldestVideoDate } from "./rss";
import { runChannelSync } from "./channel-sync";
import { runWeeklyVideoRetention } from "./video-retention";
import type { AccountRow, Env, SyncRun } from "./types";
import { privateVideoStatements } from "./private-metadata";
import {
  startQueuedSync,
  queuedSyncStatus,
  recoverAndScheduleSync,
  type SyncJobSummary,
} from "./queue-sync";
import {
  ExternalError,
  HttpError,
  fetchWithTimeout,
  readLimitedText,
  isoInDays,
  nowIso,
  randomToken,
  sanitizeError,
  sanitizeText,
} from "./http";
import {
  externalChannelStatement,
  externalVideoStatement,
  purgeExpiredMetadata,
  toNumber,
  type ExternalChannel,
  type ExternalVideo,
} from "./db";
import { getValidAccessToken, requireConnectedAccount } from "./auth";
import { MAX_FEED_BYTES, channelFeedUrl, parseAtomFeed } from "./rss";
import { readRssCheck, rssRecentCutoff, writeRssCheck } from "./rss-cache";
import {
  listPlaylistItems,
  listPlaylists,
  listSubscriptions,
  listVideos,
  parseIsoDuration,
  pickThumbnailUrl,
  type YouTubePlaylistItemEntry,
} from "./youtube";

export const SYNC_TYPES = ["all", "subscriptions", "rss", "playlists"] as const;
export type SyncType = (typeof SYNC_TYPES)[number];

export function isSyncType(value: string): value is SyncType {
  return (SYNC_TYPES as readonly string[]).includes(value);
}

const LEASE_TTL_MS = 15 * 60 * 1000;
const SUBSCRIPTION_MAX_PAGES = 10;
const RSS_BATCH = 5; // Maximum parallel feed requests, not a five-channel total.
const RSS_MAX_BATCHES = 30;
const RSS_BUDGET_MS = 45_000;
const PLAYLIST_MAX_PAGES = 5;
const PLAYLIST_IMPORT_BATCH = 3;
const PLAYLIST_ITEM_MAX_PAGES = 10;
const METADATA_RENEW_BATCH = 50;
const BATCH_LIMIT = 80;
export const METADATA_TTL_DAYS = 25;
const SYNC_RUNS_KEPT = 50;

type OutcomeStatus = "success" | "partial" | "noop" | "error";

interface SyncOutcome {
  more?: boolean;
  status: OutcomeStatus;
  items: number;
  detail: string | null;
  message?: string;
}

interface LeasedResult {
  outcome: SyncOutcome;
  run: SyncRun;
}

export interface SyncSummary {
  job?: SyncJobSummary;
  more?: boolean;
  type: SyncType;
  status: SyncRun["status"];
  mode: "demo" | "real";
  items: number;
  message?: string;
  detail?: string | null;
  run?: SyncRun;
}

export interface SyncStatus {
  jobs?: SyncJobSummary[];
  runs: SyncRun[];
  mode: "demo" | "real";
  message?: string;
}

/* ------------------------------------------------------------------ */
/* Pure helpers (unit tested)                                         */
/* ------------------------------------------------------------------ */

export function backoffDelayMs(failures: number): number {
  const normalized = Math.max(1, Math.min(10, Math.floor(failures)));
  return Math.min(5 * 60 * 1000 * 2 ** (normalized - 1), 6 * 60 * 60 * 1000);
}

function safeHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function safeIsoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePosition(value: unknown, fallback: number): number {
  const number = toNumber(value, fallback);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

/* ------------------------------------------------------------------ */
/* Sync run bookkeeping                                               */
/* ------------------------------------------------------------------ */

function mapSyncRun(row: Record<string, unknown>): SyncRun {
  const status = row.status;
  return {
    id: String(row.id ?? ""),
    type: String(row.type ?? ""),
    status:
      status === "running" ||
      status === "success" ||
      status === "partial" ||
      status === "error"
        ? status
        : "noop",
    startedAt: String(row.started_at ?? ""),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : String(row.finished_at),
    items: toNumber(row.items),
    error:
      row.error === null || row.error === undefined ? null : String(row.error),
    detail:
      row.detail === null || row.detail === undefined
        ? null
        : String(row.detail),
    mode: row.mode === "demo" ? "demo" : "real",
  };
}

async function beginRun(
  env: Env,
  account: AccountRow,
  type: SyncType,
): Promise<{ id: string; startedAt: string }> {
  const id = crypto.randomUUID();
  const startedAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO sync_runs (id, account_id, type, status, started_at, finished_at, items, error, detail, mode)
     VALUES (?, ?, ?, 'running', ?, NULL, 0, NULL, NULL, ?)`,
  )
    .bind(id, account.id, type, startedAt, env.MODE)
    .run();
  return { id, startedAt };
}

async function finishRun(
  env: Env,
  runId: string,
  status: OutcomeStatus,
  items: number,
  error: string | null,
  detail: string | null,
): Promise<string> {
  const finishedAt = nowIso();
  await env.DB.prepare(
    `UPDATE sync_runs SET status = ?, finished_at = ?, items = ?, error = ?, detail = ? WHERE id = ?`,
  )
    .bind(status, finishedAt, Math.max(0, items), error, detail, runId)
    .run();
  return finishedAt;
}

async function pruneRuns(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM sync_runs WHERE account_id = ? AND id IN (
       SELECT id FROM sync_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT -1 OFFSET ?
     )`,
  )
    .bind(accountId, accountId, SYNC_RUNS_KEPT)
    .run();
}

/* ------------------------------------------------------------------ */
/* Lease                                                              */
/* ------------------------------------------------------------------ */

async function acquireLease(
  env: Env,
  accountId: string,
  type: SyncType,
  owner: string,
): Promise<boolean> {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO sync_state (account_id, type, lease_owner, lease_expires_at, cursor, last_run_at, last_status)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT(account_id, type) DO UPDATE SET
       lease_owner = excluded.lease_owner,
       lease_expires_at = excluded.lease_expires_at
     WHERE sync_state.lease_owner IS NULL
        OR sync_state.lease_expires_at IS NULL
        OR sync_state.lease_expires_at < ?`,
  )
    .bind(accountId, type, owner, expiresAt, now)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

async function releaseLease(
  env: Env,
  accountId: string,
  type: SyncType,
  owner: string,
  status: SyncRun["status"],
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sync_state SET lease_owner = NULL, lease_expires_at = NULL, last_run_at = ?, last_status = ?
     WHERE account_id = ? AND type = ? AND lease_owner = ?`,
  )
    .bind(nowIso(), status, accountId, type, owner)
    .run();
}

async function withLease(
  env: Env,
  account: AccountRow,
  type: SyncType,
  work: () => Promise<SyncOutcome>,
): Promise<LeasedResult> {
  const owner = randomToken(16);
  if (!(await acquireLease(env, account.id, type, owner))) {
    throw new HttpError(
      409,
      "SYNC_IN_PROGRESS",
      "A sync of this type is already running.",
    );
  }
  const run = await beginRun(env, account, type);
  let status: OutcomeStatus = "error";
  try {
    const outcome = await work();
    status = outcome.status;
    const finishedAt = await finishRun(
      env,
      run.id,
      outcome.status,
      outcome.items,
      null,
      outcome.detail,
    );
    await pruneRuns(env, account.id);
    return {
      outcome,
      run: {
        id: run.id,
        type,
        status: outcome.status,
        startedAt: run.startedAt,
        finishedAt,
        items: outcome.items,
        error: null,
        detail: outcome.detail,
        mode: env.MODE,
      },
    };
  } catch (error) {
    const safeError = sanitizeError(error);
    const finishedAt = await finishRun(
      env,
      run.id,
      "error",
      0,
      safeError,
      null,
    );
    void finishedAt;
    await pruneRuns(env, account.id);
    throw error;
  } finally {
    await releaseLease(env, account.id, type, owner, status).catch(
      () => undefined,
    );
  }
}

async function executeStatements(
  env: Env,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let index = 0; index < statements.length; index += BATCH_LIMIT) {
    await env.DB.batch(statements.slice(index, index + BATCH_LIMIT));
  }
}

/* ------------------------------------------------------------------ */
/* Demo + entry point                                                 */
/* ------------------------------------------------------------------ */

async function recordNoop(
  env: Env,
  account: AccountRow,
  type: SyncType,
): Promise<SyncSummary> {
  const message =
    "Demo mode: no external sync was attempted. Local demo data is unchanged.";
  const id = crypto.randomUUID();
  const startedAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO sync_runs (id, account_id, type, status, started_at, finished_at, items, error, detail, mode)
     VALUES (?, ?, ?, 'noop', ?, ?, 0, NULL, ?, 'demo')`,
  )
    .bind(id, account.id, type, startedAt, startedAt, message)
    .run();
  return {
    type,
    status: "noop",
    mode: "demo",
    items: 0,
    message,
    detail: message,
    run: {
      id,
      type,
      status: "noop",
      startedAt,
      finishedAt: startedAt,
      items: 0,
      error: null,
      detail: message,
      mode: "demo",
    },
  };
}

export async function handleSync(
  env: Env,
  account: AccountRow,
  type: SyncType,
): Promise<SyncSummary> {
  if (env.MODE === "demo") return recordNoop(env, account, type);
  if (isWebSubEnabled(env)) {
    requireConnectedAccount(account);
    if (type === "all") type = "subscriptions";
  }
  if (env.SYNC_QUEUE) return startQueuedSync(env, account, type);
  const requestedAll = type === "all";
  if (env.SYNC_PROFILE === "free") {
    if (requestedAll) {
      const snapshot = await env.DB.prepare(
        "SELECT cursor,last_run_at,last_status FROM sync_state WHERE account_id=? AND type='subscriptions'",
      )
        .bind(account.id)
        .first<{
          cursor: string | null;
          last_run_at: string | null;
          last_status: string | null;
        }>();
      type =
        !snapshot ||
        snapshot.cursor ||
        snapshot.last_status !== "success" ||
        !snapshot.last_run_at ||
        Date.parse(snapshot.last_run_at) < Date.now() - 86400000
          ? "subscriptions"
          : "rss";
    }
  }
  await purgeExpiredMetadata(env.DB);
  if (type === "all") {
    const result = await withLease(env, account, "all", () =>
      runAll(env, account),
    );
    return {
      type,
      status: result.outcome.status,
      mode: "real",
      items: result.outcome.items,
      ...(result.outcome.message ? { message: result.outcome.message } : {}),
      detail: result.outcome.detail,
      run: result.run,
    };
  }
  const result = await withLease(env, account, type, () =>
    runType(env, account, type),
  );
  return {
    type,
    status: result.outcome.status,
    mode: "real",
    more:
      result.outcome.more ||
      (env.SYNC_PROFILE === "free" &&
        requestedAll &&
        type === "subscriptions" &&
        result.outcome.status === "success"),
    items: result.outcome.items,
    ...(result.outcome.message ? { message: result.outcome.message } : {}),
    detail: result.outcome.detail,
    run: result.run,
  };
}

async function runType(
  env: Env,
  account: AccountRow,
  type: SyncType,
): Promise<SyncOutcome> {
  if (type === "subscriptions") return syncSubscriptions(env, account);
  if (type === "rss") return syncRss(env, account, isWebSubEnabled(env));
  if (type === "playlists") return syncPlaylists(env, account);
  throw new HttpError(400, "VALIDATION_ERROR", "Invalid sync type.");
}

async function runAll(env: Env, account: AccountRow): Promise<SyncOutcome> {
  const summaries: Array<{
    type: SyncType;
    status: string;
    items: number;
    detail: string | null;
  }> = [];
  const errors: string[] = [];
  let items = 0;

  for (const type of ["subscriptions", "rss"] as const) {
    try {
      const result = await withLease(env, account, type, () =>
        runType(env, account, type),
      );
      summaries.push({
        type,
        status: result.outcome.status,
        items: result.outcome.items,
        detail: result.outcome.detail,
      });
      items += result.outcome.items;
    } catch (error) {
      errors.push(`${type}: ${sanitizeError(error)}`);
    }
  }

  let metadata: { items: number; purged: number; error?: string } | null = null;
  try {
    metadata = await syncMetadata(env, account);
    items += metadata.items;
  } catch (error) {
    metadata = { items: 0, purged: 0, error: sanitizeError(error) };
    errors.push(`metadata: ${metadata.error}`);
  }

  const anyPartial = summaries.some((summary) => summary.status === "partial");
  const status: OutcomeStatus =
    errors.length > 0
      ? summaries.length === 0
        ? "error"
        : "partial"
      : anyPartial
        ? "partial"
        : "success";
  const detail = sanitizeText(
    JSON.stringify({
      summaries,
      metadata,
      errors,
    }),
    3000,
  );
  return {
    status,
    items,
    detail,
    ...(status === "partial"
      ? {
          message: "Some sync steps failed; existing local data was preserved.",
        }
      : {}),
    ...(status === "error"
      ? { message: "Sync failed; existing local data was preserved." }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                      */
/* ------------------------------------------------------------------ */

function subscriptionStatement(
  env: Env,
  accountId: string,
  channelId: string,
  remoteId: string | null,
  generation: string,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO subscriptions
       (account_id, channel_id, remote_subscription_id, active, generation, last_verified_at, last_synced_at, created_at, updated_at)
     SELECT ?, ?, ?, 1, ?, ?, NULL, ?, ? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND connected=1)
     ON CONFLICT(account_id, channel_id) DO UPDATE SET
       remote_subscription_id = COALESCE(excluded.remote_subscription_id, subscriptions.remote_subscription_id),
       last_synced_at=CASE WHEN subscriptions.active=0 THEN NULL ELSE subscriptions.last_synced_at END,
       active = 1,
       generation = excluded.generation,
       last_verified_at = excluded.last_verified_at,
       updated_at = excluded.updated_at
     WHERE subscriptions.updated_at <= excluded.updated_at`,
  ).bind(accountId, channelId, remoteId, generation, now, now, now, accountId);
}

export async function syncSubscriptionStep(env: Env, account: AccountRow) {
  return (
    await withLease(env, account, "subscriptions", () =>
      syncSubscriptions({ ...env, SYNC_PROFILE: "free" }, account),
    )
  ).outcome;
}

async function syncSubscriptions(
  env: Env,
  account: AccountRow,
): Promise<SyncOutcome> {
  requireConnectedAccount(account);
  const token = await getValidAccessToken(env, account.id);
  const now = nowIso();
  const free = env.SYNC_PROFILE === "free";
  const saved = free
    ? await env.DB.prepare(
        "SELECT cursor FROM sync_state WHERE account_id=? AND type='subscriptions'",
      )
        .bind(account.id)
        .first<{ cursor: string | null }>()
    : null;
  const checkpoint: {
    generation: string;
    startedAt: string;
    pageToken?: string;
  } = saved?.cursor
    ? JSON.parse(saved.cursor)
    : { generation: randomToken(12), startedAt: now };
  const generation = checkpoint.generation;
  const runStartedAt = checkpoint.startedAt;
  const expiresAt = isoInDays(METADATA_TTL_DAYS);
  let pageToken: string | undefined = checkpoint.pageToken;
  let complete = false;
  let pages = 0;
  let items = 0;

  for (let page = 0; page < (free ? 1 : SUBSCRIPTION_MAX_PAGES); page += 1) {
    const data = await listSubscriptions(token, pageToken, free ? 8 : 50);
    if (!Array.isArray(data.items)) throw new ExternalError("invalid_response");
    const subscriptions = data.items;
    const statements: D1PreparedStatement[] = [];
    for (const subscription of subscriptions) {
      const channelId = subscription.snippet?.resourceId?.channelId;
      if (!channelId || !/^[A-Za-z0-9_-]{1,64}$/.test(channelId))
        throw new ExternalError("incomplete_subscription");
      const snippet = subscription.snippet;
      const channel: ExternalChannel = {
        id: channelId,
        title: sanitizeText(snippet?.title, 300) || channelId,
        description: sanitizeText(snippet?.description, 5000),
        thumbnailUrl: pickThumbnailUrl(snippet?.thumbnails) || null,
      };
      statements.push(
        externalChannelStatement(env.DB, channel, expiresAt, now),
      );
      const remoteId =
        typeof subscription.id === "string" && subscription.id.length <= 200
          ? subscription.id
          : null;
      statements.push(
        subscriptionStatement(
          env,
          account.id,
          channelId,
          remoteId,
          generation,
          now,
        ),
      );
      items += 1;
    }
    await executeStatements(env, statements);
    pages += 1;
    pageToken =
      typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!pageToken) {
      complete = true;
      break;
    }
  }

  if (complete) {
    await executeStatements(env, [
      env.DB.prepare(
        `UPDATE subscriptions SET active = 0, updated_at = ?
         WHERE account_id = ? AND generation IS NOT NULL AND generation <> ?
           AND updated_at < ?`,
      ).bind(now, account.id, generation, runStartedAt),
      env.DB.prepare(
        `UPDATE subscriptions SET last_synced_at = ? WHERE account_id = ? AND active = 1`,
      ).bind(now, account.id),
    ]);
  }

  if (free)
    await env.DB.prepare(
      "UPDATE sync_state SET cursor=? WHERE account_id=? AND type='subscriptions'",
    )
      .bind(
        complete ? null : JSON.stringify({ ...checkpoint, pageToken }),
        account.id,
      )
      .run();
  return {
    status: complete ? "success" : "partial",
    more: free && !complete,
    message: free
      ? `Suscripciones: ${items} importadas en este paso.`
      : undefined,
    items,
    detail: complete
      ? summariesDetail({ pages, complete: true })
      : summariesDetail({
          pages,
          complete: false,
          note: "Page cap reached; snapshot incomplete, no subscriptions were deactivated.",
        }),
  };
}

function summariesDetail(value: Record<string, unknown>): string {
  return sanitizeText(JSON.stringify(value), 2000);
}

/* ------------------------------------------------------------------ */
/* RSS                                                                */
/* ------------------------------------------------------------------ */

interface RssChannelRow {
  id: string;
  title: string;
  failures: number;
}

async function loadRssChannels(
  env: Env,
  accountId: string,
  cursor: string | null,
  now: string,
  force = false,
): Promise<RssChannelRow[]> {
  const conditions = [
    "s.account_id = ?",
    "s.active = 1",
    "s.excluded = 0",
    ...(force ? [] : ["(c.rss_next_attempt_at IS NULL OR c.rss_next_attempt_at <= ?)"]),
  ];
  const params: Array<string | number> = force ? [accountId] : [accountId, now];
  if (cursor) {
    conditions.push("c.id > ?");
    params.push(cursor);
  }
  params.push(env.SYNC_PROFILE === "free" ? 1 : RSS_BATCH);
  const result = await env.DB.prepare(
    `SELECT c.id AS id, c.title AS title, c.rss_failures AS failures
     FROM subscriptions s
     JOIN channels c ON c.id = s.channel_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.id ASC
     LIMIT ?`,
  )
    .bind(...params)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    failures: toNumber(row.failures),
  }));
}

async function saveRssCursor(
  env: Env,
  accountId: string,
  cursor: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (account_id, type, cursor) VALUES (?, 'rss', ?)
     ON CONFLICT(account_id, type) DO UPDATE SET cursor = excluded.cursor`,
  )
    .bind(accountId, cursor)
    .run();
}

async function fetchAndStoreFeed(
  env: Env,
  accountId: string,
  channel: RssChannelRow,
  now: string,
): Promise<{ items: number; skipped: number }> {
  const url = channelFeedUrl(channel.id);
  const headers: Record<string, string> = {
    accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
  };
  // Only a successful KV record authorizes conditional headers. D1 channel
  // validators are ignored so each account has its own bootstrap state.
  const check = await readRssCheck(env, accountId, channel.id, now);
  if (check?.etag) headers["if-none-match"] = check.etag;
  if (check?.lastModified) headers["if-modified-since"] = check.lastModified;

  const response = await fetchWithTimeout(
    url,
    { headers, redirect: "follow" },
    8000,
  );
  const finalUrl = new URL(response.url || url);
  const finalHost = finalUrl.hostname.toLowerCase();
  if (
    finalHost !== "www.youtube.com" &&
    finalHost !== "youtube.com" &&
    finalHost !== "m.youtube.com"
  ) {
    throw new HttpError(
      422,
      "INVALID_FEED_ORIGIN",
      "Feed response came from an unexpected host.",
    );
  }

  if (response.status === 304) return { items: 0, skipped: 0 };

  if (!response.ok) {
    throw new ExternalError(
      `feed_http_${response.status}`,
      "YouTube feed request failed.",
    );
  }
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    throw new HttpError(
      413,
      "FEED_TOO_LARGE",
      "Feed is larger than the allowed size.",
    );
  }
  const body = await readLimitedText(response, MAX_FEED_BYTES);
  if (body.length > MAX_FEED_BYTES) {
    throw new HttpError(
      413,
      "FEED_TOO_LARGE",
      "Feed is larger than the allowed size.",
    );
  }

  const feed = parseAtomFeed(body);
  const cutoff = rssRecentCutoff(now);
  const expiresAt = isoInDays(METADATA_TTL_DAYS, new Date(now));
  const feedTitle = sanitizeText(feed.title, 300);
  let skipped = feed.skipped;

  // Old entries are ignored before any existence lookup or video write.
  const recent = feed.entries.filter((entry) => entry.publishedAt >= cutoff);
  // Bound SQL statements as well as external requests on Workers Free.
  const candidates = env.SYNC_PROFILE === "free" ? recent.slice(0, 6) : recent;
  const existing = new Set<string>();
  if (candidates.length) {
    const known = await env.DB.prepare(
      `SELECT id FROM videos WHERE id IN (${candidates.map(() => "?").join(",")})`,
    )
      .bind(...candidates.map((entry) => entry.videoId))
      .all<{ id: string }>();
    for (const row of known.results ?? []) existing.add(row.id);
  }
  const videos: ExternalVideo[] = [];
  for (const entry of candidates) {
    if (existing.has(entry.videoId)) continue;
    const ownerId = entry.channelId || channel.id;
    const video: ExternalVideo = {
      id: entry.videoId,
      channelId: ownerId,
      channelTitle:
        sanitizeText(entry.channelTitle || channel.title || feedTitle, 300) ||
        channel.title,
      title: sanitizeText(entry.title, 500),
      description: sanitizeText(entry.description, 5000),
      thumbnailUrl: entry.thumbnailUrl,
      publishedAt: entry.publishedAt,
      durationSeconds: entry.durationSeconds,
      viewCount: entry.viewCount,
      source: "rss",
    };
    if (!video.title) {
      skipped += 1;
      continue;
    }
    videos.push(video);
  }

  await executeStatements(
    env,
    videos.map((video) =>
      externalVideoStatement(env.DB, video, expiresAt, now, true),
    ),
  );
  // Validators become reusable only after every durable write above succeeded
  // and the feed produced no incomplete entry that a 304 could hide.
  if (skipped === 0)
    await writeRssCheck(env, accountId, channel.id, {
      checkedAt: now,
      etag: safeHeaderValue(response.headers.get("etag")),
      lastModified: safeHeaderValue(response.headers.get("last-modified")),
    });
  return { items: videos.length, skipped };
}

async function syncRss(env: Env, account: AccountRow, force = false): Promise<SyncOutcome> {
  requireConnectedAccount(account);
  const now = nowIso();
  const state = await env.DB.prepare(
    `SELECT cursor FROM sync_state WHERE account_id = ? AND type = 'rss'`,
  )
    .bind(account.id)
    .first<{ cursor: string | null }>();
  let cursor = typeof state?.cursor === "string" ? state.cursor : null;
  let rows = await loadRssChannels(env, account.id, cursor, now, force);
  if (cursor && rows.length === 0) {
    cursor = null;
    rows = await loadRssChannels(env, account.id, null, now, force);
  }

  const startedAt = Date.now();
  const errors: Array<{ channelId: string; reason: string }> = [];
  let items = 0;
  let skipped = 0;
  let processed = 0;

  for (
    let batch = 0;
    rows.length > 0 &&
    batch < (env.SYNC_PROFILE === "free" ? 1 : RSS_MAX_BATCHES) &&
    Date.now() - startedAt < RSS_BUDGET_MS;
    batch++
  ) {
    await Promise.all(
      rows.map(async (channel) => {
        processed++;
        try {
          const result = await fetchAndStoreFeed(env, account.id, channel, now);
          items += result.items;
          skipped += result.skipped;
        } catch (error) {
          const failures = channel.failures + 1;
          const nextAttempt = new Date(
            Date.now() + backoffDelayMs(failures),
          ).toISOString();
          await env.DB.prepare(
            `UPDATE channels SET rss_failures = ?, rss_next_attempt_at = ?, updated_at = ? WHERE id = ?`,
          )
            .bind(failures, nextAttempt, now, channel.id)
            .run();
          errors.push({
            channelId: channel.id,
            reason:
              error instanceof ExternalError
                ? error.reason
                : sanitizeError(error),
          });
        }
      }),
    );
    cursor = rows[rows.length - 1].id;
    await saveRssCursor(env, account.id, cursor);
    rows = await loadRssChannels(env, account.id, cursor, now, force);
    if (rows.length === 0) {
      cursor = null;
      await saveRssCursor(env, account.id, null);
    }
  }
  if (rows.length === 0 && cursor !== null) {
    cursor = null;
    await saveRssCursor(env, account.id, null);
  }
  const pendingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS pending
    FROM subscriptions s JOIN channels c ON c.id = s.channel_id
    WHERE s.account_id = ? AND s.active = 1 AND s.excluded = 0
      AND (c.rss_next_attempt_at > ? OR (? IS NOT NULL AND c.id > ?))`,
  )
    .bind(account.id, now, cursor, cursor)
    .first<{ pending: number }>();
  const pending = pendingRow?.pending ?? 0;
  const complete = pending === 0 && skipped === 0;
  return {
    status: !complete ? "partial" : processed === 0 ? "noop" : "success",
    more: env.SYNC_PROFILE === "free" && cursor !== null,
    items,
    detail: summariesDetail({
      processed,
      items,
      skipped,
      failed: errors.length,
      pending,
      complete,
      errors: errors.slice(0, 10),
    }),
    message: complete
      ? `RSS: ${processed} canales revisados.`
      : `RSS: ${processed} canales revisados, ${pending} pendientes y ${skipped} entradas incompletas. Se conservaron los vídeos conocidos; los fallos se reintentarán con espera.`,
  };
}

/* ------------------------------------------------------------------ */
/* Playlists                                                          */
/* ------------------------------------------------------------------ */

interface PlaylistImportRow {
  id: string;
  remoteId: string;
}

function playlistSummaryStatement(
  env: Env,
  accountId: string,
  remoteId: string,
  title: string,
  description: string,
  privacyStatus: string | null,
  itemCount: number | null,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO playlists
       (id, account_id, source, remote_id, title, description, privacy_status, remote_item_count,
        fetched_at, items_synced_at, seeded, created_at, updated_at)
     VALUES (?, ?, 'youtube', ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
     ON CONFLICT(account_id, remote_id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       privacy_status = excluded.privacy_status,
       remote_item_count = excluded.remote_item_count,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at
     WHERE playlists.updated_at <= excluded.updated_at`,
  ).bind(
    crypto.randomUUID(),
    accountId,
    remoteId,
    title,
    description,
    privacyStatus,
    itemCount,
    now,
    now,
    now,
  );
}

function playlistItemStatement(
  env: Env,
  playlistId: string,
  videoId: string,
  remoteItemId: string,
  position: number,
  generation: string,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO playlist_items (id, playlist_id, video_id, remote_item_id, position, sync_generation, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(playlist_id, remote_item_id) DO UPDATE SET
       video_id = excluded.video_id,
       position = excluded.position,
       sync_generation = excluded.sync_generation`,
  ).bind(
    crypto.randomUUID(),
    playlistId,
    videoId,
    remoteItemId,
    position,
    generation,
    now,
  );
}

async function importPlaylistItems(
  env: Env,
  accountId: string,
  playlist: PlaylistImportRow,
  token: string,
  now: string,
): Promise<{ items: number; complete: boolean; pages: number }> {
  const generation = randomToken(12);
  const snapshotStart = now;
  const expiresAt = isoInDays(METADATA_TTL_DAYS);
  let pageToken: string | undefined;
  let complete = false;
  let pages = 0;
  let items = 0;
  let fallbackPosition = 0;

  for (let page = 0; page < PLAYLIST_ITEM_MAX_PAGES; page += 1) {
    const data = await listPlaylistItems(token, playlist.remoteId, pageToken);
    if (!Array.isArray(data.items)) throw new ExternalError("invalid_response");
    const entries: YouTubePlaylistItemEntry[] = data.items;
    const statements: D1PreparedStatement[] = [];
    const retained = new Set<string>();
    if (isWebSubEnabled(env)) {
      const oldIds = entries
        .filter((entry) => {
          const date =
            entry.contentDetails?.videoPublishedAt ||
            entry.snippet?.publishedAt;
          return date && !isRecentEnough(date, now);
        })
        .map(
          (entry) =>
            entry.contentDetails?.videoId || entry.snippet?.resourceId?.videoId,
        )
        .filter((id): id is string => !!id);
      if (oldIds.length) {
        const existing = await env.DB.prepare(
          `SELECT id FROM videos WHERE id IN (${oldIds.map(() => "?").join(",")})`,
        )
          .bind(...oldIds)
          .all<{ id: string }>();
        for (const row of existing.results || []) retained.add(row.id);
      }
    }
    for (const entry of entries) {
      const videoId =
        entry.contentDetails?.videoId ||
        entry.snippet?.resourceId?.videoId ||
        "";
      const remoteItemId = typeof entry.id === "string" ? entry.id : "";
      if (
        !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
        !remoteItemId ||
        remoteItemId.length > 200
      ) {
        fallbackPosition += 1;
        continue;
      }
      const title = sanitizeText(entry.snippet?.title, 500);
      if (!title) {
        fallbackPosition += 1;
        continue;
      }
      const snippet = entry.snippet;
      const publishedAt = safeIsoOrNull(
        entry.contentDetails?.videoPublishedAt || snippet?.publishedAt,
      );
      if (!publishedAt) {
        fallbackPosition += 1;
        continue;
      }
      const tooOld = isWebSubEnabled(env) && !isRecentEnough(publishedAt, now);
      if (tooOld && !retained.has(videoId)) {
        fallbackPosition++;
        continue;
      }
      const video: ExternalVideo = {
        id: videoId,
        channelId: snippet?.videoOwnerChannelId || snippet?.channelId || "",
        channelTitle:
          sanitizeText(
            snippet?.videoOwnerChannelTitle || snippet?.channelTitle,
            300,
          ) || "YouTube",
        title,
        description: sanitizeText(snippet?.description, 5000),
        thumbnailUrl: pickThumbnailUrl(snippet?.thumbnails),
        publishedAt,
        durationSeconds: null,
        viewCount: null,
        source: "youtube",
      };
      if (!tooOld)
        statements.push(
          ...privateVideoStatements(env.DB, accountId, video, now, expiresAt),
        );
      const position = normalizePosition(
        entry.snippet?.position,
        fallbackPosition,
      );
      statements.push(
        playlistItemStatement(
          env,
          playlist.id,
          videoId,
          remoteItemId,
          position,
          generation,
          now,
        ),
      );
      fallbackPosition += 1;
      items += 1;
    }
    await executeStatements(env, statements);
    pages += 1;
    pageToken =
      typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!pageToken) {
      complete = true;
      break;
    }
  }

  if (complete) {
    await executeStatements(env, [
      env.DB.prepare(
        `DELETE FROM playlist_items
         WHERE playlist_id = ? AND added_at < ?
           AND sync_generation IS NOT NULL AND sync_generation <> ?`,
      ).bind(playlist.id, snapshotStart, generation),
      env.DB.prepare(
        `UPDATE playlists SET items_synced_at = ?, remote_item_count =
           (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = ?), updated_at = ?
         WHERE id = ?`,
      ).bind(now, playlist.id, now, playlist.id),
    ]);
  }
  return { items, complete, pages };
}

async function syncPlaylists(
  env: Env,
  account: AccountRow,
): Promise<SyncOutcome> {
  requireConnectedAccount(account);
  const token = await getValidAccessToken(env, account.id);
  const now = nowIso();
  let pageToken: string | undefined;
  let listComplete = false;
  let pages = 0;
  let importedPlaylists = 0;

  for (let page = 0; page < PLAYLIST_MAX_PAGES; page += 1) {
    const data = await listPlaylists(token, pageToken);
    if (!Array.isArray(data.items)) throw new ExternalError("invalid_response");
    const playlists = data.items;
    const statements: D1PreparedStatement[] = [];
    for (const playlist of playlists) {
      const remoteId = typeof playlist.id === "string" ? playlist.id : "";
      if (!remoteId || !/^[A-Za-z0-9_-]{1,64}$/.test(remoteId))
        throw new ExternalError("incomplete_playlist");
      // Watch Later and History reject playlistItems.list and are not importable.
      if (remoteId === "WL" || remoteId === "HL") continue;
      const title = sanitizeText(playlist.snippet?.title, 500);
      if (!title) throw new ExternalError("incomplete_playlist");
      const privacy = playlist.status?.privacyStatus;
      const privacyStatus =
        privacy === "private" || privacy === "unlisted" || privacy === "public"
          ? privacy
          : null;
      const itemCount =
        typeof playlist.contentDetails?.itemCount === "number"
          ? playlist.contentDetails.itemCount
          : null;
      statements.push(
        playlistSummaryStatement(
          env,
          account.id,
          remoteId,
          title,
          sanitizeText(playlist.snippet?.description, 5000),
          privacyStatus,
          itemCount,
          now,
        ),
      );
      importedPlaylists += 1;
    }
    await executeStatements(env, statements);
    pages += 1;
    pageToken =
      typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!pageToken) {
      listComplete = true;
      break;
    }
  }

  if (listComplete) {
    await env.DB.prepare(
      `DELETE FROM playlists WHERE account_id = ? AND source = 'youtube'
      AND fetched_at < ? AND updated_at < ?`,
    )
      .bind(account.id, now, now)
      .run();
  }

  const candidatesResult = await env.DB.prepare(
    `SELECT id, remote_id AS remoteId FROM playlists
     WHERE account_id = ? AND source = 'youtube' AND remote_id IS NOT NULL
       AND items_synced_at IS NULL
     ORDER BY COALESCE(items_synced_at, '') ASC, id ASC
     LIMIT ?`,
  )
    .bind(account.id, PLAYLIST_IMPORT_BATCH)
    .all<PlaylistImportRow>();
  const candidates = candidatesResult.results ?? [];

  const imports: Array<{
    id: string;
    items: number;
    complete: boolean;
    pages: number;
    error?: string;
  }> = [];
  const errors: string[] = [];
  let items = 0;
  for (const candidate of candidates) {
    try {
      const result = await importPlaylistItems(
        env,
        account.id,
        candidate,
        token,
        now,
      );
      items += result.items;
      imports.push({ id: candidate.id, ...result });
    } catch (error) {
      const reason = sanitizeError(error);
      errors.push(`${candidate.id}: ${reason}`);
      imports.push({
        id: candidate.id,
        items: 0,
        complete: false,
        pages: 0,
        error: reason,
      });
    }
  }

  const pendingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS pending FROM playlists
    WHERE account_id = ? AND source = 'youtube' AND remote_id IS NOT NULL
      AND items_synced_at IS NULL`,
  )
    .bind(account.id)
    .first<{ pending: number }>();
  const pendingPlaylists = pendingRow?.pending ?? 0;
  const incomplete =
    !listComplete ||
    imports.some((entry) => !entry.complete) ||
    pendingPlaylists > 0;
  const detail = summariesDetail({
    listPages: pages,
    listComplete,
    importedPlaylists,
    pendingPlaylists,
    imports,
    errors: errors.slice(0, 10),
  });
  return {
    status:
      !listComplete || errors.length > 0
        ? "partial"
        : incomplete
          ? "partial"
          : "success",
    items,
    detail,
    ...(!listComplete || errors.length > 0 || incomplete
      ? {
          message: `Listas: ${importedPlaylists} detectadas, ${pendingPlaylists} pendientes de importar o actualizar. Pulsa Actualizar para continuar el siguiente lote.`,
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Metadata renewal                                                   */
/* ------------------------------------------------------------------ */

async function syncMetadata(
  env: Env,
  account: AccountRow,
): Promise<{ items: number; purged: number }> {
  requireConnectedAccount(account);
  const token = await getValidAccessToken(env, account.id);
  const now = nowIso();
  const threshold = isoInDays(5);
  const result = await env.DB.prepare(
    `SELECT video_id AS id FROM account_video_metadata
     WHERE account_id=? AND expires_at <= ?
       AND (?=0 OR json_extract(metadata,'$.publishedAt')>=?)
     ORDER BY expires_at ASC LIMIT ?`,
  )
    .bind(
      account.id,
      threshold,
      isWebSubEnabled(env) ? 1 : 0,
      oldestVideoDate(now),
      METADATA_RENEW_BATCH,
    )
    .all<{ id: string }>();
  const ids = (result.results ?? [])
    .map((row) => row.id)
    .filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id));
  if (ids.length === 0) return { items: 0, purged: 0 };

  const data = await listVideos(token, ids);
  const seen = new Set<string>();
  const expiresAt = isoInDays(METADATA_TTL_DAYS);
  const statements: D1PreparedStatement[] = [];
  let items = 0;
  for (const entry of data.items ?? []) {
    if (typeof entry.id !== "string" || !ids.includes(entry.id)) continue;
    seen.add(entry.id);
    const snippet = entry.snippet;
    const title = sanitizeText(snippet?.title, 500);
    if (!title) continue;
    const publishedAt = safeIsoOrNull(snippet?.publishedAt);
    if (!publishedAt) continue;
    const duration = parseIsoDuration(entry.contentDetails?.duration);
    const viewCountRaw = entry.statistics?.viewCount;
    const viewCount =
      viewCountRaw && /^\d{1,15}$/.test(viewCountRaw)
        ? Number(viewCountRaw)
        : null;
    const video: ExternalVideo = {
      id: entry.id,
      channelId: snippet?.channelId ?? "",
      channelTitle: sanitizeText(snippet?.channelTitle, 300) || "YouTube",
      title,
      description: sanitizeText(snippet?.description, 5000),
      thumbnailUrl: pickThumbnailUrl(snippet?.thumbnails),
      publishedAt,
      durationSeconds: duration,
      viewCount,
      source: "youtube",
      isLive: snippet?.liveBroadcastContent !== "none",
      liveBroadcastContent: snippet?.liveBroadcastContent ?? null,
    };
    statements.push(
      ...privateVideoStatements(
        env.DB,
        account.id,
        video,
        now,
        expiresAt,
        true,
      ),
    );
    items += 1;
  }

  const missing = ids.filter((id) => !seen.has(id));
  for (const id of missing) {
    statements.push(
      env.DB.prepare(
        "DELETE FROM account_video_metadata WHERE account_id=? AND video_id=?",
      ).bind(account.id, id),
    );
  }
  await executeStatements(env, statements);
  return { items, purged: missing.length };
}

/* ------------------------------------------------------------------ */
/* Status + scheduled handler                                         */
/* ------------------------------------------------------------------ */

export async function getSyncStatus(
  env: Env,
  account: AccountRow,
  limit = 20,
): Promise<SyncStatus> {
  const result = await env.DB.prepare(
    `SELECT id, type, status, started_at, finished_at, items, error, detail, mode
     FROM sync_runs WHERE account_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
  )
    .bind(account.id, Math.min(50, Math.max(1, limit)))
    .all<Record<string, unknown>>();
  return {
    runs: (result.results ?? []).map(mapSyncRun),
    ...(env.SYNC_QUEUE
      ? { jobs: await queuedSyncStatus(env, account.id) }
      : {}),
    mode: env.MODE,
    ...(env.MODE === "demo"
      ? {
          message:
            "Demo mode records explicit no-op sync runs; no external calls are made.",
        }
      : {}),
  };
}

export async function runScheduledSync(
  env: Env,
  type: SyncType = "all",
): Promise<void> {
  if (env.MODE !== "real") return;
  if (isWebSubEnabled(env)) {
    // Keep discovery and account/weekly maintenance in separate invocations:
    // a 15-entry RSS batch can use 30 D1 statements before its bookkeeping.
    // Every tenth minute is reserved for existing Queue recovery/subscriptions
    // and one weekly retention page; no additional infrastructure is needed.
    if (
      type === "rss" ||
      (type === "all" && new Date().getUTCMinutes() % 10 !== 0)
    ) {
      await runChannelSync(env);
      return;
    }
    if (type === "all") {
      await runWeeklyVideoRetention(env);
      type = "subscriptions";
    }
  }
  if (env.SYNC_QUEUE) return recoverAndScheduleSync(env);
  let accounts: AccountRow[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT * FROM accounts WHERE mode = 'real' AND connected = 1
       ${isWebSubEnabled(env) ? `AND (NOT EXISTS(SELECT 1 FROM sync_state WHERE account_id=accounts.id AND type='subscriptions' AND last_status='success' AND last_run_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 hours')) OR EXISTS(SELECT 1 FROM sync_state WHERE account_id=accounts.id AND type='subscriptions' AND cursor IS NOT NULL))` : ""}
       ORDER BY ${isWebSubEnabled(env) ? "COALESCE((SELECT last_run_at FROM sync_state WHERE account_id=accounts.id AND type='subscriptions'), '')" : env.SYNC_PROFILE === "free" ? "COALESCE((SELECT last_run_at FROM sync_state WHERE account_id=accounts.id AND type='rss'), '')" : "updated_at"} ASC LIMIT ${env.SYNC_PROFILE === "free" ? 1 : 5}`,
    ).all<AccountRow>();
    accounts = result.results ?? [];
  } catch {
    return;
  }
  for (const account of accounts) {
    try {
      await handleSync(env, account, type);
    } catch {
      // The failed step is recorded in sync_runs; scheduled runs must not throw.
    }
  }
}

/** Exported for tests: maps persisted rows without exposing SQL details. */
export { mapSyncRun };
