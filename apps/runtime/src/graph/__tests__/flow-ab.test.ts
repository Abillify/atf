// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for A/B experiments (`src/graph/flow-ab.ts`) — pure selection/stats
 * plus the manager against a fake version resolver, and the versioned registry
 * overlay.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  hashFraction,
  pickVariantIndex,
  reportVariant,
  emptyVariantStats,
  createAbManager,
  versionedFlowId,
  type VersionResolver,
} from "../flow-ab.js";
import { createVersionedRegistry } from "../flow-registry-composite.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { FlowRegistry } from "../flow-parser.js";

describe("hashFraction / pickVariantIndex", () => {
  it("hashFraction is deterministic and in [0,1)", () => {
    const f = hashFraction("conv-1");
    expect(f).toBe(hashFraction("conv-1"));
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });

  it("picks by cumulative weight and is stable per key", () => {
    const idx = pickVariantIndex([1, 1], "user-x");
    expect(idx).toBe(pickVariantIndex([1, 1], "user-x"));
    expect([0, 1]).toContain(idx);
  });

  it("a zero-weight variant is never picked", () => {
    for (const key of ["a", "b", "c", "d", "e", "f"]) {
      expect(pickVariantIndex([1, 0], key)).toBe(0);
    }
  });

  it("roughly honours weights across many keys", () => {
    let zero = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      if (pickVariantIndex([9, 1], `k${i}`) === 0) zero++;
    }
    // ~90% to variant 0 (allow a generous band).
    expect(zero / N).toBeGreaterThan(0.8);
    expect(zero / N).toBeLessThan(0.97);
  });
});

describe("reportVariant", () => {
  it("computes error rate, mean latency and mean score", () => {
    const s = emptyVariantStats("A", 2);
    s.samples = 4;
    s.errors = 1;
    s.latencySumMs = 800;
    s.scoreSum = 3;
    s.scoreCount = 4;
    const r = reportVariant(s);
    expect(r.errorRate).toBe(0.25);
    expect(r.meanLatencyMs).toBe(200);
    expect(r.meanScore).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// Manager (no flows dir → empty policy) + resolver behaviour
// ---------------------------------------------------------------------------

const v2: FlowDefinition = {
  id: "flow",
  name: "v2",
  nodes: [{ id: "a", type: "llm" }],
  edges: [],
};

const resolver: VersionResolver = async (flow, version) =>
  flow === "flow" && (version === 1 || version === 2)
    ? { ...v2, name: `v${version}` }
    : undefined;

describe("AbManager (no experiments file)", () => {
  it("is disabled and selects nothing", async () => {
    const mgr = createAbManager("/nonexistent-dir", resolver);
    await mgr.reload();
    expect(mgr.enabled).toBe(false);
    expect(mgr.select("flow", "k1")).toBeUndefined();
    expect(mgr.status()).toEqual([]);
  });
});

describe("AbManager (with experiments.json)", () => {
  function tmpDirWith(policy: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiperator-ab-"));
    fs.writeFileSync(
      path.join(dir, "experiments.json"),
      JSON.stringify(policy),
    );
    return dir;
  }

  it("selects variants, caches versions, records and reports", async () => {
    const dir = tmpDirWith({
      experiments: [
        {
          flow: "flow",
          variants: [
            { label: "A", version: 1, weight: 1 },
            { label: "B", version: 2, weight: 1 },
          ],
        },
      ],
    });
    const mgr = createAbManager(dir, resolver);
    await mgr.reload();
    expect(mgr.enabled).toBe(true);

    // Versioned definitions are cached with rewritten ids.
    expect(mgr.resolveVersioned("flow@1")?.id).toBe("flow@1");
    expect(mgr.resolveVersioned("flow@2")?.name).toBe("v2");

    const sel = mgr.select("flow", "conv-42");
    expect(sel).toBeDefined();
    if (sel === undefined) throw new Error("expected a selection");
    expect(["A", "B"]).toContain(sel.variant);
    expect(sel.versionedId).toBe(`flow@${sel.version}`);
    // Deterministic per key.
    const sel2 = mgr.select("flow", "conv-42");
    if (sel2 === undefined) throw new Error("expected a selection");
    expect(sel2.variant).toBe(sel.variant);

    mgr.record("flow", sel.variant, {
      error: false,
      latencyMs: 100,
      score: 0.9,
    });
    const report = mgr.status();
    const reportEntry = report[0];
    if (reportEntry === undefined) throw new Error("expected a report entry");
    expect(reportEntry.flow).toBe("flow");
    const v = reportEntry.variants.find((x) => x.label === sel.variant);
    if (v === undefined) throw new Error("expected the selected variant in the report");
    expect(v.samples).toBe(1);
    expect(v.meanScore).toBe(0.9);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("disables an experiment that references an unknown version", async () => {
    const dir = tmpDirWith({
      experiments: [
        {
          flow: "flow",
          variants: [
            { label: "A", version: 1 },
            { label: "B", version: 99 }, // resolver returns undefined
          ],
        },
      ],
    });
    const mgr = createAbManager(dir, resolver);
    await mgr.reload();
    expect(mgr.select("flow", "k")).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("createVersionedRegistry", () => {
  it("resolves flow@version via the resolver, else delegates to base", () => {
    const base: FlowRegistry = {
      get: (id) => (id === "flow" ? v2 : undefined),
      list: () => [v2],
    };
    const pinned = new Map<string, FlowDefinition>([
      [versionedFlowId("flow", 1), { ...v2, id: "flow@1", name: "v1" }],
    ]);
    const reg = createVersionedRegistry(base, (id) => pinned.get(id));

    expect(reg.get("flow@1")?.name).toBe("v1");
    expect(reg.get("flow@1")?.id).toBe("flow@1");
    expect(reg.get("flow")?.name).toBe("v2"); // delegated
    expect(reg.get("unknown@9")).toBeUndefined(); // not cached → base miss
    expect(reg.list()).toHaveLength(1); // versioned ids not advertised
  });
});
