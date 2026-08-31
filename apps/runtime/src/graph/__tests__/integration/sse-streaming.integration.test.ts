// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LOCAL-ONLY integration test — SSE streaming against REAL models.
 *
 * Runs a real flow (classifier → router → llm responder) through the graph
 * engine with the real provider factory and asserts the streamed surfaces:
 *   - reasoning  → chunks with delta.reasoning_content (the classifier emits a
 *                  "🧭 Route" reasoning step; models may add <think> tokens)
 *   - decisions  → the router node's monitoring event carries routing_decision
 *   - tool calls → delta.tool_calls chunks (function-calling passthrough via
 *                  ctx.clientTools — no MCP needed)
 *   - content    → the responder streams a non-empty answer
 *
 * Gated behind RUN_MODEL_INTEGRATION=1 — skipped in CI. Run locally:
 *   RUN_MODEL_INTEGRATION=1 bun run test:integration:models
 */
import { describe, test, expect } from "bun:test";
import { createGraphEngine } from "../../graph-engine.js";
import type { FlowDefinition } from "../../../types/flow.js";
import type { ChatCompletionChunk, OpenAITool } from "../../../types/openai.js";
import type { NodeExecutionEvent } from "../../../types/monitoring.js";
import type {
  MonitoringServiceInterface,
  MonitoringClient,
} from "../../../monitoring/monitoring-service.js";
import type { RequestContext } from "../../../types/monitoring.js";
import {
  MODELS,
  CLASSIFIER_MODELS,
  HAIKU,
  SONNET,
  shouldRun,
  integrationAppConfig,
  MODEL_TIMEOUT_MS,
  type ModelCase,
} from "./_helpers.js";

// ── flows ──────────────────────────────────────────────────────────────────

function makeClassifyRespondFlow(
  classifier: ModelCase,
  responder: ModelCase,
): FlowDefinition {
  return {
    id: "itest-classify-respond",
    name: "itest classify+respond",
    nodes: [
      {
        id: "classifier",
        type: "classifier",
        systemPrompt:
          "Klassifiziere die Anfrage: 'frage' fuer eine echte Frage, " +
          "'smalltalk' fuer Begruessung/Smalltalk.",
        llm: classifier.llm,
        classifierSchema: {
          classKey: "intent",
          schema: {
            type: "object",
            properties: {
              intent: { type: "string", enum: ["frage", "smalltalk"] },
            },
            required: ["intent"],
            additionalProperties: false,
          },
        },
      },
      { id: "router", type: "router" },
      {
        id: "responder",
        type: "llm",
        systemPrompt: "Antworte knapp und freundlich auf Deutsch.",
        llm: responder.llm,
      },
    ],
    edges: [
      { source: "classifier", target: "router" },
      { source: "router", target: "responder", conditions: "true" },
    ],
  };
}

function makeToolFlow(m: ModelCase): FlowDefinition {
  return {
    id: "itest-tool",
    name: "itest tool passthrough",
    nodes: [
      {
        id: "responder",
        type: "llm",
        systemPrompt:
          "Beantworte Wetterfragen ausschliesslich ueber das bereitgestellte " +
          "Tool get_weather. Rufe es mit der genannten Stadt auf.",
        llm: m.llm,
      },
    ],
    edges: [],
  };
}

const WEATHER_TOOL: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Liefert das aktuelle Wetter fuer eine Stadt.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "Stadtname" } },
      required: ["city"],
    },
  },
};

// ── harness helpers ──────────────────────────────────────────────────────────

function makeRegistry(flow: FlowDefinition) {
  return {
    get: (id: string) => (id === flow.id ? flow : undefined),
    list: () => [flow],
  };
}

function makeMonitoring(): {
  service: MonitoringServiceInterface;
  events: NodeExecutionEvent[];
} {
  const events: NodeExecutionEvent[] = [];
  const service: MonitoringServiceInterface = {
    emitNodeEvent: (_id, e) => events.push(e),
    subscribe: (_c: MonitoringClient) => () => {},
    hasConnectionCapacity: () => true,
    getConnectionCount: () => 0,
    getTransportType: () => "sse",
    getHistory: async () => [],
    getHistoryPage: async () => ({ executions: [], total: 0 }),
    getHistoryFacets: async () => ({ flows: [], users: [] }),
    getUsageLog: async () => [],
    getExecutionEvents: async () => [],
    clearHistory: async () => 0,
  };
  return { service, events };
}

interface RunResult {
  chunks: ChatCompletionChunk[];
  events: NodeExecutionEvent[];
}

