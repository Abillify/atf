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
import { stringify as stringifyYaml } from "yaml";
import { mergeFlowIntoYaml } from "../graph/flow-yaml-merge.js";
import { Hono } from "hono";
import type { FlowRegistry } from "../graph/flow-parser.js";
import type { FlowStore } from "../graph/flow-store.js";
import { FlowStoreError } from "../graph/flow-store.js";
import type { DbFlowSource } from "../graph/flow-registry-composite.js";
import { validateFlow } from "../graph/flow-validator.js";
import { validateFlowDefinition } from "../graph/flow-parser.js";
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
): Promise<FlowDefinition> {
  const originOf = (nodeId: string): string | undefined => origins[nodeId];

  const byOrigin = new Map<
    string,
    { nodes: FlowDefinition["nodes"]; edges: FlowDefinition["edges"] }
  >();
  const parentNodes: FlowDefinition["nodes"] = [];
  for (const node of definition.nodes) {
    const origin = originOf(node.id);
    if (origin === undefined) {
      parentNodes.push(node);
      continue;
    }
    const bucket = byOrigin.get(origin) ?? { nodes: [], edges: [] };
    bucket.nodes.push(node);
    byOrigin.set(origin, bucket);
  }

  const parentEdges: FlowDefinition["edges"] = [];
  for (const edge of definition.edges) {
    const sourceOrigin = originOf(edge.source);
    const targetOrigin = originOf(edge.target);
    const fragment =
      sourceOrigin !== undefined && sourceOrigin === targetOrigin
        ? byOrigin.get(sourceOrigin)
        : undefined;
    if (fragment !== undefined) {
      fragment.edges.push(edge);
    } else {
      parentEdges.push(edge);
    }
  }

  for (const [relPath, fragment] of byOrigin) {
    const targetPath = resolveIncludeWritePath(flowsDir, relPath);
    const content = serializeSubflowFragment(path.extname(targetPath), fragment);
    await atomicWriteFile(targetPath, content);
  }

  const { $includeOrigins: _omit, ...restMetadata } = (definition.metadata ??
    {}) as Record<string, unknown>;
  void _omit;
  const subflowPaths = [...byOrigin.keys()].sort();

  return {
    ...definition,
    nodes: parentNodes,
    edges: parentEdges,
    metadata: {
      ...restMetadata,
      ...(subflowPaths.length > 0
        ? { $include: { subflows: subflowPaths } }
        : {}),
    },
  };
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
    return ctx.json(validateFlow(body, knownToolIds));
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

    const parsed = validateFlowDefinition(body.definition);
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
    const result = await proposeFlowEdit(parsed.data, body.instruction, model, {
      ...(knownToolIds !== undefined ? { knownToolIds } : {}),
    });

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
        return ctx.json({
          id,
          source: "online",
          editable: true,
          version: rec.version,
          published: rec.published,
          draft: rec.draft,
          updatedAt: rec.updatedAt,
          updatedBy: rec.updatedBy,
        });
      }
    }
    const fileFlow = fileRegistry.get(id);
    if (fileFlow !== undefined) {
      return ctx.json({
        id,
        source: "file",
        editable: false,
        version: 0,
        published: fileFlow,
        draft: null,
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
    const validation = validateFlow(def, knownToolIds);
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
    const validation = validateFlow(rec.draft, knownToolIds);
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
      if (rec === undefined || rec.published === null || rec.draft === null) {
        return ctx.json(
          {
            error: {
              message: `Flow '${id}' needs both a published version and a draft to diff.`,
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
      let targetPath: string;
      try {
        targetPath = resolveFlowWritePath(flowsDir, req.id, req.format);
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
      const validation = validateFlow(req.definition, knownToolIds);
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
      let definitionToWrite: unknown = req.definition;
      const parsedForSplit = validateFlowDefinition(req.definition);
      if (parsedForSplit.success) {
        const origins = parseIncludeOrigins(parsedForSplit.data);
        if (origins !== undefined) {
          try {
            definitionToWrite = await splitByIncludeOrigin(
              parsedForSplit.data,
              origins,
              flowsDir,
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
        if (req.format === "yaml") {
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
          format: req.format,
          path: targetPath,
          hash: newHash,
          commentsPreserved,
        },
      });

      return ctx.json({
        id: req.id,
        format: req.format,
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
