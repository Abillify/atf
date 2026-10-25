// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Unit tests for `bench-capture.ts` — trace → bench case conversion, the
 * personal-data refusal, and the append/render helpers. Pure functions, no
 * server and no file I/O (the CLI wraps these).
 */
import { describe, expect, it } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  appendCapturedCases,
  captureBenchCase,
  KNOWN_ERROR_DIAGNOSTIC_CODES,
  renderBenchFile,
} from "../bench-capture.js";
import { BenchFileSchema } from "../bench-contract.js";
import type { DebugNodeTrace, DebugTrace } from "../../types/debug-trace.js";

function node(overrides: Partial<DebugNodeTrace> = {}): DebugNodeTrace {
  return {
    node_id: "answer",
    node_type: "llm",
    status: "completed",
    started_at: "2026-10-20T10:00:00.000Z",
    finished_at: "2026-10-20T10:00:02.000Z",
    latency_ms: 2000,
    tool_calls: [],
    ...overrides,
  };
}

function trace(overrides: Partial<DebugTrace> = {}): DebugTrace {
  return {
    execution_id: "11111111-1111-4111-8111-111111111111",
    flow_id: "my-flow",
    status: "completed",
    started_at: "2026-10-20T10:00:00.000Z",
    finished_at: "2026-10-20T10:00:04.000Z",
    context: {},
    input_messages: [{ role: "user", content: "What does the contract say?" }],
    nodes: [node()],
    usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
    errors: [],
    ...overrides,
  };
}

