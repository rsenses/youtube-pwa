import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Env } from "../worker/types";
import {
  WEBSUB_CALLBACK_PATH,
  handleWebSub,
  isWebSubEnabled,
  websubHubSecret,
  websubRoutingToken,
  websubTopicUrl,
} from "../worker/websub";
import { readGlobalFeedRevision } from "../worker/channel-sync";
import { parseAtomFeed } from "../worker/rss";
import { setChannelExcluded } from "../worker/db";

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

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

async function insertAccount(id: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO accounts(id,mode,name,connected,scopes,created_at,updated_at)
       VALUES (?, 'real', ?, 1, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(id, id)
    .run();
}

async function seedSubscribed(
  channelId: string,
  accountId: string,
): Promise<string> {
  const now = new Date().toISOString();
  await insertAccount(accountId);
  await db
    .prepare(
      `INSERT INTO channels(id,title,source,created_at,updated_at)
       VALUES (?, 'Feed channel', 'youtube', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(channelId)
    .run();
  await db
    .prepare(
      `INSERT INTO subscriptions(account_id,channel_id,active,created_at,updated_at)
       VALUES (?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(accountId, channelId)
    .run();
  await db
    .prepare(
      `UPDATE websub_channels SET hub_state='subscribed',
         hub_lease_expires_at=?, hub_next_attempt_at=?, rss_next_at=?
       WHERE channel_id=?`,
    )
    .bind(
      plus(now, 30 * 86400000),
      plus(now, 30 * 86400000),
      plus(now, 30 * 86400000),
      channelId,
    )
    .run();
  return now;
}

interface EntryInput {
  id: string;
  title: string;
  published: string;
  updated?: string;
  owner?: string;
  description?: string;
  thumbnail?: string;
  duration?: number;
  views?: number;
  extra?: string;
}

function atom(channelId: string, entries: EntryInput[]): string {
  return `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
    <id>yt:channel:${channelId}</id><title>Feed channel</title>
    ${entries
      .map((entry) => {
        const media =
          entry.description !== undefined ||
          entry.thumbnail !== undefined ||
          entry.duration !== undefined ||
          entry.views !== undefined
            ? `<media:group>
                 ${entry.description !== undefined ? `<media:description>${entry.description}</media:description>` : ""}
                 ${entry.thumbnail !== undefined ? `<media:thumbnail url="${entry.thumbnail}"/>` : ""}
                 ${entry.views !== undefined ? `<media:community><media:statistics views="${entry.views}"/></media:community>` : ""}
                 ${entry.duration !== undefined ? `<media:content duration="${entry.duration}"/>` : ""}
               </media:group>`
            : "";
        return `<entry>
          <yt:videoId>${entry.id}</yt:videoId>
          <yt:channelId>${entry.owner ?? channelId}</yt:channelId>
          <title>${entry.title}</title>
          <published>${entry.published}</published>
          ${entry.updated ? `<updated>${entry.updated}</updated>` : ""}
          ${media}${entry.extra ?? ""}
        </entry>`;
      })
      .join("")}
  </feed>`;
}

async function hmacHeader(
  channelId: string,
  body: Uint8Array,
  hash: "SHA-1" | "SHA-256",
): Promise<string> {
  const secret = await websubHubSecret(env, channelId);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new Uint8Array(body).buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function postXml(
  channelId: string,
  xml: string,
  options: {
    sha1?: "valid" | "invalid" | "missing";
    sha256?: "valid" | "invalid";
    token?: string;
    target?: Env;
    mediaType?: string;
  } = {},
): Promise<Response> {
  const body = new TextEncoder().encode(xml);
  const headers = new Headers({
    "content-type": options.mediaType || "application/atom+xml",
  });
  if (options.sha1 !== "missing") {
    headers.set(
      "x-hub-signature",
      `sha1=${
        options.sha1 === "invalid"
          ? "0".repeat(40)
          : await hmacHeader(channelId, body, "SHA-1")
      }`,
    );
  }
  if (options.sha256) {
    headers.set(
      "x-hub-signature-256",
      `sha256=${
        options.sha256 === "invalid"
          ? "0".repeat(64)
          : await hmacHeader(channelId, body, "SHA-256")
      }`,
    );
  }
  const url = new URL(WEBSUB_CALLBACK_PATH, APP_ORIGIN);
  url.searchParams.set("channel", channelId);
  url.searchParams.set(
    "token",
    options.token ?? (await websubRoutingToken(env, channelId)),
  );
  return handleWebSub(
    new Request(url, { method: "POST", headers, body }),
    options.target ?? env,
  );
}

async function verifyGet(
  channelId: string,
  params: {
    mode?: string;
    topic?: string;
    challenge?: string;
    lease?: string;
    token?: string;
    target?: Env;
  },
): Promise<Response> {
  const url = new URL(WEBSUB_CALLBACK_PATH, APP_ORIGIN);
  url.searchParams.set("channel", channelId);
  url.searchParams.set(
    "token",
    params.token ?? (await websubRoutingToken(env, channelId)),
  );
  url.searchParams.set("hub.mode", params.mode ?? "subscribe");
  url.searchParams.set("hub.topic", params.topic ?? websubTopicUrl(channelId));
  if (params.challenge !== undefined)
    url.searchParams.set("hub.challenge", params.challenge);
  if (params.lease !== undefined)
    url.searchParams.set("hub.lease_seconds", params.lease);
  return handleWebSub(
    new Request(url, { method: "GET" }),
    params.target ?? env,
  );
}

function meter(database: D1Database) {
  let read = 0;
  let written = 0;
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
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(
              statements.map((statement) => native.get(statement) ?? statement),
            );
            for (const result of results) {
              read += result.meta.rows_read || 0;
              written += result.meta.rows_written || 0;
            }
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
  };
}

async function videoRow(id: string): Promise<Record<string, unknown> | null> {
  return db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
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

beforeAll(async () => {
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const name of ALL_MIGRATIONS) {
    const sql = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of splitSql(sql)) await db.prepare(statement).run();
  }
  env = {
    DB: db,
    MODE: "real",
    APP_ORIGIN,
    WEBSUB_ENABLED: "true",
    WEBSUB_SECRET: SECRET,
  } as unknown as Env;
}, 30000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

describe("WebSub feature flag", () => {
  it("requires real mode, the explicit flag and a substantial secret", () => {
    expect(
      isWebSubEnabled({
        MODE: "real",
        WEBSUB_ENABLED: "true",
        WEBSUB_SECRET: SECRET,
      } as unknown as Env),
    ).toBe(true);
    expect(
      isWebSubEnabled({
        MODE: "real",
        WEBSUB_ENABLED: "false",
        WEBSUB_SECRET: SECRET,
      } as unknown as Env),
    ).toBe(false);
    expect(
      isWebSubEnabled({
        MODE: "demo",
        WEBSUB_ENABLED: "true",
        WEBSUB_SECRET: SECRET,
      } as unknown as Env),
    ).toBe(false);
    expect(
      isWebSubEnabled({
        MODE: "real",
        WEBSUB_ENABLED: "true",
        WEBSUB_SECRET: "short",
      } as unknown as Env),
    ).toBe(false);
  });
});

describe("public callback routing", () => {
  it("rejects disabled, wrong path, wrong method and invalid tokens without writing", async () => {
    const channelId = "UCroute";
    await seedSubscribed(channelId, "route-owner");
    const xml = atom(channelId, [
      {
        id: "route000001",
        title: "Route",
        published: plus(new Date().toISOString(), -3600_000),
      },
    ]);
    const disabled = { ...env, WEBSUB_ENABLED: "false" } as unknown as Env;
    expect((await postXml(channelId, xml, { target: disabled })).status).toBe(
      404,
    );

    const wrongPath = new URL(WEBSUB_CALLBACK_PATH + "-other", APP_ORIGIN);
    wrongPath.searchParams.set("channel", channelId);
    wrongPath.searchParams.set(
      "token",
      await websubRoutingToken(env, channelId),
    );
    expect(
      (
        await handleWebSub(
          new Request(wrongPath, {
            method: "POST",
            headers: { "x-hub-signature": "sha1=" + "0".repeat(40) },
            body: xml,
          }),
          env,
        )
      ).status,
    ).toBe(404);

    const method = new URL(WEBSUB_CALLBACK_PATH, APP_ORIGIN);
    method.searchParams.set("channel", channelId);
    method.searchParams.set("token", "invalid");
    const methodResponse = await handleWebSub(
      new Request(method, { method: "PUT" }),
      env,
    );
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, POST");

    const invalidToken = await postXml(channelId, xml, { token: "invalid" });
    expect(invalidToken.status).toBe(404);
    expect(await videoRow("route000001")).toBeNull();

    const invalidGet = await verifyGet(channelId, {
      challenge: "x",
      token: "invalid",
    });
    expect(invalidGet.status).toBe(404);
  });
});

describe("hub verification GET", () => {
  it("requires pending state, exact topic/mode, a bounded lease and cannot be replayed", async () => {
    const channelId = "UCverify";
    const now = new Date().toISOString();
    await seedSubscribed(channelId, "verify-owner");
    await db
      .prepare(
        `UPDATE websub_channels SET hub_state='pending_subscribe',
           hub_pending_mode='subscribe', hub_pending_token='server-token',
           hub_pending_deadline=?, hub_lease_expires_at=NULL, hub_verified_at=NULL
         WHERE channel_id=?`,
      )
      .bind(plus(now, 600_000), channelId)
      .run();

    expect(
      (
        await verifyGet(channelId, {
          challenge: "x",
          topic: websubTopicUrl("UCother"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await verifyGet(channelId, {
          mode: "unsubscribe",
          challenge: "x",
        })
      ).status,
    ).toBe(404);
    expect((await verifyGet(channelId, {})).status).toBe(400);
    expect(
      (await verifyGet(channelId, { challenge: "x", lease: "not-a-number" }))
        .status,
    ).toBe(400);

    const good = await verifyGet(channelId, {
      challenge: "challenge-ok",
      lease: "3600",
    });
    expect(good.status).toBe(200);
    expect(await good.text()).toBe("challenge-ok");
    expect(good.headers.get("content-type")).toContain("text/plain");
    expect(good.headers.get("cache-control")).toBe("no-store");
    let row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id=?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.hub_state).toBe("subscribed");
    expect(row?.hub_pending_token).toBeNull();
    expect(row?.hub_lease_expires_at).toBeTruthy();

    expect(
      (
        await verifyGet(channelId, {
          challenge: "replay",
          // A subscribe verification without a positive lease is rejected
          // before pending-state lookup; include one to reach the replay guard.
          lease: "3600",
        })
      ).status,
    ).toBe(404);

    await db
      .prepare(
        `UPDATE websub_channels SET desired=0, hub_state='pending_unsubscribe',
           hub_pending_mode='unsubscribe', hub_pending_token='cancel-token',
           hub_pending_deadline=?, hub_verified_at=NULL WHERE channel_id=?`,
      )
      .bind(plus(now, 600_000), channelId)
      .run();
    const cancel = await verifyGet(channelId, {
      mode: "unsubscribe",
      challenge: "challenge-cancel",
    });
    expect(cancel.status).toBe(200);
    expect(await cancel.text()).toBe("challenge-cancel");
    row = await db
      .prepare("SELECT * FROM websub_channels WHERE channel_id=?")
      .bind(channelId)
      .first<Record<string, unknown>>();
    expect(row?.hub_state).toBe("unsubscribed");
    expect(row?.hub_lease_expires_at).toBeNull();
  });
});

describe("notification signatures and bounds", () => {
  it("fails closed on missing/invalid HMAC, owner mismatch, oversize bodies and too many entries", async () => {
    const channelId = "UCsignature";
    const now = await seedSubscribed(channelId, "signature-owner");
    const entry = (id: string, owner = channelId): EntryInput => ({
      id,
      title: "Signed " + id,
      published: plus(now, -3600_000),
      updated: plus(now, -1800_000),
      owner,
    });

    expect(
      (
        await postXml(channelId, atom(channelId, [entry("sigmissing1")]), {
          sha1: "missing",
        })
      ).status,
    ).toBe(401);
    expect(await videoRow("sigmissing1")).toBeNull();

    expect(
      (
        await postXml(channelId, atom(channelId, [entry("sigbad00001")]), {
          sha1: "invalid",
        })
      ).status,
    ).toBe(401);
    expect(await videoRow("sigbad00001")).toBeNull();

    expect(
      (
        await postXml(channelId, atom(channelId, [entry("badmedia001")]), {
          mediaType: "text/html",
        })
      ).status,
    ).toBe(415);
    expect(await videoRow("badmedia001")).toBeNull();
    const incomplete = atom(channelId, [entry("incomplete1")]).replace(
      "<title>Signed incomplete1</title>",
      "<title></title>",
    );
    expect((await postXml(channelId, incomplete)).status).toBe(422);
    expect(await videoRow("incomplete1")).toBeNull();

    const sha1Only = await postXml(
      channelId,
      atom(channelId, [entry("sigsha10001")]),
      { sha1: "valid" },
    );
    expect(sha1Only.status).toBe(204);
    expect((await videoRow("sigsha10001"))?.title).toBe("Signed sigsha10001");

    const mixed = await postXml(
      channelId,
      atom(channelId, [entry("sigmixed001")]),
      { sha1: "valid", sha256: "invalid" },
    );
    expect(mixed.status).toBe(401);
    expect(await videoRow("sigmixed001")).toBeNull();

    const both = await postXml(
      channelId,
      atom(channelId, [entry("sigboth0001")]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(both.status).toBe(204);
    expect(await videoRow("sigboth0001")).toBeTruthy();

    const owner = await postXml(
      channelId,
      atom(channelId, [entry("sigowner001", "UCotherchannel")]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(owner.status).toBe(422);
    expect(await videoRow("sigowner001")).toBeNull();

    const oversized = "x".repeat(64 * 1024 + 1);
    expect(
      (
        await postXml(channelId, oversized, {
          sha1: "valid",
          sha256: "valid",
        })
      ).status,
    ).toBe(413);

    const many = Array.from({ length: 16 }, (_, index) =>
      entry(`many${String(index).padStart(7, "0")}`),
    );
    expect(
      (
        await postXml(channelId, atom(channelId, many), {
          sha1: "valid",
          sha256: "valid",
        })
      ).status,
    ).toBe(413);
    expect(await videoRow(`many${String(0).padStart(7, "0")}`)).toBeNull();

    const invalidXml = await postXml(channelId, "<rss><channel/></rss>", {
      sha1: "valid",
      sha256: "valid",
    });
    expect(invalidXml.status).toBe(422);
  });
});

describe("durable notification application", () => {
  it("deduplicates exact/reordered events, preserves sparse rich fields and writes only an ordering stamp", async () => {
    const channelId = "UCnotify";
    const now = await seedSubscribed(channelId, "notify-viewer");
    const baseline = await readGlobalFeedRevision(db);
    const event: EntryInput = {
      id: "notify00001",
      title: "Original",
      published: plus(now, -3600_000),
      updated: plus(now, -1800_000),
      description: "Rich description",
      thumbnail: "https://i.ytimg.com/vi/notify00001/hq.jpg",
      duration: 240,
      views: 77,
    };
    const first = await postXml(channelId, atom(channelId, [event]), {
      sha1: "valid",
      sha256: "valid",
    });
    expect(first.status).toBe(204);
    let row = await videoRow("notify00001");
    expect(row).toMatchObject({
      channel_id: channelId,
      title: "Original",
      description: "Rich description",
      thumbnail_url: "https://i.ytimg.com/vi/notify00001/mqdefault.jpg",
      duration_seconds: 240,
      view_count: 77,
    });
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);

    await db
      .prepare(
        `INSERT INTO watch_states(account_id,video_id,watched,position_seconds,percent,manual,revision,updated_at)
         VALUES ('notify-viewer','notify00001',0,30,10,0,2,'2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const watchBefore = await db
      .prepare(
        "SELECT * FROM watch_states WHERE account_id='notify-viewer' AND video_id='notify00001'",
      )
      .first<Record<string, unknown>>();

    const duplicateMeter = meter(db);
    const duplicate = await postXml(channelId, atom(channelId, [event]), {
      sha1: "valid",
      sha256: "valid",
      target: { ...env, DB: duplicateMeter.db } as unknown as Env,
    });
    expect(duplicate.status).toBe(204);
    expect(duplicateMeter.writes).toBe(0);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
    console.log("WebSub duplicate notification", {
      rowsRead: duplicateMeter.reads,
      rowsWritten: duplicateMeter.writes,
    });

    const reordered = await postXml(
      channelId,
      atom(channelId, [
        {
          ...event,
          title: "Reordered older",
          updated: plus(now, -7200_000),
        },
      ]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(reordered.status).toBe(204);
    expect((await videoRow("notify00001"))?.title).toBe("Original");
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);

    const sparse = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "notify00001",
          title: "Sparse title",
          published: event.published,
          updated: plus(now, -300_000),
        },
      ]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(sparse.status).toBe(204);
    row = await videoRow("notify00001");
    expect(row).toMatchObject({
      title: "Sparse title",
      description: "Rich description",
      thumbnail_url: "https://i.ytimg.com/vi/notify00001/mqdefault.jpg",
      duration_seconds: 240,
      view_count: 77,
    });
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 2);
    const watchAfter = await db
      .prepare(
        "SELECT * FROM watch_states WHERE account_id='notify-viewer' AND video_id='notify00001'",
      )
      .first<Record<string, unknown>>();
    expect(watchAfter).toEqual(watchBefore);
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM watch_states WHERE video_id='notify00001'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);

    const watermarkBefore = String(row?.websub_updated_at);
    const updatedAtBefore = String(row?.updated_at);
    const hashBefore = String(row?.websub_hash);
    const newerUpdated = plus(now, -60_000);
    const watermarkMeter = meter(db);
    const identicalNewer = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "notify00001",
          title: "Sparse title",
          published: event.published,
          updated: newerUpdated,
        },
      ]),
      {
        sha1: "valid",
        sha256: "valid",
        target: { ...env, DB: watermarkMeter.db } as unknown as Env,
      },
    );
    expect(identicalNewer.status).toBe(204);
    // Identical content, newer timestamp: exactly one ordering stamp write,
    // no visible metadata rewrite and no feed epoch change.
    expect(watermarkMeter.writes).toBe(1);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 2);
    row = await videoRow("notify00001");
    expect(String(row?.websub_updated_at)).toBe(newerUpdated);
    expect(String(row?.updated_at)).toBe(updatedAtBefore);
    expect(String(row?.websub_hash)).toBe(hashBefore);
    expect(row).toMatchObject({
      title: "Sparse title",
      description: "Rich description",
      thumbnail_url: "https://i.ytimg.com/vi/notify00001/mqdefault.jpg",
      duration_seconds: 240,
      view_count: 77,
    });
    expect(String(row?.websub_updated_at)).not.toBe(watermarkBefore);

    // A later-delivered older event must not move the watermark or content
    // backwards after the identical newer event advanced source ordering.
    const reorderedMeter = meter(db);
    const olderAfterNewer = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "notify00001",
          title: "Older after newer",
          published: event.published,
          updated: plus(now, -120_000),
        },
      ]),
      {
        sha1: "valid",
        sha256: "valid",
        target: { ...env, DB: reorderedMeter.db } as unknown as Env,
      },
    );
    expect(olderAfterNewer.status).toBe(204);
    expect(reorderedMeter.writes).toBe(0);
    row = await videoRow("notify00001");
    expect(row?.title).toBe("Sparse title");
    expect(String(row?.websub_updated_at)).toBe(newerUpdated);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 2);
  });

  it("applies concurrent duplicate notifications exactly once", async () => {
    const channelId = "UCconcurrent";
    const now = await seedSubscribed(channelId, "concurrent-viewer");
    const baseline = await readGlobalFeedRevision(db);
    const entry: EntryInput = {
      id: "concurrent1",
      title: "Concurrent",
      published: plus(now, -3600_000),
      updated: plus(now, -1800_000),
    };
    const xml = atom(channelId, [entry]);
    const responses = await Promise.all([
      postXml(channelId, xml, { sha1: "valid", sha256: "valid" }),
      postXml(channelId, xml, { sha1: "valid", sha256: "valid" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM videos WHERE id='concurrent1'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("rejects a stale ordering stamp with a retryable conflict and reapplies on retry", async () => {
    const channelId = "UCstamprace";
    const now = await seedSubscribed(channelId, "stamp-race-viewer");
    const published = plus(now, -7200_000);
    const storedAt = plus(now, -5400_000);
    await seedVideo(
      "stamprace01",
      channelId,
      published,
      storedAt,
      "Same title",
    );
    const baseline = await readGlobalFeedRevision(db);
    const newer = plus(now, -1800_000);
    const concurrentAt = plus(now, -3600_000);
    const xml = atom(channelId, [
      {
        id: "stamprace01",
        title: "Same title",
        published,
        updated: newer,
      },
    ]);

    const racy = await postXml(channelId, xml, {
      sha1: "valid",
      sha256: "valid",
      target: {
        ...env,
        DB: withBatchSideEffect(db, async () => {
          await db
            .prepare(
              `UPDATE videos SET title='Concurrent', websub_updated_at=?,
                 websub_hash='concurrent' WHERE id='stamprace01'`,
            )
            .bind(concurrentAt)
            .run();
        }),
      } as unknown as Env,
    });
    // The stamp CAS expected the old watermark, so it must not mark the newer
    // timestamp over the concurrent B@2 row.
    expect(racy.status).toBe(409);
    let row = await videoRow("stamprace01");
    expect(row?.title).toBe("Concurrent");
    expect(String(row?.websub_updated_at)).toBe(concurrentAt);
    expect(await readGlobalFeedRevision(db)).toBe(baseline);

    // A retry re-reads the concurrent row and re-applies the newer event.
    const retry = await postXml(channelId, xml, {
      sha1: "valid",
      sha256: "valid",
    });
    expect(retry.status).toBe(204);
    row = await videoRow("stamprace01");
    expect(row?.title).toBe("Same title");
    expect(String(row?.websub_updated_at)).toBe(newer);
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
  });

  it("does not blank richer fields from a concurrent merge based on a stale row", async () => {
    const channelId = "UCmergerace";
    const now = await seedSubscribed(channelId, "merge-race-viewer");
    const published = plus(now, -7200_000);
    const storedAt = plus(now, -5400_000);
    await seedVideo(
      "mergerace01",
      channelId,
      published,
      storedAt,
      "Stored title",
    );
    await db
      .prepare(
        `UPDATE videos SET description='Stored rich', websub_hash='stored-hash'
         WHERE id='mergerace01'`,
      )
      .run();
    const baseline = await readGlobalFeedRevision(db);
    const newer = plus(now, -1800_000);
    const concurrentAt = plus(now, -3600_000);
    const xml = atom(channelId, [
      {
        id: "mergerace01",
        title: "Newer sparse",
        published,
        updated: newer,
      },
    ]);

    const racy = await postXml(channelId, xml, {
      sha1: "valid",
      sha256: "valid",
      target: {
        ...env,
        DB: withBatchSideEffect(db, async () => {
          await db
            .prepare(
              `UPDATE videos SET title='Concurrent', description='Concurrent rich',
                 websub_updated_at=?, websub_hash='concurrent-hash'
               WHERE id='mergerace01'`,
            )
            .bind(concurrentAt)
            .run();
        }),
      } as unknown as Env,
    });
    expect(racy.status).toBe(409);
    let row = await videoRow("mergerace01");
    expect(row).toMatchObject({
      title: "Concurrent",
      description: "Concurrent rich",
      websub_updated_at: concurrentAt,
    });
    expect(await readGlobalFeedRevision(db)).toBe(baseline);

    // Retrying the sparse newer event preserves the concurrent rich field.
    const retry = await postXml(channelId, xml, {
      sha1: "valid",
      sha256: "valid",
    });
    expect(retry.status).toBe(204);
    row = await videoRow("mergerace01");
    expect(row).toMatchObject({
      title: "Newer sparse",
      description: "Concurrent rich",
      websub_updated_at: newer,
    });
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
  });

  it("atomically gates in-flight inserts and updates on desired=1", async () => {
    const channelId = "UClastunsub";
    const now = await seedSubscribed(channelId, "last-unsub-viewer");
    const baseline = await readGlobalFeedRevision(db);

    const insertMeter = meter(db);
    const insertGate = withBatchSideEffect(insertMeter.db, async () => {
      await db
        .prepare("UPDATE websub_channels SET desired=0 WHERE channel_id=?")
        .bind(channelId)
        .run();
    });
    const inserted = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "gateinsert1",
          title: "Must not insert",
          published: plus(now, -3600_000),
          updated: plus(now, -1800_000),
        },
      ]),
      {
        sha1: "valid",
        sha256: "valid",
        target: { ...env, DB: insertGate } as unknown as Env,
      },
    );
    expect(inserted.status).toBe(204);
    expect(await videoRow("gateinsert1")).toBeNull();
    expect(insertMeter.writes).toBe(0);
    expect(await readGlobalFeedRevision(db)).toBe(baseline);

    await db
      .prepare("UPDATE websub_channels SET desired=1 WHERE channel_id=?")
      .bind(channelId)
      .run();
    const published = plus(now, -7200_000);
    await seedVideo(
      "gateupdate1",
      channelId,
      published,
      plus(now, -5400_000),
      "Before",
    );
    const updateMeter = meter(db);
    const updateGate = withBatchSideEffect(updateMeter.db, async () => {
      await db
        .prepare("UPDATE websub_channels SET desired=0 WHERE channel_id=?")
        .bind(channelId)
        .run();
    });
    const updated = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "gateupdate1",
          title: "After",
          published,
          updated: plus(now, -1800_000),
        },
      ]),
      {
        sha1: "valid",
        sha256: "valid",
        target: { ...env, DB: updateGate } as unknown as Env,
      },
    );
    expect(updated.status).toBe(204);
    expect((await videoRow("gateupdate1"))?.title).toBe("Before");
    expect(updateMeter.writes).toBe(0);
    expect(await readGlobalFeedRevision(db)).toBe(baseline);
  });

  it("skips unknown/old videos and promotes only a verified public placeholder", async () => {
    const channelId = "UCage";
    const now = await seedSubscribed(channelId, "age-viewer");
    const baseline = await readGlobalFeedRevision(db);

    // The one-year window replaced the old 24h bootstrap ceiling on both
    // discovery paths, so a two-day-old unknown video is imported.
    const unknownRecent = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "unknownold1",
          title: "Unknown two days",
          published: plus(now, -2 * 86400_000),
        },
      ]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(unknownRecent.status).toBe(204);
    expect((await videoRow("unknownold1"))?.title).toBe("Unknown two days");
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);

    await postXml(
      channelId,
      atom(channelId, [
        {
          id: "unknownyear",
          title: "Unknown year",
          published: plus(now, -400 * 86400000),
        },
      ]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(await videoRow("unknownyear")).toBeNull();
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);

    await db
      .prepare(
        `INSERT INTO videos
           (id,channel_id,channel_title,title,description,thumbnail_url,published_at,
            duration_seconds,view_count,source,fetched_at,expires_at,purged_at,
            created_at,updated_at)
         VALUES ('oldexist001',?,'Age','Old title','Old description','',?,
                 100,1,'rss','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',NULL,
                 '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .bind(channelId, plus(now, -400 * 86400000))
      .run();
    const oldUpdate = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "oldexist001",
          title: "Must not update",
          published: plus(now, -400 * 86400000),
          updated: plus(now, -60_000),
        },
      ]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(oldUpdate.status).toBe(204);
    expect((await videoRow("oldexist001"))?.title).toBe("Old title");
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);

    await db
      .prepare(
        `INSERT INTO videos
           (id,channel_id,channel_title,title,description,thumbnail_url,published_at,
            duration_seconds,view_count,source,fetched_at,expires_at,purged_at,
            created_at,updated_at)
         VALUES ('private0001','','YouTube','Vídeo de YouTube','','',?,
                 NULL,NULL,'youtube','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',?,
                 '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .bind(plus(now, -7200_000), now)
      .run();
    await db
      .prepare(
        `INSERT INTO account_video_metadata
           (account_id,video_id,metadata,fetched_at,expires_at,details_fetched_at)
         VALUES ('age-viewer','private0001',?,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .bind(
        JSON.stringify({
          title: "Private secret",
          description: "Private description",
          channelId: "UCprivate",
        }),
      )
      .run();
    expect((await videoRow("private0001"))?.channel_id).toBe("");

    const promoted = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "private0001",
          title: "Public title",
          published: plus(now, -7200_000),
          updated: plus(now, -120_000),
          description: "Public description",
        },
      ]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(promoted.status).toBe(204);
    const promotedRow = await videoRow("private0001");
    expect(promotedRow).toMatchObject({
      channel_id: channelId,
      source: "rss",
      title: "Public title",
      description: "Public description",
      purged_at: null,
    });
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 2);
    const privateCopy = await db
      .prepare(
        "SELECT metadata FROM account_video_metadata WHERE account_id='age-viewer' AND video_id='private0001'",
      )
      .first<{ metadata: string }>();
    expect(JSON.parse(privateCopy?.metadata ?? "{}").title).toBe(
      "Private secret",
    );
    expect(promotedRow?.description).not.toContain("Private description");
  });
});

async function subscribeAccount(
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

async function seedVideo(
  id: string,
  channelId: string,
  published: string,
  eventAt: string,
  title: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO videos
         (id,channel_id,channel_title,title,description,thumbnail_url,published_at,
          duration_seconds,view_count,source,fetched_at,expires_at,purged_at,
          created_at,updated_at,websub_updated_at)
       VALUES (?,?,'Feed channel',?,'','',?,NULL,NULL,'rss',
               '2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',NULL,
               '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',?)`,
    )
    .bind(id, channelId, title, published, eventAt)
    .run();
}

async function setWatched(
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

describe("watched/playlist update eligibility", () => {
  it("does not refresh an untouched short candidate or reimport a discarded one", async () => {
    const channelId = "UCshortignored";
    const now = await seedSubscribed(channelId, "short-ignored-owner");
    const published = plus(now, -3600_000);
    await seedVideo("shortign001", channelId, published, plus(now, -3000_000), "Before");
    await db.prepare("UPDATE videos SET duration_seconds=90,short_candidate=1 WHERE id='shortign001'").run();
    const changed = await postXml(channelId, atom(channelId, [{
      id: "shortign001", title: "After", published, updated: plus(now, -1800_000),
    }]), { sha1: "valid", sha256: "valid" });
    expect(changed.status).toBe(204);
    expect((await videoRow("shortign001"))?.title).toBe("Before");

    await db.prepare("INSERT INTO short_video_tombstones(video_id,published_at) VALUES (?,?)")
      .bind("shortgone01", published).run();
    const repeated = await postXml(channelId, atom(channelId, [{
      id: "shortgone01", title: "Discarded", published,
    }]), { sha1: "valid", sha256: "valid" });
    expect(repeated.status).toBe(204);
    expect(await videoRow("shortgone01")).toBeNull();
  });
  it("skips metadata watched by every interested subscriber and absent from playlists", async () => {
    const channelId = "UCallwatched";
    const now = await seedSubscribed(channelId, "allwatched-a");
    await insertAccount("allwatched-b");
    await subscribeAccount("allwatched-b", channelId);
    const published = plus(now, -7200_000);
    await seedVideo(
      "allwatched1",
      channelId,
      published,
      plus(now, -5400_000),
      "Before",
    );
    // One explicit watched flag and one full progress row both mean watched;
    // stored watch rows with watched=1 are the only watched signal.
    await setWatched("allwatched-a", "allwatched1", 1, 100);
    await setWatched("allwatched-b", "allwatched1", 1, 100);
    const baseline = await readGlobalFeedRevision(db);

    const watchedMeter = meter(db);
    const response = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "allwatched1",
          title: "After",
          published,
          updated: plus(now, -1800_000),
        },
      ]),
      {
        sha1: "valid",
        sha256: "valid",
        target: { ...env, DB: watchedMeter.db } as unknown as Env,
      },
    );
    expect(response.status).toBe(204);
    expect(watchedMeter.writes).toBe(0);
    console.log("WebSub watched-skip notification", {
      rowsRead: watchedMeter.reads,
      rowsWritten: watchedMeter.writes,
    });
    expect((await videoRow("allwatched1"))?.title).toBe("Before");
    expect((await videoRow("allwatched1"))?.websub_updated_at).toBe(
      plus(now, -5400_000),
    );
    expect(await readGlobalFeedRevision(db)).toBe(baseline);

    // A newer identical event would normally write one ordering stamp, but the
    // watched/playlist user rule skips the video entirely, watermark included.
    const orderingMeter = meter(db);
    const ordering = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "allwatched1",
          title: "Before",
          published,
          updated: plus(now, -1800_000),
        },
      ]),
      {
        sha1: "valid",
        sha256: "valid",
        target: { ...env, DB: orderingMeter.db } as unknown as Env,
      },
    );
    expect(ordering.status).toBe(204);
    expect(orderingMeter.writes).toBe(0);
    expect((await videoRow("allwatched1"))?.websub_updated_at).toBe(
      plus(now, -5400_000),
    );
    expect(await readGlobalFeedRevision(db)).toBe(baseline);
  });

  it("refreshes metadata when a second interested account still has it pending", async () => {
    const channelId = "UCsecondpending";
    const now = await seedSubscribed(channelId, "pending-a");
    await insertAccount("pending-b");
    await subscribeAccount("pending-b", channelId);
    const published = plus(now, -7200_000);
    await seedVideo(
      "pending0001",
      channelId,
      published,
      plus(now, -5400_000),
      "Before",
    );
    await setWatched("pending-a", "pending0001", 1, 100);
    // Progress without an explicit watched flag stays pending, not watched.
    await setWatched("pending-b", "pending0001", 0, 50);
    // API detail timestamps belong to the detail cache, not to the RSS sweep.
    await db
      .prepare(
        `UPDATE videos SET fetched_at='2026-01-02T00:00:00.000Z',
           details_fetched_at='2026-01-02T00:00:00.000Z',
           details_expires_at='2026-02-01T00:00:00.000Z'
         WHERE id='pending0001'`,
      )
      .run();
    const baseline = await readGlobalFeedRevision(db);

    const response = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "pending0001",
          title: "After",
          published,
          updated: plus(now, -1800_000),
        },
      ]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(response.status).toBe(204);
    expect((await videoRow("pending0001"))?.title).toBe("After");
    expect(await videoRow("pending0001")).toMatchObject({
      fetched_at: "2026-01-02T00:00:00.000Z",
      details_fetched_at: "2026-01-02T00:00:00.000Z",
      details_expires_at: "2026-02-01T00:00:00.000Z",
    });
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
    expect(
      (
        await db
          .prepare(
            "SELECT watched, percent FROM watch_states WHERE video_id='pending0001' ORDER BY account_id",
          )
          .all<{ watched: number; percent: number }>()
      ).results,
    ).toEqual([
      { watched: 1, percent: 100 },
      { watched: 0, percent: 50 },
    ]);
  });

  it("lets any account playlist override the watched state but never the one-year floor", async () => {
    const channelId = "UClistpriority";
    const now = await seedSubscribed(channelId, "list-a");
    const published = plus(now, -7200_000);
    await seedVideo(
      "listvideo01",
      channelId,
      published,
      plus(now, -5400_000),
      "Before",
    );
    await setWatched("list-a", "listvideo01", 1, 100);
    // The playlist belongs to another account: any account's list counts.
    await insertAccount("list-b");
    await db
      .prepare(
        `INSERT INTO playlists(id,account_id,source,title,created_at,updated_at)
         VALUES ('listkeep01','list-b','local','Keep','2026','2026')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO playlist_items(id,playlist_id,video_id,position,added_at)
         VALUES ('listitem01','listkeep01','listvideo01',0,'2026')`,
      )
      .run();
    const baseline = await readGlobalFeedRevision(db);

    const listed = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "listvideo01",
          title: "After",
          published,
          updated: plus(now, -1800_000),
        },
      ]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(listed.status).toBe(204);
    expect((await videoRow("listvideo01"))?.title).toBe("After");
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);

    // The absolute one-calendar-year retention floor wins over any playlist.
    const oldPublished = plus(now, -400 * 86400000);
    await seedVideo(
      "listold0001",
      channelId,
      oldPublished,
      plus(now, -400 * 86400000),
      "Ancient",
    );
    await db
      .prepare(
        `INSERT INTO playlist_items(id,playlist_id,video_id,position,added_at)
         VALUES ('listitem02','listkeep01','listold0001',1,'2026')`,
      )
      .run();
    const oldListed = await postXml(
      channelId,
      atom(channelId, [
        {
          id: "listold0001",
          title: "Changed",
          published: oldPublished,
          updated: plus(now, -60_000),
        },
      ]),
      { sha1: "valid", sha256: "valid" },
    );
    expect(oldListed.status).toBe(204);
    expect((await videoRow("listold0001"))?.title).toBe("Ancient");
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
  });

  it("only counts real connected active accounts as interested followers", async () => {
    const channelId = "UCinterestscope";
    const now = await seedSubscribed(channelId, "scope-owner");
    await db
      .prepare(
        `INSERT INTO accounts(id,mode,name,connected,scopes,created_at,updated_at)
         VALUES ('scope-demo','demo','Demo',1,'','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
                ('scope-off','real','Off',0,'','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    await subscribeAccount("scope-demo", channelId);
    await subscribeAccount("scope-off", channelId);
    const published = plus(now, -7200_000);
    await seedVideo(
      "scoped00001",
      channelId,
      published,
      plus(now, -5400_000),
      "Before",
    );
    await setWatched("scope-owner", "scoped00001", 1, 100);
    const baseline = await readGlobalFeedRevision(db);

    const notification = () =>
      postXml(
        channelId,
        atom(channelId, [
          {
            id: "scoped00001",
            title: "After",
            published,
            updated: plus(now, -1800_000),
          },
        ]),
        { sha1: "valid", sha256: "valid" },
      );

    // Demo and disconnected accounts never make a video "unwatched".
    expect((await notification()).status).toBe(204);
    expect((await videoRow("scoped00001"))?.title).toBe("Before");
    expect(await readGlobalFeedRevision(db)).toBe(baseline);

    // The same notification applies once the real owner is pending again.
    await setWatched("scope-owner", "scoped00001", 0, 10);
    expect((await notification()).status).toBe(204);
    expect((await videoRow("scoped00001"))?.title).toBe("After");
    expect(await readGlobalFeedRevision(db)).toBe(baseline + 1);
  });
});

describe("sparse Atom parsing", () => {
  it("exposes updatedAt and field presence without requiring media", () => {
    const channelId = "UCparse";
    const feed =
      parseAtomFeed(`<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
      <id>yt:channel:${channelId}</id><title>Parse</title>
      <entry>
        <yt:videoId>parse000001</yt:videoId>
        <yt:channelId>${channelId}</yt:channelId>
        <title>Sparse</title>
        <published>2026-10-22T10:00:00Z</published>
        <updated>2026-10-22T11:00:00Z</updated>
      </entry>
    </feed>`);
    expect(feed.entries[0]).toMatchObject({
      videoId: "parse000001",
      publishedAt: "2026-10-22T10:00:00.000Z",
      updatedAt: "2026-10-22T11:00:00.000Z",
      hasDescription: false,
      hasThumbnail: true,
      hasDuration: false,
      hasViewCount: false,
    });
  });
});

it("keeps shared WebSub interest until every follower excludes the channel, then restores it", async () => {
  const channelId = "UCexcluded-shared";
  await seedSubscribed(channelId, "excluded-owner-a");
  await insertAccount("excluded-owner-b");
  await db.prepare(
    "INSERT INTO subscriptions(account_id,channel_id,active,created_at,updated_at) VALUES (?,?,1,?,?)",
  ).bind("excluded-owner-b", channelId, new Date().toISOString(), new Date().toISOString()).run();
  const desired = async () => (await db.prepare(
    "SELECT desired FROM websub_channels WHERE channel_id=?",
  ).bind(channelId).first<{ desired: number }>())?.desired;
  expect(await desired()).toBe(1);
  await setChannelExcluded(db, "excluded-owner-a", channelId, true);
  expect(await desired()).toBe(1);
  await setChannelExcluded(db, "excluded-owner-b", channelId, true);
  expect(await desired()).toBe(0);
  await setChannelExcluded(db, "excluded-owner-a", channelId, false);
  expect(await desired()).toBe(1);
});
