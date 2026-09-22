// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Record of Processing Activities (RoPA) + data-flow map
 * (`src/compliance/data-flow-map.ts`)
 *
 * GDPR Art. 30 requires a controller to keep a *record of processing
 * activities*: for each processing purpose, which categories of personal data
 * are processed and which (sub-)processors / recipients — and, for the EU AI
 * Act / data-residency, in which regions. aiperator already holds every input
 * needed to derive this automatically:
 *
 *   - each flow declares the data classes it processes (`FlowDefinition.dataClasses`),
 *   - each flow node declares the LLM provider/model it calls (the "processor"),
 *   - the compliance policy's `dataRules` declare which providers (and regions)
 *     may process each data class (the residency control).
 *
 * This module cross-references those three into a per-flow processing record
 * and an overall data-flow map: for every declared data class, which providers
 * actually touch it, whether that is permitted by the residency policy, and in
 * which regions. It turns "we have controls" into a concrete, exportable
 * auditor artefact — the compliance counterpart to the dossier, focused on
 * *data lineage* rather than *operator actions*.
 *
 * Pure — no I/O. The route/dossier pass in the loaded flows and policy.
 *
 * No `any` at module boundaries.
 */

import { poolLeafConfigs } from "../graph/model-pool.js";
import type { FlowDefinition, DataClass, LlmConfig } from "../types/flow.js";
import type { CompliancePolicy } from "./policy-schema.js";

/** One (provider, models, nodes) processor touching a flow. */
export interface FlowProcessor {
  provider: string;
  /** Distinct model ids this provider is called with across the flow. */
  models: string[];
  /** Flow node ids that invoke this provider. */
  nodeIds: string[];
  /** True for a local/on-prem provider (data never leaves the deployment). */
  local: boolean;
}

/** Residency assessment for one (data class × provider) pair. */
export interface ResidencyAssessment {
  dataClass: DataClass;
  provider: string;
  /**
   * "any" (no region restriction), a list of allowed regions, "not-permitted"
   * (provider not on the data class's allow-list), or "unregulated" (no dataRule
   * exists for this data class).
   */
  allowedRegions: string[] | "any" | "not-permitted" | "unregulated";
  /** The provider's actual configured operating region, when known. */
  region?: string;
  /**
   * Region check outcome:
   *   - "ok"          — region is known and within the allowed set (or no region restriction),
   *   - "violation"   — region is known and NOT in the allowed set,
   *   - "unverified"  — provider allowed but its region is unknown (no PROVIDER_REGIONS entry),
   *   - "n/a"         — not applicable (local provider, unregulated, or provider not permitted).
   */
  regionStatus: "ok" | "violation" | "unverified" | "n/a";
  /** True when this provider may process this data class per the policy (incl. region). */
  permitted: boolean;
}

/** Options controlling the residency assessment. */
export interface DataFlowMapOptions {
  /** Provider id → its actual operating region (e.g. { azure: "westeurope" }). */
  providerRegions?: Record<string, string>;
  /** Providers treated as local/on-prem (data never leaves). Default: {ollama}. */
  localProviders?: ReadonlySet<string>;
}

export interface RoPAEntry {
  flowId: string;
  flowName: string;
  description?: string;
  /** Data classes the flow declares it processes (Art. 30 data categories). */
  dataClasses: DataClass[];
  /** LLM providers/models that process the flow's data (the sub-processors). */
  processors: FlowProcessor[];
  /** Per (data class × provider) residency assessment against the policy. */
  residency: ResidencyAssessment[];
  /**
   * Overall status:
   *   - "compliant"   — every declared data class is only processed by permitted providers,
   *   - "violation"   — at least one provider is not permitted for a declared data class,
   *   - "undeclared"  — the flow declares NO data classes (not covered by dataRules),
   *   - "no-policy"   — no compliance policy / no dataRules loaded to assess against.
   */
  status: "compliant" | "violation" | "undeclared" | "no-policy";
  /** Human-readable notes (undeclared data, non-permitted providers, local-only, …). */
  warnings: string[];
}

export interface DataFlowMap {
  generatedAt: string;
  entries: RoPAEntry[];
  summary: {
    flows: number;
    withDataClasses: number;
    violations: number;
    /** Distinct providers used across all flows. */
    providers: string[];
    /** Distinct data classes declared across all flows. */
    dataClasses: DataClass[];
  };
}

/** Default providers that run on-prem/local — data never leaves the deployment. */
export const DEFAULT_LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama"]);

