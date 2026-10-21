/* Solo recursos propios. Nunca respuestas personales, OAuth ni vídeos. */
const CACHE = "alveo-shell-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        c.addAll([
          "/",
          "/icon.svg?v=2",
          "/manifest.webmanifest?v=3",
          "/thumbs/01.svg",
          "/thumbs/02.svg",
          "/thumbs/03.svg",
          "/thumbs/04.svg",
          "/thumbs/05.svg",
          "/thumbs/06.svg",
        ]),
      ),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) =>
                (k.startsWith("cauce-shell-") ||
                  k.startsWith("alveo-shell-")) &&
                k !== CACHE,
            )
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const req = event.request,
    url = new URL(req.url);
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/auth")
  )
    return;
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match("/").then(
          (c) =>
            c ||
            new Response("Sin conexión con la aplicación local.", {
              status: 503,
              headers: { "Content-Type": "text/plain;charset=utf-8" },
            }),
        ),
      ),
    );
    return;
  }
  if (!/^\/(assets\/|thumbs\/|icon|manifest\.webmanifest)/.test(url.pathname))
    return;
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
          }
          return response;
        }),
    ),
  );
});
