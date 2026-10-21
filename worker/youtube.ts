/**
 * Google OAuth and YouTube Data API v3 client (backend only).
 *
 * Tokens never leave this module's callers in plaintext: the caller supplies a
 * short-lived access token obtained from the encrypted token store. Error
 * messages are reduced to a sanitized reason code; response bodies, codes and
 * tokens are never logged or returned to the browser.
 */
import type { Env } from "./types";
import {
  ExternalError,
  HttpError,
  absoluteUrl,
  fetchWithTimeout,
  readLimitedText,
} from "./http";

export const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

export const SCOPE_READONLY =
  "https://www.googleapis.com/auth/youtube.readonly";
export const SCOPE_WRITE = "https://www.googleapis.com/auth/youtube.force-ssl";

const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;

export interface OAuthSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function oauthConfigured(env: Env): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.TOKEN_ENCRYPTION_KEY &&
    env.APP_ORIGIN,
  );
}

export function getOAuthSettings(env: Env): OAuthSettings {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(
      501,
      "OAUTH_NOT_CONFIGURED",
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET locally.",
    );
  }
  const origin = new URL(env.APP_ORIGIN);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new HttpError(
      500,
      "CONFIG_ERROR",
      "APP_ORIGIN must be an http(s) origin.",
    );
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: absoluteUrl(origin.origin, "/auth/google/callback"),
  };
}

export function scopesFor(scope: "readonly" | "write"): string {
  return scope === "write"
    ? `${SCOPE_READONLY} ${SCOPE_WRITE}`
    : SCOPE_READONLY;
}

export function hasWriteScope(scopes: string): boolean {
  return scopes.split(/\s+/).includes(SCOPE_WRITE);
}

export interface AuthUrlInput {
  state: string;
  codeChallenge: string;
  scope: "readonly" | "write";
}

