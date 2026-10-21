# Alveo

Una PWA personal para seguir canales de YouTube a tu ritmo. React + TypeScript + Vite, un Worker y D1. Entorno local separado y **beta publicada en https://alveo.rsenses.com**.

## Beta Android publicada

La URL está protegida por **Cloudflare Access**: pasa primero ese acceso; su configuración no se ha desactivado. El manifest usa cookies para poder cargarse tras autenticación.

Abre **https://alveo.rsenses.com** en Chrome Android, pasa Access y usa «Instalar aplicación»/«Añadir a pantalla de inicio». Se necesita Internet. Versión publicada: `f62c344c-20e9-4352-b085-49002751e586` (optimización D1/KV y listas manuales). Comprobada localmente; falta verificación autenticada tras el restablecimiento de D1 y aplicar migraciones pendientes con `npm run setup`.

El manifest declara `standalone`, identidad/scope `/`, inicio `/feed` e iconos PNG 192/512. Chrome con perfil normal temporal devuelve cero errores de instalabilidad en la prueba local. Brave Android tiene un [reporte coincidente de instalación como acceso directo](https://github.com/brave/brave-browser/issues/56133): probar primero Chrome, sin desactivar Access. No se ha certificado la instalación en un teléfono ni el manifest autenticado remoto.

En el cliente web de Google OAuth añade este **URI de redirección autorizado** exacto:

```text
https://alveo.rsenses.com/auth/google/callback
```

Añade ese callback al cliente OAuth en Google Cloud antes de conectar (su alta no se puede hacer desde este repositorio). La dirección temporal workers.dev está desactivada. Al cambiar de origen tendrás que entrar de nuevo y reinstalar la PWA desde el dominio definitivo; las cuentas y datos D1 se conservan. Conserva el callback localhost si sigues usando el entorno local. Después acepta privacidad y conecta Google desde Configuración usando la misma cuenta de YouTube. La cuenta se identifica por su canal y recupera los datos importados. Si el proyecto Google está en modo Testing, tu usuario debe seguir en su lista de usuarios de prueba.

**Alcance de esta beta:** datos iniciales copiados selectivamente de local, sin sesiones ni tokens. Se migraron también los estados de reproducción: tras la primera sincronización remota completa hay 1.774, incluidas cuatro actualizaciones durante el trabajo. OAuth remoto y una ejecución real de la cola se han comprobado. No existe réplica bidireccional: local y remoto son independientes. Android físico y segunda persona siguen pendientes.

**Sincronización durable para Free:** Cloudflare Queue `alveo-sync` despierta pasos pequeños; D1 conserva estado, cursores, leases y progreso. «Actualizar» hace un solo POST e inicia la actualización incremental; continúa al cerrar la pantalla. La UI consulta el progreso sin dirigir el trabajo. Suscripciones/resúmenes/elementos de listas se paginan, RSS procesa todas las entradas devueltas por el feed sin recorte artificial y los metadatos se renuevan por bloques. RSS no proporciona el histórico completo de un canal. Solo se reconcilian snapshots completos; errores conservan los datos previos.

El Cron cada minuto recupera trabajos y publicaciones pendientes; inicia una sincronización automática por cuenta cada **12 horas**. La automática descubre novedades desde la última sincronización correcta, sin margen fijo de 24 h, y renueva directos/programados pendientes y metadata próxima a caducar. También importa IDs RSS desconocidos aunque su publicación sea antigua. No actualiza listas: «Actualizar catálogo de YouTube» descubre sus nombres; dentro de cada lista, «Actualizar desde YouTube» importa solamente sus elementos y metadata necesaria. Las locales no hacen llamadas externas. Un mensaje/concurrencia 1 y presupuesto global de **2.600 envíos al día**; pausa hasta el siguiente día UTC al agotarlo. No garantiza todas las cuotas de la cuenta: reintentos, D1 y YouTube tienen límites propios. El máximo de 50 consultas D1 es **por invocación**, no diario. Índices de retención evitan escaneos completos en cada sondeo. No se borran Shorts ni se activaron pagos. Sugerencias bajo demanda limitadas a cuatro candidatos nuevos por consulta.

Caché KV opcional de 60 s para feed y catálogo, aislada por cuenta y con invalidación por generación D1; el progreso se recupera de D1 en cada hit. No guarda tokens ni sustituye la autenticación. Si KV falla, se consulta D1. Ver mediciones y límites en [D1-PERFORMANCE.md](docs/D1-PERFORMANCE.md).

Configuración remota canónica: `wrangler.jsonc` (`wrangler.production.jsonc` es un alias); presets locales e IDs anteriores conservados. Worker `alveo`, D1 `alveo` (WEUR). Actualizar código/estáticos, preservando secrets existentes:

```sh
npm run setup  # migraciones remotas; no seed ni reimportación
npm run build
npx wrangler deploy
```

Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_API_KEY` y clave de cifrado exclusiva de producción. No copiarlos a código, logs ni argumentos. Backups/export selectivo y material privado están bajo `.ai/private/` (ignorado, permisos restrictivos). `scripts/prepare-bootstrap.py` prepara INSERT de datos para una D1 **vacía y ya migrada**, no una sincronización continua ni un reemplazo de una base activa.

### Acceso de otra persona

Añade su correo a la política de **Cloudflare Access** y, si Google OAuth sigue en Testing, a sus usuarios de prueba. Cada persona conecta su cuenta Google y pulsa «Actualizar» para importar sus propias suscripciones. Las cuentas se identifican por su canal YouTube; cambiar de usuario en el mismo navegador no reasigna datos anteriores. Si no se puede verificar esa identidad, OAuth falla sin enlazar una cuenta por aproximación. Listas y estados propios se filtran por cuenta; metadatos públicos/caché de búsquedas pueden compartirse. Vídeos importados de listas que no se hayan verificado como públicos solo son legibles por su propietario.

La nueva cuenta puede importar sus propias listas YouTube mediante la cola. La metadata OAuth privada vive en `account_video_metadata`; no sobrescribe la metadata pública compartida. Desconectar/borrar cancela trabajos y elimina sus copias privadas; respuestas tardías no deben reinsertarlas. Dos cuentas se han probado con respuestas simuladas, no con la pareja real. Ambas comparten el presupuesto gratuito, por lo que los trabajos pueden pausarse.

## Probar en local

Necesitas Node 22.12+, 24 o 26 (comprobado con 26.12) y npm. Se usa el Wrangler del proyecto, no el global.

```sh
npm install
npm run setup:local
npm run dev
```

Abre **http://localhost:5173**. No alternes entre localhost y 127.0.0.1: las cookies dependen del host. El frontend usa 5173 y la API local 8787; ambos escuchan exclusivamente en loopback.

**Para probar el vídeo directamente:** http://localhost:5173/watch/aqz-KE-bpKQ

Al abrir un vídeo real se carga directamente el embed oficial de YouTube, sin póster ni botón propios ni reproducción automática. Sus controles nativos inician la reproducción, que no necesita OAuth ni consume por sí misma cuota de Data API. Puede haber publicidad y restricciones de YouTube. Sin API key, los datos, canales y miniaturas son ficticios; tres IDs enlazan a ejemplos reproducibles y los otros tres vídeos son solo ejemplos de organización. Con API key local, se activan metadatos, comentarios y vídeos públicos reales (ver abajo); esas lecturas sí consumen cuota.

Para ver la versión compilada, con Service Worker e instalación PWA:

```sh
# Detener npm run dev antes: utiliza el mismo puerto.
npm run preview
```

`dev` y `preview` generan los estáticos automáticamente antes de arrancar. `dev` tiene recarga en caliente; en `preview` reinicia el comando para recompilar cambios.

### Qué puedes hacer sin credenciales

- Navegar por Feed, Canales, Listas y Configuración, con enlaces propios y Atrás del navegador.
- Filtrar pendientes/todos/vistos y canales, y cargar el feed por páginas.
- Marcar vídeos individualmente, todos los de tus suscripciones, por canal o antes de una fecha.
- Gestionar suscripciones ficticias, crear/editar/eliminar listas locales, añadir y retirar vídeos.
- Reproducir los ejemplos reales, cambiar velocidad, usar controles nativos y abrir YouTube.
- Guardar posición y estado propio en D1; el marcado manual tiene prioridad. El umbral predeterminado es 90 %, configurable.
- Usar tema claro, oscuro o del sistema.

Los cambios persisten en `.wrangler/state/`. El seed es repetible y no sobrescribe preferencias, estados ni ediciones existentes. Repetirlo sí repone fixtures que se hayan eliminado. No elimines ese directorio si quieres conservar la base.

## Interfaz

Feed de **18 vídeos por página**, con carga incremental. Selector múltiple de tipos: Vídeos y Directos activos inicialmente, Shorts desactivado. El filtro se aplica en D1 antes de paginar y queda en la URL. Miniaturas con `live` solo para `liveBroadcastContent=live` de YouTube (no programados/finalizados) y `short` para duración conocida mayor de cero y menor de 180 s, con prioridad del directo. Es una heurística de duración, no reconocimiento del formato oficial Shorts; duración desconocida/cero se trata como vídeo. No se borra contenido. El estado live refleja la última metadata disponible; Actualizar vuelve a consultar directos/programados con datos de más de cinco minutos, no hay seguimiento en tiempo real.

Configuración muestra «Edición autorizada» o «Edición no autorizada» según los permisos de la sesión; solo ofrece «Permitir edición en YouTube» si la cuenta está conectada y falta el permiso. No comprueba revocaciones externas en tiempo real. En escritorio, el estado de conexión aparece solo en el sidebar, sin una cabecera vacía. En móvil se conserva la barra del logo.

Interfaz compacta de estilo app Android: barra superior de 60 px, navegación inferior fija de 64 px en móvil, etiquetas legibles y controles táctiles de al menos 44 px. Paleta clara greige `#F3F0EB` y vino tinto `#8A263B`, con variante oscura cálida y contraste legible. Nombre visible y PWA: **Alveo**; símbolo del logo conservado. Pantallas con títulos directos, sin introducciones grandes ni mensajes decorativos. Tema claro, oscuro o del sistema. El estado de sincronización distingue éxito, parcial, error y ausencia de cambios, con contadores legibles.

## Vídeo y rotación

En vertical, el player queda arriba, seguido de información, acciones, descripción desplegable, comentarios y sugerencias de la biblioteca.

En horizontal móvil, CSS hace que **el mismo iframe** ocupe la ventana y oculta nuestra navegación. No se solicita fullscreen automáticamente ni se bloquea la orientación. Al volver a vertical reaparece la interfaz sin reconstruir el iframe. Se respetan los controles y la publicidad de YouTube. El botón de fullscreen es explícito.

Comprobado en Chrome de escritorio con viewport/touch móvil y reproducción externa real. **Pendiente probar en Android físico instalado**, incluidos controles nativos, barras del sistema, ajustes de rotación y políticas de autoplay del dispositivo. La inmersión CSS no garantiza ocultar barras Android.

El progreso se guarda aproximadamente cada cinco segundos mientras se reproduce y al pausar/finalizar cuando el player lo notifica. No se marca visto al abrir ni al abrir externamente. El porcentaje es posición relativa, no una medición de segundos consumidos: saltar hasta el umbral puede marcarlo visto. Directos, estrenos o vídeos sin estado VOD confirmado no se marcan automáticamente. Un cierre brusco o cambiar de página puede perder los últimos segundos no enviados.

### Android sin infraestructura remota

Una IP de la LAN servida por HTTP no es un contexto seguro para PWA. Alternativa sin túneles: Android con depuración USB y ADB ya configurado:

```sh
adb reverse tcp:5173 tcp:5173
```

Con `npm run preview` abierto, visita `http://localhost:5173` en Chrome Android y usa su opción de instalación/añadir a inicio. Solo se reenvía el puerto web: la API se atiende en ese mismo origen. No hace falta exponer Wrangler en la LAN. No se ha instalado ni configurado ADB, certificados o dispositivos desde este proyecto.

El SW cachea únicamente el shell y estáticos propios; no OAuth, API personal, imágenes externas ni vídeo. **No hay modo offline completo**: D1 necesita la API remota disponible o, en el entorno local, su servidor en marcha. La reproducción y Google también requieren Internet.

## Contenido público real, sin OAuth

Si `.dev.vars` contiene `YOUTUBE_API_KEY`, el modo demo pasa a consultar contenido público real. La clave se envía exclusivamente desde el Worker, en una cabecera a Google; nunca llega al navegador ni se incorpora al bundle.

```dotenv
# Archivo local ignorado por Git; no sobrescribas otras variables.
YOUTUBE_API_KEY="tu_clave"
```

Reinicia `npm run preview` o `npm run dev` al cambiar credenciales. No hace falta cambiar ningún preset Wrangler ni conectar tu cuenta.

- Las tres muestras reproducibles se completan con título, canal, miniatura, descripción, fecha, duración y estadísticas reales. Los otros vídeos ficticios quedan fuera de esta vista pública. Los canales de las muestras se siguen **solo localmente** para alimentar el feed; no se crea ninguna suscripción en YouTube. El marcado y las listas locales se conservan.
- La página de vídeo muestra **comentarios reales**, inicialmente por relevancia, con autor, fecha, likes, paginación y respuestas paginadas. Están cerrados por defecto y solo se consultan al pulsar «Cargar comentarios»; no se almacenan permanentemente.
- «Cargar vídeos relacionados» usa etiquetas útiles (`snippet.tags`) como primera búsqueda temática; elimina promoción, palabras genéricas y marca del canal, y prioriza etiquetas que coinciden con el título. Si faltan etiquetas útiles, usa palabras del título y hashtags de descripción. Si la consulta por etiquetas no da candidatos, prueba una alternativa (máximo dos búsquedas por fallo de caché). No restringe al mismo canal. No es el feed interno de relacionados de YouTube. Solo consulta al pulsar; al entrar/recargar/cambiar de vídeo sigue cerrado. Tags/metadata del vídeo origen se consultan por API key solo al faltar caché; no se persisten tags privados. Caché de IDs de una hora, compartida únicamente para consultas construidas con metadata pública verificada; si se utiliza contexto privado queda por propietario y no se reinserta tras desconectar. Estados de reproducción individuales. Free conserva máximo cuatro candidatos; sin resultados no inventa tarjetas. Sin scraping, YouTube.js ni dependencias nuevas.
- Metadatos completos e índices de candidatos tienen caché de una hora en D1. Las lecturas consumen cuota de YouTube; las escrituras y guardados de la demo siguen siendo locales. Sin clave, se mantiene el modo ficticio sin peticiones externas automáticas.
- Los tests de navegador fuerzan una clave vacía: **nunca usan tu clave real ni gastan su cuota**, aunque exista `.dev.vars`. Los tests de comentarios usan respuestas simuladas; se ha verificado además la API pública real por separado.

No compartas la clave. Restringe su API a YouTube Data API v3; no uses restricciones de referente web para llamadas de este backend. Configurar acceso público no permite importar suscripciones/listas privadas ni editar YouTube: eso sigue requiriendo OAuth.

Fuentes: [credenciales](https://developers.google.com/youtube/registering_an_application), [comentarios](https://developers.google.com/youtube/data/reference/rest/v3/commentThreads/list), [subidas del canal](https://developers.google.com/youtube/data/reference/rest/v3/channels), [uso de API keys](https://docs.cloud.google.com/docs/authentication/api-keys-use).

## Modo real: Google y YouTube, no Cloudflare remoto

La conexión OAuth de lectura y la importación de suscripciones, RSS y listas **ya se han comprobado con una cuenta real**. El consentimiento en Google lo realiza el usuario en su navegador. Las llamadas salen del ordenador a Google/YouTube; la aplicación y D1 siguen locales. No se han probado escrituras contra la cuenta real ni revocaciones destructivas.

1. En tu proyecto de **Google Cloud**, habilita YouTube Data API v3 y configura consentimiento OAuth, usuarios de prueba y un cliente **aplicación web**. Este paso crea/configura credenciales externas de Google; no lo ejecutamos automáticamente. Si no quieres crear ningún recurso externo, permanece en demo.
2. Registra exactamente el redirect URI `http://localhost:5173/auth/google/callback`.
3. Edita **manualmente** `.dev.vars` y añade `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `TOKEN_ENCRYPTION_KEY`, **sin sobrescribir el archivo ni retirar tu `YOUTUBE_API_KEY`**. Solo si el archivo no existe, puedes crearlo tomando `.dev.vars.example` como referencia. No nos compartas el archivo. Para la clave usa 32 bytes criptográficamente aleatorios codificados en base64 (por ejemplo `openssl rand -base64 32`, ejecutado tú, sin pegar su salida en el chat). Conservar la clave permite descifrar tokens existentes; perderla obliga a reconectar.
4. Detén el modo demo y ejecuta:

```sh
npm run setup:real
npm run dev:real
# O, para instalar/probar con estáticos y SW:
# npm run preview:real
```

5. En Configuración, lee/acepta la información de privacidad, conecta con Google y pulsa Actualizar. Suscripciones y RSS alimentarán el feed. La importación de listas se hace en lotes; revisa las limitaciones abajo.
6. Para modificar YouTube, pulsa «Permitir edición en YouTube». El scope inicial es `youtube.readonly`; la autorización adicional usa `youtube.force-ssl`, más amplia que solo listas porque YouTube no ofrece un permiso limitado a nuestras operaciones.

Los dos presets Wrangler usan IDs **ficticios** de D1 diferentes. No identifican recursos remotos ni deben reutilizarse para desplegar. `remote:false` y todos los comandos de datos usan `--local`. El modo real no recibe seed, y su base no comparte datos con la demo. Las sesiones también se separan por modo; cambiar de modo en el mismo host puede requerir reconectar.

Tokens exclusivamente backend, cifrados AES-GCM, state de un uso ligado a sesión y PKCE. Mutaciones protegidas con cookie HttpOnly, SameSite, origen y CSRF. No hay variables `VITE_*` con credenciales. Revocar/desconectar y borrar datos están en Configuración; no borran listas ni suscripciones en YouTube. Si la revocación remota falla, los datos locales se eliminan igualmente; revoca también desde los permisos de Google.

En OAuth externo en Testing, los refresh tokens para permisos de YouTube normalmente caducan a los siete días. Puede ser necesario reconectar. Este prototipo no está aprobado/verificado para publicación por Google.

### Sincronización local

El botón Actualizar separa suscripciones, RSS, listas y mantenimiento. Los endpoints también permiten escoger `subscriptions`, `rss` o `playlists`, con sesión y CSRF. Se registran ejecuciones y errores; la demo registra un **no-op explícito**, no un éxito externo ficticio.

Hay un handler `scheduled` compartido con la sincronización manual. Con `npm run dev:real`, la versión fijada de Wrangler permite invocarlo localmente:

```sh
# IMPORTANTE: en modo real hace peticiones externas y puede consumir cuota.
curl 'http://localhost:8787/cdn-cgi/local/scheduled?cron=rss'
# También cron=playlists o cron=all. Son invocaciones del depurador local.
# En preview, arranca npm run preview:real -- --test-scheduled y usa el puerto 5173.
```

La ruta verificada en Wrangler 4.151.3 es `/cdn-cgi/local/scheduled`; la ayuda aún menciona `/__scheduled`, pero en este proyecto esa ruta devuelve el HTML de la SPA y **no ejecuta** el trabajo. Las expresiones Cron normales ejecutan el pipeline completo; los nombres `rss`, `playlists` y `all` permiten seleccionar un trabajo desde el depurador local.

El entorno local no tiene programador permanente: un ordenador apagado no sincroniza. La producción sí tiene Queue y Cron cada minuto, independientes del teléfono. No recrear recursos ni reimportar la base inicial sobre la base activa.

## Límites de esta prueba de concepto

- **No es un MVP de producción terminado.** Están comprobados el flujo local, reproductor, lecturas públicas, login OAuth e importación real de suscripciones/listas y RSS. Siguen pendientes Android físico, validación de refresh/revocación reales, escrituras consentidas en YouTube y revisión completa de políticas/aislamiento.
- **Beta privada tras Access**, no un servicio público de registro abierto. Estados, listas y metadata OAuth privada están separados por cuenta; solo se comparte metadata pública verificada. La revisión OAuth/políticas y la prueba de otra persona siguen pendientes.
- **Solo backend local sin Queue:** los snapshots parciales no causan bajas masivas. Las ejecuciones tienen límites: hasta 500 suscripciones, 250 resúmenes de listas, tres listas a importar por pasada y 500 elementos por lista. RSS procesa lotes de cinco canales en paralelo, con cursor entre lotes y hasta 150 canales / presupuesto de 45 segundos por invocación. Si quedan canales, errores en espera o entradas inválidas, se indica estado parcial; ya no se da por completo al terminar solo el primer lote. Los vídeos cuyo propietario difiere del canal del feed se conservan mediante `video_discoveries`, sin cambiar su autor real. La lista de canales tampoco se trunca silenciosamente en cien. **Las listas aún reinician desde la primera página**: listas por encima de sus límites necesitan ampliar la reanudación antes de usarlas en serio. En el perfil Free las suscripciones sí mantienen cursor/generación entre páginas. No se promete importar todo repitiendo el botón en esos casos.
- En el backend local sin Queue, las listas ya importadas se refrescan por lotes con intervalo de seis horas. Sus títulos y bajas se reconcilian con el snapshot completo; los elementos pueden tardar en reflejar cambios externos. La UI carga actualmente todos los elementos locales de una lista; falta paginar listas grandes.
- La importación remota usa Queue durable y leases; las escrituras a YouTube no tienen serialización/idempotencia exhaustiva. Se preservan cambios recientes en reconciliaciones principales. No se da por resuelto todo conflicto multiventana/remoto ni los timeouts de escrituras. Ante una inserción incierta, comprueba YouTube y sincroniza antes de reintentar: repetirla puede crear duplicados válidos.
- Los detalles de un vídeo se completan al abrirlo, con caché de una hora y fallback D1 si falla YouTube. Comentarios y respuestas se consultan bajo demanda, sin archivo persistente. Se muestran errores de comentarios deshabilitados, permisos y cuota, no comentarios inventados. No se publican comentarios ni se vota.
- Los metadatos de vídeos/canales tienen vencimiento, mantenimiento y purga antes de servir datos; los detalles completos tienen vigencia separada para que RSS no prolongue estadísticas antiguas. Las listas remotas no renovadas se eliminan a los 30 días. **Falta una revisión completa de retención por campo y de detección de revocación externa** antes de uso prolongado/publicación; no afirmar cumplimiento por tener un TTL. Un feed RSS no acredita el histórico completo ni la eliminación de un vídeo.
- Sin clave, sugerencias desde D1; con clave, búsqueda pública bajo botón y caché, no recomendaciones personalizadas de YouTube. No se promete controlar las sugerencias internas del iframe.
- Sin scraping, descarga, streams alternativos, historial de YouTube, Ver más tarde oficial, IA ni push. Los guardados locales no son Ver más tarde de YouTube.

Documentación y fuentes oficiales: [docs/ANALISIS.md](docs/ANALISIS.md).

## Pruebas y estructura

```sh
npm run typecheck
npm run test:sql
npm test
npm run test:ui
```

`test:ui` compila estáticos y usa **Chrome instalado** mediante Playwright. Se puede escoger otro canal con `PLAYWRIGHT_CHANNEL`; no instala navegadores automáticamente. Usa el puerto 5174 y una D1 separada en `.wrangler/ui-state`, nunca tu base de demo o real. Sus pruebas del player simulan la IFrame API para verificar identidad del iframe/rotación/progreso sin peticiones externas; no prueban por sí solas reproducción real. Los tests D1 usan Miniflare en memoria y respuestas externas simuladas.

- `src/`: interfaz, rutas, cliente API y player.
- `worker/`: HTTP, D1, OAuth, YouTube, Atom y sincronización.
- `migrations/`: SQL versionado; `fixtures/`: datos ficticios.
- `public/`: recursos locales, manifest, iconos y SW.
- `worker-configuration.d.ts`: generado con `npm run types`; regenerar tras cambios en bindings. Los secretos opcionales se declaran solo en backend.

Evidencia de las comprobaciones realizadas y de lo pendiente: [docs/VALIDACION.md](docs/VALIDACION.md).