/** Collects the effective LLM configs of a node (base + overrides + pool members). */
function nodeLlmConfigs(node: FlowDefinition["nodes"][number]): LlmConfig[] {
  const configs: LlmConfig[] = [];
  if (node.llm !== undefined) configs.push(node.llm);
  for (const o of node.overrides ?? []) {
    if (o.llm !== undefined) configs.push(o.llm);
  }
  // A POOL member may serve any request, so it is a processor of the flow's
  // data exactly like the primary — the record must list it (see LlmPoolConfig).
  // poolLeafConfigs walks nested sub-pools, so every leaf model is included.
  for (const llm of configs.slice()) {
    for (const leaf of poolLeafConfigs(llm)) configs.push(leaf);
  }
  return configs;
}

/** Builds the processor list (provider → models/nodes) for one flow. */
function collectProcessors(
  flow: FlowDefinition,
  localProviders: ReadonlySet<string>,
): FlowProcessor[] {
  const byProvider = new Map<
    string,
    { models: Set<string>; nodeIds: Set<string> }
  >();
  for (const node of flow.nodes) {
    for (const llm of nodeLlmConfigs(node)) {
      let e = byProvider.get(llm.provider);
      if (e === undefined) {
        e = { models: new Set(), nodeIds: new Set() };
        byProvider.set(llm.provider, e);
      }
      e.models.add(llm.model);
      e.nodeIds.add(node.id);
    }
  }
  return [...byProvider.entries()]
    .map(([provider, e]) => ({
      provider,
      models: [...e.models].sort(),
      nodeIds: [...e.nodeIds].sort(),
      local: localProviders.has(provider),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Assesses one (data class × provider) pair against the policy's dataRules.
 * A local provider is always permitted (data stays on-prem). When no dataRule
 * exists for the class, it is "unregulated" (permitted, but flagged).
 */
function assessResidency(
  dataClass: DataClass,
  provider: string,
  local: boolean,
  policy: CompliancePolicy | undefined,
  providerRegions: Record<string, string>,
): ResidencyAssessment {
  const rule = policy?.dataRules?.find((r) => r.dataClass === dataClass);
  if (rule === undefined) {
    return { dataClass, provider, allowedRegions: "unregulated", regionStatus: "n/a", permitted: true };
  }
  if (local) {
    return { dataClass, provider, allowedRegions: "any", regionStatus: "n/a", permitted: true };
  }
  const allowed = rule.allowedProviders.find((p) => p.provider === provider);
  if (allowed === undefined) {
    return { dataClass, provider, allowedRegions: "not-permitted", regionStatus: "n/a", permitted: false };
  }
  const regions = allowed.allowedRegions ?? [];
  const region = providerRegions[provider];
  // No region restriction on the rule → provider allow-listing is sufficient.
  if (regions.length === 0) {
    return { dataClass, provider, allowedRegions: "any", regionStatus: "n/a", permitted: true };
  }
  // Rule restricts regions. Check the provider's ACTUAL configured region.
  if (region === undefined) {
    // Provider allowed but its region is unknown — cannot confirm compliance.
    return { dataClass, provider, allowedRegions: regions, regionStatus: "unverified", permitted: true };
  }
  const regionOk = regions.includes(region);
  return {
    dataClass,
    provider,
    allowedRegions: regions,
    region,
    regionStatus: regionOk ? "ok" : "violation",
    permitted: regionOk,
  };
}

/** Builds the RoPA entry for a single flow. */
export function buildRoPAEntry(
  flow: FlowDefinition,
  policy: CompliancePolicy | undefined,
  options: DataFlowMapOptions = {},
): RoPAEntry {
  const localProviders = options.localProviders ?? DEFAULT_LOCAL_PROVIDERS;
  const providerRegions = options.providerRegions ?? {};
  const dataClasses = flow.dataClasses ?? [];
  const processors = collectProcessors(flow, localProviders);
  const warnings: string[] = [];

  const residency: ResidencyAssessment[] = [];
  for (const dc of dataClasses) {
    for (const proc of processors) {
      residency.push(
        assessResidency(dc, proc.provider, proc.local, policy, providerRegions),
      );
    }
  }
  for (const r of residency) {
    if (r.regionStatus === "violation") {
      warnings.push(
        `Provider "${r.provider}" processes "${r.dataClass}" data in region "${r.region}", ` +
          `which is NOT among the allowed regions [${(r.allowedRegions as string[]).join(", ")}].`,
      );
    } else if (r.regionStatus === "unverified") {
      warnings.push(
        `Provider "${r.provider}" is allowed for "${r.dataClass}" but its region is unknown ` +
          `(no PROVIDER_REGIONS entry) — residency cannot be confirmed.`,
      );
    }
  }

  const hasPolicyRules = (policy?.dataRules?.length ?? 0) > 0;
  let status: RoPAEntry["status"];
  if (dataClasses.length === 0) {
    status = "undeclared";
    warnings.push(
      "Flow declares no dataClasses — it is NOT covered by data-residency rules. " +
        "Add `dataClasses: [...]` to the flow file so its processing is assessed.",
    );
  } else if (!hasPolicyRules) {
    status = "no-policy";
    warnings.push(
      "No compliance-policy dataRules loaded — residency cannot be assessed. " +
        "Add dataRules to compliance-policy.yaml.",
    );
  } else {
    const violations = residency.filter((r) => !r.permitted);
    status = violations.length > 0 ? "violation" : "compliant";
    for (const v of violations) {
      warnings.push(
        `Provider "${v.provider}" is NOT permitted to process data class "${v.dataClass}" ` +
          `under the residency policy.`,
      );
    }
  }

  const nonLocal = processors.filter((p) => !p.local);
  if (dataClasses.some((d) => d === "personal" || d === "sensitive" || d === "health") && nonLocal.length > 0) {
    warnings.push(
      `Flow processes ${dataClasses.join("/")} data via non-local provider(s) ` +
        `${nonLocal.map((p) => p.provider).join(", ")} — verify a data-processing agreement + region.`,
    );
  }

  return {
    flowId: flow.id,
    flowName: flow.name,
    ...(flow.description !== undefined ? { description: flow.description } : {}),
    dataClasses,
    processors,
    residency,
    status,
    warnings,
  };
}

/** Builds the full data-flow map / RoPA across all loaded flows. */
export function buildDataFlowMap(
  flows: readonly FlowDefinition[],
  policy: CompliancePolicy | undefined,
  now: () => number = Date.now,
  options: DataFlowMapOptions = {},
): DataFlowMap {
  const entries = flows
    .map((f) => buildRoPAEntry(f, policy, options))
    .sort((a, b) => a.flowId.localeCompare(b.flowId));

  const providers = new Set<string>();
  const dataClasses = new Set<DataClass>();
  let withDataClasses = 0;
  let violations = 0;
  for (const e of entries) {
    for (const p of e.processors) providers.add(p.provider);
    for (const d of e.dataClasses) dataClasses.add(d);
    if (e.dataClasses.length > 0) withDataClasses++;
    if (e.status === "violation") violations++;
  }

  return {
    generatedAt: new Date(now()).toISOString(),
    entries,
    summary: {
      flows: entries.length,
      withDataClasses,
      violations,
      providers: [...providers].sort(),
      dataClasses: [...dataClasses].sort(),
    },
  };
}

/** Renders a {@link DataFlowMap} as a self-contained Markdown RoPA document. */
export function formatDataFlowMapAsMarkdown(map: DataFlowMap): string {
  const lines: string[] = [];
  lines.push(`# Record of Processing Activities (RoPA) & Data-Flow Map`);
  lines.push("");
  lines.push(`Generated: ${map.generatedAt}`);
  lines.push(
    `${map.summary.flows} flow(s), ${map.summary.withDataClasses} with declared data classes, ` +
      `${map.summary.violations} residency violation(s).`,
  );
  lines.push(
    `Providers in use: ${map.summary.providers.join(", ") || "none"}. ` +
      `Data classes: ${map.summary.dataClasses.join(", ") || "none declared"}.`,
  );
  lines.push("");

  for (const e of map.entries) {
    lines.push(`## ${e.flowName} (\`${e.flowId}\`) — ${e.status}`);
    if (e.description !== undefined) lines.push(e.description);
    lines.push(
      `Data classes: ${e.dataClasses.length > 0 ? e.dataClasses.join(", ") : "(none declared)"}`,
    );
    lines.push(`Processors (sub-processors / recipients):`);
    if (e.processors.length === 0) {
      lines.push(`  - (none — no LLM node declares a provider)`);
    } else {
      for (const p of e.processors) {
        lines.push(
          `  - **${p.provider}**${p.local ? " (local/on-prem)" : ""}: ` +
            `${p.models.join(", ")} — nodes: ${p.nodeIds.join(", ")}`,
        );
      }
    }
    if (e.residency.length > 0) {
      lines.push(`Residency:`);
      for (const r of e.residency) {
        const regions =
          Array.isArray(r.allowedRegions)
            ? `allowed: ${r.allowedRegions.join(", ")}`
            : r.allowedRegions;
        const actual =
          r.region !== undefined ? `; region=${r.region} (${r.regionStatus})` : "";
        lines.push(
          `  - ${r.dataClass} × ${r.provider}: ${r.permitted ? "✓" : "✗"} (${regions}${actual})`,
        );
      }
    }
    for (const w of e.warnings) lines.push(`  ⚠ ${w}`);
    lines.push("");
  }
  return lines.join("\n");
}
