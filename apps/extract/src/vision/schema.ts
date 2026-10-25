// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * schema.ts
 *
 * Structured-output schemas for `response_format: json_schema` (task 7.9,
 *
 * ## Why a schema *and* the tag parser, not one instead of the other
 *
 * The tag grammar (`<summary>` / `<figures>` / `<markdown>`) is tolerant: a
 * model that mis-nests a tag still yields usable figures. A JSON schema is
 * exact: a conforming response needs no repair heuristics at all. But schema
 * enforcement is a provider capability — vLLM with structured outputs has it,
 * older llama.cpp servers reject the field outright. So the schema rides on a
 * capability flag (`VISION_SUPPORTS_JSON_SCHEMA`, fail-closed) and the tag
 * parser stays as the fallback for both the transport (provider rejects the
 * field) and the payload (response is not conforming JSON).
 *
 * ## The conversion, which is the whole trick
 *
 * A conforming structured page response is re-rendered into the tag format by
 * {@link pageJsonToTagText} and handed to the *existing* `parseVisionPage`.
 * That keeps every downstream concern — placeholder rewriting, figure
 * renumbering, table continuation detection, warning collection — exactly
 * where it is instead of forking a second consumption path for structured
 * responses. The schema changes the transport, not the pipeline.
 *
 * Pass 2 needs no conversion at all: its parsers in `response.ts` already
 * expect a JSON object, so a schema-conforming response flows straight into
 * `parseTranscription`.
 *
 * ## Why `strict: false`
 *
 * OpenAI's strict mode additionally requires every property to be required and
 * `additionalProperties: false`; the schemas here deliberately keep optional
 * fields (a figure without a caption is normal), so strict mode would reject
 * them. vLLM enforces the schema through guided decoding regardless of the
 * flag. The capability flag is operator-set, so the operator states whether the
 * backend understands `json_schema`; `strict: false` keeps the request shape
 * acceptable to both enforcement styles.
 */

import { z } from "zod";
import {
  dataTranscriptionSchema,
  drawingTranscriptionSchema,
  fieldsTranscriptionSchema,
  figureKindSchema,
  processTranscriptionSchema,
} from "@atf/extract-contract/v2";

/**
 * One figure as the structured Pass-1 output reports it. Mirrors the tag
 * grammar's attributes: `id` is the model's own ordinal (stringified numbers
 * are accepted because models alternate between `1` and `"1"`), `description`
 * is the 2–3 sentence summary the prompt asks for.
 */
export const pageFigureSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  kind: z.enum(figureKindSchema.options).optional(),
  caption: z.string().optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  description: z.string(),
});

/**
 * The Pass-1 page output. `figures` defaults to an empty array so a model that
 * omits it on a figure-free page — instead of writing `[]` — still validates.
 */
export const pageExtractionSchema = z.object({
  summary: z.string().optional(),
  figures: z.array(pageFigureSchema).default([]),
  markdown: z.string(),
});

export type PageExtraction = z.infer<typeof pageExtractionSchema>;

/** A `response_format` request member, shaped per the OpenAI spec. */
export type ResponseFormat = Record<string, unknown>;

function responseFormat(name: string, schema: z.ZodType): ResponseFormat {
  return {
    type: "json_schema",
    json_schema: { name, strict: false, schema: z.toJSONSchema(schema) },
  };
}

/** Sent with every Pass-1 page request while the capability flag is on. */
export const PAGE_RESPONSE_FORMAT: ResponseFormat = responseFormat(
  "page_extraction",
  pageExtractionSchema,
);

/**
 * Per-kind Pass-2 response formats, precomputed so the JSON Schema conversion
 * happens once per process rather than once per figure. Kinds without an entry
 * (photo, diagram, other) have no structured transcription and are sent
 * unstructured — the same set the per-kind system prompts cover.
 */
const PASS2_RESPONSE_FORMATS: Record<string, ResponseFormat> = {
  bpmn: responseFormat("process_transcription", processTranscriptionSchema),
  flowchart: responseFormat("process_transcription", processTranscriptionSchema),
  ui_mask: responseFormat("fields_transcription", fieldsTranscriptionSchema),
  technical_drawing: responseFormat("drawing_transcription", drawingTranscriptionSchema),
  chart: responseFormat("data_transcription", dataTranscriptionSchema),
  table_image: responseFormat("data_transcription", dataTranscriptionSchema),
};

/** The response format for a Pass-2 kind, or `undefined` when it has none. */
export function pass2ResponseFormat(kind: string): ResponseFormat | undefined {
  return PASS2_RESPONSE_FORMATS[kind];
}

/** Models wrap JSON in a code fence often enough that unwrapping pays. */
const JSON_FENCE = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i;

/**
 * Parse a structured Pass-1 response. Returns `null` for anything that is not
 * schema-conforming JSON — the caller then hands the raw text to the tag
 * parser unchanged, which is the requirement's "fall back to the existing
 * parser" at the payload level.
 */
export function parsePageJson(raw: string): PageExtraction | null {
  const fenced = JSON_FENCE.exec(raw);
  const text = fenced?.[1] ?? raw;
  try {
    const parsed = pageExtractionSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Attribute values are double-quoted by the tag grammar; inner quotes break it. */
function escapeAttribute(value: string): string {
  return value.replace(/"/g, "'");
}

/**
 * Re-render a schema-conforming page as the tag format `parseVisionPage`
 * already consumes. The figure attributes match what the prompt asks the model
 * to emit (`id`, `kind`, `bbox`, `caption`), so the contract's attribute
 * parsers pick them up without knowing the text was reconstructed.
 */
export function pageJsonToTagText(page: PageExtraction): string {
  const parts: string[] = [];
  const summary = page.summary?.trim();
  if (summary !== undefined && summary !== "") {
    parts.push(`<summary>${summary}</summary>`);
  }
  const figures = page.figures.map((figure, index) => {
    const id = figure.id !== undefined ? String(figure.id).trim() : String(index + 1);
    const kind = figure.kind !== undefined ? ` kind="${figure.kind}"` : "";
    const bbox =
      figure.bbox !== undefined ? ` bbox="[${figure.bbox.join(", ")}]"` : "";
    const caption =
      figure.caption !== undefined && figure.caption.trim() !== ""
        ? ` caption="${escapeAttribute(figure.caption.trim())}"`
        : "";
    return `<figure id="${escapeAttribute(id)}"${kind}${bbox}${caption}>${figure.description}</figure>`;
  });
  // An empty block is what the parser's "None" tolerance already handles.
  parts.push(`<figures>${figures.join("\n")}</figures>`);
  parts.push(`<markdown>${page.markdown}</markdown>`);
  return parts.join("\n\n");
}
