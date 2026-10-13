// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/mcp-catalog.ts
 *
 * The read-only catalog / document tools: list_collections,
 * collection_stats, collection_overview, list_documents, list_folders,
 * find_folders, get_document, get_thread, get_document_asset,
 * get_documents, get_summary and get_summaries.
 *
 * Extracted verbatim from handlers/mcp.ts (Requirement 13.6). The tools are
 * registered onto the SAME {@link McpServer} built by buildMcpServer, so they
 * inherit its one registration boundary — identical Fabric scope,
 * authorization and idempotency semantics.
 */

import { z } from "zod";
import { accessScopeForMcp } from "../access-scope.js";
import { normalizePathPrefix, normalizeReference } from "../postgres-client.js";
import { DOCUMENT_ASSET_MIME_TYPES } from "./document-assets.js";
import type { McpToolContext } from "./mcp-tool-ctx.js";

export function registerCatalogTools(opts: McpToolContext): void {
  const {
    server,
    postgresClient,
    defaultCollection = "documents",
    authorize,
    documentGroupOf,
    emitQueryActivity,
  } = opts;

  // ── Tool: list_collections ────────────────────────────────────────────────
  server.tool(
    "list_collections",
    "List all available collections with their document counts and configuration.",
    {},
    async () => {
      const startTime = Date.now();
      const scope = accessScopeForMcp();
      const result = await postgresClient.listCollections(scope);
      if (!result.ok) {
        emitQueryActivity({
          tool: "list_collections",
          summary: "failed",
          status: "error",
          startTime,
          detail: { error: result.error.message },
        });
        return {
          content: [
            {
              type: "text",
              text: `Failed to list collections: ${result.error.message}`,
            },
          ],
          isError: true,
        };
      }

      const collections = result.result.map((c) => ({
        collection: c.collection,
        totalDocs: c.totalDocs,
        totalChunks: c.totalChunks,
        vectorSize: c.vectorSize,
        ftsLanguage: c.ftsLanguage,
        sparseEnabled: c.sparseEnabled,
        quantization: c.quantization,
      }));

      emitQueryActivity({
        tool: "list_collections",
        summary: `${collections.length} collection${collections.length === 1 ? "" : "s"}`,
        status: "ok",
        startTime,
        detail: { count: collections.length },
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { collections, count: collections.length },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── Tool: collection_stats ──────────────────────────────────────────────
  // Aggregate counts (number of documents / chunks), optionally scoped to a
  // folder. Answers "how many documents are in the akte / in folder X" — which
  // semantic search alone cannot do reliably.
  server.tool(
    "collection_stats",
    "Count documents and chunks in a collection, optionally scoped to a folder path prefix. Use this for questions about how many documents exist (in total or within a folder).",
    {
      collection: z
        .string()
        .optional()
        .describe(`Collection to inspect (default: "${defaultCollection}")`),
      path_prefix: z
        .string()
        .optional()
        .describe(
          'Restrict to documents beneath this folder path, e.g. "/Unterlagen Teil 1". Omit for the whole collection.',
        ),
    },
    async ({ collection, path_prefix }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getCollectionStats(col, accessScopeForMcp(), path_prefix);
      if (!result.ok) {
        emitQueryActivity({
          tool: "collection_stats",
          summary: `${col}${path_prefix ? " " + path_prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, path_prefix, error: result.error.message },
        });
        return {
          content: [
            { type: "text", text: `Stats failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }
      emitQueryActivity({
        tool: "collection_stats",
        summary: `${col}${path_prefix ? " " + path_prefix : ""}`,
        status: "ok",
        startTime,
        detail: { collection: col, path_prefix, stats: result.result },
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(result.result, null, 2) },
        ],
      };
    },
  );

  // ── Tool: collection_overview ─────────────────────────────────────────────
  // A rich statistical snapshot of a collection (or a folder within it):
  // document/chunk/folder counts, chunk- and document-size distributions,
  // summary coverage and the index configuration. Use it when the user wants
  // "the key numbers", a health snapshot, or to understand the shape of the
  // akte before diving in.
  server.tool(
    "collection_overview",
    "Get a rich statistical overview of a collection (or a folder within it): number of documents, chunks (and chunk rows across all versions), folders, chunk-size and document-size distributions (min/max/avg/median characters), chunks-per-document, summary coverage (how many documents have a stored summary and their average length), the index configuration (vector size, FTS language, sparse/quantization) and the modified-time span. Use this for the key numbers / a health snapshot of the akte. For a simple document/chunk count only, use collection_stats.",
    {
      collection: z
        .string()
        .optional()
        .describe(`Collection to inspect (default: "${defaultCollection}")`),
      path_prefix: z
        .string()
        .optional()
        .describe(
          'Restrict the overview to documents beneath this folder path, e.g. "/Unterlagen Teil 1". Omit for the whole collection.',
        ),
    },
    async ({ collection, path_prefix }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getCollectionOverview(
        col,
        accessScopeForMcp(),
        path_prefix,
      );
      if (!result.ok) {
        emitQueryActivity({
          tool: "collection_overview",
          summary: `${col}${path_prefix ? " " + path_prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, path_prefix, error: result.error.message },
        });
        return {
          content: [
            { type: "text", text: `Overview failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }
      const ov = result.result;
      emitQueryActivity({
        tool: "collection_overview",
        summary: `${col}${path_prefix ? " " + path_prefix : ""} — ${ov.documents} docs, ${ov.chunks} chunks, ${ov.folders} folders`,
        status: "ok",
        startTime,
        detail: { collection: col, path_prefix, overview: ov },
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(ov, null, 2) },
        ],
      };
    },
  );

  // ── Tool: list_documents ──────────────────────────────────────────────────
  server.tool(
    "list_documents",
    "List the documents in a collection (one entry per document, not per chunk), newest first, optionally restricted to a folder path prefix. Paginated. Use this to enumerate the files of the akte / a folder.",
    {
      collection: z
        .string()
        .optional()
        .describe(`Collection to list (default: "${defaultCollection}")`),
      path_prefix: z
        .string()
        .optional()
        .describe(
          'Only list documents beneath this folder path, e.g. "/Unterlagen Teil 1".',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum documents to return (default: 100)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of documents to skip (pagination, default: 0)"),
    },
    async ({ collection, path_prefix, limit, offset }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.listDocuments(col, accessScopeForMcp(), {
        ...(path_prefix !== undefined ? { pathPrefix: path_prefix } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({
          tool: "list_documents",
          summary: `${col}${path_prefix ? " " + path_prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, path_prefix, error: result.error.message },
        });
        return {
          content: [
            { type: "text", text: `List failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }
      const { documents, total } = result.result;
      emitQueryActivity({
        tool: "list_documents",
        summary: `${documents.length} of ${total} document${total === 1 ? "" : "s"} in ${col}${path_prefix ? " " + path_prefix : ""}`,
        status: "ok",
        startTime,
        detail: {
          collection: col,
          path_prefix,
          count: documents.length,
          total,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { documents, count: documents.length, total },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── Tool: list_folders ────────────────────────────────────────────────────
  server.tool(
    "list_folders",
    "List the sub-folders beneath a folder path (derived from document paths). Each folder reports its recursive document (file) count, recursive chunk count, and the number and names of its immediate child folders; the top-level 'files' field counts documents lying directly at the queried level. Use this to explore the folder structure and size of the akte.",
    {
      collection: z
        .string()
        .optional()
        .describe(`Collection to inspect (default: "${defaultCollection}")`),
      path_prefix: z
        .string()
        .optional()
        .describe(
          'Folder to list the contents of, e.g. "/Unterlagen Teil 1". Omit or "/" for the top level.',
        ),
      depth: z
        .number()
        .int()
        .optional()
        .describe(
          "How many folder levels below the prefix to return: 1 (default) = immediate children only; n>1 = up to n levels; 0 or negative = the entire sub-tree.",
        ),
    },
    async ({ collection, path_prefix, depth }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.listFolders(col, accessScopeForMcp(), {
        ...(path_prefix !== undefined ? { pathPrefix: path_prefix } : {}),
        ...(depth !== undefined ? { depth } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({
          tool: "list_folders",
          summary: `${col}${path_prefix ? " " + path_prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, path_prefix, error: result.error.message },
        });
        return {
          content: [
            { type: "text", text: `List failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }
      emitQueryActivity({
        tool: "list_folders",
        summary: `${col}${path_prefix ? " " + path_prefix : "/"}`,
        status: "ok",
        startTime,
        detail: { collection: col, path_prefix, result: result.result },
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(result.result, null, 2) },
        ],
      };
    },
  );

  // ── Tool: find_folders ────────────────────────────────────────────────────
  // Resolve an arbitrary folder NAME to its actual path(s) anywhere in the
  // collection, without the caller having to know where it is nested. Use this
  // when the user names a folder ("ExampleRecords", "Records Part 3") but you
  // don't yet know its full path_prefix — then pass the resolved path to the
  // other folder-scoped tools.
  server.tool(
    "find_folders",
    "Fuzzily find folders whose NAME matches a search term, anywhere in the collection and at any nesting depth (case-insensitive; tolerates typos, partial names and word-order; matches any path segment). Use this to resolve a folder the user named (e.g. \"ExampleRecords\" or \"Records Part 3\") to its actual path_prefix before calling search/list_documents/get_documents/collection_stats. Returns ALL matching folder paths above the score threshold (each with a fuzzy 'score' 0..1, its recursive document (file) and chunk counts, and the number and names of its immediate child folders), best match first — when several folders match well, they are all returned so you can pick the right one or ask the user.",
    {
      query: z
        .string()
        .min(1)
        .describe(
          'Folder name (or part of it) to look for, e.g. "ExampleRecords". Case-insensitive; fuzzy (typo/partial tolerant).',
        ),
      collection: z
        .string()
        .optional()
        .describe(`Collection to search (default: "${defaultCollection}")`),
      match_full_path: z
        .boolean()
        .optional()
        .describe(
          "Match the query against the whole folder path instead of individual path segments. Default: false (segment match).",
        ),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Minimum fuzzy score (0..1) for a folder to be returned (default: 0.4). Lower it to be more permissive, raise it to only get very close matches.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum matching folders to return (default: 50)"),
    },
    async ({ query, collection, match_full_path, threshold, limit }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.findFolders(col, accessScopeForMcp(), query, {
        ...(match_full_path !== undefined
          ? { matchFullPath: match_full_path }
          : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({
          tool: "find_folders",
          summary: `${col} "${query}" — failed`,
          status: "error",
          startTime,
          detail: { collection: col, query, error: result.error.message },
        });
        return {
          content: [
            { type: "text", text: `Find failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }
      const { matches } = result.result;
      emitQueryActivity({
        tool: "find_folders",
        summary: `${matches.length} match${matches.length === 1 ? "" : "es"} for "${query}" in ${col}`,
        status: "ok",
        startTime,
        detail: { collection: col, query, count: matches.length },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { query, matches, count: matches.length },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── Tool: get_document ────────────────────────────────────────────────────
  // Reassemble a whole document from its chunks — so the model can read a
  // complete file, not just the passages semantic search happened to return.
  server.tool(
    "get_document",
    "Fetch a document reassembled from its chunks (in order, overlaps trimmed). Pass the document reference/path (from list_documents or a search hit's base_ref). Use this to read an entire file rather than only retrieved passages. Large documents are windowed by max_chars — if the returned 'truncated' is true, read the rest with offset.",
    {
      reference: z
        .string()
        .min(1)
        .describe(
          "The document reference/path (base_ref), or any chunk reference of it.",
        ),
      collection: z
        .string()
        .optional()
        .describe(`Collection to read from (default: "${defaultCollection}")`),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .max(2_000_000)
        .optional()
        .describe(
          "Maximum characters of document text to return (default: 200000). Guards against overflowing the context on very large documents.",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Character offset to start from (default: 0). Use with max_chars to page through a document whose previous call returned truncated=true.",
        ),
      valid_at: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "RFC 3339 instant with timezone: read the version valid at that time (the same version search's valid_at selects). Default: the current version.",
        ),
    },
    async ({ reference, collection, max_chars, offset, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getDocument(col, accessScopeForMcp(), reference, {
        ...(valid_at !== undefined ? { validAt: valid_at } : {}),
        ...(max_chars !== undefined ? { maxChars: max_chars } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({
          tool: "get_document",
          summary: `${reference}${col !== "documents" ? " in " + col : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, reference, error: result.error.message },
        });
        return {
          content: [
            { type: "text", text: `Get failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }
      if (result.result === null) {
        emitQueryActivity({
          tool: "get_document",
          summary: `${reference}${col !== "documents" ? " in " + col : ""} — not found`,
          status: "error",
          startTime,
          detail: { collection: col, reference, notFound: true },
        });
        return {
          content: [
            {
              type: "text",
              text: `No document found for reference "${reference}" in collection "${col}".`,
            },
          ],
          isError: true,
        };
      }
      emitQueryActivity({
        tool: "get_document",
        summary: `${reference}${col !== "documents" ? " in " + col : ""}`,
        status: "ok",
        startTime,
        detail: { collection: col, reference },
      });
      // An e-mail names its thread, so the caller knows the message is one
      // part of a conversation (read it whole with get_thread).
      const group = await documentGroupOf(col, result.result.reference);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(group ? { ...result.result, document_group: group } : result.result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "get_thread",
    "Read a whole e-mail thread: every message of the conversation in chronological order, each with its reference, sender/recipients/date header and its own text (quoted history is not repeated). Pass any message's reference (a search hit's base_ref) or a thread id (document_group.id). Bounded by max_chars — check 'truncated'. Cite each statement with the reference of the message it comes from.",
    {
      reference: z
        .string()
        .min(1)
        .describe("A message's reference/base_ref, or the thread id from a hit's document_group.id"),
      collection: z
        .string()
        .optional()
        .describe(`Collection to read from (default: "${defaultCollection}")`),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .max(2_000_000)
        .optional()
        .describe("Maximum characters over all messages (default: 200000)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of messages to skip (pagination; pass the previous call's next_offset when truncated=true)"),
      path_prefix: z
        .string()
        .optional()
        .describe('Only messages beneath this folder path (e.g. "/Kunde A"); messages of the thread elsewhere are left out and counted in "outside_prefix".'),
    },
    async ({ reference, collection, max_chars, offset, path_prefix }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const scope = accessScopeForMcp();
      const budget = max_chars ?? 200_000;
      const prefix = normalizePathPrefix(path_prefix);
      if (postgresClient.listThreadMembers === undefined || postgresClient.resolveDocumentGroups === undefined) {
        return { content: [{ type: "text", text: "Threads are not supported by this backend." }], isError: true };
      }
      // A message reference resolves to its thread; anything else is taken as
      // the thread id itself.
      const doc = await postgresClient.getDocument(col, scope, reference, { maxChars: 1000 });
      const baseRef = doc.ok && doc.result ? doc.result.reference : undefined;
      const group = baseRef ? await documentGroupOf(col, baseRef) : undefined;
      if (baseRef && (group === undefined || group.kind !== "email_thread")) {
        return {
          content: [{ type: "text", text: `"${baseRef}" is not part of an e-mail thread; read it with get_document.` }],
          isError: true,
        };
      }
      const threadId = group?.id ?? reference;
      const members = await postgresClient.listThreadMembers(col, scope, threadId);
      if (!members.ok || members.result.length === 0) {
        emitQueryActivity({ tool: "get_thread", summary: `${reference} in ${col} — not found`, status: "error", startTime, detail: { collection: col, reference } });
        return { content: [{ type: "text", text: `No e-mail thread found for "${reference}" in collection "${col}".` }], isError: true };
      }
      const messages: Array<{ reference: string; title: string | null; content: string; truncated: boolean }> = [];
      let used = 0;
      let truncated = false;
      // A folder scope keeps a comparison side from reading the other side's
      // messages of a shared thread.
      const inScope = members.result.filter((m) => prefix === "" || normalizeReference(m).startsWith(`${prefix}/`));
      const outsidePrefix = members.result.length - inScope.length;
      const start = Math.min(offset ?? 0, inScope.length);
      let nextOffset: number | null = null;
      for (let i = start; i < inScope.length; i++) {
        const member = inScope[i] as string;
        if (used >= budget) {
          truncated = true;
          nextOffset = i;
          break;
        }
        const read = await postgresClient.getDocument(col, scope, member, { maxChars: Math.max(1000, budget - used) });
        // A message the caller may not see (row ACL) or that was deleted.
        if (!read.ok || read.result === null) continue;
        messages.push({
          reference: read.result.reference,
          title: read.result.title,
          content: read.result.content,
          truncated: read.result.truncated === true,
        });
        if (read.result.truncated === true) {
          // This message itself did not fit: the next call starts after it.
          truncated = true;
          nextOffset = i + 1 < inScope.length ? i + 1 : null;
          used = budget;
        } else {
          used += read.result.content.length;
        }
      }
      emitQueryActivity({
        tool: "get_thread",
        summary: `${messages.length} message${messages.length === 1 ? "" : "s"} of thread ${group?.title ?? threadId}`,
        status: "ok",
        startTime,
        detail: { collection: col, reference, thread_id: threadId, messages: messages.length, truncated },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                thread_id: threadId,
                subject: group?.title ?? messages[0]?.title ?? null,
                messages,
                count: messages.length,
                total: inScope.length,
                offset: start,
                truncated,
                ...(nextOffset !== null ? { next_offset: nextOffset } : {}),
                ...(outsidePrefix > 0 ? { outside_prefix: outsidePrefix } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── Tool: get_document_asset ─────────────────────────────────────────────
  server.tool(
    "get_document_asset",
    "Fetch an authorized original document figure as MCP image content. Use the asset_id from a search result; optional expected document/figure fields fail closed when evidence and asset metadata do not match.",
    {
      asset_id: z.string().min(1).describe("Asset ID from search evidence"),
      collection: z
        .string()
        .optional()
        .describe(`Collection to read from (default: "${defaultCollection}")`),
      expected_document_reference: z
        .string()
        .min(1)
        .optional()
        .describe("Optional expected document reference from the search hit"),
      expected_figure_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional expected figure ID from the search evidence"),
    },
    async ({ asset_id, collection, expected_document_reference, expected_figure_id }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getDocumentAsset(
        col,
        asset_id,
        accessScopeForMcp(),
      );
      const fail = (reason: "lookup_failed" | "not_found" | "metadata_mismatch" | "unsupported_mime") => {
        emitQueryActivity({
          tool: "get_document_asset",
          summary: `${asset_id}${col !== "documents" ? " in " + col : ""} — unavailable`,
          status: "error",
          startTime,
          detail: { collection: col, assetId: asset_id, reason },
        });
        return {
          content: [{ type: "text" as const, text: `No authorized image asset found for "${asset_id}" in collection "${col}".` }],
          isError: true,
        };
      };
      if (!result.ok) return fail("lookup_failed");
      const asset = result.result;
      if (asset === null) return fail("not_found");
      if (
        (expected_document_reference !== undefined &&
          asset.documentReference !== expected_document_reference) ||
        (expected_figure_id !== undefined && asset.figureId !== expected_figure_id)
      ) {
        return fail("metadata_mismatch");
      }
      if (!DOCUMENT_ASSET_MIME_TYPES.has(asset.mimeType)) {
        return fail("unsupported_mime");
      }
      emitQueryActivity({
        tool: "get_document_asset",
        summary: `${asset.assetId}${col !== "documents" ? " in " + col : ""}`,
        status: "ok",
        startTime,
        detail: {
          collection: col,
          assetId: asset.assetId,
          documentReference: asset.documentReference,
          figureId: asset.figureId,
          mimeType: asset.mimeType,
          bytes: asset.data.length,
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              asset_id: asset.assetId,
              document_reference: asset.documentReference,
              figure_id: asset.figureId,
              mime_type: asset.mimeType,
              ...(asset.checksum !== undefined ? { checksum: asset.checksum } : {}),
            }),
          },
          {
            type: "image" as const,
            data: asset.data.toString("base64"),
            mimeType: asset.mimeType,
          },
        ],
      };
    },
  );

  // ── Tool: get_documents ───────────────────────────────────────────────────
  // Reassemble EVERY document beneath a folder at once — read a whole folder in
  // one call. Bounded by `limit` and `max_chars` so the result can't overflow
  // the model context; `truncated` signals when not everything was returned.
  server.tool(
    "get_documents",
    "Fetch every document beneath a folder path at once, each reassembled from its chunks (in order, overlaps trimmed). Use this to read a whole folder of the akte in one call. Bounded by limit and max_chars; check the 'truncated' flag and paginate/narrow the path if it is true.",
    {
      path_prefix: z
        .string()
        .optional()
        .describe(
          'Folder whose documents to read, e.g. "/Unterlagen Teil 1". Omit for the whole collection (bounded by limit).',
        ),
      collection: z
        .string()
        .optional()
        .describe(`Collection to read from (default: "${defaultCollection}")`),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum number of documents to reassemble (default: 20)"),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .max(2_000_000)
        .optional()
        .describe(
          "Maximum combined content length across all returned documents (default: 200000). Guards against overflowing the context.",
        ),
      valid_at: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "RFC 3339 instant with timezone: read the version valid at that time (the same version search's valid_at selects). Default: the current version.",
        ),
    },
    async ({ path_prefix, collection, limit, max_chars, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getDocumentsByPrefix(col, accessScopeForMcp(), {
        ...(valid_at !== undefined ? { validAt: valid_at } : {}),
        ...(path_prefix !== undefined ? { pathPrefix: path_prefix } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(max_chars !== undefined ? { maxChars: max_chars } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({
          tool: "get_documents",
          summary: `${col}${path_prefix ? " " + path_prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, path_prefix, error: result.error.message },
        });
        return {
          content: [
            { type: "text", text: `Get failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }
      const { documents, total, truncated } = result.result;
      emitQueryActivity({
        tool: "get_documents",
        summary: `${documents.length} of ${total} document${total === 1 ? "" : "s"} in ${col}${path_prefix ? " " + path_prefix : ""}${truncated ? " (truncated)" : ""}`,
        status: "ok",
        startTime,
        detail: {
          collection: col,
          path_prefix,
          count: documents.length,
          total,
          truncated,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { documents, count: documents.length, total, truncated },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── Tool: get_summary ─────────────────────────────────────────────────────
  // The per-document summary generated at ingest time (X-Summarize), stored on
  // chunk 0. Much cheaper than reading the whole document when you only need
  // the gist.
  server.tool(
    "get_summary",
    "Fetch the stored summary of a single document (generated at ingest time). Pass the document reference/path (or any chunk reference). Cheaper than get_document when you only need the gist.",
    {
      reference: z
        .string()
        .min(1)
        .describe(
          "The document reference/path (base_ref), or any chunk reference of it.",
        ),
      collection: z
        .string()
        .optional()
        .describe(`Collection to read from (default: "${defaultCollection}")`),
      valid_at: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "RFC 3339 instant with timezone: read the version valid at that time (the same version search's valid_at selects). Default: the current version.",
        ),
    },
    async ({ reference, collection, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getSummary(
        col,
        accessScopeForMcp(),
        reference,
        valid_at !== undefined ? { validAt: valid_at } : undefined,
      );
      if (!result.ok) {
        emitQueryActivity({
          tool: "get_summary",
          summary: `${reference}${col !== "documents" ? " in " + col : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, reference, error: result.error.message },
        });
        return {
          content: [
            { type: "text", text: `Get failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }
      if (result.result === null) {
        emitQueryActivity({
          tool: "get_summary",
          summary: `${reference}${col !== "documents" ? " in " + col : ""} — not found`,
          status: "error",
          startTime,
          detail: { collection: col, reference, notFound: true },
        });
        return {
          content: [
            {
              type: "text",
              text: `No document found for reference "${reference}" in collection "${col}".`,
            },
          ],
          isError: true,
        };
      }
      emitQueryActivity({
        tool: "get_summary",
        summary: `${reference}${col !== "documents" ? " in " + col : ""}`,
        status: "ok",
        startTime,
        detail: { collection: col, reference },
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(result.result, null, 2) },
        ],
      };
    },
  );

  // ── Tool: get_summaries ───────────────────────────────────────────────────
  // One summary per document — the cheap "whole-akte overview". Ideal to build
  // a case dossier or to plan which documents to read in full.
  server.tool(
    "get_summaries",
    "List the stored summaries of the documents in a collection (one per document), optionally restricted to a folder path prefix. The cheap way to get an overview of the whole akte / a folder and to decide which documents to read in full.",
    {
      collection: z
        .string()
        .optional()
        .describe(`Collection to read from (default: "${defaultCollection}")`),
      path_prefix: z
        .string()
        .optional()
        .describe(
          'Only summaries of documents beneath this folder path, e.g. "/Unterlagen Teil 1".',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum summaries to return (default: 100)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of documents to skip (pagination, default: 0)"),
      valid_at: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "RFC 3339 instant with timezone: read the version valid at that time (the same version search's valid_at selects). Default: the current version.",
        ),
    },
    async ({ collection, path_prefix, limit, offset, valid_at }) => {
      const startTime = Date.now();
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.getSummaries(col, accessScopeForMcp(), {
        ...(valid_at !== undefined ? { validAt: valid_at } : {}),
        ...(path_prefix !== undefined ? { pathPrefix: path_prefix } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      if (!result.ok) {
        emitQueryActivity({
          tool: "get_summaries",
          summary: `${col}${path_prefix ? " " + path_prefix : ""} — failed`,
          status: "error",
          startTime,
          detail: { collection: col, path_prefix, error: result.error.message },
        });
        return {
          content: [
            { type: "text", text: `List failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }
      const { summaries: entries, total } = result.result;
      // Each e-mail names its thread, so a triage sees the messages of one
      // conversation together (and can read it whole with get_thread).
      const groups =
        entries.length > 0 && postgresClient.resolveDocumentGroups !== undefined
          ? await postgresClient.resolveDocumentGroups(col, accessScopeForMcp(), entries.map((e) => e.reference))
          : undefined;
      const summaries = entries.map((e) => {
        const group = groups?.ok ? groups.result.get(e.reference) : undefined;
        return group ? { ...e, document_group: group } : e;
      });
      emitQueryActivity({
        tool: "get_summaries",
        summary: `${summaries.length} of ${total} summar${total === 1 ? "y" : "ies"} in ${col}${path_prefix ? " " + path_prefix : ""}`,
        status: "ok",
        startTime,
        detail: {
          collection: col,
          path_prefix,
          count: summaries.length,
          total,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { summaries, count: summaries.length, total },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
