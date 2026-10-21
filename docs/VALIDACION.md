# Validación del concepto local

Comprobaciones realizadas el 20–21-10-2026. Son verificaciones dirigidas, **no certificación de preparación para producción**.

## Búsqueda temática por etiquetas — estado vigente 21-10-2026

Publicado `54375013-7d7b-45d3-a9ed-3e21e20f5991`. Usuario elige mejorar búsqueda oficial sin librería/scraping: etiquetas útiles y relacionadas con título primero, alternativa título/hashtags si faltan o no producen candidatos. Consultas cortas/deduplicadas, sin enlaces/promoción/números de episodio. Hasta dos search.list por fallo de caché; metadata del origen solo se solicita al faltar caché, siempre bajo el botón. Cache v4 evita reutilizar búsquedas antiguas por título.

Metadata pública verificada construye consultas compartibles; contexto privado usa key de propietario, limpieza multiversión al borrar/desconectar e INSERT condicionado a cuenta activa. No tags privados ni estados personales en caché compartida. Cuatro candidatos Free y TTL 1h conservados. Sin migración/config/Access/secretos/pagos/dependencias nuevos.

Checks: typecheck/build 0; `npm exec vitest -- run tests/related-query.test.ts tests/d1-sync.test.ts tests/queue-sync.test.ts`: **37 correctas**. Incluyen tags prioritarios, ausencia/ruido, fallback sin resultados, Unicode/límites, caché pública entre dos cuentas con estados propios, caché privada separada y no reinserción desconectada, limpieza de versiones. Playwright dirigido `npm run test:ui -- tests/browser.spec.ts --grep 'public comments'`: **uno correcto**, cero consultas de sugerencias antes del clic, mostrar/ocultar/recargar y nota de procedencia actualizada. Proveedores simulados: no gastan clave real. No suite integral/lint ni comparación real de relevancia/autenticación del usuario; no afirmar equivalencia con relacionados de YouTube.

## Tipos de vídeo y autorización — despliegue anterior 21-10-2026

