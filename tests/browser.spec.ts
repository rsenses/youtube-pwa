import { test, expect, chromium } from "@playwright/test";

// Only the dedicated player test supplies an IFrame API fixture; never call YouTube from UI tests.
test.beforeEach(async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) =>
    route.abort(),
  );
});

test("navegación, listas persistentes, ajustes y errores de escritura", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://localhost:5174")) external.push(r.url());
  });
  await page.goto("/feed");
  await expect(
    page.getByRole("heading", { name: "Feed", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".video-card").first()).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page
    .locator(".bottom-nav")
    .getByRole("link", { name: "Listas" })
    .click();
  await page.getByRole("button", { name: "Nueva lista" }).click();
  const title = "Prueba navegador " + Date.now();
  await page.getByLabel("Nombre", { exact: true }).fill(title);
  await page
    .getByLabel("Descripción", { exact: true })
    .fill("Persistencia local de prueba");
  await page
    .getByRole("button", { name: "Guardar lista", exact: true })
    .click();
  await page.getByRole("heading", { name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const path = new URL(page.url()).pathname;
  await page.reload();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.goto("/watch/aqz-KE-bpKQ");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Guardado en" }),
  ).toBeVisible();
  await page.goto(path);
  await expect(page.locator(".video-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Quitar de la lista" }).click();
  await expect(page.locator(".video-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Editar lista" }).click();
  await page
    .getByRole("button", { name: "Eliminar lista", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirmar eliminación" }).click();
  await expect(page).toHaveURL(/\/playlists$/);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Oscuro", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(28, 25, 24)",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#1c1918",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Sistema", exact: true }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(243, 240, 235)",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#f3f0eb",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(28, 25, 24)",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#1c1918",
  );
  await page.emulateMedia({ colorScheme: "light" });
  const rejected = await page.evaluate(async () => {
    const r = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ watchThreshold: 50 }),
    });
    return r.status;
  });
  expect(rejected).toBe(403);
  expect(errors).toEqual([]);
  expect(external).toEqual(["https://www.youtube.com/iframe_api"]);
});

test("embed directo, progreso y mismo iframe al rotar sin autoplay ni fullscreen automático", async ({
  page,
}) => {
  let apiLoads = 0;
  await page.route("https://www.youtube.com/iframe_api", async (route) => {
    apiLoads++;
    await route.fulfill({
      contentType: "application/javascript",
      body: `
    window.__mock={constructs:0,destroys:0,seconds:0,state:1};
    window.YT={Player:class {
      constructor(el,opts){this.opts=opts;this.iframe=document.createElement('iframe');this.iframe.srcdoc='<body style="background:#101813;color:white">Player simulado para verificar el contenedor, no reproducción real</body>';el.replaceWith(this.iframe);window.__mock.constructs++;window.__mock.player=this;setTimeout(()=>opts.events.onReady(),10)}
      getIframe(){return this.iframe} getCurrentTime(){return window.__mock.seconds} getDuration(){return 100}
      getPlayerState(){return window.__mock.state} getAvailablePlaybackRates(){return [.5,1,1.5,2]}
      setPlaybackRate(rate){window.__mock.rate=rate} playVideo(){window.__mock.playCalls=(window.__mock.playCalls||0)+1} pauseVideo(){}
      destroy(){window.__mock.destroys++;this.iframe.remove()}
    }};
    window.onYouTubeIframeAPIReady();
  `,
    });
  });
  await page.goto("/watch/M7lc1UVf-VE");
  await expect(page.locator(".watch-actions")).toBeVisible();
  await page.evaluate(async () => {
    const session = (await fetch("/api/session").then((r) => r.json())) as {
      csrfToken: string;
    };
    await fetch("/api/videos/M7lc1UVf-VE/watch-state", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({ watched: false }),
    });
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "YouTube IFrame Player API demo" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reproducir en YouTube" }),
  ).toHaveCount(0);
  await expect(page.locator(".player-poster")).toHaveCount(0);
  expect(apiLoads).toBeGreaterThan(0);
  const iframe = page.locator(".youtube-host iframe");
  await expect(iframe).toBeVisible();
  expect(await page.evaluate(() => (window as any).__mock.playCalls || 0)).toBe(
    0,
  );
  const identity = await iframe.elementHandle();
  const progressResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/videos/M7lc1UVf-VE/progress") &&
      r.request().method() === "PUT",
  );
  await page.evaluate(() => {
    (window as unknown as { __mock: { seconds: number } }).__mock.seconds = 30;
  });
  expect((await (await progressResponse).json()).positionSeconds).toBe(30);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".bottom-nav")).toBeHidden();
  await expect(page.locator(".watch-details")).toBeHidden();
  const box = await page.locator(".player-viewport").boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.y).toBe(0);
  expect(box?.width).toBe(844);
  expect(box?.height).toBe(390);
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  expect(
    await iframe.evaluate((el, original) => el === original, identity),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".watch-details")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await page.screenshot({ path: "/tmp/alveo-direct-embed-mobile.png" });
  expect(
    await iframe.evaluate((el, original) => el === original, identity),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __mock: { constructs: number; destroys: number };
          }
        ).__mock.constructs,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __mock: { destroys: number } }).__mock.destroys,
    ),
  ).toBe(0);
  await page
    .locator(".watch-actions")
    .getByRole("button", { name: "Marcar visto", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Visto", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Visto", exact: true }),
  ).toBeVisible();
});

