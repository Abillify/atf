// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Judge, JudgeVerdict } from "./eval-runner.js";

export interface JudgeModel { invoke(input: string): Promise<unknown>; }
function textFrom(value: unknown): string { if (typeof value === "string") return value; if (value && typeof value === "object" && "content" in value) { const content = (value as { content: unknown }).content; return typeof content === "string" ? content : JSON.stringify(content); } return String(value); }
/** Creates a judge that requires an injected model and accepts only bounded numeric scores. */
export function createLlmJudge(model: unknown): Judge { return async ({ criteria, response, expected, messages }) => { const candidate = model as Partial<JudgeModel>; if (typeof candidate.invoke !== "function") return { score: 0, reasoning: "No compatible judge model is configured." }; const prompt = JSON.stringify({ criteria, response, expected, messages }); const raw = textFrom(await candidate.invoke(prompt)); const match = raw.match(/(?:score\s*[:=]\s*|^)(0(?:\.\d+)?|1(?:\.0+)?)/i); const score = match ? Number(match[1]) : 0; const verdict: JudgeVerdict = { score: Math.max(0, Math.min(1, score)), reasoning: raw.slice(0, 2000) }; return verdict; }; }
/** Public builds have no provider credentials; callers must inject a model to enable judging. */
export function createLlmJudgeFromConfig(_model: unknown, _config?: unknown): Judge | undefined { return undefined; }
