// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Trace visibility for indirect prompt injection.
 *
 * The tool-output validator scans text the model did not get from the user —
 * MCP tool results and retrieved RAG chunks — for instruction-override
 * signals. A finding used to reach only the process log; this binds every
 * scan to the node that consumed the content so a finding also lands on that
 * node's debug-trace diagnostics (`indirect_prompt_injection`) and in the
 * `aiperator_indirect_injection_total` metric.
 *
 * The Search service runs its own content-trust scan on the stored text and
 * labels its responses (`injection_risk` / `content_trust`). Its signal list
 * deliberately diverges from the runtime's regex list (German phrasing,
 * chat-template tokens, concealment patterns), so a hit Search flags may pass
 * the runtime's own scan unnoticed. {@link markTaintFromSearchLabels} closes
 * that gap: a `suspected` label anywhere in a tool payload taints the run
 * exactly like a local validator finding would.
 */

import type { ExecRuntime } from "./exec-runtime.js";
import type {
  ToolOutputValidationResult,
  ToolOutputValidator,
} from "../mcp/tool-output-validator.js";

/** A validator whose findings are reported on `nodeId`'s trace. */
export function reportingValidator(
  runtime: Pick<
    ExecRuntime,
    "toolOutputValidator" | "onNodeDiagnostic" | "metrics" | "taint"
  >,
  nodeId: string,
): ToolOutputValidator | undefined {
  const validator = runtime.toolOutputValidator;
  if (validator === undefined || !validator.enabled) return undefined;
  return {
    enabled: true,
    validate(content, sourceRef): ToolOutputValidationResult {
      const result = validator.validate(content, sourceRef);
      if (result.flagged) {
        // A finding taints the rest of the run: write tools then need approval.
        runtime.taint?.mark(sourceRef);
        runtime.onNodeDiagnostic?.(nodeId, {
          level: "warn",
          code: "indirect_prompt_injection",
          message:
            `Possible prompt injection in output of ${sourceRef} ` +
            `(signals: ${result.signals.join(", ") || "unknown"}); ` +
            `${result.modifiedCount} value(s) neutralised before the model saw them.`,
        });
        runtime.metrics?.recordCounter("aiperator_indirect_injection_total", {
          source: sourceRef.startsWith("retrieval/") ? "retrieval" : "tool",
        });
      }
      return result;
    },
  };
}

