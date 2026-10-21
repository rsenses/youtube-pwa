# Análisis técnico y arquitectura propuesta

Estado: diseño inicial conservado como referencia, con documentación consultada el 20-10-2026. La prueba de concepto local ya está implementada: estado real, desviaciones y límites en [README.md](../README.md); comprobaciones en [VALIDACION.md](VALIDACION.md). Ningún recurso remoto creado. Las propuestas siguientes no equivalen a aceptación de todos los incrementos.

Verificación adicional durante implementación: update/delete de listas, delete de elementos y delete de suscripciones admiten `youtube.force-ssl` [15]. `playlists.update` reemplaza campos mutables de la parte enviada: la implementación preserva `snippet.defaultLanguage`, envía título/descripción y no incluye `status` al renombrar, para no modificar privacidad.

## Límites verificados

- **Cloudflare local:** Wrangler ejecuta Workers y D1 locales; D1 persiste entre ejecuciones. Aplicar SQL y migraciones siempre con `--local`. No necesitamos crear una D1 remota para empezar [1]. No configurar bindings remotos, IDs de cuenta ni scripts de deploy.
- **OAuth:** flujo de servidor con código de autorización, `state` aleatorio de un solo uso ligado al navegador, callback registrado exactamente y acceso offline para sincronización. Los tokens quedan exclusivamente en backend. En proyectos OAuth externos en Testing los refresh tokens con permisos de YouTube expiran normalmente a los siete días [2]. Configurar credenciales y usuarios de prueba requiere Google Cloud: es un requisito externo, no infraestructura Cloudflare ni algo que este proyecto creará automáticamente. La futura publicación puede necesitar verificación de Google.
- **Permisos:** comenzar con `youtube.readonly` al implementar lecturas; solicitar autorización incremental de `youtube.force-ssl` al habilitar escrituras. No hay scope exclusivo para editar solamente nuestras listas: los permisos admitidos por los endpoints de escritura son más amplios. `subscriptions.insert` y `playlists.insert` admiten force-ssl [3]. Verificar también los métodos concretos de update/delete antes de implementarlos; no anticipar permisos para funciones aún inexistentes.
- **Suscripciones:** `subscriptions.list?mine=true` requiere autorización y permite recuperar las suscripciones de la cuenta [4]. Guardar el ID de la suscripción (distinto del ID del canal), necesario para su eliminación. Paginar hasta finalizar antes de considerar ausencias como bajas.
- **Listas:** la API dispone de recursos playlists y playlistItems. Guardar IDs de elementos: un vídeo puede aparecer repetido en una lista. No deduplicar elementos por vídeo. `playlistItems.list` declara expresamente que no permite acceder a Ver más tarde ni al historial [5]. Guardados locales no se presentarán como esa lista de YouTube.
- **RSS/Atom:** la guía oficial documenta feeds Atom de canales como temas de notificaciones; no garantiza histórico completo, SLA ni una ventana fija. Incluso la ruta documentada incluye `/xml/feeds/`, diferente de la URL pública propuesta [6]. El polling se implementará verificando respuesta y estructura reales, sin scraping ni asumir disponibilidad permanente. No implementaremos webhooks ni push en el MVP. La ausencia de un vídeo en un feed no demuestra que haya sido eliminado.
- **Cuota:** lecturas habituales cuestan 1 unidad y muchas escrituras 50; cada página consume una petición. La tabla vigente distingue cupos específicos para algunos métodos: no asumir que absolutamente todo usa una única bolsa diaria [7]. Evitar `search.list` para resolver URLs con IDs de canal; no prometer resolución de cualquier handle sin una consulta oficial apropiada.
- **Comentarios:** `commentThreads.list` pagina hilos, puede devolver `commentsDisabled` y no garantiza incluir todas las respuestas. Recuperar respuestas con `comments.list?parentId=...`, también paginadas [8]. Pedir texto plano; renderizar texto, no HTML externo. No confundir error de permisos o cuota con lista vacía.
- **Player:** la IFrame API expone posición, duración, eventos y velocidades disponibles [9]. La duración puede no estar disponible al inicio; en directos tiene otra semántica. No inferir visto al abrir, por autoplay fallido o al abrir YouTube externamente. Manejar vídeos no disponibles y embedding prohibido. El error 153 indica falta de Referer o identificación equivalente. Conservar `strict-origin-when-cross-origin`, proporcionar `origin` y no suprimir Referer [10]. No tapar controles, anuncios, enlaces ni recomendaciones internas del player.
- **Rotación:** conservar un único iframe; modificar su contenedor con CSS landscape y `100dvh`, ocultando solo nuestra interfaz secundaria. Aplicar inmersión solo a la vista de reproducción y preferentemente a dispositivos móviles. Fullscreen nativo requiere activación del usuario; orientation lock tiene soporte y restricciones dependientes del contexto [11]. No bloquear orientación en manifest. Standalone no equivale a fullscreen nativo ni garantiza esconder barras Android.
- **PWA local en Android:** service workers necesitan contexto seguro; localhost es excepción, una IP LAN por HTTP no lo es [12]. Para pruebas físicas usar reenvío USB de puertos con localhost o HTTPS local configurado expresamente; no crear túneles remotos ni modificar certificados/sistema automáticamente.

