// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * openapi.ts
 *
 * The machine-readable API description, served unauthenticated at
 * `/openapi.json` so tooling can read it without a credential — the same choice
 * Search makes.
 *
 * Hand-written rather than generated from the Zod schemas. The interesting part
 * of this API is not its body shapes, which are thin, but its *header* contract:
 * which header selects which response mode, which headers are forwarded to
 * Search, and what `X-Callback-URL` costs you. None of that is derivable from a
 * type, and a generated document that omitted it would be worse than no document.
 */

import { EXTRACT_CONTRACT_ID, EXTRACT_CONTRACT_VERSION } from "@atf/extract-contract";
import { supportedMimeTypes } from "./formats.js";

export interface OpenApiOptions {
  serverUrl: string;
  ingestEnabled: boolean;
}

export function buildOpenApiSpec(options: OpenApiOptions): Record<string, unknown> {
  const documentContent = Object.fromEntries(
    supportedMimeTypes().map((mimeType) => [
      mimeType,
      { schema: { type: "string", format: "binary" } },
    ]),
  );

  const uploadRequestBody = {
    required: true,
    description:
      "Either multipart/form-data with a `document` field, or the raw file with its own " +
      "Content-Type. The raw form is intended for service-to-service callers.",
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          required: ["document"],
          properties: { document: { type: "string", format: "binary" } },
        },
      },
      ...documentContent,
    },
  };

  const commonHeaders = [
    {
      name: "X-Reference",
      in: "header",
      required: false,
      description:
        "Stable document identity. Figure asset ids are derived from it. Defaults to the " +
        "filename for conversion; required for ingest.",
      schema: { type: "string" },
    },
    {
      name: "X-Title",
      in: "header",
      required: false,
      description: "Overrides the document title. May be `base64:`-encoded.",
      schema: { type: "string" },
    },
    {
      name: "X-Filename",
      in: "header",
      required: false,
      description: "Filename for the raw-body form, where none is otherwise available.",
      schema: { type: "string" },
    },
  ];

  const errorSchema = {
    type: "object",
    required: ["error", "code", "retryable", "errorId"],
    properties: {
      error: { type: "string" },
      code: { type: "string" },
      retryable: {
        type: "boolean",
        description: "Whether repeating the identical request can succeed.",
      },
      errorId: {
        type: "string",
        description: "Correlation id; the full message is in the service log under it.",
      },
      detail: {
        type: "string",
        description: "Only present when EXPOSE_ERROR_DETAIL is enabled.",
      },
    },
  };

  const paths: Record<string, unknown> = {
    "/health": {
      get: {
        summary: "Liveness and dependency state",
        description:
          "503 when the poppler binaries or the vision endpoint are unavailable. Search being " +
          "unreachable is reported but not fatal, because it only degrades /v1/ingest. " +
          "`?deep=1` forces a re-probe instead of using the cached result.",
        security: [],
        parameters: [
          { name: "deep", in: "query", required: false, schema: { type: "boolean" } },
        ],
        responses: {
          "200": { description: "Healthy" },
          "503": { description: "A required dependency is unavailable" },
        },
      },
    },
    "/metrics": {
      get: {
        summary: "Prometheus metrics",
        description:
          "Includes conversion-specific series: pages, vision requests, token spend, " +
          "truncations, figure counts and queue depth.",
        responses: {
          "200": {
            description: "Prometheus text exposition",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/v1/convert": {
      post: {
        summary: "Convert a document to canonical Markdown",
        description:
          "The response mode is selected by request headers.\n\n" +
          "- `X-Callback-URL` present: 202 immediately, the result is POSTed to the callback.\n" +
          "- `Accept: text/event-stream`: pages stream in reading order as they complete.\n" +
          "- otherwise: one response at the end, JSON by default, Markdown for " +
          "`Accept: text/markdown`.\n\n" +
          `Output conforms to \`${EXTRACT_CONTRACT_ID}\`; see packages/extract-contract.`,
        parameters: [
          ...commonHeaders,
          {
            name: "X-Include-Figure-Data",
            in: "header",
            required: false,
            description:
              "Embed figure crops as base64 in the JSON response. Off by default: a document " +
              "with many figures produces a multi-megabyte body.",
            schema: { type: "boolean", default: false },
          },
          {
            name: "X-Callback-URL",
            in: "header",
            required: false,
            description:
              "Switches to asynchronous delivery. Restricted by CALLBACK_ALLOWED_HOSTS; " +
              "link-local and metadata addresses are always refused.",
            schema: { type: "string", format: "uri" },
          },
        ],
        requestBody: uploadRequestBody,
        responses: {
          "200": {
            description: "Conversion complete",
            headers: {
              "X-Extract-Contract": { schema: { type: "string" }, description: "Contract id" },
              "X-Page-Count": { schema: { type: "integer" } },
              "X-Figure-Count": { schema: { type: "integer" } },
              "X-Extract-Warnings": { schema: { type: "integer" } },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ConvertResponse" } },
              "text/markdown": { schema: { type: "string" } },
              "text/event-stream": { schema: { type: "string" } },
            },
          },
          "202": {
            description: "Accepted for asynchronous conversion",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    job_id: { type: "string" },
                    reference: { type: "string" },
                    callback_url: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { description: "Malformed request", content: { "application/json": { schema: errorSchema } } },
          "401": { description: "Unauthenticated" },
          "403": { description: "Missing the extract.convert scope" },
          "413": { description: "Upload exceeds MAX_UPLOAD_BYTES" },
          "415": { description: "Unsupported or mismatched file type", content: { "application/json": { schema: errorSchema } } },
          "422": { description: "Document exceeds MAX_PAGES" },
          "502": { description: "The vision endpoint failed", content: { "application/json": { schema: errorSchema } } },
          "503": { description: "The conversion queue is full" },
        },
      },
    },
  };

  if (options.ingestEnabled) {
    paths["/v1/ingest"] = {
      post: {
        summary: "Convert a document and index it in Search",
        description:
          "Ingest happens before the figure crops are stored, because Search resolves the " +
          "owning document for every asset. A crop that fails to store does not fail the " +
          "ingest: the document is indexed and its figure descriptions are retrievable, only " +
          "the image is missing.\n\n" +
          "`X-Allowed-Users` and `X-Allowed-Groups` may only *narrow* the caller's own " +
          "identity; they cannot widen it.",
        parameters: [
          {
            name: "X-Reference",
            in: "header",
            required: true,
            description: "Row key in Search. Required, so two uploads named the same do not collide.",
            schema: { type: "string" },
          },
          ...commonHeaders.slice(1),
          { name: "X-Collection", in: "header", required: false, schema: { type: "string" } },
          { name: "X-Source", in: "header", required: false, schema: { type: "string" } },
          { name: "X-Link", in: "header", required: false, schema: { type: "string" } },
          { name: "X-Tags", in: "header", required: false, schema: { type: "string" } },
          { name: "X-Allowed-Users", in: "header", required: false, schema: { type: "string" } },
          { name: "X-Allowed-Groups", in: "header", required: false, schema: { type: "string" } },
          { name: "X-Version", in: "header", required: false, schema: { type: "string" } },
          { name: "X-Valid-From", in: "header", required: false, description: "RFC 3339 validity start; timezone is required and the value is forwarded to Search.", schema: { type: "string", format: "date-time" } },
          {
            name: "X-Version-Mode",
            in: "header",
            required: false,
            schema: { type: "string", enum: ["replace", "version"] },
          },
          { name: "X-Metadata", in: "header", required: false, schema: { type: "string" } },
          { name: "X-Fts-Language", in: "header", required: false, schema: { type: "string" } },
          { name: "X-Chunk-Size", in: "header", required: false, schema: { type: "integer" } },
          { name: "X-Chunk-Overlap", in: "header", required: false, schema: { type: "integer" } },
          { name: "X-Semantic-Chunking", in: "header", required: false, schema: { type: "boolean" } },
        ],
        requestBody: uploadRequestBody,
        responses: {
          "200": {
            description: "Converted and indexed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    reference: { type: "string" },
                    collection: { type: "string" },
                    contract: { type: "string" },
                    page_count: { type: "integer" },
                    figure_count: { type: "integer" },
                    assets_stored: { type: "integer" },
                    assets_failed: { type: "integer" },
                    warnings: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          "400": { description: "Malformed request, or X-Reference missing" },
          "401": { description: "Unauthenticated" },
          "403": { description: "Missing the extract.ingest scope" },
          "502": { description: "Search rejected the ingest" },
          "503": { description: "The conversion queue is full" },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "ATF Extract",
      version: EXTRACT_CONTRACT_VERSION,
      summary: "Document-to-Markdown extraction against the atf-extract contract",
      description:
        "Converts PDF, DOCX, XLSX, PNG, JPEG and GIF into the canonical Markdown defined by " +
        `\`${EXTRACT_CONTRACT_ID}\`: \`## Seite N\` page markers, \`<figure id bbox page>\` ` +
        "entries with normalised geometry, per-page `<summary>` blocks, and HTML tables that " +
        "preserve merged cells.\n\n" +
        "Each page is rendered and passed to a vision model together with its text layer. The " +
        "text layer is authoritative for wording; the rendered page is authoritative for " +
        "structure.",
      license: { name: "Elastic-2.0" },
    },
    servers: [{ url: options.serverUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Static API_TOKEN or an OIDC JWT, depending on AUTHN_MODE. Browser sessions are " +
            "not API credentials; the UI uses the /ui/* boundary with a cookie.",
        },
      },
      schemas: {
        BoundingBox: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: { type: "number" },
          description:
            "[x1, y1, x2, y2] normalised to [0,1], origin top-left. Normalised rather than " +
            "pixels so geometry survives re-rendering the page at a different DPI.",
        },
        Figure: {
          type: "object",
          required: ["id", "page", "description", "bbox", "assetId", "mimeType"],
          properties: {
            id: {
              type: "string",
              description: "Document-unique, `p<page>-f<ordinal>`.",
              examples: ["p3-f1"],
            },
            page: { type: "integer", minimum: 1 },
            description: {
              type: "string",
              description: "Self-contained prose; the only retrievable text for the figure.",
            },
            bbox: { $ref: "#/components/schemas/BoundingBox" },
            assetId: {
              type: "string",
              description: "sha256(reference \\n id) — the id Search stores the crop under.",
            },
            mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
            bytes: { type: "integer" },
            checksum: { type: "string" },
            dataBase64: {
              type: "string",
              description: "Only present when X-Include-Figure-Data is set.",
            },
          },
        },
        Page: {
          type: "object",
          required: ["page", "markdown", "figures", "warnings"],
          properties: {
            page: { type: "integer", minimum: 1 },
            markdown: {
              type: "string",
              description: "Body only; the page marker is added by the serializer.",
            },
            summary: { type: "string" },
            figures: { type: "array", items: { $ref: "#/components/schemas/Figure" } },
            warnings: { type: "array", items: { type: "string" } },
          },
        },
        ConvertResponse: {
          type: "object",
          required: ["contract", "reference", "source", "pipeline", "pageCount", "pages", "markdown"],
          properties: {
            contract: { type: "string", examples: [EXTRACT_CONTRACT_ID] },
            reference: { type: "string" },
            title: { type: "string" },
            language: { type: "string" },
            source: {
              type: "object",
              required: ["filename", "mimeType", "bytes", "sha256"],
              properties: {
                filename: { type: "string" },
                mimeType: { type: "string" },
                bytes: { type: "integer" },
                sha256: {
                  type: "string",
                  description: "Checksum of the uploaded bytes; the only proof two ingests match.",
                },
              },
            },
            pipeline: {
              type: "object",
              required: ["extractor", "ocr"],
              properties: {
                extractor: { type: "string", examples: ["poppler", "libreoffice+poppler", "sharp"] },
                renderer: { type: "string" },
                visionModel: { type: "string" },
                ocr: {
                  type: "boolean",
                  description:
                    "True when at least one page had no text layer, so its text came from the image.",
                },
                dpi: { type: "integer" },
              },
            },
            pageCount: { type: "integer" },
            pageLabel: { type: "string", enum: ["Seite", "Page"] },
            pages: { type: "array", items: { $ref: "#/components/schemas/Page" } },
            markdown: { type: "string", description: "The serialized canonical document." },
            warnings: { type: "array", items: { type: "string" } },
          },
        },
        Error: errorSchema,
      },
    },
    paths,
  };
}
