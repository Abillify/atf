// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the human-in-the-loop approval gate.
 */

import { describe, test, expect } from "bun:test";
import {
  toolRequiresApproval,
  nodeApprovalList,
  createApprovalGate,
  sideEffectFreeApprovalGate,
  type ApprovalGateConfig,
} from "../approval-gate.js";

/** `createApprovalGate` for a config known to enable the gate. */
function mustCreateApprovalGate(config: ApprovalGateConfig) {
  const gate = createApprovalGate(config);
  if (gate === undefined) throw new Error("expected the approval gate to be enabled");
  return gate;
}

describe("toolRequiresApproval", () => {
  test("no patterns → never requires approval", () => {
    expect(toolRequiresApproval("mcp/x", undefined, undefined)).toBe(false);
    expect(toolRequiresApproval("mcp/x", [], [])).toBe(false);
  });

  test("exact full-ref match", () => {
    expect(
      toolRequiresApproval(
        "demo-mcp/case_lookup",
        ["demo-mcp/case_lookup"],
        undefined,
      ),
    ).toBe(true);
  });

  test("bare-name match", () => {
    expect(
      toolRequiresApproval("demo-mcp/calendar_delete", undefined, [
        "calendar_delete",
      ]),
    ).toBe(true);
  });

  test("server wildcard match", () => {
    expect(
      toolRequiresApproval("demo-mcp/anything", undefined, [
        "demo-mcp/*",
      ]),
    ).toBe(true);
    expect(
      toolRequiresApproval("other-mcp/anything", undefined, ["demo-mcp/*"]),
    ).toBe(false);
  });

  test("global wildcard matches everything", () => {
    expect(toolRequiresApproval("any/tool", undefined, ["*"])).toBe(true);
  });

  test("node and global lists are combined", () => {
    expect(toolRequiresApproval("a/b", ["a/b"], ["c/d"])).toBe(true);
    expect(toolRequiresApproval("c/d", ["a/b"], ["c/d"])).toBe(true);
    expect(toolRequiresApproval("e/f", ["a/b"], ["c/d"])).toBe(false);
  });
});

describe("nodeApprovalList", () => {
  test("reads config.requiresApproval string array", () => {
    expect(nodeApprovalList({ requiresApproval: ["x", "y"] })).toEqual([
      "x",
      "y",
    ]);
  });
  test("undefined when missing or wrong type", () => {
    expect(nodeApprovalList(undefined)).toBeUndefined();
    expect(nodeApprovalList({})).toBeUndefined();
    expect(nodeApprovalList({ requiresApproval: "x" })).toBeUndefined();
    expect(nodeApprovalList({ requiresApproval: [] })).toBeUndefined();
  });
});

describe("createApprovalGate", () => {
  test("undefined when disabled and no global tools", () => {
    expect(createApprovalGate({})).toBeUndefined();
    expect(createApprovalGate({ enabled: false })).toBeUndefined();
  });

  test("enabled when a global tool list is present even without enabled flag", () => {
    const gate = createApprovalGate({ requireApprovalTools: ["a/b"] });
    expect(gate).toBeDefined();
    if (gate === undefined) throw new Error("expected the gate to be enabled");
    expect(gate.requires("a/b", undefined)).toBe(true);
  });

  test("request resolves when approved via resolve()", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    let pendingId = "";
    const decisionPromise = gate.request(
      { executionId: "e1", nodeId: "n1", tool: "a/b", args: {} },
      (p) => {
        pendingId = p.id;
      },
    );
    expect(pendingId).not.toBe("");
    expect(gate.listPending()).toHaveLength(1);

    const ok = gate.resolve(pendingId, { approved: true, by: "alice" });
    expect(ok).toBe(true);

    const decision = await decisionPromise;
    expect(decision.approved).toBe(true);
    expect(decision.by).toBe("alice");
    expect(gate.listPending()).toHaveLength(0);
  });

  test("request resolves when denied", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    let pendingId = "";
    const p = gate.request(
      { executionId: "e", nodeId: "n", tool: "a/b", args: {} },
      (pp) => (pendingId = pp.id),
    );
    gate.resolve(pendingId, { approved: false, reason: "not allowed" });
    const d = await p;
    expect(d.approved).toBe(false);
    expect(d.reason).toBe("not allowed");
  });

  test("auto-denies on timeout (fail-closed)", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 20 });
    const d = await gate.request({
      executionId: "e",
      nodeId: "n",
      tool: "a/b",
      args: {},
    });
    expect(d.approved).toBe(false);
    expect(d.timedOut).toBe(true);
  });

  test("a per-request timeoutMs override fires BEFORE the registry's longer global timeout", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const start = Date.now();
    const d = await gate.request({
      executionId: "e",
      nodeId: "n",
      tool: "a/b",
      args: {},
      timeoutMs: 20, // ADR-0009: e.g. from a compliance-policy.yaml approvalRules[].timeoutMs
    });
    const elapsedMs = Date.now() - start;
    expect(d.approved).toBe(false);
    expect(d.timedOut).toBe(true);
    expect(d.reason).toContain("20ms");
    expect(elapsedMs).toBeLessThan(1000); // nowhere near the 5000ms global timeout
  });

  test("a per-request timeoutMs override can also be LONGER than the global default", async () => {
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 20 });
    let pendingId = "";
    const decisionPromise = gate.request(
      {
        executionId: "e",
        nodeId: "n",
        tool: "a/b",
        args: {},
        timeoutMs: 5000,
      },
      (p) => {
        pendingId = p.id;
      },
    );
    // Give the (short) global timeout a chance to fire — it must NOT, since
    // this request declared its own longer timeout.
    await new Promise((r) => setTimeout(r, 60));
    expect(gate.listPending()).toHaveLength(1);
    gate.resolve(pendingId, { approved: true, by: "alice" });
    const decision = await decisionPromise;
    expect(decision.approved).toBe(true);
  });

  test("resolve() returns false for an unknown id", () => {
    const gate = mustCreateApprovalGate({ enabled: true });
    expect(gate.resolve("nope", { approved: true })).toBe(false);
  });
});

describe("sideEffectFreeApprovalGate", () => {
  test("denies at once without registering a pending approval or notifying", async () => {
    const gate = mustCreateApprovalGate({ requireApprovalTools: ["a/b"], timeoutMs: 5000 });
    const shadow = sideEffectFreeApprovalGate(gate);
    expect(shadow.requires("a/b", undefined)).toBe(true);
    expect(shadow.enabled).toBe(true);

    let notified = false;
    const decision = await shadow.request(
      { executionId: "e1", nodeId: "n1", tool: "a/b", args: {} },
      () => {
        notified = true;
      },
    );
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/suppressed/);
    expect(notified).toBe(false);
    expect(await gate.listPending()).toHaveLength(0);
  });
});
