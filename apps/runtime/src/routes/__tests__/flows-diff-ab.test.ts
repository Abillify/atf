// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the flow version-diff and A/B experiment routes on /flows.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createFlowsRouter } from "../flows.js";
import { InMemoryFlowStore } from "../../graph/flow-store.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AbManager } from "../../graph/flow-ab.js";
import type { CompliancePolicy } from "../../compliance/policy-schema.js";

function fileRegistry(...flows: FlowDefinition[]): FlowRegistry {
  const m = new Map(flows.map((f) => [f.id, f]));
  return { get: (id) => m.get(id), list: () => [...m.values()] };
}

function app(deps: Parameters<typeof createFlowsRouter>[0]) {
  const a = new Hono();
  a.route("/", createFlowsRouter(deps));
  return a;
}

function flow(name: string, model: string): FlowDefinition {
  return {
    id: "f",
    name,
    nodes: [{ id: "n", type: "llm", llm: { provider: "openai", model } }],
    edges: [],
  };
}

describe("GET /flows/:id/diff", () => {
  test("diffs the two latest published versions by default", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("f", flow("V1", "gpt-4o-mini"));
    await store.publish("f"); // version 1
    await store.saveDraft("f", flow("V2", "gpt-4o"));
    await store.publish("f"); // version 2

    const res = await app({ fileRegistry: fileRegistry(), store }).request(
      "/flows/f/diff",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from: { version: number };
      to: { version: number };
      diff: {
        changed: boolean;
        nodes: { changed: Array<{ id: string; changedFields: string[] }> };
      };
    };
    expect(body.from.version).toBe(1);
    expect(body.to.version).toBe(2);
    expect(body.diff.changed).toBe(true);
    const changed0 = body.diff.nodes.changed[0];
    if (changed0 === undefined) throw new Error("expected a changed node");
    expect(changed0.changedFields).toContain("llm");
  });

  test("diffs published → draft with ?draft=true", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("f", flow("V1", "gpt-4o-mini"));
    await store.publish("f");
    await store.saveDraft("f", flow("V1", "gpt-4o")); // dirty draft

    const res = await app({ fileRegistry: fileRegistry(), store }).request(
      "/flows/f/diff?draft=true",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      to: { kind: string };
      diff: { changed: boolean };
    };
    expect(body.to.kind).toBe("draft");
    expect(body.diff.changed).toBe(true);
  });

  test("404 when a requested version is missing", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("f", flow("V1", "gpt-4o-mini"));
    await store.publish("f");
    const res = await app({ fileRegistry: fileRegistry(), store }).request(
      "/flows/f/diff?from=1&to=9",
    );
    expect(res.status).toBe(404);
  });

  test("501 when no online store is configured", async () => {
    const res = await app({ fileRegistry: fileRegistry() }).request(
      "/flows/f/diff",
    );
    expect(res.status).toBe(501);
  });
});

describe("GET /flows/diff/compare", () => {
  test("diffs a draft of one flow against the published version of another", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("alpha", {
      ...flow("A", "gpt-4o-mini"),
      id: "alpha",
    });
    await store.publish("alpha");
    await store.saveDraft("beta", { ...flow("B", "gpt-4o"), id: "beta" });
    await store.publish("beta");
    await store.saveDraft(
      "alpha",
      { ...flow("A wip", "gpt-5"), id: "alpha" },
      "tester",
      {
        draftId: "exp",
        label: "Experiment",
      },
    );

    const res = await app({ fileRegistry: fileRegistry(), store }).request(
      "/flows/diff/compare?from=alpha&fromDraft=exp&to=beta",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from: { flowId: string; kind: string; draftId?: string };
      to: { flowId: string; kind: string; version?: number };
      diff: { changed: boolean };
    };
    expect(body.from).toEqual({
      flowId: "alpha",
      kind: "draft",
      draftId: "exp",
    });
    expect(body.to.flowId).toBe("beta");
    expect(body.to.kind).toBe("published");
    expect(body.diff.changed).toBe(true);
  });

  test("falls back to the file definition for a never-published file flow", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("online", {
      ...flow("Online", "gpt-4o"),
      id: "online",
    });
    await store.publish("online");
    const res = await app({
      fileRegistry: fileRegistry({
        ...flow("File", "gpt-4o-mini"),
        id: "filef",
      }),
      store,
    }).request("/flows/diff/compare?from=filef&to=online");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from: { kind: string };
      diff: { changed: boolean };
    };
    expect(body.from.kind).toBe("file");
    expect(body.diff.changed).toBe(true);
  });

  test("400 when from or to is missing", async () => {
    const res = await app({
      fileRegistry: fileRegistry(),
      store: new InMemoryFlowStore(),
    }).request("/flows/diff/compare?from=a");
    expect(res.status).toBe(400);
  });

  test("404 for an unknown flow or missing named draft", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("a", { ...flow("A", "gpt-4o-mini"), id: "a" });
    await store.publish("a");
    const unknown = await app({ fileRegistry: fileRegistry(), store }).request(
      "/flows/diff/compare?from=ghost&to=a",
    );
    expect(unknown.status).toBe(404);
    const noDraft = await app({ fileRegistry: fileRegistry(), store }).request(
      "/flows/diff/compare?from=a&fromDraft=exp&to=a",
    );
    expect(noDraft.status).toBe(404);
  });
});

