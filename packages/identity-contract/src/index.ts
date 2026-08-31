// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { z } from "zod";

export const IDENTITY_PRINCIPAL_CONTRACT_VERSION = "1.0.0" as const;
export const IdentityPrincipalSchema = z.object({
  version: z.literal(IDENTITY_PRINCIPAL_CONTRACT_VERSION),
  id: z.string().min(1),
  subject: z.string().min(1),
  issuer: z.string().min(1),
  roles: z.array(z.string()).default([]),
  authenticatedAt: z.string().datetime(),
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
});
export type GatePrincipalInput = z.infer<typeof GatePrincipalInputSchema>;
