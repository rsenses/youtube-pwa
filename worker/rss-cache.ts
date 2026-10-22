/**
 * Optional READ_CACHE record of the last successful RSS check per account and
 * channel. D1 stays authoritative: a missing, stale or invalid record only
 * forces an unconditional feed request. Validators are published only after
 * the corresponding video rows were written successfully.
 */
import type { Env } from "./types";

export const RSS_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const KEY_VERSION = "v1";
const ENVELOPE_VERSION = 1;
const TTL_SECONDS = 2 * 24 * 60 * 60;
const MAX_VALIDATOR_LENGTH = 500;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface RssCheck {
  checkedAt: string;
  etag: string | null;
  lastModified: string | null;
}

interface RssCheckEnvelope extends RssCheck {
  v: number;
  accountId: string;
  channelId: string;
}

function checkKey(accountId: string, channelId: string): string {
  return `rss-check:${KEY_VERSION}:${encodeURIComponent(accountId)}:${encodeURIComponent(channelId)}`;
}

function validator(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" &&
    value.length <= MAX_VALIDATOR_LENGTH &&
    !/[\u0000-\u001F\u007F]/.test(value)
  )
    return value || null;
  return undefined;
}

function decode(
  raw: string | null,
  accountId: string,
  channelId: string,
  now: string,
): RssCheck | null {
  if (raw === null) return null;
  if (raw.length > 2048) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const value = parsed as Record<string, unknown>;
  if (
    value.v !== ENVELOPE_VERSION ||
    value.accountId !== accountId ||
    value.channelId !== channelId ||
    typeof value.checkedAt !== "string"
  )
    return null;
  const etag = validator(value.etag);
  const lastModified = validator(value.lastModified);
  if (etag === undefined || lastModified === undefined) return null;
  const checked = Date.parse(value.checkedAt);
  const reference = Date.parse(now);
  if (!Number.isFinite(checked) || !Number.isFinite(reference)) return null;
  if (checked > reference + MAX_CLOCK_SKEW_MS) return null;
  if (checked < reference - RSS_RECENT_WINDOW_MS) return null;
  return { checkedAt: value.checkedAt, etag, lastModified };
}

/** The frozen public window for a sync job: entries older than this are ignored. */
export function rssRecentCutoff(startedAt: string): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) throw new TypeError("Invalid sync start");
  return new Date(started - RSS_RECENT_WINDOW_MS).toISOString();
}

export async function readRssCheck(
  env: Env,
  accountId: string,
  channelId: string,
  now: string,
): Promise<RssCheck | null> {
  if (!env.READ_CACHE) return null;
  try {
    return decode(
      await env.READ_CACHE.get(checkKey(accountId, channelId)),
      accountId,
      channelId,
      now,
    );
  } catch {
    // The cache is optional; any KV failure safely falls back to a full check.
    return null;
  }
}

export async function writeRssCheck(
  env: Env,
  accountId: string,
  channelId: string,
  check: RssCheck,
): Promise<void> {
  if (!env.READ_CACHE) return;
  const etag = validator(check.etag);
  const lastModified = validator(check.lastModified);
  const checked = Date.parse(check.checkedAt);
  if (
    etag === undefined ||
    lastModified === undefined ||
    !Number.isFinite(checked)
  )
    return;
  const envelope: RssCheckEnvelope = {
    v: ENVELOPE_VERSION,
    accountId,
    channelId,
    checkedAt: check.checkedAt,
    etag,
    lastModified,
  };
  try {
    await env.READ_CACHE.put(
      checkKey(accountId, channelId),
      JSON.stringify(envelope),
      { expirationTtl: TTL_SECONDS },
    );
  } catch {
    // Best effort only; losing a validator can never lose durable D1 data.
  }
}
