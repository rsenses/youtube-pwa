import { test, expect } from "@playwright/test";

const now = "2026-10-20T10:00:00.000Z";
test("actualiza solo la lista seleccionada y no ofrece sincronización externa para listas locales", async ({
  page,
}) => {
  await page.route(/\/api\/session$/, async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    await route.fulfill({ json: { ...data, mode: "real", connected: true } });
  });
  let posts = 0,
    reads = 0;
  await page.route(/\/api\/playlists\/manual-list$/, (route) => {
    reads++;
    return route.fulfill({
      json: {
        id: "manual-list",
        title: posts ? "Lista actualizada" : "Lista remota",
        description: "",
        source: "youtube",
        privacyStatus: "private",
        itemCount: 0,
        items: [],
      },
    });
  });
  await page.route(/\/api\/playlists\/manual-list\/sync$/, (route) => {
    if (route.request().method() === "POST") {
      posts++;
      return route.fulfill({
        json: {
          job: queuedJob({
            type: "playlists",
            playlistId: "manual-list",
            phase: "playlist_items",
          }),
        },
      });
    }
    return route.fulfill({
      json: {
        runs: [],
        jobs: posts
          ? [
              queuedJob({
                type: "playlists",
                playlistId: "manual-list",
                phase: "done",
                status: "success",
              }),
            ]
          : [],
      },
    });
  });
  await page.goto("/playlists/manual-list");
  await page.getByRole("button", { name: "Actualizar desde YouTube" }).click();
  await expect(
    page.getByRole("heading", { name: "Lista actualizada" }),
  ).toBeVisible();
  expect(posts).toBe(1);
  expect(reads).toBeGreaterThan(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.route(/\/api\/playlists\/local-list$/, (route) =>
    route.fulfill({
      json: {
        id: "local-list",
        title: "Lista local",
        description: "",
        source: "local",
        itemCount: 0,
        items: [],
      },
    }),
  );
  await page.goto("/playlists/local-list");
  await expect(
    page.getByRole("heading", { name: "Lista local" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Actualizar desde YouTube" }),
  ).toHaveCount(0);
});

const legacyRun = {
  id: "legacy-run-1",
  type: "all",
  status: "running",
  startedAt: now,
  finishedAt: null,
  items: 0,
  error: null,
  detail: null,
  mode: "real",
};

function queuedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-sync-1",
    status: "queued",
    phase: "subscriptions",
    items: 0,
    processedChannels: 0,
    processedPlaylists: 0,
    message: null,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// The queue never calls providers from the browser; keep any player fixture out of these tests.
test.beforeEach(async ({ page }) => {
  await page.route("https://www.youtube.com/iframe_api", (route) =>
    route.abort(),
  );
});

test("un clic encola una sola vez y muestra el progreso del servidor sin repetir el bucle local", async ({
  page,
}) => {
  let posts = 0;
  let statusReads = 0;
  let readsAfterPost = 0;

  await page.route(/\/api\/sync\/status$/, async (route) => {
    statusReads++;
    if (posts) readsAfterPost++;
    const jobs = !posts
      ? []
      : readsAfterPost <= 1
        ? [queuedJob()]
        : readsAfterPost === 2
          ? [
              queuedJob({
                status: "running",
                phase: "rss",
                items: 2,
                processedChannels: 1,
                message: "Procesando suscripciones",
              }),
            ]
          : [
              queuedJob({
                status: "success",
                message: "Sincronización completada.",
                phase: "done",
                items: 12,
                processedChannels: 3,
                processedPlaylists: 2,
              }),
            ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [legacyRun],
        mode: "real",
        jobs,
      }),
    });
  });

  await page.route(/\/api\/sync$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    posts++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "running",
        mode: "real",
        type: "all",
        items: 0,
        // A queued acknowledgement must ignore the legacy pagination flag.
        more: true,
        message: "Sincronización aceptada",
        job: queuedJob(),
      }),
    });
  });

  await page.goto("/settings");
  const section = page
    .locator("section.settings-card")
    .filter({ has: page.getByRole("heading", { name: "Sincronización" }) });
  const jobPanel = section.getByTestId("sync-job");
  await expect(section.locator(".sync-history")).toContainText("En curso");
  await expect(jobPanel).toHaveCount(0);

  await section.getByRole("button", { name: "Actualizar" }).click();

  await expect(page.locator(".toast")).toContainText("cola");
  await expect(page.locator(".toast")).toContainText("cierres la página");
  await expect(jobPanel).toContainText("En cola");
  await expect(jobPanel).toContainText("Fase: Suscripciones");
  await expect(section.locator(".sync-history")).toContainText("En curso");
  expect(posts).toBe(1);

  await expect(jobPanel).toContainText("En curso", { timeout: 6000 });
  await expect(jobPanel).toContainText("Fase: RSS");
  await expect(jobPanel).toContainText("2 elementos");
  await expect(jobPanel).toContainText("1 canal");

  await expect(jobPanel).toContainText("Correcta", { timeout: 6000 });
  await expect(jobPanel).toContainText("Fase: Completada");
  await expect(jobPanel).not.toContainText("Sincronización completada.");
  await expect(jobPanel).toContainText("12 elementos");
  await expect(jobPanel).toContainText("3 canales");
  await expect(jobPanel).toContainText("2 listas");
  expect(posts).toBe(1);

  const readsAtSuccess = statusReads;
  await page.waitForTimeout(3500);
  expect(statusReads).toBe(readsAtSuccess);
  expect(posts).toBe(1);
});

test("el sondeo se detiene al navegar fuera de Configuración", async ({
  page,
}) => {
  let statusReads = 0;
  await page.route(/\/api\/sync\/status$/, async (route) => {
    statusReads++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [],
        mode: "real",
        jobs: [
          queuedJob({
            status: "running",
            phase: "rss",
            items: 3,
            processedChannels: 2,
          }),
        ],
      }),
    });
  });

  await page.goto("/settings");
  await expect(page.getByTestId("sync-job")).toContainText("En curso");
  await expect.poll(() => statusReads, { timeout: 8000 }).toBeGreaterThan(1);

  await page.locator(".bottom-nav").getByRole("link", { name: "Feed" }).click();
  await expect(
    page.getByRole("heading", { name: "Feed", exact: true, level: 1 }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  const readsAfterNavigation = statusReads;
  await page.waitForTimeout(3500);
  expect(statusReads).toBe(readsAfterNavigation);
});

test("el estado en pausa muestra fase, contadores y el siguiente intento sin sondear", async ({
  page,
}) => {
  let statusReads = 0;
  await page.route(/\/api\/sync\/status$/, async (route) => {
    statusReads++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [],
        mode: "real",
        jobs: [
          queuedJob({
            status: "paused",
            phase: "metadata",
            items: 4,
            processedChannels: 2,
            message: "Límite temporal de YouTube",
            nextAttemptAt: "2026-10-20T10:05:00.000Z",
          }),
        ],
      }),
    });
  });

  await page.goto("/settings");
  const jobPanel = page
    .locator("section.settings-card")
    .filter({ has: page.getByRole("heading", { name: "Sincronización" }) })
    .getByTestId("sync-job");
  await expect(jobPanel).toContainText("En pausa");
  await expect(jobPanel).toContainText("Fase: Metadatos");
  await expect(jobPanel).toContainText("4 elementos");
  await expect(jobPanel).toContainText("2 canales");
  await expect(jobPanel).toContainText("Límite temporal de YouTube");
  await expect(jobPanel).toContainText("Reintento automático:");

  const reads = statusReads;
  await page.waitForTimeout(3500);
  expect(statusReads).toBe(reads);
});
