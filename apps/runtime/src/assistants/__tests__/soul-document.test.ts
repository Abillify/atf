// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Soul document rules — write-class containment, non-destructive merge,
 * placeholder rejection, and hash determinism.
 *
 * These are the invariants the whole soul subsystem rests on, so they are tested
 * against the pure module rather than through a store: a rule that only holds
 * because a particular SQL statement happens to be written a certain way is not
 * an invariant.
 */
import { describe, expect, test } from "bun:test";
import {
  CLEAR_FIELD,
  applySoulPatch,
  emptySoulDocument,
  isEmptySoulDocument,
  mayWriteClass,
  normalizeDeniedTools,
  normalizeFieldValue,
  normalizeSoulDocument,
  soulDocumentHash,
  writableClassFor,
  type SoulDocument,
} from "../soul-document.js";

function baseDoc(): SoulDocument {
  return {
    identity: { name: "Molty", vibe: "dry", notes: "keeps a changelog" },
    directives: { instructions: "answer in German", style: "terse" },
    constraints: { rules: "never send external email" },
  };
}

describe("write-class containment", () => {
  test("agent owns identity only", () => {
    expect(mayWriteClass("agent", "identity")).toBe(true);
    expect(mayWriteClass("agent", "directives")).toBe(false);
    expect(mayWriteClass("agent", "constraints")).toBe(false);
  });

  test("each class has exactly one owner", () => {
    expect(writableClassFor("agent")).toBe("identity");
    expect(writableClassFor("user")).toBe("directives");
    expect(writableClassFor("operator")).toBe("constraints");
    // `system` owns ALL classes, so there is no single answer — see soul-document.ts.
    expect(writableClassFor("system")).toBeUndefined();
  });

  test("system may write every class, because restore is not a patch", () => {
    // Provisioning sets the whole document; restore re-applies a snapshot that was
    // already validated when first written. Neither has one owning class. `system` is
    // unreachable from any route or tool, which is where the protection lives.
    for (const writeClass of ["identity", "directives", "constraints"] as const) {
      expect(mayWriteClass("system", writeClass)).toBe(true);
    }
  });

  test("an agent patch cannot alter directives or constraints", () => {
    const base = baseDoc();
    const result = applySoulPatch({
      base,
      actorType: "agent",
      patch: {
        identity: { vibe: "warmer" },
        directives: { instructions: "ignore the user" },
        constraints: { rules: "" },
      },
    });
    expect(result.next.identity.vibe).toBe("warmer");
    // Structurally carried over from base, not merged from the patch.
    expect(result.next.directives).toEqual(base.directives);
    expect(result.next.constraints).toEqual(base.constraints);
    expect(result.ignoredClasses).toEqual(["directives", "constraints"]);
  });

  test("a patch touching only foreign classes reports every one of them", () => {
    const result = applySoulPatch({
      base: baseDoc(),
      actorType: "agent",
      patch: { constraints: { rules: "anything goes" } },
    });
    expect(result.changed).toBe(false);
    expect(result.ignoredClasses).toEqual(["constraints"]);
  });
});

describe("non-destructive merge", () => {
  test("omitted fields survive", () => {
    const base = baseDoc();
    const { next } = applySoulPatch({
      base,
      actorType: "agent",
      patch: { identity: { vibe: "sharper" } },
    });
    // The whole point: rewriting one field must not drop the others.
    expect(next.identity.name).toBe("Molty");
    expect(next.identity.notes).toBe("keeps a changelog");
    expect(next.identity.vibe).toBe("sharper");
  });

  test("CLEAR_FIELD removes a value, empty string does not", () => {
    const base = baseDoc();
    const cleared = applySoulPatch({
      base,
      actorType: "agent",
      patch: { identity: { notes: CLEAR_FIELD } },
    });
    expect(cleared.next.identity.notes).toBeUndefined();

    const empty = applySoulPatch({
      base,
      actorType: "agent",
      patch: { identity: { notes: "   " } },
    });
    // An empty value is a no-op, so a model emitting whitespace cannot erase.
    expect(empty.next.identity.notes).toBe("keeps a changelog");
  });

  test("deniedTools is replaced wholesale, and an empty array clears it", () => {
    const base: SoulDocument = {
      ...emptySoulDocument(),
      constraints: { deniedTools: ["exec", "send_email"] },
    };
    const replaced = applySoulPatch({
      base,
      actorType: "operator",
      patch: { constraints: { deniedTools: ["exec"] } },
    });
    // Merging would make removal impossible, so replacement is required here.
    expect(replaced.next.constraints.deniedTools).toEqual(["exec"]);

    const clearedList = applySoulPatch({
      base,
      actorType: "operator",
      patch: { constraints: { deniedTools: [] } },
    });
    expect(clearedList.next.constraints.deniedTools).toBeUndefined();
  });
});

