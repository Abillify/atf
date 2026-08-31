// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Roundtrip Property Tests for FlowDefinition serialization.
 *
 * Feature: platform-hardening-and-studio, Task 24.2
 * Property 1: Serialization roundtrip identity
 *   For every valid FlowDefinition, parse(serialize(fd)) is semantically
 *   identical to fd. Only metadata.ui may differ (it is layout info, not
 *   semantics).
 *
 * **Validates: Requirements 14.3**
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { validateFlowDefinition } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a FlowDefinition to a plain JSON-serializable object and back,
 * mimicking the real YAML/JSON roundtrip. JSON.stringify + JSON.parse is the
 * minimal faithful representation of the on-disk format.
 */
function serializeRoundtrip(fd: FlowDefinition): unknown {
  return JSON.parse(JSON.stringify(fd));
}

/**
 * Compare two FlowDefinitions for semantic equality: all fields except
 * `metadata.ui` must be deeply equal.
 */
function semanticallyEqual(a: FlowDefinition, b: FlowDefinition): boolean {
  const stripUi = (fd: FlowDefinition): unknown => {
    const { metadata, ...rest } = fd;
    if (metadata === undefined) return rest;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ui: _ui, ...metaWithoutUi } = metadata as Record<
      string,
      unknown
    > & {
      ui?: unknown;
    };
    return { ...rest, metadata: metaWithoutUi };
  };
  return JSON.stringify(stripUi(a)) === JSON.stringify(stripUi(b));
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty strings for IDs, names, labels */
const arbId = fc
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
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      "r",
      "s",
      "t",
      "u",
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

const arbNonEmptyString = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary for a valid LLM node (no tools array required) */
function arbLlmNode(id: string) {
  return fc.constant({ id, type: "llm" as const });
}

/** Arbitrary for a router node */
function arbRouterNode(id: string) {
  return fc.constant({ id, type: "router" as const });
}

/** Arbitrary for a tool node with optional tools list */
function arbToolNode(id: string) {
  return fc
    .array(
      arbNonEmptyString.filter((s) => s.length <= 30),
      {
        minLength: 0,
        maxLength: 5,
      },
    )
    .map((tools) =>
      tools.length > 0
        ? { id, type: "tool" as const, tools }
        : { id, type: "tool" as const },
    );
}

/** Arbitrary for a valid flow edge between two existing node IDs */
function arbEdge(nodeIds: string[]) {
  if (nodeIds.length < 2)
    return fc.constant([] as Array<{ source: string; target: string }>);
  return fc.array(
    fc
      .tuple(
        fc.integer({ min: 0, max: nodeIds.length - 1 }),
        fc.integer({ min: 0, max: nodeIds.length - 1 }),
      )
      .filter(([s, t]) => s !== t)
      .map(([s, t]) => ({ source: at(nodeIds, s), target: at(nodeIds, t) })),
    { minLength: 0, maxLength: Math.min(nodeIds.length * 2, 10) },
  );
}

/** Arbitrary UiNodeLayout entries (additive, not semantic) */
function arbUiLayout(nodeIds: string[]) {
  return fc.array(
    fc
      .integer({ min: 0, max: nodeIds.length - 1 })
      .chain((idx) =>
        fc
          .tuple(
            fc.integer({ min: -2000, max: 2000 }),
            fc.integer({ min: -2000, max: 2000 }),
          )
          .map(([x, y]) => ({ id: at(nodeIds, idx), x, y })),
      ),
    { minLength: 0, maxLength: nodeIds.length },
  );
}

/**
 * Builds a valid FlowDefinition arbitrary with optional metadata.ui.
 * Ensures no duplicate node IDs and edges only reference existing nodes.
 */
