// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { findPiiMatches, type PiiType } from "../graph/output-guardrails.js";

export type PiiExpectedItem = string | { type: PiiType; value: string };
export interface PiiRecallCase { id?: string; text: string; expected: PiiExpectedItem[]; }
export interface PiiRecallDataset { name?: string; cases: PiiRecallCase[]; }
export interface DetectedSpan { type: PiiType; value: string; }
export type PiiDetectFn = (text: string) => DetectedSpan[];
export interface PiiTypeMetrics { type: PiiType; truePositives: number; falsePositives: number; falseNegatives: number; precision: number; recall: number; f1: number; }
export interface PiiRecallReport {
  dataset: string;
  cases: number;
  overall: Omit<PiiTypeMetrics, "type">;
  byType: PiiTypeMetrics[];
  misses: Array<{ caseId: string; type: PiiType; value: string }>;
  /** Legacy ATF aliases retained for existing dossier consumers. */
  total: number;
  recall: number;
  precision: number;
}

const DEFAULT_DETECT: PiiDetectFn = (text) =>
  findPiiMatches(text).map(({ type, value }) => ({ type, value }));

function normalize(value: string): string {
  return value.replace(/[\s\-().]/g, "").toLowerCase();
}

function covers(detected: DetectedSpan, expected: { type: PiiType; value: string }): boolean {
  return detected.type === expected.type && normalize(expected.value).length > 0 &&
    normalize(detected.value).includes(normalize(expected.value));
}

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 1000;
}

function calculateF1(precision: number, recall: number): number {
  return precision + recall === 0
    ? 0
    : Math.round(((2 * precision * recall) / (precision + recall)) * 1000) / 1000;
}

function expectedItem(item: PiiExpectedItem, detect: PiiDetectFn): { type: PiiType; value: string } {
  if (typeof item !== "string") return item;
  return { type: detect(item)[0]?.type ?? "secret", value: item };
}

export function evaluatePiiRecall(
  dataset: PiiRecallDataset,
  detect: PiiDetectFn = DEFAULT_DETECT,
): PiiRecallReport {
  type Bucket = { tp: number; fp: number; fn: number };
  const buckets = new Map<PiiType, Bucket>();
  const bucket = (type: PiiType): Bucket => {
    const current = buckets.get(type);
    if (current !== undefined) return current;
    const created = { tp: 0, fp: 0, fn: 0 };
    buckets.set(type, created);
    return created;
  };
  const misses: PiiRecallReport["misses"] = [];

  dataset.cases.forEach((entry, caseIndex) => {
    const detected = detect(entry.text);
    const used = new Array<boolean>(detected.length).fill(false);
    for (const rawExpected of entry.expected) {
      const expected = expectedItem(rawExpected, detect);
      const index = detected.findIndex((span, spanIndex) => !used[spanIndex] && covers(span, expected));
      if (index >= 0) {
        used[index] = true;
        bucket(expected.type).tp++;
      } else {
        bucket(expected.type).fn++;
        if (misses.length < 100) {
          misses.push({ caseId: entry.id ?? `case-${caseIndex + 1}`, type: expected.type, value: expected.value });
        }
      }
    }
    detected.forEach((span, index) => {
      if (!used[index]) bucket(span.type).fp++;
    });
  });

  const byType = [...buckets.entries()].map(([type, counts]): PiiTypeMetrics => {
    const precision = safeDiv(counts.tp, counts.tp + counts.fp);
    const recall = safeDiv(counts.tp, counts.tp + counts.fn);
    return {
      type,
      truePositives: counts.tp,
      falsePositives: counts.fp,
      falseNegatives: counts.fn,
      precision,
      recall,
      f1: calculateF1(precision, recall),
    };
  }).sort((a, b) => a.type.localeCompare(b.type));

  const totals = byType.reduce(
    (sum, metrics) => ({
      tp: sum.tp + metrics.truePositives,
      fp: sum.fp + metrics.falsePositives,
      fn: sum.fn + metrics.falseNegatives,
    }),
    { tp: 0, fp: 0, fn: 0 },
  );
  const precision = safeDiv(totals.tp, totals.tp + totals.fp);
  const recall = safeDiv(totals.tp, totals.tp + totals.fn);
  const overall = {
    truePositives: totals.tp,
    falsePositives: totals.fp,
    falseNegatives: totals.fn,
    precision,
    recall,
    f1: calculateF1(precision, recall),
  };
  return {
    dataset: dataset.name ?? "pii-recall",
    cases: dataset.cases.length,
    overall,
    byType,
    misses,
    total: dataset.cases.length,
    recall,
    precision,
  };
}

export function formatPiiRecallReport(report: PiiRecallReport): string {
  const lines = [
    `DLP effectiveness — dataset "${report.dataset}" (${report.cases} cases)`,
    `  overall: recall ${(report.overall.recall * 100).toFixed(1)}% · precision ${(report.overall.precision * 100).toFixed(1)}% · F1 ${(report.overall.f1 * 100).toFixed(1)}% (TP ${report.overall.truePositives} / FP ${report.overall.falsePositives} / FN ${report.overall.falseNegatives})`,
  ];
  for (const metrics of report.byType) {
    lines.push(`  ${metrics.type.padEnd(14)} recall ${(metrics.recall * 100).toFixed(0)}% · precision ${(metrics.precision * 100).toFixed(0)}% (TP ${metrics.truePositives}/FP ${metrics.falsePositives}/FN ${metrics.falseNegatives})`);
  }
  if (report.misses.length > 0) lines.push(`  misses (leaks): ${report.misses.length}`);
  return lines.join("\n");
}

export function parsePiiRecallDataset(raw: unknown): PiiRecallDataset | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const value = raw as { name?: unknown; cases?: unknown };
  if (!Array.isArray(value.cases)) return undefined;
  const cases: PiiRecallCase[] = [];
  for (const rawCase of value.cases) {
    if (rawCase === null || typeof rawCase !== "object") continue;
    const entry = rawCase as Record<string, unknown>;
    if (typeof entry.text !== "string" || !Array.isArray(entry.expected)) continue;
    const expected: PiiExpectedItem[] = [];
    for (const rawExpected of entry.expected) {
      if (typeof rawExpected === "string") {
        expected.push(rawExpected);
      } else if (rawExpected !== null && typeof rawExpected === "object") {
        const item = rawExpected as Record<string, unknown>;
        if (typeof item.type === "string" && typeof item.value === "string") {
          expected.push({ type: item.type as PiiType, value: item.value });
        }
      }
    }
    cases.push({
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      text: entry.text,
      expected,
    });
  }
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    cases,
  };
}
