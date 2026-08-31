// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { ChatMessage } from "../types/openai.js";
import type { ExecutionSnapshot } from "../graph/replay.js";
import type { Assertion, EvalCase, EvalDataset } from "./eval-runner.js";

const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "but", "if", "then", "is", "are", "was", "were",
  "be", "been", "to", "of", "in", "on", "for", "with", "as", "at", "by", "it", "this",
  "that", "these", "those", "i", "you", "he", "she", "we", "they", "not", "no", "yes",
  "do", "does", "did", "can", "could", "should", "would", "will", "your", "our", "my",
  "me", "from", "about", "into", "over", "than", "so", "der", "die", "das", "und", "oder",
  "aber", "wenn", "ist", "sind", "war", "waren", "sein", "zu", "von", "in", "auf", "für",
  "mit", "als", "bei", "es", "dies", "diese", "nicht", "kein", "keine", "ja", "ich", "du",
  "wir", "sie", "ihr", "mein", "dein", "aus", "über", "auch", "ein", "eine", "einen", "dem",
  "den", "des",
]);

export function extractKeyPhrases(text: string, n = 3): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  const frequency = new Map<string, { count: number; first: number }>();
  tokens.forEach((token, index) => {
    if (STOPWORDS.has(token)) return;
    const current = frequency.get(token);
    if (current === undefined) frequency.set(token, { count: 1, first: index });
    else current.count++;
  });
  return [...frequency.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .slice(0, Math.max(0, n))
    .map(([word]) => word);
}

export interface AutoEvalOptions {
  keyPhrases?: number;
  judgeCriteria?: string;
  judgeThreshold?: number;
  minResponseChars?: number;
}

export function snapshotToCase(
  snapshot: ExecutionSnapshot,
  options: AutoEvalOptions = {},
): EvalCase | undefined {
  const response = snapshot.responseText.trim();
  if (response.length < Math.max(1, options.minResponseChars ?? 1)) return undefined;
  if (snapshot.messages.length === 0) return undefined;

  const assertions: Assertion[] = extractKeyPhrases(response, options.keyPhrases ?? 3)
    .map((value) => ({ type: "contains", value, caseSensitive: false }));
  if (options.judgeCriteria !== undefined) {
    assertions.push({
      type: "llmJudge",
      criteria: options.judgeCriteria,
      threshold: options.judgeThreshold ?? 0.7,
    });
  }
  if (assertions.length === 0) return undefined;

  return {
    id: `auto-${snapshot.executionId}`,
    flow: snapshot.flowId,
    messages: snapshot.messages,
    assert: assertions,
    expected: response,
    metadata: {
      ...(snapshot.metadata ?? {}),
      source: "production-snapshot",
      capturedAt: snapshot.createdAt,
      baselineResponse: response,
    },
  };
}

function dedupeKey(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const text = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((block) => {
            const value = block as { type?: string; text?: string };
            return value.type === "text" ? (value.text ?? "") : `[${value.type}]`;
          }).join(" ")
        : "";
    return `${message.role}:${text.replace(/\s+/g, " ").trim().toLowerCase()}`;
  }).join("\u0001");
}

export interface BuildDatasetOptions extends AutoEvalOptions {
  name?: string;
  maxCases?: number;
  dedupe?: boolean;
  flows?: string[];
}

/** Pure transformation of caller-supplied snapshots; performs no I/O or retention. */
export function buildAutoEvalDataset(
  snapshots: readonly ExecutionSnapshot[],
  options: BuildDatasetOptions = {},
): EvalDataset {
  const flowFilter = options.flows !== undefined && options.flows.length > 0
    ? new Set(options.flows)
    : undefined;
  const sorted = [...snapshots].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const seen = new Set<string>();
  const cases: EvalCase[] = [];
  const maxCases = options.maxCases === undefined
    ? undefined
    : Math.max(0, Math.floor(options.maxCases));
  if (maxCases === 0) return { name: options.name ?? "auto-eval (production)", cases };

  for (const snapshot of sorted) {
    if (flowFilter !== undefined && !flowFilter.has(snapshot.flowId)) continue;
    const evalCase = snapshotToCase(snapshot, options);
    if (evalCase === undefined) continue;
    if (options.dedupe ?? true) {
      const key = `${snapshot.flowId}\u0002${dedupeKey(snapshot.messages)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    cases.push(evalCase);
    if (maxCases !== undefined && cases.length >= maxCases) break;
  }

  return { name: options.name ?? "auto-eval (production)", cases };
}
