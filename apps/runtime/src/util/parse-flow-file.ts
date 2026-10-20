// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared utilities for reading and parsing flow configuration files.
 *
 * Supports both JSON (.json) and YAML (.yaml / .yml) formats so that any
 * file in the flows directory can be authored in either syntax.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/** `<<` merge keys are expanded (YAML 1.1 semantics); without it they stay literal keys. */
export const FLOW_YAML_PARSE_OPTIONS = { merge: true } as const;

/** Maximum recursion depth of {@link assertNoLiteralMergeKeys}; deeper values are skipped. */
const MERGE_KEY_SCAN_MAX_DEPTH = 64;

/**
 * Fails when a literal `"<<"` key survived parsing: with merge expansion on,
 * a well-formed merge key is always replaced, so a remaining one means the
 * value was neither a mapping nor a list of mappings (the same silent
 * failure a JSON flow with a literal `"<<"` would cause).
 */
export function assertNoLiteralMergeKeys(
  value: unknown,
  filePath: string,
): void {
  const visit = (node: unknown, pointer: string, depth: number): void => {
    if (depth > MERGE_KEY_SCAN_MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        visit(node[i], `${pointer}/${i}`, depth + 1);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key === "<<") {
          throw new Error(
            `${path.basename(filePath)}: YAML merge key "<<" at ${pointer} was not expanded — use a mapping or a list of mappings as its value`,
          );
        }
        visit(child, `${pointer}/${key}`, depth + 1);
      }
    }
  };
  visit(value, "", 0);
}

/**
 * Parses `content` according to the file extension of `filePath`.
 * - `.yaml` / `.yml` → YAML parser
 * - anything else    → JSON.parse
 */
function parseContent(filePath: string, content: string): unknown {
  const ext = path.extname(filePath).toLowerCase();
  const result =
    ext === ".yaml" || ext === ".yml"
      ? parseYaml(content, FLOW_YAML_PARSE_OPTIONS)
      : JSON.parse(content);
  assertNoLiteralMergeKeys(result, filePath);
  return result;
}

/**
 * Reads and parses a single file synchronously.
 * Throws on read or parse errors (caller decides how to handle them).
 */
export function parseFlowFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseContent(filePath, content);
}

/**
 * Reads and parses a single file asynchronously.
 * Rejects on read or parse errors.
 */
export async function parseFlowFileAsync(filePath: string): Promise<unknown> {
  const content = await fs.promises.readFile(filePath, "utf-8");
  return parseContent(filePath, content);
}

// ---------------------------------------------------------------------------
// Config-file resolution
// ---------------------------------------------------------------------------

/**
 * Preferred extension order: YAML variants are tried before JSON so that a
 * YAML file takes precedence when both exist side-by-side during a migration.
 */
const CONFIG_FILE_EXTENSIONS = [".yaml", ".yml", ".json"] as const;

/**
 * Returns true if the file name (without extension) matches one of the
 * supported flow-config extensions.
 */
export function isFlowFileExtension(ext: string): boolean {
  return (CONFIG_FILE_EXTENSIONS as readonly string[]).includes(
    ext.toLowerCase(),
  );
}

/**
 * Resolves the path to a reserved config file (e.g. `dispatch`, `access`)
 * inside `dir`. Tries `.yaml`, `.yml`, then `.json` in that order.
 *
 * Returns the first path that exists on disk, or `null` when none is found.
 */
export function resolveConfigFile(
  dir: string,
  baseName: string,
): string | null {
  for (const ext of CONFIG_FILE_EXTENSIONS) {
    const candidate = path.join(dir, baseName + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
