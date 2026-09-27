// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * office.ts
 *
 * Word and spreadsheet documents to PDF, via headless LibreOffice.
 *
 * Why convert at all instead of parsing OOXML directly: a Word document has no
 * pages until something lays it out. A library like `mammoth` returns the whole
 * document as one unpaginated block, which means no page numbers, no page
 * images, and therefore no citable retrieval and no figure geometry. Routing
 * through PDF buys pagination that matches what a human sees when they open the
 * file, at the cost of a heavyweight dependency. For a spreadsheet the argument
 * is stronger still: the visual grid, merged cells and column widths *are* the
 * information, and only a layout engine knows where the page breaks fall.
 *
 * LibreOffice is the least pleasant part of this service, and two of its
 * behaviours have to be worked around explicitly:
 *
 *  1. **It is not concurrency-safe with a shared user profile.** Two
 *     simultaneous invocations sharing `$HOME` race on the profile lock and one
 *     fails, or worse, hangs. Every invocation therefore gets a private
 *     `-env:UserInstallation` directory. This is the single most common cause of
 *     "conversion works alone, fails under load".
 *
 *  2. **It reports success while producing nothing.** A non-zero exit is not
 *     guaranteed on failure, so the output file's existence is checked
 *     explicitly rather than inferred from the exit code.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SupportedFormat } from "../formats.js";
import { conversionFailed } from "../errors.js";
import { run, type RunOptions } from "./exec.js";

export interface OfficeConverterOptions {
  /** LIBREOFFICE_BIN. */
  binary: string;
  /** Writable scratch root. */
  workDir: string;
}

/**
 * Convert an office document to PDF and return the path of the result.
 *
 * The input keeps its original extension because LibreOffice selects its import
 * filter from it; handing it an extensionless temporary file makes it guess, and
 * it guesses wrong on XLSX.
 */
export async function convertToPdf(
  source: { buffer: Uint8Array; extension: string },
  options: OfficeConverterOptions & RunOptions,
): Promise<string> {
  const { binary, workDir } = options;
  const inputDir = join(workDir, "office-in");
  const outputDir = join(workDir, "office-out");
  // A private profile per invocation. LibreOffice locks it, so sharing one
  // across concurrent conversions is what makes them fail intermittently.
  const profileDir = join(workDir, `lo-profile-${randomUUID()}`);
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  // The filename is generated, never taken from the upload: it reaches a process
  // boundary and ends up in an output path.
  const inputPath = join(inputDir, `source${source.extension}`);
  await writeFile(inputPath, source.buffer);

  await run(
    binary,
    [
      "--headless",
      "--norestore",
      "--invisible",
      "--nolockcheck",
      "--nodefault",
      "--nofirststartwizard",
      `-env:UserInstallation=file://${profileDir}`,
      "--convert-to",
      "pdf",
      "--outdir",
      outputDir,
      inputPath,
    ],
    // HOME is the private profile directory, so nothing is shared between runs.
    profileDir,
    options,
  );

  // Exit code 0 does not imply output, so look for the file.
  const produced = (await readdir(outputDir)).filter((name) => name.toLowerCase().endsWith(".pdf"));
  const first = produced[0];
  if (first === undefined) {
    throw conversionFailed(
      "LibreOffice reported success but produced no PDF. The document is most likely " +
        "password-protected or corrupt.",
      { extension: source.extension },
    );
  }
  return join(outputDir, first);
}

/** The source kinds LibreOffice lays out to PDF before the normal PDF path. */
const LIBREOFFICE_KINDS = new Set<SupportedFormat["kind"]>([
  "word",
  "spreadsheet",
  "presentation",
  "visio",
]);

/** True when a format is converted to PDF by LibreOffice (design §10.4). */
export function isLibreOfficeKind(format: SupportedFormat): boolean {
  return LIBREOFFICE_KINDS.has(format.kind);
}

/**
 * Extension LibreOffice needs to pick the exact import filter.
 *
 * PPTX and VSDX join Word/Excel here: LibreOffice lays each out to PDF and the
 * normal PDF pipeline takes over, so a presentation gets page images and a
 * Visio drawing gets its shape text with no bespoke renderer (design §10.4).
 */
export function officeExtensionFor(format: SupportedFormat): string {
  if (!isLibreOfficeKind(format)) {
    throw new Error(`No Office extension for ${format.label}`);
  }
  const extension = format.extensions[0];
  if (extension === undefined) throw new Error(`No extension registered for ${format.label}`);
  return extension;
}
