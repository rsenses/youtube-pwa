import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: ["browser.spec.ts", "feed.spec.ts", "sync-queue.spec.ts"],
  workers: 1,
  use: {
    baseURL: "http://localhost:5174",
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
  webServer: {
    command: "npm run ui:server",
    url: "http://localhost:5174",
    reuseExistingServer: false,
    timeout: 60000,
  },
  reporter: "list",
});
