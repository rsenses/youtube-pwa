import { test, expect, type Locator, type Page } from "@playwright/test";

test("actualizar suscripciones se ofrece en Canales, no en Feed", async ({
  page,
}) => {
  await page.goto("/feed");
  await expect(
    page.getByRole("heading", { name: "Feed", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Actualizar", exact: true }),
  ).toHaveCount(0);
  await page.goto("/channels");
  await expect(
    page.getByRole("heading", { name: "Canales", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Actualizar", exact: true }),
  ).toBeVisible();
});

test("WebSub refresca el feed al volver visible y reinicia la paginación", async ({
  page,
}) => {
  let revision = "first";
  let polls = 0;
  let firstPageRequests = 0;
  let releaseRefresh!: () => void;
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        mode: "real",
        connected: true,
        csrfToken: "test",
        account: { name: "Fixture" },
        capabilities: {
          automaticDiscovery: true,
          localPlaylists: true,
          externalSync: true,
        },
      },
    }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { watchThreshold: 80, theme: "system" } }),
  );
  await page.route("**/api/channels", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/api/feed/revision", (route) => {
    polls++;
    return route.fulfill({ json: { revision } });
  });
  await page.route("**/api/feed?**", async (route) => {
    const more = new URL(route.request().url()).searchParams.has("cursor");
    if (!more) firstPageRequests++;
    if (!more && revision === "new") {
      await new Promise<void>((resolve) => { releaseRefresh = resolve; });
    }
    return route.fulfill({
      json: {
        items: [
          feedItem(
            more ? "second" : revision,
            more ? "Página anterior" : `Llegada ${revision}`,
          ),
        ],
        nextCursor: more ? null : "next",
      },
    });
  });
  await page.goto("/feed");
  await expect(
    page.getByRole("heading", { name: "Llegada first" }),
  ).toBeVisible();
  await expect.poll(() => polls).toBe(1);
  expect(firstPageRequests).toBe(1);
  await expect(page.locator(".video-card")).toHaveCount(2);
  revision = "new";
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(150);
  expect(polls).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => firstPageRequests).toBe(2);
  await expect(page.getByRole("heading", { name: "Llegada first" })).toBeVisible();
  releaseRefresh();
  await expect(page.getByRole("heading", { name: "Llegada new" })).toBeVisible();
  await expect(page.locator(".video-card")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Llegada first" })).toHaveCount(0);
  revision = "focused";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Llegada focused" })).toBeVisible();
});

test("el swipe muestra la acción detrás y saca la tarjeta sin rebote", async ({ page }) => {
  const video = feedItem("swipe", "Vídeo para deslizar");
  let finishWrite!: () => void;
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    mode: "real", connected: true, csrfToken: "test", account: { name: "Fixture" },
    capabilities: { automaticDiscovery: true, localPlaylists: true, externalSync: true },
  } }));
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { watchThreshold: 80, theme: "system" } }));
  await page.route("**/api/channels", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/feed?**", (route) =>
    route.fulfill({ json: { items: [video], nextCursor: null } }));
  await page.route("**/api/videos/*/watch-state", async (route) => {
    await new Promise<void>((resolve) => { finishWrite = resolve; });
    await route.fulfill({ json: { ...video, watched: true } });
  });

  await page.goto("/feed");
  const shell = page.locator(".swipe-card");
  const card = shell.locator(".video-card");
  await expect(card).toBeVisible();
  const touch = (type: string, x: number) => card.evaluate((element, gesture) => {
    const point = new Touch({ identifier: 1, target: element, clientX: gesture.x, clientY: 200 });
    element.dispatchEvent(new TouchEvent(gesture.type, {
      bubbles: true,
      touches: gesture.type === "touchend" ? [] : [point],
      changedTouches: [point],
    }));
  }, { type, x });
  await touch("touchstart", 30);
  await touch("touchmove", 140);
  await expect(card).toHaveClass(/is-swiping/);
  await touch("touchend", 140);
  await expect(card).toHaveClass(/is-leaving/);
  await expect(shell.locator(".swipe-feedback")).toContainText("Visto");
  await expect.poll(async () => {
    const [cardBox, shellBox] = await Promise.all([card.boundingBox(), shell.boundingBox()]);
    return cardBox!.x - shellBox!.x;
  }).toBeGreaterThan(100);
  finishWrite();
  await expect(shell).toHaveCount(0);
});

