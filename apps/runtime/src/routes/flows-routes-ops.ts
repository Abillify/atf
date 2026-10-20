// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Simulation, versioning, rollback and the file write routes under /flows/:id.
 * (Phase 18.4 split of flows.ts, Req. 13.6.)
 */

import * as fs from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { mergeFlowIntoYaml } from "../graph/flow-yaml-merge.js";
import {
  AUDIT_UNAVAILABLE_BODY,
  AUDIT_UNAVAILABLE_STATUS,
} from "../compliance/regulated-actions.js";
import { FlowStoreError } from "../graph/flow-store.js";
import { validateFlow } from "../graph/flow-validator.js";
import { simulateFlow } from "../graph/graph-engine/simulate.js";
import type { FlowDefinition } from "../types/flow.js";
import type { Hono } from "hono";
import type { FlowsContext } from "./flows-context.js";
import type { FlowWriteRequest } from "./flows-shared.js";
import * as flowsShared from "./flows-shared.js";

export function registerFlowOpsRoutes(router: Hono, fc: FlowsContext): void {
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
    if (!(await fc.guard(ctx, "flows:write"))) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
    if (fc.appConfig === undefined || fc.deps.simulation === undefined) {
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
    const rec = await fc.store.get(id);
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
        { appConfig: fc.appConfig, ...fc.deps.simulation },
      );
      fc.logger?.info("Flow simulation completed", {
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
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
    const versions = await fc.store.listVersions(ctx.req.param("id"));
    return ctx.json({ versions });
  });

  // -------------------------------------------------------------------------
  // POST /flows/:id/rollback — re-publish a past version (Stage 3)
  // -------------------------------------------------------------------------
  router.post("/flows/:id/rollback", async (ctx) => {
    const actor = await fc.guard(ctx, "flows:write");
    if (!actor) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
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
      const record = await fc.store.rollback(id, body.version, actor.name);
      await fc.dbSource?.refresh();
      // A rollback re-publishes online, keeping a same-id file flow shadowed —
      // record that like a publish does (ADR 0034).
      const shadowsFile = fc.fileRegistry.get(id) !== undefined;
      // Regulierte Aktion (Req 1.4): durable audit before reporting success.
      if (fc.auditLog !== undefined) {
        try {
          await fc.auditLog.recordRequired({
            actor: actor.name,
            role: actor.role,
            action: "flows.rollback",
            target: id,
            details: {
              toVersion: body.version,
              newVersion: record.version,
              ...(shadowsFile ? { shadowsFile: true } : {}),
            },
          });
        } catch {
          return ctx.json(AUDIT_UNAVAILABLE_BODY, AUDIT_UNAVAILABLE_STATUS);
        }
      }
      return ctx.json({
        record,
        ...(shadowsFile ? { shadowsFile: true } : {}),
      });
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
  for (const method of ["post", "put"] as const) {
    router[method]("/flows/write", async (ctx) => {
      // Req. 22.1: only operator/admin — guard uses flows:write which is
      // granted to admin; operator does NOT have flows:write per RBAC table,
      // so we additionally accept the operator role explicitly.
      const actor = await fc.guard(ctx, "flows:write");
      if (!actor) {
        // Check if it's an operator (has flows:read but not flows:write) — they
        // also lack write permission, so a 403 (Forbidden, not 401) is correct.
        const readActor = await fc.guard(ctx, "flows:read");
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
        return fc.unauthorized(ctx);
      }
      if (fc.flowsDir === undefined) return fc.requireFlowsDir(ctx);

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
      const existingFile = fc.fileRegistry.getSource?.(req.id)?.fileName;
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
            ? flowsShared.resolveIncludeWritePath(fc.flowsDir, existingFile)
            : flowsShared.resolveFlowWritePath(fc.flowsDir, req.id, req.format);
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
        fc.expandForValidation(req.definition),
        fc.knownToolIds,
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
        const origins = flowsShared.parseIncludeOrigins(submitted);
        if (origins !== undefined) {
          try {
            definitionToWrite = await flowsShared.splitByIncludeOrigin(
              submitted,
              origins,
              fc.flowsDir,
              {
                edgeOrigins: flowsShared.parseIncludeEdgeOrigins(submitted),
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
          const currentHash = flowsShared.sha256Hex(currentContent);
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
              fc.logger?.warn(
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
      await flowsShared.atomicWriteFile(targetPath, content);

      const newHash = flowsShared.sha256Hex(content);

      fc.auditLog?.record({
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
}
