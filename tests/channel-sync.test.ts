import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Env } from "../worker/types";
import { readGlobalFeedRevision, runChannelSync } from "../worker/channel-sync";
import {
  WEBSUB_CALLBACK_PATH,
  WEBSUB_HUB_URL,
  handleWebSub,
  ingestParsedEntries,
  websubRoutingToken,
  websubTopicUrl,
} from "../worker/websub";
import { parseAtomFeed } from "../worker/rss";

const SECRET = "fixture-websub-secret-not-a-real-credential";
const APP_ORIGIN = "https://alveo.test";
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
  "0013_exclusions.sql",
  "0014_exclusion_websub.sql",
  "0015_short_retention.sql",
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

async function applyMigration(db: D1Database, name: string): Promise<void> {
  const sql = await readFile(
    new URL(`../migrations/${name}`, import.meta.url),
    "utf8",
  );
  for (const statement of splitSql(sql)) {
    await db.prepare(statement).run();
  }
}

async function applyMigrations(
  db: D1Database,
  names: string[] = ALL_MIGRATIONS,
): Promise<void> {
  for (const name of names) await applyMigration(db, name);
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
let hubPosts: URLSearchParams[];
let feedRequests: Array<{ url: URL; headers: Headers }>;
let feedHandler: (url: URL, headers: Headers) => Promise<Response>;

const emptyFeed = (channelId: string): Response =>
  new Response(
    `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><id>yt:channel:${channelId}</id><title>Channel ${channelId}</title></feed>`,
    { status: 200, headers: { etag: '"empty"' } },
  );

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

async function insertAccount(
  id: string,
  connected = 1,
  mode: "real" | "demo" = "real",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO accounts(id,mode,name,connected,scopes,created_at,updated_at)
       VALUES (?, ?, ?, ?, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(id, mode, id, connected)
    .run();
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

async function subscribe(
  accountId: string,
  channelId: string,
  active = 1,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions(account_id,channel_id,active,created_at,updated_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(accountId, channelId, active)
    .run();
}

async function insertVideo(
  id: string,
  channelId: string,
  publishedAt: string,
  title = `Video ${id}`,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO videos
         (id,channel_id,channel_title,title,description,thumbnail_url,published_at,
          duration_seconds,view_count,source,fetched_at,expires_at,purged_at,
          created_at,updated_at,websub_updated_at)
       VALUES (?,?,'Channel',?,'',?,?,NULL,NULL,'rss','2026-01-01T00:00:00.000Z',
              '2099-01-01T00:00:00.000Z',NULL,'2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',?)`,
    )
    .bind(id, channelId, title, "", publishedAt, publishedAt)
    .run();
}

async function setWatch(
  accountId: string,
  videoId: string,
  watched: 0 | 1,
  percent = 0,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watch_states
         (account_id,video_id,watched,watched_at,position_seconds,percent,manual,revision,updated_at)
       VALUES (?,?,?,?,?,?,0,1,'2026-01-01T00:00:00.000Z')
       ON CONFLICT(account_id,video_id) DO UPDATE SET
         watched = excluded.watched, watched_at = excluded.watched_at,
         percent = excluded.percent, position_seconds = excluded.position_seconds,
         revision = watch_states.revision + 1`,
    )
    .bind(
      accountId,
      videoId,
      watched,
      watched ? "2026-01-01T00:00:00.000Z" : null,
      percent,
      percent,
    )
    .run();
}

function meter(database: D1Database) {
  let read = 0;
  let written = 0;
  const executed: string[] = [];
  const native = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (key === "all" || key === "first")
          return async (column?: string) => {
            const result = await target.all<Record<string, unknown>>();
            read += result.meta.rows_read || 0;
            written += result.meta.rows_written || 0;
            executed.push(sql);
            return key === "all"
              ? result
              : column
                ? (result.results?.[0]?.[column] ?? null)
                : (result.results?.[0] ?? null);
          };
        if (key === "run")
          return async () => {
            const result = await target.run();
            read += result.meta.rows_read || 0;
            written += result.meta.rows_written || 0;
            executed.push(sql);
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    native.set(proxy, statement);
    return proxy;
  };
  return {
    db: new Proxy(database, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => wrap(target.prepare(sql), sql);
        if (key === "batch")
          return async (batch: D1PreparedStatement[]) => {
            const results = await target.batch(
              batch.map((statement) => native.get(statement) ?? statement),
            );
            for (const result of results) {
              read += result.meta.rows_read || 0;
              written += result.meta.rows_written || 0;
            }
            executed.push(`batch(${batch.length})`);
            return results;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database,
    get reads() {
      return read;
    },
    get writes() {
      return written;
    },
    count(match: string): number {
      return executed.filter((sql) => sql.includes(match)).length;
    },
  };
}

/**
 * Runs one side effect immediately before the next D1 batch, which lets a test
 * place a concurrent write exactly between ingest's read and its CAS write.
 */
function withBatchSideEffect(
  database: D1Database,
  effect: () => Promise<void>,
): D1Database {
  let fired = false;
  return new Proxy(database, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await effect();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

async function quiesceOthers(channelId: string, now: string): Promise<void> {
  await db
    .prepare(
      `UPDATE websub_channels SET
         hub_state = 'subscribed', hub_lease_expires_at = ?,
         hub_next_attempt_at = ?, rss_next_at = ?, hub_pending_mode = NULL,
         hub_pending_token = NULL, hub_pending_deadline = NULL,
         hub_claim_token = NULL, rss_claim_token = NULL
       WHERE channel_id <> ?`,
    )
    .bind(
      plus(now, 30 * 86400000),
      plus(now, 30 * 86400000),
      plus(now, 30 * 86400000),
      channelId,
    )
    .run();
}

async function seedSubscribedChannel(
  accountId: string,
  channelId: string,
  now: string,
): Promise<void> {
  await insertAccount(accountId);
  await insertChannel(channelId);
  await subscribe(accountId, channelId);
  await quiesceOthers(channelId, now);
  await db
    .prepare(
      `UPDATE websub_channels SET
         hub_state = 'subscribed', hub_lease_expires_at = ?,
         hub_next_attempt_at = ?, rss_next_at = ?
       WHERE channel_id = ?`,
    )
    .bind(plus(now, 30 * 86400000), plus(now, 30 * 86400000), now, channelId)
    .run();
}

async function verifyHub(
  channelId: string,
  mode: "subscribe" | "unsubscribe",
  challenge: string,
  leaseSeconds?: number,
): Promise<Response> {
  const callback = new URL(WEBSUB_CALLBACK_PATH, APP_ORIGIN);
  callback.searchParams.set("channel", channelId);
  callback.searchParams.set("token", await websubRoutingToken(env, channelId));
  callback.searchParams.set("hub.mode", mode);
  callback.searchParams.set("hub.topic", websubTopicUrl(channelId));
  callback.searchParams.set("hub.challenge", challenge);
  if (leaseSeconds !== undefined)
    callback.searchParams.set("hub.lease_seconds", String(leaseSeconds));
  return handleWebSub(new Request(callback, { method: "GET" }), env);
}

function atomFeed(
  channelId: string,
  entries: Array<{
    id: string;
    title: string;
    published: string;
    owner?: string;
    description?: string;
    extra?: string;
  }>,
): string {
  return `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
    <id>yt:channel:${channelId}</id><title>Channel ${channelId}</title>
    ${entries
      .map(
        (entry) => `<entry>
          <yt:videoId>${entry.id}</yt:videoId>
          <yt:channelId>${entry.owner ?? channelId}</yt:channelId>
          <title>${entry.title}</title>
          <published>${entry.published}</published>
          ${entry.description !== undefined ? `<media:group><media:description>${entry.description}</media:description></media:group>` : ""}
          ${entry.extra ?? ""}
        </entry>`,
      )
      .join("")}
  </feed>`;
}

beforeAll(async () => {
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  // Seed pre-existing eligible followers before 0010 to exercise the backfill.
  await applyMigrations(db, ALL_MIGRATIONS.slice(0, -4));
  await insertAccount("pre-owner");
  await insertAccount("demo-owner", 1, "demo");
  await insertAccount("off-owner", 0);
  for (const channelId of ["UCmigration", "UCdemoonly", "UCoffline"]) {
    await insertChannel(channelId);
  }
  await subscribe("pre-owner", "UCmigration");
  await subscribe("demo-owner", "UCdemoonly");
  await subscribe("off-owner", "UCoffline");
  await applyMigration(db, "0010_websub_channels.sql");
  await applyMigration(db, "0013_exclusions.sql");
  await applyMigration(db, "0014_exclusion_websub.sql");
  await applyMigration(db, "0015_short_retention.sql");

  env = {
    DB: db,
    MODE: "real",
    APP_ORIGIN,
    WEBSUB_ENABLED: "true",
    WEBSUB_SECRET: SECRET,
  } as unknown as Env;
}, 30000);

beforeEach(() => {
  hubPosts = [];
  feedRequests = [];
  feedHandler = async (url) =>
    emptyFeed(url.searchParams.get("channel_id") ?? "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const url = new URL(raw);
      if (raw === WEBSUB_HUB_URL) {
        hubPosts.push(new URLSearchParams(String(init?.body ?? "")));
        return new Response("", { status: 202 });
      }
      if (
        url.hostname === "www.youtube.com" &&
        url.pathname === "/feeds/videos.xml"
      ) {
        const headers = new Headers(init?.headers);
        feedRequests.push({ url, headers });
        return feedHandler(url, headers);
      }
      throw new Error(`Unexpected fetch in test: ${raw}`);
    }),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

describe("global channel lifecycle", () => {
  it("backfills eligible followers and reconciles shared membership with triggers", async () => {
    const rows = await db
      .prepare(
        "SELECT channel_id, desired FROM websub_channels WHERE channel_id IN ('UCmigration','UCdemoonly','UCoffline') ORDER BY channel_id",
      )
      .all<{ channel_id: string; desired: number }>();
    expect(rows.results).toEqual([{ channel_id: "UCmigration", desired: 1 }]);

    const channelId = "UCtrigger";
    const other = "UCtriggerother";
    await insertChannel(channelId);
    await insertChannel(other);
    await insertAccount("trigger-a");
    await insertAccount("trigger-b");
    await subscribe("trigger-a", channelId);
    await subscribe("trigger-b", channelId);

    let shared = await db
      .prepare(
        "SELECT channel_id, desired FROM websub_channels WHERE channel_id = ?",
      )
      .bind(channelId)
      .all<{ channel_id: string; desired: number }>();
    expect(shared.results).toEqual([{ channel_id: channelId, desired: 1 }]);

    await db
      .prepare(
        "UPDATE subscriptions SET active = 0 WHERE account_id = 'trigger-a' AND channel_id = ?",
      )
      .bind(channelId)
      .run();
    const afterOneLeaves = await db
      .prepare(
        "SELECT desired, rss_next_at FROM websub_channels WHERE channel_id = ?",
      )
      .bind(channelId)
      .all<{ desired: number; rss_next_at: string | null }>();
    expect(afterOneLeaves.results?.[0].desired).toBe(1);

    await db
      .prepare("UPDATE accounts SET connected = 0 WHERE id = 'trigger-b'")
      .run();
    const afterDisconnect = await db
      .prepare(
        "SELECT desired, rss_next_at FROM websub_channels WHERE channel_id = ?",
      )
      .bind(channelId)
      .all<{ desired: number; rss_next_at: string | null }>();
    expect(afterDisconnect.results?.[0].desired).toBe(0);
    expect(afterDisconnect.results?.[0].rss_next_at).toBeNull();

    await db
      .prepare("UPDATE accounts SET connected = 1 WHERE id = 'trigger-b'")
      .run();
    const afterReconnect = await db
      .prepare(
        "SELECT desired, hub_next_attempt_at FROM websub_channels WHERE channel_id = ?",
      )
      .bind(channelId)
      .all<{ desired: number; hub_next_attempt_at: string | null }>();
    expect(afterReconnect.results?.[0].desired).toBe(1);
    expect(afterReconnect.results?.[0].hub_next_attempt_at).not.toBeNull();

    // A demo account never creates a global hub subscription.
    await insertChannel("UCdemotrigger");
    await subscribe("demo-owner", "UCdemotrigger");
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM websub_channels WHERE channel_id = 'UCdemotrigger'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);

    await db
      .prepare(
        "UPDATE subscriptions SET channel_id = ? WHERE account_id = 'trigger-b' AND channel_id = ?",
      )
      .bind(other, channelId)
      .run();
    const moved = await db
      .prepare(
        "SELECT channel_id, desired FROM websub_channels WHERE channel_id IN (?, ?) ORDER BY channel_id",
      )
      .bind(channelId, other)
      .all<{ channel_id: string; desired: number }>();
    expect(moved.results).toEqual([
      { channel_id: channelId, desired: 0 },
      { channel_id: other, desired: 1 },
    ]);
  });
});

describe("WebSub registration lifecycle", () => {
  it("registers, renews before lease expiry, cancels after the last follower and rejoins", async () => {
    const channelId = "UChublifecycle";
    const now = new Date().toISOString();
    await seedSubscribedChannel("hub-owner", channelId, now);
    // Start from the trigger-created due state to exercise registration.
    await db
      .prepare(
        `UPDATE websub_channels SET hub_state='idle',
           hub_lease_expires_at=NULL, hub_next_attempt_at=?, rss_next_at=?
         WHERE channel_id=?`,
      )
      .bind(now, plus(now, 86400000), channelId)
      .run();

    const first = await runChannelSync(env, now);
    expect(first.hub.subscribe).toBe(1);
    expect(hubPosts).toHaveLength(1);
    const registration = hubPosts[0];
    expect(registration.get("hub.mode")).toBe("subscribe");
    expect(registration.get("hub.topic")).toBe(websubTopicUrl(channelId));
    expect(registration.get("hub.verify")).toBe("async");
    expect(registration.get("hub.lease_seconds")).toBe("345600");
    expect(registration.get("hub.secret")).toBeTruthy();
    expect(registration.get("hub.secret")).not.toBe(SECRET);
    const callback = new URL(registration.get("hub.callback") ?? "");
    expect(callback.origin).toBe(APP_ORIGIN);
    expect(callback.pathname).toBe(WEBSUB_CALLBACK_PATH);
    expect(callback.searchParams.get("channel")).toBe(channelId);
    expect(callback.searchParams.get("token")).toBe(
      await websubRoutingToken(env, channelId),
    );

    let row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id = ?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.hub_state).toBe("pending_subscribe");
    expect(row?.hub_pending_mode).toBe("subscribe");
    expect(row?.hub_verified_at).toBeNull();

    const challenge = "challenge-subscribe-1";
    const verified = await verifyHub(channelId, "subscribe", challenge, 3600);
    expect(verified.status).toBe(200);
    expect(await verified.text()).toBe(challenge);
    expect(verified.headers.get("cache-control")).toBe("no-store");
    row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id = ?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.hub_state).toBe("subscribed");
    expect(row?.hub_pending_mode).toBeNull();
    const firstLease = String(row?.hub_lease_expires_at);
    expect(
      Math.abs(Date.parse(firstLease) - (Date.now() + 3600_000)),
    ).toBeLessThan(5000);
    // Short leases renew with a 25% buffer rather than the full 12h default.
    const renewalBuffer = Math.min(12 * 3600_000, 3600_000 / 4);
    expect(
      Math.abs(
        Date.parse(String(row?.hub_next_attempt_at)) -
          (Date.parse(firstLease) - renewalBuffer),
      ),
    ).toBeLessThan(1000);

    const renewalAt = String(row?.hub_next_attempt_at);
    const renewal = await runChannelSync(env, renewalAt);
    expect(renewal.hub.subscribe).toBe(1);
    expect(hubPosts).toHaveLength(2);
    expect(hubPosts[1].get("hub.mode")).toBe("subscribe");
    row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id = ?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.hub_state).toBe("pending_subscribe");
    // Renewal keeps the previous lease until the hub verifies the new one.
    expect(row?.hub_lease_expires_at).toBe(firstLease);
    const renewed = await verifyHub(
      channelId,
      "subscribe",
      "challenge-renew",
      7200,
    );
    expect(renewed.status).toBe(200);
    row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id = ?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.hub_state).toBe("subscribed");
    expect(Date.parse(String(row?.hub_lease_expires_at))).toBeGreaterThan(
      Date.parse(firstLease),
    );

    await db
      .prepare(
        "UPDATE subscriptions SET active = 0 WHERE account_id = 'hub-owner' AND channel_id = ?",
      )
      .bind(channelId)
      .run();
    const cancel = await runChannelSync(env, plus(now, 120_000));
    expect(cancel.hub.unsubscribe).toBe(1);
    expect(hubPosts).toHaveLength(3);
    expect(hubPosts[2].get("hub.mode")).toBe("unsubscribe");
    expect(hubPosts[2].get("hub.secret")).toBeNull();
    expect(
      (
        await db
          .prepare("SELECT hub_state FROM websub_channels WHERE channel_id = ?")
          .bind(channelId)
          .first<{ hub_state: string }>()
      )?.hub_state,
    ).toBe("pending_unsubscribe");
    expect(
      (await verifyHub(channelId, "unsubscribe", "challenge-cancel")).status,
    ).toBe(200);
    row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id = ?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.desired).toBe(0);
    expect(row?.hub_state).toBe("unsubscribed");
    expect(row?.hub_lease_expires_at).toBeNull();

    await db
      .prepare(
        "UPDATE subscriptions SET active = 1 WHERE account_id = 'hub-owner' AND channel_id = ?",
      )
      .bind(channelId)
      .run();
    const rejoin = await runChannelSync(env, plus(now, 180_000));
    expect(rejoin.hub.subscribe).toBe(1);
    expect(hubPosts).toHaveLength(4);
    expect(hubPosts[3].get("hub.mode")).toBe("subscribe");
  });

  it("serializes concurrent cron ticks to a single hub request", async () => {
    const channelId = "UCconcurrent";
    const now = new Date().toISOString();
    await seedSubscribedChannel("concurrent-owner", channelId, now);
    await db
      .prepare(
        `UPDATE websub_channels SET hub_state='idle', hub_lease_expires_at=NULL,
           hub_next_attempt_at=?, rss_next_at=?
         WHERE channel_id=?`,
      )
      .bind(now, plus(now, 86400000), channelId)
      .run();
    const [first, second] = await Promise.all([
      runChannelSync(env, now),
      runChannelSync(env, now),
    ]);
    expect(first.operations + second.operations).toBe(1);
    expect(hubPosts).toHaveLength(1);
  });
});

describe("global daily RSS", () => {
  it("imports unknowns up to one year, coalesces the day, keeps validators and skips unchanged metadata", async () => {
    const channelId = "UCrssdaily";
    const now = new Date().toISOString();
    await seedSubscribedChannel("rss-owner", channelId, now);
    const baseline = await readGlobalFeedRevision(db);

    const firstPublished = plus(now, -3600_000);
    feedHandler = async () =>
      new Response(
        atomFeed(channelId, [
          {
            id: "rssone00001",
            title: "First",
            published: firstPublished,
            extra:
              '<media:group><media:description>Rich</media:description><media:thumbnail url="https://i.ytimg.com/vi/rssone00001/hq.jpg"/><media:community><media:statistics views="10"/></media:community><media:content duration="240"/></media:group>',
          },
          {
            id: "recent00001",
            title: "Two days old",
            published: plus(now, -2 * 86400_000),
          },
          {
            id: "oldyear0001",
            title: "Too old year",
            published: plus(now, -400 * 86400000),
          },
        ]),
        {
          status: 200,
          headers: {
            etag: '"etag-1"',
            "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
          },
        },
      );

    const first = await runChannelSync(env, now);
    expect(first.rss.attempted).toBe(1);
    // Unknown videos inside the one-year window are imported: the old 24h
    // bootstrap ceiling no longer applies to the daily latest-entries sweep.
    expect(first.rss.inserted).toBe(2);
    expect(first.rss.updated).toBe(0);
    let row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id = ?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.rss_etag).toBe('"etag-1"');
    expect(row?.rss_last_modified).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(row?.rss_failures).toBe(0);
    expect(row?.rss_next_at).toBe(plus(now, 86400000));
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 2);
    const firstVideo = await db
      .prepare(
        "SELECT id,title,duration_seconds,view_count FROM videos WHERE id='rssone00001'",
      )
      .first<Record<string, unknown>>();
    expect(firstVideo?.title).toBe("First");
    expect(firstVideo?.duration_seconds).toBe(240);
    expect(firstVideo?.view_count).toBe(10);
    expect(
      await db
        .prepare(
          "SELECT id FROM videos WHERE id IN ('recent00001','oldyear0001') ORDER BY id",
        )
        .all<{ id: string }>(),
    ).toMatchObject({ results: [{ id: "recent00001" }] });

    const sameDay = await runChannelSync(env, plus(now, 3600_000));
    expect(sameDay.operations).toBe(0);
    expect(feedRequests).toHaveLength(1);

    const nextDay = plus(now, 25 * 3600_000);
    const secondPublished = plus(nextDay, -3600_000);
    const secondUpdated = plus(nextDay, -1800_000);
    feedHandler = async () =>
      new Response(
        atomFeed(channelId, [
          {
            id: "rssone00001",
            title: "First",
            published: firstPublished,
            extra: `<updated>${secondUpdated}</updated>`,
          },
          {
            id: "rsstwo00002",
            title: "Second",
            published: secondPublished,
          },
        ]),
        { status: 200, headers: { etag: '"etag-2"' } },
      );
    const secondMeter = meter(db);
    const second = await runChannelSync(
      { ...env, DB: secondMeter.db } as unknown as Env,
      nextDay,
    );
    expect(second.rss.inserted).toBe(1);
    // A newer <updated> with an identical content fingerprint writes exactly
    // one ordering stamp: no visible metadata change and no feed epoch bump.
    // Stats report it as skipped, never as updated.
    expect(second.rss.updated).toBe(0);
    expect(second.rss.skipped).toBe(1);
    expect(secondMeter.count("batch(")).toBe(1);
    expect(feedRequests[1].headers.get("if-none-match")).toBe('"etag-1"');
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 3);
    const unchanged = await db
      .prepare(
        "SELECT title, websub_updated_at FROM videos WHERE id='rssone00001'",
      )
      .first<{ title: string; websub_updated_at: string }>();
    expect(unchanged?.title).toBe("First");
    expect(unchanged?.websub_updated_at).toBe(secondUpdated);
    console.log("WebSub RSS ordering stamp", {
      updated: second.rss.updated,
      inserted: second.rss.inserted,
      revision: await readGlobalFeedRevision(db),
      watermark: unchanged?.websub_updated_at,
    });
    row = await db
      .prepare(
        "SELECT rss_etag, rss_next_at FROM websub_channels WHERE channel_id = ?",
      )
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.rss_etag).toBe('"etag-2"');
    expect(row?.rss_next_at).toBe(plus(nextDay, 86400000));

    const thirdDay = plus(nextDay, 86400000);
    feedHandler = async () => new Response(null, { status: 304 });
    const third = await runChannelSync(env, thirdDay);
    expect(third.rss.notModified).toBe(1);
    expect(third.rss.inserted).toBe(0);
    expect(third.rss.updated).toBe(0);
    expect(feedRequests[2].headers.get("if-none-match")).toBe('"etag-2"');
    row = await db
      .prepare(
        "SELECT rss_etag, rss_next_at FROM websub_channels WHERE channel_id = ?",
      )
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.rss_etag).toBe('"etag-2"');
    expect(row?.rss_next_at).toBe(plus(thirdDay, 86400000));
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 3);
  });

  it("enriches sparse push metadata at the same updated timestamp and honors explicit empty descriptions", async () => {
    const channelId = "UCenrich";
    const now = new Date().toISOString();
    await seedSubscribedChannel("enrich-owner", channelId, now);
    const baseline = await readGlobalFeedRevision(db);
    const published = plus(now, -7200_000);
    const updated = plus(now, -1800_000);

    const sparse = parseAtomFeed(
      atomFeed(channelId, [
        {
          id: "enrich00001",
          title: "Sparse",
          published,
          extra: `<updated>${updated}</updated>`,
        },
      ]),
    );
    const push = await ingestParsedEntries(
      env,
      channelId,
      sparse.entries,
      now,
      "push",
    );
    expect(push.inserted).toBe(1);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
    const video = () =>
      db
        .prepare(
          "SELECT title, description, websub_updated_at FROM videos WHERE id='enrich00001'",
        )
        .first<{
          title: string;
          description: string;
          websub_updated_at: string;
        }>();
    expect(await video()).toEqual({
      title: "Sparse",
      description: "",
      websub_updated_at: updated,
    });

    const dueAt = async (at: string): Promise<string> => {
      await db
        .prepare(
          "UPDATE websub_channels SET rss_next_at = ? WHERE channel_id = ?",
        )
        .bind(at, channelId)
        .run();
      return at;
    };
    const feed = (description?: string) => {
      feedHandler = async () =>
        new Response(
          atomFeed(channelId, [
            {
              id: "enrich00001",
              title: "Sparse",
              published,
              description,
              extra: `<updated>${updated}</updated>`,
            },
          ]),
          {
            status: 200,
            headers: {
              etag: `"${description === undefined ? "missing" : description}"`,
            },
          },
        );
    };

    // The full RSS feed may fill fields that the sparse push omitted even
    // though its raw <updated> is exactly the stored watermark.
    feed("Full description");
    const enriched = await runChannelSync(env, await dueAt(now));
    expect(enriched.rss.updated).toBe(1);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 2);
    expect(await video()).toMatchObject({
      title: "Sparse",
      description: "Full description",
      websub_updated_at: updated,
    });

    // Repeating the identical full RSS entry is still zero writes and zero
    // epoch even at the same timestamp.
    const duplicateMeter = meter(db);
    feed("Full description");
    const duplicate = await runChannelSync(
      { ...env, DB: duplicateMeter.db } as unknown as Env,
      await dueAt(plus(now, 60_000)),
    );
    expect(duplicate.rss.updated).toBe(0);
    expect(duplicateMeter.count("batch(")).toBe(0);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 2);

    // A missing media:description preserves the stored rich field.
    const missingMeter = meter(db);
    feed(undefined);
    const missing = await runChannelSync(
      { ...env, DB: missingMeter.db } as unknown as Env,
      await dueAt(plus(now, 120_000)),
    );
    expect(missing.rss.updated).toBe(0);
    expect(missingMeter.count("batch(")).toBe(0);
    expect((await video())?.description).toBe("Full description");

    // An explicit empty media:description is a real clear, not a missing field.
    feed("");
    const cleared = await runChannelSync(env, await dueAt(plus(now, 180_000)));
    expect(cleared.rss.updated).toBe(1);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 3);
    expect((await video())?.description).toBe("");
  });

  it("backs off a CAS conflict from the shared ingest instead of publishing validators", async () => {
    const channelId = "UCrssconflict";
    const now = new Date().toISOString();
    await seedSubscribedChannel("conflict-owner", channelId, now);
    const published = plus(now, -7200_000);
    const storedAt = plus(now, -5400_000);
    await insertVideo("conflict001", channelId, published, "Before");
    await db
      .prepare(
        "UPDATE videos SET websub_updated_at = ? WHERE id = 'conflict001'",
      )
      .bind(storedAt)
      .run();
    const baseline = await readGlobalFeedRevision(db);
    const updated = plus(now, -1800_000);
    const concurrentAt = plus(now, -3600_000);
    feedHandler = async () =>
      new Response(
        atomFeed(channelId, [
          {
            id: "conflict001",
            title: "After",
            published,
            extra: `<updated>${updated}</updated>`,
          },
        ]),
        { status: 200, headers: { etag: '"conflict"' } },
      );

    const conflictDb = withBatchSideEffect(db, async () => {
      await db
        .prepare(
          `UPDATE videos SET title='Concurrent', websub_updated_at=?,
             websub_hash='concurrent' WHERE id='conflict001'`,
        )
        .bind(concurrentAt)
        .run();
    });
    const conflicted = await runChannelSync(
      { ...env, DB: conflictDb } as unknown as Env,
      now,
    );
    expect(conflicted.rss.failed).toBe(1);
    expect(conflicted.rss.updated).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT title FROM videos WHERE id='conflict001'")
          .first<{ title: string }>()
      )?.title,
    ).toBe("Concurrent");
    expect(await readGlobalFeedRevision(db)).toBe(baseline);
    const failedRow = await db
      .prepare(
        "SELECT rss_etag, rss_failures, rss_next_at FROM websub_channels WHERE channel_id = ?",
      )
      .bind(channelId)
      .first<{
        rss_etag: string | null;
        rss_failures: number;
        rss_next_at: string | null;
      }>();
    expect(failedRow?.rss_etag).toBeNull();
    expect(failedRow?.rss_failures).toBe(1);

    // The leased backoff retry re-reads the concurrent row and applies the
    // newer event, so the conflict is recoverable without silent loss.
    const retry = await runChannelSync(env, String(failedRow?.rss_next_at));
    expect(retry.rss.failed).toBe(0);
    expect(retry.rss.updated).toBe(1);
    expect(
      (
        await db
          .prepare("SELECT title FROM videos WHERE id='conflict001'")
          .first<{ title: string }>()
      )?.title,
    ).toBe("After");
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
  });

  it("backs off failures, retries boundedly and never fetches when no active account remains", async () => {
    const channelId = "UCrssretry";
    const now = new Date().toISOString();
    await seedSubscribedChannel("retry-owner", channelId, now);
    await db
      .prepare(
        "UPDATE websub_channels SET rss_next_at = ? WHERE channel_id = ?",
      )
      .bind(now, channelId)
      .run();
    feedHandler = async () => new Response("nope", { status: 503 });
    const failed = await runChannelSync(env, now);
    expect(failed.rss.failed).toBe(1);
    expect(feedRequests).toHaveLength(1);
    let row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id = ?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.rss_failures).toBe(1);
    expect(Date.parse(String(row?.rss_next_at))).toBeGreaterThan(
      Date.parse(now),
    );
    expect(row?.rss_next_at).not.toBe(plus(now, 86400000));
    expect(row?.rss_etag).toBeNull();

    const immediate = await runChannelSync(env, plus(now, 1000));
    expect(immediate.rss.attempted).toBe(0);
    expect(feedRequests).toHaveLength(1);

    await db
      .prepare(
        "UPDATE websub_channels SET rss_next_at = ? WHERE channel_id = ?",
      )
      .bind(plus(now, 2000), channelId)
      .run();
    feedHandler = async () =>
      new Response(atomFeed(channelId, []), {
        status: 200,
        headers: { etag: '"retry-ok"' },
      });
    const recovered = await runChannelSync(env, plus(now, 2000));
    expect(recovered.rss.attempted).toBe(1);
    row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id = ?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.rss_failures).toBe(0);
    expect(row?.rss_etag).toBe('"retry-ok"');
    expect(row?.rss_next_at).toBe(plus(plus(now, 2000), 86400000));

    const noActive = "UCnoactive";
    await insertChannel(noActive);
    await insertAccount("noactive-owner");
    await subscribe("noactive-owner", noActive);
    await quiesceOthers(noActive, now);
    await db
      .prepare(
        "UPDATE websub_channels SET rss_next_at = ? WHERE channel_id = ?",
      )
      .bind(now, noActive)
      .run();
    await db
      .prepare("UPDATE accounts SET connected = 0 WHERE id = 'noactive-owner'")
      .run();
    expect(
      (
        await db
          .prepare("SELECT desired FROM websub_channels WHERE channel_id = ?")
          .bind(noActive)
          .first<{ desired: number }>()
      )?.desired,
    ).toBe(0);
    const beforeNoActive = feedRequests.length;
    const noAccountRun = await runChannelSync(env, plus(now, 3000));
    expect(noAccountRun.rss.attempted).toBe(0);
    expect(
      feedRequests
        .slice(beforeNoActive)
        .some(
          (request) => request.url.searchParams.get("channel_id") === noActive,
        ),
    ).toBe(false);
  });
  it("refreshes changed metadata only while an interested subscriber has not watched or a playlist holds the video", async () => {
    const channelId = "UCrsselig";
    const now = new Date().toISOString();
    await seedSubscribedChannel("elig-a", channelId, now);
    await insertAccount("elig-b");
    await subscribe("elig-b", channelId);
    const published = plus(now, -7200_000);
    await insertVideo("eligvideo01", channelId, published, "Before");
    // One subscriber already watched it; the second only has progress, which
    // must count as still pending.
    await setWatch("elig-a", "eligvideo01", 1, 100);
    await setWatch("elig-b", "eligvideo01", 0, 40);
    const baseline = await readGlobalFeedRevision(db);
    const videoState = () =>
      db
        .prepare(
          "SELECT title, websub_updated_at FROM videos WHERE id='eligvideo01'",
        )
        .first<{ title: string; websub_updated_at: string | null }>();
    const feed = (title: string, updated: string) => {
      feedHandler = async () =>
        new Response(
          atomFeed(channelId, [
            {
              id: "eligvideo01",
              title,
              published,
              extra: `<updated>${updated}</updated>`,
            },
          ]),
          { status: 200, headers: { etag: `"${title}"` } },
        );
    };
    const dueAt = async (at: string) => {
      await db
        .prepare(
          "UPDATE websub_channels SET rss_next_at = ? WHERE channel_id = ?",
        )
        .bind(at, channelId)
        .run();
      return at;
    };

    const firstMeter = meter(db);
    feed("After", plus(now, -1800_000));
    const first = await runChannelSync(
      { ...env, DB: firstMeter.db } as unknown as Env,
      await dueAt(now),
    );
    expect(first.rss.updated).toBe(1);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
    expect((await videoState())?.title).toBe("After");
    // One batched eligibility query for the payload, never one per entry.
    expect(firstMeter.count("FROM playlist_items pi")).toBe(1);
    expect(firstMeter.count("batch(")).toBe(1);

    // Watched by every interested subscriber and absent from every playlist:
    // skip the metadata entirely, including timestamps and the feed epoch.
    await setWatch("elig-a", "eligvideo01", 1, 100);
    await setWatch("elig-b", "eligvideo01", 1, 100);
    feed("Later", plus(now, -900_000));
    const skippedAt = plus(now, 60_000);
    const skippedMeter = meter(db);
    const skipped = await runChannelSync(
      { ...env, DB: skippedMeter.db } as unknown as Env,
      await dueAt(skippedAt),
    );
    expect(skipped.rss.attempted).toBe(1);
    expect(skipped.rss.updated).toBe(0);
    expect(skipped.rss.skipped).toBe(1);
    expect(skippedMeter.count("batch(")).toBe(0);
    expect(skippedMeter.count("FROM playlist_items pi")).toBe(1);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
    expect(await videoState()).toEqual({
      title: "After",
      websub_updated_at: plus(now, -1800_000),
    });

    // Any playlist of any account takes priority over the watched state.
    await db
      .prepare(
        `INSERT INTO playlists(id,account_id,source,title,created_at,updated_at)
         VALUES ('eliglist','elig-b','local','Keep','2026','2026')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO playlist_items(id,playlist_id,video_id,position,added_at)
         VALUES ('eligitem','eliglist','eligvideo01',0,'2026')`,
      )
      .run();
    feed("Later", plus(now, -300_000));
    const listedAt = plus(now, 120_000);
    const listed = await runChannelSync(env, await dueAt(listedAt));
    expect(listed.rss.updated).toBe(1);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 2);
    expect((await videoState())?.title).toBe("Later");

    // An RSS duplicate with the same raw <updated> and identical content still
    // writes nothing, even after watch-state mutations make it eligible again.
    await setWatch("elig-a", "eligvideo01", 0, 10);
    await setWatch("elig-b", "eligvideo01", 0, 10);
    feed("Later", plus(now, -300_000));
    const repeatMeter = meter(db);
    const repeat = await runChannelSync(
      { ...env, DB: repeatMeter.db } as unknown as Env,
      await dueAt(plus(now, 180_000)),
    );
    expect(repeat.rss.updated).toBe(0);
    expect(repeatMeter.count("batch(")).toBe(0);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 2);
    expect((await videoState())?.title).toBe("Later");
  });

  it("never refreshes an existing video published more than one year ago", async () => {
    const channelId = "UCrossold";
    const now = new Date().toISOString();
    await seedSubscribedChannel("old-owner", channelId, now);
    const published = plus(now, -400 * 86400000);
    await insertVideo("oldsync0001", channelId, published, "Ancient");
    const baseline = await readGlobalFeedRevision(db);
    feedHandler = async () =>
      new Response(
        atomFeed(channelId, [
          {
            id: "oldsync0001",
            title: "Changed",
            published,
            extra: `<updated>${plus(now, -60_000)}</updated>`,
          },
        ]),
        { status: 200 },
      );
    const run = await runChannelSync(env, now);
    expect(run.rss.attempted).toBe(1);
    expect(run.rss.updated).toBe(0);
    expect(run.rss.skipped).toBe(1);
    expect(
      (
        await db
          .prepare("SELECT title FROM videos WHERE id='oldsync0001'")
          .first<{ title: string }>()
      )?.title,
    ).toBe("Ancient");
    expect(await readGlobalFeedRevision(db)).toBe(baseline);
  });
});

