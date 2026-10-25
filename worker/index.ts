/**
 * Worker entry point: small explicit router, JSON-only API errors, ASSETS
 * fallback for the SPA. All /api routes resolve the account from the session
 * cookie; the client can never choose an account id.
 */
import { privateVideoStatements } from "./private-metadata";
import type { AccountRow, CommentItem, Env, SessionRow, Video } from "./types";
import { cachedFeed, invalidateReads, feedRevision } from "./read-cache";
import { deleteFeedThumbnail, deleteWatchedThumbnails, feedThumbnailPath, serveFeedThumbnail, warmKnownFeedThumbnail } from "./feed-thumbnails";
import { handleWebSub, WEBSUB_CALLBACK_PATH } from "./websub";
import {
  ExternalError,
  HttpError,
  assertCommentId,
  assertId,
  assertPageToken,
  decodeCursor,
  encodeCursor,
  errorResponse,
  isoInDays,
  nowIso,
  json,
  optionalBoolean,
  optionalFiniteNumber,
  optionalString,
  parseEnum,
  parseIsoDate,
  parseLimit,
  parseOptionalQuery,
  readJsonObject,
  requiredBoolean,
  requiredString,
  requireCsrf,
  requireMutationOrigin,
  sanitizeText,
} from "./http";
import {
  addPlaylistItemRow,
  bulkWatchState,
  createPlaylist,
  deletePlaylistItemRow,
  deletePlaylistRow,
  getChannelRow,
  getPlaylistDetail,
  getPlaylistItem,
  getPlaylistRow,
  getPreferences,
  getSubscription,
  getSuggestions,
  getVideo,
  getWatchSnapshot,
  listChannels,
  listFeed,
  listPlaylists,
  nextPlaylistPosition,
  purgeExpiredMetadata,
  savePreferences,
  setChannelExcluded,
  setManualWatchState,
  setPlaylistExcluded,
  setProgress,
  subscribeLocal,
  unsubscribeRow,
  updatePlaylistRow,
  upsertExternalChannel,
  upsertRemoteSubscription,
  type ExternalChannel,
  type ExternalVideo,
  type VideoScope,
} from "./db";
import {
  buildSessionInfo,
  getSessionAccount,
  getValidAccessToken,
  handleDeleteAccountData,
  handleDisconnect,
  handleLogout,
  handleOAuthCallback,
  handleOAuthStart,
  requireConnectedAccount,
  requireWriteScope,
  resolveSession,
  type SessionContext,
} from "./auth";
import {
  deletePlaylist as youtubeDeletePlaylist,
  deletePlaylistItem as youtubeDeletePlaylistItem,
  deleteSubscription as youtubeDeleteSubscription,
  insertPlaylist as youtubeInsertPlaylist,
  insertPlaylistItem as youtubeInsertPlaylistItem,
  insertSubscription as youtubeInsertSubscription,
  listChannels as youtubeListChannels,
  listCommentReplies,
  listCommentThreads,
  listSubscriptions as youtubeListSubscriptions,
  listVideos as youtubeListVideos,
  parseIsoDuration,
  pickThumbnailUrl,
  updatePlaylist as youtubeUpdatePlaylist,
  type YouTubeCommentItem,
  type YouTubeCommentThreadItem,
  type YouTubeSubscriptionItem,
  type YouTubeVideoItem,
} from "./youtube";
import {
  METADATA_TTL_DAYS,
  getSyncStatus,
  handleSync,
  isSyncType,
  runScheduledSync,
} from "./sync";

import {
  ensurePublicExamples,
  listPublicChannelVideos,
  getPublicPreview,
  getPublicVideo,
  getPublicSuggestions,
  searchPublicVideos,
  storeVideos,
} from "./public-youtube";
import {
  consumeSyncQueue,
  startQueuedSync,
  queuedSyncStatus,
  type SyncMessage,
} from "./queue-sync";

const FEED_STATUSES = ["all", "pending", "watched"] as const;
const PLAYLIST_SOURCES = ["local", "youtube"] as const;
const THEMES = ["system", "light", "dark"] as const;

interface RouteContext {
  env: Env;
  request: Request;
  url: URL;
  session: SessionRow;
  account: AccountRow | null;
  params: string[];
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: RouteContext) => Promise<Response>;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function requireAccount(ctx: RouteContext): AccountRow {
  if (!ctx.account) {
    throw new HttpError(
      401,
      "AUTH_REQUIRED",
      "A connected account is required for this operation.",
    );
  }
  return ctx.account;
}

/** A configured public API key upgrades the demo to genuine public metadata. */
function videoScope(ctx: RouteContext): VideoScope {
  return ctx.env.MODE === "demo" && !ctx.env.YOUTUBE_API_KEY
    ? "fixture"
    : "external";
}

function routeParam(ctx: RouteContext, index: number, label: string): string {
  const decoded = rawRouteParam(ctx, index, label);
  return assertId(decoded, label);
}

function rawRouteParam(
  ctx: RouteContext,
  index: number,
  label: string,
): string {
  const raw = ctx.params[index] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid ${label}.`);
  }
  if (!decoded || decoded.length > 200) {
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid ${label}.`);
  }
  return decoded;
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function integerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function safeAvatarUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      (host.endsWith(".googleusercontent.com") ||
        host.endsWith(".ggpht.com") ||
        host.endsWith(".ytimg.com"))
    ) {
      return url.toString();
    }
  } catch {
    // ignore invalid avatar URLs
  }
  return "";
}

function isNotFoundReason(error: ExternalError): boolean {
  const reason = error.reason.toLowerCase();
  return reason.includes("notfound") || reason.includes("not_found");
}

function isAmbiguousExternalError(error: unknown): error is ExternalError {
  return (
    error instanceof ExternalError &&
    (error.reason === "timeout" || error.reason === "network")
  );
}

async function findRemoteSubscription(
  token: string,
  channelId: string,
): Promise<YouTubeSubscriptionItem | null> {
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const data = await youtubeListSubscriptions(token, pageToken);
    const found = (data.items ?? []).find(
      (item) => item.snippet?.resourceId?.channelId === channelId,
    );
    if (found?.id) return found;
    pageToken =
      typeof data.nextPageToken === "string" && data.nextPageToken
        ? data.nextPageToken
        : undefined;
    if (!pageToken) break;
  }
  return null;
}

