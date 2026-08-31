// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { expect, test } from "@playwright/test";

const budget = {
  navigationMs: 3_000,
  firstContentfulPaintMs: 2_000,
  transferBytes: 5_242_880,
};

test("auth shell stays within the opt-in browser budget", async ({ page }) => {
  await page.goto("/auth", { waitUntil: "load" });
  await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint").length > 0);
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const paint = performance.getEntriesByName("first-contentful-paint")[0] as PerformanceEntry | undefined;
    const transferBytes = performance.getEntriesByType("resource")
      .reduce((sum, entry) => sum + ((entry as PerformanceResourceTiming).transferSize || 0), navigation.transferSize || 0);
    return {
      navigationMs: navigation.duration,
      firstContentfulPaintMs: paint?.startTime ?? Number.POSITIVE_INFINITY,
      transferBytes,
    };
  });
  test.info().annotations.push({ type: "budget", description: JSON.stringify({ budget, timing }) });
  expect(timing.navigationMs).toBeLessThanOrEqual(budget.navigationMs);
  expect(timing.firstContentfulPaintMs).toBeLessThanOrEqual(budget.firstContentfulPaintMs);
  expect(timing.transferBytes).toBeLessThanOrEqual(budget.transferBytes);
});
