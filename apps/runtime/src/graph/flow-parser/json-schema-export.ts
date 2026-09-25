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

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The Zod schema validates the RUNTIME form, in which the parser has already
 * expanded `llm: { shortcut }` into provider/model/parameters. Flow FILES are
 * written in the source form, so an editor validating them must also accept
 * the shortcut form: `{ shortcut, parameters? }` (node-level parameters
 * override the preset's; a provider/model next to a shortcut would be
 * overwritten, so the form rejects them).
 */
function withShortcutForm(llm: JsonObject): JsonObject {
  const { description, ...explicit } = llm;
  const properties = isObject(explicit.properties) ? explicit.properties : {};
  return {
    ...(typeof description === "string" ? { description } : {}),
    anyOf: [
      {
        type: "object",
        properties: {
          shortcut: {
            type: "string",
            minLength: 1,
            description:
              "A model shortcut from `model-shortcuts.yaml`, or a `{{vars.*}}` reference to one. Expanded to provider, model and the preset's parameters when the flow loads.",
          },
          ...(properties.parameters !== undefined
            ? {
                parameters: {
                  ...(properties.parameters as JsonObject),
                  description: "Override the preset's parameters (node-level values win).",
                },
              }
            : {}),
        },
        required: ["shortcut"],
        additionalProperties: false,
      },
      explicit,
    ],
  };
}

/** `_`-prefixed keys are annotations (`_comment`, `_comment_tools`, …); the parser ignores them. */
const COMMENT_KEYS = { "^_": { description: "Annotation for readers; ignored by the parser." } };

/**
 * Adapts the runtime-form schema to what a flow FILE may contain (the form
 * editors validate), without loosening anything else:
 *
 *   - `llm` accepts `{ shortcut, parameters? }` next to provider/model
 *     ({@link withShortcutForm}), on nodes and overrides;
 *   - flow, node, edge and override objects accept `_`-prefixed comment keys
 *     (other unknown keys stay errors, so typos are still caught);
 *   - `nodes`/`edges` may be omitted when `metadata.$include` merges them in
 *     from sub-flow files.
 */
function adaptToSourceForm(schema: JsonObject): void {
  const props = schema.properties as JsonObject | undefined;
  const node = (props?.nodes as JsonObject | undefined)?.items as JsonObject | undefined;
  const edge = (props?.edges as JsonObject | undefined)?.items as JsonObject | undefined;
  const nodeProps = node?.properties as JsonObject | undefined;
  const override = (nodeProps?.overrides as JsonObject | undefined)?.items as JsonObject | undefined;

  for (const obj of [node, override]) {
    const p = obj?.properties;
    if (isObject(p) && isObject(p.llm)) p.llm = withShortcutForm(p.llm);
  }
  for (const obj of [schema, node, edge, override]) {
    if (obj !== undefined) obj.patternProperties = COMMENT_KEYS;
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((k) => k !== "nodes" && k !== "edges");
    schema.anyOf = [
      { required: ["nodes", "edges"] },
      {
        required: ["metadata"],
        properties: { metadata: { type: "object", required: ["$include"] } },
      },
    ];
  }
}

/** Builds the exported JSON Schema. Pure — no file I/O. */
export function buildFlowJsonSchema(): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(FlowDefinitionSchema, {
    target: "draft-2020-12",
    // Cross-field .refine()/.superRefine() checks are enforced at runtime
    // (validateFlowDefinition) and have no JSON Schema representation.
    unrepresentable: "any",
  }) as Record<string, unknown>;
  adaptToSourceForm(jsonSchema);
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
