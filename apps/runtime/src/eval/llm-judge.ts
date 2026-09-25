// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { generateText, type LanguageModel } from "ai";
import type { Judge, JudgeVerdict } from "./eval-runner.js";

/** Legacy judge model shape: a single `invoke(prompt)` returning text or `{ content }`. */
export interface JudgeModel { invoke(input: string): Promise<unknown>; }

/** Minimal subset of the AI SDK `generateText` used here (injectable for tests). */
export type JudgeGenerateTextFn = (args: {
  model: LanguageModel;
  system: string;
  prompt: string;
}) => Promise<{ text: string }>;

export interface LlmJudgeOptions {
  generate?: JudgeGenerateTextFn;
}

const JUDGE_SYSTEM_PROMPT =
  "You are a strict evaluator. You get a conversation, the assistant's response, " +
  "the evaluation criteria and optionally a reference answer. Rate how well the " +
  "response meets the criteria on a scale from 0 (not at all) to 1 (fully). " +
  'Reply with ONLY a JSON object: {"score": <number between 0 and 1>, "reasoning": "<one or two sentences>"}';

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "content" in value) {
    const content = (value as { content: unknown }).content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return String(value);
}

/** An AI SDK model: a model id string or a provider model object. */
function isLanguageModel(model: unknown): model is LanguageModel {
  if (typeof model === "string") return model.length > 0;
  return (
    model !== null &&
    typeof model === "object" &&
    "doGenerate" in model &&
    typeof (model as { doGenerate: unknown }).doGenerate === "function"
  );
}

/**
 * Reads the score from a judge reply. Reasoning models may prefix the answer
 * with a `<think>` block — dropped first so a number inside it can't be taken
 * for the verdict. Returns undefined when the reply carries no score.
 */
export function parseJudgeReply(raw: string): JudgeVerdict | undefined {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*<\/think>/i, "")
    .trim();
  for (const candidate of text.match(/\{[\s\S]*?\}/g) ?? []) {
    try {
      const parsed = JSON.parse(candidate) as { score?: unknown; reasoning?: unknown };
      const score = typeof parsed.score === "string" ? Number(parsed.score) : parsed.score;
      if (typeof score === "number" && Number.isFinite(score)) {
        return {
          score: Math.max(0, Math.min(1, score)),
          reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : text.slice(0, 2000),
        };
      }
    } catch {
      // not JSON — try the next candidate / the plain-text form
    }
  }
  const match = text.match(/score"?\s*[:=]\s*(\d+(?:\.\d+)?)/i) ?? text.match(/^(0(?:\.\d+)?|1(?:\.0+)?)\b/);
  if (match?.[1] === undefined) return undefined;
  return { score: Math.max(0, Math.min(1, Number(match[1]))), reasoning: text.slice(0, 2000) };
}

/**
 * Creates a judge from an injected model — an AI SDK model (what
 * `createLlmProvider` returns) or a legacy `{ invoke }` model. Throws instead of
 * scoring 0 when there is no usable model or the reply has no score, so the
 * eval records a judge error rather than a fake failing grade.
 */
export function createLlmJudge(model: unknown, opts: LlmJudgeOptions = {}): Judge {
  const generate = opts.generate ?? (generateText as unknown as JudgeGenerateTextFn);
  return async ({ criteria, response, expected, messages }) => {
    const prompt = JSON.stringify({ criteria, messages, response, ...(expected !== undefined ? { expected } : {}) });
    let raw: string;
    if (isLanguageModel(model)) {
      raw = (await generate({ model, system: JUDGE_SYSTEM_PROMPT, prompt })).text;
    } else if (typeof (model as Partial<JudgeModel> | null)?.invoke === "function") {
      raw = textFrom(await (model as JudgeModel).invoke(`${JUDGE_SYSTEM_PROMPT}\n\n${prompt}`));
    } else {
      throw new Error("No compatible judge model is configured.");
    }
    const verdict = parseJudgeReply(raw);
    if (verdict === undefined) {
      throw new Error(`Judge reply contained no score: ${raw.slice(0, 300)}`);
    }
    return verdict;
  };
}

/** Public builds have no provider credentials; callers must inject a model to enable judging. */
export function createLlmJudgeFromConfig(_model: unknown, _config?: unknown): Judge | undefined { return undefined; }
