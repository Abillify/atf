// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Distributed Tracing (`src/observability/tracing.ts`)
 *
 * A dependency-free, OpenTelemetry-compatible tracer. It produces W3C Trace
 * Context IDs, builds spans with attributes/status/events, and exports them in
 * the OTLP/HTTP JSON format to an OpenTelemetry collector (or any OTLP/HTTP
 * endpoint) via `fetch`. This gives end-to-end distributed traces across the
 * caller → platform → flow → node → downstream chain without pulling the full
 * OTel SDK (which is awkward under Bun).
 *
 * Why not @opentelemetry/sdk-node? The SDK adds a large dependency tree and
 * monkey-patches globals; for a focused export of our own spans the OTLP/HTTP
 * JSON wire format is small and stable, and works cleanly on Bun's runtime.
 *
 * When tracing is disabled (default) every operation is a cheap no-op, so there
 * is zero overhead on the hot path unless an operator opts in.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Logger } from "./logger.js";
import { egressFetch } from "../security/egress.js";

// ---------------------------------------------------------------------------
// W3C Trace Context helpers
// ---------------------------------------------------------------------------

export interface SpanContext {
  traceId: string; // 16 bytes hex (32 chars)
  spanId: string; // 8 bytes hex (16 chars)
  sampled: boolean;
}

export function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Parses a W3C `traceparent` header (`00-<trace32>-<span16>-<flags2>`).
 * Returns undefined when the value is missing or malformed.
 */
export function parseTraceparent(
  value: string | undefined | null,
): SpanContext | undefined {
  if (!value) return undefined;
  const parts = value.trim().split("-");
  if (parts.length !== 4) return undefined;
  const [version, traceId, spanId, flags] = parts;
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    flags === undefined
  ) {
    return undefined; // unreachable given the length check above
  }
  if (version !== "00") return undefined;
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return undefined;
  if (!/^[0-9a-f]{16}$/i.test(spanId)) return undefined;
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return undefined;
  const sampled = ((parseInt(flags, 16) || 0) & 0x01) === 0x01;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    sampled,
  };
}

/** Formats a SpanContext as a W3C `traceparent` header value. */
export function formatTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------

export type SpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";
export type SpanStatus = "unset" | "ok" | "error";
export type AttributeValue = string | number | boolean;

export interface Span {
  /** This span's context (for child propagation / header injection). */
  spanContext(): SpanContext;
  setAttribute(key: string, value: AttributeValue): this;
  setAttributes(attrs: Record<string, AttributeValue>): this;
  setStatus(status: SpanStatus, message?: string): this;
  recordException(err: unknown): this;
  /** Ends the span and queues it for export. Idempotent. */
  end(): void;
}

interface FinishedSpan {
  name: string;
  kind: SpanKind;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startUnixNano: string;
  endUnixNano: string;
  attributes: Record<string, AttributeValue>;
  status: SpanStatus;
  statusMessage?: string;
}

function nowUnixNano(): bigint {
  // Millisecond precision is sufficient; convert to ns for OTLP.
  return BigInt(Date.now()) * 1_000_000n;
}

class NoopSpan implements Span {
  constructor(private readonly ctx: SpanContext) {}
  spanContext(): SpanContext {
    return this.ctx;
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  setStatus(): this {
    return this;
  }
  recordException(): this {
    return this;
  }
  end(): void {
    /* no-op */
  }
}

class RealSpan implements Span {
  private readonly ctx: SpanContext;
  private readonly parentSpanId?: string;
  private readonly startNano: bigint;
  private readonly attributes: Record<string, AttributeValue> = {};
  private status: SpanStatus = "unset";
  private statusMessage?: string;
  private ended = false;

  constructor(
    private readonly name: string,
    private readonly kind: SpanKind,
    ctx: SpanContext,
    parentSpanId: string | undefined,
    attributes: Record<string, AttributeValue>,
    private readonly onEnd: (span: FinishedSpan) => void,
  ) {
    this.ctx = ctx;
    this.parentSpanId = parentSpanId;
    this.startNano = nowUnixNano();
    Object.assign(this.attributes, attributes);
  }

