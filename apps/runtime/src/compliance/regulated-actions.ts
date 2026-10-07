// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Regulierte Aktionen (Req 1.4 / 3.3, platform-hardening spec).
 *
 * A *Regulierte Aktion* is a mutation whose legal defensibility depends on an
 * immutable audit trail: publishing, rolling back or deleting Flows,
 * resolving Approvals, deleting Tenants, creating or revoking credentials
 * (API keys, BYOK secrets) and any DSAR/erasure execution. For these actions
 * the audit write is part of the operation: the route MUST use
 * {@link AuditLog.recordRequired} and answer `503 AUDIT_UNAVAILABLE` when the
 * durable audit write fails, instead of reporting success without a trail.
 *
 * Policy changes (guardrails / compliance policy) are file-based (GitOps):
 * they are audited through `gitops.reload` when the files are reloaded, not
 * through a mutation route. The list below covers every *route-level*
 * Regulierte Aktion; `apps/runtime/src/routes/__tests__/regulated-audit.test.ts`
 * guards that each id here is written via `recordRequired(` in its route file.
 */

/** Action ids that require a durable audit write before the response. */
export const REGULATED_ACTIONS = [
  "flows.publish",
  "flows.rollback",
  "flows.delete",
  "approvals.resolve",
  "dsar.self_erasure",
  "compliance.forget",
  "tenant.delete",
  "api_key.create",
  "api_key.revoke",
  "byok.set",
] as const;

export type RegulatedAction = (typeof REGULATED_ACTIONS)[number];

export function isRegulatedAction(action: string): action is RegulatedAction {
  return (REGULATED_ACTIONS as readonly string[]).includes(action);
}

/**
 * Body returned by a route when a Regulierte Aktion could not be audited
 * durably (Req 1.4). The mutation is reported as *not completed* — the client
 * must retry; the trail is never silently skipped.
 */
export const AUDIT_UNAVAILABLE_BODY = {
  error: {
    message:
      "The operation could not be audited and was therefore not completed. Please retry.",
    type: "server_error",
    code: "AUDIT_UNAVAILABLE",
  },
} as const;

/** HTTP status used together with {@link AUDIT_UNAVAILABLE_BODY}. */
export const AUDIT_UNAVAILABLE_STATUS = 503;
