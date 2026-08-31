// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { diffToolSchemas, type ToolSchemas } from "@atf/schema-compatibility";
import type { FlowDefinition } from "../types/flow.js";
import { diffFlows, type FlowDiff } from "./flow-diff.js";

export type FlowCompatibilitySeverity = "breaking" | "non-breaking" | "unknown";
export interface FlowCompatibilityFinding {
  severity: FlowCompatibilitySeverity;
  code: string;
  path: string;
  message: string;
}
export interface FlowCompatibilityReport {
  status: "compatible" | "breaking" | "unknown";
  findings: FlowCompatibilityFinding[];
  structuralDiff: FlowDiff;
}
export interface FlowCompatibilityOptions {
  toolSchemas?: Record<string, { previous?: ToolSchemas; next?: ToolSchemas }>;
}

function added(previous: readonly string[] = [], next: readonly string[] = []): string[] {
  const before = new Set(previous);
  return [...new Set(next)].filter((item) => !before.has(item)).sort();
}

function metadataWithoutVersion(
  metadata: FlowDefinition["metadata"],
): FlowDefinition["metadata"] {
  if (metadata === undefined) return undefined;
  const { version: _version, ...rest } = metadata;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

function metadataVersion(metadata: FlowDefinition["metadata"]): unknown {
  return metadata?.version;
}

export function analyzeFlowCompatibility(
  previous: FlowDefinition,
  next: FlowDefinition,
  options: FlowCompatibilityOptions = {},
): FlowCompatibilityReport {
  const structuralDiff = diffFlows(previous, next);
  const findings: FlowCompatibilityFinding[] = [];
  for (const scope of added(previous.requiredScopes, next.requiredScopes)) {
    findings.push({ severity: "breaking", code: "required-scope-added", path: "$.requiredScopes", message: `Required scope '${scope}' was added` });
  }
  for (const scope of added(next.requiredScopes, previous.requiredScopes)) {
    findings.push({ severity: "non-breaking", code: "required-scope-removed", path: "$.requiredScopes", message: `Required scope '${scope}' was removed` });
  }
  if (structuralDiff.name) findings.push({ severity: "non-breaking", code: "name-changed", path: "$.name", message: "Flow display name changed" });
  if (structuralDiff.description) findings.push({ severity: "non-breaking", code: "description-changed", path: "$.description", message: "Flow description changed" });
  if (structuralDiff.metadataChanged) {
    if (JSON.stringify(metadataVersion(previous.metadata)) !== JSON.stringify(metadataVersion(next.metadata))) {
      findings.push({ severity: "non-breaking", code: "metadata-version-changed", path: "$.metadata.version", message: "Flow metadata version changed" });
    }
    const metadataOnlyDiff = diffFlows(
      { ...previous, metadata: metadataWithoutVersion(previous.metadata) },
      { ...next, metadata: metadataWithoutVersion(next.metadata) },
    );
    if (metadataOnlyDiff.metadataChanged) {
      findings.push({ severity: "unknown", code: "metadata-changed", path: "$.metadata", message: "Flow metadata changed and requires review" });
    }
  }
  for (const id of structuralDiff.nodes.added) findings.push({ severity: "unknown", code: "node-added", path: `$.nodes.${id}`, message: `Node '${id}' was added` });
  for (const id of structuralDiff.nodes.removed) findings.push({ severity: "unknown", code: "node-removed", path: `$.nodes.${id}`, message: `Node '${id}' was removed` });
  for (const node of structuralDiff.nodes.changed) findings.push({ severity: "unknown", code: "node-changed", path: `$.nodes.${node.id}`, message: `Node '${node.id}' changed: ${node.changedFields.join(", ")}` });
  for (const key of structuralDiff.edges.added) findings.push({ severity: "unknown", code: "edge-added", path: `$.edges.${key}`, message: `Edge '${key}' was added` });
  for (const key of structuralDiff.edges.removed) findings.push({ severity: "unknown", code: "edge-removed", path: `$.edges.${key}`, message: `Edge '${key}' was removed` });
  for (const edge of structuralDiff.edges.changed) findings.push({ severity: "unknown", code: "edge-changed", path: `$.edges.${edge.key}`, message: `Edge '${edge.key}' changed: ${edge.changedFields.join(", ")}` });
  for (const [tool, snapshots] of Object.entries(options.toolSchemas ?? {})) {
    if (!snapshots.previous || !snapshots.next) {
      findings.push({ severity: "unknown", code: "tool-schema-missing", path: `$.tools.${tool}`, message: `Tool '${tool}' lacks a comparable schema snapshot` });
      continue;
    }
    const diff = diffToolSchemas(snapshots.previous, snapshots.next);
    for (const finding of diff.breaking) findings.push({ severity: "breaking", code: `tool-${finding.code}`, path: `$.tools.${tool}${finding.path.slice(1)}`, message: finding.message });
    for (const finding of diff.nonBreaking) findings.push({ severity: "non-breaking", code: `tool-${finding.code}`, path: `$.tools.${tool}${finding.path.slice(1)}`, message: finding.message });
    for (const finding of diff.unknown) findings.push({ severity: "unknown", code: `tool-${finding.code}`, path: `$.tools.${tool}${finding.path.slice(1)}`, message: finding.message });
  }
  const status = findings.some((finding) => finding.severity === "breaking")
    ? "breaking"
    : findings.some((finding) => finding.severity === "unknown")
      ? "unknown"
      : "compatible";
  return { status, findings, structuralDiff };
}
