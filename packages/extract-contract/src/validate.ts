// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * validate.ts
 *
 * Semantic validation, on top of the structural validation the Zod schemas in
 * `document.ts` already perform.
 *
 * The distinction matters. A schema can tell you `assetId` is 64 hex
 * characters; only this file can tell you it is the *wrong* 64 hex characters
 * for its reference and figure id — which is the failure that makes Search
 * reject an asset upload with a 400 long after the extraction succeeded. Every
 * check here corresponds to a defect that is invisible in the payload but fatal
 * downstream:
 *
 *  - a duplicate figure id makes Search rename one of them, orphaning its crop;
 *  - a stale asset id makes the upload 400;
 *  - a page marker inside a page body makes Search split one page into two;
 *  - a residual `<figure>` in the body makes the figure text index twice;
 *  - a degenerate bbox produces a 1×1-pixel crop nobody notices until a user
 *    opens the figure in a result.
 *
 * Severity is a judgement about indexability, not tidiness. `error` means the
 * document would be indexed incorrectly; `warning` means it would be indexed
 * correctly but with something missing.
 */

import {
  FIGURE_ID_PATTERN,
  PAGE_MARKER_PATTERN,
  RESERVED_FIGURE_ID_PREFIX,
  globalize,
  isValidBoundingBox,
} from "./markers.js";
import { buildDocumentAssetId } from "./asset-id.js";
import { isCompatibleContract } from "./version.js";
import type { ExtractedDocument } from "./document.js";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  /** Dotted path into the document, e.g. `pages[2].figures[0].assetId`. */
  path: string;
  message: string;
  severity: ValidationSeverity;
}

export class ExtractContractError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const errors = issues.filter((issue) => issue.severity === "error");
    super(
      `Extract contract violated by ${errors.length} issue(s): ` +
        errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    );
    this.name = "ExtractContractError";
    this.issues = issues;
  }
}

/**
 * Check a structured document against the contract.
 *
 * Returns every issue rather than stopping at the first, so a producer fixing
 * an extraction bug sees the whole picture in one run.
 */
export function validateDocument(document: ExtractedDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (path: string, message: string): void => {
    issues.push({ path, message, severity: "error" });
  };
  const warn = (path: string, message: string): void => {
    issues.push({ path, message, severity: "warning" });
  };

  if (!isCompatibleContract(document.contract)) {
    error("contract", `"${document.contract}" is not a compatible atf-extract version`);
  }
  if (document.reference.trim() === "") {
    error("reference", "must be a non-empty document reference");
  }
  if (document.pages.length !== document.pageCount) {
    error(
      "pageCount",
      `declares ${document.pageCount} page(s) but carries ${document.pages.length}`,
    );
  }

  const seenPages = new Set<number>();
  const seenFigureIds = new Set<string>();

  document.pages.forEach((page, pageIndex) => {
    const at = `pages[${pageIndex}]`;

    if (seenPages.has(page.page)) {
      error(`${at}.page`, `page ${page.page} appears more than once`);
    }
    seenPages.add(page.page);

    // A page marker inside a body would make Search treat one page as two, and
    // every figure after it would be attributed to the wrong page.
    if (globalize(PAGE_MARKER_PATTERN).test(page.markdown)) {
      error(
        `${at}.markdown`,
        "contains a page marker; markers are added by the serializer, not the body",
      );
    }
    if (/<figure\b/i.test(page.markdown) || /<\/figure\s*>/i.test(page.markdown)) {
      error(`${at}.markdown`, "contains a residual <figure> element");
    }
    if (/<summary\b/i.test(page.markdown)) {
      error(`${at}.markdown`, "contains a residual <summary> element");
    }
    if (page.markdown.includes("\u0000")) {
      // PostgreSQL rejects NUL bytes, and Search sanitises them per row — but a
      // NUL here means the extractor emitted raw binary as text.
      error(`${at}.markdown`, "contains NUL bytes");
    }
    if (page.markdown.trim() === "" && page.figures.length === 0) {
      warn(`${at}.markdown`, `page ${page.page} produced neither text nor figures`);
    }

    page.figures.forEach((figure, figureIndex) => {
      const figureAt = `${at}.figures[${figureIndex}]`;

      if (!FIGURE_ID_PATTERN.test(figure.id)) {
        error(`${figureAt}.id`, `"${figure.id}" contains characters Search would rewrite`);
      }
      if (RESERVED_FIGURE_ID_PREFIX.test(figure.id)) {
        error(
          `${figureAt}.id`,
          `"${figure.id}" starts with the reserved "figure_" prefix, which Search strips`,
        );
      }
      if (seenFigureIds.has(figure.id)) {
        error(`${figureAt}.id`, `duplicate figure id "${figure.id}" within the document`);
      }
      seenFigureIds.add(figure.id);

      if (figure.page !== page.page) {
        error(
          `${figureAt}.page`,
          `claims page ${figure.page} but is attached to page ${page.page}`,
        );
      }

      const expectedAssetId = buildDocumentAssetId(document.reference, figure.id);
      if (figure.assetId !== expectedAssetId) {
        error(
          `${figureAt}.assetId`,
          "does not match sha256(reference \\n id); Search would reject the crop upload",
        );
      }

      if (!isValidBoundingBox(figure.bbox)) {
        error(
          `${figureAt}.bbox`,
          `${JSON.stringify(figure.bbox)} is not an ordered box inside [0,1] with area`,
        );
      }
      if (figure.description.trim() === "") {
        warn(
          `${figureAt}.description`,
          "is empty; the description is the only retrievable text for a figure",
        );
      }
      if (figure.checksum !== undefined && figure.bytes === 0) {
        warn(`${figureAt}.bytes`, "declares a checksum for an empty crop");
      }
    });
  });

  return issues;
}

/** True when the document carries no `error`-severity issues. */
export function isValidDocument(document: ExtractedDocument): boolean {
  return validateDocument(document).every((issue) => issue.severity !== "error");
}

/** Throw {@link ExtractContractError} when the document carries any error. */
export function assertValidDocument(document: ExtractedDocument): void {
  const issues = validateDocument(document);
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ExtractContractError(issues);
  }
}
