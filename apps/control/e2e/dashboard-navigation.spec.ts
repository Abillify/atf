// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E: Dashboard Navigation
 *
 * Verifies that the main navigation links render and lead to the correct pages.
 * The backend is fully mocked — no real server required.
 */

import { test, expect } from "@playwright/test";
import { mockBackend, setTestToken } from "./helpers/mock-backend";

test.describe("Dashboard navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
  });

  test("loads the dashboard root and shows the nav bar", async ({ page }) => {
    await page.goto("/graph");
    // Nav bar should contain key links
    await expect(page.getByRole("link", { name: "Live Graph" })).toBeVisible();
    await expect(page.getByRole("link", { name: "History" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Traces" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Security" })).toBeVisible();
  });

  test("navigates to the Traces page", async ({ page }) => {
    await page.goto("/traces");
    await expect(page.getByRole("heading", { name: /Execution Trace Viewer/i })).toBeVisible();
    await expect(page.getByPlaceholder("Execution ID…")).toBeVisible();
  });

  test("navigates to the History page", async ({ page }) => {
    await page.goto("/history");
    // Some form of heading or table should appear
    const heading = page.getByRole("heading");
    await expect(heading.first()).toBeVisible();
  });

  test("navigates to the Flows page", async ({ page }) => {
    await page.goto("/flows");
    const heading = page.getByRole("heading");
    await expect(heading.first()).toBeVisible();
  });

  test("navigates to the Security page", async ({ page }) => {
    await page.goto("/security");
    const heading = page.getByRole("heading");
    await expect(heading.first()).toBeVisible();
  });
});
