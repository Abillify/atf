// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the reversible PII tokenization vault (`src/graph/pii-vault.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  tokenizeText,
  detokenizeText,
  DetokenizeStream,
  InMemoryPiiVaultStore,
  PostgresPiiVaultStore,
  createPiiVault,
} from "../pii-vault.js";
import type { PiiVault, PiiVaultConfig, PiiVaultStore } from "../pii-vault.js";
import { SecretCipher } from "../secret-cipher.js";
import type { Database } from "../../db/database.js";

const CIPHER = new SecretCipher(Buffer.alloc(32, 7));

/** `createPiiVault` for a config known to enable the vault (never undefined). */
function mustCreatePiiVault(
  store: PiiVaultStore,
  config: PiiVaultConfig,
): PiiVault {
  const vault = createPiiVault(store, config);
  if (vault === undefined) throw new Error("expected the vault to be enabled");
  return vault;
}

describe("tokenizeText / detokenizeText (pure)", () => {
  it("replaces a PII span with a placeholder and round-trips it back", () => {
    const { text, entries } = tokenizeText("email me at jane@example.com now");
    expect(text).not.toContain("jane@example.com");
    expect(text).toMatch(/\[\[PII:[a-f0-9]{16}\]\]/);
    expect(entries).toHaveLength(1);
    const firstEntry = entries[0];
    if (firstEntry === undefined) throw new Error("expected a first entry");
    expect(firstEntry.type).toBe("email");
    expect(firstEntry.value).toBe("jane@example.com");

    const map = new Map(entries.map((e) => [e.token, e.value]));
    const restored = detokenizeText(text, (t) => map.get(t));
    expect(restored).toBe("email me at jane@example.com now");
  });

  it("mints a distinct token for each occurrence of a repeated value", () => {
    const { entries } = tokenizeText("a@b.com and a@b.com again");
    expect(entries).toHaveLength(2);
    const [first, second] = entries;
    if (first === undefined || second === undefined) {
      throw new Error("expected two entries");
    }
    expect(first.token).not.toBe(second.token);
    expect(first.value).toBe("a@b.com");
    expect(second.value).toBe("a@b.com");
  });

  it("returns the text unchanged when there is no PII", () => {
    const { text, entries } = tokenizeText("nothing sensitive here");
    expect(text).toBe("nothing sensitive here");
    expect(entries).toHaveLength(0);
  });

  it("respects an explicit type filter", () => {
    const { entries } = tokenizeText("email a@b.com and ip 10.0.0.1", [
      "email",
    ]);
    expect(entries).toHaveLength(1);
    const firstEntry = entries[0];
    if (firstEntry === undefined) throw new Error("expected a first entry");
    expect(firstEntry.type).toBe("email");
  });

  it("leaves an unresolvable placeholder untouched instead of dropping it", () => {
    const text = "value is [[PII:0123456789abcdef]] here";
    const restored = detokenizeText(text, () => undefined);
    expect(restored).toBe(text);
  });

  it("does not mistake ordinary bracketed text for a token", () => {
    const text = "see [[PII:not-a-real-token]] and [[OTHER:thing]]";
    const restored = detokenizeText(text, () => "SHOULD_NOT_APPEAR");
    expect(restored).toBe(text);
  });
});

describe("DetokenizeStream", () => {
  it("detokenizes a token split across two pushes", () => {
    const map = new Map([["a1b2c3d4e5f60718", "secret-value"]]);
    const stream = new DetokenizeStream((t) => map.get(t));
    const token = "[[PII:a1b2c3d4e5f60718]]";
    const padding = "x".repeat(40);
    let out = "";
    out += stream.push(`${padding} before ${token.slice(0, 10)}`);
    out += stream.push(`${token.slice(10)} after ${padding}`);
    out += stream.flush();
    expect(out).toContain("secret-value");
    expect(out).not.toContain("[[PII:");
  });

  it("passes clean text through unchanged", () => {
    const stream = new DetokenizeStream(() => undefined);
    let out = "";
    const text =
      "just a normal streamed sentence with no tokens at all. ".repeat(3);
    for (const word of text.split(" ")) out += stream.push(`${word} `);
    out += stream.flush();
    expect(out.replace(/\s+/g, " ").trim()).toBe(
      text.replace(/\s+/g, " ").trim(),
    );
  });

  it("never splits a token even when fed one character at a time", () => {
    const map = new Map([["deadbeefcafef00d", "restored-value"]]);
    const stream = new DetokenizeStream((t) => map.get(t));
    const full = `prefix text [[PII:deadbeefcafef00d]] suffix text ${"pad".repeat(20)}`;
    let out = "";
    for (const ch of full) out += stream.push(ch);
    out += stream.flush();
    expect(out).toBe(
      `prefix text restored-value suffix text ${"pad".repeat(20)}`,
    );
  });

  it("handles two tokens close together split across arbitrary boundaries", () => {
    const map = new Map([
      ["aaaaaaaaaaaaaaaa", "FIRST"],
      ["bbbbbbbbbbbbbbbb", "SECOND"],
    ]);
    const stream = new DetokenizeStream((t) => map.get(t));
    const full = "x [[PII:aaaaaaaaaaaaaaaa]][[PII:bbbbbbbbbbbbbbbb]] y";
    let out = "";
    // Split at every 3-character boundary.
    for (let i = 0; i < full.length; i += 3)
      out += stream.push(full.slice(i, i + 3));
    out += stream.flush();
    expect(out).toBe("x FIRSTSECOND y");
  });
});

