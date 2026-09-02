// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Policy-as-Code schema (`src/compliance/policy-schema.ts`)
 *
 * Defines the Zod schemas and TypeScript types for the declarative compliance
 * policy. A policy file (`flows/compliance-policy.yaml`) contains:
 *
 *   - dataRules:   which data classifications may flow through which providers
 *                  and regions (GDPR / EU AI Act data-residency controls).
 *   - approvalRules: which tool patterns require human approval (extends the
 *                    existing approval-gate config into per-flow, per-role rules).
 *   - retentionRules: per-data-class retention overrides (augments env-based
 *                     RETENTION_MAX_AGE_DAYS).
 *   - auditRules:  which actions must always be audited and at what verbosity.
 *   - modelRules:  which models / providers are allowed or blocked per tenant /
 *                  data-classification context.
 *
 * The loader validates the schema when a policy file is present. A malformed
 * file is rejected by the loader, which currently disables the policy and
 * therefore behaves allow-all; `failClosed` applies only to exceptions raised
 * while evaluating an already loaded policy. Deployments that require policy
 * enforcement must monitor the loaded state.
 *
 * No `any` at module boundaries.
 */

import { z } from "zod";
import { DATA_CLASSES } from "../types/flow.js";
import type { DataClass } from "../types/flow.js";

// ---------------------------------------------------------------------------
// Data classification labels
// ---------------------------------------------------------------------------

// Canonical definition lives in `types/flow.ts` (so `FlowDefinition.dataClasses`
// can reference it without the core flow-type module depending on this feature
// module) — re-exported here so existing imports from this module keep working.
export { DATA_CLASSES };
export type { DataClass };

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

export const DataClassSchema = z.enum(DATA_CLASSES);

const ProviderRegionSchema = z.object({
  /** LLM provider id as used in LlmConfig.provider. */
  provider: z.string().min(1),
  /**
   * Optional list of allowed cloud regions for this provider. An empty array
   * means "any region". Region values are provider-specific strings
   * (e.g. "eu-central-1" for Bedrock, "europe-west3" for Google).
   */
  allowedRegions: z.array(z.string()).optional(),
});

const DataRuleSchema = z.object({
  /** Data class this rule applies to. */
  dataClass: DataClassSchema,
  /**
   * Providers+regions that are allowed to process this data class.
   * An empty array means "no provider allowed" (effectively blocks all LLM calls
   * when this data class is present).
   */
  allowedProviders: z.array(ProviderRegionSchema).min(0),
  /**
   * When true, the system checks response content for this data class and blocks
   * or redacts matching output even if the model processed it correctly.
   */
  enforceOutputScan: z.boolean().optional(),
  /** Human-readable description for audit reports. */
  description: z.string().optional(),
});

const ApprovalRuleSchema = z.object({
  /**
   * Tool id glob patterns that require approval under this rule.
   * Supports "*" suffix wildcard (e.g. "postgres-*", "*-delete").
   */
  toolPatterns: z.array(z.string().min(1)).min(1),
  /** Flow ids this rule applies to. Empty = all flows. */
  flows: z.array(z.string()).optional(),
  /** Roles that are exempt from the approval requirement. */
  exemptRoles: z.array(z.string()).optional(),
  /** Approval timeout override in ms. Falls back to global APPROVAL_TIMEOUT_MS. */
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  description: z.string().optional(),
});

const RetentionRuleSchema = z.object({
  dataClass: DataClassSchema,
  /** Maximum age in days for data of this class. Overrides env-based defaults. */
  maxAgeDays: z.number().int().min(1).max(36_500),
  description: z.string().optional(),
});

const AuditRuleSchema = z.object({
  /** Action prefix to audit at this verbosity. E.g. "flows." or "approvals.". */
  actionPrefix: z.string().min(1),
  /** "full" = include full request details; "minimal" = action + actor + target. */
  verbosity: z.enum(["minimal", "full"]),
  description: z.string().optional(),
});

const ModelRuleSchema = z.object({
  /**
   * Tenant id this rule applies to. "*" = all tenants. The special value
   * "default" applies to unauthenticated / unresolved tenants.
   */
  tenant: z.string().min(1),
  /**
   * Explicitly allowed provider+model combinations. When non-empty, any
   * provider/model NOT in this list is blocked.
   */
  allowedModels: z
    .array(
      z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
      }),
    )
    .optional(),
  /**
   * Explicitly blocked provider+model combinations (takes precedence over
   * allowedModels when both are specified).
   */
  blockedModels: z
    .array(
      z.object({
        provider: z.string().min(1),
        /** Supports "*" suffix wildcard, e.g. "gpt-3*". */
        model: z.string().min(1),
      }),
    )
    .optional(),
  description: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Top-level policy schema
// ---------------------------------------------------------------------------

export const CompliancePolicySchema = z.object({
  /**
   * Policy schema version for forward-compatibility. Currently "1".
   */
  version: z.literal("1").default("1"),
  /**
   * Human-readable description / change note for the policy.
   */
  description: z.string().optional(),
  /**
   * When true, a policy evaluation error (e.g. malformed rule, runtime
   * exception) causes the request to be *rejected* rather than allowed through.
   * Default true (fail-closed). Set to false only in development.
   */
  failClosed: z.boolean().default(true),
  dataRules: z.array(DataRuleSchema).optional(),
  approvalRules: z.array(ApprovalRuleSchema).optional(),
  retentionRules: z.array(RetentionRuleSchema).optional(),
  auditRules: z.array(AuditRuleSchema).optional(),
  modelRules: z.array(ModelRuleSchema).optional(),
});

export type CompliancePolicy = z.infer<typeof CompliancePolicySchema>;
export type DataRule = z.infer<typeof DataRuleSchema>;
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;
export type RetentionRule = z.infer<typeof RetentionRuleSchema>;
export type AuditRule = z.infer<typeof AuditRuleSchema>;
export type ModelRule = z.infer<typeof ModelRuleSchema>;
export type ProviderRegion = z.infer<typeof ProviderRegionSchema>;
