/**
 * Small HTTP helpers shared by every Worker route: JSON responses, validated
 * bodies, size limits, cookies, CSRF tokens and keyset cursors.
 */

export const JSON_LIMIT_BYTES = 64 * 1024;

export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export class ExternalError extends HttpError {
  readonly reason: string;

  constructor(
    reason: string,
    message = "The external service request failed.",
  ) {
    super(502, "EXTERNAL_ERROR", message, { reason: sanitizeCode(reason) });
    this.reason = sanitizeCode(reason);
  }
}

export function sanitizeCode(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 80) || "unknown"
  );
}

export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(
      /(access_token|refresh_token|client_secret|code|id_token|key|api_key|youtube_api_key)=[^&\s]+/gi,
      "$1=[redacted]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, "Bearer [redacted]");
  return sanitizeText(redacted, 300);
}

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      {
        ...error.extra,
        code: error.code,
        error: error.message,
      },
      error.status,
    );
  }
  if (
    error instanceof Error &&
    /D1['’]s free tier daily row (read|write) limit/i.test(error.message)
  ) {
    const now = new Date();
    const retryAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    return json(
      {
        code: "D1_DAILY_LIMIT",
        error:
          "Se ha agotado la cuota diaria gratuita de la base de datos. Se restablece a las 00:00 UTC. No necesitas ejecutar comandos de desarrollo.",
        retryAt: retryAt.toISOString(),
      },
      503,
      {
        "retry-after": String(
          Math.ceil((retryAt.getTime() - now.getTime()) / 1000),
        ),
      },
    );
  }
  return json({ code: "INTERNAL", error: "Unexpected server error." }, 500);
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

export function isoInDays(days: number, from: Date = new Date()): string {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/* ------------------------------------------------------------------ */
/* Text                                                               */
/* ------------------------------------------------------------------ */

/**
 * Removes control characters (keeping tabs/newlines), bidi overrides and
 * zero-width characters, then trims. Output is JSON-safe; callers render it as
 * text, never as HTML.
 */
export function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > maxLength
    ? chars.slice(0, maxLength).join("")
    : cleaned;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* JSON bodies                                                        */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Mutations with a body require application/json.",
    );
  }
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > JSON_LIMIT_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  }
  const text = await readLimitedText(request, JSON_LIMIT_BYTES);
  if (!text.trim()) {
    throw new HttpError(
      400,
      "INVALID_JSON",
      "Request body must be a JSON object.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
  if (!isPlainObject(parsed)) {
    throw new HttpError(
      400,
      "INVALID_JSON",
      "Request body must be a JSON object.",
    );
  }
  return parsed;
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; trim?: boolean } = {},
): string {
  const { min = 1, max = 200, trim = true } = options;
  const raw = body[key];
  if (typeof raw !== "string") {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `Field "${key}" must be a string.`,
    );
  }
  const value = trim ? raw.trim() : raw;
  if (value.length < min) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `Field "${key}" is too short.`,
    );
  }
  if (value.length > max) {
    throw new HttpError(400, "VALIDATION_ERROR", `Field "${key}" is too long.`);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  options: { max?: number; trim?: boolean } = {},
): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `Field "${key}" must be a string.`,
    );
  }
  return requiredString(body, key, {
    min: 0,
    max: options.max ?? 2000,
    trim: options.trim ?? true,
  });
}

export function requiredBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean {
  const raw = body[key];
  if (typeof raw !== "boolean") {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `Field "${key}" must be a boolean.`,
    );
  }
  return raw;
}

export function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `Field "${key}" must be a boolean.`,
    );
  }
  return raw;
}

export function optionalFiniteNumber(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `Field "${key}" must be a finite number.`,
    );
  }
  if (options.min !== undefined && raw < options.min) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `Field "${key}" is below the allowed minimum.`,
    );
  }
  if (options.max !== undefined && raw > options.max) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `Field "${key}" is above the allowed maximum.`,
    );
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* Identifier / query validation                                      */
/* ------------------------------------------------------------------ */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function assertId(value: string, label = "id"): string {
  if (!ID_PATTERN.test(value)) {
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid ${label}.`);
  }
  return value;
}

const COMMENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;

export function assertCommentId(value: string, label = "commentId"): string {
  if (!COMMENT_ID_PATTERN.test(value)) {
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid ${label}.`);
  }
  return value;
}

