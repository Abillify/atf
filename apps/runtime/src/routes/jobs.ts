// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Async job status route (`src/routes/jobs.ts`)
 *
 * Companion to the async/batch submission mode of `POST /v1/chat/completions`
 * (request with `metadata.async: true` or header `X-Async: true`). The submit
 * returns HTTP 202 with a job id; the client then polls:
 *
 *   GET /v1/jobs/:id → { id, status, result?, error? }
 *
 * Mounted under the `/v1` plane, so the standard auth middleware already gates
 * it. Access is additionally scoped to the submitter: a job carrying an owner
 * (tenant id, else the bearer token) is only visible to a request presenting
 * the same identity — a mismatch returns 404 so job existence is not leaked.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import {
  AUTH_PRINCIPAL_KEY,
  TOKEN_KEY,
  deriveAuthenticatedOwner,
  type AuthContext,
} from "../middleware/auth.js";
import type { JobRecord, JobStore } from "../graph/job-store.js";

export const deriveJobOwner = deriveAuthenticatedOwner;

export type JobView = ReturnType<typeof toJobView>;

/** Pure Runtime producer for the public job-status wire shape. */
export function toJobView(job: JobRecord) {
  return {
    id: job.id,
    status: job.status,
    model: job.model,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    // Durable Agent Runtime fields — attempt > 1 tells a client this job
    // already survived a crash and was retried, and max_attempts shows the
    // bound it's held to. Both are 1 when recovery is not enabled for this
    // job (the pre-existing, non-recoverable behaviour).
    attempt: job.attempt,
    max_attempts: job.maxAttempts,
    // Latest harness progress snapshot while the job runs (throttled writes
    // — see `job-store.ts`); absent for jobs that never emitted one.
    ...(job.progress !== undefined ? { progress: job.progress } : {}),
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
}

export function createJobsRouter(jobStore: JobStore): Hono<AuthContext> {
  const router = new Hono<AuthContext>();

  router.get("/v1/jobs/:id", async (ctx) => {
    const id = ctx.req.param("id");
    const job = await jobStore.get(id);
    if (job === undefined) {
      return ctx.json(
        {
          error: { message: `Job "${id}" not found.`, type: "not_found_error" },
        },
        404,
      );
    }
    // Ownership scoping: a job with an owner is only visible to that identity.
    if (job.owner !== undefined) {
      const token = ctx.get(TOKEN_KEY) ?? "";
      const requester = deriveJobOwner(
        ctx.get(AUTH_PRINCIPAL_KEY),
        token,
      );
      if (requester !== job.owner) {
        return ctx.json(
          {
            error: {
              message: `Job "${id}" not found.`,
              type: "not_found_error",
            },
          },
          404,
        );
      }
    }
    return ctx.json(toJobView(job));
  });

  return router;
}
