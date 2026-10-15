// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E: full-page accessibility sweep across every dashboard route.
 *
 * Runs axe-core over the whole page for all 27 destinations and fails on any
 * `critical`/`serious` WCAG 2 A/AA violation. (The shell-scoped test in
 * a11y-responsive.spec.ts asserts *zero* violations on nav/header; this broader
 * sweep guards the page bodies against high-impact regressions without being
 * brittle to lower-severity, content-dependent findings.)
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockBackend, setTestToken } from "./helpers/mock-backend";

/**
 * Every dashboard page, read from the app directory so the sweep cannot drift
 * from the routes that actually ship (a hard-coded list kept scanning a
 * removed page — its 404 also has a <main>, so the check passed silently).
 */
const DASHBOARD_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "app",
  "(dashboard)",
);
const ROUTES = readdirSync(DASHBOARD_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(DASHBOARD_DIR, entry.name, "page.tsx")))
  .map((entry) => `/${entry.name}`)
  .sort();

test.describe("Full-page a11y sweep", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockBackend(page);
    await setTestToken(page);
  });

  test("covers the dashboard pages", () => {
    for (const route of ["/studio", "/graph", "/security", "/compliance", "/provider-testing"]) {
      expect(ROUTES).toContain(route);
    }
    expect(ROUTES).not.toContain("/rag");
  });

  for (const route of ROUTES) {
    test(`no critical/serious axe violations: ${route}`, async ({ page }) => {
      const res = await page.goto(route);
      // A missing page renders a 404 that still has a <main>.
      expect(res?.status(), `${route} must exist`).toBeLessThan(400);
      await expect(page.getByRole("main")).toBeVisible();
      // let client data settle into empty/error/loaded state
      await page.waitForTimeout(400);

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        // The React Flow canvas (third-party) renders nodes as role="button"
        // with nested interactive content — a known library limitation we don't
        // control. Exclude it; our own chrome/content is still fully scanned.
        .exclude(".react-flow")
        .analyze();

      const serious = results.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );
      const summary = serious.map(
        (v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.help}`,
      );
      expect(summary, summary.join("\n")).toEqual([]);
    });
  }
});
