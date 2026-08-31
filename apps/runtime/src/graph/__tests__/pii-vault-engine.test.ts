// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the PII vault engine decorator (`src/graph/pii-vault-engine.ts`).
 *
 * Verifies the vault is transparent to ANY caller of `executeFlow`: the
 * underlying engine only ever sees tokenized text, while the caller's
 * `onChunk` only ever sees the real (detokenized) text.
 */

import { describe, it, expect } from "bun:test";
import { withPiiVault } from "../pii-vault-engine.js";
import { createPiiVault, InMemoryPiiVaultStore } from "../pii-vault.js";
import type { PiiVault, PiiVaultConfig, PiiVaultStore } from "../pii-vault.js";
import type { GraphEngineService } from "../graph-engine/state.js";
import type { ChatMessage, ChatCompletionChunk } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";

/** `createPiiVault` for a config known to enable the vault (never undefined). */
function mustCreatePiiVault(store: PiiVaultStore, config: PiiVaultConfig): PiiVault {
  const vault = createPiiVault(store, config);
  if (vault === undefined) throw new Error("expected the vault to be enabled");
  return vault;
}

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

function makeUsage() {
  return { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
}

/** A fake engine that records the messages it received and streams a given response verbatim. */
function fakeEngine(
  responseChunks: string[],
  capture: { receivedMessages?: ChatMessage[] } = {},
): GraphEngineService {
  return {
    buildGraph: () => ({}) as never,
    async executeFlow(
      _flowId,
      messages,
      _ctx,
      onChunk,
      onDone,
    ): Promise<void> {
      capture.receivedMessages = messages;
      for (const piece of responseChunks) {
        await onChunk({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        });
      }
      await onDone(makeUsage());
    },
    invalidateCache: () => {},
    hasCapacity: () => true,
    getQueueState: () => ({
      active: 0,
      waiting: 0,
      available: 1,
      queueLimit: 1,
    }),
  };
}

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    ssoToken: "",
    executionId: "exec-1",
    ...overrides,
  };
}

async function collect(
  engine: GraphEngineService,
  messages: ChatMessage[],
  requestCtx: RequestContext,
): Promise<{ text: string; chunks: ChatCompletionChunk[] }> {
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    "flow",
    messages,
    requestCtx,
    async (chunk) => {
      chunks.push(chunk);
    },
    async () => {},
  );
  const text = chunks
    .map((c) => c.choices[0]?.delta?.content ?? "")
    .join("");
  return { text, chunks };
}