describe("InMemoryPiiVaultStore", () => {
  it("stores and resolves entries scoped by execution", async () => {
    const store = new InMemoryPiiVaultStore();
    await store.put("exec-1", "tenant-a", [
      { token: "tok1", type: "email", value: "a@b.com" },
    ]);
    expect(await store.resolve("exec-1", "tok1")).toBe("a@b.com");
    // A different execution never sees another execution's tokens.
    expect(await store.resolve("exec-2", "tok1")).toBeUndefined();
  });

  it("clear() removes all entries for an execution and returns the count", async () => {
    const store = new InMemoryPiiVaultStore();
    await store.put("exec-1", undefined, [
      { token: "t1", type: "email", value: "a@b.com" },
      { token: "t2", type: "phone", value: "+491234567" },
    ]);
    const removed = await store.clear("exec-1");
    expect(removed).toBe(2);
    expect(await store.resolve("exec-1", "t1")).toBeUndefined();
  });

  it("purgeOlderThan removes only entries older than the cutoff", async () => {
    const store = new InMemoryPiiVaultStore();
    await store.put("exec-old", undefined, [
      { token: "old1", type: "email", value: "old@x.com" },
    ]);
    const cutoff = new Date(Date.now() + 1000).toISOString(); // future cutoff catches everything
    const purged = await store.purgeOlderThan(cutoff);
    expect(purged).toBe(1);
    expect(await store.resolve("exec-old", "old1")).toBeUndefined();
  });

  it("eraseTenant removes only that tenant's entries across executions", async () => {
    const store = new InMemoryPiiVaultStore();
    await store.put("exec-1", "tenant-a", [
      { token: "t1", type: "email", value: "a@x.com" },
    ]);
    await store.put("exec-2", "tenant-b", [
      { token: "t2", type: "email", value: "b@x.com" },
    ]);
    const erased = await store.eraseTenant("tenant-a");
    expect(erased).toBe(1);
    expect(await store.resolve("exec-1", "t1")).toBeUndefined();
    expect(await store.resolve("exec-2", "t2")).toBe("b@x.com");
  });
});

function fakeDb(overrides: Partial<Database> = {}): Database {
  return {
    query: async () => [],
    close: async () => {},
    // The operator connection reuses the same overrides so tests that stub
    // `query` see their stub on operator-pool statements too.
    withOperator: async <T>(cb: (db: Database) => Promise<T>) =>
      cb(fakeDb(overrides)),
    ...overrides,
  } as Database;
}

