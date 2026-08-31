// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property-Based Tests for agent-harness node schema validation.
 *
 * Feature: agent-harness-node, Property 1: Valid harness configs parse
 * Feature: agent-harness-node, Property 2: Malformed harness configs are rejected
 * Feature: agent-harness-node, Property 3: Allowlist read fidelity
 *
 * Validates: Requirements 1.1, 1.2, 1.5, 2.1, 2.2
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { FlowNodeSchema, HarnessConfigSchema } from "../flow-parser.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty alphanumeric/dash/underscore ID strings */
const arbNodeId = fc
  .string({
    unit: fc.constantFrom(
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "1",
      "2",
      "3",
      "-",
      "_",
    ),
    minLength: 1,
    maxLength: 20,
  })
  .filter((s) => /^[a-z]/.test(s));

/** Non-empty string (min 1 char, no empty strings) */
const arbNonEmptyString = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary for a valid allowlist (non-empty array of non-empty strings) */
const arbAllowlist = fc.uniqueArray(arbNonEmptyString, {
  minLength: 1,
  maxLength: 10,
});

/** Arbitrary positive integer for limits */
const arbPositiveInt = fc.integer({ min: 1, max: 1000 });

/** Arbitrary positive number (for maxCost) */
const arbPositiveNumber = fc.double({ min: 0.01, max: 100000, noNaN: true });

/** Arbitrary positive integer for time (ms) */
const arbPositiveTimeMs = fc.integer({ min: 1, max: 86400000 });

/**
 * Generate a valid HarnessConfig object with random optional fields.
 */
function arbValidHarnessConfig() {
  return fc.record({
    allowlist: arbAllowlist,
    maxIterations: fc.option(arbPositiveInt, { nil: undefined }),
    maxCost: fc.option(arbPositiveNumber, { nil: undefined }),
    maxTimeMs: fc.option(arbPositiveTimeMs, { nil: undefined }),
    consequentialTargets: fc.option(
      fc.array(arbNonEmptyString, { minLength: 0, maxLength: 5 }),
      { nil: undefined },
    ),
  });
}

/**
 * Generate a complete valid FlowNode object with type "agent-harness".
 */
function arbValidHarnessNode() {
  return fc.tuple(arbNodeId, arbValidHarnessConfig()).map(([id, config]) => ({
    id,
    type: "agent-harness" as const,
    config,
  }));
}

/**
 * Generate malformed harness configs that should be rejected by the schema.
 */
function arbMalformedHarnessConfig(): fc.Arbitrary<unknown> {
  return fc.oneof(
    // Missing allowlist entirely
    fc.constant({}),
    // Empty allowlist
    fc.constant({ allowlist: [] }),
    // Allowlist with an empty string entry
    fc.constant({ allowlist: ["valid-node", ""] }),
    // allowlist is not an array
    fc.constant({ allowlist: "not-an-array" }),
    // allowlist is a number
    fc.constant({ allowlist: 42 }),
    // maxIterations is zero (not positive)
    arbAllowlist.map((al) => ({ allowlist: al, maxIterations: 0 })),
    // maxIterations is negative
    arbAllowlist.map((al) => ({ allowlist: al, maxIterations: -5 })),
    // maxIterations is a float (not int)
    arbAllowlist.map((al) => ({ allowlist: al, maxIterations: 3.7 })),
    // maxIterations exceeds 1000
    arbAllowlist.map((al) => ({ allowlist: al, maxIterations: 1001 })),
    // maxCost is zero
    arbAllowlist.map((al) => ({ allowlist: al, maxCost: 0 })),
    // maxCost is negative
    arbAllowlist.map((al) => ({ allowlist: al, maxCost: -10 })),
    // maxTimeMs is zero
    arbAllowlist.map((al) => ({ allowlist: al, maxTimeMs: 0 })),
    // maxTimeMs is negative
    arbAllowlist.map((al) => ({ allowlist: al, maxTimeMs: -1000 })),
    // maxTimeMs is a float
    arbAllowlist.map((al) => ({ allowlist: al, maxTimeMs: 1.5 })),
    // consequentialTargets contains an empty string
    arbAllowlist.map((al) => ({
      allowlist: al,
      consequentialTargets: ["valid", ""],
    })),
  );
}

