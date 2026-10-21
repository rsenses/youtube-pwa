import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { AccountRow, Env } from "../worker/types";
import { encryptToken, handleDeleteAccountData } from "../worker/auth";
import {
  consumeSyncQueue,
  recoverAndScheduleSync,
  startQueuedSync,
  queuedSyncStatus,
  type SyncMessage,
} from "../worker/queue-sync";
import {
  getVideo,
  getPlaylistItems,
  externalVideoStatement,
  purgeExpiredMetadata,
} from "../worker/db";
import { privateVideoStatements } from "../worker/private-metadata";

let mf: Miniflare, env: Env, account: AccountRow;
let pending: Array<{ body: SyncMessage; retry?: boolean }>,
  published: SyncMessage[];
let failSend: boolean,
  failMark: boolean,
  statements: number,
  maxStatements: number;
let failItems: boolean, failFeed: boolean;
const future = "2099-01-01T00:00:00.000Z";
const old = "2020-01-01T00:00:00.000Z";
const channels = ["UC" + "a".repeat(22), "UC" + "b".repeat(22)];
const video = (id: string, privateRead = false) => ({
  id,
  status: { privacyStatus: privateRead ? "private" : "public" },
  snippet: {
    title: (privateRead ? "Private " : "Public ") + id,
    description: "Details " + id,
    channelId: privateRead ? "UC" + "c".repeat(22) : channels[0],
    channelTitle: "Provider channel",
    publishedAt: "2026-10-01T00:00:00Z",
    liveBroadcastContent: "none",
  },
  contentDetails: { duration: "PT5M" },
  statistics: { viewCount: "12" },
});

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: "2026-10-20",
      d1Databases: ["DB"],
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const name of [
    "0001_init.sql",
    "0002_video_details.sql",
    "0003_public_read_cache.sql",
    "0004_video_discoveries.sql",
    "0005_queued_sync.sql",
    "0006_retention_indexes.sql",
    "0007_video_broadcast_status.sql",
    // Exercise compatibility before optional watermark backfill migration 0008.
  ]) {
    const sql = (
      await readFile(new URL("../migrations/" + name, import.meta.url), "utf8")
    ).replace(/^\s*--.*$/gm, "");
    await db.batch(
      sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
  pending = [];
  published = [];
  failSend = false;
  failMark = false;
  failItems = false;
  failFeed = false;
  statements = 0;
  maxStatements = 0;
  const counting = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          statements++;
          const stmt = target.prepare(sql);
          if (!sql.includes("SET enqueued_version=")) return stmt;
          return new Proxy(stmt, {
            get(t, k) {
              if (k === "bind")
                return (...args: unknown[]) => {
                  const bound = t.bind(...args);
                  return new Proxy(bound, {
                    get(b, m) {
                      if (m === "run")
                        return async () => {
                          if (failMark) {
                            failMark = false;
                            throw new Error("fixture crash after broker send");
                          }
                          return b.run();
                        };
                      const v = Reflect.get(b, m, b);
                      return typeof v === "function" ? v.bind(b) : v;
                    },
                  });
                };
              const v = Reflect.get(t, k, t);
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  env = {
    DB: counting,
    MODE: "real",
    APP_ORIGIN: "http://localhost:5173",
    SYNC_PROFILE: "free",
    GOOGLE_CLIENT_ID: "fixture",
    GOOGLE_CLIENT_SECRET: "fixture",
    TOKEN_ENCRYPTION_KEY: "fixture-encryption-key-not-a-credential",
    YOUTUBE_API_KEY: "fixture-public-key",
    SYNC_QUEUE: {
      async send(body: SyncMessage) {
        if (failSend) {
          failSend = false;
          throw new Error("fixture broker unavailable");
        }
        published.push({ ...body });
        pending.push({ body: { ...body } });
      },
    },
  } as unknown as Env;
  await env.DB.prepare(
    "INSERT INTO accounts(id,mode,name,connected,scopes,created_at,updated_at) VALUES ('owner','real','Owner',1,'readonly',?,?)",
  )
    .bind(old, old)
    .run();
  account = (await env.DB.prepare(
    "SELECT * FROM accounts WHERE id='owner'",
  ).first<AccountRow>())!;
  await env.DB.prepare(
    "INSERT INTO oauth_tokens(account_id,access_token_enc,expires_at,updated_at) VALUES (?,?,?,?)",
  )
    .bind(
      account.id,
      await encryptToken(env.TOKEN_ENCRYPTION_KEY!, "fixture-owner-access"),
      future,
      old,
    )
    .run();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const h = new Headers(init.headers);
      if (url.pathname.endsWith("/subscriptions")) {
        expect(h.get("authorization")).toBe("Bearer fixture-owner-access");
        return Response.json({
          items: [
            {
              id: "remote-" + (url.searchParams.get("pageToken") ? "b" : "a"),
              snippet: {
                title: "Channel",
                resourceId: {
                  channelId:
                    channels[url.searchParams.has("pageToken") ? 1 : 0],
                },
              },
            },
          ],
          ...(url.searchParams.has("pageToken")
            ? {}
            : { nextPageToken: "sub2" }),
        });
      }
      if (url.pathname.endsWith("/videos.xml")) {
        if (failFeed) return new Response("missing", { status: 404 });
        const channel = url.searchParams.get("channel_id")!;
        const base = channel === channels[0] ? 10000 : 10100;
        const entries = Array.from(
          { length: 15 },
          (_, i) =>
            `<entry><yt:videoId>${String(base + i).padStart(11, "0")}</yt:videoId><yt:channelId>${channel}</yt:channelId><title>Public ${String(base + i).padStart(11, "0")}</title><published>2026-10-01T00:00:00Z</published></entry>`,
        ).join("");
        return new Response(
          `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Channel</title>${entries}</feed>`,
        );
      }
      if (url.pathname.endsWith("/playlists"))
        return Response.json({
          items: [
            {
              id: "PLqueue",
              snippet: { title: "Private list" },
              contentDetails: { itemCount: 11 },
              status: { privacyStatus: "private" },
            },
          ],
        });
      if (url.pathname.endsWith("/playlistItems")) {
        if (failItems && url.searchParams.has("pageToken"))
          return Response.json(
            { error: { errors: [{ reason: "backendError" }] } },
            { status: 503 },
          );
        const start = url.searchParams.has("pageToken") ? 10 : 0;
        const count = start ? 1 : 10;
        return Response.json({
          items: Array.from({ length: count }, (_, i) => ({
            id: "remote-item-" + (start + i),
            snippet: {
              title: "Private snippet " + (start + i),
              description: "Only owner",
              position: start + i,
              publishedAt: "2026-10-01T00:00:00Z",
              resourceId: {
                videoId: "priv" + String(start + i).padStart(7, "0"),
              },
              videoOwnerChannelId: "UC" + "c".repeat(22),
              videoOwnerChannelTitle: "Private owner",
            },
            contentDetails: {
              videoId: "priv" + String(start + i).padStart(7, "0"),
            },
          })),
          ...(start ? {} : { nextPageToken: "items2" }),
        });
      }
      if (url.pathname.endsWith("/videos")) {
        const ids = url.searchParams.get("id")!.split(",");
        const privateRead = h.has("authorization");
        if (!privateRead)
          expect(ids.every((id) => !id.startsWith("priv"))).toBe(true);
        return Response.json({
          items: ids.map((id) => video(id, privateRead)),
        });
      }
      throw new Error("Unexpected fixture endpoint " + url.pathname);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});
async function deliver(entry: { body: SyncMessage; retry?: boolean }) {
  if (entry.retry)
    await env.DB.prepare(
      "UPDATE sync_jobs SET next_attempt_at=NULL,lease_expires_at=NULL WHERE id=?",
    )
      .bind(entry.body.jobId)
      .run();
  statements = 0;
  let acked = false;
  await consumeSyncQueue(
    {
      messages: [
        {
          body: entry.body,
          id: "fixture",
          timestamp: new Date(),
          attempts: 1,
          ack() {
            acked = true;
          },
          retry() {
            pending.push({ body: { ...entry.body }, retry: true });
          },
        },
      ],
    } as unknown as MessageBatch<SyncMessage>,
    env,
  );
  maxStatements = Math.max(maxStatements, statements);
  expect(statements).toBeLessThanOrEqual(50);
  return acked;
}
async function drain() {
  let n = 0;
  while (pending.length) {
    if (n++ > 500) throw new Error("Unbounded queue fixture");
    await deliver(pending.shift()!);
  }
}

async function catalog() {
  await startQueuedSync(env, account, "playlists");
  await drain();
  return (await env.DB.prepare(
    "SELECT id FROM playlists WHERE account_id=? AND source='youtube' LIMIT 1",
  )
    .bind(account.id)
    .first<{ id: string }>())!.id;
}
async function importLibrary() {
  await startQueuedSync(env, account, "all");
  await drain();
  const id = await catalog();
  await startQueuedSync(env, account, "playlists", true, id);
  await drain();
  return id;
}
describe("durable queue synchronization", () => {
  it("does not reimport old RSS, unchanged playlists or old details on the next normal update", async () => {
    await importLibrary();
    await env.DB.prepare(
      "UPDATE playlists SET items_synced_at=? WHERE account_id=?",
    )
      .bind(old, account.id)
      .run();
    const previous = await env.DB.prepare(
      "SELECT last_run_at FROM sync_state WHERE account_id=? AND type='queue:all'",
    )
      .bind(account.id)
      .first<{ last_run_at: string }>();
    expect(previous?.last_run_at).toBeTruthy();
    const retained = (await env.DB.prepare(
      "SELECT count(*) AS n FROM playlist_items",
    ).first<{ n: number }>())!.n;
    vi.mocked(fetch).mockClear();
    const next = await startQueuedSync(env, account, "all");
    await drain();
    const calls = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => new URL(String(url)));
    expect(
      calls.filter((url) => url.pathname.endsWith("/videos")),
    ).toHaveLength(0);
    expect(
      calls.filter((url) => url.pathname.endsWith("/playlistItems")),
    ).toHaveLength(0);
    expect(
      calls.filter((url) => url.pathname.endsWith("/videos.xml")),
    ).toHaveLength(2);
    expect((await queuedSyncStatus(env, account.id))[0]).toMatchObject({
      status: "success",
      processedChannels: 2,
      processedPlaylists: 0,
    });
    const state = JSON.parse(
      (await env.DB.prepare("SELECT state FROM sync_jobs WHERE id=?")
        .bind(next.job.id)
        .first<{ state: string }>())!.state,
    );
    expect(state.since).toBe(previous!.last_run_at);
    expect(state.force).toBe(false);
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM playlist_items").first<{
        n: number;
      }>())!.n,
    ).toBe(retained);
  }, 15000);
  it("bootstraps a reactivated subscription without the publication cutoff", async () => {
    await startQueuedSync(env, account, "all");
    await drain();
    await env.DB.prepare(
      "UPDATE subscriptions SET active=0 WHERE account_id=? AND channel_id=?",
    )
      .bind(account.id, channels[0])
      .run();
    await startQueuedSync(env, account, "all");
    await drain();
    const row = await env.DB.prepare(
      "SELECT active,(SELECT last_run_at FROM sync_state WHERE account_id=subscriptions.account_id AND type='queue:rss:' || subscriptions.channel_id) AS rss_synced_at FROM subscriptions WHERE account_id=? AND channel_id=?",
    )
      .bind(account.id, channels[0])
      .first<{ active: number; rss_synced_at: string }>();
    expect(row?.active).toBe(1);
    expect(row?.rss_synced_at).toBeTruthy();
    expect(
      (await queuedSyncStatus(env, account.id))[0].items,
    ).toBeGreaterThanOrEqual(15);
  });
  it("includes the exact last-success boundary without overlap and does not advance a successful watermark after partial failure", async () => {
    await startQueuedSync(env, account, "all");
    await drain();
    const baseline = (await env.DB.prepare(
      "SELECT last_run_at FROM sync_state WHERE account_id=? AND type='queue:all'",
    )
      .bind(account.id)
      .first<{ last_run_at: string }>())!.last_run_at;
    const cutoff = Date.parse(baseline);
    await externalVideoStatement(
      env.DB,
      {
        id: "edge0000000",
        channelId: channels[0],
        channelTitle: "Channel",
        title: "Known old clip",
        description: "",
        thumbnailUrl: "",
        publishedAt: new Date(cutoff - 1).toISOString(),
        durationSeconds: 300,
        viewCount: 0,
        isLive: false,
        liveBroadcastContent: "none",
        source: "rss",
      },
      future,
    ).run();
    await env.DB.prepare(
      "INSERT INTO video_discoveries(video_id,channel_id,last_seen_at) VALUES (?,?,?)",
    )
      .bind("edge0000000", channels[0], new Date().toISOString())
      .run();
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        if (
          url.pathname.endsWith("/videos.xml") &&
          url.searchParams.get("channel_id") === channels[0]
        )
          return new Response(
            '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Channel</title>' +
              [-1, 0, 1]
                .map(
                  (delta, i) =>
                    `<entry><yt:videoId>edge000000${i}</yt:videoId><yt:channelId>${channels[0]}</yt:channelId><title>Boundary</title><published>${new Date(cutoff + delta).toISOString()}</published></entry>`,
                )
                .join("") +
              "</feed>",
          );
        return original(input, init);
      }),
    );
    await startQueuedSync(env, account, "all");
    await drain();
    expect(
      (await getVideo(env.DB, account.id, "edge0000000", "external"))?.title,
    ).toBe("Known old clip");
    expect(
      await getVideo(env.DB, account.id, "edge0000001", "external"),
    ).not.toBeNull();
    expect(
      await getVideo(env.DB, account.id, "edge0000002", "external"),
    ).not.toBeNull();
    const success = (await env.DB.prepare(
      "SELECT last_run_at FROM sync_state WHERE account_id=? AND type='queue:all'",
    )
      .bind(account.id)
      .first<{ last_run_at: string }>())!.last_run_at;
    vi.stubGlobal("fetch", original);
    failFeed = true;
    await startQueuedSync(env, account, "all");
    await drain();
    expect((await queuedSyncStatus(env, account.id))[0].status).toBe("error");
    expect(
      (await env.DB.prepare(
        "SELECT last_run_at FROM sync_state WHERE account_id=? AND type='queue:all'",
      )
        .bind(account.id)
        .first<{ last_run_at: string }>())!.last_run_at,
    ).toBe(success);
  });
  it("imports an old video newly added to a manually selected playlist", async () => {
    const selected = await importLibrary();
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        const response = await original(input, init);
        if (url.pathname.endsWith("/playlists")) {
          const body = (await response.json()) as any;
          body.items[0].contentDetails.itemCount++;
          return Response.json(body);
        }
        if (
          url.pathname.endsWith("/playlistItems") &&
          !url.searchParams.has("pageToken")
        ) {
          const body = (await response.json()) as any;
          body.items.push({
            id: "new-remote-item",
            snippet: {
              title: "Old archive added today",
              publishedAt: "2010-01-01T00:00:00Z",
              resourceId: { videoId: "oldnew00001" },
              videoOwnerChannelId: channels[0],
            },
            contentDetails: {
              videoId: "oldnew00001",
              videoPublishedAt: "2010-01-01T00:00:00Z",
            },
          });
          return Response.json(body);
        }
        return response;
      }),
    );
    await startQueuedSync(env, account, "playlists", true, selected);
    await drain();
    expect(
      (await getVideo(env.DB, account.id, "oldnew00001", "external"))
        ?.durationSeconds,
    ).toBe(300);
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM playlist_items WHERE video_id='oldnew00001'",
      ).first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it("renews old expiring metadata as maintenance without reimporting an unchanged playlist", async () => {
    await importLibrary();
    const soon = new Date(Date.now() + 3600000).toISOString();
    await env.DB.prepare(
      "UPDATE videos SET expires_at=?,details_expires_at=? WHERE id='00000010000'",
    )
      .bind(soon, soon)
      .run();
    await env.DB.prepare(
      "UPDATE account_video_metadata SET expires_at=? WHERE account_id=? AND video_id='priv0000000'",
    )
      .bind(soon, account.id)
      .run();
    vi.mocked(fetch).mockClear();
    await startQueuedSync(env, account, "all");
    await drain();
    const urls = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => new URL(String(url)));
    expect(
      urls.filter((url) => url.pathname.endsWith("/playlistItems")),
    ).toHaveLength(0);
    expect(
      urls
        .filter((url) => url.pathname.endsWith("/videos"))
        .flatMap((url) => url.searchParams.get("id")!.split(",")),
    ).toContain("priv0000000");
    expect(
      (await env.DB.prepare(
        "SELECT expires_at FROM account_video_metadata WHERE account_id=? AND video_id='priv0000000'",
      )
        .bind(account.id)
        .first<{ expires_at: string }>())!.expires_at > soon,
    ).toBe(true);
  }, 15000);
  it("refreshes recent active broadcasts so completed streams stop being live, including private metadata", async () => {
    await importLibrary();
    const ago = new Date(Date.now() - 600000).toISOString();
    await env.DB.prepare(
      "UPDATE videos SET live_broadcast_content='live',is_live=1,details_fetched_at=? WHERE id='00000010000'",
    )
      .bind(ago)
      .run();
    await env.DB.prepare(
      "UPDATE account_video_metadata SET metadata=json_set(metadata,'$.liveBroadcastContent','live','$.isLive',1),details_fetched_at=? WHERE account_id=? AND video_id='priv0000000'",
    )
      .bind(ago, account.id)
      .run();
    await startQueuedSync(env, account, "all", false);
    await drain();
    expect(
      (await getVideo(env.DB, account.id, "00000010000", "external"))
        ?.liveBroadcastContent,
    ).toBe("none");
    expect(
      (await getVideo(env.DB, account.id, "priv0000000", "external"))
        ?.liveBroadcastContent,
    ).toBe("none");
    expect(maxStatements).toBeLessThanOrEqual(50);
  }, 15000);
  it("renews expired old detail fields even after API retention has cleared their values", async () => {
    await importLibrary();
    const expired = new Date(Date.now() - 26 * 86400000).toISOString();
    await env.DB.prepare(
      "UPDATE videos SET details_expires_at=?,details_fetched_at=? WHERE id='00000010000'",
    )
      .bind(expired, expired)
      .run();
    await env.DB.prepare(
      "UPDATE account_video_metadata SET details_fetched_at=? WHERE account_id=? AND video_id='priv0000000'",
    )
      .bind(expired, account.id)
      .run();
    await purgeExpiredMetadata(env.DB);
    expect(
      (await getVideo(env.DB, account.id, "priv0000000", "external"))
        ?.durationSeconds,
    ).toBeNull();
    await startQueuedSync(env, account, "all");
    await drain();
    expect(
      (await getVideo(env.DB, account.id, "priv0000000", "external"))
        ?.durationSeconds,
    ).toBe(300);
    expect(
      (await getVideo(env.DB, account.id, "00000010000", "external"))
        ?.durationSeconds,
    ).toBe(300);
    expect(
      (
        await env.DB.prepare(
          "SELECT json_extract(metadata,'$._detailsExpired') AS expired FROM account_video_metadata WHERE account_id=? AND video_id='priv0000000'",
        )
          .bind(account.id)
          .first<{ expired: number | null }>()
      )?.expired,
    ).toBeNull();
  }, 15000);
  it("catalog refresh imports names only and manual refresh is limited to its owner and selected list", async () => {
    const id = await catalog();
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM playlist_items").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    await env.DB.prepare(
      "INSERT INTO playlists(id,account_id,source,remote_id,title,fetched_at,created_at,updated_at) VALUES ('untouched',?,'youtube','PLother','Untouched',?,?,?)",
    )
      .bind(account.id, future, old, old)
      .run();
    await env.DB.prepare(
      "INSERT INTO accounts(id,mode,connected,created_at,updated_at) VALUES ('foreign','real',1,?,?)",
    )
      .bind(old, old)
      .run();
    const foreign = (await env.DB.prepare(
      "SELECT * FROM accounts WHERE id='foreign'",
    ).first<AccountRow>())!;
    await expect(
      startQueuedSync(env, foreign, "playlists", true, id),
    ).rejects.toMatchObject({ status: 404 });
    vi.mocked(fetch).mockClear();
    const first = await startQueuedSync(env, account, "playlists", true, id);
    const count = pending.length;
    const duplicate = await startQueuedSync(
      env,
      account,
      "playlists",
      true,
      id,
    );
    expect(duplicate.job.id).toBe(first.job.id);
    expect(pending).toHaveLength(count);
    await expect(startQueuedSync(env, account, "all")).rejects.toMatchObject({
      status: 409,
    });
    await drain();
    const urls = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => new URL(String(url)));
    expect(
      urls.filter(
        (u) =>
          u.pathname.endsWith("/subscriptions") ||
          u.pathname.endsWith("/videos.xml"),
      ),
    ).toHaveLength(0);
    expect(
      urls
        .filter((u) => u.pathname.endsWith("/playlistItems"))
        .every((u) => u.searchParams.get("playlistId") === "PLqueue"),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT title,fetched_at FROM playlists WHERE id='untouched'",
      ).first(),
    ).toEqual({ title: "Untouched", fetched_at: future });
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM playlist_items WHERE playlist_id=?",
        )
          .bind(id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(11);
  });
  it("does not repopulate private metadata after an account disconnects", async () => {
    await env.DB.prepare("UPDATE accounts SET connected=0 WHERE id=?")
      .bind(account.id)
      .run();
    await env.DB.batch(
      privateVideoStatements(
        env.DB,
        account.id,
        {
          id: "priv0000000",
          channelId: channels[0],
          channelTitle: "Private",
          title: "Must not return",
          description: "",
          thumbnailUrl: "",
          publishedAt: old,
          durationSeconds: 100,
          viewCount: 0,
          source: "youtube",
        },
        old,
        future,
        true,
      ),
    );
    expect(
      await getVideo(env.DB, account.id, "priv0000000", "external"),
    ).toBeNull();
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM account_video_metadata",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM videos WHERE id='priv0000000'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("uses range indexes for retention instead of rereading the library on each status poll", async () => {
    for (const [sql, index] of [
      [
        "DELETE FROM account_video_metadata WHERE expires_at<=?",
        "idx_account_metadata_global_expiry",
      ],
      [
        "UPDATE account_video_metadata SET details_fetched_at=NULL WHERE details_fetched_at IS NOT NULL AND details_fetched_at<=?",
        "idx_account_metadata_global_details",
      ],
      [
        "DELETE FROM playlists WHERE source='youtube' AND fetched_at<=?",
        "idx_playlist_metadata_expiry",
      ],
      [
        "DELETE FROM video_discoveries WHERE last_seen_at<=?",
        "idx_video_discoveries_seen",
      ],
    ]) {
      const plan = await env.DB.prepare("EXPLAIN QUERY PLAN " + sql)
        .bind(old)
        .all<{ detail: string }>();
      expect(plan.results?.some((row) => row.detail.includes(index))).toBe(
        true,
      );
    }
  });
  it("cancels deleted-account jobs without reviving data or deleting another account's metadata", async () => {
    await env.DB.prepare(
      "INSERT INTO accounts(id,mode,connected,created_at,updated_at) VALUES ('partner','real',1,?,?)",
    )
      .bind(old, old)
      .run();
    const v = {
      id: "priv0000000",
      channelId: channels[0],
      channelTitle: "Private",
      title: "A private",
      description: "",
      thumbnailUrl: "",
      publishedAt: old,
      durationSeconds: 1,
      viewCount: 0,
      source: "youtube" as const,
    };
    await env.DB.batch(
      privateVideoStatements(env.DB, account.id, v, old, future, true),
    );
    await env.DB.batch(
      privateVideoStatements(
        env.DB,
        "partner",
        { ...v, title: "B private" },
        old,
        future,
        true,
      ),
    );
    await env.DB.prepare(
      "INSERT INTO public_read_cache(cache_key,payload,expires_at) VALUES (?,?,?),(?,?,?)",
    )
      .bind(
        "search:v4:owner:priv0000000",
        "[]",
        future,
        "search:v3:partner:priv0000000",
        "[]",
        future,
      )
      .run();
    await startQueuedSync(env, account, "all");
    const message = pending.shift()!;
    await handleDeleteAccountData(env, account);
    const calls = vi.mocked(fetch).mock.calls.length;
    await deliver(message);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
    expect(await queuedSyncStatus(env, account.id)).toEqual([]);
    expect((await getVideo(env.DB, "partner", v.id, "external"))?.title).toBe(
      "B private",
    );
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM public_read_cache WHERE cache_key LIKE 'search:%:owner:%'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM public_read_cache WHERE cache_key LIKE 'search:v3:partner:%'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("recovers a broker message that disappeared after publication", async () => {
    const r = await startQueuedSync(env, account, "subscriptions");
    pending.length = 0;
    await env.DB.prepare("UPDATE sync_jobs SET dispatched_at=? WHERE id=?")
      .bind(old, r.job.id)
      .run();
    await recoverAndScheduleSync(env);
    expect(pending).toHaveLength(1);
    await drain();
    expect((await queuedSyncStatus(env, account.id))[0].status).toBe("success");
  });
  it("migrates legacy private metadata without losing states or trusting stale RSS provenance", async () => {
    const legacy = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: "2026-10-20",
        d1Databases: ["DB"],
      }),
    );
    try {
      const db = await legacy.getD1Database("DB");
      for (const name of [
        "0001_init.sql",
        "0002_video_details.sql",
        "0003_public_read_cache.sql",
        "0004_video_discoveries.sql",
      ]) {
        const sql = (
          await readFile(
            new URL("../migrations/" + name, import.meta.url),
            "utf8",
          )
        ).replace(/^\s*--.*$/gm, "");
        await db.batch(
          sql
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => db.prepare(s)),
        );
      }
      await db
        .prepare(
          "INSERT INTO accounts(id,mode,created_at,updated_at) VALUES ('a','real',?,?),('b','real',?,?)",
        )
        .bind(old, old, old, old)
        .run();
      await db
        .prepare(
          "INSERT INTO videos(id,channel_id,title,description,published_at,source,fetched_at,expires_at,created_at,updated_at) VALUES ('priv0000000','UCowner','Secret legacy title','Private description',?,'youtube',?,?,?,?)",
        )
        .bind(old, old, future, old, old)
        .run();
      await db
        .prepare(
          "INSERT INTO channels(id,source,created_at,updated_at) VALUES ('UCowner','youtube',?,?)",
        )
        .bind(old, old)
        .run();
      await db
        .prepare(
          "INSERT INTO video_discoveries(video_id,channel_id,last_seen_at) VALUES ('priv0000000','UCowner',?)",
        )
        .bind(old)
        .run();
      await db
        .prepare(
          "INSERT INTO playlists(id,account_id,source,title,created_at,updated_at) VALUES ('list','a','youtube','Own list',?,?)",
        )
        .bind(old, old)
        .run();
      await db
        .prepare(
          "INSERT INTO playlist_items(id,playlist_id,video_id,added_at) VALUES ('item','list','priv0000000',?)",
        )
        .bind(old)
        .run();
      await db
        .prepare(
          "INSERT INTO watch_states(account_id,video_id,watched,manual,updated_at) VALUES ('a','priv0000000',1,1,?)",
        )
        .bind(old)
        .run();
      const migration = (
        await readFile(
          new URL("../migrations/0005_queued_sync.sql", import.meta.url),
          "utf8",
        )
      ).replace(/^\s*--.*$/gm, "");
      await db.batch(
        migration
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
      await db
        .prepare(
          "INSERT INTO subscriptions(account_id,channel_id,last_synced_at,created_at,updated_at) VALUES ('a','UCowner',?,?,?)",
        )
        .bind(old, old, old)
        .run();
      await db
        .prepare(
          "INSERT INTO sync_jobs(id,account_id,type,status,state,created_at,updated_at) VALUES ('success','a','all','success','{}','2026-10-01T00:00:00.000Z','2026-10-02T00:00:00.000Z'),('failed','a','all','error','{}','2026-10-03T00:00:00.000Z','2026-10-04T00:00:00.000Z')",
        )
        .run();
      for (const name of [
        "0006_retention_indexes.sql",
        "0007_video_broadcast_status.sql",
        "0008_incremental_sync.sql",
      ]) {
        const sql = (
          await readFile(
            new URL("../migrations/" + name, import.meta.url),
            "utf8",
          )
        ).replace(/^\s*--.*$/gm, "");
        await db.batch(
          sql
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => db.prepare(s)),
        );
      }
      expect(
        (
          await db
            .prepare(
              "SELECT last_run_at FROM sync_state WHERE account_id='a' AND type='queue:all'",
            )
            .first<{ last_run_at: string }>()
        )?.last_run_at,
      ).toBe("2026-10-01T00:00:00.000Z");
      expect(
        (
          await db
            .prepare(
              "SELECT last_synced_at AS rss_synced_at FROM subscriptions WHERE account_id='a' AND channel_id='UCowner'",
            )
            .first<{ rss_synced_at: string }>()
        )?.rss_synced_at,
      ).toBe(old);
      const runtime = db as unknown as D1Database;
      expect(
        await getVideo(runtime, "a", "priv0000000", "external"),
      ).toMatchObject({
        title: "Secret legacy title",
        description: "Private description",
        watched: true,
        manual: true,
      });
      expect(
        await getVideo(runtime, "b", "priv0000000", "external"),
      ).toBeNull();
      expect(
        (await getPlaylistItems(runtime, "a", "list", "external"))[0].title,
      ).toBe("Secret legacy title");
      expect(
        (
          await db
            .prepare("SELECT count(*) AS n FROM watch_states")
            .first<{ n: number }>()
        )?.n,
      ).toBe(1);
    } finally {
      await legacy.dispose();
    }
  });
  it("finishes all phases without an open browser, keeps all 15 RSS entries, handles duplicate messages and isolates private metadata", async () => {
    const result = await startQueuedSync(env, account, "all");
    const first = pending.shift()!;
    await deliver(first);
    const sent = published.length;
    await deliver(first);
    expect(published.length).toBe(sent);
    await drain();
    const job = (await queuedSyncStatus(env, account.id))[0];
    expect(job).toMatchObject({
      id: result.job.id,
      status: "success",
      phase: "done",
      processedChannels: 2,
      processedPlaylists: 0,
    });
    const selected = await catalog();
    await startQueuedSync(env, account, "playlists", true, selected);
    await drain();
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM video_discoveries",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(30);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM playlist_items").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(11);
    expect(
      (await getVideo(env.DB, account.id, "priv0000000", "external"))?.title,
    ).toBe("Private priv0000000");
    await env.DB.prepare(
      "INSERT INTO accounts(id,mode,connected,created_at,updated_at) VALUES ('partner','real',1,?,?)",
    )
      .bind(old, old)
      .run();
    expect(
      await getVideo(env.DB, "partner", "priv0000000", "external"),
    ).toBeNull();
    expect(await queuedSyncStatus(env, "partner")).toEqual([]);
    const raw = await env.DB.prepare(
      "SELECT title,description,channel_id FROM videos WHERE id=?",
    )
      .bind("priv0000000")
      .first();
    expect(raw).toEqual({
      title: "Vídeo de YouTube",
      description: "",
      channel_id: "",
    });
    expect(maxStatements).toBeLessThanOrEqual(50);
    expect(JSON.stringify(published)).not.toContain("fixture-owner-access");
  });
  it("recovers a committed step whose successor could not be published", async () => {
    const r = await startQueuedSync(env, account, "subscriptions");
    failSend = true;
    await deliver(pending.shift()!);
    expect((await queuedSyncStatus(env, account.id))[0].status).toBe("paused");
    expect(pending).toHaveLength(0);
    await env.DB.prepare(
      "UPDATE sync_jobs SET next_attempt_at=NULL,dispatched_at=NULL WHERE id=?",
    )
      .bind(r.job.id)
      .run();
    await recoverAndScheduleSync(env);
    await drain();
    expect((await queuedSyncStatus(env, account.id))[0].status).toBe("success");
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM subscriptions WHERE account_id=?",
        )
          .bind(account.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it("tolerates a crash after send but before the publication marker without forking the job", async () => {
    await startQueuedSync(env, account, "subscriptions");
    failMark = true;
    await deliver(pending.shift()!);
    await drain();
    expect((await queuedSyncStatus(env, account.id))[0].status).toBe("success");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).includes("/subscriptions")),
    ).toHaveLength(2);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM subscriptions").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(2);
  });
  it("pauses at the daily send budget and resumes from D1 after reset", async () => {
    env.SYNC_QUEUE_DAILY_CAP = "1";
    const r = await startQueuedSync(env, account, "subscriptions");
    await drain();
    expect((await queuedSyncStatus(env, account.id))[0]).toMatchObject({
      status: "paused",
      phase: "subscriptions",
    });
    expect(
      (
        await env.DB.prepare("SELECT version FROM sync_jobs WHERE id=?")
          .bind(r.job.id)
          .first<{ version: number }>()
      )?.version,
    ).toBe(1);
    await recoverAndScheduleSync(env);
    expect(pending).toHaveLength(0);
    await env.DB.prepare("DELETE FROM sync_queue_budget").run();
    await env.DB.prepare(
      "UPDATE sync_jobs SET next_attempt_at=NULL,dispatched_at=NULL WHERE id=?",
    )
      .bind(r.job.id)
      .run();
    await recoverAndScheduleSync(env);
    await drain();
    expect((await queuedSyncStatus(env, account.id))[0].status).toBe("success");
  });
  it("continues after a missing RSS channel and reports partial failure rather than falsely succeeding", async () => {
    failFeed = true;
    await startQueuedSync(env, account, "all");
    await drain();
    const job = (await queuedSyncStatus(env, account.id))[0];
    expect(job.status).toBe("error");
    expect(job.phase).toBe("done");
    expect(job.message).toContain("2 canales");
    expect(job.processedPlaylists).toBe(0);
  });
  it("does not reconcile missing playlist items when a later page fails", async () => {
    await env.DB.prepare(
      "INSERT INTO playlists(id,account_id,source,remote_id,title,fetched_at,created_at,updated_at) VALUES ('existing',?,'youtube','PLqueue','Old',?,?,?)",
    )
      .bind(account.id, old, old, old)
      .run();
    await env.DB.batch(
      privateVideoStatements(
        env.DB,
        account.id,
        {
          id: "oldpriv0001",
          channelId: "",
          channelTitle: "",
          title: "Old private",
          description: "",
          thumbnailUrl: "",
          publishedAt: old,
          durationSeconds: null,
          viewCount: null,
          source: "youtube",
        },
        old,
        future,
      ),
    );
    await env.DB.prepare(
      "INSERT INTO playlist_items(id,playlist_id,video_id,remote_item_id,sync_generation,added_at) VALUES ('old-item','existing','oldpriv0001','old-remote','previous',?)",
    )
      .bind(old)
      .run();
    failItems = true;
    await startQueuedSync(env, account, "playlists", true, "existing");
    await drain();
    const job = (await queuedSyncStatus(env, account.id))[0];
    expect(job.status).toBe("error");
    expect(job.message).toContain("1 listas");
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM playlist_items WHERE id='old-item'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("stores differing private metadata for the same ID per account without leaking through the shared row", async () => {
    await env.DB.prepare(
      "INSERT INTO accounts(id,mode,connected,created_at,updated_at) VALUES ('partner','real',1,?,?)",
    )
      .bind(old, old)
      .run();
    const v = {
      id: "priv0000000",
      channelId: channels[0],
      channelTitle: "Owner",
      title: "Secret A",
      description: "Description A",
      thumbnailUrl: "",
      publishedAt: old,
      durationSeconds: 120,
      viewCount: 1,
      source: "youtube" as const,
    };
    await env.DB.batch(
      privateVideoStatements(env.DB, account.id, v, old, future, true),
    );
    await env.DB.batch(
      privateVideoStatements(
        env.DB,
        "partner",
        { ...v, title: "Private video", description: "" },
        old,
        future,
      ),
    );
    expect((await getVideo(env.DB, account.id, v.id, "external"))?.title).toBe(
      "Secret A",
    );
    expect((await getVideo(env.DB, "partner", v.id, "external"))?.title).toBe(
      "Private video",
    );
    expect(
      (
        await env.DB.prepare("SELECT title FROM videos WHERE id=?")
          .bind(v.id)
          .first<{ title: string }>()
      )?.title,
    ).toBe("Vídeo de YouTube");
  });
  it("preserves watch state and avoids rewriting unchanged RSS metadata on subsequent passes", async () => {
    const v = {
      id: "rssSame0001",
      channelId: channels[0],
      channelTitle: "Public",
      title: "Same",
      description: "same",
      thumbnailUrl: "",
      publishedAt: old,
      durationSeconds: null,
      viewCount: null,
      source: "rss" as const,
    };
    await externalVideoStatement(env.DB, v, future).run();
    const second = await externalVideoStatement(env.DB, v, future).run();
    expect(second.meta.changes).toBe(0);
  });
});
