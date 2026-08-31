// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E Test Configuration
 *
 * Tests run against the locally started Next.js dev server.
 * The backend is mocked at the network layer via Playwright's route intercept,
 * so tests are fully offline and require no running backend.
 *
 * To run:
 *   bun run test:e2e
 *
 * To run with UI:
 *   bun run test:e2e:ui
 *
 * Environment variables:
 *   BASE_URL   Override the app base URL (default: http://localhost:3000)
 */

const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],

  use: {
    baseURL: BASE_URL,
    // Keep visual-regression output independent of the runner's defaults.
    colorScheme: "light",
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Start the Next.js dev server automatically when running tests locally.
  // In CI the server is started separately so we skip this.
  webServer: process.env["CI"]
    ? undefined
    : {
        command: "bun run dev",
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