describe("PostgresPiiVaultStore", () => {
  it("encrypts on put and decrypts on resolve via the DB path", async () => {
    const inserted: unknown[][] = [];
    const db = fakeDb({
      query: (async (text: string, params?: readonly unknown[]) => {
        if (/^INSERT/i.test(text.trim())) {
          inserted.push([...(params ?? [])]);
          return [];
        }
        if (/^SELECT token, pii_type, encrypted_value/i.test(text.trim())) {
          const encrypted = inserted[0]?.[4] as string;
          return [
            { token: "tok1", pii_type: "email", encrypted_value: encrypted },
          ];
        }
        return [];
      }) as Database["query"],
    });
    const store = new PostgresPiiVaultStore(db, CIPHER);
    await store.put("exec-1", "tenant-a", [
      { token: "tok1", type: "email", value: "secret@example.com" },
    ]);
    expect(inserted).toHaveLength(1);
    const firstInsert = inserted[0];
    if (firstInsert === undefined) throw new Error("expected a first insert");
    expect(firstInsert[4]).not.toBe("secret@example.com"); // encrypted

    // Clear the in-memory mirror so resolve() must hit the DB path.
    await store.clear("exec-1");
    const resolved = await store.resolve("exec-1", "tok1");
    expect(resolved).toBe("secret@example.com");
  });

  it("resolve() serves from the in-memory mirror without a DB round-trip", async () => {
    let queried = false;
    const db = fakeDb({
      query: async (text: string) => {
        if (/^INSERT/i.test(text.trim())) return [];
        queried = true;
        return [];
      },
    });
    const store = new PostgresPiiVaultStore(db, CIPHER);
    await store.put("exec-1", undefined, [
      { token: "tok1", type: "email", value: "a@b.com" },
    ]);
    const resolved = await store.resolve("exec-1", "tok1");
    expect(resolved).toBe("a@b.com");
    expect(queried).toBe(false);
  });

  it("falls back gracefully when the insert query fails", async () => {
    const db = fakeDb({
      query: async () => {
        throw new Error("db down");
      },
    });
    const store = new PostgresPiiVaultStore(db, CIPHER);
    await store.put("exec-1", undefined, [
      { token: "tok1", type: "email", value: "a@b.com" },
    ]);
    // Still resolvable via the mirror even though the durable write failed.
    expect(await store.resolve("exec-1", "tok1")).toBe("a@b.com");
  });

  it("purgeOlderThan and eraseTenant run on the operator connection", async () => {
    let usedOperator = false;
    const db = fakeDb({
      query: async () => [],
      withOperator: async <T>(cb: (db: Database) => Promise<T>) => {
        usedOperator = true;
        return cb(
          fakeDb({
            query: (async () => [
              { token: "t1" },
              { token: "t2" },
            ]) as Database["query"],
          }),
        );
      },
    });
    const store = new PostgresPiiVaultStore(db, CIPHER);
    const purged = await store.purgeOlderThan(new Date().toISOString());
    expect(usedOperator).toBe(true);
    expect(purged).toBe(2);

    usedOperator = false;
    const erased = await store.eraseTenant("tenant-a");
    expect(usedOperator).toBe(true);
    expect(erased).toBe(2);
  });

  it("eraseTenant propagates DB errors instead of returning 0 (Req 2.1)", async () => {
    const db = fakeDb({
      query: async () => {
        throw new Error("db down");
      },
    });
    const store = new PostgresPiiVaultStore(db, CIPHER);
    await expect(store.eraseTenant("tenant-a")).rejects.toThrow("db down");
  });

  it("purgeOlderThan propagates DB errors instead of returning 0 (Req 2.1)", async () => {
    const db = fakeDb({
      query: async () => {
        throw new Error("db down");
      },
    });
    const store = new PostgresPiiVaultStore(db, CIPHER);
    await expect(
      store.purgeOlderThan(new Date().toISOString()),
    ).rejects.toThrow("db down");
  });

  it("eraseTenant clears the in-memory mirror even when the durable delete fails (Req 2.2)", async () => {
    let failDelete = false;
    const db = fakeDb({
      query: (async (text: string) => {
        const t = text.trim();
        if (/^INSERT/i.test(t)) return [];
        if (/^DELETE/i.test(t)) {
          if (failDelete) throw new Error("db down");
          return [{ token: "t1" }];
        }
        return [];
      }) as Database["query"],
    });
    const store = new PostgresPiiVaultStore(db, CIPHER);
    await store.put("exec-1", "tenant-a", [
      { token: "t1", type: "email", value: "a@x.com" },
    ]);
    // Mirror hit before erasure.
    expect(await store.resolve("exec-1", "t1")).toBe("a@x.com");
    failDelete = true;
    await expect(store.eraseTenant("tenant-a")).rejects.toThrow("db down");
    // The mirror must be gone despite the failure — a same-process resolve()
    // may never return the erased value again.
    expect(await store.resolve("exec-1", "t1")).toBeUndefined();
  });

  it("purgeOlderThan clears the in-memory mirror even when the durable delete fails (Req 2.2)", async () => {
    const db = fakeDb({
      query: async () => {
        throw new Error("db down");
      },
    });
    const store = new PostgresPiiVaultStore(db, CIPHER);
    await store.put("exec-1", undefined, [
      { token: "t1", type: "email", value: "a@x.com" },
    ]);
    await expect(
      store.purgeOlderThan(new Date(Date.now() + 1000).toISOString()),
    ).rejects.toThrow("db down");
    expect(await store.resolve("exec-1", "t1")).toBeUndefined();
  });
});

