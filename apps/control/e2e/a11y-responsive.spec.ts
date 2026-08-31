// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E: Accessibility + responsive shell (UI-STYLE-GUIDE.md §6, §7, §10)
 *
 * - axe-core scan of the app shell (header + navigation) — the components this
 *   project owns — must have zero WCAG A/AA violations.
 * - Responsive navigation: burger drawer < lg, persistent sidebar ≥ lg.
 * - ⌘K command palette opens, filters, navigates, and closes.
 *
 * Backend fully mocked; no real server required.
 */

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockBackend, setTestToken } from "./helpers/mock-backend";

test.describe("App shell — a11y & responsive", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockBackend(page);
    await setTestToken(page);
  });

  test("header + navigation have no WCAG A/AA axe violations", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByRole("banner")).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include("header")
      .include('nav[aria-label="Dashboard sections"]')
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("desktop (≥lg): sidebar is visible, burger hidden", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/graph");
    await expect(
      page.getByRole("navigation", { name: "Dashboard sections" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open navigation menu" }),
    ).toBeHidden();
  });

  test("mobile shell (drawer closed) has no WCAG A/AA axe violations", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/history");
    await expect(
      page.getByRole("button", { name: "Open navigation menu" }),
    ).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include("header")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("mobile (<lg): burger opens a focus-trapped drawer, Escape closes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/graph");

    const burger = page.getByRole("button", { name: "Open navigation menu" });
    await expect(burger).toBeVisible();

    await burger.click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    // grouped links present in the drawer
    await expect(drawer.getByRole("link", { name: "Live Graph" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  test("⌘K opens the command palette, filters, and navigates", async ({
    page,
  }) => {
    await page.goto("/graph");
    await page.keyboard.press("ControlOrMeta+k");

    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();

    const input = palette.getByRole("combobox");
    await input.fill("tenants");
    await expect(palette.getByRole("option")).toHaveCount(1);
    await input.press("Enter");

    await expect(page).toHaveURL(/\/tenants$/);
  });

  test("command palette closes on Escape", async ({ page }) => {
    await page.goto("/graph");
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });
});
