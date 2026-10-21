# Gestos estilo NewPipe y límites de ejecución

## Resultado de la investigación (sin implementar gestos)

- **Brillo real:** Chrome/PWA no ofrece una API web estándar equivalente al brillo de una ventana Android. `Screen.mozBrightness` es no estándar y obsoleto; no es una solución para Chrome Android. Oscurecer con CSS no cambia la retroiluminación ni equivale al control nativo.
- **Volumen:** el IFrame API de YouTube documenta `setVolume(0..100)` y `getVolume()`. Controlan el reproductor, no el volumen maestro del teléfono. Un control propio externo al iframe es un experimento viable, pero debe probarse en Android real antes de prometerlo.
- **Deslizamientos sobre las dos mitades del vídeo:** el iframe pertenece a YouTube y su DOM no es accesible desde Alveo por la política de mismo origen. No podemos instalar listeners dentro de él. Capturar gestos con capas propias podría interferir con controles, enlaces o anuncios. La guía YouTube permite ciertos controles superpuestos si no entran en conflicto con su UI; eso no aprueba automáticamente una capa táctil que cubra todo el vídeo.
- **Decisión actual:** mantener embed nativo sin capas/gestos añadidos. No presentar una simulación CSS como brillo de pantalla. Si se desea, el siguiente experimento sería volumen en una zona/control fuera del iframe y prueba física Android. Replicar ambas funciones nativas de NewPipe no es equivalente a añadir unos listeners a una PWA.

No se implementaron gestos, permisos Android ni envoltorios nativos.

## Qué significaban las «50 llamadas»

Workers Free permite **50 consultas D1 por invocación del Worker**. Cada petición HTTP o evento Cron tiene su propio presupuesto. No son 50 al día, 50 vídeos ni 50 usuarios.

Una consulta puede devolver los 18 vídeos del feed. La sincronización cuesta más: guardar metadatos, registrar descubrimientos, mantener sesiones, cursor, lease e historial requiere varias sentencias. Incluso en `batch()` hay que presupuestar sus consultas; el RSS se procesa por pasos pequeños. El test acota a 44 sentencias de sincronización, reservando seis para middleware HTTP.

Es independiente del límite de subpeticiones externas de Workers y de la cuota del proyecto YouTube. El RSS no consume búsquedas de Data API. Las recomendaciones de Alveo solo llaman a búsqueda después de pulsar su botón y reutilizan caché durante una hora.

## Fuentes verificadas

- [Límites D1, 50 consultas Free / 1000 Paid por invocación](https://developers.cloudflare.com/d1/platform/limits/)
- [YouTube IFrame API: control del volumen](https://developers.google.com/youtube/iframe_api_reference#Changing_the_player_volume)
- [MDN: mozBrightness no estándar/obsoleto](https://developer.mozilla.org/en-US/docs/Web/API/Screen/mozBrightness)
- [Android: screenBrightness nativo](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#screenBrightness)
- [MDN: política de mismo origen](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)
- [YouTube: controles y superposiciones sin interferencia](https://developers.google.com/youtube/terms/developer-policies-guide)
