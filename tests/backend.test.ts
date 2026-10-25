import { describe, expect, it } from "vitest";
import {
  HttpError,
  errorResponse,
  assertPageToken,
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  decodeCursor,
  encodeCursor,
  originAllowed,
  parseIsoDate,
  parseLimit,
  readJsonObject,
  requireCsrf,
  requireMutationOrigin,
  sanitizeError,
  sanitizeText,
} from "../worker/http";
import { mapVideoRow } from "../worker/db";
import { csrfMatches, decryptToken, encryptToken } from "../worker/auth";
import { parseIsoDuration } from "../worker/youtube";

const APP_ORIGIN = "http://localhost:5173";

function jsonRequest(body: string, contentType = "application/json"): Request {
  return new Request(`${APP_ORIGIN}/api/test`, {
    method: "POST",
    headers: { "content-type": contentType, origin: APP_ORIGIN },
    body,
  });
}

describe("D1 quota errors", () => {
  it.each(["read", "write"])(
    "reports the daily %s limit without exposing provider details",
    async (kind) => {
      const response = errorResponse(
        new Error(
          "D1_ERROR: Your account has exceeded D1's free tier daily row " +
            kind +
            " limit.",
        ),
      );
      expect(response.status).toBe(503);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await response.json()).toMatchObject({
        code: "D1_DAILY_LIMIT",
        error: expect.stringContaining("00:00 UTC"),
        retryAt: expect.any(String),
      });
    },
  );
  it("does not expose unknown database errors", async () => {
    expect(
      await errorResponse(new Error("private database detail")).json(),
    ).toEqual({ code: "INTERNAL", error: "Unexpected server error." });
  });
});
describe("text safety", () => {
  it("strips controls, bidi overrides and zero-width characters but keeps newlines", () => {
    const input = "  hello\u0000\u0007\u202Eworld\u200B\nsecond\tline  ";
    expect(sanitizeText(input, 100)).toBe("helloworld\nsecond\tline");
  });

  it("truncates by code point, not by UTF-16 unit", () => {
    expect(sanitizeText("😀😀😀", 2)).toBe("😀😀");
    expect(Array.from(sanitizeText("😀😀😀", 2))).toHaveLength(2);
  });

  it("redacts credentials from persisted sync errors", () => {
    const message = "failed access_token=abc123&x=1 Bearer eyJhbGciOi.abc.def";
    const safe = sanitizeError(new Error(message));
    expect(safe).not.toContain("abc123");
    expect(safe).not.toContain("eyJhbGciOi");
    expect(safe).toContain("[redacted]");
  });
});

