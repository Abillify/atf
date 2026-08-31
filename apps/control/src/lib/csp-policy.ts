// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export type ControlCspMode = "legacy" | "report-only";

const REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";

/** Parses the server-only CSP switch and rejects explicit configuration errors. */
export function parseControlCspMode(value: string | undefined): ControlCspMode {
  if (value === undefined || value === "" || value === "legacy") return "legacy";
  if (value === "report-only") return "report-only";
  throw new Error(
    `Invalid CONTROL_CSP_MODE ${JSON.stringify(value)}; expected "legacy" or "report-only"`,
  );
}

/** Returns a sanitized HTTP(S) backend origin, or null for unsafe/invalid input. */
export function sanitizeBackendOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Builds a single-line report-only policy suitable for Next.js and React. */
export function buildControlCspPolicy(options?: {
  development?: boolean;
  backendUrl?: string;
}): string {
  const backendOrigin = sanitizeBackendOrigin(options?.backendUrl);
  const connectSources = ["'self'"];
  if (backendOrigin) {
    connectSources.push(backendOrigin);
    const backend = new URL(backendOrigin);
    backend.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
    connectSources.push(backend.origin);
  }

  const scriptSources = ["'self'", "'unsafe-inline'"];
  if (options?.development) scriptSources.push("'unsafe-eval'");

  return [
    `default-src 'self'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `script-src ${scriptSources.join(" ")}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data: blob:`,
    `connect-src ${connectSources.join(" ")}`,
    `worker-src 'self' blob:`,
    `media-src 'self' blob:`,
  ].join("; ");
}

/** Produces no headers in legacy mode and never emits an enforcement header. */
export function controlCspHeaders(options: {
  mode: ControlCspMode;
  development?: boolean;
  backendUrl?: string;
}): Array<{ key: string; value: string }> {
  if (options.mode === "legacy") return [];
  return [
    {
      key: REPORT_ONLY_HEADER,
      value: buildControlCspPolicy(options),
    },
  ];
}
