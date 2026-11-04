# Cola de reproducción local

## Decisión de autoplay

Se utiliza estado React y `YT.PlayerState.ENDED` (0) → `loadVideoById()` sobre el mismo `YT.Player` e iframe. El primer vídeo se prepara para iniciarlo manualmente con los controles oficiales. Los siguientes intentan reproducirse sin silenciar ni alterar el volumen elegido. Navegar, añadir, quitar, vaciar y reordenar no carga otro vídeo ni recrea el iframe.

Comparación basada en la API oficial, no en mediciones en Android:

- **React + loadVideoById:** permite editar los pendientes sin tocar la reproducción actual. Es la estrategia elegida por simplicidad y control de errores.
- **loadPlaylist:** YouTube gestiona la sucesión, pero la API documentada carga y reproduce la lista desde un índice/posición. No documenta una operación append/remove que conserve intacto el vídeo en reproducción. Reconstruirla con index/startSeconds supone recargar, no garantiza continuidad. No hay evidencia aquí de que sea más fiable en Android.
- **Ambas** pueden activar `onAutoplayBlocked`. Chrome documenta permisos para reproducción con sonido tras interacción y para sitios añadidos a inicio en móvil, y delegación mediante `allow="autoplay"`. No es una garantía universal ni una prueba de reproducción consecutiva real.

Fuentes consultadas:
- https://developers.google.com/youtube/iframe_api_reference (`loadVideoById`, `loadPlaylist`, eventos).
- https://developer.chrome.com/blog/autoplay (interacción, instalación y delegación).

## Comportamiento y límites

- Cola en memoria de la sesión: recargar o cerrar reproducción la descarta. Vaciar elimina solo pendientes, sin detener el actual.
- No se duplica un vídeo actual o pendiente. Puede añadirse otra vez una vez consumido. Seleccionar un pendiente conserva los demás; abrir manualmente otro vídeo también los conserva.
- «Añadir a la cola» está dentro del menú de la elipsis en el feed, canales y listas, sin añadir botones visibles a esas tarjetas. Las tarjetas sin ese menú mantienen su acción directa. No navega ni muestra toast. Sin actual, se prepara ese vídeo en el minirreproductor y se inicia manualmente.
- Los metadatos disponibles se reutilizan; no se consulta el endpoint de vídeo para los elementos añadidos. No hay tablas, endpoints, escrituras de listas ni sincronización nueva. El progreso conserva la cadencia existente (30 segundos y pausa/final); no marca vistos.
- Un error explícito de YouTube salta al siguiente pendiente. Si no quedan, muestra el error. Una transición sin respuesta durante 15 segundos muestra una acción manual; no descarta un vídeo por una conexión lenta. «Siguiente» permite continuar en cualquier momento.
- El bloqueo mantiene el elemento actual y ofrece «Continuar reproducción»; si Chrome sigue bloqueándolo, usar ▶ dentro del iframe. No hay reintentos automáticos ni estrategias para eludir las políticas.
- Se reutiliza el minirreproductor existente, ampliando el viewport a un mínimo de 200 × 200 requerido por YouTube. No se oculta el iframe al navegar ni se mueve entre nodos del DOM.
- No se promete reproducción con pantalla apagada, aplicación en segundo plano o navegador suspendido. Pantalla completa y restricciones del sistema dependen de Chrome/YouTube.

## Comprobaciones locales realizadas

- `npm run typecheck`: salida 0.
- `npx vitest run tests/playback.test.ts`: 4 tests aprobados (duplicados, avance protegido, orden, eliminación, selección y vaciado).
- `npx vite build`: salida 0. Mantiene un aviso de importación estática/dinámica de `worker/queue-sync.ts`, ajeno a esta cola de reproducción.
- `npx playwright test tests/playback.spec.ts tests/browser.spec.ts -g 'cola: mismo iframe|embed directo' --global-timeout=65000`: 2 tests aprobados, con API de YouTube simulada. Cubren primer vídeo sin autoplay, cola, avance, error, bloqueo, cambios manuales, navegación, rotación, progreso existente e identidad del iframe. La prueba de cola usa vídeos transitorios y comprueba cero peticiones `/api/videos/`.
- Inspección visual de la captura móvil del minirreproductor y la cola. La primera ejecución detectó controles fuera de pantalla por la altura fija heredada; se corrigió y se repitió la prueba satisfactoriamente.

No se ha ejecutado la suite completa ni reproducción real de YouTube. El servidor de pruebas usa únicamente D1 local de fixtures; no se han ejecutado migraciones ni operaciones remotas.

## Validación reproducible en Chrome Android

**Pendiente de dispositivo real.** Los tests con API simulada verifican el contrato de integración, no autoplay, sonido, decodificación ni políticas reales de YouTube.

1. Usar una instancia local accesible por HTTPS o `adb reverse tcp:5173 tcp:5173` y localhost (sin deploy). No desactivar políticas de autoplay. Para no tocar datos reales usar el modo demo local con vídeos reales embebibles o fixtures locales. No usar acciones de listas/cuenta reales.
2. Anotar Android, versión de Chrome, origen y modo (pestaña/PWA instalada). Repetir en pestaña y después de instalar la PWA; conservar el mismo origen para no mezclar permisos.
3. Abrir un vídeo real corto y pulsar ▶ en el iframe. Confirmar sonido; no silenciar como recurso para lograr autoplay.
4. Navegar al feed/canales/listas/búsqueda, añadir tres vídeos y abrir «Cola». Confirmar que el actual sigue con audio y posición continua. Reordenar/quitar y verificar que no interrumpe. Volver al vídeo actual.
5. Dejar que termine **naturalmente** (además de probar buscar cerca del final). El siguiente debe empezar con sonido sin tocar la pantalla. Repetir al menos tres transiciones, también desde el minirreproductor. Registrar cualquier `onAutoplayBlocked` mediante depuración remota de Chrome.
6. Con depuración remota, guardar una referencia al iframe (`window.queueFrame = document.querySelector('.youtube-host iframe')`) y comprobar tras navegación, rotación y transición que `window.queueFrame === document.querySelector('.youtube-host iframe')`. Verificar un solo iframe y una sola descarga de `iframe_api`.
7. Rotar vertical/horizontal, entrar y salir de pantalla completa con los controles oficiales. Confirmar continuidad, audio y recuperación manual visible al salir de fullscreen si se bloqueó. No recargar la página durante esta comprobación.
8. Si ocurre bloqueo, comprobar que no salta el vídeo ni lo silencia y que «Continuar reproducción» o ▶ permite seguir. Probar también cola vacía, cambio manual de vídeo y un ID eliminado/no embebible entre dos válidos: debe saltar el error al siguiente, sin bucle.
9. En Network, las acciones de cola no deben emitir llamadas de API. La reproducción de vídeos guardados solo conserva las escrituras de progreso que ya existían; no deben aparecer llamadas a watch-state ni escrituras remotas de listas. Recargar debe descartar la cola.

Resultado que falta registrar: autoplay audible de A→B→C en Chrome Android, tanto pestaña como PWA instalada. Sin ese resultado no se considera confirmado en Android.
