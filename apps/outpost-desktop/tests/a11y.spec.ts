// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("desktop shell is keyboard accessible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Sync, der im Hintergrund/i })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
});

test("source actions and credential fields are labeled", async ({ page }) => {
  await page.route("**/status", (route) => route.fulfill({ json: { paused: false, sources: [
    { sourceId: "drive", type: "gdrive", auth: "oauth", status: "needs-authorization", pending: false },
    { sourceId: "archive", type: "s3", status: "idle", pending: false, credentials: { configured: false } },
  ] } }));
  await page.route("**/config", (route) => route.fulfill({ json: { extractUrl: "https://extract.test", collection: "docs", syncIntervalSec: 900, mirrorDelete: true, sources: [] } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Erneut autorisieren" })).toBeVisible();
  await expect(page.getByLabel("S3 Access-Key-ID")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("S3 Secret-Access-Key")).toHaveAttribute("autocomplete", "off");
  await expect(page.getByLabel("Extract URL")).toHaveValue("https://extract.test");
  await expect(page.locator("[aria-live='polite']")).toBeVisible();
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
});