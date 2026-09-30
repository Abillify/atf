// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:1420", ...devices["Desktop Chrome"] },
  webServer: { command: "VITE_OUTPOST_CONTROL_URL=http://127.0.0.1:9 VITE_OUTPOST_CONTROL_TOKEN=test bun run dev --host 127.0.0.1", url: "http://127.0.0.1:1420", reuseExistingServer: false },
});