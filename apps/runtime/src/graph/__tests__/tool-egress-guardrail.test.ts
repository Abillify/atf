// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the tool egress DLP guardrail — scrubbing/denying PII & secrets in
 * outbound tool-call arguments. Reuses the output-guardrail PII detectors.
 */

import { describe, test, expect } from "bun:test";
import {
  scrubToolArgs,
  hasFindings,
  createToolEgressGuardrail,
  type GuardrailOptions,
} from "../output-guardrails.js";

/** `createToolEgressGuardrail` for a config known to enable the guardrail. */
function mustCreateToolEgressGuardrail(
  ...args: Parameters<typeof createToolEgressGuardrail>
): NonNullable<ReturnType<typeof createToolEgressGuardrail>> {
  const g = createToolEgressGuardrail(...args);
  if (g === undefined) throw new Error("expected the guardrail to be enabled");
  return g;
}

const opts: GuardrailOptions = {
  redactPii: true,
  piiTypes: [],
  blockedPatterns: [],
  mode: "redact",
};

describe("scrubToolArgs", () => {
  test("redacts PII in string values, keeps keys", () => {
    const { args, findings } = scrubToolArgs(
      { to: "alice@example.com", count: 3 },
      opts,
    );
    expect(args.to).toBe("[REDACTED_EMAIL]");
    expect(args.count).toBe(3);
    expect(findings.email).toBe(1);
  });

  test("walks nested objects and arrays", () => {
    const { args, findings } = scrubToolArgs(
      {
        payload: {
          notes: ["call me at +1 415 555 1234", "no pii here"],
          card: "4111 1111 1111 1111",
        },
      },
      opts,
    );
    const payload = args.payload as {
      notes: string[];
      card: string;
    };
    expect(payload.notes[0]).toContain("[REDACTED_PHONE]");
    expect(payload.card).toBe("[REDACTED_CREDITCARD]");
    expect(findings.creditCard).toBe(1);
    expect(findings.phone).toBe(1);
  });

  test("does not mutate the input object", () => {
    const input = { to: "alice@example.com" };
    scrubToolArgs(input, opts);
    expect(input.to).toBe("alice@example.com");
  });

  test("leaves clean args untouched (no findings)", () => {
    const { args, findings } = scrubToolArgs({ q: "hello world" }, opts);
    expect(args.q).toBe("hello world");
    expect(hasFindings(findings)).toBe(false);
  });
});

describe("createToolEgressGuardrail", () => {
  test("returns undefined when disabled", () => {
    expect(createToolEgressGuardrail({ enabled: false })).toBeUndefined();
  });

  test("scrubs via the facade in redact mode", () => {
    const g = mustCreateToolEgressGuardrail({ enabled: true, mode: "redact" });
    expect(g.enabled).toBe(true);
    expect(g.mode).toBe("redact");
    const { args } = g.scrub({ email: "bob@example.com" });
    expect(args.email).toBe("[REDACTED_EMAIL]");
  });

  test("exposes block mode", () => {
    const g = mustCreateToolEgressGuardrail({ enabled: true, mode: "block" });
    expect(g.mode).toBe("block");
    const { findings } = g.scrub({ email: "bob@example.com" });
    expect(hasFindings(findings)).toBe(true);
  });
});

describe("scrubToolArgs — date-in-filename regression", () => {
  // Dates like "22.02.2024" in vectorsearch `reference` paths were falsely
  // matched as phone numbers by the generic phone detector, corrupting tool
  // call arguments (e.g. "Anrufprotokolle_II_22.02.2024_gesichtet.pdf" became
  // "Anrufprotokolle_II_[REDACTED_PHONE]_gesichtet.pdf").
  test("does not redact DD.MM.YYYY date in a vectorsearch reference path", () => {
    const ref =
      "/ExampleRecords/Beispielunterlagen/01_2024 geprüft/Protokoll_II_22.02.2024_geprüft.pdf";
    const { args, findings } = scrubToolArgs(
      { collection: "example-records", reference: ref },
      opts,
    );
    expect(args.reference).toBe(ref);
    expect(findings.phone).toBeUndefined();
  });

  test("does not redact YYYY-MM-DD date in a filename", () => {
    const ref = "/docs/EKG_2023-01-03.png";
    const { args, findings } = scrubToolArgs({ reference: ref }, opts);
    expect(args.reference).toBe(ref);
    expect(findings.phone).toBeUndefined();
  });

  test("still redacts a real phone number in tool args", () => {
    const { args, findings } = scrubToolArgs(
      { notes: "Rückruf: +49 89 12345678" },
      opts,
    );
    expect(args.notes).toContain("[REDACTED_PHONE]");
    expect(findings.phone).toBe(1);
  });
});
