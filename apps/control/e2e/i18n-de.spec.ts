// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * E2E: every dashboard route renders in German (NEXT_LOCALE=de) without a
 * page error or the error boundary. Not run locally unless a browser is
 * installed; the vitest i18n suites cover the catalogs.
 */
import { test, expect } from "@playwright/test";
import { DASHBOARD_ROUTES } from "./helpers/dashboard-routes";
import { mockBackend, setTestToken } from "./helpers/mock-backend";

for (const route of DASHBOARD_ROUTES) {
  test(`de ${route}`, async ({ page, context }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: "de", url: "http://localhost:3000" }]);
    await mockBackend(page);
    await setTestToken(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(route);
    await expect(page.getByRole("main")).toBeVisible();
    await page.waitForTimeout(400);
    expect(await page.locator("html").getAttribute("lang")).toBe("de");
    expect(await page.getByText("Etwas ist schiefgelaufen").count()).toBe(0);
    expect(errors).toEqual([]);
  });
}
