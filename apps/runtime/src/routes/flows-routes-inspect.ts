// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Capabilities, compatibility, release passport and diff endpoints under /flows/:id.
 * (Phase 18.4 split of flows.ts, Req. 13.6.)
 */

import { DEFAULT_DRAFT_ID } from "../graph/flow-store.js";
import { diffFlows } from "../graph/flow-diff.js";
import { analyzeFlowCompatibility } from "../graph/flow-compatibility.js";
import { collectFlowLlmConfigs, describeFlowCapabilities } from "../graph/flow-capabilities.js";
import { buildReleasePassport } from "../release/release-passport.js";
import { evaluatePolicyForModels } from "../compliance/policy-evaluator.js";
import type { FlowDefinition } from "../types/flow.js";
import type { Hono } from "hono";
import type { FlowsContext } from "./flows-context.js";

export function registerFlowInspectRoutes(router: Hono, fc: FlowsContext): void {
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // GET /flows/:id/capabilities — effective, secret-free runtime capabilities
  // -------------------------------------------------------------------------
  router.get("/flows/:id/capabilities", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    const id = ctx.req.param("id");
    const record = fc.store === undefined ? undefined : await fc.store.get(id);
    const flow = record?.published ?? record?.draft ?? fc.fileRegistry.get(id);
    if (flow === undefined) {
      return ctx.json(
        {
          error: {
            message: `Flow '${id}' was not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    return ctx.json(describeFlowCapabilities(flow));
  });

  // -------------------------------------------------------------------------
  // GET /flows/:id/compatibility — conservative static release assessment
  // -------------------------------------------------------------------------
  router.get("/flows/:id/compatibility", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    const id = ctx.req.param("id");
    if (ctx.req.query("draft") === "true" && fc.store !== undefined) {
      const draftId = ctx.req.query("draftId") ?? DEFAULT_DRAFT_ID;
      const record = await fc.store.get(id);
      const draftDef =
        record?.drafts.find((d) => d.draftId === draftId)?.definition ??
        (draftId === DEFAULT_DRAFT_ID ? record?.draft : null);
      if (
        record === undefined ||
        record.published === null ||
        draftDef === null ||
        draftDef === undefined
      ) {
        return ctx.json(
          {
            error: {
              message: `Flow '${id}' needs both a published version and a draft.`,
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      return ctx.json({
        from: { kind: "published", version: record.version },
        to: { kind: "draft", draftId },
        report: analyzeFlowCompatibility(record.published, draftDef),
      });
    }
    const versions = fc.store === undefined ? [] : await fc.store.listVersions(id);
    if (versions.length >= 1) {
      const latest = versions[0].version;
      const toVersion =
        ctx.req.query("to") === undefined
          ? latest
          : Number(ctx.req.query("to"));
      const fromVersion =
        ctx.req.query("from") === undefined
          ? (versions[1]?.version ?? latest)
          : Number(ctx.req.query("from"));
      const from = versions.find((entry) => entry.version === fromVersion);
      const to = versions.find((entry) => entry.version === toVersion);
      if (!from || !to) {
        return ctx.json(
          {
            error: {
              message: `Flow '${id}' is missing version ${!from ? fromVersion : toVersion}.`,
              type: "not_found_error",
            },
          },
          404,
        );
      }
      return ctx.json({
        from: { kind: "version", version: fromVersion },
        to: { kind: "version", version: toVersion },
        report: analyzeFlowCompatibility(from.definition, to.definition),
      });
    }
    const flow = fc.fileRegistry.get(id);
    if (flow === undefined) {
      return ctx.json(
        {
          error: {
            message: `Flow '${id}' was not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    return ctx.json({
      from: null,
      to: { kind: "file" },
      report: {
        status: "unknown",
        findings: [
          {
            severity: "unknown",
            code: "baseline-missing",
            path: "$",
            message: "No historical baseline is available for this file flow",
          },
        ],
        structuralDiff: diffFlows(flow, flow),
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /flows/:id/passport — compact release evidence without mutation
  // -------------------------------------------------------------------------
  router.get("/flows/:id/passport", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    const id = ctx.req.param("id");
    const requested = ctx.req.query("version");
    const versions = fc.store === undefined ? [] : await fc.store.listVersions(id);
    const targetVersion =
      requested === undefined
        ? versions[0]
        : versions.find((entry) => entry.version === Number(requested));
    let flow = targetVersion?.definition;
    let source: "file" | "online" = "online";
    if (flow === undefined && requested === undefined) {
      const record = fc.store === undefined ? undefined : await fc.store.get(id);
      flow = record?.published ?? record?.draft ?? undefined;
    }
    if (flow === undefined && requested === undefined) {
      flow = fc.fileRegistry.get(id);
      source = "file";
    }
    if (flow === undefined) {
      return ctx.json(
        {
          error: {
            message: `Flow '${id}'${requested ? ` version ${requested}` : ""} was not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    const targetIndex =
      targetVersion === undefined
        ? -1
        : versions.findIndex(
            (entry) => entry.version === targetVersion.version,
          );
    const previous = targetIndex >= 0 ? versions[targetIndex + 1] : undefined;
    const compatibility =
      previous === undefined
        ? undefined
        : analyzeFlowCompatibility(previous.definition, flow);
    const capabilities = describeFlowCapabilities(flow);
    const policy = evaluatePolicyForModels(
      fc.getCompliancePolicy?.(),
      collectFlowLlmConfigs(flow),
      {
        flowId: flow.id,
        toolIds: capabilities.graph.tools,
        ...(flow.dataClasses !== undefined
          ? { dataClasses: flow.dataClasses }
          : {}),
      },
    );
    return ctx.json(
      buildReleasePassport({
        flow,
        source,
        ...(targetVersion !== undefined
          ? { storeVersion: targetVersion.version }
          : {}),
        ...(compatibility !== undefined ? { compatibility } : {}),
        policy,
        capabilities,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // GET /flows/diff/compare — structural diff between two ARBITRARY endpoints
  // (any flow/draft combination, not just two versions of one flow):
  //   ?from=<flowId>[&fromDraft=<draftId>]   left side
  //   ?to=<flowId>[&toDraft=<draftId>]       right side
  // Each side resolves to: the named draft (when *Draft is given), else the
  // published online definition, else the flow's file definition (source form,
  // like the draft-vs-file comparison above), else its default draft.
  // Powers the /flow-diff dropdowns; 3 path segments, so it never collides
  // with /flows/:id (2) or /flows/:id/diff (last segment differs).
  // -------------------------------------------------------------------------
  type DiffSide =
    | {
        ok: true;
        definition: FlowDefinition;
        endpoint: {
          flowId: string;
          kind: "published" | "draft" | "file";
          draftId?: string;
          version?: number;
          file?: string;
        };
      }
    | { ok: false; message: string };

  const resolveDiffSide = async (
    flowId: string,
    draftId: string | undefined,
  ): Promise<DiffSide> => {
    const rec = fc.store !== undefined ? await fc.store.get(flowId) : undefined;
    if (draftId !== undefined && draftId !== "") {
      if (rec === undefined)
        return { ok: false, message: `Flow '${flowId}' not found.` };
      const draft =
        rec.drafts.find((d) => d.draftId === draftId)?.definition ??
        (draftId === DEFAULT_DRAFT_ID ? rec.draft : null);
      if (draft === null || draft === undefined)
        return {
          ok: false,
          message: `Flow '${flowId}' has no draft${draftId === DEFAULT_DRAFT_ID ? "" : ` '${draftId}'`} to compare.`,
        };
      return {
        ok: true,
        definition: draft,
        endpoint: { flowId, kind: "draft", draftId },
      };
    }
    if (rec !== undefined && rec.published !== null)
      return {
        ok: true,
        definition: rec.published,
        endpoint: { flowId, kind: "published", version: rec.version },
      };
    const fileSource = fc.fileRegistry.getSource?.(flowId);
    const fileDef = (fileSource?.definition ?? fc.fileRegistry.get(flowId)) as
      | FlowDefinition
      | undefined;
    if (fileDef !== undefined)
      return {
        ok: true,
        definition: fileDef,
        endpoint: {
          flowId,
          kind: "file",
          ...(fileSource !== undefined ? { file: fileSource.fileName } : {}),
        },
      };
    if (rec !== undefined && rec.draft !== null)
      return {
        ok: true,
        definition: rec.draft,
        endpoint: { flowId, kind: "draft", draftId: DEFAULT_DRAFT_ID },
      };
    return { ok: false, message: `Flow '${flowId}' not found.` };
  };

  router.get("/flows/diff/compare", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    const fromId = ctx.req.query("from");
    const toId = ctx.req.query("to");
    if (
      fromId === undefined ||
      fromId === "" ||
      toId === undefined ||
      toId === ""
    ) {
      return ctx.json(
        {
          error: {
            message: "Query params 'from' and 'to' (flow ids) are required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const fromSide = await resolveDiffSide(fromId, ctx.req.query("fromDraft"));
    if (!fromSide.ok)
      return ctx.json(
        { error: { message: fromSide.message, type: "not_found_error" } },
        404,
      );
    const toSide = await resolveDiffSide(toId, ctx.req.query("toDraft"));
    if (!toSide.ok)
      return ctx.json(
        { error: { message: toSide.message, type: "not_found_error" } },
        404,
      );
    return ctx.json({
      from: fromSide.endpoint,
      to: toSide.endpoint,
      diff: diffFlows(fromSide.definition, toSide.definition),
    });
  });

  // -------------------------------------------------------------------------
  // GET /flows/:id/diff — structural diff between two versions (or draft↔published)
  //   ?from=<version>&to=<version>   compare two published versions
  //   ?draft=true                    compare published → draft
  //   ?draft=true&draftId=<id>       compare published → that named draft
  //   (defaults: from = latest-1, to = latest)
  // -------------------------------------------------------------------------
  router.get("/flows/:id/diff", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    if (fc.store === undefined) return fc.requireStore(ctx);
    const id = ctx.req.param("id");

    if (ctx.req.query("draft") === "true") {
      const draftId = ctx.req.query("draftId") ?? DEFAULT_DRAFT_ID;
      const rec = await fc.store.get(id);
      const draftDef =
        rec?.drafts.find((d) => d.draftId === draftId)?.definition ??
        (draftId === DEFAULT_DRAFT_ID ? rec?.draft : null);
      // A draft of a flow that is live as a FILE (never published online) is
      // compared against that file — the version it would replace — in its
      // source form, like the draft itself, so shortcuts/variables don't show
      // up as spurious changes.
      const fileSource = fc.fileRegistry.getSource?.(id);
      const liveFile =
        fileSource?.definition ?? fc.fileRegistry.get(id);
      if (rec !== undefined && draftDef !== null && draftDef !== undefined && rec.published === null && liveFile !== undefined) {
        return ctx.json({
          from: { kind: "file", ...(fileSource ? { file: fileSource.fileName } : {}) },
          to: { kind: "draft", draftId },
          diff: diffFlows(liveFile as FlowDefinition, draftDef),
        });
      }
      if (rec === undefined || draftDef === null || draftDef === undefined) {
        return ctx.json(
          {
            error: {
              message: `Flow '${id}' has no draft${draftId === DEFAULT_DRAFT_ID ? "" : ` '${draftId}'`} to compare.`,
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      if (rec.published === null) {
        return ctx.json(
          {
            error: {
              message: `Flow '${id}' has no published version to compare the draft with.`,
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      return ctx.json({
        from: { kind: "published", version: rec.version },
        to: { kind: "draft", draftId },
        diff: diffFlows(rec.published, draftDef),
      });
    }

    const versions = await fc.store.listVersions(id); // newest first
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
}
