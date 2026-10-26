import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: ["browser.spec.ts", "feed.spec.ts", "sync-queue.spec.ts"],
  workers: 1,
  use: {
    baseURL: "http://localhost:5174",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.BRAVE_EXECUTABLE_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    },
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
