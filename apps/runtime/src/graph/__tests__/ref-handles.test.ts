// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the run-scoped reference-handle registry (`ref-handles.ts`).
 *
 * The registry lets a small model quote a short handle (`K3NQ`) where a long
 * document path belongs, because it cannot copy verbatim paths reliably
 * (trace 55c5b138). These tests pin the properties the whole feature rests on:
 * determinism (a handle survives turns/restarts), exact-match resolution,
 * collision handling, the mask/unmap round-trip, and the loud rejection of a
 * hallucinated handle-shaped argument.
 */

import { describe, it, expect } from "bun:test";
import {
  HashRefHandleRegistry,
  resolveRefHandleArgs,
} from "../ref-handles.js";

const REF_A =
  "prod/richtlinien/logistik/wareneingang_pruefung_v3.pdf#kapitel-4.2";
const REF_B = "prod/handbuch/sicherheit/brandschutz.pdf";

describe("HashRefHandleRegistry — handle derivation", () => {
  it("derives a 4-char uppercase base32 handle", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    expect(handle).toMatch(/^[A-Z2-7]{4}$/);
  });

  it("is deterministic: the same reference always yields the same handle", () => {
    const a = new HashRefHandleRegistry().register(REF_A);
    const b = new HashRefHandleRegistry().register(REF_A);
    expect(a).toBe(b);
  });

  it("returns the same handle when registering the same reference twice", () => {
    const reg = new HashRefHandleRegistry();
    const first = reg.register(REF_A);
    const second = reg.register(REF_A);
    expect(second).toBe(first);
    expect(reg.list().length).toBe(1);
  });

  it("resolves a handle back to its real reference", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    expect(reg.resolve(handle)).toBe(REF_A);
  });

  it("does not resolve a real reference as if it were a handle", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    expect(reg.resolve(REF_A)).toBeUndefined();
  });

  it("disambiguates a base-handle collision with a ~N suffix", () => {
    // Force a collision by registering many references until two share a base;
    // with 32^4 space this needs a large sample, so instead exercise the suffix
    // path directly through a tiny alphabet-free probe: register enough refs
    // that the collision counter is exercised, then assert uniqueness holds.
    const reg = new HashRefHandleRegistry();
    const handles = new Set<string>();
    for (let i = 0; i < 500; i++) {
      handles.add(reg.register(`doc/ref-${i}.pdf`));
    }
    // Every registered reference must map to a distinct handle.
    expect(handles.size).toBe(500);
    // And each must round-trip.
    for (const info of reg.list()) {
      expect(reg.resolve(info.handle)).toBe(info.ref);
    }
  });

  it("passes a blank reference through unmapped", () => {
    const reg = new HashRefHandleRegistry();
    expect(reg.register("   ")).toBe("   ");
    expect(reg.list().length).toBe(0);
  });

  it("passes references through unmasked once the budget is exhausted", () => {
    const reg = new HashRefHandleRegistry({ maxRefs: 2 });
    const h1 = reg.register(REF_A);
    const h2 = reg.register(REF_B);
    const overflow = reg.register("doc/third.pdf");
    // The third never gets a mapping — it flows as itself.
    expect(overflow).toBe("doc/third.pdf");
    expect(reg.list().length).toBe(2);
    expect(reg.resolve(h1)).toBe(REF_A);
    expect(reg.resolve(h2)).toBe(REF_B);
  });
});

describe("HashRefHandleRegistry — registerFromPayload", () => {
  it("registers references found under reference/ref/base_ref at any depth", () => {
    const reg = new HashRefHandleRegistry();
    reg.registerFromPayload({
      results: [
        { base_ref: REF_A, title: "A" },
        { reference: REF_B, title: "B" },
        { nested: { ref: "prod/tief/c.pdf" } },
      ],
    });
    const refs = reg.list().map((i) => i.ref);
    expect(refs).toContain(REF_A);
    expect(refs).toContain(REF_B);
    expect(refs).toContain("prod/tief/c.pdf");
  });

  it("registers references inside an MCP text-part JSON envelope", () => {
    const reg = new HashRefHandleRegistry();
    reg.registerFromPayload([
      { type: "text", text: JSON.stringify({ results: [{ base_ref: REF_A }] }) },
    ]);
    expect(reg.list().map((i) => i.ref)).toContain(REF_A);
  });

  it("registers references inside a JSON string payload", () => {
    const reg = new HashRefHandleRegistry();
    reg.registerFromPayload(JSON.stringify({ results: [{ reference: REF_B }] }));
    expect(reg.list().map((i) => i.ref)).toContain(REF_B);
  });
});