async function runFlow(
  flow: FlowDefinition,
  userText: string,
  ctxExtra: Partial<RequestContext> = {},
): Promise<RunResult> {
  const { service: monitoring, events } = makeMonitoring();
  const engine = createGraphEngine(integrationAppConfig(), { flowRegistry: makeRegistry(flow) });
  const chunks: ChatCompletionChunk[] = [];
  const ctx: RequestContext = {
    executionId: `itest-${Date.now()}`,
    ssoToken: "itest.itest.itest",
    ...ctxExtra,
  };
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: userText }],
    ctx,
    async (c) => {
      chunks.push(c);
    },
    async () => {},
    monitoring,
  );
  return { chunks, events };
}

const joinContent = (chunks: ChatCompletionChunk[]): string =>
  chunks
    .map((c) => c.choices[0]?.delta?.content ?? "")
    .join("")
    .trim();

const hasReasoning = (chunks: ChatCompletionChunk[]): boolean =>
  chunks.some((c) => {
    const reasoning = c.choices[0]?.delta?.reasoning_content;
    return typeof reasoning === "string" && reasoning.length > 0;
  });

const toolCalls = (chunks: ChatCompletionChunk[]): number =>
  chunks.reduce(
    (n, c) => n + (c.choices[0]?.delta?.tool_calls?.length ?? 0),
    0,
  );

// ── tests ─────────────────────────────────────────────────────────────────

// Classifier → router → responder, both nodes on the SAME model. Only models
// that actually classify (qwen local, Haiku) — the classifier drives the route
// reasoning + routing decision.
for (const m of CLASSIFIER_MODELS) {
  describe.skipIf(!shouldRun(m))(`SSE streaming — classify+respond — ${m.label}`, () => {
    test(
      "streams reasoning + routing decision + answer content",
      async () => {
        const { chunks, events } = await runFlow(
          makeClassifyRespondFlow(m, m),
          "Wie beantrage ich Urlaub?",
        );
        const errored = chunks.filter(
          (c) => c.choices[0]?.finish_reason === "error",
        );
        expect(errored.length).toBe(0);
        // Reasoning: the classifier emits a "🧭 Route" reasoning_content step.
        expect(hasReasoning(chunks)).toBe(true);
        // Decision: the router recorded which branch it took.
        const routerEvent = events.find(
          (e) => e.node_id === "router" && e.routing_decision !== undefined,
        );
        expect(routerEvent?.routing_decision?.target).toBeDefined();
        // Content: the responder produced a non-empty answer.
        expect(joinContent(chunks).length).toBeGreaterThan(0);
        const started = events
          .filter((e) => e.status === "running")
          .map((e) => e.node_id);
        expect(started).toContain("classifier");
        expect(started).toContain("responder");
      },
      MODEL_TIMEOUT_MS,
    );
  });
}

// The abby pairing: Haiku classifier + Sonnet responder. Exercises Sonnet as a
// streaming RESPONDER (its real role) without asking it to classify.
describe.skipIf(!shouldRun(SONNET) || !shouldRun(HAIKU))(
  "SSE streaming — Haiku classifier + Sonnet responder (abby pairing)",
  () => {
    test(
      "streams routing decision + answer content",
      async () => {
        const { chunks, events } = await runFlow(
          makeClassifyRespondFlow(HAIKU, SONNET),
          "Wie beantrage ich Urlaub?",
        );
        const errored = chunks.filter(
          (c) => c.choices[0]?.finish_reason === "error",
        );
        expect(errored.length).toBe(0);
        const routerEvent = events.find(
          (e) => e.node_id === "router" && e.routing_decision !== undefined,
        );
        expect(routerEvent?.routing_decision?.target).toBeDefined();
        expect(joinContent(chunks).length).toBeGreaterThan(0);
      },
      MODEL_TIMEOUT_MS,
    );
  },
);

// Client-tool passthrough (responder-only flow, no classifier) — works for any
// responder model. `clientToolChoice: "required"` is the portable forced-call
// value (Bedrock + LM Studio only accept none/auto/required, not an object).
for (const m of MODELS) {
  describe.skipIf(!shouldRun(m))(`SSE streaming — tool passthrough — ${m.label}`, () => {
    test(
      "streams client tool_calls (function-calling passthrough)",
      async () => {
        const { chunks } = await runFlow(
          makeToolFlow(m),
          "Wie ist das Wetter in Berlin?",
          { clientTools: [WEATHER_TOOL], clientToolChoice: "required" },
        );
        expect(toolCalls(chunks)).toBeGreaterThan(0);
      },
      MODEL_TIMEOUT_MS,
    );
  });
}
