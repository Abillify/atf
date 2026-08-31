// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP Wrapper — Property-Based Tests
 *
 * Property 18: Protected Parameter Filtering from Tool Schema
 * Property 19: Protected Parameter Injection on Tool Call
 * Property 20: MCP Retry Behavior
 * Property 21: Schema Checksum Invalidation
 *
 * Validates: Requirements 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 *
 * All four properties test PURE FUNCTIONS extracted from mcp-wrapper.ts so
 * that no real MCP server connection is required.
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  filterSchema,
  injectProtectedParams,
  resolveInjectedParams,
  computeSchemaChecksum,
  withRetry,
} from "../mcp-wrapper.js";
import type { RequestContext } from "../../types/monitoring.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** A single valid parameter-name identifier (non-empty, printable ASCII, no dots). */
const arbitraryParamName = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter(
    (s) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) &&
      s !== "__proto__" &&
      s !== "constructor" &&
      s !== "prototype" &&
      s !== "toString" &&
      s !== "valueOf" &&
      s !== "hasOwnProperty" &&
      s !== "isPrototypeOf" &&
      s !== "propertyIsEnumerable",
  );

/** Generates a non-empty list of unique parameter names. */
const arbitraryUniqueNames = fc.uniqueArray(arbitraryParamName, {
  minLength: 1,
  maxLength: 12,
});

// ---------------------------------------------------------------------------
// Property 18: Protected Parameter Filtering from Tool Schema
// Feature: ai-agent-orchestration-platform, Property 18: Protected Parameter Filtering from Tool Schema
// Validates: Requirements 7.2, 7.3
// ---------------------------------------------------------------------------