/** MCP result `_meta` key under which the Gate labels tool output. */
export const GATE_CONTENT_TRUST_META_KEY = "io.atf/content-trust";
/** True when any object in `value` carries `content_trust: "untrusted"` (Search labels). */
function payloadHasUntrustedLabel(value: unknown, depth: number): boolean {
  if (depth > MAX_LABEL_SCAN_DEPTH) return false;
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
    try {
      return payloadHasUntrustedLabel(JSON.parse(trimmed), depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.some((entry) => payloadHasUntrustedLabel(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.content_trust === "untrusted") return true;
    return Object.values(record).some((nested) =>
      payloadHasUntrustedLabel(nested, depth + 1),
    );
  }
  return false;
}
function metaLabelsUntrusted(meta: unknown): boolean {
  if (meta === null || typeof meta !== "object") return false;
  const label = (meta as Record<string, unknown>)[GATE_CONTENT_TRUST_META_KEY];
  return (
    label !== null &&
    typeof label === "object" &&
    (label as Record<string, unknown>).content_trust === "untrusted"
  );
}
/**
 * `TAINT_MODE=on-untrusted-source`: taint the run when content labelled
 * untrusted reaches the model — a Search response (`content_trust: "untrusted"`
 * in the payload) or any Gate tool result (`_meta["io.atf/content-trust"]`) —
 * instead of waiting for the injection scan to find something. A no-op in the
 * default `on-finding` mode. `meta` is the MCP result `_meta`, when the client
 * passed it through.
 */
export function markTaintFromUntrustedSource(
  runtime: Pick<ExecRuntime, "onNodeDiagnostic" | "metrics" | "taint" | "taintMode">,
  nodeId: string,
  sourceRef: string,
  content: unknown,
  meta?: unknown,
): void {
  if (runtime.taintMode !== "on-untrusted-source") return;
  if (!metaLabelsUntrusted(meta) && !payloadHasUntrustedLabel(content, 0)) return;
  runtime.taint?.mark(sourceRef);
  runtime.onNodeDiagnostic?.(nodeId, {
    level: "info",
    code: "untrusted_source",
    message:
      `Content from ${sourceRef} is labelled untrusted; TAINT_MODE=on-untrusted-source ` +
      `taints the run, so write tools now require approval.`,
  });
  runtime.metrics?.recordCounter("aiperator_untrusted_source_total", {
    source: sourceRef.startsWith("retrieval/") ? "retrieval" : "tool",
  });
}
/**
 * `TAINT_MODE=on-untrusted-source`: retrieved chunks are third-party text by
 * definition — taint the run when any reach the model.
 */
export function markTaintFromRetrieval(
  runtime: Pick<ExecRuntime, "onNodeDiagnostic" | "metrics" | "taint" | "taintMode">,
  nodeId: string,
  sourceRef: string,
  chunkCount: number,
): void {
  if (runtime.taintMode !== "on-untrusted-source" || chunkCount === 0) return;
  runtime.taint?.mark(sourceRef);
  runtime.onNodeDiagnostic?.(nodeId, {
    level: "info",
    code: "untrusted_source",
    message:
      `${chunkCount} retrieved chunk(s) from ${sourceRef} reached the model; ` +
      `TAINT_MODE=on-untrusted-source taints the run, so write tools now require approval.`,
  });
  runtime.metrics?.recordCounter("aiperator_untrusted_source_total", { source: "retrieval" });
}
/** How deep the label scan walks a tool payload before giving up. */
const MAX_LABEL_SCAN_DEPTH = 12;

/**
 * True when any object in `value` carries `injection_risk: "suspected"`.
 * JSON strings are parsed and scanned too — an MCP result arrives as
 * `[{ type: "text", text: "<json>" }]`, so the labels live inside a string.
 * A document that merely quotes the label text fails towards more taint,
 * never less, which is the safe direction.
 */
function payloadHasSuspectedLabel(value: unknown, depth: number): boolean {
  if (depth > MAX_LABEL_SCAN_DEPTH) return false;
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
    try {
      return payloadHasSuspectedLabel(JSON.parse(trimmed), depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.some((entry) => payloadHasSuspectedLabel(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.injection_risk === "suspected") return true;
    return Object.values(record).some((nested) =>
      payloadHasSuspectedLabel(nested, depth + 1),
    );
  }
  return false;
}

/**
 * Taint the run when the Search service labelled a tool payload as suspected
 * injection (`injection_risk: "suspected"` anywhere in it — per-item or on
 * the response envelope). Search's signal list diverges from the runtime's
 * own regex scan by design, so trusting its verdict is what keeps the taint
 * signal alive across the Extract → Search → Gate → Runtime chain. The
 * payload is scanned as-is (before any validator redaction) and the tool
 * result itself is never modified — unlike a validator finding, this is a
 * pure trust signal, not a content rewrite.
 */
export function markTaintFromSearchLabels(
  runtime: Pick<ExecRuntime, "onNodeDiagnostic" | "metrics" | "taint">,
  nodeId: string,
  sourceRef: string,
  content: unknown,
): void {
  if (!payloadHasSuspectedLabel(content, 0)) return;
  // Same consequence as a local validator finding: the run is tainted and
  // subsequent write tools require approval.
  runtime.taint?.mark(sourceRef);
  runtime.onNodeDiagnostic?.(nodeId, {
    level: "warn",
    code: "indirect_prompt_injection",
    message:
      `Search flagged the output of ${sourceRef} as suspected prompt ` +
      `injection (injection_risk=suspected); the run is tainted and write ` +
      `tools now require approval.`,
  });
  runtime.metrics?.recordCounter("aiperator_indirect_injection_total", {
    source: "search_label",
  });
}
