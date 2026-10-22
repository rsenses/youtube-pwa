import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { AccountRow, Env, Video } from "../worker/types";
import { insertSession } from "../worker/db";
import { SESSION_COOKIE } from "../worker/http";
import {
  cachedFeed,
  cachedPlaylists,
  feedRevision,
  invalidateReads,
} from "../worker/read-cache";
import {
  WEBSUB_CALLBACK_PATH,
  websubHubSecret,
  websubRoutingToken,
} from "../worker/websub";

const SECRET = "fixture-websub-secret-not-a-real-credential";
const APP_ORIGIN = "https://alveo.test";
const NOW = "2026-10-22T12:00:00.000Z";
const ALL_MIGRATIONS = [
  "0001_init.sql",
  "0002_video_details.sql",
  "0003_public_read_cache.sql",
  "0004_video_discoveries.sql",
  "0005_queued_sync.sql",
  "0006_retention_indexes.sql",
  "0007_video_broadcast_status.sql",
  "0008_incremental_sync.sql",
  "0009_active_retention_indexes.sql",
  "0010_websub_channels.sql",
  "0011_weekly_video_retention.sql",
];

function splitSql(sql: string): string[] {
  const pieces = sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((piece) => piece.trim())
    .filter(Boolean);
  const statements: string[] = [];
  let trigger: string | null = null;
  for (const piece of pieces) {
    if (trigger !== null) {
      trigger += `;\n${piece}`;
      if (/\bEND$/i.test(piece)) {
        statements.push(trigger);
        trigger = null;
      }
    } else if (/^CREATE\s+TRIGGER\b/i.test(piece)) {
      if (/\bEND$/i.test(piece)) statements.push(piece);
      else trigger = piece;
    } else {
      statements.push(piece);
    }
  }
  if (trigger !== null) throw new Error("Unterminated trigger in migration");
  return statements;
}

async function applyMigrations(db: D1Database): Promise<void> {
  for (const name of ALL_MIGRATIONS) {
    const sql = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of splitSql(sql)) {
      await db.prepare(statement).run();
    }
  }
}

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: "2026-10-20",
    d1Databases: ["DB"],
  }),
);
let db: D1Database;
let env: Env;

class FakeKV {
  store = new Map<string, string>();
  gets: string[] = [];
  puts: Array<{ key: string; value: string }> = [];

