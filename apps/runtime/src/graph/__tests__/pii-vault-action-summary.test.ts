// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the PII vault action summary (`getActionSummary`) — the
 * PII-value-free per-execution tokenization count that survives `release()`
 * and backs the Decision-Provenance Explainability Card.
 */

import { describe, it, expect } from "bun:test";
import { createPiiVault, InMemoryPiiVaultStore } from "../pii-vault.js";
import type { PiiVault, PiiVaultConfig, PiiVaultStore } from "../pii-vault.js";

/** `createPiiVault` for a config known to enable the vault (never undefined). */
function mustCreatePiiVault(store: PiiVaultStore, config: PiiVaultConfig): PiiVault {
  const vault = createPiiVault(store, config);
  if (vault === undefined) throw new Error("expected the vault to be enabled");
  return vault;
}

describe("PiiVault.getActionSummary", () => {
  it("returns undefined for an execution that never tokenized anything", () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), {
      enabled: true,
    });
    expect(vault.getActionSummary("exec-none")).toBeUndefined();
  });

  it("counts tokenized spans by type and detector (regex path)", async () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), {
      enabled: true,
    });
    await vault.tokenize(
      "exec-1",
      undefined,
      "contact a@b.com or b@c.com, IBAN DE89370400440532013000",
    );
    const summary = vault.getActionSummary("exec-1");
    expect(summary).toBeDefined();
    if (summary === undefined) throw new Error("expected a summary");
    expect(summary.totalTokenized).toBe(3);
    expect(summary.byType.email).toBe(2);
    expect(summary.byType.iban).toBe(1);
    expect(summary.byDetector.regex).toBe(3);
  });

  it("survives release() (unlike the raw vault entries)", async () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), {
      enabled: true,
    });
    await vault.tokenize("exec-2", undefined, "email me at x@y.com");
    await vault.release("exec-2");
    const summary = vault.getActionSummary("exec-2");
    expect(summary).toBeDefined();
    if (summary === undefined) throw new Error("expected a summary");
    expect(summary.totalTokenized).toBe(1);
  });

  it("accumulates across multiple tokenize() calls for the same execution", async () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), {
      enabled: true,
    });
    await vault.tokenize("exec-3", undefined, "email a@b.com");
    await vault.tokenize("exec-3", undefined, "email c@d.com");
    const summary = vault.getActionSummary("exec-3");
    if (summary === undefined) throw new Error("expected a summary");
    expect(summary.totalTokenized).toBe(2);
    expect(summary.byType.email).toBe(2);
  });

  it("keeps separate summaries per execution id", async () => {
    const vault = mustCreatePiiVault(new InMemoryPiiVaultStore(), {
      enabled: true,
    });
    await vault.tokenize("exec-a", undefined, "email a@b.com");
    await vault.tokenize("exec-b", undefined, "email c@d.com and e@f.com");
    const summaryA = vault.getActionSummary("exec-a");
    const summaryB = vault.getActionSummary("exec-b");
    if (summaryA === undefined || summaryB === undefined) {
      throw new Error("expected both summaries");
    }
    expect(summaryA.totalTokenized).toBe(1);
    expect(summaryB.totalTokenized).toBe(2);
  });
});
