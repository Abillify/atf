// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature Coverage Test (Req. 13.7, Task 22.6).
 *
 * Verifies that every documented backend capability has a corresponding
 * frontend route under (dashboard)/. A missing route page.tsx is a test
 * failure — this ensures no route is forgotten during development.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Expected routes
// ---------------------------------------------------------------------------

/**
 * All routes that must exist as Next.js App Router page files under
 * frontend/src/app/(dashboard)/<route>/page.tsx
 *
 * Validates: Req. 13.7
 */
const EXPECTED_ROUTES = [
  "graph",
  "cost",
  "limits",
  "history",
  "approvals",
  "canary",
  "optimizer",
  "flows",
  "security",
  "traces",
  "flow-diff",
  "rag",
  "memory",
  "tenants",
  "eval",
  "providers",
  "guardrails",
  "mcp",
  "pii-vault",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DASHBOARD_DIR = join(__dirname, "..", "app", "(dashboard)");

function routePagePath(route: string): string {
  return join(DASHBOARD_DIR, route, "page.tsx");
}

function routeLoadingPath(route: string): string {
  return join(DASHBOARD_DIR, route, "loading.tsx");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Feature route coverage (Req. 13.7)", () => {
  const missingPages: string[] = [];
  const missingLoading: string[] = [];

  beforeAll(() => {
    for (const route of EXPECTED_ROUTES) {
      if (!existsSync(routePagePath(route))) {
        missingPages.push(route);
      }
      if (!existsSync(routeLoadingPath(route))) {
        missingLoading.push(route);
      }
    }
  });

  it("should have a page.tsx for every required route", () => {
    if (missingPages.length > 0) {
      const list = missingPages.map((r) => `  - /${r}/page.tsx`).join("\n");
      throw new Error(
        `Missing page files for ${missingPages.length} route(s):\n${list}\n` +
          `Each documented capability must have a corresponding route.`,
      );
    }
  });

  it("should have a loading.tsx for every required route", () => {
    if (missingLoading.length > 0) {
      const list = missingLoading
        .map((r) => `  - /${r}/loading.tsx`)
        .join("\n");
      throw new Error(
        `Missing loading files for ${missingLoading.length} route(s):\n${list}\n` +
          `Each route must define a loading skeleton.`,
      );
    }
  });

  // Individual route assertions — one test per route for clear reporting
  describe.each(EXPECTED_ROUTES.map((r) => [r]))("route /%s", (route) => {
    it("has page.tsx", () => {
      expect(existsSync(routePagePath(route))).toBe(true);
    });

    it("has loading.tsx", () => {
      expect(existsSync(routeLoadingPath(route))).toBe(true);
    });
  });
});
