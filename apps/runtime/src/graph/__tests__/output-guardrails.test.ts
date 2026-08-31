// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for output guardrails (`src/graph/output-guardrails.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  luhnValid,
  redactText,
  createOutputGuardrail,
  GuardrailStream,
  findPiiMatches,
  nerOnlyTypes,
  type GuardrailOptions,
} from "../output-guardrails.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

const allPii: GuardrailOptions = {
  redactPii: true,
  piiTypes: [],
  blockedPatterns: [],
  mode: "redact",
};

describe("luhnValid", () => {
  it("accepts a valid card and rejects an invalid one", () => {
    expect(luhnValid("4242424242424242")).toBe(true); // Stripe test Visa
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("1234")).toBe(false); // too short
  });
});

describe("redactText — PII", () => {
  it("redacts emails", () => {
    const r = redactText("contact me at jane.doe@example.com please", allPii);
    expect(r.text).toContain("[REDACTED_EMAIL]");
    expect(r.text).not.toContain("jane.doe@example.com");
    expect(r.findings.email).toBe(1);
  });

  it("redacts a Luhn-valid credit card but leaves a random number", () => {
    const ccOnly: GuardrailOptions = { ...allPii, piiTypes: ["creditCard"] };
    const card = redactText("card 4242 4242 4242 4242 ok", ccOnly);
    expect(card.text).toContain("[REDACTED_CREDITCARD]");
    const notCard = redactText("order number 1234 5678 9012 3456 ok", ccOnly);
    // Random 16-digit run is not Luhn-valid → left intact by the card detector.
    expect(notCard.text).toContain("1234 5678 9012 3456");
  });

  it("redacts IPv4, SSN and secrets", () => {
    expect(redactText("host 10.0.0.1", allPii).text).toContain(
      "[REDACTED_IPV4]",
    );
    expect(redactText("ssn 123-45-6789", allPii).text).toContain(
      "[REDACTED_SSN]",
    );
    expect(
      redactText("key sk-abcdefghijklmnopqrstuvwx done", allPii).text,
    ).toContain("[REDACTED_SECRET]");
  });

  it("respects an explicit detector subset", () => {
    const opts: GuardrailOptions = { ...allPii, piiTypes: ["email"] };
    const r = redactText("mail a@b.com ip 10.0.0.1", opts);
    expect(r.text).toContain("[REDACTED_EMAIL]");
    expect(r.text).toContain("10.0.0.1"); // ipv4 detector disabled
  });

  it("leaves clean text untouched", () => {
    const r = redactText("just a normal sentence.", allPii);
    expect(r.text).toBe("just a normal sentence.");
    expect(Object.keys(r.findings)).toHaveLength(0);
  });
});

describe("redactText — German / EU PII", () => {
  it("redacts a German IBAN", () => {
    const r = redactText("Konto: DE89370400440532013000 bitte", allPii);
    expect(r.text).toContain("[REDACTED_IBAN]");
    expect(r.text).not.toContain("DE89370400440532013000");
  });

  it("redacts a German VAT id (USt-IdNr.)", () => {
    const r = redactText("USt-IdNr DE123456789 .", allPii);
    expect(r.text).toContain("[REDACTED_EUVATID]");
    expect(r.text).not.toContain("DE123456789");
  });

  it("redacts a German tax id with a valid check digit", () => {
    const only: GuardrailOptions = { ...allPii, piiTypes: ["deTaxId"] };
    const r = redactText("Steuer-ID 86110112346 hier", only);
    expect(r.text).toContain("[REDACTED_DETAXID]");
    expect(r.text).not.toContain("86110112346");
  });

  it("leaves an 11-digit run with an invalid check digit intact", () => {
    const only: GuardrailOptions = { ...allPii, piiTypes: ["deTaxId"] };
    // 86110112340 has a wrong check digit (valid is …6).
    const r = redactText("ref 86110112340 ok", only);
    expect(r.text).toContain("86110112340");
    expect(r.findings.deTaxId).toBeUndefined();
  });

  it("redacts a German social-insurance number with a plausible date", () => {
    const only: GuardrailOptions = { ...allPii, piiTypes: ["deSocialId"] };
    const r = redactText("SVNR 65170839J003 erfasst", only);
    expect(r.text).toContain("[REDACTED_DESOCIALID]");
    expect(r.text).not.toContain("65170839J003");
  });

  it("leaves a social-id shape with an impossible date intact", () => {
    const only: GuardrailOptions = { ...allPii, piiTypes: ["deSocialId"] };
    // Day 99 is not a valid DD → not a SVNR.
    const r = redactText("code 65993999J003 ok", only);
    expect(r.text).toContain("65993999J003");
  });

  it("German detectors are part of the default 'all' set", () => {
    const r = redactText("Steuer-ID 47036892816.", allPii);
    expect(r.text).not.toContain("47036892816");
  });
});

