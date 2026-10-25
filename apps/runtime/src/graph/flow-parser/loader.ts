// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow Parser — Loader, Hot-Reload, FlowParserService
 *
 * Handles file loading (YAML/JSON precedence), chokidar-based hot-reload,
 * and the FlowParserService lifecycle.
 *
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveOperationalProfile } from "@atf/security-kit";
import type { FlowDefinition } from "../../types/flow.js";
import { findUnknownConfigKeys } from "../flow-config-keys.js";
import {
  parseFlowFile,
  parseFlowFileAsync,
  isFlowFileExtension,
} from "../../util/parse-flow-file.js";
import {
  clearFlowLoadFailure,
  logValidationError,
  recordFlowLoadFailure,
  validateFlowSource,
} from "./validate.js";
import {
  applyIncludePatches,
  FlowIncludeError,
  resolveFlowIncludes,
  resolveFlowSourceIncludes,
  resolveRawFlowVariables,
  INCLUDE_EDGE_ORIGINS_KEY,
  INCLUDE_PATCHES_KEY,
} from "./normalize.js";

/**
 * Drops source-form-only bookkeeping from a clone headed for the runtime and
 * returns the `$include.patches` it carried, which the runtime form must apply
 * to the merged sub-flow nodes.
 */
function stripSourceBookkeeping(raw: Record<string, unknown>): unknown {
  const meta = raw.metadata;
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    const record = meta as Record<string, unknown>;
    delete record[INCLUDE_EDGE_ORIGINS_KEY];
    const patches = record[INCLUDE_PATCHES_KEY];
    delete record[INCLUDE_PATCHES_KEY];
    return patches;
  }
  return undefined;
}
import type { ValidationResult } from "./validate.js";
import {
  loadModelShortcuts,
  resolveModelShortcuts,
  MODEL_SHORTCUTS_BASE,
} from "./model-shortcuts.js";
import {
  FLOW_CONSTANTS_BASE,
  loadFlowConstants,
  publicEnv,
  setFlowConstantsDir,
} from "./flow-constants.js";
import { BENCH_DIR_NAME } from "../../eval/bench-contract.js";

/**
 * Builds the pre-validation resolver callback passed to `validateFlowSource`:
 * first resolves `{{vars.*}}` references, THEN expands any `llm.shortcut`
 * references against `flows/model-shortcuts.yaml` (loaded/cached from the flow
 * file's directory). Shortcut expansion runs after variables so a shortcut name
 * supplied via a flow variable is already a literal name. A no-op for shortcuts
 * when no shortcuts file exists.
 */
function makeFlowValueResolver(
  flowsDir: string,
): (
  raw: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
  fileName: string,
) => void {
  return (raw, overrides, fileName) => {
    resolveRawFlowVariables(raw, overrides, fileName, {
      constants: loadFlowConstants(flowsDir),
      env: publicEnv(),
    });
    const shortcuts = loadModelShortcuts(flowsDir);
    if (shortcuts !== null) {
      resolveModelShortcuts(raw, shortcuts, fileName);
    }
  };
}

/**
 * Builds the shortcut-only expansion passed to `validateFlowSource` as its
 * template-phase callback: expands `llm.shortcut` references WITHOUT resolving
 * `{{vars.*}}`, so the placeholder-preserving template form becomes
 * schema-valid (a raw `{ shortcut: ... }` lacks provider/model) while variables
 * stay overridable per request. A no-op when there is no shortcuts file.
 */
function makeShortcutExpander(
  flowsDir: string,
): (raw: Record<string, unknown>, fileName: string) => void {
  return (raw, fileName) => {
    const shortcuts = loadModelShortcuts(flowsDir);
    if (shortcuts !== null) {
      resolveModelShortcuts(raw, shortcuts, fileName);
    }
  };
}

// ---------------------------------------------------------------------------
// FlowRegistry
// ---------------------------------------------------------------------------

