# Lecturas D1 y caché

## Listas de YouTube — implementación local 22-10-2026

La lectura del catálogo usa D1 directamente. Para listas YouTube cuyo recuento remoto ya se conoce, el fixture de 43 listas y 2 locales pasa de 8.147 lecturas a 104; las listas antiguas con `remote_item_count=NULL` conservan el recuento local hasta la siguiente sincronización. La navegación no consulta YouTube ni usa la caché KV de listas.

La importación inicial del catálogo incorpora el contenido de listas todavía no importadas. Una actualización posterior del catálogo no lee el contenido de listas existentes. La sincronización individual identifica cada relación por `remote_item_id`, compara páginas de diez elementos contra los registros de esa lista y escribe solo altas, cambios de vídeo/posición y bajas tras recibir todas las páginas. La prueba de una lista sin cambios prepara cero escrituras de relaciones; otra prueba cubre una alta duplicando el vídeo, una baja y un cambio de posición. Se mantiene el refresco de metadatos de vídeo acotado a la lista elegida.

La migración 0012 añade un índice parcial para hallar la siguiente lista no importada y un índice que cubre la comparación final de IDs. `EXPLAIN QUERY PLAN` local confirma `idx_playlists_unimported`, `idx_playlist_items_remote` para las búsquedas por página y `COVERING INDEX idx_playlist_items_snapshot` para el barrido final. Estas cifras son del fixture Miniflare/SQLite, no analíticas remotas. El detalle sigue cargando todos los elementos de la lista abierta: 193 lecturas para 63 elementos en el fixture; una paginación posterior podría reducir ese coste inicial.

## WebSub global: medición local nueva

El modo opt-in y sus reglas actuales se describen en [WEBSUB.md](WEBSUB.md). Esta sección sustituye el contrato de RSS de 24 h/insert-only/KV por cuenta **sólo cuando WebSub está activo**. Las mediciones previas más abajo son históricas y de escenarios distintos; no se pueden restar directamente como ahorro total de producción.

Miniflare/D1, sin red externa ni base real, con los índices de las migraciones 0010/0011:

| Escenario medido | Filas leídas | Filas escritas |
| --- | ---: | ---: |
| Notificación duplicada exacta | 2 | 0 |
| Actualización de vídeo visto por todos, fuera de listas | 8 | 0 |
| RSS: 113 canales únicos, 300 vídeos cambiados, dos cuentas compartidas | 4.165 | 1.839 |
| Misma pasada RSS completa sin cambios (113 canales) | 1.165 | 339 |
| Limpieza semanal: 50 vídeos, 100 estados de visionado eliminados | 1.105 | 153 |

La pasada RSS incluye selección por índice, claims/seguimiento global, contenido y revisión global; no incluye sincronizar suscripciones OAuth, hub registration/renewal, purgas HTTP previas ni sondeo del navegador. Las 339 escrituras sin cambios son los 113 registros globales de seguimiento y sus índices (3 por canal); cero escrituras de vídeo o epoch. A diferencia del modo anterior con seguimiento KV, se paga este pequeño checkpoint durable una vez al día por **canal único**, nunca por usuario/petición de actualizar. El max observado por tick del primer sweep es 41 lecturas; una pasada sin cambios usa como máximo 11. Los índices `(rss_next_at,channel_id)`/`(hub_next_attempt_at,channel_id)` y la comparación de rango sin OR-NULL evitan recorrer todos los canales cuando no vence ninguno. El mismo fixture antes de corregir ese índice/recorrido gastaba 16.859 lecturas por pasada (264 max/tick), frente a 4.165 con las comprobaciones CAS adicionales actuales.

La eliminación semanal se paginó antes de las comprobaciones de listas/usuarios. Añadir índices por vídeo en `watch_states` y `account_video_metadata` redujo el fixture de 13.605 a 1.105 lecturas. Las 153 escrituras incluyen FK/cascada y estado global, no 153 vídeos. El borrado cuenta 50 vídeos reales mediante RETURNING.

Un evento más nuevo con contenido idéntico puede escribir sólo la marca de orden, sin metadata ni epoch: es necesario para que A@1, A@3, B@2 no termine en B. Redelivery exacto con el mismo timestamp sigue siendo cero escrituras. RSS puede enriquecer el mismo timestamp recibido antes por push escaso, sin devolver campos ausentes a NULL.

No se añade ninguna Queue para descubrimiento, ni trabajos por usuario/estado visto por vídeo. Los tests de escala prueban un registro por cada canal compartido, no CPU del Worker Free. El cron mantiene una operación de hub y una de RSS por minuto: la activación inicial de muchos canales es escalonada; una vez inscrito, el evento no espera esa pasada diaria. No se ha medido interoperabilidad hub real ni latencia/CPU de producción. El sondeo de revisión de feed lee estado, no la consulta completa de vídeos; debe contarse por pestaña visible en la medición total futura.

Comandos dirigidos: `npx vitest run tests/websub.test.ts tests/channel-sync.test.ts tests/websub-integration.test.ts tests/video-retention.test.ts --silent=false`. El coste previo de RSS reciente (282/85 para 17 nuevos, excluyendo jobs y metadata) **no es una comparación equivalente** a 300 actualizaciones más tracking global. No se afirma un porcentaje de ahorro global sin medición controlada posterior.

## Diagnóstico y medición local (modo anterior)

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

