#!/usr/bin/env node
/**
 * Isolated experiment: "sync now, import only videos published in the last 24h".
 *
 * It does not touch the source D1 file. It:
 *   1. fingerprints the source database with a read-only connection,
 *   2. makes a consistent SQLite backup,
 *   3. fetches each active subscription's public Atom feed once (max 3 in flight),
 *   4. replays only the last-24h entries through an isolated Miniflare D1 copy
 *      using the production RSS SQL/statements,
 *   5. repeats the replay to measure a no-change run, then deletes safe recent
 *      copies in a second isolated copy to measure a genuinely new import.
 *
 * Reports contain aggregate counts only: no account/channel/video ids, titles,
 * feed bodies or tokens. The reusable script contains no private values.
 *
 * Deviations from the queued production path, by design:
 *   - subscription API, playlists, metadata API and queue coordination are not run;
 *   - old feed entries are counted as current-code candidates but never imported;
 *   - HTTP failures are recorded and skipped (one pass, no retries/backoff);
 *   - channel timestamps use the frozen experiment `now`.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { Miniflare, convertV4MiniflareOptions, getPersistPath } from "miniflare";
import { createServer } from "vite";

const TABLES = [
  "accounts",
  "channels",
  "subscriptions",
  "videos",
  "watch_states",
  "playlists",
  "playlist_items",
  "account_video_metadata",
  "video_discoveries",
  "public_read_cache",
  "sync_state",
  "sync_jobs",
  "sync_runs",
];

const CHANNEL_SELECT_SQL = `SELECT c.id,c.title FROM subscriptions sub JOIN channels c ON c.id=sub.channel_id
 WHERE sub.account_id=? AND sub.active=1 AND sub.channel_id>? ORDER BY sub.channel_id LIMIT 1`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error("Unexpected argument: " + arg);
    const [key, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error("Missing value for --" + key);
    out[key] = value;
  }
  return out;
}

function log(message) {
  process.stderr.write("[recent-sync] " + message + "\n");
}

function openReadOnly(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only=ON");
  return db;
}

function fileDigest(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tableCounts(db) {
  const counts = {};
  for (const table of TABLES) {
    const row = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get();
    counts[table] = Number(row.n);
  }
  return counts;
}

function fingerprint(db, path) {
  const wal = path + "-wal";
  const counts = tableCounts(db);
  const integrity = db.prepare("PRAGMA integrity_check").get();
  return {
    counts,
    integrity: integrity?.integrity_check ?? "unknown",
    dataVersion: Number(db.prepare("PRAGMA data_version").get().data_version),
    mainBytes: statSync(path).size,
    mainSha256: fileDigest(path),
    walBytes: existsSync(wal) ? statSync(wal).size : 0,
    walSha256: fileDigest(wal),
  };
}

function sameFingerprint(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(",");
}

function asSet(rows, column = "id") {
  return new Set(rows.map((row) => String(row[column])));
}

function classifySql(sql) {
  const normalized = String(sql || "").trim().replace(/\s+/g, " ");
  if (normalized.startsWith("SELECT c.id,c.title FROM subscriptions")) return "channel_select";
  if (normalized.startsWith("SELECT id FROM videos WHERE id IN")) return "video_exists";
  if (normalized.startsWith("INSERT INTO videos")) return "video_insert";
  return "other";
}

function emptyStats() {
  return {
    rowsRead: 0,
    rowsWritten: 0,
    operations: 0,
    runCalls: 0,
    allCalls: 0,
    firstCalls: 0,
    batchCalls: 0,
    batchStatements: 0,
  };
}

function addStats(target, meta) {
  target.rowsRead += Number(meta?.rows_read || 0);
  target.rowsWritten += Number(meta?.rows_written || 0);
}

/**
 * D1 meters rows_read/rows_written in each result's meta. `first()` does not
 * expose meta through the local API, so it is executed as `all()` and the
 * first row is returned, matching tests/d1-cost.test.ts.
 */
