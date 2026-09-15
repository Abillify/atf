// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the coverage-report gate and its defect description
 * (`parseCoverageReport` / `describeCoverageReportDefect`).
 *
 * The gate is intentionally strict: a coverage report is the only input that
 * moves a document out of the review queue, so a half-parsed one is worse than
 * none. What used to be missing is the WHY — every rejection looked identical in
 * the trace. These tests pin both halves: that each malformed report is still
 * rejected, and that the description names the rule that was violated.
 */

import { describe, test, expect } from "bun:test";
import {
  describeCoverageReportDefect,
  parseCoverageReport,
  type CoverageAssignment,
  type CoverageReportMarkers,
} from "../agent-harness/coverage.js";

const markers: CoverageReportMarkers = {
  start: "<<<COVERAGE_REPORT>>>",
  end: "<<<END_COVERAGE_REPORT>>>",
};

function summaryAssignment(
  refs: readonly string[] = ["/a.md", "/b.md"],
): CoverageAssignment {
  return {
    id: "coverage-1",
    mode: "summary",
    documents: refs.map((ref) => ({
      ref,
      title: ref,
      summary: "Kurzfassung",
      windows: [],
    })),
  };
}

function originalAssignment(
  refs: readonly string[] = ["/a.md"],
): CoverageAssignment {
  return {
    id: "coverage-1",
    mode: "original",
    documents: refs.map((ref) => ({
      ref,
      title: ref,
      summary: "Kurzfassung",
      totalChars: 500,
      windows: [{ offset: 0, end: 500 }],
    })),
  };
}

/** Wraps a report payload in the markers, optionally with text before/after. */
function wrapped(
  payload: unknown,
  options?: { before?: string; after?: string; raw?: string },
): string {
  const body = options?.raw ?? JSON.stringify(payload);
  return `${options?.before ?? ""}${markers.start}${body}${markers.end}${options?.after ?? ""}`;
}

const validSummary = {
  assignmentId: "coverage-1",
  documents: [
    { ref: "/a.md", decision: "relevant", reason: "enthält Rechnungen" },
    { ref: "/b.md", decision: "excluded", reason: "nur Ferienpläne" },
  ],
};

describe("parseCoverageReport", () => {
  test("accepts a well-formed summary report", () => {
    const parsed = parseCoverageReport(
      wrapped(validSummary, { before: "Ich habe beide Dokumente geprüft.\n" }),
      summaryAssignment(),
      markers,
    );
    expect(parsed).toBeDefined();
    expect(parsed?.report.documents.map((d) => d.ref)).toEqual([
      "/a.md",
      "/b.md",
    ]);
    // Everything before the markers stays available as the task's finding text.
    expect(parsed?.findingText).toContain("geprüft");
  });

  test("rejects a report that is not the last thing in the answer", () => {
    expect(
      parseCoverageReport(
        wrapped(validSummary, { after: "\nSoll ich weitermachen?" }),
        summaryAssignment(),
        markers,
      ),
    ).toBeUndefined();
  });

  test("rejects a report addressed to another assignment", () => {
    expect(
      parseCoverageReport(
        wrapped({ ...validSummary, assignmentId: "coverage-9" }),
        summaryAssignment(),
        markers,
      ),
    ).toBeUndefined();
  });
});

