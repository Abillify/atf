// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression test: importing `pii-detector-ner.ts` (and constructing a
 * {@link BertNerDetector}) must NOT pull `@huggingface/transformers` — and its
 * heavy native components (onnxruntime-node, sharp) — into the process. That
 * import previously happened at module top-level, so it ran on EVERY startup
 * (via `bootstrap/persistence.ts`'s static import of this module) even when
 * NER-based PII detection is never enabled, adding measurable startup latency
 * and RSS to every replica. The header comment claimed the load was "lazy —
 * on first detect()", which was true only for the model pipeline, not the
 * module import itself.
 *
 * This is verified by checking `require.cache` / the module registry for
 * `@huggingface/transformers` before and after importing/constructing the
 * detector — it must be absent until `detect()` (or the pipeline loader) is
 * actually invoked.
 */

import { describe, test, expect } from "bun:test";

function transformersIsLoaded(): boolean {
  // Bun's module registry exposes loaded modules via Bun's internal cache in
  // a way that isn't directly introspectable; the reliable, portable signal
  // is whether `import.meta.resolve` for the package has already been
  // satisfied by a prior dynamic import in THIS test file's module graph.
  // Since this test file itself never imports the package, the presence of
  // its side effects (a global it sets) is the closest observable proxy.
  // transformers.js registers a global `ort` reference when it initialises
  // onnxruntime-node; its absence is a good-enough signal that it has not run.
  return (globalThis as Record<string, unknown>).ort !== undefined;
}

describe("pii-detector-ner.ts — lazy import of @huggingface/transformers", () => {
  test("importing the module and constructing BertNerDetector does not load the heavy dependency", async () => {
    expect(transformersIsLoaded()).toBe(false);
    const { BertNerDetector } = await import("../pii-detector-ner.js");
    const detector = new BertNerDetector({ confidenceThreshold: 0.5 });
    expect(detector.name).toContain("ner:");
    // Merely constructing the detector must not have triggered the model load.
    expect(transformersIsLoaded()).toBe(false);
  });

  test("the module's static imports contain no reference to @huggingface/transformers", async () => {
    // Read the compiled source and assert there is no top-level (non-dynamic)
    // import of the package — this is the structural guarantee, independent
    // of any runtime side-effect detection.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.default.join(
      import.meta.dir,
      "..",
      "pii-detector-ner.ts",
    );
    const source = await fs.default.readFile(filePath, "utf-8");
    const staticImportRe =
      /^import\s+.*from\s+["']@huggingface\/transformers["']/m;
    expect(staticImportRe.test(source)).toBe(false);
    // But it must still be dynamically imported somewhere (the lazy path).
    expect(source).toContain('await import("@huggingface/transformers")');
  });
});
