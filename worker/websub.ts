/**
 * YouTube WebSub endpoint: explicit feature flag, channel-bound HMAC routing
 * token, raw-body HMAC verification and durable notification application.
 *
 * The public callback path is exact and must be routed before sessions/CSRF:
 *   /api/websub/youtube?channel=CHANNEL_ID&token=ROUTING_TOKEN
 *
 * HMAC material is derived from WEBSUB_SECRET with domain-separated labels.
 * It is never stored in D1 and WEBSUB_SECRET/OAuth credentials are never reused.
 *
 * `ingestParsedEntries` is the single idempotent ingest used by both this
 * callback and the daily RSS sweep in channel-sync, so the one-calendar-year,
 * raw <updated> and watched/playlist eligibility rules cannot diverge.
 */
import type { Env } from "./types";
import { warmFeedThumbnails } from "./feed-thumbnails";
import {
  HttpError,
  bytesToBase64Url,
  constantTimeEqual,
  isoInDays,
  nowIso,
  sha256Hex,
} from "./http";
import { oldestVideoDate, parseAtomFeed, type AtomEntry } from "./rss";

export const WEBSUB_CALLBACK_PATH = "/api/websub/youtube";
export const WEBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
export const MAX_NOTIFICATION_BYTES = 64 * 1024;
export const MAX_NOTIFICATION_ENTRIES = 15;
export const DEFAULT_HUB_LEASE_SECONDS = 4 * 24 * 60 * 60;
export const HUB_RENEW_BEFORE_MS = 12 * 60 * 60 * 1000;

const MIN_SECRET_LENGTH = 16;
const MAX_LEASE_SECONDS = 366 * 24 * 60 * 60;
const MAX_CHALLENGE_LENGTH = 2000;
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HMAC_LABEL = "alveo:youtube-websub:v1:";
const HUB_SECRET_LABEL = `${HMAC_LABEL}hub-secret:`;
const ROUTING_TOKEN_LABEL = `${HMAC_LABEL}routing-token:`;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface WebSubBindings {
  WEBSUB_ENABLED?: string;
  WEBSUB_SECRET?: string;
}

type WebSubEnv = Env & WebSubBindings;

interface WebSubChannelRow {
  channel_id: string;
  desired: number;
  hub_state: string;
  hub_lease_expires_at: string | null;
  hub_pending_mode: string | null;
  hub_pending_token: string | null;
  hub_pending_deadline: string | null;
}

interface ExistingVideoRow {
  id: string;
  channel_id: string;
  channel_title: string;
  title: string;
  description: string;
  thumbnail_url: string;
  published_at: string;
  duration_seconds: number | null;
  view_count: number | null;
  source: string;
  purged_at: string | null;
  websub_updated_at: string | null;
  websub_hash: string | null;
}

function bindings(env: Env): WebSubBindings {
  return env as WebSubEnv;
}

function secretFor(env: Env): string {
  const secret = bindings(env).WEBSUB_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new HttpError(
      503,
      "WEBSUB_NOT_CONFIGURED",
      "WebSub is not configured.",
    );
  }
  return secret;
}

/**
 * Enabled only for real mode with an explicit flag and a non-trivial secret.
 * Demo/local defaults never register with the public hub automatically.
 */
export function isWebSubEnabled(env: Env): boolean {
  if (env.MODE !== "real") return false;
  if (bindings(env).WEBSUB_ENABLED !== "true") return false;
  return (bindings(env).WEBSUB_SECRET?.trim().length ?? 0) >= MIN_SECRET_LENGTH;
}

