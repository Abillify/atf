// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * office.ts
 *
 * DOCX and XLSX to PDF, via headless LibreOffice.
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

/** Extension LibreOffice needs to pick the right import filter. */
export function officeExtensionFor(kind: "word" | "spreadsheet"): string {
  return kind === "word" ? ".docx" : ".xlsx";
}
