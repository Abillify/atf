// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobView {
  id: string;
  status: JobStatus;
  model: string;
  created_at: string;
  updated_at: string;
  attempt: number;
  max_attempts: number;
  result?: { choices: Array<{ message: { content: string } }> };
  error?: string;
}

export type JobViewInspection =
  | { ok: true; value: JobView }
  | { ok: false; findings: readonly string[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Runtime-independent validator for the Control consumer side of GET /v1/jobs/:id. */
export function inspectJobView(value: unknown): JobViewInspection {
  const job = record(value);
  if (job === undefined) return { ok: false, findings: ["$: expected an object"] };
  const findings: string[] = [];
  const stringField = (key: string): void => {
    if (typeof job[key] !== "string" || job[key] === "") findings.push(`$.${key}: expected a non-empty string`);
  };
  for (const key of ["id", "model", "created_at", "updated_at"]) stringField(key);
  if (!(["queued", "running", "completed", "failed"] as unknown[]).includes(job.status)) {
    findings.push("$.status: expected a known job status");
  }
  for (const key of ["attempt", "max_attempts"]) {
    if (!Number.isInteger(job[key]) || (job[key] as number) < 1) findings.push(`$.${key}: expected a positive integer`);
  }
  if (job.error !== undefined && typeof job.error !== "string") findings.push("$.error: expected a string");
  if (job.result !== undefined) {
    const result = record(job.result);
    if (!Array.isArray(result?.choices)) findings.push("$.result.choices: expected an array");
    else {
      for (const [index, choice] of result.choices.entries()) {
        const content = record(record(choice)?.message)?.content;
        if (typeof content !== "string") findings.push(`$.result.choices.${index}.message.content: expected a string`);
      }
    }
  }
  return findings.length === 0
    ? { ok: true, value: job as unknown as JobView }
    : { ok: false, findings };
}

export function parseJobView(value: unknown): JobView {
  const inspection = inspectJobView(value);
  if (!inspection.ok) throw new Error(`Invalid job response contract: ${inspection.findings.join("; ")}`);
  return inspection.value;
}
