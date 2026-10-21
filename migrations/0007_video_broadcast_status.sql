-- Keep the existing broad is_live flag for VOD/progress safety; classify active broadcasts separately.
ALTER TABLE videos ADD COLUMN live_broadcast_content TEXT CHECK(live_broadcast_content IN ('none','live','upcoming'));
-- Old true flags mixed active and scheduled broadcasts: request fresh details instead of guessing.
UPDATE videos SET details_fetched_at=NULL WHERE is_live=1;
UPDATE account_video_metadata SET details_fetched_at=NULL WHERE json_extract(metadata,'$.isLive')=1;
