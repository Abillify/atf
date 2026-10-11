// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E: visual-regression snapshots of the app shell.
 *
 * Snapshots the STATIC chrome (grouped sidebar, command palette, mobile drawer)
 * — deterministic surfaces driven by `lib/nav.ts` — so unintended visual drift
 * in the design-system shell is caught. Data pages are intentionally not
 * snapshotted (dynamic content). Baselines live in e2e/visual.spec.ts-snapshots/.
 *
 * Regenerate after an intentional change:
 *   BASE_URL=http://localhost:3000 bun run test:e2e -- e2e/visual.spec.ts --update-snapshots
 */

import { test, expect } from "@playwright/test";
import { mockBackend, setTestToken } from "./helpers/mock-backend";

test.describe("Visual regression — app shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockBackend(page);
    await setTestToken(page);
  });

  test("desktop sidebar (grouped nav)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/graph");
    const sidebar = page.getByRole("navigation", { name: "Dashboard sections" });
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveScreenshot("sidebar-desktop.png");
  });

  test("command palette", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/graph");
    // Wait for client hydration before sending the global keyboard shortcut.
    await expect(page.getByRole("navigation", { name: "Dashboard sections" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await expect(palette).toHaveScreenshot("command-palette.png", {
      // Chromium may vary by exactly one pixel at the rendered dialog edge.
      maxDiffPixels: 1,
    });
  });

  test("mobile nav drawer", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/graph");
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    // wait out the slide-in transition for a stable frame
    await page.waitForTimeout(300);
    await expect(drawer).toHaveScreenshot("mobile-drawer.png");
  });
});
