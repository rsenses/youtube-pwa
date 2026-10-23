import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Env } from "../worker/types";
import { runWeeklyVideoRetention } from "../worker/video-retention";
import { externalVideoStatement, purgeExpiredMetadata } from "../worker/db";

const SECRET = "fixture-websub-secret-not-a-real-credential";
const APP_ORIGIN = "https://alveo.test";
const NOW = "2026-10-22T12:00:00.000Z";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const OLD = "2025-10-01T00:00:00.000Z";
const RECENT = "2026-10-01T00:00:00.000Z";
const SENTINEL = "1970-01-01T00:00:00.000Z";
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

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function meter(database: D1Database) {
  let read = 0;
  let written = 0;
  const native = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) => wrap(target.bind(...args));
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
          return (sql: string) => wrap(target.prepare(sql));
        if (key === "batch")
          return async (batch: D1PreparedStatement[]) => {
            const results = await target.batch(
              batch.map((statement) => native.get(statement) ?? statement),
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

async function resetDatabase(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM account_video_metadata"),
    db.prepare("DELETE FROM playlist_items"),
    db.prepare("DELETE FROM playlists"),
    db.prepare("DELETE FROM watch_states"),
    db.prepare("DELETE FROM short_video_tombstones"),
    db.prepare("DELETE FROM videos"),
    db.prepare("DELETE FROM subscriptions"),
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

async function insertAccount(id: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO accounts(id,mode,name,connected,scopes,created_at,updated_at)
       VALUES (?, 'real', ?, 1, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(id, id)
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

async function subscribe(accountId: string, channelId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions(account_id,channel_id,active,created_at,updated_at)
       VALUES (?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(accountId, channelId)
    .run();
}

async function insertVideo(
  id: string,
  channelId: string,
  publishedAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO videos
         (id,channel_id,channel_title,title,description,thumbnail_url,published_at,
          duration_seconds,view_count,source,fetched_at,expires_at,purged_at,
          created_at,updated_at)
       VALUES (?,?,'Channel',?,'','',?,NULL,NULL,'rss','2026-01-01T00:00:00.000Z',
              '2099-01-01T00:00:00.000Z',NULL,'2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z')`,
    )
    .bind(id, channelId, `Video ${id}`, publishedAt)
    .run();
}

async function setWatch(
  accountId: string,
  videoId: string,
  watched: 0 | 1,
  revision: number,
  percent: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watch_states
         (account_id,video_id,watched,watched_at,position_seconds,percent,manual,revision,updated_at)
       VALUES (?,?,?,?,?,?,0,?,'2026-01-01T00:00:00.000Z')`,
    )
    .bind(
      accountId,
      videoId,
      watched,
      watched ? "2026-01-01T00:00:00.000Z" : null,
      percent,
      percent,
      revision,
    )
    .run();
}

async function addPlaylistItem(
  accountId: string,
  playlistId: string,
  videoId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO playlists(id,account_id,source,title,created_at,updated_at)
       VALUES (?,?,'local','Keep','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    )
    .bind(playlistId, accountId)
    .run();
  await db
    .prepare(
      `INSERT INTO playlist_items(id,playlist_id,video_id,position,added_at)
       VALUES (?,?,?,0,'2026-01-01T00:00:00.000Z')`,
    )
    .bind(`${playlistId}-item`, playlistId, videoId)
    .run();
}

async function addPrivateRecentDate(
  accountId: string,
  videoId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO account_video_metadata
         (account_id,video_id,metadata,fetched_at,expires_at,details_fetched_at)
       VALUES (?,?,?,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',NULL)`,
    )
    .bind(
      accountId,
      videoId,
      JSON.stringify({
        title: "Private title",
        description: "",
        publishedAt: RECENT,
      }),
    )
    .run();
}

async function seedFollowers(
  channelId: string,
  accountIds: string[],
): Promise<void> {
  await insertChannel(channelId);
  for (const accountId of accountIds) {
    await insertAccount(accountId);
    await subscribe(accountId, channelId);
  }
}

async function revision(): Promise<number> {
  const row = await db
    .prepare("SELECT revision FROM youtube_feed_state WHERE id=1")
    .first<{ revision: number }>();
  return row?.revision ?? 0;
}

async function retentionState(): Promise<{
  next_run_at: string;
  cursor_date: string | null;
  cursor_id: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
}> {
  return (await db
    .prepare("SELECT * FROM video_retention_state WHERE id=1")
    .first<{
      next_run_at: string;
      cursor_date: string | null;
      cursor_id: string | null;
      claim_token: string | null;
      claim_expires_at: string | null;
    }>())!;
}

async function videoIds(): Promise<string[]> {
  const rows = await db
    .prepare("SELECT id FROM videos ORDER BY id")
    .all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}

async function watchRow(
  accountId: string,
  videoId: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare("SELECT * FROM watch_states WHERE account_id=? AND video_id=?")
    .bind(accountId, videoId)
    .first<Record<string, unknown>>();
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
  await resetDatabase();
});

afterAll(async () => {
  await mf.dispose();
});

describe("weekly global video retention", () => {
  it("discards an untouched short candidate after 30 days without marking it watched", async () => {
    const channelId = "UCshortage";
    await seedFollowers(channelId, ["short-owner"]);
    await insertVideo("shortold0001", channelId, "2026-09-01T00:00:00.000Z");
    await db.prepare(`UPDATE videos SET duration_seconds=90,short_candidate=1,
      created_at='2026-09-01T00:00:00.000Z',details_fetched_at='2026-09-01T00:00:00.000Z',
      details_expires_at='2026-10-01T00:00:00.000Z' WHERE id='shortold0001'`).run();
    await purgeExpiredMetadata(db, NOW);
    expect((await db.prepare("SELECT short_candidate,duration_seconds FROM videos WHERE id='shortold0001'").first<{short_candidate:number;duration_seconds:number|null}>())?.short_candidate).toBe(1);

    expect(await runWeeklyVideoRetention(env, NOW)).toBeGreaterThan(0);
    expect(await videoIds()).toEqual([]);
    expect((await db.prepare("SELECT video_id FROM short_video_tombstones WHERE video_id='shortold0001'").first())?.video_id).toBe("shortold0001");
    expect(await watchRow("short-owner", "shortold0001")).toBeNull();

    await externalVideoStatement(db, {
      id: "shortold0001", channelId, channelTitle: "Channel", title: "Short",
      description: "", thumbnailUrl: "", publishedAt: "2026-09-01T00:00:00.000Z",
      durationSeconds: 90, viewCount: null, source: "rss",
    }, "2099-01-01T00:00:00.000Z", NOW, true).run();
    expect(await videoIds()).toEqual([]);
  });

  it("keeps recent, listed and explicitly chosen brief videos", async () => {
    const channelId = "UCshortprotected";
    await seedFollowers(channelId, ["short-owner"]);
    for (const id of ["shortrecent1", "shortlisted1", "shortchosen1", "shortnormal1"]) {
      await insertVideo(id, channelId, "2026-09-01T00:00:00.000Z");
      await db.prepare("UPDATE videos SET duration_seconds=90,short_candidate=1,created_at=? WHERE id=?")
        .bind(id === "shortrecent1" ? "2026-10-01T00:00:00.000Z" : "2026-09-01T00:00:00.000Z", id).run();
    }
    await addPlaylistItem("short-owner", "short-list", "shortlisted1");
    await setWatch("short-owner", "shortchosen1", 0, 1, 0);
    await db.prepare("UPDATE videos SET duration_seconds=210,short_candidate=0 WHERE id='shortnormal1'").run();

    expect(await runWeeklyVideoRetention(env, NOW)).toBe(0);
    expect(await videoIds()).toEqual(["shortchosen1", "shortlisted1", "shortnormal1", "shortrecent1"]);
  });
  it("does nothing while the WebSub flag is disabled", async () => {
    const channelId = "UCdisabled";
    await seedFollowers(channelId, ["off-a", "off-b"]);
    await insertVideo("disabled0001", channelId, OLD);
    await setWatch("off-a", "disabled0001", 1, 1, 100);
    await setWatch("off-b", "disabled0001", 1, 1, 100);
    const before = await retentionState();

    expect(
      await runWeeklyVideoRetention(
        { ...env, WEBSUB_ENABLED: "false" } as unknown as Env,
        NOW,
      ),
    ).toBe(0);
    expect(await videoIds()).toEqual(["disabled0001"]);
    expect(await revision()).toBe(0);
    expect(await retentionState()).toEqual(before);
  });

  it("keeps an old video watched by only one of two active followers", async () => {
    const channelId = "UCsharedkeep";
    await seedFollowers(channelId, ["keep-a", "keep-b"]);
    await insertVideo("keepone0001", channelId, OLD);
    await setWatch("keep-a", "keepone0001", 1, 1, 100);

    expect(await runWeeklyVideoRetention(env, NOW)).toBe(0);
    expect(await videoIds()).toEqual(["keepone0001"]);
    expect(await revision()).toBe(0);
    // A completed short page schedules the next pass a week later.
    expect(await retentionState()).toMatchObject({
      next_run_at: plus(NOW, WEEK_MS),
      cursor_date: null,
      cursor_id: null,
      claim_token: null,
      claim_expires_at: null,
    });
  });

  it("deletes an old video only while every active follower watched it", async () => {
    const channelId = "UCshareddelete";
    await seedFollowers(channelId, ["delete-a", "delete-b"]);
    await insertVideo("deleteall001", channelId, OLD);
    await setWatch("delete-a", "deleteall001", 1, 1, 100);
    await setWatch("delete-b", "deleteall001", 1, 2, 100);

    // D1 reports cascaded watch-state deletes in the same change count, so the
    // semantic contract is checked against the video table and epoch.
    expect(await runWeeklyVideoRetention(env, NOW)).toBeGreaterThan(0);
    expect(await videoIds()).toEqual([]);
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM watch_states WHERE video_id='deleteall001'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(await revision()).toBe(1);
  });

  it("keeps a video held by a playlist of any account", async () => {
    const channelId = "UCplaylistkeep";
    await seedFollowers(channelId, ["list-a", "list-b"]);
    await insertVideo("playlistkeep", channelId, OLD);
    await setWatch("list-a", "playlistkeep", 1, 1, 100);
    await setWatch("list-b", "playlistkeep", 1, 1, 100);
    await addPlaylistItem("list-b", "keep-list", "playlistkeep");

    expect(await runWeeklyVideoRetention(env, NOW)).toBe(0);
    expect(await videoIds()).toEqual(["playlistkeep"]);
    expect(await revision()).toBe(0);
  });

  it("keeps recent, sentinel-dated and untracked old videos without touching them", async () => {
    const channelId = "UCageMix";
    await seedFollowers(channelId, ["age-a", "age-b"]);
    await insertVideo("recentold001", channelId, RECENT);
    await insertVideo("sentinel0001", channelId, SENTINEL);
    await setWatch("age-a", "recentold001", 1, 7, 100);
    await setWatch("age-b", "recentold001", 1, 4, 100);
    await setWatch("age-a", "sentinel0001", 1, 8, 100);
    await setWatch("age-b", "sentinel0001", 1, 5, 100);
    // No subscription and no watch state: there is no evidence that anyone
    // wants this video deleted.
    await insertChannel("UCuntracked");
    await insertVideo("untracked001", "UCuntracked", OLD);

    const recentBefore = await watchRow("age-a", "recentold001");
    expect(await runWeeklyVideoRetention(env, NOW)).toBe(0);
    expect(await videoIds()).toEqual([
      "recentold001",
      "sentinel0001",
      "untracked001",
    ]);
    expect(await revision()).toBe(0);
    expect(await watchRow("age-a", "recentold001")).toEqual(recentBefore);
  });

  it("keeps an old watched video while a connected non-subscriber has a pending watch state", async () => {
    const channelId = "UCpendingkeep";
    await seedFollowers(channelId, ["pending-a"]);
    await insertAccount("pending-b");
    await insertVideo("pendingkeep1", channelId, OLD);
    await setWatch("pending-a", "pendingkeep1", 1, 2, 100);
    await setWatch("pending-b", "pendingkeep1", 0, 9, 40);
    const ownerBefore = await watchRow("pending-a", "pendingkeep1");
    const pendingBefore = await watchRow("pending-b", "pendingkeep1");

    expect(await runWeeklyVideoRetention(env, NOW)).toBe(0);
    expect(await videoIds()).toEqual(["pendingkeep1"]);
    expect(await watchRow("pending-a", "pendingkeep1")).toEqual(ownerBefore);
    expect(await watchRow("pending-b", "pendingkeep1")).toEqual(pendingBefore);
  });

  it("does not run another pass before seven days and never rewrites retained states", async () => {
    const channelId = "UCweekly";
    await seedFollowers(channelId, ["week-a", "week-b"]);
    await insertVideo("weekfirst001", channelId, OLD);
    await setWatch("week-a", "weekfirst001", 1, 1, 100);
    await setWatch("week-b", "weekfirst001", 1, 1, 100);
    expect(await runWeeklyVideoRetention(env, NOW)).toBeGreaterThan(0);
    expect(await revision()).toBe(1);

    await insertVideo("weeksecond01", channelId, OLD);
    await setWatch("week-a", "weeksecond01", 1, 3, 100);
    await setWatch("week-b", "weeksecond01", 1, 3, 100);
    const retained = await watchRow("week-a", "weeksecond01");

    expect(await runWeeklyVideoRetention(env, NOW)).toBe(0);
    expect(await runWeeklyVideoRetention(env, plus(NOW, WEEK_MS - 1))).toBe(0);
    expect(await videoIds()).toEqual(["weeksecond01"]);
    expect(await watchRow("week-a", "weeksecond01")).toEqual(retained);
    expect(await revision()).toBe(1);

    expect(
      await runWeeklyVideoRetention(env, plus(NOW, WEEK_MS)),
    ).toBeGreaterThan(0);
    expect(await videoIds()).toEqual([]);
    expect(await revision()).toBe(2);
  });

  it("continues a full 50-row page immediately and then waits a week", async () => {
    const channelId = "UCpaged";
    await seedFollowers(channelId, ["page-a", "page-b"]);
    const ids = Array.from(
      { length: 51 },
      (_, index) => `page${String(index).padStart(7, "0")}`,
    );
    for (const id of ids) await insertVideo(id, channelId, OLD);
    for (const id of ids) {
      await setWatch("page-a", id, 1, 1, 100);
      await setWatch("page-b", id, 1, 1, 100);
    }

    const measured = meter(db);
    const first = await runWeeklyVideoRetention(
      { ...env, DB: measured.db } as unknown as Env,
      NOW,
    );
    console.log("Weekly retention page", {
      deleted: first,
      rowsRead: measured.reads,
      rowsWritten: measured.writes,
    });
    expect(first).toBeGreaterThan(0);
    // Measured on this 50-video/2-account fixture: ~13.6k rows read and 153
    // rows written (50 videos + 100 cascaded watch states + bookkeeping).
    expect(measured.reads).toBeGreaterThanOrEqual(50);
    expect(measured.reads).toBeLessThanOrEqual(20_000);
    expect(measured.writes).toBeGreaterThanOrEqual(150);
    expect(measured.writes).toBeLessThanOrEqual(200);
    expect(await videoIds()).toHaveLength(1);
    // One batch = one published global epoch, not one epoch per deleted row.
    expect(await revision()).toBe(1);
    let state = await retentionState();
    expect(Date.parse(state.next_run_at)).toBe(Date.parse(NOW));
    expect(state.cursor_date).not.toBeNull();
    expect(state.cursor_id).not.toBeNull();

    expect(await runWeeklyVideoRetention(env, NOW)).toBeGreaterThan(0);
    expect(await videoIds()).toEqual([]);
    expect(await revision()).toBe(2);
    state = await retentionState();
    expect(state.next_run_at).toBe(plus(NOW, WEEK_MS));
    expect(state.cursor_date).toBeNull();
    expect(state.cursor_id).toBeNull();

    expect(await runWeeklyVideoRetention(env, NOW)).toBe(0);
    expect(await videoIds()).toEqual([]);
    expect(await revision()).toBe(2);
  });

  it("allows only one concurrent deletion and increments the global epoch once", async () => {
    const channelId = "UCconcurrent";
    await seedFollowers(channelId, ["race-a", "race-b"]);
    await insertVideo("racevideo01", channelId, OLD);
    await setWatch("race-a", "racevideo01", 1, 1, 100);
    await setWatch("race-b", "racevideo01", 1, 1, 100);

    const results = await Promise.all([
      runWeeklyVideoRetention(env, NOW),
      runWeeklyVideoRetention(env, NOW),
    ]);
    expect(results.filter((result) => result > 0)).toHaveLength(1);
    expect(results).toContain(0);
    expect(await videoIds()).toEqual([]);
    expect(await revision()).toBe(1);
  });

  it("keeps a sentinel-dated row when private metadata records a recent publication date", async () => {
    const channelId = "UCprivate";
    await seedFollowers(channelId, ["private-a"]);
    await insertVideo("private0001", channelId, OLD);
    await setWatch("private-a", "private0001", 1, 1, 100);
    await addPrivateRecentDate("private-a", "private0001");

    expect(await runWeeklyVideoRetention(env, NOW)).toBe(0);
    expect(await videoIds()).toEqual(["private0001"]);
    expect(await revision()).toBe(0);
  });
});