function feedItem(
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: id.padEnd(11, "0"),
    title,
    channelId: "UCfixture",
    channelTitle: "Canal de prueba",
    thumbnailUrl: "/thumbs/01.svg",
    publishedAt: "2026-10-20T00:00:00.000Z",
    description: "",
    durationSeconds: 300,
    watched: false,
    positionSeconds: 0,
    percent: 0,
    manual: false,
    ...extra,
  };
}

async function expectNoOverlap(first: Locator, second: Locator) {
  const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  const overlaps =
    a!.x < b!.x + b!.width &&
    b!.x < a!.x + a!.width &&
    a!.y < b!.y + b!.height &&
    b!.y < a!.y + a!.height;
  expect(overlaps).toBe(false);
}

async function openSettings(
  page: Page,
  options: { writes: boolean; connected?: boolean },
) {
  const connected = options.connected ?? true;
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        mode: "real",
        connected,
        csrfToken: "ui-test-csrf",
        account: { name: "Canal de prueba" },
        capabilities: {
          externalSync: connected,
          oauth: true,
          youtubeWrites: options.writes,
          rss: connected,
          comments: true,
          publicData: true,
          localPlaylists: true,
        },
      },
    }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: { watchThreshold: 80, theme: "system" } }),
  );
  await page.route("**/api/sync/status", (route) =>
    route.fulfill({ json: { runs: [], jobs: [] } }),
  );
  await page.goto("/settings");
}

test("feed de 18, paginación y cabecera sin estado duplicado", async ({
  page,
}) => {
  const requests: URL[] = [];
  await page.route("**/api/feed?**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const second = url.searchParams.has("cursor");
    await route.fulfill({
      json: {
        items: Array.from({ length: 18 }, (_, i) => ({
          id: String(i + (second ? 18 : 0)).padStart(11, "0"),
          title: `Vídeo de prueba ${i + (second ? 18 : 0)}`,
          channelId: "UCfixture",
          channelTitle: "Canal de prueba",
          thumbnailUrl: "/thumbs/01.svg",
          publishedAt: "2026-10-20T00:00:00.000Z",
          description: "",
          durationSeconds: 300,
          watched: false,
          positionSeconds: 0,
          percent: 0,
          manual: false,
        })),
        nextCursor: second ? null : "next-page",
      },
    });
  });
  await page.goto("/feed");
  await expect(page.locator(".video-card")).toHaveCount(18);
  await expect(page.getByRole("button", { name: "Opciones de marcado masivo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Marcar todos como vistos" })).toHaveCount(0);
  await expect(page.locator('link[rel="preconnect"][href="https://i.ytimg.com"]')).toHaveCount(1);
  const thumbnails = page.locator(".video-card .thumbnail img");
  for (let index = 0; index < 3; index++) {
    await expect(thumbnails.nth(index)).toHaveAttribute("loading", "eager");
    await expect(thumbnails.nth(index)).toHaveAttribute("fetchpriority", "high");
  }
  await expect(thumbnails.nth(3)).toHaveAttribute("loading", "lazy");
  expect(requests[0]?.searchParams.get("types")).toBe("video,live");
  await expect(page.locator(".topbar")).toBeVisible();
  await expect(page.locator(".local-badge")).toHaveCount(0);
  expect(requests.at(-1)?.searchParams.get("limit")).toBe("18");
  await page.locator(".load-more").scrollIntoViewIfNeeded();
  await expect(page.locator(".video-card")).toHaveCount(36);
  expect(requests.at(-1)?.searchParams.get("limit")).toBe("18");
  expect(requests.at(-1)?.searchParams.get("cursor")).toBe("next-page");
  await page.getByRole("button", { name: "Todos", exact: true }).click();
  await expect(page.locator(".video-card")).toHaveCount(18);
  expect(requests.at(-1)?.searchParams.get("status")).toBe("all");
  expect(requests.at(-1)?.searchParams.has("cursor")).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".topbar")).toBeHidden();
  expect(
    (await page
      .getByRole("heading", { name: "Feed", exact: true, level: 1 })
      .boundingBox())!.y,
  ).toBeLessThan(40);
  await page.screenshot({ path: "/tmp/alveo-feed-18-desktop.png" });
});

