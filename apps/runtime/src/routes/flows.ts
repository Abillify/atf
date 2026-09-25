// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow management routes (`src/routes/flows.ts`)
 *
 * The operator/authoring plane for flows, under `/flows/*` and gated by the
 * same `MONITORING_AUTH` token as the dashboard. Supports all three editor
 * stages:
 *
 *   Stage 1 (read + validate — always available):
 *     GET  /flows                 — list every flow (file + online), with source
 *     GET  /flows/:id             — full definition(s) for inspect/edit
 *     POST /flows/validate        — dry-run validation of a definition
 *
 *   Stage 3 (online authoring — only when a FlowStore is configured):
 *     PUT    /flows/:id/draft     — save the working draft
 *     POST   /flows/:id/publish   — validate + promote draft to live
 *     DELETE /flows/:id           — remove an online flow
 *     GET    /flows/:id/versions  — published version history
 *     POST   /flows/:id/rollback  — re-publish a past version
 *
 * File-based flows are read-only here (they are owned by FLOWS_DIR / the image);
 * an online flow with the same id overrides a file flow in the composite
 * registry. So a deployment can be fully file/image based, fully online, or a
 * mix. No `any` at module boundaries.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { mergeFlowIntoYaml } from "../graph/flow-yaml-merge.js";
import { Hono } from "hono";
import type { FlowRegistry } from "../graph/flow-parser.js";
import type { FlowStore } from "../graph/flow-store.js";
import { FlowStoreError } from "../graph/flow-store.js";
import type { DbFlowSource } from "../graph/flow-registry-composite.js";
import { validateFlow } from "../graph/flow-validator.js";
import {
  validateFlowDefinition,
  expandFlowSource,
} from "../graph/flow-parser.js";
import { includeEdgeKey } from "../graph/flow-parser/normalize.js";
import { materializeFlowSource } from "../graph/flow-parser.js";
import type { StudioTestRegistry } from "../graph/flow-registry-studio.js";
import {
  COMMON_CONFIG_FIELDS,
  NODE_TYPE_CATALOG,
} from "../graph/node-type-catalog.js";
import { describeShortcut, loadModelShortcuts } from "../graph/flow-parser/model-shortcuts.js";
import { loadFlowConstants, publicEnv } from "../graph/flow-parser/flow-constants.js";
import { evaluateFlowVariables } from "../graph/flow-parser/variable-values.js";
import { FLOW_REFERENCE } from "../graph/flow-reference-data.js";
import {
  evaluateConditionExpression,
  validateConditionExpression,
} from "../graph/condition-evaluator.js";
import { diffFlows } from "../graph/flow-diff.js";
import { analyzeFlowCompatibility } from "../graph/flow-compatibility.js";
import { collectFlowLlmConfigs, describeFlowCapabilities } from "../graph/flow-capabilities.js";
import { buildReleasePassport } from "../release/release-passport.js";
import { evaluatePolicyForModels } from "../compliance/policy-evaluator.js";
import type { CompliancePolicy } from "../compliance/policy-schema.js";
import {
  simulateFlow,
  type SimulationDeps,
} from "../graph/graph-engine/simulate.js";
import { proposeFlowEdit } from "../graph/flow-copilot.js";
import { createLlmProvider } from "../graph/llm-factory.js";
import type { AbManager } from "../graph/flow-ab.js";
import type { FlowDefinition } from "../types/flow.js";
import type { AppConfig } from "../config/index.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
  type OperatorIdentity,
} from "../middleware/operator-rbac.js";
import type { AuditLog } from "../observability/audit-log.js";

// ---------------------------------------------------------------------------
// Flow write request (Req. 22, §3.3)
// ---------------------------------------------------------------------------

/** Request body for POST/PUT /flows/write. */
export interface FlowWriteRequest {
  /** Flow filename without extension and without path traversal. */
  id: string;
  /** Serialization format of the written file. */
  format: "yaml" | "json";
  /** Raw flow definition — validated server-side before writing. */
  definition: unknown;
  /** SHA-256 hex hash of the current file content for conflict detection (Req. 14.6). */
  baseHash?: string;
}

/** Compute the SHA-256 hex digest of a UTF-8 string. */
function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Resolves the absolute, canonical target path for writing a flow file and
 * verifies it is strictly inside `flowsDir`.
 *
 * Req. 22.2: no `..` segments, realpath prefix check.
 *
 * @returns The safe absolute target path.
 * @throws  `Error` with `code === "PATH_TRAVERSAL"` when the resolved path
 *          escapes `flowsDir`.
 */
