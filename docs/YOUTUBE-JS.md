# YouTube.js: investigación para Alveo

Fecha: 21-10-2026. Investigación documental **después de terminar y publicar tipos de vídeo y estado de edición**. No se instaló el paquete, no se hicieron llamadas InnerTube, no se importaron cookies/tokens ni se cambió la fuente actual de relacionados.

## Conclusión

**Para relacionados encaja técnicamente bastante mejor que la búsqueda actual por título.** Expone el feed contextual de la página de reproducción de YouTube. No garantiza los mismos resultados que youtube.com con tu cuenta. No recomiendo sustituir directamente el backend oficial: antes hay que resolver el encaje con las condiciones de YouTube y verificar viabilidad real en Workers Free.

Repositorio LuanRT/YouTube.js; paquete npm `youtubei.js`, licencia MIT. Versión publicada consultada: **18.2.0, 18-10-2026**. La licencia del código no autoriza por sí misma el acceso a datos/servicios de YouTube. [1][2]

**Actualización posterior:** el usuario eligió mejorar la búsqueda oficial en lugar de integrar esta librería. Alveo ya prioriza etiquetas útiles con alternativa por título/hashtags (versión 54375013); la comparación con la búsqueda antigua de este informe es histórica. No se ha autorizado ni ejecutado prueba InnerTube.

## 1. Relacionados: qué cambia realmente

En el código de la versión revisada:

- `Innertube.getInfo(videoId)` solicita `/player` y `/next`; la inicialización puede añadir llamadas.
- `VideoInfo.watch_next_feed` contiene nodos del feed de la página de reproducción.
- `filters` y `selectFilter()` permiten cambiar los filtros que YouTube devuelve.
- `wn_has_continuation` y `getWatchNextContinuation()` permiten obtener páginas siguientes. Esta última modifica el objeto/feed existente: nuestra UI necesitaría normalizar y crear listas nuevas. [3][4]

Esto cambia la **fuente** de candidatos: no son coincidencias de palabras del título. Mi valoración es que responde mejor a lo que se busca para Alveo, pero la relevancia necesita evaluación real con vídeos variados.

No confundir tres cosas:

1. Relacionados contextuales de un vídeo sin autenticar.
2. Resultados adaptados a idioma, región o visitante anónimo.
3. Recomendaciones de tu cuenta Google con su historial.

La documentación permite configurar idioma/región y `visitor_data`; esto no equivale a estar autenticado con tu cuenta. No hay garantía de reproducir exactamente la lista que ves en la web. [5]

Los resultados son nodos de UI, no nuestra lista `Video[]`: habría que admitir variantes de nodos, reconocer vídeos frente a listas/otros contenidos, deduplicar, excluir el vídeo actual y conservar procedencia. No se deben tratar como metadata pública verificada por la API oficial ni escribirlos indiscriminadamente sobre las copias privadas existentes.

## 2. En qué más podría ayudar

| Posibilidad | Evidencia en 18.2.0 | Valor potencial / límites para Alveo |
| --- | --- | --- |
| Capítulos | `MultiMarkersPlayerBar.markers_map`, `Chapter` con título y tiempo | Navegar a puntos concretos mediante el iframe oficial; solo si YouTube devuelve capítulos. |
| Transcripción | `MediaInfo.getTranscript()` | Leer o buscar texto y saltar a un momento; no todos los vídeos disponen de transcripción. |
| Canales y tipos reales | `Channel.getVideos()`, `getShorts()`, `getLiveStreams()`, continuaciones | Explorar el catálogo más allá del RSS y reconocer contenido de la sección Shorts. No prueba un detector universal por ID ni sustituye la heurística <3 min que pediste. |
| Búsqueda y sugerencias | `search()`, `getSearchSuggestions()` | Autocompletado y exploración; hoy no justifica por sí solo reemplazar las lecturas oficiales. |
| Comentarios y chat | `getComments()`, `VideoInfo.getLiveChat()` | Chat de emisiones y variantes de comentarios; exigiría demanda explícita, límites y estados de disponibilidad. |
| Historial y biblioteca | `getHistory()`, `getLibrary()`, feeds de suscripciones/notificaciones | Funciones interesantes pero vinculadas a autenticación compatible; no quedan habilitadas con el OAuth actual por instalar el paquete. |

Fuentes de métodos y tipos: [3][4][6][7][8]. Es una valoración de posibilidades, **no funciones probadas en Alveo**. Priorizaría relacionados, capítulos y transcripción; dejaría biblioteca personal y chat para después.

No usaría sus utilidades de descarga/formatos para reemplazar el iframe, eliminar publicidad ni montar un reproductor alternativo. Ese no es el objetivo autorizado de Alveo.

## 3. Autenticación y privacidad

La guía actual recomienda cookies para la mayoría de clientes web y limita OAuth2 al cliente YouTube TV. **No asumir que los tokens OAuth web de Alveo sirven en InnerTube.** No es una ampliación del botón «Permitir edición»: son mecanismos distintos. [9]

No propongo copiar cookies de tu navegador, reutilizar una sesión personal global ni pedir credenciales en el chat. Si se contemplase personalización futura, requeriría otra decisión explícita y aislamiento por persona, incluyendo caché/perfiles de visitante. Para una exploración inicial, limitarse a contenido público y sesiones anónimas sería más conservador, pero no resuelve las condiciones de uso.