describe("redactText — blocklist + mode", () => {
  it("redacts blocked patterns inline in redact mode", () => {
    const opts: GuardrailOptions = {
      redactPii: false,
      piiTypes: [],
      blockedPatterns: [/competitor/gi],
      mode: "redact",
    };
    const r = redactText("our Competitor is great", opts);
    expect(r.text).toContain("[REDACTED_BLOCKED]");
    expect(r.findings.blocked).toBe(1);
  });

  it("uses a single notice token in block mode", () => {
    const opts: GuardrailOptions = {
      redactPii: true,
      piiTypes: ["email"],
      blockedPatterns: [],
      mode: "block",
    };
    const r = redactText("write to a@b.com", opts);
    expect(r.text).toContain("[BLOCKED]");
    expect(r.text).not.toContain("[REDACTED_EMAIL]");
  });
});

describe("GuardrailStream", () => {
  it("scrubs PII even when split across deltas, and matches whole-text redaction", () => {
    const stream = new GuardrailStream(allPii);
    // Feed an email split mid-token, padded so the buffer exceeds the window.
    const padding = "x".repeat(400);
    let emitted = "";
    emitted += stream.push(`${padding} write to jane.`);
    emitted += stream.push("doe@example.com now ");
    emitted += stream.push(`${padding}`);
    emitted += stream.flush();
    expect(emitted).not.toContain("jane.doe@example.com");
    expect(emitted).toContain("[REDACTED_EMAIL]");
    expect(stream.getFindings().email).toBe(1);
  });

  it("does not leak a spaced credit-card number split at an internal space", () => {
    const stream = new GuardrailStream(allPii);
    const padding = "x".repeat(400);
    // A valid Luhn test card with internal spaces; feed so the cut would land
    // between the digit groups if the stream naively cut at any whitespace.
    let out = "";
    out += stream.push(`${padding} card 4111 1111`);
    out += stream.push(" 1111 1111 end ");
    out += stream.push(`${padding}`);
    out += stream.flush();
    expect(out).not.toContain("4111 1111 1111 1111");
    expect(out).toContain("[REDACTED_CREDITCARD]");
  });

  it("does not leak a spaced German tax id split across deltas", () => {
    const stream = new GuardrailStream(allPii);
    const padding = "x".repeat(400);
    // Valid MOD 11,10 tax id 86095742719, spaced as 86 095 742 719.
    let out = "";
    out += stream.push(`${padding} steuer 86 095`);
    out += stream.push(" 742 719 done ");
    out += stream.push(`${padding}`);
    out += stream.flush();
    expect(out).not.toContain("86 095 742 719");
    expect(out).toContain("[REDACTED_DETAXID]");
  });

  it("bounds memory on a whitespace-free stream via a forced cut", () => {
    const stream = new GuardrailStream({
      redactPii: false, // isolate the buffering behaviour from redaction
      piiTypes: [],
      blockedPatterns: [],
      mode: "redact",
    });
    let pushedBeforeFlush = "";
    // A long continuous run with NO whitespace — the fallback must still make
    // progress (emit) rather than buffer everything until flush.
    for (let i = 0; i < 20; i++) pushedBeforeFlush += stream.push("a".repeat(600));
    const flushed = stream.flush();
    // The forced cut fired: text was emitted DURING the stream, not all deferred.
    expect(pushedBeforeFlush.length).toBeGreaterThan(0);
    // No content lost overall.
    expect((pushedBeforeFlush + flushed).length).toBe(20 * 600);
  });

  it("emits clean text and preserves overall content", () => {
    const stream = new GuardrailStream(allPii);
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    let out = "";
    for (const word of text.split(" ")) out += stream.push(`${word} `);
    out += stream.flush();
    expect(out.replace(/\s+/g, " ").trim()).toBe(
      text.replace(/\s+/g, " ").trim(),
    );
  });
});

