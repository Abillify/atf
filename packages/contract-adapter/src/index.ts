// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
  EvidenceActionContractV1Schema,
  type EvidenceActionContractV1,
} from "@atf/evidence-contract";
import {
  GatePrincipalInputSchema,
  IDENTITY_PRINCIPAL_CONTRACT_VERSION,
  IdentityPrincipalSchema,
  RuntimePrincipalInputSchema,
  type GatePrincipalInput,
  type IdentityPrincipal,
  type RuntimePrincipalInput,
} from "@atf/identity-contract";
import {
  diffToolSchemas,
  type SchemaCompatibilityDiff,
  type ToolSchemas,
} from "@atf/schema-compatibility";
import {
  TransactionEnvelopeConsumerV1Schema,
  TransactionEnvelopeV1Schema,
  type TransactionEnvelopeConsumerV1,
  type TransactionEnvelopeV1,
} from "@atf/transaction-contract";

export type ContractPolicyMode = "report" | "warn" | "enforce";
export interface ContractFinding {
  path: string;
  message: string;
}
export type ContractInspection<T> =
  | { ok: true; value: T; findings: readonly [] }
  | { ok: false; findings: readonly ContractFinding[] };

interface SafeSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } };
}

/** Inspects unknown wire data without throwing or exposing a validation-library type. */
export function inspectContract<T>(schema: SafeSchema<T>, value: unknown): ContractInspection<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data, findings: [] };
  return {
    ok: false,
    findings: result.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "$" : `$.${issue.path.map(String).join(".")}`,
      message: issue.message,
    })),
  };
}

export function applyContractPolicy<T>(
  inspection: ContractInspection<T>,
  options: { mode: ContractPolicyMode; warn?: (message: string) => void },
): ContractInspection<T> {
  if (inspection.ok || options.mode === "report") return inspection;
  const message = inspection.findings.map((finding) => `${finding.path}: ${finding.message}`).join("; ");
  if (options.mode === "warn") {
    options.warn?.(message);
    return inspection;
  }
  throw new Error(`Contract validation failed: ${message}`);
}

export interface PrincipalAdapterContext {
  issuer: string;
  authenticatedAt: string;
  id?: string;
  roles?: readonly string[];
}

function principal(
  subject: string,
  context: PrincipalAdapterContext,
  fallbackId: string,
  roles: readonly string[],
): ContractInspection<IdentityPrincipal> {
  return inspectContract(IdentityPrincipalSchema, {
    version: IDENTITY_PRINCIPAL_CONTRACT_VERSION,
    id: context.id ?? fallbackId,
    subject,
    issuer: context.issuer,
    authenticatedAt: context.authenticatedAt,
    roles: [...(context.roles ?? roles)],
  });
}

export function adaptRuntimePrincipal(
  input: RuntimePrincipalInput,
  context: PrincipalAdapterContext,
): ContractInspection<IdentityPrincipal> {
  const parsed = RuntimePrincipalInputSchema.safeParse(input);
  if (!parsed.success) return inspectContract(IdentityPrincipalSchema, undefined);
  const subject = parsed.data.claims?.sub;
  if (!parsed.data.verified || typeof subject !== "string" || subject.trim() === "") {
    return { ok: false, findings: [{ path: "$.subject", message: "A verified subject claim is required" }] };
  }
  return principal(subject, context, parsed.data.tenantId ?? subject, []);
}

export function adaptGatePrincipal(
  input: GatePrincipalInput,
  context: PrincipalAdapterContext,
): ContractInspection<IdentityPrincipal> {
  const parsed = GatePrincipalInputSchema.safeParse(input);
  if (!parsed.success) return inspectContract(IdentityPrincipalSchema, undefined);
  return principal(parsed.data.subject, context, parsed.data.tenantId || parsed.data.subject, parsed.data.scopes);
}

function matchingHashAliases(value: TransactionEnvelopeConsumerV1): ContractInspection<TransactionEnvelopeConsumerV1> {
  if (value.actionContractHash !== undefined && value.evidenceContractHash !== undefined && value.actionContractHash !== value.evidenceContractHash) {
    return { ok: false, findings: [{ path: "$.evidenceContractHash", message: "Hash aliases must be identical" }] };
  }
  return { ok: true, value, findings: [] };
}

export function parseTransactionEnvelopeProducer(value: unknown): ContractInspection<TransactionEnvelopeV1> {
  const inspection = inspectContract(TransactionEnvelopeV1Schema, value);
  if (!inspection.ok) return inspection;
  const aliases = matchingHashAliases(inspection.value);
  return aliases.ok ? inspection : aliases;
}

export function parseTransactionEnvelopeConsumer(value: unknown): ContractInspection<TransactionEnvelopeConsumerV1> {
  const inspection = inspectContract(TransactionEnvelopeConsumerV1Schema, value);
  return inspection.ok ? matchingHashAliases(inspection.value) : inspection;
}

export function parseEvidenceActionContract(value: unknown): ContractInspection<EvidenceActionContractV1> {
  return inspectContract(EvidenceActionContractV1Schema, value);
}

export function assessSchemaEvolution(previous: ToolSchemas, next: ToolSchemas): SchemaCompatibilityDiff {
  return diffToolSchemas(previous, next);
}
