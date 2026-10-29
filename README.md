# Alveo

PWA privada para seguir canales, vídeos y listas de YouTube. El frontend usa React, TypeScript y Vite; el backend es un Cloudflare Worker con D1. La instalación de referencia vive en **https://alveo.rsenses.com**, protegida con Cloudflare Access y limitada a dos personas. Este repositorio también permite instalar una copia independiente en otra cuenta Cloudflare, con otro dominio y credenciales propias.

El dominio, los nombres y los identificadores de recursos de la instalación de referencia figuran en `wrangler.jsonc`: identifican dónde desplegar, pero **no son claves ni conceden acceso**. Para una instalación propia, parte de `wrangler.selfhost.example.jsonc` y sustituye todos sus valores de ejemplo. No uses la D1, KV, R2 ni Queue de la instalación de referencia. Nunca publiques secretos, archivos `.dev.vars`, tokens ni exportaciones de D1.

## Qué necesitas

| Proveedor | Recurso | Para qué se usa |
| --- | --- | --- |
| Google Cloud | Proyecto con **YouTube Data API v3** y una **API key** | Búsqueda, canales, listas y metadatos públicos. La clave solo la usa el Worker. |
| Google Cloud | Pantalla de consentimiento OAuth y cliente **Aplicación web** | Cada persona conecta su propia cuenta de YouTube. La app pide lectura primero y permiso de escritura solo si se solicita desde Configuración. |
| Cloudflare | Worker, dominio HTTPS y **Access** | Alojar la PWA y permitir solo a las personas autorizadas. |
| Cloudflare | **D1** (binding `DB`) | Cuentas, listas, vídeos, estados y trabajos de sincronización. |
| Cloudflare | **Queues** (binding `SYNC_QUEUE`) y Cron | Sincronización durable en segundo plano. |
| Cloudflare | **KV** (binding `READ_CACHE`) | Caché temporal de lecturas públicas y del feed. |
| Cloudflare | **R2** (binding `FEED_IMAGES`) | Miniaturas de vídeos pendientes del feed. |
| YouTube WebSub | Hub público existente; no requiere cuenta adicional | Avisos de vídeos nuevos. Requiere un secreto propio y que su callback pueda atravesar Access. |

Necesitas Node según `package.json` (22.12+, 24 o 26+), npm y el Wrangler instalado por el proyecto. Para producción, el dominio debe estar configurado en Cloudflare. Google y Cloudflare son los dos proveedores donde crearás credenciales y recursos; el hub WebSub ya existe.

## Probar sin cuentas externas

~~~sh
npm ci
npm run setup:local
npm run dev
~~~

Abre **http://localhost:5173**. La API local escucha en 127.0.0.1:8787 y la interfaz en 127.0.0.1:5173. Usa siempre `localhost` en el navegador: las cookies dependen del host. Este modo usa D1 local y datos ficticios; no crea recursos remotos ni llama automáticamente a tu cuenta de YouTube.

Para probar la PWA compilada y su Service Worker, detén `npm run dev` y ejecuta `npm run preview`. Los datos locales persisten en `.wrangler/`; `setup:local` vuelve a insertar fixtures si faltan.

## Probar con tu cuenta de YouTube, manteniendo Cloudflare local

