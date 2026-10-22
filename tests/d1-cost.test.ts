import { beforeAll, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { listFeed, listPlaylists, getSuggestions } from "../worker/db";
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
  const queries: string[] = [];
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(t, k) {
        if (k === "bind")
          return (...args: unknown[]) => wrap(t.bind(...args), sql);
        if (k === "all" || k === "first")
          return async (column?: string) => {
            const r = await t.all<Record<string, unknown>>();
            read += r.meta.rows_read || 0;
            queries.push(sql);
            return k === "all"
              ? r
              : column
                ? (r.results?.[0]?.[column] ?? null)
                : (r.results?.[0] ?? null);
          };
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return {
    db: new Proxy(db, {
      get(t, k) {
        if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }),
    get rows() {
      return read;
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
