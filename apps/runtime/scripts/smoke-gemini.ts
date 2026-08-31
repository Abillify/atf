// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Live smoke test for the ai@6 / @ai-sdk/google@3 upgrade.
 *
 * Exercises the REAL code path that the unit tests cannot cover against a live
 * provider:
 *   1. createLlmProvider("google", …) — the project's own factory
 *   2. streamText with a tool + stopWhen(stepCountIs) — the multi-step agent loop
 *   3. fullStream consumption — reasoning-delta / tool-call / finish-step handling
 *
 * What it proves:
 *   - Gemini 3 thinking + function calling completes WITHOUT the
 *     "Function call is missing a thought_signature" 400 (the SDK now
 *     round-trips the signature across steps).
 *   - Native reasoning is delivered as `reasoning-delta` parts (the gap we fixed
 *     in graph-engine).
 *   - Tool call args (`input`) and results (`output`) use the v6 field names.
 *
 * Usage:
 *   1. Put GOOGLE_API_KEY=... in .env  (gitignored; Bun auto-loads it)
 *   2. Optional: SMOKE_MODEL=models/gemini-3-flash-preview (default below)
 *   3. bun run scripts/smoke-gemini.ts
 *
 * The API key is read from the environment and never printed.
 */

import { streamText, stepCountIs, tool, jsonSchema } from "ai";
import { createLlmProvider } from "../src/graph/llm-factory.js";
import type { AppConfig } from "../src/config/index.js";

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey || apiKey.trim().length === 0) {
  console.error(
    "✗ GOOGLE_API_KEY is not set. Add it to .env (gitignored) and re-run.",
  );
  process.exit(1);
}

const modelId = process.env.SMOKE_MODEL ?? "models/gemini-3-flash-preview";

// Minimal AppConfig carrying only what the google factory branch reads.
const appConfig = { googleApiKey: apiKey } as unknown as AppConfig;

const model = createLlmProvider(
  { provider: "google", model: modelId },
  appConfig,
);

// A tool the model must call to answer — forces a multi-step (tool) loop,
// which is exactly where the thought_signature round-trip is required.
let toolCalled = false;
const tools = {
  get_weather: tool<{ city: string }, { tempC: number; summary: string }>({
    description: "Get the current weather for a city.",
    inputSchema: jsonSchema<{ city: string }>({
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    }),
    execute: async ({ city }) => {
      toolCalled = true;
      return { tempC: 21, summary: `clear skies over ${city}` };
    },
  }),
};

console.log(`▶ Smoke test against ${modelId} (key length: ${apiKey.length})`);

let reasoningChars = 0;
let textChars = 0;
let toolCalls = 0;
let toolResults = 0;
let steps = 0;
let streamError: string | undefined;
const usage = { input: 0, output: 0, total: 0 };

const result = streamText({
  model,
  allowSystemInMessages: true,
  tools,
  stopWhen: stepCountIs(5),
  // Optional: force Gemini to emit human-readable thought summaries
  // (reasoning-delta parts) so the live run also exercises that path.
  // Enable with SMOKE_THINKING=1.
  ...(process.env.SMOKE_THINKING === "1"
    ? {
        providerOptions: {
          google: {
            thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 },
          },
        },
      }
    : {}),
  messages: [
    {
      role: "user",
      content:
        "What's the weather in Berlin right now? Use the get_weather tool, then answer in one sentence.",
    },
  ],
});

try {
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "reasoning-delta":
        reasoningChars += (part as { text?: string }).text?.length ?? 0;
        break;
      case "text-delta":
        textChars += (part as { text?: string }).text?.length ?? 0;
        break;
      case "tool-call":
        toolCalls++;
        console.log(
          `  • tool-call: ${(part as { toolName?: string }).toolName} input=${JSON.stringify((part as { input?: unknown }).input)}`,
        );
        break;
      case "tool-result":
        toolResults++;
        console.log(
          `  • tool-result: output=${JSON.stringify((part as { output?: unknown }).output)}`,
        );
        break;
      case "finish-step": {
        steps++;
        const u = (
          part as {
            usage?: {
              inputTokens?: number;
              outputTokens?: number;
              totalTokens?: number;
            };
          }
        ).usage;
        usage.input += u?.inputTokens ?? 0;
        usage.output += u?.outputTokens ?? 0;
        usage.total += u?.totalTokens ?? 0;
        break;
      }
      case "error":
        streamError =
          (part as { error?: unknown }).error instanceof Error
            ? (part as { error: Error }).error.message
            : String((part as { error?: unknown }).error);
        break;
    }
  }
} catch (err) {
  streamError = err instanceof Error ? err.message : String(err);
}

const finalText = await result.text.catch(() => "");

console.log("\n── Results ──────────────────────────────");
console.log(`steps (finish-step):   ${steps}`);
console.log(`tool-calls:            ${toolCalls}`);
console.log(`tool-results:          ${toolResults}`);
console.log(`tool.execute ran:      ${toolCalled}`);
console.log(`reasoning chars:       ${reasoningChars}`);
console.log(`visible text chars:    ${textChars}`);
console.log(
  `usage (in/out/total):  ${usage.input}/${usage.output}/${usage.total}`,
);
console.log(`final answer:          ${finalText.slice(0, 200)}`);
console.log("─────────────────────────────────────────\n");

const checks: Array<[string, boolean]> = [
  [
    "no stream error (thought_signature round-trip OK)",
    streamError === undefined,
  ],
  ["tool was called", toolCalls > 0 && toolCalled],
  ["tool result round-tripped", toolResults > 0],
  ["multi-step loop completed", steps >= 2],
  ["produced a final answer", finalText.trim().length > 0],
];

let allPass = true;
for (const [label, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) allPass = false;
}
if (reasoningChars > 0) {
  console.log(
    `ℹ reasoning-delta observed (${reasoningChars} chars) — thinking is captured`,
  );
} else {
  console.log(
    "ℹ no reasoning-delta emitted (model/thinking config may not produce it)",
  );
}

if (streamError !== undefined) {
  console.error(`\n✗ Stream error: ${streamError}`);
}

console.log(`\n${allPass ? "✓ SMOKE TEST PASSED" : "✗ SMOKE TEST FAILED"}`);
process.exit(allPass ? 0 : 1);
