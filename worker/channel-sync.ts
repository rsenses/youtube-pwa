/**
 * Global channel discovery. One D1 row per channel, independent of users.
 * Membership changes are reconciled by migration triggers; this module only
 * performs bounded, leased hub/RSS operations for the existing minute cron.
 */
import type { Env } from "./types";
import {
  HttpError,
  fetchWithTimeout,
  nowIso,
  randomToken,
  readLimitedText,
} from "./http";
import {
  channelFeedUrl,
  parseAtomFeed,
  type AtomEntry,
  MAX_FEED_BYTES,
} from "./rss";
import {
  DEFAULT_HUB_LEASE_SECONDS,
  HUB_RENEW_BEFORE_MS,
  WEBSUB_HUB_URL,
  ingestParsedEntries,
  isWebSubEnabled,
  websubCallbackUrl,
  websubHubSecret,
  websubTopicUrl,
} from "./websub";

export { isRecentEnough, oldestVideoDate } from "./rss";

// Workerd only implements manual/follow. Reject redirects via status checks;
// redirect:"error" throws before making a request in the Workers runtime.
export const CHANNEL_REDIRECT_MODE = "manual" as const;

const HUB_CLAIM_MS = 60 * 1000;
const HUB_PENDING_MS = 10 * 60 * 1000;
const RSS_CLAIM_MS = 60 * 1000;
const RSS_DAILY_MS = 24 * 60 * 60 * 1000;
const MAX_OPERATIONS_PER_RUN = 2;
const MAX_FAILURES = 10;
// YouTube's latest Atom page is small; 15 keeps a writing batch plus hub
// lifecycle work below the Free per-invocation query/subrequest budget.
const MAX_RSS_ENTRIES = 15;
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_FEED_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
]);

interface ChannelSyncRow {
  channel_id: string;
  desired: number;
  hub_state: string;
  hub_lease_expires_at: string | null;
  hub_pending_mode: string | null;
  hub_pending_token: string | null;
  hub_pending_deadline: string | null;
  hub_requested_at: string | null;
  hub_failures: number;
  hub_next_attempt_at: string | null;
  hub_claim_token: string | null;
  hub_claim_expires_at: string | null;
  rss_claim_token: string | null;
  rss_claim_expires_at: string | null;
  rss_etag: string | null;
  rss_last_modified: string | null;
  rss_last_checked_at: string | null;
  rss_next_at: string | null;
  rss_failures: number;
}

interface HubActionResult {
  kind: "subscribe" | "unsubscribe" | "failed" | "stale";
  channelId: string;
}

interface RssActionResult {
  inserted: number;
  updated: number;
  notModified: boolean;
  skipped: number;
  failed: boolean;
  channelId: string;
}

export interface ChannelSyncSummary {
  disabled: boolean;
  operations: number;
  hub: {
    attempted: number;
    subscribe: number;
    unsubscribe: number;
    failed: number;
    stale: number;
  };
  rss: {
    attempted: number;
    inserted: number;
    updated: number;
    notModified: number;
    skipped: number;
    failed: number;
  };
}

function emptySummary(): ChannelSyncSummary {
  return {
    disabled: false,
    operations: 0,
    hub: { attempted: 0, subscribe: 0, unsubscribe: 0, failed: 0, stale: 0 },
    rss: {
      attempted: 0,
      inserted: 0,
      updated: 0,
      notModified: 0,
      skipped: 0,
      failed: 0,
    },
  };
}

function normalizeNow(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("Invalid now");
  return new Date(parsed).toISOString();
}

function failureBackoffMs(failures: number): number {
  const normalized = Math.max(1, Math.min(MAX_FAILURES, Math.floor(failures)));
  return Math.min(5 * 60 * 1000 * 2 ** (normalized - 1), 6 * 60 * 60 * 1000);
}

function plusMs(now: string, milliseconds: number): string {
  return new Date(Date.parse(now) + milliseconds).toISOString();
}

function safeHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function feedHostAllowed(rawUrl: string): boolean {
  try {
    return ALLOWED_FEED_HOSTS.has(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function readGlobalFeedRevision(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT revision FROM youtube_feed_state WHERE id = 1")
    .first<{ revision: number }>();
  return typeof row?.revision === "number" && Number.isFinite(row.revision)
    ? row.revision
    : 0;
}

/* ------------------------------------------------------------------ */
/* Hub lifecycle                                                      */
/* ------------------------------------------------------------------ */

async function dueHubChannel(
  env: Env,
  now: string,
): Promise<ChannelSyncRow | null> {
  const renewalThreshold = plusMs(now, HUB_RENEW_BEFORE_MS);
  const row = await env.DB.prepare(
    `SELECT * FROM websub_channels
     WHERE (hub_claim_token IS NULL OR hub_claim_expires_at <= ?)
       AND hub_next_attempt_at <= ?
       AND NOT (hub_pending_deadline IS NOT NULL AND hub_pending_deadline > ?)
       AND (
         (desired = 1 AND (
           hub_state IN ('idle', 'unsubscribed')
           OR (hub_state = 'subscribed' AND
               (hub_lease_expires_at IS NULL OR hub_lease_expires_at <= ?))
           OR hub_state IN ('pending_subscribe', 'pending_unsubscribe')
         ))
         OR (desired = 0 AND
             hub_state IN ('subscribed', 'pending_subscribe', 'pending_unsubscribe'))
       )
     ORDER BY hub_next_attempt_at ASC, channel_id ASC
     LIMIT 1`,
  )
    .bind(now, now, now, renewalThreshold)
    .first<ChannelSyncRow>();
  return row ?? null;
}

async function claimHub(
  env: Env,
  row: ChannelSyncRow,
  now: string,
): Promise<ChannelSyncRow | null> {
  const token = randomToken(16);
  const result = await env.DB.prepare(
    `UPDATE websub_channels SET hub_claim_token = ?, hub_claim_expires_at = ?,
       updated_at = ?
     WHERE channel_id = ? AND desired = ? AND hub_state = ?
       AND (hub_claim_token IS NULL OR hub_claim_expires_at <= ?)
       AND (hub_next_attempt_at IS NULL OR hub_next_attempt_at <= ?)
       AND NOT (hub_pending_deadline IS NOT NULL AND hub_pending_deadline > ?)`,
  )
    .bind(
      token,
      plusMs(now, HUB_CLAIM_MS),
      now,
      row.channel_id,
      row.desired,
      row.hub_state,
      now,
      now,
      now,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return env.DB.prepare(
    "SELECT * FROM websub_channels WHERE channel_id = ? AND hub_claim_token = ?",
  )
    .bind(row.channel_id, token)
    .first<ChannelSyncRow>();
}

async function clearStaleHubPending(
  env: Env,
  row: ChannelSyncRow,
  now: string,
): Promise<void> {
  const failures = Math.min(MAX_FAILURES, row.hub_failures + 1);
  const nextState = row.desired === 1 ? "idle" : "subscribed";
  await env.DB.prepare(
    `UPDATE websub_channels SET
       hub_state = ?, hub_pending_mode = NULL, hub_pending_token = NULL,
       hub_pending_deadline = NULL, hub_failures = ?, hub_next_attempt_at = ?,
       hub_claim_token = NULL, hub_claim_expires_at = NULL, updated_at = ?
     WHERE channel_id = ? AND hub_claim_token = ?`,
  )
    .bind(
      nextState,
      failures,
      plusMs(now, failureBackoffMs(failures)),
      now,
      row.channel_id,
      row.hub_claim_token,
    )
    .run();
}

async function failHub(
  env: Env,
  row: ChannelSyncRow,
  pendingToken: string,
  previousState: string,
  now: string,
): Promise<void> {
  const failures = Math.min(MAX_FAILURES, row.hub_failures + 1);
  await env.DB.prepare(
    `UPDATE websub_channels SET
       hub_state = ?, hub_pending_mode = NULL, hub_pending_token = NULL,
       hub_pending_deadline = NULL, hub_failures = ?, hub_next_attempt_at = ?,
       updated_at = ?
     WHERE channel_id = ? AND hub_pending_token = ?`,
  )
    .bind(
      previousState,
      failures,
      plusMs(now, failureBackoffMs(failures)),
      now,
      row.channel_id,
      pendingToken,
    )
    .run();
}

async function requestHub(
  env: Env,
  row: ChannelSyncRow,
  action: "subscribe" | "unsubscribe",
  now: string,
  previousState: string,
): Promise<HubActionResult> {
  const pendingToken = randomToken(16);
  const pendingDeadline = plusMs(now, HUB_PENDING_MS);
  const pendingState =
    action === "subscribe" ? "pending_subscribe" : "pending_unsubscribe";
  const transition = await env.DB.prepare(
    `UPDATE websub_channels SET
       hub_state = ?, hub_pending_mode = ?, hub_pending_token = ?,
       hub_pending_deadline = ?, hub_requested_at = ?,
       hub_next_attempt_at = ?, hub_claim_token = NULL,
       hub_claim_expires_at = NULL, updated_at = ?
     WHERE channel_id = ? AND hub_claim_token = ? AND desired = ?`,
  )
    .bind(
      pendingState,
      action,
      pendingToken,
      pendingDeadline,
      now,
      pendingDeadline,
      now,
      row.channel_id,
      row.hub_claim_token,
      row.desired,
    )
    .run();
  if ((transition.meta.changes ?? 0) !== 1)
    return { kind: "stale", channelId: row.channel_id };

  const form = new URLSearchParams();
  form.set("hub.mode", action);
  form.set("hub.topic", websubTopicUrl(row.channel_id));
  form.set("hub.callback", await websubCallbackUrl(env, row.channel_id));
  form.set("hub.verify", "async");
  if (action === "subscribe") {
    form.set("hub.lease_seconds", String(DEFAULT_HUB_LEASE_SECONDS));
    form.set("hub.secret", await websubHubSecret(env, row.channel_id));
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      WEBSUB_HUB_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: CHANNEL_REDIRECT_MODE,
      },
      8000,
    );
  } catch {
    await failHub(env, row, pendingToken, previousState, now);
    return { kind: "failed", channelId: row.channel_id };
  }
  if (response.status !== 202) {
    await failHub(env, row, pendingToken, previousState, now);
    return { kind: "failed", channelId: row.channel_id };
  }
  // Verification is completed by the hub GET callback. The intent above is
  // durable before the POST, so a callback may race the 202 response safely.
  return { kind: action, channelId: row.channel_id };
}

async function processDueHub(
  env: Env,
  now: string,
): Promise<HubActionResult | null> {
  const due = await dueHubChannel(env, now);
  if (!due) return null;
  const row = await claimHub(env, due, now);
  if (!row) return null;

  if (row.hub_pending_deadline) {
    if (Date.parse(row.hub_pending_deadline) > Date.parse(now)) return null;
    await clearStaleHubPending(env, row, now);
    return { kind: "stale", channelId: row.channel_id };
  }

  const leaseExpires = row.hub_lease_expires_at
    ? Date.parse(row.hub_lease_expires_at)
    : Number.NaN;
  const renewalDue =
    !Number.isFinite(leaseExpires) ||
    leaseExpires <= Date.parse(now) + HUB_RENEW_BEFORE_MS;

  if (row.desired === 1) {
    if (row.hub_state === "subscribed" && !renewalDue) {
      await env.DB.prepare(
        "UPDATE websub_channels SET hub_claim_token = NULL, hub_claim_expires_at = NULL WHERE channel_id = ?",
      )
        .bind(row.channel_id)
        .run();
      return null;
    }
    return requestHub(
      env,
      row,
      "subscribe",
      now,
      row.hub_state === "subscribed" ? "subscribed" : "idle",
    );
  }

  return requestHub(env, row, "unsubscribe", now, "subscribed");
}

/* ------------------------------------------------------------------ */
/* Daily RSS                                                          */
/* ------------------------------------------------------------------ */

async function dueRssChannel(
  env: Env,
  now: string,
): Promise<ChannelSyncRow | null> {
  return env.DB.prepare(
    `SELECT * FROM websub_channels
     WHERE desired = 1
       AND (rss_claim_token IS NULL OR rss_claim_expires_at <= ?)
       AND rss_next_at <= ?
     ORDER BY rss_next_at ASC, channel_id ASC
     LIMIT 1`,
  )
    .bind(now, now)
    .first<ChannelSyncRow>();
}

async function claimRss(
  env: Env,
  row: ChannelSyncRow,
  now: string,
): Promise<ChannelSyncRow | null> {
  const token = randomToken(16);
  const result = await env.DB.prepare(
    `UPDATE websub_channels SET rss_claim_token = ?,
       rss_claim_expires_at = ?, updated_at = ?
     WHERE channel_id = ? AND desired = 1
       AND (rss_claim_token IS NULL OR rss_claim_expires_at <= ?)
       AND (rss_next_at IS NULL OR rss_next_at <= ?)`,
  )
    .bind(token, plusMs(now, RSS_CLAIM_MS), now, row.channel_id, now, now)
    .run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return env.DB.prepare(
    "SELECT * FROM websub_channels WHERE channel_id = ? AND rss_claim_token = ?",
  )
    .bind(row.channel_id, token)
    .first<ChannelSyncRow>();
}

async function failRss(
  env: Env,
  row: ChannelSyncRow,
  claimToken: string,
  now: string,
): Promise<void> {
  const failures = Math.min(MAX_FAILURES, row.rss_failures + 1);
  await env.DB.prepare(
    `UPDATE websub_channels SET rss_failures = ?, rss_next_at = ?,
       rss_last_checked_at = ?, rss_claim_token = NULL,
       rss_claim_expires_at = NULL, updated_at = ?
     WHERE channel_id = ? AND rss_claim_token = ?`,
  )
    .bind(
      failures,
      plusMs(now, failureBackoffMs(failures)),
      now,
      now,
      row.channel_id,
      claimToken,
    )
    .run();
}

async function processDueRss(
  env: Env,
  now: string,
): Promise<RssActionResult | null> {
  const due = await dueRssChannel(env, now);
  if (!due) return null;
  const row = await claimRss(env, due, now);
  if (!row) return null;

  const url = channelFeedUrl(row.channel_id);
  const headers: Record<string, string> = {
    accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
  };
  if (row.rss_etag) headers["if-none-match"] = row.rss_etag;
  if (row.rss_last_modified)
    headers["if-modified-since"] = row.rss_last_modified;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      { headers, redirect: CHANNEL_REDIRECT_MODE },
      8000,
    );
  } catch {
    await failRss(env, row, row.rss_claim_token ?? "", now);
    return {
      inserted: 0,
      updated: 0,
      notModified: false,
      skipped: 0,
      failed: true,
      channelId: row.channel_id,
    };
  }
  if (!feedHostAllowed(response.url || url)) {
    await failRss(env, row, row.rss_claim_token ?? "", now);
    return {
      inserted: 0,
      updated: 0,
      notModified: false,
      skipped: 0,
      failed: true,
      channelId: row.channel_id,
    };
  }

  if (response.status === 304) {
    const next = plusMs(now, RSS_DAILY_MS);
    await env.DB.prepare(
      `UPDATE websub_channels SET rss_last_checked_at = ?, rss_next_at = ?,
         rss_failures = 0, rss_claim_token = NULL,
         rss_claim_expires_at = NULL, updated_at = ?
       WHERE channel_id = ? AND rss_claim_token = ? AND desired = 1`,
    )
      .bind(now, next, now, row.channel_id, row.rss_claim_token)
      .run();
    return {
      inserted: 0,
      updated: 0,
      notModified: true,
      skipped: 0,
      failed: false,
      channelId: row.channel_id,
    };
  }
  if (!response.ok) {
    await failRss(env, row, row.rss_claim_token ?? "", now);
    return {
      inserted: 0,
      updated: 0,
      notModified: false,
      skipped: 0,
      failed: true,
      channelId: row.channel_id,
    };
  }

  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    await failRss(env, row, row.rss_claim_token ?? "", now);
    return {
      inserted: 0,
      updated: 0,
      notModified: false,
      skipped: 0,
      failed: true,
      channelId: row.channel_id,
    };
  }

  let feed: ReturnType<typeof parseAtomFeed>;
  try {
    const body = await readLimitedText(response, MAX_FEED_BYTES);
    if (body.length > MAX_FEED_BYTES)
      throw new HttpError(413, "FEED_TOO_LARGE", "Feed is too large.");
    feed = parseAtomFeed(body);
  } catch {
    await failRss(env, row, row.rss_claim_token ?? "", now);
    return {
      inserted: 0,
      updated: 0,
      notModified: false,
      skipped: 0,
      failed: true,
      channelId: row.channel_id,
    };
  }

  // The daily sweep consumes the latest feed entries (YouTube returns its
  // newest page) and lets the shared ingest apply the one-calendar-year and
  // watch/playlist rules. There is no separate 24h bootstrap ceiling here.
  const candidates = feed.entries.slice(0, MAX_RSS_ENTRIES);
  let skipped =
    feed.skipped + Math.max(0, feed.entries.length - MAX_RSS_ENTRIES);
  const clean: AtomEntry[] = [];
  for (const entry of candidates) {
    const owner = entry.channelId || row.channel_id;
    if (!CHANNEL_ID.test(owner) || owner !== row.channel_id || !entry.title) {
      // A malformed or foreign entry must keep validators unpublished so a
      // later 304 cannot hide it.
      skipped += 1;
      continue;
    }
    clean.push(entry);
  }

  let ingested;
  try {
    ingested = await ingestParsedEntries(
      env,
      row.channel_id,
      clean,
      now,
      "rss",
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      // A stale merge or ordering stamp lost a CAS race. Keep validators
      // unpublished and let the normal leased backoff retry the feed instead
      // of acknowledging an event that was not applied.
      await failRss(env, row, row.rss_claim_token ?? "", now);
      return {
        inserted: 0,
        updated: 0,
        notModified: false,
        skipped: 0,
        failed: true,
        channelId: row.channel_id,
      };
    }
    throw error;
  }

  if (skipped > 0) {
    // Do not publish validators or complete the day when a 304 could hide
    // entries that this run could not parse. Valid writes remain durable.
    await failRss(env, row, row.rss_claim_token ?? "", now);
    return {
      inserted: ingested.inserted,
      updated: ingested.updated,
      notModified: false,
      skipped: skipped + ingested.skipped,
      failed: false,
      channelId: row.channel_id,
    };
  }

  const next = plusMs(now, RSS_DAILY_MS);
  await env.DB.prepare(
    `UPDATE websub_channels SET rss_etag = ?, rss_last_modified = ?,
       rss_last_checked_at = ?, rss_next_at = ?, rss_failures = 0,
       rss_claim_token = NULL, rss_claim_expires_at = NULL, updated_at = ?
     WHERE channel_id = ? AND rss_claim_token = ? AND desired = 1`,
  )
    .bind(
      safeHeaderValue(response.headers.get("etag")),
      safeHeaderValue(response.headers.get("last-modified")),
      now,
      next,
      now,
      row.channel_id,
      row.rss_claim_token,
    )
    .run();
  return {
    inserted: ingested.inserted,
    updated: ingested.updated,
    notModified: false,
    skipped: ingested.skipped,
    failed: false,
    channelId: row.channel_id,
  };
}

