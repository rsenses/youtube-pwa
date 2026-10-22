import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Env, AccountRow } from "../worker/types";
import { encryptToken } from "../worker/auth";
import worker from "../worker/index";
import { privateVideoStatements } from "../worker/private-metadata";
import { handleSync } from "../worker/sync";
import {
  externalVideoStatement,
  listFeed,
  listChannels,
  bulkWatchState,
  getVideo,
  setManualWatchState,
  setProgress,
  upsertExternalChannel,
  upsertRemoteSubscription,
} from "../worker/db";
import { readLimitedText } from "../worker/http";
import { writeRssCheck } from "../worker/rss-cache";
import { getPublicVideo, getPublicSuggestions } from "../worker/public-youtube";
import { listCommentThreads, listCommentReplies } from "../worker/youtube";

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("local test")}}',
    compatibilityDate: "2026-10-20",
    d1Databases: ["DB"],
  }),
);
let env: Env;
let account: AccountRow;
const oldDate = "2026-01-01T00:00:00.000Z";
const future = "2099-01-01T00:00:00.000Z";
beforeAll(async () => {
  const db = await mf.getD1Database("DB");
  env = {
    DB: db as D1Database,
    ASSETS: {
      fetch: async () => new Response("test"),
      connect() {
        throw new Error("Not used in this test");
      },
    },
    MODE: "real",
    APP_ORIGIN: "http://localhost:5173",
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-only",
    TOKEN_ENCRYPTION_KEY: "test-only-key-not-a-real-credential",
  };
  for (const name of [
    "0001_init.sql",
    "0002_video_details.sql",
    "0003_public_read_cache.sql",
    "0004_video_discoveries.sql",
    "0005_queued_sync.sql",
    "0006_retention_indexes.sql",
    "0007_video_broadcast_status.sql",
    "0008_incremental_sync.sql",
  ]) {
    const sql = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    const statements = sql
      .replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  }
  await env.DB.prepare(
    "INSERT INTO accounts (id,mode,name,connected,scopes,created_at,updated_at) VALUES (?,?,?,1,?,?,?)",
  )
    .bind(
      "real-test",
      "real",
      "Test",
      "https://www.googleapis.com/auth/youtube.readonly",
      oldDate,
      oldDate,
    )
    .run();
  account = (await env.DB.prepare("SELECT * FROM accounts WHERE id=?")
    .bind("real-test")
    .first<AccountRow>())!;
  await env.DB.prepare(
    "INSERT INTO oauth_tokens (account_id,access_token_enc,expires_at,updated_at) VALUES (?,?,?,?)",
  )
    .bind(
      account.id,
      await encryptToken(env.TOKEN_ENCRYPTION_KEY!, "mock-access-token"),
      future,
      oldDate,
    )
    .run();
  await upsertExternalChannel(
    env.DB,
    { id: "UCold", title: "Old channel", description: "", thumbnailUrl: null },
    future,
    oldDate,
  );
  await upsertRemoteSubscription(
    env.DB,
    account.id,
    "UCold",
    "sub-old",
    oldDate,
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

describe("D1 synchronization outcomes with mocked external responses", () => {
  it("filters effective video types before pagination and isolates owner broadcast metadata", async () => {
    const channel = {
      id: "UCtypes",
      title: "Types",
      description: "",
      thumbnailUrl: "",
    };
    await upsertExternalChannel(env.DB, channel, future);
    await upsertRemoteSubscription(env.DB, account.id, channel.id, null);
    const date = "2026-10-21T00:00:00.000Z";
    const ids = Array.from(
      { length: 25 },
      (_, i) => "t" + String(i).padStart(10, "0"),
    );
    for (let i = 0; i < ids.length; i++)
      await externalVideoStatement(
        env.DB,
        {
          id: ids[i],
          channelId: channel.id,
          channelTitle: channel.title,
          title: "Type " + i,
          description: "",
          thumbnailUrl: "",
          publishedAt: date,
          durationSeconds:
            i === 0 ? 180 : i === 1 ? null : i === 2 ? 30 : i === 3 ? 300 : 179,
          liveBroadcastContent:
            i === 2 ? "live" : i === 3 ? "upcoming" : "none",
          isLive: i === 2 || i === 3,
          viewCount: 0,
          source: "rss",
        },
        future,
        oldDate,
      ).run();
    const options = {
      status: "all" as const,
      channelId: channel.id,
      cursor: null,
      limit: 2,
      types: ["video", "live"] as Array<"video" | "live">,
    };
    const first = await listFeed(env.DB, account.id, options, "external");
    expect(first.items.map((v) => v.id)).toEqual([ids[3], ids[2]]);
    expect(first.hasMore).toBe(true);
    const second = await listFeed(
      env.DB,
      account.id,
      { ...options, cursor: { publishedAt: date, id: ids[2] } },
      "external",
    );
    expect(second.items.map((v) => v.id)).toEqual([ids[1], ids[0]]);
    expect(second.hasMore).toBe(false);
    expect(
      (
        await listFeed(
          env.DB,
          account.id,
          { ...options, types: [] },
          "external",
        )
      ).items,
    ).toEqual([]);
    expect(
      (
        await listFeed(
          env.DB,
          account.id,
          { ...options, types: ["short"], limit: 100 },
          "external",
        )
      ).items,
    ).toHaveLength(21);
    await env.DB.batch(
      privateVideoStatements(
        env.DB,
        account.id,
        {
          id: ids[0],
          channelId: channel.id,
          channelTitle: channel.title,
          title: "Private overlay",
          description: "",
          thumbnailUrl: "",
          publishedAt: date,
          durationSeconds: 30,
          liveBroadcastContent: "live",
          isLive: true,
          viewCount: 0,
          source: "youtube",
        },
        new Date().toISOString(),
        future,
        true,
      ),
    );
    expect(
      (
        await listFeed(
          env.DB,
          account.id,
          { ...options, types: ["live"], limit: 100 },
          "external",
        )
      ).items.map((v) => v.id),
    ).toEqual([ids[2], ids[0]]);
    expect(
      (await getVideo(env.DB, "other-type-viewer", ids[0], "external"))
        ?.liveBroadcastContent,
    ).toBe("none");
    expect(
      (await getVideo(env.DB, account.id, ids[3], "external"))?.isLive,
    ).toBe(true);
    expect(
      (await getVideo(env.DB, account.id, ids[3], "external"))
        ?.liveBroadcastContent,
    ).toBe("upcoming");
  });

  it("does not unsubscribe missing channels after a failed second page", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 2)
          return new Response(
            JSON.stringify({ error: { errors: [{ reason: "backendError" }] } }),
            { status: 503 },
          );
        return Response.json({
          items: [
            {
              id: "sub-new",
              snippet: {
                title: "New channel",
                resourceId: { channelId: "UCnew" },
              },
            },
          ],
          nextPageToken: "page-2",
        });
      }),
    );
    await expect(
      handleSync(env, account, "subscriptions"),
    ).rejects.toMatchObject({ status: 502 });
    expect(
      (
        await env.DB.prepare(
          "SELECT active FROM subscriptions WHERE account_id=? AND channel_id=?",
        )
          .bind(account.id, "UCold")
          .first<{ active: number }>()
      )?.active,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT status FROM sync_runs ORDER BY started_at DESC LIMIT 1",
        ).first<{ status: string }>()
      )?.status,
    ).toBe("error");
    vi.unstubAllGlobals();
  });
  it("reconciles missing subscriptions only after a complete snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              id: "sub-new",
              snippet: {
                title: "New channel",
                resourceId: { channelId: "UCnew" },
              },
            },
          ],
        }),
      ),
    );
    const result = await handleSync(env, account, "subscriptions");
    expect(result.status).toBe("success");
    expect(
      (
        await env.DB.prepare(
          "SELECT active FROM subscriptions WHERE account_id=? AND channel_id=?",
        )
          .bind(account.id, "UCold")
          .first<{ active: number }>()
      )?.active,
    ).toBe(0);
    vi.unstubAllGlobals();
  });
  it("deduplicates RSS video upserts without overwriting manual watch state", async () => {
    const video = {
      id: "M7lc1UVf-VE",
      channelId: "UCnew",
      channelTitle: "New",
      title: "First",
      description: "",
      thumbnailUrl: "",
      publishedAt: oldDate,
      durationSeconds: null,
      viewCount: null,
      source: "rss" as const,
    };
    await externalVideoStatement(env.DB, video, future).run();
    await setManualWatchState(env.DB, account.id, video.id, false);
    await externalVideoStatement(
      env.DB,
      { ...video, title: "Updated" },
      future,
    ).run();
    await setProgress(env.DB, account.id, video.id, {
      positionSeconds: 95,
      durationSeconds: 100,
      percent: 95,
      watched: true,
      watchedAt: oldDate,
    });
    const read = await getVideo(env.DB, account.id, video.id, "external");
    expect(read?.title).toBe("Updated");
    expect(read?.watched).toBe(false);
    expect(read?.manual).toBe(true);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM videos WHERE id=?")
          .bind(video.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });
  it("loads real related-search videos across channels with shared public cache and private watch states", async () => {
    const channelId = "UC" + "a".repeat(22);
    const relatedId = "abcDEF12345";
    const calls: string[] = [];
    const item = (id: string) => ({
      id,
      snippet: {
        title: id === "M7lc1UVf-VE" ? "Real title" : "Real related video",
        tags:
          id === "M7lc1UVf-VE"
            ? ["youtube", "electronics", "microcontrollers"]
            : [],
        channelId: id === relatedId ? "UC" + "b".repeat(22) : channelId,
        channelTitle: id === relatedId ? "Another channel" : "Real channel",
        description: "Real description",
        publishedAt: "2025-01-01T00:00:00Z",
        liveBroadcastContent: "none",
      },
      contentDetails: { duration: "PT2M" },
      statistics: { viewCount: "123" },
      status: { privacyStatus: "public" },
    });
    env.YOUTUBE_API_KEY = "unit-test-key-only";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        calls.push(url.pathname);
        const headers = new Headers(init.headers);
        expect(headers.get("x-goog-api-key")).toBe("unit-test-key-only");
        expect(headers.has("authorization")).toBe(false);
        expect(url.searchParams.has("key")).toBe(false);
        expect(init.method).toBe("GET");
        if (url.pathname.endsWith("/videos"))
          return Response.json({
            items: url.searchParams.get("id")!.split(",").map(item),
          });
        if (url.pathname.endsWith("/search")) {
          expect(url.searchParams.get("q")).toBe(
            "electronics microcontrollers",
          );
          expect(url.searchParams.get("type")).toBe("video");
          expect(url.searchParams.get("videoEmbeddable")).toBe("true");
          expect(url.searchParams.has("channelId")).toBe(false);
          return Response.json({
            items: [
              { id: { videoId: "M7lc1UVf-VE" } },
              { id: { videoId: relatedId } },
              { id: { videoId: relatedId } },
            ],
          });
        }
        throw new Error("Unexpected mocked endpoint");
      }),
    );
    try {
      const video = await getPublicVideo(env, account.id, "M7lc1UVf-VE");
      expect(video.title).toBe("Real title");
      expect(video.channelId).toBe(channelId);
      expect(video.manual).toBe(true);
      expect(video.watched).toBe(false);
      const suggestions = await getPublicSuggestions(env, account.id, video.id);
      expect(suggestions.map((v) => v.id)).toEqual([relatedId]);
      expect(suggestions[0].channelTitle).toBe("Another channel");
      const count = calls.length;
      await getPublicVideo(env, account.id, video.id);
      await getPublicSuggestions(env, account.id, video.id);
      expect(calls).toHaveLength(count);
      expect(calls.filter((path) => path.endsWith("/search"))).toHaveLength(1);
      await env.DB.prepare(
        "INSERT INTO accounts (id,mode,connected,created_at,updated_at) VALUES ('search-partner','real',1,?,?)",
      )
        .bind(oldDate, oldDate)
        .run();
      await setManualWatchState(env.DB, "search-partner", relatedId, true);
      const partnerSuggestions = await getPublicSuggestions(
        env,
        "search-partner",
        video.id,
      );
      expect(partnerSuggestions[0].watched).toBe(true);
      expect(
        (await getPublicSuggestions(env, account.id, video.id))[0].watched,
      ).toBe(false);
      expect(calls).toHaveLength(count);
    } finally {
      vi.unstubAllGlobals();
      delete env.YOUTUBE_API_KEY;
    }
  });
  it("falls back when tag searches have no candidates and keeps private query caches per owner", async () => {
    const privateId = "prvRelated1",
      publicId = "related0001",
      titleQueries: string[] = [];
    await env.DB.prepare(
      "INSERT INTO accounts(id,mode,connected,created_at,updated_at) VALUES ('related-private-b','real',1,?,?)",
    )
      .bind(oldDate, oldDate)
      .run();
    for (const [owner, title] of [
      [account.id, "React hooks"],
      ["related-private-b", "Rust memoria"],
    ])
      await env.DB.batch(
        privateVideoStatements(
          env.DB,
          owner,
          {
            id: privateId,
            channelId: "UC" + "z".repeat(22),
            channelTitle: "Private",
            title,
            description: "",
            thumbnailUrl: "",
            publishedAt: oldDate,
            durationSeconds: 300,
            viewCount: 0,
            source: "youtube",
          },
          new Date().toISOString(),
          future,
          true,
        ),
      );
    const publicItem = (id: string) => ({
      id,
      snippet: {
        title: id === publicId ? "React hooks" : "Useful result",
        tags: id === publicId ? ["frameworkcode", "ecosystem"] : [],
        channelId: "UC" + "z".repeat(22),
        channelTitle: "Public",
        description: "",
        publishedAt: oldDate,
        liveBroadcastContent: "none",
      },
      status: { privacyStatus: "public" },
      contentDetails: { duration: "PT5M" },
    });
    env.YOUTUBE_API_KEY = "fixture-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/videos"))
          return Response.json({
            items: url.searchParams
              .get("id")!
              .split(",")
              .filter((id) => id !== privateId)
              .map(publicItem),
          });
        if (url.pathname.endsWith("/search")) {
          const q = url.searchParams.get("q")!;
          titleQueries.push(q);
          return Response.json({
            items:
              q === "frameworkcode ecosystem"
                ? []
                : [{ id: { videoId: "related0002" } }],
          });
        }
        throw new Error("Unexpected fixture endpoint");
      }),
    );
    try {
      await getPublicSuggestions(env, account.id, privateId);
      await getPublicSuggestions(env, "related-private-b", privateId);
      await getPublicSuggestions(env, account.id, privateId);
      expect(titleQueries).toEqual(["React hooks", "Rust memoria"]);
      const keys = await env.DB.prepare(
        "SELECT cache_key FROM public_read_cache WHERE cache_key LIKE 'search:v4:%:prvRelated1'",
      ).all<{ cache_key: string }>();
      expect(keys.results?.map((r) => r.cache_key).sort()).toEqual(
        [
          `search:v4:${account.id}:${privateId}`,
          `search:v4:related-private-b:${privateId}`,
        ].sort(),
      );
      await env.DB.prepare("DELETE FROM public_read_cache WHERE cache_key=?")
        .bind(`search:v4:${account.id}:${privateId}`)
        .run();
      await env.DB.prepare("UPDATE accounts SET connected=0 WHERE id=?")
        .bind(account.id)
        .run();
      await getPublicSuggestions(env, account.id, privateId);
      expect(
        await env.DB.prepare(
          "SELECT cache_key FROM public_read_cache WHERE cache_key=?",
        )
          .bind(`search:v4:${account.id}:${privateId}`)
          .first(),
      ).toBeNull();
      await env.DB.prepare("UPDATE accounts SET connected=1 WHERE id=?")
        .bind(account.id)
        .run();
      await getPublicSuggestions(env, account.id, publicId);
      expect(titleQueries.slice(-2)).toEqual([
        "frameworkcode ecosystem",
        "React hooks",
      ]);
      const count = titleQueries.length;
      await getPublicSuggestions(env, account.id, publicId);
      expect(titleQueries).toHaveLength(count);
    } finally {
      vi.unstubAllGlobals();
      delete env.YOUTUBE_API_KEY;
    }
  });
  it("supports paginated public comment and reply reads without OAuth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        expect(new Headers(init.headers).get("x-goog-api-key")).toBe(
          "mock-key",
        );
        expect(url.searchParams.get("textFormat")).toBe("plainText");
        if (url.pathname.endsWith("/commentThreads")) {
          expect(url.searchParams.get("pageToken")).toBe("next-thread");
          return Response.json({ items: [], nextPageToken: "thread-page-3" });
        }
        expect(url.searchParams.get("parentId")).toBe("comment-one");
        expect(url.searchParams.get("pageToken")).toBe("next-reply");
        return Response.json({ items: [], nextPageToken: "reply-page-3" });
      }),
    );
    try {
      expect(
        (
          await listCommentThreads(
            { apiKey: "mock-key" },
            "M7lc1UVf-VE",
            "next-thread",
          )
        ).nextPageToken,
      ).toBe("thread-page-3");
      expect(
        (
          await listCommentReplies(
            { apiKey: "mock-key" },
            "comment-one",
            "next-reply",
          )
        ).nextPageToken,
      ).toBe("reply-page-3");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("does not return fabricated public metadata when YouTube rejects the key", async () => {
    env.YOUTUBE_API_KEY = "mock-invalid-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { errors: [{ reason: "keyInvalid" }] } },
          { status: 403 },
        ),
      ),
    );
    try {
      await expect(
        getPublicVideo(env, account.id, "badVID00001"),
      ).rejects.toMatchObject({ reason: "keyinvalid", status: 502 });
    } finally {
      vi.unstubAllGlobals();
      delete env.YOUTUBE_API_KEY;
    }
  });
  it("discovers and lists 113 subscriptions with bounded RSS concurrency and owner-based feed membership", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO accounts (id,mode,name,connected,scopes,created_at,updated_at) VALUES ('rss-test','real','RSS fixture',1,'',?,?)`,
    )
      .bind(now, now)
      .run();
    const rssAccount = (await env.DB.prepare(
      "SELECT * FROM accounts WHERE id=?",
    )
      .bind("rss-test")
      .first<AccountRow>())!;
    for (let index = 0; index < 113; index++) {
      const id = "UCbatch" + String(index).padStart(2, "0");
      await upsertExternalChannel(
        env.DB,
        { id, title: "RSS fixture", description: "", thumbnailUrl: null },
        future,
      );
      await upsertRemoteSubscription(env.DB, rssAccount.id, id, null);
    }
    let concurrent = 0,
      maxConcurrent = 0,
      calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const id = new URL(input).searchParams.get("channel_id")!;
        calls++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 2));
        concurrent--;
        if (new Headers(init.headers).get("if-none-match") === "fixture-v1")
          return new Response(null, { status: 304 });
        const videoId = String(Number(id.replace("UCbatch", ""))).padStart(
          11,
          "0",
        );
        const ownerId = id.endsWith("00") ? "UCdifferentOwner" : id;
        return new Response(
          `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><id>yt:channel:${id}</id><title>RSS fixture</title><entry><yt:videoId>${videoId}</yt:videoId><yt:channelId>${ownerId}</yt:channelId><author><name>Video owner fixture</name></author><title>RSS fixture video</title><published>${new Date().toISOString()}</published></entry></feed>`,
          { headers: { etag: "fixture-v1" } },
        );
      }),
    );
    try {
      const result = await handleSync(env, rssAccount, "rss");
      expect(calls).toBe(113);
      expect(maxConcurrent).toBeLessThanOrEqual(5);
      expect(result.status).toBe("success");
      expect(result.items).toBe(113);
      expect(JSON.parse(result.detail!)).toMatchObject({
        processed: 113,
        complete: true,
        pending: 0,
      });
      const feed = await listFeed(
        env.DB,
        rssAccount.id,
        { status: "all", channelId: null, cursor: null, limit: 150 },
        "external",
      );
      expect(feed.items).toHaveLength(111);
      const channels = await listChannels(
        env.DB,
        rssAccount.id,
        null,
        "external",
      );
      expect(channels.filter((channel) => channel.subscribed)).toHaveLength(
        113,
      );
      // Entries 0 and 100 declare UCdifferentOwner as their owner (their feed
      // channel ids happen to end with "00"). They keep that owner and do not
      // leak into UCbatch00's subscription feed.
      expect(feed.items.map((v) => v.id)).not.toContain("00000000000");
      expect(feed.items.map((v) => v.id)).not.toContain("00000000100");
      const misattributed = await getVideo(
        env.DB,
        rssAccount.id,
        "00000000000",
        "external",
      );
      expect(misattributed?.channelId).toBe("UCdifferentOwner");
      expect(misattributed?.watched).toBe(false);
      const channelFeed = await listFeed(
        env.DB,
        rssAccount.id,
        { status: "all", channelId: "UCbatch00", cursor: null, limit: 20 },
        "external",
      );
      expect(channelFeed.items).toEqual([]);
      const ownerFeed = await listFeed(
        env.DB,
        rssAccount.id,
        {
          status: "all",
          channelId: "UCdifferentOwner",
          cursor: null,
          limit: 20,
        },
        "external",
      );
      expect(ownerFeed.items.map((v) => v.id)).toEqual([
        "00000000100",
        "00000000000",
      ]);
      expect(
        await bulkWatchState(env.DB, rssAccount.id, {
          scope: "all",
          channelId: null,
          before: null,
          watched: true,
        }),
      ).toBe(111);
      const again = await handleSync(env, rssAccount, "rss");
      expect(again.items).toBe(0);
      expect(
        (
          await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM video_discoveries",
          ).first<{ count: number }>()
        )?.count,
      ).toBe(0);
      // Following the actual owner exposes both entries without rewriting the
      // stored owner or the feed-channel subscription.
      await upsertExternalChannel(
        env.DB,
        {
          id: "UCdifferentOwner",
          title: "Different owner",
          description: "",
          thumbnailUrl: null,
        },
        future,
      );
      await upsertRemoteSubscription(
        env.DB,
        rssAccount.id,
        "UCdifferentOwner",
        null,
      );
      const ownerSubscribed = await listFeed(
        env.DB,
        rssAccount.id,
        { status: "all", channelId: null, cursor: null, limit: 150 },
        "external",
      );
      expect(ownerSubscribed.items).toHaveLength(113);
      expect(
        (
          await env.DB.prepare(
            "SELECT channel_id FROM videos WHERE id='00000000000'",
          ).first<{ channel_id: string }>()
        )?.channel_id,
      ).toBe("UCdifferentOwner");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30000);
  it("reports partial RSS while a failed feed is awaiting retry, instead of claiming completion", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO accounts (id,mode,name,connected,scopes,created_at,updated_at) VALUES ('rss-fail-test','real','RSS failure fixture',1,'',?,?)`,
    )
      .bind(now, now)
      .run();
    const rssAccount = (await env.DB.prepare(
      "SELECT * FROM accounts WHERE id=?",
    )
      .bind("rss-fail-test")
      .first<AccountRow>())!;
    await upsertExternalChannel(
      env.DB,
      {
        id: "UCfailureFixture",
        title: "RSS failure fixture",
        description: "",
        thumbnailUrl: null,
      },
      future,
    );
    await upsertRemoteSubscription(
      env.DB,
      rssAccount.id,
      "UCfailureFixture",
      null,
    );
    const request = vi.fn(
      async () => new Response("Unavailable", { status: 503 }),
    );
    vi.stubGlobal("fetch", request);
    try {
      const first = await handleSync(env, rssAccount, "rss");
      expect(first.status).toBe("partial");
      expect(JSON.parse(first.detail!)).toMatchObject({
        failed: 1,
        complete: false,
        pending: 1,
      });
      const second = await handleSync(env, rssAccount, "rss");
      expect(second.status).toBe("partial");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("uses account+channel KV validators for legacy RSS without touching D1 channel success fields", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO accounts(id,mode,connected,created_at,updated_at) VALUES ('legacy-kv','real',1,?,?)",
    )
      .bind(now, now)
      .run();
    const legacyAccount = (await env.DB.prepare(
      "SELECT * FROM accounts WHERE id='legacy-kv'",
    ).first<AccountRow>())!;
    const channelId = "UClegacy-kv";
    await upsertExternalChannel(
      env.DB,
      { id: channelId, title: "Legacy KV", description: "", thumbnailUrl: null },
      future,
    );
    await upsertRemoteSubscription(env.DB, legacyAccount.id, channelId, null);
    await env.DB.prepare(
      "UPDATE channels SET rss_etag='sentinel',rss_last_modified='sentinel',last_synced_at='2020-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(channelId)
      .run();

    const store = new Map<string, string>();
    let failGet = false;
    const kv = {
      get: async (key: string) => {
        if (failGet) throw new Error("KV unavailable");
        return store.get(key) ?? null;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    } as unknown as KVNamespace;
    const rssEnv: Env = { ...env, READ_CACHE: kv };
    const conditional: Array<string | null> = [];
    let extra: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, init: RequestInit) => {
        const ifNoneMatch = new Headers(init.headers).get("if-none-match");
        conditional.push(ifNoneMatch);
        if (ifNoneMatch === "legacy-etag")
          return new Response(null, { status: 304 });
        return new Response(
          '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Legacy KV</title>' +
            `<entry><yt:videoId>LegacyOld01</yt:videoId><yt:channelId>${channelId}</yt:channelId><title>Old</title><published>2020-01-01T00:00:00Z</published></entry>` +
            `<entry><yt:videoId>Legacy00001</yt:videoId><yt:channelId>${channelId}</yt:channelId><title>One</title><published>${new Date().toISOString()}</published></entry>` +
            (extra
              ? `<entry><yt:videoId>${extra}</yt:videoId><yt:channelId>${channelId}</yt:channelId><title>Two</title><published>${new Date().toISOString()}</published></entry>`
              : "") +
            "</feed>",
          { headers: { etag: "legacy-etag" } },
        );
      }),
    );
    try {
      const first = await handleSync(rssEnv, legacyAccount, "rss");
      expect(first.items).toBe(1);
      expect(conditional).toEqual([null]);
      expect(
        await getVideo(env.DB, legacyAccount.id, "LegacyOld01", "external"),
      ).toBeNull();
      expect(store.size).toBe(1);

      const second = await handleSync(rssEnv, legacyAccount, "rss");
      expect(second.items).toBe(0);
      expect(conditional).toEqual([null, "legacy-etag"]);

      await writeRssCheck(rssEnv, legacyAccount.id, channelId, {
        checkedAt: new Date(Date.now() - 25 * 3600000).toISOString(),
        etag: "stale",
        lastModified: null,
      });
      extra = "Legacy00002";
      const stale = await handleSync(rssEnv, legacyAccount, "rss");
      expect(stale.items).toBe(1);
      expect(conditional).toEqual([null, "legacy-etag", null]);

      failGet = true;
      extra = "Legacy00003";
      const fallback = await handleSync(rssEnv, legacyAccount, "rss");
      expect(fallback.items).toBe(1);
      expect(conditional).toEqual([null, "legacy-etag", null, null]);
      expect(
        await env.DB.prepare(
          "SELECT rss_etag,rss_last_modified,last_synced_at FROM channels WHERE id=?",
        )
          .bind(channelId)
          .first<{
            rss_etag: string;
            rss_last_modified: string;
            last_synced_at: string;
          }>(),
      ).toEqual({
        rss_etag: "sentinel",
        rss_last_modified: "sentinel",
        last_synced_at: "2020-01-01T00:00:00.000Z",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reports pending playlists instead of claiming the three-list batch imported everything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/playlists"))
          return Response.json({
            items: Array.from({ length: 10 }, (_, i) => ({
              id: "PLfixture" + i,
              snippet: { title: "List fixture " + i },
              contentDetails: { itemCount: 0 },
              status: { privacyStatus: "private" },
            })),
          });
        if (url.pathname.endsWith("/playlistItems"))
          return Response.json({ items: [] });
        throw new Error("Unexpected mocked endpoint");
      }),
    );
    try {
      const result = await handleSync(env, account, "playlists");
      expect(result.status).toBe("partial");
      expect(JSON.parse(result.detail!)).toMatchObject({
        importedPlaylists: 10,
        pendingPlaylists: 7,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("bounds Free RSS to one channel, resumes its cursor and preserves imported snapshots", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO accounts (id,mode,connected,created_at,updated_at) VALUES ('free-test','real',1,?,?)",
    )
      .bind(now, now)
      .run();
    const freeAccount = (await env.DB.prepare(
      "SELECT * FROM accounts WHERE id='free-test'",
    ).first<AccountRow>())!;
    for (const id of ["UCfree0", "UCfree1"]) {
      await upsertExternalChannel(
        env.DB,
        { id, title: "Free fixture", description: "", thumbnailUrl: null },
        future,
      );
      await upsertRemoteSubscription(env.DB, freeAccount.id, id, null);
    }
    let statements = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (...args: Parameters<D1Database["prepare"]>) => {
            statements++;
            return target.prepare(...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const freeEnv: Env = { ...env, DB: db, SYNC_PROFILE: "free" };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const id = new URL(input).searchParams.get("channel_id")!;
        calls.push(id);
        const entries = Array.from({ length: 15 }, (_, i) => {
          const n = (id.endsWith("0") ? 70000 : 70100) + i;
          return `<entry><yt:videoId>${String(n).padStart(11, "0")}</yt:videoId><yt:channelId>UCowner${n}</yt:channelId><title>Free fixture ${n}</title><published>${new Date().toISOString()}</published></entry>`;
        }).join("");
        return new Response(
          `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Free fixture</title>${entries}</feed>`,
        );
      }),
    );
    try {
      const first = await handleSync(freeEnv, freeAccount, "rss");
      expect(calls).toEqual(["UCfree0"]);
      expect(first.items).toBe(6);
      expect(first.status).toBe("partial");
      expect(JSON.parse(first.detail!)).toMatchObject({
        processed: 1,
        pending: 1,
      });
      // Reserve six queries for HTTP session/account/retention middleware.
      expect(statements).toBeLessThanOrEqual(44);
      statements = 0;
      const second = await handleSync(freeEnv, freeAccount, "rss");
      expect(calls).toEqual(["UCfree0", "UCfree1"]);
      expect(second.items).toBe(6);
      expect(second.status).toBe("success");
      expect(statements).toBeLessThanOrEqual(44);
      await expect(
        handleSync(freeEnv, freeAccount, "playlists"),
      ).rejects.toMatchObject({ status: 503, code: "SYNC_NOT_AVAILABLE" });
      expect(calls).toHaveLength(2);
      const subscriptions = await env.DB.prepare(
        "SELECT count(*) AS n FROM subscriptions WHERE account_id='free-test' AND active=1",
      ).first<{ n: number }>();
      expect(subscriptions?.n).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("switches Google users in the same browser without relinking private data, and fails closed without identity", async () => {
    let channelId = "UC" + "c".repeat(22);
    let identityUnavailable = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        if (
          url.hostname === "oauth2.googleapis.com" &&
          url.pathname === "/token"
        )
          return Response.json({
            access_token: "fixture-access-" + channelId,
            refresh_token: "fixture-refresh-" + channelId,
            expires_in: 3600,
            token_type: "Bearer",
            scope: "https://www.googleapis.com/auth/youtube.readonly",
          });
        if (url.pathname.endsWith("/channels"))
          return Response.json({
            items: identityUnavailable
              ? []
              : [
                  {
                    id: channelId,
                    snippet: {
                      title: channelId.endsWith("c") ? "Person A" : "Person B",
                    },
                  },
                ],
          });
        throw new Error("Unexpected fixture endpoint");
      }),
    );
    async function login(cookie = "") {
      const start = await worker.fetch(
        new Request(env.APP_ORIGIN + "/auth/google/start", {
          headers: cookie ? { cookie } : {},
        }),
        env,
      );
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get("location")!).searchParams.get(
        "state",
      )!;
      const sessionCookie =
        start.headers.get("set-cookie")?.split(";")[0] || cookie;
      const callback = await worker.fetch(
        new Request(
          env.APP_ORIGIN +
            "/auth/google/callback?code=fixture&state=" +
            encodeURIComponent(state),
          { headers: { cookie: sessionCookie } },
        ),
        env,
      );
      return {
        response: callback,
        cookie:
          callback.headers.get("set-cookie")?.split(";")[0] || sessionCookie,
      };
    }
    try {
      const a = await login();
      expect(a.response.headers.get("location")).toContain("connected=1");
      const accountA = (await env.DB.prepare(
        "SELECT * FROM accounts WHERE youtube_channel_id=?",
      )
        .bind(channelId)
        .first<AccountRow>())!;
      await upsertExternalChannel(
        env.DB,
        {
          id: channelId,
          title: "Channel A",
          description: "",
          thumbnailUrl: null,
        },
        future,
      );
      await upsertRemoteSubscription(env.DB, accountA.id, channelId, null);
      await externalVideoStatement(
        env.DB,
        {
          id: "AuthTest001",
          channelId,
          channelTitle: "Channel A",
          title: "Account A video",
          description: "",
          thumbnailUrl: "",
          publishedAt: oldDate,
          durationSeconds: 100,
          viewCount: null,
          source: "youtube",
        },
        future,
      ).run();
      await env.DB.batch(
        privateVideoStatements(
          env.DB,
          accountA.id,
          {
            id: "AuthTest001",
            channelId,
            channelTitle: "Channel A",
            title: "Account A video",
            description: "",
            thumbnailUrl: "",
            publishedAt: oldDate,
            durationSeconds: 100,
            viewCount: null,
            source: "youtube",
          },
          oldDate,
          future,
          true,
        ),
      );
      await setManualWatchState(env.DB, accountA.id, "AuthTest001", true);
      await env.DB.prepare(
        "INSERT INTO playlists (id,account_id,source,title,created_at,updated_at) VALUES ('private-a',?,'local','Only person A',?,?)",
      )
        .bind(accountA.id, oldDate, oldDate)
        .run();
      await env.DB.prepare(
        "INSERT INTO playlist_items (id,playlist_id,video_id,position,added_at) VALUES ('private-item','private-a','AuthTest001',0,?)",
      )
        .bind(oldDate)
        .run();
      channelId = "UC" + "d".repeat(22);
      const b = await login(a.cookie);
      expect(b.response.headers.get("location")).toContain("connected=1");
      const accountB = (await env.DB.prepare(
        "SELECT * FROM accounts WHERE youtube_channel_id=?",
      )
        .bind(channelId)
        .first<AccountRow>())!;
      expect(accountB.id).not.toBe(accountA.id);
      expect(
        (
          await env.DB.prepare(
            "SELECT youtube_channel_id AS id FROM accounts WHERE id=?",
          )
            .bind(accountA.id)
            .first<{ id: string }>()
        )?.id,
      ).toBe("UC" + "c".repeat(22));
      await upsertRemoteSubscription(
        env.DB,
        accountB.id,
        "UC" + "c".repeat(22),
        null,
      );
      const feedB = await worker.fetch(
        new Request(env.APP_ORIGIN + "/api/feed", {
          headers: { cookie: b.cookie },
        }),
        env,
      );
      expect(feedB.status).toBe(200);
      expect(((await feedB.json()) as { items: unknown[] }).items).toEqual([]);
      const privatePlaylist = await worker.fetch(
        new Request(env.APP_ORIGIN + "/api/playlists/private-a", {
          headers: { cookie: b.cookie },
        }),
        env,
      );
      expect(privatePlaylist.status).toBe(404);
      expect(
        await getVideo(env.DB, accountB.id, "AuthTest001", "external"),
      ).toBeNull();
      expect(
        (await getVideo(env.DB, accountA.id, "AuthTest001", "external"))
          ?.watched,
      ).toBe(true);
      const before = await env.DB.prepare(
        "SELECT access_token_enc FROM oauth_tokens WHERE account_id=?",
      )
        .bind(accountB.id)
        .first<{ access_token_enc: string }>();
      identityUnavailable = true;
      const failed = await login(b.cookie);
      expect(failed.response.headers.get("location")).toContain(
        "connect=error",
      );
      expect(
        await env.DB.prepare(
          "SELECT access_token_enc FROM oauth_tokens WHERE account_id=?",
        )
          .bind(accountB.id)
          .first(),
      ).toEqual(before);
      const session = await worker.fetch(
        new Request(env.APP_ORIGIN + "/api/session", {
          headers: { cookie: b.cookie },
        }),
        env,
      );
      expect(
        ((await session.json()) as { account: { name: string } }).account.name,
      ).toBe("Person B");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("imports a new Free account in resumable subscription pages without deactivating a partial snapshot or touching another user", async () => {
    const id = "free-subscriptions";
    await env.DB.prepare(
      "INSERT INTO accounts (id,mode,connected,created_at,updated_at) VALUES (?,'real',1,?,?)",
    )
      .bind(id, oldDate, oldDate)
      .run();
    const owner = (await env.DB.prepare("SELECT * FROM accounts WHERE id=?")
      .bind(id)
      .first<AccountRow>())!;
    await env.DB.prepare(
      "INSERT INTO oauth_tokens (account_id,access_token_enc,expires_at,updated_at) VALUES (?,?,?,?)",
    )
      .bind(
        id,
        await encryptToken(env.TOKEN_ENCRYPTION_KEY!, "own-fixture-token"),
        future,
        oldDate,
      )
      .run();
    await upsertExternalChannel(
      env.DB,
      { id: "UCold-free", title: "Old", description: "", thumbnailUrl: null },
      future,
    );
    await upsertRemoteSubscription(env.DB, id, "UCold-free", null);
    await env.DB.prepare(
      "UPDATE subscriptions SET generation='previous',updated_at=? WHERE account_id=?",
    )
      .bind(oldDate, id)
      .run();
    const otherBefore = await env.DB.prepare(
      "SELECT count(*) AS n FROM subscriptions WHERE account_id=? AND active=1",
    )
      .bind(account.id)
      .first();
    let fail = false;
    const pages: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        expect(url.pathname.endsWith("/subscriptions")).toBe(true);
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer own-fixture-token",
        );
        expect(url.searchParams.get("maxResults")).toBe("8");
        const page = url.searchParams.get("pageToken");
        pages.push(page);
        if (fail)
          return Response.json(
            { error: { errors: [{ reason: "backendError" }] } },
            { status: 503 },
          );
        return Response.json(
          page
            ? { items: [] }
            : {
                items: [
                  {
                    id: "remote-sub",
                    snippet: {
                      title: "New channel",
                      resourceId: { channelId: "UCnew-free" },
                    },
                  },
                ],
                nextPageToken: "second",
              },
        );
      }),
    );
    const freeEnv: Env = { ...env, SYNC_PROFILE: "free" };
    try {
      const first = await handleSync(freeEnv, owner, "all");
      expect(first).toMatchObject({
        type: "subscriptions",
        status: "partial",
        more: true,
        items: 1,
      });
      expect(
        (
          await env.DB.prepare(
            "SELECT active FROM subscriptions WHERE account_id=? AND channel_id='UCold-free'",
          )
            .bind(id)
            .first<{ active: number }>()
        )?.active,
      ).toBe(1);
      const saved = await env.DB.prepare(
        "SELECT cursor FROM sync_state WHERE account_id=? AND type='subscriptions'",
      )
        .bind(id)
        .first();
      fail = true;
      await expect(handleSync(freeEnv, owner, "all")).rejects.toMatchObject({
        status: 502,
      });
      expect(
        await env.DB.prepare(
          "SELECT cursor FROM sync_state WHERE account_id=? AND type='subscriptions'",
        )
          .bind(id)
          .first(),
      ).toEqual(saved);
      fail = false;
      expect(await handleSync(freeEnv, owner, "all")).toMatchObject({
        type: "subscriptions",
        status: "success",
        more: true,
      });
      expect(pages).toEqual([null, "second", "second"]);
      expect(
        (
          await env.DB.prepare(
            "SELECT active FROM subscriptions WHERE account_id=? AND channel_id='UCold-free'",
          )
            .bind(id)
            .first<{ active: number }>()
        )?.active,
      ).toBe(0);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM subscriptions WHERE account_id=? AND active=1",
        )
          .bind(account.id)
          .first(),
      ).toEqual(otherBefore);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("bounds streaming bytes, including multi-byte characters", async () => {
    await expect(
      readLimitedText(new Response("😀😀"), 7),
    ).rejects.toMatchObject({ status: 413 });
    await expect(readLimitedText(new Response("😀😀"), 8)).resolves.toBe(
      "😀😀",
    );
  });
});
