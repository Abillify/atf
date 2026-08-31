// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Eval CLI (`src/eval/run.ts`)
 *
 * Replays an eval dataset against a running aiperator backend over the
 * OpenAI-compatible endpoint and prints a report. Exits non-zero when any case
 * fails, so it can gate a CI pipeline.
 *
 * Usage:
 *   bun run src/eval/run.ts --dataset eval/dataset.json \
 *     --base-url http://localhost:3000 --token <jwt> [--json] [--concurrency 4]
 *
 * Dataset format: see {@link EvalDataset} in eval-runner.ts.
 *
 * No `any` at module boundaries.
 */

import * as fs from "node:fs";
import {
  runEval,
  formatReport,
  type EvalDataset,
  type FlowExecutor,
  type FlowExecutionResult,
  type Judge,
} from "./eval-runner.js";
import { createLlmJudge } from "./llm-judge.js";
import { createLlmProvider } from "../graph/llm-factory.js";
import { loadConfig } from "../config/index.js";
import type { LlmConfig } from "../types/flow.js";
import type { ChatMessage } from "../types/openai.js";

interface CliArgs {
  dataset: string;
  baseUrl: string;
  token?: string;
  json: boolean;
  concurrency: number;
  judgeProvider?: LlmConfig["provider"];
  judgeModel?: string;
  judgeThreshold: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dataset: "eval/dataset.json",
    baseUrl: process.env.ATF_RUNTIME_URL ?? "http://localhost:3000",
    token: process.env.ATF_RUNTIME_TOKEN,
    json: false,
    concurrency: 4,
    judgeThreshold: 0.7,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") args.dataset = argv[++i] ?? args.dataset;
    else if (a === "--base-url") args.baseUrl = argv[++i] ?? args.baseUrl;
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--concurrency")
      args.concurrency = Number.parseInt(argv[++i] ?? "4", 10) || 4;
    else if (a === "--judge-provider")
      args.judgeProvider =
        (argv[++i] as LlmConfig["provider"]) ?? args.judgeProvider;
    else if (a === "--judge-model") args.judgeModel = argv[++i];
    else if (a === "--judge-threshold")
      args.judgeThreshold = Number.parseFloat(argv[++i] ?? "0.7") || 0.7;
  }
  return args;
}

/** Builds an executor that POSTs to /v1/chat/completions (non-streaming). */
export function createHttpExecutor(
  baseUrl: string,
  token?: string,
): FlowExecutor {
  return async (
    flow: string,
    messages: ChatMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<FlowExecutionResult> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const body = {
      model: flow,
      messages,
      stream: false,
      ...(metadata !== undefined ? { metadata } : {}),
    };
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    return {
      text,
      ...(json.usage !== undefined ? { usage: json.usage } : {}),
    };
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dataset)) {
    process.stderr.write(`Dataset not found: ${args.dataset}\n`);
    process.exit(2);
  }

  let dataset: EvalDataset;
  try {
    dataset = JSON.parse(fs.readFileSync(args.dataset, "utf-8")) as EvalDataset;
  } catch (err) {
    process.stderr.write(
      `Failed to parse dataset: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
    return;
  }

  const executor = createHttpExecutor(args.baseUrl, args.token);

  // Build an LLM judge when requested (or warn when the dataset needs one).
  // `assert` is optional in the generic ATF dataset schema.
  const usesJudge = dataset.cases.some(
    (c) => c.assert?.some((a) => a.type === "llmJudge") ?? false,
  );
  let judge: Judge | undefined;
  if (args.judgeModel !== undefined) {
    const provider = args.judgeProvider ?? "openai";
    // The model is deliberately injected explicitly here:
    // `createLlmJudgeFromConfig` intentionally returns no judge in public
    // builds, because provider credentials are not assumed there. The CLI
    // caller is the place that supplies the model.
    judge = createLlmJudge(
      createLlmProvider({ provider, model: args.judgeModel }, loadConfig()),
    );
  } else if (usesJudge) {
    process.stderr.write(
      "Warning: dataset contains llmJudge assertions but no --judge-model was provided; " +
        "those assertions will fail.\n",
    );
  }

  const report = await runEval(dataset, executor, {
    concurrency: args.concurrency,
    judgeThreshold: args.judgeThreshold,
    ...(judge !== undefined ? { judge } : {}),
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }

  process.exit(report.failed === 0 ? 0 : 1);
}

if (import.meta.main) {
  void main();
}