## Datos y cumplimiento

Las políticas requieren actualizar o borrar las categorías relevantes de metadatos almacenados a más tardar a los 30 días; las excepciones para determinados datos autorizados no convierten todos los datos en archivables. Revocación y solicitud de borrado requieren eliminación de los datos correspondientes cuanto antes y dentro de siete días [13].

Propuesta conservadora: refrescar metadatos antes del límite (objetivo 25 días), conservar fecha de procedencia y de verificación, y purgar metadatos vencidos si falla la renovación. Un fallo breve no vacía el feed, pero no se promete disponibilidad indefinida de metadatos caducados. Los estados propios, referencias mínimas y guardados deben distinguirse de las copias de datos de YouTube; revisar su retención según procedencia y consentimiento. La desconexión ofrecerá revocación y borrado de datos de cuenta, no solo borrar una cookie. Comentarios con caché corta, no archivo permanente.

Las políticas también restringen recrear experiencias principales sin valor independiente significativo [13]. El enfoque propuesto es una herramienta de organización personal (pendientes, marcado masivo, listas y cronología predecible), no un clon ni un servicio sin anuncios. Esto es una justificación de diseño, **no una aprobación de YouTube ni una garantía jurídica**. Debe revisarse antes de publicar. RSS no se usará para eludir políticas de la API. Mostrar atribución YouTube, enlaces, términos y privacidad; distinguir acciones locales de escrituras en YouTube. El progreso será estado personal de esta app, nunca historial ni analítica oficial de YouTube.

## Arquitectura pequeña

Un repositorio, un paquete npm, TypeScript en frontend y backend. React + Vite + React Router; CSS propio, sin framework visual. Worker con routing HTTP pequeño, consultas preparadas D1 y validación explícita. Parser XML mantenido para Atom; no regex como parser. Vitest para comportamiento y pruebas SQL/integración dirigidas. Fijar versiones y lockfile tras comprobar Node y Wrangler instalados. Sin ORM, Redux, colas, Durable Objects ni framework empresarial.

```text
src/                    React, rutas, componentes, cliente API, estilos
worker/index.ts         fetch, scheduled, routing y errores HTTP
worker/db.ts            consultas D1
worker/youtube.ts       OAuth/API oficial (solo backend)
worker/rss.ts           lectura y validación Atom
worker/sync.ts          lotes, reconciliación, leases y mantenimiento
shared/                 tipos de contratos HTTP, sin secretos
migrations/             SQL numerado
fixtures/               SQL y respuestas ficticias de prueba
public/                 manifest, iconos, service worker
scripts/                comandos locales y comprobaciones dirigidas
docs/                   ejecución, decisiones y limitaciones
wrangler.local.jsonc    configuración nueva exclusivamente local
```

Desarrollo: Vite en loopback con proxy `/api` y `/auth` a Wrangler local. Misma procedencia para el navegador y cookies. Preview local: assets compilados servidos por el Worker con fallback SPA, preservando 404 JSON en `/api`. No configurar ni modificar recursos Cloudflare existentes. Secrets solo en archivo local ignorado; crear únicamente una plantilla sin valores. Cualquier edición de configuración sensible existente requiere backup y aprobación.

### Esquema D1 previsto

Crear tablas según el incremento que las necesite, no simular integraciones todavía pendientes. Timestamps UTC y constraints/índices explícitos.

| Tabla | Contenido y claves principales |
|---|---|
| accounts | ID interno, canal propio YouTube, modo demo/real, estado de conexión |
| oauth_tokens | cuenta, tokens cifrados AES-GCM, nonce aleatorio, scopes, expiración, versión de clave; clave fuera de D1 |
| sessions / oauth_attempts | hashes de secretos de sesión/state, expiración, cuenta y vínculo al navegador; state de un solo uso |
| channels | ID YouTube único, nombre, imagen, descripción, fetched_at, expires_at, disponibilidad |
| subscriptions | cuenta+canal únicos, ID remoto, activa, generación de sincronización, última verificación |
| videos | ID YouTube único, canal, publicación, metadatos renovables, duración nullable, discovered_at, fetched_at, expires_at, disponibilidad |
| video_discoveries | Implementada en migración 0004: vídeo+canal de descubrimiento y last_seen_at. Un feed puede contener vídeos de otro propietario; se conservan ambas identidades sin duplicar el vídeo. |
| watch_states | cuenta+vídeo, visto, viewed_at, posición, porcentaje, marcado manual, updated_at/revisión |
| playlists | ID interno, cuenta, origen local/YouTube, ID remoto único por cuenta, título, descripción, privacidad, fetched_at |
| playlist_items | ID interno, lista, ID remoto de elemento, vídeo, posición; permitir repeticiones |
| preferences | cuenta, tema y umbral validado |
| sync_state / sync_runs | cuenta/tipo/recurso, cursor, próxima ejecución, lease con propietario y vencimiento, intento/error resumido, contadores y fechas |

