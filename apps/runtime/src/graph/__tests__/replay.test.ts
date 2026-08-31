// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for time-travel replay.
 */

import { describe, test, expect } from "bun:test";
import {
  InMemoryReplayStore,
  textSimilarity,
  createReplayService,
  ReplayNotFoundError,
  type ReplayExecutor,
  type ExecutionSnapshot,
} from "../replay.js";
import type { ChatMessage } from "../../types/openai.js";

const snap = (over: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot => ({
  executionId: "exec-1",
  flowId: "helpdesk",
  messages: [{ role: "user", content: "Wie ist der Stand bei Akte A-123?" }],
  responseText: "Die Akte A-123 ist offen, Betrag 500 Euro.",
  createdAt: new Date().toISOString(),
  ...over,
});

describe("textSimilarity", () => {
  test("identical text → 1", () => {
    expect(textSimilarity("hello world", "hello world")).toBe(1);
  });
  test("disjoint text → 0", () => {
    expect(textSimilarity("alpha beta", "gamma delta")).toBe(0);
  });
  test("partial overlap is between 0 and 1", () => {
    const s = textSimilarity("the quick brown fox", "the slow brown dog");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
  test("two empty strings → 1", () => {
    expect(textSimilarity("", "")).toBe(1);
  });
});

describe("InMemoryReplayStore", () => {
  test("save and get round-trip", async () => {
    const store = new InMemoryReplayStore();
    await store.save(snap());
    const got = await store.get("exec-1");
    expect(got?.flowId).toBe("helpdesk");
  });

  test("evicts oldest beyond bound", async () => {
    const store = new InMemoryReplayStore(2);
    await store.save(snap({ executionId: "a" }));
    await store.save(snap({ executionId: "b" }));
    await store.save(snap({ executionId: "c" }));
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("c")).toBeDefined();
  });

  test("list returns newest-first, bounded by limit", async () => {
    const store = new InMemoryReplayStore();
    await store.save(snap({ executionId: "a" }));
    await store.save(snap({ executionId: "b" }));
    await store.save(snap({ executionId: "c" }));
    const all = await store.list();
    expect(all.map((s) => s.executionId)).toEqual(["c", "b", "a"]);
    const limited = await store.list(2);
    expect(limited.map((s) => s.executionId)).toEqual(["c", "b"]);
  });
});

describe("ReplayService", () => {
  test("throws when snapshot is unknown", async () => {
    const store = new InMemoryReplayStore();
    const svc = createReplayService(store, async () => ({ text: "x" }));
    await expect(svc.replay("missing")).rejects.toBeInstanceOf(
      ReplayNotFoundError,
    );
  });

  test("replays with the original input by default", async () => {
    const store = new InMemoryReplayStore();
    await store.save(snap());
    let seenFlow = "";
    let seenMessages: ChatMessage[] = [];
    const exec: ReplayExecutor = async (flowId, messages) => {
      seenFlow = flowId;
      seenMessages = messages;
      return { text: "Die Akte A-123 ist offen, Betrag 500 Euro." };
    };
    const svc = createReplayService(store, exec);
    const result = await svc.replay("exec-1");
    expect(seenFlow).toBe("helpdesk");
    const seenMessage0 = seenMessages[0];
    if (seenMessage0 === undefined) throw new Error("expected a seen message");
    expect(seenMessage0.content).toContain("A-123");
    expect(result.changed).toBe(false);
    expect(result.similarity).toBe(1);
  });

  test("overrides the flow id (fork to a different version)", async () => {
    const store = new InMemoryReplayStore();
    await store.save(snap());
    let seenFlow = "";
    const svc = createReplayService(store, async (flowId) => {
      seenFlow = flowId;
      return { text: "Andere Antwort." };
    });
    const result = await svc.replay("exec-1", { flowId: "helpdesk-v2" });
    expect(seenFlow).toBe("helpdesk-v2");
    expect(result.replayedFlowId).toBe("helpdesk-v2");
    expect(result.originalFlowId).toBe("helpdesk");
    expect(result.changed).toBe(true);
  });

  test("overrides input messages (edit-and-replay)", async () => {
    const store = new InMemoryReplayStore();
    await store.save(snap());
    let seen = "";
    const svc = createReplayService(store, async (_f, msgs) => {
      const msg0 = msgs[0];
      if (msg0 === undefined) throw new Error("expected a message");
      seen = typeof msg0.content === "string" ? msg0.content : "";
      return { text: "neu" };
    });
    await svc.replay("exec-1", {
      messages: [{ role: "user", content: "Und bei Akte B-999?" }],
    });
    expect(seen).toContain("B-999");
  });

  test("detects a changed answer and reports similarity", async () => {
    const store = new InMemoryReplayStore();
    await store.save(snap({ responseText: "the quick brown fox jumps" }));
    const svc = createReplayService(store, async () => ({
      text: "the quick brown dog sleeps",
    }));
    const r = await svc.replay("exec-1");
    expect(r.changed).toBe(true);
    expect(r.similarity).toBeGreaterThan(0);
    expect(r.similarity).toBeLessThan(1);
  });
});