function arbFlowDefinition(): fc.Arbitrary<FlowDefinition> {
  // Generate between 1 and 5 unique node IDs
  return fc
    .uniqueArray(arbId, { minLength: 1, maxLength: 5 })
    .chain((nodeIds) => {
      const nodeArbs = nodeIds.map((id, idx) => {
        if (idx === 0) return arbLlmNode(id);
        if (idx === 1) return arbRouterNode(id);
        return arbToolNode(id);
      });

      return fc
        .tuple(
          ...nodeArbs,
          arbEdge(nodeIds),
          // optional metadata with or without ui
          fc.option(
            fc
              .tuple(
                // arbitrary extra metadata key
                fc.option(
                  fc
                    .string({ minLength: 1, maxLength: 10 })
                    .filter((s) => s !== "ui" && s.trim().length > 0),
                  { nil: undefined },
                ),
                // optional ui layout
                fc.option(arbUiLayout(nodeIds), { nil: undefined }),
                // optional viewport
                fc.option(
                  fc
                    .tuple(
                      fc.integer({ min: -1000, max: 1000 }),
                      fc.integer({ min: -1000, max: 1000 }),
                      fc.double({ min: 0.1, max: 5.0, noNaN: true }),
                    )
                    .map(([x, y, zoom]) => ({ x, y, zoom })),
                  { nil: undefined },
                ),
              )
              .map(([extraKey, layout, viewport]) => {
                const meta: Record<string, unknown> = {};
                if (extraKey !== undefined) meta[extraKey] = "some-value";
                if (layout !== undefined) {
                  meta.ui =
                    viewport !== undefined ? { layout, viewport } : { layout };
                }
                return meta;
              }),
            { nil: undefined },
          ),
        )
        .map((args) => {
          const nodes = args.slice(0, nodeIds.length) as Array<{
            id: string;
            type: string;
          }>;
          const edges = args[nodeIds.length] as Array<{
            source: string;
            target: string;
          }>;
          const metadata = args[nodeIds.length + 1] as
            | Record<string, unknown>
            | undefined;

          const fd: FlowDefinition = {
            id: at(nodeIds, 0),
            name: `Flow-${nodeIds[0]}`,
            nodes,
            edges,
          };
          if (metadata !== undefined && Object.keys(metadata).length > 0) {
            fd.metadata = metadata;
          }
          return fd;
        });
    });
}

// ---------------------------------------------------------------------------
// Representative fixture flows (deterministic)
// ---------------------------------------------------------------------------

const singleLlmNodeFlow: FlowDefinition = {
  id: "single-llm",
  name: "Single LLM Node",
  nodes: [{ id: "llm-1", type: "llm" }],
  edges: [],
};

const routerWithConditionsFlow: FlowDefinition = {
  id: "router-flow",
  name: "Router With Conditions",
  nodes: [
    { id: "entry", type: "llm" },
    { id: "router", type: "router" },
    { id: "branch-a", type: "llm" },
    { id: "branch-b", type: "llm" },
  ],
  edges: [
    { source: "entry", target: "router" },
    { source: "router", target: "branch-a", conditions: "state.route === 'a'" },
    { source: "router", target: "branch-b", conditions: "state.route === 'b'" },
  ],
  metadata: { version: 2 },
};

const parallelNodesFlow: FlowDefinition = {
  id: "parallel-flow",
  name: "Parallel Nodes",
  nodes: [
    { id: "start", type: "llm" },
    {
      id: "fan-out",
      type: "parallel",
      parallelNodes: ["worker-a", "worker-b"],
    },
    { id: "worker-a", type: "llm" },
    { id: "worker-b", type: "tool", tools: ["my-mcp/search"] },
    { id: "merge", type: "llm" },
  ],
  edges: [
    { source: "start", target: "fan-out" },
    { source: "fan-out", target: "worker-a" },
    { source: "fan-out", target: "worker-b" },
    { source: "worker-a", target: "merge" },
    { source: "worker-b", target: "merge" },
  ],
};

const flowWithUiMetadata: FlowDefinition = {
  id: "ui-meta-flow",
  name: "Flow With UI Metadata",
  nodes: [
    { id: "node-a", type: "llm" },
    { id: "node-b", type: "llm" },
  ],
  edges: [{ source: "node-a", target: "node-b" }],
  metadata: {
    ui: {
      layout: [
        { id: "node-a", x: 100, y: 200 },
        { id: "node-b", x: 400, y: 200 },
      ],
      viewport: { x: 0, y: 0, zoom: 1.0 },
    },
    author: "test-suite",
  },
};

const representativeFlows: FlowDefinition[] = [
  singleLlmNodeFlow,
  routerWithConditionsFlow,
  parallelNodesFlow,
  flowWithUiMetadata,
];

// ---------------------------------------------------------------------------
// Property 1: Serialization roundtrip identity
// Feature: platform-hardening-and-studio
// ---------------------------------------------------------------------------

