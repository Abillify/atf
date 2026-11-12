// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * PII vault at the tool boundary (ADR 0036): listed tools get real values in
 * their arguments, unlisted tools keep placeholders, and everything that is
 * recorded about the call keeps the placeholder form.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { buildAiTools } from "../agent-tools.js";
import {
  createPiiToolBoundary,
  getPiiToolBoundary,
  PII_TOOL_DETOKENIZED_METRIC,
  setPiiToolBoundary,
} from "../pii-tool-boundary.js";
import { createPiiVault, InMemoryPiiVaultStore } from "../pii-vault.js";
import type { PiiVault } from "../pii-vault.js";
import { createToolEgressGuardrail } from "../output-guardrails.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import { withPiiVault } from "../pii-vault-engine.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";

const EXEC = "exec-pii-boundary";
const CTX: RequestContext = { ssoToken: "a.b.c", executionId: EXEC };

function vault(): PiiVault {
  const v = createPiiVault(new InMemoryPiiVaultStore(), { enabled: true });
  if (v === undefined) throw new Error("vault expected");
  return v;
}

afterEach(() => setPiiToolBoundary(undefined));

describe("createPiiToolBoundary", () => {
  test("no patterns → no boundary", () => {
    expect(createPiiToolBoundary(vault(), [])).toBeUndefined();
    expect(createPiiToolBoundary(vault(), [" ", ""])).toBeUndefined();
  });

  test("matches full ref, bare name and server wildcard like APPROVAL_REQUIRE_TOOLS", () => {
    const b = createPiiToolBoundary(vault(), ["crm/lookup", "send_mail", "hr/*"]);
    expect(b?.applies("crm/lookup")).toBe(true);
    expect(b?.applies("crm/delete")).toBe(false);
    expect(b?.applies("mail/send_mail")).toBe(true);
    expect(b?.applies("hr/anything")).toBe(true);
    expect(b?.applies("web/fetch")).toBe(false);
  });

  test("restores placeholders at any depth and leaves other values alone", async () => {
    const v = vault();
    const email = await v.tokenize(EXEC, undefined, "jane@example.com");
    const iban = await v.tokenize(EXEC, undefined, "DE89370400440532013000");
    const counted: Array<Record<string, string>> = [];
    const b = createPiiToolBoundary(v, ["crm/*"], {
      recordCounter: (name, labels) => {
        if (name === PII_TOOL_DETOKENIZED_METRIC) counted.push(labels);
      },
    });
    const args = {
      to: email,
      note: `refund to ${iban} today`,
      nested: { list: [email, 7, null, { deep: iban }] },
      limit: 5,
    };
    const out = await b?.detokenizeArgs("crm/lookup", EXEC, args);
    expect(out).toEqual({
      to: "jane@example.com",
      note: "refund to DE89370400440532013000 today",
      nested: {
        list: ["jane@example.com", 7, null, { deep: "DE89370400440532013000" }],
      },
      limit: 5,
    });
    // The input is not mutated — it is what gets recorded.
    expect(args.to).toBe(email);
    expect(counted).toEqual([{ tool: "crm/lookup" }]);
  });

  test("returns the same object when nothing changed or the tool is not listed", async () => {
    const v = vault();
    const email = await v.tokenize(EXEC, undefined, "jane@example.com");
    const b = createPiiToolBoundary(v, ["crm/lookup"]);
    const plain = { q: "no placeholders here" };
    expect(await b?.detokenizeArgs("crm/lookup", EXEC, plain)).toBe(plain);
    const other = { to: email };
    expect(await b?.detokenizeArgs("web/fetch", EXEC, other)).toBe(other);
  });

  test("never resolves another execution's placeholder", async () => {
    const v = vault();
    const foreign = await v.tokenize("exec-other", undefined, "jane@example.com");
    const b = createPiiToolBoundary(v, ["*"]);
    const args = { to: foreign };
    const out = await b?.detokenizeArgs("crm/lookup", EXEC, args);
    expect(out).toEqual({ to: foreign });
  });
});

