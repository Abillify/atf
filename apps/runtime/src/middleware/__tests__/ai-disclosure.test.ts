// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * AI_DISCLOSURE (EU AI Act Art. 50): opt-in, machine-readable marker on
 * successful completions only.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { loadConfig } from "../../config/index.js";
import { AI_GENERATED_HEADER, aiDisclosureMiddleware, type AiDisclosureMode } from "../ai-disclosure.js";

function appFor(mode: AiDisclosureMode) {
  const app = new Hono();
  app.use("/v1/chat/completions", aiDisclosureMiddleware(mode));
  app.post("/v1/chat/completions", async (ctx) => {
    const body = (await ctx.req.json()) as { stream?: boolean; fail?: boolean; metadata?: Record<string, unknown> };
    if (body.fail) return ctx.json({ error: { message: "nope" } }, 400);
    if (body.stream) {
      return streamSSE(ctx, async (s) => {
        await s.writeSSE({ data: JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) });
        await s.writeSSE({ data: "[DONE]" });
      });
    }
    return ctx.json({
      id: "c1",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "hi" } }],
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    });
  });
  app.get("/health", (ctx) => ctx.json({ status: "ok" }));
  return app;
}
const post = (app: Hono, body: Record<string, unknown>) =>
  app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("AI_DISCLOSURE=off (default)", () => {
  test("adds nothing", async () => {
    const res = await post(appFor("off"), {});
    expect(res.headers.get(AI_GENERATED_HEADER)).toBeNull();
    expect(await res.json()).not.toHaveProperty("metadata");
  });
});

describe("AI_DISCLOSURE=header", () => {
  test("marks a successful JSON completion and a stream, leaves the body alone", async () => {
    const app = appFor("header");
    const json = await post(app, {});
    expect(json.headers.get(AI_GENERATED_HEADER)).toBe("true");
    expect(await json.json()).not.toHaveProperty("metadata");
    const sse = await post(app, { stream: true });
    expect(sse.headers.get(AI_GENERATED_HEADER)).toBe("true");
    expect(await sse.text()).toContain("[DONE]");
  });

  test("does not mark an error, and does not touch other routes", async () => {
    const app = appFor("header");
    expect((await post(app, { fail: true })).headers.get(AI_GENERATED_HEADER)).toBeNull();
    expect((await app.request("/health")).headers.get(AI_GENERATED_HEADER)).toBeNull();
  });
});

describe("AI_DISCLOSURE=field", () => {
  test("adds metadata.ai_generated to a JSON completion and keeps existing metadata", async () => {
    const app = appFor("field");
    const plain = (await (await post(app, {})).json()) as { metadata: Record<string, unknown>; id: string };
    expect(plain.metadata).toEqual({ ai_generated: "true" });
    expect(plain.id).toBe("c1");
    const withMeta = (await (await post(app, { metadata: { trace: "t-1" } })).json()) as {
      metadata: Record<string, unknown>;
    };
    expect(withMeta.metadata).toEqual({ trace: "t-1", ai_generated: "true" });
  });

  test("a stream has no single body, so it gets the header instead", async () => {
    const res = await post(appFor("field"), { stream: true });
    expect(res.headers.get(AI_GENERATED_HEADER)).toBe("true");
    expect(await res.text()).toContain("[DONE]");
  });

  test("an error is not marked in either form", async () => {
    const res = await post(appFor("field"), { fail: true });
    expect(res.headers.get(AI_GENERATED_HEADER)).toBeNull();
    expect(await res.json()).not.toHaveProperty("metadata");
  });
});

describe("AI_DISCLOSURE on the responses routes", () => {
  test("marks /v1/responses and the routes below it, not other paths", async () => {
    const app = new Hono();
    const disclosure = aiDisclosureMiddleware("field");
    // The wiring of bootstrap/routes-inference.ts.
    app.use("/v1/responses", disclosure);
    app.use("/v1/responses/*", disclosure);
    app.post("/v1/responses", (ctx) => ctx.json({ id: "r1" }));
    app.get("/v1/responses/r1", (ctx) => ctx.json({ id: "r1" }));
    app.get("/v1/other", (ctx) => ctx.json({ id: "o1" }));
    const created = (await (await app.request("/v1/responses", { method: "POST" })).json()) as {
      metadata: Record<string, unknown>;
    };
    expect(created.metadata).toEqual({ ai_generated: "true" });
    const fetched = (await (await app.request("/v1/responses/r1")).json()) as {
      metadata: Record<string, unknown>;
    };
    expect(fetched.metadata).toEqual({ ai_generated: "true" });
    expect(await (await app.request("/v1/other")).json()).not.toHaveProperty("metadata");
  });
});

describe("AI_DISCLOSURE configuration", () => {
  test("defaults to off and accepts header and field", () => {
    const saved = process.env.AI_DISCLOSURE;
    try {
      delete process.env.AI_DISCLOSURE;
      expect(loadConfig().aiDisclosure).toBe("off");
      process.env.AI_DISCLOSURE = "header";
      expect(loadConfig().aiDisclosure).toBe("header");
      process.env.AI_DISCLOSURE = "field";
      expect(loadConfig().aiDisclosure).toBe("field");
    } finally {
      if (saved === undefined) delete process.env.AI_DISCLOSURE;
      else process.env.AI_DISCLOSURE = saved;
    }
  });
});
