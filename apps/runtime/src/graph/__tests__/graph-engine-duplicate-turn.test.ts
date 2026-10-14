// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Duplicate turn = regenerate (`handler-factories.ts`, threaded-history block).
 *
 * The regression: the same request sent twice with the same `conversation_id`
 * ran the second turn on top of the persisted old answer. The responder saw
 * `[system, user, assistant(old answer), user]`, ended its answer early, and
 * the append-only reducer stacked a second answer onto the same turn. The
 * engine now forks from the input checkpoint of the repeated turn, so every
 * run sees `[system, user]` and the thread keeps exactly one answer.
 */
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  CheckpointListOptions,
  CheckpointTuple,
} from "@langchain/langgraph-checkpoint";
import type { AppConfig } from "../../config/index.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { ChatMessage } from "../../types/openai.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import {
  InMemoryCheckpointRepository,
  PersistentCheckpointSaver,
} from "../checkpointer.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

const flow: FlowDefinition = {
  id: "dup-turn-flow",
  name: "Duplicate turn",
  nodes: [
    {
      id: "resp",
      type: "llm",
      systemPrompt: "Du bist ein Analyst.",
      llm: { provider: "openai", model: "mock-model" },
    },
  ],
  edges: [],
};

const usage = {
  inputTokens: {
    total: 7,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
};

type Prompt = LanguageModelV3CallOptions["prompt"];

/**
 * fds-flash shape: a deterministic retrieval tool node feeds the responder,
 * which then sees the retrieval result as context next to the user turn.
 */
const ragFlow: FlowDefinition = {
  id: "dup-turn-rag-flow",
  name: "Duplicate turn (retrieve → responder)",
  nodes: [
    {
      id: "retrieve",
      type: "tool",
      tools: ["fake/lookup"],
      // Result reaches the responder as a mid-conversation SystemMessage.
      config: { injectResultContext: true },
    },
    {
      id: "resp",
      type: "llm",
      systemPrompt: "Du bist ein Analyst.",
      llm: { provider: "openai", model: "mock-model" },
    },
  ],
  edges: [{ source: "retrieve", target: "resp" }],
};

function fakeMcp(): McpWrapperService {
  let n = 0;
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["lookup"],
    getFilteredToolSchema: async (_s, t) => ({
      name: t,
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    // A fresh result per call, like a live search with changing ranks.
    callTool: async () => ({ content: `Treffer ${++n}: Kapitel 9.13 NIO.` }),
    getInstructions: () => undefined,
  };
}

/** MemorySaver whose history scan misbehaves; `getTuple` stays intact. */
class HistoryStubSaver extends MemorySaver {
  constructor(private readonly mode: "empty" | "throw") {
    super();
  }
  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    if (this.mode === "throw") throw new Error("history unavailable");
    // `empty`: the base checkpoint is never found.
    void config;
    void options;
    yield* [];
  }
}

function setup(
  checkpointer: BaseCheckpointSaver | undefined,
  opts: { flow?: FlowDefinition; mcpWrapper?: McpWrapperService } = {},
) {
  const activeFlow = opts.flow ?? flow;
  const prompts: Prompt[] = [];
  let calls = 0;
  const map = new Map([[activeFlow.id, activeFlow]]);
  const registry: FlowRegistry = {
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry,
    ...(checkpointer !== undefined ? { checkpointer } : {}),
    ...(opts.mcpWrapper !== undefined ? { mcpWrapper: opts.mcpWrapper } : {}),
    llmProviderFactory: () =>
      new MockLanguageModelV3({
        doStream: async (options: LanguageModelV3CallOptions) => {
          prompts.push(options.prompt);
          calls += 1;
          const text = `Antwort ${calls}`;
          return {
            stream: new ReadableStream({
              start(controller: ReadableStreamDefaultController<unknown>) {
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({ type: "text-delta", id: "t", delta: text });
                controller.enqueue({ type: "text-end", id: "t" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage,
                });
                controller.close();
              },
            }),
          } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
        },
      }),
  });
  const debugStore = new InMemoryDebugTraceStore();
  engine.setDebugStore?.(debugStore);

  async function run(
    messages: ChatMessage[],
    executionId: string,
    // `null` = stateless request (an `undefined` argument would pick the default).
    conversationId: string | null = "conv-dup",
  ) {
    const before = prompts.length;
    await engine.executeFlow(
      activeFlow.id,
      messages,
      {
        ssoToken: "a.b.c",
        executionId,
        ...(conversationId !== null
          ? { requestParams: { conversation_id: conversationId } }
          : {}),
      },
      async () => {},
      async () => {},
    );
    return {
      prompts: prompts.slice(before),
      trace: debugStore.getTrace(executionId),
    };
  }

  async function threadMessages(): Promise<BaseMessage[]> {
    const tuple = await checkpointer?.getTuple({
      configurable: { thread_id: `${activeFlow.id}:conv-dup`, checkpoint_ns: "" },
    });
    const values = tuple?.checkpoint.channel_values as
      | { messages?: BaseMessage[] }
      | undefined;
    return values?.messages ?? [];
  }

  return { run, threadMessages };
}

const roles = (prompt: Prompt | undefined): string[] =>
  (prompt ?? []).map((m) => m.role);

const textOf = (m: BaseMessage): string =>
  typeof m.content === "string" ? m.content : JSON.stringify(m.content);

const summary = (messages: BaseMessage[]): string[] =>
  messages
    .filter((m) => m._getType() === "human" || m._getType() === "ai")
    .map((m) => `${m._getType()}:${textOf(m)}`);