test("la carga automática se detiene tras un error y permite reintentar", async ({ page }) => {
  let pageRequests = 0;
  await page.route("**/api/feed?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) {
      pageRequests++;
      if (pageRequests === 1) return route.fulfill({ status: 503, json: { error: "Fallo temporal" } });
      return route.fulfill({ json: { items: [feedItem("retry", "Página recuperada")], nextCursor: null } });
    }
    return route.fulfill({ json: {
      items: Array.from({ length: 18 }, (_, i) => feedItem(`initial-${i}`, `Vídeo ${i}`)),
      nextCursor: "NEXT",
    } });
  });
  await page.goto("/feed");
  await expect(page.locator(".video-card")).toHaveCount(18);
  await expect(page.getByRole("button", { name: /Cargar más/ })).toHaveCount(0);
  await page.locator(".load-more").scrollIntoViewIfNeeded();
  await expect(page.locator(".load-more").getByRole("button", { name: "Reintentar" })).toBeVisible();
  expect(pageRequests).toBe(1);
  await page.locator(".load-more").getByRole("button", { name: "Reintentar" }).click();
  await expect(page.getByRole("heading", { name: "Página recuperada" })).toBeVisible();
  expect(pageRequests).toBe(2);
});

test("menú del feed permite guardar, ver canal y marcar visto", async ({ page }) => {
  const video = feedItem("menu", "Vídeo con opciones");
  const saved: string[] = [];
  await page.route("**/api/feed?**", (route) => route.fulfill({
    json: { items: [video], nextCursor: null },
  }));
  await page.route("**/api/playlists", (route) => route.fulfill({
    json: { items: [{ id: "list-1", title: "Favoritos", source: "local" }] },
  }));
  await page.route("**/api/playlists/list-1/items", (route) => {
    saved.push((route.request().postDataJSON() as { videoId: string }).videoId);
    return route.fulfill({ json: { id: "saved" } });
  });
  await page.route("**/api/videos/*/watch-state", (route) => route.fulfill({
    json: { ...video, watched: true },
  }));
  await page.goto("/feed");
  const options = page.getByRole("button", { name: "Opciones de Vídeo con opciones" });
  await options.click();
  await page.screenshot({ path: "/tmp/alveo-feed-menu-mobile.png" });
  await expect(page.getByRole("button", { name: "Marcar visto", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await page.getByRole("button", { name: /Favoritos/ }).click();
  expect(saved).toEqual([video.id]);
  await options.click();
  await page.getByRole("link", { name: "Ver canal" }).click();
  await expect(page).toHaveURL(/\/channels\/UCfixture$/);
  await page.goto("/feed");
  await page.getByRole("button", { name: "Opciones de Vídeo con opciones" }).click();
  await page.getByRole("button", { name: "Marcar visto", exact: true }).click();
  await expect(page.locator(".video-card")).toHaveCount(0);
});

test("canal muestra 18 subidas y pagina vídeos antiguos", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/api/channels", (route) => route.fulfill({ json: { items: [{
    id: "UCfixture", title: "Canal de prueba", description: "",
    thumbnailUrl: "", subscribed: false,
  }] } }));
  await page.route("**/api/channels/UCfixture/videos?**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const second = url.searchParams.has("cursor");
    return route.fulfill({ json: {
      items: Array.from({ length: second ? 1 : 18 }, (_, i) =>
        feedItem(`old${i + (second ? 18 : 0)}`, `Vídeo antiguo ${i + (second ? 18 : 0)}`, {
          publishedAt: "2010-01-01T00:00:00Z", transient: true,
        })),
      nextCursor: second ? null : "NEXT",
    } });
  });
  await page.goto("/channels/UCfixture");
  await expect(page.locator(".video-card")).toHaveCount(18);
  expect(requests[0].searchParams.get("limit")).toBe("18");
  await page.getByRole("button", { name: "Opciones de Vídeo antiguo 0" }).click();
  await expect(page.getByRole("button", { name: "Marcar visto", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver canal" })).toBeVisible();
  await page.locator(".load-more").scrollIntoViewIfNeeded();
  await expect(page.locator(".video-card")).toHaveCount(19);
  expect(requests[1].searchParams.get("cursor")).toBe("NEXT");
  expect(requests[1].searchParams.get("limit")).toBe("18");
});

test("canal no guardado muestra los metadatos públicos", async ({ page }) => {
  const channelId = `UC${"u".repeat(22)}`;
  await page.route("**/api/channels", (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`**/api/channels/${channelId}/videos?**`, (route) => route.fulfill({ json: {
    channel: { id: channelId, title: "Canal público", description: "Descripción pública", thumbnailUrl: "" },
    items: [feedItem("public", "Vídeo público", { channelId, transient: true })],
    nextCursor: null,
  } }));
  await page.goto(`/channels/${channelId}`);
  await expect(page.getByRole("heading", { name: "Canal público" })).toBeVisible();
  await expect(page.getByText("Descripción pública")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Vídeo público" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Marcar vídeos" })).toHaveCount(0);
});