export function parseLimit(url: URL, fallback = 30, max = 100): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,4}$/.test(raw)) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "limit must be a positive integer.",
    );
  }
  const value = Number(raw);
  if (value < 1 || value > max) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `limit must be between 1 and ${max}.`,
    );
  }
  return value;
}

export function parseOptionalQuery(
  url: URL,
  key: string,
  max = 200,
): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.length > max) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `Query parameter "${key}" is too long.`,
    );
  }
  return value;
}

export function parseIsoDate(value: string, label = "date"): string {
  if (value.length < 10 || value.length > 40) {
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid ${label}.`);
  }
  if (
    !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  ) {
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid ${label}.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid ${label}.`);
  }
  return date.toISOString();
}

export function parseEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid ${label}.`);
  }
  return value as T;
}

/* ------------------------------------------------------------------ */
/* Opaque pagination cursors                                          */
/* ------------------------------------------------------------------ */

export interface FeedCursor {
  publishedAt: string;
  id: string;
}

export function encodeCursor(cursor: FeedCursor): string {
  return bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ p: cursor.publishedAt, i: cursor.id }),
    ),
  );
}

export function decodeCursor(value: string | null): FeedCursor | null {
  if (!value) return null;
  if (value.length > 400) {
    throw new HttpError(400, "VALIDATION_ERROR", "Invalid cursor.");
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(value)),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).p === "string" &&
      typeof (parsed as Record<string, unknown>).i === "string"
    ) {
      const p = (parsed as Record<string, string>).p;
      const i = (parsed as Record<string, string>).i;
      if (p.length <= 40 && /^[0-9T:.+\-Z]+$/.test(p) && ID_PATTERN.test(i)) {
        return { publishedAt: p, id: i };
      }
    }
  } catch {
    // fall through to the validation error
  }
  throw new HttpError(400, "VALIDATION_ERROR", "Invalid cursor.");
}

/** Opaque upstream page tokens (YouTube) are bounded and character checked. */
export function assertPageToken(value: string | null): string | null {
  if (!value) return null;
  if (value.length > 500 || !/^[A-Za-z0-9_=+./-]+$/.test(value)) {
    throw new HttpError(400, "VALIDATION_ERROR", "Invalid pagination cursor.");
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Cookies / CSRF / origins                                           */
/* ------------------------------------------------------------------ */

export const SESSION_COOKIE = "pwa_session";

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
  path?: string;
  sameSite?: "Lax" | "Strict";
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    "HttpOnly",
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { maxAgeSeconds: 0, secure });
}

export function normalizeOrigin(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function originAllowed(request: Request, appOrigin: string): boolean {
  const header = request.headers.get("origin");
  const origin = normalizeOrigin(header);
  if (!origin) return false;
  const allowed = new Set<string>();
  const configured = normalizeOrigin(appOrigin);
  if (configured) allowed.add(configured);
  allowed.add(new URL(request.url).origin);
  return allowed.has(origin);
}

export function requireMutationOrigin(
  request: Request,
  appOrigin: string,
): void {
  const header = request.headers.get("origin");
  if (!header) {
    throw new HttpError(
      403,
      "ORIGIN_REQUIRED",
      "Mutations require an Origin header.",
    );
  }
  if (!originAllowed(request, appOrigin)) {
    throw new HttpError(403, "ORIGIN_FORBIDDEN", "Origin is not allowed.");
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function requireCsrf(request: Request, csrfToken: string): void {
  const provided = request.headers.get("x-csrf-token");
  if (!provided) {
    throw new HttpError(403, "CSRF_REQUIRED", "Missing x-csrf-token header.");
  }
  if (!constantTimeEqual(provided, csrfToken)) {
    throw new HttpError(403, "CSRF_INVALID", "Invalid CSRF token.");
  }
}

/* ------------------------------------------------------------------ */
/* Crypto / encoding utilities                                        */
/* ------------------------------------------------------------------ */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await sha256Bytes(value);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Fetch with a hard timeout. Used for OAuth, YouTube API and Atom feeds. */
/** Bound bytes during streaming, rather than buffering an untrusted body first. */
export async function readLimitedText(
  message: Request | Response,
  maxBytes: number,
): Promise<string> {
  if (!message.body) return "";
  const reader = message.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 12000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut)
        throw new ExternalError(
          "timeout",
          "Reading the external data timed out.",
        );
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Data exceeds the permitted size.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = 12_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof ExternalError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ExternalError("timeout", "The external request timed out.");
    }
    throw new ExternalError(
      "network",
      "The external request could not be completed.",
    );
  } finally {
    clearTimeout(timer);
  }
}
