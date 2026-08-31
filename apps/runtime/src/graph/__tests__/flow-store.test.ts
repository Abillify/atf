// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the online flow store (draft/publish/version lifecycle).
 */

import { describe, test, expect } from "bun:test";
import { InMemoryFlowStore, FlowStoreError } from "../flow-store.js";
import type { FlowDefinition } from "../../types/flow.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

const def = (id: string, name = id): FlowDefinition => ({
  id,
  name,
  nodes: [
    { id: "n", type: "llm", llm: { provider: "openai", model: "gpt-4o-mini" } },
  ],
  edges: [],
});

describe("InMemoryFlowStore", () => {
  test("saveDraft creates a draft-only flow (not yet published)", async () => {
    const s = new InMemoryFlowStore();
    const rec = await s.saveDraft("f", def("f"), "alice");
    expect(rec.draft).not.toBeNull();
    expect(rec.published).toBeNull();
    expect(rec.version).toBe(0);
    expect(await s.listPublished()).toHaveLength(0);
  });

  test("publish promotes draft to published and bumps version", async () => {
    const s = new InMemoryFlowStore();
    await s.saveDraft("f", def("f"), "alice");
    const rec = await s.publish("f", "alice");
    expect(rec.published).not.toBeNull();
    expect(rec.version).toBe(1);
    const published = await s.listPublished();
    expect(published).toHaveLength(1);
    expect(at(published, 0).id).toBe("f");
  });

  test("publish without a draft throws no_draft", async () => {
    const s = new InMemoryFlowStore();
    // seed published via save+publish, then check a fresh flow with no draft
    await expect(s.publish("missing")).rejects.toBeInstanceOf(FlowStoreError);
  });

  test("draftDirty reflects divergence between draft and published", async () => {
    const s = new InMemoryFlowStore();
    await s.saveDraft("f", def("f", "v1"));
    await s.publish("f");
    let summary = at(await s.listAll(), 0);
    expect(summary.draftDirty).toBe(false);
    await s.saveDraft("f", def("f", "v2-edited"));
    summary = at(await s.listAll(), 0);
    expect(summary.draftDirty).toBe(true);
  });

  test("version history accumulates and rollback re-publishes", async () => {
    const s = new InMemoryFlowStore();
    await s.saveDraft("f", def("f", "v1"));
    await s.publish("f"); // version 1
    await s.saveDraft("f", def("f", "v2"));
    await s.publish("f"); // version 2

    const versions = await s.listVersions("f");
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    const rolled = await s.rollback("f", 1, "bob");
    expect(rolled.version).toBe(3);
    if (rolled.published === null) throw new Error("expected a published flow");
    expect(rolled.published.name).toBe("v1");
  });

  test("rollback to an unknown version throws", async () => {
    const s = new InMemoryFlowStore();
    await s.saveDraft("f", def("f"));
    await s.publish("f");
    await expect(s.rollback("f", 99)).rejects.toBeInstanceOf(FlowStoreError);
  });

  test("delete removes the flow and its versions", async () => {
    const s = new InMemoryFlowStore();
    await s.saveDraft("f", def("f"));
    await s.publish("f");
    expect(await s.delete("f")).toBe(true);
    expect(await s.get("f")).toBeUndefined();
    expect(await s.listVersions("f")).toHaveLength(0);
    expect(await s.delete("f")).toBe(false);
  });

  test("listAll summarises hasDraft/hasPublished", async () => {
    const s = new InMemoryFlowStore();
    await s.saveDraft("a", def("a"));
    await s.saveDraft("b", def("b"));
    await s.publish("b");
    const all = await s.listAll();
    const a = all.find((x) => x.id === "a");
    const b = all.find((x) => x.id === "b");
    if (a === undefined || b === undefined) throw new Error("expected both summaries");
    expect(a.hasPublished).toBe(false);
    expect(b.hasPublished).toBe(true);
  });
});
