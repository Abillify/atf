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

/**
 * Parses `content` according to the file extension of `filePath`.
 * - `.yaml` / `.yml` → YAML parser
 * - anything else    → JSON.parse
 */
function parseContent(filePath: string, content: string): unknown {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    return parseYaml(content);
  }
  return JSON.parse(content);
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
