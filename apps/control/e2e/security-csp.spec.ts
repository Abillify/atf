// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * E2E: Control security hardening (Req. 8.1, 8.3), Task 12.6.
 *
 * Checks against the real Next server (dev mode, default CSP mode
 * `enforce`):
 *   1. The CSP header is present and contains a script nonce.
 *   2. No inline <script> in the delivered HTML lacks a nonce (or hash).
 *   3. The operator token does NOT appear in the EventSource URL; the
 *      stream uses the short-lived ticket exchange (Req. 8.3).
 */

import { test, expect } from "@playwright/test";
import { mockBackend, setTestToken, TEST_TOKEN } from "./helpers/mock-backend";

test.describe("CSP & Token-Exposure (Req 8.1 / 8.3)", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    await setTestToken(page);
  });

  test("CSP header present, enforced, with a nonce in script-src", async ({
    page,
  }) => {
    const res = await page.goto("/graph");
    expect(res).not.toBeNull();
    const csp = res?.headers()["content-security-policy"] ?? "";
    expect(csp).not.toBe("");
    // Enforce mode: a real header, not report-only.
    expect(res?.headers()["content-security-policy-report-only"]).toBeUndefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Nonce based: script-src carries a 'nonce-…' source.
    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? "";
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9_-]{16,}'/);
    // The nonce in the header must match a script in the delivered HTML
    // (theme init and Next's own inline scripts carry it). The live DOM is
    // no use as a source: the browser clears the nonce attribute as soon as
    // the script has run (CSP spec).
    const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1] ?? "";
    const html = await res?.text();
    expect(html).toBeDefined();
    const nonceUsed = await page.evaluate(
      ([doc, n]) =>
        Array.from(
          new DOMParser().parseFromString(doc, "text/html").querySelectorAll(
            "script[nonce]",
          ),
        ).some((s) => s.getAttribute("nonce") === n),
      [html ?? "", nonce],
    );
    expect(nonceUsed).toBe(true);
  });

  test("no inline <script> without a nonce", async ({ page }) => {
    const res = await page.goto("/graph");
    const csp = res?.headers()["content-security-policy"] ?? "";
    const nonce = /script-src [^;]*'nonce-([^']+)'/ .exec(csp)?.[1];
    expect(nonce).toBeTruthy();

    // Checks the delivered HTML (not the live DOM, where the browser removes
    // nonce attributes of executed scripts). DOMParser does not run scripts.
    const html = await res?.text();
    expect(html).toBeDefined();
    const offenders = await page.evaluate(
      ([doc, n]) => {
        const parsed = new DOMParser().parseFromString(doc, "text/html");
        const inline = Array.from(
          parsed.querySelectorAll("script:not([src])"),
        ).filter((s) => (s.textContent ?? "").trim().length > 0);
        return inline
          .filter((s) => s.getAttribute("nonce") !== n)
          .map(
            (s) =>
              `${s.type || "javascript"}: ${(s.textContent ?? "").slice(0, 80)}`,
          );
      },
      [html ?? "", nonce ?? ""],
    );

    expect(offenders).toEqual([]);
  });

  test("operator token does not appear in the EventSource URL", async ({
    page,
  }) => {
    const sseUrls: string[] = [];
    await page.route("**/monitoring/events**", (route) => {
      sseUrls.push(route.request().url());
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: ": heartbeat\n\n",
      });
    });

    await page.goto("/graph");
    // The hook first exchanges the token for a ticket (POST /monitoring/ticket)
    // and then connects; wait for both.
    await expect
      .poll(() => sseUrls.length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    for (const url of sseUrls) {
      // The reusable operator JWT must never end up in the URL …
      expect(url).not.toContain(TEST_TOKEN);
      // … but the short-lived ticket from the exchange does.
      expect(url).toContain("token=test-ticket");
    }
  });
});