export function websubTopicUrl(channelId: string): string {
  if (!CHANNEL_ID.test(channelId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "Invalid channel id.");
  }
  // Official push topic. It intentionally differs from the RSS feed URL.
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

async function hmacBytes(env: Env, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretFor(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

/** Deterministic routing token for a channel. It never carries account data. */
export async function websubRoutingToken(
  env: Env,
  channelId: string,
): Promise<string> {
  if (!CHANNEL_ID.test(channelId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "Invalid channel id.");
  }
  return bytesToBase64Url(
    await hmacBytes(env, `${ROUTING_TOKEN_LABEL}${channelId}`),
  );
}

/** Per-channel hub signing secret derived from WEBSUB_SECRET. */
export async function websubHubSecret(
  env: Env,
  channelId: string,
): Promise<string> {
  if (!CHANNEL_ID.test(channelId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "Invalid channel id.");
  }
  return bytesToBase64Url(
    await hmacBytes(env, `${HUB_SECRET_LABEL}${channelId}`),
  );
}

export async function websubCallbackUrl(
  env: Env,
  channelId: string,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(WEBSUB_CALLBACK_PATH, env.APP_ORIGIN);
  } catch {
    throw new HttpError(
      503,
      "WEBSUB_NOT_CONFIGURED",
      "WebSub callback origin is invalid.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(
      503,
      "WEBSUB_NOT_CONFIGURED",
      "WebSub callback origin is invalid.",
    );
  }
  url.searchParams.set("channel", channelId);
  url.searchParams.set("token", await websubRoutingToken(env, channelId));
  return url.toString();
}

function textResponse(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}

function challengeHeader(value: string | null): string | null {
  if (!value || value.length > MAX_CHALLENGE_LENGTH) return null;
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;
  return value;
}

function leaseSeconds(value: string | null): number | null | undefined {
  if (value === null) return null;
  if (!/^\d{1,9}$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    seconds <= MAX_LEASE_SECONDS
    ? seconds
    : undefined;
}

function queryChannel(url: URL): string | null {
  const channel = url.searchParams.get("channel");
  return channel && CHANNEL_ID.test(channel) ? channel : null;
}

function queryToken(url: URL): string | null {
  const token = url.searchParams.get("token");
  if (!token || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token))
    return null;
  return token;
}

function hexBytes(value: string, length: number): Uint8Array | null {
  if (value.length !== length || !/^[0-9a-fA-F]+$/.test(value)) return null;
  const bytes = new Uint8Array(length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function verifyHmac(
  secret: string,
  hash: "SHA-1" | "SHA-256",
  signature: Uint8Array,
  body: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(signature).buffer,
    new Uint8Array(body).buffer,
  );
}

/**
 * Require a valid sha1 signature (the hub minimum). If sha256 is present it
 * must also verify. Missing or malformed signatures fail closed.
 */
export async function verifyWebSubSignature(
  env: Env,
  channelId: string,
  body: Uint8Array,
  sha1Header: string | null,
  sha256Header: string | null,
): Promise<boolean> {
  const sha1 = /^sha1=([0-9a-fA-F]{40})$/.exec(sha1Header ?? "");
  if (!sha1) return false;
  const sha1Bytes = hexBytes(sha1[1], 40);
  if (!sha1Bytes) return false;
  const secret = await websubHubSecret(env, channelId);
  if (!(await verifyHmac(secret, "SHA-1", sha1Bytes, body))) return false;
  if (sha256Header !== null) {
    const sha256 = /^sha256=([0-9a-fA-F]{64})$/.exec(sha256Header);
    if (!sha256) return false;
    const sha256Bytes = hexBytes(sha256[1], 64);
    if (
      !sha256Bytes ||
      !(await verifyHmac(secret, "SHA-256", sha256Bytes, body))
    )
      return false;
  }
  return true;
}

async function rawRequestBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_NOTIFICATION_BYTES)
    return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_NOTIFICATION_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function channelRow(
  env: Env,
  channelId: string,
): Promise<WebSubChannelRow | null> {
  return env.DB.prepare(
    `SELECT channel_id, desired, hub_state, hub_lease_expires_at,
            hub_pending_mode, hub_pending_token, hub_pending_deadline
     FROM websub_channels WHERE channel_id = ?`,
  )
    .bind(channelId)
    .first<WebSubChannelRow>();
}

async function handleVerification(
  request: Request,
  env: Env,
  url: URL,
  channelId: string,
): Promise<Response> {
  const token = queryToken(url);
  if (
    !token ||
    !constantTimeEqual(token, await websubRoutingToken(env, channelId))
  )
    return textResponse("Not found.", 404);

  const mode = url.searchParams.get("hub.mode");
  if (mode !== "subscribe" && mode !== "unsubscribe")
    return textResponse("Invalid hub mode.", 400);
  const topic = url.searchParams.get("hub.topic");
  if (topic !== websubTopicUrl(channelId))
    return textResponse("Topic does not match channel.", 400);
  const challenge = challengeHeader(url.searchParams.get("hub.challenge"));
  if (!challenge) return textResponse("Invalid challenge.", 400);

  const lease = leaseSeconds(url.searchParams.get("hub.lease_seconds"));
  if (lease === undefined || (mode === "subscribe" && lease === null))
    return textResponse("Invalid lease.", 400);

  const row = await channelRow(env, channelId);
  if (!row || row.desired !== (mode === "subscribe" ? 1 : 0))
    return textResponse("Not found.", 404);
  if (
    row.hub_pending_mode !== mode ||
    !row.hub_pending_token ||
    !row.hub_pending_deadline ||
    Date.parse(row.hub_pending_deadline) <= Date.now()
  )
    return textResponse("No pending verification.", 404);

  const verifiedAt = nowIso();
  if (mode === "subscribe") {
    const seconds = lease ?? DEFAULT_HUB_LEASE_SECONDS;
    const leaseExpires = new Date(Date.now() + seconds * 1000).toISOString();
    const nextAttempt = new Date(
      Date.parse(leaseExpires) -
        Math.min(HUB_RENEW_BEFORE_MS, (seconds * 1000) / 4),
    ).toISOString();
    const result = await env.DB.prepare(
      `UPDATE websub_channels SET
         hub_state = 'subscribed', hub_pending_mode = NULL,
         hub_pending_token = NULL, hub_pending_deadline = NULL,
         hub_lease_expires_at = ?, hub_verified_at = ?,
         hub_subscribed_at = COALESCE(hub_subscribed_at, ?),
         hub_failures = 0, hub_next_attempt_at = ?, updated_at = ?
       WHERE channel_id = ? AND desired = 1
         AND hub_pending_mode = 'subscribe' AND hub_pending_token = ?
         AND hub_pending_deadline > ?`,
    )
      .bind(
        leaseExpires,
        verifiedAt,
        verifiedAt,
        nextAttempt,
        verifiedAt,
        channelId,
        row.hub_pending_token,
        verifiedAt,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      return textResponse("Verification state changed.", 409);
  } else {
    const result = await env.DB.prepare(
      `UPDATE websub_channels SET
         hub_state = 'unsubscribed', hub_pending_mode = NULL,
         hub_pending_token = NULL, hub_pending_deadline = NULL,
         hub_lease_expires_at = NULL, hub_verified_at = ?,
         hub_failures = 0, hub_next_attempt_at = NULL, updated_at = ?
       WHERE channel_id = ? AND desired = 0
         AND hub_pending_mode = 'unsubscribe' AND hub_pending_token = ?
         AND hub_pending_deadline > ?`,
    )
      .bind(
        verifiedAt,
        verifiedAt,
        channelId,
        row.hub_pending_token,
        verifiedAt,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      return textResponse("Verification state changed.", 409);
  }
  return textResponse(challenge, 200);
}

function sameNullable(
  left: string | number | null,
  right: string | number | null,
): boolean {
  return (left ?? null) === (right ?? null);
}

function nextValue<T>(present: boolean | undefined, value: T, fallback: T): T {
  return present ? value : fallback;
}

async function contentHash(values: unknown[]): Promise<string> {
  return sha256Hex(JSON.stringify(values));
}

/**
 * Result of one idempotent ingest batch. The daily RSS sweep and the WebSub
 * notification callback share it because they share the same contract.
 */
export interface IngestSummary {
  /** Unknown videos created inside the one-calendar-year window. */
  inserted: number;
  /** Existing videos whose visible metadata changed in place. Ordering-only
   * stamps for newer identical events are deliberately not counted here. */
  updated: number;
  /** Existing entries without a visible metadata write; `ineligible` is a
   * subset. This includes newer identical events that advance only the
   * ordering watermark (one row write, no feed revision) and concurrent
   * duplicates already applied by another delivery. */
  skipped: number;
  /** Changed metadata refused because every interested subscriber watched
   * the video and no playlist holds it. */
  ineligible: number;
}

/** Legacy name kept for callers that only consume notification counts. */
export type NotificationApplySummary = IngestSummary;

interface PlannedUpdate {
  entry: AtomEntry;
  eventAt: string;
  channelTitle: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  durationSeconds: number | null;
  viewCount: number | null;
  source: string;
  expectedWatermark: string | null;
  expectedHash: string | null;
}

interface PlannedStamp {
  videoId: string;
  eventAt: string;
  eventMs: number;
  expectedWatermark: string | null;
}

interface IngestAction {
  kind: "insert" | "visible" | "stamp";
  index: number;
  videoId: string;
  eventAt: string;
  eventMs: number;
}

/**
 * A feed or notification may repeat a video. Keep only its newest event so
 * duplicate entries cannot cause extra writes or epoch increments.
 */
function newestEventPerVideo(entries: AtomEntry[]): AtomEntry[] {
  const deduped: AtomEntry[] = [];
  const indexById = new Map<string, number>();
  for (const entry of entries) {
    const at = Date.parse(entry.updatedAt ?? entry.publishedAt);
    const index = indexById.get(entry.videoId);
    if (index === undefined) {
      indexById.set(entry.videoId, deduped.length);
      deduped.push(entry);
      continue;
    }
    const previous = deduped[index];
    if (at > Date.parse(previous.updatedAt ?? previous.publishedAt))
      deduped[index] = entry;
  }
  return deduped;
}

/**
 * Merge a sparse Atom event into the stored row without blanking known
 * metadata. Returns null when the visible content is unchanged; the caller may
 * still advance the ordering watermark with a single stamp write, but never
 * rewrites metadata or publishes a feed epoch for it.
 */
function planUpdate(
  channelId: string,
  entry: AtomEntry,
  current: ExistingVideoRow,
): PlannedUpdate | null {
  // A channel topic may never take ownership of another channel's video.
  if (current.channel_id !== "" && current.channel_id !== channelId)
    return null;

  const title = entry.title || current.title;
  const placeholder = current.channel_id === "" || current.purged_at !== null;
  const channelTitle = placeholder
    ? entry.channelTitle || channelId
    : entry.channelTitle || current.channel_title || channelId;
  // Presence, not non-emptiness: an explicit empty <media:description/> is a
  // real clear, while a sparse entry without the element preserves the row.
  const description = nextValue(
    entry.hasDescription,
    entry.description,
    placeholder ? "" : current.description,
  );
  const thumbnailUrl = nextValue(
    entry.hasThumbnail && entry.thumbnailUrl !== "",
    entry.thumbnailUrl,
    placeholder ? "" : current.thumbnail_url,
  );
  const durationSeconds = nextValue(
    entry.hasDuration,
    entry.durationSeconds,
    placeholder ? null : current.duration_seconds,
  );
  const viewCount = nextValue(
    entry.hasViewCount,
    entry.viewCount,
    placeholder ? null : current.view_count,
  );
  const source = placeholder ? "rss" : current.source;
  const visibleChanged =
    current.channel_id !== channelId ||
    current.purged_at !== null ||
    current.source !== source ||
    current.title !== title ||
    current.channel_title !== channelTitle ||
    current.description !== description ||
    current.thumbnail_url !== thumbnailUrl ||
    current.published_at !== entry.publishedAt ||
    !sameNullable(current.duration_seconds, durationSeconds) ||
    !sameNullable(current.view_count, viewCount);
  if (!visibleChanged) return null;
  return {
    entry,
    eventAt: entry.updatedAt ?? entry.publishedAt,
    channelTitle,
    title,
    description,
    thumbnailUrl,
    durationSeconds,
    viewCount,
    source,
    expectedWatermark: current.websub_updated_at,
    expectedHash: current.websub_hash,
  };
}

/**
 * One batched eligibility query for the whole payload. An existing video may
 * only be refreshed while at least one interested real connected subscriber
 * has not explicitly marked it watched, or while any playlist holds it.
 * Ineligible videos never reach a write statement and there is no per-entry
 * fanout over subscribers.
 */
async function eligibleVideoIds(
  env: Env,
  channelId: string,
  ids: string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await env.DB.prepare(
    `SELECT v.id AS id FROM videos v
     WHERE v.id IN (${ids.map(() => "?").join(",")})
       AND (
         EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.video_id = v.id)
         OR EXISTS (
           SELECT 1
           FROM subscriptions s
           JOIN accounts a ON a.id = s.account_id
           WHERE s.channel_id = ? AND s.active = 1 AND s.excluded = 0
             AND a.mode = 'real' AND a.connected = 1
             AND (v.duration_seconds IS NULL OR v.duration_seconds>=180
               OR v.duration_seconds=0 OR COALESCE(v.is_live,0)=1
               OR COALESCE(v.live_broadcast_content,'none')<>'none'
               OR EXISTS(SELECT 1 FROM watch_states chosen
                 WHERE chosen.account_id=s.account_id AND chosen.video_id=v.id))
             AND NOT EXISTS (
               SELECT 1 FROM watch_states ws
               WHERE ws.account_id = s.account_id AND ws.video_id = v.id
                 AND ws.watched = 1
             )
         )
       )`,
  )
    .bind(...ids, channelId)
    .all<{ id: string }>();
  return new Set((rows.results ?? []).map((row) => row.id));
}

function revisionStatement(env: Env, now: string): D1PreparedStatement {
  // changes() is evaluated inside the same D1 batch directly after the write,
  // so a conflict no-op or a stale guard never publishes a new epoch.
  return env.DB.prepare(
    `UPDATE youtube_feed_state SET revision = revision + 1, updated_at = ?
     WHERE id = 1 AND changes() > 0`,
  ).bind(now);
}

/**
 * A conditional write that changed nothing is safe only when the channel was
 * concurrently unsubscribed or the stored row already carries an event at
 * least as new. Otherwise acknowledging would silently lose this event, so the
 * delivery is rejected as retryable and the daily sweep can recover it.
 */
async function assertNoLostUpdates(
  env: Env,
  channelId: string,
  actions: IngestAction[],
): Promise<void> {
  if (!actions.length) return;
  const channel = await env.DB.prepare(
    "SELECT desired FROM websub_channels WHERE channel_id = ?",
  )
    .bind(channelId)
    .first<{ desired: number }>();
  // The last unsubscribe wins over an in-flight notification or RSS batch.
  if (channel?.desired !== 1) return;

  const ids = [...new Set(actions.map((action) => action.videoId))];
  const rows = await env.DB.prepare(
    `SELECT id, websub_updated_at FROM videos
     WHERE id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<{ id: string; websub_updated_at: string | null }>();
  const latest = new Map(
    (rows.results ?? []).map((row) => [row.id, row.websub_updated_at]),
  );
  const inserts = actions.filter((action) => action.kind === "insert");
  const tombstones = new Set(inserts.length
    ? ((await env.DB.prepare(
      `SELECT video_id FROM short_video_tombstones WHERE video_id IN (${inserts.map(() => "?").join(",")})`,
    ).bind(...inserts.map((action) => action.videoId)).all<{ video_id: string }>()).results ?? []).map((row) => row.video_id)
    : []);
  for (const action of actions) {
    if (action.kind === "insert" && tombstones.has(action.videoId)) continue;
    const watermark = latest.get(action.videoId) ?? null;
    const watermarkMs = watermark ? Date.parse(watermark) : Number.NaN;
    if (Number.isFinite(watermarkMs) && watermarkMs >= action.eventMs) continue;
    throw new HttpError(
      409,
      "INGEST_CONFLICT",
      "Concurrent video update; retry the delivery.",
    );
  }
}

/**
 * Idempotent ingest shared by the daily RSS sweep and WebSub notifications.
 *
 * Ordering on both paths:
 *  - a push event must be strictly newer than the stored raw <updated>;
 *  - RSS may enrich an existing row at the same <updated>, because a sparse
 *    push can omit media fields that the full feed later supplies, but RSS
 *    never regresses to an older event;
 *  - an identical newer event writes exactly one ordering stamp so a later
 *    older event cannot move the watermark backwards. It rewrites no visible
 *    metadata and never advances the global feed revision.
 *
 * Identical rules on both paths:
 *  - an unknown or existing video published more than one calendar year ago
 *    is never synced or updated;
 *  - unknown videos inside that window are imported (the old 24h bootstrap
 *    ceiling is superseded);
 *  - refreshed metadata additionally requires an interested real connected
 *    subscriber that has not watched the video, or playlist membership.
 *
 * Exact duplicates, reordered/older events, unchanged RSS duplicates,
 * ineligible videos and out-of-retention entries produce zero writes and never
 * advance the global feed revision. `source` defaults to `"push"`; only the
 * daily RSS sweep passes `"rss"`.
 */
export async function ingestParsedEntries(
  env: Env,
  channelId: string,
  entries: AtomEntry[],
  now: string,
  source: "push" | "rss" = "push",
): Promise<IngestSummary> {
  if (!CHANNEL_ID.test(channelId))
    throw new HttpError(400, "VALIDATION_ERROR", "Invalid channel id.");
  const summary: IngestSummary = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    ineligible: 0,
  };
  if (!entries.length) return summary;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid now");

  const oldest = oldestVideoDate(now);
  const oldestMs = Date.parse(oldest);
  const futureLimit = nowMs + MAX_CLOCK_SKEW_MS;
  // Reject age/owner-invalid entries before touching D1, including unknown IDs.
  const deduped = newestEventPerVideo(entries).filter((entry) => {
    const published = Date.parse(entry.publishedAt);
    const event = Date.parse(entry.updatedAt ?? entry.publishedAt);
    const valid =
      Number.isFinite(published) &&
      published >= oldestMs &&
      published <= futureLimit &&
      Number.isFinite(event) &&
      event <= futureLimit &&
      (!entry.channelId || entry.channelId === channelId);
    if (!valid) summary.skipped++;
    return valid;
  });
  if (!deduped.length) return summary;
  const ids = deduped.map((entry) => entry.videoId);
  const existingRows = await env.DB.prepare(
    `SELECT id, channel_id, channel_title, title, description, thumbnail_url,
            published_at, duration_seconds, view_count, source, purged_at,
            websub_updated_at, websub_hash
     FROM videos WHERE id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<ExistingVideoRow>();
  const existing = new Map(
    (existingRows.results ?? []).map((row) => [row.id, row]),
  );

  const expiresAt = isoInDays(25, new Date(now));

  const inserts: AtomEntry[] = [];
  const updates: PlannedUpdate[] = [];
  const stamps: PlannedStamp[] = [];
  for (const entry of deduped) {
    const eventAt = entry.updatedAt ?? entry.publishedAt;
    const eventMs = Date.parse(eventAt);
    if (!Number.isFinite(eventMs) || eventMs > futureLimit) {
      summary.skipped += 1;
      continue;
    }
    // A channel feed or topic never writes another channel's video.
    if (entry.channelId && entry.channelId !== channelId) {
      summary.skipped += 1;
      continue;
    }
    const current = existing.get(entry.videoId);
    if (!current) {
      const publishedMs = Date.parse(entry.publishedAt);
      if (!entry.title || !Number.isFinite(publishedMs)) {
        summary.skipped += 1;
        continue;
      }
      // Absolute one-calendar-year retention floor for every discovery path.
      if (publishedMs < oldestMs || publishedMs > futureLimit) {
        summary.skipped += 1;
        continue;
      }
      inserts.push(entry);
      continue;
    }
    if (current.channel_id !== "" && current.channel_id !== channelId) {
      summary.skipped += 1;
      continue;
    }
    const watermarkMs = current.websub_updated_at
      ? Date.parse(current.websub_updated_at)
      : Number.NaN;
    const hasWatermark = Number.isFinite(watermarkMs);
    if (hasWatermark && watermarkMs > eventMs) {
      // Older event: never regress the source ordering.
      summary.skipped += 1;
      continue;
    }
    if (hasWatermark && watermarkMs === eventMs && source === "push") {
      // Exact duplicate or same-timestamp push redelivery: zero writes.
      summary.skipped += 1;
      continue;
    }
    // The stored publication date is authoritative for the retention floor,
    // and a feed may never push an event for a publication older than a year.
    const publishedMs = Date.parse(current.published_at);
    const entryPublishedMs = Date.parse(entry.publishedAt);
    if (
      !Number.isFinite(publishedMs) ||
      publishedMs < oldestMs ||
      !Number.isFinite(entryPublishedMs) ||
      entryPublishedMs < oldestMs ||
      entryPublishedMs > futureLimit
    ) {
      summary.skipped += 1;
      continue;
    }
    const plan = planUpdate(channelId, entry, current);
    if (!plan) {
      if (!hasWatermark || eventMs > watermarkMs) {
        // Identical content but newer source timestamp: advance ordering only.
        stamps.push({
          videoId: entry.videoId,
          eventAt,
          eventMs,
          expectedWatermark: current.websub_updated_at,
        });
      } else {
        // RSS duplicate with identical content at the same timestamp.
        summary.skipped += 1;
      }
      continue;
    }
    updates.push(plan);
  }

  // Ordering-only stamps still obey the watched/playlist user rule: an
  // ineligible video is left completely untouched, including its watermark.
  const eligible = await eligibleVideoIds(env, channelId, [
    ...updates.map((plan) => plan.entry.videoId),
    ...stamps.map((stamp) => stamp.videoId),
  ]);
  const statements: D1PreparedStatement[] = [];
  const actions: IngestAction[] = [];

  for (const entry of inserts) {
    const channelTitle = entry.channelTitle || channelId;
    const eventAt = entry.updatedAt ?? entry.publishedAt;
    const hash = await contentHash([
      channelId,
      channelTitle,
      entry.title,
      entry.description,
      entry.thumbnailUrl,
      entry.publishedAt,
      entry.durationSeconds,
      entry.viewCount,
    ]);
    actions.push({
      kind: "insert",
      index: statements.length,
      videoId: entry.videoId,
      eventAt,
      eventMs: Date.parse(eventAt),
    });
    statements.push(
      env.DB.prepare(
        `INSERT INTO videos
           (id, channel_id, channel_title, title, description, thumbnail_url,
            published_at, duration_seconds, view_count, source, fetched_at,
            expires_at, purged_at, created_at, updated_at, is_live,
            details_fetched_at, details_expires_at, live_broadcast_content, short_candidate,
            websub_updated_at, websub_hash)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rss', ?, ?, NULL, ?, ?, NULL,
                NULL, NULL, NULL, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM short_video_tombstones WHERE video_id = ?)
         AND EXISTS (
           SELECT 1 FROM websub_channels
           WHERE channel_id = ? AND desired = 1
         )
         ON CONFLICT(id) DO NOTHING`,
      ).bind(
        entry.videoId,
        channelId,
        channelTitle,
        entry.title,
        entry.description,
        entry.thumbnailUrl,
        entry.publishedAt,
        entry.durationSeconds,
        entry.viewCount,
        now,
        entry.durationSeconds !== null && entry.durationSeconds > 0 && entry.durationSeconds < 180
          ? isoInDays(31, new Date(now)) : expiresAt,
        now,
        now,
        entry.durationSeconds !== null && entry.durationSeconds > 0 && entry.durationSeconds < 180 ? 1 : 0,
        eventAt,
        hash,
        entry.videoId,
        channelId,
      ),
    );
    statements.push(revisionStatement(env, now));
  }

  for (const plan of updates) {
    if (!eligible.has(plan.entry.videoId)) {
      // Watched by every interested subscriber and absent from every playlist:
      // skip the metadata entirely instead of writing a dead update.
      summary.ineligible += 1;
      summary.skipped += 1;
      continue;
    }
    const hash = await contentHash([
      channelId,
      plan.channelTitle,
      plan.title,
      plan.description,
      plan.thumbnailUrl,
      plan.entry.publishedAt,
      plan.durationSeconds,
      plan.viewCount,
      plan.source,
    ]);
    actions.push({
      kind: "visible",
      index: statements.length,
      videoId: plan.entry.videoId,
      eventAt: plan.eventAt,
      eventMs: Date.parse(plan.eventAt),
    });
    statements.push(
      env.DB.prepare(
        `UPDATE videos SET
           channel_id = ?, channel_title = ?, title = ?, description = ?,
           thumbnail_url = ?, published_at = ?, duration_seconds = ?,
           view_count = ?, source = ?, purged_at = NULL,
           short_candidate = CASE WHEN ? IS NULL THEN short_candidate WHEN ?>0 AND ?<180
             AND COALESCE(is_live,0)=0 AND COALESCE(live_broadcast_content,'none')='none'
             THEN 1 ELSE 0 END,
           websub_updated_at = ?, websub_hash = ?,
           expires_at = CASE WHEN expires_at IS NULL OR expires_at < ?
                             THEN ? ELSE expires_at END,
           updated_at = ?
         WHERE id = ? AND (channel_id = '' OR channel_id = ?)
           AND IFNULL(websub_updated_at, '') = ?
           AND IFNULL(websub_hash, '') = ?
           AND published_at >= ?
           AND EXISTS (
             SELECT 1 FROM websub_channels
             WHERE channel_id = ? AND desired = 1
           )`,
      ).bind(
        channelId,
        plan.channelTitle,
        plan.title,
        plan.description,
        plan.thumbnailUrl,
        plan.entry.publishedAt,
        plan.durationSeconds,
        plan.viewCount,
        plan.source,
        plan.durationSeconds,
        plan.durationSeconds,
        plan.durationSeconds,
        plan.eventAt,
        hash,
        plan.durationSeconds !== null && plan.durationSeconds > 0 && plan.durationSeconds < 180
          ? isoInDays(31, new Date(now)) : expiresAt,
        plan.durationSeconds !== null && plan.durationSeconds > 0 && plan.durationSeconds < 180
          ? isoInDays(31, new Date(now)) : expiresAt,
        now,
        plan.entry.videoId,
        channelId,
        plan.expectedWatermark ?? "",
        plan.expectedHash ?? "",
        oldest,
        channelId,
      ),
    );
    statements.push(revisionStatement(env, now));
  }

  for (const stamp of stamps) {
    if (!eligible.has(stamp.videoId)) {
      summary.ineligible += 1;
      summary.skipped += 1;
      continue;
    }
    actions.push({
      kind: "stamp",
      index: statements.length,
      videoId: stamp.videoId,
      eventAt: stamp.eventAt,
      eventMs: stamp.eventMs,
    });
    // Ordering only: no visible metadata, updated_at or feed revision.
    statements.push(
      env.DB.prepare(
        `UPDATE videos SET websub_updated_at = ?
         WHERE id = ? AND (channel_id = '' OR channel_id = ?)
           AND IFNULL(websub_updated_at, '') = ?
           AND published_at >= ?
           AND EXISTS (
             SELECT 1 FROM websub_channels
             WHERE channel_id = ? AND desired = 1
           )`,
      ).bind(
        stamp.eventAt,
        stamp.videoId,
        channelId,
        stamp.expectedWatermark ?? "",
        oldest,
        channelId,
      ),
    );
  }

  if (!statements.length) return summary;
  const results = await env.DB.batch(statements);
  const noops: IngestAction[] = [];
  for (const action of actions) {
    const changed = (results[action.index]?.meta.changes ?? 0) > 0;
    if (!changed) {
      noops.push(action);
      continue;
    }
    if (action.kind === "insert") summary.inserted += 1;
    else if (action.kind === "visible") summary.updated += 1;
    else summary.skipped += 1;
  }
  if (noops.length) {
    await assertNoLostUpdates(env, channelId, noops);
    // Every no-op is either a concurrent duplicate/newer row or an intentional
    // last-unsubscribe gate; neither produced visible metadata.
    summary.skipped += noops.length;
  }
  await warmFeedThumbnails(env, actions.filter((action) =>
    action.kind !== "stamp" && (results[action.index]?.meta.changes ?? 0) > 0,
  ).map((action) => action.videoId));
  return summary;
}

async function handleNotification(
  request: Request,
  env: Env,
  url: URL,
  channelId: string,
): Promise<Response> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    !["application/atom+xml", "application/xml", "text/xml"].includes(
      mediaType || "",
    )
  )
    return textResponse("Expected Atom XML.", 415);
  const token = queryToken(url);
  if (
    !token ||
    !constantTimeEqual(token, await websubRoutingToken(env, channelId))
  )
    return textResponse("Not found.", 404);

  const row = await channelRow(env, channelId);
  if (!row || row.desired !== 1) return textResponse("Not found.", 404);
  const subscribed =
    row.hub_state === "subscribed" ||
    (row.hub_state === "pending_subscribe" &&
      row.hub_lease_expires_at !== null);
  if (!subscribed) return textResponse("Not found.", 404);

  const body = await rawRequestBody(request);
  if (!body) return textResponse("Payload too large.", 413);
  const signed = await verifyWebSubSignature(
    env,
    channelId,
    body,
    request.headers.get("x-hub-signature"),
    request.headers.get("x-hub-signature-256"),
  );
  if (!signed) return textResponse("Invalid signature.", 401);

  let feed: ReturnType<typeof parseAtomFeed>;
  try {
    feed = parseAtomFeed(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof HttpError && error.code === "FEED_TOO_LARGE")
      return textResponse("Payload too large.", 413);
    return textResponse("Invalid Atom notification.", 422);
  }
  if (feed.entries.length > MAX_NOTIFICATION_ENTRIES)
    return textResponse("Too many entries.", 413);
  if (feed.skipped) return textResponse("Incomplete Atom notification.", 422);
  // The callback channel is the owner topic. Reject the complete notification
  // if any entry claims a different owner, before writing anything.
  if (feed.entries.some((entry) => entry.channelId !== channelId))
    return textResponse("Notification owner does not match the topic.", 422);

  const now = nowIso();
  try {
    await ingestParsedEntries(env, channelId, feed.entries, now);
  } catch (error) {
    if (error instanceof HttpError)
      return textResponse(error.message, error.status);
    return textResponse("Notification could not be stored.", 500);
  }
  return textResponse("", 204);
}

export async function handleWebSub(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isWebSubEnabled(env)) return textResponse("Not found.", 404);
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return textResponse("Bad request.", 400);
  }
  if (url.pathname !== WEBSUB_CALLBACK_PATH)
    return textResponse("Not found.", 404);
  const channelId = queryChannel(url);
  if (!channelId) return textResponse("Invalid channel.", 400);
  if (request.method === "GET")
    return handleVerification(request, env, url, channelId);
  if (request.method === "POST")
    return handleNotification(request, env, url, channelId);
  return textResponse("Method not allowed.", 405, { allow: "GET, POST" });
}
