import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../worker/http";
import {
  cachedFeed,
  cachedPlaylists,
  invalidateReads,
  type FeedPage,
} from "../worker/read-cache";
import type { Env, PlaylistSummary, Video } from "../worker/types";

const QUERY = "types=video,live&status=all&limit=18";

interface StoredWatch {
  watched: number;
  positionSeconds: number;
  percent: number;
  manual: number;
  revision: number;
}

interface QueryRecord {
  sql: string;
  args: unknown[];
}

interface PutRecord {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

class FakeKV {
  store = new Map<string, string>();
  gets: string[] = [];
  puts: PutRecord[] = [];
  deletes: string[] = [];
  failGet = false;
  failPut = false;

  async get(key: string): Promise<string | null> {
    this.gets.push(key);
    if (this.failGet) throw new Error("KV get unavailable");
    return this.store.get(key) ?? null;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.puts.push({ key, value, options });
    if (this.failPut) throw new Error("KV put quota exceeded");
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.store.delete(key);
  }
}

class FakeStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.args);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return this.db.all<T>(this.sql, this.args);
  }

  async run(): Promise<{ success: boolean }> {
    return this.db.run(this.sql, this.args);
  }
}

class FakeD1 {
  constructor() {
    this.addAccount("owner-a");
    this.addAccount("owner-b");
  }
  accounts = new Map<string, { mode: "real" | "demo"; connected: number }>();
  generations = new Map<string, string>();
  watch = new Map<string, Map<string, StoredWatch>>();
  queries: QueryRecord[] = [];
  failGeneration = false;
  failWatch = false;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  addAccount(
    ownerId: string,
    mode: "real" | "demo" = "real",
    connected = 1,
  ): void {
    this.accounts.set(ownerId, { mode, connected });
    this.generations.set(ownerId, "0");
  }

  setWatch(
    ownerId: string,
    videoId: string,
    state: Partial<StoredWatch> = {},
  ): void {
    let byVideo = this.watch.get(ownerId);
    if (!byVideo) {
      byVideo = new Map();
      this.watch.set(ownerId, byVideo);
    }
    byVideo.set(videoId, {
      watched: 0,
      positionSeconds: 0,
      percent: 0,
      manual: 0,
      revision: 0,
      ...state,
    });
  }

  watchQueries(): QueryRecord[] {
    return this.queries.filter((query) =>
      query.sql.includes("FROM watch_states"),
    );
  }

  generationReads(): QueryRecord[] {
    return this.queries.filter((query) =>
      query.sql.includes("SELECT cursor FROM sync_state"),
    );
  }

  invalidationWrites(): QueryRecord[] {
    return this.queries.filter((query) =>
      query.sql.includes("INSERT INTO sync_state"),
    );
  }

  async first<T>(sql: string, args: unknown[]): Promise<T | null> {
    this.queries.push({ sql, args });
    if (!sql.includes("SELECT cursor FROM sync_state")) {
      throw new Error(`Unexpected first query: ${sql}`);
    }
    if (this.failGeneration) throw new Error("D1 generation read failed");
    if (args[1] !== "cache:reads") {
      throw new Error(`Unexpected generation type: ${String(args[1])}`);
    }
    const cursor = this.generations.get(String(args[0]));
    return (cursor === undefined ? null : { cursor }) as T;
  }

  async all<T>(sql: string, args: unknown[]): Promise<{ results: T[] }> {
    this.queries.push({ sql, args });
    if (!sql.includes("FROM watch_states")) {
      throw new Error(`Unexpected all query: ${sql}`);
    }
    if (this.failWatch) throw new Error("D1 watch hydration failed");
    const byVideo = this.watch.get(String(args[0])) ?? new Map();
    const results = args
      .slice(1)
      .map(String)
      .filter((videoId) => byVideo.has(videoId))
      .map((videoId) => ({ videoId, ...byVideo.get(videoId)! }));
    return { results: results as T[] };
  }