describe("tool boundary in the LLM tool loop (buildAiTools)", () => {
  async function run(opts: {
    listed: boolean;
    args: Record<string, unknown>;
    egressBlock?: boolean;
    v: PiiVault;
  }): Promise<{
    wire: unknown[];
    traced: unknown[];
    result: unknown;
  }> {
    const wire: unknown[] = [];
    const traced: unknown[] = [];
    const mcp: McpWrapperService = {
      connect: async () => {},
      reconnect: async () => {},
      listTools: async () => ["lookup"],
      getFilteredToolSchema: async (_s, t) => ({
        name: t,
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: { email: { type: "string" } },
        },
      }),
      refreshSchemaIfChanged: async () => false,
      callTool: async (_s: string, _t: string, args: unknown) => {
        wire.push(args);
        return { content: "found" };
      },
      getInstructions: () => undefined,
    };
    setPiiToolBoundary(
      createPiiToolBoundary(opts.v, opts.listed ? ["crm/lookup"] : ["other/tool"]),
    );
    expect(getPiiToolBoundary()).toBeDefined();
    const node: FlowNode = { id: "n1", type: "llm", tools: ["crm/lookup"] };
    const egress =
      opts.egressBlock === true
        ? {
            guardrail: createToolEgressGuardrail({
              enabled: true,
              redactPii: true,
              mode: "block",
            }),
          }
        : undefined;
    const { tools } = await buildAiTools(
      node,
      mcp,
      CTX,
      undefined,
      egress as never,
      undefined,
      undefined,
      undefined,
      {
        onEffectiveToolArgs: (_id, _ref, args) => {
          traced.push(args);
        },
      },
    );
    const set = tools as ToolSet;
    const tool = set[Object.keys(set)[0] ?? ""];
    if (tool?.execute === undefined) throw new Error("expected one executable tool");
    const result = await tool.execute(opts.args, { toolCallId: "tc-1" } as never);
    return { wire, traced, result };
  }

  test("a listed tool is called with the real value; the trace keeps the placeholder", async () => {
    const v = vault();
    const placeholder = await v.tokenize(EXEC, undefined, "jane@example.com");
    const { wire, traced } = await run({
      listed: true,
      args: { email: placeholder },
      v,
    });
    expect(wire).toEqual([{ email: "jane@example.com" }]);
    expect(traced).toEqual([{ email: placeholder }]);
    expect(JSON.stringify(traced)).not.toContain("jane@example.com");
  });

  test("an unlisted tool is called with the placeholder", async () => {
    const v = vault();
    const placeholder = await v.tokenize(EXEC, undefined, "jane@example.com");
    const { wire } = await run({
      listed: false,
      args: { email: placeholder },
      v,
    });
    expect(wire).toEqual([{ email: placeholder }]);
  });

  test("egress DLP still blocks plaintext the model wrote itself, and lets placeholders through", async () => {
    const v = vault();
    const placeholder = await v.tokenize(EXEC, undefined, "jane@example.com");
    const blocked = await run({
      listed: true,
      args: { email: "mallory@example.org" },
      egressBlock: true,
      v,
    });
    expect(blocked.wire).toEqual([]);
    expect(JSON.stringify(blocked.result)).toContain("egress_blocked");

    const passed = await run({
      listed: true,
      args: { email: placeholder },
      egressBlock: true,
      v,
    });
    expect(passed.wire).toEqual([{ email: "jane@example.com" }]);
  });
});

describe("tool boundary in the deterministic tool node (engine + vault decorator)", () => {
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
  const flow: FlowDefinition = {
    id: "lookup-flow",
    name: "Lookup",
    nodes: [
      {
        id: "lookup",
        type: "tool",
        tools: ["crm/lookup"],
        config: { toolArgs: { "crm/lookup": { q: "{{query}}" } } },
      },
    ],
    edges: [],
  };

  async function execute(listed: boolean): Promise<{
    wire: unknown[];
    traceJson: string;
  }> {
    const wire: unknown[] = [];
    const v = vault();
    setPiiToolBoundary(
      createPiiToolBoundary(v, listed ? ["crm/lookup"] : ["other/tool"]),
    );
    const mcp: McpWrapperService = {
      connect: async () => {},
      reconnect: async () => {},
      listTools: async () => ["lookup"],
      getFilteredToolSchema: async (_s, t) => ({
        name: t,
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      }),
      refreshSchemaIfChanged: async () => false,
      callTool: async (_s: string, _t: string, args: unknown) => {
        wire.push(args);
        return { content: "one record" };
      },
      getInstructions: () => undefined,
    };
    const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
    const registry: FlowRegistry = {
      get: (id) => map.get(id),
      list: () => [...map.values()],
    };
    const inner = createGraphEngine(baseConfig, {
      flowRegistry: registry,
      mcpWrapper: mcp,
      llmProviderFactory: () => {
        throw new Error("no LLM node in this flow");
      },
    });
    const debug = new InMemoryDebugTraceStore();
    inner.setDebugStore?.(debug);
    const engine = withPiiVault(inner, v);
    const executionId = `exec-tool-node-${listed ? "listed" : "unlisted"}`;
    await engine.executeFlow(
      "lookup-flow",
      [{ role: "user", content: "find jane@example.com" }],
      { ssoToken: "a.b.c", executionId },
      async () => {},
      async () => {},
    );
    return { wire, traceJson: JSON.stringify(debug.getTrace(executionId) ?? {}) };
  }

  test("a listed tool receives the real value, the debug trace does not", async () => {
    const { wire, traceJson } = await execute(true);
    expect(wire).toEqual([{ q: "find jane@example.com" }]);
    // The trace recorded the call — with the placeholder, not the address.
    expect(traceJson).toContain("[[PII:EMAIL:");
    expect(traceJson).not.toContain("jane@example.com");
  });

  test("an unlisted tool receives the placeholder", async () => {
    const { wire } = await execute(false);
    expect(wire).toHaveLength(1);
    const q = (wire[0] as { q: string }).q;
    expect(q).toMatch(/^find \[\[PII:EMAIL:[a-f0-9]{16}\]\]$/);
  });
});
