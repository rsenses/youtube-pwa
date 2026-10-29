import { afterAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Env } from "../worker/types";
import { encryptToken, getValidAccessToken } from "../worker/auth";
import { OAUTH_REVOKE_URL, OAUTH_TOKEN_URL } from "../worker/youtube";

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("local test")}}',
    compatibilityDate: "2026-10-20",
    d1Databases: ["DB"],
  }),
);

afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

describe("expired Google authorization", () => {
  it("requires reconnection without deleting the account's watch and exclusion data", async () => {
    const db = (await mf.getD1Database("DB")) as D1Database;
    for (const name of [
      "0001_init.sql",
      "0002_video_details.sql",
      "0003_public_read_cache.sql",
      "0004_video_discoveries.sql",
      "0005_queued_sync.sql",
      "0006_retention_indexes.sql",
      "0007_video_broadcast_status.sql",
      "0008_incremental_sync.sql",
      "0013_exclusions.sql",
      "0015_short_retention.sql",
      "0016_pure_black_theme.sql",
      "0017_followed_playlists.sql",
    ]) {
      const sql = (
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        )
      ).replace(/^\s*--.*$/gm, "");
      await db.batch(
        sql
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => db.prepare(part)),
      );
    }
    const accountId = "existing-account";
    const channelId = "UCexistingChannel12345678";
    const videoId = "existingVid1";
    const before = "2026-10-20T00:00:00.000Z";
    const env = {
      DB: db,
      MODE: "real",
      APP_ORIGIN: "http://localhost:5173",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-only",
      TOKEN_ENCRYPTION_KEY: "test-only-key-not-a-real-credential",
    } as Env;
    await db.batch([
      db
        .prepare(
          "INSERT INTO accounts (id,mode,name,youtube_channel_id,connected,created_at,updated_at) VALUES (?,'real','Existing',?,1,?,?)",
        )
        .bind(accountId, channelId, before, before),
      db
        .prepare(
          "INSERT INTO channels (id,title,created_at,updated_at) VALUES (?,'Channel',?,?)",
        )
        .bind(channelId, before, before),
      db
        .prepare(
          "INSERT INTO videos (id,channel_id,title,published_at,fetched_at,created_at,updated_at,source) VALUES (?,?,'Video',?,?,?,?,'youtube')",
        )
        .bind(videoId, channelId, before, before, before, before),
      db
        .prepare(
          "INSERT INTO subscriptions (account_id,channel_id,excluded,created_at,updated_at) VALUES (?,?,1,?,?)",
        )
        .bind(accountId, channelId, before, before),
      db
        .prepare(
          "INSERT INTO watch_states (account_id,video_id,watched,updated_at) VALUES (?,?,1,?)",
        )
        .bind(accountId, videoId, before),
      db
        .prepare(
          "INSERT INTO playlists (id,account_id,source,remote_id,title,excluded,created_at,updated_at) VALUES ('list',?,'youtube','remote','List',1,?,?)",
        )
        .bind(accountId, before, before),
    ]);
    await db
      .prepare(
        "INSERT INTO oauth_tokens (account_id,access_token_enc,refresh_token_enc,expires_at,updated_at) VALUES (?,?,?,?,?)",
      )
      .bind(
        accountId,
        await encryptToken(env.TOKEN_ENCRYPTION_KEY!, "old-access"),
        await encryptToken(env.TOKEN_ENCRYPTION_KEY!, "expired-refresh"),
        before,
        before,
      )
      .run();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(String(input));
        if (String(input) === OAUTH_TOKEN_URL)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (String(input) === OAUTH_REVOKE_URL)
          return new Response(null, { status: 200 });
        throw new Error("Unexpected network request");
      }),
    );

    await expect(getValidAccessToken(env, accountId)).rejects.toMatchObject({
      code: "RECONNECT_REQUIRED",
    });
    expect(calls).toEqual([OAUTH_TOKEN_URL]);
    expect(
      await db
        .prepare("SELECT connected,youtube_channel_id FROM accounts WHERE id=?")
        .bind(accountId)
        .first(),
    ).toMatchObject({ connected: 0, youtube_channel_id: channelId });
    expect(
      await db
        .prepare(
          "SELECT watched FROM watch_states WHERE account_id=? AND video_id=?",
        )
        .bind(accountId, videoId)
        .first(),
    ).toMatchObject({ watched: 1 });
    expect(
      await db
        .prepare(
          "SELECT excluded FROM subscriptions WHERE account_id=? AND channel_id=?",
        )
        .bind(accountId, channelId)
        .first(),
    ).toMatchObject({ excluded: 1 });
    expect(
      await db
        .prepare(
          "SELECT excluded FROM playlists WHERE account_id=? AND id='list'",
        )
        .bind(accountId)
        .first(),
    ).toMatchObject({ excluded: 1 });
    expect(
      await db
        .prepare("SELECT account_id FROM oauth_tokens WHERE account_id=?")
        .bind(accountId)
        .first(),
    ).toBeNull();
  });
});
