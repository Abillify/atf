// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-flow read/draft/publish/delete endpoints under /flows/:id.
 * (Phase 18.4 split of flows.ts, Req. 13.6.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DraftInfo } from "../graph/flow-store.js";
import {
  AUDIT_UNAVAILABLE_BODY,
  AUDIT_UNAVAILABLE_STATUS,
} from "../compliance/regulated-actions.js";
import { DEFAULT_DRAFT_ID, isValidDraftId } from "../graph/flow-store.js";
import { validateFlow } from "../graph/flow-validator.js";
import { validateFlowDefinition, materializeFlowSource } from "../graph/flow-parser.js";
import type { FlowDefinition } from "../types/flow.js";
import type { Hono } from "hono";
import type { FlowsContext } from "./flows-context.js";
import * as flowsShared from "./flows-shared.js";

export function registerFlowCrudRoutes(router: Hono, fc: FlowsContext): void {
  // -------------------------------------------------------------------------
  // GET /flows/:id — full definition(s)
  // -------------------------------------------------------------------------
  router.get("/flows/:id", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    const id = ctx.req.param("id");

    if (fc.store !== undefined) {
      const rec = await fc.store.get(id);
      if (rec !== undefined) {
        // Not yet published online but live as a file: that file is what the
        // draft would replace (for comparisons in the editor).
        const fileBaseline =
          rec.published === null ? fc.fileRegistry.getSource?.(id) : undefined;
        return ctx.json({
          id,
          source: "online",
          editable: true,
          version: rec.version,
          published: rec.published,
          draft: rec.draft,
          // Every named draft (default first), with its definition, so the
          // Studio can switch between drafts without a request per draft.
          drafts: rec.drafts.map((d) => ({
            draftId: d.draftId,
            label: d.label,
            definition: d.definition,
            updatedAt: d.updatedAt,
            updatedBy: d.updatedBy,
          })),
          ...(fileBaseline !== undefined
            ? {
                fileDefinition: fileBaseline.definition,
                file: {
                  name: fileBaseline.fileName,
                  format: /\.json$/i.test(fileBaseline.fileName)
                    ? "json"
                    : "yaml",
                },
              }
            : {}),
          updatedAt: rec.updatedAt,
          updatedBy: rec.updatedBy,
        });
      }
    }
    const fileFlow = fc.fileRegistry.get(id);
    if (fileFlow !== undefined) {
      // The editable source (shortcuts, {{vars.*}}, prompt includes kept as
      // references) plus the file it lives in, so the editor saves back the
      // authoring form into the SAME file instead of the expanded runtime form.
      const src = fc.fileRegistry.getSource?.(id);
      let hash: string | undefined;
      if (src !== undefined && fc.sourceDir !== undefined) {
        try {
          hash = flowsShared.sha256Hex(
            await fs.promises.readFile(
              path.join(fc.sourceDir, src.fileName),
              "utf-8",
            ),
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
    const actor = await fc.guard(ctx, "flows:write");
    if (!actor) return fc.unauthorized(ctx);
    const studioTests = fc.deps.studioTests;
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
    const validation = validateFlow(fc.expandForValidation(def), fc.knownToolIds);
    const materialized =
      fc.sourceDir !== undefined
        ? materializeFlowSource(def, fc.sourceDir, `studio-test:${id}`)
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
    fc.auditLog?.record({
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
    const actor = await fc.guard(ctx, "flows:write");
    if (!actor) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
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
    const record = await fc.store.saveDraft(id, def, actor.name);
    await fc.dbSource?.refresh();
    fc.auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "flows.draft",
      target: id,
    });
    // A draft can be saved while still invalid (WIP); the report guides the editor.
    const validation = validateFlow(fc.expandForValidation(def), fc.knownToolIds);
    return ctx.json({ record, validation });
  });

  // -------------------------------------------------------------------------
  // Named drafts — several working copies per flow.
  //
  //   GET    /flows/:id/drafts           — list drafts (default first)
  //   PUT    /flows/:id/drafts/:draftId  — save one named draft
  //   DELETE /flows/:id/drafts/:draftId  — remove one named draft
  //
  // The implicit `PUT /flows/:id/draft` above is the `default` draft; these
  // routes add siblings to it. `:draftId` is a slug (see DRAFT_ID_RE).
  // -------------------------------------------------------------------------

  // Strip the definitions from a draft list for the lightweight listing.
  const draftMeta = (d: DraftInfo) => ({
    draftId: d.draftId,
    label: d.label,
    updatedAt: d.updatedAt,
    updatedBy: d.updatedBy,
  });

  router.get("/flows/:id/drafts", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
    const id = ctx.req.param("id");
    const rec = await fc.store.get(id);
    if (rec === undefined) {
      return ctx.json(
        {
          error: {
            message: `Flow '${id}' not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    return ctx.json({ id, drafts: rec.drafts.map(draftMeta) });
  });

  router.put("/flows/:id/drafts/:draftId", async (ctx) => {
    const actor = await fc.guard(ctx, "flows:write");
    if (!actor) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
    const id = ctx.req.param("id");
    const draftId = ctx.req.param("draftId");
    if (!isValidDraftId(draftId)) {
      return ctx.json(
        {
          error: {
            message: `Invalid draft id '${draftId}'. Use lowercase letters, digits, '-' or '_' (max 63 chars).`,
            type: "invalid_request_error",
          },
        },
        400,
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
    const { label, ...rest } = body as Record<string, unknown>;
    // Force the id to the path id so a draft can't be saved under the wrong key.
    const def = { ...rest, id } as FlowDefinition;
    if (typeof def.name !== "string" || def.name.length === 0) def.name = id;
    const record = await fc.store.saveDraft(id, def, actor.name, {
      draftId,
      ...(typeof label === "string" ? { label } : {}),
    });
    await fc.dbSource?.refresh();
    fc.auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "flows.draft",
      target: id,
      details: { draftId },
    });
    const validation = validateFlow(fc.expandForValidation(def), fc.knownToolIds);
    return ctx.json({ record, validation });
  });

  router.delete("/flows/:id/drafts/:draftId", async (ctx) => {
    const actor = await fc.guard(ctx, "flows:write");
    if (!actor) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
    const id = ctx.req.param("id");
    const draftId = ctx.req.param("draftId");
    if (!isValidDraftId(draftId)) {
      return ctx.json(
        {
          error: {
            message: `Invalid draft id '${draftId}'.`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const ok = await fc.store.deleteDraft(id, draftId);
    await fc.dbSource?.refresh();
    if (!ok) {
      return ctx.json(
        {
          error: {
            message: `Draft '${draftId}' of flow '${id}' not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    fc.auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "flows.draft.delete",
      target: id,
      details: { draftId },
    });
    return ctx.json({ id, draftId, deleted: true });
  });

  // -------------------------------------------------------------------------
  // POST /flows/:id/publish — validate + go live (Stage 3)
  //   ?draftId=<id> (or body {draftId}) publishes that named draft;
  //   without it the default draft is published, as before.
  // -------------------------------------------------------------------------
  router.post("/flows/:id/publish", async (ctx) => {
    const actor = await fc.guard(ctx, "flows:write");
    if (!actor) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
    const id = ctx.req.param("id");
    // The body is optional here (older clients POST an empty body), so a bad
    // body must not break publishing — fall back to the query parameter.
    let bodyDraftId: string | undefined;
    try {
      const body = (await ctx.req.json()) as Record<string, unknown> | null;
      if (
        body !== null &&
        typeof body === "object" &&
        typeof body.draftId === "string"
      ) {
        bodyDraftId = body.draftId;
      }
    } catch {
      /* no (or invalid) JSON body — fine, publish the default draft */
    }
    const draftId = ctx.req.query("draftId") ?? bodyDraftId ?? DEFAULT_DRAFT_ID;
    if (!isValidDraftId(draftId)) {
      return ctx.json(
        {
          error: {
            message: `Invalid draft id '${draftId}'.`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const rec = await fc.store.get(id);
    const source =
      rec === undefined
        ? undefined
        : (rec.drafts.find((d) => d.draftId === draftId)?.definition ??
          (draftId === DEFAULT_DRAFT_ID ? rec.draft : undefined));
    if (rec === undefined || source === null || source === undefined) {
      return ctx.json(
        {
          error: {
            message:
              draftId === DEFAULT_DRAFT_ID
                ? `Flow '${id}' has no draft to publish.`
                : `Flow '${id}' has no draft '${draftId}' to publish.`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const validation = validateFlow(fc.expandForValidation(source), fc.knownToolIds);
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
    const record = await fc.store.publish(id, actor.name, { draftId });
    await fc.dbSource?.refresh();
    // Regulierte Aktion (Req 1.4): the publish is only reported as successful
    // once the audit entry is durably persisted — otherwise 503.
    if (fc.auditLog !== undefined) {
      try {
        await fc.auditLog.recordRequired({
          actor: actor.name,
          role: actor.role,
          action: "flows.publish",
          target: id,
          details: { version: record.version, draftId },
        });
      } catch {
        return ctx.json(AUDIT_UNAVAILABLE_BODY, AUDIT_UNAVAILABLE_STATUS);
      }
    }
    return ctx.json({ record, validation });
  });

  // -------------------------------------------------------------------------
  // DELETE /flows/:id — remove an online flow (Stage 3)
  // -------------------------------------------------------------------------
  router.delete("/flows/:id", async (ctx) => {
    const actor = await fc.guard(ctx, "flows:write");
    if (!actor) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
    const id = ctx.req.param("id");
    const ok = await fc.store.delete(id);
    await fc.dbSource?.refresh();
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
    // Regulierte Aktion (Req 1.4): durable audit before reporting deletion.
    if (fc.auditLog !== undefined) {
      try {
        await fc.auditLog.recordRequired({
          actor: actor.name,
          role: actor.role,
          action: "flows.delete",
          target: id,
        });
      } catch {
        return ctx.json(AUDIT_UNAVAILABLE_BODY, AUDIT_UNAVAILABLE_STATUS);
      }
    }
    return ctx.json({ id, deleted: true });
  });
}