  async run(sql: string, args: unknown[]): Promise<{ success: boolean }> {
    this.queries.push({ sql, args });
    if (!sql.includes("INSERT INTO sync_state")) {
      throw new Error(`Unexpected run query: ${sql}`);
    }
    if (!sql.includes("ON CONFLICT(account_id, type)")) {
      throw new Error("Invalidation must upsert the generation");
    }
    if (args[0] !== "cache:reads") {
      throw new Error(`Unexpected generation type: ${String(args[0])}`);
    }
    const account = this.accounts.get(String(args[2]));
    if (account?.mode === "real" && account.connected === 1) {
      this.generations.set(String(args[2]), String(args[1]));
    }
    return { success: true };
  }
}

function makeEnv(
  options: { kv?: FakeKV; db?: FakeD1; mode?: "real" | "demo" } = {},
): Env {
  return {
    MODE: options.mode ?? "real",
    DB: (options.db ?? new FakeD1()) as unknown as D1Database,
    ...(options.kv ? { READ_CACHE: options.kv as unknown as KVNamespace } : {}),
  } as unknown as Env;
}

function video(id: string, overrides: Partial<Video> = {}): Video {
  return {
    id,
    title: `Video ${id}`,
    channelId: "channel-1",
    channelTitle: "Channel",
    thumbnailUrl: "https://example.test/thumb.jpg",
    publishedAt: "2026-01-01T00:00:00.000Z",
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
    ...overrides,
  };
}

function summary(
  id: string,
  overrides: Partial<PlaylistSummary> = {},
): PlaylistSummary {
  return {
    id,
    title: `Playlist ${id}`,
    description: "Description",
    source: "local",
    itemCount: 2,
    ...overrides,
  };
}

async function expectedKey(
  kind: "feed" | "playlists",
  owner: string,
  generation: string,
  query: string,
): Promise<string> {
  return `read-cache:v1:${encodeURIComponent(owner)}:${encodeURIComponent(generation)}:${kind}:${await sha256Hex(query)}`;
}

