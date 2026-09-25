// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the security-header and CSRF middleware wiring applied globally
 * in `src/index.ts` (`hono/secure-headers` + `csrfProtection()`).
 *
 * These exercise the SAME middleware factories with the SAME defaults `index.ts`
 * uses, on a minimal standalone Hono app — `src/index.ts` itself boots a full
 * server (persistence, MCP, …) and is not import-safe for a unit test.
 *
 * Regression coverage for:
 *   - Missing security response headers (CSP/HSTS/X-Frame-Options/etc. were
 *     entirely absent before this change).
 *   - Cookie-based auth on `/v1/*` (`authMiddleware` accepts a `token` cookie)
 *     had no CSRF defense — a same-site form POST from a third-party page could
 *     execute with the victim's cookie.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { csrfProtection } from "../csrf-protection.js";
import { approvalWidgetEmbeddingMiddleware } from "../approval-widget-embedding.js";

function buildApp(): Hono {
  const app = new Hono();
  app.use("*", approvalWidgetEmbeddingMiddleware);
  app.use("*", secureHeaders());
  app.use("*", csrfProtection());
  app.post("/v1/chat/completions", (ctx) => ctx.json({ ok: true }));
  app.get("/v1/chat/completions", (ctx) => ctx.json({ ok: true }));
  app.delete("/eval/cases/:id", (ctx) => ctx.json({ removed: true }));
  app.post("/webhooks/git", (ctx) => ctx.json({ ok: true }));
  app.get("/monitoring/approvals/:id/widget", (ctx) => {
    ctx.header(
      "Content-Security-Policy",
      "frame-ancestors 'self' https://chat.example.com;",
    );
    return ctx.html("<p>approval</p>");
  });
  return app;
}

describe("secureHeaders()", () => {
  test("keeps core headers on normal API responses", async () => {
    const app = buildApp();
    const res = await app.request("https://api.example.com/v1/chat/completions");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("X-DNS-Prefetch-Control")).toBe("off");
    expect(res.headers.get("X-Download-Options")).toBe("noopen");
    expect(res.headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
  });

  test("allows only approval HTML routes to be embedded under their CSP policy", async () => {
    const app = buildApp();
    const res = await app.request(
      "https://api.example.com/monitoring/approvals/approval-1/widget",
    );
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self' https://chat.example.com;",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("removes the X-Powered-By header", async () => {
    const app = buildApp();
    const res = await app.request("https://api.example.com/v1/chat/completions");
    expect(res.headers.get("X-Powered-By")).toBeNull();
  });
});

describe("csrf()", () => {
  test("allows a same-origin JSON POST (the normal /v1/* client shape)", async () => {
    const app = buildApp();
    const res = await app.request("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://api.example.com",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  test("allows a GET request regardless of origin (safe method)", async () => {
    const app = buildApp();
    const res = await app.request("https://api.example.com/v1/chat/completions", {
      method: "GET",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("blocks a cross-origin form-urlencoded POST (the cookie-riding CSRF vector)", async () => {
    const app = buildApp();
    const res = await app.request("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example.com",
      },
      body: "message=hi",
    });
    expect(res.status).toBe(403);
  });

  test("blocks a cross-origin multipart/form-data POST", async () => {
    const app = buildApp();
    const res = await app.request("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=x",
        Origin: "https://evil.example.com",
      },
      body: "--x--",
    });
    expect(res.status).toBe(403);
  });

  test("allows a cross-origin JSON POST to pass CSRF (JSON cannot be sent by a bare HTML form)", async () => {
    // csrf() only gates form-encodable content types, because those are the
    // ones a plain <form> (no JS, no preflight) can send cross-site with the
    // victim's cookies attached. application/json requires a script (and thus
    // a CORS preflight, which the app's separate cors() middleware governs).
    const app = buildApp();
    const res = await app.request("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  test("still rejects a cross-origin form POST without a content type", async () => {
    const res = await buildApp().request("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
      body: "x",
    });
    expect(res.status).toBe(403);
  });

  test("lets a body-less DELETE through (forms cannot send DELETE; cors() preflight governs it)", async () => {
    const res = await buildApp().request("https://api.example.com/eval/cases/abc", {
      method: "DELETE",
      headers: { Origin: "http://localhost:3101" },
    });
    expect(res.status).toBe(200);
  });

  test("exempts HMAC-signed webhooks", async () => {
    const res = await buildApp().request("https://api.example.com/webhooks/git", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://git.example.com" },
      body: "a=b",
    });
    expect(res.status).toBe(200);
  });
});
