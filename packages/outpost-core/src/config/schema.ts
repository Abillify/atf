// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Configuration schema for the Outpost (requirements 1.1, 1.4, 1.8, 1.9, 1.10).
 *
 * The schema describes the *file* format and deliberately knows no secret
 * fields: tokens, client secrets and cloud credentials live in the
 * CredentialStore under keys like `source:<id>:s3-secret-key` (requirement
 * 1.10). Unknown keys are stripped rather than rejected, so a stray
 * `apiToken:` in the file cannot smuggle a secret into the config object.
 *
 * Semantic rules that need more than one field — the collection pattern and
 * the HTTPS-only rule for the Extract URL — live in `validate.ts` so every
 * violation can be collected into one `ConfigError[]` instead of the first
 * zod issue hiding the rest.
 */

import { z } from "zod";

/** The collection-name pattern from requirement 1.4; quoted verbatim in errors. */
export const COLLECTION_PATTERN = "^[a-zA-Z][a-zA-Z0-9_]*$";
const COLLECTION_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Source IDs become part of every Reference (`outpost:<sourceId>:<hash>`) and
 * of environment-variable names (`OUTPOST_SOURCE_<ID>_…`), so they are limited
 * to characters that keep both unambiguous.
 */
const SOURCE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const sourceCommon = {
  id: z
    .string()
    .regex(
      SOURCE_ID_REGEX,
      "source id must start with a letter or digit and contain only A-Z, a-z, 0-9, '.', '_' or '-' (max 64 characters)",
    ),
  /** Overrides the global target collection for this source (requirement 1.8). */
  collection: z.string().optional(),
  include: z.array(z.string().min(1)).optional(),
  exclude: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowedUsers: z.array(z.string().min(1)).optional(),
  allowedGroups: z.array(z.string().min(1)).optional(),
};

export const sourceConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("local"),
    path: z.string().min(1),
    watch: z.boolean().default(false),
    followSymlinks: z.literal(false).optional(),
    ...sourceCommon,
  }),
  z.object({
    type: z.literal("s3"),
    bucket: z.string().min(1),
    prefix: z.string().optional(),
    region: z.string().optional(),
    endpoint: z.string().optional(),
    forcePathStyle: z.boolean().optional(),
    credentials: z
      .union([z.literal("store"), z.object({ profile: z.string().min(1) }), z.literal("default-chain")])
      .default("store"),
    ...sourceCommon,
  }),
  z.object({
    type: z.literal("gdrive"),
    folderId: z.string().min(1),
    exportFormat: z.enum(["pdf", "docx", "xlsx", "pptx"]).default("pdf"),
    auth: z.enum(["oauth", "service-account"]).default("oauth"),
    deviceFlow: z.boolean().optional(),
    ...sourceCommon,
  }),
  z.object({
    type: z.literal("dropbox"),
    path: z.string().min(1),
    ...sourceCommon,
  }),
]);

export const outpostConfigSchema = z.object({
  extractUrl: z.string().min(1),
  /** Allow `http://localhost` / `http://127.0.0.1` for development (requirement 1.6). */
  allowInsecureLocalhost: z.boolean().default(false),
  caCertPath: z.string().min(1).optional(),
  oidc: z
    .object({
      issuer: z.string().min(1),
      clientId: z.string().min(1),
      audience: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  collection: z.string(),
  syncIntervalSec: z.int().min(1).default(900),
  /** On by default (requirement 1.7). */
  mirrorDelete: z.boolean().default(true),
  deleteThresholdPercent: z.number().min(0).max(100).default(50),
  resumableThresholdBytes: z.int().min(1).default(33_554_432),
  maxConcurrentUploads: z.int().min(1).default(4),
  health: z
    .object({
      bind: z.string().min(1).default("127.0.0.1"),
      port: z.int().min(0).max(65535).default(8787),
    })
    .default({ bind: "127.0.0.1", port: 8787 }),
  /** Public OAuth clients per provider — not secrets, may live in the file. */
  cloudOAuth: z
    .object({
      gdrive: z.object({ clientId: z.string().min(1) }).optional(),
      dropbox: z.object({ appKey: z.string().min(1) }).optional(),
    })
    .default({}),
  sources: z.array(sourceConfigSchema).default([]),
});

export type OutpostConfig = z.infer<typeof outpostConfigSchema>;
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export { COLLECTION_REGEX };
