// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `POST /v2/jobs` and `GET /v2/jobs/{id}` (requirements 8.5, 8.7).
 *
 * `createJob` submits an already-uploaded source (addressed by its sha256)
 * for processing. `pollJob` follows a job with an exponential interval
 * (2 s → ×2 → capped at 30 s) until it reaches a terminal status
 * (`completed`, `failed`, `cancelled`) — the first terminal status wins and is
 * returned exactly once (Property 23). `sleep` and `now` are injected so the
 * polling cadence is testable without real timers.
 */

import {
  jobRequestSchema,
  jobSchema,
  type Job,
  type JobRequest,
  type JobStatus,
} from "@atf/extract-contract/v2";
import type { ExtractHttpClient } from "../http/client.js";
import { apiErrorCode, apiErrorMessage, ExtractApiError } from "./api-error.js";

/** Initial poll interval (requirement 8.7). */
export const POLL_INITIAL_MS = 2_000;
/** Upper bound for the poll interval. */
export const POLL_MAX_MS = 30_000;

/** Statuses that end the polling loop. */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/** The next poll delay for the given 0-based poll round: 2 s doubling to 30 s. */
export function pollDelayMs(round: number): number {
  return Math.min(POLL_MAX_MS, POLL_INITIAL_MS * 2 ** round);
}

/** Submit a job for an uploaded source. The body is validated against the contract. */
export async function createJob(
  client: ExtractHttpClient,
  body: JobRequest,
  signal?: AbortSignal,
): Promise<Job> {
  const parsed = jobRequestSchema.parse(body);
  const response = await client.request({
    url: "/v2/jobs",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new ExtractApiError(
      response.status,
      apiErrorCode(response.json),
      apiErrorMessage(response.json) ?? `createJob antwortete mit ${response.status}`,
    );
  }
  return jobSchema.parse(response.json);
}

/** Read a job once. */
export async function getJob(
  client: ExtractHttpClient,
  jobId: string,
  signal?: AbortSignal,
): Promise<Job> {
  const response = await client.request({
    url: `/v2/jobs/${encodeURIComponent(jobId)}`,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (response.status !== 200) {
    throw new ExtractApiError(
      response.status,
      apiErrorCode(response.json),
      apiErrorMessage(response.json) ?? `getJob antwortete mit ${response.status}`,
    );
  }
  return jobSchema.parse(response.json);
}

export interface PollJobDeps {
  sleep: (ms: number) => Promise<void>;
  /** Optional abort signal — an abort rejects with the abort reason. */
  signal?: AbortSignal;
}

/**
 * Poll until the job reaches a terminal status. The first terminal status is
 * returned; the interval doubles per round, capped at 30 s (8.7).
 */
export async function pollJob(
  client: ExtractHttpClient,
  jobId: string,
  deps: PollJobDeps,
): Promise<Job> {
  let round = 0;
  for (;;) {
    const job = await getJob(client, jobId, deps.signal);
    if (isTerminalJobStatus(job.status)) return job;
    await deps.sleep(pollDelayMs(round));
    round += 1;
  }
}
