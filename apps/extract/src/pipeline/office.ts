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
  const isHtml = source.extension === ".html" || source.extension === ".htm";
  await writeFile(inputPath, isHtml ? neutralizeHtmlReferences(source.buffer) : source.buffer);

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

/** Attributes whose value LibreOffice may resolve as a resource to load. */
const URL_ATTRIBUTES = new Set([
  "src", "srcset", "href", "background", "poster", "data", "action", "formaction",
  "xlink:href", "lowsrc", "dynsrc", "longdesc", "codebase", "archive", "profile",
  "manifest", "usemap", "cite", "ping",
]);

/** Elements that only exist to embed or load something else; dropped whole. */
const EMBEDDING_ELEMENTS = /^(script|iframe|frame|frameset|object|embed|applet|link|base|portal|noscript)$/;

/**
 * Remove every reference in an HTML page that LibreOffice could follow while
 * laying it out.
 *
 * LibreOffice's HTML import loads linked images, frames and stylesheets —
 * `http(s)://` as well as `file://`. On a server that is a request forgery
 * (the page decides which internal URL Extract calls) and a local file read
 * (a `file:///etc/…` image or frame lands in the PDF). So before the page
 * reaches LibreOffice:
 *
 *  - script/frame/object/embed/link/base elements are dropped, and so is a
 *    `<meta http-equiv>` (a refresh is a redirect);
 *  - every URL-bearing attribute is removed, except a link target on `<a>`
 *    (never fetched, kept as the document's link) and a `data:` image;
 *  - CSS `url(…)` and `@import` are neutralised, in `<style>` and `style=`.
 *
 * External images therefore do not appear; inline `data:` images do. The
 * rewrite is byte-preserving outside the touched markup (latin1 round trip),
 * so a page in any charset keeps its text.
 */
export function neutralizeHtmlReferences(source: Uint8Array): Uint8Array {
  const html = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("latin1");
  const cssSafe = (css: string): string =>
    css
      .replace(/@import[^;]*;?/gi, "")
      .replace(/url\(\s*(['"]?)(?!data:)[^)]*\)/gi, "none");

  let out = html
    // Whole embedding elements, with their content.
    .replace(/<(script|iframe|object|applet|noscript|frameset)\b[\s\S]*?<\/\1\s*>/gi, "")
    // Style blocks keep their rules, minus anything that loads.
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m, open: string, css: string, close: string) =>
      open + cssSafe(css) + close,
    );

  out = out.replace(/<([a-zA-Z][\w:-]*)(\s[^>]*)?>/g, (tag: string, name: string, attrs: string | undefined) => {
    const lower = name.toLowerCase();
    if (EMBEDDING_ELEMENTS.test(lower)) return "";
    if (lower === "meta" && /http-equiv/i.test(attrs ?? "")) return "";
    if (attrs === undefined) return tag;
    const cleaned = attrs.replace(
      /\s([\w:-]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g,
      (attr: string, attrName: string, _eq: string | undefined, rawValue: string | undefined) => {
        const key = attrName.toLowerCase();
        const value = (rawValue ?? "").replace(/^["']|["']$/g, "").trim();
        if (key === "style") return ` style="${cssSafe(value).replace(/"/g, "&quot;")}"`;
        if (!URL_ATTRIBUTES.has(key)) return attr;
        if (lower === "a" && key === "href") return attr;
        if ((key === "src" || key === "srcset") && /^data:image\//i.test(value)) return attr;
        return "";
      },
    );
    return `<${name}${cleaned}>`;
  });
  return Buffer.from(out, "latin1");
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