## Medición histórica de propuestas de listas

Medición local con el fixture sintético de `tests/d1-cost.test.ts` y Miniflare/D1, sin cambios en `worker/`, esquema ni migraciones. Baseline del árbol local `cb13589`; no se consultó D1 remota ni la versión desplegada `caf795fe-e772-4242-a4ac-5ca143ded7fd`. Las cifras son `meta.rows_read`/`meta.rows_written` de D1 local, no consumo de producción. Ejecutar `npx vitest run tests/d1-cost.test.ts --silent=false` o `npm run profile:d1`; el test imprime cada cifra.

Fixture: 4.497 vídeos, 113 suscripciones, 43 listas YouTube y 2.673 elementos. Fuera de toda medición se añadieron 2 listas locales (3 y 2 elementos) y se sembraron `remote_item_count` con los recuentos visibles actuales; son valores sintéticos, no de la API. Antes de sembrarlos, las 43 listas YouTube devolvieron `NULL` en la consulta candidata: 43/43 desconocidos, sin fabricar un 0.

| Caso                                                        | Filas leídas | Filas escritas |
| ----------------------------------------------------------- | -----------: | -------------: |
| Catálogo actual, 43 listas YouTube                          |        8.147 |              0 |
| Catálogo actual, 43 remotas + 2 locales                     |        8.165 |              0 |
| Catálogo candidato, 45 listas, `remote_item_count` sin sembrar |           97 |              0 |
| Catálogo candidato, 45 listas, recuentos sembrados          |           97 |              0 |
| `getPlaylistRow` actual, p0 (63 elementos)                  |          191 |              0 |
| Lookup candidato de mutación, sin `COUNT`                   |            1 |              0 |

Semántica remota/local: las listas YouTube usan `remote_item_count` (nullable) y las locales `COUNT(playlist_items)` crudo. En el fixture, `local-a` contiene 3 vídeos `source='fixture'`; el catálogo actual en scope externo cuenta 0 porque filtra visibilidad, mientras el candidato crudo cuenta 3. `local-b`, con vídeos externos, coincide en 2. Por tanto el `COUNT` local crudo cambia la semántica de scope/purga; si debe conservarse la visibilidad actual, el recuento local tendría que mantener el filtro, con coste acotado a los elementos de listas locales. No se implementó. El DTO actual `PlaylistSummary.itemCount` es numérico y `toNumber(NULL)` daría 0; la consulta medida conserva `NULL`, pero exponerlo como nullable requiere un cambio de contrato no realizado.

Detalle de p0, 63 elementos, con posiciones sintéticas 0..62 sembradas fuera de medición:

| Caso                                              | Filas leídas | Filas escritas |
| ------------------------------------------------- | -----------: | -------------: |
| `getPlaylistDetail` actual, lista completa        |          383 |              0 |
| Resumen candidato (`remote_item_count`, sin COUNT) |            1 |              0 |
| Página candidata 1 (18 + 1 de lookahead)          |           59 |              0 |
| Página candidata 2 (18 + 1 de lookahead)          |           76 |              0 |
| Lookup + página 1 / página 2                      |        60 / 77 |            0 / 0 |
| Otra cuenta: lookup + página                      |            2 |              0 |
| Scope `fixture` sobre p0 (sin elementos)          |          128 |              0 |

El test compara pertenencia y orden: los 18 primeros de la página 1 coinciden con `full[0..18]` y los 18 primeros de la página 2 con `full[18..36]`; el elemento 19 es solo lookahead. Ninguna consulta candidata contiene `COUNT`. El resumen candidato de p0 devuelve `itemCount=63` desde `remote_item_count`; el lookup de mutación (tabla anterior) sigue en 1 lectura. La SQL candidata incluye `JOIN playlists p ON p.id=pi.playlist_id AND p.account_id=?`; otra cuenta obtiene resumen nulo y cero elementos. El scope se conserva con `v.source`; en scope `fixture` el filtro no tiene índice y recorre los 63 elementos (128 lecturas), mientras el scope externo normal corta en 59/76.

Sincronización de una lista de 30 relaciones sin cambios: el UPSERT actual de `queue-sync.ts` con `sync_generation` nuevo ejecuta 30 sentencias, 30 lecturas y **90 filas escritas** (D1 cuenta tabla e índices). El `DELETE` final de ausentes escribe 0 (30 lecturas acumuladas) y el `UPDATE playlists` que recalcula el count añade 1 escritura (91 lecturas/91 escrituras acumuladas). La propuesta de cambio-only lee las 30 relaciones (30 lecturas), calcula un diff 0/0/0 y escribe **0 filas de relación**. Con el fixture cambiado (1 reordenación, 1 alta y 1 baja), el diff de prueba detecta 1/1/1 y aplicar solo esos cambios cuesta 8 filas escritas y 2 lecturas, además de las 30 de leer el snapshot; incluye mantenimiento de índices y no es una implementación de reconciliación.

En el momento de esta medición no se había implementado la sincronización propuesta: no se midió el estado durable de IDs vistos (JSON de job), la retirada final preservando cambios posteriores al inicio, ni escrituras de metadata privada, cola, leases o jobs; se excluyen explícitamente. Tampoco se habían ejecutado suite completa, build ni deploy. Estas cifras históricas no certifican producción ni el coste de la implementación descrita arriba.

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