  async get(key: string): Promise<string | null> {
    this.gets.push(key);
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.puts.push({ key, value });
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function countingDb(database: D1Database, statements: string[]): D1Database {
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

async function resetDatabase(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM account_video_metadata"),
    db.prepare("DELETE FROM playlist_items"),
    db.prepare("DELETE FROM playlists"),
    db.prepare("DELETE FROM watch_states"),
    db.prepare("DELETE FROM videos"),
    db.prepare("DELETE FROM subscriptions"),
    db.prepare("DELETE FROM sync_jobs"),
    db.prepare("DELETE FROM sync_queue_budget"),
    db.prepare("DELETE FROM sessions"),
    db.prepare("DELETE FROM accounts"),
    db.prepare("DELETE FROM channels"),
    db.prepare("DELETE FROM websub_channels"),
    db.prepare("UPDATE youtube_feed_state SET revision = 0"),
    db.prepare(
      `UPDATE video_retention_state SET next_run_at='1970-01-01T00:00:00.000Z',
         cursor_date=NULL,cursor_id=NULL,claim_token=NULL,claim_expires_at=NULL
       WHERE id=1`,
    ),
  ]);
}

async function createAccount(id: string): Promise<AccountRow> {
  await db
    .prepare(
      `INSERT INTO accounts(id,mode,name,connected,scopes,created_at,updated_at)
       VALUES (?, 'real', ?, 1, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(id, id)
    .run();
  return (await db
    .prepare("SELECT * FROM accounts WHERE id=?")
    .bind(id)
    .first<AccountRow>())!;
}

async function insertChannel(channelId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO channels(id,title,source,created_at,updated_at)
       VALUES (?, ?, 'youtube', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(channelId, `Channel ${channelId}`)
    .run();
}

async function subscribe(accountId: string, channelId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions(account_id,channel_id,active,created_at,updated_at)
       VALUES (?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(accountId, channelId)
    .run();
}

async function seedSession(
  accountId: string,
): Promise<{ cookie: string; csrfToken: string }> {
  const { token, session } = await insertSession(db, accountId);
  return {
    cookie: `${SESSION_COOKIE}=${token}`,
    csrfToken: session.csrf_token,
  };
}

async function sessionCount(): Promise<number> {
  return (
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM sessions")
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

async function cacheGeneration(accountId: string): Promise<string | null> {
  return (
    (
      await db
        .prepare(
          "SELECT cursor FROM sync_state WHERE account_id=? AND type='cache:reads'",
        )
        .bind(accountId)
        .first<{ cursor: string | null }>()
    )?.cursor ?? null
  );
}

async function cacheGenerationRows(): Promise<number> {
  return (
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM sync_state WHERE type='cache:reads'",
        )
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

function feedVideo(id: string): Video {
  return {
    id,
    title: `Video ${id}`,
    channelId: "UCcache",
    channelTitle: "Cache channel",
    thumbnailUrl: "https://example.test/thumb.jpg",
    publishedAt: "2026-10-01T00:00:00.000Z",
    description: "Description",
    durationSeconds: 120,
    isLive: null,
    liveBroadcastContent: null,
    watched: false,
    positionSeconds: 0,
    percent: 0,
    manual: false,
    viewCount: null,
    revision: 0,
  };
}

function playlistSummary(id: string) {
  return {
    id,
    title: `Playlist ${id}`,
    description: "",
    source: "local" as const,
    itemCount: 1,
  };
}

function fakeBatch(
  messages: Array<{
    body: { jobId: string; version: number };
    ack: () => void;
    retry: () => void;
  }>,
): MessageBatch<{ jobId: string; version: number }> {
  return { messages } as unknown as MessageBatch<{
    jobId: string;
    version: number;
  }>;
}

function atom(channelId: string, videoId: string): string {
  // Keep the callback inside the one-calendar-year ingest window regardless
  // of when the suite runs.
  const published = new Date(Date.now() - 60_000).toISOString();
  return `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
    <id>yt:channel:${channelId}</id><title>Channel ${channelId}</title>
    <entry>
      <yt:videoId>${videoId}</yt:videoId>
      <yt:channelId>${channelId}</yt:channelId>
      <title>Callback ${videoId}</title>
      <published>${published}</published>
      <updated>${published}</updated>
    </entry>
  </feed>`;
}

async function hmacHeader(channelId: string, body: string): Promise<string> {
  const secret = await websubHubSecret(env, channelId);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `sha1=${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

beforeAll(async () => {
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  env = {
    DB: db,
    MODE: "real",
    APP_ORIGIN,
    WEBSUB_ENABLED: "true",
    WEBSUB_SECRET: SECRET,
  } as unknown as Env;
}, 30000);

beforeEach(async () => {
  vi.unstubAllGlobals();
  await resetDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(async () => {
  await mf.dispose();
});

describe("one-year import boundary", () => {
  it("does not reimport old public metadata through the existing API persistence", async () => {
    const { storeVideos } = await import("../worker/public-youtube");
    const channelId = "UC" + "a".repeat(22);
    const item = (id: string, publishedAt: string) => ({
      id,
      status: { privacyStatus: "public" as const },
      snippet: { channelId, channelTitle: "Fixture", title: id, publishedAt },
      contentDetails: { duration: "PT5M" },
    });
    const ids = await storeVideos(env, [
      item("ageold00001", "2020-01-01T00:00:00.000Z"),
      item("agenew00001", new Date(Date.now() - 3600000).toISOString()),
    ]);
    expect(ids).toEqual(["agenew00001"]);
    expect(
      await db.prepare("SELECT id FROM videos WHERE id='ageold00001'").first(),
    ).toBeNull();
  });
});

describe("WebSub-enabled sync cutover", () => {
  it("separates discovery ticks from account and weekly maintenance budgets", async () => {
    const { runScheduledSync } = await import("../worker/sync");
    await createAccount("scheduled-owner");
    await insertChannel("UCscheduled");
    await subscribe("scheduled-owner", "UCscheduled");
    await db
      .prepare(
        "UPDATE websub_channels SET hub_next_attempt_at='2026',rss_next_at='2026'",
      )
      .run();
    const send = vi.fn(async () => undefined);
    const target = { ...env, SYNC_QUEUE: { send } } as unknown as Env;
    const external = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://pubsubhubbub.appspot.com/subscribe")
        return new Response(null, { status: 202 });
      if (url.startsWith("https://www.youtube.com/feeds/videos.xml?"))
        return new Response("<feed><id>yt:channel:UCscheduled</id></feed>", {
          headers: { "content-type": "application/atom+xml" },
        });
      throw new Error("Unexpected external request");
    });
    vi.stubGlobal("fetch", external);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:01:00.000Z"));
    await runScheduledSync(target);
    expect(external).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-10-23T12:10:00.000Z"));
    await runScheduledSync(target);
    expect(external).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await db
          .prepare(
            "SELECT type FROM sync_jobs WHERE account_id='scheduled-owner'",
          )
          .first<{ type: string }>()
      )?.type,
    ).toBe("subscriptions");
  });
  it("queues only subscriptions for all and returns rss as a no-op", async () => {
    const { handleSync } = await import("../worker/sync");
    const account = await createAccount("queue-owner");
    const sent: Array<{ jobId: string; version: number }> = [];
    const queueEnv = {
      ...env,
      SYNC_QUEUE: {
        send: vi.fn(async (message: { jobId: string; version: number }) => {
          sent.push(message);
        }),
      },
    } as unknown as Env;
    const external = vi.fn(async () => {
      throw new Error("unexpected external request");
    });
    vi.stubGlobal("fetch", external);

    const summary = await handleSync(queueEnv, account, "all");
    expect(summary).toMatchObject({
      type: "subscriptions",
      mode: "real",
      status: "running",
    });
    expect(sent).toHaveLength(1);
    const job = await db
      .prepare("SELECT * FROM sync_jobs WHERE account_id=?")
      .bind(account.id)
      .first<{ type: string; state: string }>();
    expect(job?.type).toBe("subscriptions");
    expect(JSON.parse(job?.state ?? "{}")).toMatchObject({
      phase: "subscriptions",
      requested: "subscriptions",
    });
    expect(external).not.toHaveBeenCalled();

    const rss = await handleSync(queueEnv, account, "rss");
    expect(rss).toMatchObject({ type: "rss", status: "noop", items: 0 });
    expect(sent).toHaveLength(1);
    expect(external).not.toHaveBeenCalled();
  });

  it("cuts persisted all/rss/metadata jobs to done without external requests", async () => {
    const { consumeSyncQueue } = await import("../worker/queue-sync");
    const jobs = [
      {
        account: "legacy-all-rss",
        type: "all",
        requested: "all",
        phase: "rss",
      },
      {
        account: "legacy-rss-meta",
        type: "rss",
        requested: "rss",
        phase: "metadata",
      },
      {
        account: "legacy-all-meta",
        type: "all",
        requested: "all",
        phase: "metadata",
      },
    ] as const;
    const messages: Array<{
      body: { jobId: string; version: number };
      ack: () => void;
      retry: () => void;
    }> = [];
    for (const job of jobs) {
      await createAccount(job.account);
      const id = `job-${job.account}`;
      const state = {
        phase: job.phase,
        requested: job.requested,
        force: false,
        startedAt: NOW,
        lastSuccessAt: "2026-01-01T00:00:00.000Z",
        since: "2026-01-01T00:00:00.000Z",
        generation: "legacy-generation",
        items: 0,
        processedChannels: 0,
        processedPlaylists: 0,
        ...(job.phase === "rss"
          ? {
              rss: {
                id: "UClegacy",
                title: "Legacy",
                entries: [],
                offset: 0,
                etag: null,
                modified: null,
              },
            }
          : { metadataScope: "public", metadataCursor: "legacy" }),
      };
      await db
        .prepare(
          `INSERT INTO sync_jobs
             (id,account_id,type,status,state,version,enqueued_version,created_at,updated_at)
           VALUES (?,?,?,'queued',?,0,-1,?,?)`,
        )
        .bind(id, job.account, job.type, JSON.stringify(state), NOW, NOW)
        .run();
      messages.push({
        body: { jobId: id, version: 0 },
        ack: vi.fn(),
        retry: vi.fn(),
      });
    }
    const external = vi.fn(async () => {
      throw new Error("unexpected external request");
    });
    vi.stubGlobal("fetch", external);

    await consumeSyncQueue(fakeBatch(messages), env);

    expect(external).not.toHaveBeenCalled();
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
      const job = await db
        .prepare("SELECT * FROM sync_jobs WHERE id=?")
        .bind(message.body.jobId)
        .first<{ status: string; state: string; version: number }>();
      expect(job?.status).toBe("success");
      expect(job?.version).toBe(1);
      const state = JSON.parse(job?.state ?? "{}");
      expect(state.phase).toBe("done");
      expect(state.rss).toBeUndefined();
    }
  });
});

describe("global feed revision cache", () => {
  it("invalidates feed caches when the global epoch changes without account fanout, while playlist caches stay hot", async () => {
    await createAccount("cache-a");
    await createAccount("cache-b");
    const kv = new FakeKV();
    const cacheEnv = {
      ...env,
      READ_CACHE: kv as unknown as KVNamespace,
    } as Env;
    const feedLoader = vi.fn(async () => ({
      items: [feedVideo("cachefeed01")],
      nextCursor: null,
    }));
    const playlistLoader = vi.fn(async () => [playlistSummary("pl-cache")]);

    const first = await cachedFeed(
      cacheEnv,
      "cache-a",
      "status=all",
      feedLoader,
    );
    expect(first.cache).toBe("miss");
    const hit = await cachedFeed(cacheEnv, "cache-a", "status=all", feedLoader);
    expect(hit.cache).toBe("hit");
    expect(feedLoader).toHaveBeenCalledTimes(1);
    const playlistFirst = await cachedPlaylists(
      cacheEnv,
      "cache-a",
      "scope=external",
      playlistLoader,
    );
    expect(playlistFirst.cache).toBe("miss");
    const playlistHit = await cachedPlaylists(
      cacheEnv,
      "cache-a",
      "scope=external",
      playlistLoader,
    );
    expect(playlistHit.cache).toBe("hit");
    expect(playlistLoader).toHaveBeenCalledTimes(1);
    const generationBefore = await cacheGeneration("cache-a");
    expect(generationBefore).not.toBeNull();
    expect(await cacheGeneration("cache-b")).toBeNull();
    expect(await cacheGenerationRows()).toBe(1);

    await db
      .prepare("UPDATE youtube_feed_state SET revision=revision+1 WHERE id=1")
      .run();
    const invalidated = await cachedFeed(
      cacheEnv,
      "cache-a",
      "status=all",
      feedLoader,
    );
    expect(invalidated.cache).toBe("miss");
    expect(feedLoader).toHaveBeenCalledTimes(2);
    expect(await cacheGeneration("cache-a")).toBe(generationBefore);
    // The epoch is global read-only state: no per-account generation writes.
    expect(await cacheGeneration("cache-b")).toBeNull();
    expect(await cacheGenerationRows()).toBe(1);

    const playlistStillHot = await cachedPlaylists(
      cacheEnv,
      "cache-a",
      "scope=external",
      playlistLoader,
    );
    expect(playlistStillHot.cache).toBe("hit");
    expect(playlistLoader).toHaveBeenCalledTimes(1);
  });

  it("returns a cheap account-isolated revision without feed or playlist scans", async () => {
    await createAccount("rev-a");
    await createAccount("rev-b");
    const kv = new FakeKV();
    const cacheEnv = {
      ...env,
      READ_CACHE: kv as unknown as KVNamespace,
    } as Env;
    const firstA = await feedRevision(cacheEnv, "rev-a");
    const firstB = await feedRevision(cacheEnv, "rev-b");
    expect(firstA).not.toBe(firstB);
    await invalidateReads(cacheEnv, "rev-a");
    expect(await feedRevision(cacheEnv, "rev-a")).not.toBe(firstA);
    expect(await feedRevision(cacheEnv, "rev-b")).toBe(firstB);

    await db
      .prepare("UPDATE youtube_feed_state SET revision=revision+1 WHERE id=1")
      .run();
    expect(await feedRevision(cacheEnv, "rev-b")).not.toBe(firstB);

    const statements: string[] = [];
    await feedRevision(
      { ...cacheEnv, DB: countingDb(db, statements) } as Env,
      "rev-a",
    );
    expect(statements).toHaveLength(2);
    expect(
      statements.some((sql) => sql.includes("FROM youtube_feed_state")),
    ).toBe(true);
    expect(
      statements.some((sql) => /FROM videos|FROM playlist|purge/i.test(sql)),
    ).toBe(false);
  });
});

describe("API and callback authentication boundaries", () => {
  it("requires a browser session for feed revision and exposes automatic discovery", async () => {
    const worker = (await import("../worker/index")).default;
    await createAccount("api-owner");
    const { cookie } = await seedSession("api-owner");
    const unauthenticated = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/feed/revision`),
      env,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("set-cookie")).toBeNull();

    const statements: string[] = [];
    const authenticated = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/feed/revision`, {
        headers: { cookie },
      }),
      { ...env, DB: countingDb(db, statements) } as Env,
    );
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("set-cookie")).toBeNull();
    const payload = (await authenticated.json()) as { revision: string };
    expect(payload.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(
      statements.some((sql) => /FROM videos|FROM playlist|purge/i.test(sql)),
    ).toBe(false);

    const session = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/session`, { headers: { cookie } }),
      env,
    );
    expect(session.status).toBe(200);
    expect(
      (
        (await session.json()) as {
          capabilities: { automaticDiscovery?: boolean };
        }
      ).capabilities.automaticDiscovery,
    ).toBe(true);
  });

  it("routes the public callback ahead of sessions/CSRF and never creates a browser session", async () => {
    const worker = (await import("../worker/index")).default;
    await createAccount("callback-owner");
    await insertChannel("UCcallback");
    await subscribe("callback-owner", "UCcallback");
    await db
      .prepare(
        `UPDATE websub_channels SET desired=1,hub_state='subscribed',
           hub_lease_expires_at='2099-01-01T00:00:00.000Z',
           hub_next_attempt_at='2099-01-01T00:00:00.000Z',
           rss_next_at='2099-01-01T00:00:00.000Z'
         WHERE channel_id='UCcallback'`,
      )
      .run();
    const sessionsBefore = await sessionCount();
    const invalidUrl = new URL(WEBSUB_CALLBACK_PATH, APP_ORIGIN);
    invalidUrl.searchParams.set("channel", "UCcallback");
    invalidUrl.searchParams.set("token", "invalid-routing-token");
    const invalid = await worker.fetch(
      new Request(invalidUrl, {
        method: "POST",
        headers: { "content-type": "application/atom+xml" },
        body: atom("UCcallback", "callback001"),
      }),
      env,
    );
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("set-cookie")).toBeNull();
    expect(await sessionCount()).toBe(sessionsBefore);

    const baseline = (
      await db
        .prepare("SELECT revision FROM youtube_feed_state WHERE id=1")
        .first<{ revision: number }>()
    )?.revision;
    const callbackUrl = new URL(WEBSUB_CALLBACK_PATH, APP_ORIGIN);
    callbackUrl.searchParams.set("channel", "UCcallback");
    callbackUrl.searchParams.set(
      "token",
      await websubRoutingToken(env, "UCcallback"),
    );
    const body = atom("UCcallback", "callback001");
    const valid = await worker.fetch(
      new Request(callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/atom+xml",
          "x-hub-signature": await hmacHeader("UCcallback", body),
        },
        body,
      }),
      env,
    );
    expect(valid.status).toBe(204);
    expect(valid.headers.get("set-cookie")).toBeNull();
    expect(await sessionCount()).toBe(sessionsBefore);
    expect(
      (
        await db
          .prepare("SELECT title FROM videos WHERE id='callback001'")
          .first<{ title: string }>()
      )?.title,
    ).toBe("Callback callback001");
    expect(
      (
        await db
          .prepare("SELECT revision FROM youtube_feed_state WHERE id=1")
          .first<{ revision: number }>()
      )?.revision,
    ).toBe((baseline ?? 0) + 1);
  });
});