1. En [Google Cloud](https://developers.google.com/youtube/v3/getting-started), crea un proyecto y habilita **YouTube Data API v3**.
2. Crea una **API key** y restríngela a YouTube Data API v3. La petición sale del Worker, así que una restricción de referente de navegador no sirve para esta clave. La búsqueda pública necesita esta clave.
3. Configura la pantalla de consentimiento OAuth y crea un cliente de tipo **Aplicación web**. Si la aplicación está en **Testing**, añade a quienes vayan a entrar como usuarios de prueba. Registra exactamente este URI autorizado: `http://localhost:5173/auth/google/callback`.
4. Copia manualmente `.dev.vars.example` a `.dev.vars` y completa `YOUTUBE_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `TOKEN_ENCRYPTION_KEY`. Genera esta última como **32 bytes aleatorios en base64** (por ejemplo, `openssl rand -base64 32`). Guárdala de forma estable: cambiarla impide descifrar tokens anteriores y obliga a reconectar.
5. Inicia una base real **local** y el servidor:

~~~sh
npm run setup:real
npm run dev:real
~~~

En Configuración, conecta Google. El primer permiso es `youtube.readonly`; «Permitir edición en YouTube» pide después `youtube.force-ssl` para suscripciones y listas. Las sincronizaciones locales en modo real sí llaman a Google y consumen cuota, pero D1, Queue y R2 usan simulaciones locales. `.dev.vars` no se envía al Worker de producción. No actives WebSub en localhost: el hub necesita un callback HTTPS accesible desde Internet.

## Instalar una copia en tu Cloudflare

**No ejecutes estos comandos contra la instalación de referencia.** En tu fork o copia de trabajo, configura primero tus propios recursos y dominio. `wrangler.jsonc` contiene los recursos de la instalación de referencia; `wrangler.selfhost.example.jsonc` es una plantilla sin sus IDs. Copia la plantilla a `wrangler.jsonc` y rellena sus valores antes de construir o desplegar.

Desde la raíz del repositorio, instala primero las dependencias con `npm ci`.

### 1. Crea los recursos Cloudflare

Inicia sesión con `npx wrangler login` y comprueba la cuenta con `npx wrangler whoami`. Crea una D1, un namespace KV, un bucket R2 y una Queue propios; los nombres de ejemplo de abajo deben ser únicos en tu cuenta:

~~~sh
npx wrangler d1 create mi-alveo-db
npx wrangler kv namespace create mi-alveo-cache
npx wrangler r2 bucket create mi-alveo-images
npx wrangler queues create mi-alveo-sync
~~~

Copia el **ID de D1** y el **ID de KV** que devuelve Wrangler. En tu `wrangler.jsonc`, mantén los bindings `DB`, `READ_CACHE`, `FEED_IMAGES`, `SYNC_QUEUE` y `ASSETS`, pero cambia los nombres/IDs de sus recursos. La Queue debe tener el mismo nombre en productor y consumidor. Configura también un nombre de Worker propio, `routes[].pattern` con tu dominio y `vars.APP_ORIGIN` con su origen HTTPS exacto, sin ruta. El Cron y `run_worker_first` de la plantilla deben conservarse.

La configuración actual usa `workers_dev: false` y un **custom domain**. Configura ese dominio en tu cuenta Cloudflare antes de desplegar; no copies el dominio de referencia. `npm run build` comprueba que el origen coincide con la ruta del Worker y rechaza los IDs o el dominio de ejemplo sin sustituir. Los valores `MODE=real`, `SYNC_PROFILE=free` y el límite de Queue están en la plantilla. Deja `WEBSUB_ENABLED=false` durante el primer arranque.

### 2. Configura Google para ese dominio

En **tu** proyecto Google habilita YouTube Data API v3, crea la API key y el cliente OAuth web como en la sección local. Registra el callback exacto `https://TU-DOMINIO/auth/google/callback` como URI de redirección autorizado. Si también usas el modo real local, registra además el callback de localhost. Añade a las personas autorizadas como usuarios de prueba de Google si el proyecto OAuth sigue en Testing. Los permisos de Google y los de Cloudflare Access son independientes.

### 3. Protege la aplicación con Cloudflare Access

Crea una aplicación Access para tu dominio y una política **Allow limitada a los correos concretos** de quienes deban usarlo. Elige un método de inicio de sesión (por ejemplo, la identidad Cloudflare o One-time PIN); no uses una política Allow con «Everyone» ni con todos los correos válidos. Haz esto **antes del primer despliegue**. Si vas a usar WebSub, crea una excepción Access limitada a `/api/websub/youtube`: el hub no puede iniciar sesión en Access. Conserva protegidos el resto de `/api`, `/auth` y la PWA. El callback sin Access valida el topic, un token HMAC y la firma del cuerpo; no publiques ni reutilices su secreto. Más detalle en [WebSub](docs/WEBSUB.md).

### 4. Migra, despliega y carga secretos

Con `wrangler.jsonc` ya apuntando **solo a tus recursos**:

~~~sh
npm run setup          # Migraciones sobre tu D1 remota; no inserta fixtures
npm run build
npx wrangler deploy --dry-run
npx wrangler deploy
~~~

`npm run setup` usa el binding `DB` y `--remote`. Haz copia de D1 antes de aplicar migraciones a una base con datos. El build de Vite genera una configuración de despliegue bajo `dist/`; ejecuta Wrangler desde la raíz del proyecto para que use esa configuración compilada.

Carga cada valor de forma interactiva, sin ponerlo en los argumentos ni en Git. Cada `secret put` publica una nueva versión del Worker:

~~~sh
npx wrangler secret put YOUTUBE_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
~~~

Para WebSub, genera **otro** valor aleatorio estable (mínimo 16 caracteres), cárgalo con `npx wrangler secret put WEBSUB_SECRET`, comprueba que la excepción Access del callback funciona y entonces cambia `WEBSUB_ENABLED` a `true` en `wrangler.jsonc`. Ejecuta de nuevo `npm run build && npx wrangler deploy`. Sin flag y secreto, WebSub permanece apagado y la sincronización usa el mecanismo anterior. No reutilices la clave de cifrado OAuth como secreto WebSub.

En la primera visita, entra por Access, conecta Google desde Configuración y sincroniza las suscripciones. Cada persona conecta **su propia** cuenta Google; sus listas y estados quedan separados en D1. Las listas propias normales se importan inicialmente; después el catálogo y cada lista se actualizan manualmente. Las listas ajenas encontradas en la búsqueda se pueden seguir y se importan en segundo plano. Los vídeos nuevos llegan mediante WebSub y reconciliación RSS si lo activaste. Las miniaturas de vídeos pendientes del feed se guardan en R2 y se eliminan cuando dejan de necesitarlas.

Para una instalación permanente, comprueba en Google Cloud que la pantalla OAuth esté **In production**. En **Testing**, Google caduca los permisos de los usuarios de prueba a los siete días para estos scopes; la renovación automática deja de funcionar y cada persona debe autorizar de nuevo. La app conserva sus estados y listas cuando ocurre. Una app personal para menos de 100 personas puede continuar sin verificación, aunque Google puede mostrar el aviso de aplicación no verificada; consulta la [documentación de Google sobre audiencia](https://support.google.com/cloud/answer/15549945) y [cuándo no se exige verificación](https://support.google.com/cloud/answer/13464323).

### 5. Comprueba y actualiza

Sin sesión, tu dominio debe redirigir a Access. Tras entrar, comprueba búsqueda, página de canal, listas, feed y una sincronización. Con WebSub activo, una petición sin parámetros a `/api/websub/youtube` debe llegar al Worker y fallar por validación; no debe redirigir a Access. Comprueba su alcance sin quitar protección al resto de la app.

Para versiones futuras, revisa cambios de configuración y migraciones, respalda D1, ejecuta `npm run setup` si hay migraciones nuevas, `npm run build`, `npx wrangler deploy --dry-run` y `npx wrangler deploy`. Los secrets existentes se conservan. Cambiar `APP_ORIGIN` exige actualizar el callback en Google y volver a iniciar sesión; cambiar `TOKEN_ENCRYPTION_KEY` invalida los tokens cifrados.

## Comportamiento y límites

- El feed, los canales y las listas usan D1 para los datos guardados. La búsqueda pública y los vídeos de un canal consultan YouTube bajo demanda. La API key y OAuth consumen cuota de Google.
- El embed es el reproductor oficial de YouTube. La PWA necesita red; el Service Worker solo cachea el shell y recursos propios, nunca respuestas privadas, OAuth ni vídeo.
- Los Shorts se identifican con una heurística de duración, que no es infalible. En el feed están desactivados por defecto.
- El recuento de suscriptores de un canal procede de YouTube y puede estar redondeado u oculto. La sincronización en segundo plano y WebSub no garantizan entrega instantánea.
- La configuración de referencia tiene R2, KV, Queue, Cron y Access. Aunque algunas cachés toleran fallos temporales, no omitas sus bindings al reproducir esta instalación.

## Comprobaciones locales

~~~sh
npm run typecheck
npm run test:sql
npm test
npm run test:ui
npm run build
~~~

`test:ui` usa Brave. En macOS lo busca en `/Applications/Brave Browser.app`; en otra ubicación, configura `BRAVE_EXECUTABLE_PATH` con la ruta al ejecutable. Usa una D1 local separada y desactiva la API key real. Las pruebas de backend usan respuestas simuladas; no escriben en una cuenta YouTube real.

Documentación técnica: [WebSub](docs/WEBSUB.md), [costes D1](docs/D1-PERFORMANCE.md) y [validaciones históricas](docs/VALIDACION.md). Referencias de instalación: [YouTube Data API y credenciales](https://developers.google.com/youtube/registering_an_application), [OAuth web](https://developers.google.com/identity/protocols/oauth2/web-server), [configuración de Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/), [políticas de Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/), [One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/) y [bypass de un endpoint](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).
