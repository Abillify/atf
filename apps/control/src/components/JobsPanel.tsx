"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * JobsPanel — async/batch job status lookup (`GET /v1/jobs/:id`).
 *
 * Deliberately a single-job LOOKUP, not a listing view: the backend has no
 * job-listing endpoint — `GET /v1/jobs/:id` is scoped to the identity that
 * created the job (tenant id, else the caller's own bearer token; see
 * `deriveJobOwner` in `src/routes/jobs.ts`), and there is no cross-tenant
 * admin listing route for jobs the way there is for, say, assistants. Adding
 * one would be new backend surface outside this feature's scope; this panel
 * stays proportional to what already exists.
 *
 * Surfaces the Durable Agent Runtime fields (`attempt`/`max_attempts`) added
 * alongside the crash-recovery sweeper (see `job-store.ts` /
 * `job-recovery-sweeper.ts`): `attempt > 1` tells an operator this job
 * already survived a crash and was retried automatically.
 */

import type React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { parseJobView, type JobStatus, type JobView } from "../contracts/jobs";
import { Badge, Button, Panel } from "../lib/ui";
import type { BadgeVariant } from "../lib/ui";
import { translate, formatDateTime } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Wire contract is centralized in ../contracts/jobs.
// ---------------------------------------------------------------------------

function statusVariant(status: JobStatus): BadgeVariant {
  if (status === "completed") return "success";
  if (status === "failed") return "destructive";
  if (status === "running") return "warning";
  return "secondary";
}

async function fetchJob(id: string, token: string | undefined): Promise<JobView> {
  const res = await authFetch(backendUrl(`/v1/jobs/${encodeURIComponent(id)}`), token);
  if (!res.ok) {
    const detail = await res
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: { message?: string } }).error?.message ?? "")
          : "",
      )
      .catch(() => "");
    throw new Error(detail !== "" ? detail : `HTTP ${res.status}`);
  }
  return parseJobView(await res.json());
}

export interface JobsPanelProps {
  token: string | null | undefined;
  ready: boolean;
  /**
   * Whether operator auth is satisfied (= !authRequired || !!token). Lets the
   * lookup work when auth is disabled (AUTHN_MODE=disabled), where no token is
   * issued but the backend serves the operator plane anonymously. Optional and
   * defaults to "token present" to preserve existing callers/tests.
   */
  authenticated?: boolean;
}

/**
 * A submitted async/batch job's id is opaque to the operator until the
 * submitting client shares it — so this panel is a lookup box, polling while
 * the job is not yet terminal (2s, matching the cadence a client would poll
 * on its own).
 */
export function JobsPanel({
  token,
  ready,
  authenticated,
}: JobsPanelProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [jobId, setJobId] = useState<string | undefined>(undefined);

  // Fall back to "token present" when `authenticated` is not supplied, so
  // existing callers/tests keep their behaviour.
  const authOk = authenticated ?? Boolean(token);

  const {
    data: job,
    isLoading,
    error,
  } = useQuery<JobView, Error>({
    queryKey: ["jobs", jobId],
    queryFn: () => fetchJob(jobId as string, token ?? undefined),
    enabled: ready && authOk && jobId !== undefined,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 2000 : false;
    },
  });

  const submit = (): void => {
    const trimmed = input.trim();
    if (trimmed === "") return;
    setJobId(trimmed);
  };

  return (
    <Panel heading={translate("jobsPanel.asyncJobStatus")}>
      <p className="mb-3 text-xs text-muted-foreground">
        {translate("jobsPanel.lookUpAnAsyncBatch")}{" "}
        <code className="font-mono">metadata.async: true</code> {translate("jobsPanel.orHeader")}{" "}
        <code className="font-mono">X-Async: true</code>{translate("jobsPanel.byTheIdItWas")}<code className="font-mono">JOB_RECOVERY_ENABLED</code>{translate("jobsPanel.aJobWhoseExecutingReplica")}{" "}
        <code className="font-mono">attempt</code> /{" "}
        <code className="font-mono">max attempts</code>.
      </p>
      <div className="mb-3 flex items-center gap-2">
        <input
          className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          placeholder="job-..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          aria-label={translate("jobsPanel.jobId")}
        />
        <Button size="sm" variant="primary" onClick={submit} disabled={input.trim() === ""}>
          {translate("jobsPanel.lookUp")}
        </Button>
      </div>

      {jobId === undefined ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {translate("jobsPanel.enterAJobIdTo")}
        </p>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {translate("jobsPanel.lookingUpJobId", { jobId })}
        </div>
      ) : error ? (
        <div role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
          {error.message}
        </div>
      ) : job === undefined ? (
        <></>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-foreground">{job.id}</span>
            <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
            {job.attempt > 1 && (
              <Badge variant="warning" title={translate("jobsPanel.thisJobSurvivedACrash")}>
                {translate("jobsPanel.recoveredAttemptAttemptMaxAttempts", { attempt: job.attempt, max_attempts: job.max_attempts })}
              </Badge>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">{translate("jobsPanel.modelFlow")}</dt>
              <dd className="font-mono text-foreground">{job.model}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{translate("jobsPanel.attempt")}</dt>
              <dd className="text-foreground">
                {job.attempt} / {job.max_attempts}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{translate("jobsPanel.created")}</dt>
              <dd className="text-foreground">{formatDateTime(job.created_at)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{translate("jobsPanel.updated")}</dt>
              <dd className="text-foreground">{formatDateTime(job.updated_at)}</dd>
            </div>
          </dl>
          {job.result !== undefined && (
            <div className="rounded-md border border-border bg-card p-3">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {translate("jobsPanel.result")}
              </h4>
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {job.result.choices[0]?.message.content ?? translate("jobsPanel.empty")}
              </p>
            </div>
          )}
          {job.error !== undefined && (
            <div className="rounded-md border border-danger-border bg-danger-soft p-3 text-sm text-danger">
              {job.error}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