test("marcar por fecha desde un canal envía solo ese canal", async ({ page }) => {
  const channelId = "UCfixture";
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/channels", (route) => route.fulfill({ json: { items: [{
    id: channelId, title: "Canal de prueba", description: "", thumbnailUrl: "", subscribed: true,
  }] } }));
  await page.route(`**/api/channels/${channelId}/videos?**`, (route) => route.fulfill({ json: {
    items: [feedItem("dated", "Vídeo anterior")], nextCursor: null,
  } }));
  await page.route("**/api/watch-state/bulk", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { updated: 1 } });
  });
  await page.goto(`/channels/${channelId}`);
  await page.getByRole("button", { name: "Marcar vídeos" }).click();
  await page.locator('.channel-mark-panel input[type="date"]').fill("2026-10-10");
  await page.getByRole("button", { name: "Marcar como vistos" }).click();
  await expect.poll(() => body).toMatchObject({
    scope: "channel_before", channelId,
    before: new Date("2026-10-10T00:00:00").toISOString(),
  });
  await expect(page.locator(".channel-mark-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Marcar vídeos" }).click();
  await page.getByRole("button", { name: "Marcar todos como vistos" }).click();
  await expect.poll(() => body).toMatchObject({ scope: "channel", channelId });
});

test("lista conserva quitar y ofrece el menú de vídeo", async ({ page }) => {
  await page.route("**/api/playlists/list-1", (route) => route.fulfill({ json: {
    id: "list-1", title: "Favoritos", description: "", source: "local", itemCount: 1,
    items: [{ ...feedItem("listed", "Vídeo en lista"), playlistItemId: "item-1" }],
  } }));
  await page.goto("/playlists/list-1");
  await expect(page.getByRole("button", { name: "Quitar de la lista" })).toBeVisible();
  await page.getByRole("button", { name: "Opciones de Vídeo en lista" }).click();
  await expect(page.getByRole("button", { name: "Marcar visto", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver canal" })).toBeVisible();
});

test("quitar un vídeo de una lista conserva la página, el scroll y las demás tarjetas", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/playlists/list-1", (route) => {
    reads++;
    return route.fulfill({ json: {
      id: "list-1", title: "Favoritos", description: "", source: "local", itemCount: 30,
      items: Array.from({ length: 30 }, (_, index) => ({
        ...feedItem(`listed${index}`, `Vídeo ${index}`), playlistItemId: `item-${index}`,
      })),
    } });
  });
  await page.route("**/api/playlists/list-1/items/item-10", (route) =>
    route.fulfill({ json: { ok: true } }));
  await page.goto("/playlists/list-1");
  await expect(page.locator(".video-card")).toHaveCount(30);
  const target = page.locator(".video-card").filter({ hasText: "Vídeo 10" });
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => { (window as Window & { retained?: string }).retained = "yes"; });
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);
  await target.getByRole("button", { name: "Quitar de la lista" }).click();
  await expect(target).toHaveCount(0);
  await expect(page.locator(".video-card")).toHaveCount(29);
  expect(await page.evaluate(() => (window as Window & { retained?: string }).retained)).toBe("yes");
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(reads).toBe(1);
  await expect(page).toHaveURL(/\/playlists\/list-1$/);
});

