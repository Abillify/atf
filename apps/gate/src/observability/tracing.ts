// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { TracingConfig } from "../config/schema.ts";
import { logger } from "../logger.ts";

/**
 * Optional OpenTelemetry tracing.
 *
 * Entirely opt-in and zero-overhead when disabled: `withSpan()` is a plain
 * passthrough unless `tracing.enabled` is true AND the optional
 * `@opentelemetry/*` packages are installed. No hard dependency is added to
 * package.json - the packages are lazily `import()`-ed only when tracing is
 * turned on, exactly like the optional redis integrations for rate limiting.
 *
 * Spans are emitted around:
 *   - MCP tool calls (src/mcp/server.ts)
 *   - database queries (src/tools/database-tool.ts)
 *   - outbound HTTP / downstream MCP proxy calls (src/tools/http-tool.ts,
 *     src/tools/mcp-proxy-tool.ts)
 */

interface MinimalSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(err: unknown): void;
  end(): void;
}

interface MinimalTracer {
  startActiveSpan<T>(name: string, fn: (span: MinimalSpan) => Promise<T> | T): Promise<T> | T;
}

let tracer: MinimalTracer | undefined;
let shutdownFn: (() => Promise<void>) | undefined;

/** SpanStatusCode.ERROR value, hardcoded to avoid an unconditional @opentelemetry/api import. */
const ERROR_STATUS_CODE = 2;

/**
 * Initialise tracing from config. Safe to call even when tracing is disabled
 * (returns immediately) or the optional packages are missing (logs a warning
 * and leaves tracing as a no-op). Idempotent per-process.
 */
export async function initTracing(config: TracingConfig): Promise<void> {
  if (!config.enabled) return;

  try {
    // Variable specifiers keep these optional packages out of the static
    // dependency graph, so typecheck/build never require them to be present
    // (mirrors the pattern used for the optional redis integrations).
    const apiName = "@opentelemetry/api";
    // biome-ignore lint/suspicious/noExplicitAny: optional module loaded dynamically, no static types available
    const api = (await import(apiName)) as any;

    if (config.otlpEndpoint) {
      const sdkTraceNodeName = "@opentelemetry/sdk-trace-node";
      const sdkTraceBaseName = "@opentelemetry/sdk-trace-base";
      const exporterName = "@opentelemetry/exporter-trace-otlp-http";
      const resourcesName = "@opentelemetry/resources";
      const semconvName = "@opentelemetry/semantic-conventions";
      // biome-ignore lint/suspicious/noExplicitAny: optional modules loaded dynamically, no static types available
      const [nodeTrace, traceBase, exporterMod, resourcesMod, semconv]: any[] =
        await Promise.all([
          import(sdkTraceNodeName),
          import(sdkTraceBaseName),
          import(exporterName),
          import(resourcesName),
          import(semconvName),
        ]);

      const provider = new nodeTrace.NodeTracerProvider({
        resource: new resourcesMod.Resource({
          [semconv.ATTR_SERVICE_NAME ?? "service.name"]: config.serviceName,
        }),
      });
      const exporter = new exporterMod.OTLPTraceExporter({
        url: `${config.otlpEndpoint.replace(/\/$/, "")}/v1/traces`,
      });
      provider.addSpanProcessor(new traceBase.BatchSpanProcessor(exporter));
      provider.register();
      shutdownFn = () => provider.shutdown();
      logger.info(`tracing enabled (OTLP exporter -> ${config.otlpEndpoint})`);
    } else {
      logger.info(
        "tracing enabled (no otlpEndpoint set - spans are created but not exported)",
      );
    }

    tracer = api.trace.getTracer(config.serviceName) as MinimalTracer;
  } catch (_err) {
    tracer = {
      startActiveSpan: async <T>(
        _name: string,
        fn: (span: MinimalSpan) => Promise<T> | T,
      ): Promise<T> =>
        fn({
          setAttribute() {},
          setStatus() {},
          recordException() {},
          end() {},
        }),
    };
  }
}

/** Flush and release exporter resources on shutdown. No-op when tracing was never initialised. */
export async function shutdownTracing(): Promise<void> {
  await shutdownFn?.();
  tracer = undefined;
  shutdownFn = undefined;
}

/**
 * Run `fn` inside a span named `name`. A complete passthrough (no span, no
 * overhead beyond one boolean check) when tracing is disabled/unavailable.
 * Records thrown errors on the span and re-throws them unchanged.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) return fn();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [k, v] of Object.entries(attributes)) span.setAttribute(k, v);
      const result = await fn();
      span.end();
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: ERROR_STATUS_CODE, message: err instanceof Error ? err.message : String(err) });
      span.end();
      throw err;
    }
  });
}

/** Whether tracing is currently active (for tests / diagnostics). */
export function isTracingEnabled(): boolean {
  return tracer !== undefined;
}
