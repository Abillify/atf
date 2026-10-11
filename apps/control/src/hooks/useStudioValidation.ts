"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Inline validation of the Studio builder (Req 9.3, Task 13.4): debounced
 * dry run against POST /flows/validate and mapping the messages to
 * nodes/edges. Split out of `components/StudioBuilder.tsx` without
 * behavior change.
 */

import { useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import type { NodeValidationState, EdgeValidationState } from "../components/FlowCanvas";
import {
  graphToFlow,
  parseValidationPath,
  type RFEdge,
  type RFNode,
  type ViewportState,
} from "../lib/flow-graph";
import { validateFlowOnBackend } from "../lib/studio-flow-api";
import type { FlowDefinition, FlowValidationReport } from "../types/flow";

/** Validator message for a tool no connected MCP server offers. */
const UNKNOWN_TOOL_RE =
  /^tool "([^"]+)" is not known to any connected MCP server$/;

export interface UseStudioValidationParams {
  base: FlowDefinition;
  nodes: RFNode[];
  edges: RFEdge[];
  viewport: ViewportState | undefined;
  token: string | null | undefined;
  validation: FlowValidationReport | null;
  setValidation: Dispatch<SetStateAction<FlowValidationReport | null>>;
}

export function useStudioValidation({
  base,
  nodes,
  edges,
  viewport,
  token,
  validation,
  setValidation,
}: UseStudioValidationParams): {
  nodeValidation: Map<string, NodeValidationState>;
  edgeValidation: Map<string, EdgeValidationState>;
  otherWarnings: FlowValidationReport["warnings"];
  unknownToolsByServer: Map<string, Set<string>>;
  totalErrors: number;
  totalWarnings: number;
} {
  // -------------------------------------------------------------------------
  // Inline validation — debounced dry-run against POST /flows/validate.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const def = graphToFlow(base, nodes, edges, viewport);
    const t = setTimeout(() => {
      validateFlowOnBackend(token ?? null, def).then((report) => {
        if (report) setValidation(report);
      });
    }, 500);
    return () => clearTimeout(t);
  }, [base, nodes, edges, viewport, token, setValidation]);

  const { nodeValidation, edgeValidation } = useMemo(() => {
    const nodeMap = new Map<string, NodeValidationState>();
    const edgeMap = new Map<string, EdgeValidationState>();

    const add = (
      map: Map<string, NodeValidationState | EdgeValidationState>,
      id: string,
      message: string,
      level: "errors" | "warnings",
    ): void => {
      const entry = map.get(id) ?? { errors: [], warnings: [] };
      entry[level].push(message);
      map.set(id, entry);
    };

    if (validation) {
      for (const [issues, level] of [
        [validation.errors, "errors"] as const,
        [validation.warnings, "warnings"] as const,
      ]) {
        for (const issue of issues) {
          // Unknown MCP tools are reported per server below instead of
          // ringing every node that uses a server this runtime can't reach.
          if (level === "warnings" && UNKNOWN_TOOL_RE.test(issue.message))
            continue;
          const parsed = parseValidationPath(issue.path, edges);
          if (parsed.kind === "node" && parsed.id) {
            add(nodeMap, parsed.id, issue.message, level);
          } else if (parsed.kind === "edge" && parsed.id) {
            add(edgeMap, parsed.id, issue.message, level);
          }
          // "global" issues (e.g. cycle detection, top-level schema errors)
          // have no node/edge to highlight — they still show up in the raw
          // errors/warnings list rendered in the Problems panel below.
        }
      }
    }
    return { nodeValidation: nodeMap, edgeValidation: edgeMap };
  }, [validation, edges]);

  const { otherWarnings, unknownToolsByServer } = useMemo(() => {
    const byServer = new Map<string, Set<string>>();
    const others: FlowValidationReport["warnings"] = [];
    for (const w of validation?.warnings ?? []) {
      const m = UNKNOWN_TOOL_RE.exec(w.message);
      if (!m) {
        others.push(w);
        continue;
      }
      const tool = m[1]!;
      const server = tool.includes("/")
        ? tool.slice(0, tool.indexOf("/"))
        : "(no server prefix)";
      const set = byServer.get(server) ?? new Set<string>();
      set.add(tool);
      byServer.set(server, set);
    }
    return { otherWarnings: others, unknownToolsByServer: byServer };
  }, [validation]);

  const totalErrors = validation?.errors.length ?? 0;
  const totalWarnings = otherWarnings.length;

  return {
    nodeValidation,
    edgeValidation,
    otherWarnings,
    unknownToolsByServer,
    totalErrors,
    totalWarnings,
  };
}
