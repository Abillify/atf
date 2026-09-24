// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the provider testing bench routes.
 *
 * The three POST /monitoring/providers/test/* endpoints run REAL inference, so
 * they are covered here for their authorization and request-validation
 * contract only — exercising the generation path would require a live provider.
 * The model listing is fully covered by stubbing `fetch`, since its whole job is
 * translating each wire protocol's listing endpoint into one shape.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createProviderTestingRouter } from "../provider-testing.js";
import type { AppConfig } from "../../config/index.js";
import { setProviderRegistry } from "../../config/providers.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";

const config = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  defaultLlm: { provider: "openai-local", model: "local-model" },
} as AppConfig;

/** Router with auth switched off — the default for the behaviour tests. */
function openApp() {
  const app = new Hono();
  app.route("/", createProviderTestingRouter({ config }));
  return app;
}

/** Router with RBAC on, holding one viewer (read) and one operator (write). */
function guardedApp() {
  const app = new Hono();
  app.route(
    "/",
    createProviderTestingRouter({
      config,
      authRequired: true,
      operatorAuth: createOperatorAuthorizer({
        authRequired: true,
        tokens: [
          { token: "viewer-tok", role: "viewer" },
          { token: "operator-tok", role: "operator" },
        ],
      }),
    }),
  );
  return app;
}

const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; headers: Record<string, string> }> = [];

/** Replaces `fetch` with a single canned JSON response, recording the call. */
function stubFetch(payload: unknown, ok = true, status = 200): void {
  requests = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: ok ? status : status,
        statusText: ok ? "OK" : "Service Unavailable",
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  setProviderRegistry([
    {
      name: "openai-local",
      protocol: "openai",
      url: "http://127.0.0.1:1234/v1",
      apiKey: "local-secret",
      local: true,
    },
    {
      name: "ollama-local",
      protocol: "ollama",
      // Deliberately written with a trailing /v1 to pin the normalisation.
      url: "http://127.0.0.1:11434/v1",
      local: true,
    },
    { name: "gemini", protocol: "google", apiKey: "google-key" },
    { name: "claude-direct", protocol: "anthropic", apiKey: "anthropic-key" },
    { name: "keyless-google", protocol: "google" },
    { name: "aws", protocol: "bedrock", region: "eu-central-1" },
  ]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  setProviderRegistry([]);
});

interface ModelsBody {
  provider: string;
  models: Array<{ id: string; label?: string }>;
}
interface ErrorBody {
  error: { message: string };
}

