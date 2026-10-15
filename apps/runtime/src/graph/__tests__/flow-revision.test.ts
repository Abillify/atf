// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `flow_digest` / `subflow_versions`: revision identity of the executed flow,
 * independent of the (human-declared) `metadata.version`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { AppConfig } from "../../config/index.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { RequestContext } from "../../types/monitoring.js";
import { createFlowParserService } from "../flow-parser.js";
import { computeFlowDigest, subflowVersionsOf } from "../flow-revision.js";
import type { FlowDefinition } from "../../types/flow.js";

const base = (over: Partial<FlowDefinition> = {}): FlowDefinition =>
  ({
    id: "f",
    name: "F",
    nodes: [{ id: "a", type: "llm", systemPrompt: "Answer briefly." }],
    edges: [],
    metadata: { version: "1.0.0" },
    ...over,
  }) as FlowDefinition;

describe("computeFlowDigest", () => {
  test("is a stable sha256 and ignores key order, layout and changelog", () => {
    const a = computeFlowDigest(base());
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reordered = base({
      metadata: { changelog: { "1.0.0": "x" }, ui: { layout: [] }, version: "1.0.0" },
    });
    expect(computeFlowDigest(reordered)).toBe(a);
  });

  test("changes when the executed behaviour changes, even with the same version", () => {
    const changed = base({
      nodes: [{ id: "a", type: "llm", systemPrompt: "Answer in German." }],
    } as Partial<FlowDefinition>);
    expect(computeFlowDigest(changed)).not.toBe(computeFlowDigest(base()));
  });
});

describe("subflowVersionsOf", () => {
  test("returns [] without bookkeeping and sorted entries with it", () => {
    expect(subflowVersionsOf(base())).toEqual([]);
    const f = base({
      metadata: {
        $subflowVersions: { "subflows/b.yaml": null, "subflows/a.yaml": "2.0.0" },
      },
    });
    expect(subflowVersionsOf(f)).toEqual([
      { path: "subflows/a.yaml", version: "2.0.0" },
      { path: "subflows/b.yaml", version: null },
    ]);
  });
});

describe("loader records sub-flow versions", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("the runtime form carries each merged sub-flow's declared version", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-revision-"));
    fs.mkdirSync(path.join(dir, "subflows"));
    fs.writeFileSync(
      path.join(dir, "subflows", "guard.yaml"),
      JSON.stringify({
        metadata: { version: "3.1.0" },
        nodes: [{ id: "guard-node", type: "tool" }],
        edges: [],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "parent.json"),
      JSON.stringify({
        id: "parent",
        name: "Parent",
        metadata: { version: "1.0.0", $include: { subflows: ["subflows/guard.yaml"] } },
        nodes: [{ id: "router", type: "router" }],
        edges: [{ source: "router", target: "guard-node" }],
      }),
    );
    const service = createFlowParserService(dir);
    await service.start();
    const flow = service.getRegistry().get("parent");
    await service.stop();
    if (flow === undefined) throw new Error("expected the parent flow to load");
    expect(subflowVersionsOf(flow)).toEqual([
      { path: "subflows/guard.yaml", version: "3.1.0" },
    ]);
    expect(computeFlowDigest(flow)).toMatch(/^sha256:/);
  });
});

// ── Engine: the trace carries flow_version, flow_digest and subflow_versions ──

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

/** Captures the last prompt the mock LLM was called with. */
function capturingLlm(tokens: string[], capture: { prompt?: unknown }) {
  return () =>
    new MockLanguageModelV3({
      doStream: async (opts) => {
        capture.prompt = opts.prompt;
        return {
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              for (const t of tokens) {
                controller.enqueue({ type: "text-start", id: "1" });
                controller.enqueue({ type: "text-delta", id: "1", delta: t });
                controller.enqueue({ type: "text-end", id: "1" });
              }
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 7,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 5,
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
              controller.close();
            },
          }),
        } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
      },
    });
}


describe("debug trace revision identity", () => {
  test("flow_version, flow_digest and subflow_versions are recorded", async () => {
    const flow = base({
      id: "rev-flow",
      metadata: {
        version: "2.4.0",
        $subflowVersions: { "subflows/guard.yaml": "3.1.0" },
      },
    });
    const map = new Map([[flow.id, flow]]);
    const flowRegistry: FlowRegistry = { get: (id) => map.get(id), list: () => [...map.values()] };
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(baseConfig, {
      flowRegistry,
      llmProviderFactory: capturingLlm(["ok"], {}),
    });
    engine.setDebugStore?.(debugStore);
    const ctx: RequestContext = { ssoToken: "a.b.c", executionId: "exec-rev-1" };
    await engine.executeFlow(
      "rev-flow",
      [{ role: "user", content: "hi" }],
      ctx,
      async () => {},
      async () => {},
      undefined,
    );
    const trace = debugStore.getTrace("exec-rev-1");
    expect(trace?.flow_version).toBe("2.4.0");
    expect(trace?.flow_digest).toBe(computeFlowDigest(flow));
    expect(trace?.subflow_versions).toEqual([
      { path: "subflows/guard.yaml", version: "3.1.0" },
    ]);
  });
});
