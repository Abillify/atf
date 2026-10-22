// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/mcp-document-diff-tool.ts
 *
 * The MCP `document_diff` tool (Epic E7, K1): compares one document's units
 * between two points in time. The units at each instant come from the same
 * navigation reads that back `get_pages` (with the temporal `valid_at`
 * visibility rule), so the diff sees exactly what a read at that instant
 * would see. Alignment: `section_id`, then `unit_id`, then the ordinal-based
 * pair key, then reading order.
 */

import { z } from "zod";
import { aggregateTrustLabels, trustLabels } from "../content-trust.js";
import { parseRfc3339DateTime } from "../rfc3339.js";
import { buildDocumentDiff } from "./document-diff-v2.js";
import type { McpToolContext } from "./mcp-tool-ctx.js";

function json(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function registerDocumentDiffTool(opts: McpToolContext): void {
  const { server, postgresClient, defaultCollection = "documents", authorize, emitQueryActivity } = opts;

  server.tool(
    "document_diff",
    "Compare one document's units between two points in time. Loads the document's units at `from` and at `to` (each with the temporal \"version valid at that instant\" rule) and diffs them by section, then unit id, then reading order: added (only at to), removed (only at from), changed (aligned unit whose content hash differs, with before/after excerpts) and unchanged_count.",
    {
      base_ref: z
        .string()
        .min(1)
        .max(512)
        .describe("Document base reference (the stable document identity)"),
      collection: z
        .string()
        .optional()
        .describe(`Collection to read (default: "${defaultCollection}")`),
      from: z
        .string()
        .datetime({ offset: true })
        .describe("RFC 3339 instant with timezone: the earlier point in time"),
      to: z
        .string()
        .datetime({ offset: true })
        .describe("RFC 3339 instant with timezone: the later point in time"),
    },
    async ({ base_ref, collection, from, to }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      const { scope } = await authorize(col);
      const fromInstant = parseRfc3339DateTime(from);
      const toInstant = parseRfc3339DateTime(to);
      if (fromInstant === undefined || toInstant === undefined) {
        return {
          content: [{ type: "text", text: "from and to must be RFC 3339 instants with a timezone." }],
          isError: true,
        };
      }

      try {
        const diff = await buildDocumentDiff(
          postgresClient,
          col,
          scope,
          base_ref,
          fromInstant,
          toInstant,
        );
        const risks = [
          ...diff.added.map((u) => trustLabels(u.excerpt).injection_risk),
          ...diff.removed.map((u) => trustLabels(u.excerpt).injection_risk),
          ...diff.changed.flatMap((c) => [
            trustLabels(c.before_excerpt).injection_risk,
            trustLabels(c.after_excerpt).injection_risk,
          ]),
        ];
        emitQueryActivity({
          tool: "document_diff",
          summary: `${base_ref}: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed, ${diff.unchanged_count} unchanged`,
          status: "ok",
          startTime,
          detail: {
            collection: col,
            base_ref,
            from: fromInstant,
            to: toInstant,
            added: diff.added.length,
            removed: diff.removed.length,
            changed: diff.changed.length,
            unchanged_count: diff.unchanged_count,
          },
        });
        return json({
          ...diff,
          added: diff.added.map((u) => ({ ...u, ...trustLabels(u.excerpt) })),
          removed: diff.removed.map((u) => ({ ...u, ...trustLabels(u.excerpt) })),
          changed: diff.changed.map((c) => ({
            key: c.key,
            before_excerpt: c.before_excerpt,
            after_excerpt: c.after_excerpt,
            ...trustLabels(c.after_excerpt),
          })),
          ...aggregateTrustLabels(risks),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitQueryActivity({
          tool: "document_diff",
          summary: `${base_ref} in ${col} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, base_ref, error: message },
        });
        return { content: [{ type: "text", text: `Document diff failed: ${message}` }], isError: true };
      }
    },
  );
}
