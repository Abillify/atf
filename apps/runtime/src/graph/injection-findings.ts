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
 */

import type { ExecRuntime } from "./exec-runtime.js";
import type {
  ToolOutputValidationResult,
  ToolOutputValidator,
} from "../mcp/tool-output-validator.js";

/** A validator whose findings are reported on `nodeId`'s trace. */
export function reportingValidator(
  runtime: Pick<ExecRuntime, "toolOutputValidator" | "onNodeDiagnostic" | "metrics">,
  nodeId: string,
): ToolOutputValidator | undefined {
  const validator = runtime.toolOutputValidator;
  if (validator === undefined || !validator.enabled) return undefined;
  return {
    enabled: true,
    validate(content, sourceRef): ToolOutputValidationResult {
      const result = validator.validate(content, sourceRef);
      if (result.flagged) {
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
