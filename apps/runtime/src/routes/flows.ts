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
 *     PUT    /flows/:id/draft            — save the (default) working draft
 *     GET    /flows/:id/drafts           — list all named drafts
 *     PUT    /flows/:id/drafts/:draftId  — save a named draft
 *     DELETE /flows/:id/drafts/:draftId  — remove a named draft
 *     POST   /flows/:id/publish          — validate + promote a draft to live
 *                                          (?draftId= selects the draft)
 *     DELETE /flows/:id                  — remove an online flow
 *     GET    /flows/:id/versions         — published version history
 *     POST   /flows/:id/rollback         — re-publish a past version
 *
 * File-based flows are read-only here (they are owned by FLOWS_DIR / the image);
 * an online flow with the same id overrides a file flow in the composite
 * registry. So a deployment can be fully file/image based, fully online, or a
 * mix. No `any` at module boundaries.
 *
 * Split (Phase 18.4, Req. 13.6): the route groups live in the
 * flows-routes-*.ts modules, pure helpers in flows-shared.ts and the former
 * closure state in flows-context.ts (createFlowsContext). The registration
 * order below is significant — static paths must be mounted before
 * /flows/:id.
 */

import { Hono } from "hono";
import type { FlowsContext, FlowsRouterDeps } from "./flows-context.js";
import { createFlowsContext } from "./flows-context.js";
import { registerFlowListRoutes } from "./flows-routes-list.js";
import { registerFlowSourceRoutes } from "./flows-routes-source.js";
import { registerFlowCatalogRoutes } from "./flows-routes-catalog.js";
import { registerFlowCrudRoutes } from "./flows-routes-crud.js";
import { registerFlowInspectRoutes } from "./flows-routes-inspect.js";
import { registerFlowOpsRoutes } from "./flows-routes-ops.js";

export type { FlowsRouterDeps } from "./flows-context.js";
export type { FlowWriteRequest, FlowListEntry } from "./flows-shared.js";

export function createFlowsRouter(deps: FlowsRouterDeps): Hono {
  const router = new Hono();
  const fc: FlowsContext = createFlowsContext(deps);
  registerFlowListRoutes(router, fc);
  registerFlowSourceRoutes(router, fc);
  registerFlowCatalogRoutes(router, fc);
  registerFlowCrudRoutes(router, fc);
  registerFlowInspectRoutes(router, fc);
  registerFlowOpsRoutes(router, fc);
  return router;
}