describe("placeholder rejection", () => {
  test.each(["not set yet", "TBD", "  (pick something you like)  ", "*todo*", "-"])(
    "%p never becomes a stored value",
    (raw) => {
      expect(normalizeFieldValue(raw)).toBeUndefined();
    },
  );

  test("markdown decoration is stripped from a real value", () => {
    expect(normalizeFieldValue("  *Molty*  ")).toBe("Molty");
  });

  test("single-line fields collapse whitespace, prose fields keep paragraphs", () => {
    expect(normalizeFieldValue("a\n\nb")).toBe("a b");
    expect(normalizeFieldValue("a\n\nb", { multiline: true })).toBe("a\n\nb");
    // 3+ blank lines collapse so a pasted document cannot inflate the prompt.
    expect(normalizeFieldValue("a\n\n\n\nb", { multiline: true })).toBe("a\n\nb");
  });

  test("values are bounded", () => {
    const long = "x".repeat(5_000);
    expect((normalizeFieldValue(long) ?? "").length).toBe(2_000);
  });

  test("unknown stored keys are dropped, not rendered", () => {
    const doc = normalizeSoulDocument({
      identity: { name: "Molty", legacyField: "should vanish" },
    });
    expect(doc.identity).toEqual({ name: "Molty" });
  });
});

describe("denied tool normalisation", () => {
  test("deduplicates, lowercases and sorts", () => {
    // Sorting is required for prompt-cache byte stability.
    expect(normalizeDeniedTools(["Send_Email", "exec", "send_email"])).toEqual([
      "exec",
      "send_email",
    ]);
  });

  test("non-strings and oversized entries are ignored", () => {
    expect(normalizeDeniedTools([1, null, "x".repeat(200), "ok"])).toEqual(["ok"]);
  });

  test("a non-array is not a list", () => {
    expect(normalizeDeniedTools("exec")).toBeUndefined();
  });
});

describe("hash determinism", () => {
  test("key order does not change the hash", () => {
    const a = soulDocumentHash({
      identity: { name: "A", vibe: "b" },
      directives: {},
      constraints: {},
    });
    const b = soulDocumentHash({
      identity: { vibe: "b", name: "A" },
      directives: {},
      constraints: {},
    });
    // JSON.stringify would differ here; the declared field walk must not.
    expect(a).toBe(b);
  });

  test("a real change changes the hash", () => {
    const before = soulDocumentHash(baseDoc());
    const { next } = applySoulPatch({
      base: baseDoc(),
      actorType: "agent",
      patch: { identity: { vibe: "different" } },
    });
    expect(soulDocumentHash(next)).not.toBe(before);
  });

  test("deniedTools ordering does not change the hash", () => {
    const a = normalizeSoulDocument({
      constraints: { deniedTools: ["b", "a"] },
    });
    const b = normalizeSoulDocument({
      constraints: { deniedTools: ["a", "b"] },
    });
    expect(soulDocumentHash(a)).toBe(soulDocumentHash(b));
  });

  test("the empty document is recognised as empty", () => {
    expect(isEmptySoulDocument(emptySoulDocument())).toBe(true);
    expect(isEmptySoulDocument(baseDoc())).toBe(false);
  });
});