/**
 * Read-only view of all loaded FlowDefinitions, keyed by flow ID.
 * Requirement 3.10: valid flows stored in an internal registry, retrievable by ID.
 */
export interface FlowRegistry {
  get(flowId: string): FlowDefinition | undefined;
  list(): FlowDefinition[];
  /**
   * Editable source form of a file flow (see `resolveFlowSourceIncludes`) and
   * the file it came from. Optional: composite/versioned/test registries that
   * have no file backing simply don't implement it.
   */
  getSource?(flowId: string): FlowSourceRecord | undefined;
}

/** A file flow's authoring form: references kept, sub-flows merged in. */
export interface FlowSourceRecord {
  definition: Record<string, unknown>;
  /** File name relative to the flows directory, e.g. `abby-pii.yaml`. */
  fileName: string;
}

/**
 * The source form with every reference expanded against the variables' DEFAULT
 * values (prompt includes, `{{vars.*}}`, `llm.shortcut`) — what schema and
 * semantic checks (`validateFlow`) need to see. Not schema-validated; the input
 * is not mutated.
 */
export function expandFlowSource(
  source: unknown,
  flowsDir: string,
  fileName = "<source>",
): unknown {
  if (typeof source !== "object" || source === null) return source;
  const clone = structuredClone(source) as Record<string, unknown>;
  const patches = stripSourceBookkeeping(clone);
  resolveFlowIncludes(clone, flowsDir, fileName);
  if (patches !== undefined) {
    try {
      applyIncludePatches(clone, patches);
    } catch (error) {
      // The load already reported this flow; expansion stays usable for the editor.
      if (!(error instanceof FlowIncludeError)) throw error;
    }
  }
  makeFlowValueResolver(flowsDir)(clone, undefined, fileName);
  return clone;
}

/**
 * Turns a flow's source form (as served to/saved by the Studio editor) into
 * the runtime definition — the same prompt-include, variable and model-shortcut
 * expansion a flow file goes through on load. The input is not mutated.
 */
export function materializeFlowSource(
  source: unknown,
  flowsDir: string,
  fileName = "<source>",
): ValidationResult {
  if (typeof source !== "object" || source === null) {
    return validateFlowSource(
      source,
      makeFlowValueResolver(flowsDir),
      makeShortcutExpander(flowsDir),
    );
  }
  const clone = structuredClone(source) as Record<string, unknown>;
  const patches = stripSourceBookkeeping(clone);
  try {
    resolveFlowIncludes(clone, flowsDir, fileName);
    if (patches !== undefined) applyIncludePatches(clone, patches);
  } catch (error) {
    if (error instanceof FlowIncludeError) {
      return { success: false, error: { fileName, reason: error.message } };
    }
    throw error;
  }
  return validateFlowSource(
    clone,
    makeFlowValueResolver(flowsDir),
    makeShortcutExpander(flowsDir),
  );
}

/**
 * Mutable implementation of FlowRegistry.
 */
class FlowRegistryImpl implements FlowRegistry {
  private readonly _flows = new Map<string, FlowDefinition>();
  private readonly _sources = new Map<string, FlowSourceRecord>();

  getSource(flowId: string): FlowSourceRecord | undefined {
    return this._sources.get(flowId);
  }

  setSource(flowId: string, source: FlowSourceRecord): void {
    this._sources.set(flowId, source);
  }

  get(flowId: string): FlowDefinition | undefined {
    return this._flows.get(flowId);
  }

  list(): FlowDefinition[] {
    return Array.from(this._flows.values());
  }

  has(flowId: string): boolean {
    return this._flows.has(flowId);
  }

  set(flowId: string, def: FlowDefinition): void {
    this._flows.set(flowId, def);
  }

  delete(flowId: string): void {
    this._flows.delete(flowId);
    this._sources.delete(flowId);
  }
}

// ---------------------------------------------------------------------------
// FlowParserService
// ---------------------------------------------------------------------------