export function buildAuthUrl(env: Env, input: AuthUrlInput): string {
  const settings = getOAuthSettings(env);
  const url = new URL(OAUTH_AUTH_URL);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", settings.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopesFor(input.scope));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string | undefined;
  expires_in?: number | undefined;
  scope?: string | undefined;
  token_type?: string | undefined;
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await readLimitedText(response, MAX_RESPONSE_CHARS);
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new ExternalError("response_too_large");
  }
  if (!text.trim()) {
    if (response.ok) return {};
    throw new ExternalError(`http_${response.status}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new ExternalError("invalid_response");
}

function tokenFrom(data: Record<string, unknown>): GoogleTokenResponse {
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new ExternalError("missing_access_token");
  }
  return {
    access_token: data.access_token,
    refresh_token:
      typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expires_in:
      typeof data.expires_in === "number" ? data.expires_in : undefined,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    token_type:
      typeof data.token_type === "string" ? data.token_type : undefined,
  };
}

function oauthErrorReason(
  data: Record<string, unknown>,
  status: number,
): string {
  return typeof data.error === "string" ? data.error : `http_${status}`;
}

export async function exchangeCode(
  env: Env,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<GoogleTokenResponse> {
  const settings = getOAuthSettings(env);
  const body = new URLSearchParams({
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  const response = await fetchWithTimeout(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  const data = await readJsonObject(response);
  if (!response.ok) {
    throw new ExternalError(
      oauthErrorReason(data, response.status),
      "Google authorization failed.",
    );
  }
  return tokenFrom(data);
}

export async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<GoogleTokenResponse> {
  const settings = getOAuthSettings(env);
  const body = new URLSearchParams({
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetchWithTimeout(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  const data = await readJsonObject(response);
  if (!response.ok) {
    throw new ExternalError(
      oauthErrorReason(data, response.status),
      "Google token refresh failed.",
    );
  }
  return tokenFrom(data);
}

/** Best-effort revocation; local cleanup must not depend on Google being reachable. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(OAUTH_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* YouTube Data API                                                   */
/* ------------------------------------------------------------------ */

type QueryValue = string | number | undefined;
export type ReadCredential = string | { apiKey: string };

async function requestJson(
  accessToken: ReadCredential,
  method: "GET" | "POST" | "PUT" | "DELETE",
  endpoint: string,
  params: Record<string, QueryValue>,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${YOUTUBE_API}/${endpoint.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  if (typeof accessToken !== "string" && method !== "GET") {
    throw new HttpError(
      403,
      "READ_ONLY_CREDENTIAL",
      "An API key cannot authorize YouTube writes.",
    );
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (typeof accessToken === "string")
    headers.authorization = `Bearer ${accessToken}`;
  else headers["x-goog-api-key"] = accessToken.apiKey;
  if (body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetchWithTimeout(url.toString(), init);
  const data = await readJsonObject(response);
  if (!response.ok) {
    const error =
      typeof data.error === "object" && data.error !== null
        ? (data.error as Record<string, unknown>)
        : {};
    const errors = Array.isArray(error.errors) ? error.errors : [];
    const first =
      typeof errors[0] === "object" && errors[0] !== null
        ? (errors[0] as Record<string, unknown>)
        : {};
    const reason =
      typeof first.reason === "string"
        ? first.reason
        : `http_${response.status}`;
    throw new ExternalError(reason, "YouTube API request failed.");
  }
  return data;
}

export interface YouTubeSearchList {
  items?: Array<{ id?: { videoId?: string } }>;
}

/** Public search, never personalized recommendations or arbitrary URLs. */
export async function searchVideos(
  credential: ReadCredential,
  query: string,
): Promise<YouTubeSearchList> {
  return (await requestJson(credential, "GET", "search", {
    part: "snippet",
    type: "video",
    q: query,
    maxResults: 8,
    order: "relevance",
    videoEmbeddable: "true",
    videoSyndicated: "true",
    fields: "items(id/videoId)",
  })) as unknown as YouTubeSearchList;
}

export interface YouTubeThumbnail {
  url?: string;
  width?: number;
  height?: number;
}

export interface YouTubeThumbnails {
  default?: YouTubeThumbnail;
  medium?: YouTubeThumbnail;
  high?: YouTubeThumbnail;
  standard?: YouTubeThumbnail;
  maxres?: YouTubeThumbnail;
}

export interface YouTubeSnippet {
  tags?: string[];
  title?: string;
  description?: string;
  publishedAt?: string;
  channelId?: string;
  channelTitle?: string;
  resourceId?: { kind?: string; channelId?: string; videoId?: string };
  thumbnails?: YouTubeThumbnails;
  position?: number;
  videoOwnerChannelId?: string;
  videoOwnerChannelTitle?: string;
  liveBroadcastContent?: "none" | "live" | "upcoming";
}

export interface YouTubeSubscriptionItem {
  id?: string;
  snippet?: YouTubeSnippet;
}

export interface YouTubeSubscriptionList {
  items?: YouTubeSubscriptionItem[];
  nextPageToken?: string;
}

export async function listSubscriptions(
  accessToken: string,
  pageToken?: string,
  maxResults = 50,
): Promise<YouTubeSubscriptionList> {
  return (await requestJson(accessToken, "GET", "subscriptions", {
    part: "snippet",
    mine: "true",
    maxResults,
    pageToken,
  })) as unknown as YouTubeSubscriptionList;
}

export async function insertSubscription(
  accessToken: string,
  channelId: string,
): Promise<YouTubeSubscriptionItem> {
  return (await requestJson(
    accessToken,
    "POST",
    "subscriptions",
    { part: "snippet" },
    { snippet: { resourceId: { kind: "youtube#channel", channelId } } },
  )) as unknown as YouTubeSubscriptionItem;
}

export async function deleteSubscription(
  accessToken: string,
  remoteSubscriptionId: string,
): Promise<void> {
  await requestJson(accessToken, "DELETE", "subscriptions", {
    id: remoteSubscriptionId,
  });
}

export interface YouTubeChannelItem {
  id?: string;
  snippet?: YouTubeSnippet;
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

export interface YouTubeChannelList {
  items?: YouTubeChannelItem[];
}

export async function listChannels(
  accessToken: ReadCredential,
  options: { mine?: boolean; id?: string; includeUploads?: boolean },
): Promise<YouTubeChannelList> {
  return (await requestJson(accessToken, "GET", "channels", {
    part: options.includeUploads ? "snippet,contentDetails" : "snippet",
    mine: options.mine ? "true" : undefined,
    id: options.id,
  })) as unknown as YouTubeChannelList;
}

export interface YouTubePlaylistItem {
  id?: string;
  snippet?: YouTubeSnippet;
  contentDetails?: { itemCount?: number; videoPublishedAt?: string };
  status?: { privacyStatus?: string };
}

export interface YouTubePlaylistList {
  items?: YouTubePlaylistItem[];
  nextPageToken?: string;
}

export async function listPlaylists(
  accessToken: string,
  pageToken?: string,
  maxResults = 50,
): Promise<YouTubePlaylistList> {
  return (await requestJson(accessToken, "GET", "playlists", {
    part: "snippet,contentDetails,status",
    mine: "true",
    maxResults,
    pageToken,
  })) as unknown as YouTubePlaylistList;
}

export async function getRemotePlaylist(
  accessToken: string,
  id: string,
): Promise<YouTubePlaylistList> {
  return (await requestJson(accessToken, "GET", "playlists", {
    part: "snippet,contentDetails,status",
    id,
  })) as unknown as YouTubePlaylistList;
}

export async function insertPlaylist(
  accessToken: string,
  input: {
    title: string;
    description: string;
    privacyStatus: "private" | "unlisted" | "public";
  },
): Promise<YouTubePlaylistItem> {
  return (await requestJson(
    accessToken,
    "POST",
    "playlists",
    { part: "snippet,status" },
    {
      snippet: { title: input.title, description: input.description },
      status: { privacyStatus: input.privacyStatus },
    },
  )) as unknown as YouTubePlaylistItem;
}

export async function updatePlaylist(
  accessToken: string,
  input: { id: string; title: string; description: string },
): Promise<YouTubePlaylistItem> {
  // Updating a part replaces its mutable fields. Preserve defaultLanguage,
  // and do not include status: an edit must not change playlist privacy.
  const current = await requestJson(accessToken, "GET", "playlists", {
    id: input.id,
    part: "snippet",
  });
  const entry = Array.isArray(current.items)
    ? (current.items.find(
        (item: YouTubePlaylistItem) => item.id === input.id,
      ) as YouTubePlaylistItem | undefined)
    : undefined;
  if (!entry?.snippet) throw new ExternalError("playlist_not_found");
  const language = (
    entry.snippet as YouTubeSnippet & { defaultLanguage?: string }
  ).defaultLanguage;
  return (await requestJson(
    accessToken,
    "PUT",
    "playlists",
    { part: "snippet" },
    {
      id: input.id,
      snippet: {
        title: input.title,
        description: input.description,
        ...(language ? { defaultLanguage: language } : {}),
      },
    },
  )) as unknown as YouTubePlaylistItem;
}

export async function deletePlaylist(
  accessToken: string,
  remotePlaylistId: string,
): Promise<void> {
  await requestJson(accessToken, "DELETE", "playlists", {
    id: remotePlaylistId,
  });
}

export interface YouTubePlaylistItemEntry {
  id?: string;
  snippet?: YouTubeSnippet;
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}

export interface YouTubePlaylistItemList {
  items?: YouTubePlaylistItemEntry[];
  nextPageToken?: string;
}

export async function listPlaylistItems(
  accessToken: ReadCredential,
  playlistId: string,
  pageToken?: string,
  maxResults = 50,
): Promise<YouTubePlaylistItemList> {
  return (await requestJson(accessToken, "GET", "playlistItems", {
    part: "snippet,contentDetails",
    playlistId,
    maxResults,
    pageToken,
  })) as unknown as YouTubePlaylistItemList;
}

export async function insertPlaylistItem(
  accessToken: string,
  playlistId: string,
  videoId: string,
): Promise<YouTubePlaylistItemEntry> {
  return (await requestJson(
    accessToken,
    "POST",
    "playlistItems",
    { part: "snippet" },
    { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
  )) as unknown as YouTubePlaylistItemEntry;
}

export async function deletePlaylistItem(
  accessToken: string,
  remoteItemId: string,
): Promise<void> {
  await requestJson(accessToken, "DELETE", "playlistItems", {
    id: remoteItemId,
  });
}

export interface YouTubeVideoItem {
  id?: string;
  status?: { privacyStatus?: string; embeddable?: boolean };
  snippet?: YouTubeSnippet;
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
}

export interface YouTubeVideoList {
  items?: YouTubeVideoItem[];
}

export async function listVideos(
  accessToken: ReadCredential,
  ids: string[],
): Promise<YouTubeVideoList> {
  return (await requestJson(accessToken, "GET", "videos", {
    part: "snippet,contentDetails,statistics,status",
    id: ids.join(","),
  })) as unknown as YouTubeVideoList;
}

export interface YouTubeCommentSnippet {
  authorDisplayName?: string;
  authorProfileImageUrl?: string;
  publishedAt?: string;
  textOriginal?: string;
  textDisplay?: string;
  likeCount?: number;
}

export interface YouTubeCommentThreadItem {
  id?: string;
  snippet?: {
    topLevelComment?: { id?: string; snippet?: YouTubeCommentSnippet };
    totalReplyCount?: number;
  };
}

export interface YouTubeCommentThreadList {
  items?: YouTubeCommentThreadItem[];
  nextPageToken?: string;
}

export async function listCommentThreads(
  accessToken: ReadCredential,
  videoId: string,
  pageToken?: string,
): Promise<YouTubeCommentThreadList> {
  return (await requestJson(accessToken, "GET", "commentThreads", {
    part: "snippet",
    order: "relevance",
    videoId,
    maxResults: 20,
    textFormat: "plainText",
    pageToken,
  })) as unknown as YouTubeCommentThreadList;
}

export interface YouTubeCommentItem {
  id?: string;
  snippet?: YouTubeCommentSnippet;
}

export interface YouTubeCommentList {
  items?: YouTubeCommentItem[];
  nextPageToken?: string;
}

export async function listCommentReplies(
  accessToken: ReadCredential,
  parentId: string,
  pageToken?: string,
): Promise<YouTubeCommentList> {
  return (await requestJson(accessToken, "GET", "comments", {
    part: "snippet",
    parentId,
    maxResults: 20,
    textFormat: "plainText",
    pageToken,
  })) as unknown as YouTubeCommentList;
}

export function pickThumbnailUrl(
  thumbnails: YouTubeThumbnails | undefined,
): string {
  if (!thumbnails) return "";
  const candidates = [
    thumbnails.maxres?.url,
    thumbnails.standard?.url,
    thumbnails.high?.url,
    thumbnails.medium?.url,
    thumbnails.default?.url,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      if (
        url.protocol === "https:" &&
        (host.endsWith(".ytimg.com") ||
          host.endsWith(".ggpht.com") ||
          host.endsWith(".googleusercontent.com") ||
          host === "youtube.com" ||
          host === "www.youtube.com")
      ) {
        return url.toString();
      }
    } catch {
      // ignore malformed thumbnail URLs
    }
  }
  return "";
}

/** Parses ISO-8601 durations like PT1H2M3S (as returned by videos.list). */
export function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value,
  );
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
