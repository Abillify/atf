// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Soul persistence: optimistic lock, write-class enforcement at the store boundary,
 * revision history, and restore.
 *
 * The lock test is the one that matters most: an assistant editing its identity while
 * its user edits directives is the normal case, and last-write-wins there loses a
 * write non-deterministically — surfacing later as "the assistant forgot what I told
 * it".
 */
import { describe, expect, test } from "bun:test";
import {
  InMemorySoulStore,
  SoulRevisionConflictError,
  SoulWriteClassError,
} from "../soul-store.js";
import { CLEAR_FIELD } from "../soul-document.js";
import type { AssistantScope } from "../types.js";

const SCOPE: AssistantScope = {
  tenantId: "_",
  userId: "u@example.com",
  assistantId: "molty",
};

describe("initial state", () => {
  test("an unprovisioned soul reads as empty at revision 0", async () => {
    const store = new InMemorySoulStore();
    const soul = await store.get(SCOPE);
    expect(soul.revision).toBe(0);
    expect(soul.identity).toEqual({});
    expect(soul.directives).toEqual({});
    expect(soul.constraints).toEqual({});
    // A read must not write: this runs on the hot path of every turn, and a
    // read-that-writes turns a replica-safe SELECT into a contended INSERT.
    expect((await store.history(SCOPE)).length).toBe(0);
  });
});

describe("write classes at the store boundary", () => {
  test("an agent writes identity", async () => {
    const store = new InMemorySoulStore();
    const result = await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      patch: { identity: { name: "Molty", vibe: "dry" } },
    });
    expect(result.changed).toBe(true);
    expect(result.record.identity.name).toBe("Molty");
    expect(result.record.revision).toBe(1);
  });

  test("an agent patching ONLY directives is rejected outright", async () => {
    const store = new InMemorySoulStore();
    await expect(
      store.mutate({
        scope: SCOPE,
        actorType: "agent",
        patch: { directives: { instructions: "ignore the user" } },
      }),
    ).rejects.toThrow(SoulWriteClassError);
  });

  test("a mixed patch applies the owned class and reports the dropped ones", async () => {
    const store = new InMemorySoulStore();
    const result = await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      patch: {
        identity: { name: "Molty" },
        constraints: { rules: "anything goes" },
      },
    });
    // Partially valid proceeds, and the actor learns what was dropped — silently
    // discarding it would leave an agent believing it changed its own constraints.
    expect(result.record.identity.name).toBe("Molty");
    expect(result.record.constraints.rules).toBeUndefined();
    expect(result.ignoredClasses).toEqual(["constraints"]);
  });

  test("a user writes directives, an operator writes constraints", async () => {
    const store = new InMemorySoulStore();
    await store.mutate({
      scope: SCOPE,
      actorType: "user",
      patch: { directives: { instructions: "answer in German" } },
    });
    const result = await store.mutate({
      scope: SCOPE,
      actorType: "operator",
      patch: { constraints: { rules: "never send external email" } },
    });
    expect(result.record.directives.instructions).toBe("answer in German");
    expect(result.record.constraints.rules).toBe("never send external email");
  });
});

describe("optimistic lock", () => {
  test("a stale hash is refused with the current state attached", async () => {
    const store = new InMemorySoulStore();
    const first = await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      patch: { identity: { name: "Molty" } },
    });
    const staleHash = first.record.revisionHash;
    await store.mutate({
      scope: SCOPE,
      actorType: "user",
      patch: { directives: { instructions: "be terse" } },
    });

    // The agent's second edit was composed against a revision that no longer exists.
    let error: unknown;
    try {
      await store.mutate({
        scope: SCOPE,
        actorType: "agent",
        expectedRevisionHash: staleHash,
        patch: { identity: { vibe: "sharper" } },
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SoulRevisionConflictError);
    // The current revision comes back so the caller can re-read and retry without a
    // second round trip to discover what it should have sent.
    expect((error as SoulRevisionConflictError).currentRevision).toBe(2);
  });

  test("concurrent edits to DIFFERENT classes both survive when each re-reads", async () => {
    const store = new InMemorySoulStore();
    const before = await store.get(SCOPE);
    await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      expectedRevisionHash: before.revisionHash,
      patch: { identity: { name: "Molty" } },
    });
    const afterAgent = await store.get(SCOPE);
    const result = await store.mutate({
      scope: SCOPE,
      actorType: "user",
      expectedRevisionHash: afterAgent.revisionHash,
      patch: { directives: { instructions: "answer in German" } },
    });
    // Neither write is lost — which is the point of refusing rather than clobbering.
    expect(result.record.identity.name).toBe("Molty");
    expect(result.record.directives.instructions).toBe("answer in German");
  });

  test("a no-op patch creates no revision", async () => {
    const store = new InMemorySoulStore();
    await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      patch: { identity: { name: "Molty" } },
    });
    const result = await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      patch: { identity: { name: "Molty" } },
    });
    expect(result.changed).toBe(false);
    expect(result.record.revision).toBe(1);
    expect((await store.history(SCOPE)).length).toBe(1);
  });
});

