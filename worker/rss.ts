/**
 * YouTube channel Atom feed parsing.
 *
 * Only channel ids are accepted; callers never supply an arbitrary feed URL,
 * which keeps the RSS path free of SSRF. The parser is a real XML parser
 * (fast-xml-parser), not regular expressions, and rejects DOCTYPE declarations
 * so no external entity machinery is involved.
 */
import { XMLParser } from "fast-xml-parser";
import { HttpError, parseIsoDate, sanitizeText } from "./http";

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AtomEntry {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  durationSeconds: number | null;
  viewCount: number | null;
  /** Atom <updated>; absent in feeds that only publish one timestamp. */
  updatedAt?: string;
  /** Presence flags distinguish sparse WebSub entries from explicit empty values. */
  hasDescription?: boolean;
  hasThumbnail?: boolean;
  hasDuration?: boolean;
  hasViewCount?: boolean;
}

/** One calendar year before now, used by both global discovery paths. */
export function oldestVideoDate(now: string | Date = new Date()): string {
  const reference =
    now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(reference.getTime())) throw new TypeError("Invalid now");
  reference.setUTCFullYear(reference.getUTCFullYear() - 1);
  return reference.toISOString();
}

/** Never sync or update a video published more than a calendar year ago. */
export function isRecentEnough(
  publishedAt: string,
  now: string | Date = new Date(),
): boolean {
  const published = Date.parse(publishedAt);
  const oldest = Date.parse(oldestVideoDate(now));
  return Number.isFinite(published) && published >= oldest;
}

export interface ParsedAtomFeed {
  feedId: string | null;
  title: string | null;
  entries: AtomEntry[];
  skipped: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  isArray: (name) => name === "entry",
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function text(value: unknown, maxLength: number): string {
  const direct = first(value);
  if (typeof direct === "string") return sanitizeText(direct, maxLength);
  if (typeof direct === "number") return String(direct);
  const record = asRecord(direct);
  if (record) return text(record["#text"], maxLength);
  return "";
}

function safeThumbnailUrl(value: unknown): string {
  const raw = text(value, 500);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    const allowed =
      host.endsWith(".ytimg.com") ||
      host.endsWith(".ggpht.com") ||
      host.endsWith(".googleusercontent.com") ||
      host === "youtube.com" ||
      host === "www.youtube.com";
    return allowed ? url.toString() : "";
  } catch {
    return "";
  }
}

function positiveInt(value: unknown): number | null {
  const raw = text(value, 30);
  if (!/^\d{1,15}$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function channelIdFromFeedId(feedId: string | null): string {
  if (!feedId) return "";
  const match = /^yt:channel:([A-Za-z0-9_-]{1,64})$/.exec(feedId);
  return match ? match[1] : "";
}

export function channelFeedUrl(channelId: string): string {
  if (!CHANNEL_ID.test(channelId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "Invalid channel id.");
  }
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

export function parseAtomFeed(xml: string): ParsedAtomFeed {
  if (typeof xml !== "string" || !xml.trim()) {
    throw new HttpError(422, "INVALID_FEED", "Feed is empty.");
  }
  if (xml.length > MAX_FEED_BYTES) {
    throw new HttpError(
      413,
      "FEED_TOO_LARGE",
      "Feed is larger than the allowed size.",
    );
  }
  if (/<!DOCTYPE/i.test(xml)) {
    throw new HttpError(
      422,
      "INVALID_FEED",
      "Feed must not contain a DOCTYPE declaration.",
    );
  }

  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    throw new HttpError(422, "INVALID_FEED", "Feed is not valid XML.");
  }

  const root = asRecord(document);
  const feed = asRecord(root?.feed);
  if (!feed) {
    throw new HttpError(
      422,
      "INVALID_FEED",
      "XML document is not an Atom feed.",
    );
  }

  const feedId = text(feed.id, 200) || null;
  const feedTitle = text(feed.title, 300) || null;
  const fallbackChannelId = channelIdFromFeedId(feedId);
  const feedChannelTitle =
    text(asRecord(feed.author)?.name, 300) || feedTitle || "";

  const rawEntries = Array.isArray(feed.entry) ? feed.entry : [];
  const entries: AtomEntry[] = [];
  let skipped = 0;

  for (const rawEntry of rawEntries) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      skipped += 1;
      continue;
    }
    const videoId = text(entry["yt:videoId"], 32);
    const title = text(entry.title, 500);
    const publishedRaw = text(entry.published, 40) || text(entry.updated, 40);
    if (!VIDEO_ID.test(videoId) || !title || !publishedRaw) {
      skipped += 1;
      continue;
    }

    let publishedAt: string;
    try {
      publishedAt = parseIsoDate(publishedRaw, "published");
    } catch {
      skipped += 1;
      continue;
    }
    let updatedAt: string | undefined;
    const updatedRaw = text(entry.updated, 40);
    if (updatedRaw) {
      try {
        updatedAt = parseIsoDate(updatedRaw, "updated");
      } catch {
        updatedAt = undefined;
      }
    }

    const group = asRecord(first(entry["media:group"]));
    const hasDescription = group?.["media:description"] !== undefined;
    const description = group ? text(group["media:description"], 5000) : "";
    const thumbnail = group
      ? safeThumbnailUrl(asRecord(first(group["media:thumbnail"]))?.["@_url"])
      : "";
    const community = group ? asRecord(first(group["media:community"])) : null;
    const statistics = community
      ? asRecord(first(community["media:statistics"]))
      : null;
    const content = group ? asRecord(first(group["media:content"])) : null;
    const durationRaw = content ? text(content["@_duration"], 20) : "";
    const durationSeconds = /^\d{1,7}$/.test(durationRaw)
      ? Number(durationRaw)
      : null;
    const viewCount = statistics ? positiveInt(statistics["@_views"]) : null;

    entries.push({
      videoId,
      channelId: text(entry["yt:channelId"], 64) || fallbackChannelId,
      channelTitle: text(asRecord(entry.author)?.name, 300) || feedChannelTitle,
      title,
      description,
      publishedAt,
      thumbnailUrl: thumbnail,
      durationSeconds,
      viewCount,
      ...(updatedAt ? { updatedAt } : {}),
      hasDescription,
      hasThumbnail: thumbnail !== "",
      hasDuration: durationSeconds !== null,
      hasViewCount: viewCount !== null,
    });
  }

  return { feedId, title: feedTitle, entries, skipped };
}
