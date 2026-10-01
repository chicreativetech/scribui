import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "packages/canvas/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4399", viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "node packages/canvas/e2e/serve.mjs",
    url: "http://127.0.0.1:4399/api/project",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
