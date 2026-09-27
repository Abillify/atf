// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/src/metadata.ts

/** Canonical, additive metadata contract. Unknown JSON-compatible keys remain valid. */
export interface Metadata {
  project_id?: string;
  case_id?: string;
  document_id?: string;
  document_type?: string;
  document_date?: string;
  version?: string;
  supersedes?: string;
  author?: string;
  recipient?: string;
  confidentiality?: string;
  page?: number;
  section?: string;
  attachment_of?: string;
  ocr_quality?: number;
  [key: string]: unknown;
}

export const CANONICAL_METADATA_FIELDS = [
  "project_id", "case_id", "document_id", "document_type", "document_date",
  "version", "supersedes", "author", "recipient", "confidentiality", "page",
  "section", "attachment_of", "ocr_quality",
] as const;
export type CanonicalMetadataField = (typeof CANONICAL_METADATA_FIELDS)[number];
const CANONICAL_FIELD_SET = new Set<string>(CANONICAL_METADATA_FIELDS);
const STRING_FIELDS = new Set<string>(CANONICAL_METADATA_FIELDS.filter((field) => field !== "page" && field !== "ocr_quality"));

export class MetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataValidationError";
  }
}

/**
 * Validate known fields while preserving every unknown key. The technical
 * version is copied into metadata.version only when no explicit domain value
 * exists; an explicit metadata.version is never overwritten.
 */
export function normalizeMetadata(
  value: unknown,
  technicalVersion?: string,
): Metadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MetadataValidationError("metadata must be a JSON object");
  }
  const metadata: Metadata = { ...(value as Record<string, unknown>) };
  for (const [key, fieldValue] of Object.entries(metadata)) {
    if (!CANONICAL_FIELD_SET.has(key) || fieldValue === undefined || fieldValue === null) continue;
    if (STRING_FIELDS.has(key)) {
      if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
        throw new MetadataValidationError(`metadata.${key} must be a non-empty string`);
      }
      if (key === "document_date") {
        const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(fieldValue);
        if (!match) throw new MetadataValidationError("metadata.document_date must be a valid ISO date or date-time");
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const calendar = new Date(Date.UTC(year, month - 1, day));
        const validCalendar = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
        const hour = match[4] === undefined ? 0 : Number(match[4]);
        const minute = match[5] === undefined ? 0 : Number(match[5]);
        const second = match[6] === undefined ? 0 : Number(match[6]);
        if (!validCalendar || hour > 23 || minute > 59 || second > 59 || Number.isNaN(Date.parse(fieldValue))) {
          throw new MetadataValidationError("metadata.document_date must be a valid ISO date or date-time");
        }
      }
    } else if (key === "page") {
      if (typeof fieldValue !== "number" || !Number.isInteger(fieldValue) || fieldValue < 1) {
        throw new MetadataValidationError("metadata.page must be a positive integer");
      }
    } else if (key === "ocr_quality") {
      if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0 || fieldValue > 1) {
        throw new MetadataValidationError("metadata.ocr_quality must be a finite number between 0 and 1");
      }
    }
  }
  if (metadata.version === undefined && technicalVersion?.trim()) {
    metadata.version = technicalVersion.trim();
  }
  return metadata;
}

export const FILTER_V2 = Symbol("search.filter_v2");

export interface FilterV2Range { gt?: string | number; gte?: string | number; lt?: string | number; lte?: string | number }
export interface FilterV2 {
  eq?: Partial<Record<CanonicalMetadataField, string | number>>;
  in?: Partial<Record<CanonicalMetadataField, Array<string | number>>>;
  range?: Partial<Record<CanonicalMetadataField, FilterV2Range>>;
}

