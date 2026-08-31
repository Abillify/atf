// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import {
  buildControlCspPolicy,
  controlCspHeaders,
  parseControlCspMode,
  sanitizeBackendOrigin,
} from "../lib/csp-policy";

describe("Control CSP report-only policy", () => {
  test("defaults to legacy and rejects an explicitly invalid mode", () => {
    expect(parseControlCspMode(undefined)).toBe("legacy");
    expect(parseControlCspMode("")).toBe("legacy");
    expect(parseControlCspMode("report-only")).toBe("report-only");
    expect(() => parseControlCspMode("enforce")).toThrow(
      "Invalid CONTROL_CSP_MODE",
    );
  });

  test("emits only the report-only header with safe Next/React directives", () => {
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

  test("legacy emits nothing and production excludes unsafe-eval", () => {
    expect(controlCspHeaders({ mode: "legacy" })).toEqual([]);
    expect(buildControlCspPolicy()).not.toContain("'unsafe-eval'");
  });

  test("sanitizes the configured backend to a credential-free HTTP origin", () => {
    expect(sanitizeBackendOrigin("http://localhost:4000/v1")).toBe(
      "http://localhost:4000",
    );
    expect(sanitizeBackendOrigin("https://user:secret@example.test")).toBeNull();
    expect(sanitizeBackendOrigin("javascript:alert(1)\r\nInjected: yes")).toBeNull();
  });
});
