#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Writes the generated flow configuration reference (`docs/FLOWS.md`) and the
 * flow JSON Schema (`apps/runtime/schemas/flow.schema.json`), or checks both
 * are current (`--check`, CI). Content comes from
 * `src/graph/flow-reference.ts` and `src/graph/flow-parser/json-schema-export.ts`.
 *
 * Usage (from the repository root):
 *   bun run flow-reference          # write both
 *   bun run flow-reference:check    # exit 1 when either is stale
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildFlowJsonSchema } from "../src/graph/flow-parser/json-schema-export.js";
import { buildFlowReferenceMarkdown } from "../src/graph/flow-reference.js";

const root = path.join(import.meta.dirname, "..", "..", "..");
const artifacts: Array<{ file: string; content: string }> = [
  { file: path.join(root, "docs", "FLOWS.md"), content: buildFlowReferenceMarkdown() },
  {
    file: path.join(root, "apps", "runtime", "schemas", "flow.schema.json"),
    content: `${JSON.stringify(buildFlowJsonSchema(), null, 2)}\n`,
  },
];

const check = process.argv.includes("--check");
let stale = false;
for (const { file, content } of artifacts) {
  const rel = path.relative(root, file);
  if (check) {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    if (existing === content) console.log(`✓ ${rel} is up to date.`);
    else {
      console.error(`✗ ${rel} is stale. Run \`bun run flow-reference\` and commit the result.`);
      stale = true;
    }
  } else {
    fs.writeFileSync(file, content, "utf-8");
    console.log(`✓ Wrote ${rel}`);
  }
}
if (stale) process.exit(1);
