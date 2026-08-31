// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property tests for resolveAllowlist (src/graph/agent-harness.ts).
 *
 * Feature: agent-harness-node, Property 4: Selectable targets are the valid allowlist subset
 *
 * Validates: Requirements 2.3
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { resolveAllowlist } from "../agent-harness.js";
import type { FlowNode } from "../../types/flow.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a node ID string (short, readable). */
const arbNodeId: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "1", "2", "3", "-", "_"),
    minLength: 1,
    maxLength: 10,
  })
  .filter((s) => /^[a-z]/.test(s)); // ensure it starts with a letter

/** Create a minimal FlowNode stub for the node map. */
function makeFlowNode(id: string): FlowNode {
  return {
    id,
    type: "llm",
  } as FlowNode;
}

/**
 * Generate a test scenario: an allowlist and a node map where some entries
 * from the allowlist are present in the map and some are not.
 */
const arbScenario = fc
  .record({
    /** IDs that will be in the node map */
    mapIds: fc.uniqueArray(arbNodeId, { minLength: 0, maxLength: 10 }),
    /** IDs that will be in the allowlist (may overlap with mapIds or not) */
    allowlistIds: fc.uniqueArray(arbNodeId, { minLength: 0, maxLength: 10 }),
  })
  .map(({ mapIds, allowlistIds }) => {
    const nodeMap = new Map<string, FlowNode>();
    for (const id of mapIds) {
      nodeMap.set(id, makeFlowNode(id));
    }
    return { allowlist: allowlistIds, nodeMap };
  });

/**
 * Scenario that guarantees some overlap (valid entries) and some misses (dropped).
 */
const arbMixedScenario = fc
  .record({
    /** IDs present in both the allowlist and the map */
    presentIds: fc.uniqueArray(arbNodeId, { minLength: 1, maxLength: 5 }),
    /** IDs present only in the allowlist (NOT in the map) */
    absentIds: fc.uniqueArray(arbNodeId, { minLength: 1, maxLength: 5 }),
    /** Extra IDs in the map but not in the allowlist */
    extraMapIds: fc.uniqueArray(arbNodeId, { minLength: 0, maxLength: 5 }),
  })
  .filter(({ presentIds, absentIds, extraMapIds }) => {
    // Ensure no overlap between present and absent, and absent and extraMapIds
    const inMapSet = new Set([...presentIds, ...extraMapIds]);
    return absentIds.every((id) => !inMapSet.has(id));
  })
  .chain(({ presentIds, absentIds, extraMapIds }) => {
    // Shuffle the allowlist order
    const combined = [...presentIds, ...absentIds];
    return fc
      .shuffledSubarray(combined, {
        minLength: combined.length,
        maxLength: combined.length,
      })
      .map((shuffledAllowlist) => {
        const nodeMap = new Map<string, FlowNode>();
        for (const id of presentIds) {
          nodeMap.set(id, makeFlowNode(id));
        }
        for (const id of extraMapIds) {
          if (!nodeMap.has(id)) {
            nodeMap.set(id, makeFlowNode(id));
          }
        }
        return { allowlist: shuffledAllowlist, nodeMap, presentIds, absentIds };
      });
  });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 4: Selectable targets are the valid allowlist subset", () => {
  test("valid contains exactly the allowlist entries present in the node map", () => {
    fc.assert(
      fc.property(arbScenario, ({ allowlist, nodeMap }) => {
        const { valid } = resolveAllowlist(allowlist, nodeMap);

        const expected = allowlist.filter((id) => nodeMap.has(id));
        expect(valid).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  test("dropped contains exactly the allowlist entries NOT in the node map", () => {
    fc.assert(
      fc.property(arbScenario, ({ allowlist, nodeMap }) => {
        const { dropped } = resolveAllowlist(allowlist, nodeMap);

        const expected = allowlist.filter((id) => !nodeMap.has(id));
        expect(dropped).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  test("valid + dropped is a partition of allowlist (no overlap, covers all)", () => {
    fc.assert(
      fc.property(arbScenario, ({ allowlist, nodeMap }) => {
        const { valid, dropped } = resolveAllowlist(allowlist, nodeMap);

        // Union of valid and dropped must equal allowlist (same elements, same total count)
        expect(valid.length + dropped.length).toBe(allowlist.length);

        // No overlap between valid and dropped
        const validSet = new Set(valid);
        for (const d of dropped) {
          expect(validSet.has(d)).toBe(false);
        }

        // Every allowlist entry appears in exactly one of valid or dropped
        const allEntries = [...valid, ...dropped];
        // Since order is preserved, concatenating valid (in-order) and dropped (in-order)
        // won't necessarily equal allowlist directly, but each element is accounted for
        const allSet = new Set(allEntries);
        for (const entry of allowlist) {
          expect(allSet.has(entry)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("order is preserved from the original allowlist for both arrays", () => {
    fc.assert(
      fc.property(arbScenario, ({ allowlist, nodeMap }) => {
        const { valid, dropped } = resolveAllowlist(allowlist, nodeMap);

        // valid entries appear in the same relative order as in allowlist
        let validIdx = 0;
        let droppedIdx = 0;
        for (const entry of allowlist) {
          if (validIdx < valid.length && valid[validIdx] === entry) {
            validIdx++;
          } else if (
            droppedIdx < dropped.length &&
            dropped[droppedIdx] === entry
          ) {
            droppedIdx++;
          }
        }
        // All entries in both arrays were consumed in order
        expect(validIdx).toBe(valid.length);
        expect(droppedIdx).toBe(dropped.length);
      }),
      { numRuns: 200 },
    );
  });

  test("with mixed scenario: present IDs are valid, absent IDs are dropped", () => {
    fc.assert(
      fc.property(
        arbMixedScenario,
        ({ allowlist, nodeMap, presentIds, absentIds }) => {
          const { valid, dropped } = resolveAllowlist(allowlist, nodeMap);

          // All present IDs must appear in valid
          const validSet = new Set(valid);
          for (const id of presentIds) {
            expect(validSet.has(id)).toBe(true);
          }

          // All absent IDs must appear in dropped
          const droppedSet = new Set(dropped);
          for (const id of absentIds) {
            expect(droppedSet.has(id)).toBe(true);
          }

          // No absent ID in valid, no present ID in dropped
          for (const id of absentIds) {
            expect(validSet.has(id)).toBe(false);
          }
          for (const id of presentIds) {
            expect(droppedSet.has(id)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