Publicado `bcdc830f-3834-495b-a72a-a7bc104afc8e` en alveo.rsenses.com. Selector múltiple URL/servidor, por defecto vídeo+live; etiquetas live/short en miniatura. Clasificación compartida con SQL antes del LIMIT: directo activo tiene prioridad, short es duración >0 y <180, desconocida/cero queda vídeo. Programados no son live. Estado oficial [snippet.liveBroadcastContent](https://developers.google.com/youtube/data/reference/rest/v3/videos#snippet.liveBroadcastContent); se conserva el isLive amplio anterior para no debilitar la protección de progreso en emisiones/programados.

Migración 0007 añade estado específico, marca detalles legacy ambiguos como pendientes y no borra vídeos/progreso. Metadata pública y privada por propietario conservan la separación; purga elimina también este campo. La cola renueva emisiones/programados de más de cinco minutos al ejecutar sincronización, sin prometer live instantáneo. Backup D1 privado previo (0600). Post-deploy: 1774 estados, migración aplicada, FK vacío, Access 302 intacto.

Configuración muestra estado conocido de youtubeWrites y oculta el enlace redundante cuando ya está autorizado. Proveedores simulados en pruebas: no se validó una concesión nueva de Google real.

Checks dirigidos: typecheck/build 0; `npm exec vitest -- run tests/video-type.test.ts tests/d1-sync.test.ts tests/queue-sync.test.ts tests/backend.test.ts`: **59 correctas**. Incluyen 179/180, duración desconocida, prioridad live, programados, filtro antes de paginar, metadata privada y live→finalizado. Playwright: 13 correctas en browser/feed/queue, después siete de feed (incluye el nuevo caso de paginación tardía); **14 casos únicos**, sin errores. SQL checker correcto. No validación integral/lint ni Android físico ni contenido autenticado tras Access. Las bases locales originales no se migraron. Captura sintética móvil `/tmp/alveo-video-types-mobile.png` inspeccionada: selector y etiquetas legibles, sin solapes con duración/visto/progreso.

Investigación posterior, sin cambios de runtime ni instalación: [YOUTUBE-JS.md](YOUTUBE-JS.md). No se probaron sus endpoints ni rendimiento en Workers.

## Dominio definitivo — despliegue anterior 21-10-2026

Publicado **https://alveo.rsenses.com**, versión `3754cf01-6da3-4ded-a5a3-47691cbce67c`. El dominio ya estaba asociado al Worker alveo y protegido por Access; se declaró en Wrangler, cambió APP_ORIGIN y se desactivaron workers.dev/previews. Misma D1/Queue/Cron y cuatro secretos presentes (solo nombres comprobados). Configuración respaldada antes del cambio; no cambios de políticas ni datos.

Checks dirigidos: build/typecheck 0, dry-run 0, cuatro tests OAuth (localhost y callback definitivo) correctos, tipos producción generados temporalmente, deploy correcto. Control plane confirma origen nuevo y workers.dev desactivado. Raíz, manifest, API sesión e inicio OAuth responden 302 hacia Access sin autenticar. No suite integral ni comprobación de OAuth autenticado: **usuario debe registrar https://alveo.rsenses.com/auth/google/callback en Google** y probar conexión/instalación. Cookies/instalaciones del dominio anterior no se transfieren; datos de cuenta sí se conservan en D1.

## Cola durable y PWA — despliegue anterior 21-10-2026

Publicado `b1c8c9c6-3550-4304-b16b-ec13145726fd`, mismo Worker/D1 y Access intacto. Cola `alveo-sync`, lote/concurrencia 1, Cron cada minuto y automática cada 12 h. Presupuesto app 2.600 envíos/día UTC. Migraciones 0005/0006 aplicadas; backups privados previos y copia de configuración con permisos restrictivos. No se activaron pagos ni se modificaron secretos/presets locales.

- Primera ejecución real finalizó `success/done`, versión de trabajo 663, cero intentos fallidos; 113 canales y una lista que necesitaba reimportarse en la automática. Metadata privada completada para 2.497 registros; los no disponibles se retiran, no se inventan detalles. La automática no fuerza los elementos de las 43 listas si siguen recientes; el botón sí fuerza su importación.
- Presupuesto contabilizado: 665 envíos/reservas ese día. No es una medición de consumo total D1/YouTube/Queues de toda la cuenta ni una garantía de cuota.
- Después del último deploy: 1.774 estados de reproducción, cuatro actualizados durante la ejecución, FK sin infracciones y cuatro índices de retención presentes. Lecturas de comprobación no cambiaron datos. Raíz, manifest y SW anónimos siguen respondiendo 302 hacia Access.
- Cancelación y limpieza al borrar/desconectar incluyen trabajos, metadata privada y caché propia. Inserciones privadas comprueban cuenta activa para no resucitar datos ante respuestas tardías. El sondeo se detiene al desconectar o navegar.
- `npm run typecheck`, salida 0. `npm exec vitest -- run tests/queue-sync.test.ts tests/d1-sync.test.ts tests/backend-sync.test.ts tests/backend-oauth.test.ts tests/youtube-write.test.ts`: **34 correctas**. Incluyen duplicados, publicación pendiente, Cron, presupuesto, snapshots incompletos, separación por cuenta, revocación/borrado y planes SQL con índices. El caso legacy de 113 canales superó inicialmente el plazo de test de 5 s y contaminó mocks posteriores; se dio 30 s a ese caso completo y la reejecución fue correcta. No se ampliaron límites del Worker.
- `npm run test:ui -- tests/sync-queue.spec.ts tests/browser.spec.ts tests/feed.spec.ts`: **8 correctas**, con build. Incluyen un solo POST para encolar, progreso desde servidor, parada al navegar, pausa, player directo y feed 18. Proveedores simulados, sin usar la API key real.
- `npm run build` y deploy, salida 0. JS ~308 KB / 96,5 KB gzip. No validación integral fix/lint/todas las suites.

### Instalación PWA: Brave frente a Chrome

El usuario instala desde **Brave Android**. Manifest válido (`id/scope /`, `start_url /feed`, `standalone`) e iconos PNG decodificados 192/512. El SW registra y no cachea API/OAuth. CDP en un perfil Chrome normal temporal devuelve **cero errores de instalabilidad** localmente. El contexto aislado estándar de Playwright devuelve `in-incognito`; se usa además el perfil normal para no confundir una limitación del harness con la aplicación.

Existe un [reporte abierto coincidente en Brave](https://github.com/brave/brave-browser/issues/56133). No demuestra la causa en la versión/dispositivo del usuario: probar Chrome Android después de pasar Access. No se han abierto rutas públicas ni cambiado políticas. Si Chrome también falla, investigar la descarga autenticada real del manifest/iconos antes de proponer excepciones limitadas de Access; requieren autorización.

Pendientes: instalación/reproducción/rotación en Android físico; pareja tras permitir su correo en Access y Google Testing; consumo diario prolongado, refresh/revocación reales y revisión de políticas. El agente no atravesó Access ni extrajo cookies/tokens del navegador.

## Embed directo, búsquedas opt-in y segunda cuenta — histórico anterior a Queue

Versión `f9af7b03-e569-4edf-8391-0e9bc297884e`, misma URL/Worker/D1, sin nuevos recursos ni cambios en Cloudflare Access. Configuración respaldada en `.ai/backups/20261021-003916/`.

- Embed directo, sin póster, botón previo, toolbar propia ni autoplay. Progreso/revisión manual y mismo iframe durante rotación conservados.
- Búsqueda YouTube por palabras del título, sin restringir canal, con filtro de embebibles, cuatro candidatos en Free y caché pública de IDs 1 h. No son recomendaciones personalizadas. Cerrada al abrir/recargar/cambiar de vídeo; sin peticiones de sugerencias antes de pulsar «Cargar vídeos relacionados». Ocultar retira tarjetas.
- OAuth identifica por canal verificado y ya no reutiliza una cuenta distinta del mismo navegador. Identidad ausente falla sin enlazar ni reemplazar tokens. Pruebas con dos cuentas verifican listas ajenas 404, feed propio incluso siguiendo el canal de la otra, estados separados y metadatos privados de listas no legibles por terceros. Metadatos públicos se comparten solo cuando proceden de RSS/descubrimiento público o verificación por API key; la caché pública no contiene estados personales.
- Suscripciones Free: ocho por página, cursor/generación conservados incluso ante fallo; solo se desactivan ausentes al completar snapshot. UI continúa pasos (máximo 500, se detiene al abandonar pantalla). Cron ordena cuentas por último paso RSS. Importación de listas YouTube Free y modelo completo de metadatos privados multiusuario siguen pendientes; no habilitarla sin resolver ese contrato.

Checks ejecutados: tipos (0), tres archivos Vitest dirigidos (20 correctos), cinco pruebas de navegador afectadas (correctas) y, tras el último texto UI, dos dirigidas de player/opt-in (correctas con build). Verifican cero búsquedas antes de clic, una al mostrar, ocultación y recarga cerrada; player sin autoplay, sin overlay y mismo iframe. Captura sintética Chrome `/tmp/alveo-direct-embed-mobile.png` inspeccionada. No suite integral/lint; no se usaron APIs YouTube reales en tests.

Deploy real correcto. La URL sigue protegida por Access; comprobación privada nueva tras Access y Android físico corresponde al usuario. Añadir pareja a Access y Google Testing si aplica, conectar su Google y pulsar Actualizar. Investigación sin código de gestos: [GESTOS-Y-LIMITES.md](GESTOS-Y-LIMITES.md).

## Beta remota publicada (evidencia inicial)

Publicada en **https://alveo.ruben-silva.workers.dev**, Worker/D1 `alveo`, D1 región WEUR. Versión vigente `2457f195-ed2a-4f82-8a44-def3824fe138`. Cron cada cinco minutos; no se activaron pagos. Configuración anterior respaldada en `.ai/backups/20261021-000354/`.

Migración: copia SQLite consistente de solo lectura y export selectivo privado; ensayo en SQLite con migraciones y FK correcto antes de importar. D1 remota nueva/vacía comprobada. Importó 8.782 sentencias, 40.211 filas escritas contando índices, 7,63 MB. Conteos remotos: 113 suscripciones, 43 listas, 2.705 elementos, 4.138 vídeos y cinco estados de reproducción. `PRAGMA foreign_key_check` vacío. Cero tokens OAuth importados; cuentas desconectadas y sesiones/nonce/leases excluidos. Las sesiones anónimas creadas después son de visitas/pruebas nuevas, no migradas. Secrets subidos directamente al Worker, con clave de cifrado nueva e independiente, sin mostrar valores.

Checks dirigidos ejecutados: `npm run build` y dry-run de Wrangler, salida 0; `npm exec vitest -- run tests/backend-sync.test.ts tests/d1-sync.test.ts` (14 correctos antes del nuevo test Free); nuevo test Free dirigido (uno correcto, diez omitidos) que verifica un canal por petición, nueve entradas, cursor de dos pasos, presupuesto ≤44 sentencias más seis de middleware y rechazo seguro de reimportación de listas. `npm run typecheck`, salida 0. `npm run test:ui -- --grep 'navegación|feed de 18'`: dos correctos con build. Deploy real correcto; última versión arranque 2 ms (no equivale a medición CPU de sincronización).

Pruebas HTTPS reales: raíz/manifest/SW 200, nombre Alveo y manifest standalone; API sesión 200/no-store con OAuth configurado; feed sin autenticar 401 y sin items; inicio OAuth 302 hacia Google con callback HTTPS exacto y PKCE S256. Chrome con viewport/touch móvil cargó Configuración, SW activo, sin excepciones JS ni overflow; captura `/tmp/alveo-production-mobile.png` inspeccionada.

Comprobación posterior: la URL empezó a responder 302 hacia Cloudflare Access (no se cambió ni desactivó esa protección). Los 200 y la captura anteriores son evidencia previa a ese control de acceso. Control plane confirmó los cuatro secrets presentes tras redeploy, sin leer sus valores. Se añadió `crossorigin=use-credentials` al enlace del manifest para cargarlo con cookies detrás de Access ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/crossorigin#web_manifest_with_credentials)); build y aserción del atributo compilado correctos, nuevo deploy correcto. Escaneo de 15 estáticos no encontró valores de credenciales. No se atravesó Access ni se verificó el manifiesto tras autenticarlo: requiere al usuario.

**Pendiente:** acceder primero por Cloudflare Access, añadir callback en Google y completar OAuth remoto, probar reproducción/instalación/rotación en Android físico y medir RSS autenticado real en Workers Free. No suite integral ni lint. Beta limita sincronización a RSS de un canal/nueve entradas por paso, Cron 5 minutos; reimportación privada de suscripciones/listas y renovación integral pendientes. Los datos importados quedan disponibles, no se certifica toda la integración por haber publicado el shell.

## Feed y cabecera

Feed ampliado a 18 por página, también al cargar más y cambiar filtros. Eliminado el estado duplicado de la cabecera; en escritorio se oculta esa franja y el contenido comienza arriba; en móvil se conserva el logo. `npm run typecheck` y `npm run test:ui -- tests/feed.spec.ts`: salida 0, una prueba de navegador dirigida con build Vite. Comprueba 18 → 36 tarjetas, cursor/filtros, cabecera móvil, sidebar/escritorio sin franja y posición real del título (<40 px). Captura `/tmp/alveo-feed-18-desktop.png` inspeccionada. No suite integral, lint ni Android físico.

## Alveo, greige y vino

Nombre elegido por el usuario: **Alveo**, sin acento. Actualizados wordmark, textos propios, título HTML, manifest, nombre npm y etiquetas de fixtures. No se cambió la geometría del logo. Se conservaron los nombres/IDs internos de D1 y presets locales para no mover datos. Colores: greige claro `#F3F0EB`, vino `#8A263B` y neutros oscuros cálidos. Iconos PNG/SVG recoloreados; namespace del SW Alveo con limpieza de caches Cauce y manifest versionado.

Checks dirigidos: `npm run typecheck` y `npm run test:ui -- --grep navegación`, salida 0 (una prueba, build Vite incluido). El test verifica claro/oscuro/sistema y actualización de `theme-color` al cambiar la preferencia del sistema. Contraste calculado: primario claro 8,33:1, texto secundario claro 4,99:1, primario oscuro 7,74:1 y secundario oscuro 8,64:1. Chrome confirmó título/manifest Alveo, wordmark `alveo.` y acento vino, sin cambiar el símbolo. Captura `/tmp/alveo-greige-vino.png` inspeccionada. No se ejecutaron suite integral ni lint para este ajuste visual.

Preflight remoto **solo de lectura** autorizado posteriormente: Wrangler autenticado, una cuenta; subdominio `ruben-silva.workers.dev`; Worker/D1 llamados `alveo` no existentes. No se ha desplegado ni creado ningún recurso remoto. La consulta de suscripciones/facturación devolvió 403; plan Workers desconocido, pendiente de decisión del usuario antes del despliegue. El pedido posterior de despliegue sustituye la restricción inicial de desarrollo exclusivamente local; aún no se ha ejecutado.

## Estado de la fase local: cuenta real, feed completo e interfaz tipo Android

Esta sección sustituye los pendientes de credenciales/importación de las etapas históricas de abajo. El usuario configuró sus credenciales y completó Google OAuth en su navegador. Se arrancó únicamente el preset real local; no se modificó `.dev.vars`, no se compartieron cookies/tokens y no se creó infraestructura remota.

### Integración real observada

- OAuth de solo lectura: inicio HTTP 302, callback local correcto, state y PKCE S256. Tras autorización confirmada por el usuario, D1 registró una cuenta conectada y **113 suscripciones reales**.
- Se detectó y reprodujo con un test el fallo del primer lote RSS: antes solo procesaba cinco canales y marcaba éxito. Ahora recorre lotes de cinco peticiones concurrentes con límite de trabajo/cursor y estados parciales honestos, incluido backoff.
- Las 44 entradas inicialmente descartadas no estaban necesariamente incompletas: la muestra inspeccionada tenía vídeos válidos de propietarios distintos del canal del feed. Migración **0004_video_discoveries.sql** aplicada a D1 real y demo locales. La procedencia se separa de la autoría; el feed, filtro por canal y marcado masivo incluyen esas relaciones sin duplicar vídeos ni atribuirlos al canal equivocado.
- Última pasada RSS real: **113 canales revisados, 1.658 publicaciones procesadas, 0 pendientes, 0 errores, 0 descartes y estado success**. D1 contiene **1.769 vídeos para el feed**; los seis primeros pertenecen a cuatro propietarios distintos. No es el histórico completo de YouTube.
- Importación por lotes de listas reales terminada: **43 listas, 0 pendientes y 2.705 elementos locales**, coincidiendo con el total de elementos reportado por los resúmenes de YouTube. Se verificaron solo lecturas, no CRUD destructivo remoto.
- La ruta de invocación local verificada es `/cdn-cgi/local/scheduled?cron=rss` o `cron=playlists`. `/__scheduled` devolvía el HTML de la SPA pese a mencionar esa ruta la ayuda; HTTP 200 por sí solo no certifica ejecución. Los resultados anteriores se comprobaron en `sync_runs` y en los consumidores SQL de D1, no solo por el estado HTTP.

### UI y checks dirigidos

- Interfaz simplificada a Feed, Canales, Listas y Configuración, sin textos de landing. Barra móvil de 60 px, navegación inferior de 64 px, etiquetas de 12 px y controles táctiles legibles. Estado parcial/error nunca se anuncia como éxito.
- Inspección visual propia en Chrome con API sintética (sin acceder a la sesión privada del usuario): 390×844 sin overflow, cuatro tarjetas y navegación visible; escritorio 1280×900 con un único shell/header/sidebar y un único logo visible, sin overflow. Se incluyeron títulos cortos/largos. Capturas locales `/tmp/cauce-android-mobile.png` y `/tmp/cauce-android-desktop-clean.png`.
- `npm run typecheck`: salida 0.
- `npm exec vitest run -- tests/d1-sync.test.ts tests/backend-sync.test.ts tests/rss.test.ts`: **19 pruebas dirigidas correctas** en tres archivos. Regresión con 113 suscripciones, máximo cinco peticiones RSS concurrentes, listado de canales sin corte en cien, repetición sin duplicados, propietario diferente con procedencia/filtro correctos, marcado masivo y error/backoff parcial. También verifica que un lote de listas no se presenta como importación completa mientras queden listas pendientes.
- `npm run test:sql`: salida 0; incluye todas las migraciones versionadas.
- `npm run test:ui`: **cuatro pruebas correctas**, salida 0, con build Vite ejecutado como parte del comando. Incluye comentarios bajo demanda y la conservación de identidad del iframe durante rotación ida/vuelta después del rediseño.
- Además se ejecutaron los siete tests dirigidos de OAuth/sincronización antes de la autorización interactiva; salida 0.

No se ejecutó lint ni una validación integral de publicación. Pendientes: Android físico/standalone, refresh y revocación reales, escrituras en YouTube con consentimiento adicional, casos por encima de los caps de snapshots y revisión completa de retención/aislamiento. No se certifica preparación para producción.

## Histórico: lecturas públicas reales con API key

El usuario configuró `YOUTUBE_API_KEY` por su cuenta. No se modificó `.dev.vars` ni se imprimió su valor. El modo demo con clave ahora usa datos públicos reales; sin clave conserva las fixtures y no contacta con YouTube automáticamente.

Comprobado en esta ampliación:

- `npm run db:migrate`: migración **0003_public_read_cache.sql** aplicada solo a D1 local, salida 0. Caché pública de IDs, sin tokens ni comentarios persistidos.
- `npm run typecheck` y `npm run build`: salida 0.
- `npm exec vitest run -- tests/d1-sync.test.ts tests/backend.test.ts tests/youtube-write.test.ts`: **29 checks dirigidos correctos** en tres archivos, salida 0. Nuevos casos de API key por cabecera sin token OAuth/clave en URL, metadatos reales simulados, caché de sugerencias, preservación del estado manual, comentarios/respuestas con cursores y rechazo de clave sin inventar datos.
- `npm run test:sql`: salida 0, incluyendo la nueva migración.
- `npm run test:ui`: **cuatro tests correctos**, salida 0. El nuevo verifica procedencia de sugerencias, comentarios/respuestas/paginación y fallback de avatar fallido. Las credenciales reales están desactivadas explícitamente para esta suite y todas las respuestas públicas de ese test están simuladas.
- **YouTube Data API real, sin OAuth:** metadatos de `aqz-KE-bpKQ` con título oficial y canal Blender, 20 comentarios por relevancia, siguiente página con otros 20 y un hilo con 20 respuestas y cursor adicional. Todos HTTP 200. El endpoint de sugerencias devolvió seis vídeos reales de la lista de subidas del mismo canal (cinco tarjetas visibles). No se utilizó búsqueda, scraping ni el antiguo endpoint de relacionados.
- **Chrome contra el preview real:** título oficial, 20 comentarios, cinco tarjetas reales y 20 respuestas anidadas renderizadas; sin errores JS. Inspección visual a 1440 px y 390 px. No hay overflow horizontal a 390 px. Se observó un avatar externo fallido y se añadió fallback a inicial, también comprobado con test de navegador.
- Comprobación programática sin mostrar secretos: clave **ausente del bundle cliente y de la respuesta de sesión**. `capabilities.publicData` expone únicamente un booleano. Preview local HTTP 200.

No se ejecutó lint ni una validación integral de producción. La validación de OAuth/cuenta privada, Android físico y las revisiones completas de políticas/aislamiento siguen pendientes. No se desplegó ni creó ningún recurso remoto.

## Histórico: ajuste de comentarios solo bajo demanda

Comentarios cerrados por defecto, incluso con API key u OAuth disponibles. `npm run typecheck` y `npm run test:ui`: salida 0, cuatro pruebas correctas; el test público ahora verifica cero consultas antes del clic, carga posterior y estado cerrado al recargar. El build de Vite se ejecutó como parte de `test:ui`.

Comprobación adicional en Chrome contra el preview real: antes del clic, **0 peticiones / 0 comentarios**; al pulsar «Cargar comentarios», **1 petición / 20 comentarios reales**; al recargar, sigue habiendo una sola petición acumulada y vuelve a **0 comentarios visibles**. No se ejecutaron lint ni la suite integral para este ajuste de interfaz. OAuth sigue pendiente: se comprobó únicamente la presencia de sus tres variables, todas ausentes, sin mostrar secretos.

## Ejecución inicial (histórica)

- `npm install` / actualización del lockfile: dependencias instaladas. Se sustituyó la primera selección de Vitest por una versión actual después de que npm notificase vulnerabilidades; el último análisis de instalación informa **0 vulnerabilidades conocidas**. No equivale a una auditoría de seguridad.
- `npm run types`: tipos de bindings/runtime generados por Wrangler 4.151.3. No consulta ni crea una base remota. Se retiró el paquete de tipos de Workers redundante.
- `npm run setup`, repetido: migraciones 0001 y 0002 y seed aplicados a **D1 local** correctamente; persistencia en `.wrangler/state`.
- `npm run typecheck`: salida 0.
- `npm exec vitest run -- tests/backend.test.ts tests/backend-oauth.test.ts tests/backend-sync.test.ts tests/rss.test.ts tests/d1-sync.test.ts tests/youtube-write.test.ts`: **38 pruebas correctas en seis archivos**, salida 0. Cubren validación HTTP/CSRF, cifrado/state, parsing Atom, cuotas de tamaño, deduplicación D1, prioridad manual, preservación de suscripciones tras error de segunda página, reconciliación completa y preservación de idioma/privacidad de listas al editar. Las llamadas externas están simuladas.
- `npm run test:sql`: salida 0. Migraciones, seed repetido, filtros/keyset, estados, retención, listas, constraints, leases y cascadas en SQLite. Esta prueba por sí sola no ejecuta el Worker.
- `npm run build`: salida 0; TypeScript y Vite 8.3.4. Assets JS ~303 KB / ~95 KB gzip; CSS ~29 KB / ~7 KB gzip. No incluye descargar el player externo, que se carga solo bajo acción del usuario.
- `npm run test:ui`: **tres pruebas de navegador correctas**, salida 0, Chrome instalado con Playwright, base D1 de prueba separada y servidor local 5174. Verifican navegación móvil, ausencia de overflow horizontal a 390 px, CRUD de listas y persistencia tras recarga, tema, rechazo sin CSRF, player opt-in, progreso guardado, identidad del mismo iframe durante ida/vuelta de orientación, no uso automático de fullscreen y SW sin caché de API/OAuth. La IFrame API está simulada en esta suite.
- Inspección visual de capturas en Chrome a 1440 px, móvil 390×844 y horizontal 844×390: feed y vista de vídeo legibles; vídeo horizontal ocupa exactamente la ventana, sin navegación propia. La revisión automatizada no reemplaza accesibilidad con lector de pantalla.
- **Reproducción real externa**: se pulsó reproducir para Big Buck Bunny en Chrome headless con viewport/touch móvil, tanto en Vite como en el preview compilado con CSP. Se cargó un iframe oficial y se observaron fotogramas de vídeo en reproducción y progreso persistido, sin avisos del player ni errores JS/CSP. No se usó OAuth ni YouTube Data API.
- **Reinicio real del backend**: posición persistida de Big Buck Bunny 8,75 segundos antes de detener el servidor; después de arrancar `npm run preview`, la API devolvió los mismos 8,75 segundos, HTTP 200.
- Preview compilado: ruta SPA de vídeo HTTP 200, `Referrer-Policy: strict-origin-when-cross-origin` y CSP presentes. Tras la reproducción real, viewport del player horizontal `{x:0,y:0,width:844,height:390}`.

## Pendientes de la primera etapa (histórico; ver estado actual arriba)

- OAuth con una cuenta Google real, refresh/revocación reales y sincronización con suscripciones/listas/comentarios de esa cuenta: **faltan credenciales configuradas por el usuario**. Los tests de cifrado/state no sustituyen ese flujo completo.
- Feed RSS real y disponibilidad actual de canales específicos; parser/fallos con fixtures no garantizan disponibilidad externa.
- PWA instalada en Android físico, rotación del dispositivo, barras del sistema, autoplay, fullscreen nativo, accesibilidad asistiva y comportamiento con diferentes navegadores.
- Pruebas prolongadas, cuotas de una cuenta real, reconciliación de todas las carreras multiventana y límites superiores de paginación: ver README. No hay pruebas exhaustivas de cada operación remota.
- Revisión completa de retención por campo, políticas/branding y autorización para publicación; aislamiento de metadatos privados para múltiples cuentas.
- No hay lint configurado ni se ha ejecutado una validación integral fix/lint/tests de publicación. Se formatearon los archivos fuente nuevos con Prettier y se ejecutaron los checks dirigidos indicados.
- **Ningún deploy, creación de recursos remotos ni cambio de configuración Cloudflare existente.** No se ejecutaron login, creación de D1, secretos remotos ni túneles.

## Servidor dejado disponible

Está activo `npm run preview:real -- --test-scheduled` en **http://localhost:5173**, solo loopback. API y D1 son locales; Google/YouTube se consultan para OAuth y las lecturas autorizadas. Registro local `/tmp/cauce-real-preview.log`, PID de arranque `/tmp/cauce-real-preview.pid`. No compartir cookies ni tokens para comprobar la sesión; las verificaciones del agente usaron contadores de D1 y tareas locales, no la extracción de la sesión del navegador del usuario. Si el proceso termina, volver a arrancar con el comando del README.
