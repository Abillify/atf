// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Coverage evidence for a worker with `config.refHandles`.
 *
 * Such a worker sees short handles (`K3NQ`) instead of real references in every
 * tool result and passes handles back in its tool-call args. The coverage
 * ledger keys documents by the REAL reference, so before this fix a masked
 * `get_document` result never matched the assigned ref and no window evidence
 * was recorded — every `reviewed` decision was rejected and the queue stalled.
 * These tests pin the back-translation: evidence, search hits and the
 * acceptance of a coverage report all use real references.
 */

import { describe, expect, test } from "bun:test";
import {
  applyCoverageReport,
  isCoverageTerminal,
  mergeCoverageEvidence,
  nextCoverageAssignment,
  parseCoverageReport,
  seedCoverageLedger,
  type CoverageAssignment,
  type CoverageDocumentEvidence,
  type CoverageSearchEvidence,
  type CoverageSearchParseResult,
} from "../agent-harness/coverage.js";
import {
  renderCoverageAssignmentForWorker,
  withCoverageEvidenceRuntime,
} from "../agent-harness/loop-coverage-runtime.js";
import type { ExecRuntime } from "../graph-engine.js";
import { HashRefHandleRegistry, resolveRefHandleArgs } from "../ref-handles.js";

const R =
  "/20250516_Pflichtenheft WMS_Prozesse/20250516_Pflichtenheft WMS_Prozesse.pdf/73. 9.5 Lagereinheit prüfen";
const R2 =
  "/20250516_Pflichtenheft WMS_Prozesse/20250516_Pflichtenheft WMS_Prozesse.pdf/74. 9.6 Umlagerung";
const MODIFIED = "2026-08-21T10:00:00.000Z";

/** Real document text that quotes its own reference (masking shortens it). */
const REAL_TEXT = `Kapitel siehe ${R} — Lagereinheit pruefen. NIOB bleibt NIOB.`;

function fakeRuntime(): ExecRuntime {
  const noop = async (): Promise<void> => {};
  return {
    onToolCall: noop,
    onToolEffectiveArgs: noop,
    onToolResult: noop,
    onToolError: noop,
    onToolTraceMetadata: () => {},
  } as unknown as ExecRuntime;
}

function originalAssignment(): CoverageAssignment {
  return {
    id: "cov-1",
    mode: "original",
    documents: [{ ref: R, title: "9.5", summary: "Lagereinheit", windows: [] }],
  };
}

/** The masked get_document payload the model (and the stream) sees. */
function maskedDocumentResult(registry: HashRefHandleRegistry): unknown {
  const real = [
    {
      type: "text",
      text: JSON.stringify({
        reference: R,
        content: REAL_TEXT,
        totalChars: REAL_TEXT.length,
        modified: MODIFIED,
      }),
    },
  ];
  registry.registerFromPayload(real);
  return registry.maskContent(real);
}

function collect(
  registry: HashRefHandleRegistry | undefined,
  assignment: CoverageAssignment = originalAssignment(),
): {
  runtime: ExecRuntime;
  evidence: CoverageDocumentEvidence[];
  searchEvidence: CoverageSearchEvidence[];
  statuses: CoverageSearchParseResult["status"][];
} {
  const evidence: CoverageDocumentEvidence[] = [];
  const searchEvidence: CoverageSearchEvidence[] = [];
  const statuses: CoverageSearchParseResult["status"][] = [];
  const runtime = withCoverageEvidenceRuntime(
    fakeRuntime(),
    assignment,
    evidence,
    searchEvidence,
    statuses,
    undefined,
    registry,
  );
  return { runtime, evidence, searchEvidence, statuses };
}