describe("nerOnlyTypes", () => {
  it("flags person/location/organization as having no regex detector", () => {
    expect(nerOnlyTypes(["email", "person", "location"])).toEqual([
      "person",
      "location",
    ]);
    expect(nerOnlyTypes(["email", "iban"])).toEqual([]);
  });

  it("createOutputGuardrail warns but still builds with NER-only types", () => {
    const warnings: string[] = [];
    const g = createOutputGuardrail(
      { enabled: true, piiTypes: ["person"] },
      { info: () => {}, warn: (m: string) => warnings.push(m), debug: () => {}, error: () => {} } as never,
    );
    expect(g).toBeDefined();
    expect(warnings.some((w) => w.includes("NER-only"))).toBe(true);
  });
});

describe("createOutputGuardrail", () => {
  it("returns undefined when disabled", () => {
    expect(createOutputGuardrail({ enabled: false })).toBeUndefined();
  });

  it("builds a guardrail and skips invalid blocked patterns", () => {
    const g = createOutputGuardrail({
      enabled: true,
      redactPii: true,
      blockedPatterns: ["valid", "(unclosed"],
    });
    expect(g).toBeDefined();
    if (g === undefined) throw new Error("expected the guardrail to be enabled");
    const r = g.redact("a valid email a@b.com");
    expect(r.text).toContain("[REDACTED_BLOCKED]");
    expect(r.text).toContain("[REDACTED_EMAIL]");
  });
});
describe("findPiiMatches", () => {
  it("returns spans with correct offsets for a single email", () => {
    const text = "contact jane@example.com now";
    const matches = findPiiMatches(text);
    expect(matches).toHaveLength(1);
    const match = at(matches, 0);
    expect(match.type).toBe("email");
    expect(match.value).toBe("jane@example.com");
    expect(text.slice(match.start, match.end)).toBe("jane@example.com");
  });

  it("returns multiple non-overlapping spans in left-to-right order", () => {
    const text = "email a@b.com and ip 10.0.0.1 and phone +49 30 1234567";
    const matches = findPiiMatches(text);
    const types = matches.map((m) => m.type);
    expect(types).toContain("email");
    expect(types).toContain("ipv4");
    expect(types).toContain("phone");
    // Sorted by start offset.
    for (let i = 1; i < matches.length; i++) {
      expect(at(matches, i).start).toBeGreaterThanOrEqual(at(matches, i - 1).end);
    }
  });

  it("respects an explicit type subset", () => {
    const text = "email a@b.com and ip 10.0.0.1";
    const matches = findPiiMatches(text, ["email"]);
    expect(matches).toHaveLength(1);
    expect(at(matches, 0).type).toBe("email");
  });

  it("does not double-match overlapping detectors (higher-priority wins)", () => {
    // The IBAN-shaped run must not ALSO get picked up by the phone detector.
    const text = "IBAN DE89370400440532013000 danke";
    const matches = findPiiMatches(text);
    const ibanMatches = matches.filter((m) => m.type === "iban");
    expect(ibanMatches).toHaveLength(1);
    // No other match should overlap the IBAN's span.
    const ibanMatch = at(ibanMatches, 0);
    for (const m of matches) {
      if (m.type === "iban") continue;
      const overlaps = m.start < ibanMatch.end && m.end > ibanMatch.start;
      expect(overlaps).toBe(false);
    }
  });

  it("rejects a Luhn-invalid digit run as a credit card", () => {
    const matches = findPiiMatches("order 1234 5678 9012 3456", ["creditCard"]);
    expect(matches).toHaveLength(0);
  });

  it("returns an empty array for clean text", () => {
    expect(findPiiMatches("nothing sensitive here")).toHaveLength(0);
  });
});
