// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Single HTTP client for every Extract call (requirements 4.1, 4.3, 4.4,
 * 5.3, 5.4, 14.9, 15.1).
 *
 * Responsibilities:
 * - `Authorization: Bearer <token>` from the {@link TokenProvider};
 * - `User-Agent: atf-outpost/<version> (<runtime>; <os>/<arch>)`;
 * - an origin guard that rejects any request whose origin differs from the
 *   configured Extract_URL origin **before** any network access (15.1);
 * - on `401`: exactly one `forceRefresh()` and exactly one repeat; a second
 *   `401` reports `reauth_required` (4.3, 4.4);
 * - TLS via the optional `undici` dispatcher from `tls.ts`.
 *
 * Cloud sources never use this client and never receive the Extract token.
 */

import { arch, platform } from "node:os";
import type { TokenProvider } from "../auth/manager.js";
import { extractTlsErrorCode } from "./tls.js";

/** Raised for a request rejected by the origin guard (15.1). */
export class OriginGuardError extends Error {
  constructor(
    message: string,
    readonly requestOrigin: string,
    readonly allowedOrigin: string,
  ) {
    super(message);
    this.name = "OriginGuardError";
  }
}

/** Raised when re-authentication is required after a repeated 401 (4.4). */
export class ReauthRequiredError extends Error {
  constructor(message = "Erneute Anmeldung erforderlich") {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

export type Runtime = "docker" | "desktop";

export interface ExtractHttpClientOptions {
  /** Base Extract_URL; its origin is the only allowed request origin. */
  extractUrl: string;
  tokenProvider: TokenProvider;
  version: string;
  runtime: Runtime;
  fetchImpl?: typeof globalThis.fetch;
  /** undici dispatcher for a custom CA (see `createTlsAgent`). */
  dispatcher?: unknown;
  /** Called when a repeated 401 forces re-authentication. */
  onReauthRequired?: () => void;
}

export interface HttpRequest {
  /** Absolute URL or path relative to the Extract_URL origin. */
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or `undefined` for empty/non-JSON bodies. */
  json: unknown;
  text: string;
}

/** Build the `User-Agent` value (requirement 14.9). */
export function buildUserAgent(version: string, runtime: Runtime): string {
  return `atf-outpost/${version} (${runtime}; ${platform()}/${arch()})`;
}

export class ExtractHttpClient {
  private readonly origin: string;
  private readonly opts: ExtractHttpClientOptions;
  private readonly fetchImpl: typeof globalThis.fetch;
  readonly userAgent: string;

  constructor(options: ExtractHttpClientOptions) {
    this.opts = options;
    let parsed: URL;
    try {
      parsed = new URL(options.extractUrl);
    } catch {
      throw new Error(`Ungültige Extract_URL: ${options.extractUrl}`);
    }
    this.origin = parsed.origin;
    this.userAgent = buildUserAgent(options.version, options.runtime);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** The single allowed origin, exposed for status output and tests. */
  get allowedOrigin(): string {
    return this.origin;
  }

  /**
   * Perform a request against the Extract service. Rejects non-matching
   * origins before touching the network (15.1).
   */
  async request(request: HttpRequest): Promise<HttpResponse> {
    const url = this.resolveAndGuard(request.url);
    const response = await this.sendOnce(url, request, false);
    return this.toResponse(response);
  }

  /** Send once; on 401 refresh the token and repeat exactly once (4.3). */
  private async sendOnce(
    url: string,
    request: HttpRequest,
    isRetry: boolean,
  ): Promise<Awaited<ReturnType<typeof globalThis.fetch>>> {
    const token = await this.opts.tokenProvider.getAccessToken(Date.now());
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "user-agent": this.userAgent,
      accept: "application/json",
      ...request.headers,
    };
    const init: RequestInit = {
      method: request.method ?? "GET",
      headers,
      body: request.body as BodyInit | null | undefined,
      signal: request.signal,
    };
    // undici accepts a dispatcher via its request options; the global fetch
    // in Node/Bun forwards it when provided as such.
    if (this.opts.dispatcher !== undefined) {
      (init as RequestInit & { dispatcher?: unknown }).dispatcher = this.opts.dispatcher;
    }

    let response: Awaited<ReturnType<typeof globalThis.fetch>>;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      // Surface TLS codes unchanged (5.3); no retry without a config change.
      const tlsCode = extractTlsErrorCode(error);
      if (tlsCode !== undefined) {
        throw new TlsFailureError(tlsCode, url, { cause: error });
      }
      throw error;
    }

    if (response.status === 401 && !isRetry) {
      // Exactly one forceRefresh + one repeat (4.3). api-token mode:
      // forceRefresh re-reads the token; a second 401 still ends here.
      await this.opts.tokenProvider.forceRefresh();
      return this.sendOnce(url, request, true);
    }
    if (response.status === 401 && isRetry) {
      // The repeat also returned 401 → re-authentication required (4.4).
      this.opts.onReauthRequired?.();
      throw new ReauthRequiredError();
    }
    return response;
  }

  /** Resolve a possibly relative URL and enforce the origin guard (15.1). */
  private resolveAndGuard(url: string): string {
    let resolved: URL;
    try {
      resolved = new URL(url, this.opts.extractUrl);
    } catch {
      throw new OriginGuardError(`Ungültige Anfrage-URL: ${url}`, url, this.origin);
    }
    if (resolved.origin !== this.origin) {
      throw new OriginGuardError(
        `Anfrage-Origin ${resolved.origin} weicht von der Extract_URL ${this.origin} ab`,
        resolved.origin,
        this.origin,
      );
    }
    return resolved.toString();
  }

  private async toResponse(
    response: Awaited<ReturnType<typeof globalThis.fetch>>,
  ): Promise<HttpResponse> {
    const text = await response.text();
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, headers: response.headers, json, text };
  }
}

/** Raised on a TLS failure, carrying the concrete code and checked URL (5.3). */
export class TlsFailureError extends Error {
  constructor(
    readonly code: string,
    readonly checkedUrl: string,
    readonly options?: { cause?: unknown },
  ) {
    super(`TLS-Fehler ${code} bei ${checkedUrl}`, options);
    this.name = "TlsFailureError";
  }
}