describe("shared channel scale", () => {
  it("stores one row per channel shared by two accounts and stays bounded per tick", async () => {
    const scaleMf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: "2026-10-20",
        d1Databases: ["DB"],
      }),
    );
    try {
      const scaleDb = (await scaleMf.getD1Database(
        "DB",
      )) as unknown as D1Database;
      await applyMigrations(scaleDb);
      await scaleDb
        .prepare(
          `INSERT INTO accounts(id,mode,name,connected,created_at,updated_at)
           VALUES ('scale-a','real','A',1,'2026','2026'),('scale-b','real','B',1,'2026','2026')`,
        )
        .run();
      await scaleDb
        .prepare(
          `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<112)
           INSERT INTO channels(id,title,source,created_at,updated_at)
           SELECT printf('UCscale%019d',x),'Scale','youtube','2026','2026' FROM n`,
        )
        .run();
      await scaleDb
        .prepare(
          `INSERT INTO subscriptions(account_id,channel_id,active,created_at,updated_at)
           SELECT a.id,c.id,1,'2026','2026' FROM accounts a CROSS JOIN channels c`,
        )
        .run();
      const count = await scaleDb
        .prepare("SELECT COUNT(*) AS n FROM websub_channels")
        .first<{ n: number }>();
      expect(count?.n).toBe(113);
      await scaleDb
        .prepare(
          "UPDATE websub_channels SET hub_next_attempt_at='2026', rss_next_at='2026'",
        )
        .run();

      const scaleEnv = {
        DB: scaleDb,
        MODE: "real",
        APP_ORIGIN,
        WEBSUB_ENABLED: "true",
        WEBSUB_SECRET: SECRET,
      } as unknown as Env;
      let hubCalls = 0;
      let rssCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const raw =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (raw === WEBSUB_HUB_URL) {
            hubCalls += 1;
            return new Response("", { status: 202 });
          }
          rssCalls += 1;
          return emptyFeed(new URL(raw).searchParams.get("channel_id") ?? "");
        }),
      );
      const summary = await runChannelSync(
        scaleEnv,
        "2026-10-22T12:00:00.000Z",
      );
      console.log("WebSub scale", { channels: count?.n, hubCalls, rssCalls });
      expect(summary.operations).toBe(2);
      expect(hubCalls).toBe(1);
      expect(rssCalls).toBe(1);

      // 113 channels and 300 videos shared by two interested accounts: the
      // daily sweep must stay one-row-per-channel and must not fan out per
      // entry or per account. Costs are measured with a wrapping D1 proxy.
      await scaleDb
        .prepare(
          `UPDATE websub_channels SET hub_next_attempt_at='2099-01-01T00:00:00.000Z'`,
        )
        .run();
      const published = "2026-10-01T00:00:00.000Z";
      const updated = "2026-10-22T10:00:00.000Z";
      await scaleDb
        .prepare(
          `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<299)
           INSERT INTO videos
             (id,channel_id,channel_title,title,description,thumbnail_url,published_at,
              duration_seconds,view_count,source,fetched_at,expires_at,purged_at,
              created_at,updated_at,websub_updated_at)
           SELECT printf('scalev%05d',x),printf('UCscale%019d',x%113),'Scale',
                  'Scale video','','',?,
                  300,7,'rss','2026-10-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',
                  NULL,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z',?
           FROM n`,
        )
        .bind(published, published)
        .run();
      // Account A already watched every video; B is still pending, so the
      // eligibility rule must keep all 300 updates while reading followers in
      // one batched query per channel.
      await scaleDb
        .prepare(
          `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<299)
           INSERT INTO watch_states
             (account_id,video_id,watched,watched_at,position_seconds,percent,manual,revision,updated_at)
           SELECT 'scale-a',printf('scalev%05d',x),1,'2026-10-02T00:00:00.000Z',
                  0,100,1,1,'2026-10-02T00:00:00.000Z' FROM n`,
        )
        .run();
      const entriesByFeed = new Map<
        string,
        Array<{ id: string; title: string; published: string; extra: string }>
      >();
      const videos = await scaleDb
        .prepare(
          "SELECT id, channel_id FROM videos WHERE id LIKE 'scalev%' ORDER BY id",
        )
        .all<{ id: string; channel_id: string }>();
      for (const video of videos.results ?? []) {
        const entries = entriesByFeed.get(video.channel_id) ?? [];
        entries.push({
          id: video.id,
          title: "Scale video v2",
          published,
          extra: `<updated>${updated}</updated>`,
        });
        entriesByFeed.set(video.channel_id, entries);
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = new URL(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url,
          );
          if (url.toString() === WEBSUB_HUB_URL) {
            hubCalls += 1;
            return new Response("", { status: 202 });
          }
          rssCalls += 1;
          const channelId = url.searchParams.get("channel_id") ?? "";
          return new Response(
            atomFeed(channelId, entriesByFeed.get(channelId) ?? []),
            { status: 200, headers: { etag: `"${channelId}"` } },
          );
        }),
      );

      const sweep = async (
        firstTick: string,
        label: string,
        channelCount = 113,
      ): Promise<{
        reads: number;
        writes: number;
        maxTickReads: number;
        updated: number;
        eligibilityQueries: number;
        ingestBatches: number;
      }> => {
        const meterDb = meter(scaleDb);
        const at = Date.parse(firstTick);
        let attempted = 0;
        let updatedVideos = 0;
        let maxTickReads = 0;
        for (let i = 0; i < channelCount; i += 1) {
          const before = meterDb.reads;
          const tick = await runChannelSync(
            { ...scaleEnv, DB: meterDb.db } as unknown as Env,
            new Date(at + i * 60_000).toISOString(),
          );
          maxTickReads = Math.max(maxTickReads, meterDb.reads - before);
          expect(tick.hub.attempted).toBe(0);
          attempted += tick.rss.attempted;
          updatedVideos += tick.rss.updated;
        }
        expect(attempted).toBe(channelCount);
        const metrics = {
          label,
          channels: channelCount,
          videos: 300,
          accounts: 2,
          reads: meterDb.reads,
          writes: meterDb.writes,
          maxTickReads,
          eligibilityQueries: meterDb.count("FROM playlist_items pi"),
          ingestBatches: meterDb.count("batch("),
        };
        console.log("WebSub daily sweep", metrics);
        return {
          reads: meterDb.reads,
          writes: meterDb.writes,
          maxTickReads,
          updated: updatedVideos,
          eligibilityQueries: meterDb.count("FROM playlist_items pi"),
          ingestBatches: meterDb.count("batch("),
        };
      };

      const sweepStart = "2026-10-22T12:00:00.000Z";
      await scaleDb
        .prepare("UPDATE websub_channels SET rss_next_at = ?")
        .bind(sweepStart)
        .run();
      const firstSweep = await sweep(sweepStart, "first");
      expect(firstSweep.updated).toBe(300);
      expect(await readGlobalFeedRevision(scaleDb)).toBe(300);
      // Exactly one eligibility query and one ingest batch per channel, never
      // one per entry or per interested account.
      expect(firstSweep.eligibilityQueries).toBe(113);
      expect(firstSweep.ingestBatches).toBe(113);
      // Writes are proportional to the 300 changed videos plus per-channel
      // bookkeeping. Reads stay bounded per tick: with every channel due at
      // the same instant the scheduler scan is the worst case (~226 rows);
      // the ingest itself reads ~33 rows for three changed videos.
      expect(firstSweep.writes).toBeLessThanOrEqual(300 * 8);
      expect(firstSweep.maxTickReads).toBeLessThanOrEqual(64);

      const unchangedAt = await scaleDb
        .prepare(
          "SELECT COUNT(*) AS n FROM videos WHERE id LIKE 'scalev%' AND title='Scale video v2'",
        )
        .first<{ n: number }>();
      expect(unchangedAt?.n).toBe(300);

      // A second sampled sweep with the exact same raw <updated> values must
      // not write a single video row or advance the feed revision.
      await scaleDb
        .prepare(
          `UPDATE websub_channels SET rss_next_at = ?
           WHERE channel_id IN (
             SELECT channel_id FROM websub_channels ORDER BY channel_id LIMIT 12)`,
        )
        .bind(sweepStart)
        .run();
      const secondSweep = await sweep(
        "2026-10-23T12:00:00.000Z",
        "duplicate",
        113,
      );
      expect(secondSweep.updated).toBe(0);
      expect(await readGlobalFeedRevision(scaleDb)).toBe(300);
      // No content change means no eligibility query and no ingest batch.
      expect(secondSweep.eligibilityQueries).toBe(0);
      expect(secondSweep.ingestBatches).toBe(0);
      expect(secondSweep.writes).toBeLessThanOrEqual(113 * 3);
    } finally {
      vi.unstubAllGlobals();
      await scaleMf.dispose();
    }
  }, 120000);
});