test("seguir un canal conserva búsqueda y scroll mientras se actualiza la lista", async ({ page }) => {
  let releaseRefresh!: () => void;
  const refresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let reads = 0;
  await page.route("**/api/channels?excluded=false", async (route) => {
    reads++;
    if (reads > 1) await refresh;
    return route.fulfill({ json: { items: Array.from({ length: 30 }, (_, index) => ({
      id: `UC${String(index).padStart(22, "0")}`,
      title: `Canal ${index}`, description: "", thumbnailUrl: "",
      subscribed: reads > 1 && index === 10, excluded: false, lastSyncedAt: null,
    })) } });
  });
  await page.route("**/api/subscriptions", (route) => route.fulfill({ json: { ok: true } }));
  await page.goto("/channels");
  await page.getByLabel("Buscar canales").fill("Canal");
  const target = page.locator(".channel-card").nth(10);
  await target.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await target.getByRole("button", { name: "Seguir", exact: true }).click();
  await expect(target.getByRole("button", { name: "Siguiendo" })).toBeVisible();
  await expect(page.locator(".channel-card")).toHaveCount(30);
  await expect(page.getByLabel("Buscar canales")).toHaveValue("Canal");
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  releaseRefresh();
  await expect.poll(() => reads).toBe(2);
});

test("selector de tipos, etiquetas y paginación", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/api/feed?**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const selected = new Set(
      (url.searchParams.get("types") ?? "video,live").split(","),
    );
    const items = [];
    if (selected.has("video")) items.push(feedItem("video", "Vídeo normal"));
    if (selected.has("live"))
      items.push(
        feedItem("live", "Directo en emisión", {
          liveBroadcastContent: "live",
          durationSeconds: 0,
          watched: true,
          percent: 100,
        }),
      );
    if (selected.has("short"))
      items.push(
        feedItem("short", "Short de prueba", {
          durationSeconds: 120,
          percent: 40,
        }),
      );
    await route.fulfill({ json: { items: url.searchParams.has("cursor") ? [] : items, nextCursor: url.searchParams.has("cursor") ? null : "next-page" } });
  });

  await page.goto("/feed");
  const group = page.getByRole("group", { name: "Filtrar por tipo" });
  const videos = group.getByRole("button", { name: "Vídeos", exact: true });
  const live = group.getByRole("button", { name: "Directos", exact: true });
  const shorts = group.getByRole("button", { name: "Shorts", exact: true });

  await expect(videos).toHaveAttribute("aria-pressed", "true");
  await expect(live).toHaveAttribute("aria-pressed", "true");
  await expect(shorts).toHaveAttribute("aria-pressed", "false");
  expect(requests[0]?.searchParams.get("types")).toBe("video,live");
  expect(new URL(page.url()).searchParams.get("types")).toBe("video,live");
  await expect(page.locator(".video-card")).toHaveCount(2);

  const liveCard = page
    .locator(".video-card")
    .filter({ hasText: "Directo en emisión" });
  const liveTag = liveCard.locator(".thumbnail .type-tag.live");
  await expect(liveTag).toHaveText("live");
  await expect(page.locator(".type-tag.short")).toHaveCount(0);
  await expectNoOverlap(liveTag, liveCard.locator(".duration"));
  await expectNoOverlap(liveTag, liveCard.locator(".watched-label"));

  await expect
    .poll(() => requests.at(-1)?.searchParams.get("cursor"))
    .toBe("next-page");

  await shorts.click();
  await expect
    .poll(() => requests.at(-1)?.searchParams.get("types"))
    .toBe("video,live,short");
  expect(requests.at(-1)?.searchParams.has("cursor")).toBe(false);
  await expect(shorts).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".video-card")).toHaveCount(3);

  const shortCard = page
    .locator(".video-card")
    .filter({ hasText: "Short de prueba" });
  const shortTag = shortCard.locator(".thumbnail .type-tag.short");
  await expect(shortTag).toHaveText("short");
  await expectNoOverlap(shortTag, shortCard.locator(".duration"));
  await expectNoOverlap(shortTag, shortCard.locator(".progress-track"));
  await page.screenshot({
    path: "/tmp/alveo-video-types-mobile.png",
    fullPage: true,
  });

  await videos.click();
  await live.click();
  await shorts.click();
  await expect.poll(() => requests.at(-1)?.searchParams.get("types")).toBe("");
  expect(new URL(page.url()).searchParams.get("types")).toBe("");
  await expect(page.locator(".video-card")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No hay tipos seleccionados" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("descarta paginación tardía al cambiar tipos", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/feed?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) {
      await delayed;
      await route.fulfill({
        json: { items: [feedItem("late", "Página tardía")], nextCursor: null },
      });
      return;
    }
    const changed = url.searchParams.get("types")?.includes("short");
    await route.fulfill({
      json: {
        items: [
          feedItem(
            changed ? "new" : "old",
            changed ? "Filtro nuevo" : "Filtro inicial",
          ),
        ],
        nextCursor: changed ? null : "page2",
      },
    });
  });
  const requested = page.waitForRequest((r) =>
    new URL(r.url()).searchParams.has("cursor"),
  );
  await page.goto("/feed");
  await expect(
    page.getByRole("heading", { name: "Filtro inicial" }),
  ).toBeVisible();
  await requested;
  await page.getByRole("button", { name: "Shorts", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Filtro nuevo" }),
  ).toBeVisible();
  const response = page.waitForResponse((r) =>
    new URL(r.url()).searchParams.has("cursor"),
  );
  release();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    page.getByRole("heading", { name: "Página tardía" }),
  ).toHaveCount(0);
  await expect(page.locator(".video-card")).toHaveCount(1);
});