function createMeter(rawDb) {
  const totals = emptyStats();
  const labels = new Map();
  const sqlByRaw = new WeakMap();
  const rawByProxy = new WeakMap();

  const labelStats = (label) => {
    if (!labels.has(label)) labels.set(label, emptyStats());
    return labels.get(label);
  };
  const add = (label, meta, kind) => {
    const target = labelStats(label);
    addStats(target, meta);
    addStats(totals, meta);
    if (kind === "run") {
      target.runCalls++;
      totals.runCalls++;
    } else if (kind === "all") {
      target.allCalls++;
      totals.allCalls++;
    } else if (kind === "first") {
      target.firstCalls++;
      totals.firstCalls++;
    }
    target.operations++;
    totals.operations++;
  };

  const wrap = (stmt, sql) => {
    const label = classifySql(sql);
    const proxy = new Proxy(stmt, {
      get(target, key) {
        if (key === "bind") {
          return (...args) => wrap(target.bind(...args), sql);
        }
        if (key === "run") {
          return async (...args) => {
            const result = await target.run(...args);
            add(label, result.meta, "run");
            return result;
          };
        }
        if (key === "all") {
          return async (...args) => {
            const result = await target.all(...args);
            add(label, result.meta, "all");
            return result;
          };
        }
        if (key === "first") {
          return async (column) => {
            const result = await target.all();
            add(label, result.meta, "first");
            const row = result.results?.[0] ?? null;
            return column ? (row ? (row[column] ?? null) : null) : row;
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    sqlByRaw.set(stmt, sql);
    rawByProxy.set(proxy, stmt);
    return proxy;
  };

  const db = new Proxy(rawDb, {
    get(target, key) {
      if (key === "prepare") return (sql) => wrap(target.prepare(sql), sql);
      if (key === "batch") {
        return async (statements) => {
          totals.batchCalls++;
          totals.operations++;
          const raws = statements.map((statement) => rawByProxy.get(statement) || statement);
          const results = await target.batch(raws);
          totals.batchStatements += raws.length;
          for (let i = 0; i < results.length; i++) {
            const sql = sqlByRaw.get(raws[i]) || "";
            add(classifySql(sql), results[i].meta, null);
          }
          return results;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    db,
    stats() {
      return {
        ...totals,
        byLabel: Object.fromEntries(
          [...labels.entries()].map(([label, stats]) => [label, { ...stats }]),
        ),
      };
    },
  };
}

async function loadProductionModules(tempRoot) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: join(tempRoot, "vite-cache"),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const db = await server.ssrLoadModule("/worker/db.ts");
    const rss = await server.ssrLoadModule("/worker/rss.ts");
    const rssCache = await server.ssrLoadModule("/worker/rss-cache.ts");
    const http = await server.ssrLoadModule("/worker/http.ts");
    return {
      externalVideoStatement: db.externalVideoStatement,
      isoInDays: http.isoInDays,
      sanitizeText: http.sanitizeText,
      fetchWithTimeout: http.fetchWithTimeout,
      readLimitedText: http.readLimitedText,
      parseAtomFeed: rss.parseAtomFeed,
      channelFeedUrl: rss.channelFeedUrl,
      maxFeedBytes: rss.MAX_FEED_BYTES,
      readRssCheck: rssCache.readRssCheck,
      writeRssCheck: rssCache.writeRssCheck,
      rssRecentCutoff: rssCache.rssRecentCutoff,
    };
  } finally {
    await server.close();
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

async function seedMiniflareD1({ backupPath, root, label, expectedVideos }) {
  const persist = join(root, label);
  mkdirSync(persist, { recursive: true, mode: 0o700 });
  chmodSync(persist, 0o700);
  const options = () =>
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("experiment")}}',
      compatibilityDate: "2026-10-20",
      d1Databases: ["DB"],
      resourcePersistencePath: persist,
    });

  let mf = new Miniflare(options());
  try {
    const db = await mf.getD1Database("DB");
    await db.prepare("SELECT 1 AS ok").first();
  } finally {
    await mf.dispose();
  }

  const d1Root = getPersistPath("d1", "", persist).replaceAll("\\", "/");
  const files = walk(d1Root);
  const dbFiles = files.filter((path) =>
    /miniflare-D1DatabaseObject\/[0-9a-f]{64}\.sqlite$/.test(path.replaceAll("\\", "/")),
  );
  if (dbFiles.length !== 1) {
    throw new Error(`Expected one Miniflare D1 file, found ${dbFiles.length}`);
  }
  const target = dbFiles[0];
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(target + suffix)) unlinkSync(target + suffix);
  }
  copyFileSync(backupPath, target);
  chmodSync(target, 0o600);

  mf = new Miniflare(options());
  const db = await mf.getD1Database("DB");
  const count = Number((await db.prepare("SELECT count(*) AS n FROM videos").first()).n);
  if (count !== expectedVideos) {
    await mf.dispose();
    throw new Error(`Seeded copy mismatch: ${count} != ${expectedVideos}`);
  }
  // D1 forbids integrity_check through its SQL API; validate the SQLite copy
  // directly using a separate read-only connection instead.
  const inspection = openReadOnly(target);
  const integrity = inspection.prepare("PRAGMA integrity_check").get();
  inspection.close();
  if (integrity?.integrity_check !== "ok") {
    await mf.dispose();
    throw new Error("Seeded copy failed integrity_check");
  }
  const foreignKeys = await db.prepare("PRAGMA foreign_key_check").all();
  const fkEnabled = Number((await db.prepare("PRAGMA foreign_keys").first())?.foreign_keys);
  return {
    db,
    foreignKeyViolations: (foreignKeys.results || []).length,
    fkEnabled: fkEnabled === 1,
    close: () => mf.dispose(),
  };
}

function accountAndSubscriptions(copyDb) {
  const accounts = copyDb
    .prepare("SELECT id,mode,connected FROM accounts WHERE mode='real' AND connected=1")
    .all();
  if (accounts.length === 0) throw new Error("No connected real account in copy");
  const account = accounts
    .map((row) => ({
      id: String(row.id),
      subscriptions: Number(
        copyDb
          .prepare("SELECT count(*) AS n FROM subscriptions WHERE account_id=? AND active=1")
          .get(row.id).n,
      ),
    }))
    .sort((a, b) => b.subscriptions - a.subscriptions)[0];
  const subscriptions = copyDb
    .prepare(
      `SELECT s.channel_id AS channelId, c.title AS title,
        s.last_synced_at AS subscriptionLastSyncedAt,
        (SELECT last_run_at FROM sync_state WHERE account_id=s.account_id AND type='queue:rss:' || c.id) AS rssSyncedAt
       FROM subscriptions s JOIN channels c ON c.id=s.channel_id
       WHERE s.account_id=? AND s.active=1 ORDER BY s.channel_id`,
    )
    .all(account.id)
    .map((row) => ({
      channelId: String(row.channelId),
      title: String(row.title || ""),
      subscriptionLastSyncedAt:
        row.subscriptionLastSyncedAt === null || row.subscriptionLastSyncedAt === undefined
          ? null
          : String(row.subscriptionLastSyncedAt),
      rssSyncedAt:
        row.rssSyncedAt === null || row.rssSyncedAt === undefined
          ? null
          : String(row.rssSyncedAt),
    }));
  return { accountId: account.id, accountCount: accounts.length, subscriptions };
}

function resolveCurrentQueueWatermark(copyDb, accountId) {
  const previous = copyDb
    .prepare(
      "SELECT last_run_at FROM sync_state WHERE account_id=? AND type IN (?, 'queue:all') AND last_status='success' ORDER BY last_run_at DESC LIMIT 1",
    )
    .get(accountId, "queue:rss");
  const legacyJob = previous
    ? null
    : copyDb
        .prepare(
          "SELECT created_at AS last_run_at FROM sync_jobs WHERE account_id=? AND type IN (?, 'all') AND status='success' ORDER BY created_at DESC LIMIT 1",
        )
        .get(accountId, "rss");
  const legacyRss = copyDb
    .prepare(
      "SELECT last_run_at FROM sync_state WHERE account_id=? AND type='rss' AND last_status='success' ORDER BY last_run_at DESC LIMIT 1",
    )
    .get(accountId);
  return {
    since: previous?.last_run_at || legacyJob?.last_run_at || null,
    queueWatermark: previous?.last_run_at || null,
    legacyJobWatermark: legacyJob?.last_run_at || null,
    legacySyncStateRssWatermark: legacyRss?.last_run_at || null,
  };
}

function failureCode(error) {
  const raw =
    error && typeof error === "object" && "reason" in error
      ? String(error.reason)
      : error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error?.name === "AbortError"
          ? "timeout"
          : "unexpected_error";
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 60) || "unknown"
  );
}

async function fetchFeeds({ subscriptions, http, timeoutMs, concurrency, cutoff }) {
  const started = performance.now();
  const results = new Array(subscriptions.length);
  let next = 0;
  let completed = 0;

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= subscriptions.length) return;
      const subscription = subscriptions[index];
      const requestStarted = performance.now();
      let result;
      try {
        const response = await http.fetchWithTimeout(
          http.channelFeedUrl(subscription.channelId),
          { headers: { accept: "application/atom+xml,application/xml" } },
          timeoutMs,
        );
        if (response.status === 304) {
          result = {
            channelId: subscription.channelId,
            kind: "not_modified",
            httpStatus: 304,
            entries: [],
            bytes: 0,
          };
        } else if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          result = {
            channelId: subscription.channelId,
            kind: "error",
            httpStatus: response.status,
            failureCode: `http_${response.status}`,
            entries: [],
            bytes: 0,
          };
        } else {
          const xml = await http.readLimitedText(response, http.maxFeedBytes);
          const parsed = http.parseAtomFeed(xml);
          if (parsed.skipped) {
            result = {
              channelId: subscription.channelId,
              kind: "incomplete",
              httpStatus: 200,
              failureCode: "incomplete_feed",
              skipped: parsed.skipped,
              entries: [],
              bytes: xml.length,
            };
          } else {
            result = {
              channelId: subscription.channelId,
              kind: "ok",
              httpStatus: 200,
              title: http.sanitizeText(parsed.title || subscription.title, 300),
              entries: parsed.entries,
              etag: response.headers.get("etag")?.slice(0, 500) || null,
              modified: response.headers.get("last-modified")?.slice(0, 500) || null,
              bytes: xml.length,
            };
          }
        }
      } catch (error) {
        result = {
          channelId: subscription.channelId,
          kind: "error",
          httpStatus: null,
          failureCode: failureCode(error),
          entries: [],
          bytes: 0,
        };
      }
      result.elapsedMs = Math.round(performance.now() - requestStarted);
      results[index] = result;
      completed++;
      if (completed % 20 === 0 || completed === subscriptions.length) {
        const ok = results.filter((item) => item?.kind === "ok").length;
        const failed = results.filter((item) => item?.kind === "error" || item?.kind === "incomplete").length;
        log(`feeds ${completed}/${subscriptions.length} (ok=${ok}, failed=${failed})`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, subscriptions.length) }, () => worker()),
  );

  const wallMs = Math.round(performance.now() - started);
  const failures = {};
  let ok = 0;
  let notModified = 0;
  let failed = 0;
  let skipped = 0;
  let bytes = 0;
  let recentEntries = 0;
  let oldEntries = 0;
  let futureEntries = 0;
  let parsedEntries = 0;
  const durations = [];
  const recentPerChannel = new Map();

  for (const result of results) {
    durations.push(result.elapsedMs);
    bytes += result.bytes;
    skipped += result.skipped || 0;
    if (result.kind === "ok") {
      ok++;
      let recent = 0;
      for (const entry of result.entries) {
        parsedEntries++;
        if (entry.publishedAt >= cutoff) {
          recentEntries++;
          recent++;
          if (entry.publishedAt > new Date().toISOString()) futureEntries++;
        } else {
          oldEntries++;
        }
      }
      recentPerChannel.set(result.channelId, recent);
    } else if (result.kind === "not_modified") {
      notModified++;
    } else {
      failed++;
      const code = result.failureCode || "unknown";
      failures[code] = (failures[code] || 0) + 1;
    }
  }

  durations.sort((a, b) => a - b);
  return {
    results,
    stats: {
      requests: subscriptions.length,
      ok,
      notModified,
      failed,
      failureCategories: failures,
      parsedEntries,
      recentEntries,
      oldEntries,
      futureEntries,
      skippedEntries: skipped,
      channelsWithRecentEntries: [...recentPerChannel.values()].filter((n) => n > 0).length,
      recentEntriesPerChannel: {
        zero: [...recentPerChannel.values()].filter((n) => n === 0).length,
        oneToFive: [...recentPerChannel.values()].filter((n) => n >= 1 && n <= 5).length,
        sixToFifteen: [...recentPerChannel.values()].filter((n) => n >= 6).length,
      },
      bytes,
      wallMs,
      sumRequestMs: durations.reduce((sum, value) => sum + value, 0),
      maxRequestMs: durations.length ? durations[durations.length - 1] : 0,
      medianRequestMs: durations.length ? durations[Math.floor(durations.length / 2)] : 0,
    },
  };
}