describe("createPiiVault", () => {
  it("returns undefined when disabled", () => {
    expect(
      createPiiVault(new InMemoryPiiVaultStore(), { enabled: false }),
    ).toBeUndefined();
  });

  it("tokenizes on ingress and detokenizes on egress round-trip (non-streaming)", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const tokenized = await vault.tokenize(
      "exec-1",
      "tenant-a",
      "call me at a@b.com",
    );
    expect(tokenized).not.toContain("a@b.com");

    const restored = await vault.detokenize("exec-1", tokenized);
    expect(restored).toBe("call me at a@b.com");
  });

  it("detokenizes a streamed response split across pushes", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const tokenized = await vault.tokenize(
      "exec-1",
      undefined,
      "email a@b.com please",
    );

    const handle = vault.createDetokenizeStream("exec-1");
    const mid = Math.floor(tokenized.length / 2);
    let out = "";
    out += await handle.push(tokenized.slice(0, mid));
    out += await handle.push(tokenized.slice(mid));
    out += await handle.flush();
    expect(out).toBe("email a@b.com please");
  });

  it("release() clears the vault entries for the execution", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const tokenized = await vault.tokenize("exec-1", undefined, "a@b.com");
    await vault.release("exec-1");
    // The token can no longer be resolved — detokenize leaves it as-is.
    const restored = await vault.detokenize("exec-1", tokenized);
    expect(restored).toBe(tokenized);
  });

  it("restricts detection to the configured PII type subset", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, {
      enabled: true,
      piiTypes: ["email"],
    });
    const tokenized = await vault.tokenize(
      "exec-1",
      undefined,
      "email a@b.com and ip 10.0.0.1",
    );
    expect(tokenized).not.toContain("a@b.com");
    expect(tokenized).toContain("10.0.0.1"); // ip detector excluded
  });
});

// ---------------------------------------------------------------------------
// Per-flow detector resolver integration (ADR-0015)
// ---------------------------------------------------------------------------

import {
  PiiDetectorRegistry,
  type PiiDetector,
  type PiiDetectorResolver,
} from "../pii-detector.js";
import { RegexPiiDetector } from "../pii-detector-regex.js";
import type { PiiMatch, PiiType } from "../output-guardrails.js";

/** Fake detector that flags a fixed substring as a given PII type. */
class SubstringDetector implements PiiDetector {
  constructor(
    readonly name: string,
    readonly priority: number,
    private readonly needle: string,
    private readonly type: PiiType,
  ) {}
  async detect(text: string): Promise<PiiMatch[]> {
    const start = text.indexOf(this.needle);
    if (start === -1) return [];
    return [
      {
        type: this.type,
        value: this.needle,
        start,
        end: start + this.needle.length,
      },
    ];
  }
}

class ThrowingDetector implements PiiDetector {
  readonly name = "boom";
  readonly priority = 20;
  async detect(): Promise<PiiMatch[]> {
    throw new Error("detector exploded");
  }
}

/** Resolver returning a fixed plan for a specific flow, undefined otherwise. */
function resolverFor(
  flowId: string,
  registry: PiiDetectorRegistry | undefined,
  piiTypes?: readonly PiiType[],
): PiiDetectorResolver {
  return {
    resolve: (id) =>
      id === flowId && registry !== undefined
        ? piiTypes !== undefined
          ? { registry, piiTypes }
          : { registry }
        : undefined,
  };
}