Separar estados propios de metadatos renovables; la renovación no sobrescribe visto/pendiente. No usar cascadas que eliminen accidentalmente estados al refrescar metadatos. Índices de feed por fecha e ID, canal+fecha, estados por cuenta, elementos por lista+posición, trabajos por próxima ejecución.

### Contrato HTTP propuesto

Todas las rutas personales se resuelven por sesión; nunca confiar en account_id aportado por el cliente.

- `GET /api/session`, `GET/PATCH /api/settings`.
- `GET /api/feed?status=pending|all|watched&channelId=&cursor=&limit=`: keyset `(published_at,id)` descendente, límite máximo.
- `GET /api/videos/:id`, `PUT /api/videos/:id/watch-state`, `PUT /api/videos/:id/progress`.
- `POST /api/watch-state/bulk`: todos, canal o anteriores a fecha, con corte temporal explícito para no marcar descubrimientos posteriores.
- `GET /api/channels`, `GET /api/channels/:id/videos`.
- `POST /api/subscriptions`, `DELETE /api/subscriptions/:channelId`: acciones expresas sobre YouTube, no cambios locales fingidos.
- `GET/POST /api/playlists`, `GET/PATCH/DELETE /api/playlists/:id`.
- `GET/POST /api/playlists/:id/items`, `DELETE /api/playlists/:id/items/:itemId`.
- `GET /api/videos/:id/comments`, `GET /api/comments/:id/replies`, ambos paginados bajo demanda.
- `GET /api/videos/:id/suggestions`: contenido conocido de D1, reglas explícitas, sin recomendaciones personalizadas de YouTube.
- `POST /api/sync` (tipo validado), `GET /api/sync/status`.
- `/auth/google/start`, `/auth/google/callback`, `POST /auth/logout`, `POST /api/account/disconnect`, `DELETE /api/account/data`.

Errores JSON consistentes; distinguir 401, 403, validación, conflicto y fallo externo. Mutaciones requieren origen válido, sesión, token CSRF y JSON; cookies HttpOnly, SameSite y Secure salvo loopback HTTP explícito. CORS cerrado. Validar IDs, tamaños, cursores, URLs y pertenencia de listas/elementos. No aceptar URLs arbitrarias para RSS (prevención SSRF). Nunca registrar códigos OAuth, tokens, cookies ni descripciones de error externas sin sanear.

### Sincronización

1. Jobs separados para suscripciones, listas, RSS, metadatos y mantenimiento. Comentarios no entran en cron.
2. Lease adquirido atómicamente en D1 por cuenta/tipo, con vencimiento y comprobación del propietario al renovar o liberar. Rechazar ejecución duplicada; no mantener transacciones abiertas durante fetch externo.
3. Paginación y lotes acotados con checkpoint; completar snapshots antes de reconciliar bajas. Error a mitad no borra datos ni simula éxito. Evitar reconciliación contra snapshots anteriores a una escritura concurrente mediante revisión/generación.
4. RSS con timeout, tamaño máximo, validación XML, campos obligatorios y origen; hasta pocas peticiones concurrentes. ETag/Last-Modified si existen. Upsert por vídeo; ausencia no borra histórico. Backoff para 429/5xx, errores por canal y cursor persistido.
5. API `videos.list` en lotes para renovación, duración y disponibilidad cuando proceda. No sobrescribir campos buenos con valores ausentes de un feed parcial.
6. Escrituras: primero operación remota y luego actualización/reconciliación local. No reintentar ciegamente inserts tras timeout ambiguo; verificar estado remoto y mostrar incertidumbre. UI diferencia sincronización pendiente de éxito confirmado.
7. Handler `scheduled` comparte implementación con actualización manual. Su invocación local depende de la versión instalada: la documentación actual muestra `/cdn-cgi/local/scheduled`; versiones anteriores usan `--test-scheduled` y `/__scheduled`. Verificar ayuda instalada antes de fijar comandos [14]. Sin prometer ejecución periódica automática en local con el ordenador apagado.
8. Mantenimiento de expiraciones se ejecuta también antes de servir metadatos: la política no puede depender solo de un cron futuro.

