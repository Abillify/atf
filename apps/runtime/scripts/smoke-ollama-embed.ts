// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Live smoke test for the Ollama → @ai-sdk/openai (/v1) migration.
 *
 * This Ollama instance only hosts embedding models (bge-m3), so we exercise the
 * embedding path: createEmbeddingProvider("ollama", …) → openai.embedding via
 * the normalised {host}/v1 base URL. Proves the provider swap + URL handling
 * works against a real Ollama OpenAI-compatible endpoint.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://host:11434 SMOKE_EMBED_MODEL=bge-m3 \
 *     bun run scripts/smoke-ollama-embed.ts
 */
import { embed } from "ai";
import { createEmbeddingProvider } from "../src/graph/llm-factory.js";
import type { AppConfig } from "../src/config/index.js";

const baseUrl = process.env.OLLAMA_BASE_URL;
if (!baseUrl) {
  console.error("✗ OLLAMA_BASE_URL not set.");
  process.exit(1);
}
const modelId = process.env.SMOKE_EMBED_MODEL ?? "bge-m3";

const appConfig = { ollamaBaseUrl: baseUrl } as unknown as AppConfig;

console.log(`▶ Ollama embedding smoke test: ${modelId} @ ${baseUrl}`);

const model = createEmbeddingProvider(
  { provider: "ollama", model: modelId },
  appConfig,
);

let err: string | undefined;
let dims = 0;
let finite = false;
let nonZero = false;

try {
  const { embedding } = await embed({
    model,
    value: "Hallo Welt, dies ist ein Test.",
  });
  dims = embedding.length;
  finite = embedding.every((n) => Number.isFinite(n));
  nonZero = embedding.some((n) => n !== 0);
} catch (e) {
  err = e instanceof Error ? e.message : String(e);
}

console.log("\n── Results ──────────────────────────────");
console.log(`vector dimensions:  ${dims}`);
console.log(`all finite numbers: ${finite}`);
console.log(`has non-zero values:${nonZero}`);
if (err) console.log(`error:              ${err}`);
console.log("─────────────────────────────────────────\n");

const checks: Array<[string, boolean]> = [
  ["no error (/v1 endpoint reachable + provider swap OK)", err === undefined],
  ["returned a non-empty vector", dims > 0],
  ["vector is all finite numbers", finite],
  ["vector is not all zeros", nonZero],
];
let allPass = true;
for (const [label, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) allPass = false;
}
console.log(`\n${allPass ? "✓ OLLAMA EMBED SMOKE PASSED" : "✗ FAILED"}`);
process.exit(allPass ? 0 : 1);
