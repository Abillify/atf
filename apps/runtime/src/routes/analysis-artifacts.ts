// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Hono } from "hono";
import { z } from "zod";
import {
  ANALYSIS_ARTIFACT_TYPES,
  AnalysisArtifactConflictError,
  type AnalysisArtifactService,
  AnalysisArtifactValidationError,
  type AnalysisArtifactListFilter,
  type AnalysisArtifactScope,
} from "../artifacts/analysis-artifacts.js";
import {
  AUTH_PRINCIPAL_KEY,
  type AuthContext,
  type AuthPrincipal,
} from "../middleware/auth.js";

const optionalId = z.string().trim().min(1).max(500).optional();
const createSchema = z.object({
  assistant_id: optionalId,
  conversation_id: optionalId,
  project_id: optionalId,
  case_id: optionalId,
  type: z.enum(ANALYSIS_ARTIFACT_TYPES),
  schema_version: z.number().int().positive().max(1_000),
  title: z.string().trim().min(1).max(1_000),
  payload: z.unknown(),
  status: z.enum(["draft", "validated"]).optional(),
  source_execution_id: z.string().uuid().optional(),
  source_flow_id: optionalId,
  dataset_id: optionalId,
}).strict();

const revisionSchema = z.object({
  schema_version: z.number().int().positive().max(1_000).optional(),
  title: z.string().trim().min(1).max(1_000).optional(),
  payload: z.unknown().optional(),
  status: z.enum(["draft", "validated"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Revision body must change at least one field.");

function error(message: string, type = "invalid_request_error") {
  return { error: { message, type } };
}

function principalScope(principal: AuthPrincipal | undefined):
  | { ok: true; scope: AnalysisArtifactScope; actor: string }
  | { ok: false; message: string } {
  if (principal?.verified !== true || principal.tenantId === undefined || principal.tenantId.trim() === "") {
    return { ok: false, message: "A verified tenant scope is required." };
  }
  const claimUser =
    typeof principal.claims?.sub === "string" && principal.claims.sub.trim() !== ""
      ? principal.claims.sub
      : typeof principal.claims?.email === "string" && principal.claims.email.trim() !== ""
        ? principal.claims.email
        : undefined;
  const actor = claimUser ?? `${principal.method}:${principal.tenantId}`;
  return {
    ok: true,
    scope: {
      tenantId: principal.tenantId,
      ...(claimUser !== undefined ? { userId: claimUser } : {}),
    },
    actor,
  };
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : undefined;
}

export function createAnalysisArtifactsRouter(service: AnalysisArtifactService): Hono<AuthContext> {
  const router = new Hono<AuthContext>();

  router.post("/v1/analysis-artifacts", async (ctx) => {
    const scoped = principalScope(ctx.get(AUTH_PRINCIPAL_KEY));
    if (!scoped.ok) return ctx.json(error(scoped.message, "authentication_error"), 401);
    const parsed = createSchema.safeParse(await ctx.req.json().catch(() => undefined));
    if (!parsed.success) return ctx.json(error(parsed.error.issues[0]?.message ?? "Invalid body."), 400);
    try {
      const artifact = await service.create({
        scope: scoped.scope,
        ...(parsed.data.assistant_id !== undefined ? { assistantId: parsed.data.assistant_id } : {}),
        ...(parsed.data.conversation_id !== undefined ? { conversationId: parsed.data.conversation_id } : {}),
        ...(parsed.data.project_id !== undefined ? { projectId: parsed.data.project_id } : {}),
        ...(parsed.data.case_id !== undefined ? { caseId: parsed.data.case_id } : {}),
        type: parsed.data.type,
        schemaVersion: parsed.data.schema_version,
        title: parsed.data.title,
        payload: parsed.data.payload,
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.source_execution_id !== undefined ? { sourceExecutionId: parsed.data.source_execution_id } : {}),
        ...(parsed.data.source_flow_id !== undefined ? { sourceFlowId: parsed.data.source_flow_id } : {}),
        ...(parsed.data.dataset_id !== undefined ? { datasetId: parsed.data.dataset_id } : {}),
        createdBy: scoped.actor,
      });
      return ctx.json({ artifact }, 201);
    } catch (cause) {
      if (cause instanceof AnalysisArtifactValidationError) return ctx.json(error(cause.message), 400);
      throw cause;
    }
  });

  router.get("/v1/analysis-artifacts", async (ctx) => {
    const scoped = principalScope(ctx.get(AUTH_PRINCIPAL_KEY));
    if (!scoped.ok) return ctx.json(error(scoped.message, "authentication_error"), 401);
    const typeRaw = ctx.req.query("type");
    const statusRaw = ctx.req.query("status");
    if (typeRaw !== undefined && !ANALYSIS_ARTIFACT_TYPES.includes(typeRaw as never)) {
      return ctx.json(error("Invalid artifact type filter."), 400);
    }
    if (statusRaw !== undefined && !["draft", "validated", "superseded"].includes(statusRaw)) {
      return ctx.json(error("Invalid artifact status filter."), 400);
    }
    const limitRaw = ctx.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      return ctx.json(error("limit must be an integer from 1 to 500."), 400);
    }
    const latestRaw = ctx.req.query("latest");
    const latest = parseBoolean(latestRaw);
    if (latestRaw !== undefined && latest === undefined) {
      return ctx.json(error("latest must be true, false, 1, or 0."), 400);
    }
    const filter: AnalysisArtifactListFilter = {
      ...(typeRaw !== undefined ? { type: typeRaw as AnalysisArtifactListFilter["type"] } : {}),
      ...(statusRaw !== undefined ? { status: statusRaw as AnalysisArtifactListFilter["status"] } : {}),
      ...(ctx.req.query("assistant_id") !== undefined ? { assistantId: ctx.req.query("assistant_id") } : {}),
      ...(ctx.req.query("conversation_id") !== undefined ? { conversationId: ctx.req.query("conversation_id") } : {}),
      ...(ctx.req.query("project_id") !== undefined ? { projectId: ctx.req.query("project_id") } : {}),
      ...(ctx.req.query("case_id") !== undefined ? { caseId: ctx.req.query("case_id") } : {}),
      ...(ctx.req.query("source_execution_id") !== undefined ? { sourceExecutionId: ctx.req.query("source_execution_id") } : {}),
      ...(ctx.req.query("source_flow_id") !== undefined ? { sourceFlowId: ctx.req.query("source_flow_id") } : {}),
      ...(ctx.req.query("dataset_id") !== undefined ? { datasetId: ctx.req.query("dataset_id") } : {}),
      ...(latest !== undefined ? { latest } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    return ctx.json({ artifacts: await service.list(scoped.scope, filter) });
  });

  router.get("/v1/analysis-artifacts/:id", async (ctx) => {
    const scoped = principalScope(ctx.get(AUTH_PRINCIPAL_KEY));
    if (!scoped.ok) return ctx.json(error(scoped.message, "authentication_error"), 401);
    const id = z.string().uuid().safeParse(ctx.req.param("id"));
    if (!id.success) return ctx.json(error("Artifact id must be a UUID."), 400);
    const artifact = await service.get(scoped.scope, id.data);
    return artifact === undefined
      ? ctx.json(error("Analysis artifact not found.", "not_found"), 404)
      : ctx.json({ artifact });
  });

  router.post("/v1/analysis-artifacts/:id/revisions", async (ctx) => {
    const scoped = principalScope(ctx.get(AUTH_PRINCIPAL_KEY));
    if (!scoped.ok) return ctx.json(error(scoped.message, "authentication_error"), 401);
    const id = z.string().uuid().safeParse(ctx.req.param("id"));
    if (!id.success) return ctx.json(error("Artifact id must be a UUID."), 400);
    const parsed = revisionSchema.safeParse(await ctx.req.json().catch(() => undefined));
    if (!parsed.success) return ctx.json(error(parsed.error.issues[0]?.message ?? "Invalid body."), 400);
    try {
      const artifact = await service.createRevision({
        scope: scoped.scope,
        id: id.data,
        ...(parsed.data.schema_version !== undefined ? { schemaVersion: parsed.data.schema_version } : {}),
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.payload !== undefined ? { payload: parsed.data.payload } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        createdBy: scoped.actor,
      });
      return artifact === undefined
        ? ctx.json(error("Analysis artifact not found.", "not_found"), 404)
        : ctx.json({ artifact }, 201);
    } catch (cause) {
      if (cause instanceof AnalysisArtifactValidationError) return ctx.json(error(cause.message), 400);
      if (cause instanceof AnalysisArtifactConflictError) return ctx.json(error(cause.message, "conflict"), 409);
      throw cause;
    }
  });

  return router;
}
