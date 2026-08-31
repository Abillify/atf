// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Remote PII detector (`src/graph/pii-detector-remote.ts`)
 *
 * Calls an external PII detection service over REST (e.g. a Python sidecar
 * running Microsoft Presidio, spaCy, or a custom NER service). The contract is
 * a simple JSON POST → JSON response interface:
 *
 *   Request:
 *     POST <endpoint>
 *     Content-Type: application/json
 *     { "text": "...", "language": "de", "types": ["person","email",...] }
 *
 *   Response (200):
 *     { "matches": [{ "type": "person", "value": "...", "start": 0, "end": 5 }] }
 *
 * This keeps the contract language-/framework-agnostic — any service that
 * speaks this JSON shape works (Presidio, custom spaCy, AWS Comprehend wrapper,
 * Google DLP, etc.).
 *
 * Resilience:
 *   - Per-request timeout (configurable, default 3 s).
 *   - Circuit breaker (configurable failure threshold + reset window).
 *   - Signals failure by THROWING (HTTP error, network error, open circuit) so
 *     the registry's fail-mode governs the outcome — fail-open skips this
 *     detector, fail-closed blocks the request. A successful call that finds
 *     nothing returns [].
 *   - Treats the response as UNTRUSTED: spans with out-of-range or inverted
 *     offsets are dropped rather than allowed to corrupt tokenization.
 *
 * Trust boundary note: the raw text is sent to this external service. This
 * should ONLY be an in-cluster, operator-controlled service — never an
 * internet-facing third party. Document this in deployment guidance.
 *
 * Priority: 30 (lowest — external, higher latency, less auditable).
 *
 * No `any` at module boundaries.
 */

import type { PiiDetector } from "./pii-detector.js";
import type { PiiMatch, PiiType } from "./output-guardrails.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RemotePiiDetectorConfig {
  /** Base URL of the remote PII detection service (required). */
  endpoint: string;
  /** Optional API key / bearer token for authentication. */
  apiKey?: string;
  /** Per-request timeout in ms. Default: 3000. */
  timeoutMs?: number;
  /** Language hint sent to the service. Default: "de". */
  language?: string;
  /** Circuit breaker: consecutive failures before opening. Default: 5. */
  circuitBreakerThreshold?: number;
  /** Circuit breaker: ms to wait before half-open probe. Default: 30000. */
  circuitBreakerResetMs?: number;
  /** Optional logger for diagnostics. */
  logger?: Logger;
  /** Human-readable name suffix for provenance tagging (e.g. "presidio"). */
  serviceName?: string;
}

// ---------------------------------------------------------------------------
// Response schema (from external service)
// ---------------------------------------------------------------------------

interface RemoteMatch {
  type: string;
  value: string;
  start: number;
  end: number;
  score?: number;
}

interface RemoteResponse {
  matches?: RemoteMatch[];
}

// ---------------------------------------------------------------------------
// Circuit breaker (minimal, in-process)
// ---------------------------------------------------------------------------

type CircuitState = "closed" | "open" | "half-open";

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private lastFailureMs = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  isOpen(): boolean {
    if (this.state === "closed") return false;
    if (this.state === "open") {
      // Check if reset window elapsed → transition to half-open.
      if (Date.now() - this.lastFailureMs >= this.resetMs) {
        this.state = "half-open";
        return false;
      }
      return true;
    }
    // half-open — allow one probe.
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureMs = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "open";
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Detector implementation
// ---------------------------------------------------------------------------

/**
 * Calls an external REST service for PII detection. Resilient (timeout +
 * circuit breaker), never throws, logs failures internally.
 */
export class RemotePiiDetector implements PiiDetector {
  readonly name: string;
  readonly priority = 30;

  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly language: string;
  private readonly logger?: Logger;
  private readonly breaker: CircuitBreaker;

  constructor(config: RemotePiiDetectorConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 3_000;
    this.language = config.language ?? "de";
    this.logger = config.logger;
    this.name = `remote:${config.serviceName ?? new URL(this.endpoint).hostname}`;
    this.breaker = new CircuitBreaker(
      config.circuitBreakerThreshold ?? 5,
      config.circuitBreakerResetMs ?? 30_000,
    );
  }

  async detect(text: string, types?: readonly PiiType[]): Promise<PiiMatch[]> {
    // An open circuit is a failure signal: the service has been failing, so we
    // throw (rather than silently returning []) to let the registry's fail-mode
    // decide — fail-open skips this detector, fail-closed blocks the request.
    if (this.breaker.isOpen()) {
      this.logger?.debug("Remote PII detector circuit is open", {
        detector: this.name,
      });
      throw new Error(`Remote PII detector circuit open (${this.name})`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = JSON.stringify({
        text,
        language: this.language,
        ...(types !== undefined && types.length > 0 ? { types } : {}),
      });

      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (this.apiKey !== undefined) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Remote PII service returned HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data = (await response.json()) as RemoteResponse;
      this.breaker.recordSuccess();

      return this.mapResponse(data, text, types);
    } catch (err) {
      this.breaker.recordFailure();
      this.logger?.warn("Remote PII detection failed", {
        detector: this.name,
        circuitState: this.breaker.getState(),
        error: err instanceof Error ? err.message : String(err),
      });
      // Re-throw so the registry's fail-mode governs the outcome (fail-open
      // skips this detector; fail-closed blocks). Never silently drop.
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ── Response mapping ──────────────────────────────────────────────────────

  private mapResponse(
    data: RemoteResponse,
    text: string,
    types?: readonly PiiType[],
  ): PiiMatch[] {
    if (!Array.isArray(data.matches)) return [];

    const typeFilter =
      types !== undefined && types.length > 0 ? new Set(types) : undefined;
    const matches: PiiMatch[] = [];

    for (const m of data.matches) {
      const piiType = m.type as PiiType;
      if (typeFilter !== undefined && !typeFilter.has(piiType)) continue;
      // The response is untrusted: drop spans with non-integer, inverted, or
      // out-of-range offsets rather than letting them corrupt the cursor-based
      // tokenization (or, worse, leave real PII in place while claiming a span).
      if (
        !Number.isInteger(m.start) ||
        !Number.isInteger(m.end) ||
        m.start < 0 ||
        m.end <= m.start ||
        m.end > text.length
      ) {
        this.logger?.warn("Dropping remote PII span with invalid offsets", {
          detector: this.name,
          start: m.start,
          end: m.end,
          textLength: text.length,
        });
        continue;
      }
      // Use the actual sliced text as the stored value (not the detector's
      // reported `value`) so the detokenize round-trip restores EXACTLY what
      // was removed, regardless of any normalization the service applied.
      matches.push({
        type: piiType,
        value: text.slice(m.start, m.end),
        start: m.start,
        end: m.end,
      });
    }

    return matches;
  }
}
