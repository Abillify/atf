// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * E2E: BFF same-origin guard with a pinned public origin.
 *
 * NOT RUN LOCALLY: needs a Control server started with
 *   CONTROL_SESSION_MODE=bff CONTROL_SESSION_SECRET=<32+ chars>
 *   CONTROL_PUBLIC_ORIGIN=http://localhost:3000
 * and E2E_BFF=1. Without E2E_BFF the specs are skipped. The same behaviour is
 * covered offline by src/app/api/session/route.test.ts,
 * src/app/api/backend/[...path]/route.test.ts and src/lib/same-origin.test.ts.
 */
import { test, expect } from "@playwright/test";

test.skip(process.env["E2E_BFF"] !== "1", "needs a BFF-mode server with CONTROL_PUBLIC_ORIGIN");

const ORIGIN = process.env["BASE_URL"] ?? "http://localhost:3000"\;
// Unsigned JWT-shaped handoff token; the session route only reads its claims.
const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "none" })}.${b64({ role: "operator", exp: 4_000_000_000 })}.sig`;

test("same-origin handoff sets the sealed cookie and logout clears it", async ({ request }) => {
  const headers = { origin: ORIGIN, "content-type": "application/json" };
  const login = await request.post("/api/session", { headers, data: { token: TOKEN } });
  expect(login.status()).toBe(200);
  expect(login.headers()["set-cookie"]).toContain("HttpOnly");
  const logout = await request.delete("/api/session", { headers: { origin: ORIGIN } });
  expect(logout.status()).toBe(200);
  expect(logout.headers()["set-cookie"]).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
});

test("a foreign origin is rejected even with a spoofed X-Forwarded-Host", async ({ request }) => {
  const res = await request.post("/api/session", {
    headers: {
      origin: "https://attacker.example",
      "x-forwarded-host": "attacker.example",
      "content-type": "application/json",
    },
    data: { token: TOKEN },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error).toBe("cross_site_request");
});
