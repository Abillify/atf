// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-flow crash-recovery resolution.
 *
 * The property that matters here is the ASYMMETRY: a flow may narrow recovery
 * but never widen it. A flow author cannot grant themselves retries the operator
 * has not allowed, and cannot enable recovery in a deployment that has it off.
 * Everything else in this module is a consequence of that rule.
 */

import { describe, expect, test } from "bun:test";
import {
  partitionFlowsByRecoveryDeclaration,
  resolveFlowRecovery,
  type GlobalJobRecovery,
} from "../flow-recovery.js";
import type { FlowDefinition } from "../../types/flow.js";

const GLOBAL: GlobalJobRecovery = { maxAttempts: 3, leaseMs: 300_000 };

/** Minimal flow shape the resolver actually reads. */
const flow = (recovery?: FlowDefinition["recovery"]): Pick<FlowDefinition, "recovery"> =>
  recovery === undefined ? {} : { recovery };

describe("recovery disabled for the deployment", () => {
  test("a flow cannot opt itself in", () => {
    // The operator's switch is the ceiling. A flow declaring retry: true in a
    // deployment with recovery off must not get a retryable job.
    expect(resolveFlowRecovery(undefined, flow({ retry: true }))).toBeUndefined();
  });

  test("an opted-out flow stays off", () => {
    expect(resolveFlowRecovery(undefined, flow({ retry: false }))).toBeUndefined();
  });

  test("an undeclared flow stays off", () => {
    expect(resolveFlowRecovery(undefined, flow())).toBeUndefined();
  });
});

describe("recovery enabled for the deployment", () => {
  test("an undeclared flow fails closed", () => {
    expect(resolveFlowRecovery(GLOBAL, flow())).toBeUndefined();
  });

  test("a missing flow fails closed", () => {
    expect(resolveFlowRecovery(GLOBAL, undefined)).toBeUndefined();
  });

  test("retry: true takes the global settings", () => {
    expect(resolveFlowRecovery(GLOBAL, flow({ retry: true }))).toEqual(GLOBAL);
  });

  /**
   * The carve-out this whole module exists for: a flow whose tools write to a
   * foreign system must be able to refuse a from-scratch re-run even though the
   * deployment allows one.
   */
  test("retry: false overrides the global switch", () => {
    expect(resolveFlowRecovery(GLOBAL, flow({ retry: false }))).toBeUndefined();
  });
});

describe("per-flow attempt cap", () => {
  test("a lower cap is honoured", () => {
    expect(resolveFlowRecovery(GLOBAL, flow({ retry: true, maxAttempts: 2 }))).toEqual({
      maxAttempts: 2,
      leaseMs: 300_000,
    });
  });

  test("a higher cap is clamped to the global ceiling", () => {
    // A flow must not be able to ask for more retries than the operator allows.
    expect(resolveFlowRecovery(GLOBAL, flow({ retry: true, maxAttempts: 9 }))).toEqual({
      maxAttempts: 3,
      leaseMs: 300_000,
    });
  });

  test("a cap equal to the ceiling passes through", () => {
    expect(resolveFlowRecovery(GLOBAL, flow({ retry: true, maxAttempts: 3 }))).toEqual({
      maxAttempts: 3,
      leaseMs: 300_000,
    });
  });

  test("never resolves below one attempt", () => {
    expect(
      resolveFlowRecovery(
        { maxAttempts: 1, leaseMs: 1_000 },
        flow({ retry: true, maxAttempts: 1 }),
      ),
    ).toEqual({ maxAttempts: 1, leaseMs: 1_000 });
  });

  test("the lease always comes from the deployment, never from the flow", () => {
    const resolved = resolveFlowRecovery(
      { maxAttempts: 3, leaseMs: 42_000 },
      flow({ retry: true, maxAttempts: 2 }),
    );
    expect(resolved?.leaseMs).toBe(42_000);
  });
});

describe("partitionFlowsByRecoveryDeclaration", () => {
  test("separates declared from undeclared flows", () => {
    const result = partitionFlowsByRecoveryDeclaration([
      { id: "reader", recovery: { retry: true } },
      { id: "writer", recovery: { retry: false } },
      { id: "legacy" },
    ]);
    expect(result.declared).toEqual(["reader", "writer"]);
    expect(result.undeclared).toEqual(["legacy"]);
  });

  test("counts an explicit opt-out as declared", () => {
    // retry: false IS a decision — it must not show up as a missing declaration.
    const result = partitionFlowsByRecoveryDeclaration([{ id: "a", recovery: { retry: false } }]);
    expect(result.declared).toEqual(["a"]);
    expect(result.undeclared).toEqual([]);
  });

  test("sorts both lists so gate output is stable across runs", () => {
    const result = partitionFlowsByRecoveryDeclaration([
      { id: "zeta" },
      { id: "alpha" },
      { id: "mid", recovery: { retry: true } },
    ]);
    expect(result.undeclared).toEqual(["alpha", "zeta"]);
  });

  test("handles an empty set", () => {
    expect(partitionFlowsByRecoveryDeclaration([])).toEqual({
      declared: [],
      undeclared: [],
    });
  });
});