test("cuota D1 en arranque no muestra instrucciones locales", async ({
  page,
}) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "D1_DAILY_LIMIT",
        error:
          "Se ha agotado la cuota diaria gratuita de la base de datos. Se restablece a las 00:00 UTC.",
      },
    }),
  );
  await page.goto("/feed");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("00:00 UTC");
  await expect(alert).not.toContainText("npm run");
  await expect(alert).not.toContainText("API local");
});

test("API HTML se muestra como error y no rompe el feed con undefined.filter", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/channels", (route) =>
    route.fulfill({ body: "<html>SPA</html>", contentType: "text/html" }),
  );
  await page.route("**/api/feed?**", (route) =>
    route.fulfill({ body: "<html>SPA</html>", contentType: "text/html" }),
  );
  await page.goto("/feed");
  await expect(
    page.getByText(/La API no ha devuelto datos JSON/),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("PWA registra SW y no cachea datos personales", async ({ page }) => {
  await page.goto("/feed");
  await expect
    .poll(() =>
      page.evaluate(
        async () => !!(await navigator.serviceWorker.getRegistration()),
      ),
    )
    .toBe(true);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator(".video-card").first()).toBeVisible();
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const urls: string[] = [];
    for (const k of keys)
      for (const r of await (await caches.open(k)).keys())
        urls.push(new URL(r.url).pathname);
    return urls;
  });
  expect(
    cached.some((u) => u.startsWith("/api") || u.startsWith("/auth")),
  ).toBe(false);
  expect(cached).toContain("/");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  const manifest = await cdp.send("Page.getAppManifest");
  expect(manifest.errors.filter((e) => e.critical)).toEqual([]);
  const parsed = JSON.parse(manifest.data!);
  expect(parsed).toMatchObject({
    id: "/",
    name: "Alveo",
    start_url: "/feed",
    scope: "/",
    display: "standalone",
  });
  const images = await page.evaluate(
    async (icons: Array<{ src: string }>) =>
      Promise.all(
        icons.map(async (icon) => {
          const response = await fetch(icon.src);
          const bitmap = await createImageBitmap(await response.blob());
          const result = {
            width: bitmap.width,
            height: bitmap.height,
            type: response.headers.get("content-type"),
          };
          bitmap.close();
          return result;
        }),
      ),
    parsed.icons,
  );
  expect(images.map((i) => [i.width, i.height])).toEqual([
    [192, 192],
    [512, 512],
  ]);
  expect(images.every((i) => i.type?.startsWith("image/png"))).toBe(true);
  const installability = await cdp.send("Page.getInstallabilityErrors");
  console.log("PWA Chrome installability:", JSON.stringify(installability));
  // Playwright's ordinary isolated contexts are incognito, where installation is disabled.
  expect(
    installability.installabilityErrors.filter(
      (e: { errorId: string }) => e.errorId !== "in-incognito",
    ),
  ).toEqual([]);
  await cdp.detach();
  const profile = await chromium.launchPersistentContext("", {
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
  });
  try {
    const normal = await profile.newPage();
    await normal.goto("http://localhost:5174/feed");
    await normal.evaluate(() => navigator.serviceWorker.ready);
    const session = await profile.newCDPSession(normal);
    await session.send("Page.enable");
    await session.send("Page.getAppManifest");
    const result = await session.send("Page.getInstallabilityErrors");
    console.log("PWA normal Chrome profile:", JSON.stringify(result));
    expect(result.installabilityErrors).toEqual([]);
  } finally {
    await profile.close();
  }
});

