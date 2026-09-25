// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";
import { baseFlowId, describeRun, mergeExecutionEvents, studioRunHref } from "../lib/run-attach";
import type { NodeExecutionEvent } from "../types/monitoring";

const ev = (node_id: string, status: NodeExecutionEvent["status"], extra: Partial<NodeExecutionEvent> = {}): NodeExecutionEvent => ({
  execution_id: "x1",
  node_id,
  status,
  start_time: "2026-09-25T10:00:00.000Z",
  end_time: status === "running" ? null : "2026-09-25T10:00:01.000Z",
  latency_ms: status === "running" ? null : 1000,
  ...extra,
});

describe("run-attach", () => {
  test("Studio test runs map back to their flow", () => {
    expect(baseFlowId("support@studio-ab12")).toBe("support");
    expect(baseFlowId("support")).toBe("support");
    expect(studioRunHref("support@studio-ab12", "x 1")).toBe("/studio?flow=support&execution=x+1");
  });

  test("merge keeps a node's finished state over a late live running event", () => {
    const merged = mergeExecutionEvents([ev("llm", "completed")], [ev("llm", "running"), ev("tool", "running")]);
    expect(merged.map((e) => `${e.node_id}:${e.status}`)).toEqual(["llm:completed", "tool:running"]);
  });

  test("describes prompt, answer and progress from the boundaries", () => {
    const request = ev("__request__", "completed", { user_prompt: "Where is my order?", flow_id: "support@studio-1" });
    const running = describeRun([request, ev("llm", "running")]);
    expect(running).toMatchObject({ running: true, prompt: "Where is my order?", flowId: "support@studio-1" });
    expect(running.answer).toBeUndefined();

    const response = ev("__response__", "completed", {
      response: JSON.stringify({ choices: [{ message: { role: "assistant", content: "On its way." } }] }),
    });
    expect(describeRun([request, ev("llm", "completed"), response])).toEqual({
      running: false,
      prompt: "Where is my order?",
      answer: "On its way.",
      flowId: "support@studio-1",
    });
  });

  test("a request without its response yet is still running", () => {
    expect(describeRun([ev("__request__", "completed"), ev("llm", "completed")]).running).toBe(true);
    expect(describeRun([ev("llm", "completed")]).running).toBe(false);
  });
});
