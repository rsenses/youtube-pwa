import { beforeAll, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  listFeed,
  listPlaylists,
  getSuggestions,
  getPlaylistDetail,
  getPlaylistRow,
} from "../worker/db";
import { cachedFeed } from "../worker/read-cache";
import type { Env } from "../worker/types";
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("cost fixture")}}',
    compatibilityDate: "2026-10-20",
    d1Databases: ["DB"],
  }),
);
let db: D1Database;
beforeAll(async () => {
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const name of [
    "0001_init",
    "0002_video_details",
    "0003_public_read_cache",
    "0004_video_discoveries",
    "0005_queued_sync",
    "0006_retention_indexes",
    "0007_video_broadcast_status",
    "0008_incremental_sync",
    "0012_playlist_unimported",
    "0013_exclusions",
  ]) {
    const sql = (
      await readFile(
        new URL("../migrations/" + name + ".sql", import.meta.url),
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
  for (const sql of [
    "INSERT INTO accounts(id,mode,connected,created_at,updated_at) VALUES ('cost-owner','real',1,'2026','2026')",
    "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<112) INSERT INTO channels(id,title,source,created_at,updated_at) SELECT printf('UC%022d',x),'Channel','youtube','2026','2026' FROM n",
    "INSERT INTO subscriptions(account_id,channel_id,active,created_at,updated_at) SELECT 'cost-owner',id,1,'2026','2026' FROM channels",
    "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<4495) INSERT INTO videos(id,channel_id,title,published_at,duration_seconds,is_live,live_broadcast_content,source,fetched_at,expires_at,purged_at,created_at,updated_at) SELECT printf('v%010d',x),CASE WHEN x<1695 THEN printf('UC%022d',x%113) ELSE '' END,'Fixture',CASE WHEN x<1695 THEN '2025-01-01T00:00:00.000Z' ELSE '2026-01-01T00:00:00.000Z' END,300,0,'none',CASE WHEN x<1695 THEN 'rss' ELSE 'youtube' END,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',CASE WHEN x>=1695 THEN '2026' ELSE NULL END,'2026','2026' FROM n",
    "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1773) INSERT INTO watch_states(account_id,video_id,watched,manual,updated_at) SELECT 'cost-owner',printf('v%010d',x),0,0,'2026' FROM n",
    "INSERT INTO video_discoveries(video_id,channel_id,last_seen_at) SELECT id,channel_id,'2026-10-21' FROM videos WHERE source='rss'",
    "INSERT INTO videos(id,channel_id,title,published_at,duration_seconds,is_live,live_broadcast_content,source,fetched_at,expires_at,purged_at,created_at,updated_at) VALUES ('unowned0001','UCunsubscribed','Unowned','2099-02-01T00:00:00.000Z',300,0,'none','rss','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',NULL,'2026','2026')",
    "INSERT INTO video_discoveries(video_id,channel_id,last_seen_at) VALUES ('unowned0001',printf('UC%022d',0),'2026-10-21')",
    "INSERT INTO account_video_metadata(account_id,video_id,metadata,fetched_at,expires_at,details_fetched_at) SELECT 'cost-owner',id,json_object('title','Private fixture','durationSeconds',300,'publishedAt',published_at,'liveBroadcastContent','none'),'2026','2099-01-01T00:00:00.000Z','2026' FROM videos WHERE source='youtube'",
    "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<42) INSERT INTO playlists(id,account_id,source,remote_id,title,created_at,updated_at) SELECT printf('p%d',x),'cost-owner','youtube',printf('remote%d',x),'List','2026','2026' FROM n",
    "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<2672) INSERT INTO playlist_items(id,playlist_id,video_id,added_at) SELECT printf('pi%d',x),printf('p%d',x%43),printf('v%010d',1695+x),'2026' FROM n",
  ])
    await db.prepare(sql).run();
}, 30000);
afterAll(() => mf.dispose());
function meter() {
  let read = 0;
  let written = 0;
  const queries: string[] = [];
  const native = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (
    stmt: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(t, k) {
        if (k === "bind")
          return (...args: unknown[]) => wrap(t.bind(...args), sql);
        if (k === "all" || k === "first")
          return async (column?: string) => {
            const r = await t.all<Record<string, unknown>>();
            read += r.meta.rows_read || 0;
            written += r.meta.rows_written || 0;
            queries.push(sql);
            return k === "all"
              ? r
              : column
                ? (r.results?.[0]?.[column] ?? null)
                : (r.results?.[0] ?? null);
          };
        if (k === "run")
          return async () => {
            const r = await t.run();
            read += r.meta.rows_read || 0;
            written += r.meta.rows_written || 0;
            queries.push(sql);
            return r;
          };
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    native.set(proxy, stmt);
    return proxy;
  };
  return {
    db: new Proxy(db, {
      get(t, k) {
        if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
        if (k === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await t.batch(
              statements.map((s) => native.get(s) ?? s),
            );
            for (const result of results) {
              read += result.meta.rows_read || 0;
              written += result.meta.rows_written || 0;
            }
            queries.push(`batch(${statements.length})`);
            return results;
          };
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }),
    get rows() {
      return read;
    },
    get writes() {
      return written;
    },
    queries,
  };
}
it("feed scans are bounded on a realistic library, including many unrelated private placeholders", async () => {
  for (const status of ["all", "pending"] as const) {
    const m = meter();
    const result = await listFeed(
      m.db,
      "cost-owner",
      {
        status,
        channelId: null,
        cursor: null,
        limit: 18,
        types: ["video", "live"],
      },
      "external",
    );
    console.log("D1 cost feed", status, m.rows);
    expect(result.items).toHaveLength(18);
    expect(result.items.map((v) => v.id)).not.toContain("unowned0001");
    expect(m.rows).toBeLessThan(5000);
  }
}, 30000);
it("cached feed reads stay below 100 rows and still hydrate current watch state", async () => {
  const data = new Map<string, string>();
  const kv = {
    get: async (k: string) => data.get(k) || null,
    put: async (k: string, v: string) => {
      data.set(k, v);
    },
  } as unknown as KVNamespace;
  const a = meter();
  const env = { MODE: "real", DB: a.db, READ_CACHE: kv } as unknown as Env;
  const prime = await cachedFeed(env, "cost-owner", "pending", async () => ({
    items: (
      await listFeed(
        a.db,
        "cost-owner",
        {
          status: "pending",
          channelId: null,
          cursor: null,
          limit: 18,
          types: ["video", "live"],
        },
        "external",
      )
    ).items,
    nextCursor: "next",
  }));
  await db
    .prepare(
      "UPDATE watch_states SET position_seconds=30,percent=10 WHERE account_id='cost-owner' AND video_id=?",
    )
    .bind(prime.value.items[0].id)
    .run();
  const b = meter();
  const hit = await cachedFeed(
    { ...env, DB: b.db },
    "cost-owner",
    "pending",
    async () => {
      throw new Error("Unexpected expensive query");
    },
  );
  console.log("D1 cost cached feed", b.rows);
  expect(hit.cache).toBe("hit");
  expect(hit.value.items).toHaveLength(18);
  expect(hit.value.items[0].positionSeconds).toBe(30);
  expect(b.rows).toBeLessThan(100);
});
it("reports playlist and local-suggestion costs", async () => {
  const p = meter();
  expect(await listPlaylists(p.db, "cost-owner", "external")).toHaveLength(43);
  console.log("D1 cost playlists", p.rows);
  const r = meter();
  expect(
    (await getSuggestions(r.db, "cost-owner", "v0000000000", 6, "external"))
      .length,
  ).toBeGreaterThan(0);
  console.log("D1 cost local suggestions", r.rows);
});

/* ------------------------------------------------------------------ */
/* Playlist proposals: measurement-only SQL, not wired into the app.  */
/* ------------------------------------------------------------------ */

// Copied from worker/db.ts VIDEO_COLUMNS/OWNED_VIDEO_JOIN so the candidate
// page query hydrates the same shape as the current detail endpoint. This is a
// test-local measurement query; worker/db.ts is intentionally unchanged.
const PLAYLIST_VIDEO_COLUMNS = `
  v.id AS id,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.title ELSE COALESCE(json_extract(pm.metadata,'$.title'),v.title) END AS title,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.channel_id ELSE COALESCE(json_extract(pm.metadata,'$.channelId'),v.channel_id) END AS channelId,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.channel_title ELSE COALESCE(json_extract(pm.metadata,'$.channelTitle'),v.channel_title) END AS channelTitle,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.thumbnail_url ELSE COALESCE(json_extract(pm.metadata,'$.thumbnailUrl'),v.thumbnail_url) END AS thumbnailUrl,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.published_at ELSE COALESCE(json_extract(pm.metadata,'$.publishedAt'),v.published_at) END AS publishedAt,
  CASE WHEN v.channel_id<>'' AND v.purged_at IS NULL AND (pm.video_id IS NULL OR v.fetched_at>=pm.fetched_at) THEN v.description ELSE COALESCE(json_extract(pm.metadata,'$.description'),v.description) END AS description,
  CASE WHEN pm.details_fetched_at IS NOT NULL AND pm.details_fetched_at>COALESCE(v.details_fetched_at,'') THEN COALESCE(json_extract(pm.metadata,'$.durationSeconds'),v.duration_seconds) ELSE COALESCE(v.duration_seconds,json_extract(pm.metadata,'$.durationSeconds')) END AS durationSeconds,
  CASE WHEN pm.details_fetched_at IS NOT NULL AND pm.details_fetched_at>COALESCE(v.details_fetched_at,'') THEN COALESCE(json_extract(pm.metadata,'$.isLive'),v.is_live) ELSE COALESCE(v.is_live,json_extract(pm.metadata,'$.isLive')) END AS isLive,
  CASE WHEN pm.details_fetched_at IS NOT NULL AND pm.details_fetched_at>COALESCE(v.details_fetched_at,'') THEN COALESCE(json_extract(pm.metadata,'$.liveBroadcastContent'),v.live_broadcast_content) ELSE COALESCE(v.live_broadcast_content,json_extract(pm.metadata,'$.liveBroadcastContent')) END AS liveBroadcastContent,
  COALESCE(ws.watched, 0) AS watched,
  COALESCE(ws.position_seconds, 0) AS positionSeconds,
  COALESCE(ws.percent, 0) AS percent,
  COALESCE(ws.manual, 0) AS manual,
  CASE WHEN pm.details_fetched_at IS NOT NULL AND pm.details_fetched_at>COALESCE(v.details_fetched_at,'') THEN COALESCE(json_extract(pm.metadata,'$.viewCount'),v.view_count) ELSE COALESCE(v.view_count,json_extract(pm.metadata,'$.viewCount')) END AS viewCount,
  COALESCE(ws.revision, 0) AS revision`;
const PLAYLIST_VIDEO_JOIN = `LEFT JOIN account_video_metadata pm ON pm.video_id=v.id AND pm.account_id=?
  AND pm.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

interface CandidateCatalogueRow {
  id: string;
  source: "local" | "youtube";
  item_count: number | null;
}

async function candidateCatalogue(
  database: D1Database,
  accountId: string,
): Promise<CandidateCatalogueRow[]> {
  const result = await database
    .prepare(
      `SELECT p.id, p.source,
              CASE WHEN p.source='youtube' THEN p.remote_item_count
                   ELSE (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id=p.id)
              END AS item_count
       FROM playlists p
       WHERE p.account_id = ?
       ORDER BY p.source ASC, p.title COLLATE NOCASE ASC`,
    )
    .bind(accountId)
    .all<CandidateCatalogueRow>();
  return result.results ?? [];
}

async function candidatePlaylistLookup(
  database: D1Database,
  accountId: string,
  playlistId: string,
): Promise<{
  id: string;
  title: string;
  description: string;
  source: "local" | "youtube";
  remote_id: string | null;
  privacy_status: string | null;
} | null> {
  return database
    .prepare(
      `SELECT p.id, p.title, p.description, p.source, p.remote_id, p.privacy_status
       FROM playlists p WHERE p.id = ? AND p.account_id = ?`,
    )
    .bind(playlistId, accountId)
    .first();
}

interface CandidateDetailRow {
  id: string;
  title: string;
  description: string;
  source: "local" | "youtube";
  remote_id: string | null;
  privacy_status: string | null;
  item_count: number | null;
}

async function candidateDetailSummary(
  database: D1Database,
  accountId: string,
  playlistId: string,
): Promise<CandidateDetailRow | null> {
  return database
    .prepare(
      `SELECT p.id, p.title, p.description, p.source, p.remote_id, p.privacy_status,
              CASE WHEN p.source='youtube' THEN p.remote_item_count
                   ELSE (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id=p.id)
              END AS item_count
       FROM playlists p WHERE p.id = ? AND p.account_id = ?`,
    )
    .bind(playlistId, accountId)
    .first();
}

interface PlaylistPageItem {
  itemId: string;
  position: number;
}

async function candidatePlaylistPage(
  database: D1Database,
  accountId: string,
  playlistId: string,
  scope: "fixture" | "external",
  cursor?: { position: number; itemId: string },
): Promise<PlaylistPageItem[]> {
  const keyset = cursor
    ? "AND (pi.position > ? OR (pi.position = ? AND pi.id > ?))"
    : "";
  const binds: unknown[] = [accountId, accountId, accountId, playlistId];
  if (cursor) binds.push(cursor.position, cursor.position, cursor.itemId);
  const result = await database
    .prepare(
      `SELECT pi.position AS position, pi.id AS playlistItemId, ${PLAYLIST_VIDEO_COLUMNS}
       FROM playlist_items pi
       JOIN playlists p ON p.id = pi.playlist_id AND p.account_id = ?
       JOIN videos v ON v.id = pi.video_id
       LEFT JOIN watch_states ws ON ws.video_id = v.id AND ws.account_id = ?
       ${PLAYLIST_VIDEO_JOIN}
       WHERE pi.playlist_id = ? AND (v.purged_at IS NULL OR pm.video_id IS NOT NULL)
         AND ${scope === "fixture" ? "v.source = 'fixture'" : "v.source <> 'fixture'"}
         ${keyset}
       ORDER BY pi.position ASC, pi.id ASC
       LIMIT 19`,
    )
    .bind(...binds)
    .all<{ position: number; playlistItemId: string }>();
  return (result.results ?? []).map((row) => ({
    position: Number(row.position),
    itemId: String(row.playlistItemId),
  }));
}

interface ExistingRelation {
  id: string;
  remote_item_id: string;
  video_id: string;
  position: number;
}

interface RemoteRelation {
  remoteId: string;
  videoId: string;
  position: number;
}

/** Test-local diff used only to count fixture changes; not app reconciliation. */
function relationDiff(existing: ExistingRelation[], remote: RemoteRelation[]) {
  const byRemote = new Map(existing.map((row) => [row.remote_item_id, row]));
  const seen = new Set<string>();
  const inserts: RemoteRelation[] = [];
  const updates: Array<{ existing: ExistingRelation; remote: RemoteRelation }> =
    [];
  for (const item of remote) {
    seen.add(item.remoteId);
    const current = byRemote.get(item.remoteId);
    if (!current) {
      inserts.push(item);
    } else if (
      current.video_id !== item.videoId ||
      current.position !== item.position
    ) {
      updates.push({ existing: current, remote: item });
    }
  }
  const deletes = existing.filter((row) => !seen.has(row.remote_item_id));
  return { inserts, updates, deletes };
}

it("measures catalogue cost: current counts versus remote_item_count and local-only counts", async () => {
  const baseline = meter();
  const current43 = await listPlaylists(baseline.db, "cost-owner", "external");
  console.log(
    "D1 cost catalogue current 43 youtube lists",
    baseline.rows,
    "reads",
    baseline.writes,
    "writes",
  );
  expect(current43).toHaveLength(43);
  expect(
    current43.reduce((total, playlist) => total + playlist.itemCount, 0),
  ).toBe(2673);
  expect(baseline.rows).toBe(8147);

  // Synthetic fixture additions happen outside every measurement. Local-a uses
  // fixture-source videos to expose the external-scope difference; local-b uses
  // external videos so its raw and scoped counts coincide.
  await db.batch([
    db.prepare(
      `INSERT INTO videos(id,channel_id,title,published_at,duration_seconds,is_live,live_broadcast_content,source,fetched_at,expires_at,purged_at,created_at,updated_at)
       VALUES ('localvid0001','','Local 1','2026-01-01T00:00:00.000Z',300,0,'none','fixture','2026','2099-01-01T00:00:00.000Z',NULL,'2026','2026'),
              ('localvid0002','','Local 2','2026-01-02T00:00:00.000Z',300,0,'none','fixture','2026','2099-01-01T00:00:00.000Z',NULL,'2026','2026'),
              ('localvid0003','','Local 3','2026-01-03T00:00:00.000Z',300,0,'none','fixture','2026','2099-01-01T00:00:00.000Z',NULL,'2026','2026')`,
    ),
    db.prepare(
      `INSERT INTO playlists(id,account_id,source,remote_id,title,description,created_at,updated_at)
       VALUES ('local-a','cost-owner','local',NULL,'Alpha local','','2026','2026'),
              ('local-b','cost-owner','local',NULL,'Beta local','','2026','2026')`,
    ),
    db.prepare(
      `INSERT INTO playlist_items(id,playlist_id,video_id,remote_item_id,position,added_at)
       VALUES ('localpi1','local-a','localvid0001',NULL,0,'2026'),
              ('localpi2','local-a','localvid0002',NULL,1,'2026'),
              ('localpi3','local-a','localvid0003',NULL,2,'2026'),
              ('localpi4','local-b','v0000001695',NULL,0,'2026'),
              ('localpi5','local-b','v0000001738',NULL,1,'2026')`,
    ),
  ]);

  const unseeded = meter();
  const nullRemote = await candidateCatalogue(unseeded.db, "cost-owner");
  console.log(
    "D1 cost catalogue candidate, remote counts unseeded",
    unseeded.rows,
    "reads",
    unseeded.writes,
    "writes",
  );
  expect(nullRemote).toHaveLength(45);
  const nullYoutube = nullRemote.filter((row) => row.source === "youtube");
  expect(nullYoutube).toHaveLength(43);
  expect(nullYoutube.every((row) => row.item_count === null)).toBe(true);
  expect(nullRemote.find((row) => row.id === "local-a")?.item_count).toBe(3);
  expect(nullRemote.find((row) => row.id === "local-b")?.item_count).toBe(2);

  // Seed the synthetic remote counts from the current visible counts, outside
  // measurement. Real remote_item_count values come from YouTube and stay
  // nullable when unknown; no value is fabricated by the candidate query.
  const visibleById = new Map(
    current43.map((playlist) => [playlist.id, playlist.itemCount]),
  );
  await db.batch(
    current43.map((playlist) =>
      db
        .prepare(
          "UPDATE playlists SET remote_item_count=? WHERE id=? AND account_id=?",
        )
        .bind(playlist.itemCount, playlist.id, "cost-owner"),
    ),
  );

  const combinedBaseline = meter();
  const current45 = await listPlaylists(
    combinedBaseline.db,
    "cost-owner",
    "external",
  );
  console.log(
    "D1 cost catalogue current, 43 remote + 2 local lists",
    combinedBaseline.rows,
    "reads",
    combinedBaseline.writes,
    "writes",
  );
  expect(current45).toHaveLength(45);
  expect(combinedBaseline.rows).toBeLessThan(baseline.rows);

  const candidate = meter();
  const proposed = await candidateCatalogue(candidate.db, "cost-owner");
  console.log(
    "D1 cost catalogue candidate, 43 remote + 2 local lists",
    candidate.rows,
    "reads",
    candidate.writes,
    "writes",
  );
  expect(proposed).toHaveLength(45);
  expect(candidate.writes).toBe(0);
  expect(proposed.map((row) => row.id).sort()).toEqual(
    current45.map((playlist) => playlist.id).sort(),
  );

  const currentById = new Map(
    current45.map((playlist) => [playlist.id, playlist.itemCount]),
  );
  for (const row of proposed.filter((entry) => entry.source === "youtube")) {
    expect(row.item_count).toBe(currentById.get(row.id));
  }
  // Raw local COUNT(*) ignores video scope and purged visibility. In this
  // fixture local-a's three fixture-source videos are hidden from the external
  // API scope, so the current endpoint reports 0 while the raw candidate counts 3.
  expect(currentById.get("local-a")).toBe(0);
  expect(proposed.find((row) => row.id === "local-a")?.item_count).toBe(3);
  expect(currentById.get("local-b")).toBe(2);
  expect(proposed.find((row) => row.id === "local-b")?.item_count).toBe(2);

  const currentRowMeter = meter();
  const currentRow = await getPlaylistRow(
    currentRowMeter.db,
    "cost-owner",
    "p0",
    "external",
  );
  console.log(
    "D1 cost getPlaylistRow current",
    currentRowMeter.rows,
    "reads",
    currentRowMeter.writes,
    "writes",
  );
  expect(currentRow?.id).toBe("p0");

  const candidateRowMeter = meter();
  const candidateRow = await candidatePlaylistLookup(
    candidateRowMeter.db,
    "cost-owner",
    "p0",
  );
  console.log(
    "D1 cost mutation lookup candidate (no count)",
    candidateRowMeter.rows,
    "reads",
    candidateRowMeter.writes,
    "writes",
  );
  expect(candidateRow?.source).toBe("youtube");
  expect(candidateRowMeter.rows).toBe(1);
  expect(candidateRowMeter.writes).toBe(0);
}, 30000);

it("measures detail: full list versus 18-item keyset pages", async () => {
  // Deterministic positions outside measurement; the current fixture leaves all
  // positions at 0, so page order would otherwise be lexicographic id only.
  const playlistItemIds = await db
    .prepare("SELECT id FROM playlist_items WHERE playlist_id='p0' ORDER BY id")
    .all<{ id: string }>();
  await db.batch(
    (playlistItemIds.results ?? []).map((row, index) =>
      db
        .prepare("UPDATE playlist_items SET position=? WHERE id=?")
        .bind(index, row.id),
    ),
  );

  const fullMeter = meter();
  const full = await getPlaylistDetail(
    fullMeter.db,
    "cost-owner",
    "p0",
    "external",
  );
  console.log(
    "D1 cost detail current full 63 items (row + items)",
    fullMeter.rows,
    "reads",
    fullMeter.writes,
    "writes",
  );
  expect(full?.items).toHaveLength(63);
  const fullItemIds = full!.items.map((item) => item.playlistItemId!);
  expect(fullItemIds.every(Boolean)).toBe(true);

  const lookupMeter = meter();
  const row = await candidateDetailSummary(lookupMeter.db, "cost-owner", "p0");
  console.log(
    "D1 cost detail candidate summary (remote_item_count, no count scan)",
    lookupMeter.rows,
    "reads",
    lookupMeter.writes,
    "writes",
  );
  expect(row?.id).toBe("p0");
  expect(row?.item_count).toBe(63);
  expect(lookupMeter.rows).toBe(1);
  expect(lookupMeter.writes).toBe(0);

  const firstMeter = meter();
  const first = await candidatePlaylistPage(
    firstMeter.db,
    "cost-owner",
    "p0",
    "external",
  );
  console.log(
    "D1 cost detail candidate page 1 (18 + 1 lookahead)",
    firstMeter.rows,
    "reads",
    firstMeter.writes,
    "writes",
  );
  expect(first).toHaveLength(19);
  expect(first.slice(0, 18).map((item) => item.itemId)).toEqual(
    fullItemIds.slice(0, 18),
  );
  expect(firstMeter.queries.join("\n")).not.toMatch(/COUNT\s*\(/i);
  expect(firstMeter.writes).toBe(0);

  const cursorPosition = await db
    .prepare("SELECT position FROM playlist_items WHERE id=?")
    .bind(fullItemIds[17])
    .first<{ position: number }>();
  expect(cursorPosition).not.toBeNull();
  const secondMeter = meter();
  const second = await candidatePlaylistPage(
    secondMeter.db,
    "cost-owner",
    "p0",
    "external",
    { position: Number(cursorPosition!.position), itemId: fullItemIds[17] },
  );
  console.log(
    "D1 cost detail candidate page 2 (18 + 1 lookahead)",
    secondMeter.rows,
    "reads",
    secondMeter.writes,
    "writes",
  );
  expect(second).toHaveLength(19);
  expect(second.slice(0, 18).map((item) => item.itemId)).toEqual(
    fullItemIds.slice(18, 36),
  );
  expect(secondMeter.writes).toBe(0);
  expect(secondMeter.queries.join("\n")).not.toMatch(/COUNT\s*\(/i);
  expect(second[0].itemId).not.toBe(first[0].itemId);
  expect(firstMeter.rows + lookupMeter.rows).toBeLessThan(fullMeter.rows);
  expect(secondMeter.rows + lookupMeter.rows).toBeLessThan(fullMeter.rows);

  const otherAccountMeter = meter();
  const otherAccountPage = await candidatePlaylistPage(
    otherAccountMeter.db,
    "cost-other",
    "p0",
    "external",
  );
  const otherAccountRow = await candidateDetailSummary(
    otherAccountMeter.db,
    "cost-other",
    "p0",
  );
  console.log(
    "D1 cost detail candidate other account",
    otherAccountMeter.rows,
    "reads",
    otherAccountMeter.writes,
    "writes",
  );
  expect(otherAccountRow).toBeNull();
  expect(otherAccountPage).toEqual([]);

  const fixtureScopeMeter = meter();
  const fixtureScope = await candidatePlaylistPage(
    fixtureScopeMeter.db,
    "cost-owner",
    "p0",
    "fixture",
  );
  console.log(
    "D1 cost detail candidate fixture scope",
    fixtureScopeMeter.rows,
    "reads",
    fixtureScopeMeter.writes,
    "writes",
  );
  expect(fixtureScope).toEqual([]);
}, 30000);

it("measures playlist sync: current generation writes versus change-only relation writes", async () => {
  const syncVideos = Array.from(
    { length: 31 },
    (_, index) => `v${String(1695 + index).padStart(10, "0")}`,
  );
  await db.batch([
    db.prepare(
      `INSERT INTO playlists(id,account_id,source,remote_id,title,description,remote_item_count,items_synced_at,created_at,updated_at)
       VALUES ('sync-list','cost-owner','youtube','sync-remote','Sync list','',30,'2026','2026','2026')`,
    ),
    db.prepare(
      `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<29)
       INSERT INTO playlist_items(id,playlist_id,video_id,remote_item_id,position,sync_generation,added_at)
       SELECT printf('syncpi%d',x),'sync-list',printf('v%010d',1695+x),printf('sr%d',x),x,'old','2026' FROM n`,
    ),
  ]);
  const snapshot: RemoteRelation[] = Array.from({ length: 30 }, (_, index) => ({
    remoteId: `sr${index}`,
    videoId: syncVideos[index],
    position: index,
  }));

  const current = meter();
  const upserts = snapshot.map((item) =>
    current.db
      .prepare(
        `INSERT INTO playlist_items(id,playlist_id,video_id,remote_item_id,position,sync_generation,added_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(playlist_id,remote_item_id) DO UPDATE SET video_id=excluded.video_id,
         position=excluded.position,sync_generation=excluded.sync_generation`,
      )
      .bind(
        crypto.randomUUID(),
        "sync-list",
        item.videoId,
        item.remoteId,
        item.position,
        "gen-1",
        "2026",
      ),
  );
  const currentResults = await current.db.batch(upserts);
  console.log(
    "D1 cost sync unchanged current relation upserts",
    current.rows,
    "reads",
    current.writes,
    "writes",
  );
  expect(currentResults).toHaveLength(30);
  const relationWrites = current.writes;
  expect(relationWrites).toBe(90);

  await current.db
    .prepare(
      "DELETE FROM playlist_items WHERE playlist_id=? AND added_at<? AND sync_generation IS NOT NULL AND sync_generation<>?",
    )
    .bind("sync-list", "2027-01-01T00:00:00.000Z", "gen-1")
    .run();
  console.log(
    "D1 cost sync unchanged current tail delete",
    current.rows,
    "reads",
    current.writes,
    "writes",
  );
  expect(current.writes).toBe(relationWrites);

  await current.db
    .prepare(
      "UPDATE playlists SET items_synced_at=?,remote_item_count=(SELECT count(*) FROM playlist_items WHERE playlist_id=?),updated_at=? WHERE id=? AND account_id=?",
    )
    .bind(
      "2027-01-01T00:00:00.000Z",
      "sync-list",
      "2027-01-01T00:00:00.000Z",
      "sync-list",
      "cost-owner",
    )
    .run();
  console.log(
    "D1 cost sync unchanged current total including playlist row",
    current.rows,
    "reads",
    current.writes,
    "writes",
  );
  expect(current.writes).toBe(relationWrites + 1);

  const proposed = meter();
  const existingResult = await proposed.db
    .prepare(
      "SELECT id,remote_item_id,video_id,position FROM playlist_items WHERE playlist_id=? ORDER BY position,id",
    )
    .bind("sync-list")
    .all<ExistingRelation>();
  const existing = existingResult.results ?? [];
  console.log(
    "D1 cost sync unchanged candidate snapshot read",
    proposed.rows,
    "reads",
    proposed.writes,
    "writes",
  );
  expect(existing).toHaveLength(30);
  const unchanged = relationDiff(existing, snapshot);
  expect(unchanged).toEqual({ inserts: [], updates: [], deletes: [] });
  expect(proposed.writes).toBe(0);

  // Changed fixture: one reorder, one removal and one addition. The test-local
  // diff only counts deltas; it is not a production reconciliation algorithm.
  const changedSnapshot = snapshot
    .filter((item) => item.remoteId !== "sr29")
    .map((item) =>
      item.remoteId === "sr5" ? { ...item, position: 105 } : item,
    );
  changedSnapshot.push({
    remoteId: "sr-new",
    videoId: syncVideos[30],
    position: 30,
  });
  const changed = relationDiff(existing, changedSnapshot);
  expect(changed.inserts).toHaveLength(1);
  expect(changed.updates).toHaveLength(1);
  expect(changed.deletes).toHaveLength(1);

  const changedMeter = meter();
  await changedMeter.db.batch([
    changedMeter.db
      .prepare(
        `INSERT INTO playlist_items(id,playlist_id,video_id,remote_item_id,position,added_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind(
        "syncpi-new",
        "sync-list",
        changed.inserts[0].videoId,
        changed.inserts[0].remoteId,
        changed.inserts[0].position,
        "2027-01-01T00:00:00.000Z",
      ),
    changedMeter.db
      .prepare(
        "UPDATE playlist_items SET position=? WHERE playlist_id=? AND remote_item_id=? AND position<>?",
      )
      .bind(
        changed.updates[0].remote.position,
        "sync-list",
        changed.updates[0].remote.remoteId,
        changed.updates[0].remote.position,
      ),
    changedMeter.db
      .prepare(
        "DELETE FROM playlist_items WHERE playlist_id=? AND remote_item_id=?",
      )
      .bind("sync-list", changed.deletes[0].remote_item_id),
  ]);
  console.log(
    "D1 cost sync changed relations (1 insert, 1 update, 1 delete)",
    changedMeter.rows,
    "reads",
    changedMeter.writes,
    "writes",
  );
  expect(changedMeter.writes).toBeGreaterThan(0);
  const finalState = await db
    .prepare(
      "SELECT count(*) AS n, sum(CASE WHEN remote_item_id='sr-new' THEN 1 ELSE 0 END) AS added, sum(CASE WHEN remote_item_id='sr29' THEN 1 ELSE 0 END) AS removed FROM playlist_items WHERE playlist_id='sync-list'",
    )
    .first<{ n: number; added: number; removed: number }>();
  expect(finalState?.n).toBe(30);
  expect(finalState?.added).toBe(1);
  expect(finalState?.removed).toBe(0);
}, 30000);
