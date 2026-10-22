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
  await page.route("**/api/feed?**", (route) => {
    const more = new URL(route.request().url()).searchParams.has("cursor");
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
  await page.getByRole("button", { name: "Cargar más vídeos" }).click();
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
  await expect(
    page.getByRole("heading", { name: "Llegada new" }),
  ).toBeVisible();
  await expect(page.locator(".video-card")).toHaveCount(1);
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
  expect(requests[0]?.searchParams.get("types")).toBe("video,live");
  await expect(page.locator(".topbar")).toBeVisible();
  await expect(page.locator(".local-badge")).toHaveCount(0);
  expect(requests.at(-1)?.searchParams.get("limit")).toBe("18");
  await page
    .getByRole("button", { name: "Cargar más vídeos", exact: true })
    .click();
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
    await route.fulfill({ json: { items, nextCursor: "next-page" } });
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

  await page
    .getByRole("button", { name: "Cargar más vídeos", exact: true })
    .click();
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
  await page.goto("/feed");
  await expect(
    page.getByRole("heading", { name: "Filtro inicial" }),
  ).toBeVisible();
  const requested = page.waitForRequest((r) =>
    new URL(r.url()).searchParams.has("cursor"),
  );
  await page
    .getByRole("button", { name: "Cargar más vídeos", exact: true })
    .click();
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

test("los tipos conservan estado, canal y URL", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/api/feed?**", async (route) => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });

  await page.goto("/feed?status=all&channelId=UCfixture&types=short");
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(requests[0]?.searchParams.get("types")).toBe("short");
  expect(requests[0]?.searchParams.get("status")).toBe("all");
  expect(requests[0]?.searchParams.get("channelId")).toBe("UCfixture");

  await page
    .getByRole("group", { name: "Filtrar por tipo" })
    .getByRole("button", { name: "Directos", exact: true })
    .click();
  await expect
    .poll(() => requests.at(-1)?.searchParams.get("types"))
    .toBe("live,short");
  expect(requests.at(-1)?.searchParams.get("status")).toBe("all");
  expect(requests.at(-1)?.searchParams.get("channelId")).toBe("UCfixture");
  expect(requests.at(-1)?.searchParams.has("cursor")).toBe(false);
  const current = new URL(page.url()).searchParams;
  expect(current.get("types")).toBe("live,short");
  expect(current.get("status")).toBe("all");
  expect(current.get("channelId")).toBe("UCfixture");
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
