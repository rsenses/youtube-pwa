-- WebSub interest follows active, included real-account subscriptions.
DROP TRIGGER websub_subscription_insert;
DROP TRIGGER websub_subscription_update;
DROP TRIGGER websub_subscription_delete;
DROP TRIGGER websub_account_update;
DROP TRIGGER websub_account_delete;

CREATE TRIGGER websub_subscription_insert AFTER INSERT ON subscriptions BEGIN
  INSERT INTO websub_channels(channel_id,desired,hub_next_attempt_at,rss_next_at,created_at,updated_at)
  SELECT NEW.channel_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NEW.active=1 AND NEW.excluded=0 AND EXISTS(
    SELECT 1 FROM accounts WHERE id=NEW.account_id AND mode='real' AND connected=1)
  ON CONFLICT(channel_id) DO UPDATE SET desired=1,hub_next_attempt_at=excluded.hub_next_attempt_at,
    rss_next_at=excluded.rss_next_at,updated_at=excluded.updated_at WHERE websub_channels.desired=0;
END;

CREATE TRIGGER websub_subscription_update AFTER UPDATE OF active,excluded,channel_id,account_id ON subscriptions BEGIN
  INSERT INTO websub_channels(channel_id,desired,hub_next_attempt_at,rss_next_at,created_at,updated_at)
  SELECT NEW.channel_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NEW.active=1 AND NEW.excluded=0 AND EXISTS(
    SELECT 1 FROM accounts WHERE id=NEW.account_id AND mode='real' AND connected=1)
  ON CONFLICT(channel_id) DO UPDATE SET desired=1,hub_next_attempt_at=excluded.hub_next_attempt_at,
    rss_next_at=excluded.rss_next_at,updated_at=excluded.updated_at WHERE websub_channels.desired=0;
  UPDATE websub_channels SET desired=0,hub_next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    rss_next_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE channel_id IN (OLD.channel_id,NEW.channel_id) AND desired=1 AND NOT EXISTS(
    SELECT 1 FROM subscriptions s JOIN accounts a ON a.id=s.account_id
    WHERE s.channel_id=websub_channels.channel_id AND s.active=1 AND s.excluded=0
      AND a.mode='real' AND a.connected=1);
END;

CREATE TRIGGER websub_subscription_delete AFTER DELETE ON subscriptions BEGIN
  UPDATE websub_channels SET desired=0,hub_next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    rss_next_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE channel_id=OLD.channel_id AND desired=1 AND NOT EXISTS(
    SELECT 1 FROM subscriptions s JOIN accounts a ON a.id=s.account_id
    WHERE s.channel_id=OLD.channel_id AND s.active=1 AND s.excluded=0
      AND a.mode='real' AND a.connected=1);
END;

CREATE TRIGGER websub_account_update AFTER UPDATE OF connected,mode ON accounts BEGIN
  INSERT INTO websub_channels(channel_id,desired,hub_next_attempt_at,rss_next_at,created_at,updated_at)
  SELECT DISTINCT s.channel_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM subscriptions s WHERE s.account_id=NEW.id AND s.active=1 AND s.excluded=0
    AND NEW.mode='real' AND NEW.connected=1
  ON CONFLICT(channel_id) DO UPDATE SET desired=1,hub_next_attempt_at=excluded.hub_next_attempt_at,
    rss_next_at=excluded.rss_next_at,updated_at=excluded.updated_at WHERE websub_channels.desired=0;
  UPDATE websub_channels SET desired=0,hub_next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    rss_next_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE desired=1 AND channel_id IN (SELECT channel_id FROM subscriptions WHERE account_id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM subscriptions s JOIN accounts a ON a.id=s.account_id
      WHERE s.channel_id=websub_channels.channel_id AND s.active=1 AND s.excluded=0
        AND a.mode='real' AND a.connected=1);
END;

CREATE TRIGGER websub_account_delete BEFORE DELETE ON accounts BEGIN
  UPDATE websub_channels SET desired=0,hub_next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    rss_next_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE desired=1 AND channel_id IN (SELECT channel_id FROM subscriptions WHERE account_id=OLD.id)
    AND NOT EXISTS(SELECT 1 FROM subscriptions s JOIN accounts a ON a.id=s.account_id
      WHERE s.channel_id=websub_channels.channel_id AND s.active=1 AND s.excluded=0
        AND a.mode='real' AND a.connected=1 AND a.id<>OLD.id);
END;
