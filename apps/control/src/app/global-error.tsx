"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Global error boundary (Req 9.6, Task 13.5).
 *
 * Next.js renders this component when an error occurs outside a segment
 * `error.tsx` (e.g. in the root layout). Because it can replace the whole
 * `<html>` scaffold, it must render `html`/`body` itself.
 * The error is reported to the configurable telemetry endpoint.
 */

import { useEffect } from "react";

import { reportClientError } from "../lib/telemetry";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
    reportClientError({
      message: error.message ?? "Unknown error",
      stack: error.stack,
      digest: error.digest,
      source: "global-error",
    });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div
          role="alert"
          aria-live="assertive"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px",
            minHeight: "100vh",
            padding: "32px",
            textAlign: "center",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <h1 style={{ fontSize: "20px", fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: "14px", opacity: 0.7 }}>
            An unexpected error occurred while loading the application.
          </p>
          {error.digest && (
            <p style={{ fontFamily: "monospace", fontSize: "12px", opacity: 0.6 }}>
              Error ID: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "8px 16px",
              fontSize: "14px",
              cursor: "pointer",
              borderRadius: "6px",
              border: "1px solid currentColor",
              background: "transparent",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