describe("withCoverageEvidenceRuntime — refHandles worker", () => {
  test("records window evidence on the real ref with the full window", async () => {
    const registry = new HashRefHandleRegistry();
    const handle = registry.register(R);
    const masked = maskedDocumentResult(registry);
    expect(JSON.stringify(masked)).not.toContain(R);

    const { runtime, evidence } = collect(registry);
    await runtime.onToolCall("c1", "vectorsearch__get_document", JSON.stringify({ reference: handle }));
    await runtime.onToolEffectiveArgs?.(
      "c1",
      "vectorsearch__get_document",
      JSON.stringify({ reference: R, offset: 0 }),
    );
    await runtime.onToolResult("c1", masked, 0);

    expect(evidence).toEqual([
      {
        ref: R,
        totalChars: REAL_TEXT.length,
        windows: [{ offset: 0, end: REAL_TEXT.length }],
        modified: MODIFIED,
      },
    ]);
  });

  test("without the registry the masked result yields no evidence (the original defect)", async () => {
    const registry = new HashRefHandleRegistry();
    registry.register(R);
    const masked = maskedDocumentResult(registry);
    const { runtime, evidence } = collect(undefined);
    await runtime.onToolEffectiveArgs?.(
      "c1",
      "vectorsearch__get_document",
      JSON.stringify({ reference: R, offset: 0 }),
    );
    await runtime.onToolResult("c1", masked, 0);
    expect(evidence).toEqual([]);
  });

  test("resolves a handle in model-only args (no effective args reported)", async () => {
    const registry = new HashRefHandleRegistry();
    const handle = registry.register(R);
    const masked = maskedDocumentResult(registry);
    const { runtime, evidence } = collect(registry);
    await runtime.onToolCall("c1", "vectorsearch__get_document", JSON.stringify({ reference: handle }));
    await runtime.onToolResult("c1", masked, 0);
    expect(evidence[0]?.ref).toBe(R);
    expect(evidence[0]?.windows).toEqual([{ offset: 0, end: REAL_TEXT.length }]);
  });

  test("records search hits with real refs, not handles", async () => {
    const registry = new HashRefHandleRegistry();
    const real = {
      results: [
        { base_ref: R, score: 0.9, group_members: [R2] },
        { reference: R2, score: 0.5 },
      ],
      rerank: { requested: true, applied: true, complete: true },
      score_kind: "rerank",
      count: 2,
    };
    registry.registerFromPayload(real);
    const masked = registry.maskContent(real);
    const discovery: CoverageAssignment = { id: "disc-1", mode: "discovery", documents: [] };
    const { runtime, searchEvidence, statuses } = collect(registry, discovery);
    await runtime.onToolEffectiveArgs?.(
      "s1",
      "vectorsearch__search",
      JSON.stringify({ query: "Lagereinheit", hybrid: true, group_by_document: true, rerank: true }),
    );
    await runtime.onToolResult("s1", masked, 0);
    expect(statuses).toEqual(["parsed"]);
    expect(searchEvidence[0]?.resultRefs).toEqual([R, R2]);
    for (const hit of searchEvidence[0]?.hits ?? []) {
      expect(hit.ref).not.toMatch(/^[A-Z2-7]{4}(~\d+)?$/);
    }
  });

  test("leaves an unregistered handle-shaped term in the text untouched", () => {
    const registry = new HashRefHandleRegistry();
    registry.register(R);
    expect(registry.resolve("NIOB")).toBeUndefined();
    expect(registry.unmapText(registry.maskText(REAL_TEXT))).toBe(REAL_TEXT);
  });
});

describe("coverage acceptance with refHandles", () => {
  const config = {
    enabled: true,
    sourceTool: "vectorsearch/get_summaries",
    batchSize: 2,
    maxOriginalsPerBatch: 1,
    assignmentCharBudget: 1000,
    documentWindowChars: 1000,
    markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
  } as const;

  test("a reviewed report is accepted from handle-masked windows", async () => {
    let ledger = seedCoverageLedger(
      [
        {
          tool_call_id: "seed",
          tool_name: config.sourceTool,
          result: {
            summaries: [{ reference: R, title: "9.5", summary: "Lagereinheit" }],
            count: 1,
            total: 1,
          },
          execution_time_seconds: 0,
        },
      ],
      config.sourceTool,
    );
    const triage = nextCoverageAssignment(ledger, config);
    if (triage === undefined) throw new Error("missing triage assignment");
    const triageReport = parseCoverageReport(
      `<COVERAGE>{"assignmentId":"${triage.id}","documents":[{"ref":${JSON.stringify(R)},"decision":"relevant","reason":"Lagereinheit"}]}</COVERAGE>`,
      triage,
      config.markers,
    );
    if (triageReport === undefined) throw new Error("missing triage report");
    ledger = applyCoverageReport(ledger, triage, triageReport.report).ledger;
    const original = nextCoverageAssignment(ledger, config);
    if (original === undefined) throw new Error("missing original assignment");
    expect(original.mode).toBe("original");

    const registry = new HashRefHandleRegistry();
    const masked = maskedDocumentResult(registry);
    const { runtime, evidence } = collect(registry, original);
    await runtime.onToolCall(
      "c1",
      "vectorsearch__get_document",
      JSON.stringify({ reference: registry.register(R) }),
    );
    await runtime.onToolResult("c1", masked, 0);
    ledger = mergeCoverageEvidence(ledger, evidence);

    // The worker's reply is unmapped before parsing, so the report names R.
    const report = parseCoverageReport(
      `<COVERAGE>{"assignmentId":"${original.id}","documents":[{"ref":${JSON.stringify(R)},"decision":"reviewed","reason":"vollstaendig gelesen"}]}</COVERAGE>`,
      original,
      config.markers,
    );
    if (report === undefined) throw new Error("missing original report");
    const accepted = applyCoverageReport(ledger, original, report.report);
    expect(accepted.rejectedRefs).toEqual([]);
    expect(isCoverageTerminal(accepted.ledger)).toBe(true);
  });
});

describe("renderCoverageAssignmentForWorker", () => {
  test("shows handles for assigned refs and keeps them acceptable to the strict check", () => {
    const registry = new HashRefHandleRegistry();
    const text = `1. REF: ${R}\nTITLE: 9.5`;
    const rendered = renderCoverageAssignmentForWorker(text, originalAssignment(), registry);
    const handle = registry.list().find((info) => info.ref === R)?.handle;
    expect(handle).toBeDefined();
    expect(rendered).toBe(`1. REF: ${handle ?? ""}\nTITLE: 9.5`);
    expect(registry.resolve(handle ?? "")).toBe(R);
    expect(resolveRefHandleArgs(registry, { reference: R }, { strict: true }).ok).toBe(true);
  });

  test("returns the text unchanged without a registry", () => {
    const text = `1. REF: ${R}`;
    expect(renderCoverageAssignmentForWorker(text, originalAssignment())).toBe(text);
  });
});