describe("describeCoverageReportDefect", () => {
  /** Asserts both halves of the contract for one malformed answer. */
  const expectRejectedWith = (
    text: string,
    assignment: CoverageAssignment,
    code: string,
  ) => {
    expect(
      parseCoverageReport(text, assignment, markers),
      "the gate must reject it",
    ).toBeUndefined();
    expect(describeCoverageReportDefect(text, assignment, markers)).toBe(code);
  };

  test("a valid report is described as such (no false alarm)", () => {
    expect(
      describeCoverageReportDefect(
        wrapped(validSummary),
        summaryAssignment(),
        markers,
      ),
    ).toBe("accepted_on_recheck");
  });

  test("names a missing marker pair", () => {
    expectRejectedWith(
      "Ich habe die Dokumente geprüft, hier meine Einschätzung.",
      summaryAssignment(),
      "missing_start_marker",
    );
  });

  test("names a repeated report (the multi-interim-answer failure)", () => {
    const twice = `${wrapped(validSummary)}\n${wrapped(validSummary)}`;
    expectRejectedWith(twice, summaryAssignment(), "invalid_marker_count");
  });

  test("names text after the end marker", () => {
    expectRejectedWith(
      wrapped(validSummary, { after: "\nNoch Fragen?" }),
      summaryAssignment(),
      "trailing_content",
    );
  });

  test("names malformed JSON", () => {
    expectRejectedWith(
      wrapped(null, {
        raw: '{"assignmentId": "coverage-1", "documents": [',
      }),
      summaryAssignment(),
      "invalid_json",
    );
  });

  test("names extra keys on the report object", () => {
    expectRejectedWith(
      wrapped({ ...validSummary, note: "hoppla" }),
      summaryAssignment(),
      "invalid_report_keys",
    );
  });

  test("names a stale assignment id", () => {
    expectRejectedWith(
      wrapped({ ...validSummary, assignmentId: "coverage-9" }),
      summaryAssignment(),
      "assignment_id_mismatch",
    );
  });

  test("names an empty document list", () => {
    expectRejectedWith(
      wrapped({ assignmentId: "coverage-1", documents: [] }),
      summaryAssignment(),
      "empty_documents",
    );
  });

  test("names a document that was never assigned", () => {
    expectRejectedWith(
      wrapped({
        assignmentId: "coverage-1",
        documents: [
          { ref: "/c.md", decision: "relevant", reason: "Rechnungen" },
        ],
      }),
      summaryAssignment(),
      "unassigned_ref_at_0",
    );
  });

  test("names a duplicated ref", () => {
    expectRejectedWith(
      wrapped({
        assignmentId: "coverage-1",
        documents: [
          { ref: "/a.md", decision: "relevant", reason: "Rechnungen" },
          { ref: "/a.md", decision: "excluded", reason: "doch nicht" },
        ],
      }),
      summaryAssignment(),
      "duplicate_ref_at_1",
    );
  });

  test("names a decision that belongs to the other assignment mode", () => {
    // "reviewed" is an original-analysis verdict; a summary triage may not use it.
    expectRejectedWith(
      wrapped({
        assignmentId: "coverage-1",
        documents: [{ ref: "/a.md", decision: "reviewed", reason: "gelesen" }],
      }),
      summaryAssignment(),
      "invalid_decision_at_0",
    );
  });

  test("names discovery fields on a summary assignment", () => {
    expectRejectedWith(
      wrapped({
        assignmentId: "coverage-1",
        documents: [
          {
            ref: "/a.md",
            decision: "relevant",
            reason: "Rechnungen",
            discoveredEntities: ["Firma X"],
          },
        ],
      }),
      summaryAssignment(),
      "discovery_fields_not_allowed_at_0",
    );
  });

  test("names an empty reason", () => {
    expectRejectedWith(
      wrapped({
        assignmentId: "coverage-1",
        documents: [{ ref: "/a.md", decision: "relevant", reason: "   " }],
      }),
      summaryAssignment(),
      "empty_reason_at_0",
    );
  });

  test("names an unknown key inside a document entry", () => {
    expectRejectedWith(
      wrapped({
        assignmentId: "coverage-1",
        documents: [
          {
            ref: "/a.md",
            decision: "relevant",
            reason: "Rechnungen",
            confidence: 0.9,
          },
        ],
      }),
      summaryAssignment(),
      "unknown_document_keys_at_0",
    );
  });

  test("does not echo model-controlled values into a defect code", () => {
    const secret = "sk-secret-canary";
    const endpoint = "https://private.internal/provider";
    const text = wrapped({
      assignmentId: secret,
      documents: [
        {
          ref: endpoint,
          decision: secret,
          reason: "invalid",
          [endpoint]: true,
        },
      ],
    });
    const defect = describeCoverageReportDefect(
      text,
      summaryAssignment([endpoint]),
      markers,
    );
    expect(defect).toBe("assignment_id_mismatch");
    expect(defect).not.toContain(secret);
    expect(defect).not.toContain(endpoint);
  });

  test("accepts discovery fields on an original assignment", () => {
    const text = wrapped({
      assignmentId: "coverage-1",
      documents: [
        {
          ref: "/a.md",
          decision: "reviewed",
          reason: "vollständig gelesen",
          discoveredEntities: ["Rechnung 2024-118"],
        },
      ],
    });
    expect(parseCoverageReport(text, originalAssignment(), markers)).toBeDefined();
  });
});
