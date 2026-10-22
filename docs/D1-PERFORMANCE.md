# Lecturas D1 y caché

## Diagnóstico y medición local

Las analíticas remotas de últimas 24 h mostraron consultas del feed con medias de 208.452–287.142 filas leídas por ejecución. No se han ejecutado más consultas SQL remotas durante el bloqueo de cuota. La copia offline no tenía metadata expirada: no hay evidencia de que la purga fuera la causa principal de este incidente.

El feed y la importación RSS ya no dependen de `video_discoveries`. La pertenencia al feed es por propietario: `videos.channel_id` contra las `subscriptions` activas de la cuenta, más `watch_states` de esa cuenta. Las entradas Atom conservan el `yt:channelId` que publica YouTube como propietario; un vídeo de otro canal no aparece en el feed del canal que lo mostró ni se le reasigna el propietario. La visibilidad compartida sigue limitada a RSS o metadata pública verificada (`details_expires_at`), de modo que los placeholders privados de OAuth continúan aislados por cuenta. Las listas y sus consultas no cambian.

Reproducción sintética con Miniflare/D1 real, 4.497 vídeos (4.496 antes de añadir la fila de control), 113 suscripciones, 43 listas y 2.673 elementos:

| Caso                                                             | Antes | Después |
| ---------------------------------------------------------------- | ----: | ------: |
| Feed discovery-first, 18 elementos (fixture original)            | 2.952 |       — |
| Feed owner-based, 18 elementos (fixture + fila de control ajena) |     — |   2.953 |
| Hit del feed KV, con generación y progreso fresco                |    37 |      37 |
| Catálogo sin KV                                                  | 8.147 |   8.147 |
| Sugerencias locales                                              | 5.438 |   5.439 |

Las filas leídas del feed owner-based quedan en 2.953 con el fixture que incluye la fila de control ajena (+1 vídeo y +1 discovery); sin esa fila el recuento vuelve a 2.952, el mismo volumen que el plan discovery-first ya ajustado. La simplificación elimina sondas de discovery, no añade coste. El plan fija `INDEXED BY idx_videos_feed` para que el recorrido por fecha y el `LIMIT` sigan cortando pronto; sin esa fijación el planificador elegía el índice por canal y leía 5.423 filas en el fixture.

Medición sobre una copia local de solo lectura de la base real (4.145 vídeos, 113 suscripciones) con `sqlite3_stmt_scanstatus`, no con analíticas D1 remotas:

- Feed `status=all`: el plan anterior recorría 23 vídeos, 21 estados, 1 metadata privada y 113 suscripciones, más sondas de discovery; el nuevo recorre 23 vídeos, 19 estados, 1 metadata privada y 113 suscripciones, sin ningún nodo de `video_discoveries`.
- Selección de canal RSS: el plan anterior añadía una sonda a `video_discoveries` por canal; el nuevo no la necesita.
- Las entradas RSS antiguas ya no se consultan ni se importan: el filtro de 24 h se aplica antes de la búsqueda de IDs existentes y antes de cualquier upsert.
- Un feed con 15 entradas nuevas solo inserta IDs nuevos; una fila ya existente conserva título, detalles, `expires_at` y estado de visionado. Un pase sin cambios no ejecuta ningún `INSERT INTO videos` ni ningún `UPDATE channels` de éxito.

Replay con el transcript RSS privado ya capturado (113 feeds, 17 entradas publicadas en las últimas 24 h y 1.641 antiguas), sobre una copia Miniflare de la misma base, sin repetir peticiones de red:

| Escenario RSS (solo esta fase)              | Filas leídas D1 | Filas escritas D1 |
| ------------------------------------------- | --------------: | ----------------: |
| Importación nueva, antes (canal + sync_state) |             503 |               650 |
| Importación nueva, después (solo IDs nuevos)  |             282 |                85 |
| Repetición sin cambios, antes                 |             746 |               339 |
| Repetición sin cambios, después (200)         |             248 |                 0 |
| Repetición con ETag 304, después              |             226 |                 0 |

Las 113 comprobaciones de canal siguen leyendo 226 filas (dos por join) y las 14 canales con entradas recientes consultan 17 IDs visibles. Las 85 filas escritas en la importación nueva son las 17 inserciones más sus índices; desaparecen las 226 actualizaciones de canal y las 339 de `sync_state` del caso anterior. Los validadores y el instante de comprobación viven en READ_CACHE por cuenta+canal: 113 escrituras KV en el primer pase, ninguna escritura D1 por canal. La repetición 304 solo selecciona canales; no publica un validador nuevo porque no hubo escritura durable que confirmar.

