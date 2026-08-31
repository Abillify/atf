// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the eval-case API (`src/routes/eval.ts`).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createEvalRouter } from "../eval.js";
import { createEvalCaseStore } from "../../eval/eval-case-store.js";

function buildApp() {
  const app = new Hono();
  app.route("/", createEvalRouter({ store: createEvalCaseStore() }));
  return app;
}

function json(body: unknown, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("eval case API", () => {
  it("lists no cases initially", async () => {
    const app = buildApp();
    const res = await app.request("/eval/cases");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cases: unknown[] };
    expect(body.cases).toEqual([]);
  });

  it("adds a valid case and lists it", async () => {
    const app = buildApp();
    const add = await app.request(
      "/eval/cases",
      json({
        flowId: "task",
        prompt: "Summarize this.",
        expected: "a summary",
        tenantId: "tenant-a",
      }),
    );
    expect(add.status).toBe(201);
    const added = (await add.json()) as { case: { id: string } };
    expect(added.case.id).toBeTruthy();

    const list = await app.request("/eval/cases");
    const body = (await list.json()) as { cases: Array<{ id: string }> };
    expect(body.cases).toHaveLength(1);
    const case0 = body.cases[0];
    if (case0 === undefined) throw new Error("expected a listed case");
    expect(case0.id).toBe(added.case.id);
  });

  it("rejects a case missing required fields with 400 and names them", async () => {
    const app = buildApp();
    const res = await app.request(
      "/eval/cases",
      json({ flowId: "task", prompt: "Hi" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { missingFields: string[] };
    expect(body.missingFields).toContain("expected");
    expect(body.missingFields).toContain("tenantId");
  });

  it("deletes a case", async () => {
    const app = buildApp();
    const add = await app.request(
      "/eval/cases",
      json({
        flowId: "task",
        prompt: "x",
        expected: "y",
        tenantId: "t1",
      }),
    );
    const added = (await add.json()) as { case: { id: string } };

    const del = await app.request(
      `/eval/cases/${added.case.id}`,
      json({}, "DELETE"),
    );
    expect(del.status).toBe(200);

    const list = await app.request("/eval/cases");
    const body = (await list.json()) as { cases: unknown[] };
    expect(body.cases).toHaveLength(0);
  });

  it("404s deleting an unknown case", async () => {
    const app = buildApp();
    const res = await app.request("/eval/cases/nope", json({}, "DELETE"));
    expect(res.status).toBe(404);
  });
});
