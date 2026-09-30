// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Property tests do real fs I/O (journal + fsync) — on slow volumes the
    // 5 s default is too tight for 100-run properties.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
