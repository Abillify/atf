// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the Decision_Receipt engine decorator
 * (`src/receipts/receipts-engine-decorator.ts`).
 *
 * The decorator must be transparent to the chat path (callbacks pass through,
 * delegates delegate) while issuing signed receipts from the sealed
 * Debug_Trace after every execution — including failed ones — and never
 * letting a receipt failure escape.
 */

import { describe, expect, test } from "bun:test";

import {
  cborDecodeSign1,
  coseSign1Verify,
  ed25519RawKeyToJwk,
  exportEd25519RawPublicKey,
} from "@atf/security-kit";

import type { DebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { GraphEngineService } from "../../graph/graph-engine/state.js";
import type { ChatCompletionChunk, TokenUsage } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { Logger } from "../../observability/logger.js";
import type { ReceiptSigningKey } from "../signing-key.js";
import { InMemoryReceiptStore } from "../receipt-store.js";
import { withDecisionReceipts } from "../receipts-engine-decorator.js";
import type { DecisionReceiptDeps } from "../receipts-engine-decorator.js";

const EXECUTION_ID = "11111111-2222-3333-4444-555555555555";

function makeUsage(): TokenUsage {
  return { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
}

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return { ssoToken: "", executionId: EXECUTION_ID, ...overrides };
}

/** Fake engine that streams one chunk, calls onDone + onFinalResponse. */
function fakeEngine(opts: { throws?: Error } = {}): GraphEngineService {
  return {
    buildGraph: () => ({}) as never,
    async executeFlow(
      _flowId,
      _messages,
      _ctx,
      onChunk,
      onDone,
      _monitoring,
      _guardrailOverride,
      onFinalResponse,
    ): Promise<void> {
      const chunk: ChatCompletionChunk = {
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [
          { index: 0, delta: { content: "Antwort" }, finish_reason: null },
        ],
      };
      await onChunk(chunk);
      onFinalResponse?.("Antwort");
      await onDone(makeUsage());
      if (opts.throws !== undefined) throw opts.throws;
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

/** Minimal DebugTraceStore fake: only getTrace matters for the decorator. */
function fakeTraceStore(
  trace: ReturnType<typeof makeTrace> | undefined,
): DebugTraceStore {
  return {
    getTrace: (id: string) => (id === EXECUTION_ID ? trace : undefined),
  } as unknown as DebugTraceStore;
}

function makeTrace() {
  return {
    execution_id: EXECUTION_ID,
    flow_id: "support-flow",
    flow_version: "1.0.0",
    status: "completed" as const,
    started_at: "2026-01-01T10:00:00.000Z",
    finished_at: "2026-01-01T10:00:01.000Z",
    context: {},
    input_messages: [{ role: "user" as const, content: "hi" }],
    nodes: [
      {
        node_id: "answer",
        node_type: "llm",
        status: "completed" as const,
        started_at: "2026-01-01T10:00:00.100Z",
        finished_at: "2026-01-01T10:00:00.900Z",
        latency_ms: 800,
        model: "test/model",
        tool_calls: [
          {
            id: "call_1",
            name: "crm/get_customer",
            arguments: { id: "c-1" },
            result: { ok: true },
            is_error: false,
            called_at: "2026-01-01T10:00:00.500Z",
          },
        ],
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    errors: [],
    final_response: "Antwort",
  };
}

/** Logger fake capturing warn/debug calls. */
function fakeLogger(): Logger & {
  warns: { message: string; fields?: Record<string, unknown> }[];
  debugs: { message: string; fields?: Record<string, unknown> }[];
} {
  const warns: { message: string; fields?: Record<string, unknown> }[] = [];
  const debugs: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger = {
    debug: (message: string, fields?: Record<string, unknown>) => {
      debugs.push({ message, ...(fields !== undefined ? { fields } : {}) });
    },
    info: () => {},
    warn: (message: string, fields?: Record<string, unknown>) => {
      warns.push({ message, ...(fields !== undefined ? { fields } : {}) });
    },
    error: () => {},
    child: () => logger,
  };
  return Object.assign(logger, { warns, debugs }) as Logger & {
    warns: { message: string; fields?: Record<string, unknown> }[];
    debugs: { message: string; fields?: Record<string, unknown> }[];
  };
}

async function makeSigningKey(): Promise<ReceiptSigningKey> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const publicKeyRaw = await exportEd25519RawPublicKey(pair.privateKey);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", publicKeyRaw.slice()),
  );
  const kid = Buffer.from(digest.slice(0, 16)).toString("base64url");
  return {
    privateKey: pair.privateKey,
    publicKeyRaw,
    kid,
    jwk: ed25519RawKeyToJwk(publicKeyRaw, kid),
  };
}

function makeDeps(
  overrides: Partial<DecisionReceiptDeps> = {},
): { deps: DecisionReceiptDeps; logger: ReturnType<typeof fakeLogger> } {
  const logger = fakeLogger();
  const deps: DecisionReceiptDeps = {
    debugTraceStore: fakeTraceStore(makeTrace()),
    receiptStore: new InMemoryReceiptStore(),
    signingKey: undefined as unknown as ReceiptSigningKey,
    getToolAuthzHash: () => "a".repeat(64),
    getCompliancePolicy: () => undefined,
    getFlowDefinition: () => undefined,
    ...overrides,
    logger,
  };
  return { deps, logger };
}

describe("withDecisionReceipts (Req 15.1)", () => {
  test("issues parent + child receipts after a successful execution", async () => {
    const signingKey = await makeSigningKey();
    const { deps, logger } = makeDeps({ signingKey });
    const engine = withDecisionReceipts(fakeEngine(), deps);

    const chunks: ChatCompletionChunk[] = [];
    let doneUsage: TokenUsage | undefined;
    let finalResponse: string | undefined;
    await engine.executeFlow(
      "support-flow",
      [{ role: "user", content: "hi" }],
      makeCtx(),
      async (c) => {
        chunks.push(c);
      },
      async (u) => {
        doneUsage = u;
      },
      undefined,
      undefined,
      (r) => {
        finalResponse = r;
      },
    );

    // Callbacks pass through unchanged.
    expect(chunks).toHaveLength(1);
    expect(doneUsage?.total_tokens).toBe(2);
    expect(finalResponse).toBe("Antwort");

    // Parent + one child receipt stored.
    const stored = deps.receiptStore.byExecution(EXECUTION_ID);
    expect(stored).toHaveLength(2);
    expect(stored[0]?.payload.kind).toBe("chat_completion");
    expect(stored[1]?.payload.kind).toBe("tool_call");
    expect(logger.warns).toHaveLength(0);
    expect(logger.debugs.some((d) => d.message === "decision receipts issued")).toBe(true);
  });

  test("stored receipts verify against the signing public key", async () => {
    const signingKey = await makeSigningKey();
    const { deps } = makeDeps({ signingKey });
    const engine = withDecisionReceipts(fakeEngine(), deps);
    await engine.executeFlow(
      "support-flow",
      [],
      makeCtx(),
      async () => {},
      async () => {},
    );
    for (const signed of deps.receiptStore.byExecution(EXECUTION_ID)) {
      const decoded = cborDecodeSign1(signed.coseBytes);
      expect(await coseSign1Verify(decoded, signingKey.publicKeyRaw)).toBe(true);
    }
  });

  test("receipts are issued even when the inner engine throws", async () => {
    const signingKey = await makeSigningKey();
    const { deps } = makeDeps({ signingKey });
    const boom = new Error("inner failure");
    const engine = withDecisionReceipts(fakeEngine({ throws: boom }), deps);
    await expect(
      engine.executeFlow(
        "support-flow",
        [],
        makeCtx(),
        async () => {},
        async () => {},
      ),
    ).rejects.toThrow("inner failure");
    // finally-path still produced receipts.
    expect(deps.receiptStore.byExecution(EXECUTION_ID)).toHaveLength(2);
  });

  test("missing debug trace warns and stores nothing — never throws", async () => {
    const signingKey = await makeSigningKey();
    const { deps, logger } = makeDeps({
      signingKey,
      debugTraceStore: fakeTraceStore(undefined),
    });
    const engine = withDecisionReceipts(fakeEngine(), deps);
    await engine.executeFlow(
      "support-flow",
      [],
      makeCtx(),
      async () => {},
      async () => {},
    );
    expect(deps.receiptStore.size()).toBe(0);
    expect(
      logger.warns.some((w) =>
        w.message.startsWith("decision receipt skipped"),
      ),
    ).toBe(true);
  });

  test("a broken trace store warns instead of throwing", async () => {
    const signingKey = await makeSigningKey();
    const brokenStore = {
      getTrace: () => {
        throw new Error("store exploded");
      },
    } as unknown as DebugTraceStore;
    const { deps, logger } = makeDeps({
      signingKey,
      debugTraceStore: brokenStore,
    });
    const engine = withDecisionReceipts(fakeEngine(), deps);
    await engine.executeFlow(
      "support-flow",
      [],
      makeCtx(),
      async () => {},
      async () => {},
    );
    expect(deps.receiptStore.size()).toBe(0);
    expect(
      logger.warns.some((w) =>
        w.message.startsWith("decision receipt issuance failed"),
      ),
    ).toBe(true);
  });

  test("delegates pass through to the inner engine", async () => {
    const signingKey = await makeSigningKey();
    const { deps } = makeDeps({ signingKey });
    let invalidated = "";
    const inner: GraphEngineService = {
      ...fakeEngine(),
      invalidateCache: (flowId: string) => {
        invalidated = flowId;
      },
      hasCapacity: () => false,
    };
    const engine = withDecisionReceipts(inner, deps);
    engine.invalidateCache("flow-x");
    expect(invalidated).toBe("flow-x");
    expect(engine.hasCapacity()).toBe(false);
    expect(engine.getQueueState()).toEqual({
      active: 0,
      waiting: 0,
      available: 1,
      queueLimit: 1,
    });
  });
});
