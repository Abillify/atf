"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Dashboard-level error boundary (Req. 12.1).
 *
 * Next.js automatically renders this component when a route segment or its
 * children throw during rendering or data loading. It works in all
 * environments (development, production, test).
 *
 * Each route segment can override this template with its own `error.tsx` to
 * provide more contextual recovery options.
 */

import React, { useEffect } from "react";

import { Button } from "../../lib/ui";
import { reportClientError } from "../../lib/telemetry";

export interface ErrorProps {
  /** The error that was thrown. */
  error: Error & { digest?: string; requestId?: string };
  /** Next.js-provided function to re-attempt rendering the segment. */
  reset: () => void;
}

export default function DashboardError({ error, reset }: ErrorProps) {
  // Log to the browser console so developers can see the full stack trace
  // without opening DevTools, and report to the configurable telemetry
  // endpoint (Req 9.6) — fire-and-forget, never blocking the recovery UI.
  useEffect(() => {
    console.error("[DashboardError]", error);
    reportClientError({
      message: error.message ?? "Unknown error",
      stack: error.stack,
      digest: error.digest,
      source: "error-boundary",
    });
  }, [error]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <div className="rounded-full bg-danger-soft p-4">
        {/* Simple warning icon — no icon library required */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="h-8 w-8 text-danger"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 1.998-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.502-2.598-4.5L9.4 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
            clipRule="evenodd"
          />
        </svg>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground">
          Something went wrong
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          An unexpected error occurred while rendering this page.
        </p>
        {error.digest && (
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            Error ID: {error.digest}
          </p>
        )}
        {error.requestId && (
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            Request ID: {error.requestId}
          </p>
        )}
      </div>

      <Button variant="primary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
