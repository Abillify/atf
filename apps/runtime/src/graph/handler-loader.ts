// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Dynamic node-type handler loader (`src/graph/handler-loader.ts`)
 *
 * Discovers node-type handler modules in a directory at startup and registers
 * them into a {@link NodeHandlerRegistry}. This is how the platform is extended
 * without touching core code: drop a module that exports a node-type
 * registration into the plugins directory and a new flow node `type` becomes
 * available.
 *
 * ⚠️  SECURITY / TRUST BOUNDARY
 * Loading a plugin executes its module code in-process with full application
 * privileges (arbitrary code execution). Only point this at a directory whose
 * contents you control and trust. It is OPT-IN: nothing is loaded unless an
 * operator sets `PLUGINS_DIR`. Treat plugin files exactly like first-party
 * source in review and deployment.
 *
 * A plugin module may expose its registration(s) in any of these shapes:
 *   - `export const nodeType: NodeHandlerRegistration = {...}`
 *   - `export const nodeTypes: NodeHandlerRegistration[] = [...]`
 *   - `export default <registration | registration[]>`
 *   - `export function register(registry): void { ... }`  (full control)
 *
 * Loading is error-isolated: a malformed or throwing plugin is logged and
 * skipped, never aborting startup or affecting other plugins.
 *
 * No `any` at module boundaries.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "../observability/logger.js";
import type {
  NodeHandlerRegistry,
  NodeHandlerRegistration,
} from "./node-handler-registry.js";
import {
  createPluginVerifier,
  type PluginVerifier,
  type PluginVerifierOptions,
} from "./plugin-verifier.js";
import { createSandboxedRegistration } from "./plugin-sandbox.js";

/** The export surface a plugin module may provide. */
interface NodeTypeModule {
  nodeType?: unknown;
  nodeTypes?: unknown;
  default?: unknown;
  register?: unknown;
}

/** Outcome summary (for startup logging / diagnostics). */
export interface PluginLoadResult {
  /** Node types successfully registered, in registration order. */
  loaded: string[];
  /** `${file}: ${reason}` for every module/registration that was skipped. */
  failed: string[];
}

/** Extended verifier options that include sandbox mode. */
export interface PluginLoaderOptions extends PluginVerifierOptions {
  /**
   * When true, each plugin module is loaded inside an isolated Bun Worker
   * thread that has no access to process.env or application singletons.
   * Defaults to false (in-process, full-privilege) for backward compatibility.
   */
  sandbox?: boolean;
  /**
   * Timeout (ms) for sandboxed plugin calls. Also used for sandbox init.
   * Default: 30 000 ms.
   */
  sandboxTimeoutMs?: number;
}

const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".cjs"]);

/** A file is a candidate plugin module unless it is a declaration/test/partial. */
function isPluginFile(name: string): boolean {
  if (name.startsWith("_") || name.startsWith(".")) return false;
  if (name.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.[cm]?[jt]s$/.test(name)) return false;
  return MODULE_EXTENSIONS.has(path.extname(name));
}

/** Structurally validates a value as a NodeHandlerRegistration. */
function isRegistration(value: unknown): value is NodeHandlerRegistration {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.type === "string" &&
    r.type.length > 0 &&
    typeof r.emitsLifecycle === "boolean" &&
    typeof r.factory === "function"
  );
}

/** Extracts the registration list a module exposes (any supported shape). */
function extractRegistrations(mod: NodeTypeModule): NodeHandlerRegistration[] {
  const out: NodeHandlerRegistration[] = [];
  const candidates: unknown[] = [];
  if (Array.isArray(mod.nodeTypes)) candidates.push(...mod.nodeTypes);
  if (mod.nodeType !== undefined) candidates.push(mod.nodeType);
  if (Array.isArray(mod.default)) candidates.push(...mod.default);
  else if (mod.default !== undefined) candidates.push(mod.default);
  for (const c of candidates) if (isRegistration(c)) out.push(c);
  return out;
}

/**
 * Loads and registers every node-type handler module found in `dir`.
 *
 * @param registry The registry to register discovered node types into.
 * @param dir      Directory to scan (non-recursive). A missing directory is a
 *                 no-op (returns empty result) — not an error.
 * @param logger   Optional logger for per-plugin success/failure lines.
 * @param verifierOptions  Optional plugin verification options (allowlist/manifest).
 */