Estas cifras excluyen explícitamente suscripciones/OAuth, listas y elementos, API de metadata y renovación, coordinación de cola/leases/mensajes, reintentos HTTP, propagación y cuota reales de KV, y la preparación de la copia. La métrica es D1 local (`rows_read`/`rows_written` por sentencia), no el coste total de producción. El transcript usa la página visible del feed (máximo 15 entradas); el archivo histórico más profundo no es observable.

Las cifras son locales y no una certificación del consumo total de producción. El caso de KV usa un namespace simulado con D1 real; no mide propagación ni tasa de aciertos de KV en Cloudflare. Autenticación, mantenimiento, otras rutas y otros usuarios añaden lecturas. `video_discoveries` no se elimina ni se borran sus datos históricos: solo permanece su purga de retención existente (>30 días). Ejecutar `npm run profile:d1` para repetir el perfil; sus umbrales cubren feed y hits, no el presupuesto completo de la cuenta.

## Caché y consistencia

- KV READ_CACHE, Free, TTL 60 s. Feed y catálogo por cuenta, consulta y generación; payload validado y sin credenciales.
- La comprobación RSS guarda por cuenta+canal `checkedAt`, ETag y Last-Modified en READ_CACHE con TTL de 48 h. Solo se publican después de que las inserciones D1 terminen correctamente; un fallo, un registro ausente, caducado o inválido obliga a pedir el feed completo. Un 304 no avanza el registro. Las columnas heredadas `channels.rss_etag`/`rss_last_modified` no se usan para autorizar cabeceras condicionales. La caché es opcional: sin binding o con KV caído se siguen usando cabeceras incondicionales.
- Solo se importan vídeos publicados a partir del corte de 24 h fijado por el `startedAt` del job. Una caída de más de 24 h puede dejar fuera vídeos publicados durante la caída; es una pérdida intencional de la ventana y no se reimportan antiguos. La fase de metadata general selecciona únicamente vídeos RSS o públicos recientes de canales suscritos; la ruta de una lista explícita conserva su consulta y renovación propias. El histórico se cubrirá con listas, no con esta sincronización general.
- D1 sigue siendo la fuente durable de permisos, suscripciones, trabajos y estados de visionado. La autenticación nunca se salta. La caché no permite usar la aplicación durante el bloqueo de D1.
- El progreso se hidrata al leer un feed cacheado. Los cambios de pertenencia/filtros, mutaciones y fin de sincronización invalidan su generación. Tras borrar/reconectar se crea una generación aleatoria para no resucitar snapshots antiguos.
- La purga que cambia datos invalida las generaciones existentes. La migración 0009 usa índices parciales para que filas ya purgadas o con detalles borrados no sigan en el rango de retención.
- KV tiene consistencia eventual y límites Free propios; un miss o fallo vuelve a D1. No se cachean sesiones, tokens, permisos ni leases. No se usa Cache API detrás de Access.
- Sondeos de estado, sesión y ajustes no ejecutan la purga. Las listas se importan solo explícitamente, no en la sincronización general/cron de producción.

## Pendiente remoto

Worker optimizado publicado como `f62c344c-20e9-4352-b085-49002751e586`, con binding KV verificado por Wrangler. Los cambios de feed/RSS de este documento son locales y no se han desplegado. Se ejecutaron typecheck, pruebas dirigidas de cola sincronizada, sincronización D1, caché de lectura/RSS, helpers de backend, coste D1 y el chequeo SQL; no se ejecutó la suite completa. La cuota D1 agotada se restablece a las 00:00 UTC. Las migraciones 0008/0009 no se han aplicado remotamente; el código se comprueba también sobre esquema 0007, sin depender de nuevas columnas. Tras el restablecimiento: `npm run setup`, `npm run build`, `npx wrangler deploy`. Confirmar con sesión autenticada, cabecera `x-alveo-cache`, estados de visionado y analíticas de filas. Workers Free y Cloudflare Access se conservan; no se han activado pagos.

Referencias: [precios D1](https://developers.cloudflare.com/d1/platform/pricing/), [precios KV](https://developers.cloudflare.com/kv/platform/pricing/), [consistencia KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
