import { defineConfig, devices } from "@playwright/test";

// Runs against the stack started by scripts/stack.sh (spec/lot-2.md sections 5 and 13).
const workerPort = process.env.WORKER_PORT ?? "8787";

export default defineConfig({
  testDir: "./tests",
  // Every test starts from POST /ops/reset on the one shared stack, so tests never run concurrently.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: `http://127.0.0.1:${workerPort}` },
  projects: [
    { name: "api", testMatch: /.*\.api\.spec\.ts/ },
    { name: "browser", testMatch: /.*\.browser\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
});
