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
  listFeed,
  purgeExpiredMetadata,
} from "../worker/db";
import { privateVideoStatements } from "../worker/private-metadata";
import { readRssCheck, writeRssCheck } from "../worker/rss-cache";

let mf: Miniflare, env: Env, account: AccountRow;
let pending: Array<{ body: SyncMessage; retry?: boolean }>,
  published: SyncMessage[];
let failSend: boolean,
  failMark: boolean,
  statements: number,
  maxStatements: number,
  playlistMutations: number;
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
    publishedAt: new Date().toISOString(),
    liveBroadcastContent: "none",
  },
  contentDetails: { duration: "PT5M" },
  statistics: { viewCount: "12" },
});

class FakeKv {
  store = new Map<string, string>();
  puts: string[] = [];
  failGet = false;
  failPut = false;

  async get(key: string): Promise<string | null> {
    if (this.failGet) throw new Error("KV unavailable");
    return this.store.get(key) ?? null;
  }

  async put(
    key: string,
    value: string,
    _options?: { expirationTtl?: number },
  ): Promise<void> {
    if (this.failPut) throw new Error("KV quota exceeded");
    this.puts.push(key);
    this.store.set(key, value);
  }
}

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
    "0012_playlist_unimported.sql",
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
  playlistMutations = 0;
  const counting = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          statements++;
          if (
            /^(INSERT INTO|DELETE FROM|UPDATE) playlist_items/i.test(sql.trim())
          )
            playlistMutations++;
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
        const published = new Date(Date.now() - 60000).toISOString();
        const entries = Array.from(
          { length: 15 },
          (_, i) =>
            `<entry><yt:videoId>${String(base + i).padStart(11, "0")}</yt:videoId><yt:channelId>${channel}</yt:channelId><title>Public ${String(base + i).padStart(11, "0")}</title><published>${published}</published></entry>`,
        ).join("");
        return new Response(
          `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Channel</title>${entries}</feed>`,
          { headers: { etag: "fixture-" + channel } },
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
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM video_discoveries",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
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
  it("uses per-account KV validators, ignores old entries and writes no per-channel success rows", async () => {
    const kv = new FakeKv();
    env.READ_CACHE = kv as unknown as KVNamespace;
    const conditional: Array<string | null> = [];
    let withNewEntries = false;
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(String(input));
        if (!url.pathname.endsWith("/videos.xml")) return original(input, init);
        const owner = url.searchParams.get("channel_id")!;
        const ifNoneMatch = new Headers(init.headers).get("if-none-match");
        conditional.push(ifNoneMatch);
        if (ifNoneMatch === "fixture-" + owner)
          return new Response(null, { status: 304 });
        const suffix = owner === channels[0] ? "1" : "2";
        const recent = [`Fresh00000${suffix}`];
        if (withNewEntries)
          recent.push(`Fresh00000${suffix === "1" ? "3" : "4"}`);
        const entries = [
          `<entry><yt:videoId>Old0000000${suffix}</yt:videoId><yt:channelId>${owner}</yt:channelId><title>Old</title><published>2020-01-01T00:00:00Z</published></entry>`,
          ...recent.map(
            (id) =>
              `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${owner}</yt:channelId><title>Recent ${id}</title><published>${new Date().toISOString()}</published></entry>`,
          ),
        ].join("");
        return new Response(
          `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Channel</title>${entries}</feed>`,
          { headers: { etag: "fixture-" + owner } },
        );
      }),
    );
    await importLibrary();
    // First check has no KV proof, so no conditional headers are sent.
    expect(conditional).toEqual([null, null]);
    expect(kv.puts).toHaveLength(2);
    expect(
      await getVideo(env.DB, account.id, "Old00000001", "external"),
    ).toBeNull();
    expect(
      await getVideo(env.DB, account.id, "Old00000002", "external"),
    ).toBeNull();
    // D1 channel validators are not consulted; only the account+channel KV
    // record authorizes a conditional request.
    await env.DB.prepare("UPDATE channels SET rss_etag='wrong'").run();
    conditional.length = 0;
    await startQueuedSync(env, account, "rss");
    await drain();
    expect(conditional).toEqual([
      "fixture-" + channels[0],
      "fixture-" + channels[1],
    ]);
    expect((await queuedSyncStatus(env, account.id))[0]).toMatchObject({
      status: "success",
      items: 0,
      processedChannels: 2,
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM sync_state WHERE type LIKE 'queue:rss:%'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    // Stale KV records force an unconditional fetch and a new recent entry is
    // imported; the old entry remains ignored.
    const stale = new Date(Date.now() - 25 * 3600000).toISOString();
    for (const channel of channels)
      await writeRssCheck(env, account.id, channel, {
        checkedAt: stale,
        etag: "stale",
        lastModified: null,
      });
    withNewEntries = true;
    conditional.length = 0;
    await startQueuedSync(env, account, "rss");
    await drain();
    expect(conditional).toEqual([null, null]);
    expect((await queuedSyncStatus(env, account.id))[0]).toMatchObject({
      status: "success",
      items: 2,
    });
    expect(
      await getVideo(env.DB, account.id, "Fresh000003", "external"),
    ).not.toBeNull();
    expect(
      await getVideo(env.DB, account.id, "Fresh000004", "external"),
    ).not.toBeNull();
    expect(
      await getVideo(env.DB, account.id, "Old00000001", "external"),
    ).toBeNull();
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM channels WHERE rss_etag='wrong' AND last_synced_at IS NULL",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(2);
    expect(
      (
        await readRssCheck(
          env,
          account.id,
          channels[0],
          new Date().toISOString(),
        )
      )?.etag,
    ).toBe("fixture-" + channels[0]);
  }, 25000);
  it("keeps RSS validators isolated between accounts sharing a channel", async () => {
    const kv = new FakeKv();
    env.READ_CACHE = kv as unknown as KVNamespace;
    await startQueuedSync(env, account, "subscriptions");
    await drain();
    await env.DB.prepare(
      "INSERT INTO accounts(id,mode,connected,created_at,updated_at) VALUES ('partner','real',1,?,?)",
    )
      .bind(old, old)
      .run();
    await env.DB.prepare(
      "INSERT INTO subscriptions(account_id,channel_id,active,created_at,updated_at) VALUES ('partner',?,1,?,?)",
    )
      .bind(channels[0], old, old)
      .run();

    const conditional: Array<string | null> = [];
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        if (String(input).includes("/videos.xml"))
          conditional.push(new Headers(init.headers).get("if-none-match"));
        return original(input, init);
      }),
    );
    await startQueuedSync(env, account, "rss");
    await drain();
    expect(conditional).toEqual([null, null]);
    conditional.length = 0;
    await startQueuedSync(
      env,
      (await env.DB.prepare(
        "SELECT * FROM accounts WHERE id='partner'",
      ).first<AccountRow>())!,
      "rss",
    );
    await drain();
    expect(conditional).toEqual([null]);
    expect((await queuedSyncStatus(env, "partner"))[0]).toMatchObject({
      status: "success",
      items: 0,
    });
    expect(kv.puts).toHaveLength(3);
  }, 20000);
  it("does not publish KV validators when the durable video write fails", async () => {
    const kv = new FakeKv();
    env.READ_CACHE = kv as unknown as KVNamespace;
    await startQueuedSync(env, account, "subscriptions");
    await drain();
    await env.DB.prepare(
      "UPDATE subscriptions SET active=0 WHERE account_id=? AND channel_id=?",
    )
      .bind(account.id, channels[1])
      .run();

    const originalDb = env.DB;
    const sqlByStatement = new WeakMap<object, string>();
    const rawByStatement = new WeakMap<object, D1PreparedStatement>();
    const track = (
      statement: D1PreparedStatement,
      sql: string,
    ): D1PreparedStatement => {
      const tracked = new Proxy(statement, {
        get(target, key) {
          if (key === "bind")
            return (...args: unknown[]) => track(target.bind(...args), sql);
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      sqlByStatement.set(tracked, sql);
      rawByStatement.set(tracked, statement);
      return tracked;
    };
    let failVideoWrite = true;
    env.DB = new Proxy(originalDb, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => track(target.prepare(sql), sql);
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (
              failVideoWrite &&
              statements.some((statement) =>
                sqlByStatement.get(statement)?.startsWith("INSERT INTO videos"),
              )
            ) {
              failVideoWrite = false;
              throw new Error("fixture D1 write failure");
            }
            return target.batch(
              statements.map(
                (statement) => rawByStatement.get(statement) || statement,
              ),
            );
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(String(input));
        if (!url.pathname.endsWith("/videos.xml")) return original(input, init);
        return new Response(
          `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Channel</title><entry><yt:videoId>Fail0000001</yt:videoId><yt:channelId>${channels[0]}</yt:channelId><title>Failure fixture</title><published>${new Date().toISOString()}</published></entry></feed>`,
          { headers: { etag: "failure-etag" } },
        );
      }),
    );
    await startQueuedSync(env, account, "rss");
    await deliver(pending.shift()!);
    expect(kv.puts).toHaveLength(0);
    expect(
      await getVideo(env.DB, account.id, "Fail0000001", "external"),
    ).toBeNull();
    await drain();
    expect(kv.puts).toHaveLength(1);
    expect(
      await getVideo(env.DB, account.id, "Fail0000001", "external"),
    ).not.toBeNull();
  }, 20000);
  it("writes no video rows or channel success fields on a no-op RSS rerun", async () => {
    await startQueuedSync(env, account, "subscriptions");
    await drain();
    await startQueuedSync(env, account, "rss");
    await drain();
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM videos").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(30);

    const prepared: string[] = [];
    const originalDb = env.DB;
    env.DB = new Proxy(originalDb, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string, ...args: unknown[]) => {
            prepared.push(sql);
            return (
              target.prepare as (...values: unknown[]) => D1PreparedStatement
            )(sql, ...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await startQueuedSync(env, account, "rss");
    await drain();
    expect((await queuedSyncStatus(env, account.id))[0]).toMatchObject({
      status: "success",
      items: 0,
    });
    expect(
      prepared.filter((sql) =>
        sql.trimStart().startsWith("INSERT INTO videos"),
      ),
    ).toHaveLength(0);
    expect(
      prepared.filter((sql) => sql.trimStart().startsWith("UPDATE channels")),
    ).toHaveLength(0);
    expect(prepared.filter((sql) => sql.includes("queue:rss:"))).toHaveLength(
      0,
    );
  }, 15000);
  it("imports only the frozen 24h window when a subscription is reactivated", async () => {
    await startQueuedSync(env, account, "all");
    await drain();
    await env.DB.prepare(
      "UPDATE subscriptions SET active=0 WHERE account_id=? AND channel_id=?",
    )
      .bind(account.id, channels[0])
      .run();
    await startQueuedSync(env, account, "subscriptions");
    await drain();
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(String(input));
        if (
          url.pathname.endsWith("/videos.xml") &&
          url.searchParams.get("channel_id") === channels[0]
        )
          return new Response(
            '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Channel</title>' +
              `<entry><yt:videoId>ReactOld001</yt:videoId><yt:channelId>${channels[0]}</yt:channelId><title>Old</title><published>2020-01-01T00:00:00Z</published></entry>` +
              `<entry><yt:videoId>ReactNew001</yt:videoId><yt:channelId>${channels[0]}</yt:channelId><title>Recent</title><published>${new Date().toISOString()}</published></entry>` +
              "</feed>",
          );
        return original(input, init);
      }),
    );
    await startQueuedSync(env, account, "rss");
    await drain();
    const row = await env.DB.prepare(
      "SELECT active FROM subscriptions WHERE account_id=? AND channel_id=?",
    )
      .bind(account.id, channels[0])
      .first<{ active: number }>();
    expect(row?.active).toBe(1);
    expect(
      await getVideo(env.DB, account.id, "ReactOld001", "external"),
    ).toBeNull();
    expect(
      await getVideo(env.DB, account.id, "ReactNew001", "external"),
    ).not.toBeNull();
    expect((await queuedSyncStatus(env, account.id))[0]).toMatchObject({
      status: "success",
      items: 1,
    });
  });
  it("imports entries at or after the frozen 24h cutoff and does not advance a successful watermark after partial failure", async () => {
    await externalVideoStatement(
      env.DB,
      {
        id: "edge0000000",
        channelId: channels[0],
        channelTitle: "Channel",
        title: "Known old clip",
        description: "",
        thumbnailUrl: "",
        publishedAt: "2020-01-01T00:00:00.000Z",
        durationSeconds: 300,
        viewCount: 0,
        isLive: false,
        liveBroadcastContent: "none",
        source: "rss",
      },
      future,
    ).run();
    const next = await startQueuedSync(env, account, "all");
    const startedAt = JSON.parse(
      (await env.DB.prepare("SELECT state FROM sync_jobs WHERE id=?")
        .bind(next.job.id)
        .first<{ state: string }>())!.state,
    ).startedAt as string;
    const cutoff = Date.parse(startedAt) - 24 * 3600000;
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
              [-1, -1, 0, 1]
                .map(
                  (delta, i) =>
                    `<entry><yt:videoId>edge000000${i}</yt:videoId><yt:channelId>${channels[0]}</yt:channelId><title>Boundary ${i}</title><published>${new Date(cutoff + (i === 1 ? -1 : delta)).toISOString()}</published></entry>`,
                )
                .join("") +
              "</feed>",
          );
        return original(input, init);
      }),
    );
    await drain();
    // The old entry is present in the feed but was neither imported nor
    // rewritten, even though it is the same id as a retained row.
    expect(
      (await getVideo(env.DB, account.id, "edge0000000", "external"))?.title,
    ).toBe("Known old clip");
    expect(
      await getVideo(env.DB, account.id, "edge0000001", "external"),
    ).toBeNull();
    expect(
      await getVideo(env.DB, account.id, "edge0000002", "external"),
    ).not.toBeNull();
    expect(
      await getVideo(env.DB, account.id, "edge0000003", "external"),
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
  it("does not renew old metadata during general sync and keeps the explicit playlist path", async () => {
    const selected = await importLibrary();
    const soon = new Date(Date.now() + 3600000).toISOString();
    await env.DB.prepare(
      "UPDATE videos SET published_at='2020-01-01T00:00:00.000Z',expires_at=?,details_expires_at=? WHERE id='00000010000'",
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
    const generalUrls = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => new URL(String(url)));
    expect(
      generalUrls.filter((url) => url.pathname.endsWith("/playlistItems")),
    ).toHaveLength(0);
    const generalIds = generalUrls
      .filter((url) => url.pathname.endsWith("/videos"))
      .flatMap((url) => url.searchParams.get("id")!.split(","));
    expect(generalIds).not.toContain("priv0000000");
    expect(generalIds).not.toContain("00000010000");
    expect(
      (await env.DB.prepare(
        "SELECT expires_at FROM account_video_metadata WHERE account_id=? AND video_id='priv0000000'",
      )
        .bind(account.id)
        .first<{ expires_at: string }>())!.expires_at,
    ).toBe(soon);
    expect(
      (await env.DB.prepare(
        "SELECT expires_at FROM videos WHERE id='00000010000'",
      ).first<{ expires_at: string }>())!.expires_at,
    ).toBe(soon);

    await startQueuedSync(env, account, "playlists", true, selected);
    await drain();
    expect(
      (await env.DB.prepare(
        "SELECT expires_at FROM account_video_metadata WHERE account_id=? AND video_id='priv0000000'",
      )
        .bind(account.id)
        .first<{ expires_at: string }>())!.expires_at > soon,
    ).toBe(true);
  }, 15000);
  it("refreshes recent active broadcasts within the window and keeps private refresh in the explicit playlist path", async () => {
    const selected = await importLibrary();
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
    // The general path no longer scans owned metadata.
    expect(
      (await getVideo(env.DB, account.id, "priv0000000", "external"))
        ?.liveBroadcastContent,
    ).toBe("live");

    await startQueuedSync(env, account, "playlists", true, selected);
    await drain();
    expect(
      (await getVideo(env.DB, account.id, "priv0000000", "external"))
        ?.liveBroadcastContent,
    ).toBe("none");
    expect(maxStatements).toBeLessThanOrEqual(50);
  }, 15000);
  it("does not renew expired old detail fields during general sync and keeps list-scoped renewal", async () => {
    const selected = await importLibrary();
    const expired = new Date(Date.now() - 26 * 86400000).toISOString();
    await env.DB.prepare(
      "UPDATE videos SET published_at='2020-01-01T00:00:00.000Z',details_expires_at=?,details_fetched_at=? WHERE id='00000010000'",
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
    ).toBeNull();
    expect(
      (await getVideo(env.DB, account.id, "00000010000", "external"))
        ?.durationSeconds,
    ).toBeNull();

    await startQueuedSync(env, account, "playlists", true, selected);
    await drain();
    expect(
      (await getVideo(env.DB, account.id, "priv0000000", "external"))
        ?.durationSeconds,
    ).toBe(300);
    expect(
      (await getVideo(env.DB, account.id, "00000010000", "external"))
        ?.durationSeconds,
    ).toBeNull();
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
  it("imports new lists once, then leaves existing content for individual refresh", async () => {
    const id = await catalog();
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM playlist_items").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(11);
    vi.mocked(fetch).mockClear();
    await startQueuedSync(env, account, "playlists");
    await drain();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) =>
          new URL(String(url)).pathname.endsWith("/playlistItems"),
        ),
    ).toHaveLength(0);
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
  it("writes only item differences and keeps duplicate video references distinct", async () => {
    const id = await catalog();
    playlistMutations = 0;
    await startQueuedSync(env, account, "playlists", true, id);
    await drain();
    expect(playlistMutations).toBe(0);

    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const response = await original(input, init);
        const url = new URL(input);
        if (
          !url.pathname.endsWith("/playlistItems") ||
          url.searchParams.has("pageToken")
        )
          return response;
        const body = (await response.json()) as {
          items: Array<{
            id: string;
            snippet: { position: number; resourceId: { videoId: string } };
            contentDetails: { videoId: string };
          }>;
        };
        body.items = body.items.filter((item) => item.id !== "remote-item-1");
        body.items[0].snippet.position = 9;
        body.items.push({
          ...body.items[0],
          id: "duplicate-item",
          snippet: { ...body.items[0].snippet, position: 1 },
        });
        return Response.json(body);
      }),
    );
    playlistMutations = 0;
    await startQueuedSync(env, account, "playlists", true, id);
    await drain();
    expect(playlistMutations).toBe(3);
    const rows = await env.DB.prepare(
      "SELECT remote_item_id,video_id,position FROM playlist_items WHERE playlist_id=? ORDER BY position,id",
    )
      .bind(id)
      .all<{ remote_item_id: string; video_id: string; position: number }>();
    expect(rows.results).toHaveLength(11);
    expect(
      rows.results?.some((item) => item.remote_item_id === "remote-item-1"),
    ).toBe(false);
    expect(
      rows.results?.find((item) => item.remote_item_id === "remote-item-0")
        ?.position,
    ).toBe(9);
    expect(
      rows.results?.find((item) => item.remote_item_id === "duplicate-item")
        ?.video_id,
    ).toBe("priv0000000");
  }, 15000);
  it("keeps playlist membership visible after video metadata expires", async () => {
    const id = await catalog();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE videos SET title='',purged_at=? WHERE id='priv0000000'",
      ).bind(old),
      env.DB.prepare(
        "DELETE FROM account_video_metadata WHERE account_id=? AND video_id='priv0000000'",
      ).bind(account.id),
    ]);
    const items = await getPlaylistItems(env.DB, account.id, id, "external");
    expect(items).toHaveLength(11);
    expect(items.find((item) => item.id === "priv0000000")?.title).toBe(
      "Vídeo sin metadatos",
    );
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
    ).toBe(0);
    const feed = await listFeed(
      env.DB,
      account.id,
      { status: "all", channelId: null, cursor: null, limit: 100 },
      "external",
    );
    expect(feed.items).toHaveLength(30);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM videos WHERE source='youtube' AND details_expires_at IS NOT NULL",
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
