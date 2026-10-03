// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the flow management routes (/flows) — validate, list, inspect,
 * draft/publish/delete/versions/rollback.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createFlowsRouter } from "../flows.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import { InMemoryFlowStore } from "../../graph/flow-store.js";
import { createDbFlowSource } from "../../graph/flow-registry-composite.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";

const def = (id: string, name = id): FlowDefinition => ({
  id,
  name,
  nodes: [
    { id: "n", type: "llm", llm: { provider: "openai", model: "gpt-4o-mini" } },
  ],
  edges: [],
});

function fileRegistry(...flows: FlowDefinition[]): FlowRegistry {
  const m = new Map(flows.map((f) => [f.id, f]));
  return { get: (id) => m.get(id), list: () => [...m.values()] };
}

function app(deps: Parameters<typeof createFlowsRouter>[0]) {
  const a = new Hono();
  a.route("/", createFlowsRouter(deps));
  return a;
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /flows/validate (Stage 1, always available)", () => {
  test("valid flow → valid: true", async () => {
    const a = app({ fileRegistry: fileRegistry() });
    const res = await a.request("/flows/validate", json(def("v")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  test("invalid flow → valid: false with errors", async () => {
    const a = app({ fileRegistry: fileRegistry() });
    const res = await a.request(
      "/flows/validate",
      json({ id: "x", name: "X", nodes: [], edges: [] }),
    );
    const body = (await res.json()) as { valid: boolean; errors: unknown[] };
    expect(body.valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });
});

describe("GET /flows + GET /flows/:id", () => {
  test("lists file and online flows with source", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("online1", def("online1"));
    await store.publish("online1");
    const a = app({ fileRegistry: fileRegistry(def("file1")), store });

    const res = await a.request("/flows");
    const body = (await res.json()) as {
      flows: Array<{ id: string; source: string; editable: boolean }>;
      onlineEditing: boolean;
    };
    expect(body.onlineEditing).toBe(true);
    const file1 = body.flows.find((f) => f.id === "file1");
    const online1 = body.flows.find((f) => f.id === "online1");
    if (file1 === undefined || online1 === undefined) {
      throw new Error("expected both flows to be listed");
    }
    expect(file1.source).toBe("file");
    expect(file1.editable).toBe(false);
    expect(online1.source).toBe("online");
    expect(online1.editable).toBe(true);
  });

  test("GET /flows/:id returns the file definition for a file flow", async () => {
    const a = app({ fileRegistry: fileRegistry(def("f")) });
    const res = await a.request("/flows/f");
    const body = (await res.json()) as { source: string; editable: boolean };
    expect(body.source).toBe("file");
    expect(body.editable).toBe(false);
  });

  test("unknown flow → 404", async () => {
    const a = app({ fileRegistry: fileRegistry() });
    const res = await a.request("/flows/ghost");
    expect(res.status).toBe(404);
  });
});

describe("write routes return 501 when no store is configured", () => {
  test("PUT draft → 501", async () => {
    const a = app({ fileRegistry: fileRegistry() });
    const res = await a.request("/flows/x/draft", {
      ...json(def("x")),
      method: "PUT",
    });
    expect(res.status).toBe(501);
  });
});

describe("online authoring lifecycle (Stage 3)", () => {
  test("save draft → publish → appears with published status", async () => {
    const store = new InMemoryFlowStore();
    const dbSource = createDbFlowSource(store);
    const a = app({ fileRegistry: fileRegistry(), store, dbSource });

    const put = await a.request("/flows/neu/draft", {
      ...json(def("neu", "Neu")),
      method: "PUT",
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { validation: { valid: boolean } };
    expect(putBody.validation.valid).toBe(true);

    const pub = await a.request("/flows/neu/publish", json({}));
    expect(pub.status).toBe(200);

    // dbSource refreshed → snapshot has the published flow
    expect(dbSource.get("neu")?.id).toBe("neu");
  });

  test("publish fails (400) when the draft is invalid", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    // Save an invalid draft (no nodes) directly via the store, then publish.
    await store.saveDraft("bad", {
      id: "bad",
      name: "Bad",
      nodes: [],
      edges: [],
    } as FlowDefinition);
    const res = await a.request("/flows/bad/publish", json({}));
    expect(res.status).toBe(400);
  });

  test("path id overrides body id on draft save", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    await a.request("/flows/correct/draft", {
      ...json(def("WRONG")),
      method: "PUT",
    });
    const rec = await store.get("correct");
    expect(rec?.draft?.id).toBe("correct");
  });

  test("delete an online flow → 200, then 404", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("d", def("d"));
    await store.publish("d");
    const a = app({ fileRegistry: fileRegistry(), store });
    expect((await a.request("/flows/d", { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await a.request("/flows/d", { method: "DELETE" })).status).toBe(
      404,
    );
  });

  test("versions + rollback", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    await a.request("/flows/r/draft", {
      ...json(def("r", "v1")),
      method: "PUT",
    });
    await a.request("/flows/r/publish", json({}));
    await a.request("/flows/r/draft", {
      ...json(def("r", "v2")),
      method: "PUT",
    });
    await a.request("/flows/r/publish", json({}));

    const versions = (await (await a.request("/flows/r/versions")).json()) as {
      versions: Array<{ version: number }>;
    };
    expect(versions.versions.map((v) => v.version)).toEqual([2, 1]);

    const rb = await a.request("/flows/r/rollback", json({ version: 1 }));
    expect(rb.status).toBe(200);
    const rbBody = (await rb.json()) as {
      record: { version: number; published: { name: string } };
    };
    expect(rbBody.record.version).toBe(3);
    expect(rbBody.record.published.name).toBe("v1");
  });
});

describe("named drafts (several working copies per flow)", () => {
  test("PUT /flows/:id/drafts/:draftId saves alongside the default draft", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    await a.request("/flows/m/draft", {
      ...json(def("m", "default copy")),
      method: "PUT",
    });
    const put = await a.request("/flows/m/drafts/exp-1", {
      ...json({ ...def("m", "experiment"), label: "Experiment 1" }),
      method: "PUT",
    });
    expect(put.status).toBe(200);

    const rec = await store.get("m");
    expect(rec?.drafts.map((d) => d.draftId)).toEqual(["default", "exp-1"]);
    expect(rec?.draft?.name).toBe("default copy");

    const list = (await (await a.request("/flows/m/drafts")).json()) as {
      drafts: Array<{ draftId: string; label: string }>;
    };
    expect(list.drafts.map((d) => d.draftId)).toEqual(["default", "exp-1"]);
    expect(list.drafts[1]?.label).toBe("Experiment 1");
  });

  test("GET /flows/:id includes the drafts with definitions", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    await a.request("/flows/m/drafts/exp-1", {
      ...json(def("m", "experiment")),
      method: "PUT",
    });
    const body = (await (await a.request("/flows/m")).json()) as {
      drafts: Array<{ draftId: string; definition: { name: string } }>;
    };
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]?.draftId).toBe("exp-1");
    expect(body.drafts[0]?.definition.name).toBe("experiment");
  });

  test("publish ?draftId= promotes the named draft only", async () => {
    const store = new InMemoryFlowStore();
    const dbSource = createDbFlowSource(store);
    const a = app({ fileRegistry: fileRegistry(), store, dbSource });
    await a.request("/flows/m/draft", {
      ...json(def("m", "default copy")),
      method: "PUT",
    });
    await a.request("/flows/m/drafts/exp-1", {
      ...json(def("m", "experiment")),
      method: "PUT",
    });
    const pub = await a.request("/flows/m/publish?draftId=exp-1", json({}));
    expect(pub.status).toBe(200);
    expect(dbSource.get("m")?.name).toBe("experiment");
    // The default draft is untouched and still unpublished-divergent.
    const rec = await store.get("m");
    expect(rec?.draft?.name).toBe("default copy");
  });

  test("publish via body {draftId} works too", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    await a.request("/flows/m/drafts/exp-1", {
      ...json(def("m", "experiment")),
      method: "PUT",
    });
    const pub = await a.request("/flows/m/publish", json({ draftId: "exp-1" }));
    expect(pub.status).toBe(200);
    const body = (await pub.json()) as {
      record: { published: { name: string } };
    };
    expect(body.record.published.name).toBe("experiment");
  });

  test("publish of an unknown draft → 400", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    await a.request("/flows/m/draft", { ...json(def("m")), method: "PUT" });
    const pub = await a.request("/flows/m/publish?draftId=ghost", json({}));
    expect(pub.status).toBe(400);
  });

  test("an invalid draftId in the path → 400", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    const put = await a.request("/flows/m/drafts/Bad Id", {
      ...json(def("m")),
      method: "PUT",
    });
    expect(put.status).toBe(400);
  });

  test("DELETE /flows/:id/drafts/:draftId removes it", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    await a.request("/flows/m/draft", { ...json(def("m")), method: "PUT" });
    await a.request("/flows/m/drafts/exp-1", {
      ...json(def("m", "x")),
      method: "PUT",
    });
    expect(
      (await a.request("/flows/m/drafts/exp-1", { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await a.request("/flows/m/drafts/exp-1", { method: "DELETE" })).status,
    ).toBe(404);
    const rec = await store.get("m");
    expect(rec?.drafts.map((d) => d.draftId)).toEqual(["default"]);
  });

  test("diff ?draft=true&draftId= compares the named draft", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    await a.request("/flows/m/draft", { ...json(def("m", "v1")), method: "PUT" });
    await a.request("/flows/m/publish", json({}));
    await a.request("/flows/m/drafts/exp-1", {
      ...json(def("m", "experiment")),
      method: "PUT",
    });
    const res = await a.request("/flows/m/diff?draft=true&draftId=exp-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      to: { kind: string; draftId: string };
      diff: { changed: unknown[] };
    };
    expect(body.to).toEqual({ kind: "draft", draftId: "exp-1" });
  });

  test("list reports draftCount", async () => {
    const store = new InMemoryFlowStore();
    const a = app({ fileRegistry: fileRegistry(), store });
    await a.request("/flows/m/draft", { ...json(def("m")), method: "PUT" });
    await a.request("/flows/m/drafts/exp-1", {
      ...json(def("m", "x")),
      method: "PUT",
    });
    const body = (await (await a.request("/flows")).json()) as {
      flows: Array<{ id: string; draftCount: number }>;
    };
    expect(body.flows.find((f) => f.id === "m")?.draftCount).toBe(2);
  });
});

describe("auth", () => {
  test("401 when auth required and no token", async () => {
    const a = app({ fileRegistry: fileRegistry(), authRequired: true });
    expect((await a.request("/flows")).status).toBe(401);
  });

  test("a format-only token no longer grants access to the flow plane", async () => {
    // The default back-compat authorizer is fail-closed: `aaa.bbb.ccc` is a
    // well-FORMED but unverified token, and previously that alone granted
    // admin — i.e. read AND flows:write on the operator plane.
    const a = app({ fileRegistry: fileRegistry(), authRequired: true });
    expect((await a.request("/flows?token=aaa.bbb.ccc")).status).toBe(401);
  });

  test("the legacy format-only path still works when explicitly opted into", async () => {
    const a = app({
      fileRegistry: fileRegistry(),
      authRequired: true,
      operatorAuth: createOperatorAuthorizer({
        authRequired: true,
        allowUnverifiedJwt: true,
      }),
    });
    expect((await a.request("/flows?token=aaa.bbb.ccc")).status).toBe(200);
  });
});