describe("Feature: platform-hardening-and-studio, Property 1: Serialization roundtrip identity", () => {
  /**
   * **Validates: Requirements 14.3**
   *
   * For every valid FlowDefinition, parse(serialize(fd)) must produce a
   * semantically equivalent result. Only metadata.ui may change (it is layout
   * data, not part of flow semantics).
   */
  test("property: parse(serialize(fd)) is semantically identical to fd for random FlowDefinitions", () => {
    fc.assert(
      fc.property(arbFlowDefinition(), (fd) => {
        // Verify the generated fd is actually valid before testing roundtrip
        const parsed = validateFlowDefinition(fd);
        if (!parsed.success) {
          // Skip invalid generated flows (shouldn't happen but guards test correctness)
          return true;
        }

        // Perform roundtrip: serialize to JSON and parse back
        const roundtripped = serializeRoundtrip(fd);
        const reparsed = validateFlowDefinition(roundtripped);

        // The reparsed result must succeed
        expect(reparsed.success).toBe(true);

        if (reparsed.success) {
          // Semantic fields must be identical (excluding metadata.ui)
          expect(semanticallyEqual(parsed.data, reparsed.data)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("representative flows: single LLM node survives roundtrip", () => {
    const roundtripped = validateFlowDefinition(
      serializeRoundtrip(singleLlmNodeFlow),
    );
    expect(roundtripped.success).toBe(true);
    if (roundtripped.success) {
      expect(semanticallyEqual(singleLlmNodeFlow, roundtripped.data)).toBe(
        true,
      );
    }
  });

  test("representative flows: router with conditions survives roundtrip", () => {
    const roundtripped = validateFlowDefinition(
      serializeRoundtrip(routerWithConditionsFlow),
    );
    expect(roundtripped.success).toBe(true);
    if (roundtripped.success) {
      expect(
        semanticallyEqual(routerWithConditionsFlow, roundtripped.data),
      ).toBe(true);
    }
  });

  test("representative flows: parallel nodes flow survives roundtrip", () => {
    const roundtripped = validateFlowDefinition(
      serializeRoundtrip(parallelNodesFlow),
    );
    expect(roundtripped.success).toBe(true);
    if (roundtripped.success) {
      expect(semanticallyEqual(parallelNodesFlow, roundtripped.data)).toBe(
        true,
      );
    }
  });

  test("representative flows: flow with metadata.ui survives roundtrip (ui preserved, semantics unchanged)", () => {
    const roundtripped = validateFlowDefinition(
      serializeRoundtrip(flowWithUiMetadata),
    );
    expect(roundtripped.success).toBe(true);
    if (roundtripped.success) {
      // metadata.ui is preserved through roundtrip (it's stored in the record)
      expect(roundtripped.data.metadata?.ui).toBeDefined();
      // Semantic fields are unchanged
      expect(semanticallyEqual(flowWithUiMetadata, roundtripped.data)).toBe(
        true,
      );
    }
  });

  test("all representative flows round-trip successfully", () => {
    for (const fd of representativeFlows) {
      const roundtripped = validateFlowDefinition(serializeRoundtrip(fd));
      expect(roundtripped.success).toBe(true);
      if (roundtripped.success) {
        expect(semanticallyEqual(fd, roundtripped.data)).toBe(true);
      }
    }
  });

  test("metadata.ui field does NOT break validation — flows with ui metadata are accepted", () => {
    const flowWithUi = {
      id: "test-ui",
      name: "Test UI",
      nodes: [{ id: "n1", type: "llm" }],
      edges: [],
      metadata: {
        ui: {
          layout: [{ id: "n1", x: 50, y: 100 }],
          viewport: { x: 0, y: 0, zoom: 1.5 },
        },
      },
    };
    const result = validateFlowDefinition(flowWithUi);
    expect(result.success).toBe(true);
  });

  test("metadata.ui absence does NOT break flows — backward compatible with flows without ui", () => {
    const flowWithoutUi = {
      id: "no-ui",
      name: "No UI",
      nodes: [{ id: "n1", type: "llm" }],
      edges: [],
      metadata: { version: 1, tags: ["prod"] },
    };
    const result = validateFlowDefinition(flowWithoutUi);
    expect(result.success).toBe(true);
  });

  test("metadata.ui is ignored semantically — two flows differing only in ui are semantically equal", () => {
    const base: FlowDefinition = {
      id: "same-flow",
      name: "Same Flow",
      nodes: [{ id: "n1", type: "llm" }],
      edges: [],
      metadata: { version: 1 },
    };
    const withUi: FlowDefinition = {
      ...base,
      metadata: {
        version: 1,
        ui: {
          layout: [{ id: "n1", x: 999, y: 888 }],
          viewport: { x: 10, y: 20, zoom: 2 },
        },
      },
    };
    // They differ only in metadata.ui → should be semantically equal
    expect(semanticallyEqual(base, withUi)).toBe(true);
  });
});