function mapCommentThread(item: YouTubeCommentThreadItem): CommentItem | null {
  const comment = item.snippet?.topLevelComment;
  const snippet = comment?.snippet;
  if (!comment?.id || !snippet) return null;
  const publishedAt = isoOrNull(snippet.publishedAt);
  if (!publishedAt) return null;
  const mapped: CommentItem = {
    id: comment.id,
    author: sanitizeText(snippet.authorDisplayName, 200) || "YouTube user",
    avatarUrl: safeAvatarUrl(snippet.authorProfileImageUrl),
    publishedAt,
    text: sanitizeText(snippet.textOriginal ?? snippet.textDisplay, 5000),
    likeCount: integerOrZero(snippet.likeCount),
  };
  if (typeof item.snippet?.totalReplyCount === "number") {
    mapped.replyCount = integerOrZero(item.snippet.totalReplyCount);
  }
  return mapped;
}

function mapCommentReply(item: YouTubeCommentItem): CommentItem | null {
  const snippet = item.snippet;
  if (!item.id || !snippet) return null;
  const publishedAt = isoOrNull(snippet.publishedAt);
  if (!publishedAt) return null;
  return {
    id: item.id,
    author: sanitizeText(snippet.authorDisplayName, 200) || "YouTube user",
    avatarUrl: safeAvatarUrl(snippet.authorProfileImageUrl),
    publishedAt,
    text: sanitizeText(snippet.textOriginal ?? snippet.textDisplay, 5000),
    likeCount: integerOrZero(snippet.likeCount),
  };
}

function errorFromComments(error: unknown): never {
  if (error instanceof ExternalError) {
    if (error.reason === "commentsdisabled") {
      throw new HttpError(
        403,
        "COMMENTS_DISABLED",
        "Comments are disabled for this video.",
      );
    }
    if (error.reason === "videonotfound") {
      throw new HttpError(
        404,
        "VIDEO_NOT_FOUND",
        "Video not found on YouTube.",
      );
    }
  }
  throw error;
}

async function ensureVideoKnown(
  ctx: RouteContext,
  videoId: string,
  refresh = false,
): Promise<Video | null> {
  const account = requireAccount(ctx);
  const scope = videoScope(ctx);
  const existing = await getVideo(ctx.env.DB, account.id, videoId, scope);
  if (existing && !refresh) return existing;
  if (ctx.env.MODE !== "real") return null;

  requireConnectedAccount(account);
  const token = await getValidAccessToken(ctx.env, account.id);
  let item: YouTubeVideoItem | undefined;
  try {
    const data = await youtubeListVideos(token, [videoId]);
    item = data.items?.find((entry) => entry.id === videoId);
  } catch (error) {
    errorFromComments(error);
  }
  if (!item || !item.id) return null;
  const snippet = item.snippet;
  const title = sanitizeText(snippet?.title, 500);
  const publishedAt = isoOrNull(snippet?.publishedAt);
  if (!title || !publishedAt) return null;
  const viewCountRaw = item.statistics?.viewCount;
  const video: ExternalVideo = {
    id: item.id,
    channelId: snippet?.channelId ?? "",
    channelTitle: sanitizeText(snippet?.channelTitle, 300) || "YouTube",
    title,
    description: sanitizeText(snippet?.description, 5000),
    thumbnailUrl: pickThumbnailUrl(snippet?.thumbnails),
    publishedAt,
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    viewCount:
      viewCountRaw && /^\d{1,15}$/.test(viewCountRaw)
        ? Number(viewCountRaw)
        : null,
    source: "youtube",
    isLive: snippet?.liveBroadcastContent !== "none",
    liveBroadcastContent: snippet?.liveBroadcastContent ?? null,
  };
  await ctx.env.DB.batch(
    privateVideoStatements(
      ctx.env.DB,
      account.id,
      video,
      nowIso(),
      isoInDays(METADATA_TTL_DAYS),
      true,
    ),
  );
  if (item.status?.privacyStatus === "public")
    await storeVideos(ctx.env, [item], true);
  return getVideo(ctx.env.DB, account.id, videoId, scope);
}

async function ensureChannelKnown(
  ctx: RouteContext,
  channelId: string,
): Promise<boolean> {
  const existing = await getChannelRow(ctx.env.DB, channelId);
  const expectedSource = videoScope(ctx) === "fixture" ? "fixture" : "youtube";
  if (existing && existing.source === expectedSource && !existing.purged_at)
    return true;
  if (ctx.env.MODE !== "real") return false;

  const account = requireAccount(ctx);
  requireConnectedAccount(account);
  const token = await getValidAccessToken(ctx.env, account.id);
  const data = await youtubeListChannels(token, { id: channelId });
  const item = data.items?.find((entry) => entry.id === channelId);
  if (!item) return false;
  const channel: ExternalChannel = {
    id: channelId,
    title: sanitizeText(item.snippet?.title, 300) || channelId,
    description: sanitizeText(item.snippet?.description, 5000),
    thumbnailUrl: pickThumbnailUrl(item.snippet?.thumbnails) || null,
  };
  await upsertExternalChannel(
    ctx.env.DB,
    channel,
    isoInDays(METADATA_TTL_DAYS),
  );
  return true;
}

async function writeTokenFor(
  ctx: RouteContext,
  account: AccountRow,
): Promise<string> {
  requireConnectedAccount(account);
  requireWriteScope(account);
  return getValidAccessToken(ctx.env, account.id);
}

/* ------------------------------------------------------------------ */
/* Session + settings                                                 */
/* ------------------------------------------------------------------ */

async function handleSession(ctx: RouteContext): Promise<Response> {
  const account = await getSessionAccount(ctx.env, ctx.session);
  return json(buildSessionInfo(ctx.env, ctx.session, account));
}

async function handleGetSettings(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  return json(await getPreferences(ctx.env.DB, account.id));
}

async function handlePatchSettings(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const body = await readJsonObject(ctx.request);
  const current = await getPreferences(ctx.env.DB, account.id);
  let changed = false;

  let theme = current.theme;
  if ("theme" in body) {
    if (body.theme === null) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "theme must be system, light or dark.",
      );
    }
    theme = parseEnum(
      requiredString(body, "theme", { max: 20 }),
      THEMES,
      "theme",
    );
    changed = true;
  }

  if (!changed) {
    throw new HttpError(400, "VALIDATION_ERROR", "Provide theme.");
  }
  return json(await savePreferences(ctx.env.DB, account.id, { theme }));
}

/* ------------------------------------------------------------------ */
/* Feed + videos                                                      */
/* ------------------------------------------------------------------ */

