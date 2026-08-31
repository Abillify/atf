// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { buildAutoEvalDataset, extractKeyPhrases, snapshotToCase } from "../auto-eval.js";
import type { ExecutionSnapshot } from "../../graph/replay.js";

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`expected an element at index ${index}`);
  return value;
}
function snap(partial: Partial<ExecutionSnapshot> & { executionId: string }): ExecutionSnapshot {
  return {
    flowId: "flow-a",
    messages: [{ role: "user", content: "hello" }],
    responseText: "A vector database stores embeddings for similarity search.",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("extractKeyPhrases", () => {
  it("returns salient terms, excluding stopwords and short tokens", () => {
    const phrases = extractKeyPhrases("The vector database stores vector embeddings for fast vector search.", 3);
    expect(phrases[0]).toBe("vector");
    expect(phrases).not.toContain("the");
    expect(phrases).not.toContain("for");
  });
  it("is deterministic and bounded by n", () => {
    expect(extractKeyPhrases("alpha beta gamma delta epsilon zeta", 2)).toEqual(["alpha", "beta"]);
  });
  it("handles empty text", () => expect(extractKeyPhrases("", 3)).toEqual([]));
});

describe("snapshotToCase", () => {
  it("derives contains assertions from the baseline response", () => {
    const value = snapshotToCase(snap({ executionId: "e1" }), { keyPhrases: 2 });
    if (value === undefined) throw new Error("expected a derived case");
    expect(value.id).toBe("auto-e1");
    expect(value.flow).toBe("flow-a");
    expect(value.assert?.filter((assertion) => assertion.type === "contains")).toHaveLength(2);
    expect(value.metadata?.source).toBe("production-snapshot");
    expect(value.metadata?.baselineResponse).toContain("vector");
  });
  it("attaches an llmJudge assertion when criteria is given", () => {
    const value = snapshotToCase(snap({ executionId: "e2" }), {
      keyPhrases: 0,
      judgeCriteria: "Answer is correct and concise.",
      judgeThreshold: 0.8,
    });
    if (value === undefined) throw new Error("expected a derived case");
    const judge = value.assert?.find((assertion) => assertion.type === "llmJudge");
    expect(judge).toBeDefined();
    expect(judge?.type === "llmJudge" ? judge.threshold : undefined).toBe(0.8);
  });
  it("skips snapshots with an empty/too-short response", () => {
    expect(snapshotToCase(snap({ executionId: "e3", responseText: "  " }))).toBeUndefined();
    expect(snapshotToCase(snap({ executionId: "e4", responseText: "hi" }), { minResponseChars: 10 })).toBeUndefined();
  });
  it("skips snapshots with no input messages", () => {
    expect(snapshotToCase(snap({ executionId: "e5", messages: [] }))).toBeUndefined();
  });
  it("returns undefined when no assertion can be derived", () => {
    expect(snapshotToCase(snap({ executionId: "e6" }), { keyPhrases: 0 })).toBeUndefined();
  });
});

describe("buildAutoEvalDataset", () => {
  it("builds a dataset from many snapshots, newest first", () => {
    const dataset = buildAutoEvalDataset([
      snap({ executionId: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
      snap({ executionId: "new", createdAt: "2026-02-01T00:00:00.000Z", messages: [{ role: "user", content: "different" }] }),
    ]);
    expect(at(dataset.cases, 0).id).toBe("auto-new");
    expect(dataset.cases).toHaveLength(2);
  });
  it("de-duplicates identical inputs, keeping the newest", () => {
    const dataset = buildAutoEvalDataset([
      snap({ executionId: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
      snap({ executionId: "b", createdAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(dataset.cases).toHaveLength(1);
    expect(at(dataset.cases, 0).id).toBe("auto-b");
  });
  it("respects the flow filter and maxCases cap", () => {
    const snapshots = [
      snap({ executionId: "x", flowId: "flow-a", messages: [{ role: "user", content: "q1" }] }),
      snap({ executionId: "y", flowId: "flow-b", messages: [{ role: "user", content: "q2" }] }),
      snap({ executionId: "z", flowId: "flow-a", messages: [{ role: "user", content: "q3" }] }),
    ];
    const onlyA = buildAutoEvalDataset(snapshots, { flows: ["flow-a"] });
    expect(onlyA.cases.every((value) => value.flow === "flow-a")).toBe(true);
    expect(onlyA.cases).toHaveLength(2);
    expect(buildAutoEvalDataset(snapshots, { maxCases: 1 }).cases).toHaveLength(1);
  });
  it("uses a custom dataset name", () => {
    expect(buildAutoEvalDataset([snap({ executionId: "a" })], { name: "nightly" }).name).toBe("nightly");
  });
});

describe("buildAutoEvalDataset edge cases", () => {
  it("does not let an unsuitable newer snapshot hide a usable older duplicate", () => {
    const dataset = buildAutoEvalDataset([
      snap({ executionId: "usable", createdAt: "2026-01-01T00:00:00.000Z" }),
      snap({ executionId: "empty", responseText: "", createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(dataset.cases.map((value) => value.id)).toEqual(["auto-usable"]);
  });

  it("honors a zero maxCases cap", () => {
    expect(buildAutoEvalDataset([snap({ executionId: "a" })], { maxCases: 0 }).cases).toHaveLength(0);
  });
});
