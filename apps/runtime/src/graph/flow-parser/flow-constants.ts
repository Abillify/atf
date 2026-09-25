// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Global constants for flow variables:
 *
 *   - `flows/constants.yaml` — `constants: { name: value, … }`, shared by all
 *     flows and versioned with them. Referenced as `{{const.<name>}}`.
 *   - Public environment values — ONLY variables whose name starts with
 *     `FLOW_PUBLIC_`. Referenced as `{{env.FLOW_PUBLIC_<NAME>}}`.
 *
 * Why an env allowlist: variable values end up in prompts, tool arguments and
 * traces, i.e. they reach LLM providers, operators and logs. Letting a flow
 * read arbitrary env would turn every flow author into someone who can
 * exfiltrate API keys and database passwords. The prefix makes "this value is
 * safe to expose" an explicit deployment decision.
 *
 * The active constants directory is module state set by the flow parser when
 * it loads a flows directory, so the per-request variable resolution
 * (`applyFlowVariables`, which only sees a FlowDefinition) can reach it. The
 * file is cached by mtime; a change reloads all flows (loader.ts), which also
 * invalidates the per-flow variable memo.
 */

import fs from "node:fs";
import { parseFlowFile, resolveConfigFile } from "../../util/parse-flow-file.js";

/** Reserved base name of the constants file inside the flows directory. */
export const FLOW_CONSTANTS_BASE = "constants";

/** Only env variables with this prefix are readable from flows. */
export const PUBLIC_ENV_PREFIX = "FLOW_PUBLIC_";

const cache = new Map<string, { mtimeMs: number; data: Record<string, unknown> }>();
let activeDir: string | undefined;

/**
 * Reads `constants.{yaml,yml,json}` from `flowsDir`. Missing file → `{}`; a
 * parse error is logged and also yields `{}` so a broken constants file never
 * takes flow loading down.
 */
export function loadFlowConstants(flowsDir: string): Record<string, unknown> {
  const filePath = resolveConfigFile(flowsDir, FLOW_CONSTANTS_BASE);
  if (filePath === null) return {};
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return {};
  }
  const hit = cache.get(filePath);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.data;

  let data: Record<string, unknown> = {};
  try {
    const raw = parseFlowFile(filePath) as { constants?: unknown } | null;
    const map = raw?.constants;
    if (map !== undefined && (typeof map !== "object" || map === null || Array.isArray(map))) {
      throw new Error("`constants` must be a map of name → value");
    }
    data = (map as Record<string, unknown> | undefined) ?? {};
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        component: "flow-parser",
        reason: "Failed to parse constants file — ignoring constants",
        file: filePath,
        details: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
  cache.set(filePath, { mtimeMs, data });
  return data;
}

/** Called by the flow parser for the directory it serves. */
export function setFlowConstantsDir(flowsDir: string | undefined): void {
  activeDir = flowsDir;
}

/** Constants of the active flows directory (`{}` when none is set). */
export function currentFlowConstants(): Record<string, unknown> {
  return activeDir === undefined ? {} : loadFlowConstants(activeDir);
}

/** The allowlisted (`FLOW_PUBLIC_*`) environment values. */
export function publicEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[0].startsWith(PUBLIC_ENV_PREFIX) && typeof e[1] === "string",
    ),
  );
}

/** Clears the constants cache and active directory (tests). */
export function resetFlowConstants(): void {
  cache.clear();
  activeDir = undefined;
}
