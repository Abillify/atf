// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/ocr.ts
 *
 * The optional Tesseract OCR fallback.
 *
 * ## What it is for
 *
 * A scanned page — a page with no text layer — normally gets its text from the
 * vision model. When the model is down, the page used to fail and wait for a
 * retry; with `OCR_FALLBACK=tesseract` the runner recognises the rendered page
 * image with Tesseract instead, so a VLM outage degrades to searchable OCR text
 * with a warning on the page rather than missing content.
 *
 * ## Why a fallback and not a replacement
 *
 * Tesseract is a deliberately weak second engine: no layout understanding, no
 * figures, no Markdown structure. It exists only so that an outage of the
 * expensive engine does not mean content loss; the page record carries the
 * warning the requirement asks for, so a consumer can tell OCR text from model
 * text. The default is `off` — a deployment that has not installed the binary
 * and its traineddata behaves exactly as before.
 *
 * ## Execution
 *
 * The spawn goes through {@link run} like every other converter binary, so
 * `CONVERTER_MODE=isolated` routes it to the sidecar and the `SUBPROCESS_*`
 * ceilings (timeout, and prlimit on Linux) apply. Tesseract reads the page PNG
 * and writes `<output>.txt` next to it; the text is read back and the temp
 * files removed. A failure of the binary (missing, crashed, timeout) throws —
 * the caller keeps the original vision failure, which is the honest error to
 * surface when even the fallback did not work.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversionFailed } from "../errors.js";
import { run } from "./exec.js";

/**
 * Wall-clock ceiling on one Tesseract invocation. Deliberately independent of
 * `SUBPROCESS_TIMEOUT_MS`: that ceiling is tuned for poppler/LibreOffice, and a
 * fallback that runs *while the service is already degraded* should give up
 * sooner than a primary conversion — the page keeps its vision failure anyway.
 */
export const OCR_TIMEOUT_MS = 60_000;

/**
 * The largest page image Tesseract is handed. A rendered page at RENDER_DPI is
 * a few MiB; anything far past this is not a page, and feeding it to an OCR
 * binary during an outage is exactly the behaviour a hardening task removes.
 */
export const OCR_MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export interface OcrConfig {
  /** OCR_FALLBACK — the switch; `off` disables the client entirely. */
  ocrFallback: "off" | "tesseract";
  /** TESSERACT_BIN — binary name or absolute path. */
  tesseractBin: string;
  /** OCR_LANG — Tesseract language spec, e.g. `deu` or `deu+eng`. */
  ocrLang: string;
}

export interface OcrClient {
  /** True when `OCR_FALLBACK=tesseract` is configured. */
  readonly enabled: boolean;
  /**
   * Recognise the text of one page image (PNG bytes). Rejects with an
   * `ExtractError` when the binary is missing or fails; the caller decides
   * whether the page keeps its vision failure instead.
   */
  recognize(
    image: Uint8Array,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<string>;
}

/**
 * Build the OCR client from the config. A `off` config returns a disabled
 * client whose `recognize` always rejects — callers gate on `enabled`, and the
 * disabled object keeps the call sites free of null checks.
 */
export function createOcrClient(config: OcrConfig): OcrClient {
  const enabled = config.ocrFallback === "tesseract";
  return {
    enabled,
    async recognize(image, options = {}) {
      if (!enabled) {
        throw conversionFailed("the OCR fallback is disabled (OCR_FALLBACK=off)");
      }
      if (image.byteLength > OCR_MAX_IMAGE_BYTES) {
        throw conversionFailed(
          `the page image is ${image.byteLength} bytes, above the ${OCR_MAX_IMAGE_BYTES} byte OCR limit`,
        );
      }
      // Tesseract needs files: it reads an image path and writes
      // `<output-base>.txt`. A private temp dir per call keeps concurrent
      // pages apart and matches the converter convention (HOME/TMPDIR inside
      // the scratch dir, minimal environment).
      const scratchRoot = tmpdir();
      const workDir = await mkdtemp(join(scratchRoot, "ocr-"));
      try {
        const imagePath = join(workDir, "page.png");
        const outputPath = join(workDir, "text");
        await writeFile(imagePath, image);
        await run(
          config.tesseractBin,
          [imagePath, outputPath, "-l", config.ocrLang, "--psm", "3"],
          workDir,
          {
            timeoutMs: OCR_TIMEOUT_MS,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          },
        );
        const text = await readFile(`${outputPath}.txt`, "utf8");
        return text.trim();
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