describe("PiiVault — per-flow detector resolver", () => {
  it("uses the flow's registry (NER-style detector) when a resolver + flowId are supplied", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const registry = new PiiDetectorRegistry().add(
      new SubstringDetector("ner:test", 20, "Anna Schmidt", "person"),
    );
    vault.setDetectorResolver(resolverFor("helpdesk", registry));

    const tokenized = await vault.tokenize(
      "exec-1",
      undefined,
      "Kundin Anna Schmidt meldet sich",
      "helpdesk",
    );
    expect(tokenized).not.toContain("Anna Schmidt");
    expect(tokenized).toMatch(/\[\[PII:[a-f0-9]{16}\]\]/);
    // Round-trips back to the real value on egress.
    expect(await vault.detokenize("exec-1", tokenized)).toContain(
      "Anna Schmidt",
    );
  });

  it("restricts tokenization to the per-flow PII type subset from the plan", async () => {
    const store = new InMemoryPiiVaultStore();
    // Vault global has NO type restriction (all types).
    const vault = mustCreatePiiVault(store, { enabled: true });
    const registry = new PiiDetectorRegistry().add(new RegexPiiDetector());
    // Per-flow plan restricts this flow to emails only.
    vault.setDetectorResolver(resolverFor("helpdesk", registry, ["email"]));

    const tokenized = await vault.tokenize(
      "exec-1",
      undefined,
      "mail a@b.com and ip 10.0.0.1",
      "helpdesk",
    );
    expect(tokenized).not.toContain("a@b.com"); // email tokenized
    expect(tokenized).toContain("10.0.0.1"); // ipv4 left alone (not in subset)
  });

  it("persists detector provenance for tokens produced via the registry", async () => {
    const store = new InMemoryPiiVaultStore();
    const captured: Array<{ detector?: string }> = [];
    const origPut = store.put.bind(store);
    store.put = async (execId, tenantId, entries) => {
      captured.push(...entries.map((e) => ({ detector: e.detector })));
      return origPut(execId, tenantId, entries);
    };
    const vault = mustCreatePiiVault(store, { enabled: true });
    const registry = new PiiDetectorRegistry().add(
      new SubstringDetector("ner:test", 20, "Berlin", "location"),
    );
    vault.setDetectorResolver(resolverFor("helpdesk", registry));

    await vault.tokenize("exec-1", undefined, "wohnhaft in Berlin", "helpdesk");
    expect(captured).toHaveLength(1);
    const firstCaptured = captured[0];
    if (firstCaptured === undefined)
      throw new Error("expected a first captured entry");
    expect(firstCaptured.detector).toBe("ner:test");
  });

  it("falls back to the legacy sync regex path when the resolver returns undefined for a flow", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    // Resolver only knows 'helpdesk'; 'userstory' → undefined → legacy regex path.
    vault.setDetectorResolver(
      resolverFor("helpdesk", new PiiDetectorRegistry()),
    );
    const tokenized = await vault.tokenize(
      "exec-1",
      undefined,
      "mail a@b.com",
      "userstory",
    );
    expect(tokenized).not.toContain("a@b.com"); // legacy regex still tokenizes
  });

  it("disables tokenization for a flow whose registry has no detectors (detectors: [])", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    // Empty registry = explicit 'detectors: []' → tokenize nothing.
    vault.setDetectorResolver(
      resolverFor("internal", new PiiDetectorRegistry()),
    );
    const tokenized = await vault.tokenize(
      "exec-1",
      undefined,
      "mail a@b.com",
      "internal",
    );
    expect(tokenized).toBe("mail a@b.com"); // untouched
  });

  it("propagates a fail-closed detection error instead of forwarding un-tokenized PII", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const registry = new PiiDetectorRegistry({ failMode: "closed" }).add(
      new ThrowingDetector(),
    );
    vault.setDetectorResolver(resolverFor("helpdesk", registry));

    await expect(
      vault.tokenize("exec-1", undefined, "sensitive a@b.com", "helpdesk"),
    ).rejects.toThrow();
  });

  it("emits a per-detector tokenization metric (provenance consumption)", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const counters: Array<{ name: string; labels: Record<string, string> }> =
      [];
    vault.setMetrics({
      recordCounter: (name, labels) => counters.push({ name, labels }),
    });
    const registry = new PiiDetectorRegistry().add(
      new SubstringDetector("ner:test", 20, "Anna Schmidt", "person"),
    );
    vault.setDetectorResolver(resolverFor("helpdesk", registry));

    await vault.tokenize(
      "exec-1",
      undefined,
      "Kundin Anna Schmidt",
      "helpdesk",
    );
    expect(counters).toHaveLength(1);
    const firstCounter = counters[0];
    if (firstCounter === undefined)
      throw new Error("expected a first counter call");
    expect(firstCounter.name).toBe("aiperator_pii_vault_tokens_total");
    expect(firstCounter.labels).toEqual({
      detector: "ner:test",
      type: "person",
    });
  });

  it("emits provenance metric with detector='regex' on the legacy sync path", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const counters: Array<{ labels: Record<string, string> }> = [];
    vault.setMetrics({
      recordCounter: (_name, labels) => counters.push({ labels }),
    });
    // No resolver + no flowId → legacy regex path.
    await vault.tokenize("exec-1", undefined, "mail a@b.com");
    expect(counters).toHaveLength(1);
    const firstCounter = counters[0];
    if (firstCounter === undefined)
      throw new Error("expected a first counter call");
    expect(firstCounter.labels).toEqual({ detector: "regex", type: "email" });
  });
});