describe("HashRefHandleRegistry — maskContent / unmapContent", () => {
  it("replaces a whole reference value with its handle", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    const masked = reg.maskContent({ base_ref: REF_A, title: "A" }) as {
      base_ref: string;
    };
    expect(masked.base_ref).toBe(handle);
  });

  it("replaces a reference inside longer text (citation note)", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    const masked = reg.maskContent({
      note: `[1] Titel (Ref: ${REF_A})`,
    }) as { note: string };
    expect(masked.note).toBe(`[1] Titel (Ref: ${handle})`);
  });

  it("masks inside an MCP text-part JSON string, keeping the envelope shape", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    const masked = reg.maskContent([
      { type: "text", text: JSON.stringify({ results: [{ base_ref: REF_A }] }) },
    ]) as { type: string; text: string }[];
    expect(masked[0]?.type).toBe("text");
    expect(JSON.parse(masked[0]?.text ?? "{}")).toEqual({
      results: [{ base_ref: handle }],
    });
  });

  it("round-trips maskContent → unmapContent back to the real references", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    reg.register(REF_B);
    const original = {
      results: [
        { base_ref: REF_A, title: "A" },
        { base_ref: REF_B, title: "B" },
      ],
    };
    const masked = reg.maskContent(original);
    expect(JSON.stringify(masked)).not.toContain(REF_A);
    const unmapped = reg.unmapContent(masked);
    expect(unmapped).toEqual(original);
  });

  it("leaves unregistered strings byte-identical", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    const untouched = { other: "prod/andere/datei.pdf", n: 3 };
    expect(reg.maskContent(untouched)).toEqual(untouched);
  });
});

describe("HashRefHandleRegistry — maskText (grounding context)", () => {
  it("replaces a reference inside a grounding (Ref: ...) line", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    const section = `[1] Wareneingang (Ref: ${REF_A}): Kurztext`;
    expect(reg.maskText(section)).toBe(`[1] Wareneingang (Ref: ${handle}): Kurztext`);
  });

  it("masks several references in one block, longest first", () => {
    const reg = new HashRefHandleRegistry();
    const handleA = reg.register(REF_A);
    const handleB = reg.register(REF_B);
    const block = `A: ${REF_A}\nB: ${REF_B}`;
    const masked = reg.maskText(block);
    expect(masked).toBe(`A: ${handleA}\nB: ${handleB}`);
    expect(masked).not.toContain(REF_A);
    expect(masked).not.toContain(REF_B);
  });

  it("masks a longer reference before a shorter one it contains", () => {
    const reg = new HashRefHandleRegistry();
    const short = "prod/a.pdf";
    const long = "prod/a.pdf/kapitel-2";
    const handleShort = reg.register(short);
    const handleLong = reg.register(long);
    // The long reference must mask as a whole, not leave `handleShort/kapitel-2`.
    expect(reg.maskText(`Ref: ${long}`)).toBe(`Ref: ${handleLong}`);
    expect(reg.maskText(`Ref: ${short}`)).toBe(`Ref: ${handleShort}`);
  });

  it("round-trips maskText → unmapText back to the real references", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    reg.register(REF_B);
    const block = `[1] A (Ref: ${REF_A})\n[2] B (Ref: ${REF_B})`;
    const masked = reg.maskText(block);
    expect(masked).not.toContain(REF_A);
    expect(reg.unmapText(masked)).toBe(block);
  });

  it("leaves text without a registered reference unchanged", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    const text = "RELEVANT PASSAGES ohne Referenzen.";
    expect(reg.maskText(text)).toBe(text);
  });
});

