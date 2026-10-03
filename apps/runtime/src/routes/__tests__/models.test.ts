// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the OpenAI-compatible models route (src/routes/models.ts).
 */

import { describe, test, expect } from "bun:test";
import { createModelsRouter } from "../models.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";

function registry(flows: FlowDefinition[]): FlowRegistry {
  const map = new Map(flows.map((f) => [f.id, f]));
  return {
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
}

const flowA: FlowDefinition = {
  id: "flow-a",
  name: "Flow A",
  nodes: [{ id: "n", type: "router" }],
  edges: [],
};
const flowB: FlowDefinition = {
  id: "flow-b",
  name: "Flow B",
  nodes: [{ id: "n", type: "router" }],
  edges: [],
};

describe("GET /v1/models", () => {
  test("lists all flows as OpenAI model objects", async () => {
    const app = createModelsRouter(registry([flowA, flowB]));
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; object: string; name?: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id).sort()).toEqual(["flow-a", "flow-b"]);
    expect(body.data[0]?.object).toBe("model");
    expect(body.data.find((m) => m.id === "flow-a")?.name).toBe("Flow A");
  });

  test("returns an empty list when no flows are loaded", async () => {
    const app = createModelsRouter(registry([]));
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  test("omits flows with metadata.hidden from the listing", async () => {
    const hiddenFlow: FlowDefinition = {
      id: "task",
      name: "Hidden helper",
      metadata: { hidden: true },
      nodes: [{ id: "n", type: "router" }],
      edges: [],
    };
    const app = createModelsRouter(registry([flowA, hiddenFlow]));
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    const body = (await res.json()) as {
      data: Array<{ id: string; name?: string }>;
    };
    expect(body.data.map((m) => m.id)).toEqual(["flow-a"]);
  });

  test("a hidden flow is not discoverable by id either", async () => {
    const hiddenFlow: FlowDefinition = {
      id: "task",
      name: "Hidden helper",
      metadata: { hidden: true },
      nodes: [{ id: "n", type: "router" }],
      edges: [],
    };
    const app = createModelsRouter(registry([hiddenFlow]));
    const res = await app.fetch(new Request("http://localhost/v1/models/task"));
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/models/:id", () => {
  test("returns a single model", async () => {
    const app = createModelsRouter(registry([flowA]));
    const res = await app.fetch(
      new Request("http://localhost/v1/models/flow-a"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; object: string };
    expect(body.id).toBe("flow-a");
    expect(body.object).toBe("model");
  });

  test("returns 404 for an unknown model", async () => {
    const app = createModelsRouter(registry([flowA]));
    const res = await app.fetch(new Request("http://localhost/v1/models/nope"));
    expect(res.status).toBe(404);
  });
});