describe.each([
  ["MemorySaver", (): BaseCheckpointSaver => new MemorySaver()],
  [
    "PersistentCheckpointSaver",
    (): BaseCheckpointSaver =>
      new PersistentCheckpointSaver(new InMemoryCheckpointRepository()),
  ],
])("duplicate turn regenerate (%s)", (_name, makeSaver) => {
  test("same request three times → [system,user] each run, one answer in the thread", async () => {
    const { run, threadMessages } = setup(makeSaver());
    for (let i = 1; i <= 3; i++) {
      const { prompts, trace } = await run(
        [{ role: "user", content: "Gibt es X" }],
        `exec-dup-${i}`,
      );
      expect(prompts).toHaveLength(1);
      expect(roles(prompts[0])).toEqual(["system", "user"]);
      const rec = trace?.context.history_reconciliation;
      if (i === 1) {
        expect(rec?.duplicate_turn).toBe(false);
        expect(rec?.regenerate).toBeUndefined();
      } else {
        expect(rec?.duplicate_turn).toBe(true);
        expect(rec?.regenerate?.outcome).toBe("duplicate_turn_regenerated");
        expect(rec?.regenerate?.base_checkpoint_id).toBeString();
        expect(rec?.appended).toBe(1);
      }
      expect(summary(await threadMessages())).toEqual([
        "human:Gibt es X",
        `ai:Antwort ${i}`,
      ]);
    }
  });

  test("normal follow-up turn is unaffected, regenerate of turn 2 keeps turn 1", async () => {
    const { run, threadMessages } = setup(makeSaver());
    await run([{ role: "user", content: "u1" }], "exec-f-1");

    const followUp: ChatMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "Antwort 1" },
      { role: "user", content: "u2" },
    ];
    const second = await run(followUp, "exec-f-2");
    expect(roles(second.prompts[0])).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(second.trace?.context.history_reconciliation?.regenerate).toBeUndefined();
    expect(summary(await threadMessages())).toEqual([
      "human:u1",
      "ai:Antwort 1",
      "human:u2",
      "ai:Antwort 2",
    ]);

    // Regenerate the second turn: same transcript again.
    const third = await run(followUp, "exec-f-3");
    expect(third.prompts).toHaveLength(1);
    expect(roles(third.prompts[0])).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(third.trace?.context.history_reconciliation?.regenerate?.outcome).toBe(
      "duplicate_turn_regenerated",
    );
    expect(summary(await threadMessages())).toEqual([
      "human:u1",
      "ai:Antwort 1",
      "human:u2",
      "ai:Antwort 3",
    ]);
  });
});

describe("duplicate turn regenerate — retrieve → responder (fds-flash shape)", () => {
  test("repeated request: responder prompt matches the first run, one answer in the thread", async () => {
    const { run, threadMessages } = setup(new MemorySaver(), {
      flow: ragFlow,
      mcpWrapper: fakeMcp(),
    });
    const first = await run([{ role: "user", content: "Gibt es X" }], "exec-rag-1");
    expect(first.prompts).toHaveLength(1);
    const firstRoles = roles(first.prompts[0]);
    // No assistant turn in front of the user question on the first run.
    expect(firstRoles).not.toContain("assistant");
    expect(JSON.stringify(first.prompts[0])).toContain("Treffer 1");

    for (let i = 2; i <= 3; i++) {
      const { prompts, trace } = await run(
        [{ role: "user", content: "Gibt es X" }],
        `exec-rag-${i}`,
      );
      expect(prompts).toHaveLength(1);
      expect(roles(prompts[0])).toEqual(firstRoles);
      // The fresh retrieval result of this run reaches the responder.
      expect(JSON.stringify(prompts[0])).toContain(`Treffer ${i}`);
      expect(trace?.context.history_reconciliation?.regenerate?.outcome).toBe(
        "duplicate_turn_regenerated",
      );
      expect(summary(await threadMessages()).filter((s) => s.startsWith("ai:Antwort"))).toEqual([
        `ai:Antwort ${i}`,
      ]);
    }
  });
});

describe("duplicate turn regenerate — fallback when the base checkpoint is missing", () => {
  test.each([
    ["empty", "base_checkpoint_not_found"],
    ["throw", "history_unreadable"],
  ] as const)(
    "history scan %s → duplicate_turn_kept/%s, turn still answers",
    async (mode, reason) => {
      const { run, threadMessages } = setup(new HistoryStubSaver(mode));
      await run([{ role: "user", content: "Gibt es X" }], `exec-fb-${mode}-1`);
      const { prompts, trace } = await run(
        [{ role: "user", content: "Gibt es X" }],
        `exec-fb-${mode}-2`,
      );
      // Pre-regenerate behaviour: the turn runs on top of the persisted thread.
      expect(prompts).toHaveLength(1);
      expect(roles(prompts[0])).toContain("assistant");
      const rec = trace?.context.history_reconciliation;
      expect(rec?.duplicate_turn).toBe(true);
      expect(rec?.appended).toBe(0);
      expect(rec?.regenerate).toEqual({ outcome: "duplicate_turn_kept", reason });
      expect(summary(await threadMessages())).toEqual([
        "human:Gibt es X",
        "ai:Antwort 1",
        "ai:Antwort 2",
      ]);
    },
  );
});

describe("duplicate turn regenerate — stateless", () => {
  test("without conversation_id nothing is reconciled", async () => {
    const { run } = setup(new MemorySaver());
    for (let i = 1; i <= 2; i++) {
      const { prompts, trace } = await run(
        [{ role: "user", content: "Gibt es X" }],
        `exec-nocid-${i}`,
        null,
      );
      expect(roles(prompts[0])).toEqual(["system", "user"]);
      expect(trace?.context.history_reconciliation).toBeUndefined();
    }
  });
});
