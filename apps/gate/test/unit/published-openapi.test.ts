// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Contract tests for the Gate's PUBLISHED OpenAPI document (requirement 14.5):
 * valid OpenAPI 3.1, product version, and the routers assembled in app.ts
 * (health, RFC 9728 metadata, erasure, MCP transports, monitor) present.
 *
 * (openapi.test.ts covers the separate OpenAPI tool-import feature.)
 */

import { describe, expect, test } from "bun:test";
import type { Request } from "express";
import { version } from "../../package.json";
import {
  buildOpenApiSpec,
  buildOpenApiYaml,
  resolveOpenApiServerUrl,
} from "../../src/openapi.ts";

const spec = buildOpenApiSpec("http://127.0.0.1:3003") as {
  openapi: string;
  info: { version: string; title: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, { "x-enabled-when"?: string }>>;
  components: { securitySchemes: Record<string, unknown> };
};

describe("published OpenAPI document (gate)", () => {
  test("is a valid OpenAPI 3.1 document with the product version", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.version).toBe(version);
    expect(spec.info.title).toContain("Gate");
    expect(spec.servers[0]?.url).toBe("http://127.0.0.1:3003");
  });

  test("covers the routers assembled in app.ts", () => {
    for (const p of [
      "/healthz",
      "/readyz",
      "/.well-known/oauth-protected-resource",
      "/v1/erasure",
      "/metrics",
      "/sse",
      "/messages",
      "/mcp",
      "/mcp/v2026",
      "/monitor/login",
      "/monitor/tools/{name}/run",
    ]) {
      expect(spec.paths[p], `missing path ${p}`).toBeDefined();
    }
    expect(spec.paths["/mcp"]?.["get"]).toBeDefined();
    expect(spec.paths["/mcp"]?.["delete"]).toBeDefined();
  });

  test("conditional routers carry x-enabled-when", () => {
    expect(spec.paths["/metrics"]?.["get"]?.["x-enabled-when"]).toContain(
      "server.metrics.enabled",
    );
    expect(spec.paths["/mcp/v2026"]?.["post"]?.["x-enabled-when"]).toContain(
      "server.mcp2026.enabled",
    );
  });

  test("declares the security schemes used by the operations", () => {
    for (const s of ["bearerAuth", "serviceAuth", "sessionCookie", "webhookSignature"]) {
      expect(spec.components.securitySchemes[s], s).toBeDefined();
    }
  });
});

describe("published OpenAPI YAML (gate)", () => {
  test("serializes to YAML starting with the openapi key", () => {
    const yaml = buildOpenApiYaml("http://127.0.0.1:3003");
    expect(yaml.startsWith("openapi: 3.1.0")).toBe(true);
    expect(yaml).toContain("paths:");
  });
});

describe("resolveOpenApiServerUrl (gate)", () => {
  function fakeRequest(headers: Record<string, string>, protocol = "http"): Request {
    return {
      headers,
      protocol,
      socket: {},
    } as unknown as Request;
  }

  test("prefers PUBLIC_URL", () => {
    const prev = process.env["PUBLIC_URL"];
    process.env["PUBLIC_URL"] = "https://gw.example.com/";
    try {
      expect(resolveOpenApiServerUrl(fakeRequest({ host: "x:3000" }))).toBe(
        "https://gw.example.com",
      );
    } finally {
      if (prev === undefined) delete process.env["PUBLIC_URL"];
      else process.env["PUBLIC_URL"] = prev;
    }
  });

  test("uses forwarded proto/host behind a proxy", () => {
    const req = fakeRequest(
      {
        host: "10.0.0.5:3003",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "gw.example.com",
      },
      "http",
    );
    expect(resolveOpenApiServerUrl(req)).toBe("https://gw.example.com");
  });

  test("falls back to the request host", () => {
    expect(resolveOpenApiServerUrl(fakeRequest({ host: "127.0.0.1:3003" }))).toBe(
      "http://127.0.0.1:3003",
    );
  });
});
