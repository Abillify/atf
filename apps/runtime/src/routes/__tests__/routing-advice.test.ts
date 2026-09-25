// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `GET /optimizer/routing-advice` — the routing advisor is wired.
 *
 * `src/graph/routing-advisor.ts` shipped a complete cost/quality advisor with its
 * own unit tests and a header comment pointing at the "Studio Optimize panel",
 * but nothing imported it — the second instance of the `error-strategy.ts`
 * pattern (finished, tested, unreachable). It is now reachable through the
 * optimizer router.
 *
 * Also pins the two deliberate design choices:
 *   - only nodes that ALREADY declare a candidate pool are considered, so the
 *     advisor never proposes a model nobody vetted for that prompt;
 *   - the endpoint is read-only and merely emits the canary entry an operator
 *     would add, so opening a dashboard tab cannot divert production traffic.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createOptimizerRouter } from "../optimizer.js";
import { collectRoutingCandidates } from "../../graph/routing-advisor.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { FlowOptimizer } from "../../graph/flow-optimizer.js";

// A node whose author declared acceptable substitutes.
const FLOW_WITH_POOL: FlowDefinition = {
  id: "advisable",
  name: "Advisable",
  nodes: [
    {
      id: "answer",
      type: "llm",
      llm: { provider: "openai", model: "gpt-4o" },
      config: {
        routing: {
          strategy: "cheapest",
          candidates: [
            { provider: "openai", model: "gpt-4o" },
            { provider: "openai", model: "gpt-4o-mini" },
          ],
        },
      },
    },
  ],
  edges: [],
} as FlowDefinition;

// A node with no candidate pool — must be left alone.
const FLOW_WITHOUT_POOL: FlowDefinition = {
  id: "plain",
  name: "Plain",
  nodes: [
    { id: "answer", type: "llm", llm: { provider: "openai", model: "gpt-4o" } },
  ],
  edges: [],
} as FlowDefinition;

function registry(flows: FlowDefinition[]): FlowRegistry {
  const map = new Map(flows.map((f) => [f.id, f]));
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
  } as unknown as FlowRegistry;
}

const optimizerStub = {} as unknown as FlowOptimizer;

function app(opts: { flows?: FlowDefinition[] } = {}) {
  const a = new Hono();
  a.route(
    "/optimizer",
    createOptimizerRouter({
      optimizer: optimizerStub,
      ...(opts.flows !== undefined
        ? { flowRegistry: registry(opts.flows) }
        : {}),
    }),
  );
  return a;
}

/**
 * Narrows an array's first element. Preferred over a `!` assertion so a shape
 * regression fails with "expected at least one recommendation" rather than a
 * TypeError several lines later.
 */
function first<T>(items: T[], what: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`expected at least one ${what}`);
  return item;
}

interface AdviceBody {
  nodesExamined: number;
  qualityDataAvailable: boolean;
  recommendations: {
    flowId: string;
    nodeId: string;
    currentModel: string;
    suggestedModel: string;
    expectedCostSavingPct: number;
    source: string;
    canary: { flow: string; candidate: string; trafficPercent: number };
  }[];
}

// ---------------------------------------------------------------------------

