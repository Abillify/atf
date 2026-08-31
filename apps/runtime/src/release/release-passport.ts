// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { PolicyEvalResult } from "../compliance/policy-evaluator.js";
import type { FlowDefinition } from "../types/flow.js";
import type { FlowCompatibilityReport } from "../graph/flow-compatibility.js";
import type { FlowCapabilityDescriptor } from "../graph/flow-capabilities.js";

export interface ReleasePassport {
  schemaVersion: "1";
  generatedAt: string;
  flow: { id: string; name: string; source: "file" | "online"; storeVersion?: number; semanticVersion?: string };
  assessment: "clear" | "blocked" | "review" | "insufficient-evidence";
  reasons: string[];
  compatibility: FlowCompatibilityReport | { status: "unknown"; findings: []; structuralDiff?: undefined };
  policy: PolicyEvalResult;
  capabilities: FlowCapabilityDescriptor;
  eval: { status: "missing" | "unbound" | "passed" | "failed" };
  canary: { status: "not-configured" | "not-version-bound" | "active" | "rolled-back" };
  evidence: { dossierUrl: string; diffUrl?: string };
}

export function readSemanticVersion(metadata: FlowDefinition["metadata"]): string | undefined {
  const value = metadata?.version;
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
    ? value
    : undefined;
}

export function buildReleasePassport(input: {
  flow: FlowDefinition;
  source: "file" | "online";
  storeVersion?: number;
  compatibility?: FlowCompatibilityReport;
  policy: PolicyEvalResult;
  capabilities: FlowCapabilityDescriptor;
  evalStatus?: ReleasePassport["eval"]["status"];
  canaryStatus?: ReleasePassport["canary"]["status"];
  now?: () => Date;
}): ReleasePassport {
  const reasons: string[] = [];
  const compatibility = input.compatibility ?? { status: "unknown" as const, findings: [] as [] };
  const evalStatus = input.evalStatus ?? "missing";
  const canaryStatus = input.canaryStatus ?? "not-configured";
  if (compatibility.status === "breaking") reasons.push("Breaking flow compatibility findings exist.");
  else if (compatibility.status === "unknown") reasons.push("No conclusive compatibility baseline is available.");
  if (input.policy.decision === "deny") reasons.push("The current compliance policy denies this flow configuration.");
  else if (input.policy.decision === "require-approval") reasons.push("The current compliance policy requires approval.");
  if (evalStatus === "failed") reasons.push("Latest matching evaluation evidence failed.");
  else if (evalStatus === "missing" || evalStatus === "unbound") reasons.push("No version-bound evaluation evidence is available.");
  if (canaryStatus === "rolled-back") reasons.push("The canary deployment was rolled back.");
  else if (canaryStatus === "not-version-bound") reasons.push("Canary evidence is not bound to this release version.");
  const blocked = compatibility.status === "breaking" || input.policy.decision === "deny" || evalStatus === "failed" || canaryStatus === "rolled-back";
  const review = input.policy.decision === "require-approval" || compatibility.status === "unknown" || canaryStatus === "not-version-bound";
  const insufficient = evalStatus === "missing" || evalStatus === "unbound";
  return {
    schemaVersion: "1",
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    flow: {
      id: input.flow.id,
      name: input.flow.name,
      source: input.source,
      ...(input.storeVersion !== undefined ? { storeVersion: input.storeVersion } : {}),
      ...(readSemanticVersion(input.flow.metadata) !== undefined ? { semanticVersion: readSemanticVersion(input.flow.metadata) } : {}),
    },
    assessment: blocked ? "blocked" : review ? "review" : insufficient ? "insufficient-evidence" : "clear",
    reasons,
    compatibility,
    policy: input.policy,
    capabilities: input.capabilities,
    eval: { status: evalStatus },
    canary: { status: canaryStatus },
    evidence: {
      dossierUrl: "/admin/compliance/dossier",
      ...(input.storeVersion !== undefined ? { diffUrl: `/flows/${encodeURIComponent(input.flow.id)}/compatibility?to=${input.storeVersion}` } : {}),
    },
  };
}
