// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { defineConfig, devices } from "@playwright/test";

const port = process.env["PORT"] ?? "3000";
const baseURL = process.env["BASE_URL"] ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e/performance",
  testMatch: "*.budget.ts",
  fullyParallel: false,
  retries: 0,
  reporter: [["line"], ["json", { outputFile: "test-results/performance.json" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node .next/standalone/apps/control/server.js",
    url: `${baseURL}/auth`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: "chromium-performance", use: { ...devices["Desktop Chrome"] } }],
});