async function handleFeed(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  await ensurePublicExamples(ctx.env, account.id);
  const status = parseEnum(
    ctx.url.searchParams.get("status") ?? "all",
    FEED_STATUSES,
    "status",
  );
  const typesParam = ctx.url.searchParams.get("types");
  const types =
    typesParam === null
      ? undefined
      : typesParam === ""
        ? []
        : [
            ...new Set(
              typesParam
                .split(",")
                .map((value) =>
                  parseEnum(
                    value,
                    ["video", "live", "short"] as const,
                    "types",
                  ),
                ),
            ),
          ];
  const channelId = parseOptionalQuery(ctx.url, "channelId", 64);
  if (channelId) assertId(channelId, "channelId");
  const limit = parseLimit(ctx.url, 30, 100);
  const cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  const options = { status, channelId, cursor, limit, types };
  const scope = videoScope(ctx);
  const cached = await cachedFeed(
    ctx.env,
    account.id,
    JSON.stringify({ scope, ...options }),
    async () => {
      const { items, hasMore } = await listFeed(
        ctx.env.DB,
        account.id,
        options,
        scope,
      );
      const last = items[items.length - 1];
      return {
        items,
        nextCursor:
          hasMore && last
            ? encodeCursor({ publishedAt: last.publishedAt, id: last.id })
            : null,
      };
    },
  );
  return json({ ...cached.value, items: cached.value.items.map((video) => ({
    ...video,
    thumbnailUrl: !video.watched && ctx.env.FEED_IMAGES && /^[A-Za-z0-9_-]{11}$/.test(video.id)
      ? feedThumbnailPath(video.id) : video.thumbnailUrl,
  })) }, 200, { "x-alveo-cache": cached.cache });
}

async function handleVideo(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const videoId = routeParam(ctx, 0, "videoId");
  if (ctx.env.MODE === "demo" && ctx.env.YOUTUBE_API_KEY)
    return json(await getPublicVideo(ctx.env, account.id, videoId));
  let video = await getVideo(ctx.env.DB, account.id, videoId, videoScope(ctx));
  if (!video && ctx.env.MODE === "real" && account.connected) {
    video = ctx.env.YOUTUBE_API_KEY
      ? await getPublicPreview(ctx.env, videoId)
      : await ensureVideoKnown(ctx, videoId, true);
  }
  if (
    video &&
    !video.transient &&
    ctx.env.MODE === "real" &&
    account.connected
  ) {
    const details = await ctx.env.DB.prepare(
      "SELECT details_fetched_at FROM videos WHERE id = ?",
    )
      .bind(videoId)
      .first<{ details_fetched_at: string | null }>();
    if (
      video &&
      (!details?.details_fetched_at ||
        Date.parse(details.details_fetched_at) < Date.now() - 3600000)
    ) {
      try {
        video = (await ensureVideoKnown(ctx, videoId, true)) ?? video;
      } catch {
        /* Existing D1 data remains useful during an external outage. */
      }
    }
  }
  if (!video)
    throw new HttpError(
      404,
      "VIDEO_NOT_FOUND",
      "Video not found or its metadata expired.",
    );
  return json(video);
}

async function handleSetWatchState(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const videoId = routeParam(ctx, 0, "videoId");
  const body = await readJsonObject(ctx.request);
  const watched = requiredBoolean(body, "watched");
  let existing = await getVideo(
    ctx.env.DB,
    account.id,
    videoId,
    videoScope(ctx),
  );
  if (!existing && ctx.env.YOUTUBE_API_KEY)
    existing = await getPublicVideo(ctx.env, account.id, videoId);
  if (!existing) {
    throw new HttpError(
      404,
      "VIDEO_NOT_FOUND",
      "Video not found or its metadata expired.",
    );
  }
  await setManualWatchState(ctx.env.DB, account.id, videoId, watched);
  if (watched) await deleteFeedThumbnail(ctx.env, account.id, videoId);
  const updated = await getVideo(
    ctx.env.DB,
    account.id,
    videoId,
    videoScope(ctx),
    !watched && !!ctx.env.FEED_IMAGES,
  );
  if (!updated)
    throw new HttpError(
      500,
      "INTERNAL",
      "The updated video could not be read back.",
    );
  if (!watched && updated.feedEligible) await warmKnownFeedThumbnail(ctx.env, account.id, videoId);
  delete updated.feedEligible;
  return json(updated);
}

async function handleProgress(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const videoId = routeParam(ctx, 0, "videoId");
  const body = await readJsonObject(ctx.request);
  const video = await getVideo(
    ctx.env.DB,
    account.id,
    videoId,
    videoScope(ctx),
  );
  if (!video) {
    throw new HttpError(
      404,
      "VIDEO_NOT_FOUND",
      "Video not found or its metadata expired.",
    );
  }

  const position = optionalFiniteNumber(body, "positionSeconds", {
    min: 0,
    max: 864000,
  });
  if (position === undefined) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "positionSeconds is required.",
    );
  }

  let incomingDuration: number | null | undefined;
  if (body.durationSeconds === null) {
    incomingDuration = null;
  } else if (body.durationSeconds === undefined) {
    incomingDuration = undefined;
  } else {
    incomingDuration = optionalFiniteNumber(body, "durationSeconds", {
      min: 0,
      max: 864000,
    });
    if (incomingDuration === 0) incomingDuration = null;
  }

  const revision = optionalFiniteNumber(body, "revision", {
    min: 0,
    max: 1_000_000_000,
  });
  if (revision !== undefined && !Number.isInteger(revision)) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "revision must be an integer.",
    );
  }
  const current = await getWatchSnapshot(ctx.env.DB, account.id, videoId);
  if (revision !== undefined && current && revision < current.revision) {
    return json({
      ...(await getVideo(ctx.env.DB, account.id, videoId, videoScope(ctx))),
      applied: false,
      stale: true,
    });
  }

  const effectiveDuration =
    incomingDuration === null
      ? null
      : (incomingDuration ??
        current?.durationSeconds ??
        video.durationSeconds ??
        null);
  const percent =
    effectiveDuration && effectiveDuration > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round((position / effectiveDuration) * 10000) / 100,
          ),
        )
      : (current?.percent ?? 0);
  const now = new Date().toISOString();

  await setProgress(
    ctx.env.DB,
    account.id,
    videoId,
    {
      positionSeconds: Math.round(position * 100) / 100,
      durationSeconds:
        incomingDuration === undefined
          ? (current?.durationSeconds ?? video.durationSeconds ?? null)
          : incomingDuration,
      percent,
    },
    now,
  );
  const updated = await getVideo(
    ctx.env.DB,
    account.id,
    videoId,
    videoScope(ctx),
  );
  if (!updated)
    throw new HttpError(
      500,
      "INTERNAL",
      "The updated video could not be read back.",
    );
  return json({ ...updated, applied: true });
}

