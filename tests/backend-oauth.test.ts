import { describe, expect, it } from "vitest";
import type { Env } from "../worker/types";
import {
  OAUTH_AUTH_URL,
  SCOPE_READONLY,
  SCOPE_WRITE,
  buildAuthUrl,
  getOAuthSettings,
  hasWriteScope,
  oauthConfigured,
  scopesFor,
} from "../worker/youtube";

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    MODE: "real",
    APP_ORIGIN: "http://localhost:5173",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEY: "token-key",
    ...overrides,
  } as unknown as Env;
}

describe("Google OAuth configuration", () => {
  it.each(["http://localhost:5173", "https://alveo.rsenses.com"])(
    "builds an authorization URL with PKCE, offline access and a fixed redirect for %s",
    (origin) => {
      const url = new URL(
        buildAuthUrl(envWith({ APP_ORIGIN: origin }), {
          state: "state-value",
          codeChallenge: "challenge-value",
          scope: "readonly",
        }),
      );
      expect(url.origin + url.pathname).toBe(`${OAUTH_AUTH_URL}`);
      expect(url.searchParams.get("client_id")).toBe("client-id");
      expect(url.searchParams.get("redirect_uri")).toBe(
        `${origin}/auth/google/callback`,
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("scope")).toBe(SCOPE_READONLY);
      expect(url.searchParams.get("state")).toBe("state-value");
      expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    },
  );

  it("requests incremental write scope only when asked", () => {
    expect(scopesFor("readonly")).toBe(SCOPE_READONLY);
    expect(scopesFor("write")).toBe(`${SCOPE_READONLY} ${SCOPE_WRITE}`);
    expect(hasWriteScope(SCOPE_READONLY)).toBe(false);
    expect(hasWriteScope(`${SCOPE_READONLY} ${SCOPE_WRITE}`)).toBe(true);
  });

  it("reports missing local OAuth configuration instead of pretending to connect", () => {
    expect(oauthConfigured(envWith())).toBe(true);
    const noClient = envWith();
    delete noClient.GOOGLE_CLIENT_ID;
    expect(oauthConfigured(noClient)).toBe(false);
    const noKey = envWith();
    delete noKey.TOKEN_ENCRYPTION_KEY;
    expect(oauthConfigured(noKey)).toBe(false);
    const noSecret = envWith();
    delete noSecret.GOOGLE_CLIENT_SECRET;
    let error: unknown = null;
    try {
      getOAuthSettings(noSecret);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ status: 501, code: "OAUTH_NOT_CONFIGURED" });
  });
});