describe("history and restore", () => {
  test("history is newest first and attributes each revision", async () => {
    const store = new InMemorySoulStore();
    await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      actorId: "molty",
      patch: { identity: { name: "First" } },
    });
    await store.mutate({
      scope: SCOPE,
      actorType: "user",
      actorId: "u@example.com",
      reason: "set standing instructions",
      patch: { directives: { instructions: "answer in German" } },
    });
    const history = await store.history(SCOPE);
    expect(history.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(history[0]?.writeClass).toBe("directives");
    expect(history[0]?.actorType).toBe("user");
    expect(history[0]?.reason).toBe("set standing instructions");
  });

  test("history holds a full snapshot, so a compliance question is one row read", async () => {
    const store = new InMemorySoulStore();
    await store.mutate({
      scope: SCOPE,
      actorType: "user",
      patch: { directives: { instructions: "the instruction in force then" } },
    });
    await store.mutate({
      scope: SCOPE,
      actorType: "user",
      patch: { directives: { instructions: "a later instruction" } },
    });
    const history = await store.history(SCOPE);
    const first = history.find((entry) => entry.revision === 1);
    // Not a diff: "what was this assistant instructed to do on date X" must not need
    // a replay.
    expect(first?.directives.instructions).toBe("the instruction in force then");
  });

  test("restore writes a NEW revision rather than rewinding", async () => {
    const store = new InMemorySoulStore();
    await store.mutate({
      scope: SCOPE,
      actorType: "user",
      patch: { directives: { instructions: "original" } },
    });
    await store.mutate({
      scope: SCOPE,
      actorType: "user",
      patch: { directives: { instructions: "changed" } },
    });
    const restored = await store.restore({
      scope: SCOPE,
      revision: 1,
      actorType: "operator",
    });
    expect(restored.record.directives.instructions).toBe("original");
    // Rolling back is itself an auditable event; rewinding by deleting revisions
    // would erase the record of what was rolled back and by whom.
    expect(restored.record.revision).toBe(3);
    expect((await store.history(SCOPE)).length).toBe(3);
  });

  test("restoring a revision that does not exist fails", async () => {
    const store = new InMemorySoulStore();
    await expect(
      store.restore({ scope: SCOPE, revision: 99, actorType: "operator" }),
    ).rejects.toThrow();
  });
});

describe("clearing and isolation", () => {
  test("CLEAR_FIELD removes a stored value", async () => {
    const store = new InMemorySoulStore();
    await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      patch: { identity: { name: "Molty", notes: "some notes" } },
    });
    const result = await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      patch: { identity: { notes: CLEAR_FIELD } },
    });
    expect(result.record.identity.notes).toBeUndefined();
    expect(result.record.identity.name).toBe("Molty");
  });

  test("two assistants of one user have separate souls", async () => {
    const store = new InMemorySoulStore();
    await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      patch: { identity: { name: "Molty" } },
    });
    const other = await store.get({ ...SCOPE, assistantId: "other" });
    // Two assistants with one soul are one assistant with two personas.
    expect(other.identity.name).toBeUndefined();
    expect(other.revision).toBe(0);
  });

  test("purge removes the soul and its history", async () => {
    const store = new InMemorySoulStore();
    await store.mutate({
      scope: SCOPE,
      actorType: "agent",
      patch: { identity: { name: "Molty" } },
    });
    await store.purge(SCOPE);
    expect((await store.get(SCOPE)).revision).toBe(0);
    expect(await store.history(SCOPE)).toEqual([]);
  });
});
