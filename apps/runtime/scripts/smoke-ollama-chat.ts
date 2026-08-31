// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Live smoke test for the Ollama → @ai-sdk/openai (/v1) migration — chat path.
 *
 * Counterpart to smoke-ollama-embed.ts. This exercises the chat-completion
 * path: createLlmProvider("ollama", …) → openai(model) via the normalised
 * {host}/v1 base URL, then a real generateText() round-trip. Proves the
 * provider swap + URL handling works against a real Ollama OpenAI-compatible
 * chat-completion endpoint.
 *
 * Usage:
 *   OLLAMA_BASE_URL=http://host:11434 SMOKE_CHAT_MODEL=lfm2.5 \
 *     bun run scripts/smoke-ollama-chat.ts
 */
import { generateText } from "ai";
import { createLlmProvider } from "../src/graph/llm-factory.js";
import type { AppConfig } from "../src/config/index.js";

const baseUrl = process.env.OLLAMA_BASE_URL;
if (!baseUrl) {
  console.error("✗ OLLAMA_BASE_URL not set.");
  process.exit(1);
}
const modelId = process.env.SMOKE_CHAT_MODEL ?? "lfm2.5";

const appConfig = { ollamaBaseUrl: baseUrl } as unknown as AppConfig;

console.log(`▶ Ollama chat smoke test: ${modelId} @ ${baseUrl}`);

const model = createLlmProvider(
  { provider: "ollama", model: modelId },
  appConfig,
);

let err: string | undefined;
let text = "";
let finishReason: string | undefined;
let totalTokens: number | undefined;

try {
  const result = await generateText({
    model,
    prompt:
      "Antworte mit genau einem Wort: Was ist die Hauptstadt von Frankreich?",
  });
  text = result.text;
  finishReason = result.finishReason;
  totalTokens = result.usage?.totalTokens;
} catch (e) {
  err = e instanceof Error ? e.message : String(e);
}

console.log("\n── Results ──────────────────────────────");
console.log(`response text:      ${JSON.stringify(text)}`);
console.log(`finish reason:      ${finishReason ?? "n/a"}`);
console.log(`total tokens:       ${totalTokens ?? "n/a"}`);
if (err) console.log(`error:              ${err}`);
console.log("─────────────────────────────────────────\n");

const checks: Array<[string, boolean]> = [
  ["no error (/v1 endpoint reachable + provider swap OK)", err === undefined],
  ["returned non-empty text", text.trim().length > 0],
  ["mentions Paris (model produced a sensible answer)", /paris/i.test(text)],
];
let allPass = true;
for (const [label, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) allPass = false;
}
console.log(`\n${allPass ? "✓ OLLAMA CHAT SMOKE PASSED" : "✗ FAILED"}`);
process.exit(allPass ? 0 : 1);