describe("Property 18: Protected Parameter Filtering from Tool Schema", () => {
  /**
   * For any tool schema containing one or more configured Protected Parameter
   * names, the filtered schema presented to the LLM must contain none of those
   * parameter names; all other parameters must remain unchanged.
   */
  test("filtered schema contains none of the protected params, all other params unchanged", () => {
    // Feature: ai-agent-orchestration-platform, Property 18: Protected Parameter Filtering from Tool Schema
    fc.assert(
      fc.property(
        // Generate a set of all param names (unique)
        arbitraryUniqueNames,
        // Then split into protected vs normal
        fc.double({ min: 0.1, max: 0.9, noNaN: true }),
        (allNames, splitRatio) => {
          const splitAt = Math.max(1, Math.floor(allNames.length * splitRatio));
          const protectedParams = allNames.slice(0, splitAt);
          const normalParams = allNames.slice(splitAt);

          // Build a schema containing all names
          const properties: Record<string, unknown> = {};
          for (const n of allNames) {
            properties[n] = { type: "string", description: `param ${n}` };
          }
          const required = [...allNames]; // all required initially
          const schema = { type: "object", properties, required };

          const filtered = filterSchema(schema, protectedParams);

          // Protected params must NOT appear in filtered properties
          for (const pp of protectedParams) {
            expect(Object.hasOwn(filtered.properties, pp)).toBe(false);
            if (filtered.required) {
              expect(filtered.required.includes(pp)).toBe(false);
            }
          }

          // Normal params MUST still appear in filtered properties, unchanged
          for (const np of normalParams) {
            expect(Object.hasOwn(filtered.properties, np)).toBe(true);
            expect(filtered.properties[np]).toEqual(properties[np]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("filtered schema with all params protected returns empty properties and no required", () => {
    // Feature: ai-agent-orchestration-platform, Property 18: Protected Parameter Filtering from Tool Schema
    fc.assert(
      fc.property(arbitraryUniqueNames, (names) => {
        const properties: Record<string, unknown> = {};
        for (const n of names) {
          properties[n] = { type: "string" };
        }
        const schema = { type: "object", properties, required: [...names] };
        const filtered = filterSchema(schema, names);

        expect(Object.keys(filtered.properties)).toHaveLength(0);
        expect(filtered.required).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  test("filtered schema with no protected params returns schema unchanged", () => {
    // Feature: ai-agent-orchestration-platform, Property 18: Protected Parameter Filtering from Tool Schema
    fc.assert(
      fc.property(arbitraryUniqueNames, (names) => {
        const properties: Record<string, unknown> = {};
        for (const n of names) {
          properties[n] = { type: "string" };
        }
        const required = names.slice(0, Math.ceil(names.length / 2));
        const schema = { type: "object", properties, required };

        const filtered = filterSchema(schema, []);

        expect(Object.keys(filtered.properties)).toHaveLength(names.length);
        for (const n of names) {
          expect(Object.hasOwn(filtered.properties, n)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19: Protected Parameter Injection on Tool Call
// Feature: ai-agent-orchestration-platform, Property 19: Protected Parameter Injection on Tool Call
// Validates: Requirements 7.4, 7.5
// ---------------------------------------------------------------------------

/** Generate a RequestContext-like object. */
const arbitraryRequestContext = fc.record({
  ssoToken: fc.string({ minLength: 1, maxLength: 64 }),
  executionId: fc.string({ minLength: 1, maxLength: 36 }),
  userEmail: fc.option(fc.emailAddress(), { nil: undefined }),
  clientId: fc.option(fc.string({ minLength: 1, maxLength: 20 }), {
    nil: undefined,
  }),
}) as fc.Arbitrary<RequestContext>;

/** Generate arbitrary tool call args (without protected keys). */
const arbitraryToolArgs = fc.dictionary(
  arbitraryParamName.filter(
    (n) => n !== "user_token" && n !== "user_email" && n !== "client_id",
  ),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { minKeys: 0, maxKeys: 8 },
);

describe("Property 19: Protected Parameter Injection on Tool Call", () => {
  /**
   * For any request context with stored SSO token and metadata, and for any
   * tool call, the actual call sent to the MCP server must have all configured
   * Protected Parameters filled with values from the request context.
   */
  test("injected args always contain user_token from ssoToken", () => {
    // Feature: ai-agent-orchestration-platform, Property 19: Protected Parameter Injection on Tool Call
    fc.assert(
      fc.property(arbitraryToolArgs, arbitraryRequestContext, (args, ctx) => {
        const result = injectProtectedParams(args, ctx);

        // user_token must equal ssoToken
        expect(result.user_token).toBe(ctx.ssoToken);
      }),
      { numRuns: 100 },
    );
  });

  test("injected args contain user_email when userEmail is present in context", () => {
    // Feature: ai-agent-orchestration-platform, Property 19: Protected Parameter Injection on Tool Call
    fc.assert(
      fc.property(
        arbitraryToolArgs,
        fc.record({
          ssoToken: fc.string({ minLength: 1, maxLength: 64 }),
          executionId: fc.string({ minLength: 1 }),
          userEmail: fc.emailAddress(), // always defined here
          clientId: fc.option(fc.string({ minLength: 1, maxLength: 20 }), {
            nil: undefined,
          }),
        }) as fc.Arbitrary<RequestContext>,
        (args, ctx) => {
          const result = injectProtectedParams(args, ctx);
          expect(result.user_email).toBe(ctx.userEmail);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("injected args contain client_id when clientId is present in context", () => {
    // Feature: ai-agent-orchestration-platform, Property 19: Protected Parameter Injection on Tool Call
    fc.assert(
      fc.property(
        arbitraryToolArgs,
        fc.record({
          ssoToken: fc.string({ minLength: 1, maxLength: 64 }),
          executionId: fc.string({ minLength: 1 }),
          userEmail: fc.option(fc.emailAddress(), { nil: undefined }),
          clientId: fc.string({ minLength: 1, maxLength: 20 }), // always defined
        }) as fc.Arbitrary<RequestContext>,
        (args, ctx) => {
          const result = injectProtectedParams(args, ctx);
          expect(result.client_id).toBe(ctx.clientId);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("original args keys are preserved after injection (no keys removed)", () => {
    // Feature: ai-agent-orchestration-platform, Property 19: Protected Parameter Injection on Tool Call
    fc.assert(
      fc.property(arbitraryToolArgs, arbitraryRequestContext, (args, ctx) => {
        const result = injectProtectedParams(args, ctx);

        // All original keys must still be present with unchanged values
        for (const [key, value] of Object.entries(args)) {
          expect(result[key]).toEqual(value);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("injection does not mutate the original args object", () => {
    // Feature: ai-agent-orchestration-platform, Property 19: Protected Parameter Injection on Tool Call
    fc.assert(
      fc.property(arbitraryToolArgs, arbitraryRequestContext, (args, ctx) => {
        const originalKeys = Object.keys(args).sort();
        injectProtectedParams(args, ctx);
        expect(Object.keys(args).sort()).toEqual(originalKeys);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20: MCP Retry Behavior
// Feature: ai-agent-orchestration-platform, Property 20: MCP Retry Behavior
// Validates: Requirements 7.6
// ---------------------------------------------------------------------------

describe("Property 20: MCP Retry Behavior", () => {
  /**
   * For any unreachable MCP server, the MCP Wrapper must return an error after
   * exactly 3 failed connection attempts, with the error containing the server
   * name and attempt count.
   *
   * We test withRetry with a mock that always rejects, verifying:
   * - The promise rejects
   * - The error message contains the serverName
   * - The error message contains the attempt count (3)
   * - The mock is called exactly 3 times
   */
  test("always-failing fn causes rejection after exactly 3 attempts with server name in message", async () => {
    // Feature: ai-agent-orchestration-platform, Property 20: MCP Retry Behavior
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 40 })
          .filter((s) => s.trim().length > 0),
        async (serverName) => {
          let callCount = 0;
          const alwaysFail = async () => {
            callCount = callCount + 1;
            throw new Error("connection refused");
          };

          let caughtError: Error | undefined;
          try {
            await withRetry(alwaysFail, {
              serverName,
              maxAttempts: 3,
              timeoutMs: 100, // short timeout — no need to wait 5s in tests
              delayMs: 0, // no delay in tests
            });
          } catch (err) {
            caughtError = err as Error;
          }

          // Must have thrown
          expect(caughtError).toBeDefined();
          if (caughtError === undefined) throw new Error("expected a caught error");
          // Error message must contain the server name
          expect(caughtError.message).toContain(serverName);
          // Error message must reference the attempt count (3)
          expect(caughtError.message).toContain("3");
          // The function must have been called exactly 3 times
          expect(callCount).toBe(3);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("succeeds on first attempt — fn called exactly once and result returned", async () => {
    // Feature: ai-agent-orchestration-platform, Property 20: MCP Retry Behavior
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (serverName, returnValue) => {
          let callCount = 0;
          const alwaysSucceed = async () => {
            callCount = callCount + 1;
            return returnValue;
          };

          const result = await withRetry(alwaysSucceed, {
            serverName,
            maxAttempts: 3,
            timeoutMs: 100,
            delayMs: 0,
          });

          expect(result).toBe(returnValue);
          expect(callCount).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("succeeds on second attempt — fn called exactly twice", async () => {
    // Feature: ai-agent-orchestration-platform, Property 20: MCP Retry Behavior
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (serverName, returnValue) => {
          let callCount = 0;
          const failOnceThenSucceed = async () => {
            callCount = callCount + 1;
            if (callCount < 2) throw new Error("temporary failure");
            return returnValue;
          };

          const result = await withRetry(failOnceThenSucceed, {
            serverName,
            maxAttempts: 3,
            timeoutMs: 100,
            delayMs: 0,
          });

          expect(result).toBe(returnValue);
          expect(callCount).toBe(2);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 21: Schema Checksum Invalidation
// Feature: ai-agent-orchestration-platform, Property 21: Schema Checksum Invalidation
// Validates: Requirements 7.7
// ---------------------------------------------------------------------------

describe("Property 21: Schema Checksum Invalidation", () => {
  /**
   * For any changed tool schema (new content produces a different checksum),
   * the MCP Wrapper must reload the schema; for unchanged schema, it must use
   * the cache.
   *
   * We test computeSchemaChecksum directly:
   * - Same content → same checksum (cache should be used)
   * - Different content → different checksum (schema should be reloaded)
   */
  test("same schema content always produces the same checksum", () => {
    // Feature: ai-agent-orchestration-platform, Property 21: Schema Checksum Invalidation
    fc.assert(
      fc.property(
        // Generate arbitrary schema objects
        fc.record({
          type: fc.constant("object"),
          properties: fc.dictionary(
            arbitraryParamName,
            fc.record({ type: fc.constantFrom("string", "number", "boolean") }),
            { minKeys: 0, maxKeys: 8 },
          ),
          required: fc.array(arbitraryParamName, { maxLength: 5 }),
        }),
        (schema) => {
          const checksum1 = computeSchemaChecksum(schema);
          const checksum2 = computeSchemaChecksum(schema);

          // Idempotent — same object → same checksum
          expect(checksum1).toBe(checksum2);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("structurally equal but independently created schema objects produce the same checksum", () => {
    // Feature: ai-agent-orchestration-platform, Property 21: Schema Checksum Invalidation
    fc.assert(
      fc.property(
        fc.record({
          type: fc.constant("object"),
          properties: fc.dictionary(
            arbitraryParamName,
            fc.record({ type: fc.constantFrom("string", "number") }),
            { minKeys: 0, maxKeys: 8 },
          ),
        }),
        (schema) => {
          // Deep clone via JSON round-trip (structural equality, different reference)
          const clone = JSON.parse(JSON.stringify(schema)) as typeof schema;

          expect(computeSchemaChecksum(schema)).toBe(
            computeSchemaChecksum(clone),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  test("adding a new property to a schema produces a different checksum", () => {
    // Feature: ai-agent-orchestration-platform, Property 21: Schema Checksum Invalidation
    fc.assert(
      fc.property(
        fc.record({
          type: fc.constant("object"),
          properties: fc.dictionary(
            arbitraryParamName.filter((n) => n !== "new_field"),
            fc.record({ type: fc.constantFrom("string", "number") }),
            { minKeys: 0, maxKeys: 6 },
          ),
        }),
        (schema) => {
          const before = computeSchemaChecksum(schema);

          // Add a new property
          const modified = {
            ...schema,
            properties: {
              ...schema.properties,
              new_field: { type: "string" },
            },
          };
          const after = computeSchemaChecksum(modified);

          expect(before).not.toBe(after);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("removing a property from a schema produces a different checksum", () => {
    // Feature: ai-agent-orchestration-platform, Property 21: Schema Checksum Invalidation
    fc.assert(
      fc.property(
        // Schema must have at least 1 property so we can remove one
        fc.record({
          type: fc.constant("object"),
          properties: fc.dictionary(
            arbitraryParamName,
            fc.record({ type: fc.constantFrom("string", "number") }),
            { minKeys: 2, maxKeys: 8 }, // at least 2 so removing 1 still leaves a schema
          ),
        }),
        (schema) => {
          const before = computeSchemaChecksum(schema);

          // Remove the first property
          const keys = Object.keys(schema.properties);
          const [first, ...rest] = keys;
          const reducedProperties: Record<string, { type: string }> = {};
          for (const k of rest) {
            const prop = schema.properties[k];
            if (prop === undefined) throw new Error(`expected a property "${k}"`);
            reducedProperties[k] = prop;
          }
          const modified = { ...schema, properties: reducedProperties };

          // Suppress unused variable warning
          void first;

          const after = computeSchemaChecksum(modified);
          expect(before).not.toBe(after);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("changing a property value in a schema produces a different checksum", () => {
    // Feature: ai-agent-orchestration-platform, Property 21: Schema Checksum Invalidation
    fc.assert(
      fc.property(
        // Schema with at least one property
        fc.record({
          type: fc.constant("object"),
          properties: fc.dictionary(
            arbitraryParamName,
            fc.record({ type: fc.constantFrom("string", "number") }),
            { minKeys: 1, maxKeys: 6 },
          ),
        }),
        (schema) => {
          const before = computeSchemaChecksum(schema);

          // Change the type of the first property to something distinct
          const firstKey = Object.keys(schema.properties)[0];
          if (firstKey === undefined) throw new Error("expected at least one property");
          const firstProp = schema.properties[firstKey];
          if (firstProp === undefined) throw new Error(`expected a property "${firstKey}"`);
          const currentType = firstProp.type;
          const newType = currentType === "string" ? "number" : "string";

          const modified = {
            ...schema,
            properties: {
              ...schema.properties,
              [firstKey]: { type: newType },
            },
          };

          const after = computeSchemaChecksum(modified);
          expect(before).not.toBe(after);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — filterSchema
// ---------------------------------------------------------------------------

describe("Unit: filterSchema", () => {
  test("removes single protected param from properties", () => {
    const schema = {
      type: "object",
      properties: {
        user_token: { type: "string" },
        query: { type: "string" },
      },
      required: ["user_token", "query"],
    };
    const filtered = filterSchema(schema, ["user_token"]);
    expect(Object.hasOwn(filtered.properties, "user_token")).toBe(false);
    expect(Object.hasOwn(filtered.properties, "query")).toBe(true);
    expect(filtered.required).toEqual(["query"]);
  });

  test("removes default protected params (user_token, user_email, client_id)", () => {
    const defaultProtected = ["user_token", "user_email", "client_id"];
    const schema = {
      type: "object",
      properties: {
        user_token: { type: "string" },
        user_email: { type: "string" },
        client_id: { type: "string" },
        public_param: { type: "string" },
      },
      required: ["user_token", "user_email", "client_id", "public_param"],
    };
    const filtered = filterSchema(schema, defaultProtected);
    for (const pp of defaultProtected) {
      expect(Object.hasOwn(filtered.properties, pp)).toBe(false);
    }
    expect(Object.hasOwn(filtered.properties, "public_param")).toBe(true);
    expect(filtered.required).toEqual(["public_param"]);
  });

  test("required becomes undefined when all required params are protected", () => {
    const schema = {
      type: "object",
      properties: { user_token: { type: "string" } },
      required: ["user_token"],
    };
    const filtered = filterSchema(schema, ["user_token"]);
    expect(filtered.required).toBeUndefined();
  });

  test("empty protectedParams list returns all properties", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    };
    const filtered = filterSchema(schema, []);
    expect(Object.keys(filtered.properties)).toHaveLength(2);
    expect(filtered.required).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — injectProtectedParams
// ---------------------------------------------------------------------------

describe("Unit: injectProtectedParams", () => {
  const baseCtx: RequestContext = {
    ssoToken: "tok.abc.def",
    executionId: "exec-1",
    userEmail: "user@example.com",
    clientId: "tenant-42",
  };

  test("injects user_token from ssoToken", () => {
    const result = injectProtectedParams({}, baseCtx);
    expect(result.user_token).toBe(baseCtx.ssoToken);
  });

  test("injects user_email from userEmail", () => {
    const result = injectProtectedParams({}, baseCtx);
    expect(result.user_email).toBe(baseCtx.userEmail);
  });

  test("injects client_id from clientId", () => {
    const result = injectProtectedParams({}, baseCtx);
    expect(result.client_id).toBe(baseCtx.clientId);
  });

  test("preserves original args keys", () => {
    const args = { query: "hello", limit: 10 };
    const result = injectProtectedParams(args, baseCtx);
    expect(result.query).toBe("hello");
    expect(result.limit).toBe(10);
  });

  test("does not mutate original args", () => {
    const args = { query: "hello" };
    injectProtectedParams(args, baseCtx);
    expect(Object.keys(args)).toEqual(["query"]);
  });

  test("skips user_email key when userEmail is undefined", () => {
    const ctx: RequestContext = { ssoToken: "t.o.k", executionId: "e-1" };
    const result = injectProtectedParams({}, ctx);
    expect(Object.hasOwn(result, "user_email")).toBe(false);
  });

  test("skips client_id key when clientId is undefined", () => {
    const ctx: RequestContext = { ssoToken: "t.o.k", executionId: "e-1" };
    const result = injectProtectedParams({}, ctx);
    expect(Object.hasOwn(result, "client_id")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — resolveInjectedParams
// ---------------------------------------------------------------------------

describe("Unit: resolveInjectedParams", () => {
  const ctx: RequestContext = {
    ssoToken: "tok",
    executionId: "exec-1",
    userId: "u-123",
    userName: "Example Contributor",
    userEmail: "test.user@example.test",
    language: "de-DE",
    chatId: "bf74f1b8-460f-4198-87ea-9ad3bc91a186",
    sessionId: "zRLkrBa3hay6fPEXAAEk",
    messageId: "d83d0d6d-672d-4112-91ee-5f8efffa9916",
  };
  // Fixed clock: 2025-11-20 (a Thursday).
  const now = new Date(2025, 10, 20, 17, 25, 1, 816);

  test("resolves nested {{ctx.*}} placeholders preserving types", () => {
    const out = resolveInjectedParams(
      {
        context: {
          source: "aiperator",
          user: {
            id: "{{ctx.userId}}",
            name: "{{ctx.userName}}",
            mail: "{{ctx.userEmail}}",
            language: "{{ctx.language}}",
          },
        },
      },
      ctx,
      now,
    );
    const context = out.context as Record<string, unknown>;
    const user = context.user as Record<string, unknown>;
    expect(context.source).toBe("aiperator");
    expect(user.id).toBe("u-123");
    expect(user.name).toBe("Example Contributor");
    expect(user.mail).toBe("test.user@example.test");
    expect(user.language).toBe("de-DE");
  });

  test("computes {{now.*}} from the supplied clock", () => {
    const out = resolveInjectedParams(
      { date: "{{now.date}}", weekday: "{{now.weekday}}" },
      ctx,
      now,
    );
    expect(out.date).toBe("2025-11-20");
    expect(out.weekday).toBe("Thu");
  });

  test("resolves conversation-id tokens from the execution call", () => {
    const out = resolveInjectedParams(
      {
        chat_id: "{{ctx.chatId}}",
        session_id: "{{ctx.sessionId}}",
        message_id: "{{ctx.messageId}}",
      },
      ctx,
      now,
    );
    expect(out.chat_id).toBe("bf74f1b8-460f-4198-87ea-9ad3bc91a186");
    expect(out.session_id).toBe("zRLkrBa3hay6fPEXAAEk");
    expect(out.message_id).toBe("d83d0d6d-672d-4112-91ee-5f8efffa9916");
  });

  test("single placeholder resolving to nothing becomes null", () => {
    const out = resolveInjectedParams(
      { client: "{{ctx.clientId}}", chat_id: null },
      ctx,
      now,
    );
    expect(out.client).toBeNull();
    expect(out.chat_id).toBeNull();
  });

  test("embedded placeholder in a larger string resolves to empty when unset", () => {
    const out = resolveInjectedParams(
      { greeting: "Hi {{ctx.userName}} ({{ctx.plan}})" },
      ctx,
      now,
    );
    expect(out.greeting).toBe("Hi Example Contributor ()");
  });

  test("does not mutate the input template", () => {
    const template = { user: { id: "{{ctx.userId}}" } };
    resolveInjectedParams(template, ctx, now);
    expect(template.user.id).toBe("{{ctx.userId}}");
  });
});

// ---------------------------------------------------------------------------
// Unit tests — computeSchemaChecksum
// ---------------------------------------------------------------------------

describe("Unit: computeSchemaChecksum", () => {
  test("returns a 64-character hex string (SHA-256)", () => {
    const checksum = computeSchemaChecksum({ type: "object", properties: {} });
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same schema returns same checksum", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(computeSchemaChecksum(schema)).toBe(computeSchemaChecksum(schema));
  });

  test("different schemas return different checksums", () => {
    const a = { type: "object", properties: { a: { type: "string" } } };
    const b = { type: "object", properties: { b: { type: "string" } } };
    expect(computeSchemaChecksum(a)).not.toBe(computeSchemaChecksum(b));
  });
});

// ---------------------------------------------------------------------------
// Unit tests — withRetry
// ---------------------------------------------------------------------------

describe("Unit: withRetry", () => {
  test("resolves immediately when fn succeeds on first call", async () => {
    const result = await withRetry(async () => "ok", {
      serverName: "test-server",
      maxAttempts: 3,
      timeoutMs: 100,
      delayMs: 0,
    });
    expect(result).toBe("ok");
  });

  test("throws after exactly 3 attempts when fn always fails", async () => {
    let attempts = 0;
    let error: Error | undefined;
    try {
      await withRetry(
        async () => {
          attempts++;
          throw new Error("fail");
        },
        {
          serverName: "my-mcp-server",
          maxAttempts: 3,
          timeoutMs: 100,
          delayMs: 0,
        },
      );
    } catch (e) {
      error = e as Error;
    }
    expect(attempts).toBe(3);
    expect(error?.message).toContain("my-mcp-server");
    expect(error?.message).toContain("3");
  });

  test("error message contains server name", async () => {
    let error: Error | undefined;
    try {
      await withRetry(
        async () => {
          throw new Error("nope");
        },
        {
          serverName: "special-server-name",
          maxAttempts: 3,
          timeoutMs: 100,
          delayMs: 0,
        },
      );
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain("special-server-name");
  });

  test("resolves on second attempt when fn fails once then succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("retry me");
        return "success";
      },
      { serverName: "server", maxAttempts: 3, timeoutMs: 100, delayMs: 0 },
    );
    expect(result).toBe("success");
    expect(attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — isSessionExpiredError
// ---------------------------------------------------------------------------

import { isSessionExpiredError, StreamableHTTPError } from "../mcp-wrapper.js";

describe("Unit: isSessionExpiredError", () => {
  test("returns true for StreamableHTTPError with code 404", () => {
    const err = new StreamableHTTPError(404, "session not found");
    expect(isSessionExpiredError(err)).toBe(true);
  });

  test("returns false for StreamableHTTPError with code 500", () => {
    const err = new StreamableHTTPError(500, "internal server error");
    expect(isSessionExpiredError(err)).toBe(false);
  });

  test("returns false for StreamableHTTPError with code 401", () => {
    const err = new StreamableHTTPError(401, "unauthorized");
    expect(isSessionExpiredError(err)).toBe(false);
  });

  test("returns true for plain Error with 404 and 'session' in message", () => {
    const err = new Error("Streamable HTTP error 404: session not found");
    expect(isSessionExpiredError(err)).toBe(true);
  });

  test("returns false for plain Error with 404 but no 'session' in message", () => {
    const err = new Error("404 Not Found");
    expect(isSessionExpiredError(err)).toBe(false);
  });

  test("returns false for plain Error with 'session' but no 404", () => {
    const err = new Error("session started");
    expect(isSessionExpiredError(err)).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isSessionExpiredError("404 session")).toBe(false);
    expect(isSessionExpiredError(null)).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
    expect(isSessionExpiredError(404)).toBe(false);
  });
});