export interface FlowParserService {
  /** Loads all flows from flowsDir, starts file watcher. */
  start(): Promise<void>;
  /** Stops the file watcher. */
  stop(): Promise<void>;
  /** Returns the FlowRegistry. */
  getRegistry(): FlowRegistry;
}

/** Options for createFlowParserService. */
export interface FlowParserOptions {
  onDispatchChange?: () => void;
  onAccessChange?: () => void;
  onCanaryChange?: () => void;
  onGuardrailsChange?: () => void;
  onExperimentsChange?: () => void;
  onToolAuthzChange?: () => void;
  onFlowChange?: () => void;
  /** Called when compliance-policy.yaml/.json changes on disk. */
  onComplianceChange?: () => void;
  /** Called when shadow.yaml/.json changes on disk (shadow mode hot-reload). */
  onShadowChange?: () => void;
}

// ---------------------------------------------------------------------------
// Reserved File Names
// ---------------------------------------------------------------------------

const DISPATCH_BASE = "dispatch";
const ACCESS_BASE = "access";
const CANARY_BASE = "canary";
const GUARDRAILS_BASE = "guardrails";
const EXPERIMENTS_BASE = "experiments";
const MCP_BASE = "mcp";
const TOOL_AUTHZ_BASE = "tool-authz";
const COMPLIANCE_POLICY_BASE = "compliance-policy";
const SHADOW_BASE = "shadow";

const RESERVED_BASES = new Set([
  DISPATCH_BASE,
  ACCESS_BASE,
  CANARY_BASE,
  GUARDRAILS_BASE,
  EXPERIMENTS_BASE,
  MCP_BASE,
  TOOL_AUTHZ_BASE,
  COMPLIANCE_POLICY_BASE,
  SHADOW_BASE,
  // Not a flow — bundles engine/model/preset/credential shortcuts consumed at
  // load time by the shortcut resolver. Must never be parsed as a live flow.
  MODEL_SHORTCUTS_BASE,
  // Not a flow — global `{{const.*}}` values for flow variables.
  FLOW_CONSTANTS_BASE,
]);

/**
 * True for documentation-template files whose base name ends in `.example`
 * (e.g. `canary.example.yaml`, `shadow.example.json`). These are config samples
 * — some are multi-document YAML, some are not flow definitions at all — so they
 * must never be parsed as live flows or config.
 */
function isExampleFile(base: string): boolean {
  return base.endsWith(".example");
}

/**
 * True for paths below the `bench/` directory of a flows dir. Bench files
 * (`<flowId>.bench.yaml`) are release-gate definitions, not flows and not
 * includes — the watcher must skip them entirely (they are read on demand by
 * `atf flows release`). The initial scan is non-recursive, so it skips the
 * directory implicitly.
 */
function isBenchPath(relToFlowsDir: string): boolean {
  return relToFlowsDir === BENCH_DIR_NAME || relToFlowsDir.startsWith(`${BENCH_DIR_NAME}${path.sep}`);
}

// ---------------------------------------------------------------------------
// Conflict Logging
// ---------------------------------------------------------------------------

/**
 * Logs a duplicate-ID conflict to stderr.
 * Requirement 3.5: conflict log naming both files; first definition is kept.
 */
