-- Repeatable, non-destructive demo fixtures.
-- Fictional channels/videos plus three playable YouTube demo ids. Thumbnails are
-- local files so demo mode never performs external requests. `INSERT OR IGNORE`
-- keeps user watch state, edits and subscriptions across repeated seeds.

INSERT OR IGNORE INTO accounts
  (id, mode, name, youtube_channel_id, connected, scopes, token_expires_at, created_at, updated_at)
VALUES
  ('demo', 'demo', 'Demo local', NULL, 0, '', NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

INSERT OR IGNORE INTO preferences (account_id, watch_threshold, theme, updated_at)
VALUES ('demo', 90, 'system', '2026-10-01T00:00:00.000Z');

INSERT OR IGNORE INTO channels
  (id, title, description, thumbnail_url, source, fetched_at, expires_at, purged_at, last_synced_at,
   rss_etag, rss_last_modified, rss_failures, rss_next_attempt_at, created_at, updated_at)
VALUES
  ('UCdemoChannel0000000001', 'Canal Demo Uno',
   'Canal ficticio de demostración. No representa a ninguna persona ni canal real.',
   '/thumbs/01.svg', 'fixture', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
   '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('UCdemoChannel0000000002', 'Canal Demo Dos',
   'Canal ficticio de demostración para probar el feed y las listas.',
   '/thumbs/03.svg', 'fixture', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
   '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('UCdemoChannel0000000003', 'Canal Demo Tres',
   'Canal ficticio de demostración sin datos externos.',
   '/thumbs/02.svg', 'fixture', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
   '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('UCdemoChannel0000000004', 'Canal Demo Cuatro',
   'Canal ficticio no suscrito, usado para comprobar el estado de suscripción.',
   '/thumbs/06.svg', 'fixture', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
   '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

INSERT OR IGNORE INTO videos
  (id, channel_id, channel_title, title, description, thumbnail_url, published_at,
   duration_seconds, view_count, source, fetched_at, expires_at, purged_at, created_at, updated_at)
VALUES
  ('M7lc1UVf-VE', 'UCdemoChannel0000000001', 'Canal Demo Uno',
   'YouTube IFrame Player API demo',
   'Vídeo reproducible de demostración de la API oficial del reproductor de YouTube. El canal y los metadatos de esta demo son ficticios.',
   '/thumbs/01.svg', '2026-10-12T09:00:00.000Z', NULL, NULL, 'fixture',
   '2026-10-12T09:00:00.000Z', NULL, NULL, '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z'),
  ('demoVid0001', 'UCdemoChannel0000000003', 'Canal Demo Tres',
   'Pendientes de la semana',
   'Vídeo ficticio de demostración para probar el feed, los filtros y el marcado de pendientes.',
   '/thumbs/02.svg', '2026-10-10T12:30:00.000Z', 420, 1234, 'fixture',
   '2026-10-10T12:30:00.000Z', NULL, NULL, '2026-10-10T12:30:00.000Z', '2026-10-10T12:30:00.000Z'),
  ('jNQXAC9IVRw', 'UCdemoChannel0000000002', 'Canal Demo Dos',
   'Me at the zoo',
   'Primer vídeo publicado en YouTube, usado como ejemplo reproducible en la demo. El canal mostrado es ficticio.',
   '/thumbs/03.svg', '2026-10-08T08:15:00.000Z', 19, NULL, 'fixture',
   '2026-10-08T08:15:00.000Z', NULL, NULL, '2026-10-08T08:15:00.000Z', '2026-10-08T08:15:00.000Z'),
  ('demoVid0002', 'UCdemoChannel0000000002', 'Canal Demo Dos',
   'Cómo organizo mis listas',
   'Vídeo ficticio para probar listas locales, repetición de elementos y estados de reproducción.',
   '/thumbs/04.svg', '2026-10-05T17:45:00.000Z', 600, 987, 'fixture',
   '2026-10-05T17:45:00.000Z', NULL, NULL, '2026-10-05T17:45:00.000Z', '2026-10-05T17:45:00.000Z'),
  ('aqz-KE-bpKQ', 'UCdemoChannel0000000001', 'Canal Demo Uno',
   'Big Buck Bunny',
   'Corto de animación de Blender Foundation usado como vídeo reproducible de demostración.',
   '/thumbs/05.svg', '2026-09-28T14:00:00.000Z', 596, NULL, 'fixture',
   '2026-09-28T14:00:00.000Z', NULL, NULL, '2026-09-28T14:00:00.000Z', '2026-09-28T14:00:00.000Z'),
  ('demoVid0003', 'UCdemoChannel0000000004', 'Canal Demo Cuatro',
   'RSS y feeds explicados sin promesas',
   'Vídeo ficticio sobre feeds Atom. En modo demo no se consulta ningún feed real.',
   '/thumbs/06.svg', '2026-09-20T11:00:00.000Z', 315, 456, 'fixture',
   '2026-09-20T11:00:00.000Z', NULL, NULL, '2026-09-20T11:00:00.000Z', '2026-09-20T11:00:00.000Z');

INSERT OR IGNORE INTO watch_states
  (account_id, video_id, watched, watched_at, position_seconds, duration_seconds, percent, manual, revision, updated_at)
VALUES
  ('demo', 'jNQXAC9IVRw', 1, '2026-10-09T10:00:00.000Z', 19, 19, 100, 1, 2, '2026-10-09T10:00:00.000Z'),
  ('demo', 'demoVid0002', 0, NULL, 120, 600, 20, 0, 1, '2026-10-06T09:00:00.000Z');

INSERT OR IGNORE INTO subscriptions
  (account_id, channel_id, remote_subscription_id, active, generation, last_verified_at, last_synced_at, created_at, updated_at)
VALUES
  ('demo', 'UCdemoChannel0000000001', NULL, 1, 'seed', '2026-10-01T00:00:00.000Z', NULL,
   '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('demo', 'UCdemoChannel0000000002', NULL, 1, 'seed', '2026-10-01T00:00:00.000Z', NULL,
   '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('demo', 'UCdemoChannel0000000003', NULL, 1, 'seed', '2026-10-01T00:00:00.000Z', NULL,
   '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

INSERT OR IGNORE INTO playlists
  (id, account_id, source, remote_id, title, description, privacy_status, remote_item_count,
   fetched_at, items_synced_at, seeded, created_at, updated_at)
VALUES
  ('pl-demo-favoritos', 'demo', 'local', NULL, 'Favoritos demo',
   'Lista local ficticia para comprobar guardados. No es una lista de YouTube.',
   NULL, NULL, '2026-10-01T00:00:00.000Z', NULL, 1,
   '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('pl-demo-pendientes', 'demo', 'local', NULL, 'Pendientes demo',
   'Segunda lista local ficticia con varios elementos.',
   NULL, NULL, '2026-10-01T00:00:00.000Z', NULL, 1,
   '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

INSERT OR IGNORE INTO playlist_items (id, playlist_id, video_id, remote_item_id, position, sync_generation, added_at)
VALUES
  ('pi-demo-favoritos-1', 'pl-demo-favoritos', 'M7lc1UVf-VE', NULL, 0, NULL, '2026-10-01T00:00:00.000Z'),
  ('pi-demo-favoritos-2', 'pl-demo-favoritos', 'jNQXAC9IVRw', NULL, 1, NULL, '2026-10-01T00:00:00.000Z'),
  ('pi-demo-pendientes-1', 'pl-demo-pendientes', 'aqz-KE-bpKQ', NULL, 0, NULL, '2026-10-01T00:00:00.000Z'),
  ('pi-demo-pendientes-2', 'pl-demo-pendientes', 'demoVid0001', NULL, 1, NULL, '2026-10-01T00:00:00.000Z'),
  ('pi-demo-pendientes-3', 'pl-demo-pendientes', 'demoVid0003', NULL, 2, NULL, '2026-10-01T00:00:00.000Z');

UPDATE videos SET is_live = 0 WHERE source = 'fixture' AND is_live IS NULL;
