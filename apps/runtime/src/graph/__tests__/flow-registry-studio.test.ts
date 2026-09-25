// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "bun:test";
import { createStudioTestRegistry, isStudioTestModel } from "../flow-registry-studio.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { FlowRegistry } from "../flow-parser.js";
import { resolveFlowRouting } from "../../routes/chat/metering.js";

const live: FlowDefinition = { id: "f", name: "F", nodes: [{ id: "a", type: "router" }], edges: [] };
const canvas: FlowDefinition = { ...live, nodes: [{ id: "b", type: "router" }] };
const base: FlowRegistry = { get: (id) => (id === "f" ? live : undefined), list: () => [live] };

describe("studio test registry", () => {
  test("resolves a registered canvas under its throwaway id without listing it", () => {
    const reg = createStudioTestRegistry(base);
    const { model } = reg.register(canvas);
    expect(isStudioTestModel(model)).toBe(true);
    expect(model.startsWith("f@studio-")).toBe(true);
    expect(reg.get(model)).toBe(canvas);
    expect(reg.get("f")).toBe(live);
    expect(reg.list()).toEqual([live]);
  });

  test("entries expire and are capped", () => {
    let t = 0;
    const reg = createStudioTestRegistry(base, { ttlMs: 1000, max: 2, now: () => t });
    const first = reg.register(canvas).model;
    t = 500;
    const second = reg.register(canvas).model;
    const third = reg.register(canvas).model;
    expect(reg.get(first)).toBeUndefined(); // evicted by the cap
    expect(reg.get(third)).toBe(canvas);
    t = 1600;
    expect(reg.get(second)).toBeUndefined(); // expired
  });

  test("an ephemeral definition resolves under its own id until disposed", () => {
    const reg = createStudioTestRegistry(base);
    const variant = { ...canvas, id: "f@variant/direct" };
    const dispose = reg.registerEphemeral(variant);
    expect(reg.get("f@variant/direct")).toBe(variant);
    expect(reg.get("f")).toBe(live);
    expect(reg.list()).toEqual([live]);
    dispose();
    expect(reg.get("f@variant/direct")).toBeUndefined();
  });

  test("routing runs the test id directly but keeps the flow's guardrail override", () => {
    const routing = resolveFlowRouting({
      requestModel: "f@studio-abc",
      requestCtx: { executionId: "x" } as never,
      flowDispatcher: { resolveFlow: () => "somewhere-else", reload: () => {} },
      flowGuardrailResolver: { resolve: (id: string) => (id === "f" ? ({ pii: true } as never) : undefined) } as never,
    });
    expect(routing.flowToRun).toBe("f@studio-abc");
    expect(routing.resolvedModel).toBe("f");
    expect(routing.runtimeGuardrailOverride).toEqual({ pii: true } as never);
  });
});