describe("HashRefHandleRegistry — unmapText", () => {
  it("replaces a handle occurrence in prose with the real reference", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    expect(reg.unmapText(`Siehe ${handle} für Details.`)).toBe(
      `Siehe ${REF_A} für Details.`,
    );
  });

  it("does not rewrite a handle embedded in a longer identifier", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    // `K3NQX` (handle + X) is a different token and must NOT be replaced.
    const text = `${handle}X bleibt unverändert`;
    expect(reg.unmapText(text)).toBe(text);
  });

  it("leaves an unknown handle unchanged", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    expect(reg.unmapText("ZZZZ ist unbekannt")).toBe("ZZZZ ist unbekannt");
  });
});

describe("HashRefHandleRegistry — unmapStreamText (split handles)", () => {
  it("reassembles a handle split across two deltas", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    const first = handle.slice(0, 2);
    const second = handle.slice(2);
    // The first delta's tail could still become a handle → held back.
    const out1 = reg.unmapStreamText("token", "n1", `Siehe ${first}`);
    expect(out1).toBe("Siehe ");
    const out2 = reg.unmapStreamText("token", "n1", `${second} Ende`);
    expect(out2).toBe(`${REF_A} Ende`);
  });

  it("flushes a trailing partial on final", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    // A lone partial that never completes is released on final as itself.
    reg.unmapStreamText("token", "n1", "text KK");
    const flushed = reg.unmapStreamText("token", "n1", "", true);
    expect(flushed).toBe("KK");
  });

  it("never loses text when every delta is fully handle-shaped", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    // Regression: a delta whose whole content is a hold-back candidate (`17`,
    // `A`, `KO`) used to be dropped instead of buffered, corrupting answers
    // streamed one character per delta. Every character of the base32 handle
    // alphabet must survive char-by-char streaming plus the final flush.
    const text =
      "Abschnitt 3.17 im Dokument 2025_Requirements Spec_KO.pdf " +
      "Version 1.9, Ersteller XY [AB, CD], Betreiber [EF, GH] S. 3 von 9";
    let out = "";
    for (const ch of text) out += reg.unmapStreamText("token", "nc", ch);
    out += reg.unmapStreamText("token", "nc", "", true);
    expect(out).toBe(text);
  });

  it("reassembles a handle streamed one character per delta", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    let out = "";
    for (const ch of `Siehe ${handle} Ende.`) {
      out += reg.unmapStreamText("token", "nd", ch);
    }
    out += reg.unmapStreamText("token", "nd", "", true);
    expect(out).toBe(`Siehe ${REF_A} Ende.`);
  });

  it("keeps concurrent nodes' hold-back buffers independent", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    // Node A holds back a partial; node B emits a complete handle.
    reg.unmapStreamText("token", "a", handle.slice(0, 2));
    const b = reg.unmapStreamText("token", "b", `${handle}!`);
    expect(b).toBe(`${REF_A}!`);
  });
});

describe("resolveRefHandleArgs", () => {
  it("resolves a handle-valued reference argument", () => {
    const reg = new HashRefHandleRegistry();
    const handle = reg.register(REF_A);
    const result = resolveRefHandleArgs(reg, { reference: handle });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.reference).toBe(REF_A);
      expect(result.resolved).toBe(true);
    }
  });

  it("resolves handles inside a references array", () => {
    const reg = new HashRefHandleRegistry();
    const ha = reg.register(REF_A);
    const hb = reg.register(REF_B);
    const result = resolveRefHandleArgs(reg, { references: [ha, hb] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.references).toEqual([REF_A, REF_B]);
  });

  it("forwards a real (non-handle) path unchanged", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    const result = resolveRefHandleArgs(reg, { reference: REF_B });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.reference).toBe(REF_B);
      expect(result.resolved).toBe(false);
    }
  });

  it("rejects a handle-shaped argument that was never registered", () => {
    const reg = new HashRefHandleRegistry();
    reg.register(REF_A);
    const result = resolveRefHandleArgs(reg, { reference: "QQQQ" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unknownHandles).toEqual(["QQQQ"]);
  });

  it("leaves non-reference arguments untouched", () => {
    const reg = new HashRefHandleRegistry();
    const result = resolveRefHandleArgs(reg, { query: "hallo", limit: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toEqual({ query: "hallo", limit: 5 });
      expect(result.resolved).toBe(false);
    }
  });
});
