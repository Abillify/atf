// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sub-flow and prompt source endpoints (static paths, registered before /flows/:id).
 * (Phase 18.4 split of flows.ts, Req. 13.6.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { mergeFlowIntoYaml } from "../graph/flow-yaml-merge.js";
import { validateFlowDefinition } from "../graph/flow-parser.js";
import { resolveFlowSourceIncludes } from "../graph/flow-parser/normalize.js";
import type { FlowDefinition } from "../types/flow.js";
import type { Hono } from "hono";
import type { FlowsContext } from "./flows-context.js";
import * as flowsShared from "./flows-shared.js";

export function registerFlowSourceRoutes(router: Hono, fc: FlowsContext): void {
  // -------------------------------------------------------------------------
  // GET /flows/subflows — the sub-flow files a flow can include
  // (FLOWS_DIR/subflows/*.{yaml,yml,json}) with their nodes and the flows that
  // already use them. GET /flows/subflows/content?path=… — one file in SOURCE
  // form (shortcuts, {{vars.*}}, prompt includes kept; nested includes merged
  // and tagged), ready to be placed on the Studio canvas.
  // Static paths: registered before GET /flows/:id.
  // -------------------------------------------------------------------------
  router.get("/flows/subflows", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    if (fc.sourceDir === undefined) return ctx.json({ subflows: [] });
    const dir = path.join(fc.sourceDir, "subflows");
    let files: string[] = [];
    try {
      files = (await fs.promises.readdir(dir))
        .filter((f) => /\.(ya?ml|json)$/i.test(f))
        .sort();
    } catch {
      return ctx.json({ subflows: [] });
    }
    // Which flows include which file (from the flows' source forms).
    const usedBy = new Map<string, string[]>();
    for (const flow of fc.fileRegistry.list()) {
      const origins = (
        fc.fileRegistry.getSource?.(flow.id)?.definition.metadata as
          | { $includeOrigins?: Record<string, string> }
          | undefined
      )?.$includeOrigins;
      for (const rel of new Set(Object.values(origins ?? {}))) {
        usedBy.set(rel, [...(usedBy.get(rel) ?? []), flow.id]);
      }
    }
    const subflows = [];
    for (const f of files) {
      const rel = `subflows/${f}`;
      let parsed: Record<string, unknown> = {};
      try {
        const text = await fs.promises.readFile(path.join(dir, f), "utf-8");
        const v = /\.json$/i.test(f) ? JSON.parse(text) : parseYaml(text);
        if (v !== null && typeof v === "object" && !Array.isArray(v))
          parsed = v as Record<string, unknown>;
      } catch {
        /* unreadable file: listed without details */
      }
      const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
      subflows.push({
        path: rel,
        ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
        ...(typeof parsed.description === "string"
          ? { description: parsed.description }
          : {}),
        nodeIds: nodes
          .map((n) =>
            n !== null && typeof n === "object"
              ? (n as { id?: unknown }).id
              : undefined,
          )
          .filter((id): id is string => typeof id === "string"),
        edgeCount: Array.isArray(parsed.edges) ? parsed.edges.length : 0,
        usedBy: usedBy.get(rel) ?? [],
      });
    }
    return ctx.json({ subflows });
  });

  router.get("/flows/subflows/content", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    const rel = (ctx.req.query("path") ?? "").trim();
    if (
      fc.sourceDir === undefined ||
      !/^subflows\/[\w.-]+\.(ya?ml|json)$/i.test(rel)
    ) {
      return ctx.json(
        {
          error: {
            message:
              "path must name a file in subflows/ (e.g. subflows/x.yaml).",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    if (!fs.existsSync(path.join(fc.sourceDir, rel))) {
      return ctx.json(
        {
          error: {
            message: `Sub-flow ${rel} not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    // Same resolution as loading a flow that includes it, in source form.
    const raw: Record<string, unknown> = {
      metadata: { $include: { subflows: [rel] } },
    };
    resolveFlowSourceIncludes(raw, fc.sourceDir, "<studio>");
    const meta = (raw.metadata ?? {}) as Record<string, unknown>;
    return ctx.json({
      path: rel,
      nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
      edges: Array.isArray(raw.edges) ? raw.edges : [],
      edgeOrigins: meta.$includeEdgeOrigins ?? {},
    });
  });

  // -------------------------------------------------------------------------
  // POST /flows/subflows/write — write ONE sub-flow file on its own, without
  // touching the parent flow. The Studio uses this to "save this sub-flow"
  // from its group on the canvas. The full flow's `/flows/write` still writes
  // every sub-flow via the include-aware split; this is the surgical, single-
  // file counterpart.
  //   Body: { path: "subflows/x.yaml", nodes: [...], edges: [...] }
  //   200:  { hash }
  // Static path: registered before GET /flows/:id.
  // -------------------------------------------------------------------------
  router.post("/flows/subflows/write", async (ctx) => {
    // Same authorization shape as POST /flows/write: flows:write (admin), with
    // an explicit 403 for an authenticated operator that lacks it.
    const actor = await fc.guard(ctx, "flows:write");
    if (!actor) {
      const readActor = await fc.guard(ctx, "flows:read");
      if (readActor !== null) {
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
    const req = (body ?? {}) as {
      path?: unknown;
      nodes?: unknown;
      edges?: unknown;
    };
    const rel = typeof req.path === "string" ? req.path.trim() : "";
    if (!/^subflows\/[\w.-]+\.(ya?ml|json)$/i.test(rel)) {
      return ctx.json(
        {
          error: {
            message:
              "Field 'path' must name a file in subflows/ (e.g. subflows/x.yaml).",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const nodes = Array.isArray(req.nodes) ? req.nodes : [];
    const edges = Array.isArray(req.edges) ? req.edges : [];
    if (nodes.length === 0) {
      return ctx.json(
        {
          error: {
            message: "A sub-flow needs at least one node.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    // Validate the fragment structurally (schema, duplicate ids, condition
    // syntax) as a stand-alone mini-flow. A sub-flow fragment is not a runnable
    // flow on its own — reachability/entry rules only apply once it is merged
    // into a parent — so the semantic `validateFlow` is intentionally not run.
    // Cross-boundary edges legitimately name parent nodes that aren't in the
    // fragment; add lightweight placeholders for those so the edge-reference
    // check doesn't reject an edge that resolves fine after the merge.
    const fragmentNodeIds = new Set(
      nodes.map((n) =>
        n !== null && typeof n === "object"
          ? (n as { id?: unknown }).id
          : undefined,
      ),
    );
    const placeholders: Array<{ id: string; type: string }> = [];
    for (const e of edges) {
      if (e === null || typeof e !== "object") continue;
      for (const end of ["source", "target"] as const) {
        const id = (e as Record<string, unknown>)[end];
        if (
          typeof id === "string" &&
          !fragmentNodeIds.has(id) &&
          !placeholders.some((p) => p.id === id)
        ) {
          placeholders.push({ id, type: "llm" });
        }
      }
    }
    const fragmentFlow = fc.expandForValidation({
      id: rel,
      name: rel,
      nodes: [...nodes, ...placeholders],
      edges,
    });
    const structural = validateFlowDefinition(fragmentFlow);
    if (!structural.success) {
      return ctx.json(
        {
          error: {
            message: `Sub-flow fragment failed validation: ${structural.error.reason}`,
            type: "invalid_request_error",
          },
          details: structural.error.details,
        },
        400,
      );
    }

    let targetPath: string;
    try {
      targetPath = flowsShared.resolveIncludeWritePath(fc.flowsDir, rel);
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

    const ext = path.extname(targetPath).toLowerCase();
    const fragment = { nodes, edges } as {
      nodes: FlowDefinition["nodes"];
      edges: FlowDefinition["edges"];
    };

    let existing: string | null = null;
    try {
      existing = await fs.promises.readFile(targetPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    // Comment-preserving merge into the existing YAML (same behaviour as the
    // full-flow split), keeping other top-level keys (name, description, …)
    // and not inventing an empty `edges` list the file never had.
    let content: string;
    if (
      existing !== null &&
      existing.trim().length > 0 &&
      (ext === ".yaml" || ext === ".yml")
    ) {
      try {
        const current = parseYaml(existing) as Record<string, unknown> | null;
        const base =
          current !== null &&
          typeof current === "object" &&
          !Array.isArray(current)
            ? current
            : {};
        const next: Record<string, unknown> = {
          ...base,
          nodes: fragment.nodes,
        };
        if (fragment.edges.length > 0 || "edges" in base)
          next.edges = fragment.edges;
        else delete next.edges;
        content = mergeFlowIntoYaml(existing, next, { lineWidth: 120 });
      } catch {
        content = flowsShared.serializeSubflowFragment(ext, fragment);
      }
    } else {
      // A fresh file: don't write an empty `edges: []` the sub-flow never had.
      const fresh =
        fragment.edges.length > 0
          ? fragment
          : ({ nodes: fragment.nodes } as typeof fragment);
      content = flowsShared.serializeSubflowFragment(ext, fresh);
    }

    await flowsShared.atomicWriteFile(targetPath, content);
    const hash = flowsShared.sha256Hex(content);

    fc.auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "flows.subflows.write",
      target: rel,
      details: {
        path: targetPath,
        nodeCount: fragment.nodes.length,
        edgeCount: fragment.edges.length,
      },
    });

    // Reflect the write immediately for subsequent reads/lists.
    fc.dbSource?.refresh?.();

    return ctx.json({ hash });
  });

  // -------------------------------------------------------------------------
  // Prompt files — the content behind `#[[file:prompts/x.md]]`
  //
  // Most system prompts don't live in the flow YAML at all, they are a
  // reference the parser expands on load (see flow-parser/normalize.ts). Until
  // these two routes existed the Studio could show the reference string but not
  // the prompt itself, which meant the actual prompt text of nearly every flow
  // was not editable in the UI.
  //
  //   GET  /flows/prompts/content?path=prompts/x.md → { path, content, hash }
  //   POST /flows/prompts/write { path, content, baseHash? } → { hash, path }
  //
  // Reading uses `sourceDir`, writing requires `flowsDir` (the writable mount).
  // Both are pinned to the flow directory's `prompts/` subtree.
  // Static paths: registered before GET /flows/:id.
  // -------------------------------------------------------------------------
  router.get("/flows/prompts/content", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    const rel = (ctx.req.query("path") ?? "").trim();
    const problem = flowsShared.promptPathProblem(rel);
    if (problem !== null) {
      return ctx.json(
        { error: { message: problem, type: "invalid_request_error" } },
        400,
      );
    }
    if (fc.sourceDir === undefined) {
      return ctx.json(
        {
          error: {
            message:
              "Prompt files are not available: configure FLOWS_DIR to enable this endpoint.",
            type: "not_implemented_error",
          },
        },
        501,
      );
    }
    let absPath: string;
    try {
      absPath = flowsShared.resolvePromptFilePath(fc.sourceDir, rel);
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
    let content: string;
    try {
      content = await fs.promises.readFile(absPath, "utf-8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT" || e.code === "EISDIR") {
        return ctx.json(
          {
            error: {
              message: `Prompt file ${rel} not found.`,
              type: "not_found_error",
            },
          },
          404,
        );
      }
      throw err;
    }
    return ctx.json({
      path: rel,
      content,
      hash: flowsShared.sha256Hex(content),
      // The editor disables saving up front on a read-only mount instead of
      // letting the operator type a change and then fail on save.
      writable: fc.flowsDirWritable(),
    });
  });

  router.post("/flows/prompts/write", async (ctx) => {
    // Same authorization shape as POST /flows/write and /flows/subflows/write:
    // a prompt file is flow behaviour, so it needs flows:write.
    const actor = await fc.guard(ctx, "flows:write");
    if (!actor) {
      const readActor = await fc.guard(ctx, "flows:read");
      if (readActor !== null) {
        return ctx.json(
          {
            error: {
              message:
                "Insufficient role: prompt writing requires operator or admin role.",
              type: "authorization_error",
            },
          },
          403,
        );
      }
      return fc.unauthorized(ctx);
    }
    if (fc.flowsDir === undefined) return fc.requireFlowsDir(ctx);

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
    const req = (body ?? {}) as {
      path?: unknown;
      content?: unknown;
      baseHash?: unknown;
    };
    const rel = typeof req.path === "string" ? req.path.trim() : "";
    const problem = flowsShared.promptPathProblem(rel);
    if (problem !== null) {
      return ctx.json(
        { error: { message: problem, type: "invalid_request_error" } },
        400,
      );
    }
    if (typeof req.content !== "string") {
      return ctx.json(
        {
          error: {
            message: "Field 'content' (string) is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    // A prompt is text, not a definition — there is nothing to schema-validate.
    // The one guard that matters is size, so a runaway paste cannot fill the
    // volume the flows are served from.
    if (req.content.length > 1_000_000) {
      return ctx.json(
        {
          error: {
            message: "Prompt content exceeds the 1,000,000 character limit.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    let targetPath: string;
    try {
      targetPath = flowsShared.resolvePromptFilePath(fc.flowsDir, rel);
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

    // Conflict detection, same contract as /flows/write (Req. 14.6): a
    // baseHash that no longer matches the file means somebody else edited the
    // prompt since this editor loaded it.
    let currentContent: string | null = null;
    try {
      currentContent = await fs.promises.readFile(targetPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (typeof req.baseHash === "string" && currentContent !== null) {
      const currentHash = flowsShared.sha256Hex(currentContent);
      if (currentHash !== req.baseHash) {
        return ctx.json(
          {
            error: {
              message:
                "Conflict: the prompt file has been modified since your last read. " +
                "Fetch the latest version and re-apply your changes.",
              type: "conflict_error",
              currentHash,
            },
          },
          409,
        );
      }
    }
    // Creating a prompt file is a deliberate act (a reference to a file that
    // does not exist resolves to an empty prompt), so it is allowed — but only
    // when the caller says so, to catch a typo in the path.
    if (currentContent === null && req.baseHash !== undefined) {
      return ctx.json(
        {
          error: {
            message: `Prompt file ${rel} no longer exists; reload before saving.`,
            type: "conflict_error",
          },
        },
        409,
      );
    }

    await flowsShared.atomicWriteFile(targetPath, req.content);
    const hash = flowsShared.sha256Hex(req.content);

    fc.auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "flows.prompts.write",
      target: rel,
      details: {
        path: targetPath,
        chars: req.content.length,
        created: currentContent === null,
      },
    });

    return ctx.json({ path: rel, hash, created: currentContent === null });
  });
}