describe("cachedFeed", () => {
  it("does not resurrect old cached data after account state is cleared and reconnected", async () => {
    const kv = new FakeKV(),
      db = new FakeD1(),
      env = makeEnv({ kv, db });
    await cachedFeed(env, "owner-a", QUERY, async () => ({
      items: [video("old")],
      nextCursor: null,
    }));
    const oldKey = kv.puts[0].key;
    db.generations.delete("owner-a");
    const fresh = await cachedFeed(env, "owner-a", QUERY, async () => ({
      items: [video("new")],
      nextCursor: null,
    }));
    expect(fresh.cache).toBe("miss");
    expect(fresh.value.items[0].id).toBe("new");
    expect(kv.puts.at(-1)?.key).not.toBe(oldKey);
  });
  it("serves a hit without the loader and hydrates fresh watch state in one query", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    const env = makeEnv({ kv, db });
    const leakyVideo = {
      ...video("v1", {
        watched: true,
        positionSeconds: 90,
        percent: 100,
        manual: true,
        revision: 7,
      }),
      accessToken: "secret-access-token",
    } as Video & { accessToken: string };
    const loader = vi.fn(async (): Promise<FeedPage> => ({
      items: [
        leakyVideo,
        video("v2", {
          watched: false,
          positionSeconds: 3,
          percent: 1,
          manual: false,
          revision: 2,
        }),
      ],
      nextCursor: "cursor-2",
    }));

    const first = await cachedFeed(env, "owner-a", QUERY, loader);
    expect(first.cache).toBe("miss");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].options).toEqual({ expirationTtl: 60 });
    expect(kv.puts[0].key).toBe(
      await expectedKey("feed", "owner-a", "0", QUERY),
    );
    expect(kv.puts[0].value).not.toContain("secret-access-token");
    const envelope = JSON.parse(kv.puts[0].value) as {
      value: FeedPage;
    } & Record<string, unknown>;
    expect(envelope).toMatchObject({
      v: 1,
      kind: "feed",
      owner: "owner-a",
      generation: "0",
      query: QUERY,
    });
    for (const item of envelope.value.items) {
      expect(item).toMatchObject({
        watched: false,
        positionSeconds: 0,
        percent: 0,
        manual: false,
        revision: 0,
      });
      expect("accessToken" in item).toBe(false);
    }

    db.setWatch("owner-a", "v1", {
      watched: 1,
      positionSeconds: 42,
      percent: 50,
      manual: 1,
      revision: 3,
    });
    const hitLoader = vi.fn(async (): Promise<FeedPage> => {
      throw new Error("loader must not run on a hit");
    });
    const hit = await cachedFeed(env, "owner-a", QUERY, hitLoader);
    expect(hit.cache).toBe("hit");
    expect(hitLoader).not.toHaveBeenCalled();
    expect(hit.value.nextCursor).toBe("cursor-2");
    expect(hit.value.items[0]).toMatchObject({
      id: "v1",
      title: "Video v1",
      watched: true,
      positionSeconds: 42,
      percent: 50,
      manual: true,
      revision: 3,
    });
    expect(hit.value.items[1]).toMatchObject({
      id: "v2",
      watched: false,
      positionSeconds: 0,
      percent: 0,
      manual: false,
      revision: 0,
    });
    expect("accessToken" in hit.value.items[0]).toBe(false);

    const watchQueries = db.watchQueries();
    expect(watchQueries).toHaveLength(1);
    expect(watchQueries[0].sql).toContain("video_id IN (?,?)");
    expect(watchQueries[0].args).toEqual(["owner-a", "v1", "v2"]);
    expect(db.generationReads()).toHaveLength(2);
  });

  it("isolates owners, including copied payloads and watch state", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    const env = makeEnv({ kv, db });
    const page = (): FeedPage => ({
      items: [video("shared")],
      nextCursor: null,
    });

    const aLoader = vi.fn(async () => page());
    await cachedFeed(env, "owner-a", "scope=external", aLoader);
    const bLoader = vi.fn(async () => page());
    await cachedFeed(env, "owner-b", "scope=external", bLoader);
    expect(kv.puts).toHaveLength(2);
    expect(kv.puts[0].key).not.toBe(kv.puts[1].key);
    expect(kv.puts[0].key).toContain("owner-a");
    expect(kv.puts[1].key).toContain("owner-b");

    // A payload copied under another owner's key is rejected.
    kv.store.set(kv.puts[1].key, kv.puts[0].value);
    const retryLoader = vi.fn(async () => page());
    const retried = await cachedFeed(
      env,
      "owner-b",
      "scope=external",
      retryLoader,
    );
    expect(retried.cache).toBe("miss");
    expect(retryLoader).toHaveBeenCalledTimes(1);

    db.setWatch("owner-a", "shared", {
      watched: 1,
      positionSeconds: 30,
      percent: 25,
      manual: 0,
      revision: 4,
    });
    const hitA = await cachedFeed(
      env,
      "owner-a",
      "scope=external",
      vi.fn(async (): Promise<FeedPage> => {
        throw new Error("owner A loader must not run");
      }),
    );
    const hitB = await cachedFeed(
      env,
      "owner-b",
      "scope=external",
      vi.fn(async (): Promise<FeedPage> => {
        throw new Error("owner B loader must not run");
      }),
    );
    expect(hitA.value.items[0]).toMatchObject({
      watched: true,
      positionSeconds: 30,
      percent: 25,
      revision: 4,
    });
    expect(hitB.value.items[0]).toMatchObject({
      watched: false,
      positionSeconds: 0,
      percent: 0,
      manual: false,
      revision: 0,
    });
    expect(db.watchQueries().map((query) => query.args[0])).toEqual([
      "owner-a",
      "owner-b",
    ]);
  });

  it("changes the key on invalidation without deleting old KV entries", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    db.addAccount("owner-a");
    const env = makeEnv({ kv, db });

    const firstLoader = vi.fn(async () => ({
      items: [video("v1", { title: "Before" })],
      nextCursor: null,
    }));
    await cachedFeed(env, "owner-a", QUERY, firstLoader);
    const oldKey = kv.puts[0].key;

    await invalidateReads(env, "owner-a");
    expect(kv.deletes).toHaveLength(0);
    const writes = db.invalidationWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain("SELECT id");
    expect(writes[0].sql).toContain("connected = 1");
    expect(writes[0].sql).toContain("ON CONFLICT(account_id, type)");
    expect(writes[0].args[0]).toBe("cache:reads");
    expect(String(writes[0].args[1])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(writes[0].args[2]).toBe("owner-a");
    const generation = db.generations.get("owner-a");
    expect(generation).toBe(String(writes[0].args[1]));

    const secondLoader = vi.fn(async () => ({
      items: [video("v1", { title: "After" })],
      nextCursor: null,
    }));
    const second = await cachedFeed(env, "owner-a", QUERY, secondLoader);
    expect(second.cache).toBe("miss");
    expect(secondLoader).toHaveBeenCalledTimes(1);
    expect(kv.puts[1].key).not.toBe(oldKey);
    expect(kv.puts[1].key).toContain(String(generation));
    expect(kv.store.has(oldKey)).toBe(true);

    db.accounts.set("owner-a", { mode: "real", connected: 0 });
    await invalidateReads(env, "owner-a");
    expect(db.generations.get("owner-a")).toBe(generation);
  });

  it("falls back on KV get errors and survives KV put quota failures", async () => {
    const getKv = new FakeKV();
    getKv.failGet = true;
    const getDb = new FakeD1();
    const getEnv = makeEnv({ kv: getKv, db: getDb });
    const loadedPage: FeedPage = {
      items: [video("v1", { title: "Loaded" })],
      nextCursor: null,
    };
    const loader = vi.fn(async () => loadedPage);
    const result = await cachedFeed(getEnv, "owner-a", QUERY, loader);
    expect(result.cache).toBe("miss");
    expect(result.value).toBe(loadedPage);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getKv.puts).toHaveLength(1);

    const putKv = new FakeKV();
    putKv.failPut = true;
    const putEnv = makeEnv({ kv: putKv, db: new FakeD1() });
    const quotaLoader = vi.fn(async () => ({
      items: [video("v2", { title: "Still returned" })],
      nextCursor: "next",
    }));
    const quota = await cachedFeed(putEnv, "owner-a", QUERY, quotaLoader);
    expect(quota.cache).toBe("miss");
    expect(quota.value.items[0].title).toBe("Still returned");
    expect(quotaLoader).toHaveBeenCalledTimes(1);
    expect(putKv.puts).toHaveLength(1);
    expect(putKv.store.size).toBe(0);
  });

  it("is disabled without KV or outside real mode without querying D1", async () => {
    const noKvDb = new FakeD1();
    const noKvLoader = vi.fn(async () => ({
      items: [video("v1")],
      nextCursor: null,
    }));
    const noKv = await cachedFeed(
      makeEnv({ db: noKvDb }),
      "owner-a",
      QUERY,
      noKvLoader,
    );
    expect(noKv.cache).toBe("disabled");
    expect(noKvLoader).toHaveBeenCalledTimes(1);
    expect(noKvDb.queries).toHaveLength(0);

    const demoKv = new FakeKV();
    const demoDb = new FakeD1();
    const demoLoader = vi.fn(async () => ({
      items: [video("v1")],
      nextCursor: null,
    }));
    const demo = await cachedFeed(
      makeEnv({ kv: demoKv, db: demoDb, mode: "demo" }),
      "owner-a",
      QUERY,
      demoLoader,
    );
    expect(demo.cache).toBe("disabled");
    expect(demoLoader).toHaveBeenCalledTimes(1);
    expect(demoDb.queries).toHaveLength(0);
    expect(demoKv.gets).toHaveLength(0);
    expect(demoKv.puts).toHaveLength(0);

    const disabledDb = new FakeD1();
    await invalidateReads(makeEnv({ db: disabledDb }), "owner-a");
    expect(disabledDb.queries).toHaveLength(0);
  });

  it("falls back on malformed, mismatched, or misshapen payloads", async () => {
    const baseEnvelope = {
      v: 1,
      kind: "feed",
      owner: "owner-a",
      generation: "0",
      query: QUERY,
      value: { items: [video("v1")], nextCursor: null },
    };
    const cases: Array<[string, string]> = [
      ["malformed JSON", "{"],
      ["wrong version", JSON.stringify({ ...baseEnvelope, v: 2 })],
      ["wrong owner", JSON.stringify({ ...baseEnvelope, owner: "owner-b" })],
      ["wrong kind", JSON.stringify({ ...baseEnvelope, kind: "playlists" })],
      [
        "wrong generation",
        JSON.stringify({ ...baseEnvelope, generation: "stale" }),
      ],
      ["wrong query", JSON.stringify({ ...baseEnvelope, query: "other" })],
      ["missing value", JSON.stringify({ ...baseEnvelope, value: undefined })],
      [
        "invalid feed shape",
        JSON.stringify({
          ...baseEnvelope,
          value: { items: [{ id: "v1" }], nextCursor: null },
        }),
      ],
      [
        "invalid cursor",
        JSON.stringify({
          ...baseEnvelope,
          value: { items: [], nextCursor: 42 },
        }),
      ],
    ];

    for (const [name, raw] of cases) {
      const kv = new FakeKV();
      const db = new FakeD1();
      const env = makeEnv({ kv, db });
      kv.store.set(await expectedKey("feed", "owner-a", "0", QUERY), raw);
      const loader = vi.fn(async () => ({
        items: [video("fresh")],
        nextCursor: null,
      }));
      const result = await cachedFeed(env, "owner-a", QUERY, loader);
      expect(result.cache, name).toBe("miss");
      expect(loader, name).toHaveBeenCalledTimes(1);
      expect(result.value.items[0].id, name).toBe("fresh");
    }
  });

  it("bounds hydration to D1's 100-parameter limit", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    const env = makeEnv({ kv, db });
    const items = Array.from({ length: 99 }, (_, index) => video(`v${index}`));
    const first = await cachedFeed(env, "owner-a", QUERY, async () => ({
      items,
      nextCursor: null,
    }));
    expect(first.cache).toBe("miss");
    expect(kv.puts).toHaveLength(1);

    const hit = await cachedFeed(
      env,
      "owner-a",
      QUERY,
      vi.fn(async (): Promise<FeedPage> => {
        throw new Error("loader must not run");
      }),
    );
    expect(hit.cache).toBe("hit");
    expect(hit.value.items).toHaveLength(99);
    const watchQueries = db.watchQueries();
    expect(watchQueries).toHaveLength(1);
    expect(watchQueries[0].args).toHaveLength(100);
    expect(watchQueries[0].args[0]).toBe("owner-a");
  });

  it("does not cache oversized pages and hashes unbounded query keys", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    const env = makeEnv({ kv, db });
    const oversized = Array.from({ length: 100 }, (_, index) =>
      video(`v${index}`),
    );
    const large = await cachedFeed(env, "owner-a", QUERY, async () => ({
      items: oversized,
      nextCursor: null,
    }));
    expect(large.cache).toBe("miss");
    expect(large.value.items).toHaveLength(100);
    expect(kv.puts).toHaveLength(0);

    const longQuery = "q".repeat(5_000);
    const small = await cachedFeed(env, "owner-a", longQuery, async () => ({
      items: [video("v1")],
      nextCursor: null,
    }));
    expect(small.cache).toBe("miss");
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key.length).toBeLessThan(256);
    expect(kv.puts[0].key).not.toContain("qqqq");
    expect(kv.puts[0].key).toMatch(/[0-9a-f]{64}$/);
  });

  it("propagates D1 errors instead of hiding them", async () => {
    const kv = new FakeKV();
    const generationDb = new FakeD1();
    generationDb.failGeneration = true;
    const loader = vi.fn(async () => ({
      items: [video("v1")],
      nextCursor: null,
    }));
    await expect(
      cachedFeed(makeEnv({ kv, db: generationDb }), "owner-a", QUERY, loader),
    ).rejects.toThrow("D1 generation read failed");
    expect(loader).not.toHaveBeenCalled();

    const hydrationKv = new FakeKV();
    const hydrationDb = new FakeD1();
    const hydrationEnv = makeEnv({ kv: hydrationKv, db: hydrationDb });
    await cachedFeed(hydrationEnv, "owner-a", QUERY, async () => ({
      items: [video("v1")],
      nextCursor: null,
    }));
    hydrationDb.failWatch = true;
    const hitLoader = vi.fn(async (): Promise<FeedPage> => {
      throw new Error("loader must not run");
    });
    await expect(
      cachedFeed(hydrationEnv, "owner-a", QUERY, hitLoader),
    ).rejects.toThrow("D1 watch hydration failed");
    expect(hitLoader).not.toHaveBeenCalled();
  });
});