function queryVideoRows(copyDb, ids) {
  const rows = new Map();
  for (const chunk of chunks(ids, 400)) {
    const result = copyDb
      .prepare(
        `SELECT id,channel_id,expires_at,purged_at,details_fetched_at,source,published_at
         FROM videos WHERE id IN (${placeholders(chunk.length)})`,
      )
      .all(...chunk);
    for (const row of result) {
      rows.set(String(row.id), {
        channelId: String(row.channel_id || ""),
        expiresAt: row.expires_at == null ? null : String(row.expires_at),
        purgedAt: row.purged_at == null ? null : String(row.purged_at),
        detailsFetchedAt:
          row.details_fetched_at == null ? null : String(row.details_fetched_at),
        source: String(row.source || ""),
        publishedAt: String(row.published_at || ""),
      });
    }
  }
  return rows;
}

function queryIdSet(copyDb, table, column, ids) {
  const out = new Set();
  for (const chunk of chunks(ids, 400)) {
    const rows = copyDb
      .prepare(
        `SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${column} IN (${placeholders(chunk.length)})`,
      )
      .all(...chunk);
    for (const row of rows) out.add(String(row.id));
  }
  return out;
}

function queueWouldImport(entry, subscription, row, since, knownChannels, dueThreshold) {
  const bootstrap = !since || !knownChannels.has(subscription.channelId);
  if (bootstrap) return true;
  const maintenance =
    entry.publishedAt < since &&
    (!row || (row.expiresAt !== null && row.expiresAt <= dueThreshold));
  return entry.publishedAt >= since || maintenance;
}

