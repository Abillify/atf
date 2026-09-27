// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * v2/validate.ts
 *
 * Validation of a single v2 record, returning a machine-readable result rather
 * than throwing — because the primary caller is Search rejecting a bad ingest
 * batch, and Requirement 3.5 says that rejection must carry a structured issue
 * list the producer can act on.
 *
 * Two layers, same distinction as v1:
 *
 *   structural — the zod record schema. Wrong types, missing fields, an
 *                unknown record `type`.
 *   semantic   — things a schema cannot see: an asset id that does not match
 *                `sha256(reference \n localId)` and would make the upload 400;
 *                a degenerate bounding box that would crop a 1×1 pixel; a
 *                figure whose declared `page` disagrees with its record; a
 *                `document.begin` whose contract major this build cannot read.
 *
 * Semantic checks that need the document reference (asset-id verification) run
 * only when a reference is supplied, so a page record can be validated
 * standalone during streaming and cross-checked later once `document.begin` has
 * established the reference.
 */

import type { z } from "zod";
import { buildAssetId } from "../asset-id.js";
import { isCompatibleContract } from "../version.js";
import { isValidBoundingBoxTuple } from "./geometry.js";
import {
  recordSchema,
  type AssetRef,
  type Block,
  type ExtractRecord,
  type PageRecord,
} from "./records.js";

export type RecordValidationSeverity = "error" | "warning";

export interface RecordValidationIssue {
  path: string;
  message: string;
  severity: RecordValidationSeverity;
}

/** A failed validation: the (possibly partially parsed) issues. */
export interface RecordValidationFailure {
  ok: false;
  issues: RecordValidationIssue[];
}

/** A successful validation: the typed record plus any warnings. */
export interface RecordValidationSuccess {
  ok: true;
  record: ExtractRecord;
  issues: RecordValidationIssue[];
}

export type RecordValidation = RecordValidationSuccess | RecordValidationFailure;

/** Options controlling the semantic layer. */
export interface ValidateRecordOptions {
  /**
   * Document reference to verify asset ids against. When omitted, asset-id
   * checks are skipped (the reference is not yet known mid-stream).
   */
  reference?: string;
  /** Expected contract major for a `document.begin`. Defaults to the current. */
  expectedMajor?: number;
}

function zodIssues(error: z.ZodError): RecordValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
    severity: "error" as const,
  }));
}

function checkAsset(
  asset: AssetRef,
  path: string,
  reference: string,
  push: (issue: RecordValidationIssue) => void,
): void {
  const expected = buildAssetId(reference, asset.localId);
  if (asset.assetId !== expected) {
    push({
      path: `${path}.assetId`,
      message: "does not match sha256(reference \\n localId); Search would reject the upload",
      severity: "error",
    });
  }
  if (asset.bbox !== undefined && !isValidBoundingBoxTuple(asset.bbox)) {
    push({
      path: `${path}.bbox`,
      message: `${JSON.stringify(asset.bbox)} is not an ordered box inside [0,1] with area`,
      severity: "error",
    });
  }
}

function checkBlock(
  block: Block,
  pageNumber: number,
  index: number,
  reference: string | undefined,
  push: (issue: RecordValidationIssue) => void,
): void {
  const path = `blocks[${index}]`;
  if (block.page !== pageNumber) {
    push({
      path: `${path}.page`,
      message: `claims page ${block.page} but is on page ${pageNumber}`,
      severity: "error",
    });
  }
  if (block.bbox !== undefined && !isValidBoundingBoxTuple(block.bbox)) {
    push({
      path: `${path}.bbox`,
      message: `${JSON.stringify(block.bbox)} is not an ordered box inside [0,1] with area`,
      severity: "warning",
    });
  }
  if (block.type === "figure") {
    if (block.description.trim() === "") {
      push({
        path: `${path}.description`,
        message: "is empty; the description is retrievable text for a figure",
        severity: "warning",
      });
    }
    if (reference !== undefined && block.assetId !== undefined) {
      const expected = buildAssetId(reference, block.figureId);
      if (block.assetId !== expected) {
        push({
          path: `${path}.assetId`,
          message: "does not match sha256(reference \\n figureId)",
          severity: "error",
        });
      }
    }
  }
}

function checkPage(
  page: PageRecord,
  reference: string | undefined,
  push: (issue: RecordValidationIssue) => void,
): void {
  const seenBlockIds = new Set<string>();
  page.blocks.forEach((block, index) => {
    if (seenBlockIds.has(block.id)) {
      push({
        path: `blocks[${index}].id`,
        message: `duplicate block id "${block.id}" on page ${page.page}`,
        severity: "error",
      });
    }
    seenBlockIds.add(block.id);
    checkBlock(block, page.page, index, reference, push);
  });
  if (reference !== undefined) {
    page.assets.forEach((asset, index) => {
      checkAsset(asset, `assets[${index}]`, reference, push);
      if (asset.page !== undefined && asset.page !== page.page) {
        push({
          path: `assets[${index}].page`,
          message: `claims page ${asset.page} but is on page ${page.page}`,
          severity: "warning",
        });
      }
    });
  }
}

/**
 * Validate an untrusted value as a v2 record.
 *
 * Returns `{ ok: true, record, issues }` when the value is a structurally valid
 * record carrying no error-severity semantic issue (warnings are allowed), and
 * `{ ok: false, issues }` otherwise.
 */
export function validateRecord(
  value: unknown,
  options: ValidateRecordOptions = {},
): RecordValidation {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, issues: zodIssues(parsed.error) };
  }

  const record = parsed.data;
  const issues: RecordValidationIssue[] = [];
  const push = (issue: RecordValidationIssue): void => {
    issues.push(issue);
  };

  if (record.type === "document.begin") {
    if (!isCompatibleContract(record.contract, options.expectedMajor)) {
      push({
        path: "contract",
        message: `"${record.contract}" is not a compatible atf-extract version`,
        severity: "error",
      });
    }
  } else if (record.type === "page") {
    checkPage(record, options.reference, push);
  }

  if (issues.some((issue) => issue.severity === "error")) {
    return { ok: false, issues };
  }
  return { ok: true, record, issues };
}

/** True when `value` is a valid record carrying no error-severity issue. */
export function isValidRecord(value: unknown, options: ValidateRecordOptions = {}): boolean {
  return validateRecord(value, options).ok;
}
