#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow JSON Schema exporter CLI (`scripts/export-flow-schema.ts`)
 *
 * Thin CLI wrapper: writes {@link buildFlowJsonSchema}'s output
 * (`src/graph/flow-parser/json-schema-export.ts`) to disk, or checks it is
 * up to date (`--check`, for CI drift detection).
 *
 * Usage:
 *   bun run scripts/export-flow-schema.ts                     # writes schemas/flow.schema.json
 *   bun run scripts/export-flow-schema.ts --out path/to.json  # custom output path
 *   bun run scripts/export-flow-schema.ts --check             # exit 1 if the file would change (CI drift check)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildFlowJsonSchema } from "../src/graph/flow-parser/json-schema-export.js";

const DEFAULT_OUT = path.join(import.meta.dirname, "..", "schemas", "flow.schema.json");

function parseArgs(argv: string[]): { out: string; check: boolean } {
  const args = argv.slice(2);
  let out = DEFAULT_OUT;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && i + 1 < args.length) {
      out = path.resolve(args[++i] ?? DEFAULT_OUT);
    } else if (args[i] === "--check") {
      check = true;
    }
  }
  return { out, check };
}

function main(): void {
  const { out, check } = parseArgs(process.argv);
  const content = `${JSON.stringify(buildFlowJsonSchema(), null, 2)}\n`;

  if (check) {
    const existing = fs.existsSync(out) ? fs.readFileSync(out, "utf-8") : "";
    if (existing === content) {
      console.log(`✓ ${path.relative(process.cwd(), out)} is up to date.`);
      return;
    }
    console.error(
      `✗ ${path.relative(process.cwd(), out)} is stale. Run \`bun run scripts/export-flow-schema.ts\` and commit the result.`,
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content, "utf-8");
  console.log(`✓ Wrote ${path.relative(process.cwd(), out)}`);
}

main();