describe("GET /optimizer/routing-advice", () => {
  test("recommends the cheaper declared candidate", async () => {
    const res = await app({ flows: [FLOW_WITH_POOL] }).request(
      "/optimizer/routing-advice",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdviceBody;

    expect(body.nodesExamined).toBe(1);
    expect(body.recommendations).toHaveLength(1);
    const rec = first(body.recommendations, "recommendation");
    expect(rec.flowId).toBe("advisable");
    expect(rec.nodeId).toBe("answer");
    expect(rec.currentModel).toBe("openai/gpt-4o");
    expect(rec.suggestedModel).toBe("openai/gpt-4o-mini");
    expect(rec.expectedCostSavingPct).toBeGreaterThan(0);
  });

  test("each recommendation carries a ready-to-paste canary entry", async () => {
    const res = await app({ flows: [FLOW_WITH_POOL] }).request(
      "/optimizer/routing-advice",
    );
    const body = (await res.json()) as AdviceBody;
    const canary = first(body.recommendations, "recommendation").canary;
    expect(canary.flow).toBe("advisable");
    expect(canary.trafficPercent).toBe(10);
    // Sanitised into something usable as a flow id.
    expect(canary.candidate).toMatch(/^advisable-/);
    expect(canary.candidate).not.toContain("/");
  });

  test("a node without a declared candidate pool is not advised on", async () => {
    // Guessing candidates would propose a model nobody vetted for that prompt.
    const res = await app({ flows: [FLOW_WITHOUT_POOL] }).request(
      "/optimizer/routing-advice",
    );
    const body = (await res.json()) as AdviceBody;
    expect(body.nodesExamined).toBe(0);
    expect(body.recommendations).toEqual([]);
  });

  test("thresholds are honoured from the query string", async () => {
    // An unreachable saving target must yield nothing rather than everything.
    const res = await app({ flows: [FLOW_WITH_POOL] }).request(
      "/optimizer/routing-advice?minCostSavingPct=99.9",
    );
    const body = (await res.json()) as AdviceBody;
    expect(body.nodesExamined).toBe(1);
    expect(body.recommendations).toEqual([]);
  });

  test("an out-of-range threshold is ignored rather than applied", async () => {
    const res = await app({ flows: [FLOW_WITH_POOL] }).request(
      "/optimizer/routing-advice?minCostSavingPct=abc&maxQualityLossPct=-5",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdviceBody;
    expect(body.recommendations).toHaveLength(1);
  });

  test("without quality data the response says so", async () => {
    // Otherwise a cost-only suggestion would look quality-checked.
    const res = await app({ flows: [FLOW_WITH_POOL] }).request(
      "/optimizer/routing-advice",
    );
    const body = (await res.json()) as AdviceBody;
    expect(body.qualityDataAvailable).toBe(false);
    expect(first(body.recommendations, "recommendation").source).toBe(
      "unknown",
    );
  });

  test("501 when no flow registry is wired", async () => {
    const res = await app().request("/optimizer/routing-advice");
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// collectRoutingCandidates
// ---------------------------------------------------------------------------

describe("collectRoutingCandidates", () => {
  test("uses the global default when a node declares no llm", () => {
    const flow = {
      id: "f",
      name: "F",
      nodes: [
        {
          id: "answer",
          type: "llm",
          config: {
            routing: {
              strategy: "cheapest",
              candidates: [{ provider: "openai", model: "gpt-4o-mini" }],
            },
          },
        },
      ],
      edges: [],
    } as FlowDefinition;

    const infos = collectRoutingCandidates([flow], {
      provider: "openai",
      model: "gpt-4o",
    });
    expect(infos).toHaveLength(1);
    expect(first(infos, "routing info").currentModel.model).toBe("gpt-4o");
  });

  test("skips a node with neither its own llm nor a global default", () => {
    const flow = {
      id: "f",
      name: "F",
      nodes: [
        {
          id: "answer",
          type: "llm",
          config: {
            routing: {
              strategy: "cheapest",
              candidates: [{ provider: "openai", model: "gpt-4o-mini" }],
            },
          },
        },
      ],
      edges: [],
    } as FlowDefinition;
    expect(collectRoutingCandidates([flow])).toEqual([]);
  });

  test("drops the current model from its own candidate list", () => {
    const infos = collectRoutingCandidates([FLOW_WITH_POOL]);
    expect(
      first(infos, "routing info").candidateModels.map((c) => c.model),
    ).toEqual(["gpt-4o-mini"]);
  });

  test("a pool containing only the current model yields nothing", () => {
    const flow = {
      id: "f",
      name: "F",
      nodes: [
        {
          id: "answer",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o" },
          config: {
            routing: {
              strategy: "cheapest",
              candidates: [{ provider: "openai", model: "gpt-4o" }],
            },
          },
        },
      ],
      edges: [],
    } as FlowDefinition;
    expect(collectRoutingCandidates([flow])).toEqual([]);
  });

  test("scans every flow, not just the first", () => {
    const infos = collectRoutingCandidates([
      FLOW_WITHOUT_POOL,
      FLOW_WITH_POOL,
    ]);
    expect(infos.map((i) => i.flowId)).toEqual(["advisable"]);
  });
});

// ---------------------------------------------------------------------------

describe("POST /optimizer/routing-advice (a definition that is not loaded)", () => {
  const post = (a: Hono, body: unknown) =>
    a.request("/optimizer/routing-advice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("advises on the posted definition only, not on the loaded flows", async () => {
    // The loaded version of the flow has no pool; the posted draft does.
    const res = await post(app({ flows: [FLOW_WITHOUT_POOL] }), {
      definition: { ...FLOW_WITH_POOL, id: "plain" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdviceBody;
    expect(body.nodesExamined).toBe(1);
    expect(first(body.recommendations, "recommendation")).toMatchObject({
      flowId: "plain",
      nodeId: "answer",
      suggestedModel: "openai/gpt-4o-mini",
    });
  });

  test("works without a flow registry (nothing loaded at all)", async () => {
    const res = await post(app(), { definition: FLOW_WITH_POOL });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AdviceBody).nodesExamined).toBe(1);
  });

  test("resolves shortcuts and variables in the source form, like a flow file", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-advice-"));
    try {
      fs.writeFileSync(
        path.join(dir, "model-shortcuts.yaml"),
        "engines:\n  oai: { provider: openai }\nmodelPresets:\n  big: { model: gpt-4o }\n  small: { model: gpt-4o-mini }\n" +
          "shortcuts:\n  big: { engine: oai, model: big }\n  small: { engine: oai, model: small }\n",
      );
      const a = new Hono();
      a.route("/optimizer", createOptimizerRouter({ optimizer: optimizerStub, flowsDir: dir }));
      const res = await post(a, {
        definition: {
          id: "src",
          name: "Source form",
          variables: { model_main: "big" },
          nodes: [
            {
              id: "answer",
              type: "llm",
              llm: { shortcut: "{{vars.model_main}}" },
              config: { routing: { strategy: "cheapest", candidates: [{ shortcut: "big" }, { shortcut: "small" }] } },
            },
          ],
          edges: [],
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as AdviceBody;
      expect(body.nodesExamined).toBe(1);
      expect(first(body.recommendations, "recommendation").suggestedModel).toBe("openai/gpt-4o-mini");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a body without a valid definition", async () => {
    expect((await post(app(), {})).status).toBe(400);
    expect((await post(app(), { definition: { id: "x", nodes: "nope" } })).status).toBe(400);
  });
});

describe("without the self-optimizing loop (OPTIMIZER_ENABLED off)", () => {
  const bare = () => {
    const a = new Hono();
    a.route("/optimizer", createOptimizerRouter({ flowRegistry: registry([FLOW_WITH_POOL]) }));
    return a;
  };

  test("routing advice still works, GET and POST", async () => {
    const get = await bare().request("/optimizer/routing-advice");
    expect(get.status).toBe(200);
    const post = await bare().request("/optimizer/routing-advice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: FLOW_WITH_POOL }),
    });
    expect(post.status).toBe(200);
  });

  test("the optimizer's own endpoints explain they are off (501)", async () => {
    const res = await bare().request("/optimizer/advisable/runs");
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("OPTIMIZER_ENABLED");
  });
});
