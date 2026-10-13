// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * GET /flows — list file + online flows.
 * (Phase 18.4 split of flows.ts, Req. 13.6.)
 */

import type { Hono } from "hono";
import type { FlowsContext } from "./flows-context.js";
import type { FlowListEntry } from "./flows-shared.js";

export function registerFlowListRoutes(router: Hono, fc: FlowsContext): void {
  // -------------------------------------------------------------------------
  // GET /flows — list file + online flows
  // -------------------------------------------------------------------------
  router.get("/flows", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);

    const entries = new Map<string, FlowListEntry>();
    for (const f of fc.fileRegistry.list()) {
      entries.set(f.id, {
        id: f.id,
        name: f.name,
        source: "file",
        status: "file",
        version: 0,
        hasDraft: false,
        draftDirty: false,
        draftCount: 0,
        editable: false,
        nodeCount: f.nodes.length,
        edgeCount: f.edges.length,
      });
    }
    if (fc.store !== undefined) {
      for (const s of await fc.store.listAll()) {
        const fileShadowed = entries.get(s.id)?.source === "file";
        const rec = await fc.store.get(s.id);
        const def = rec?.published ?? rec?.draft;
        entries.set(s.id, {
          id: s.id,
          name: s.name,
          source: "online",
          ...(fileShadowed ? { shadowsFile: true } : {}),
          status: s.hasPublished ? "published" : "draft",
          version: s.version,
          hasDraft: s.hasDraft,
          draftDirty: s.draftDirty,
          draftCount: s.draftCount,
          ...(rec !== undefined
            ? {
                drafts: rec.drafts.map((d) => ({
                  draftId: d.draftId,
                  label: d.label,
                })),
              }
            : {}),
          editable: true,
          nodeCount: def?.nodes.length ?? 0,
          edgeCount: def?.edges.length ?? 0,
        });
      }
    }
    return ctx.json({
      flows: [...entries.values()],
      onlineEditing: fc.store !== undefined,
      fileWriting: fc.flowsDirWritable(),
    });
  });
}