describe("JSON body validation", () => {
  it("parses a JSON object", async () => {
    await expect(readJsonObject(jsonRequest('{"a":1}'))).resolves.toEqual({
      a: 1,
    });
  });

  it("rejects non-JSON content types", async () => {
    await expect(
      readJsonObject(jsonRequest('{"a":1}', "text/plain")),
    ).rejects.toMatchObject({
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it("rejects arrays, invalid JSON and empty bodies", async () => {
    await expect(readJsonObject(jsonRequest("[]"))).rejects.toMatchObject({
      status: 400,
    });
    await expect(readJsonObject(jsonRequest("{"))).rejects.toMatchObject({
      code: "INVALID_JSON",
    });
    await expect(readJsonObject(jsonRequest(""))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects oversized bodies", async () => {
    const oversized = `{"value":"${"x".repeat(70_000)}"}`;
    await expect(readJsonObject(jsonRequest(oversized))).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe("query validation", () => {
  it("round-trips keyset cursors", () => {
    const cursor = {
      publishedAt: "2026-10-12T09:00:00.000Z",
      id: "M7lc1UVf-VE",
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(null)).toBeNull();
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(HttpError);
    expect(() =>
      decodeCursor(
        bytesToBase64Url(new TextEncoder().encode('{"p":1,"i":"x"}')),
      ),
    ).toThrow(/Invalid cursor/);
  });

  it("validates limits", () => {
    const url = new URL(`${APP_ORIGIN}/api/feed?limit=25`);
    expect(parseLimit(url, 30, 100)).toBe(25);
    expect(() =>
      parseLimit(new URL(`${APP_ORIGIN}/api/feed?limit=101`), 30, 100),
    ).toThrow(/between/);
    expect(() =>
      parseLimit(new URL(`${APP_ORIGIN}/api/feed?limit=2.5`), 30, 100),
    ).toThrow(/integer/);
  });

  it("normalizes ISO dates and rejects junk", () => {
    expect(parseIsoDate("2026-10-01", "before")).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(parseIsoDate("2026-10-01T10:00:00+02:00", "before")).toBe(
      "2026-10-01T08:00:00.000Z",
    );
    expect(() => parseIsoDate("2026-10-01T10:00:00", "before")).toThrow(
      /Invalid before/,
    );
    expect(() => parseIsoDate("not-a-date", "before")).toThrow(HttpError);
  });

  it("bounds opaque upstream page tokens", () => {
    expect(assertPageToken("abc_DEF-123")).toBe("abc_DEF-123");
    const opaque = `next:page?part=comments&token=${"x".repeat(600)}`;
    expect(assertPageToken(opaque)).toBe(opaque);
    expect(assertPageToken(null)).toBeNull();
    expect(() => assertPageToken("bad token!")).toThrow(/pagination cursor/);
    expect(() => assertPageToken("x".repeat(4097))).toThrow(/pagination cursor/);
  });
});

describe("origin and CSRF protection", () => {
  it("accepts the configured origin and the request origin", () => {
    expect(
      originAllowed(
        new Request(`${APP_ORIGIN}/api/x`, { headers: { origin: APP_ORIGIN } }),
        APP_ORIGIN,
      ),
    ).toBe(true);
    expect(
      originAllowed(
        new Request("http://localhost:8787/api/x", {
          headers: { origin: "http://localhost:8787" },
        }),
        APP_ORIGIN,
      ),
    ).toBe(true);
    expect(
      originAllowed(
        new Request(`${APP_ORIGIN}/api/x`, {
          headers: { origin: "https://evil.example" },
        }),
        APP_ORIGIN,
      ),
    ).toBe(false);
  });

  it("rejects missing origins for mutations", () => {
    const request = new Request(`${APP_ORIGIN}/api/x`, { method: "POST" });
    expect(() => requireMutationOrigin(request, APP_ORIGIN)).toThrow(
      /Origin header/,
    );
  });

  it("requires an exact CSRF token", () => {
    const request = new Request(`${APP_ORIGIN}/api/x`, {
      method: "POST",
      headers: { "x-csrf-token": "abc123" },
    });
    expect(() => requireCsrf(request, "abc123")).not.toThrow();
    expect(() => requireCsrf(request, "abc124")).toThrow(/Invalid CSRF/);
    expect(() =>
      requireCsrf(new Request(`${APP_ORIGIN}/api/x`), "abc123"),
    ).toThrow(/Missing/);
    expect(csrfMatches("abc123", "abc123")).toBe(true);
    expect(csrfMatches("abc123", "abc1234")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("row mapping", () => {
  it("maps SQLite integers and nulls to the Video contract", () => {
    const video = mapVideoRow({
      id: "M7lc1UVf-VE",
      title: "Demo",
      channelId: "UC123",
      channelTitle: "Channel",
      thumbnailUrl: "/thumbs/01.svg",
      publishedAt: "2026-10-12T09:00:00.000Z",
      description: "",
      durationSeconds: null,
      watched: 1,
      positionSeconds: 12.5,
      percent: 50.555,
      manual: 0,
      viewCount: null,
      revision: 3,
    });
    expect(video.watched).toBe(true);
    expect(video.manual).toBe(false);
    expect(video.durationSeconds).toBeNull();
    expect(video.viewCount).toBeNull();
    expect(video.percent).toBe(50.56);
    expect(video.revision).toBe(3);
    expect(video.playlistItemId).toBeUndefined();
  });

  it("keeps playlist item ids when provided", () => {
    const video = mapVideoRow({
      id: "x",
      watched: 0,
      manual: 1,
      playlistItemId: "pi-1",
    });
    expect(video.playlistItemId).toBe("pi-1");
    expect(video.watched).toBe(false);
    expect(video.manual).toBe(true);
  });
});

describe("token encryption", () => {
  it("round-trips with AES-GCM and a fresh IV", async () => {
    const secret = "local-test-secret";
    const first = await encryptToken(secret, "refresh-token-value");
    const second = await encryptToken(secret, "refresh-token-value");
    expect(first).toMatch(/^v1\./);
    expect(first).not.toBe(second);
    expect(first).not.toContain("refresh-token-value");
    await expect(decryptToken(secret, first)).resolves.toBe(
      "refresh-token-value",
    );
    await expect(decryptToken(secret, second)).resolves.toBe(
      "refresh-token-value",
    );
  });

  it("fails closed with the wrong key or malformed payload", async () => {
    const encrypted = await encryptToken("secret-one", "token");
    await expect(decryptToken("secret-two", encrypted)).rejects.toMatchObject({
      status: 500,
      code: "TOKEN_DECRYPT_FAILED",
    });
    await expect(
      decryptToken("secret-one", "v1.not-base64"),
    ).rejects.toMatchObject({
      code: "TOKEN_DECRYPT_FAILED",
    });
    await expect(decryptToken("secret-one", "v2.abc")).rejects.toMatchObject({
      code: "TOKEN_DECRYPT_FAILED",
    });
  });
});

describe("small parsing utilities", () => {
  it("parses ISO durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("P1DT2S")).toBe(86402);
    expect(parseIsoDuration("PT0S")).toBe(0);
    expect(parseIsoDuration("not-a-duration")).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });

  it("round-trips base64url bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
  });
});
