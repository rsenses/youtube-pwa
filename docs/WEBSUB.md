# Descubrimiento global de YouTube (WebSub)

Implementación opt-in, activada en producción **tras autorización posterior explícita** como `7a444ee5-e9f3-42ef-9a9d-6788d08d10c9`. Se aplicaron 0010/0011 sin respaldo D1 por decisión del usuario, se configuró un secret propio y el usuario creó el bypass de Access restringido al callback. No se modificaron las claves OAuth. La app y las APIs privadas siguen devolviendo login de Access (302); callback sin parámetros responde 400 del Worker.

Verificación inicial: 136 canales únicos; dos inscripciones verificadas por el hub, una comprobación RSS correcta y canales todavía en reintento. No se ha certificado toda la incorporación, recepción de un vídeo real ni consumo diario/CPU sostenido. Las pruebas automatizadas continúan siendo locales y simuladas.

## Recorrido

- YouTube Data API sigue siendo la fuente de las suscripciones de cada cuenta. «Actualizar» y la tarea automática de cuentas (12 h) actualizan esas suscripciones, no recorren RSS por usuario cuando WebSub está activo.
- Una fila de `websub_channels` representa cada canal seguido por al menos una cuenta real conectada. Triggers de suscripciones/conexión/desconexión mantienen ese interés; añadir un segundo usuario no crea otra suscripción ni repite el bootstrap.
- El cron existente reserva nueve de cada diez minutos para como máximo una operación de hub y una RSS; el décimo ejecuta recuperación de la Queue/suscripciones y una página de limpieza semanal, sin mezclar ese presupuesto con el RSS. Cada página RSS admite hasta 15 entradas. No se añade Queue, Workflow ni Durable Object. La Queue existente permanece para suscripciones/listas y para reanudar trabajos anteriores. Los trabajos RSS por cuenta ya persistidos se cortan al activar el nuevo modo.
- Un canal nuevo queda inmediatamente pendiente de inscripción y bootstrap RSS. La prioridad por fecha/ID reparte el arranque de cientos de canales entre ticks; no es una inscripción masiva instantánea. Con un RSS por tick de descubrimiento (9 de cada 10 minutos), 113 canales iniciales necesitan aproximadamente 126 minutos sin errores; el coste sólo se comparte una vez entre usuarios.
- El callback aplica una notificación válida antes de responder 2xx. No usa `waitUntil` para confirmar una persistencia que aún no ha ocurrido. Un fallo D1 devuelve error; un conflicto concurrente devuelve 409 para permitir redelivery. RSS diario es la segunda red de recuperación.
- Cada canal con éxito RSS vuelve a quedar pendiente 24 h después. Los fallos usan backoff (5 min hasta 6 h) sin publicar validadores de éxito. No se repite una pasada por usuario. Un 304 sólo actualiza el seguimiento global del canal.

## Protocolo y autenticidad

Hub fijo: `https://pubsubhubbub.appspot.com/subscribe`.

**Topic exacto:** `https://www.youtube.com/xml/feeds/videos.xml?channel_id=CHANNEL_ID`. No sustituirlo por la URL de descarga RSS (`https://www.youtube.com/feeds/videos.xml?channel_id=...`): el hub empareja topics por cadena exacta. La guía oficial y el informe Google enlazado abajo documentan esa distinción.

Callback exacto: `/api/websub/youtube?channel=CHANNEL_ID&token=TOKEN_DERIVADO`.

- GET valida routing token HMAC ligado al canal, topic exacto, modo/intención pendiente, deadline y lease positivo de `subscribe`. Devuelve challenge como `text/plain`, `no-store`, `nosniff`; no crea sesión. Se guarda la intención antes del POST al hub, por lo que el GET puede llegar antes de recibir su 202.
- POST exige XML/Atom, máximo 64 KiB y 15 entradas, verifica HMAC del cuerpo **crudo** antes del parser. Se admite `X-Hub-Signature: sha1=...` (hub 0.4) y SHA-256 implementado explícitamente. Falta de firma/firma inválida se rechaza; no hay fallback unsigned. Se rechazan DOCTYPE, entradas incompletas, propietario distinto al topic y cuerpos fuera de límites.
- Routing token y `hub.secret` se derivan con etiquetas distintas de `WEBSUB_SECRET`. No se guardan credenciales por canal ni se reutiliza la clave OAuth. No registrar URLs de callback completas, firmas ni cuerpos en logs.
- Renovación anticipada según el lease realmente verificado, con margen máximo de 12 h (25 % para leases cortos). Renovar no borra el lease válido mientras llega el nuevo GET. La última baja solicita unsubscribe; una baja/reentrada concurrente converge de nuevo al estado deseado, sin duplicar canales.