// ---------------------------------------------------------------------------
// Property 1: Valid harness configs parse
// Feature: agent-harness-node, Property 1: Valid harness configs parse
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 1: Valid harness configs parse", () => {
  /**
   * **Validates: Requirements 1.1, 1.5**
   */
  test("HarnessConfigSchema accepts any well-formed config (non-empty allowlist, positive limits)", () => {
    fc.assert(
      fc.property(arbValidHarnessConfig(), (config) => {
        const result = HarnessConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  test("FlowNodeSchema accepts a node with type 'agent-harness' and valid config", () => {
    fc.assert(
      fc.property(arbValidHarnessNode(), (node) => {
        const result = FlowNodeSchema.safeParse(node);
        expect(result.success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  test("FlowNodeSchema accepts harness node with all optional config fields present", () => {
    fc.assert(
      fc.property(
        arbNodeId,
        arbAllowlist,
        arbPositiveInt,
        arbPositiveNumber,
        arbPositiveTimeMs,
        fc.array(arbNonEmptyString, { minLength: 0, maxLength: 3 }),
        (
          id,
          allowlist,
          maxIterations,
          maxCost,
          maxTimeMs,
          consequentialTargets,
        ) => {
          const node = {
            id,
            type: "agent-harness" as const,
            config: {
              allowlist,
              maxIterations,
              maxCost,
              maxTimeMs,
              consequentialTargets,
            },
          };
          const result = FlowNodeSchema.safeParse(node);
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("FlowNodeSchema accepts harness node with only the required allowlist", () => {
    fc.assert(
      fc.property(arbNodeId, arbAllowlist, (id, allowlist) => {
        const node = {
          id,
          type: "agent-harness" as const,
          config: { allowlist },
        };
        const result = FlowNodeSchema.safeParse(node);
        expect(result.success).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Malformed harness configs are rejected
// Feature: agent-harness-node, Property 2: Malformed harness configs are rejected
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 2: Malformed harness configs are rejected", () => {
  /**
   * **Validates: Requirements 1.2, 2.2**
   */
  test("HarnessConfigSchema rejects configs with missing/empty allowlist or malformed fields", () => {
    fc.assert(
      fc.property(arbMalformedHarnessConfig(), (config) => {
        const result = HarnessConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  test("FlowNodeSchema rejects agent-harness node with malformed config", () => {
    fc.assert(
      fc.property(arbNodeId, arbMalformedHarnessConfig(), (id, config) => {
        const node = {
          id,
          type: "agent-harness" as const,
          config,
        };
        const result = FlowNodeSchema.safeParse(node);
        expect(result.success).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  test("FlowNodeSchema rejects agent-harness node with no config at all", () => {
    fc.assert(
      fc.property(arbNodeId, (id) => {
        const node = {
          id,
          type: "agent-harness" as const,
          // no config field → defaults to {} → allowlist missing → rejected
        };
        const result = FlowNodeSchema.safeParse(node);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("FlowNodeSchema rejects harness node when maxIterations is not a positive integer", () => {
    fc.assert(
      fc.property(
        arbNodeId,
        arbAllowlist,
        fc.oneof(
          fc.constant(0),
          fc.integer({ min: -1000, max: -1 }),
          fc.constant(1001),
          fc
            .double({ min: 0.1, max: 999.9, noNaN: true })
            .filter((n) => !Number.isInteger(n) && n > 0),
        ),
        (id, allowlist, badIter) => {
          const node = {
            id,
            type: "agent-harness" as const,
            config: { allowlist, maxIterations: badIter },
          };
          const result = FlowNodeSchema.safeParse(node);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Allowlist read fidelity
// Feature: agent-harness-node, Property 3: Allowlist read fidelity
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 3: Allowlist read fidelity", () => {
  /**
   * **Validates: Requirements 2.1**
   */
  test("parsed config preserves the allowlist exactly as declared", () => {
    fc.assert(
      fc.property(arbValidHarnessConfig(), (config) => {
        const result = HarnessConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.allowlist).toEqual(config.allowlist);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("FlowNodeSchema-parsed harness node preserves the allowlist in config", () => {
    fc.assert(
      fc.property(arbValidHarnessNode(), (node) => {
        const result = FlowNodeSchema.safeParse(node);
        expect(result.success).toBe(true);
        if (result.success) {
          // The config record passes through; verify allowlist is preserved
          const parsedConfig = HarnessConfigSchema.safeParse(
            result.data.config ?? {},
          );
          expect(parsedConfig.success).toBe(true);
          if (parsedConfig.success) {
            expect(parsedConfig.data.allowlist).toEqual(node.config.allowlist);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  test("allowlist order is preserved through parsing", () => {
    fc.assert(
      fc.property(arbAllowlist, (allowlist) => {
        const config = { allowlist };
        const result = HarnessConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
          // Same length
          expect(result.data.allowlist.length).toBe(allowlist.length);
          // Same order
          for (let i = 0; i < allowlist.length; i++) {
            expect(result.data.allowlist[i]).toBe(allowlist[i]);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  test("optional numeric limits are preserved exactly when present", () => {
    fc.assert(
      fc.property(arbValidHarnessConfig(), (config) => {
        const result = HarnessConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
          if (config.maxIterations !== undefined) {
            expect(result.data.maxIterations).toBe(config.maxIterations);
          }
          if (config.maxCost !== undefined) {
            expect(result.data.maxCost).toBe(config.maxCost);
          }
          if (config.maxTimeMs !== undefined) {
            expect(result.data.maxTimeMs).toBe(config.maxTimeMs);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example test: type-union fixture compiles with an `agent-harness` node
// ---------------------------------------------------------------------------

describe("Example: agent-harness type-union fixture", () => {
  /**
   * **Validates: Requirements 1.5**
   *
   * Verifies that a FlowNode with type: "agent-harness" is accepted by
   * FlowNodeSchema, confirming the type union includes it.
   */
  test("a FlowNode with type 'agent-harness' validates through FlowNodeSchema", () => {
    const node = {
      id: "harness-1",
      type: "agent-harness" as const,
      label: "My Harness",
      config: {
        allowlist: ["worker-a", "worker-b"],
        maxIterations: 10,
        maxCost: 5.0,
        maxTimeMs: 30000,
        consequentialTargets: ["worker-b"],
      },
    };

    const result = FlowNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("harness-1");
      expect(result.data.type).toBe("agent-harness");
      expect(result.data.label).toBe("My Harness");
    }
  });

  test("FlowNodeSchema accepts agent-harness alongside other node types in the type enum", () => {
    const nodeTypes = [
      "llm",
      "tool",
      "router",
      "classifier",
      "parallel",
      "retrieval",
      "memory",
      "agent-harness",
    ] as const;

    for (const nodeType of nodeTypes) {
      const node: Record<string, unknown> = {
        id: `node-${nodeType}`,
        type: nodeType,
      };
      // agent-harness requires config; others don't
      if (nodeType === "agent-harness") {
        node.config = { allowlist: ["target-1"] };
      }
      const result = FlowNodeSchema.safeParse(node);
      expect(result.success).toBe(true);
    }
  });
});