describe("GET /flows/experiments", () => {
  test("returns experiment status when a manager is present", async () => {
    const fakeAb = {
      enabled: true,
      status: () => [
        {
          flow: "f",
          variants: [{ label: "A", version: 1, samples: 3, errorRate: 0 }],
        },
      ],
    } as unknown as AbManager;

    const res = await app({
      fileRegistry: fileRegistry(),
      abManager: fakeAb,
    }).request("/flows/experiments");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      experiments: Array<{ flow: string }>;
    };
    expect(body.enabled).toBe(true);
    const experiment0 = body.experiments[0];
    if (experiment0 === undefined) throw new Error("expected an experiment");
    expect(experiment0.flow).toBe("f");
  });

  test("reports disabled when no manager is present", async () => {
    const res = await app({ fileRegistry: fileRegistry() }).request(
      "/flows/experiments",
    );
    const body = (await res.json()) as {
      enabled: boolean;
      experiments: unknown[];
    };
    expect(body.enabled).toBe(false);
    expect(body.experiments).toEqual([]);
  });

  test("is not captured by the /flows/:id route", async () => {
    // With a flow literally named "experiments" present, the static route still wins.
    const res = await app({
      fileRegistry: fileRegistry({
        id: "experiments",
        name: "x",
        nodes: [{ id: "n", type: "router" }],
        edges: [],
      }),
    }).request("/flows/experiments");
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false); // experiment-stats shape, not a flow definition
  });
});


describe("release governance read APIs", () => {
  test("reports breaking scope changes and emits a version-aware passport", async () => {
    const store = new InMemoryFlowStore();
    await store.saveDraft("f", flow("V1", "gpt-4o-mini"));
    await store.publish("f");
    await store.saveDraft("f", { ...flow("V2", "gpt-4o-mini"), requiredScopes: ["flow:execute"], metadata: { version: "2.0.0" } });
    await store.publish("f");

    const router = app({ fileRegistry: fileRegistry(), store });
    const compatibility = await router.request("/flows/f/compatibility");
    expect(compatibility.status).toBe(200);
    const compatibilityBody = await compatibility.json() as { report: { status: string } };
    expect(compatibilityBody.report.status).toBe("breaking");

    const passport = await router.request("/flows/f/passport?version=2");
    expect(passport.status).toBe(200);
    const passportBody = await passport.json() as { assessment: string; flow: { storeVersion: number; semanticVersion: string } };
    expect(passportBody.assessment).toBe("blocked");
    expect(passportBody.flow).toMatchObject({ storeVersion: 2, semanticVersion: "2.0.0" });
  });

  test("propagates statically declared tool approval requirements into the passport", async () => {
    const approvalPolicy: CompliancePolicy = {
      version: "1",
      failClosed: true,
      approvalRules: [{ toolPatterns: ["server/delete"] }],
    };
    const approvalFlow: FlowDefinition = {
      ...flow("Approval", "gpt-4o"),
      nodes: [{
        id: "n",
        type: "llm",
        tools: ["server/delete"],
        llm: { provider: "openai", model: "gpt-4o" },
      }],
    };
    const response = await app({
      fileRegistry: fileRegistry(approvalFlow),
      getCompliancePolicy: () => approvalPolicy,
    }).request("/flows/f/passport");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      assessment: string;
      policy: { decision: string };
      capabilities: { graph: { tools: string[] } };
      reasons: string[];
    };
    expect(body.policy.decision).toBe("require-approval");
    expect(body.assessment).toBe("review");
    expect(body.capabilities.graph.tools).toContain("server/delete");
    expect(body.reasons.some((reason) => reason.includes("requires approval"))).toBe(true);
  });

  test("describes file-flow capabilities without exposing provider credentials", async () => {
    const response = await app({ fileRegistry: fileRegistry(flow("File", "gpt-4o")) }).request("/flows/f/capabilities");
    expect(response.status).toBe(200);
    const body = await response.json() as { schemaVersion: string; models: Array<{ provider: string }> };
    expect(body.schemaVersion).toBe("1");
    expect(body.models[0]?.provider).toBe("openai");
    expect(JSON.stringify(body)).not.toContain("apiKey");
  });
});
