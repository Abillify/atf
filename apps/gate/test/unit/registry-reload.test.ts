// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import {
  DecoratedToolExecutor,
  ScopeEnforcingToolExecutor,
  ToolRegistry,
} from "../../src/tools/registry.ts";
import type { ToolExecutor } from "../../src/tools/types.ts";
import { ToolConfigSchema } from "../../src/config/schema.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import { FakeDb } from "../helpers/fake-db.ts";

const runtime = () => ({ db: new FakeDb({ main: [{ id: 1 }] }), bus: new MonitorBus(10) });

const dbTool = (name: string) =>
  ToolConfigSchema.parse({
    name,
    type: "database",
    database: "main",
    query: "select 1",
    inputSchema: { type: "object", properties: {}, required: [] },
  });

const inlineTool = (
  name: string,
  inputSchema: Record<string, unknown> = {
    type: "object",
    properties: {},
    required: [],
  },
  outputSchema?: Record<string, unknown>,
) =>
  ToolConfigSchema.parse({
    name,
    type: "inline",
    handler: "calculate",
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
  });

describe("ToolRegistry.reload", () => {
  it("swaps the tool set in place", () => {
    const reg = new ToolRegistry([dbTool("a")], runtime());
    expect(reg.size).toBe(1);
    expect(reg.list().map((d) => d.name)).toEqual(["a"]);

    reg.reload([inlineTool("b"), dbTool("c")]);
    expect(reg.size).toBe(2);
    expect(reg.getReal("a")).toBeUndefined();
    expect(reg.getReal("b")).toBeDefined();
    expect(reg.typeOf("b")).toBe("inline");
    expect(
      reg
        .list()
        .map((d) => d.name)
        .sort(),
    ).toEqual(["b", "c"]);
  });

  it("propagates abort through the registry decoration and authorization wrappers", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const inner: ToolExecutor = {
      definition: { name: "wrapped", description: "", inputSchema: {} },
      async execute(_args, _ctx, signal) {
        received = signal;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const wrapped = new DecoratedToolExecutor(
      new ScopeEnforcingToolExecutor(inner, []),
      undefined,
      undefined,
      "read",
    );
    await wrapped.execute(
      {},
      {
        method: "static",
        subject: "s",
        username: "u",
        scopes: [],
        claims: {},
        headers: {},
        rawToken: "",
      },
      controller.signal,
    );

    expect(received).toBe(controller.signal);
  });

  it("preserves a webhook executor instance across reload (keeps its receiver/cache)", () => {
    const webhook = ToolConfigSchema.parse({
      name: "wh",
      type: "webhook",
      path: "/webhooks/wh",
      tenantId: "acme",
      inputSchema: { type: "object", properties: {}, required: [] },
    });
    const reg = new ToolRegistry([webhook], runtime());
    const before = reg.getReal("wh");
    reg.reload([webhook, dbTool("a")]);
    const after = reg.getReal("wh");
    expect(after).toBe(before); // same instance → mounted receiver still valid
    expect(reg.getReal("a")).toBeDefined();
  });

  it("updates effective scopes on a preserved outer wrapper during reload", async () => {
    const configured = (requiredScopes: string[]) =>
      ToolConfigSchema.parse({
        name: "wh",
        type: "webhook",
        path: "/webhooks/wh",
      tenantId: "acme",
        requiredScopes,
        inputSchema: { type: "object", properties: {}, required: [] },
      });
    const reg = new ToolRegistry([configured(["old:scope", "tools:read"])], runtime());
    const before = reg.getReal("wh");
    expect(reg.requiredScopesOf("wh")).toEqual(["old:scope", "tools:read"]);

    reg.reload([configured(["new:scope", "new:scope"])]);
    expect(reg.getReal("wh")).toBe(before);
    expect(reg.requiredScopesOf("wh")).toEqual(["new:scope"]);

    const executor = reg.getReal("wh");
    expect(executor).toBeDefined();
    const result = await executor?.execute(
      {},
      {
        method: "static",
        subject: "s",
        username: "u",
        scopes: ["tools:read", "old:scope"],
        claims: {},
        headers: {},
        rawToken: "",
      },
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Missing required scope(s): new:scope" }],
      isError: true,
    });
  });

  it("report mode warns and swaps despite a breaking output change", () => {
    const output = (required: string[]) => ({
      type: "object",
      properties: { kept: { type: "string" }, removed: { type: "string" } },
      required,
    });
    const reg = new ToolRegistry(
      [inlineTool("same", undefined, output(["kept", "removed"]))],
      runtime(),
      "report",
    );
    const before = reg.getReal("same");
    const lines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      reg.reload([
        inlineTool("same", undefined, {
          type: "object",
          properties: { kept: { type: "string" } },
          required: ["kept"],
        }),
      ]);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(reg.getReal("same")).not.toBe(before);
    expect(lines.join("\n")).toContain("tool schema compatibility finding");
    expect(lines.join("\n")).toContain("breaking");
  });

  it("strict mode rejects breaking input changes without mutating preserved wrappers", () => {
    const configured = (requiredScopes: string[], required: string[]) =>
      ToolConfigSchema.parse({
        name: "wh",
        type: "webhook",
        path: "/webhooks/wh",
        tenantId: "acme",
        requiredScopes,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required,
        },
      });
    const reg = new ToolRegistry([configured(["old:scope"], [])], runtime(), "strict");
    const before = reg.getReal("wh");

    expect(() => reg.reload([configured(["new:scope"], ["query"])]))
      .toThrow(/Schema compatibility check rejected reload/);
    expect(reg.getReal("wh")).toBe(before);
    expect(reg.requiredScopesOf("wh")).toEqual(["old:scope"]);
    expect(reg.getReal("wh")?.definition.inputSchema).toMatchObject({ required: [] });
  });

  it("report mode warns and removes a tool despite the breaking surface change", () => {
    const reg = new ToolRegistry([dbTool("kept"), dbTool("removed")], runtime(), "report");
    const lines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      reg.reload([dbTool("kept")]);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(reg.getReal("removed")).toBeUndefined();
    expect(lines.join("\n")).toContain("tool-removed");
  });

  it("strict mode rejects a removed tool atomically", () => {
    const reg = new ToolRegistry([dbTool("kept"), dbTool("removed")], runtime(), "strict");
    const removedBefore = reg.getReal("removed");

    expect(() => reg.reload([dbTool("kept")])).toThrow(/tool-removed/);
    expect(reg.size).toBe(2);
    expect(reg.getReal("removed")).toBe(removedBefore);
  });

  it("strict mode allows unknown-only changes and swaps", () => {
    const schema = (pattern: string) => ({
      type: "object",
      properties: { query: { type: "string", pattern } },
      required: [],
    });
    const reg = new ToolRegistry([inlineTool("same", schema("^a"))], runtime(), "strict");
    const before = reg.getReal("same");

    reg.reload([inlineTool("same", schema("^b"))]);
    expect(reg.getReal("same")).not.toBe(before);
    expect(reg.getReal("same")?.definition.inputSchema).toMatchObject(schema("^b"));
  });
});
