#!/usr/bin/env python3
"""Dependency-free D1/SQLite check for migrations, seed and core queries.

Run with: python3 tests/backend-sql-check.py

This does not execute the Worker, but it applies the exact migration and seed
files to SQLite (the engine behind local D1) and verifies keyset paging, watch
state writes, retention purging and constraint behaviour.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "migrations" / "0001_init.sql"
SEED = ROOT / "fixtures" / "seed.sql"

FEED_SELECT = """
SELECT v.id
FROM videos v
LEFT JOIN watch_states ws ON ws.video_id = v.id AND ws.account_id = ?
"""


def check(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def feed(
    db: sqlite3.Connection,
    *,
    limit: int = 3,
    status: str = "all",
    channel_id: str | None = None,
    cursor: tuple[str, str] | None = None,
) -> list[str]:
    conditions = ["v.purged_at IS NULL"]
    params: list[object] = ["demo"]
    if channel_id:
        conditions.append("v.channel_id = ?")
        params.append(channel_id)
    if status == "watched":
        conditions.append("COALESCE(ws.watched, 0) = 1")
    elif status == "pending":
        conditions.append("COALESCE(ws.watched, 0) = 0")
    if cursor:
        conditions.append("(v.published_at < ? OR (v.published_at = ? AND v.id < ?))")
        params.extend([cursor[0], cursor[0], cursor[1]])
    params.append(limit)
    rows = db.execute(
        FEED_SELECT
        + " WHERE "
        + " AND ".join(conditions)
        + " ORDER BY v.published_at DESC, v.id DESC LIMIT ?",
        params,
    ).fetchall()
    return [row[0] for row in rows]


def main() -> int:
    check(MIGRATION.exists(), f"missing migration: {MIGRATION}")
    check(SEED.exists(), f"missing seed: {SEED}")

    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    migration_sql = MIGRATION.read_text()
    seed_sql = SEED.read_text()

    # Migrations and seed must both be repeatable.
    db.executescript(migration_sql)
    db.executescript(migration_sql)
    for migration in sorted((ROOT / 'migrations').glob('*.sql')):
        if migration != MIGRATION:
            db.executescript(migration.read_text())
    db.executescript(seed_sql)
    db.executescript(seed_sql)

    expected_tables = {
        "accounts",
        "sessions",
        "oauth_attempts",
        "oauth_tokens",
        "channels",
        "subscriptions",
        "videos",
        "watch_states",
        "playlists",
        "playlist_items",
        "preferences",
        "sync_state",
        "sync_runs",
    }
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    check(expected_tables <= tables, f"missing tables: {expected_tables - tables}")
    check(db.execute("PRAGMA foreign_key_check").fetchall() == [], "foreign key violations after seed")

    playlist_item_columns = {row[1] for row in db.execute("PRAGMA table_info(playlist_items)")}
    check("sync_generation" in playlist_item_columns, "playlist_items.sync_generation missing")

    counts = {
        "accounts": 1,
        "channels": 4,
        "videos": 6,
        "subscriptions": 3,
        "playlists": 2,
        "playlist_items": 5,
        "preferences": 1,
        "watch_states": 2,
    }
    for table, expected in counts.items():
        actual = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        check(actual == expected, f"{table}: expected {expected}, got {actual}")

    account = db.execute("SELECT id, mode, name, connected FROM accounts").fetchone()
    check(account == ("demo", "demo", "Demo local", 0), f"unexpected demo account: {account}")

    video_ids = [row[0] for row in db.execute("SELECT id FROM videos ORDER BY id")]
    check(len(video_ids) == len(set(video_ids)), "seed duplicated videos")
    check(
        {"M7lc1UVf-VE", "aqz-KE-bpKQ", "jNQXAC9IVRw"} <= set(video_ids),
        "playable demo video ids missing",
    )
    thumbs = {row[0] for row in db.execute("SELECT thumbnail_url FROM videos")}
    check({f"/thumbs/{index:02d}.svg" for index in range(1, 7)} <= thumbs, "local thumbnails missing")

    expected_order = [
        "M7lc1UVf-VE",
        "demoVid0001",
        "jNQXAC9IVRw",
        "demoVid0002",
        "aqz-KE-bpKQ",
        "demoVid0003",
    ]
    check(feed(db, limit=100) == expected_order, "feed order is not published_at DESC, id DESC")

    page1 = feed(db, limit=3)
    check(page1 == expected_order[:3], f"page 1 mismatch: {page1}")
    cursor = db.execute(
        "SELECT published_at FROM videos WHERE id = ?", (page1[-1],)
    ).fetchone()
    page2 = feed(db, limit=3, cursor=(cursor[0], page1[-1]))
    check(page2 == expected_order[3:], f"page 2 mismatch: {page2}")
    page3 = feed(db, limit=3, cursor=("2000-01-01T00:00:00.000Z", page2[-1] if page2 else ""))
    check(page3 == [], f"expected empty final page, got {page3}")

    check(feed(db, limit=100, status="watched") == ["jNQXAC9IVRw"], "watched filter mismatch")
    check(len(feed(db, limit=100, status="pending")) == 5, "pending filter mismatch")
    channel2 = feed(db, limit=100, channel_id="UCdemoChannel0000000002")
    check(sorted(channel2) == ["demoVid0002", "jNQXAC9IVRw"], f"channel filter mismatch: {channel2}")

    # Re-seeding must not overwrite personal state or duplicate fixtures.
    db.execute(
        "UPDATE watch_states SET position_seconds = 321 WHERE account_id='demo' AND video_id='demoVid0002'"
    )
    db.executescript(seed_sql)
    preserved = db.execute(
        "SELECT position_seconds FROM watch_states WHERE account_id='demo' AND video_id='demoVid0002'"
    ).fetchone()[0]
    check(preserved == 321, f"re-seed overwrote watch progress: {preserved}")
    for table, expected in counts.items():
        actual = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        check(actual == expected, f"re-seed duplicated {table}: {actual}")

    # Manual watch state upsert increments revision and preserves position fields.
    db.execute("SAVEPOINT watch")
    db.execute(
        """
        INSERT INTO watch_states
          (account_id, video_id, watched, watched_at, position_seconds, duration_seconds, percent, manual, revision, updated_at)
        VALUES ('demo', 'demoVid0002', 1, '2026-10-20T00:00:00.000Z', 0, NULL, 0, 1, 1, '2026-10-20T00:00:00.000Z')
        ON CONFLICT(account_id, video_id) DO UPDATE SET
          watched = excluded.watched,
          watched_at = CASE WHEN excluded.watched = 1 THEN excluded.watched_at ELSE NULL END,
          manual = 1,
          revision = watch_states.revision + 1,
          updated_at = excluded.updated_at
        """
    )
    state = db.execute(
        "SELECT watched, manual, revision, position_seconds, percent FROM watch_states WHERE account_id='demo' AND video_id='demoVid0002'"
    ).fetchone()
    check(state == (1, 1, 2, 321, 20), f"manual state upsert mismatch: {state}")
    db.execute("ROLLBACK TO watch")
    db.execute("RELEASE watch")

    # Bulk marking uses an explicit published_at cutoff and preserves manual flags.
    db.execute("SAVEPOINT bulk")
    before_cursor = db.execute(
        "INSERT INTO watch_states (account_id, video_id, watched, watched_at, position_seconds, duration_seconds, percent, manual, revision, updated_at) "
        "SELECT 'demo', v.id, 1, '2026-10-20T00:00:00.000Z', 0, NULL, 0, 1, 1, '2026-10-20T00:00:00.000Z' "
        "FROM videos v WHERE v.purged_at IS NULL AND v.published_at < ? "
        "ON CONFLICT(account_id, video_id) DO UPDATE SET watched=excluded.watched, manual=1, revision=watch_states.revision+1",
        ("2026-10-06T00:00:00.000Z",),
    )
    check(before_cursor.rowcount == 3, f"bulk cutoff updated {before_cursor.rowcount}, expected 3")
    db.execute("ROLLBACK TO bulk")
    db.execute("RELEASE bulk")

    # Soft purge blanks metadata and keeps personal state; feed hides the row.
    db.execute("SAVEPOINT purge")
    db.execute("UPDATE videos SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 'demoVid0002'")
    purged = db.execute(
        """
        UPDATE videos SET title='', description='', channel_title='', thumbnail_url='',
          duration_seconds=NULL, view_count=NULL, purged_at='2026-10-20T00:00:00.000Z',
          updated_at='2026-10-20T00:00:00.000Z'
        WHERE expires_at IS NOT NULL AND expires_at <= '2026-10-20T00:00:00.000Z' AND purged_at IS NULL
        """
    ).rowcount
    check(purged == 1, f"expected one purged video, got {purged}")
    check("demoVid0002" not in feed(db, limit=100), "purged video still served by feed")
    check(
        db.execute(
            "SELECT COUNT(*) FROM watch_states WHERE account_id='demo' AND video_id='demoVid0002'"
        ).fetchone()[0]
        == 1,
        "soft purge deleted the user's watch state",
    )
    db.execute("ROLLBACK TO purge")
    db.execute("RELEASE purge")

    # Local playlist items may repeat a video; remote ids are unique per playlist.
    db.execute("SAVEPOINT playlists")
    db.execute(
        "INSERT INTO playlist_items (id, playlist_id, video_id, remote_item_id, position, added_at) "
        "VALUES ('dup-a', 'pl-demo-favoritos', 'M7lc1UVf-VE', NULL, 9, '2026-10-20T00:00:00.000Z')"
    )
    db.execute(
        "INSERT INTO playlist_items (id, playlist_id, video_id, remote_item_id, position, added_at) "
        "VALUES ('dup-b', 'pl-demo-favoritos', 'M7lc1UVf-VE', NULL, 10, '2026-10-20T00:00:00.000Z')"
    )
    db.execute(
        "INSERT INTO playlist_items (id, playlist_id, video_id, remote_item_id, position, added_at) "
        "VALUES ('remote-a', 'pl-demo-favoritos', 'M7lc1UVf-VE', 'remote-1', 11, '2026-10-20T00:00:00.000Z')"
    )
    duplicate_remote_rejected = False
    try:
        db.execute(
            "INSERT INTO playlist_items (id, playlist_id, video_id, remote_item_id, position, added_at) "
            "VALUES ('remote-b', 'pl-demo-favoritos', 'demoVid0001', 'remote-1', 12, '2026-10-20T00:00:00.000Z')"
        )
    except sqlite3.IntegrityError:
        duplicate_remote_rejected = True
    check(duplicate_remote_rejected, "unique remote playlist item was not enforced")
    db.execute(
        "INSERT INTO playlists (id, account_id, source, remote_id, title, created_at, updated_at) "
        "VALUES ('local-one', 'demo', 'local', NULL, 'Local one', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')"
    )
    db.execute(
        "INSERT INTO playlists (id, account_id, source, remote_id, title, created_at, updated_at) "
        "VALUES ('local-two', 'demo', 'local', NULL, 'Local two', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')"
    )
    db.execute("ROLLBACK TO playlists")
    db.execute("RELEASE playlists")

    # Preference constraints.
    invalid_theme = False
    try:
        db.execute("UPDATE preferences SET theme='neon' WHERE account_id='demo'")
    except sqlite3.IntegrityError:
        invalid_theme = True
    check(invalid_theme, "invalid theme was accepted")
    invalid_pure_black = False
    try:
        db.execute("UPDATE preferences SET pure_black=2 WHERE account_id='demo'")
    except sqlite3.IntegrityError:
        invalid_pure_black = True
    check(invalid_pure_black, "invalid pure-black preference was accepted")
    invalid_threshold = False
    try:
        db.execute("UPDATE preferences SET watch_threshold=0 WHERE account_id='demo'")
    except sqlite3.IntegrityError:
        invalid_threshold = True
    check(invalid_threshold, "invalid watch threshold was accepted")

    # Atomic lease semantics: a live owner blocks another owner; expiry allows takeover.
    db.execute(
        "INSERT INTO sync_state (account_id, type, lease_owner, lease_expires_at) "
        "VALUES ('demo', 'rss', 'owner-1', '2099-01-01T00:00:00.000Z')"
    )
    blocked = db.execute(
        """
        INSERT INTO sync_state (account_id, type, lease_owner, lease_expires_at)
        VALUES ('demo', 'rss', 'owner-2', '2099-01-01T00:00:00.000Z')
        ON CONFLICT(account_id, type) DO UPDATE SET
          lease_owner = excluded.lease_owner,
          lease_expires_at = excluded.lease_expires_at
        WHERE sync_state.lease_owner IS NULL OR sync_state.lease_expires_at < '2026-10-20T00:00:00.000Z'
        """
    )
    check(blocked.rowcount == 0, "live sync lease was stolen")
    db.execute("UPDATE sync_state SET lease_expires_at='2020-01-01T00:00:00.000Z' WHERE account_id='demo' AND type='rss'")
    takeover = db.execute(
        """
        INSERT INTO sync_state (account_id, type, lease_owner, lease_expires_at)
        VALUES ('demo', 'rss', 'owner-2', '2099-01-01T00:00:00.000Z')
        ON CONFLICT(account_id, type) DO UPDATE SET
          lease_owner = excluded.lease_owner,
          lease_expires_at = excluded.lease_expires_at
        WHERE sync_state.lease_owner IS NULL OR sync_state.lease_expires_at < '2026-10-20T00:00:00.000Z'
        """
    )
    check(takeover.rowcount == 1, "expired sync lease could not be taken over")

    # Demo "delete account data" clears personal state, keeps seeded fixtures.
    db.execute("SAVEPOINT delete_demo")
    db.execute(
        "DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id='demo' AND seeded=0)"
    )
    db.execute("DELETE FROM playlists WHERE account_id='demo' AND seeded=0")
    db.execute("DELETE FROM watch_states WHERE account_id='demo'")
    db.execute("DELETE FROM subscriptions WHERE account_id='demo'")
    db.execute("DELETE FROM sync_runs WHERE account_id='demo'")
    db.execute("DELETE FROM sync_state WHERE account_id='demo'")
    check(db.execute("SELECT COUNT(*) FROM watch_states").fetchone()[0] == 0, "demo watch states survived")
    check(db.execute("SELECT COUNT(*) FROM playlists").fetchone()[0] == 2, "seeded playlists were removed")
    check(db.execute("SELECT COUNT(*) FROM playlist_items").fetchone()[0] == 5, "seeded items were removed")
    check(db.execute("SELECT COUNT(*) FROM videos").fetchone()[0] == 6, "fixture videos were removed")
    db.execute("ROLLBACK TO delete_demo")
    db.execute("RELEASE delete_demo")

    # Account deletion cascades personal rows but leaves fixture channels/videos.
    db.execute("SAVEPOINT account_delete")
    db.execute("DELETE FROM accounts WHERE id='demo'")
    for table in ("watch_states", "subscriptions", "playlists", "playlist_items", "preferences", "sync_runs", "sync_state"):
        remaining = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        check(remaining == 0, f"{table} rows survived account cascade delete: {remaining}")
    check(db.execute("SELECT COUNT(*) FROM videos").fetchone()[0] == 6, "fixture videos should remain")
    db.execute("ROLLBACK TO account_delete")
    db.execute("RELEASE account_delete")

    check(db.execute("PRAGMA foreign_key_check").fetchall() == [], "foreign key violations at end")
    print("PASS: migrations, repeatable seed, feed paging, filters, watch state, retention, playlists, leases, cascades")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as error:
        print(f"FAIL: {error}")
        sys.exit(1)