export async function loadHandlerPlugins(
  registry: NodeHandlerRegistry,
  dir: string,
  logger?: Logger,
  verifierOptions?: PluginLoaderOptions,
): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], failed: [] };

  let entries: string[];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      logger?.warn("Plugins directory not found; skipping plugin load", {
        dir,
      });
      return result;
    }
    entries = fs.readdirSync(dir).filter(isPluginFile).sort();
  } catch (err) {
    logger?.warn("Failed to read plugins directory; skipping plugin load", {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  // Create verifier (handles allowlist + manifest logic)
  const verifier: PluginVerifier | undefined = verifierOptions
    ? createPluginVerifier(verifierOptions)
    : undefined;

  const sandboxEnabled = verifierOptions?.sandbox === true;
  const sandboxTimeoutMs = verifierOptions?.sandboxTimeoutMs ?? 30_000;

  if (sandboxEnabled) {
    logger?.info("Plugin sandbox mode enabled — plugins run in isolated Bun Workers", {
      dir,
      timeoutMs: sandboxTimeoutMs,
    });
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry);

    // --- Plugin verification gate (Req. 4.1, 4.2) ---
    if (verifier) {
      const verification = verifier.verify(entry, filePath);
      if (!verification.allowed) {
        const reason = verification.reason ?? "verification failed";
        result.failed.push(`${entry}: ${reason}`);
        logger?.error("SECURITY: Plugin loading denied — failed verification", {
          plugin: entry,
          reason,
          event: "plugin_verification_failed",
        });
        continue;
      }
    }

    // ── Sandbox mode: spawn Worker, skip in-process import ─────────────────
    if (sandboxEnabled) {
      // We need to discover which node type(s) the plugin provides without
      // importing it in-process. Fall back to in-process for discovery only,
      // then sandbox all handler calls.
      let discoveredTypes: string[] = [];
      try {
        const discoveryMod = (await import(pathToFileURL(filePath).href)) as NodeTypeModule;
        const regs = extractRegistrations(discoveryMod);
        discoveredTypes = regs.map((r) => r.type);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.failed.push(`${entry}: sandbox discovery import failed — ${reason}`);
        logger?.warn("Sandbox plugin type discovery failed; skipping", { plugin: entry, error: reason });
        continue;
      }

      if (discoveredTypes.length === 0) {
        result.failed.push(`${entry}: no nodeType/nodeTypes/default registration export`);
        logger?.warn("Sandbox plugin exposes no node-type registration; skipping", { plugin: entry });
        continue;
      }

      for (const type of discoveredTypes) {
        try {
          const sandboxedReg = await createSandboxedRegistration(
            filePath,
            type,
            sandboxTimeoutMs,
            logger,
          );
          if (sandboxedReg === undefined) {
            // Bun Worker not available — fall through to in-process below
            break;
          }
          registry.register(sandboxedReg);
          result.loaded.push(type);
          logger?.info("Sandboxed plugin node type registered", { plugin: entry, type });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          result.failed.push(`${entry}: ${type} — sandbox init failed: ${reason}`);
          logger?.warn("Sandbox plugin registration failed; skipping type", { plugin: entry, type, error: reason });
        }
      }
      // Only skip in-process if at least one type was sandboxed successfully
      if (result.loaded.some((t) => discoveredTypes.includes(t))) continue;
      logger?.warn("Sandbox mode unavailable; falling back to in-process for plugin", { plugin: entry });
    }
    // ── End sandbox path ───────────────────────────────────────────────────

    let mod: NodeTypeModule;
    try {
      mod = (await import(pathToFileURL(filePath).href)) as NodeTypeModule;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.failed.push(`${entry}: import failed — ${reason}`);
      logger?.warn("Plugin module failed to import; skipping", {
        plugin: entry,
        error: reason,
      });
      continue;
    }

    // A `register(registry)` export takes full control of registration.
    if (typeof mod.register === "function") {
      try {
        (mod.register as (r: NodeHandlerRegistry) => void)(registry);
        result.loaded.push(`${entry}:register()`);
        logger?.info("Plugin registered via register()", { plugin: entry });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.failed.push(`${entry}: register() threw — ${reason}`);
        logger?.warn("Plugin register() threw; skipping", {
          plugin: entry,
          error: reason,
        });
      }
      continue;
    }

    const registrations = extractRegistrations(mod);
    if (registrations.length === 0) {
      result.failed.push(
        `${entry}: no nodeType/nodeTypes/default registration export`,
      );
      logger?.warn("Plugin exposes no node-type registration; skipping", {
        plugin: entry,
      });
      continue;
    }

    for (const reg of registrations) {
      try {
        registry.register(reg);
        result.loaded.push(reg.type);
        logger?.info("Plugin node type registered", {
          plugin: entry,
          type: reg.type,
        });
      } catch (err) {
        // Most commonly a duplicate type (a plugin shadowing a built-in or
        // another plugin) — registry.register throws loudly; we isolate it.
        const reason = err instanceof Error ? err.message : String(err);
        result.failed.push(`${entry}: ${reg.type} — ${reason}`);
        logger?.warn("Plugin node type registration rejected; skipping", {
          plugin: entry,
          type: reg.type,
          error: reason,
        });
      }
    }
  }

  return result;
}