function logConflict(
  flowId: string,
  existingFile: string,
  incomingFile: string,
): void {
  const entry = {
    level: "error",
    component: "flow-parser",
    reason: "Duplicate flow ID — keeping first definition, discarding second",
    flowId,
    keptFile: existingFile,
    discardedFile: incomingFile,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// File Loading
// ---------------------------------------------------------------------------

/**
 * Loads a single flow file asynchronously, validates it, and registers it.
 */
async function loadFlowFileAsync(
  filePath: string,
  fileName: string,
  registry: FlowRegistryImpl,
  fileOwner: Map<string, string>,
  isCurrent?: () => boolean,
): Promise<void> {
  let raw: unknown;

  try {
    raw = await parseFlowFileAsync(filePath);
  } catch (err) {
    // The file may have been deleted while this (watcher-triggered) read was in
    // flight: that is not a load failure, and must not resurrect a ledger entry
    // the delete just cleared.
    if (isCurrent?.() === false) return;
    logValidationError(fileName, "Failed to read or parse flow file", err);
    return;
  }
  if (isCurrent?.() === false) return;

  registerParsedFlow(raw, filePath, fileName, registry, fileOwner);
}

/**
 * The definition the runtime registers for one flow file: sub-flow includes
 * merged, prompt files, variables and model shortcuts expanded, validated —
 * the same steps as the loader below, without registering anything. Its
 * `computeFlowDigest` equals the `flow_digest` a server that loaded this file
 * reports in the debug trace. Throws with the validation reason.
 */
export function resolveFlowFile(filePath: string): FlowDefinition {
  const raw = parseFlowFile(filePath);
  const fileName = path.basename(filePath);
  if (typeof raw === "object" && raw !== null) {
    resolveFlowIncludes(raw as Record<string, unknown>, path.dirname(filePath), fileName);
  }
  const result = validateFlowSource(
    raw,
    makeFlowValueResolver(path.dirname(filePath)),
    makeShortcutExpander(path.dirname(filePath)),
  );
  if (!result.success) {
    throw new Error(`${fileName}: ${result.error.reason}`);
  }
  return result.data;
}
/**
 * Synchronous file loading for startup — blocks until all flows are loaded.
 */
function loadFlowFile(
  filePath: string,
  fileName: string,
  registry: FlowRegistryImpl,
  fileOwner: Map<string, string>,
): void {
  let raw: unknown;

  try {
    raw = parseFlowFile(filePath);
  } catch (err) {
    logValidationError(fileName, "Failed to read or parse flow file", err);
    return;
  }

  registerParsedFlow(raw, filePath, fileName, registry, fileOwner);
}

/**
 * Effective operational profile of the process: `ATF_PROFILE` wins over
 * `APP_ENV` (resolved like `apps/runtime/src/config/load.ts`). An unknown
 * value is treated as non-production here — startup validation of the same
 * variable happens in the config loader and must not be duplicated (or
 * crash) inside the parser.
 */
function isProductionProfile(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return resolveOperationalProfile(env, ["APP_ENV"]).isProduction;
  } catch {
    return false;
  }
}

/**
 * Shared post-parse step of the sync and async loaders: builds the editable
 * source form from a pristine copy, expands the runtime form, validates and
 * registers both.
 */
function registerParsedFlow(  raw: unknown,
  filePath: string,
  fileName: string,
  registry: FlowRegistryImpl,
  fileOwner: Map<string, string>,
): void {
  let source: Record<string, unknown> | undefined;
  if (typeof raw === "object" && raw !== null) {
    try {
      source = structuredClone(raw) as Record<string, unknown>;
      resolveFlowSourceIncludes(source, path.dirname(filePath), fileName);
      resolveFlowIncludes(
        raw as Record<string, unknown>,
        path.dirname(filePath),
        fileName,
      );
    } catch (error) {
      // A wrong `$include` (for example a patch for a node that does not
      // exist) keeps the flow from loading, like any other validation error.
      if (error instanceof FlowIncludeError) {
        logValidationError(fileName, error.message);
        return;
      }
      throw error;
    }
  }

  const result = validateFlowSource(
    raw,
    makeFlowValueResolver(path.dirname(filePath)),
    makeShortcutExpander(path.dirname(filePath)),
  );
  if (!result.success) {
    logValidationError(fileName, result.error.reason, result.error.details);
    return;
  }

  const flow = result.data;

  // Unknown node `config` keys: outside production a warning; with the
  // production profile the flow is not registered and lands in the load-
  // failure ledger (readiness `flow_load: degraded`).
  const unknownKeys = findUnknownConfigKeys(flow.nodes);
  if (unknownKeys.length > 0) {
    const summary = unknownKeys.map((u) => `${u.nodeId}.config.${u.key}`).join(", ");
    if (isProductionProfile()) {
      logValidationError(
        fileName,
        `Unknown config keys (not loaded in production): ${summary}`,
        { unknownConfigKeys: unknownKeys },
      );
      return;
    }
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        component: "flow-parser",
        file: fileName,
        unknownConfigKeys: unknownKeys,
        msg: `Flow ${flow.id} has unknown config keys that the runtime ignores: ${summary}`,
      })}\n`,
    );
  }

  const existingOwner = fileOwner.get(flow.id);

  if (existingOwner !== undefined && existingOwner !== fileName) {
    logConflict(flow.id, existingOwner, fileName);
    recordFlowLoadFailure(
      fileName,
      `Duplicate flow ID '${flow.id}' — already defined by ${existingOwner}`,
    );
    return;
  }

  registry.set(flow.id, flow);
  clearFlowLoadFailure(fileName);
  if (source !== undefined) registry.setSource(flow.id, { definition: source, fileName });
  fileOwner.set(flow.id, fileName);
}

// ---------------------------------------------------------------------------
// FlowParserService Implementation
// ---------------------------------------------------------------------------

/**
 * Implementation of FlowParserService.
 */
class FlowParserServiceImpl implements FlowParserService {
  private readonly registry = new FlowRegistryImpl();
  private readonly fileOwner = new Map<string, string>();
  private readonly fileIndex = new Map<string, string>();
  private watcher: import("chokidar").FSWatcher | null = null;

  constructor(
    private readonly flowsDir: string,
    private readonly options: FlowParserOptions = {},
  ) {}

  /**
   * Forget everything a flow file contributed: its registered flow(s), the
   * source record, the ownership entry and any recorded load failure.
   */
  private dropFlowFile(file: string): void {
    for (const [flowId, owner] of [...this.fileOwner]) {
      if (owner !== file) continue;
      this.registry.delete(flowId);
      this.fileOwner.delete(flowId);
    }
    this.fileIndex.delete(file);
    clearFlowLoadFailure(file);
  }

  private _reloadAllFlows(): void {
    for (const [fileName, filePath] of this.fileIndex) {
      void loadFlowFileAsync(
        filePath,
        fileName,
        this.registry,
        this.fileOwner,
        () => this.fileIndex.has(fileName),
      );
    }
  }

  async start(): Promise<void> {
    // Requirement 3.1: missing directory → structured error + exit(1)
    if (!fs.existsSync(this.flowsDir)) {
      const entry = {
        level: "error",
        component: "flow-parser",
        reason: "Flows directory does not exist",
        flowsDir: this.flowsDir,
      };
      process.stderr.write(`${JSON.stringify(entry)}\n`);
      process.exit(1);
    }

    // `{{const.*}}` in variables resolves against this directory's constants
    // file, also for per-request resolution (applyFlowVariables).
    setFlowConstantsDir(this.flowsDir);

    // Load all existing flow files, skipping reserved names
    const files = fs.readdirSync(this.flowsDir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!isFlowFileExtension(ext)) continue;
      const base = path.basename(file, ext);
      if (RESERVED_BASES.has(base)) continue;
      // Skip documentation templates (`*.example.yaml|yml|json`) — they are
      // config samples (some multi-document, some not flows at all) and must
      // never be parsed as live flows.
      if (isExampleFile(base)) continue;
      const filePath = path.join(this.flowsDir, file);
      this.fileIndex.set(file, filePath);
      loadFlowFile(filePath, file, this.registry, this.fileOwner);
    }

    // Requirement 3.2: file watcher — detects new/changed files within 10s
    const chokidar = await import("chokidar");
    this.watcher = chokidar.watch(
      [
        this.flowsDir,
        path.join(this.flowsDir, "prompts"),
        path.join(this.flowsDir, "subflows"),
      ],
      {
        persistent: false,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100,
        },
      },
    );

    const handleFile = (filePath: string): void => {
      const file = path.basename(filePath);
      const relToFlowsDir = path.relative(this.flowsDir, filePath);

      const isIncludeFile =
        !relToFlowsDir.startsWith("..") &&
        (relToFlowsDir.startsWith(`prompts${path.sep}`) ||
          relToFlowsDir.startsWith(`subflows${path.sep}`));

      if (isIncludeFile) {
        this._reloadAllFlows();
        return;
      }

      // Bench files are release-gate definitions, not flows — never loaded.
      if (isBenchPath(relToFlowsDir)) return;

      const ext = path.extname(file).toLowerCase();
      if (!isFlowFileExtension(ext)) return;
      const base = path.basename(file, ext);

      // Documentation templates are never live flows/config.
      if (isExampleFile(base)) return;

      if (base === DISPATCH_BASE) {
        this.options.onDispatchChange?.();
        return;
      }
      if (base === ACCESS_BASE) {
        this.options.onAccessChange?.();
        return;
      }
      if (base === CANARY_BASE) {
        this.options.onCanaryChange?.();
        return;
      }
      if (base === GUARDRAILS_BASE) {
        this.options.onGuardrailsChange?.();
        return;
      }
      if (base === EXPERIMENTS_BASE) {
        this.options.onExperimentsChange?.();
        return;
      }
      if (base === MCP_BASE) return;
      if (base === TOOL_AUTHZ_BASE) {
        this.options.onToolAuthzChange?.();
        return;
      }
      if (base === COMPLIANCE_POLICY_BASE) {
        this.options.onComplianceChange?.();
        return;
      }
      if (base === SHADOW_BASE) {
        this.options.onShadowChange?.();
        return;
      }
      if (base === FLOW_CONSTANTS_BASE) {
        // Constants feed variable evaluation — re-expand every flow (the
        // constants cache invalidates by mtime).
        this._reloadAllFlows();
        this.options.onFlowChange?.();
        return;
      }
      if (base === MODEL_SHORTCUTS_BASE) {
        // Shortcuts changed — every flow that references a shortcut must be
        // re-expanded. The shortcuts cache invalidates by mtime, so a plain
        // reload picks up the new definitions.
        this._reloadAllFlows();
        this.options.onFlowChange?.();
        return;
      }
      void loadFlowFileAsync(
        filePath,
        file,
        this.registry,
        this.fileOwner,
        () => this.fileIndex.has(file),
      ).then(() => {
        this.options.onFlowChange?.();
      });
      this.fileIndex.set(file, filePath);
    };

    this.watcher.on("add", handleFile);
    this.watcher.on("change", handleFile);
    // A deleted flow file must stop being served: without this the flow stayed
    // registered (and executable) until the next restart.
    this.watcher.on("unlink", (filePath: string) => {
      const file = path.basename(filePath);
      const relToFlowsDir = path.relative(this.flowsDir, filePath);
      const isIncludeFile =
        !relToFlowsDir.startsWith("..") &&
        (relToFlowsDir.startsWith(`prompts${path.sep}`) ||
          relToFlowsDir.startsWith(`subflows${path.sep}`));
      if (isIncludeFile) {
        // A removed include can break the flows that use it: re-validate all.
        this._reloadAllFlows();
        this.options.onFlowChange?.();
        return;
      }
      // A removed bench file never belonged to a flow.
      if (isBenchPath(relToFlowsDir)) return;
      if (!this.fileIndex.has(file)) return;
      this.dropFlowFile(file);
      this.options.onFlowChange?.();
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  getRegistry(): FlowRegistry {
    return this.registry;
  }
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Creates a new FlowParserService for the given flows directory.
 *
 * @param flowsDir  Path to the directory containing flow JSON files
 * @param options   Optional hooks (e.g. dispatch.json hot-reload callback)
 */
export function createFlowParserService(
  flowsDir: string,
  options?: FlowParserOptions,
): FlowParserService {
  return new FlowParserServiceImpl(flowsDir, options);
}