/**
 * Bounded scheduled entry point. It performs at most one hub operation and one
 * RSS operation per invocation; all other due channels continue on later ticks.
 */
export async function runChannelSync(
  env: Env,
  now: string = nowIso(),
): Promise<ChannelSyncSummary> {
  const summary = emptySummary();
  if (!isWebSubEnabled(env)) {
    summary.disabled = true;
    return summary;
  }
  const at = normalizeNow(now);

  const hub = await processDueHub(env, at);
  if (hub) {
    summary.operations += 1;
    summary.hub.attempted += 1;
    if (hub.kind === "subscribe") summary.hub.subscribe += 1;
    else if (hub.kind === "unsubscribe") summary.hub.unsubscribe += 1;
    else if (hub.kind === "failed") summary.hub.failed += 1;
    else summary.hub.stale += 1;
  }

  if (summary.operations < MAX_OPERATIONS_PER_RUN) {
    const rss = await processDueRss(env, at);
    if (rss) {
      summary.operations += 1;
      summary.rss.attempted += 1;
      summary.rss.inserted += rss.inserted;
      summary.rss.updated += rss.updated;
      summary.rss.skipped += rss.skipped;
      if (rss.notModified) summary.rss.notModified += 1;
      if (rss.failed) summary.rss.failed += 1;
    }
  }
  return summary;
}