async function handleBulkWatch(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const body = await readJsonObject(ctx.request);
  const scope = parseEnum(
    requiredString(body, "scope", { max: 20 }),
    ["all", "channel", "before", "channel_before"] as const,
    "scope",
  );
  let channelId: string | null = null;
  let before: string | null = null;
  if (scope === "channel" || scope === "channel_before") {
    channelId = assertId(
      requiredString(body, "channelId", { max: 64 }),
      "channelId",
    );
  }
  if (scope === "before" || scope === "channel_before") {
    before = parseIsoDate(
      requiredString(body, "before", { max: 40 }),
      "before",
    );
  }
  const watched = optionalBoolean(body, "watched") ?? true;
  const updated = await bulkWatchState(ctx.env.DB, account.id, {
    scope,
    channelId,
    before,
    watched,
  });
  if (watched && updated) await deleteWatchedThumbnails(ctx.env, account.id);
  return json({ updated, scope, watched, mode: ctx.env.MODE });
}

async function handleSuggestions(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const videoId = routeParam(ctx, 0, "videoId");
  if (ctx.env.YOUTUBE_API_KEY)
    return json({
      items: await getPublicSuggestions(ctx.env, account.id, videoId, 6),
      source: "youtube-search",
    });
  const video = await getVideo(
    ctx.env.DB,
    account.id,
    videoId,
    videoScope(ctx),
  );
  if (!video) {
    throw new HttpError(
      404,
      "VIDEO_NOT_FOUND",
      "Video not found or its metadata expired.",
    );
  }
  const limit = parseLimit(ctx.url, 10, 20);
  return json({
    items: await getSuggestions(
      ctx.env.DB,
      account.id,
      videoId,
      limit,
      videoScope(ctx),
    ),
  });
}

/* ------------------------------------------------------------------ */
/* Channels + subscriptions                                           */
/* ------------------------------------------------------------------ */

async function handleChannels(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const query = parseOptionalQuery(ctx.url, "q", 100);
  return json({
    items: await listChannels(
      ctx.env.DB,
      account.id,
      query,
      videoScope(ctx),
      ctx.url.searchParams.get("excluded") === "true",
    ),
  });
}

async function handleSubscriptionStatus(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const channelId = routeParam(ctx, 0, "channelId");
  const subscription = await getSubscription(ctx.env.DB, account.id, channelId);
  return json({ subscribed: Boolean(subscription?.active) });
}

async function handleChannelExclusion(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const channelId = routeParam(ctx, 0, "channelId");
  if (!(await getChannelRow(ctx.env.DB, channelId)))
    throw new HttpError(404, "CHANNEL_NOT_FOUND", "Canal no encontrado.");
  const body = await readJsonObject(ctx.request);
  const excluded = requiredBoolean(body, "excluded");
  await setChannelExcluded(ctx.env.DB, account.id, channelId, excluded);
  await invalidateReads(ctx.env, account.id);
  return json({ channelId, excluded });
}

async function handleChannelVideos(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const channelId = routeParam(ctx, 0, "channelId");
  if (ctx.env.YOUTUBE_API_KEY) {
    const limit = parseLimit(ctx.url, 18, 50);
    const cursor = assertPageToken(ctx.url.searchParams.get("cursor"));
    return json(await listPublicChannelVideos(
      ctx.env, account.id, channelId, cursor || undefined, limit,
    ));
  }
  const channel = await getChannelRow(ctx.env.DB, channelId);
  const expectedSource = videoScope(ctx) === "fixture" ? "fixture" : "youtube";
  if (!channel || channel.purged_at || channel.source !== expectedSource) {
    throw new HttpError(
      404,
      "CHANNEL_NOT_FOUND",
      "Channel not found or its metadata expired.",
    );
  }
  const status = parseEnum(
    ctx.url.searchParams.get("status") ?? "all",
    FEED_STATUSES,
    "status",
  );
  const limit = parseLimit(ctx.url, 30, 100);
  const cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  const { items, hasMore } = await listFeed(
    ctx.env.DB,
    account.id,
    { status, channelId, cursor, limit },
    videoScope(ctx),
  );
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ publishedAt: last.publishedAt, id: last.id })
      : null;
  const subscription = await getSubscription(ctx.env.DB, account.id, channelId);
  return json({
    channel: {
      id: channel.id,
      title: channel.title,
      thumbnailUrl: channel.thumbnail_url ?? "",
      description: channel.description,
      subscribed: Boolean(subscription?.active),
    },
    items,
    nextCursor,
  });
}

async function handleSubscribe(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const body = await readJsonObject(ctx.request);
  const channelId = assertId(
    requiredString(body, "channelId", { max: 64 }),
    "channelId",
  );

  if (ctx.env.MODE === "demo") {
    const channel = await getChannelRow(ctx.env.DB, channelId);
    if (
      !channel ||
      channel.source !== (videoScope(ctx) === "fixture" ? "fixture" : "youtube")
    ) {
      throw new HttpError(404, "CHANNEL_NOT_FOUND", "Unknown demo channel.");
    }
    await subscribeLocal(ctx.env.DB, account.id, channelId);
    return json({
      channelId,
      subscribed: true,
      mode: "demo",
      local: true,
      message: "Local demo subscription; no YouTube call was made.",
    });
  }

  const token = await writeTokenFor(ctx, account);
  if (!(await ensureChannelKnown(ctx, channelId))) {
    throw new HttpError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
  }
  let remote: YouTubeSubscriptionItem;
  try {
    remote = await youtubeInsertSubscription(token, channelId);
  } catch (error) {
    if (!isAmbiguousExternalError(error)) throw error;
    const recovered = await findRemoteSubscription(token, channelId).catch(
      () => null,
    );
    if (!recovered) {
      throw new HttpError(
        502,
        "REMOTE_WRITE_UNCERTAIN",
        "YouTube did not confirm the subscription. The local record was not changed; check YouTube and run a subscriptions sync before retrying.",
      );
    }
    remote = recovered;
  }
  const remoteId = typeof remote.id === "string" ? remote.id : null;
  try {
    await upsertRemoteSubscription(ctx.env.DB, account.id, channelId, remoteId);
  } catch {
    throw new HttpError(
      502,
      "LOCAL_WRITE_FAILED",
      "YouTube accepted the subscription but the local record could not be saved. Run a subscriptions sync to reconcile.",
    );
  }
  return json({ channelId, subscribed: true, mode: "real" });
}