test("public comments, replies, paging, avatar fallback and related provenance", async ({
  page,
}) => {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        capabilities: {
          ...data.capabilities,
          comments: true,
          publicData: true,
        },
      },
    });
  });
  const video = {
    id: "M7lc1UVf-VE",
    title: "Public video fixture",
    channelId: "UC" + "a".repeat(22),
    channelTitle: "Public channel fixture",
    thumbnailUrl: "/thumbs/01.svg",
    publishedAt: "2025-01-01T00:00:00Z",
    description: "Public metadata fixture",
    durationSeconds: 120,
    isLive: false,
    watched: false,
    manual: false,
    positionSeconds: 0,
    percent: 0,
  };
  await page.route("**/api/videos/M7lc1UVf-VE", (route) =>
    route.fulfill({ json: video }),
  );
  let suggestionRequests = 0;
  await page.route("**/api/videos/M7lc1UVf-VE/suggestions", (route) => {
    suggestionRequests++;
    return route.fulfill({
      json: {
        items: [
          { ...video, id: "abcDEF12345", title: "Same-channel video fixture" },
        ],
        source: "youtube-search",
      },
    });
  });
  const comment = {
    id: "thread-one",
    author: "@Author",
    avatarUrl: "/missing-avatar.png",
    publishedAt: "2025-01-01T00:00:00Z",
    text: "A public comment fixture",
    likeCount: 12,
    replyCount: 1,
  };
  await page.route("**/missing-avatar.png", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  let commentRequests = 0;
  await page.route("**/api/videos/M7lc1UVf-VE/comments*", (route) => {
    commentRequests++;
    return route.fulfill({
      json: new URL(route.request().url()).searchParams.has("cursor")
        ? {
            items: [
              {
                ...comment,
                id: "thread-two",
                text: "Second-page comment fixture",
                replyCount: 0,
              },
            ],
            nextCursor: null,
          }
        : { items: [comment], nextCursor: "next-page" },
    });
  });
  await page.route("**/api/comments/thread-one/replies*", (route) =>
    route.fulfill({
      json: {
        items: [
          { ...comment, id: "reply-one", text: "Reply fixture", replyCount: 0 },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/watch/M7lc1UVf-VE");
  await expect(
    page.getByRole("heading", { name: "Public video fixture" }),
  ).toBeVisible();
  await expect(page.getByText("A public comment fixture")).toHaveCount(0);
  expect(commentRequests).toBe(0);
  await page
    .getByRole("button", { name: "Cargar comentarios", exact: true })
    .click();
  await expect(page.getByText("A public comment fixture")).toBeVisible();
  expect(commentRequests).toBe(1);
  const parent = page.locator(".comments-section>.comment").first();
  await expect(parent.locator(":scope>.comment-avatar")).toHaveText("A");
  await parent.getByRole("button", { name: "Ver 1 respuestas" }).click();
  await expect(parent.getByText("Reply fixture")).toBeVisible();
  await page
    .locator(".comments-section")
    .getByRole("button", { name: "Cargar más", exact: true })
    .click();
  await expect(page.getByText("Second-page comment fixture")).toBeVisible();
  expect(suggestionRequests).toBe(0);
  await page
    .getByRole("button", { name: "Cargar vídeos relacionados", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Vídeos relacionados" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Same-channel video fixture" }),
  ).toBeVisible();
  expect(suggestionRequests).toBe(1);
  await expect(
    page.getByText(
      "Búsqueda temática por etiquetas; si faltan, título y hashtags. Solo al solicitarla.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Ocultar vídeos relacionados", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Same-channel video fixture" }),
  ).toHaveCount(0);
  const previousRequests = commentRequests;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Public video fixture" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cargar comentarios", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".comments-section .comment")).toHaveCount(0);
  expect(commentRequests).toBe(previousRequests);
  await expect(
    page.getByRole("button", {
      name: "Cargar vídeos relacionados",
      exact: true,
    }),
  ).toBeVisible();
  expect(suggestionRequests).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
