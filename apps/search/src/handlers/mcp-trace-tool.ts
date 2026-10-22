// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/mcp-trace-tool.ts
 *
 * The MCP `trace` tool (Epic E7, K1): follows an identifier across two points
 * in time. At each instant the identifier is looked up in the lexical index
 * (FTS-only search with the temporal `valid_at` visibility rule); the two
 * occurrence sets are diffed into added / removed / changed / unchanged.
 */

import { z } from "zod";
import { accessScopeForMcp } from "../access-scope.js";
import { aggregateTrustLabels, trustLabels } from "../content-trust.js";
import { parseRfc3339DateTime } from "../rfc3339.js";
import type { PostgresResponse, SearchResult } from "../pg-types.js";
import {
  centeredExcerpt,
  contentHash,
  traceIdentifier,
  type TraceOccurrence,
} from "../traceability.js";
import type { McpToolContext } from "./mcp-tool-ctx.js";

function json(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** Shapes one lexical hit into a trace occurrence. */
function shapeOccurrence(hit: SearchResult, identifier: string): TraceOccurrence {
  const sectionPath = hit.evidence?.section_path;
  return {
    base_ref: hit.base_ref ?? hit.reference,
    reference: hit.reference,
    ...(sectionPath !== undefined && sectionPath.length > 0
      ? { section: sectionPath.join(" > ") }
      : {}),
    ...(hit.evidence?.page_start !== undefined
      ? { page_start: hit.evidence.page_start }
      : {}),
    excerpt: centeredExcerpt(hit.content, identifier),
    content_hash: contentHash(hit.content),
  };
}

export function registerTraceTool(opts: McpToolContext): void {
  const { server, postgresClient, defaultCollection = "documents", authorize, emitQueryActivity } = opts;

  server.tool(
    "trace",
    'Trace an identifier (e.g. "WE-01/A") across two points in time. Runs the lexical identifier lookup at valid_at_a and at valid_at_b (each with the temporal "version valid at that instant" rule) and diffs the occurrences by document + section: added (only at b), removed (only at a), changed (present at both, content hash differs) and unchanged_count.',
    {
      identifier: z
        .string()
        .min(1)
        .max(200)
        .describe('The identifier to trace, as written (e.g. "WE-01/A", "DIN EN 1090-2")'),
      collection: z
        .string()
        .optional()
        .describe(`Collection to search (default: "${defaultCollection}")`),
      valid_at_a: z
        .string()
        .datetime({ offset: true })
        .describe("RFC 3339 instant with timezone: the earlier point in time"),
      valid_at_b: z
        .string()
        .datetime({ offset: true })
        .describe("RFC 3339 instant with timezone: the later point in time"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum occurrences per time point (default: 50)"),
    },
    async ({ identifier, collection, valid_at_a, valid_at_b, limit = 50 }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const validAtA = parseRfc3339DateTime(valid_at_a);
      const validAtB = parseRfc3339DateTime(valid_at_b);
      if (validAtA === undefined || validAtB === undefined) {
        return {
          content: [{ type: "text", text: "valid_at_a and valid_at_b must be RFC 3339 instants with a timezone." }],
          isError: true,
        };
      }

      // Each time point runs the same lexical lookup through the public search
      // interface (FTS-only, temporal visibility). A failed lookup aborts the
      // trace — a partial diff would be misleading.
      const lookup = async (validAt: string): Promise<TraceOccurrence[]> => {
        const res: PostgresResponse<SearchResult[]> = await postgresClient.search(
          identifier,
          [],
          limit,
          col,
          accessScopeForMcp(),
          undefined,
          false,
          false,
          0,
          4,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          validAt,
        );
        if (!res.ok) {
          throw new Error(res.error.message);
        }
        return res.result.map((hit) => shapeOccurrence(hit, identifier));
      };

      try {
        // The closure already captures identifier/limit for excerpt centring,
        // so the callback only needs the time point.
        const diff = await traceIdentifier(
          { identifier, valid_at_a: validAtA, valid_at_b: validAtB, limit },
          (_id, validAt, _lim) => lookup(validAt),
        );
        const occurrences = [
          ...diff.added,
          ...diff.removed,
          ...diff.changed.map((c) => c.b),
        ];
        emitQueryActivity({
          tool: "trace",
          summary: `${identifier}: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed, ${diff.unchanged_count} unchanged`,
          status: "ok",
          startTime,
          detail: {
            collection: col,
            identifier,
            valid_at_a: validAtA,
            valid_at_b: validAtB,
            added: diff.added.length,
            removed: diff.removed.length,
            changed: diff.changed.length,
            unchanged_count: diff.unchanged_count,
          },
        });
        return json({
          identifier,
          collection: col,
          valid_at_a: validAtA,
          valid_at_b: validAtB,
          added: diff.added.map((o) => ({ ...o, ...trustLabels(o.excerpt) })),
          removed: diff.removed.map((o) => ({ ...o, ...trustLabels(o.excerpt) })),
          changed: diff.changed.map((c) => ({
            key: c.key,
            a: { ...c.a, ...trustLabels(c.a.excerpt) },
            b: { ...c.b, ...trustLabels(c.b.excerpt) },
          })),
          unchanged_count: diff.unchanged_count,
          ...aggregateTrustLabels(occurrences.map((o) => trustLabels(o.excerpt).injection_risk)),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitQueryActivity({
          tool: "trace",
          summary: `${identifier} in ${col} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, identifier, error: message },
        });
        return { content: [{ type: "text", text: `Trace failed: ${message}` }], isError: true };
      }
    },
  );
}
