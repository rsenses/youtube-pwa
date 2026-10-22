/**
 * Sessions, CSRF material, Google OAuth flow, encrypted token storage and
 * account deletion. Secrets never reach JSON responses or logs.
 */
import { isWebSubEnabled } from "./websub";
import type { AccountRow, Env, SessionInfo, SessionRow } from "./types";
import {
  ExternalError,
  HttpError,
  SESSION_COOKIE,
  absoluteUrl,
  base64UrlToBytes,
  bytesToBase64Url,
  clearCookie,
  constantTimeEqual,
  json,
  nowIso,
  randomToken,
  readCookie,
  sanitizeText,
  serializeCookie,
  sha256Bytes,
  sha256Hex,
} from "./http";
import {
  cleanupExpiredAuthRows,
  deleteSession,
  ensureDemoAccount,
  ensurePreferences,
  getAccount,
  getSessionByHash,
  insertSession,
  linkSessionAccount,
} from "./db";
import {
  buildAuthUrl,
  exchangeCode,
  getOAuthSettings,
  hasWriteScope,
  listChannels as youtubeListChannels,
  oauthConfigured,
  refreshAccessToken,
  revokeToken,
  type GoogleTokenResponse,
} from "./youtube";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const TOKEN_KEY_VERSION = "v1";

export interface SessionContext {
  session: SessionRow;
  tokenHash: string;
  setCookie?: string;
}

export function isSecureOrigin(origin: string): boolean {
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

export async function resolveSession(
  env: Env,
  request: Request,
  options: { create: boolean },
): Promise<SessionContext | null> {
  const secure = isSecureOrigin(env.APP_ORIGIN);
  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE);

  if (cookie && /^[A-Za-z0-9_-]{20,128}$/.test(cookie)) {
    const hash = await sha256Hex(cookie);
    const session = await getSessionByHash(env.DB, hash);
    if (session && Date.parse(session.expires_at) > Date.now()) {
      if (await sessionMatchesMode(env, session)) {
        return { session, tokenHash: hash };
      }
    }
    if (session) await deleteSession(env.DB, hash);
  }

  if (!options.create) return null;
  if (env.MODE === "demo") {
    await ensureDemoAccount(env.DB);
  }
  const created = await insertSession(
    env.DB,
    env.MODE === "demo" ? "demo" : null,
  );
  await cleanupExpiredAuthRows(env.DB);
  return {
    session: created.session,
    tokenHash: created.session.id,
    setCookie: serializeCookie(SESSION_COOKIE, created.token, {
      maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
      secure,
    }),
  };
}

async function sessionMatchesMode(
  env: Env,
  session: SessionRow,
): Promise<boolean> {
  if (!session.account_id) return true;
  const account = await getAccount(env.DB, session.account_id);
  return Boolean(account && account.mode === env.MODE);
}

export async function getSessionAccount(
  env: Env,
  session: SessionRow,
): Promise<AccountRow | null> {
  if (!session.account_id) return null;
  const account = await getAccount(env.DB, session.account_id);
  if (!account || account.mode !== env.MODE) return null;
  return account;
}