## Qué vídeos se guardan o actualizan

La política anterior de nuevas publicaciones de 24 h queda **sustituida** en el modo WebSub por la decisión posterior del usuario:

1. Nunca se importan ni renuevan vídeos publicados hace **más de un año natural UTC**. Se aplica al RSS y push, a la renovación de detalles y a nuevas importaciones de listas en el nuevo modo; las relaciones antiguas ya guardadas se conservan. Un timestamp futuro mayor de cinco minutos no se acepta.
2. RSS sólo dispone de su página más reciente (habitualmente hasta 15 entradas); no se consulta el archivo histórico. Una entrada desconocida dentro del año se incorpora una vez. Un bootstrap usa esa misma página; no importa el histórico del canal.
3. Si ya existe, se compara Atom `<updated>` con el último evento aplicado y los campos recibidos con los guardados. Un vídeo sólo actualiza su contenido si cambió y está pendiente para al menos una cuenta interesada **o** está en alguna lista de cualquier cuenta.
4. Visto por todas las cuentas interesadas y fuera de todas las listas: se omite. No se genera watch state por cuenta al recibir eventos. Una cuenta real conectada con suscripción activa sin `watched=1` cuenta como pendiente; demo/desconectadas no generan interés global.
5. Un payload escaso no borra duración, miniatura, descripción o estado live ausentes; una descripción explícitamente vacía sí se puede aplicar. RSS completo puede enriquecer el mismo `<updated>` que una notificación escasa. Los detalles de duración/live siguen viniendo de las lecturas API existentes, no de campos inventados del push.
6. Duplicado exacto o evento más antiguo: cero escrituras. Un evento más nuevo de contenido idéntico sólo puede avanzar su marca de orden (una escritura necesaria para impedir la secuencia A@1, A@3, B@2); no reescribe metadatos ni invalida el feed. CAS y relectura de conflictos evitan confirmar un merge obsoleto.

Los campos globales son públicos. La metadata privada de listas permanece por cuenta y no se copia al registro público. Un evento firmado es prueba de un evento del topic, no permiso para leer las listas de otra persona.

## Caché y llegada a la interfaz

`youtube_feed_state` tiene una única revisión global. La persistencia de cambios visibles y su incremento se ejecutan en el mismo batch D1; un conflicto no-op no aumenta la revisión. Las claves KV de feed combinan revisión global + generación de cuenta. El catálogo de listas no cambia y no se hace fanout de invalidaciones por usuario.

El feed visible consulta `/api/feed/revision` cada 60 s y al volver a la pestaña. El endpoint autenticado lee claves de estado, no vídeos ni purgas. Al cambiar la revisión vuelve a cargar los primeros 18 vídeos; las páginas anteriores se descartan para no mezclar snapshots. Las pestañas ocultas no sondean. No es una conexión push navegador ni garantiza refresco instantáneo en segundo plano.

## Limpieza semanal

`video_retention_state` guarda una sola ejecución global. El cron continúa páginas de 50 candidatos antiguos usando el índice de fecha, sin escanear toda la biblioteca en cada tick. Tras terminar espera siete días.

Sólo se elimina un vídeo de más de un año que:

- tenga al menos un estado visto de una cuenta real conectada;
- esté visto por todas las cuentas reales conectadas con suscripción activa al propietario;
- no tenga ningún estado explícito pendiente de otra cuenta real conectada;
- no esté en **ninguna lista**, local o remota, de ninguna cuenta.

Edad desconocida (placeholder 1970) se conserva; una copia privada con publicación reciente impide borrarlo. La sentencia vuelve a comprobar las condiciones al borrar, y FK conserva integridad/cascada de estados asociados. Un claim expirable y cursor guardado con el batch permiten reanudar tras fallo. Sólo un borrado real invalida la revisión global.

No es la purga de caducidad de metadata YouTube: esa política previa continúa. Conservar la identidad de un vídeo antiguo en una lista no promete conservar metadatos externos caducados indefinidamente sin renovación.

## Pruebas exclusivamente locales

No hace falta URL pública, cuenta de Google ni secrets reales. Los tests usan Miniflare/D1 aislado, firma con clave fixture y hub/RSS simulados; no llaman a YouTube ni al hub.

