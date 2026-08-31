// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { CompositeToolExecutor } from "../../src/tools/composite-tool.ts";
import { CompositeToolSchema } from "../../src/config/schema.ts";
import type { AuthContext } from "../../src/auth/context.ts";
import type { ToolExecutor, ToolResult } from "../../src/tools/types.ts";

const ctx: AuthContext = {
  method: "static",
  subject: "s",
  username: "alice",
  scopes: [],
  claims: {},
  headers: {},
  rawToken: "t",
};

function makeTool(
  name: string,
  fn: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
): ToolExecutor {
  return {
    definition: { name, description: "", inputSchema: { type: "object", properties: {} } },
    execute: async (args) => fn(args),
  };
}

describe("CompositeToolExecutor v2 · condition gating", () => {
  it("skips a step whose condition resolves falsy, leaving :steps.<id> as null", async () => {
    const calls: string[] = [];
    const gated = makeTool("gated", async () => {
      calls.push("gated");
      return { content: [{ type: "text", text: "1" }] };
    });
    const cfg = CompositeToolSchema.parse({
      name: "c",
      type: "composite",
      steps: [{ id: "s1", tool: "gated", condition: ":param.run", arguments: {} }],
      output: ":steps.s1",
    });
    const exec = new CompositeToolExecutor(cfg, (n) => (n === "gated" ? gated : undefined));
    const res = await exec.execute({ run: false }, ctx);
    expect(calls).toEqual([]);
    expect(res.content[0]?.text).toBe("null");
  });

  it("runs the step when its condition resolves truthy", async () => {
    const tool = makeTool("t", async () => ({ content: [{ type: "text", text: "42" }] }));
    const cfg = CompositeToolSchema.parse({
      name: "c",
      type: "composite",
      steps: [{ id: "s1", tool: "t", condition: ":param.run", arguments: {} }],
      output: ":steps.s1",
    });
    const exec = new CompositeToolExecutor(cfg, () => tool);
    const res = await exec.execute({ run: true }, ctx);
    expect(res.content[0]?.text).toBe("42");
  });
});

describe("CompositeToolExecutor v2 · parallel groups", () => {
  it("runs steps sharing a parallelGroup concurrently", async () => {
    const order: string[] = [];
    const slow = makeTool("slow", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
      return { content: [{ type: "text", text: "1" }] };
    });
    const fast = makeTool("fast", async () => {
      order.push("fast");
      return { content: [{ type: "text", text: "2" }] };
    });
    const cfg = CompositeToolSchema.parse({
      name: "c",
      type: "composite",
      steps: [
        { id: "a", tool: "slow", parallelGroup: "g1", arguments: {} },
        { id: "b", tool: "fast", parallelGroup: "g1", arguments: {} },
      ],
    });
    const start = Date.now();
    const exec = new CompositeToolExecutor(cfg, (n) => (n === "slow" ? slow : fast));
    await exec.execute({}, ctx);
    const elapsed = Date.now() - start;
    // "fast" finishes first even though declared second — proves concurrency.
    expect(order[0]).toBe("fast");
    expect(elapsed).toBeLessThan(40);
  });
});

describe("CompositeToolExecutor v2 · retries and timeout", () => {
  it("retries a failing step up to `retries` times before giving up", async () => {
    let attempts = 0;
    const flaky = makeTool("flaky", async () => {
      attempts++;
      if (attempts < 3) return { content: [{ type: "text", text: "err" }], isError: true };
      return { content: [{ type: "text", text: "ok" }] };
    });
    const cfg = CompositeToolSchema.parse({
      name: "c",
      type: "composite",
      steps: [{ id: "s1", tool: "flaky", retries: 2, retryDelayMs: 1, arguments: {} }],
    });
    const exec = new CompositeToolExecutor(cfg, () => flaky);
    const res = await exec.execute({}, ctx);
    expect(attempts).toBe(3);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toBe("ok");
  });

  it("fails the composite once retries are exhausted", async () => {
    const alwaysFails = makeTool("f", async () => ({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    }));
    const cfg = CompositeToolSchema.parse({
      name: "c",
      type: "composite",
      steps: [{ id: "s1", tool: "f", retries: 1, retryDelayMs: 1, arguments: {} }],
    });
    const exec = new CompositeToolExecutor(cfg, () => alwaysFails);
    const res = await exec.execute({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.meta?.failedStep).toBe("s1");
  });

  it("times out a step that runs longer than timeoutMs", async () => {
    let aborted = false;
    const hangs = makeTool("hangs", async () => ({ content: [{ type: "text", text: "unused" }] }));
    hangs.execute = async (_args, _ctx, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return { content: [{ type: "text", text: "aborted" }], isError: true };
    };
    const cfg = CompositeToolSchema.parse({
      name: "c",
      type: "composite",
      steps: [{ id: "s1", tool: "hangs", timeoutMs: 20, arguments: {} }],
    });
    const exec = new CompositeToolExecutor(cfg, () => hangs);
    const res = await exec.execute({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("timed out");
    expect(aborted).toBe(true);
  });

  it("propagates parent abort and stops an abortable retry delay", async () => {
    let attempts = 0;
    let received: AbortSignal | undefined;
    const failing = makeTool("failing", async () => ({
      content: [{ type: "text", text: "no" }],
      isError: true,
    }));
    failing.execute = async (_args, _ctx, signal) => {
      attempts++;
      received = signal;
      return { content: [{ type: "text", text: "no" }], isError: true };
    };
    const cfg = CompositeToolSchema.parse({
      name: "c",
      type: "composite",
      steps: [{ id: "s1", tool: "failing", retries: 2, retryDelayMs: 5_000, arguments: {} }],
    });
    const controller = new AbortController();
    const exec = new CompositeToolExecutor(cfg, () => failing);
    const pending = exec.execute({}, ctx, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("cancelled"));
    const res = await pending;
    expect(received).toBeDefined();
    expect(attempts).toBe(1);
    expect(res.isError).toBe(true);
  });

  it("aborts a running attempt when the parent is aborted", async () => {
    let aborted = false;
    const running = makeTool("running", async () => ({
      content: [{ type: "text", text: "unused" }],
    }));
    running.execute = async (_args, _ctx, signal) => {
      await new Promise<void>((resolve) =>
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { content: [{ type: "text", text: "stopped" }], isError: true };
    };
    const cfg = CompositeToolSchema.parse({
      name: "c",
      type: "composite",
      steps: [{ id: "s1", tool: "running", arguments: {} }],
    });
    const controller = new AbortController();
    const pending = new CompositeToolExecutor(cfg, () => running).execute(
      {},
      ctx,
      controller.signal,
    );
    controller.abort();
    const res = await pending;
    expect(aborted).toBe(true);
    expect(res.content[0]?.text).toContain("aborted");
  });
});

describe("CompositeToolExecutor v2 · structuredContent", () => {
  it("returns structuredContent when the resolved output is an object", async () => {
    const tool = makeTool("t", async () => ({
      content: [{ type: "text", text: JSON.stringify({ rows: [1, 2] }) }],
    }));
    const cfg = CompositeToolSchema.parse({
      name: "c",
      type: "composite",
      steps: [{ id: "s1", tool: "t", arguments: {} }],
      output: ":steps.s1",
    });
    const exec = new CompositeToolExecutor(cfg, () => tool);
    const res = await exec.execute({}, ctx);
    expect(res.structuredContent).toEqual({ rows: [1, 2] });
  });
});
