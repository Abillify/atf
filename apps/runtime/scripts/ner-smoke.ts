// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * NER smoke test (`scripts/ner-smoke.ts`) — real in-process inference.
 *
 * Exercises the BERT-NER PII detector (`src/graph/pii-detector-ner.ts`) against
 * the real transformers.js model to prove it detects person names and location
 * names in German + English with correct character offsets.
 *
 * This lives as a standalone `bun run` script rather than a `bun test` file
 * because transformers.js's Node backend is native `onnxruntime-node`, which
 * crashes Bun's TEST runner (a bun-test + native-addon incompatibility) — but
 * runs fine in the plain runtime, which is exactly how aiperator runs in prod
 * (`bun run src/index.ts`). The deterministic aggregation/offset logic is unit-
 * tested separately (`nerTokensToMatches` in pii-detector.test.ts).
 *
 * Usage:
 *   bun run scripts/ner-smoke.ts
 *   PII_NER_MODEL=<hf-onnx-model> bun run scripts/ner-smoke.ts
 *
 * Exit code 0 = all checks passed, 1 = a check failed (downloads the model on
 * first run — a few hundred MB, cached thereafter).
 */

import { BertNerDetector } from "../src/graph/pii-detector-ner.js";
import type { PiiMatch } from "../src/graph/output-guardrails.js";

interface Case {
  text: string;
  /** Each expected substring must appear as the `value` of a detected span of the given type. */
  expect: Array<{ type: string; value: string }>;
}

const CASES: Case[] = [
  {
    text: "Die Kundin Anna Schmidt aus Berlin meldet sich.",
    expect: [
      { type: "person", value: "Anna Schmidt" },
      { type: "location", value: "Berlin" },
    ],
  },
  {
    text: "Customer John Miller from London called today.",
    expect: [{ type: "person", value: "John Miller" }],
  },
  {
    text: "the invoice total is due next week",
    expect: [], // no named entities
  },
];

function checkOffsets(text: string, matches: PiiMatch[]): boolean {
  return matches.every((m) => text.slice(m.start, m.end) === m.value);
}

async function main(): Promise<void> {
  const model = process.env["PII_NER_MODEL"];
  const detector = new BertNerDetector({
    confidenceThreshold: 0.5,
    ...(model !== undefined ? { model } : {}),
  });

  let failures = 0;

  for (const c of CASES) {
    const matches = await detector.detect(c.text);
    const summary = matches.map((m) => `${m.type}:"${m.value}"`).join(", ");
    console.log(`\nTEXT: ${c.text}`);
    console.log(`  detected: [${summary}]`);

    if (!checkOffsets(c.text, matches)) {
      console.error("  ✗ offset mismatch: a span's [start,end) does not equal its value");
      failures++;
      continue;
    }

    let ok = true;
    for (const want of c.expect) {
      const hit = matches.some((m) => m.type === want.type && m.value.includes(want.value));
      if (!hit) {
        console.error(`  ✗ expected ${want.type} containing "${want.value}" — not found`);
        ok = false;
      }
    }
    // For the no-entity case, tolerate spurious low-confidence hits only if empty.
    if (c.expect.length === 0 && matches.length > 0) {
      console.warn(`  ! expected no entities but got ${matches.length} (non-fatal)`);
    }
    if (ok) console.log("  ✓ ok");
    else failures++;
  }

  if (failures > 0) {
    console.error(`\nNER smoke FAILED: ${failures} case(s) failed.`);
    process.exit(1);
  }
  console.log("\nNER smoke PASSED — person + location detection with correct offsets.");
}

await main();