async function handleUnsubscribe(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const channelId = routeParam(ctx, 0, "channelId");

  if (ctx.env.MODE === "demo") {
    await unsubscribeRow(ctx.env.DB, account.id, channelId);
    return json({
      channelId,
      subscribed: false,
      mode: "demo",
      local: true,
      message: "Local demo subscription removed; no YouTube call was made.",
    });
  }

  const token = await writeTokenFor(ctx, account);
  const subscription = await getSubscription(ctx.env.DB, account.id, channelId);
  if (!subscription) {
    throw new HttpError(
      404,
      "SUBSCRIPTION_UNKNOWN",
      "No local subscription record exists for this channel. Run a subscriptions sync first.",
    );
  }
  if (!subscription.remote_subscription_id) {
    throw new HttpError(
      409,
      "SYNC_REQUIRED",
      "The remote subscription id is unknown. Run a subscriptions sync before unsubscribing.",
    );
  }
  try {
    await youtubeDeleteSubscription(token, subscription.remote_subscription_id);
  } catch (error) {
    if (!(error instanceof ExternalError) || !isNotFoundReason(error))
      throw error;
  }
  await unsubscribeRow(ctx.env.DB, account.id, channelId);
  return json({ channelId, subscribed: false, mode: "real" });
}

/* ------------------------------------------------------------------ */
/* Playlists                                                          */
/* ------------------------------------------------------------------ */

async function handleListPlaylists(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  return json({
    items: await listPlaylists(
      ctx.env.DB,
      account.id,
      videoScope(ctx),
      ctx.url.searchParams.get("excluded") === "true",
    ),
  });
}

async function handlePlaylistExclusion(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const playlistId = routeParam(ctx, 0, "playlistId");
  const body = await readJsonObject(ctx.request);
  const excluded = requiredBoolean(body, "excluded");
  if (
    !(await setPlaylistExcluded(ctx.env.DB, account.id, playlistId, excluded))
  )
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "Lista no encontrada.");
  return json({ playlistId, excluded });
}

async function handleCreatePlaylist(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const body = await readJsonObject(ctx.request);
  const title = sanitizeText(requiredString(body, "title", { max: 200 }), 200);
  if (!title) {
    throw new HttpError(400, "VALIDATION_ERROR", "title is required.");
  }
  const description = sanitizeText(
    optionalString(body, "description", { max: 2000 }) ?? "",
    2000,
  );
  const source = parseEnum(
    requiredString(body, "source", { max: 20 }),
    PLAYLIST_SOURCES,
    "source",
  );

  if (ctx.env.MODE === "real" && source !== "youtube") {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "Las listas de una cuenta conectada se guardan en YouTube.",
    );
  }

  if (source === "youtube" && ctx.env.MODE === "demo") {
    throw new HttpError(
      501,
      "DEMO_MODE",
      "Demo mode cannot create YouTube playlists because it performs no external writes.",
    );
  }

  if (source === "youtube") {
    const token = await writeTokenFor(ctx, account);
    let remote: Awaited<ReturnType<typeof youtubeInsertPlaylist>>;
    try {
      remote = await youtubeInsertPlaylist(token, {
        title,
        description,
        privacyStatus: "private",
      });
    } catch (error) {
      if (!isAmbiguousExternalError(error)) throw error;
      throw new HttpError(
        502,
        "REMOTE_WRITE_UNCERTAIN",
        "YouTube did not confirm playlist creation. The local record was not changed; check YouTube and run a playlists sync before retrying.",
      );
    }
    if (typeof remote.id !== "string" || !remote.id) {
      throw new HttpError(
        502,
        "REMOTE_WRITE_UNCERTAIN",
        "YouTube returned no playlist id. The local record was not changed; check YouTube and run a playlists sync before retrying.",
      );
    }
    let id: string;
    try {
      id = await createPlaylist(ctx.env.DB, {
        accountId: account.id,
        title,
        description,
        source: "youtube",
        remoteId: remote.id,
        privacyStatus: remote.status?.privacyStatus ?? "private",
        remoteItemCount: remote.contentDetails?.itemCount ?? 0,
      });
    } catch {
      throw new HttpError(
        502,
        "LOCAL_WRITE_FAILED",
        "YouTube created the playlist but the local record could not be saved. Run a playlists sync to reconcile.",
      );
    }
    return json({ id, source: "youtube" }, 201);
  }

  const id = await createPlaylist(ctx.env.DB, {
    accountId: account.id,
    title,
    description,
    source: "local",
  });
  return json({ id, source: "local" }, 201);
}

async function ownedRemotePlaylist(ctx: RouteContext) {
  const account = requireAccount(ctx);
  const id = routeParam(ctx, 0, "playlistId");
  const row = await ctx.env.DB.prepare(
    "SELECT id,source,excluded FROM playlists WHERE id=? AND account_id=?",
  )
    .bind(id, account.id)
    .first<{ id: string; source: string; excluded: number }>();
  if (!row)
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "Lista no encontrada.");
  if (row.excluded)
    throw new HttpError(
      409,
      "PLAYLIST_EXCLUDED",
      "Vuelve a incluir la lista antes de sincronizarla.",
    );
  if (row.source !== "youtube")
    throw new HttpError(
      400,
      "LOCAL_PLAYLIST",
      "Las listas locales no se sincronizan con YouTube.",
    );
  return { account, id };
}
async function handlePlaylistSync(ctx: RouteContext) {
  const { account, id } = await ownedRemotePlaylist(ctx);
  if (!ctx.env.SYNC_QUEUE)
    throw new HttpError(
      501,
      "QUEUE_REQUIRED",
      "Esta función necesita la cola de sincronización.",
    );
  return json(await startQueuedSync(ctx.env, account, "playlists", true, id));
}
async function handlePlaylistSyncStatus(ctx: RouteContext) {
  const { account, id } = await ownedRemotePlaylist(ctx);
  return json({
    mode: "real",
    runs: [],
    jobs: (await queuedSyncStatus(ctx.env, account.id)).filter(
      (job) => job.playlistId === id,
    ),
  });
}
async function handlePlaylistDetail(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const playlistId = routeParam(ctx, 0, "playlistId");
  const playlist = await getPlaylistDetail(
    ctx.env.DB,
    account.id,
    playlistId,
    videoScope(ctx),
  );
  if (!playlist)
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "Playlist not found.");
  return json(playlist);
}

async function handleUpdatePlaylist(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const playlistId = routeParam(ctx, 0, "playlistId");
  const row = await getPlaylistRow(
    ctx.env.DB,
    account.id,
    playlistId,
    videoScope(ctx),
  );
  if (!row)
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "Playlist not found.");
  const body = await readJsonObject(ctx.request);
  const titleProvided = "title" in body;
  const descriptionProvided = "description" in body;
  if (!titleProvided && !descriptionProvided) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "Provide title or description.",
    );
  }

  const title = titleProvided
    ? sanitizeText(requiredString(body, "title", { max: 200 }), 200)
    : row.title;
  if (titleProvided && !title) {
    throw new HttpError(400, "VALIDATION_ERROR", "title cannot be empty.");
  }
  const description = descriptionProvided
    ? sanitizeText(
        optionalString(body, "description", { max: 2000 }) ?? "",
        2000,
      )
    : row.description;

  if (row.source === "youtube") {
    if (!row.remote_id) {
      throw new HttpError(
        409,
        "SYNC_REQUIRED",
        "This playlist has no remote id; run a playlists sync first.",
      );
    }
    const token = await writeTokenFor(ctx, account);
    await youtubeUpdatePlaylist(token, {
      id: row.remote_id,
      title,
      description,
    });
  }
  try {
    await updatePlaylistRow(ctx.env.DB, playlistId, { title, description });
  } catch {
    throw new HttpError(
      502,
      "LOCAL_WRITE_FAILED",
      "YouTube confirmó el cambio, pero no se pudo guardar en D1. Sincroniza el catálogo para recuperarlo.",
    );
  }
  return json({ id: playlistId, title, description, source: row.source });
}

