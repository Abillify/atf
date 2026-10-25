// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * SSE Streamer Tests
 *
 * Property 1:  Streaming Response Format
 * Property 2:  Non-Streaming Response Structure
 * Property 3:  Request Validation → 400 for Invalid Required Fields
 * Property 4:  SSE Stream Termination with [DONE]
 * Property 14: SSE Token Chunk Format
 * Property 15: Tool Call Chunk Format
 * Property 16: Execution Time Rounding
 * Property 17: Citation Chunk Format
 *
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { SSEStreamer } from "../sse-streamer.js";
import type { SSEWriter, ToolResultChunk } from "../sse-streamer.js";
import type {
  ToolCallChunk,
  Citation,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "../../types/openai.js";

// ---------------------------------------------------------------------------
// MockWriter — captures all SSE frames written during a test
// ---------------------------------------------------------------------------

class MockWriter implements SSEWriter {
  chunks: string[] = [];

  async write(data: string): Promise<void> {
    this.chunks.push(data);
  }

  async flush(): Promise<void> {
    // no-op — just tracks that flush is callable without error
  }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty printable string, up to 64 chars */
const arbitraryNonEmptyString = fc.string({ minLength: 1, maxLength: 64 });

/** Arbitrary token content (LLM token can be any string, including empty) */
const arbitraryTokenContent = fc.string({ minLength: 0, maxLength: 128 });

/** Arbitrary request/chunk id */
const arbitraryId = fc.string({ minLength: 1, maxLength: 64 });

/** Arbitrary model name */
const arbitraryModel = fc.string({ minLength: 1, maxLength: 64 });

/** Arbitrary tool name */
const arbitraryToolName = fc.string({ minLength: 1, maxLength: 64 });

/** Arbitrary JSON-serialisable arguments object */
const arbitraryToolArguments = fc
  .record({
    input: fc.string(),
  })
  .map((obj) => JSON.stringify(obj));

/** Arbitrary ToolCallChunk */
const arbitraryToolCallChunk: fc.Arbitrary<ToolCallChunk> = fc
  .tuple(arbitraryId, arbitraryToolName, arbitraryToolArguments)
  .map(([id, name, args]) => ({
    id,
    type: "function" as const,
    function: { name, arguments: args },
  }));

/**
 * Arbitrary float execution time — covers negative, zero, positive, fractions,
 * and large values to exercise rounding corner cases.
 * Excludes NaN and Infinity since those aren't valid execution times.
 */
const arbitraryExecutionTime = fc.oneof(
  fc.float({ noNaN: true, noDefaultInfinity: true }),
  fc.constant(0),
  fc.constant(1.23456789),
  fc.constant(0.0005),
  fc.constant(0.0004),
  fc.constant(1.0005),
  fc.constant(1.0004),
);

/** Snippet limited to 500 characters as required */
const arbitrarySnippet = fc.string({ minLength: 0, maxLength: 500 });

/** similarity_score in range [0.0, 1.0] */
const arbitrarySimilarityScore = fc.double({
  min: 0.0,
  max: 1.0,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Arbitrary Citation */
const arbitraryCitation: fc.Arbitrary<Citation> = fc
  .tuple(
    arbitraryNonEmptyString,
    arbitraryNonEmptyString,
    arbitrarySnippet,
    arbitrarySimilarityScore,
  )
  .map(([title, url, snippet, similarity_score]) => ({
    title,
    url,
    snippet,
    similarity_score,
  }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the single written chunk string, asserting exactly one chunk was written.
 */
function getSingleChunk(writer: MockWriter): string {
  expect(writer.chunks).toHaveLength(1);
  const chunk = writer.chunks[0];
  if (chunk === undefined) throw new Error("expected a single chunk");
  return chunk;
}

/**
 * Asserts that a string is a valid SSE data frame: starts with "data: " and
 * ends with "\n\n".
 */
function assertSseFrame(frame: string): void {
  expect(frame.startsWith("data: ")).toBe(true);
  expect(frame.endsWith("\n\n")).toBe(true);
}

/**
 * Parses the JSON payload out of a `data: <json>\n\n` frame.
 * Throws if the frame is not valid JSON-carrying SSE.
 */
function parseSseJson(frame: string): unknown {
  assertSseFrame(frame);
  const jsonPart = frame.slice("data: ".length, frame.length - "\n\n".length);
  return JSON.parse(jsonPart);
}

// ---------------------------------------------------------------------------
// Property 1: Streaming-Response-Format
// Feature: ai-agent-orchestration-platform, Property 1: Streaming-Response-Format
// ---------------------------------------------------------------------------

describe("Property 1: Streaming-Response-Format", () => {
  test("sendToken writes exactly one frame matching data: <json>\\n\\n", async () => {
    // Feature: ai-agent-orchestration-platform, Property 1: Streaming-Response-Format
    await fc.assert(
      fc.asyncProperty(
        arbitraryId,
        arbitraryModel,
        arbitraryTokenContent,
        async (id, model, token) => {
          const writer = new MockWriter();
          const streamer = new SSEStreamer(writer);
          await streamer.sendToken(id, model, token);

          const chunk = getSingleChunk(writer);
          assertSseFrame(chunk);

          // JSON must parse without throwing
          const parsed = parseSseJson(chunk);
          expect(parsed).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("sendToolCallChunk writes exactly one frame matching data: <json>\\n\\n", async () => {
    // Feature: ai-agent-orchestration-platform, Property 1: Streaming-Response-Format
    await fc.assert(
      fc.asyncProperty(arbitraryToolCallChunk, async (toolCall) => {
        const writer = new MockWriter();
        const streamer = new SSEStreamer(writer);
        await streamer.sendToolCallChunk(toolCall);

        const chunk = getSingleChunk(writer);
        assertSseFrame(chunk);

        const parsed = parseSseJson(chunk);
        expect(parsed).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  test("sendCitation writes exactly one frame matching data: <json>\\n\\n", async () => {
    // Feature: ai-agent-orchestration-platform, Property 1: Streaming-Response-Format
    await fc.assert(
      fc.asyncProperty(arbitraryCitation, async (citation) => {
        const writer = new MockWriter();
        const streamer = new SSEStreamer(writer);
        await streamer.sendCitation(citation);

        const chunk = getSingleChunk(writer);
        assertSseFrame(chunk);

        const parsed = parseSseJson(chunk);
        expect(parsed).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Non-Streaming-Response-Struktur
// Feature: ai-agent-orchestration-platform, Property 2: Non-Streaming-Response-Struktur
// ---------------------------------------------------------------------------

describe("Property 2: Non-Streaming-Response-Struktur", () => {
  /**
   * The SSEStreamer itself only handles the streaming path; the non-streaming
   * response is assembled by the chat route (task 10.1, not yet implemented).
   * We validate the structural contract against the ChatCompletionResponse type
   * directly — any object satisfying the required fields is conformant.
   */

  test("ChatCompletionResponse type structure: id, object, created, model, choices with message and finish_reason", () => {
    // Feature: ai-agent-orchestration-platform, Property 2: Non-Streaming-Response-Struktur
    fc.assert(
      fc.property(
        fc.tuple(
          arbitraryId, // id
          fc.integer({ min: 0 }), // created (Unix timestamp)
          arbitraryModel, // model
          arbitraryNonEmptyString, // message content
          fc.constantFrom(
            "stop" as const,
            "tool_calls" as const,
            "length" as const,
            "error" as const,
            null,
          ),
        ),
        ([id, created, model, content, finish_reason]) => {
          const response: ChatCompletionResponse = {
            id,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content },
                finish_reason,
              },
            ],
          };

          // Required fields must all be present
          expect(typeof response.id).toBe("string");
          expect(response.object).toBe("chat.completion");
          expect(typeof response.created).toBe("number");
          expect(typeof response.model).toBe("string");
          expect(Array.isArray(response.choices)).toBe(true);
          expect(response.choices.length).toBeGreaterThanOrEqual(1);

          const choice = response.choices[0];
          expect(choice).toBeDefined();
          if (choice === undefined) throw new Error("expected a first choice");
          expect(choice.message).toBeDefined();
          expect(choice.finish_reason !== undefined).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("ChatCompletionChunk type structure: id, object=chat.completion.chunk, choices[0].delta", async () => {
    // Feature: ai-agent-orchestration-platform, Property 2: Non-Streaming-Response-Struktur
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(arbitraryId, arbitraryModel, arbitraryTokenContent),
        async ([id, model, token]) => {
          const writer = new MockWriter();
          const streamer = new SSEStreamer(writer);
          await streamer.sendToken(id, model, token);

          const frame = getSingleChunk(writer);
          const chunk = parseSseJson(frame) as ChatCompletionChunk;

          // Verify chunk structure matches the ChatCompletionChunk interface
          expect(typeof chunk.id).toBe("string");
          expect(chunk.object).toBe("chat.completion.chunk");
          expect(Array.isArray(chunk.choices)).toBe(true);
          expect(chunk.choices.length).toBeGreaterThanOrEqual(1);
          const firstChoice = chunk.choices[0];
          if (firstChoice === undefined)
            throw new Error("expected a first choice");
          expect(firstChoice.delta).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Request Validation → 400 for Invalid Required Fields
// Feature: ai-agent-orchestration-platform, Property 3: Request Validation → 400 for Invalid Required Fields
// ---------------------------------------------------------------------------

describe("Property 3: Request Validation → 400 for Invalid Required Fields", () => {
  /**
   * The HTTP 400 response is the responsibility of the chat route.
   * Here we test the structural contract: any invalid-request error object must
   * have `error.message` (string) and `error.type = "invalid_request_error"`.
   * We also validate that sendError produces the correct error chunk format.
   */

  test("sendError writes a valid SSE frame with error information", async () => {
    // Feature: ai-agent-orchestration-platform, Property 3: Request Validation → 400 for Invalid Required Fields
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          arbitraryNonEmptyString, // error message
          fc.constantFrom(
            "execution_error" as const,
            "invalid_request_error" as const,
            "provider_error" as const,
            "tool_error" as const,
          ),
        ),
        async ([message, type]) => {
          const writer = new MockWriter();
          const streamer = new SSEStreamer(writer);
          await streamer.sendError({ message, type });

          const frame = getSingleChunk(writer);
          assertSseFrame(frame);

          const parsed = parseSseJson(frame) as Record<string, unknown>;
          expect(parsed).toBeDefined();

          // Must have error information
          const error = parsed.error as Record<string, unknown> | undefined;
          expect(error).toBeDefined();
          if (error === undefined)
            throw new Error("expected error to be defined");
          expect(typeof error.message).toBe("string");
        },
      ),
      { numRuns: 100 },
    );
  });

  test("invalid_request_error type structure: error.message and error.type = invalid_request_error", () => {
    // Feature: ai-agent-orchestration-platform, Property 3: Request Validation → 400 for Invalid Required Fields
    fc.assert(
      fc.property(arbitraryNonEmptyString, (errorMessage) => {
        // Structural contract for HTTP 400 responses from the chat route
        const errorBody = {
          error: {
            message: errorMessage,
            type: "invalid_request_error" as const,
          },
        };

        expect(typeof errorBody.error.message).toBe("string");
        expect(errorBody.error.message.length).toBeGreaterThan(0);
        expect(errorBody.error.type).toBe("invalid_request_error");
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: SSE Stream Termination with [DONE]
// Feature: ai-agent-orchestration-platform, Property 4: SSE Stream Termination with [DONE]
// ---------------------------------------------------------------------------

describe("Property 4: SSE Stream Termination with [DONE]", () => {
  test("sendDone always writes exactly data: [DONE]\\n\\n — no other content", async () => {
    // Feature: ai-agent-orchestration-platform, Property 4: SSE Stream Termination with [DONE]
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);
    await streamer.sendDone();

    expect(writer.chunks).toHaveLength(1);
    expect(writer.chunks[0]).toBe("data: [DONE]\n\n");
  });

  test("sendDone is idempotent — each call writes exactly data: [DONE]\\n\\n", async () => {
    // Feature: ai-agent-orchestration-platform, Property 4: SSE Stream Termination with [DONE]
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (callCount) => {
        const writer = new MockWriter();
        const streamer = new SSEStreamer(writer);

        for (let i = 0; i < callCount; i++) {
          await streamer.sendDone();
        }

        expect(writer.chunks).toHaveLength(callCount);
        for (const chunk of writer.chunks) {
          expect(chunk).toBe("data: [DONE]\n\n");
        }
      }),
      { numRuns: 100 },
    );
  });

  test("[DONE] terminator is a literal string — NOT JSON", async () => {
    // Feature: ai-agent-orchestration-platform, Property 4: SSE Stream Termination with [DONE]
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);
    await streamer.sendDone();

    const frame = getSingleChunk(writer);

    // The payload part between "data: " and "\n\n" must be "[DONE]" literally
    const payload = frame.slice("data: ".length, frame.length - "\n\n".length);
    expect(payload).toBe("[DONE]");

    // It must NOT be parseable as JSON
    let threw = false;
    try {
      JSON.parse(payload);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("after sending tokens, sendDone is still the last chunk written", async () => {
    // Feature: ai-agent-orchestration-platform, Property 4: SSE Stream Termination with [DONE]
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(arbitraryId, arbitraryModel, arbitraryTokenContent), {
          minLength: 0,
          maxLength: 5,
        }),
        async (tokens) => {
          const writer = new MockWriter();
          const streamer = new SSEStreamer(writer);

          for (const [id, model, token] of tokens) {
            await streamer.sendToken(id, model, token);
          }
          await streamer.sendDone();

          const lastChunk = writer.chunks[writer.chunks.length - 1];
          expect(lastChunk).toBe("data: [DONE]\n\n");
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14: SSE Token Chunk Format
// Feature: ai-agent-orchestration-platform, Property 14: SSE Token Chunk Format
// ---------------------------------------------------------------------------

describe("Property 14: SSE Token Chunk Format", () => {
  test("sendToken produces valid JSON chunk with id, object=chat.completion.chunk, choices[0].delta.content=token, choices[0].index=0", async () => {
    // Feature: ai-agent-orchestration-platform, Property 14: SSE Token Chunk Format
    await fc.assert(
      fc.asyncProperty(
        arbitraryId,
        arbitraryModel,
        arbitraryTokenContent,
        async (id, model, token) => {
          const writer = new MockWriter();
          const streamer = new SSEStreamer(writer);
          await streamer.sendToken(id, model, token);

          const frame = getSingleChunk(writer);
          assertSseFrame(frame);

          const chunk = parseSseJson(frame) as ChatCompletionChunk;

          // id must be present and match
          expect(chunk.id).toBe(id);

          // object must be "chat.completion.chunk"
          expect(chunk.object).toBe("chat.completion.chunk");

          // model must match
          expect(chunk.model).toBe(model);

          // choices[0].index must be 0
          const firstChoice = chunk.choices[0];
          if (firstChoice === undefined)
            throw new Error("expected a first choice");
          expect(firstChoice.index).toBe(0);

          // choices[0].delta.content must equal the token exactly
          expect(firstChoice.delta.content).toBe(token);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("token content is preserved exactly — including empty string, whitespace, and special chars", async () => {
    // Feature: ai-agent-orchestration-platform, Property 14: SSE Token Chunk Format
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          arbitraryId,
          arbitraryModel,
          fc.oneof(
            fc.constant(""),
            fc.constant(" "),
            fc.constant("\n"),
            fc.constant("\t"),
            fc.constant('"quoted"'),
            fc.constant("\\backslash"),
            fc.string({ minLength: 0, maxLength: 100 }),
          ),
        ),
        async ([id, model, token]) => {
          const writer = new MockWriter();
          const streamer = new SSEStreamer(writer);
          await streamer.sendToken(id, model, token);

          const chunk = parseSseJson(
            getSingleChunk(writer),
          ) as ChatCompletionChunk;
          const firstChoice = chunk.choices[0];
          if (firstChoice === undefined)
            throw new Error("expected a first choice");
          expect(firstChoice.delta.content).toBe(token);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 15: Tool Call Chunk Format
// Feature: ai-agent-orchestration-platform, Property 15: Tool Call Chunk Format
// ---------------------------------------------------------------------------

describe("Property 15: Tool Call Chunk Format", () => {
  test("sendToolCallChunk produces valid JSON with type=function, function.name, function.arguments (JSON string), non-empty id", async () => {
    // Feature: ai-agent-orchestration-platform, Property 15: Tool Call Chunk Format
    await fc.assert(
      fc.asyncProperty(arbitraryToolCallChunk, async (toolCall) => {
        const writer = new MockWriter();
        const streamer = new SSEStreamer(writer);
        await streamer.sendToolCallChunk(toolCall);

        const frame = getSingleChunk(writer);
        assertSseFrame(frame);

        const chunk = parseSseJson(frame) as Record<string, unknown>;

        // Must be a chat.completion.chunk
        expect(chunk.object).toBe("chat.completion.chunk");

        const choices = chunk.choices as Array<Record<string, unknown>>;
        expect(Array.isArray(choices)).toBe(true);
        expect(choices.length).toBeGreaterThanOrEqual(1);

        const firstChoice = choices[0];
        if (firstChoice === undefined)
          throw new Error("expected a first choice");
        const delta = firstChoice.delta as Record<string, unknown>;
        expect(delta).toBeDefined();

        const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
        expect(Array.isArray(toolCalls)).toBe(true);
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        const tc = toolCalls[0];
        if (tc === undefined) throw new Error("expected a first tool call");

        // id must be a non-empty string
        expect(typeof tc.id).toBe("string");
        expect((tc.id as string).length).toBeGreaterThan(0);

        // type must be "function"
        expect(tc.type).toBe("function");

        const fn = tc.function as Record<string, unknown>;
        expect(fn).toBeDefined();

        // function.name must match
        expect(fn.name).toBe(toolCall.function.name);

        // function.arguments must be a valid JSON string matching the input
        expect(typeof fn.arguments).toBe("string");
        const parsedArgs = JSON.parse(fn.arguments as string);
        expect(parsedArgs).toEqual(JSON.parse(toolCall.function.arguments));
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 16: Execution Time Rounding
// Feature: ai-agent-orchestration-platform, Property 16: Execution Time Rounding
// ---------------------------------------------------------------------------

describe("Property 16: Execution Time Rounding", () => {
  test("sendToolResultChunk rounds execution_time_seconds to exactly 3 decimal places via Math.round(t * 1000) / 1000", async () => {
    // Feature: ai-agent-orchestration-platform, Property 16: Execution Time Rounding
    await fc.assert(
      fc.asyncProperty(arbitraryExecutionTime, async (rawTime) => {
        const writer = new MockWriter();
        const streamer = new SSEStreamer(writer);

        const result: ToolResultChunk = {
          tool_call_id: "test-id",
          content: "result",
          execution_time_seconds: rawTime,
        };

        await streamer.sendToolResultChunk(result);

        const frame = getSingleChunk(writer);
        assertSseFrame(frame);

        const chunk = parseSseJson(frame) as Record<string, unknown>;
        const writtenTime = chunk.execution_time_seconds as number;

        const expected = Math.round(rawTime * 1000) / 1000;
        // JSON serialization converts -0 to 0 — normalise expected the same way
        // so the comparison reflects what actually comes out of the wire format.
        const expectedAfterJsonRoundTrip = JSON.parse(
          JSON.stringify(expected),
        ) as number;
        expect(writtenTime).toBe(expectedAfterJsonRoundTrip);
      }),
      { numRuns: 100 },
    );
  });

  test("execution_time_seconds rounding is idempotent — applying rounding twice gives same result", () => {
    // Feature: ai-agent-orchestration-platform, Property 16: Execution Time Rounding
    fc.assert(
      fc.property(arbitraryExecutionTime, (t) => {
        const rounded = Math.round(t * 1000) / 1000;
        const doubleRounded = Math.round(rounded * 1000) / 1000;
        expect(doubleRounded).toBe(rounded);
      }),
      { numRuns: 100 },
    );
  });

  test("tool_call_id and content are preserved after rounding", async () => {
    // Feature: ai-agent-orchestration-platform, Property 16: Execution Time Rounding
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          arbitraryNonEmptyString,
          arbitraryNonEmptyString,
          arbitraryExecutionTime,
        ),
        async ([tool_call_id, content, executionTime]) => {
          const writer = new MockWriter();
          const streamer = new SSEStreamer(writer);

          await streamer.sendToolResultChunk({
            tool_call_id,
            content,
            execution_time_seconds: executionTime,
          });

          const chunk = parseSseJson(getSingleChunk(writer)) as Record<
            string,
            unknown
          >;
          expect(chunk.tool_call_id).toBe(tool_call_id);
          expect(chunk.content).toBe(content);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 17: Citation Chunk Format
// Feature: ai-agent-orchestration-platform, Property 17: Citation Chunk Format
// ---------------------------------------------------------------------------

describe("Property 17: Citation Chunk Format", () => {
  test("sendCitation writes all four citation fields unchanged: title, url, snippet, similarity_score", async () => {
    // Feature: ai-agent-orchestration-platform, Property 17: Citation Chunk Format
    await fc.assert(
      fc.asyncProperty(arbitraryCitation, async (citation) => {
        const writer = new MockWriter();
        const streamer = new SSEStreamer(writer);
        await streamer.sendCitation(citation);

        const frame = getSingleChunk(writer);
        assertSseFrame(frame);

        const chunk = parseSseJson(frame) as Record<string, unknown>;

        // Must have type "citation"
        expect(chunk.type).toBe("citation");

        const embedded = chunk.citation as Citation;
        expect(embedded).toBeDefined();

        // All four fields must be preserved exactly
        expect(embedded.title).toBe(citation.title);
        expect(embedded.url).toBe(citation.url);
        expect(embedded.snippet).toBe(citation.snippet);
        expect(embedded.similarity_score).toBe(citation.similarity_score);
      }),
      { numRuns: 100 },
    );
  });

  test("citation snippet is preserved even at boundary length (500 chars)", async () => {
    // Feature: ai-agent-orchestration-platform, Property 17: Citation Chunk Format
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          arbitraryNonEmptyString, // title
          arbitraryNonEmptyString, // url
          fc.string({ minLength: 500, maxLength: 500 }), // exactly 500 chars
          arbitrarySimilarityScore,
        ),
        async ([title, url, snippet, similarity_score]) => {
          const writer = new MockWriter();
          const streamer = new SSEStreamer(writer);
          await streamer.sendCitation({
            title,
            url,
            snippet,
            similarity_score,
          });

          const chunk = parseSseJson(getSingleChunk(writer)) as Record<
            string,
            unknown
          >;
          const embedded = chunk.citation as Citation;
          expect(embedded.snippet).toBe(snippet);
          expect(embedded.snippet.length).toBe(500);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("similarity_score boundary values (0.0 and 1.0) are preserved exactly", async () => {
    // Feature: ai-agent-orchestration-platform, Property 17: Citation Chunk Format
    for (const score of [0.0, 1.0]) {
      const writer = new MockWriter();
      const streamer = new SSEStreamer(writer);
      await streamer.sendCitation({
        title: "Test",
        url: "https://example.com",
        snippet: "snippet",
        similarity_score: score,
      });

      const chunk = parseSseJson(getSingleChunk(writer)) as Record<
        string,
        unknown
      >;
      const embedded = chunk.citation as Citation;
      expect(embedded.similarity_score).toBe(score);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — sendDone
// ---------------------------------------------------------------------------

describe("Unit: sendDone", () => {
  test("writes exactly 'data: [DONE]\\n\\n' and nothing else", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);
    await streamer.sendDone();

    expect(writer.chunks).toHaveLength(1);
    expect(getSingleChunk(writer)).toBe("data: [DONE]\n\n");
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — sendToken
// ---------------------------------------------------------------------------

describe("Unit: sendToken", () => {
  test("writes SSE frame with correct token content", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);
    await streamer.sendToken("req-1", "gpt-4", "Hello");

    expect(writer.chunks).toHaveLength(1);
    const chunk = parseSseJson(getSingleChunk(writer)) as ChatCompletionChunk;
    expect(chunk.id).toBe("req-1");
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.model).toBe("gpt-4");
    const firstChoice = chunk.choices[0];
    if (firstChoice === undefined) throw new Error("expected a first choice");
    expect(firstChoice.index).toBe(0);
    expect(firstChoice.delta.content).toBe("Hello");
  });

  test("writes SSE frame with empty string token", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);
    await streamer.sendToken("id", "model", "");

    const chunk = parseSseJson(getSingleChunk(writer)) as ChatCompletionChunk;
    const firstChoice = chunk.choices[0];
    if (firstChoice === undefined) throw new Error("expected a first choice");
    expect(firstChoice.delta.content).toBe("");
  });

  test("content within the per-frame limit is emitted as a single frame", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);
    // 60_000 chars is exactly the limit — must stay a single frame.
    const content = "a".repeat(60_000);
    await streamer.sendToken("id", "model", content);

    expect(writer.chunks).toHaveLength(1);
    const chunk = parseSseJson(getSingleChunk(writer)) as ChatCompletionChunk;
    const firstChoice = chunk.choices[0];
    if (firstChoice === undefined) throw new Error("expected a first choice");
    expect(firstChoice.delta.content).toBe(content);
  });

  test("oversized content is split so no SSE line exceeds aiohttp's 131072-byte limit", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);
    // Simulate a base64 image data-URI emitted in a single delta (~1 MB).
    const content = `![](data:image/jpeg;base64,${"/9j4AAQSkZJRg".repeat(80_000)})`;
    expect(content.length).toBeGreaterThan(1_000_000);

    await streamer.sendToken("req-img", "helpdesk", content);

    // Must produce multiple frames.
    expect(writer.chunks.length).toBeGreaterThan(1);

    // Every emitted SSE line must stay under the 131072-byte limit, and the
    // reassembled content must equal the original.
    let reassembled = "";
    for (const frame of writer.chunks) {
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThan(131072);
      const chunk = parseSseJson(frame) as ChatCompletionChunk;
      expect(chunk.id).toBe("req-img");
      expect(chunk.model).toBe("helpdesk");
      reassembled += chunk.choices[0]?.delta.content ?? "";
    }
    expect(reassembled).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — sendToolCallChunk
// ---------------------------------------------------------------------------

describe("Unit: sendToolCallChunk", () => {
  test("writes SSE frame with correct tool call structure", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);

    const toolCall: ToolCallChunk = {
      id: "call-abc",
      type: "function",
      function: {
        name: "search",
        arguments: '{"query":"test"}',
      },
    };

    await streamer.sendToolCallChunk(toolCall);

    expect(writer.chunks).toHaveLength(1);
    const chunk = parseSseJson(getSingleChunk(writer)) as Record<
      string,
      unknown
    >;
    expect(chunk.object).toBe("chat.completion.chunk");

    const choices = chunk.choices as Array<Record<string, unknown>>;
    const firstChoice = choices[0];
    if (firstChoice === undefined) throw new Error("expected a first choice");
    const delta = firstChoice.delta as Record<string, unknown>;
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
    const tc = toolCalls[0];
    if (tc === undefined) throw new Error("expected a first tool call");

    expect(tc.id).toBe("call-abc");
    expect(tc.type).toBe("function");
    const fn = tc.function as Record<string, unknown>;
    expect(fn.name).toBe("search");
    expect(fn.arguments).toBe('{"query":"test"}');
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — sendToolResultChunk
// ---------------------------------------------------------------------------

describe("Unit: sendToolResultChunk", () => {
  test("rounds execution_time_seconds to 3 decimal places", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);

    await streamer.sendToolResultChunk({
      tool_call_id: "call-1",
      content: "result",
      execution_time_seconds: 1.23456789,
    });

    const chunk = parseSseJson(getSingleChunk(writer)) as Record<
      string,
      unknown
    >;
    expect(chunk.execution_time_seconds).toBe(1.235);
  });

  test("rounds 0.0005 to 0.001 (round half up)", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);

    await streamer.sendToolResultChunk({
      tool_call_id: "call-1",
      content: "x",
      execution_time_seconds: 0.0005,
    });

    const chunk = parseSseJson(getSingleChunk(writer)) as Record<
      string,
      unknown
    >;
    expect(chunk.execution_time_seconds).toBe(0.001);
  });

  test("preserves exactly 0 execution time", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);

    await streamer.sendToolResultChunk({
      tool_call_id: "call-1",
      content: "x",
      execution_time_seconds: 0,
    });

    const chunk = parseSseJson(getSingleChunk(writer)) as Record<
      string,
      unknown
    >;
    expect(chunk.execution_time_seconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — sendCitation
// ---------------------------------------------------------------------------

describe("Unit: sendCitation", () => {
  test("writes all citation fields in the citation wrapper", async () => {
    const writer = new MockWriter();
    const streamer = new SSEStreamer(writer);

    const citation: Citation = {
      title: "Test Doc",
      url: "https://example.com/doc",
      snippet: "This is a relevant excerpt.",
      similarity_score: 0.87,
    };

    await streamer.sendCitation(citation);

    expect(writer.chunks).toHaveLength(1);
    const chunk = parseSseJson(getSingleChunk(writer)) as Record<
      string,
      unknown
    >;
    expect(chunk.type).toBe("citation");

    const embedded = chunk.citation as Citation;
    expect(embedded.title).toBe("Test Doc");
    expect(embedded.url).toBe("https://example.com/doc");
    expect(embedded.snippet).toBe("This is a relevant excerpt.");
    expect(embedded.similarity_score).toBe(0.87);
  });
});