describe("cachedPlaylists", () => {
  it("caches summaries without extra secret fields and supports the optional query key", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    const env = makeEnv({ kv, db });
    const summaries: PlaylistSummary[] = [
      {
        ...summary("p1"),
        accessToken: "secret-playlist-token",
      } as PlaylistSummary,
      summary("p2", { source: "youtube", itemCount: 7 }),
    ];
    const loader = vi.fn(async () => summaries);
    const first = await cachedPlaylists(env, "owner-a", loader);
    expect(first.cache).toBe("miss");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].options).toEqual({ expirationTtl: 60 });
    expect(kv.puts[0].key).toBe(
      await expectedKey("playlists", "owner-a", "0", ""),
    );
    expect(kv.puts[0].value).not.toContain("secret-playlist-token");
    const envelope = JSON.parse(kv.puts[0].value) as {
      value: PlaylistSummary[];
    } & Record<string, unknown>;
    expect(envelope).toMatchObject({
      v: 1,
      kind: "playlists",
      owner: "owner-a",
      generation: "0",
      query: "",
    });
    expect(envelope.value).toEqual([
      summary("p1"),
      summary("p2", { source: "youtube", itemCount: 7 }),
    ]);

    const hitLoader = vi.fn(async (): Promise<PlaylistSummary[]> => {
      throw new Error("playlist loader must not run");
    });
    const hit = await cachedPlaylists(env, "owner-a", "", hitLoader);
    expect(hit.cache).toBe("hit");
    expect(hitLoader).not.toHaveBeenCalled();
    expect(hit.value).toEqual([
      summary("p1"),
      summary("p2", { source: "youtube", itemCount: 7 }),
    ]);

    const scopedLoader = vi.fn(async () => []);
    const scoped = await cachedPlaylists(
      env,
      "owner-a",
      "scope=external",
      scopedLoader,
    );
    expect(scoped.cache).toBe("miss");
    expect(scopedLoader).toHaveBeenCalledTimes(1);
  });

  it("falls back on invalid playlist payloads and stays disabled without KV", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    const env = makeEnv({ kv, db });
    kv.store.set(
      await expectedKey("playlists", "owner-a", "0", ""),
      JSON.stringify({
        v: 1,
        kind: "playlists",
        owner: "owner-a",
        generation: "0",
        query: "",
        value: [{ id: "p1", title: "Missing fields" }],
      }),
    );
    const loader = vi.fn(async () => [summary("fresh")]);
    const fallback = await cachedPlaylists(env, "owner-a", loader);
    expect(fallback.cache).toBe("miss");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fallback.value[0].id).toBe("fresh");

    const demoNamespace = new FakeKV();
    const demoDb = new FakeD1();
    const demoLoader = vi.fn(async () => [summary("demo")]);
    const disabled = await cachedPlaylists(
      makeEnv({ kv: demoNamespace, db: demoDb, mode: "demo" }),
      "owner-a",
      demoLoader,
    );
    expect(disabled.cache).toBe("disabled");
    expect(demoLoader).toHaveBeenCalledTimes(1);
    expect(demoDb.queries).toHaveLength(0);
    expect(demoNamespace.gets).toHaveLength(0);
    expect(demoNamespace.puts).toHaveLength(0);
  });

  it("does not cache more than the bounded item count", async () => {
    const kv = new FakeKV();
    const env = makeEnv({ kv, db: new FakeD1() });
    const many = Array.from({ length: 101 }, (_, index) =>
      summary(`p${index}`),
    );
    const result = await cachedPlaylists(env, "owner-a", async () => many);
    expect(result.cache).toBe("miss");
    expect(result.value).toHaveLength(101);
    expect(kv.puts).toHaveLength(0);
  });
});