  spanContext(): SpanContext {
    return this.ctx;
  }
  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: Record<string, AttributeValue>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }
  setStatus(status: SpanStatus, message?: string): this {
    this.status = status;
    if (message !== undefined) this.statusMessage = message;
    return this;
  }
  recordException(err: unknown): this {
    const message = err instanceof Error ? err.message : String(err);
    this.attributes["exception.message"] = message;
    if (err instanceof Error && err.stack)
      this.attributes["exception.stacktrace"] = err.stack;
    this.status = "error";
    this.statusMessage = message;
    return this;
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    const finished: FinishedSpan = {
      name: this.name,
      kind: this.kind,
      traceId: this.ctx.traceId,
      spanId: this.ctx.spanId,
      startUnixNano: this.startNano.toString(),
      endUnixNano: nowUnixNano().toString(),
      attributes: this.attributes,
      status: this.status,
    };
    if (this.parentSpanId !== undefined)
      finished.parentSpanId = this.parentSpanId;
    if (this.statusMessage !== undefined)
      finished.statusMessage = this.statusMessage;
    this.onEnd(finished);
  }
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface StartSpanOptions {
  kind?: SpanKind;
  /** Parent context — when omitted a new root trace is started. */
  parent?: SpanContext;
  attributes?: Record<string, AttributeValue>;
}

export interface Tracer {
  /** True when spans are recorded and exported. */
  readonly enabled: boolean;
  /** Starts a span. Returns a no-op span when tracing is disabled. */
  startSpan(name: string, opts?: StartSpanOptions): Span;
  /** Flushes any buffered spans to the exporter. */
  flush(): Promise<void>;
  /** Stops the tracer (flushes + clears timers). */
  shutdown(): Promise<void>;
}

class NoopTracer implements Tracer {
  readonly enabled = false;
  startSpan(_name: string, opts?: StartSpanOptions): Span {
    const parent = opts?.parent;
    return new NoopSpan({
      traceId: parent?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      sampled: parent?.sampled ?? false,
    });
  }
  async flush(): Promise<void> {
    /* no-op */
  }
  async shutdown(): Promise<void> {
    /* no-op */
  }
}

export interface TracerOptions {
  serviceName: string;
  /** OTLP/HTTP traces endpoint, e.g. http://collector:4318/v1/traces. */
  endpoint?: string;
  /** Max spans buffered before a flush is triggered. Default 256. */
  maxBatch?: number;
  /** Max ms between flushes. Default 5000. */
  flushIntervalMs?: number;
  /**
   * Outbound fetch for OTLP export. Defaults to the process-wide
   * Egress_Guard (SSRF-safe); tests may inject a stub.
   */
  fetchFn?: typeof fetch;
  logger?: Logger;
}

class BatchingTracer implements Tracer {
  readonly enabled = true;
  private buffer: FinishedSpan[] = [];
  private readonly maxBatch: number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: TracerOptions) {
    this.maxBatch = opts.maxBatch ?? 256;
    const interval = opts.flushIntervalMs ?? 5000;
    this.timer = setInterval(() => {
      void this.flush();
    }, interval);
    // Don't keep the event loop alive solely for span flushing.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  startSpan(name: string, opts?: StartSpanOptions): Span {
    const parent = opts?.parent;
    const ctx: SpanContext = {
      traceId: parent?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      sampled: parent?.sampled ?? true,
    };
    return new RealSpan(
      name,
      opts?.kind ?? "internal",
      ctx,
      parent?.spanId,
      opts?.attributes ?? {},
      (span) => this.enqueue(span),
    );
  }

  private enqueue(span: FinishedSpan): void {
    this.buffer.push(span);
    if (this.buffer.length >= this.maxBatch) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    if (this.opts.endpoint === undefined) {
      // No exporter configured — emit a compact debug line per span so traces
      // are still observable in logs.
      for (const s of batch) {
        this.opts.logger?.debug("span", {
          name: s.name,
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId,
          status: s.status,
          durationMs:
            Number(BigInt(s.endUnixNano) - BigInt(s.startUnixNano)) / 1_000_000,
        });
      }
      return;
    }

    try {
      const payload = this.toOtlp(batch);
      const res = await (this.opts.fetchFn ?? egressFetch)(this.opts.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.opts.logger?.warn("OTLP trace export failed", {
          status: res.status,
          spans: batch.length,
        });
      }
    } catch (err) {
      this.opts.logger?.warn("OTLP trace export error", {
        error: err instanceof Error ? err.message : String(err),
        spans: batch.length,
      });
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  /** Builds an OTLP/HTTP JSON ExportTraceServiceRequest from finished spans. */
  private toOtlp(spans: FinishedSpan[]): Record<string, unknown> {
    const kindMap: Record<SpanKind, number> = {
      internal: 1,
      server: 2,
      client: 3,
      producer: 4,
      consumer: 5,
    };
    const statusMap: Record<SpanStatus, number> = { unset: 0, ok: 1, error: 2 };

    const toAttrs = (attrs: Record<string, AttributeValue>) =>
      Object.entries(attrs).map(([key, value]) => {
        let v: Record<string, unknown>;
        if (typeof value === "number") {
          v = Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value };
        } else if (typeof value === "boolean") {
          v = { boolValue: value };
        } else {
          v = { stringValue: value };
        }
        return { key, value: v };
      });

    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: this.opts.serviceName },
              },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "aiperator", version: "1.0.0" },
              spans: spans.map((s) => {
                const span: Record<string, unknown> = {
                  traceId: s.traceId,
                  spanId: s.spanId,
                  name: s.name,
                  kind: kindMap[s.kind],
                  startTimeUnixNano: s.startUnixNano,
                  endTimeUnixNano: s.endUnixNano,
                  attributes: toAttrs(s.attributes),
                  status: {
                    code: statusMap[s.status],
                    ...(s.statusMessage !== undefined
                      ? { message: s.statusMessage }
                      : {}),
                  },
                };
                if (s.parentSpanId !== undefined)
                  span.parentSpanId = s.parentSpanId;
                return span;
              }),
            },
          ],
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface TracingConfig {
  tracingEnabled?: boolean;
  otelExporterOtlpEndpoint?: string;
  otelServiceName?: string;
}

/**
 * Creates a tracer. Returns a {@link NoopTracer} when tracing is disabled so
 * the hot path pays nothing.
 */
export function createTracer(config: TracingConfig, logger?: Logger): Tracer {
  if (config.tracingEnabled !== true) return new NoopTracer();
  const opts: TracerOptions = {
    serviceName: config.otelServiceName ?? "aiperator",
    ...(config.otelExporterOtlpEndpoint !== undefined
      ? { endpoint: config.otelExporterOtlpEndpoint }
      : {}),
    ...(logger !== undefined ? { logger } : {}),
  };
  return new BatchingTracer(opts);
}

export const NOOP_TRACER: Tracer = new NoopTracer();
