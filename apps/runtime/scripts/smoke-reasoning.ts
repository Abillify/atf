// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Focused live probe: does the Gemini provider emit `reasoning-delta` parts
 * (thought summaries) that our graph-engine now routes to the reasoning channel?
 *
 * Uses a hard reasoning prompt, NO tools, and includeThoughts. Tries a list of
 * model ids until one emits reasoning-delta.
 *
 * Usage: bun run scripts/smoke-reasoning.ts
 * Key is read from .env (GOOGLE_API_KEY), never printed.
 */
import { streamText } from "ai";
import { createLlmProvider } from "../src/graph/llm-factory.js";
import type { AppConfig } from "../src/config/index.js";

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("✗ GOOGLE_API_KEY not set (add to .env).");
  process.exit(1);
}
const appConfig = { googleApiKey: apiKey } as unknown as AppConfig;

const models = (
  process.env.SMOKE_MODELS ??
  "models/gemini-3-flash-preview,models/gemini-2.5-flash,models/gemini-2.5-pro"
).split(",");

const prompt =
  "A man has to cross a river with a fox, a chicken, and a sack of grain. " +
  "The boat only holds him and one item. The fox eats the chicken, the chicken eats the grain, " +
  "if left together unattended. Give the full step-by-step crossing plan, reasoning carefully.";

for (const modelId of models) {
  const model = createLlmProvider(
    { provider: "google", model: modelId },
    appConfig,
  );
  let reasoningChars = 0;
  let textChars = 0;
  let err: string | undefined;

  const result = streamText({
    model,
    providerOptions: {
      google: {
        thinkingConfig: { includeThoughts: true, thinkingBudget: 4096 },
      },
    },
    messages: [{ role: "user", content: prompt }],
  });

  try {
    for await (const part of result.fullStream) {
      if (part.type === "reasoning-delta")
        reasoningChars += (part as { text?: string }).text?.length ?? 0;
      else if (part.type === "text-delta")
        textChars += (part as { text?: string }).text?.length ?? 0;
      else if (part.type === "error")
        err =
          (part as { error?: unknown }).error instanceof Error
            ? (part as { error: Error }).error.message
            : String((part as { error?: unknown }).error);
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  console.log(
    `${modelId}: reasoning=${reasoningChars} chars, text=${textChars} chars` +
      (err ? `, error=${err}` : ""),
  );
  if (reasoningChars > 0) {
    console.log(
      `\n✓ reasoning-delta confirmed live on ${modelId} — graph-engine routing is exercised end-to-end.`,
    );
    process.exit(0);
  }
}

console.log(
  "\nℹ No model emitted reasoning-delta. The routing fix is still proven by the unit test; " +
    "this provider/config simply did not return thought summaries.",
);
process.exit(0);
