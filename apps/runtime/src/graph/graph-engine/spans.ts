// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graph Engine — OTel Span Instrumentation per Node Transition
 *
 * Encapsulates OpenTelemetry span lifecycle management for graph engine
 * executions. Each flow execution receives a parent span, and every node
 * transition creates a child span with relevant attributes.
 *
 */

import type { Tracer, Span, SpanContext } from "../../observability/tracing.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlowSpanOptions {
  flowId: string;
  executionId: string;
  tenantId?: string;
  /** Incoming trace context (e.g. from W3C traceparent) for parent linking. */
  parentContext?: SpanContext;
}

export interface NodeSpanAttributes {
  /** Latency of the node execution in milliseconds. */
  latencyMs?: number;
  /** GenAI or custom attributes set during node execution. */
  [key: string]: string | number | boolean | undefined;
}

// ---------------------------------------------------------------------------
// FlowSpanManager
// ---------------------------------------------------------------------------

/**
 * Manages the span hierarchy for a single flow execution:
 *   flow span (root or child of caller trace)
 *     └── node span per node transition
 *
 * Usage:
 *   const mgr = createFlowSpanManager(tracer, opts);
 *   mgr.startNodeSpan(nodeId);           // on node entry
 *   mgr.getNodeSpan(nodeId);             // access mid-execution
 *   mgr.endNodeSpan(nodeId, "ok");       // on success
 *   mgr.endNodeSpan(nodeId, "error", m); // on failure
 *   mgr.endFlow("ok");                   // on flow completion
 */
export interface FlowSpanManager {
  /** The top-level flow span's context for child propagation. */
  readonly flowSpanContext: SpanContext;

  /** Starts a child span for a node transition. */
  startNodeSpan(
    nodeId: string,
    attributes?: Record<string, string | number | boolean>,
  ): Span;

  /** Retrieves an active node span (or undefined if not started / already ended). */
  getNodeSpan(nodeId: string): Span | undefined;

  /**
   * Ends a node span with a status and optional error message.
   * Also records additional attributes (e.g. latency) before ending.
   */
  endNodeSpan(
    nodeId: string,
    status: "ok" | "error",
    errorMessage?: string,
    attributes?: NodeSpanAttributes,
  ): void;

  /** Records an exception on the flow span (e.g. unhandled execution error). */
  recordFlowException(err: unknown): void;

  /**
   * Ends the flow span. Automatically ends any dangling node spans.
   * @param status - "ok" or "error"
   */
  endFlow(status: "ok" | "error", statusMessage?: string): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class FlowSpanManagerImpl implements FlowSpanManager {
  private readonly flowSpan: Span;
  private readonly nodeSpans = new Map<string, Span>();
  private readonly tracer: Tracer;
  private readonly flowId: string;
  private ended = false;

  constructor(tracer: Tracer, opts: FlowSpanOptions) {
    this.tracer = tracer;
    this.flowId = opts.flowId;
    this.flowSpan = tracer.startSpan(`flow ${opts.flowId}`, {
      kind: "internal",
      ...(opts.parentContext !== undefined
        ? { parent: opts.parentContext }
        : {}),
      attributes: {
        "aiperator.flow_id": opts.flowId,
        "aiperator.execution_id": opts.executionId,
        ...(opts.tenantId !== undefined
          ? { "aiperator.tenant_id": opts.tenantId }
          : {}),
      },
    });
  }

  get flowSpanContext(): SpanContext {
    return this.flowSpan.spanContext();
  }

  startNodeSpan(
    nodeId: string,
    attributes?: Record<string, string | number | boolean>,
  ): Span {
    const span = this.tracer.startSpan(`node ${nodeId}`, {
      kind: "internal",
      parent: this.flowSpan.spanContext(),
      attributes: {
        "aiperator.flow_id": this.flowId,
        "aiperator.node_id": nodeId,
        ...(attributes ?? {}),
      },
    });
    this.nodeSpans.set(nodeId, span);
    return span;
  }

  getNodeSpan(nodeId: string): Span | undefined {
    return this.nodeSpans.get(nodeId);
  }

  endNodeSpan(
    nodeId: string,
    status: "ok" | "error",
    errorMessage?: string,
    attributes?: NodeSpanAttributes,
  ): void {
    const span = this.nodeSpans.get(nodeId);
    if (span === undefined) return;

    if (attributes !== undefined) {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) {
          span.setAttribute(key, value);
        }
      }
    }

    if (status === "error") {
      span.setStatus("error", errorMessage);
    } else {
      span.setStatus("ok");
    }

    span.end();
    this.nodeSpans.delete(nodeId);
  }

  recordFlowException(err: unknown): void {
    this.flowSpan.recordException(err);
  }

  endFlow(status: "ok" | "error", statusMessage?: string): void {
    if (this.ended) return;
    this.ended = true;

    // End any dangling node spans (e.g. nodes that weren't properly closed).
    for (const span of Array.from(this.nodeSpans.values())) {
      span.end();
    }
    this.nodeSpans.clear();

    this.flowSpan.setStatus(status, statusMessage).end();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a {@link FlowSpanManager} for instrumenting a single flow execution.
 *
 * When the tracer is disabled (no-op), spans are still created as no-ops and
 * the API remains identical — zero-cost abstraction on the hot path.
 */
export function createFlowSpanManager(
  tracer: Tracer,
  opts: FlowSpanOptions,
): FlowSpanManager {
  return new FlowSpanManagerImpl(tracer, opts);
}