```sh
npm run typecheck
npx vitest run tests/websub.test.ts tests/channel-sync.test.ts tests/websub-integration.test.ts tests/video-retention.test.ts tests/rss.test.ts
npm run test:sql
```

Las migraciones nuevas son `0010_websub_channels.sql` y `0011_weekly_video_retention.sql`. Las pruebas las aplican a bases desechables, no a `.wrangler/state` real. Los loaders SQL deben respetar los cuerpos de triggers (no basta `split(';')`).

`WEBSUB_ENABLED=true` y `WEBSUB_SECRET` de al menos 16 caracteres activan el modo en `MODE=real`. Sin ambas condiciones el modo anterior permanece y no hay registro en el hub. Los tests suministran esas variables en memoria; no se ha editado `.dev.vars`. **No activar un servidor local con credenciales reales y cron externo para estas pruebas.**

## Procedimiento de activación de producción

Se ejecutó con autorización explícita para la activación indicada arriba. Cualquier repetición o cambio remoto requiere su propio alcance autorizado:

1. Respaldar D1 y aplicar las migraciones; preparar un secret WebSub propio y estable, distinto de OAuth. No reemplazar `TOKEN_ENCRYPTION_KEY`.
2. Incluir `WEBSUB_ENABLED` en la configuración fuente que vaya a desplegarse; registrar el secret por el mecanismo seguro de Wrangler. `.dev.vars` no se publica automáticamente.
3. Configurar una excepción Access **sólo** para `/api/websub/youtube` (GET/POST donde la herramienta de política permita restringir métodos). El hub no puede atravesar el login de Access. Todo el resto de `/api`, OAuth y la app sigue protegido. El usuario configuró esta excepción y se comprobó su alcance antes de activar el Worker.
4. El routing Worker-first actual `/api/*` y el cron existente cubren este endpoint; no hacen falta nuevos recursos.
5. Desplegar sólo con aprobación explícita; verificar challenge/lease y una notificación real firmada antes de dar por validada toda la interoperabilidad. El challenge/lease inicial ya se ha verificado; quedan notificación real, CPU/subrequests Free sostenidos y consumo global con una muestra controlada.

Desactivar la flag detiene el nuevo cron/callback y restaura la ruta anterior. No cancela mágicamente leases del hub: al retirar el modo hay que planificar cancelaciones o dejar caducar leases; el callback apagado responderá 404. No borrar el secret hasta decidir esa retirada. No se certifica que el hub cancele inmediatamente por respuestas fallidas.

## Verificación del runtime y arranque

El primer despliegue autorizado (`318598eb-0be4-4746-8f63-38c50b19d05e`) detectó un fallo que los mocks de fetch no cubrían: Workerd rechaza `redirect: "error"` antes de enviar la petición. Se corrigió a `manual`; el código rechaza estados de redirección sin seguirlos. `tests/websub-runtime.test.ts` cruza el fetch nativo de Workerd con outbound local simulado y comprueba 202/302 sin red externa. La versión corregida es la indicada al principio.

Última validación dirigida antes del despliegue corregido: typecheck, 122 tests en 13 archivos, build + check-build correctos; comprobación SQL y un test de navegador de refresco automático también habían pasado durante la validación local. No suite completa. Los contadores de fallos iniciales no se borraron: siguen su backoff y se conservan para no ocultar incidencias.

## Límites y fuentes

Workers Free documenta 10 ms CPU por invocación y 50 subrequests; `waitUntil` HTTP no es una cola durable. Un RSS + operación de hub por tick y páginas pequeñas limitan trabajo, pero **Miniflare no certifica CPU de producción**. La entrega WebSub es near-real-time, no garantía de entrega instantánea; RSS tampoco puede recuperar publicaciones que ya no aparezcan en su página.

- YouTube oficial (consultado 2026-10-22): https://developers.google.com/youtube/v3/guides/push_notifications
- Topic exacto /xml/feeds (respuesta Google): https://issuetracker.google.com/issues/566069563
- Hub Google 0.4 y leases: https://pubsubhubbub.appspot.com/
- WebSub verificación/firmas: https://www.w3.org/TR/websub/
- Cloudflare Workers límites: https://developers.cloudflare.com/workers/platform/limits/
- Cron UTC y simulación local: https://developers.cloudflare.com/workers/configuration/cron-triggers/

Métricas y exclusiones: [D1-PERFORMANCE.md](D1-PERFORMANCE.md).