function candidateAnalysis({ feeds, subscriptions, copyDb, accountId, since, knownChannels, now, cutoff, http }) {
  const entries = [];
  for (const feed of feeds) {
    if (feed.kind !== "ok") continue;
    const subscription = subscriptions.find((item) => item.channelId === feed.channelId);
    for (const entry of feed.entries) {
      entries.push({ entry, subscription });
    }
  }
  const uniqueIds = [...new Set(entries.map(({ entry }) => entry.videoId))];
  const videoRows = queryVideoRows(copyDb, uniqueIds);
  const watch = queryIdSet(copyDb, "watch_states", "video_id", uniqueIds);
  const playlist = queryIdSet(copyDb, "playlist_items", "video_id", uniqueIds);
  const privateMetadata = queryIdSet(copyDb, "account_video_metadata", "video_id", uniqueIds);
  const discoveries = queryIdSet(copyDb, "video_discoveries", "video_id", uniqueIds);
  const referenced = new Set([...watch, ...playlist, ...privateMetadata, ...discoveries]);
  const dueThreshold = http.isoInDays(1, new Date(now));

  const recentUnique = new Set();
  const oldUnique = new Set();
  const stats = {
    entries: entries.length,
    uniqueVideoIds: uniqueIds.length,
    recentEntries: 0,
    oldEntries: 0,
    recentUniqueVideoIds: 0,
    oldUniqueVideoIds: 0,
    recentKnownEntries: 0,
    recentNewEntries: 0,
    recentDueEntries: 0,
    recentReferencedEntries: 0,
    oldKnownEntries: 0,
    oldMissingEntries: 0,
    oldDueEntries: 0,
    oldMaintenanceEligibleEntries: 0,
    oldKnownNotDueEntries: 0,
    currentQueueEligibleEntries: 0,
    currentQueueEligibleRecentEntries: 0,
    currentQueueEligibleOldEntries: 0,
    currentQueueBootstrapAll: !since,
    currentQueueBootstrapChannels: since
      ? subscriptions.filter((item) => !knownChannels.has(item.channelId)).length
      : subscriptions.length,
    legacySyncRssEligibleEntries: entries.length,
    uniqueRecentReferenced: 0,
    uniqueRecentUnreferenced: 0,
    references: {
      watchStates: 0,
      playlistItems: 0,
      privateMetadata: 0,
      discoveries: 0,
    },
  };
  const relevant = entries;

  for (const { entry, subscription } of relevant) {
    const recent = entry.publishedAt >= cutoff;
    const row = videoRows.get(entry.videoId);
    if (recent) {
      stats.recentEntries++;
      recentUnique.add(entry.videoId);
      if (row) stats.recentKnownEntries++;
      else stats.recentNewEntries++;
      if (row?.expiresAt && row.expiresAt <= dueThreshold) stats.recentDueEntries++;
      if (watch.has(entry.videoId) || playlist.has(entry.videoId) || privateMetadata.has(entry.videoId) || discoveries.has(entry.videoId))
        stats.recentReferencedEntries++;
    } else {
      stats.oldEntries++;
      oldUnique.add(entry.videoId);
      if (row) stats.oldKnownEntries++;
      else stats.oldMissingEntries++;
      if (row?.expiresAt && row.expiresAt <= dueThreshold) stats.oldDueEntries++;
      if (!row || (row.expiresAt !== null && row.expiresAt <= dueThreshold))
        stats.oldMaintenanceEligibleEntries++;
      if (row && (row.expiresAt === null || row.expiresAt > dueThreshold))
        stats.oldKnownNotDueEntries++;
    }
    if (queueWouldImport(entry, subscription, row, since, knownChannels, dueThreshold)) {
      stats.currentQueueEligibleEntries++;
      if (recent) stats.currentQueueEligibleRecentEntries++;
      else stats.currentQueueEligibleOldEntries++;
    }
  }

  stats.recentUniqueVideoIds = recentUnique.size;
  stats.oldUniqueVideoIds = oldUnique.size;
  for (const id of recentUnique) {
    if (referenced.has(id)) stats.uniqueRecentReferenced++;
    else stats.uniqueRecentUnreferenced++;
  }
  stats.references.watchStates = [...recentUnique].filter((id) => watch.has(id)).length;
  stats.references.playlistItems = [...recentUnique].filter((id) => playlist.has(id)).length;
  stats.references.privateMetadata = [...recentUnique].filter((id) => privateMetadata.has(id)).length;
  stats.references.discoveries = [...recentUnique].filter((id) => discoveries.has(id)).length;

  return {
    stats,
    uniqueIds,
    recentUnique,
    oldUnique,
    videoRows,
    referenced,
    dueThreshold,
    entries,
  };
}