describe("withPiiVault", () => {
  it("tokenizes outbound message text before the underlying engine sees it", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const capture: { receivedMessages?: ChatMessage[] } = {};
    const engine = withPiiVault(fakeEngine(["ok"], capture), vault);

    await collect(
      engine,
      [{ role: "user", content: "email me at jane@example.com" }],
      ctx(),
    );

    const seen = at(capture.receivedMessages ?? [], 0).content as string;
    expect(seen).not.toContain("jane@example.com");
    expect(seen).toMatch(/\[\[PII:[a-f0-9]{16}\]\]/);
  });

  it("detokenizes streamed response chunks before the caller sees them", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    // The underlying (fake) engine "echoes back" a token it never actually
    // saw resolved — simulate a real engine forwarding the tokenized prompt
    // content in its answer.
    const capture: { receivedMessages?: ChatMessage[] } = {};
    const echoEngine: GraphEngineService = {
      buildGraph: () => ({}) as never,
      async executeFlow(_flowId, messages, _ctx, onChunk, onDone) {
        capture.receivedMessages = messages;
        const echoed = `${at(messages, 0).content as string} received`;
        await onChunk({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [{ index: 0, delta: { content: echoed }, finish_reason: null }],
        });
        await onDone(makeUsage());
      },
      invalidateCache: () => {},
      hasCapacity: () => true,
      getQueueState: () => ({
        active: 0,
        waiting: 0,
        available: 1,
        queueLimit: 1,
      }),
    };
    const engine = withPiiVault(echoEngine, vault);

    const { text } = await collect(
      engine,
      [{ role: "user", content: "contact jane@example.com please" }],
      ctx(),
    );

    expect(text).toBe("contact jane@example.com please received");
    expect(text).not.toContain("[[PII:");
  });

  it("splits a token exactly across two onChunk calls and still detokenizes it", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    let tokenizedPrompt = "";
    const capture: { receivedMessages?: ChatMessage[] } = {};
    const splitEngine: GraphEngineService = {
      buildGraph: () => ({}) as never,
      async executeFlow(_flowId, messages, _ctx, onChunk, onDone) {
        capture.receivedMessages = messages;
        tokenizedPrompt = at(messages, 0).content as string;
        const mid = Math.floor(tokenizedPrompt.length / 2);
        await onChunk({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [
            { index: 0, delta: { content: tokenizedPrompt.slice(0, mid) }, finish_reason: null },
          ],
        });
        await onChunk({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [
            { index: 0, delta: { content: tokenizedPrompt.slice(mid) }, finish_reason: null },
          ],
        });
        await onDone(makeUsage());
      },
      invalidateCache: () => {},
      hasCapacity: () => true,
      getQueueState: () => ({
        active: 0,
        waiting: 0,
        available: 1,
        queueLimit: 1,
      }),
    };
    const engine = withPiiVault(splitEngine, vault);

    const { text } = await collect(
      engine,
      [{ role: "user", content: "reach a@b.com now" }],
      ctx(),
    );

    expect(text).toBe("reach a@b.com now");
  });

  it("releases the vault entries for the execution after the run finishes", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const engine = withPiiVault(fakeEngine(["ok"]), vault);
    const requestCtx = ctx({ executionId: "exec-release" });

    await collect(
      engine,
      [{ role: "user", content: "reach a@b.com" }],
      requestCtx,
    );

    // After release, resolving any token for this execution must miss.
    const resolved = await vault.detokenize(
      "exec-release",
      "[[PII:0000000000000000]]",
    );
    expect(resolved).toBe("[[PII:0000000000000000]]");
  });

  it("releases the vault even when the underlying engine throws", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const throwingEngine: GraphEngineService = {
      buildGraph: () => ({}) as never,
      async executeFlow() {
        throw new Error("boom");
      },
      invalidateCache: () => {},
      hasCapacity: () => true,
      getQueueState: () => ({
        active: 0,
        waiting: 0,
        available: 1,
        queueLimit: 1,
      }),
    };
    const engine = withPiiVault(throwingEngine, vault);

    await expect(
      engine.executeFlow(
        "flow",
        [{ role: "user", content: "a@b.com" }],
        ctx(),
        async () => {},
        async () => {},
      ),
    ).rejects.toThrow("boom");
  });

  it("tokenizes text content blocks (multimodal messages) too", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    const capture: { receivedMessages?: ChatMessage[] } = {};
    const engine = withPiiVault(fakeEngine(["ok"], capture), vault);

    await collect(
      engine,
      [
        {
          role: "user",
          content: [{ type: "text", text: "email a@b.com" }],
        },
      ],
      ctx(),
    );

    const blocks = at(capture.receivedMessages ?? [], 0).content;
    expect(Array.isArray(blocks)).toBe(true);
    const textBlock = at(blocks as Array<{ type: string; text?: string }>, 0);
    expect(textBlock.text).not.toContain("a@b.com");
  });

  it("delegates non-executeFlow methods unchanged", async () => {
    const store = new InMemoryPiiVaultStore();
    const vault = mustCreatePiiVault(store, { enabled: true });
    let invalidated = "";
    const engine = withPiiVault(
      {
        buildGraph: () => ({ marker: "graph" }) as never,
        async executeFlow() {},
        invalidateCache: (flowId) => {
          invalidated = flowId;
        },
        hasCapacity: () => false,
        getQueueState: () => ({
          active: 1,
          waiting: 2,
          available: 0,
          queueLimit: 3,
        }),
      },
      vault,
    );

    engine.invalidateCache("some-flow");
    expect(invalidated).toBe("some-flow");
    expect(engine.hasCapacity()).toBe(false);
    expect(engine.getQueueState()).toEqual({
      active: 1,
      waiting: 2,
      available: 0,
      queueLimit: 3,
    });
  });
});
