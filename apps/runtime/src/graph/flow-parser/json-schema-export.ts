// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow JSON Schema builder (`src/graph/flow-parser/json-schema-export.ts`)
 *
 * Generates a standalone JSON Schema from the authoritative
 * {@link FlowDefinitionSchema} (Zod) so editors can validate `flows/*.yaml`
 * files WITHOUT running the server: YAML/JSON language servers (the VS Code
 * YAML extension, most JSON LSPs) accept a `$schema`/`yaml.schemas` mapping to
 * a local file and give inline error squiggles + autocomplete as you type.
 *
 * Zod 4 ships `z.toJSONSchema()` natively (no extra dependency). A few
 * refinements (`.refine()`, `.superRefine()`) on `FlowNodeSchema` — the
 * cross-field checks for `overrides`, `errorStrategy`, and the
 * type/config-schema dispatch via the node handler registry — cannot be
 * represented in JSON Schema; those become plain `{}` (`unrepresentable:
 * "any"`) rather than throwing, so the export always succeeds. That is an
 * acceptable trade-off: the *structural* shape (required fields, enums,
 * nesting, string/array bounds) is what an editor's inline validation is
 * useful for; the semantic cross-field rules are still enforced at runtime by
 * `validateFlowDefinition` / `bun run scripts/cli.ts validate`.
 *
 * Kept in `src/` (not `scripts/`) so it is covered by the default `bun test`
 * root (`./src`, see bunfig.toml) — `scripts/export-flow-schema.ts` is a thin
 * CLI wrapper around {@link buildFlowJsonSchema} that only does file I/O.
 */

import { z } from "zod";
import { FlowDefinitionSchema } from "./validate.js";

export const FLOW_SCHEMA_ID = "https://aiperator.dev/schemas/flow.schema.json";

/** Builds the exported JSON Schema. Pure — no file I/O. */
export function buildFlowJsonSchema(): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(FlowDefinitionSchema, {
    target: "draft-2020-12",
    // Cross-field .refine()/.superRefine() checks are enforced at runtime
    // (validateFlowDefinition) and have no JSON Schema representation.
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return {
    ...jsonSchema,
    $id: FLOW_SCHEMA_ID,
    title: "aiperator Flow Definition",
    description:
      "Structural schema for aiperator flow YAML/JSON files (flows/*.yaml). " +
      "Generated from the Zod FlowDefinitionSchema — do not edit by hand; " +
      "run `bun run scripts/export-flow-schema.ts`. Cross-field validation " +
      "(node type/config compatibility, override well-formedness, edge " +
      "reference integrity) is enforced at runtime, not by this schema — use " +
      "`bun run scripts/cli.ts validate <file>` for full validation.",
  };
}
