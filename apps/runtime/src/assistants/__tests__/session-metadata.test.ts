// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { normalizeSessionMetadata, safeSetSessionStatus } from "../session-metadata.js";
import type { AssistantSessionStore } from "../session-store.js";

describe("normalizeSessionMetadata", () => {
  test("trims and bounds title and normalizes tags", () => {
    const result = normalizeSessionMetadata({
      title: `  ${"A".repeat(150)}  `,
      tags: ["  Mahnwesen  ", "Vertrag#2026", "   ", "Alpha", "Beta", "Gamma", "Delta", "Epsilon"],
    });
    expect(result).toBeDefined();
    expect(result?.title.length).toBe(120);
    expect(result?.tags).toEqual(["mahnwesen", "vertrag2026", "alpha", "beta", "gamma", "delta"]);
  });

  test("returns undefined when raw title is empty", () => {
    const result = normalizeSessionMetadata({ title: "   ", tags: [] });
    expect(result).toBeUndefined();
  });
});

describe("safeSetSessionStatus", () => {
  test("swallows store errors and avoids throwing on best-effort updates", async () => {
    const failingStore = {
      setSessionStatus: async () => {
        throw new Error("db down");
      },
    } as unknown as AssistantSessionStore;

    await expect(
      safeSetSessionStatus(failingStore, {
        scope: { tenantId: "acme", userId: "alice", assistantId: "molty" },
        conversationId: "conv-1",
        status: "completed",
      }),
    ).resolves.toBeUndefined();
  });
});