async function handleDeletePlaylist(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const playlistId = routeParam(ctx, 0, "playlistId");
  const row = await getPlaylistRow(
    ctx.env.DB,
    account.id,
    playlistId,
    videoScope(ctx),
  );
  if (!row)
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "Playlist not found.");

  if (row.source === "youtube") {
    if (!row.remote_id) {
      throw new HttpError(
        409,
        "SYNC_REQUIRED",
        "This playlist has no remote id; run a playlists sync first.",
      );
    }
    const token = await writeTokenFor(ctx, account);
    try {
      await youtubeDeletePlaylist(token, row.remote_id);
    } catch (error) {
      if (!(error instanceof ExternalError) || !isNotFoundReason(error))
        throw error;
    }
  }
  try {
    await deletePlaylistRow(ctx.env.DB, playlistId);
  } catch {
    throw new HttpError(
      502,
      "LOCAL_WRITE_FAILED",
      "YouTube confirmó el borrado, pero no se pudo guardar en D1. Sincroniza el catálogo para recuperarlo.",
    );
  }
  return json({
    deleted: true,
    id: playlistId,
    remote: row.source === "youtube",
  });
}

async function handleAddPlaylistItem(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const playlistId = routeParam(ctx, 0, "playlistId");
  const row = await getPlaylistRow(
    ctx.env.DB,
    account.id,
    playlistId,
    videoScope(ctx),
  );
  if (!row)
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "Playlist not found.");
  const body = await readJsonObject(ctx.request);
  const videoId = assertId(
    requiredString(body, "videoId", { max: 64 }),
    "videoId",
  );
  const video = await ensureVideoKnown(ctx, videoId);
  if (!video) {
    throw new HttpError(
      404,
      "UNKNOWN_VIDEO",
      ctx.env.MODE === "demo"
        ? "Demo mode can only add videos already present in the demo fixtures."
        : "The video is not available through the YouTube API.",
    );
  }

  let position = await nextPlaylistPosition(ctx.env.DB, playlistId);
  let remoteItemId: string | null = null;
  if (row.source === "youtube") {
    if (!row.remote_id) {
      throw new HttpError(
        409,
        "SYNC_REQUIRED",
        "This playlist has no remote id; run a playlists sync first.",
      );
    }
    const token = await writeTokenFor(ctx, account);
    let created: Awaited<ReturnType<typeof youtubeInsertPlaylistItem>>;
    try {
      created = await youtubeInsertPlaylistItem(token, row.remote_id, videoId);
    } catch (error) {
      if (!isAmbiguousExternalError(error)) throw error;
      // Duplicate video entries are valid: finding an older entry cannot
      // establish whether this particular insertion succeeded.
      throw new HttpError(
        502,
        "REMOTE_WRITE_UNCERTAIN",
        "YouTube did not confirm the insertion. The local list was not changed; check YouTube and run a playlists sync before retrying.",
      );
    }
    if (typeof created.id !== "string" || !created.id) {
      throw new HttpError(
        502,
        "EXTERNAL_INVALID_RESPONSE",
        "YouTube did not return a playlist item id.",
      );
    }
    remoteItemId = created.id;
    if (
      typeof created.snippet?.position === "number" &&
      created.snippet.position >= 0
    ) {
      position = Math.floor(created.snippet.position);
    }
  }

  let itemId: string;
  try {
    itemId = await addPlaylistItemRow(
      ctx.env.DB,
      playlistId,
      videoId,
      position,
      remoteItemId,
    );
  } catch {
    throw new HttpError(
      502,
      "LOCAL_WRITE_FAILED",
      "YouTube confirmó el elemento, pero no se pudo guardar en D1. Sincroniza esta lista para recuperarlo.",
    );
  }
  const fresh = await getVideo(
    ctx.env.DB,
    account.id,
    videoId,
    videoScope(ctx),
  );
  if (!fresh)
    throw new HttpError(
      500,
      "INTERNAL",
      "The added video could not be read back.",
    );
  return json({ ...fresh, playlistItemId: itemId }, 201);
}

async function handleDeletePlaylistItem(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const playlistId = routeParam(ctx, 0, "playlistId");
  const itemId = routeParam(ctx, 1, "playlistItemId");
  const item = await getPlaylistItem(
    ctx.env.DB,
    account.id,
    playlistId,
    itemId,
  );
  if (!item)
    throw new HttpError(
      404,
      "PLAYLIST_ITEM_NOT_FOUND",
      "Playlist item not found.",
    );

  if (item.source === "youtube") {
    if (!item.remote_item_id) {
      throw new HttpError(
        409,
        "SYNC_REQUIRED",
        "The remote playlist item id is unknown.",
      );
    }
    const token = await writeTokenFor(ctx, account);
    try {
      await youtubeDeletePlaylistItem(token, item.remote_item_id);
    } catch (error) {
      if (!(error instanceof ExternalError) || !isNotFoundReason(error))
        throw error;
    }
  }
  try {
    await deletePlaylistItemRow(ctx.env.DB, item.id, playlistId);
  } catch {
    throw new HttpError(
      502,
      "LOCAL_WRITE_FAILED",
      "YouTube confirmó la eliminación, pero no se pudo guardar en D1. Sincroniza esta lista para recuperarla.",
    );
  }
  return json({ deleted: true, id: item.id });
}

/* ------------------------------------------------------------------ */
/* Comments                                                           */
/* ------------------------------------------------------------------ */

