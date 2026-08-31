// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { defineConfig } from "vitest/config";

/** Public browser-like test environment for Control UI tests. */
export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // The Playwright specs under e2e/ run exclusively via `test:e2e`
    // (playwright test). Vitest must not collect them, otherwise the import of
    // @playwright/test fails.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "e2e/**"],
  },
});
