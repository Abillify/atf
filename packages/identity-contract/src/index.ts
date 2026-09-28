// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { z } from "zod";

/**
 * Current identity-principal contract version.
 *
 * 1.1.0 adds the optional {@link ActorSchema} `actor` field (RFC 8693 `act`
 * delegation). It is additive and backward compatible: a producer that still
 * emits `1.0.0` and no actor is accepted unchanged (see
 * {@link SUPPORTED_IDENTITY_PRINCIPAL_CONTRACT_VERSIONS}). A consumer that does
 * not understand `actor` may ignore it and behaves exactly as before.
 */
export const IDENTITY_PRINCIPAL_CONTRACT_VERSION = "1.1.0" as const;

/** Every principal version this contract still parses. */
export const SUPPORTED_IDENTITY_PRINCIPAL_CONTRACT_VERSIONS = ["1.0.0", "1.1.0"] as const;

/**
 * The acting party in an RFC 8693 on-behalf-of (delegation) exchange. Present
 * when a token carries an `act` claim: the `subject` remains the end user while
 * `actor.subject` names the service (e.g. the aiperator runtime) that performed
 * the action for them. `parent` carries a nested `act` chain when one exists.
 */
export const ActorSchema: z.ZodType<{
  subject: string;
  issuer?: string;
  parent?: { subject: string; issuer?: string };
}> = z.object({
  subject: z.string().min(1),
  issuer: z.string().min(1).optional(),
  parent: z.lazy(() =>
    z.object({ subject: z.string().min(1), issuer: z.string().min(1).optional() }),
  ).optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const IdentityPrincipalSchema = z.object({
  version: z.enum(SUPPORTED_IDENTITY_PRINCIPAL_CONTRACT_VERSIONS),
  id: z.string().min(1),
  subject: z.string().min(1),
  issuer: z.string().min(1),
  roles: z.array(z.string()).default([]),
  authenticatedAt: z.string().datetime(),
  /** Acting party when the token was minted via delegation (RFC 8693 `act`). */
  actor: ActorSchema.optional(),
});
export type IdentityPrincipal = z.infer<typeof IdentityPrincipalSchema>;

/** Plain input accepted from Runtime authentication without coupling consumers to app types. */
export const RuntimePrincipalInputSchema = z.object({
  method: z.enum(["anonymous", "token", "api_key"]),
  verified: z.boolean(),
  claims: z.record(z.string(), z.unknown()).nullable(),
  tenantId: z.string().min(1).optional(),
});
export type RuntimePrincipalInput = z.infer<typeof RuntimePrincipalInputSchema>;

/** Plain input accepted from Gate authentication without coupling consumers to app types. */
export const GatePrincipalInputSchema = z.object({
  method: z.enum(["disabled", "static", "oauth"]),
  subject: z.string().min(1),
  username: z.string().min(1),
  scopes: z.array(z.string()),
  claims: z.record(z.string(), z.unknown()),
  tenantId: z.string().min(1),
  /** Acting party parsed from the token's `act` claim, when present. */
  actor: ActorSchema.optional(),
});
export type GatePrincipalInput = z.infer<typeof GatePrincipalInputSchema>;

/**
 * Extracts an {@link Actor} from a raw JWT `act` claim (RFC 8693), tolerating
 * arbitrary claim shapes. Returns undefined when no usable actor subject is
 * present, so a token without delegation yields no actor. Nested `act` chains
 * are followed one level into `parent`.
 */
export function actorFromClaim(actClaim: unknown): Actor | undefined {
  if (actClaim === null || typeof actClaim !== "object") return undefined;
  const record = actClaim as Record<string, unknown>;
  const subject = record.sub;
  if (typeof subject !== "string" || subject.length === 0) return undefined;
  const issuer = typeof record.iss === "string" && record.iss.length > 0 ? record.iss : undefined;
  const parentClaim = record.act;
  let parent: { subject: string; issuer?: string } | undefined;
  if (parentClaim !== null && typeof parentClaim === "object") {
    const parentRecord = parentClaim as Record<string, unknown>;
    if (typeof parentRecord.sub === "string" && parentRecord.sub.length > 0) {
      parent = {
        subject: parentRecord.sub,
        ...(typeof parentRecord.iss === "string" && parentRecord.iss.length > 0
          ? { issuer: parentRecord.iss }
          : {}),
      };
    }
  }
  return {
    subject,
    ...(issuer !== undefined ? { issuer } : {}),
    ...(parent !== undefined ? { parent } : {}),
  };
}
