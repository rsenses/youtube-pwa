"""One-time, private, data-only bootstrap; excludes all authentication material.

Usage: python3 scripts/prepare-bootstrap.py SOURCE.sqlite PRIVATE_DIRECTORY
Import only into an EMPTY, already migrated D1. INSERT fails on existing IDs.
"""
import datetime
import json
import os
import pathlib
import sqlite3
import sys

source = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
os.chmod(out, 0o700)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
snapshot = out / f'local-backup-{stamp}.sqlite'
original = sqlite3.connect(f'file:{source}?mode=ro', uri=True)
backup = sqlite3.connect(snapshot)
original.backup(backup)
original.close()
os.chmod(snapshot, 0o600)
backup.row_factory = sqlite3.Row
account_ids = [r[0] for r in backup.execute("SELECT id FROM accounts WHERE mode='real' AND youtube_channel_id IS NOT NULL")]
if len(account_ids) != 1:
    raise SystemExit('Expected exactly one identified real account; refusing ambiguous export')
account = account_ids[0]
if not backup.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_video_metadata'").fetchone():
    raise SystemExit('Apply current local migrations before exporting: private metadata must be account-scoped')
tables = [
    ('accounts', 'id = ?', (account,)),
    ('channels', "source = 'youtube'", ()),
    ('videos', "source <> 'fixture'", ()),
    ('subscriptions', 'account_id = ?', (account,)),
    ('preferences', 'account_id = ?', (account,)),
    ('watch_states', 'account_id = ?', (account,)),
    ('playlists', 'account_id = ?', (account,)),
    ('playlist_items', 'playlist_id IN (SELECT id FROM playlists WHERE account_id = ?)', (account,)),
    ('video_discoveries', '1 = 1', ()),
    ('account_video_metadata', 'account_id = ?', (account,)),
]
counts = {}
export = out / 'alveo-bootstrap.sql'
with export.open('w', encoding='utf8') as f:
    os.chmod(export, 0o600)
    for table, where, params in tables:
        rows = backup.execute(f'SELECT * FROM {table} WHERE {where}', params).fetchall()
        counts[table] = len(rows)
        for row in rows:
            values = dict(row)
            if table == 'accounts':
                values.update(connected=0, scopes='', token_expires_at=None)
            columns = ','.join('"' + name + '"' for name in values)
            literals = ','.join(backup.execute('SELECT quote(?)', (v,)).fetchone()[0] for v in values.values())
            f.write(f'INSERT INTO "{table}" ({columns}) VALUES ({literals});\n')
backup.close()
(out / 'expected-counts.json').write_text(json.dumps(counts, indent=2) + '\n')
os.chmod(out / 'expected-counts.json', 0o600)
print(json.dumps({'export': str(export), 'backup': str(snapshot), 'counts': counts, 'bytes': export.stat().st_size}))
