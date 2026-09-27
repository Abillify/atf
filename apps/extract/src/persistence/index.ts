// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Persistence barrel for the v2 job model (schema `extract`).
 *
 * The schema/migrations live in `extract-ddl.ts`, the parameterised query
 * builders in `extract-queries.ts`, the row types in `types.ts`, and the
 * lazily-initialised data-access store in `extract-store.ts`.
 */

export {
  EXTRACT_SCHEMA,
  EXTRACT_SCHEMA_VERSION,
  EXTRACT_MIGRATIONS,
  ensureExtractSchema,
  getExtractSchemaVersion,
  runExtractMigrations,
  applyPendingMigrations,
  type ExtractMigrationStep,
  type MigrationClient,
  type MigrationLogger,
} from "./extract-ddl.js";

export {
  advanceUploadOffsetInTx,
  createExtractStore,
  type ExtractStore,
} from "./extract-store.js";

export type * from "./types.js";