describe("captureBenchCase", () => {
  it("maps the input conversation and derives tool, token and latency assertions", () => {
    const result = captureBenchCase(
      trace({
        input_messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Summarize the report" },
          { role: "assistant", content: "Sure." },
          { role: "user", content: "Now list the risks" },
        ],
        nodes: [
          node({
            tool_calls: [
              {
                id: "t1",
                name: "search/docs",
                arguments: {},
                result: null,
                is_error: false,
                called_at: "2026-10-20T10:00:01.000Z",
              },
              {
                id: "t2",
                name: "search/docs",
                arguments: {},
                result: null,
                is_error: false,
                called_at: "2026-10-20T10:00:01.500Z",
              },
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const benchCase = result.captured.benchCase;
    expect(benchCase.id).toBe(`captured-${"11111111-1111-4111-8111-111111111111"}`);
    expect(benchCase.messages).toHaveLength(4);
    expect(benchCase.messages[3]?.content).toBe("Now list the risks");
    const assertions = benchCase.assert ?? [];
    // Distinct tool only once despite two calls.
    const toolAssertions = assertions.filter((a) => a.type === "toolCalled");
    expect(toolAssertions).toEqual([{ type: "toolCalled", name: "search/docs" }]);
    expect(assertions).toContainEqual({ type: "finishReason", equals: "stop" });
    // ceil(1.5 * 160) = 240
    expect(assertions).toContainEqual({ type: "maxTokens", value: 240 });
    // ceil(2 * 4000ms) = 8000
    expect(assertions).toContainEqual({ type: "maxLatencyMs", value: 8000 });
    expect(assertions).toContainEqual({ type: "noDiagnostic", code: "empty_response" });
  });

  it("drops noDiagnostic codes that occurred with level error and keeps the rest", () => {
    const result = captureBenchCase(
      trace({
        nodes: [
          node({
            diagnostics: [
              {
                at: "2026-10-20T10:00:01.000Z",
                level: "error",
                code: "tool_execution_failed",
                message: "tool blew up",
              },
              {
                at: "2026-10-20T10:00:01.200Z",
                level: "warn",
                code: "retry",
                message: "retried",
              },
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const codes = (result.captured.benchCase.assert ?? [])
      .filter((a) => a.type === "noDiagnostic")
      .map((a) => (a as { code: string }).code);
    expect(codes).not.toContain("tool_execution_failed");
    // A warn-level code is not an error code at all — the known list is unaffected.
    expect(codes).not.toContain("retry");
    expect(codes).toContain("empty_response");
    // All known codes except the occurred one, limited by the per-case cap of
    // 20 assertions (finishReason + maxTokens + maxLatencyMs take 3 of them).
    expect(codes.length).toBe(Math.min(KNOWN_ERROR_DIAGNOSTIC_CODES.length - 1, 20 - 3));
  });

  it("caps the assertion count at the bench contract limit", () => {
    const result = captureBenchCase(
      trace({
        nodes: [
          node({
            tool_calls: Array.from({ length: 12 }, (_, i) => ({
              id: `t${i}`,
              name: `srv/tool_${i}`,
              arguments: {},
              result: null,
              is_error: false,
              called_at: "2026-10-20T10:00:01.000Z",
            })),
          }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.captured.benchCase.assert ?? []).length).toBeLessThanOrEqual(20);
  });

  it("refuses inputs containing personal data and names the kinds", () => {
    const result = captureBenchCase(
      trace({ input_messages: [{ role: "user", content: "Write to john@example.com, IBAN DE89370400440532013000" }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("contains personal data");
    expect(result.error).toContain("email");
    expect(result.error).toContain("iban");
    expect(result.error).toContain("pass --allow-raw");
  });

  it("warns instead of refusing when allowRaw is set", () => {
    const result = captureBenchCase(
      trace({ input_messages: [{ role: "user", content: "Mail me at john@example.com" }] }),
      { allowRaw: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join("\n")).toContain("personal data");
    expect(result.captured.benchCase.messages[0]?.content).toContain("john@example.com");
  });

  it("drops tool-role messages and empty content from the case", () => {
    const result = captureBenchCase(
      trace({
        input_messages: [
          { role: "user", content: "Hi" },
          { role: "tool", content: "raw tool payload", tool_call_id: "t1", name: "search/docs" },
          { role: "assistant", content: "" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.captured.benchCase.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("omits maxTokens when the trace recorded no usage", () => {
    const result = captureBenchCase(trace({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.captured.benchCase.assert ?? []).some((a) => a.type === "maxTokens")).toBe(false);
  });
});

describe("renderBenchFile / appendCapturedCases", () => {
  function captured(id: string, executionId: string) {
    const result = captureBenchCase(
      trace({
        execution_id: executionId,
        input_messages: [{ role: "user", content: `question ${id}` }],
      }),
    );
    if (!result.ok) throw new Error("fixture must capture");
    return result.captured;
  }

  it("renders a contract-valid file with a provenance comment per case", () => {
    const yaml = renderBenchFile("my-flow", [captured("a", "exec-a"), captured("b", "exec-b")], { passRate: 1 });
    const parsed = BenchFileSchema.parse(parseYaml(yaml));
    expect(parsed.cases.map((c) => c.id)).toEqual(["captured-exec-a", "captured-exec-b"]);
    expect(yaml).toContain("# captured from execution exec-a at ");
    expect(yaml).toContain("review the expectations before release");
    expect(yaml).toContain("flow: my-flow");
    expect(yaml).toContain("captured-exec-b");
  });

  it("appends to existing YAML without touching existing cases", () => {
    const first = renderBenchFile("my-flow", [captured("a", "exec-a")], { passRate: 1 });
    const merged = appendCapturedCases(first, "my-flow", [captured("b", "exec-b")]);
    expect(merged).toContain("captured-exec-a");
    expect(merged).toContain("captured-exec-b");
    expect(merged).toContain("# captured from execution exec-a");
  });

  it("refuses to append when the case id already exists", () => {
    const first = renderBenchFile("my-flow", [captured("a", "exec-a")], { passRate: 1 });
    expect(() => appendCapturedCases(first, "my-flow", [captured("a", "exec-a")])).toThrow(
      /already exists/,
    );
  });

  it("refuses to append to a file for a different flow", () => {
    const first = renderBenchFile("other-flow", [captured("a", "exec-a")], { passRate: 1 });
    expect(() => appendCapturedCases(first, "my-flow", [captured("b", "exec-b")])).toThrow(
      /for flow "other-flow"/,
    );
  });
});
