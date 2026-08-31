// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { realpathSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import {
  controlCspHeaders,
  parseControlCspMode,
} from "./src/lib/csp-policy";

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
 */
const workspaceRoot = path.join(import.meta.dirname, "..", "..");
const swcHelpersRoot = realpathSync(
  path.join(import.meta.dirname, "node_modules", "@swc", "helpers"),
);
const swcHelpersEsmGlob = path
  .join(path.relative(import.meta.dirname, swcHelpersRoot), "esm", "**", "*")
  .split(path.sep)
  .join(path.posix.sep);

const cspMode = parseControlCspMode(process.env["CONTROL_CSP_MODE"]);

const nextConfig: NextConfig = {
  // CSP rollout is opt-in and report-only. Legacy mode emits no CSP header;
  // an enforcement header is deliberately never configured here.
  async headers() {
    const headers = controlCspHeaders({
      mode: cspMode,
      development: process.env.NODE_ENV === "development",
      backendUrl: process.env["NEXT_PUBLIC_BACKEND_URL"],
    });
    return headers.length === 0 ? [] : [{ source: "/:path*", headers }];
  },
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