function resolveFlowWritePath(
  flowsDir: string,
  id: string,
  format: "yaml" | "json",
): string {
  // Reject explicit traversal sequences in the id before any resolution.
  if (
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    const err = new Error(
      `Illegal flow id: "${id}" contains forbidden characters.`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_TRAVERSAL";
    throw err;
  }

  // Resolve the flows directory to its realpath (follows symlinks).
  // If flowsDir does not exist yet we fall back to its absolute path so the
  // caller can create it; the prefix check still applies.
  let canonicalDir: string;
  try {
    canonicalDir = fs.realpathSync(flowsDir);
  } catch {
    canonicalDir = path.resolve(flowsDir);
  }

  const ext = format === "yaml" ? ".yaml" : ".json";
  const target = path.resolve(canonicalDir, `${id}${ext}`);

  // Ensure the resolved target stays inside the flows directory.
  if (!target.startsWith(canonicalDir + path.sep) && target !== canonicalDir) {
    const err = new Error(
      `Resolved path "${target}" escapes the flows directory "${canonicalDir}".`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_TRAVERSAL";
    throw err;
  }

  return target;
}

/**
 * Resolves a sub-flow include path (e.g. "subflows/guard.yaml", from
 * `metadata.$includeOrigins` — see `flow-parser/normalize.ts`) to an
 * absolute path strictly inside `flowsDir`, rejecting traversal.
 *
 * Unlike {@link resolveFlowWritePath} (used for the top-level flow id), an
 * include path already carries its own extension and is EXPECTED to contain
 * subdirectory segments (that's the point of organizing sub-flows under
 * `subflows/`) — so only `..` traversal, null bytes, and absolute paths are
 * rejected, not `/` itself.
 *
 * @throws `Error` with `code === "PATH_TRAVERSAL"` when the resolved path
 *         escapes `flowsDir`.
 */
function resolveIncludeWritePath(flowsDir: string, relPath: string): string {
  if (
    relPath.includes("..") ||
    relPath.includes("\0") ||
    path.isAbsolute(relPath)
  ) {
    const err = new Error(
      `Illegal sub-flow include path: "${relPath}" contains forbidden segments.`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_TRAVERSAL";
    throw err;
  }

  let canonicalDir: string;
  try {
    canonicalDir = fs.realpathSync(flowsDir);
  } catch {
    canonicalDir = path.resolve(flowsDir);
  }

  const target = path.resolve(canonicalDir, relPath);
  if (!target.startsWith(canonicalDir + path.sep) && target !== canonicalDir) {
    const err = new Error(
      `Resolved path "${target}" escapes the flows directory "${canonicalDir}".`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_TRAVERSAL";
    throw err;
  }

  return target;
}

/**
 * Reads `metadata.$includeOrigins` (`nodeId -> relPath`) off a raw, already
 * schema-validated flow definition. Returns `undefined` when absent/empty —
 * the common case for the overwhelming majority of flows that don't use
 * `$include.subflows` at all, which keeps `/flows/write` a no-op passthrough
 * for them (see `splitByIncludeOrigin` below).
 */
function parseIncludeOrigins(definition: FlowDefinition): Record<string, string> | undefined {
  const raw = (definition.metadata as Record<string, unknown> | undefined)?.$includeOrigins;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [nodeId, relPath] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof relPath === "string" && relPath.trim().length > 0) {
      result[nodeId] = relPath.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Reads `metadata.$includeEdgeOrigins` (edge key -> relPath) off a source-form definition. */
function parseIncludeEdgeOrigins(
  definition: FlowDefinition,
): Record<string, string> | undefined {
  const raw = (definition.metadata as Record<string, unknown> | undefined)?.[
    "$includeEdgeOrigins"
  ];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0,
    ),
  );
}

/** Serializes a bare `{nodes, edges}` sub-flow fragment per its file extension. */
function serializeSubflowFragment(
  ext: string,
  fragment: { nodes: FlowDefinition["nodes"]; edges: FlowDefinition["edges"] },
): string {
  return ext === ".yaml" || ext === ".yml"
    ? stringifyYaml(fragment, { lineWidth: 120 })
    : `${JSON.stringify(fragment, null, 2)}\n`;
}

/**
 * Splits an `$include`-composed flow definition back into its sub-flow
 * file(s) plus a parent-only definition, writing each sub-flow file directly
 * (atomically, path-traversal-checked) and returning the parent definition
 * for the caller to write via the normal path.
 *
 * This is what lets the Studio builder round-trip a flow composed via
 * `metadata.$include.subflows` without flattening the sub-flow's nodes back
 * into the parent file on every save — see `flow-parser/normalize.ts` for
 * how `$includeOrigins` is produced on load. A cross-boundary edge (only one
 * endpoint tagged, or endpoints tagged with different origins) stays with
 * the parent — after the files are re-merged on next load it still resolves
 * correctly either way.
 */
async function splitByIncludeOrigin(
  definition: FlowDefinition,
  origins: Record<string, string>,
  flowsDir: string,
  options: {
    /** `metadata.$includeEdgeOrigins` of a source-form definition. */
    edgeOrigins?: Record<string, string>;
    /** The parent file as currently on disk (parsed), if any. */
    existingParent?: Record<string, unknown>;
  } = {},
): Promise<FlowDefinition> {
  const originOf = (nodeId: string): string | undefined => origins[nodeId];
  const edgeOrigins = options.edgeOrigins ?? {};

  const byOrigin = new Map<
    string,
    { nodes: FlowDefinition["nodes"]; edges: FlowDefinition["edges"] }
  >();
  const bucketFor = (origin: string) => {
    const bucket = byOrigin.get(origin) ?? { nodes: [], edges: [] };
    byOrigin.set(origin, bucket);
    return bucket;
  };
  const parentNodes: FlowDefinition["nodes"] = [];
  for (const node of definition.nodes) {
    const origin = originOf(node.id);
    if (origin === undefined) {
      parentNodes.push(node);
      continue;
    }
    bucketFor(origin).nodes.push(node);
  }

  const parentEdges: FlowDefinition["edges"] = [];
  for (const edge of definition.edges) {
    // An edge loaded from a sub-flow goes back to that file even when it links
    // nodes of two different sub-flows; otherwise fall back to "both endpoints
    // share an origin", and everything else stays with the parent.
    const key = includeEdgeKey(edge);
    const recorded = key !== undefined ? edgeOrigins[key] : undefined;
    const sourceOrigin = originOf(edge.source);
    const targetOrigin = originOf(edge.target);
    const origin =
      recorded ??
      (sourceOrigin !== undefined && sourceOrigin === targetOrigin
        ? sourceOrigin
        : undefined);
    if (origin !== undefined) {
      bucketFor(origin).edges.push(edge);
    } else {
      parentEdges.push(edge);
    }
  }

  for (const [relPath, fragment] of byOrigin) {
    const targetPath = resolveIncludeWritePath(flowsDir, relPath);
    const ext = path.extname(targetPath).toLowerCase();
    let existing: string | null = null;
    try {
      existing = await fs.promises.readFile(targetPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    let content: string;
    if (existing !== null && (ext === ".yaml" || ext === ".yml")) {
      // Same comment-preserving merge as the parent file; other top-level keys
      // of the sub-flow file (description, notes, …) are kept as they are, and
      // an `edges` key the file never had isn't invented.
      try {
        const current = parseYaml(existing) as Record<string, unknown> | null;
        const base =
          current !== null && typeof current === "object" && !Array.isArray(current)
            ? current
            : {};
        const next: Record<string, unknown> = { ...base, nodes: fragment.nodes };
        if (fragment.edges.length > 0 || "edges" in base) next.edges = fragment.edges;
        else delete next.edges;
        content = mergeFlowIntoYaml(existing, next, { lineWidth: 120 });
      } catch {
        content = serializeSubflowFragment(ext, fragment);
      }
    } else {
      content = serializeSubflowFragment(ext, fragment);
    }
    await atomicWriteFile(targetPath, content);
  }

  const {
    $includeOrigins: _omit,
    $includeEdgeOrigins: _omitEdges,
    ...restMetadata
  } = (definition.metadata ?? {}) as Record<string, unknown>;
  void _omit;
  void _omitEdges;

  // Keep the parent's existing `$include` directive (its other keys such as a
  // `_comment`, and its order — the merge order matters) and only reconcile
  // the list of files with what is still in use.
  const existingMeta = options.existingParent?.["metadata"];
  const existingInclude =
    typeof existingMeta === "object" && existingMeta !== null
      ? ((existingMeta as Record<string, unknown>)["$include"] as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const inUse = [...byOrigin.keys()];
  const previous = Array.isArray(existingInclude?.["subflows"])
    ? (existingInclude["subflows"] as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];
  const subflowPaths = [
    ...previous.filter((p) => inUse.includes(p.trim())),
    ...inUse.filter((p) => !previous.some((q) => q.trim() === p)),
  ];

  const parent: Record<string, unknown> = {
    ...definition,
    nodes: parentNodes,
    edges: parentEdges,
    metadata: {
      ...restMetadata,
      ...(subflowPaths.length > 0
        ? { $include: { ...(existingInclude ?? {}), subflows: subflowPaths } }
        : {}),
    },
  };
  // A parent that only assembles sub-flows has no nodes/edges keys of its own;
  // don't add empty ones.
  for (const key of ["nodes", "edges"] as const) {
    if (
      (parent[key] as unknown[]).length === 0 &&
      options.existingParent !== undefined &&
      !(key in options.existingParent)
    ) {
      delete parent[key];
    }
  }
  return parent as unknown as FlowDefinition;
}

/**
 * Atomically writes `content` to `targetPath` by first writing to a temp file
 * in the same directory, then renaming it into place.
 *
 * Req. 22.4: no partial file left on failure — temp file is cleaned up on error.
 */
async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(targetPath);
  // Use the OS temp dir as a first choice — but rename is only atomic when
  // source and target are on the same filesystem, so we write into the same
  // target directory instead.
  const tmpPath = path.join(
    dir,
    `.tmp-${crypto.randomBytes(8).toString("hex")}`,
  );
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmpPath, content, "utf-8");
    await fs.promises.rename(tmpPath, targetPath);
  } catch (err) {
    // Clean up the temp file so no partial content is left on disk.
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export interface FlowsRouterDeps {
  /** File-based flows (read-only here). */
  fileRegistry: FlowRegistry;
  /** Online flow store — when absent, write routes return 501. */
  store?: FlowStore;
  /** DB snapshot to refresh after a mutation (immediate local effect). */
  dbSource?: Pick<DbFlowSource, "refresh">;
  /** Known MCP tool ids for validation warnings. */
  knownToolIds?: ReadonlySet<string>;
  /** Require a valid token (header or ?token=) — mirrors MONITORING_AUTH. */
  authRequired?: boolean;
  /** Optional A/B experiment manager (exposes live experiment stats). */
  abManager?: AbManager;
  /** Operator RBAC authorizer (defaults to a back-compat one from authRequired). */
  operatorAuth?: OperatorAuthorizer;
  /** Optional audit log for recording flow mutations. */
  auditLog?: AuditLog;
  /**
   * Used to report a fallback from the comment-preserving YAML merge to a plain
   * rewrite. Optional — the outcome is also in the response body and the audit
   * entry (`commentsPreserved`), so a missing logger loses no evidence.
   */
  logger?: import("../observability/logger.js").Logger;
  /**
   * Directory that contains flow YAML/JSON files. Required for the file-based
   * write endpoint (POST/PUT /flows/write). When absent the endpoint returns 501.
   * Req. 22 — path-traversal protection uses this as the trusted base.
   */
  flowsDir?: string;
  /**
   * Flows directory used READ-ONLY to expand source-form definitions (model
   * shortcuts, prompt includes) for validation and to serve a file flow's
   * editable source. Independent of `flowsDir`, which additionally enables
   * writing files.
   */
  sourceDir?: string;
  /**
   * Throwaway registry for Studio "Run & Trace" test runs
   * (`POST /flows/:id/test-run`). When absent that endpoint returns 501.
   */
  studioTests?: StudioTestRegistry;
  /**
   * Application configuration, used solely to resolve the LLM behind
   * `POST /flows/:id/copilot` (`appConfig.defaultLlm` + provider API keys via
   * `createLlmProvider`). When absent, or `defaultLlm` is unset, the copilot
   * endpoint returns 501 rather than guessing a model.
   */
  appConfig?: AppConfig;
  /** Current compliance policy reader for read-only release assessment. */
  getCompliancePolicy?: () => CompliancePolicy | undefined;
  /**
   * Collaborators for `POST /flows/:id/simulate` (counterfactual impact
   * simulation — runs a draft against real historical snapshots). When
   * absent (or `appConfig` is absent), the endpoint returns 501: it needs a
   * replay store to source snapshots from, so there's nothing useful for it
   * to do without one.
   */
  simulation?: Omit<SimulationDeps, "appConfig">;
}

interface FlowListEntry {
  id: string;
  name: string;
  /** Where the live definition comes from. */
  source: "file" | "online";
  /** True when an online flow shadows a same-id file flow. */
  shadowsFile?: boolean;
  status: "published" | "draft" | "file";
  version: number;
  hasDraft: boolean;
  draftDirty: boolean;
  editable: boolean;
  nodeCount: number;
  edgeCount: number;
}

export function createFlowsRouter(deps: FlowsRouterDeps): Hono {
  const router = new Hono();
  const {
    fileRegistry,
    store,
    dbSource,
    knownToolIds,
    abManager,
    auditLog,
    flowsDir,
    appConfig,
    getCompliancePolicy,
  } = deps;
  const authRequired = deps.authRequired ?? false;
  const sourceDir = deps.sourceDir ?? flowsDir;
  /**
   * Source-form definitions keep `llm.shortcut`, `{{vars.*}}` and prompt
   * includes as references (that is what the editor saves). Validation must
   * see what the runtime will run, so expand a copy first. A no-op for
   * already-expanded definitions.
   */
  const expandForValidation = (def: unknown): unknown =>
    sourceDir !== undefined ? expandFlowSource(def, sourceDir) : def;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });
  const logger = deps.logger;

  /** Permission-aware guard: returns the actor when allowed, else null. */
  const guard = async (
    ctx: {
      req: {
        header: (k: string) => string | undefined;
        query: (k: string) => string | undefined;
      };
    },
    perm: Parameters<OperatorAuthorizer["authorize"]>[2],
  ): Promise<OperatorIdentity | null> => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      perm,
    );
    return r.ok
      ? (r.actor ?? { name: "operator", role: "admin", via: "open" })
      : null;
  };

  const unauthorized = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message: "Unauthorized operator access.",
          type: "authentication_error",
        },
      },
      401,
    );

  /** Configured AND actually writable (a read-only mount must not offer writes). */
  const flowsDirWritable = (): boolean => {
    if (flowsDir === undefined) return false;
    try {
      fs.accessSync(flowsDir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  const requireStore = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message:
            "Online flow editing is disabled. Set FLOW_EDITOR_ENABLED=true and configure DATABASE_URL, or deploy flows via FLOWS_DIR.",
          type: "not_implemented_error",
        },
      },
      501,
    );

  // -------------------------------------------------------------------------
  // GET /flows — list file + online flows
  // -------------------------------------------------------------------------
  router.get("/flows", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);

    const entries = new Map<string, FlowListEntry>();
    for (const f of fileRegistry.list()) {
      entries.set(f.id, {
        id: f.id,
        name: f.name,
        source: "file",
        status: "file",
        version: 0,
        hasDraft: false,
        draftDirty: false,
        editable: false,
        nodeCount: f.nodes.length,
        edgeCount: f.edges.length,
      });
    }
    if (store !== undefined) {
      for (const s of await store.listAll()) {
        const fileShadowed = entries.get(s.id)?.source === "file";
        const def =
          (await store.get(s.id))?.published ?? (await store.get(s.id))?.draft;
        entries.set(s.id, {
          id: s.id,
          name: s.name,
          source: "online",
          ...(fileShadowed ? { shadowsFile: true } : {}),
          status: s.hasPublished ? "published" : "draft",
          version: s.version,
          hasDraft: s.hasDraft,
          draftDirty: s.draftDirty,
          editable: true,
          nodeCount: def?.nodes.length ?? 0,
          edgeCount: def?.edges.length ?? 0,
        });
      }
    }
    return ctx.json({
      flows: [...entries.values()],
      onlineEditing: store !== undefined,
      fileWriting: flowsDirWritable(),
    });
  });

  // -------------------------------------------------------------------------
  // GET /flows/node-types — node type catalog for the Studio (forms, docs,
  // Copilot): every built-in type with its config keys, plus the tool ids of
  // connected MCP servers and the model shortcut names, so editors can offer
  // them as choices. Static path: registered before GET /flows/:id.
  // -------------------------------------------------------------------------
  router.get("/flows/node-types", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    const shortcuts =
      sourceDir !== undefined ? loadModelShortcuts(sourceDir) : null;
    return ctx.json({
      common: COMMON_CONFIG_FIELDS,
      types: NODE_TYPE_CATALOG,
      tools: [...(knownToolIds ?? [])].sort(),
      shortcuts: shortcuts ? Object.keys(shortcuts.shortcuts ?? {}).sort() : [],
      // name → "provider · model" / "pool (strategy): …" for pickers.
      shortcutInfo: shortcuts
        ? Object.fromEntries(
            Object.keys(shortcuts.shortcuts ?? {}).map((n) => [
              n,
              describeShortcut(shortcuts, n) ?? "",
            ]),
          )
        : {},
      // Global constants (flows/constants.yaml) and the allowlisted env
      // values — what `{{const.*}}` / `{{env.*}}` in variables can read.
      constants: sourceDir !== undefined ? loadFlowConstants(sourceDir) : {},
      publicEnv: publicEnv(),
      // Placeholders, condition grammar, variable references, calculations —
      // the same data docs/FLOWS.md is generated from.
      reference: FLOW_REFERENCE,
      // Concrete model ids of the central model presets (for `llm.model`).
      models: shortcuts
        ? [...new Set(Object.values(shortcuts.modelPresets ?? {}).map((p) => p.model))].sort()
        : [],
    });
  });

  // -------------------------------------------------------------------------
  // POST /flows/variables/evaluate — the Studio's variables table: evaluates a
  // `variables` map (cross-references, {{const.*}}, {{env.FLOW_PUBLIC_*}},
  // {{= calculations }}) exactly as a flow load does and returns the values.
  //   Body: { variables: object }
  //   200:  { values: object, errors: [{ name, message }] }
  // -------------------------------------------------------------------------
  router.post("/flows/variables/evaluate", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    const body = (await ctx.req.json().catch(() => null)) as { variables?: unknown } | null;
    const vars = body?.variables;
    if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
      return ctx.json(
        { error: { message: "`variables` must be an object.", type: "invalid_request_error" } },
        400,
      );
    }
    return ctx.json(
      evaluateFlowVariables(vars as Record<string, unknown>, undefined, {
        constants: sourceDir !== undefined ? loadFlowConstants(sourceDir) : {},
        env: publicEnv(),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // POST /flows/expressions/evaluate — the Studio's formula editor: checks a
  // routing/condition expression and evaluates it against sample values with
  // the runtime's own evaluator, so the preview is exactly what a run does.
  //   Body: { expression: string, sample?: object }
  //   200:  { valid: true, result: boolean } | { valid: false, error }
  // -------------------------------------------------------------------------
  router.post("/flows/expressions/evaluate", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    let body: { expression?: unknown; sample?: unknown };
    try {
      body = (await ctx.req.json()) as typeof body;
    } catch {
      body = {};
    }
    if (typeof body.expression !== "string") {
      return ctx.json(
        { error: { message: "Field 'expression' (string) is required.", type: "invalid_request_error" } },
        400,
      );
    }
    const expression = body.expression.slice(0, 4000);
    if (expression.trim() === "") return ctx.json({ valid: true, result: true, empty: true });
    const check = validateConditionExpression(expression);
    if (!check.valid) return ctx.json({ valid: false, error: check.error });
    const sample =
      body.sample !== null && typeof body.sample === "object" && !Array.isArray(body.sample)
        ? (body.sample as Record<string, unknown>)
        : {};
    return ctx.json({
      valid: true,
      result: evaluateConditionExpression(expression, sample as Parameters<typeof evaluateConditionExpression>[1]),
    });
  });

  // -------------------------------------------------------------------------
  // GET /flows/experiments — live A/B experiment stats (static path, must be
  // registered before GET /flows/:id so it is not captured as an id).
  // -------------------------------------------------------------------------
  router.get("/flows/experiments", async (ctx) => {
    if (!(await guard(ctx, "experiments:read"))) return unauthorized(ctx);
    return ctx.json({
      enabled: abManager?.enabled ?? false,
      experiments: abManager?.status() ?? [],
    });
  });

  // -------------------------------------------------------------------------
  // POST /flows/validate — dry-run (Stage 1)
  // -------------------------------------------------------------------------
  router.post("/flows/validate", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Request body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    return ctx.json(validateFlow(expandForValidation(body), knownToolIds));
  });

  // -------------------------------------------------------------------------
  // POST /flows/:id/copilot — AI-assisted edit proposal (Stage 1; never writes)
  //
  //   Body: { definition: FlowDefinition, instruction: string }
  //   200:  { ok: true, proposed, diff, explanation }
  //   422/501/400: { ok: false, message, validation? }  — no patch is ever
  //   auto-applied; the caller (Studio builder) must explicitly accept it via
  //   the normal /flows/write or /flows/:id/draft path.
  // -------------------------------------------------------------------------
  router.post("/flows/:id/copilot", async (ctx) => {
    if (!(await guard(ctx, "flows:write"))) return unauthorized(ctx);

    if (appConfig?.defaultLlm === undefined) {
      return ctx.json(
        {
          ok: false,
          message:
            "Copilot is not configured — set DEFAULT_LLM (or another provider config) on the backend.",
        },
        501,
      );
    }

    let body: { definition?: unknown; instruction?: unknown };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Request body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    if (typeof body.instruction !== "string" || body.instruction.trim().length === 0) {
      return ctx.json(
        {
          error: {
            message: "Field 'instruction' (non-empty string) is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const parsed = validateFlowDefinition(expandForValidation(body.definition));
    if (!parsed.success) {
      return ctx.json(
        {
          error: {
            message: `Field 'definition' is not a valid flow: ${parsed.error.reason}`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const model = createLlmProvider(appConfig.defaultLlm, appConfig);
    // Hand the copilot the SOURCE form so an accepted proposal keeps its
    // shortcuts/variables; it validates via `expand`.
    const result = await proposeFlowEdit(
      body.definition as FlowDefinition,
      body.instruction,
      model,
      {
        ...(knownToolIds !== undefined ? { knownToolIds } : {}),
        expand: (def) => expandForValidation(def),
        shortcuts: Object.keys(
          (sourceDir !== undefined ? loadModelShortcuts(sourceDir)?.shortcuts : undefined) ?? {},
        ).sort(),
      },
    );

    if (!result.ok) {
      return ctx.json(
        {
          ok: false,
          message: result.message,
          ...(result.validation !== undefined ? { validation: result.validation } : {}),
        },
        422,
      );
    }

    return ctx.json({
      ok: true,
      proposed: result.proposed,
      diff: result.diff,
      explanation: result.explanation,
    });
  });

  // -------------------------------------------------------------------------
  // GET /flows/:id — full definition(s)
  // -------------------------------------------------------------------------
  router.get("/flows/:id", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    const id = ctx.req.param("id");

    if (store !== undefined) {
      const rec = await store.get(id);
      if (rec !== undefined) {
        // Not yet published online but live as a file: that file is what the
        // draft would replace (for comparisons in the editor).
        const fileBaseline =
          rec.published === null ? fileRegistry.getSource?.(id) : undefined;
        return ctx.json({
          id,
          source: "online",
          editable: true,
          version: rec.version,
          published: rec.published,
          draft: rec.draft,
          ...(fileBaseline !== undefined
            ? {
                fileDefinition: fileBaseline.definition,
                file: {
                  name: fileBaseline.fileName,
                  format: /\.json$/i.test(fileBaseline.fileName) ? "json" : "yaml",
                },
              }
            : {}),
          updatedAt: rec.updatedAt,
          updatedBy: rec.updatedBy,
        });
      }
    }
    const fileFlow = fileRegistry.get(id);
    if (fileFlow !== undefined) {
      // The editable source (shortcuts, {{vars.*}}, prompt includes kept as
      // references) plus the file it lives in, so the editor saves back the
      // authoring form into the SAME file instead of the expanded runtime form.
      const src = fileRegistry.getSource?.(id);
      let hash: string | undefined;
      if (src !== undefined && sourceDir !== undefined) {
        try {
          hash = sha256Hex(
            await fs.promises.readFile(path.join(sourceDir, src.fileName), "utf-8"),
          );
        } catch {
          /* file vanished between load and request — serve without a hash */
        }
      }
      return ctx.json({
        id,
        source: "file",
        editable: false,
        version: 0,
        published: fileFlow,
        draft: null,
        ...(src !== undefined
          ? {
              sourceDefinition: src.definition,
              file: {
                name: src.fileName,
                format: /\.json$/i.test(src.fileName) ? "json" : "yaml",
              },
            }
          : {}),
        ...(hash !== undefined ? { hash } : {}),
      });
    }
    return ctx.json(
      {
        error: { message: `Flow '${id}' not found.`, type: "not_found_error" },
      },
      404,
    );
  });

  // -------------------------------------------------------------------------
  // POST /flows/:id/test-run — register the Studio canvas for a test run
  //
  //   Body: a flow definition in source form (what the editor holds).
  //   200:  { model, expiresAt } — call /v1/chat/completions with `model`.
  //   400:  { error, validation } when the definition would not run.
  //
  // Nothing is saved: the expanded definition lives in memory for a while
  // under a throwaway id (see flow-registry-studio.ts). Requires flows:write
  // because it lets the caller execute an arbitrary definition.
  // -------------------------------------------------------------------------
  router.post("/flows/:id/test-run", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    const studioTests = deps.studioTests;
    if (studioTests === undefined) {
      return ctx.json(
        {
          error: {
            message: "Studio test runs are not available on this runtime.",
            type: "not_implemented_error",
          },
        },
        501,
      );
    }
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Request body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    if (body === null || typeof body !== "object") {
      return ctx.json(
        {
          error: {
            message: "Body must be a flow definition object.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const id = ctx.req.param("id");
    const def = { ...(body as Record<string, unknown>), id };
    const validation = validateFlow(expandForValidation(def), knownToolIds);
    const materialized =
      sourceDir !== undefined
        ? materializeFlowSource(def, sourceDir, `studio-test:${id}`)
        : validateFlowDefinition(def);
    if (!validation.valid || !materialized.success) {
      return ctx.json(
        {
          error: {
            message: materialized.success
              ? "The canvas has validation errors — fix them before testing."
              : `The canvas is not a runnable flow: ${materialized.error.reason}`,
            type: "invalid_request_error",
          },
          validation,
        },
        400,
      );
    }
    const registered = studioTests.register(materialized.data);
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "flows.test-run",
      target: id,
      details: { model: registered.model },
    });
    return ctx.json(registered);
  });

  // -------------------------------------------------------------------------
  // PUT /flows/:id/draft — save draft (Stage 3)
  // -------------------------------------------------------------------------
  router.put("/flows/:id/draft", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    if (store === undefined) return requireStore(ctx);
    const id = ctx.req.param("id");
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Request body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    if (body === null || typeof body !== "object") {
      return ctx.json(
        {
          error: {
            message: "Body must be a flow definition object.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    // Force the id to the path id so a draft can't be saved under the wrong key.
    const def = { ...(body as Record<string, unknown>), id } as FlowDefinition;
    if (typeof def.name !== "string" || def.name.length === 0) def.name = id;
    const record = await store.saveDraft(id, def, actor.name);
    await dbSource?.refresh();
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "flows.draft",
      target: id,
    });
    // A draft can be saved while still invalid (WIP); the report guides the editor.
    const validation = validateFlow(expandForValidation(def), knownToolIds);
    return ctx.json({ record, validation });
  });

  // -------------------------------------------------------------------------
  // POST /flows/:id/publish — validate + go live (Stage 3)
  // -------------------------------------------------------------------------
  router.post("/flows/:id/publish", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    if (store === undefined) return requireStore(ctx);
    const id = ctx.req.param("id");
    const rec = await store.get(id);
    if (rec === undefined || rec.draft === null) {
      return ctx.json(
        {
          error: {
            message: `Flow '${id}' has no draft to publish.`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const validation = validateFlow(expandForValidation(rec.draft), knownToolIds);
    if (!validation.valid) {
      return ctx.json(
        {
          error: {
            message: "Draft failed validation and cannot be published.",
            type: "invalid_request_error",
          },
          validation,
        },
        400,
      );
    }
    const record = await store.publish(id, actor.name);
    await dbSource?.refresh();
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "flows.publish",
      target: id,
      details: { version: record.version },
    });
    return ctx.json({ record, validation });
  });

  // -------------------------------------------------------------------------
  // DELETE /flows/:id — remove an online flow (Stage 3)
  // -------------------------------------------------------------------------
  router.delete("/flows/:id", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    if (store === undefined) return requireStore(ctx);
    const id = ctx.req.param("id");
    const ok = await store.delete(id);
    await dbSource?.refresh();
    if (!ok) {
      return ctx.json(
        {
          error: {
            message: `Online flow '${id}' not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "flows.delete",
      target: id,
    });
    return ctx.json({ id, deleted: true });
  });

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // GET /flows/:id/capabilities — effective, secret-free runtime capabilities
  // -------------------------------------------------------------------------
  router.get("/flows/:id/capabilities", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    const id = ctx.req.param("id");
    const record = store === undefined ? undefined : await store.get(id);
    const flow = record?.published ?? record?.draft ?? fileRegistry.get(id);
    if (flow === undefined) {
      return ctx.json({ error: { message: `Flow '${id}' was not found.`, type: "not_found_error" } }, 404);
    }
    return ctx.json(describeFlowCapabilities(flow));
  });

  // -------------------------------------------------------------------------
  // GET /flows/:id/compatibility — conservative static release assessment
  // -------------------------------------------------------------------------
  router.get("/flows/:id/compatibility", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    const id = ctx.req.param("id");
    if (ctx.req.query("draft") === "true" && store !== undefined) {
      const record = await store.get(id);
      if (record?.published === null || record?.draft === null || record === undefined) {
        return ctx.json({ error: { message: `Flow '${id}' needs both a published version and a draft.`, type: "invalid_request_error" } }, 400);
      }
      return ctx.json({
        from: { kind: "published", version: record.version },
        to: { kind: "draft" },
        report: analyzeFlowCompatibility(record.published, record.draft),
      });
    }
    const versions = store === undefined ? [] : await store.listVersions(id);
    if (versions.length >= 1) {
      const latest = versions[0]!.version;
      const toVersion = ctx.req.query("to") === undefined ? latest : Number(ctx.req.query("to"));
      const fromVersion = ctx.req.query("from") === undefined ? (versions[1]?.version ?? latest) : Number(ctx.req.query("from"));
      const from = versions.find((entry) => entry.version === fromVersion);
      const to = versions.find((entry) => entry.version === toVersion);
      if (!from || !to) {
        return ctx.json({ error: { message: `Flow '${id}' is missing version ${!from ? fromVersion : toVersion}.`, type: "not_found_error" } }, 404);
      }
      return ctx.json({
        from: { kind: "version", version: fromVersion },
        to: { kind: "version", version: toVersion },
        report: analyzeFlowCompatibility(from.definition, to.definition),
      });
    }
    const flow = fileRegistry.get(id);
    if (flow === undefined) {
      return ctx.json({ error: { message: `Flow '${id}' was not found.`, type: "not_found_error" } }, 404);
    }
    return ctx.json({
      from: null,
      to: { kind: "file" },
      report: {
        status: "unknown",
        findings: [{ severity: "unknown", code: "baseline-missing", path: "$", message: "No historical baseline is available for this file flow" }],
        structuralDiff: diffFlows(flow, flow),
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /flows/:id/passport — compact release evidence without mutation
  // -------------------------------------------------------------------------
  router.get("/flows/:id/passport", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    const id = ctx.req.param("id");
    const requested = ctx.req.query("version");
    const versions = store === undefined ? [] : await store.listVersions(id);
    const targetVersion = requested === undefined ? versions[0] : versions.find((entry) => entry.version === Number(requested));
    let flow = targetVersion?.definition;
    let source: "file" | "online" = "online";
    if (flow === undefined && requested === undefined) {
      const record = store === undefined ? undefined : await store.get(id);
      flow = record?.published ?? record?.draft ?? undefined;
    }
    if (flow === undefined && requested === undefined) {
      flow = fileRegistry.get(id);
      source = "file";
    }
    if (flow === undefined) {
      return ctx.json({ error: { message: `Flow '${id}'${requested ? ` version ${requested}` : ""} was not found.`, type: "not_found_error" } }, 404);
    }
    const targetIndex = targetVersion === undefined ? -1 : versions.findIndex((entry) => entry.version === targetVersion.version);
    const previous = targetIndex >= 0 ? versions[targetIndex + 1] : undefined;
    const compatibility = previous === undefined ? undefined : analyzeFlowCompatibility(previous.definition, flow);
    const capabilities = describeFlowCapabilities(flow);
    const policy = evaluatePolicyForModels(getCompliancePolicy?.(), collectFlowLlmConfigs(flow), {
      flowId: flow.id,
      toolIds: capabilities.graph.tools,
      ...(flow.dataClasses !== undefined ? { dataClasses: flow.dataClasses } : {}),
    });
    return ctx.json(buildReleasePassport({
      flow,
      source,
      ...(targetVersion !== undefined ? { storeVersion: targetVersion.version } : {}),
      ...(compatibility !== undefined ? { compatibility } : {}),
      policy,
      capabilities,
    }));
  });

  // -------------------------------------------------------------------------
  // GET /flows/:id/diff — structural diff between two versions (or draft↔published)
  //   ?from=<version>&to=<version>   compare two published versions
  //   ?draft=true                    compare published → draft
  //   (defaults: from = latest-1, to = latest)
  // -------------------------------------------------------------------------
  router.get("/flows/:id/diff", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    if (store === undefined) return requireStore(ctx);
    const id = ctx.req.param("id");

    if (ctx.req.query("draft") === "true") {
      const rec = await store.get(id);
      // A draft of a flow that is live as a FILE (never published online) is
      // compared against that file — the version it would replace — in its
      // source form, like the draft itself, so shortcuts/variables don't show
      // up as spurious changes.
      const fileSource = fileRegistry.getSource?.(id);
      const liveFile =
        fileSource?.definition ?? fileRegistry.get(id);
      if (rec !== undefined && rec.draft !== null && rec.published === null && liveFile !== undefined) {
        return ctx.json({
          from: { kind: "file", ...(fileSource ? { file: fileSource.fileName } : {}) },
          to: { kind: "draft" },
          diff: diffFlows(liveFile as FlowDefinition, rec.draft),
        });
      }
      if (rec === undefined || rec.published === null || rec.draft === null) {
        return ctx.json(
          {
            error: {
              message:
                rec === undefined || rec.draft === null
                  ? `Flow '${id}' has no draft to compare.`
                  : `Flow '${id}' has no published version to compare the draft with.`,
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      return ctx.json({
        from: { kind: "published", version: rec.version },
        to: { kind: "draft" },
        diff: diffFlows(rec.published, rec.draft),
      });
    }

    const versions = await store.listVersions(id); // newest first
    if (versions.length === 0) {
      return ctx.json(
        {
          error: {
            message: `Flow '${id}' has no published versions.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    const firstVersion = versions[0];
    if (firstVersion === undefined) {
      // Unreachable: the length check above already returned on an empty list.
      return ctx.json(
        {
          error: {
            message: `Flow '${id}' has no published versions.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    const latest = firstVersion.version;
    const toQuery = ctx.req.query("to");
    const toV = toQuery !== undefined ? Number(toQuery) : latest;
    const fromQuery = ctx.req.query("from");
    const fromV =
      fromQuery !== undefined ? Number(fromQuery) : (versions[1]?.version ?? latest);

    const from = versions.find((v) => v.version === fromV);
    const to = versions.find((v) => v.version === toV);
    if (from === undefined || to === undefined) {
      return ctx.json(
        {
          error: {
            message: `Flow '${id}' is missing version ${from === undefined ? fromV : toV}.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    return ctx.json({
      from: { kind: "version", version: fromV },
      to: { kind: "version", version: toV },
      diff: diffFlows(from.definition, to.definition),
    });
  });

  // -------------------------------------------------------------------------
  // POST /flows/:id/simulate — counterfactual impact simulation: runs the
  // current draft against the last N real production execution snapshots
  // and reports behavior/cost/latency/compliance/access deltas, without
  // publishing anything. Gated by `flows:write` (same tier as publish/
  // rollback) since — unlike every other route in this file — it makes real,
  // billable LLM calls.
  //
  // Body (all optional, conservative defaults so a bare POST can't run away):
  //   { maxSnapshots?: number (default 20, hard ceiling 200),
  //     maxCostUsd?: number   (default 1.0, hard ceiling 25) }
  // -------------------------------------------------------------------------
  const DEFAULT_MAX_SNAPSHOTS = 20;
  const HARD_MAX_SNAPSHOTS = 200;
  const DEFAULT_MAX_COST_USD = 1.0;
  const HARD_MAX_COST_USD = 25;

  router.post("/flows/:id/simulate", async (ctx) => {
    if (!(await guard(ctx, "flows:write"))) return unauthorized(ctx);
    if (store === undefined) return requireStore(ctx);
    if (appConfig === undefined || deps.simulation === undefined) {
      return ctx.json(
        {
          error: {
            message:
              "Simulation is not configured (needs appConfig + a replay store of production snapshots).",
            type: "not_implemented_error",
          },
        },
        501,
      );
    }
    const id = ctx.req.param("id");
    const rec = await store.get(id);
    if (rec === undefined || rec.draft === null) {
      return ctx.json(
        {
          error: {
            message: `Flow '${id}' has no draft to simulate.`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    let body: { maxSnapshots?: unknown; maxCostUsd?: unknown } = {};
    try {
      body = await ctx.req.json();
    } catch {
      /* empty body is fine — defaults apply */
    }
    const maxSnapshots = Math.min(
      HARD_MAX_SNAPSHOTS,
      Math.max(
        1,
        typeof body.maxSnapshots === "number"
          ? Math.trunc(body.maxSnapshots)
          : DEFAULT_MAX_SNAPSHOTS,
      ),
    );
    const maxCostUsd = Math.min(
      HARD_MAX_COST_USD,
      Math.max(
        0,
        typeof body.maxCostUsd === "number"
          ? body.maxCostUsd
          : DEFAULT_MAX_COST_USD,
      ),
    );

    try {
      const report = await simulateFlow(
        id,
        rec.draft,
        rec.published ?? undefined,
        { maxSnapshots, maxCostUsd },
        { appConfig, ...deps.simulation },
      );
      logger?.info("Flow simulation completed", {
        flowId: id,
        runId: report.runId,
        sampled: report.behavior.sampled,
        spentUsd: report.costCap.spentUsd,
        capped: report.costCap.capped,
      });
      return ctx.json(report);
    } catch (err) {
      return ctx.json(
        {
          error: {
            message: `Simulation failed: ${err instanceof Error ? err.message : String(err)}`,
            type: "internal_error",
          },
        },
        500,
      );
    }
  });

  // -------------------------------------------------------------------------
  // GET /flows/:id/versions — published history (Stage 3)
  // -------------------------------------------------------------------------
  router.get("/flows/:id/versions", async (ctx) => {
    if (!(await guard(ctx, "flows:read"))) return unauthorized(ctx);
    if (store === undefined) return requireStore(ctx);
    const versions = await store.listVersions(ctx.req.param("id"));
    return ctx.json({ versions });
  });

  // -------------------------------------------------------------------------
  // POST /flows/:id/rollback — re-publish a past version (Stage 3)
  // -------------------------------------------------------------------------
  router.post("/flows/:id/rollback", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);
    if (store === undefined) return requireStore(ctx);
    const id = ctx.req.param("id");
    let body: { version?: number };
    try {
      body = await ctx.req.json<{ version?: number }>();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Request body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    if (typeof body.version !== "number") {
      return ctx.json(
        {
          error: {
            message: "Field 'version' (number) is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    try {
      const record = await store.rollback(id, body.version, actor.name);
      await dbSource?.refresh();
      auditLog?.record({
        actor: actor.name,
        role: actor.role,
        action: "flows.rollback",
        target: id,
        details: { toVersion: body.version, newVersion: record.version },
      });
      return ctx.json({ record });
    } catch (err) {
      if (err instanceof FlowStoreError) {
        return ctx.json(
          { error: { message: err.message, type: "not_found_error" } },
          404,
        );
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // POST/PUT /flows/write — file-based write path (Stage 2, Req. 22)
  //
  // Only operator/admin roles may write (Req. 22.1).
  // Path traversal is rejected (Req. 22.2).
  // Full schema validation before writing (Req. 22.3).
  // Atomic temp-file + rename — no partial file on failure (Req. 22.4).
  // Conflict detection via baseHash (Req. 14.6).
  // -------------------------------------------------------------------------
  const requireFlowsDir = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message:
            "File-based flow writing is disabled. Configure FLOWS_DIR to enable this endpoint.",
          type: "not_implemented_error",
        },
      },
      501,
    );

  for (const method of ["post", "put"] as const) {
    router[method]("/flows/write", async (ctx) => {
      // Req. 22.1: only operator/admin — guard uses flows:write which is
      // granted to admin; operator does NOT have flows:write per RBAC table,
      // so we additionally accept the operator role explicitly.
      const actor = await guard(ctx, "flows:write");
      if (!actor) {
        // Check if it's an operator (has flows:read but not flows:write) — they
        // also lack write permission, so a 403 (Forbidden, not 401) is correct.
        const readActor = await guard(ctx, "flows:read");
        if (readActor !== null) {
          // Authenticated but insufficient role.
          return ctx.json(
            {
              error: {
                message:
                  "Insufficient role: flow writing requires operator or admin role.",
                type: "authorization_error",
              },
            },
            403,
          );
        }
        return unauthorized(ctx);
      }
      if (flowsDir === undefined) return requireFlowsDir(ctx);

      // Parse and validate request body.
      let body: unknown;
      try {
        body = await ctx.req.json();
      } catch {
        return ctx.json(
          {
            error: {
              message: "Request body must be valid JSON.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }

      if (body === null || typeof body !== "object") {
        return ctx.json(
          {
            error: {
              message: "Body must be a FlowWriteRequest object.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      const req = body as Partial<FlowWriteRequest>;

      if (typeof req.id !== "string" || req.id.trim().length === 0) {
        return ctx.json(
          {
            error: {
              message: "Field 'id' (non-empty string) is required.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      if (req.format !== "yaml" && req.format !== "json") {
        return ctx.json(
          {
            error: {
              message: 'Field \'format\' must be "yaml" or "json".',
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      if (req.definition === undefined || req.definition === null) {
        return ctx.json(
          {
            error: {
              message: "Field 'definition' is required.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }

      // Req. 22.2: path-traversal protection.
      // An existing file flow is written back into the file it was loaded
      // from (its name may differ from the id, and its format decides the
      // serialisation) — never into a second `<id>.<format>` file next to it,
      // which would give two files with the same flow id.
      const existingFile = fileRegistry.getSource?.(req.id)?.fileName;
      const format: "yaml" | "json" =
        existingFile !== undefined
          ? /\.json$/i.test(existingFile)
            ? "json"
            : "yaml"
          : req.format;
      let targetPath: string;
      try {
        targetPath =
          existingFile !== undefined
            ? resolveIncludeWritePath(flowsDir, existingFile)
            : resolveFlowWritePath(flowsDir, req.id, req.format);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "PATH_TRAVERSAL") {
          return ctx.json(
            {
              error: {
                message: `Path traversal rejected: ${e.message}`,
                type: "invalid_request_error",
              },
            },
            400,
          );
        }
        throw err;
      }

      // Req. 22.3: validate before writing.
      const validation = validateFlow(
        expandForValidation(req.definition),
        knownToolIds,
      );
      if (!validation.valid) {
        return ctx.json(
          {
            error: {
              message:
                "Flow definition failed validation and cannot be written.",
              type: "invalid_request_error",
            },
            validation,
          },
          400,
        );
      }

      // Include-aware split (see flow-parser/normalize.ts's $includeOrigins):
      // when the incoming definition was composed via `$include.subflows`,
      // write each sub-flow's nodes/edges back to the file they came from
      // instead of flattening them into the parent — a no-op for the
      // overwhelming majority of flows, which don't use includes at all.
      // Read the current file once: it serves both the conflict check below and
      // the comment-preserving merge further down.
      let currentContent: string | null = null;
      try {
        currentContent = await fs.promises.readFile(targetPath, "utf-8");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") throw err;
        // File does not exist yet — a fresh write, nothing to preserve.
      }

      let existingParent: Record<string, unknown> | undefined;
      if (currentContent !== null) {
        try {
          const parsed: unknown =
            format === "json" ? JSON.parse(currentContent) : parseYaml(currentContent);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            existingParent = parsed as Record<string, unknown>;
          }
        } catch {
          /* unparseable current file — split without it */
        }
      }

      // Split the definition AS SUBMITTED (source form, schema-checked above via
      // its expansion) so sub-flow files keep their shortcuts/variables too.
      let definitionToWrite: unknown = req.definition;
      const submitted = req.definition as FlowDefinition;
      if (Array.isArray(submitted.nodes) && Array.isArray(submitted.edges)) {
        const origins = parseIncludeOrigins(submitted);
        if (origins !== undefined) {
          try {
            definitionToWrite = await splitByIncludeOrigin(
              submitted,
              origins,
              flowsDir,
              {
                edgeOrigins: parseIncludeEdgeOrigins(submitted),
                ...(existingParent !== undefined ? { existingParent } : {}),
              },
            );
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === "PATH_TRAVERSAL") {
              return ctx.json(
                {
                  error: {
                    message: `Path traversal rejected: ${e.message}`,
                    type: "invalid_request_error",
                  },
                },
                400,
              );
            }
            throw err;
          }
        }
      }

      // Conflict detection (Req. 14.6): if caller supplied baseHash, compare
      // it to the current file's SHA-256. A mismatch means the file has changed
      // since the caller last read it.
      if (req.baseHash !== undefined) {
        if (currentContent !== null) {
          const currentHash = sha256Hex(currentContent);
          if (currentHash !== req.baseHash) {
            return ctx.json(
              {
                error: {
                  message:
                    "Conflict: the flow file has been modified since your last read. " +
                    "Fetch the latest version and re-apply your changes.",
                  type: "conflict_error",
                  currentHash,
                },
              },
              409,
            );
          }
        }
      }

      // Serialize the definition (post-split parent definition when the flow
      // uses includes, otherwise the definition as submitted).
      let content: string;
      let commentsPreserved = false;
      try {
        if (format === "yaml") {
          // Merge into the existing document rather than re-serialising from
          // scratch. A plain `stringify()` produces equivalent YAML and drops
          // every comment — and in these flow files the comments hold the
          // reasoning (which override ordering is deliberate, why a schema is
          // forced, which incident led to a rule). One save from the editor used
          // to delete all of it, leaving a file that looked perfectly fine.
          if (currentContent !== null && currentContent.trim().length > 0) {
            try {
              content = mergeFlowIntoYaml(currentContent, definitionToWrite, {
                lineWidth: 120,
              });
              commentsPreserved = true;
            } catch (mergeErr) {
              // The existing file cannot serve as a merge base (unparseable, or
              // not a mapping). Fall back to a plain serialisation rather than
              // refusing the save — but say so in the response so the operator
              // knows comments were not carried over.
              logger?.warn(
                "[flows] Comment-preserving merge failed; falling back to plain serialisation",
                {
                  flow: req.id,
                  path: targetPath,
                  error:
                    mergeErr instanceof Error
                      ? mergeErr.message
                      : String(mergeErr),
                },
              );
              content = stringifyYaml(definitionToWrite, { lineWidth: 120 });
            }
          } else {
            content = stringifyYaml(definitionToWrite, { lineWidth: 120 });
          }
        } else {
          content = `${JSON.stringify(definitionToWrite, null, 2)}\n`;
        }
      } catch (err) {
        return ctx.json(
          {
            error: {
              message: `Failed to serialize flow definition: ${(err as Error).message}`,
              type: "invalid_request_error",
            },
          },
          400,
        );
      }

      // Req. 22.4: atomic write.
      await atomicWriteFile(targetPath, content);

      const newHash = sha256Hex(content);

      auditLog?.record({
        actor: actor.name,
        role: actor.role,
        action: "flows.write",
        target: req.id,
        details: {
          format,
          path: targetPath,
          hash: newHash,
          commentsPreserved,
        },
      });

      return ctx.json({
        id: req.id,
        format,
        path: targetPath,
        hash: newHash,
        // Lets the editor tell the operator whether the file's comments survived
        // this write — false means the file was rewritten from scratch.
        commentsPreserved,
        validation,
      });
    });
  }

  return router;
}