async function handleComments(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const videoId = routeParam(ctx, 0, "videoId");
  const video = await getVideo(
    ctx.env.DB,
    account.id,
    videoId,
    videoScope(ctx),
  );
  if (!video)
    throw new HttpError(
      404,
      "VIDEO_NOT_FOUND",
      "Video not found or its metadata expired.",
    );

  if (ctx.env.MODE === "demo" && !ctx.env.YOUTUBE_API_KEY) {
    return json({
      items: [],
      nextCursor: null,
      mode: "demo",
      demo: true,
      message:
        "Configura YOUTUBE_API_KEY en el backend local para consultar comentarios públicos reales.",
    });
  }
  const token =
    ctx.env.MODE === "demo" && ctx.env.YOUTUBE_API_KEY
      ? { apiKey: ctx.env.YOUTUBE_API_KEY }
      : (requireConnectedAccount(account),
        await getValidAccessToken(ctx.env, account.id));
  const cursor = assertPageToken(ctx.url.searchParams.get("cursor"));
  try {
    const data = await listCommentThreads(token, videoId, cursor ?? undefined);
    const items = (data.items ?? [])
      .map(mapCommentThread)
      .filter((item): item is CommentItem => item !== null);
    return json({
      items,
      nextCursor:
        typeof data.nextPageToken === "string" ? data.nextPageToken : null,
      mode: "real",
    });
  } catch (error) {
    errorFromComments(error);
  }
}

async function handleCommentReplies(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const commentId = assertCommentId(
    rawRouteParam(ctx, 0, "commentId"),
    "commentId",
  );

  if (ctx.env.MODE === "demo" && !ctx.env.YOUTUBE_API_KEY) {
    return json({
      items: [],
      nextCursor: null,
      mode: "demo",
      demo: true,
      message:
        "Configura YOUTUBE_API_KEY para consultar respuestas públicas reales.",
    });
  }
  const token =
    ctx.env.MODE === "demo" && ctx.env.YOUTUBE_API_KEY
      ? { apiKey: ctx.env.YOUTUBE_API_KEY }
      : (requireConnectedAccount(account),
        await getValidAccessToken(ctx.env, account.id));
  const cursor = assertPageToken(ctx.url.searchParams.get("cursor"));
  try {
    const data = await listCommentReplies(
      token,
      commentId,
      cursor ?? undefined,
    );
    const items = (data.items ?? [])
      .map(mapCommentReply)
      .filter((item): item is CommentItem => item !== null);
    return json({
      items,
      nextCursor:
        typeof data.nextPageToken === "string" ? data.nextPageToken : null,
      mode: "real",
    });
  } catch (error) {
    errorFromComments(error);
  }
}

/* ------------------------------------------------------------------ */
/* Sync                                                               */
/* ------------------------------------------------------------------ */

async function handleSyncStatus(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const limit = parseLimit(ctx.url, 20, 50);
  return json(await getSyncStatus(ctx.env, account, limit));
}

async function handleSyncRequest(ctx: RouteContext): Promise<Response> {
  const account = requireAccount(ctx);
  const body = await readJsonObject(ctx.request);
  const type = requiredString(body, "type", { max: 30 });
  if (!isSyncType(type)) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "type must be all, subscriptions, rss or playlists.",
    );
  }
  if (ctx.env.MODE === "real") {
    requireConnectedAccount(account);
  }
  return json(await handleSync(ctx.env, account, type));
}

/* ------------------------------------------------------------------ */
/* Account                                                            */
/* ------------------------------------------------------------------ */

async function handleDisconnectRequest(ctx: RouteContext): Promise<Response> {
  return handleDisconnect(ctx.env, requireAccount(ctx));
}

async function handleDeleteDataRequest(ctx: RouteContext): Promise<Response> {
  return handleDeleteAccountData(ctx.env, requireAccount(ctx));
}

/* ------------------------------------------------------------------ */
/* Routing                                                            */
/* ------------------------------------------------------------------ */

const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/api\/session$/, handler: handleSession },
  {
    method: "GET",
    pattern: /^\/api\/search$/,
    handler: async (ctx) => {
      requireAccount(ctx);
      const query = (ctx.url.searchParams.get("q") || "").trim().replace(/\s+/g, " ");
      if (query.length < 2 || query.length > 120)
        throw new HttpError(400, "INVALID_QUERY", "Escribe entre 2 y 120 caracteres.");
      const pageToken = assertPageToken(ctx.url.searchParams.get("pageToken"));
      return json(await searchPublicVideos(ctx.env, query, pageToken || undefined));
    },
  },
  { method: "GET", pattern: /^\/api\/feed$/, handler: handleFeed },
  { method: "GET", pattern: /^\/api\/feed\/thumbnails\/([^/]+)$/, handler: async (ctx) => {
    const account = requireAccount(ctx);
    return serveFeedThumbnail(ctx.env, account.id, routeParam(ctx, 0, "videoId"));
  } },
  {
    method: "GET",
    pattern: /^\/api\/feed\/revision$/,
    handler: async (ctx) => {
      const account = requireAccount(ctx);
      return json({ revision: await feedRevision(ctx.env, account.id) });
    },
  },
  { method: "GET", pattern: /^\/api\/videos\/([^/]+)$/, handler: handleVideo },
  {
    method: "PUT",
    pattern: /^\/api\/videos\/([^/]+)\/watch-state$/,
    handler: handleSetWatchState,
  },
  {
    method: "PUT",
    pattern: /^\/api\/videos\/([^/]+)\/progress$/,
    handler: handleProgress,
  },
  {
    method: "GET",
    pattern: /^\/api\/videos\/([^/]+)\/suggestions$/,
    handler: handleSuggestions,
  },
  {
    method: "GET",
    pattern: /^\/api\/videos\/([^/]+)\/comments$/,
    handler: handleComments,
  },
  {
    method: "GET",
    pattern: /^\/api\/comments\/([^/]+)\/replies$/,
    handler: handleCommentReplies,
  },
  {
    method: "POST",
    pattern: /^\/api\/watch-state\/bulk$/,
    handler: handleBulkWatch,
  },
  { method: "GET", pattern: /^\/api\/channels$/, handler: handleChannels },
  {
    method: "GET",
    pattern: /^\/api\/subscriptions\/([^/]+)$/,
    handler: handleSubscriptionStatus,
  },
  {
    method: "PATCH",
    pattern: /^\/api\/channels\/([^/]+)\/exclusion$/,
    handler: handleChannelExclusion,
  },
  {
    method: "GET",
    pattern: /^\/api\/channels\/([^/]+)\/videos$/,
    handler: handleChannelVideos,
  },
  {
    method: "POST",
    pattern: /^\/api\/subscriptions$/,
    handler: handleSubscribe,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/subscriptions\/([^/]+)$/,
    handler: handleUnsubscribe,
  },
  {
    method: "GET",
    pattern: /^\/api\/playlists$/,
    handler: handleListPlaylists,
  },
  {
    method: "PATCH",
    pattern: /^\/api\/playlists\/([^/]+)\/exclusion$/,
    handler: handlePlaylistExclusion,
  },
  {
    method: "POST",
    pattern: /^\/api\/playlists$/,
    handler: handleCreatePlaylist,
  },
  {
    method: "POST",
    pattern: /^\/api\/playlists\/([^/]+)\/sync$/,
    handler: handlePlaylistSync,
  },
  {
    method: "GET",
    pattern: /^\/api\/playlists\/([^/]+)\/sync$/,
    handler: handlePlaylistSyncStatus,
  },
  {
    method: "GET",
    pattern: /^\/api\/playlists\/([^/]+)$/,
    handler: handlePlaylistDetail,
  },
  {
    method: "PATCH",
    pattern: /^\/api\/playlists\/([^/]+)$/,
    handler: handleUpdatePlaylist,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/playlists\/([^/]+)$/,
    handler: handleDeletePlaylist,
  },
  {
    method: "POST",
    pattern: /^\/api\/playlists\/([^/]+)\/items$/,
    handler: handleAddPlaylistItem,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/playlists\/([^/]+)\/items\/([^/]+)$/,
    handler: handleDeletePlaylistItem,
  },
  { method: "GET", pattern: /^\/api\/settings$/, handler: handleGetSettings },
  {
    method: "PATCH",
    pattern: /^\/api\/settings$/,
    handler: handlePatchSettings,
  },
  {
    method: "GET",
    pattern: /^\/api\/sync\/status$/,
    handler: handleSyncStatus,
  },
  { method: "POST", pattern: /^\/api\/sync$/, handler: handleSyncRequest },
  {
    method: "POST",
    pattern: /^\/api\/account\/disconnect$/,
    handler: handleDisconnectRequest,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/account\/data$/,
    handler: handleDeleteDataRequest,
  },
];

