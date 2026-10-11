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
    // Req 9.11: enforce coverage thresholds. They sit just below the measured
    // baseline so regressions fail every `bun run test` (coverage is enabled
    // by default) while incremental work stays green.
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/__tests__/**",
        "src/test-setup.ts",
      ],
      thresholds: {
        statements: 50,
        branches: 45,
        functions: 45,
        lines: 50,
      },
    },
  },
});