function createKv() {
  const store = new Map();
  return {
    store,
    writes: 0,
    gets: 0,
    async get(key) {
      this.gets++;
      return store.get(key) ?? null;
    },
    async put(key, value) {
      this.writes++;
      store.set(key, value);
    },
  };
}

async function replayRecent({
  db,
  subscriptions,
  feedsByChannel,
  accountId,
  now,
  cutoff,
  http,
  kv,
  conditional304 = false,
}) {
  const started = performance.now();
  const summary = {
    channelsSelected: 0,
    feedsOk: 0,
    feedsNotModified: 0,
    feedsFailed: 0,
    channelsWithRecent: 0,
    chunks: 0,
    entriesProcessed: 0,
    newVideos: 0,
    uniqueVideoIds: 0,
    videoStatements: 0,
    kvReads: 0,
    kvWrites: 0,
    durationMs: 0,
  };
  const processedIds = new Set();
  let cursor = "";
  const env = { MODE: "real", READ_CACHE: kv };

  for (const subscription of subscriptions) {
    const row = await db
      .prepare(CHANNEL_SELECT_SQL)
      .bind(accountId, cursor)
      .first();
    if (!row) break;
    cursor = String(row.id);
    summary.channelsSelected++;
    const check = await http.readRssCheck(env, accountId, String(row.id), now);
    summary.kvReads++;
    if (conditional304 && check) {
      summary.feedsNotModified++;
      continue;
    }
    const feed = feedsByChannel.get(String(row.id));
    if (!feed || feed.kind === "error" || feed.kind === "incomplete") {
      summary.feedsFailed++;
      continue;
    }
    summary.feedsOk++;
    const entries = feed.entries.filter((entry) => entry.publishedAt >= cutoff);
    if (entries.length) {
      summary.channelsWithRecent++;
      const byId = new Map();
      for (const entry of entries) byId.set(entry.videoId, entry);
      const ids = [...byId.keys()];
      const existing = new Set();
      const known = await db
        .prepare(`SELECT id FROM videos WHERE id IN (${placeholders(ids.length)})`)
        .bind(...ids)
        .all();
      for (const knownRow of known.results || []) existing.add(String(knownRow.id));
      const fresh = [...byId.values()].filter((entry) => !existing.has(entry.videoId));
      for (const chunk of chunks(fresh, 15)) {
        const statements = chunk.map((entry) =>
          http.externalVideoStatement(
            db,
            {
              id: entry.videoId,
              channelId: entry.channelId || String(row.id),
              channelTitle: entry.channelTitle || feed.title,
              title: entry.title,
              description: entry.description,
              thumbnailUrl: entry.thumbnailUrl,
              publishedAt: entry.publishedAt,
              durationSeconds: entry.durationSeconds,
              viewCount: entry.viewCount,
              source: "rss",
            },
            http.isoInDays(25, new Date(now)),
            now,
            true,
          ),
        );
        await db.batch(statements);
        summary.chunks++;
        summary.entriesProcessed += chunk.length;
        summary.videoStatements += chunk.length;
        summary.newVideos += chunk.length;
        for (const entry of chunk) processedIds.add(entry.videoId);
      }
    }
    await http.writeRssCheck(env, accountId, String(row.id), {
      checkedAt: now,
      etag: feed.etag,
      lastModified: feed.modified,
    });
    summary.kvWrites++;
  }

  summary.uniqueVideoIds = processedIds.size;
  summary.durationMs = Math.round(performance.now() - started);
  return summary;
}

async function countPresentVideos(db, ids) {
  let present = 0;
  for (const chunk of chunks(ids, 400)) {
    const row = await db
      .prepare(`SELECT count(*) AS n FROM videos WHERE id IN (${placeholders(chunk.length)})`)
      .bind(...chunk)
      .first();
    present += Number(row?.n || 0);
  }
  return present;
}

async function selectPresentVideoIds(db, ids) {
  const present = new Set();
  for (const chunk of chunks(ids, 400)) {
    const result = await db
      .prepare(`SELECT id FROM videos WHERE id IN (${placeholders(chunk.length)})`)
      .bind(...chunk)
      .all();
    for (const row of result.results || []) present.add(String(row.id));
  }
  return present;
}

async function deleteUnreferencedRecent({ db, ids }) {
  const started = performance.now();
  let deleted = 0;
  for (const chunk of chunks(ids, 50)) {
    const result = await db
      .prepare(
        `DELETE FROM videos WHERE id IN (${placeholders(chunk.length)})
         AND NOT EXISTS (SELECT 1 FROM watch_states w WHERE w.video_id=videos.id)
         AND NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.video_id=videos.id)
         AND NOT EXISTS (SELECT 1 FROM account_video_metadata m WHERE m.video_id=videos.id)
         AND NOT EXISTS (SELECT 1 FROM video_discoveries d WHERE d.video_id=videos.id)`,
      )
      .bind(...chunk)
      .run();
    deleted += Number(result.meta?.changes || 0);
  }
  return { deleted, durationMs: Math.round(performance.now() - started) };
}

function sanitizeReport(report) {
  // The report is built from counters only. This guard makes accidental
  // identifier-shaped strings visible during development without printing them.
  const text = JSON.stringify(report);
  if (/UC[A-Za-z0-9_-]{20,}/.test(text)) throw new Error("Report contains a channel-like id");
  return report;
}