function withSessionCookie(
  response: Response,
  context: SessionContext,
): Response {
  if (!context.setCookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", context.setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function dispatchApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const method = request.method.toUpperCase();
  let pathMatched = false;
  const allowed = new Set<string>();
  let matched: Route | null = null;
  let params: string[] = [];

  for (const route of ROUTES) {
    const match = url.pathname.match(route.pattern);
    if (!match) continue;
    pathMatched = true;
    allowed.add(route.method);
    if (route.method === method) {
      matched = route;
      params = match.slice(1);
      break;
    }
  }

  if (!matched) {
    if (pathMatched) {
      return json(
        { code: "METHOD_NOT_ALLOWED", error: "Method not allowed." },
        405,
        { allow: [...allowed].join(", ") },
      );
    }
    return json({ code: "NOT_FOUND", error: "API route not found." }, 404);
  }

  const createSession = url.pathname === "/api/session" || env.MODE === "demo";
  const context = await resolveSession(env, request, { create: createSession });
  if (!context) {
    throw new HttpError(
      401,
      "AUTH_REQUIRED",
      "A browser session is required. Load /api/session first.",
    );
  }

  const isMutation = method !== "GET" && method !== "HEAD";
  if (isMutation) {
    requireMutationOrigin(request, env.APP_ORIGIN);
    requireCsrf(request, context.session.csrf_token);
  }

  const account = await getSessionAccount(env, context.session);
  const metadataRead =
    method === "GET" &&
    !url.pathname.startsWith("/api/feed/thumbnails/") &&
    !url.pathname.endsWith("/sync") &&
    ![
      "/api/session",
      "/api/settings",
      "/api/sync/status",
      "/api/feed/revision",
    ].includes(url.pathname);
  if (metadataRead && (env.MODE === "real" || env.YOUTUBE_API_KEY)) {
    // Retention cannot depend on a cron invocation: purge before serving or
    // mutating data so expired metadata is never acted on.
    await purgeExpiredMetadata(env.DB);
  }
  const response = await matched.handler({
    env,
    request,
    url,
    session: context.session,
    account,
    params,
  });
  if (
    isMutation &&
    response.ok &&
    account &&
    !url.pathname.endsWith("/progress")
  )
    await invalidateReads(env, account.id);
  return withSessionCookie(response, context);
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (env.SYNC_MAINTENANCE === "true")
    return json(
      {
        code: "MAINTENANCE",
        error: "Actualizando la sincronización. Reintenta en un minuto.",
      },
      503,
      { "retry-after": "60" },
    );
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // Public hub boundary: signature/token verification replaces browser CSRF.
  if (path === WEBSUB_CALLBACK_PATH) return handleWebSub(request, env);

  if (path === "/auth/google/start") {
    if (method !== "GET") {
      return json(
        { code: "METHOD_NOT_ALLOWED", error: "Method not allowed." },
        405,
        { allow: "GET" },
      );
    }
    return handleOAuthStart(env, request);
  }
  if (path === "/auth/google/callback") {
    if (method !== "GET") {
      return json(
        { code: "METHOD_NOT_ALLOWED", error: "Method not allowed." },
        405,
        { allow: "GET" },
      );
    }
    return handleOAuthCallback(env, request);
  }
  if (path === "/auth/logout") {
    if (method !== "POST") {
      return json(
        { code: "METHOD_NOT_ALLOWED", error: "Method not allowed." },
        405,
        { allow: "POST" },
      );
    }
    requireMutationOrigin(request, env.APP_ORIGIN);
    const context = await resolveSession(env, request, { create: false });
    if (context) requireCsrf(request, context.session.csrf_token);
    return handleLogout(env, context);
  }
  if (
    path === "/api" ||
    path.startsWith("/api/") ||
    path.startsWith("/auth/")
  ) {
    if (method !== "GET" && method !== "HEAD") {
      requireMutationOrigin(request, env.APP_ORIGIN);
    }
    if (path.startsWith("/api")) {
      return dispatchApi(request, env, url);
    }
    return json({ code: "NOT_FOUND", error: "Route not found." }, 404);
  }

  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }
  return json({ code: "NOT_FOUND", error: "Not found." }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },
  async queue(batch: MessageBatch<SyncMessage>, env: Env): Promise<void> {
    if (env.SYNC_MAINTENANCE === "true") {
      batch.retryAll({ delaySeconds: 60 });
      return;
    }
    await consumeSyncQueue(batch, env);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (env.SYNC_MAINTENANCE === "true") return;
    // Wrangler local testing accepts a job name in ?cron=rss|playlists.
    // Normal Cron Trigger expressions continue to run the complete pipeline.
    const type = isSyncType(_controller.cron) ? _controller.cron : "all";
    ctx.waitUntil(
      runScheduledSync(env, type).catch(() => {
        // Never log callback payloads, signatures, tokens or external URLs.
        console.error(
          "Scheduled synchronization failed; durable claims will retry.",
        );
      }),
    );
  },
} satisfies ExportedHandler<Env, SyncMessage>;
