// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Contract tests for the Runtime OpenAPI document (requirement 14.5):
 * the served document must be valid OpenAPI 3.1, carry the product version,
 * cover the core planes, and never silently drop routes into a generic tag.
 */

import { describe, expect, test } from "bun:test";
import { version } from "../../package.json";
import {
  buildOpenApiSpec,
  buildOpenApiYaml,
  resolveOpenApiServerUrl,
} from "../openapi.js";

const spec = buildOpenApiSpec("http://127.0.0.1:3000") as {
  openapi: string;
  info: { version: string; title: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, { tags?: string[] }>>;
  components: { securitySchemes: Record<string, unknown> };
};

describe("buildOpenApiSpec (runtime)", () => {
  test("is a valid OpenAPI 3.1 document with the product version", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.version).toBe(version);
    expect(spec.info.title).toContain("Runtime");
    expect(spec.servers[0]?.url).toBe("http://127.0.0.1:3000");
  });

  test("covers the core planes parsed from the real router tree", () => {
    // Parsed from the router tree (route-catalog.ts), so these must exist.
    for (const p of [
      "/v1/chat/completions",
      "/v1/models",
      "/health",
      "/metrics",
    ]) {
      expect(spec.paths[p], `missing path ${p}`).toBeDefined();
    }
    // The inventory is substantial — a parser regression that drops most
    // routes must fail here, not silently shrink the published document.
    expect(Object.keys(spec.paths).length).toBeGreaterThan(100);
  });

  test("no route falls back to the generic Other tag", () => {
    const other = Object.entries(spec.paths).filter(([, item]) =>
      Object.values(item).some((op) => op.tags?.includes("Other")),
    );
    expect(other.map(([p]) => p)).toEqual([]);
  });

  test("declares the security schemes used by the operations", () => {
    expect(spec.components.securitySchemes["bearerAuth"]).toBeDefined();
    expect(spec.components.securitySchemes["sessionCookie"]).toBeDefined();
    expect(spec.components.securitySchemes["webhookSignature"]).toBeDefined();
  });

  test("path templates use OpenAPI braces, not framework colons", () => {
    for (const p of Object.keys(spec.paths)) {
      expect(p).not.toMatch(/:[A-Za-z_$]/);
      for (const m of p.matchAll(/\{([^}]+)\}/g)) {
        expect(m[1]).toMatch(/^[A-Za-z_$][\w$]*$/);
      }
    }
  });
});

describe("buildOpenApiYaml (runtime)", () => {
  test("serializes to YAML starting with the openapi key", () => {
    const yaml = buildOpenApiYaml("http://127.0.0.1:3000");
    expect(yaml.startsWith("openapi: 3.1.0")).toBe(true);
    expect(yaml).toContain("paths:");
  });
});

describe("resolveOpenApiServerUrl (runtime)", () => {
  test("prefers PUBLIC_URL", () => {
    const prev = process.env["PUBLIC_URL"];
    process.env["PUBLIC_URL"] = "https://api.example.com/";
    try {
      expect(resolveOpenApiServerUrl("http://127.0.0.1:3000/openapi.json")).toBe(
        "https://api.example.com",
      );
    } finally {
      if (prev === undefined) delete process.env["PUBLIC_URL"];
      else process.env["PUBLIC_URL"] = prev;
    }
  });

  test("falls back to the request origin", () => {
    expect(
      resolveOpenApiServerUrl("http://runtime.internal:3000/openapi.json"),
    ).toBe("http://runtime.internal:3000");
  });
});
