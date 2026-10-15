// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Revision identity of a loaded flow, reported in the debug trace.
 *
 * `metadata.version` is declared by a human and can be forgotten or reused.
 * `flow_digest` is computed from the definition the runtime actually executes
 * (prompt files, sub-flows and model shortcuts already expanded), so two
 * traces with the same digest ran identical flow logic, whatever the declared
 * version says. `subflow_versions` lists the sub-flow files merged into the
 * flow with the version each declares.
 */
import { createHash } from "node:crypto";
import { canonicalizeForBundleHash } from "../observability/evidence-bundle.js";
import type { FlowDefinition } from "../types/flow.js";
import type { DebugSubflowVersion } from "../types/debug-trace.js";

/** Metadata that never changes behaviour (layout, prose) or is load-time bookkeeping. */
const NON_BEHAVIOURAL_METADATA = new Set([
  "ui",
  "changelog",
  "$includeOrigins",
  "$includeEdgeOrigins",
  "$subflowVersions",
]);

/** Load-time bookkeeping key holding `relPath -> declared sub-flow version`. */
export const SUBFLOW_VERSIONS_KEY = "$subflowVersions";

/** `sha256:<hex>` over the canonical form of the executed flow definition. */
export function computeFlowDigest(flow: FlowDefinition): string {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flow.metadata ?? {})) {
    if (!NON_BEHAVIOURAL_METADATA.has(key)) metadata[key] = value;
  }
  const canonical = canonicalizeForBundleHash({ ...flow, metadata });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Sub-flow files merged into the flow, with the version each declares (null = none). */
export function subflowVersionsOf(flow: FlowDefinition): DebugSubflowVersion[] {
  const raw = (flow.metadata as Record<string, unknown> | undefined)?.[
    SUBFLOW_VERSIONS_KEY
  ];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .map(([path, version]) => ({
      path,
      version: typeof version === "string" ? version : null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