function writeReport(reportDir, report) {
  if (!reportDir) return null;
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  chmodSync(reportDir, 0o700);
  const path = join(reportDir, "recent-sync-experiment.json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return path;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDb = args.db || process.env.SOURCE_DB;
  if (!sourceDb) {
    throw new Error("Pass --db <path-to-local-d1.sqlite> (or SOURCE_DB)");
  }
  if (!existsSync(sourceDb)) throw new Error("Source database not found");
  const concurrency = Math.max(1, Math.min(3, Number(args.concurrency || 3)));
  const timeoutMs = Math.max(1000, Number(args.timeoutMs || 12000));
  const reportDir = args["report-dir"] || null;
  const keepTemp = args["keep-temp"] === "true";
  const snapshotPath = args.snapshot || null;
  let replaySnapshot = null;
  if (snapshotPath) {
    if (!existsSync(snapshotPath)) throw new Error("Snapshot not found");
    replaySnapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    if (
      !replaySnapshot ||
      typeof replaySnapshot.now !== "string" ||
      typeof replaySnapshot.cutoff !== "string" ||
      !replaySnapshot.feeds ||
      !Array.isArray(replaySnapshot.feeds.results)
    )
      throw new Error("Snapshot must contain now, cutoff and feeds.results");
    const snapshotNow = Date.parse(replaySnapshot.now);
    if (
      !Number.isFinite(snapshotNow) ||
      replaySnapshot.cutoff !==
        new Date(snapshotNow - 24 * 3600 * 1000).toISOString()
    )
      throw new Error("Snapshot cutoff does not match its frozen 24h window");
  }
  const startedAt = replaySnapshot ? new Date(replaySnapshot.now) : new Date();
  const now = replaySnapshot ? replaySnapshot.now : startedAt.toISOString();
  const cutoff = replaySnapshot
    ? replaySnapshot.cutoff
    : new Date(startedAt.getTime() - 24 * 3600 * 1000).toISOString();
  const tempRoot = await mkdtemp(join(tmpdir(), "alveo-recent-sync-"));
  chmodSync(tempRoot, 0o700);
  const backupPath = join(tempRoot, "source-copy.sqlite");
  let sourceGuard = null;
  let copyDb = null;
  let report = null;
  let scenarioA = null;
  let scenarioB = null;

  try {
    sourceGuard = openReadOnly(sourceDb);
    const before = fingerprint(sourceGuard, sourceDb);
    await backup(sourceGuard, backupPath);
    chmodSync(backupPath, 0o600);
    const afterCopy = fingerprint(sourceGuard, sourceDb);
    if (!sameFingerprint(before, afterCopy)) {
      throw new Error("Source changed while making the backup");
    }
    copyDb = openReadOnly(backupPath);
    const copyFingerprint = fingerprint(copyDb, backupPath);
    if (copyFingerprint.counts.videos !== before.counts.videos) {
      throw new Error("Backup video count does not match source");
    }
    const copyForeignKeys = copyDb.prepare("PRAGMA foreign_key_check").all();
    if (copyForeignKeys.length) throw new Error("Copy has foreign key violations");

    const { accountId, accountCount, subscriptions } = accountAndSubscriptions(copyDb);
    const activeJobs = Number(
      copyDb
        .prepare(
          "SELECT count(*) AS n FROM sync_jobs WHERE status IN ('queued','running','retrying','paused')",
        )
        .get().n,
    );
    if (activeJobs) throw new Error("Copy has an active sync job; cannot model a fresh sync");
    const watermark = resolveCurrentQueueWatermark(copyDb, accountId);
    const knownChannels = new Set(
      subscriptions
        .filter((item) => item.subscriptionLastSyncedAt !== null)
        .map((item) => item.channelId),
    );
    log(
      `copy ready: ${subscriptions.length} active subscriptions, ${before.counts.videos} videos, ${accountCount} connected real account(s)`,
    );

    const production = await loadProductionModules(tempRoot);
    let feeds;
    if (replaySnapshot) {
      const activeChannels = new Set(subscriptions.map((item) => item.channelId));
      for (const result of replaySnapshot.feeds.results) {
        if (!activeChannels.has(String(result.channelId)))
          throw new Error("Snapshot contains a channel outside the active subscriptions");
      }
      feeds = replaySnapshot.feeds;
      log(
        `snapshot loaded: ok=${feeds.stats.ok}, failed=${feeds.stats.failed}, recent=${feeds.stats.recentEntries}, old=${feeds.stats.oldEntries}`,
      );
    } else {
      feeds = await fetchFeeds({
        subscriptions,
        http: production,
        timeoutMs,
        concurrency,
        cutoff,
      });
      log(`feeds complete: ok=${feeds.stats.ok}, failed=${feeds.stats.failed}, recent=${feeds.stats.recentEntries}, old=${feeds.stats.oldEntries}`);
      // Private replay snapshot avoids repeat network requests if measurement fails.
      if (reportDir) {
        mkdirSync(reportDir, { recursive: true, mode: 0o700 });
        const snapshot = join(reportDir, "feeds-private.json");
        writeFileSync(snapshot, JSON.stringify({ now, cutoff, feeds }), { mode: 0o600 });
        chmodSync(snapshot, 0o600);
      }
    }

    const candidates = candidateAnalysis({
      feeds: feeds.results,
      subscriptions,
      copyDb,
      accountId,
      since: watermark.since,
      knownChannels,
      now,
      cutoff,
      http: production,
    });
    const recentIds = [...candidates.recentUnique];
    const missingRecentIds = recentIds.filter((id) => !candidates.videoRows.has(id));
    const existingRecentIds = recentIds.filter((id) => candidates.videoRows.has(id));
    const referencedRecentIds = existingRecentIds.filter((id) => candidates.referenced.has(id));
    const unreferencedRecentIds = existingRecentIds.filter((id) => !candidates.referenced.has(id));
    const feedsByChannel = new Map(feeds.results.map((feed) => [feed.channelId, feed]));

    // Scenario A: actual copy, recent-only import; then an immediate rerun.
    const a = await seedMiniflareD1({
      backupPath,
      root: tempRoot,
      label: "scenario-a",
      expectedVideos: before.counts.videos,
    });
    try {
      const kv = createKv();
      const meter1 = createMeter(a.db);
      const run1 = await replayRecent({
        db: meter1.db,
        subscriptions,
        feedsByChannel,
        accountId,
        now,
        cutoff,
        http: production,
        kv,
      });
      const stats1 = meter1.stats();
      const kvWrites1 = kv.writes;
      const presentAfter1 = await countPresentVideos(a.db, recentIds);
      const meter2 = createMeter(a.db);
      const run2 = await replayRecent({
        db: meter2.db,
        subscriptions,
        feedsByChannel,
        accountId,
        now,
        cutoff,
        http: production,
        kv,
      });
      const stats2 = meter2.stats();
      const presentAfter2 = await countPresentVideos(a.db, recentIds);
      const meter3 = createMeter(a.db);
      const run3 = await replayRecent({
        db: meter3.db,
        subscriptions,
        feedsByChannel,
        accountId,
        now,
        cutoff,
        http: production,
        kv,
        conditional304: true,
      });
      const stats3 = meter3.stats();
      const presentAfter3 = await countPresentVideos(a.db, recentIds);
      const fkAfter = await a.db.prepare("PRAGMA foreign_key_check").all();
      scenarioA = {
        seed: {
          videos: before.counts.videos,
          foreignKeyViolations: a.foreignKeyViolations,
          fkEnabled: a.fkEnabled,
        },
        input: {
          recentUniqueVideoIds: recentIds.length,
          recentKnownBefore: existingRecentIds.length,
          recentNewBefore: missingRecentIds.length,
          referencedRecentPreserved: referencedRecentIds.length,
        },
        run1_newRecentImport: {
          ...run1,
          stats: stats1,
          kvWrites: kvWrites1,
          presentAfter: presentAfter1,
        },
        run2_noChange200: {
          ...run2,
          stats: stats2,
          presentAfter: presentAfter2,
        },
        run3_conditional304: {
          ...run3,
          stats: stats3,
          presentAfter: presentAfter3,
        },
        foreignKeyViolationsAfter: (fkAfter.results || []).length,
      };
      log(`scenario A done: run1 ${stats1.rowsRead}/${stats1.rowsWritten}, rerun200 ${stats2.rowsRead}/${stats2.rowsWritten}, rerun304 ${stats3.rowsRead}/${stats3.rowsWritten} (read/write)`);
    } finally {
      await a.close();
    }

    // Scenario B: delete recent rows that have no user/provenance references,
    // then replay the same recent set to measure genuinely new inserts.
    const b = await seedMiniflareD1({
      backupPath,
      root: tempRoot,
      label: "scenario-b",
      expectedVideos: before.counts.videos,
    });
    try {
      const prepMeter = createMeter(b.db);
      const prep = await deleteUnreferencedRecent({
        db: prepMeter.db,
        ids: unreferencedRecentIds,
      });
      const prepStats = prepMeter.stats();
      const fkAfterPrep = await b.db.prepare("PRAGMA foreign_key_check").all();
      const presentAfterPrep = await selectPresentVideoIds(b.db, recentIds);
      const newAfterPrep = recentIds.filter((id) => !presentAfterPrep.has(id));
      const preservedAfterPrep = recentIds.filter((id) => presentAfterPrep.has(id));
      const importMeter = createMeter(b.db);
      const kv = createKv();
      const runB = await replayRecent({
        db: importMeter.db,
        subscriptions,
        feedsByChannel,
        accountId,
        now,
        cutoff,
        http: production,
        kv,
      });
      const statsB = importMeter.stats();
      const presentAfterB = await countPresentVideos(b.db, recentIds);
      const fkAfter = await b.db.prepare("PRAGMA foreign_key_check").all();
      scenarioB = {
        preparationExcluded: {
          note: "Delete-in-copy preparation is not part of sync cost.",
          deletedRows: prep.deleted,
          preservedReferencedRecentRows: referencedRecentIds.length,
          durationMs: prep.durationMs,
          stats: prepStats,
          foreignKeyViolationsAfter: (fkAfterPrep.results || []).length,
        },
        input: {
          recentUniqueVideoIds: recentIds.length,
          newAfterPreparation: newAfterPrep.length,
          preservedAfterPreparation: preservedAfterPrep.length,
        },
        run_newRecentImport: {
          ...runB,
          stats: statsB,
          presentAfter: presentAfterB,
        },
        foreignKeyViolationsAfter: (fkAfter.results || []).length,
      };
      log(`scenario B done: new=${newAfterPrep.length}, prep ${prepStats.rowsRead}/${prepStats.rowsWritten}, import ${statsB.rowsRead}/${statsB.rowsWritten} (read/write)`);
    } finally {
      await b.close();
    }

    const after = fingerprint(sourceGuard, sourceDb);
    const originalUnchanged = sameFingerprint(before, after);
    const totalFailures = Object.values(feeds.stats.failureCategories).reduce(
      (sum, value) => sum + Number(value),
      0,
    );
    const coverageComplete = feeds.stats.ok + feeds.stats.notModified === subscriptions.length;
    const status =
      originalUnchanged &&
      coverageComplete &&
      totalFailures === 0 &&
      scenarioA?.run1_newRecentImport.presentAfter === recentIds.length &&
      scenarioA?.run2_noChange200.presentAfter === recentIds.length &&
      scenarioA?.run3_conditional304.presentAfter === recentIds.length &&
      scenarioB?.run_newRecentImport.presentAfter === recentIds.length
        ? "complete"
        : "partial";

    report = sanitizeReport({
      schemaVersion: 1,
      status,
      generatedAt: new Date().toISOString(),
      frozenNow: now,
      cutoff,
      source: {
        basename: basename(sourceDb),
        bytes: before.mainBytes,
        walBytes: before.walBytes,
        mainSha256: before.mainSha256,
        walSha256: before.walSha256,
        integrity: before.integrity,
        counts: before.counts,
      },
      copy: {
        bytes: copyFingerprint.mainBytes,
        sha256: copyFingerprint.mainSha256,
        integrity: copyFingerprint.integrity,
        foreignKeyViolations: copyForeignKeys.length,
        counts: copyFingerprint.counts,
      },
      scope: {
        included: [
          "read-only source fingerprint and SQLite backup",
          replaySnapshot
            ? "frozen RSS transcript replayed from a private snapshot (no network requests)"
            : `${subscriptions.length} active subscription RSS GETs from the public YouTube Atom feeds`,
          "recent-only replay through production insert-only video SQL in isolated Miniflare D1",
          "per-account+channel validators through the production READ_CACHE module using an in-memory namespace",
          "D1 rows_read/rows_written from result.meta per statement/batch",
        ],
        excluded: [
          "subscriptions/YouTube Data API and OAuth",
          "playlists and playlist items",
          "metadata API and metadata renewal",
          "queue job/lease/dispatch/state coordination and message fan-out",
          "HTTP retries and backoff (one attempt per feed)",
          "KV network latency, eventual consistency and quota behavior",
          "copy creation, candidate read queries, seeding and verification queries",
          "delete-in-copy preparation (measured separately in scenario B)",
        ],
        deviations: [
          "one pass over feeds; failed feeds are recorded and skipped instead of retried",
          "frozen experiment timestamps for writes",
          "the 304 rerun is simulated from a matching KV record; the transcript responses were originally 200",
          "the experiment replays the visible feed page only; it does not exercise queue retries or metadata",
        ],
        feedVisibility: "latest YouTube Atom page per channel (up to 15 entries); deeper archive is not observable",
      },
      account: {
        connectedRealAccounts: accountCount,
        activeSubscriptions: subscriptions.length,
        activeSyncJobs: activeJobs,
        knownChannels: knownChannels.size,
      },
      currentCode: {
        policy: {
          recentWindowHours: 24,
          frozenAtJobStart: true,
          importsOldEntries: false,
          importsNewIdsOnly: true,
          kvValidatorsPerAccountChannel: true,
          d1PerChannelSuccessWrites: false,
        },
        resolvedQueueWatermark: watermark.since,
        queueWatermark: watermark.queueWatermark,
        legacyJobWatermark: watermark.legacyJobWatermark,
        legacySyncStateRssWatermark: watermark.legacySyncStateRssWatermark,
        eligibleEntries: candidates.stats.recentEntries,
        eligibleRecentEntries: candidates.stats.recentEntries,
        eligibleOldEntries: 0,
        ignoredOldEntries: candidates.stats.oldEntries,
        ignoredOldMissingEntries: candidates.stats.oldMissingEntries,
        legacySyncRssEligibleEntries: candidates.stats.recentEntries,
      },
      feeds: feeds.stats,
      candidates: candidates.stats,
      scenarios: {
        a_actualNowMixed: scenarioA,
        b_newRecentImport: scenarioB,
      },
      comparison: {
        recentOnlyPolicy: {
          experimentRecentEntries: candidates.stats.recentEntries,
          experimentOldEntriesIgnored: candidates.stats.oldEntries,
          oldMissingEntriesIgnored: candidates.stats.oldMissingEntries,
          oldDueEntriesIgnored: candidates.stats.oldDueEntries,
          note: "Old counts are candidate counts from the visible feed page; no old import was executed.",
        },
        noChangeVsNewImport: {
          noChangeRowsRead: scenarioA?.run2_noChange200.stats.rowsRead ?? null,
          noChangeRowsWritten: scenarioA?.run2_noChange200.stats.rowsWritten ?? null,
          conditional304RowsRead: scenarioA?.run3_conditional304.stats.rowsRead ?? null,
          conditional304RowsWritten:
            scenarioA?.run3_conditional304.stats.rowsWritten ?? null,
          newImportRowsRead: scenarioB?.run_newRecentImport.stats.rowsRead ?? null,
          newImportRowsWritten: scenarioB?.run_newRecentImport.stats.rowsWritten ?? null,
        },
      },
      original: {
        unchanged: originalUnchanged,
        before,
        after,
      },
    });
  } finally {
    if (copyDb) copyDb.close();
    if (sourceGuard) sourceGuard.close();
    if (!keepTemp) rmSync(tempRoot, { recursive: true, force: true });
  }

  const reportPath = writeReport(reportDir, report);
  const output = {
    status: report.status,
    frozenNow: report.frozenNow,
    cutoff: report.cutoff,
    feeds: report.feeds,
    candidates: {
      recentEntries: report.candidates.recentEntries,
      oldEntries: report.candidates.oldEntries,
      recentNewEntries: report.candidates.recentNewEntries,
      recentKnownEntries: report.candidates.recentKnownEntries,
      oldMissingEntries: report.candidates.oldMissingEntries,
      oldDueEntries: report.candidates.oldDueEntries,
      currentCodeEligibleOldEntries: report.currentCode.eligibleOldEntries,
      ignoredOldEntries: report.currentCode.ignoredOldEntries,
    },
    scenarios: {
      a_actualNowMixed: report.scenarios.a_actualNowMixed
        ? {
            run1: report.scenarios.a_actualNowMixed.run1_newRecentImport.stats,
            run2_noChange200:
              report.scenarios.a_actualNowMixed.run2_noChange200.stats,
            run3_conditional304:
              report.scenarios.a_actualNowMixed.run3_conditional304.stats,
          }
        : null,
      b_newRecentImport: report.scenarios.b_newRecentImport
        ? {
            prepExcluded: report.scenarios.b_newRecentImport.preparationExcluded.stats,
            run: report.scenarios.b_newRecentImport.run_newRecentImport.stats,
          }
        : null,
    },
    originalUnchanged: report.original.unchanged,
    reportPath,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  if (report.status !== "complete") process.exitCode = 2;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(
    "[recent-sync] failed: " +
      message.replace(/UC[A-Za-z0-9_-]{20,}/g, "[redacted]") +
      "\n",
  );
  process.exitCode = 1;
});
