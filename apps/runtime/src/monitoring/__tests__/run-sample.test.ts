// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { evaluateConditionExpression } from "../../graph/condition-evaluator.js";
import { resolveContextPlaceholders } from "../../graph/exec-runtime.js";
import { createDebugRouter } from "../../routes/debug.js";
import type { DebugTrace } from "../../types/debug-trace.js";
import type { AgentExecutionContext } from "../../types/monitoring.js";
import { InMemoryDebugTraceStore } from "../debug-trace-store.js";
import { buildRunSample, traceBelongsToFlow } from "../run-sample.js";

function trace(id: string, flowId: string, question: string): DebugTrace {
  return {
    execution_id: id,
    flow_id: flowId,
    status: "completed",
    started_at: "2026-09-25T10:00:00.000Z",
    finished_at: "2026-09-25T10:00:05.000Z",
    context: { user_name: "Erika", user_email: "e@example.com", role: "user", language: "de", persisted: 0, incoming: 1, dropped: 0 },
    input_messages: [
      { role: "system", content: "sys" },
      { role: "user", content: question },
    ],
    nodes: [
      {
        node_id: "triage",
        node_type: "classifier",
        status: "completed",
        started_at: "",
        finished_at: "",
        latency_ms: 1,
        sequence: 1,
        classifier: { response_format: "json", raw_output: "", parsed: { route: "BETRIEB", needsInfo: false }, class_label: "BETRIEB" },
      },
      {
        node_id: "refine",
        node_type: "classifier",
        status: "completed",
        started_at: "",
        finished_at: "",
        latency_ms: 1,
        sequence: 2,
        classifier: { response_format: "json", raw_output: "", parsed: { client: "Acme" }, class_label: "Acme" },
      },
    ],
    usage: {},
    errors: [],
  } as unknown as DebugTrace;
}

describe("buildRunSample", () => {
  const { sample, preview } = buildRunSample(trace("e1", "abby", "Ist ein Parkplatz frei?"));

  test("collects query, context, per-node and merged classification", () => {
    expect(preview).toBe("Ist ein Parkplatz frei?");
    expect(sample).toMatchObject({
      query: "Ist ein Parkplatz frei?",
      classLabel: "Acme",
      classification: { route: "BETRIEB", needsInfo: false, client: "Acme" },
      node: { triage: { classification: { route: "BETRIEB" } }, refine: { classification: { client: "Acme" } } },
      context: { userName: "Erika", userEmail: "e@example.com", executionId: "e1" },
      currentNodeId: "refine",
      messageCount: 2,
      hasErrors: false,
    });
  });

  test("renders in a system prompt exactly like the engine would", () => {
    const out = resolveContextPlaceholders(
      "Hallo {{context.userName}} — {{node.triage.classification.route}} / {{turn[0].refine.classification.client}}",
      sample.context as AgentExecutionContext,
      { node: sample.node, turn: sample.turn } as never,
    );
    expect(out).toBe("Hallo Erika — BETRIEB / Acme");
  });

  test("feeds the condition evaluator", () => {
    expect(evaluateConditionExpression("classification.route == 'BETRIEB' && lastMessageText =~ 'parkplatz'", sample)).toBe(true);
    expect(evaluateConditionExpression("node.refine.classification.client == 'Acme'", sample)).toBe(true);
  });
});

describe("final response", () => {
  test("finishTrace records the flow's answer and the sample carries it next to the values", () => {
    const store = new InMemoryDebugTraceStore(10, { llmResultBytes: 8 });
    store.startTrace({ ...trace("e9", "abby", "Frage?"), status: "running", finished_at: null });
    store.finishTrace("e9", "completed", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, [], { response: "Antwort ist lang", nodeId: "answer" });
    const run = buildRunSample(store.getTrace("e9")!);
    expect(run.response?.startsWith("Antwort")).toBe(true);
    expect(Buffer.byteLength(run.response ?? "")).toBeLessThanOrEqual(8 + 64);
    expect(run.responseNodeId).toBe("answer");
    expect(run.sample).not.toHaveProperty("response");
  });

  test("a run without an answer has none", () => {
    expect(buildRunSample(trace("e1", "abby", "Frage?")).response).toBeUndefined();
  });
});

describe("debug routes for the Studio", () => {
  const store = new InMemoryDebugTraceStore();
  store.startTrace(trace("live", "abby", "Frage live"));
  store.startTrace(trace("studio", "abby@studio-abc", "Frage studio"));
  store.startTrace(trace("other", "other-flow", "Andere"));
  const app = createDebugRouter({ debugStore: store });

  test("lists the runs of one flow, including its Studio test runs, with a preview", async () => {
    expect(traceBelongsToFlow("abby-pii", "abby")).toBe(false);
    const body = (await (await app.request("/monitoring/debug?flowId=abby")).json()) as {
      traces: Array<{ execution_id: string; preview: string }>;
    };
    expect(body.traces.map((t) => t.execution_id).sort()).toEqual(["live", "studio"]);
    expect(body.traces.find((t) => t.execution_id === "studio")?.preview).toBe("Frage studio");
  });

  test("serves a run as sample values", async () => {
    const res = await app.request("/monitoring/debug/live/sample");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sample: { query: string } };
    expect(body.sample.query).toBe("Frage live");
    expect((await app.request("/monitoring/debug/missing/sample")).status).toBe(404);
  });
});
