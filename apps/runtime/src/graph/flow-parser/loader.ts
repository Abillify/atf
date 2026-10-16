// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow Parser — Loader, Hot-Reload, FlowParserService
 *
 * Handles file loading (YAML/JSON precedence), chokidar-based hot-reload,
 * and the FlowParserService lifecycle.
 *
 * Requirements: 3.1, 3.2, 3.4, 3.5, 3.10
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FlowDefinition } from "../../types/flow.js";
import {
  parseFlowFile,
  parseFlowFileAsync,
  isFlowFileExtension,
} from "../../util/parse-flow-file.js";
import { logValidationError, validateFlowSource } from "./validate.js";
import {
  resolveFlowIncludes,
  resolveFlowSourceIncludes,
  resolveRawFlowVariables,
  INCLUDE_EDGE_ORIGINS_KEY,
} from "./normalize.js";

/** Drops source-form-only bookkeeping from a clone headed for the runtime. */
function stripSourceBookkeeping(raw: Record<string, unknown>): void {
  const meta = raw.metadata;
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    delete (meta as Record<string, unknown>)[INCLUDE_EDGE_ORIGINS_KEY];
  }
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
  stripSourceBookkeeping(clone);
  resolveFlowIncludes(clone, flowsDir, fileName);
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
  stripSourceBookkeeping(clone);
  resolveFlowIncludes(clone, flowsDir, fileName);
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
): Promise<void> {
  let raw: unknown;

  try {
    raw = await parseFlowFileAsync(filePath);
  } catch (err) {
    logValidationError(fileName, "Failed to read or parse flow file", err);
    return;
  }

  registerParsedFlow(raw, filePath, fileName, registry, fileOwner);
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
 * Shared post-parse step of the sync and async loaders: builds the editable
 * source form from a pristine copy, expands the runtime form, validates and
 * registers both.
 */
function registerParsedFlow(
  raw: unknown,
  filePath: string,
  fileName: string,
  registry: FlowRegistryImpl,
  fileOwner: Map<string, string>,
): void {
  let source: Record<string, unknown> | undefined;
  if (typeof raw === "object" && raw !== null) {
    source = structuredClone(raw) as Record<string, unknown>;
    resolveFlowSourceIncludes(source, path.dirname(filePath), fileName);
    resolveFlowIncludes(
      raw as Record<string, unknown>,
      path.dirname(filePath),
      fileName,
    );
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
  const existingOwner = fileOwner.get(flow.id);

  if (existingOwner !== undefined && existingOwner !== fileName) {
    logConflict(flow.id, existingOwner, fileName);
    return;
  }

  registry.set(flow.id, flow);
  if (source !== undefined) registry.setSource(flow.id, { definition: source, fileName });
  fileOwner.set(flow.id, fileName);
}

// ---------------------------------------------------------------------------
// FlowParserService Implementation
// ---------------------------------------------------------------------------

/**
 * Implementation of FlowParserService.
 * Requirements: 3.1, 3.2, 3.4, 3.5, 3.10
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

  private _reloadAllFlows(): void {
    for (const [fileName, filePath] of this.fileIndex) {
      void loadFlowFileAsync(filePath, fileName, this.registry, this.fileOwner);
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
      ).then(() => {
        this.options.onFlowChange?.();
      });
      this.fileIndex.set(file, filePath);
    };

    this.watcher.on("add", handleFile);
    this.watcher.on("change", handleFile);
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
