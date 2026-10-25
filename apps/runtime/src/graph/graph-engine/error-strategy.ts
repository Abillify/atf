// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graph Engine — Error Strategy (Req. 5.2)
 *
 * Encapsulates node error handling within the graph execution loop.
 * Each node runs wrapped; on error the error is logged with OTel span context
 * and the execution continues or terminates according to the configured
 * strategy: continue | fail-fast | fallback.
 *
 * Semaphore overflow (Req. 5.3) is normalised to a well-defined error code
 * (503 SERVICE_UNAVAILABLE / QUEUE_FULL) rather than propagating as an opaque
 * internal error.
 *
 */

import type { FlowSpanManager } from "./spans.js";
import { QueueFullError, AcquireTimeoutError } from "../semaphore.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configurable strategies for handling node execution errors. */
export type ErrorStrategy = "continue" | "fail-fast" | "fallback";

/**
 * Configuration for a node's error handling behaviour.
 */
export interface NodeErrorConfig {
  /** How to react when the node throws. Default: "fail-fast". */
  strategy: ErrorStrategy;
  /**
   * Optional fallback node ID to execute when strategy is "fallback".
   * If undefined and strategy is "fallback", behaviour degrades to "continue".
   */
  fallbackNodeId?: string;
}

/**
 * Represents a captured node error that was not propagated (strategy != fail-fast).
 */
export interface CapturedNodeError {
  nodeId: string;
  error: Error;
  timestamp: string;
  strategy: ErrorStrategy;
}

/**
 * Well-defined error for semaphore/queue overflow (Req. 5.3).
 * Consumers (e.g. HTTP handlers) can map this to HTTP 503.
 */
export class QueueOverflowError extends Error {
  public readonly code = "QUEUE_FULL" as const;
  public readonly httpStatus = 503 as const;
  /** Suggested `Retry-After` value, so the transport need not invent one. */
  public readonly retryAfterSeconds = 5 as const;

  constructor(
    public readonly maxQueueDepth: number,
    cause?: unknown,
  ) {
    super(
      `Service temporarily unavailable: concurrency queue is full (max ${maxQueueDepth} waiting).`,
    );
    this.name = "QueueOverflowError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// NodeErrorHandler
// ---------------------------------------------------------------------------

/**
 * Result of handling a node error via the error strategy.
 */
export type ErrorHandlingResult =
  | { action: "continue"; captured: CapturedNodeError }
  | { action: "fallback"; captured: CapturedNodeError; fallbackNodeId: string }
  | { action: "propagate" }; // fail-fast: caller should re-throw

/**
 * Handles node execution errors according to the configured strategy.
 *
 * Usage:
 *   const handler = createNodeErrorHandler(spanManager);
 *   try {
 *     await executeNode(nodeId);
 *   } catch (err) {
 *     const result = handler.handle(nodeId, err, config);
 *     if (result.action === "propagate") throw err;
 *     // else: captured, continue or fallback
 *   }
 */
export interface NodeErrorHandler {
  /**
   * Processes a node error: logs with span context, then decides based on
   * the configured strategy whether to continue, fallback, or propagate.
   */
  handle(
    nodeId: string,
    error: unknown,
    config: NodeErrorConfig,
  ): ErrorHandlingResult;

  /** All captured (non-propagated) errors so far. */
  readonly capturedErrors: ReadonlyArray<CapturedNodeError>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class NodeErrorHandlerImpl implements NodeErrorHandler {
  private readonly errors: CapturedNodeError[] = [];

  constructor(private readonly spanManager: FlowSpanManager) {}

  get capturedErrors(): ReadonlyArray<CapturedNodeError> {
    return this.errors;
  }

  handle(
    nodeId: string,
    error: unknown,
    config: NodeErrorConfig,
  ): ErrorHandlingResult {
    const normalised = this.normaliseError(error);

    // Log with span context — end the node span as error.
    this.spanManager.endNodeSpan(nodeId, "error", normalised.message);

    const { strategy } = config;

    if (strategy === "fail-fast") {
      // Propagate immediately — caller re-throws.
      return { action: "propagate" };
    }

    const captured: CapturedNodeError = {
      nodeId,
      error: normalised,
      timestamp: new Date().toISOString(),
      strategy,
    };
    this.errors.push(captured);

    if (strategy === "fallback" && config.fallbackNodeId !== undefined) {
      return {
        action: "fallback",
        captured,
        fallbackNodeId: config.fallbackNodeId,
      };
    }

    // "continue" or "fallback" without a configured fallback → continue.
    return { action: "continue", captured };
  }

  /**
   * Normalises unknown throw values to proper Error instances.
   */
  private normaliseError(err: unknown): Error {
    if (err instanceof Error) return err;
    return new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a {@link NodeErrorHandler} bound to the given span manager for
 * span-context-aware error logging.
 */
export function createNodeErrorHandler(
  spanManager: FlowSpanManager,
): NodeErrorHandler {
  return new NodeErrorHandlerImpl(spanManager);
}

// ---------------------------------------------------------------------------
// Semaphore Overflow Normalisation (Req. 5.3)
// ---------------------------------------------------------------------------

/**
 * Normalises a QueueFullError from the semaphore into a well-defined
 * {@link QueueOverflowError} with HTTP status code and error code.
 *
 * If the error is NOT a QueueFullError, returns it unchanged.
 *
 * Usage in the execution path:
 *   try { await semaphore.acquire(); }
 *   catch (err) { throw normaliseSemaphoreError(err); }
 */
export function normaliseSemaphoreError(err: unknown): unknown {
  if (err instanceof QueueFullError) {
    return new QueueOverflowError(err.maxQueueDepth, err);
  }
  // A caller that queued but never reached the front is the same condition from
  // the client's point of view — the server is saturated — so it maps to the
  // same 503 rather than escaping as an opaque internal error.
  if (err instanceof AcquireTimeoutError) {
    return new QueueOverflowError(0, err);
  }
  return err;
}

/**
 * Resolves the error strategy for a given node from its config.
 * Falls back to "fail-fast" (safe default) if not specified.
 */
export function resolveNodeErrorConfig(
  nodeConfig?: Record<string, unknown>,
): NodeErrorConfig {
  const raw = nodeConfig?.errorStrategy;
  let strategy: ErrorStrategy = "fail-fast";

  if (raw === "continue" || raw === "fail-fast" || raw === "fallback") {
    strategy = raw;
  }

  const fallbackNodeId =
    strategy === "fallback" && typeof nodeConfig?.fallbackNodeId === "string"
      ? nodeConfig.fallbackNodeId
      : undefined;

  return { strategy, fallbackNodeId };
}
