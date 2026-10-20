// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * TAINT_MODE=on-untrusted-source (P1-Q1).
 *
 * Default (`on-finding`): the run is tainted only after the injection scan
 * flags something. With `on-untrusted-source` it is tainted as soon as content
 * labelled untrusted reaches the model — a Search response, a Gate tool result
 * (`_meta["io.atf/content-trust"]`) or a retrieved chunk — so write tools then
 * need approval after ANY read of external content.
 */
import { describe, expect, test } from "bun:test";
import {
  GATE_CONTENT_TRUST_META_KEY,
  markTaintFromRetrieval,
  markTaintFromUntrustedSource,
} from "../injection-findings.js";
import { createExecutionTaint } from "../execution-taint.js";
import { loadConfig } from "../../config/index.js";

function runtimeWith(mode: "on-untrusted-source" | undefined) {
  const diagnostics: Array<{ code?: string; level?: string }> = [];
  const counters: Array<{ name: string; labels?: Record<string, string> }> = [];
  const taint = createExecutionTaint();
  const runtime = {
    taint,
    ...(mode !== undefined ? { taintMode: mode } : {}),
    onNodeDiagnostic: (_id: string, d: { code?: string; level?: string }) => diagnostics.push(d),
    metrics: { recordCounter: (name: string, labels?: Record<string, string>) => counters.push({ name, labels }) },
  } as never;
  return { runtime, taint, diagnostics, counters };
}

const gateLabel = { [GATE_CONTENT_TRUST_META_KEY]: { content_trust: "untrusted", source: "database" } };

describe("markTaintFromUntrustedSource", () => {
  test("is a no-op in the default on-finding mode", () => {
    const { runtime, taint } = runtimeWith(undefined);
    markTaintFromUntrustedSource(runtime, "n", "gate/my_orders", "text", gateLabel);
    markTaintFromUntrustedSource(runtime, "n", "vectorsearch/search", { content_trust: "untrusted" });
    expect(taint.tainted).toBe(false);
  });

  test("a Gate _meta label taints the run on arrival", () => {
    const { runtime, taint, diagnostics, counters } = runtimeWith("on-untrusted-source");
    markTaintFromUntrustedSource(runtime, "n", "gate/my_orders", "rows", gateLabel);
    expect(taint.tainted).toBe(true);
    expect(taint.sources).toEqual(["gate/my_orders"]);
    expect(diagnostics[0]?.code).toBe("untrusted_source");
    expect(counters).toEqual([{ name: "aiperator_untrusted_source_total", labels: { source: "tool" } }]);
  });

  test("a Search content_trust label anywhere in the payload (also inside the MCP text wrapper) taints it", () => {
    const direct = runtimeWith("on-untrusted-source");
    markTaintFromUntrustedSource(direct.runtime, "n", "vectorsearch/search", {
      results: [{ content_trust: "untrusted", injection_risk: "none" }],
    });
    expect(direct.taint.tainted).toBe(true);
    const wrapped = runtimeWith("on-untrusted-source");
    markTaintFromUntrustedSource(wrapped.runtime, "n", "vectorsearch/get_document", [
      { type: "text", text: JSON.stringify({ content_trust: "untrusted", text: "hello" }) },
    ]);
    expect(wrapped.taint.tainted).toBe(true);
  });

  test("an unlabelled result, or a label that is not 'untrusted', does not taint", () => {
    const { runtime, taint } = runtimeWith("on-untrusted-source");
    markTaintFromUntrustedSource(runtime, "n", "gate/x", "plain text", undefined);
    markTaintFromUntrustedSource(runtime, "n", "gate/x", "plain text", { [GATE_CONTENT_TRUST_META_KEY]: { content_trust: "trusted" } });
    markTaintFromUntrustedSource(runtime, "n", "gate/x", { content_trust: "trusted" }, { other: 1 });
    expect(taint.tainted).toBe(false);
  });
});

describe("markTaintFromRetrieval", () => {
  test("retrieved chunks taint the run only in on-untrusted-source mode and only when there are some", () => {
    const off = runtimeWith(undefined);
    markTaintFromRetrieval(off.runtime, "n", "retrieval/kb", 3);
    expect(off.taint.tainted).toBe(false);
    const empty = runtimeWith("on-untrusted-source");
    markTaintFromRetrieval(empty.runtime, "n", "retrieval/kb", 0);
    expect(empty.taint.tainted).toBe(false);
    const on = runtimeWith("on-untrusted-source");
    markTaintFromRetrieval(on.runtime, "n", "retrieval/kb", 3);
    expect(on.taint.sources).toEqual(["retrieval/kb"]);
    expect(on.counters[0]?.labels).toEqual({ source: "retrieval" });
  });
});

describe("TAINT_MODE configuration", () => {
  test("defaults to on-finding and accepts on-untrusted-source", () => {
    const saved = process.env.TAINT_MODE;
    try {
      delete process.env.TAINT_MODE;
      expect(loadConfig().taintMode).toBe("on-finding");
      process.env.TAINT_MODE = "on-untrusted-source";
      expect(loadConfig().taintMode).toBe("on-untrusted-source");
    } finally {
      if (saved === undefined) delete process.env.TAINT_MODE;
      else process.env.TAINT_MODE = saved;
    }
  });
});