export function normalizeFilterV2(value: unknown): FilterV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MetadataValidationError("filter_v2 must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["eq", "in", "range"].includes(key))) {
    throw new MetadataValidationError("filter_v2 supports only eq, in, and range operators");
  }
  const result: FilterV2 = {};
  for (const operator of ["eq", "in", "range"] as const) {
    const clause = raw[operator];
    if (clause === undefined) continue;
    if (typeof clause !== "object" || clause === null || Array.isArray(clause)) {
      throw new MetadataValidationError(`filter_v2.${operator} must be an object`);
    }
    const normalized: Record<string, unknown> = {};
    for (const [field, operand] of Object.entries(clause)) {
      if (!CANONICAL_FIELD_SET.has(field)) throw new MetadataValidationError(`filter_v2 field is not allowed: ${field}`);
      if (operator === "in") {
        if (!Array.isArray(operand) || operand.length === 0 || operand.some((v) => typeof v !== "string" && typeof v !== "number")) {
          throw new MetadataValidationError(`filter_v2.in.${field} must be a non-empty string/number array`);
        }
      } else if (operator === "range") {
        if (typeof operand !== "object" || operand === null || Array.isArray(operand)) throw new MetadataValidationError(`filter_v2.range.${field} must be an object`);
        const bounds = operand as Record<string, unknown>;
        if (Object.keys(bounds).length === 0 || Object.keys(bounds).some((k) => !["gt", "gte", "lt", "lte"].includes(k)) || Object.values(bounds).some((v) => typeof v !== "string" && typeof v !== "number")) {
          throw new MetadataValidationError(`filter_v2.range.${field} has invalid bounds`);
        }
      } else if (typeof operand !== "string" && typeof operand !== "number") {
        throw new MetadataValidationError(`filter_v2.eq.${field} must be a string or number`);
      }
      normalized[field] = operand;
    }
    result[operator] = normalized as never;
  }
  return result;
}

export interface ParseResult { metadata: Metadata; error?: { status: number; message: string } }

export function parseMetadataHeader(metadataHeader: string | undefined): ParseResult {
  if (!metadataHeader) return { metadata: {} };
  let jsonString = metadataHeader;
  if (jsonString.toLowerCase().startsWith("base64:")) {
    try { jsonString = Buffer.from(jsonString.slice("base64:".length), "base64").toString("utf-8"); }
    catch { return { metadata: {}, error: { status: 400, message: "Invalid base64 encoding in X-Metadata header" } }; }
  }
  try {
    return { metadata: normalizeMetadata(JSON.parse(jsonString)) };
  } catch (error) {
    const message = error instanceof MetadataValidationError ? error.message : "Invalid JSON in X-Metadata header";
    return { metadata: {}, error: { status: 400, message } };
  }
}

/**
 * Symbol key under which the v2 `/v2/search` unit-column filter is carried on a
 * {@link SearchFilter} (task 3.7, Requirement 13.3). Unlike {@link FILTER_V2}
 * (which filters the `metadata` JSONB), these predicates target the REAL indexed
 * unit columns added by task 1.8 (`unit_type`, `figure_kind`, `page_start`/
 * `page_end`, `section_path text[]`), so filtering is index-backed (design §6.2).
 * A symbol key keeps the filter out of the plain JSON `metadata @>` path and out
 * of any serialization, exactly like FILTER_V2.
 */
export const UNIT_FILTER_V2 = Symbol("search.unit_filter_v2");

/**
 * The v2 unit-level filter (Requirement 13.3). Every field is optional and
 * additive; an empty object adds no predicate. These map onto the real unit
 * columns rather than the metadata JSON:
 *  - `unitType`      → `unit_type = …`
 *  - `figureKind`    → `figure_kind = …`
 *  - `pageStart/End` → page-range OVERLAP (`page_start <= end AND page_end >= start`)
 *  - `sectionPrefix` → `section_path[1:n] = prefix` (array prefix match)
 */
export interface UnitFilterV2 {
  /** Exact `unit_type` (chunk | table | figure | section | page | document). */
  unitType?: string;
  /** Exact `figure_kind`. */
  figureKind?: string;
  /** Inclusive first page of the requested range. */
  pageStart?: number;
  /** Inclusive last page of the requested range. */
  pageEnd?: number;
  /** Section-path prefix; matches units whose `section_path` starts with it. */
  sectionPrefix?: string[];
}

/** True when a UnitFilterV2 carries at least one active predicate. */
export function unitFilterV2HasPredicates(f: UnitFilterV2 | undefined): boolean {
  if (!f) return false;
  return (
    f.unitType !== undefined ||
    f.figureKind !== undefined ||
    f.pageStart !== undefined ||
    f.pageEnd !== undefined ||
    (Array.isArray(f.sectionPrefix) && f.sectionPrefix.length > 0)
  );
}

export function encodeBase64(input: string): string { return Buffer.from(input, "utf-8").toString("base64"); }
export function decodeBase64(encoded: string): string { return Buffer.from(encoded, "base64").toString("utf-8"); }
