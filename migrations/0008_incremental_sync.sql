-- Seed durable watermarks from successful history; runtime also bootstraps lazily.
INSERT INTO sync_state(account_id,type,last_run_at,last_status)
SELECT account_id,'queue:' || type,MAX(created_at),'success' FROM sync_jobs WHERE status='success' GROUP BY account_id,type
ON CONFLICT(account_id,type) DO UPDATE SET last_run_at=MAX(COALESCE(sync_state.last_run_at,''),excluded.last_run_at),last_status='success';