export function buildSessionInfo(
  env: Env,
  session: SessionRow,
  account: AccountRow | null,
): SessionInfo {
  const connected =
    env.MODE === "real" && Boolean(account && account.connected === 1);
  const scopes = account?.scopes ?? "";
  const info: SessionInfo = {
    mode: env.MODE,
    connected,
    csrfToken: session.csrf_token,
    capabilities: {
      externalSync: connected,
      oauth: env.MODE === "real",
      youtubeWrites: connected && hasWriteScope(scopes),
      rss: connected,
      comments: connected || Boolean(env.YOUTUBE_API_KEY),
      publicData: Boolean(env.YOUTUBE_API_KEY),
      localPlaylists: true,
      automaticDiscovery: isWebSubEnabled(env),
    },
  };
  if (account) {
    info.account = {
      name:
        account.name ||
        (env.MODE === "demo" ? "Demo local" : "YouTube account"),
    };
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* Token encryption (AES-GCM, random IV, key version prefix)          */
/* ------------------------------------------------------------------ */

function requireTokenSecret(env: Env): string {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new HttpError(
      501,
      "OAUTH_NOT_CONFIGURED",
      "TOKEN_ENCRYPTION_KEY is not configured; encrypted token storage is unavailable.",
    );
  }
  return env.TOKEN_ENCRYPTION_KEY;
}

async function importTokenKey(secret: string): Promise<CryptoKey> {
  const trimmed = secret.trim();
  let raw: Uint8Array | null = null;
  if (/^[A-Za-z0-9+/=_-]{43,44}$/.test(trimmed)) {
    try {
      const decoded = base64UrlToBytes(trimmed);
      if (decoded.length === 32) raw = decoded;
    } catch {
      raw = null;
    }
  }
  if (!raw) raw = await sha256Bytes(secret);
  return crypto.subtle.importKey(
    "raw",
    raw.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptToken(
  secret: string,
  plaintext: string,
): Promise<string> {
  const key = await importTokenKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return `${TOKEN_KEY_VERSION}.${bytesToBase64Url(combined)}`;
}

export async function decryptToken(
  secret: string,
  payload: string,
): Promise<string> {
  const [version, encoded] = payload.split(".", 2);
  if (version !== TOKEN_KEY_VERSION || !encoded) {
    throw new HttpError(
      500,
      "TOKEN_DECRYPT_FAILED",
      "Stored credentials could not be decrypted.",
    );
  }
  try {
    const combined = base64UrlToBytes(encoded);
    if (combined.length < 13) throw new Error("short payload");
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await importTokenKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new HttpError(
      500,
      "TOKEN_DECRYPT_FAILED",
      "Stored credentials could not be decrypted.",
    );
  }
}

interface TokenRow {
  account_id: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  scopes: string;
  expires_at: string | null;
}

async function saveTokens(
  env: Env,
  accountId: string,
  token: GoogleTokenResponse,
): Promise<void> {
  const secret = requireTokenSecret(env);
  const existing = await env.DB.prepare(
    "SELECT access_token_enc, refresh_token_enc, scopes, expires_at FROM oauth_tokens WHERE account_id = ?",
  )
    .bind(accountId)
    .first<TokenRow>();
  const accessEnc = await encryptToken(secret, token.access_token);
  const refreshEnc = token.refresh_token
    ? await encryptToken(secret, token.refresh_token)
    : (existing?.refresh_token_enc ?? null);
  const scopes = token.scope ?? existing?.scopes ?? "";
  const expiresIn =
    token.expires_in && token.expires_in > 0 ? token.expires_in : 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO oauth_tokens
         (account_id, access_token_enc, refresh_token_enc, token_type, scopes, expires_at, key_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = COALESCE(excluded.refresh_token_enc, oauth_tokens.refresh_token_enc),
         token_type = excluded.token_type,
         scopes = excluded.scopes,
         expires_at = excluded.expires_at,
         key_version = excluded.key_version,
         updated_at = excluded.updated_at`,
    ).bind(
      accountId,
      accessEnc,
      refreshEnc,
      token.token_type ?? "Bearer",
      scopes,
      expiresAt,
      TOKEN_KEY_VERSION,
      now,
    ),
    env.DB.prepare(
      `UPDATE accounts SET connected = 1, scopes = ?, token_expires_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(scopes, expiresAt, now, accountId),
  ]);
}

function reconnectError(): HttpError {
  return new HttpError(
    401,
    "RECONNECT_REQUIRED",
    "Google authorization expired. Reconnect the account to continue.",
    { authUrl: "/auth/google/start" },
  );
}

export async function markAccountDisconnected(
  env: Env,
  accountId: string,
): Promise<void> {
  // The refresh token is unusable after invalid_grant; delete it immediately.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_tokens WHERE account_id = ?").bind(
      accountId,
    ),
    env.DB.prepare(
      `UPDATE accounts SET connected = 0, scopes = '', token_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), accountId),
  ]);
}

export async function getValidAccessToken(
  env: Env,
  accountId: string,
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT account_id, access_token_enc, refresh_token_enc, scopes, expires_at FROM oauth_tokens WHERE account_id = ?",
  )
    .bind(accountId)
    .first<TokenRow>();
  if (!row) {
    throw new HttpError(
      409,
      "CONNECT_REQUIRED",
      "Connect a Google account before using YouTube integrations.",
    );
  }
  const secret = requireTokenSecret(env);
  const accessToken = await decryptToken(secret, row.access_token_enc);
  const expiresAt = row.expires_at
    ? Date.parse(row.expires_at)
    : Number.POSITIVE_INFINITY;
  if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000)
    return accessToken;
  if (!row.refresh_token_enc) throw reconnectError();

  const refreshToken = await decryptToken(secret, row.refresh_token_enc);
  try {
    const refreshed = await refreshAccessToken(env, refreshToken);
    await saveTokens(env, accountId, refreshed);
    return refreshed.access_token;
  } catch (error) {
    if (error instanceof ExternalError && error.reason === "invalid_grant") {
      // Revocation/expiry requires prompt deletion of the corresponding data,
      // not just a flag. Reuse the disconnect cleanup (best effort).
      try {
        const account = await getAccount(env.DB, accountId);
        if (account) {
          await handleDisconnect(env, account);
        } else {
          await markAccountDisconnected(env, accountId);
        }
      } catch {
        await markAccountDisconnected(env, accountId);
      }
      throw reconnectError();
    }
    throw error;
  }
}

export function requireConnectedAccount(account: AccountRow): void {
  if (account.mode !== "real" || account.connected !== 1) {
    throw new HttpError(
      401,
      "CONNECT_REQUIRED",
      "Connect a Google account before using YouTube integrations.",
    );
  }
}

export function requireWriteScope(account: AccountRow): void {
  if (!hasWriteScope(account.scopes)) {
    throw new HttpError(
      403,
      "SCOPE_REQUIRED",
      "This action writes to YouTube and requires additional authorization.",
      { authUrl: "/auth/google/start?scope=write" },
    );
  }
}

/* ------------------------------------------------------------------ */
/* OAuth start / callback                                             */
/* ------------------------------------------------------------------ */

function redirectResponse(
  env: Env,
  path: string,
  setCookie?: string,
): Response {
  const headers: Record<string, string> = {
    location: absoluteUrl(new URL(env.APP_ORIGIN).origin, path),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
  if (setCookie) headers["set-cookie"] = setCookie;
  return new Response(null, { status: 302, headers });
}

function redirectError(env: Env, reason: string, setCookie?: string): Response {
  return redirectResponse(
    env,
    `/settings?connect=error&reason=${encodeURIComponent(reason)}`,
    setCookie,
  );
}

export async function handleOAuthStart(
  env: Env,
  request: Request,
): Promise<Response> {
  if (env.MODE !== "real") {
    throw new HttpError(
      501,
      "DEMO_MODE",
      "Demo mode does not perform Google OAuth or external calls.",
    );
  }
  if (!oauthConfigured(env)) {
    throw new HttpError(
      501,
      "OAUTH_NOT_CONFIGURED",
      "Google OAuth is not configured locally. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY.",
    );
  }
  const settings = getOAuthSettings(env);
  const url = new URL(request.url);
  const requestedScope = url.searchParams.get("scope");
  if (
    requestedScope !== null &&
    requestedScope !== "readonly" &&
    requestedScope !== "write"
  ) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      'scope must be "readonly" or "write".',
    );
  }
  const scope = requestedScope === "write" ? "write" : "readonly";

  const context = await resolveSession(env, request, { create: true });
  if (!context)
    throw new HttpError(
      500,
      "SESSION_ERROR",
      "Could not create a browser session.",
    );

  const state = randomToken(32);
  const verifier = randomToken(32);
  const challenge = bytesToBase64Url(await sha256Bytes(verifier));
  const stateHash = await sha256Hex(state);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + ATTEMPT_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO oauth_attempts
       (state_hash, session_id, code_verifier, redirect_uri, scope, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      stateHash,
      context.session.id,
      verifier,
      settings.redirectUri,
      scope,
      now,
      expiresAt,
    )
    .run();

  const location = buildAuthUrl(env, {
    state,
    codeChallenge: challenge,
    scope,
  });
  const headers: Record<string, string> = {
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
  if (context.setCookie) headers["set-cookie"] = context.setCookie;
  return new Response(null, { status: 302, headers });
}

interface OAuthAttemptRow {
  state_hash: string;
  session_id: string;
  code_verifier: string;
  redirect_uri: string;
  scope: string;
  expires_at: string;
  used_at: string | null;
}

function channelIdentityFrom(
  response: Awaited<ReturnType<typeof youtubeListChannels>>,
): { id: string; title: string } | null {
  const item = response.items?.find((entry) => typeof entry.id === "string");
  if (!item || typeof item.id !== "string") return null;
  return { id: item.id, title: sanitizeText(item.snippet?.title, 200) };
}

async function findOrCreateOAuthAccount(
  env: Env,
  channel: { id: string; title: string },
  now: string,
): Promise<{ accountId: string; name: string }> {
  let account: AccountRow | null = null;
  if (channel?.id) {
    account = await env.DB.prepare(
      `SELECT * FROM accounts WHERE youtube_channel_id = ? AND mode = 'real'`,
    )
      .bind(channel.id)
      .first<AccountRow>();
  }

  const fallbackName = channel?.title || "YouTube account";
  if (account) {
    const name = channel?.title || account.name || fallbackName;
    await env.DB.prepare(
      `UPDATE accounts SET name = ?, youtube_channel_id = COALESCE(?, youtube_channel_id),
         connected = 1, updated_at = ? WHERE id = ?`,
    )
      .bind(name, channel?.id ?? null, now, account.id)
      .run();
    return { accountId: account.id, name };
  }

  const accountId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO accounts
       (id, mode, name, youtube_channel_id, connected, scopes, token_expires_at, created_at, updated_at)
     VALUES (?, 'real', ?, ?, 1, '', NULL, ?, ?)`,
  )
    .bind(accountId, fallbackName, channel?.id ?? null, now, now)
    .run();
  return { accountId, name: fallbackName };
}

export async function handleOAuthCallback(
  env: Env,
  request: Request,
): Promise<Response> {
  let setCookie: string | undefined;
  try {
    if (env.MODE !== "real") return redirectError(env, "demo_mode");
    if (!oauthConfigured(env)) return redirectError(env, "not_configured");

    const url = new URL(request.url);
    const oauthError = url.searchParams.get("error");
    if (oauthError)
      return redirectError(
        env,
        oauthError === "access_denied" ? "access_denied" : "oauth_error",
      );

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || code.length > 2000 || state.length > 200) {
      return redirectError(env, "invalid_callback");
    }

    const context = await resolveSession(env, request, { create: false });
    if (!context) return redirectError(env, "session_missing");
    setCookie = context.setCookie;

    const stateHash = await sha256Hex(state);
    const attempt = await env.DB.prepare(
      "SELECT * FROM oauth_attempts WHERE state_hash = ?",
    )
      .bind(stateHash)
      .first<OAuthAttemptRow>();
    if (
      !attempt ||
      attempt.used_at !== null ||
      attempt.session_id !== context.session.id ||
      Date.parse(attempt.expires_at) <= Date.now()
    ) {
      return redirectError(env, "invalid_state", setCookie);
    }

    const now = nowIso();
    const consumed = await env.DB.prepare(
      `UPDATE oauth_attempts SET used_at = ?
       WHERE state_hash = ? AND session_id = ? AND used_at IS NULL`,
    )
      .bind(now, stateHash, context.session.id)
      .run();
    if ((consumed.meta.changes ?? 0) !== 1) {
      return redirectError(env, "invalid_state", setCookie);
    }

    const token = await exchangeCode(env, {
      code,
      codeVerifier: attempt.code_verifier,
      redirectUri: attempt.redirect_uri,
    });

    // Never reuse a browser's previous account when another Google user signs in.
    // Without verified YouTube identity, fail closed rather than mix their data.
    const identity = channelIdentityFrom(
      await youtubeListChannels(token.access_token, { mine: true }),
    );
    if (!identity)
      throw new HttpError(
        502,
        "YOUTUBE_IDENTITY_UNAVAILABLE",
        "No se pudo identificar tu canal de YouTube.",
      );
    const account = await findOrCreateOAuthAccount(env, identity, now);
    await saveTokens(env, account.accountId, token);
    await ensurePreferences(env.DB, account.accountId);
    await linkSessionAccount(env.DB, context.session.id, account.accountId);
    await env.DB.prepare(
      "DELETE FROM oauth_attempts WHERE session_id = ? AND state_hash <> ?",
    )
      .bind(context.session.id, stateHash)
      .run();

    // Rotate the browser session after login to avoid fixation.
    const rotated = await insertSession(env.DB, account.accountId);
    await deleteSession(env.DB, context.session.id);
    setCookie = serializeCookie(SESSION_COOKIE, rotated.token, {
      maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
      secure: isSecureOrigin(env.APP_ORIGIN),
    });

    return redirectResponse(env, "/settings?connected=1", setCookie);
  } catch (error) {
    const reason =
      error instanceof HttpError && error.code === "OAUTH_NOT_CONFIGURED"
        ? "not_configured"
        : "oauth_failed";
    try {
      return redirectError(env, reason, setCookie);
    } catch {
      return json(
        { code: "OAUTH_FAILED", error: "Google authorization failed." },
        502,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Logout / disconnect / delete                                       */
/* ------------------------------------------------------------------ */

export async function handleLogout(
  env: Env,
  context: SessionContext | null,
): Promise<Response> {
  if (context) await deleteSession(env.DB, context.tokenHash);
  return json({ ok: true, mode: env.MODE }, 200, {
    "set-cookie": clearCookie(SESSION_COOKIE, isSecureOrigin(env.APP_ORIGIN)),
  });
}

async function revokeStoredToken(
  env: Env,
  accountId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT access_token_enc, refresh_token_enc FROM oauth_tokens WHERE account_id = ?",
  )
    .bind(accountId)
    .first<{ access_token_enc: string; refresh_token_enc: string | null }>();
  if (!row) return false;
  const secret = requireTokenSecret(env);
  let token: string | null = null;
  if (row.refresh_token_enc) {
    try {
      token = await decryptToken(secret, row.refresh_token_enc);
    } catch {
      token = null;
    }
  }
  if (!token) {
    try {
      token = await decryptToken(secret, row.access_token_enc);
    } catch {
      token = null;
    }
  }
  return token ? revokeToken(token) : false;
}

function countChanges(
  results: Array<{ meta?: { changes?: number } }>,
  labels: string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  labels.forEach((label, index) => {
    counts[label] = results[index]?.meta?.changes ?? 0;
  });
  return counts;
}

export async function handleDisconnect(
  env: Env,
  account: AccountRow,
): Promise<Response> {
  if (env.MODE === "demo" || account.mode === "demo") {
    return json({
      mode: "demo",
      disconnected: false,
      message:
        "Demo mode has no Google account to disconnect; no external calls were made.",
    });
  }

  let revoked = false;
  try {
    revoked = await revokeStoredToken(env, account.id);
  } catch {
    revoked = false;
  }
  const now = nowIso();
  const statements = [
    env.DB.prepare("DELETE FROM sync_jobs WHERE account_id=?").bind(account.id),
    env.DB.prepare(
      "DELETE FROM account_video_metadata WHERE account_id=?",
    ).bind(account.id),
    env.DB.prepare("DELETE FROM public_read_cache WHERE cache_key LIKE ?").bind(
      `search:%:${account.id}:%`,
    ),
    env.DB.prepare(
      `DELETE FROM playlist_items WHERE playlist_id IN
         (SELECT id FROM playlists WHERE account_id = ? AND source = 'youtube')`,
    ).bind(account.id),
    env.DB.prepare(
      `DELETE FROM playlists WHERE account_id = ? AND source = 'youtube'`,
    ).bind(account.id),
    env.DB.prepare(
      `DELETE FROM watch_states WHERE account_id = ?
       AND video_id IN (SELECT id FROM videos WHERE source <> 'fixture')`,
    ).bind(account.id),
    env.DB.prepare(
      `DELETE FROM playlist_items
       WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id = ?)
         AND video_id IN (SELECT id FROM videos WHERE source <> 'fixture')`,
    ).bind(account.id),
    env.DB.prepare(
      `DELETE FROM videos WHERE source <> 'fixture' AND channel_id=''
       AND id NOT IN (SELECT video_id FROM watch_states)
       AND id NOT IN (SELECT video_id FROM playlist_items)
       AND id NOT IN (SELECT video_id FROM account_video_metadata)`,
    ),
    env.DB.prepare("DELETE FROM subscriptions WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare("DELETE FROM sync_runs WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare("DELETE FROM sync_state WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare("DELETE FROM oauth_tokens WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare(
      `DELETE FROM oauth_attempts WHERE session_id IN (SELECT id FROM sessions WHERE account_id = ?)`,
    ).bind(account.id),
    env.DB.prepare(
      `UPDATE accounts SET connected = 0, scopes = '', token_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(now, account.id),
    env.DB.prepare(
      `DELETE FROM channels WHERE source <> 'fixture'
       AND id NOT IN (SELECT channel_id FROM subscriptions)
       AND id NOT IN (SELECT channel_id FROM videos)`,
    ),
  ];
  const results = await env.DB.batch(statements);
  return json({
    mode: "real",
    disconnected: true,
    revoked,
    deleted: countChanges(results, [
      "syncJobs",
      "ownerMetadata",
      "privateSearchCache",
      "youtubePlaylistItems",
      "youtubePlaylists",
      "externalWatchStates",
      "externalPlaylistReferences",
      "externalVideos",
      "subscriptions",
      "syncRuns",
      "syncState",
      "tokens",
      "oauthAttempts",
      "accountConnection",
      "orphanChannels",
    ]),
    note: "Local watch states and local playlists for known videos are kept; YouTube metadata was removed.",
  });
}

export async function handleDeleteAccountData(
  env: Env,
  account: AccountRow,
): Promise<Response> {
  const secure = isSecureOrigin(env.APP_ORIGIN);
  if (env.MODE === "demo" || account.mode === "demo") {
    const statements = [
      env.DB.prepare(
        `DELETE FROM playlist_items WHERE playlist_id IN
           (SELECT id FROM playlists WHERE account_id = ? AND seeded = 0)`,
      ).bind(account.id),
      env.DB.prepare(
        "DELETE FROM playlists WHERE account_id = ? AND seeded = 0",
      ).bind(account.id),
      env.DB.prepare("DELETE FROM watch_states WHERE account_id = ?").bind(
        account.id,
      ),
      env.DB.prepare("DELETE FROM subscriptions WHERE account_id = ?").bind(
        account.id,
      ),
      env.DB.prepare("DELETE FROM sync_runs WHERE account_id = ?").bind(
        account.id,
      ),
      env.DB.prepare("DELETE FROM sync_state WHERE account_id = ?").bind(
        account.id,
      ),
      env.DB.prepare(
        `INSERT INTO preferences (account_id, watch_threshold, theme, updated_at)
         VALUES (?, 90, 'system', ?)
         ON CONFLICT(account_id) DO UPDATE SET watch_threshold = 90, theme = 'system', updated_at = excluded.updated_at`,
      ).bind(account.id, nowIso()),
    ];
    const results = await env.DB.batch(statements);
    return json({
      mode: "demo",
      deleted: true,
      counts: countChanges(results, [
        "userPlaylistItems",
        "userPlaylists",
        "watchStates",
        "subscriptions",
        "syncRuns",
        "syncState",
        "preferencesReset",
      ]),
      note: "Fictional fixture videos and seeded playlists stay so the local demo remains usable. No external data exists in demo mode.",
    });
  }

  let revoked = false;
  try {
    revoked = await revokeStoredToken(env, account.id);
  } catch {
    revoked = false;
  }
  const statements = [
    env.DB.prepare(
      `DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id = ?)`,
    ).bind(account.id),
    env.DB.prepare("DELETE FROM playlists WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare("DELETE FROM watch_states WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare("DELETE FROM subscriptions WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare("DELETE FROM sync_runs WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare("DELETE FROM sync_state WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare("DELETE FROM oauth_tokens WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare("DELETE FROM sync_jobs WHERE account_id=?").bind(account.id),
    env.DB.prepare(
      "DELETE FROM account_video_metadata WHERE account_id=?",
    ).bind(account.id),
    env.DB.prepare("DELETE FROM public_read_cache WHERE cache_key LIKE ?").bind(
      `search:%:${account.id}:%`,
    ),
    env.DB.prepare("DELETE FROM preferences WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare(
      `DELETE FROM oauth_attempts WHERE session_id IN (SELECT id FROM sessions WHERE account_id = ?)`,
    ).bind(account.id),
    env.DB.prepare("DELETE FROM sessions WHERE account_id = ?").bind(
      account.id,
    ),
    env.DB.prepare(
      `DELETE FROM videos WHERE source <> 'fixture' AND channel_id=''
       AND id NOT IN (SELECT video_id FROM watch_states)
       AND id NOT IN (SELECT video_id FROM playlist_items)
       AND id NOT IN (SELECT video_id FROM account_video_metadata)`,
    ),
    env.DB.prepare(
      `DELETE FROM channels WHERE source <> 'fixture'
       AND id NOT IN (SELECT channel_id FROM subscriptions)
       AND id NOT IN (SELECT channel_id FROM videos)`,
    ),
    env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id),
  ];
  const results = await env.DB.batch(statements);
  return json(
    {
      mode: "real",
      deleted: true,
      revoked,
      counts: countChanges(results, [
        "playlistItems",
        "playlists",
        "watchStates",
        "subscriptions",
        "syncRuns",
        "syncState",
        "tokens",
        "syncJobs",
        "ownerMetadata",
        "privateSearchCache",
        "preferences",
        "oauthAttempts",
        "sessions",
        "orphanVideos",
        "orphanChannels",
        "account",
      ]),
    },
    200,
    { "set-cookie": clearCookie(SESSION_COOKIE, secure) },
  );
}

/** Used by tests to assert that CSRF comparisons are exact. */
export function csrfMatches(
  provided: string | null,
  expected: string,
): boolean {
  return typeof provided === "string" && constantTimeEqual(provided, expected);
}