test("los tipos conservan estado y eliminan el filtro antiguo de canal", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/api/feed?**", async (route) => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });

  await page.goto("/feed?status=all&channelId=UCfixture&types=short");
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(requests[0]?.searchParams.get("types")).toBe("short");
  expect(requests[0]?.searchParams.get("status")).toBe("all");
  expect(requests[0]?.searchParams.has("channelId")).toBe(false);
  await expect(page.getByLabel("Filtrar por canal")).toHaveCount(0);

  await page
    .getByRole("group", { name: "Filtrar por tipo" })
    .getByRole("button", { name: "Directos", exact: true })
    .click();
  await expect
    .poll(() => requests.at(-1)?.searchParams.get("types"))
    .toBe("live,short");
  expect(requests.at(-1)?.searchParams.get("status")).toBe("all");
  expect(requests.at(-1)?.searchParams.has("channelId")).toBe(false);
  expect(requests.at(-1)?.searchParams.has("cursor")).toBe(false);
  const current = new URL(page.url()).searchParams;
  expect(current.get("types")).toBe("live,short");
  expect(current.get("status")).toBe("all");
  expect(current.has("channelId")).toBe(false);
});

test("Configuración indica edición no autorizada y ofrece permiso", async ({
  page,
}) => {
  await openSettings(page, { writes: false, connected: true });
  const account = page
    .locator(".settings-card")
    .filter({ hasText: "Cuenta de YouTube" });
  await expect(
    account.getByText("Edición no autorizada", { exact: true }),
  ).toBeVisible();
  await expect(
    account.getByRole("link", { name: "Permitir edición en YouTube" }),
  ).toHaveAttribute("href", "/auth/google/start?scope=write");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("Configuración no ofrece permiso si ya está autorizada", async ({
  page,
}) => {
  await openSettings(page, { writes: true });
  const account = page
    .locator(".settings-card")
    .filter({ hasText: "Cuenta de YouTube" });
  await expect(
    account.getByText("Edición autorizada", { exact: true }),
  ).toBeVisible();
  await expect(
    account.getByRole("link", { name: "Permitir edición en YouTube" }),
  ).toHaveCount(0);
});

test("Configuración no ofrece permiso si no hay cuenta conectada", async ({
  page,
}) => {
  await openSettings(page, { writes: false, connected: false });
  const account = page
    .locator(".settings-card")
    .filter({ hasText: "Cuenta de YouTube" });
  await expect(
    account.getByText("Edición no autorizada", { exact: true }),
  ).toBeVisible();
  await expect(
    account.getByRole("link", { name: "Permitir edición en YouTube" }),
  ).toHaveCount(0);
});
