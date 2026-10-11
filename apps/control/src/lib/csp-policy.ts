// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * CSP and baseline security headers for Control (Req. 8.1, 8.2).
 *
 * The headers are emitted per request by `src/proxy.ts` (Next.js 16 renamed
 * middleware to proxy), NOT by `next.config.ts`: the script nonce must be
 * fresh for every request and HSTS may only go out over HTTPS — neither is
 * expressible with build-time `headers()` config.
 */

export type ControlCspMode = "legacy" | "report-only" | "enforce";

const REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
const ENFORCE_HEADER = "Content-Security-Policy";

/**
 * Request header through which the proxy hands the per-request nonce to the
 * root layout (the theme-init script). Next's own inline scripts pick the
 * nonce up from the forwarded `content-security-policy` header itself.
 */
export const CSP_NONCE_REQUEST_HEADER = "x-control-csp-nonce";

/**
 * Req. 8.1 makes `enforce` the default with this minor release. Operators who
 * need the old behaviour must now set `CONTROL_CSP_MODE=legacy` (or
 * `report-only`) explicitly — see the upgrade note in the CHANGELOG.
 */
export const DEFAULT_CONTROL_CSP_MODE: ControlCspMode = "enforce";

/** Parses the server-only CSP switch and rejects explicit configuration errors. */
export function parseControlCspMode(value: string | undefined): ControlCspMode {
  if (value === undefined || value === "") return DEFAULT_CONTROL_CSP_MODE;
  if (value === "legacy" || value === "report-only" || value === "enforce") {
    return value;
  }
  throw new Error(
    `Invalid CONTROL_CSP_MODE ${JSON.stringify(value)}; expected "legacy", "report-only" or "enforce"`,
  );
}

/**
 * 128 bits of randomness as unpadded base64url — exactly the character set
 * CSP nonces (and Next's nonce extraction) accept. Uses only Web APIs so the
 * same code runs in the Node proxy runtime and in tests.
 */
export function generateControlCspNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

/**
 * Builds a single-line policy suitable for Next.js and React.
 *
 * With a `nonce` the script source is `'self' 'nonce-…'` and no
 * `'unsafe-inline'` (enforce mode). Without one the historical
 * `'unsafe-inline'` stays (report-only rollout). `style-src` keeps
 * `'unsafe-inline'` in every mode: Tailwind and @xyflow/react emit inline
 * styles, and a style attribute cannot carry a nonce — documented ADR.
 */
export function buildControlCspPolicy(options?: {
  development?: boolean;
  backendUrl?: string;
  nonce?: string;
}): string {
  const backendOrigin = sanitizeBackendOrigin(options?.backendUrl);
  const connectSources = ["'self'"];
  if (backendOrigin) {
    connectSources.push(backendOrigin);
    const backend = new URL(backendOrigin);
    backend.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
    connectSources.push(backend.origin);
  }

  const scriptSources = ["'self'"];
  if (options?.nonce) {
    scriptSources.push(`'nonce-${options.nonce}'`);
  } else {
    scriptSources.push("'unsafe-inline'");
  }
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

/**
 * Legacy emits nothing; report-only never enforces; enforce emits the
 * enforcing header (Req. 8.1). A nonce is only honoured when one is passed —
 * the proxy always supplies one outside legacy mode.
 */
export function controlCspHeaders(options: {
  mode: ControlCspMode;
  development?: boolean;
  backendUrl?: string;
  nonce?: string;
}): Array<{ key: string; value: string }> {
  if (options.mode === "legacy") return [];
  return [
    {
      key: options.mode === "enforce" ? ENFORCE_HEADER : REPORT_ONLY_HEADER,
      value: buildControlCspPolicy(options),
    },
  ];
}

/**
 * Baseline security headers independent of the CSP mode (Req. 8.2).
 * `Strict-Transport-Security` is only emitted for HTTPS requests — sending it
 * over plain HTTP is ignored by browsers and would only mask misconfiguration.
 * `frame-ancestors 'none'` lives in the CSP; `X-Frame-Options: DENY` covers
 * legacy mode where no CSP header is sent at all.
 */
export function controlSecurityHeaders(options: {
  secure: boolean;
}): Array<{ key: string; value: string }> {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    },
    { key: "X-Frame-Options", value: "DENY" },
  ];
  if (options.secure) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000",
    });
  }
  return headers;
}