### Datos de prueba y experiencia

Modo demo predeterminado: fixtures ficticias en D1 local, no un array que reemplace persistencia. Operaciones de listas, visto y filtros reales sobre esa D1; sin peticiones externas automáticas, thumbnails locales y sin OAuth necesario. El player externo requiere acción explícita y explicación. Pruebas de API/RSS con respuestas almacenadas; nunca gastar cuota para pasar tests.

Separar demo y real en bases/directorios persistentes distintos; no mezclar sus datos ni habilitar modo demo en un despliegue futuro por accidente. La UI muestra claramente el modo y las capacidades implementadas.

Rutas `/feed`, `/channels`, `/channels/:id`, `/playlists`, `/playlists/:id`, `/settings`, `/watch/:id`. Navegación inferior móvil, foco visible, tema claro/oscuro, estados vacíos/error, carga incremental y Atrás nativo.

Visto automático: solo con datos válidos de reproducción; nunca al montar iframe. Marcado manual prevalece sobre eventos atrasados (revisión de estado). Definir y explicar el porcentaje como posición relativa, no prueba de haber consumido todos los segundos; saltar al final no acredita tiempo visto. Directos o duración desconocida: marcado manual. Guardar progreso de forma espaciada y al pausar/finalizar cuando sea posible, sin prometer persistencia del último instante tras cierre brusco.

SW solo para shell y estáticos propios. No cachear OAuth, API personal, comentarios, imágenes externas ni contenido audiovisual. No prometer datos de D1 sin backend accesible.

## Incrementos y aceptación

1. **Base utilizable demo:** Vite/Worker/D1 local, migración y seed repetible no destructivo; cuatro rutas, feed persistente, filtros/paginación, marcas individuales y masivas, canales, guardados locales y ajustes. README con comandos locales. Ningún botón de integración finge sincronización.
2. **Player y PWA:** reproducción oficial opt-in, persistencia de progreso, errores, mismo iframe en rotación; manifest/iconos/SW y prueba manual Android pendiente hasta dispositivo disponible.
3. **OAuth y suscripciones reales:** sesiones, cifrado, CSRF, scopes incrementales, desconexión/borrado, paginación y reconciliación. Verificar con credenciales solo cuando el usuario las configure sin compartirlas.
4. **RSS y mantenimiento:** upsert idempotente, fallos parciales, leases y renovación/borrado de metadatos; ejecución local manual y scheduled.
5. **Listas de YouTube:** importación completa, CRUD y elementos, preservación de privacidad/campos, manejo de timeout ambiguo. Verificar RMF y contratos específicos update/delete antes de codificar.
6. **Detalles y comentarios:** caché limitada, paginación de hilos/respuestas, sugerencias D1, revisión UX/accesibilidad y documentación de límites reales.

Validación dirigida por incremento: persistencia tras reinicio, seed repetido, deduplicación RSS, snapshot incompleto sin bajas, duplicación de listas, errores externos, manual prevalece sobre progreso, CSRF/aislamiento y expiración de datos. No ejecutar suite completa automáticamente; documentar comandos y resultados efectivamente obtenidos. Sin validación OAuth real ni Android hasta disponer de credenciales/dispositivo.

## Fuentes

[1] https://developers.cloudflare.com/d1/best-practices/local-development/ y https://developers.cloudflare.com/workers/wrangler/commands/d1/
[2] https://developers.google.com/identity/protocols/oauth2/ y https://developers.google.com/identity/protocols/oauth2/web-server
[3] https://developers.google.com/youtube/data/reference/rest/v3/subscriptions/insert y https://developers.google.com/youtube/data/reference/rest/v3/playlists/insert
[4] https://developers.google.com/youtube/data/reference/rest/v3/subscriptions/list
[5] https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list
[6] https://developers.google.com/youtube/data/guides/push_notifications
[7] https://developers.google.com/youtube/data/determine_quota_cost
[8] https://developers.google.com/youtube/data/reference/rest/v3/commentThreads/list y https://developers.google.com/youtube/data/reference/rest/v3/comments/list
[9] https://developers.google.com/youtube/iframe_api_reference
[10] https://developers.google.com/youtube/terms/required-minimum-functionality
[11] https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen y https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock
[12] https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
[13] https://developers.google.com/youtube/terms/developer-policies y https://developers.google.com/youtube/terms/developer-policies-guide
[14] https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
[15] https://developers.google.com/youtube/data/reference/rest/v3/playlists/update ; https://developers.google.com/youtube/data/reference/rest/v3/playlists/delete ; https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/delete ; https://developers.google.com/youtube/data/reference/rest/v3/subscriptions/delete
