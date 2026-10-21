# @atf/observability

Package `1.0.0`. The shared tracing implementation of the ATF services. It is dependency-free
and OpenTelemetry-compatible: W3C Trace Context identifiers, spans with attributes, status and
exceptions, and a batching exporter that sends OTLP/HTTP JSON to an OpenTelemetry collector (or
any OTLP/HTTP endpoint) through `fetch`. It avoids the full OTel SDK, which brings a large
dependency tree and patches globals.

With tracing disabled (the default) every operation is a cheap no-op, so the hot path pays
nothing unless an operator opts in.

## Exports

| Export | Purpose |
| --- | --- |
| `createTracer(config, logger?, factoryOptions?)` | Returns the batching tracer when `config.tracingEnabled === true`, otherwise the no-op tracer |
| `NOOP_TRACER` | Shared no-op tracer; its spans still carry valid ids so context can propagate |
| `parseTraceparent`, `formatTraceparent` | Read and write the W3C `traceparent` header (`00-<trace32>-<span16>-<flags2>`); malformed or all-zero values parse to `undefined` |
| `generateTraceId`, `generateSpanId` | 16-byte and 8-byte random hex ids |
| `Tracer`, `Span`, `SpanContext`, `SpanKind`, `SpanStatus`, `AttributeValue`, `StartSpanOptions` | Tracing types |
| `TracingConfig`, `TracerFactoryOptions`, `TracerOptions`, `TracerLogger` | Configuration and logger types |

## Behaviour

- `tracer.startSpan(name, { kind, parent, attributes })` starts a root trace unless `parent` is
  given. A `Span` offers `setAttribute(s)`, `setStatus`, `recordException`, `updateName` (used to
  rename a request span to its route template) and an idempotent `end()`.
- Finished spans are buffered and exported when `maxBatch` (default 256) is reached or every
  `flushIntervalMs` (default 5000 ms). `flush()` and `shutdown()` drain the buffer.
- `TracingConfig` is `{ tracingEnabled, otelExporterOtlpEndpoint, otelServiceName }`. Services map
  their `TRACING_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` settings onto it.
- Services behind an egress guard pass their guard-wrapped `fetch` as `fetchFn`, so the export
  keeps the service's SSRF posture.

## Usage

```ts
import { createTracer, formatTraceparent, parseTraceparent } from "@atf/observability";

const tracer = createTracer(
  {
    tracingEnabled: true,
    otelExporterOtlpEndpoint: "http://collector.example.test:4318/v1/traces",
    otelServiceName: "example-service",
  },
  logger,
);

const parent = parseTraceparent(req.headers.traceparent);
const span = tracer.startSpan("GET /items", { kind: "server", ...(parent ? { parent } : {}) });
try {
  // ... work ...
  span.setStatus("ok");
} catch (err) {
  span.recordException(err);
  span.setStatus("error");
  throw err;
} finally {
  span.end();
}
const outgoing = formatTraceparent(span.spanContext());
```

## Compatibility

Imported by `apps/runtime`, `apps/search` and `apps/extract`. The wire format is OTLP/HTTP JSON
and the propagation format is W3C Trace Context.

## Tests

```bash
bun run --filter @atf/observability test
```
