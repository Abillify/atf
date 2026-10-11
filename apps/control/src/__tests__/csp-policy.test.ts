// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import {
  buildControlCspPolicy,
  controlCspHeaders,
  controlSecurityHeaders,
  generateControlCspNonce,
  parseControlCspMode,
  sanitizeBackendOrigin,
} from "../lib/csp-policy";

describe("Control CSP policy (Req. 8.1)", () => {
  // Intentional default flip with this minor release: enforce is now the
  // default; the previous legacy default must be opted into explicitly.
  test("defaults to enforce and accepts all three modes", () => {
    expect(parseControlCspMode(undefined)).toBe("enforce");
    expect(parseControlCspMode("")).toBe("enforce");
    expect(parseControlCspMode("legacy")).toBe("legacy");
    expect(parseControlCspMode("report-only")).toBe("report-only");
    expect(parseControlCspMode("enforce")).toBe("enforce");
  });

  test("rejects an explicitly invalid mode", () => {
    expect(() => parseControlCspMode("off")).toThrow(
      "Invalid CONTROL_CSP_MODE",
    );
    expect(() => parseControlCspMode("ENFORCE")).toThrow(
      "Invalid CONTROL_CSP_MODE",
    );
  });

  test("report-only emits the report-only header with safe directives", () => {
    const headers = controlCspHeaders({
      mode: "report-only",
      development: true,
      backendUrl: "https://api.example.test/path?ignored=yes",
    });

    expect(headers).toHaveLength(1);
    expect(headers[0]?.key).toBe("Content-Security-Policy-Report-Only");
    expect(headers[0]?.key).not.toBe("Content-Security-Policy");
    expect(headers[0]?.value).toContain("default-src 'self'");
    expect(headers[0]?.value).toContain("object-src 'none'");
    expect(headers[0]?.value).toContain("frame-ancestors 'none'");
    expect(headers[0]?.value).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
    expect(headers[0]?.value).toContain(
      "connect-src 'self' https://api.example.test wss://api.example.test",
    );
    expect(headers[0]?.value).not.toMatch(/[\r\n]/);
  });

  test("enforce emits the enforcing header with a nonce and no unsafe-inline", () => {
    const nonce = generateControlCspNonce();
    const headers = controlCspHeaders({
      mode: "enforce",
      development: false,
      backendUrl: "https://api.example.test",
      nonce,
    });

    expect(headers).toHaveLength(1);
    expect(headers[0]?.key).toBe("Content-Security-Policy");
    expect(headers[0]?.value).toContain(`'nonce-${nonce}'`);
    // unsafe-inline must be gone from script-src specifically; style-src keeps
    // it by documented ADR (Tailwind/xyflow inline styles, no nonce possible).
    const scriptSrc = headers[0]?.value
      .split("; ")
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBe(`script-src 'self' 'nonce-${nonce}'`);
    expect(headers[0]?.value).not.toContain("'unsafe-eval'");
    expect(headers[0]?.value).toContain("style-src 'self' 'unsafe-inline'");
  });

  test("legacy emits nothing and production excludes unsafe-eval", () => {
    expect(controlCspHeaders({ mode: "legacy" })).toEqual([]);
    expect(buildControlCspPolicy()).not.toContain("'unsafe-eval'");
  });

  test("nonces are 128-bit base64url and unique per call", () => {
    const nonces = new Set(
      Array.from({ length: 64 }, () => generateControlCspNonce()),
    );
    expect(nonces.size).toBe(64);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  test("security headers: nosniff/referrer/permissions always, HSTS only on HTTPS", () => {
    const insecure = controlSecurityHeaders({ secure: false });
    expect(insecure.map((h) => h.key)).not.toContain(
      "Strict-Transport-Security",
    );
    const keys = insecure.map((h) => h.key);
    expect(keys).toContain("X-Content-Type-Options");
    expect(keys).toContain("Referrer-Policy");
    expect(keys).toContain("Permissions-Policy");
    expect(keys).toContain("X-Frame-Options");
    expect(
      insecure.find((h) => h.key === "X-Content-Type-Options")?.value,
    ).toBe("nosniff");
    expect(insecure.find((h) => h.key === "Referrer-Policy")?.value).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(
      insecure.find((h) => h.key === "Permissions-Policy")?.value,
    ).toContain("camera=()");

    const secure = controlSecurityHeaders({ secure: true });
    const hsts = secure.find(
      (h) => h.key === "Strict-Transport-Security",
    )?.value;
    expect(hsts).toContain("max-age=31536000");
  });

  test("sanitizes the configured backend to a credential-free HTTP origin", () => {
    expect(sanitizeBackendOrigin("http://localhost:4000/v1")).toBe(
      "http://localhost:4000",
    );
    expect(
      sanitizeBackendOrigin("https://user:secret@example.test"),
    ).toBeNull();
    expect(
      sanitizeBackendOrigin("javascript:alert(1)\r\nInjected: yes"),
    ).toBeNull();
  });
});
