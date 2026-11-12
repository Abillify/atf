// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Trust-proxy mode end to end (ADR 0038): a client that speaks the Anthropic
 * Messages API or the OpenAI Chat Completions API sends a model name that is
 * no flow. The Runtime maps it through PROXY_MODELS to a built-in
 * pass-through flow and runs it through the real chain — routes, graph
 * engine, PII vault decorator, decision-receipt decorator. Asserted at the
 * boundaries an auditor cares about:
 *
 *   - the model provider receives a placeholder, never the e-mail address;
 *   - the client receives the address back;
 *   - a signed decision receipt exists for the execution, naming the
 *     pass-through flow and recording the tokenization.
 *
 * In-memory stores, a hand-written model stub, no network.
 */

import { describe, expect, test } from "bun:test";
import { createChatRouter } from "../../apps/runtime/src/routes/chat.ts";
import { createMessagesRouter } from "../../apps/runtime/src/routes/messages.ts";
import { createGraphEngine } from "../../apps/runtime/src/graph/graph-engine.ts";
import { createProxyRegistry } from "../../apps/runtime/src/graph/flow-registry-proxy.ts";
import { withPiiVault } from "../../apps/runtime/src/graph/pii-vault-engine.ts";
import {
  createPiiVault,
  InMemoryPiiVaultStore,
} from "../../apps/runtime/src/graph/pii-vault.ts";
import { withDecisionReceipts } from "../../apps/runtime/src/receipts/receipts-engine-decorator.ts";
import { InMemoryReceiptStore } from "../../apps/runtime/src/receipts/receipt-store.ts";
import { parseReceiptSigningKey } from "../../apps/runtime/src/receipts/signing-key.ts";
import { InMemoryDebugTraceStore } from "../../apps/runtime/src/monitoring/debug-trace-store.ts";
import { TOKEN_KEY } from "../../apps/runtime/src/middleware/auth.ts";
import type { AppConfig } from "../../apps/runtime/src/config/index.ts";
import type { FlowRegistry } from "../../apps/runtime/src/graph/flow-parser.js";

const ADDRESS = "lena.vogt@example.com";

const config: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
};

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
} as never;

/**
 * Minimal language-model stub in the shape the AI SDK calls: it records the
 * prompt and answers by quoting the first placeholder it saw — which is what a
 * real model does when asked to repeat a contact.
 */
function recordingModel(prompts: string[]) {
  return {
    specificationVersion: "v3",
    provider: "stub",
    modelId: "stub-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("streaming only");
    },
    async doStream(options: { prompt: unknown }) {
      const prompt = JSON.stringify(options.prompt);
      prompts.push(prompt);
      const placeholder = prompt.match(/\[\[PII:[A-Z_]+:[a-f0-9]{16}\]\]/)?.[0] ?? "nothing";
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: `Reply to ${placeholder}.` });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 9, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 4, text: undefined, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

async function stack() {
  const prompts: string[] = [];
  const base: FlowRegistry = { get: () => undefined, list: () => [] };
  const registry = createProxyRegistry(base, [
    { match: "claude-*", provider: "openai", model: "upstream-model" },
    { match: "gpt-4.1", provider: "openai", model: "upstream-model" },
  ]);
  const debugTraceStore = new InMemoryDebugTraceStore();
  const raw = createGraphEngine(config, {
    flowRegistry: registry,
    llmProviderFactory: () => recordingModel(prompts) as never,
  });
  raw.setDebugStore?.(debugTraceStore);
  const vault = createPiiVault(new InMemoryPiiVaultStore(), { enabled: true });
  if (vault === undefined) throw new Error("vault expected");
  const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const signingKey = await parseReceiptSigningKey(seed);
  const receiptStore = new InMemoryReceiptStore();
  const receipted = withDecisionReceipts(raw, {
    debugTraceStore,
    receiptStore,
    signingKey,
    logger: silentLogger,
    getToolAuthzHash: () => "none",
    getCompliancePolicy: () => undefined,
    getFlowDefinition: (id) => registry.get(id),
    vault,
  });
  const engine = withPiiVault(receipted, vault);

  const chat = createChatRouter(registry, engine);
  // This workspace does not depend on hono; the router's own class builds the
  // outer app, which stands in for the auth middleware of the real bootstrap.
  const HonoClass = chat.constructor as new () => typeof chat;
  const app = new HonoClass();
  app.use("*", async (ctx: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    ctx.set(TOKEN_KEY, "header.payload.sig");
    await next();
  });
  app.route("/", chat);
  app.route("/", createMessagesRouter(chat));
  return { app, prompts, receiptStore };
}

function executionIdOf(res: Response): string {
  const id = res.headers.get("x-execution-id");
  if (id === null) throw new Error("no X-Execution-Id header");
  return id;
}

describe("trust proxy, end to end", () => {
  test("Anthropic Messages API: tokenized for the model, restored for the client, receipted", async () => {
    const { app, prompts, receiptStore } = await stack();
    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 200,
          messages: [{ role: "user", content: `Draft a reply to ${ADDRESS}.` }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; content: Array<{ text: string }> };
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.content[0]?.text).toBe(`Reply to ${ADDRESS}.`);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(ADDRESS);
    expect(prompts[0]).toMatch(/\[\[PII:EMAIL:[a-f0-9]{16}\]\]/);

    const receipts = receiptStore.byExecution(executionIdOf(res));
    expect(receipts.length).toBeGreaterThan(0);
    const parent = receipts[0]?.payload as unknown as Record<string, unknown>;
    expect(parent.flow_id).toBe("__proxy__.0");
    expect(JSON.stringify(parent)).not.toContain(ADDRESS);
  });

  test("OpenAI Chat Completions: the same pass-through, by exact name", async () => {
    const { app, prompts } = await stack();
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4.1",
          messages: [{ role: "user", content: `Draft a reply to ${ADDRESS}.` }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe(`Reply to ${ADDRESS}.`);
    expect(prompts[0]).not.toContain(ADDRESS);
  });

  test("a model name nobody mapped is still a 404", async () => {
    const { app } = await stack();
    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-pro",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