## 4. Cloudflare Workers Free: soporte no equivale a viabilidad verificada

El paquete exporta `youtubei.js/cf-worker` y contiene adaptación para ese runtime. Eso es evidencia de intención de soporte, no una prueba de funcionamiento de nuestra carga. [2][10]

Precauciones verificadas en el código:

- El adaptador usa `cache.match(key)` / `cache.put(key, ...)`; `Session` utiliza la clave desnuda `innertube_session_data`. Hay un informe de ese problema de URL en la caché de Workers (versión antigua), y el patrón continúa en el código revisado. No dar por bueno `UniversalCache` sin comprobarlo/adaptarlo; también puede desactivarse la caché de sesión de la biblioteca. [10][11][12]
- `retrieve_player: false` evita descargar el JavaScript del player, útil para reducir inicialización si solo interesa metadata/relacionados. No elimina las dos llamadas internas de `getInfo`. [3][5]
- El evaluador por defecto lanza un error para descifrar URLs. No habría que añadir un evaluador para descargar streams: esa función queda fuera del alcance. [13]
- Workers Free tiene **10 ms de CPU por petición HTTP**. El tiempo de red no cuenta como CPU, pero parsear respuestas y cargar la librería sí requiere medición. La Queue actual no elimina ese límite ni garantiza que este parser quepa. [14]

Sin mediciones de bundle, arranque, CPU, memoria, latencia, volumen de respuestas y bloqueos desde las IP de Cloudflare, no afirmar que funcionará gratis ni que basta con instalar el paquete.

## 5. Fragilidad y condiciones de uso

InnerTube es una API interna, no la API pública soportada para integraciones externas. Los cambios del sitio pueden exigir actualizaciones de parsers/clientes. Hay, por ejemplo, un informe histórico de `LOGIN_REQUIRED`/detección de bots en `/player`; está cerrado y afecta a una versión anterior: no demuestra que 18.2.0 falle hoy ni que vaya a funcionar desde nuestro Worker. [15]

**Bloqueo de adopción, no detalle secundario:** las políticas para clientes de YouTube API prohíben el scraping directo/indirecto y el uso de otras tecnologías para acceder a API Data. Alveo utiliza API oficial e iframe; incorporar InnerTube plantea un riesgo importante de incompatibilidad con esas condiciones. No se ha confirmado autorización de YouTube ni cumplimiento. No presentar MIT o acceso anónimo como permiso para hacerlo. [16]

## 6. Siguiente paso propuesto, sin implementar

Primero decidir si se acepta continuar la evaluación de un backend no oficial y aclarar el encaje con las condiciones. Si procede, autorizar una prueba **aislada**, no un reemplazo en producción:

1. Versión fijada y contenido público, sin cookies, OAuth personal ni cambios de reproducción.
2. Comparar varios vídeos/idiomas: relevancia, duplicados, ausencia de resultados y continuaciones. No prometer recomendaciones personales.
3. Usar solo bajo «Cargar relacionados», con límite de candidatos, normalización, caché breve apropiadamente separada y fallo explícito; no disfrazar una búsqueda por título de relacionados de YouTube.
4. Probar compatibilidad y caché en Workers, luego medir CPU/errores en el runtime real dentro del Free; no activar pagos ni añadir servicios/proxies para superar bloqueos.
5. Mantener API oficial/OAuth/sincronización y embed actuales. Si no es viable o no encaja con las condiciones, no integrar.

**Estado:** investigación completada; prueba de concepto, instalación e integración no autorizadas ni ejecutadas. No hacen falta tests de aplicación para este documento; los checks del cambio publicado están en VALIDACION.md.

## Fuentes

[1] https://github.com/LuanRT/YouTube.js/releases/tag/v18.2.0
[2] https://github.com/LuanRT/YouTube.js/blob/v18.2.0/package.json
[3] https://github.com/LuanRT/YouTube.js/blob/v18.2.0/src/Innertube.ts
[4] https://github.com/LuanRT/YouTube.js/blob/v18.2.0/src/parser/youtube/VideoInfo.ts
[5] https://ytjs.dev/guide/getting-started
[6] https://github.com/LuanRT/YouTube.js/blob/v18.2.0/src/core/mixins/MediaInfo.ts
[7] https://github.com/LuanRT/YouTube.js/blob/v18.2.0/src/parser/youtube/Channel.ts
[8] https://github.com/LuanRT/YouTube.js/blob/v18.2.0/src/parser/classes/MultiMarkersPlayerBar.ts y https://github.com/LuanRT/YouTube.js/blob/v18.2.0/src/parser/classes/Chapter.ts
[9] https://ytjs.dev/guide/authentication
[10] https://github.com/LuanRT/YouTube.js/blob/v18.2.0/src/platform/cf-worker.ts
[11] https://github.com/LuanRT/YouTube.js/blob/v18.2.0/src/core/Session.ts
[12] https://github.com/LuanRT/YouTube.js/issues/714
[13] https://github.com/LuanRT/YouTube.js/blob/v18.2.0/src/platform/jsruntime/default.ts
[14] https://developers.cloudflare.com/workers/platform/limits/
[15] https://github.com/LuanRT/YouTube.js/issues/1119
[16] https://developers.google.com/youtube/terms/developer-policies
