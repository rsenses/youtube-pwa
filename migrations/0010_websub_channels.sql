-- Global public YouTube discovery. WebSub membership is independent of any
-- account row so a channel's cancellation state survives local channel cleanup.
-- Only real connected accounts create interest; demo rows never call the hub.
CREATE TABLE IF NOT EXISTS youtube_feed_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO youtube_feed_state (id, revision, updated_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS websub_channels (
  channel_id TEXT PRIMARY KEY,
  desired INTEGER NOT NULL DEFAULT 0 CHECK (desired IN (0, 1)),
  hub_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (hub_state IN ('idle', 'pending_subscribe', 'subscribed',
                         'pending_unsubscribe', 'unsubscribed')),
  hub_lease_expires_at TEXT,
  hub_pending_mode TEXT CHECK (hub_pending_mode IN ('subscribe', 'unsubscribe')),
  hub_pending_token TEXT,
  hub_pending_deadline TEXT,
  hub_requested_at TEXT,
  hub_failures INTEGER NOT NULL DEFAULT 0 CHECK (hub_failures >= 0),
  hub_next_attempt_at TEXT,
  hub_verified_at TEXT,
  hub_subscribed_at TEXT,
  hub_claim_token TEXT,
  hub_claim_expires_at TEXT,
  rss_claim_token TEXT,
  rss_claim_expires_at TEXT,
  rss_etag TEXT,
  rss_last_modified TEXT,
  rss_last_checked_at TEXT,
  rss_next_at TEXT,
  rss_failures INTEGER NOT NULL DEFAULT 0 CHECK (rss_failures >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_websub_channels_hub_due
  ON websub_channels(hub_next_attempt_at, channel_id);
CREATE INDEX IF NOT EXISTS idx_websub_channels_rss_due
  ON websub_channels(rss_next_at, channel_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_websub_interest
  ON subscriptions(channel_id, active, account_id);

-- WebSub notifications need their own ordering watermark, separate from API
-- details freshness. Exact duplicates leave every row untouched.
ALTER TABLE videos ADD COLUMN websub_updated_at TEXT;
ALTER TABLE videos ADD COLUMN websub_hash TEXT;

-- Populate channels that already have an eligible real follower at deployment.
INSERT OR IGNORE INTO websub_channels
  (channel_id, desired, hub_next_attempt_at, rss_next_at, created_at, updated_at)
SELECT s.channel_id, 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM subscriptions s
JOIN accounts a ON a.id = s.account_id
WHERE s.active = 1 AND a.mode = 'real' AND a.connected = 1
GROUP BY s.channel_id;

-- An eligible active subscription schedules global discovery immediately.
CREATE TRIGGER IF NOT EXISTS websub_subscription_insert
AFTER INSERT ON subscriptions
WHEN NEW.active = 1
BEGIN
  INSERT INTO websub_channels
    (channel_id, desired, hub_next_attempt_at, rss_next_at, created_at, updated_at)
  SELECT NEW.channel_id, 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (
    SELECT 1 FROM subscriptions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.channel_id = NEW.channel_id AND s.active = 1
      AND a.mode = 'real' AND a.connected = 1
  )
  ON CONFLICT(channel_id) DO UPDATE SET
    desired = 1,
    hub_next_attempt_at = excluded.hub_next_attempt_at,
    rss_next_at = excluded.rss_next_at,
    updated_at = excluded.updated_at
  WHERE websub_channels.desired = 0;
END;

-- Updates can move a subscription between channels or accounts, so reconcile
-- both the old and new channel. Only the last interested account removes
-- desired=1; the row is kept as a durable cancellation/rejoin tombstone.
CREATE TRIGGER IF NOT EXISTS websub_subscription_update
AFTER UPDATE OF active, channel_id, account_id ON subscriptions
WHEN OLD.active IS NOT NEW.active OR OLD.channel_id IS NOT NEW.channel_id OR OLD.account_id IS NOT NEW.account_id
BEGIN
  INSERT INTO websub_channels
    (channel_id, desired, hub_next_attempt_at, rss_next_at, created_at, updated_at)
  SELECT OLD.channel_id, 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (
    SELECT 1 FROM subscriptions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.channel_id = OLD.channel_id AND s.active = 1
      AND a.mode = 'real' AND a.connected = 1
  )
  ON CONFLICT(channel_id) DO UPDATE SET
    desired = 1,
    hub_next_attempt_at = excluded.hub_next_attempt_at,
    rss_next_at = excluded.rss_next_at,
    updated_at = excluded.updated_at
  WHERE websub_channels.desired = 0;

  UPDATE websub_channels SET
    desired = 0,
    hub_next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    rss_next_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE channel_id = OLD.channel_id AND desired = 1
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.channel_id = OLD.channel_id AND s.active = 1
        AND a.mode = 'real' AND a.connected = 1
    );

  INSERT INTO websub_channels
    (channel_id, desired, hub_next_attempt_at, rss_next_at, created_at, updated_at)
  SELECT NEW.channel_id, 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (
    SELECT 1 FROM subscriptions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.channel_id = NEW.channel_id AND s.active = 1
      AND a.mode = 'real' AND a.connected = 1
  )
  ON CONFLICT(channel_id) DO UPDATE SET
    desired = 1,
    hub_next_attempt_at = excluded.hub_next_attempt_at,
    rss_next_at = excluded.rss_next_at,
    updated_at = excluded.updated_at
  WHERE websub_channels.desired = 0;

  UPDATE websub_channels SET
    desired = 0,
    hub_next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    rss_next_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE channel_id = NEW.channel_id AND desired = 1
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.channel_id = NEW.channel_id AND s.active = 1
        AND a.mode = 'real' AND a.connected = 1
    );
END;

CREATE TRIGGER IF NOT EXISTS websub_subscription_delete
AFTER DELETE ON subscriptions
BEGIN
  UPDATE websub_channels SET
    desired = 0,
    hub_next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    rss_next_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE channel_id = OLD.channel_id AND desired = 1
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.channel_id = OLD.channel_id AND s.active = 1
        AND a.mode = 'real' AND a.connected = 1
    );
END;

-- Connecting/disconnecting real OAuth accounts changes the global follower set.
CREATE TRIGGER IF NOT EXISTS websub_account_update
AFTER UPDATE OF connected, mode ON accounts
WHEN OLD.connected IS NOT NEW.connected OR OLD.mode IS NOT NEW.mode
BEGIN
  INSERT INTO websub_channels
    (channel_id, desired, hub_next_attempt_at, rss_next_at, created_at, updated_at)
  SELECT DISTINCT s.channel_id, 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM subscriptions s
  JOIN accounts a ON a.id = s.account_id
  WHERE s.account_id = NEW.id AND s.active = 1
    AND a.mode = 'real' AND a.connected = 1
  ON CONFLICT(channel_id) DO UPDATE SET
    desired = 1,
    hub_next_attempt_at = excluded.hub_next_attempt_at,
    rss_next_at = excluded.rss_next_at,
    updated_at = excluded.updated_at
  WHERE websub_channels.desired = 0;

  UPDATE websub_channels SET
    desired = 0,
    hub_next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    rss_next_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE desired = 1
    AND channel_id IN (SELECT channel_id FROM subscriptions WHERE account_id = NEW.id)
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.channel_id = websub_channels.channel_id AND s.active = 1
        AND a.mode = 'real' AND a.connected = 1
    );
END;

-- Deletion cascades subscriptions afterwards; capture the follower set before.
CREATE TRIGGER IF NOT EXISTS websub_account_delete
BEFORE DELETE ON accounts
BEGIN
  UPDATE websub_channels SET
    desired = 0,
    hub_next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    rss_next_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE desired = 1
    AND channel_id IN (SELECT channel_id FROM subscriptions WHERE account_id = OLD.id)
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.channel_id = websub_channels.channel_id AND s.active = 1
        AND a.mode = 'real' AND a.connected = 1 AND a.id <> OLD.id
    );
END;