describe("GET /monitoring/providers/:name/models", () => {
  it("lists openai-protocol models from /models and sorts them", async () => {
    stubFetch({
      data: [
        { id: "zeta-model", owned_by: "acme" },
        { id: "alpha-model" },
      ],
    });

    const res = await openApp().request(
      "/monitoring/providers/openai-local/models",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsBody;

    expect(requests[0]?.url).toBe("http://127.0.0.1:1234/v1/models");
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer local-secret",
    });
    // Sorted by id, with owned_by surfaced as the label when present.
    expect(body.models).toEqual([
      { id: "alpha-model" },
      { id: "zeta-model", label: "acme" },
    ]);
  });

  it("normalises an ollama base url and reads the native tag list", async () => {
    stubFetch({
      models: [
        { name: "bge-m3:latest", details: { parameter_size: "567M" } },
        { model: "qwen:7b" },
      ],
    });

    const res = await openApp().request(
      "/monitoring/providers/ollama-local/models",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsBody;

    // The configured /v1 suffix must be stripped before /api/tags is appended.
    expect(requests[0]?.url).toBe("http://127.0.0.1:11434/api/tags");
    expect(body.models).toEqual([
      { id: "bge-m3:latest", label: "567M" },
      { id: "qwen:7b" },
    ]);
  });

  it("uses the google api-key header and the displayName as label", async () => {
    stubFetch({
      models: [{ name: "models/gemini-3-flash", displayName: "Gemini 3 Flash" }],
    });

    const res = await openApp().request("/monitoring/providers/gemini/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsBody;

    expect(requests[0]?.url).toContain(
      "generativelanguage.googleapis.com/v1beta/models",
    );
    expect(requests[0]?.headers).toMatchObject({ "x-goog-api-key": "google-key" });
    expect(body.models).toEqual([
      { id: "models/gemini-3-flash", label: "Gemini 3 Flash" },
    ]);
  });

  it("uses the anthropic api-key and version headers", async () => {
    stubFetch({
      data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
    });

    const res = await openApp().request(
      "/monitoring/providers/claude-direct/models",
    );
    expect(res.status).toBe(200);
    expect(requests[0]?.headers).toMatchObject({
      "x-api-key": "anthropic-key",
      "anthropic-version": "2023-06-01",
    });
  });

  it("fails with 502 for bedrock, which has no bearer-listable endpoint", async () => {
    const res = await openApp().request("/monitoring/providers/aws/models");
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorBody).error.message).toContain(
      "manually",
    );
  });

  it("fails with 502 when a key-based protocol has no key configured", async () => {
    const res = await openApp().request(
      "/monitoring/providers/keyless-google/models",
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorBody).error.message).toContain(
      "no API key",
    );
  });

  it("fails with 502 for an unknown provider name", async () => {
    const res = await openApp().request("/monitoring/providers/nope/models");
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorBody).error.message).toContain(
      'Unknown provider "nope"',
    );
  });

  it("reports an upstream failure as 502 rather than leaking a 200", async () => {
    stubFetch({ error: "boom" }, false, 503);

    const res = await openApp().request(
      "/monitoring/providers/openai-local/models",
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorBody).error.message).toContain("503");
  });

  it("requires monitoring:read when operator auth is enabled", async () => {
    stubFetch({ data: [{ id: "alpha-model" }] });
    const app = guardedApp();

    expect(
      (await app.request("/monitoring/providers/openai-local/models")).status,
    ).toBe(401);
    expect(
      (
        await app.request("/monitoring/providers/openai-local/models", {
          headers: { Authorization: "Bearer viewer-tok" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("POST /monitoring/providers/test/* authorization", () => {
  const paths = [
    "/monitoring/providers/test/prompt",
    "/monitoring/providers/test/capabilities",
    "/monitoring/providers/test/performance",
  ] as const;

  const body = JSON.stringify({ provider: "openai-local", model: "m", prompt: "hi" });

  it("rejects an unauthenticated caller on every test endpoint", async () => {
    const app = guardedApp();
    for (const path of paths) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(401);
    }
  });

  it("rejects a read-only viewer, because the tests spend real money", async () => {
    const app = guardedApp();
    for (const path of paths) {
      const res = await app.request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer viewer-tok",
        },
        body,
      });
      expect(res.status).toBe(401);
    }
  });

  it("lets an operator past the gate (validation is then reached)", async () => {
    const app = guardedApp();
    for (const path of paths) {
      const res = await app.request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer operator-tok",
        },
        // Deliberately invalid so the request stops at validation instead of
        // calling a provider.
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /monitoring/providers/test/* validation", () => {
  const post = (path: string, payload: unknown) =>
    openApp().request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  it("rejects a prompt test without provider, model or prompt", async () => {
    for (const payload of [
      {},
      { provider: "openai-local" },
      { provider: "openai-local", model: "m" },
      { provider: "", model: "m", prompt: "hi" },
      { provider: "openai-local", model: "m", prompt: "" },
    ]) {
      const res = await post("/monitoring/providers/test/prompt", payload);
      expect(res.status).toBe(400);
    }
  });

  it("rejects prompt-test knobs outside their bounds", async () => {
    const base = { provider: "openai-local", model: "m", prompt: "hi" };
    for (const extra of [
      { temperature: 2.5 },
      { temperature: -1 },
      // The output ceiling may be lowered, never raised past the hard cap.
      { maxOutputTokens: 4096 },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 1.5 },
    ]) {
      const res = await post("/monitoring/providers/test/prompt", {
        ...base,
        ...extra,
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a performance test with a run count outside 1..20", async () => {
    for (const runs of [0, -1, 21, 2.5]) {
      const res = await post("/monitoring/providers/test/performance", {
        provider: "openai-local",
        model: "m",
        runs,
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a capability test without a model", async () => {
    const res = await post("/monitoring/providers/test/capabilities", {
      provider: "openai-local",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed json body", async () => {
    const res = await openApp().request("/monitoring/providers/test/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
