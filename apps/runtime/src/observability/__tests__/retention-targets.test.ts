// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the retention target adapters (`src/observability/retention-targets.ts`).
 *
 * Focused on the reversible PII vault adapter — the others (replay, execution
 * history, memory) are exercised indirectly by the Postgres integration tests
 * in retention-stores.test.ts.
 */

import { describe, it, expect } from "bun:test";
import {
  piiVaultRetentionTarget,
  RETENTION_TARGET,
} from "../retention-targets.js";
import type { PiiVaultStore, PiiVaultEntry } from "../../graph/pii-vault.js";
import type { RetentionTarget, ErasureSubject } from "../retention.js";

/** `target.purgeOlderThan`, asserting the target implements age-purge. */
function mustPurgeOlderThan(target: RetentionTarget, cutoffIso: string): Promise<number> {
  if (target.purgeOlderThan === undefined) throw new Error("expected purgeOlderThan to be implemented");
  return target.purgeOlderThan(cutoffIso);
}

/** `target.eraseSubject`, asserting the target implements subject-erasure. */
function mustEraseSubject(target: RetentionTarget, subject: ErasureSubject): Promise<number> {
  if (target.eraseSubject === undefined) throw new Error("expected eraseSubject to be implemented");
  return target.eraseSubject(subject);
}

class FakePiiVaultStore implements PiiVaultStore {
  purgeCalls: string[] = [];
  eraseCalls: string[] = [];
  purgeReturn = 0;
  eraseReturn = 0;

  async put(): Promise<void> {}
  async resolve(): Promise<string | undefined> {
    return undefined;
  }
  clearCalls: string[] = [];
  async clear(executionId: string): Promise<number> {
    this.clearCalls.push(executionId);
    return 2;
  }
  async purgeOlderThan(cutoffIso: string): Promise<number> {
    this.purgeCalls.push(cutoffIso);
    return this.purgeReturn;
  }
  async eraseTenant(tenantId: string): Promise<number> {
    this.eraseCalls.push(tenantId);
    return this.eraseReturn;
  }
}

describe("piiVaultRetentionTarget", () => {
  it("uses the stable target name", () => {
    const target = piiVaultRetentionTarget(new FakePiiVaultStore());
    expect(target.name).toBe(RETENTION_TARGET.piiVault);
  });

  it("delegates age-purge to the store's purgeOlderThan", async () => {
    const store = new FakePiiVaultStore();
    store.purgeReturn = 5;
    const target = piiVaultRetentionTarget(store);
    const removed = await mustPurgeOlderThan(target, "2024-01-01T00:00:00.000Z");
    expect(removed).toBe(5);
    expect(store.purgeCalls).toEqual(["2024-01-01T00:00:00.000Z"]);
  });

  it("erases a tenant's entries via eraseTenant when tenantId is set", async () => {
    const store = new FakePiiVaultStore();
    store.eraseReturn = 3;
    const target = piiVaultRetentionTarget(store);
    const erased = await mustEraseSubject(target, { tenantId: "tenant-a" });
    expect(erased).toBe(3);
    expect(store.eraseCalls).toEqual(["tenant-a"]);
  });

  it("erases only the user's executions for a user-scoped subject, never the tenant", async () => {
    const store = new FakePiiVaultStore();
    const lookups: ErasureSubject[] = [];
    const target = piiVaultRetentionTarget(store, async (subject) => {
      lookups.push(subject);
      return ["exec-1", "exec-2"];
    });
    const subject = { tenantId: "tenant-a", userId: "u@x.de", userAliases: ["u-1"] };
    const erased = await mustEraseSubject(target, subject);
    expect(erased).toBe(4);
    expect(lookups).toEqual([subject]);
    expect(store.clearCalls).toEqual(["exec-1", "exec-2"]);
    expect(store.eraseCalls).toHaveLength(0);
  });

  it("fails a user-scoped subject without an execution lookup instead of erasing the tenant", async () => {
    const store = new FakePiiVaultStore();
    const target = piiVaultRetentionTarget(store);
    await expect(
      mustEraseSubject(target, { tenantId: "tenant-a", userId: "u@x.de" }),
    ).rejects.toThrow(/cannot be attributed/);
    expect(store.eraseCalls).toHaveLength(0);
    expect(store.clearCalls).toHaveLength(0);
  });

  it("omits purgeOlderThan from the target when the store does not implement it", () => {
    const store: PiiVaultStore = {
      async put(): Promise<void> {},
      async resolve(): Promise<string | undefined> {
        return undefined;
      },
      async clear(): Promise<number> {
        return 0;
      },
    };
    const target = piiVaultRetentionTarget(store);
    expect(target.purgeOlderThan).toBeUndefined();
  });

  it("returns 0 without calling anything when the store has no eraseTenant", async () => {
    const store: PiiVaultStore = {
      async put(): Promise<void> {},
      async resolve(): Promise<string | undefined> {
        return undefined;
      },
      async clear(): Promise<number> {
        return 0;
      },
    };
    const target = piiVaultRetentionTarget(store);
    const erased = await mustEraseSubject(target, { tenantId: "tenant-a" });
    expect(erased).toBe(0);
  });

  it("real PiiVaultEntry shape sanity check (type import)", () => {
    const entry: PiiVaultEntry = { token: "abc", type: "email", value: "a@b.com" };
    expect(entry.type).toBe("email");
  });
});
