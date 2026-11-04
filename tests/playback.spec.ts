import { test, expect } from "@playwright/test";

const videos = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"].map((id, i) => ({
  id, title: `Vídeo ${i + 1}`, channelId: "UCtest", channelTitle: "Canal de prueba",
  thumbnailUrl: "/thumbs/01.svg", publishedAt: "2026-01-01T00:00:00Z", description: "",
  durationSeconds: 100, watched: false, positionSeconds: 0, percent: 0, manual: false, transient: true,
}));
test("cola: mismo iframe al añadir, navegar, rotar, avanzar y recuperar autoplay", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/videos/")) requests.push(request.method() + " " + new URL(request.url()).pathname); });
  await page.route("**/api/feed?*", route => route.fulfill({ json: { items: videos, nextCursor: null } }));
  await page.route("https://www.youtube.com/iframe_api", route => route.fulfill({ contentType: "application/javascript", body: `
    window.mock = { constructs: 0, destroys: 0, loads: [], plays: 0 };
    window.YT = { Player: class {
      constructor(el, options) { this.options = options; this.iframe = document.createElement('iframe'); this.iframe.srcdoc = '<body>Reproductor simulado</body>'; el.replaceWith(this.iframe); window.mock.player = this; window.mock.constructs++; setTimeout(() => options.events.onReady(), 0); }
      getIframe() { return this.iframe; } getCurrentTime() { return 0; } getDuration() { return 100; } getPlayerState() { return 1; }
      loadVideoById(options) { window.mock.loads.push(options); }
      playVideo() { window.mock.plays++; this.options.events.onStateChange({data: 1}); }
      destroy() { window.mock.destroys++; this.iframe.remove(); }
    }}; window.onYouTubeIframeAPIReady();
  ` }));
  await page.goto("/feed");
  const addToQueue = async (n: number) => {
    const options = page.getByRole("button", { name: `Opciones de Vídeo ${n}`, exact: true });
    await expect(page.getByRole("button", { name: /^Añadir a la cola/ })).toHaveCount(0);
    await expect(page.locator(".video-card").filter({ has: options }).locator(".card-actions > button")).toHaveCount(0);
    await options.click();
    await page.getByRole("button", { name: "Añadir a la cola", exact: true }).click();
    await expect(options).toHaveAttribute("aria-expanded", "false");
  };
  await addToQueue(1);
  const iframe = page.locator(".youtube-host iframe");
  await expect(iframe).toBeVisible();
  const identity = await iframe.elementHandle();
  await expect(page).toHaveURL(/\/feed/);
  await expect.poll(() => page.evaluate(() => (window as any).mock.plays)).toBe(0);
  for (const n of [2, 3, 4]) await addToQueue(n);
  await page.getByRole("button", { name: "Cola (3)", exact: true }).click();
  await expect(page.locator(".playback-queue li")).toHaveCount(3);
  await page.getByRole("button", { name: "Subir Vídeo 3", exact: true }).click();
  await expect(page.locator(".queue-video").first()).toHaveText("Vídeo 3Canal de prueba");
  await page.getByRole("button", { name: "Quitar Vídeo 4", exact: true }).click();
  await page.getByRole("link", { name: "Volver al vídeo: Vídeo 1", exact: true }).click();
  await expect(page.locator(".mini-player")).toHaveCount(0);
  await page.setViewportSize({ width: 844, height: 390 });
  expect(await iframe.evaluate((el, original) => el === original, identity)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).mock.player.options.events.onStateChange({data: 0}));
  await expect.poll(() => page.evaluate(() => (window as any).mock.loads)).toEqual([{ videoId: videos[2].id, startSeconds: 0 }]);
  await expect(page).toHaveURL(new RegExp(`/watch/${videos[2].id}$`));
  await page.evaluate(() => (window as any).mock.player.options.events.onStateChange({data: 0}));
  expect(await page.evaluate(() => (window as any).mock.loads.length)).toBe(1);
  await page.evaluate(() => (window as any).mock.player.options.events.onAutoplayBlocked());
  await page.getByRole("button", { name: "Continuar reproducción", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).mock.plays)).toBe(1);
  await expect(page.getByRole("button", { name: "Continuar reproducción", exact: true })).toHaveCount(0);
  // An unavailable queued video must not strand the remaining queue.
  await page.evaluate(() => (window as any).mock.player.options.events.onError({data: 150}));
  await expect.poll(() => page.evaluate(() => (window as any).mock.loads.length)).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/watch/${videos[1].id}$`));
  await expect(page.getByRole("button", { name: "Siguiente", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Feed", exact: true }).last().click();
  await expect(page.locator(".mini-player")).toBeVisible();
  await page.getByRole("link", { name: "Ver Vídeo 4", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).mock.loads.length)).toBe(3);
  await page.getByRole("link", { name: "Feed", exact: true }).last().click();
  await page.getByRole("button", { name: "Cola (0)", exact: true }).click();
  await addToQueue(1);
  await page.getByRole("button", { name: "Cola (1)", exact: true }).click();
  await expect(page.locator(".playback-queue li")).toHaveCount(1);
  await page.getByRole("button", { name: "Vaciar cola", exact: true }).click();
  await expect(page.locator(".playback-queue li")).toHaveCount(0);
  await expect(page.locator(".mini-player")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "/tmp/alveo-playback-queue.png" });
  expect(await iframe.evaluate((el, original) => el === original, identity)).toBe(true);
  expect(await page.evaluate(() => ({ constructs: (window as any).mock.constructs, destroys: (window as any).mock.destroys }))).toEqual({ constructs: 1, destroys: 0 });
  expect(requests).toEqual([]);
});
