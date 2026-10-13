// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { CompositeToolExecutor } from "../../src/tools/composite-tool.ts";
import { CompositeToolSchema } from "../../src/config/schema.ts";
import type { AuthContext } from "../../src/auth/context.ts";
import type { ToolExecutor, ToolResult } from "../../src/tools/types.ts";

const ctx: AuthContext = {
  method: "static",
  subject: "u",
  username: "alice",
  scopes: [],
  claims: {},
  headers: {},
  rawToken: "",
};

/** A tool that echoes its received arguments as JSON. */
function echoTool(name: string, transform: (args: Record<string, unknown>) => unknown): ToolExecutor {
  return {
    definition: { name, description: "", inputSchema: {} },
    async execute(args): Promise<ToolResult> {
      return { content: [{ type: "text", text: JSON.stringify(transform(args)) }] };
    },
  };
}

function errorTool(name: string): ToolExecutor {
  return {
    definition: { name, description: "", inputSchema: {} },
    async execute(): Promise<ToolResult> {
      return { content: [{ type: "text", text: "failed" }], isError: true };
    },
  };
}

describe("CompositeToolExecutor", () => {
  it("chains steps, passing prior output and caller args through tokens", async () => {
    const tools = new Map<string, ToolExecutor>([
      ["double", echoTool("double", (a) => ({ doubled: (a.n as number) * 2 }))],
      ["label", echoTool("label", (a) => ({ result: a.value, who: a.who }))],
    ]);
    const cfg = CompositeToolSchema.parse({
      name: "flow",
      type: "composite",
      steps: [
        { id: "s1", tool: "double", arguments: { n: ":param.n" } },
        { id: "s2", tool: "label", arguments: { value: ":steps.s1.doubled", who: ":ctx.username" } },
      ],
      output: ":steps.s2",
    });
    const exec = new CompositeToolExecutor(cfg, (n) => tools.get(n));

    const res = await exec.execute({ n: 5 }, ctx);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual({ result: 10, who: "alice" });
  });

  it("returns the last step's result when no output token is set", async () => {
    const tools = new Map<string, ToolExecutor>([["t", echoTool("t", () => ({ ok: true }))]]);
    const cfg = CompositeToolSchema.parse({
      name: "flow",
      type: "composite",
      steps: [{ id: "s1", tool: "t", arguments: {} }],
    });
    const exec = new CompositeToolExecutor(cfg, (n) => tools.get(n));
    const res = await exec.execute({}, ctx);
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
  });

  it("aborts and reports the failing step on error", async () => {
    const tools = new Map<string, ToolExecutor>([
      ["bad", errorTool("bad")],
      ["never", echoTool("never", () => ({ reached: true }))],
    ]);
    const cfg = CompositeToolSchema.parse({
      name: "flow",
      type: "composite",
      steps: [
        { id: "s1", tool: "bad", arguments: {} },
        { id: "s2", tool: "never", arguments: {} },
      ],
    });
    const exec = new CompositeToolExecutor(cfg, (n) => tools.get(n));
    const res = await exec.execute({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.meta?.failedStep).toBe("s1");
  });

  it("errors clearly when a step references an unknown tool", async () => {
    const cfg = CompositeToolSchema.parse({
      name: "flow",
      type: "composite",
      steps: [{ id: "s1", tool: "missing", arguments: {} }],
    });
    const exec = new CompositeToolExecutor(cfg, () => undefined);
    const res = await exec.execute({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("unknown tool");
  });

  it("explain returns the static plan without executing", async () => {
    const tools = new Map<string, ToolExecutor>([["t", echoTool("t", () => ({}))]]);
    const cfg = CompositeToolSchema.parse({
      name: "flow",
      type: "composite",
      steps: [{ id: "s1", tool: "t", arguments: { a: ":param.x" } }],
    });
    const exec = new CompositeToolExecutor(cfg, (n) => tools.get(n));
    const res = await exec.explain({}, ctx);
    const plan = JSON.parse(res.content[0].text);
    expect(plan.steps[0]).toMatchObject({ id: "s1", tool: "t", resolvable: true });
  });
});
