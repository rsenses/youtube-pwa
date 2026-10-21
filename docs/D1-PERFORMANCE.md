# Lecturas D1 y caché

## Diagnóstico y medición local

Las analíticas remotas de últimas 24 h mostraron consultas del feed con medias de 208.452–287.142 filas leídas por ejecución. No se han ejecutado más consultas SQL remotas durante el bloqueo de cuota. La copia offline no tenía metadata expirada: no hay evidencia de que la purga fuera la causa principal de este incidente.

El plan de la consulta correlacionada podía recorrer las suscripciones por cada vídeo ajeno al feed. El join discovery-first con CROSS JOIN fija el orden de búsqueda: primero comprueba el vídeo en discoveries y luego la suscripción concreta. No cambia el conjunto de vídeos accesibles.

Reproducción sintética con Miniflare/D1 real, 4.496 vídeos, 113 suscripciones, 43 listas y 2.673 elementos:

| Caso | Filas leídas |
| --- | ---: |
| Consulta original, sin estados de visionado | 319.446 |
| Alternativa IN no correlacionada, sin estados | 9.151 |
| Consulta final discovery-first, con 1.774 estados | 2.952 |
| Hit del feed KV, con generación y progreso fresco | 37 |
| Catálogo sin KV | 8.147 |
| Sugerencias locales | 5.438 |

Las cifras son locales, no una certificación del consumo total de producción. El caso de KV usa un namespace simulado con D1 real; no mide propagación ni tasa de aciertos de KV en Cloudflare. Autenticación, mantenimiento, otras rutas y otros usuarios añaden lecturas. Ejecutar `npm run profile:d1` para repetir el perfil; sus umbrales cubren feed y hits, no el presupuesto completo de la cuenta.

## Caché y consistencia

- KV READ_CACHE, Free, TTL 60 s. Feed y catálogo por cuenta, consulta y generación; payload validado y sin credenciales.
- D1 sigue siendo la fuente durable de permisos, suscripciones, trabajos y estados de visionado. La autenticación nunca se salta. La caché no permite usar la aplicación durante el bloqueo de D1.
- El progreso se hidrata al leer un feed cacheado. Los cambios de pertenencia/filtros, mutaciones y fin de sincronización invalidan su generación. Tras borrar/reconectar se crea una generación aleatoria para no resucitar snapshots antiguos.
- La purga que cambia datos invalida las generaciones existentes. La migración 0009 usa índices parciales para que filas ya purgadas o con detalles borrados no sigan en el rango de retención.
- KV tiene consistencia eventual y límites Free propios; un miss o fallo vuelve a D1. No se cachean sesiones, tokens, permisos ni leases. No se usa Cache API detrás de Access.
- Sondeos de estado, sesión y ajustes no ejecutan la purga. Las listas se importan solo explícitamente, no en la sincronización general/cron de producción.

## Pendiente remoto

Worker optimizado publicado como `f62c344c-20e9-4352-b085-49002751e586`, con binding KV verificado por Wrangler. 83 pruebas dirigidas de backend/caché/cola/API, una prueba móvil de listas, chequeo SQL, typecheck y build/postbuild correctos; no se ejecutó la suite completa. La cuota D1 agotada se restablece a las 00:00 UTC. Las migraciones 0008/0009 no se han aplicado remotamente; el código se comprueba también sobre esquema 0007, sin depender de nuevas columnas. Tras el restablecimiento: `npm run setup`, `npm run build`, `npx wrangler deploy`. Confirmar con sesión autenticada, cabecera `x-alveo-cache`, estados de visionado y analíticas de filas. Workers Free y Cloudflare Access se conservan; no se han activado pagos.

Referencias: [precios D1](https://developers.cloudflare.com/d1/platform/pricing/), [precios KV](https://developers.cloudflare.com/kv/platform/pricing/), [consistencia KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
