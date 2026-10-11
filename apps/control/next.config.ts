// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { realpathSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

/**
 * Control (Next.js) build configuration.
 *
 * Two points are deliberately different from the legacy frontend config:
 *
 * 1. `outputFileTracingRoot` points at the workspace root, not at the app
 *    directory. Control is part of a Bun workspace with hoisted
 *    `node_modules`; if the tracing root were pinned to `apps/control`, the
 *    standalone output would miss the resolved dependencies. With the
 *    workspace root the server ends up at
 *    `.next/standalone/apps/control/server.js`.
 *
 * 2. `NEXT_PUBLIC_BACKEND_URL` is NOT baked into the build via `env`.
 *    `src/lib/backend-url.ts` resolves the backend base relatively at runtime
 *    on purpose, so the same image works behind any reverse proxy. A
 *    build-time default would make the image environment-specific.
 *
 * CSP and the baseline security headers are no longer declared here: they are
 * emitted per request by `src/proxy.ts` (Next 16 middleware), which can inject
 * a fresh nonce into both the response policy and the rendered HTML.
 */
const workspaceRoot = path.join(import.meta.dirname, "..", "..");
const swcHelpersRoot = realpathSync(
  path.join(import.meta.dirname, "node_modules", "@swc", "helpers"),
);
const swcHelpersEsmGlob = path
  .join(path.relative(import.meta.dirname, swcHelpersRoot), "esm", "**", "*")
  .split(path.sep)
  .join(path.posix.sep);

const nextConfig: NextConfig = {
  // Lean production image: emits a minimal server.js.
  output: "standalone",
  // Prevents Next.js from guessing the workspace root across multiple
  // lockfiles (which used to emit a warning in dev/Playwright runs).
  outputFileTracingRoot: workspaceRoot,
  // Node 26 picks the `module-sync` exports under `esm/` for @swc/helpers.
  // Next.js' tracer currently only detects the CJS targets. The real package
  // path bypasses Bun's symlink, which the include glob does not traverse.
  outputFileTracingIncludes: {
    "/*": [swcHelpersEsmGlob],
  },
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
