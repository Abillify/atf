// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { evaluatePiiRecall, formatPiiRecallReport, parsePiiRecallDataset, type PiiRecallDataset } from "../pii-recall.js";

const dataset: PiiRecallDataset = {
  name: "t",
  cases: [
    { id: "1", text: "mail jane.doe@example.com now", expected: [{ type: "email", value: "jane.doe@example.com" }] },
    { id: "2", text: "iban DE89370400440532013000 ok", expected: [{ type: "iban", value: "DE89370400440532013000" }] },
    { id: "3", text: "account holder Klaus Müller", expected: [{ type: "person", value: "Klaus Müller" }] },
  ],
};

describe("evaluatePiiRecall (regex default)", () => {
  it("detects structured PII and flags the undetectable name as a miss", () => {
    const report = evaluatePiiRecall(dataset);
    const email = report.byType.find((value) => value.type === "email");
    const iban = report.byType.find((value) => value.type === "iban");
    const person = report.byType.find((value) => value.type === "person");
    if (email === undefined || iban === undefined || person === undefined) throw new Error("expected email, iban and person entries");
    expect(email.recall).toBe(1);
    expect(iban.recall).toBe(1);
    expect(person.recall).toBe(0);
    expect(person.falseNegatives).toBe(1);
    expect(report.misses.some((miss) => miss.type === "person")).toBe(true);
    expect(report.overall.recall).toBeCloseTo(2 / 3, 2);
  });
  it("reaches full recall when an NER detector is injected", () => {
    const report = evaluatePiiRecall(dataset, (text) => {
      const spans = [];
      if (text.includes("jane.doe@example.com")) spans.push({ type: "email" as const, value: "jane.doe@example.com" });
      if (text.includes("DE89370400440532013000")) spans.push({ type: "iban" as const, value: "DE89370400440532013000" });
      if (text.includes("Klaus Müller")) spans.push({ type: "person" as const, value: "Klaus Müller" });
      return spans;
    });
    expect(report.overall.recall).toBe(1);
    expect(report.misses).toHaveLength(0);
  });
  it("counts a spurious detection as a false positive (precision)", () => {
    const report = evaluatePiiRecall(
      { name: "t", cases: [{ id: "1", text: "no pii", expected: [] }] },
      () => [{ type: "email", value: "ghost@x.com" }],
    );
    const email = report.byType.find((value) => value.type === "email");
    if (email === undefined) throw new Error("expected an email entry");
    expect(email.falsePositives).toBe(1);
    expect(report.overall.precision).toBe(0);
  });
});

describe("parsePiiRecallDataset", () => {
  it("parses a valid dataset and rejects malformed input", () => {
    const parsed = parsePiiRecallDataset({ name: "x", cases: [{ id: "a", text: "hi", expected: [{ type: "email", value: "a@b.co" }] }] });
    expect(parsed?.cases).toHaveLength(1);
    expect(parsePiiRecallDataset(null)).toBeUndefined();
    expect(parsePiiRecallDataset({ cases: "no" })).toBeUndefined();
  });
  it("renders a human-readable report", () => {
    const markdown = formatPiiRecallReport(evaluatePiiRecall(dataset));
    expect(markdown).toContain("DLP effectiveness");
    expect(markdown).toContain("recall");
  });
});
