// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, it } from "bun:test";
import { withSpan, isTracingEnabled, initTracing, shutdownTracing } from "../../src/observability/tracing.ts";
import { TracingConfigSchema } from "../../src/config/schema.ts";

afterEach(async () => {
  await shutdownTracing();
});

describe("tracing · disabled (default)", () => {
  it("withSpan is a transparent passthrough when tracing was never initialised", async () => {
    expect(isTracingEnabled()).toBe(false);
    const result = await withSpan("test.span", { foo: "bar" }, async () => 42);
    expect(result).toBe(42);
  });

  it("withSpan propagates a thrown error unchanged", async () => {
    await expect(
      withSpan("test.span", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("initTracing is a no-op when tracing.enabled is false", async () => {
    await initTracing(TracingConfigSchema.parse({ enabled: false }));
    expect(isTracingEnabled()).toBe(false);
  });
});

describe("tracing · enabled (optional @opentelemetry/* packages present)", () => {
  it("initialises a tracer without an otlpEndpoint (spans created, not exported)", async () => {
    await initTracing(TracingConfigSchema.parse({ enabled: true, serviceName: "test" }));
    expect(isTracingEnabled()).toBe(true);
    // withSpan should still run the function and return its result.
    const result = await withSpan("test.span", { foo: "bar" }, async () => 42);
    expect(result).toBe(42);
  });
});
