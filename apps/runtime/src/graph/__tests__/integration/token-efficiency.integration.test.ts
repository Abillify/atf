// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LOCAL-ONLY integration test — token-efficiency mechanisms against REAL models.
 *
 * The unit suites prove each mechanism in isolation. This suite proves the parts
 * that only a real provider can show:
 *
 *   - Prompt-prefix stability across turns — that a follow-up turn really is
 *     append-only, which is what a local KV cache (LM Studio / llama.cpp) needs
 *     to skip re-prefilling the conversation. Measured through the engine's own
 *     metrics, not by re-deriving the prompt in the test.
 *   - Prompt-cache reporting — that `cachedInputTokens` actually arrives from a
 *     provider that supports it and reaches `usage.prompt_tokens_details`.
 *   - Tool-result budget — that an oversized tool result in the incoming history
 *     is bounded enough for a small-window model to still answer, where the
 *     unbounded payload would exceed the window.
 *   - History compression — that a real side-model summary replaces the middle of
 *     a long conversation and that the cached summary is reused on the next turn.
 *
 * Gated behind RUN_MODEL_INTEGRATION=1 — skipped in CI. Run locally:
 *   RUN_MODEL_INTEGRATION=1 bun run test:integration:models
 */
import { describe, test, expect } from "bun:test";
import { createGraphEngine } from "../../graph-engine.js";
import { createMetrics } from "../../../observability/metrics.js";
import type { Metrics } from "../../../observability/metrics.js";
import type { FlowDefinition } from "../../../types/flow.js";
import type {
  ChatCompletionChunk,
  ChatMessage,
  TokenUsage,
} from "../../../types/openai.js";
import type {
  RequestContext,
  NodeExecutionEvent,
} from "../../../types/monitoring.js";
import type {
  MonitoringServiceInterface,
  MonitoringClient,
} from "../../../monitoring/monitoring-service.js";
import {
  QWEN,
  HAIKU,
  shouldRun,
  integrationAppConfig,
  MODEL_TIMEOUT_MS,
  type ModelCase,
} from "./_helpers.js";

// ── harness ────────────────────────────────────────────────────────────────

function makeRegistry(flow: FlowDefinition) {
  return {
    get: (id: string) => (id === flow.id ? flow : undefined),
    list: () => [flow],
  };
}

interface RunResult {
  chunks: ChatCompletionChunk[];
  usage: TokenUsage | undefined;
  metrics: Metrics;
  events: NodeExecutionEvent[];
}

function makeMonitoring(): {
  service: MonitoringServiceInterface;
  events: NodeExecutionEvent[];
} {
  const events: NodeExecutionEvent[] = [];
  const service: MonitoringServiceInterface = {
    emitNodeEvent: (_id, e) => events.push(e),
    subscribe: (_c: MonitoringClient) => () => {},
    hasConnectionCapacity: () => true,
    getConnectionCount: () => 0,
    getTransportType: () => "sse",
    getHistory: async () => [],
    getHistoryPage: async () => ({ executions: [], total: 0 }),
    getHistoryFacets: async () => ({ flows: [], users: [] }),
    getUsageLog: async () => [],
    getExecutionEvents: async () => [],
    clearHistory: async () => 0,
  };
  return { service, events };
}

/**
 * Prompt tokens attributed to ONE node.
 *
 * Necessary because `usage.prompt_tokens` from `onDone` is the run AGGREGATE —
 * it includes the summariser's own call, which happens inside the responder
 * node's execution. Per-node counters come from `setGenAiAttributes`, which the
 * summariser deliberately does not call, so this isolates the prompt the
 * responder actually sent.
 */
function nodeInputTokens(
  events: NodeExecutionEvent[],
  nodeId: string,
): number | undefined {
  for (const e of events) {
    if (e.node_id === nodeId && typeof e.input_tokens === "number") {
      return e.input_tokens;
    }
  }
  return undefined;
}

/**
 * Runs a flow with a REAL provider and an injected metrics registry, so the
 * assertions read the same counters production reads.
 *
 * `chatId` is the prompt-prefix tracker's stream key — two calls sharing it are
 * treated as consecutive turns of one conversation.
 */
async function runFlow(
  flow: FlowDefinition,
  messages: ChatMessage[],
  opts: { chatId?: string; metrics?: Metrics } = {},
): Promise<RunResult> {
  const metrics = opts.metrics ?? createMetrics(true);
  const { service: monitoring, events } = makeMonitoring();
  const engine = createGraphEngine(integrationAppConfig(), { flowRegistry: makeRegistry(flow), metrics: metrics });
  const chunks: ChatCompletionChunk[] = [];
  let usage: TokenUsage | undefined;
  const ctx: RequestContext = {
    executionId: `itest-tokeff-${Date.now()}-${Math.random()}`,
    ssoToken: "itest.itest.itest",
    ...(opts.chatId !== undefined ? { chatId: opts.chatId } : {}),
  };
  await engine.executeFlow(
    flow.id,
    messages,
    ctx,
    async (c) => {
      chunks.push(c);
    },
    async (u) => {
      usage = u;
    },
    monitoring,
  );
  return { chunks, usage, metrics, events };
}

const joinContent = (chunks: ChatCompletionChunk[]): string =>
  chunks
    .map((c) => c.choices[0]?.delta?.content ?? "")
    .join("")
    .trim();

const errorChunks = (chunks: ChatCompletionChunk[]): ChatCompletionChunk[] =>
  chunks.filter((c) => c.choices[0]?.finish_reason === "error");

/** Reads a counter series total out of the Prometheus rendering. */
function counterTotal(
  metrics: Metrics,
  name: string,
  labelFilter: Record<string, string> = {},
): number {
  let total = 0;
  for (const line of metrics.render().split("\n")) {
    if (!line.startsWith(`${name}{`) && line !== name) continue;
    const open = line.indexOf("{");
    const close = line.lastIndexOf("}");
    const labels = open >= 0 ? line.slice(open + 1, close) : "";
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (!Number.isFinite(value)) continue;
    let matches = true;
    for (const [k, v] of Object.entries(labelFilter)) {
      if (!labels.includes(`${k}="${v}"`)) {
        matches = false;
        break;
      }
    }
    if (matches) total += value;
  }
  return total;
}

// ── flows ──────────────────────────────────────────────────────────────────

/** Single responder node; `parameters.contextLength` makes the window known. */
function responderFlow(
  m: ModelCase,
  id: string,
  extra: {
    contextLength?: number;
    config?: Record<string, unknown>;
    systemPrompt?: string;
  } = {},
): FlowDefinition {
  return {
    id,
    name: id,
    nodes: [
      {
        id: "responder",
        type: "llm",
        systemPrompt:
          extra.systemPrompt ?? "Antworte sehr knapp auf Deutsch, in einem Satz.",
        llm: {
          ...m.llm,
          parameters: {
            ...m.llm.parameters,
            ...(extra.contextLength !== undefined
              ? { contextLength: extra.contextLength }
              : {}),
          },
        },
        ...(extra.config !== undefined ? { config: extra.config } : {}),
      },
    ],
    edges: [],
  };
}

// ---------------------------------------------------------------------------
// 1. Prompt-prefix stability across turns
// ---------------------------------------------------------------------------

describe.skipIf(!shouldRun(QWEN))(
  "token efficiency — prompt prefix stability (LM Studio)",
  () => {
    test(
      "a follow-up turn is append-only, so the KV prefix is reusable",
      async () => {
        // This is THE property a local KV cache keys on. If the engine ever
        // rewrites an earlier message (volatile system prompt, mid-array
        // rewrite), the whole conversation re-prefills every turn and the local
        // model's apparent speed collapses.
        const flow = responderFlow(QWEN, "itest-prefix");
        const chatId = `prefix-${Date.now()}`;
        const metrics = createMetrics(true);

        const first = await runFlow(
          flow,
          [{ role: "user", content: "Nenne die Hauptstadt von Frankreich." }],
          { chatId, metrics },
        );
        expect(errorChunks(first.chunks)).toHaveLength(0);
        const answer1 = joinContent(first.chunks);
        expect(answer1.length).toBeGreaterThan(0);

        // Turn 2 replays turn 1 verbatim and appends the new question — exactly
        // what an OpenAI-compatible client does.
        const second = await runFlow(
          flow,
          [
            { role: "user", content: "Nenne die Hauptstadt von Frankreich." },
            { role: "assistant", content: answer1 },
            { role: "user", content: "Und von Italien?" },
          ],
          { chatId, metrics },
        );
        expect(errorChunks(second.chunks)).toHaveLength(0);
        expect(joinContent(second.chunks).length).toBeGreaterThan(0);

        const appendOnly = counterTotal(
          metrics,
          "aiperator_prompt_prefix_observations_total",
          { shape: "append_only" },
        );
        const diverged = counterTotal(
          metrics,
          "aiperator_prompt_prefix_observations_total",
          { shape: "diverged" },
        );

        // The probe only reports from the SECOND observation onward.
        expect(appendOnly + diverged).toBe(1);
        expect(diverged).toBe(0);
        expect(appendOnly).toBe(1);

        // The stable prefix must be a real share of the prompt, not a token of it.
        const stable = counterTotal(
          metrics,
          "aiperator_prompt_prefix_chars_total",
          { part: "stable" },
        );
        const total = counterTotal(
          metrics,
          "aiperator_prompt_prefix_chars_total",
          { part: "total" },
        );
        expect(total).toBeGreaterThan(0);
        expect(stable / total).toBeGreaterThan(0.5);
      },
      MODEL_TIMEOUT_MS * 2,
    );

    test(
      "a volatile system prompt is what breaks the prefix (control case)",
      async () => {
        // Same two turns, but the node's system prompt differs between them —
        // the shape the old layout produced by concatenating live MCP state onto
        // the system prompt. Proves the probe detects a real regression rather
        // than always reporting append-only.
        const chatId = `prefix-control-${Date.now()}`;
        const metrics = createMetrics(true);

        await runFlow(
          responderFlow(QWEN, "itest-prefix-ctl", {
            systemPrompt: "Antworte knapp. [Status: server-a erreichbar]",
          }),
          [{ role: "user", content: "Hauptstadt von Frankreich?" }],
          { chatId, metrics },
        );
        await runFlow(
          responderFlow(QWEN, "itest-prefix-ctl", {
            systemPrompt: "Antworte knapp. [Status: server-a NICHT erreichbar]",
          }),
          [{ role: "user", content: "Hauptstadt von Frankreich?" }],
          { chatId, metrics },
        );

        const diverged = counterTotal(
          metrics,
          "aiperator_prompt_prefix_observations_total",
          { shape: "diverged" },
        );
        expect(diverged).toBe(1);
      },
      MODEL_TIMEOUT_MS * 2,
    );
  },
);

// ---------------------------------------------------------------------------
// 2. Prompt-cache token reporting (needs a provider that reports it)
// ---------------------------------------------------------------------------

describe.skipIf(!shouldRun(HAIKU))(
  "token efficiency — prompt-cache reporting (Bedrock)",
  () => {
    test(
      "cachedInputTokens reaches usage.prompt_tokens_details on a cache hit",
      async () => {
        // Anthropic only caches a prefix above a model-specific minimum
        // (~2048 tokens for Haiku), so the system prompt is deliberately long
        // and STABLE across both turns. Turn 1 writes the cache, turn 2 reads it.
        const stableSystemPrompt =
          "Du bist ein praeziser Assistent fuer Verwaltungsfragen.\n\n" +
          Array.from(
            { length: 220 },
            (_, i) =>
              `Regel ${i + 1}: Antworte sachlich, nenne keine erfundenen ` +
              `Quellen, und halte dich an die geltende Hausordnung sowie an ` +
              `die dokumentierten Prozesse der Abteilung.`,
          ).join("\n");

        const flow = responderFlow(HAIKU, "itest-cache", {
          systemPrompt: stableSystemPrompt,
        });
        const chatId = `cache-${Date.now()}`;

        const first = await runFlow(
          flow,
          [{ role: "user", content: "Wie beantrage ich Urlaub?" }],
          { chatId },
        );
        expect(errorChunks(first.chunks)).toHaveLength(0);

        const second = await runFlow(
          flow,
          [{ role: "user", content: "Und wie melde ich mich krank?" }],
          { chatId },
        );
        expect(errorChunks(second.chunks)).toHaveLength(0);

        // The field must be PRESENT for a cache-capable provider — its absence
        // would mean the plumbing never reached the usage payload.
        expect(second.usage?.prompt_tokens_details).toBeDefined();
        if (second.usage === undefined || second.usage.prompt_tokens_details === undefined) {
          throw new Error("expected usage.prompt_tokens_details");
        }
        const cached = second.usage.prompt_tokens_details.cached_tokens;
        expect(cached).toBeGreaterThan(0);
        // Cached tokens are a SUBSET of prompt tokens, never an addition.
        expect(cached).toBeLessThanOrEqual(second.usage.prompt_tokens);
      },
      MODEL_TIMEOUT_MS * 2,
    );
  },
);

// ---------------------------------------------------------------------------
// 3. Tool-result budget — inbound history
// ---------------------------------------------------------------------------

describe.skipIf(!shouldRun(QWEN))(
  "token efficiency — tool-result budget (LM Studio)",
  () => {
    test(
      "an oversized inbound tool result is bounded so a small window still answers",
      async () => {
        // A 600k-character tool result is ~150k tokens — far beyond the declared
        // 8k window. Unbounded it cannot be sent at all; bounded to 15% of the
        // window (floored at 8k chars) the model still receives the head and tail
        // and can answer. The budget is what makes this request possible.
        const payload =
          "ANFANG-DES-BERICHTS Kennung AZ-4711.\n" +
          "Füllzeile mit belanglosem Inhalt.\n".repeat(20_000) +
          "ENDE-DES-BERICHTS Gesamtsumme 42.";
        expect(payload.length).toBeGreaterThan(500_000);

        const flow = responderFlow(QWEN, "itest-toolbudget", {
          contextLength: 8_192,
          systemPrompt:
            "Du beantwortest Fragen ausschliesslich anhand des Werkzeug-" +
            "Ergebnisses im Verlauf. Antworte mit einem sehr kurzen Satz.",
        });

        const { chunks, events, metrics } = await runFlow(flow, [
          { role: "user", content: "Wie lautet die Gesamtsumme im Bericht?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "read_report", arguments: "{}" },
              },
            ],
          } as ChatMessage,
          {
            role: "tool",
            content: payload,
            tool_call_id: "call-1",
          } as ChatMessage,
        ]);

        expect(errorChunks(chunks)).toHaveLength(0);
        expect(joinContent(chunks).length).toBeGreaterThan(0);

        // The budget demonstrably acted on the inbound history.
        const saved = counterTotal(
          metrics,
          "aiperator_tool_result_chars_saved_total",
          { stage: "inbound" },
        );
        expect(saved).toBeGreaterThan(400_000);

        // And the request that actually went out fits the declared window
        // (8_192 tokens) instead of the ~150k the raw payload would have needed.
        // Read per-node, not from the run aggregate, so the measurement is the
        // responder's own prompt.
        const responderPrompt = nodeInputTokens(events, "responder");
        expect(responderPrompt).toBeDefined();
        if (responderPrompt === undefined) throw new Error("expected responderPrompt");
        expect(responderPrompt).toBeLessThan(8_192);
        expect(payload.length / 4).toBeGreaterThan(100_000); // unbounded: ~150k tokens
      },
      MODEL_TIMEOUT_MS * 2,
    );
  },
);

// ---------------------------------------------------------------------------
// 4. History compression with a real summariser
// ---------------------------------------------------------------------------

describe.skipIf(!shouldRun(QWEN))(
  "token efficiency — history compression (LM Studio)",
  () => {
    /**
     * Builds a long but coherent conversation carrying one key identifier.
     *
     * Sized deliberately: the declared 16_384-token window is below
     * SMALL_CTX_WINDOW_LIMIT, so `effectiveThresholdRatio` raises the trigger to
     * 0.75 (≈12_288 tokens ≈ 49k chars). 24 exchanges of ~1.5k chars each clears
     * that with margin — an earlier 12-exchange version sat at ~10k tokens and
     * was correctly reported as `skipped{reason="under-threshold"}`.
     */
    function longHistory(turns: number): ChatMessage[] {
      const msgs: ChatMessage[] = [
        {
          role: "user",
          content:
            "Wir bearbeiten Vorgang AZ-8891. Merke dir diese Kennung. " +
            "Beschreibe kurz das Vorgehen. " +
            "Kontext: ".padEnd(1_200, "Detailinformation zum Vorgang. "),
        },
        {
          role: "assistant",
          content:
            "Verstanden, Vorgang AZ-8891. " +
            "Vorgehen: ".padEnd(1_200, "Schritt mit ausfuehrlicher Begruendung. "),
        },
      ];
      for (let i = 0; i < turns; i++) {
        msgs.push({
          role: "user",
          content:
            `Zwischenfrage ${i}: ` +
            "".padEnd(1_500, `Nebenaspekt ${i} mit vielen Worten. `),
        });
        msgs.push({
          role: "assistant",
          content:
            `Antwort ${i}: ` +
            "".padEnd(1_500, `Erlaeuterung ${i} mit vielen Worten. `),
        });
      }
      msgs.push({
        role: "user",
        content: "Wie lautet die Kennung des Vorgangs? Antworte nur mit der Kennung.",
      });
      return msgs;
    }

    test(
      "compacts the middle via a real side-model summary and still answers",
      async () => {
        const flow = responderFlow(QWEN, "itest-compress", {
          contextLength: 16_384,
          config: {
            historyCompression: { enabled: true, thresholdRatio: 0.5 },
          },
          systemPrompt: "Antworte extrem knapp auf Deutsch.",
        });
        const metrics = createMetrics(true);

        const history = longHistory(24);
        const { chunks, usage, events } = await runFlow(flow, history, {
          chatId: `compress-${Date.now()}`,
          metrics,
        });

        expect(errorChunks(chunks)).toHaveLength(0);

        // A summary was produced by the real model (not served from cache on a
        // first run). On failure, surface WHY it was skipped — the reason label
        // is the difference between "mechanism broken" and "test data too small
        // for the raised small-window threshold".
        const generated = counterTotal(
          metrics,
          "aiperator_history_compaction_total",
          { source: "generated" },
        );
        const skipReasons = metrics
          .render()
          .split("\n")
          .filter((l) => l.startsWith("aiperator_history_compaction_skipped{"));
        expect(skipReasons).toEqual([]);
        expect(generated).toBe(1);

        // The RESPONDER's own prompt fits the declared window, and is materially
        // smaller than the raw history it was built from.
        const responderPrompt = nodeInputTokens(events, "responder");
        expect(responderPrompt).toBeDefined();
        if (responderPrompt === undefined) throw new Error("expected responderPrompt");
        expect(responderPrompt).toBeLessThan(16_384);

        const rawHistoryChars = history.reduce(
          (n, m) => n + String(m.content ?? "").length,
          0,
        );
        // ~4 chars/token: the uncompacted history alone exceeds the window.
        expect(rawHistoryChars / 4).toBeGreaterThan(16_384);
        expect(responderPrompt).toBeLessThan(rawHistoryChars / 4);

        // The run AGGREGATE is larger than the responder's own prompt — the
        // summariser's call is real spend and is accounted, not hidden.
        expect(usage?.prompt_tokens).toBeDefined();
        if (usage === undefined) throw new Error("expected usage");
        expect(usage.prompt_tokens).toBeGreaterThan(responderPrompt);

        // The identifier from the FIRST turn survived compaction — the summary
        // preserved it rather than paraphrasing it away. This is the substantive
        // check: shrinking the prompt is worthless if it drops the facts.
        expect(joinContent(chunks)).toContain("AZ-8891");
      },
      MODEL_TIMEOUT_MS * 3,
    );

    test(
      "the cached summary is reused on the next turn, with no second model call",
      async () => {
        // Without the range-fingerprinted cache the summary would be regenerated
        // every turn, and because generation is non-deterministic the prompt
        // bytes would differ each time — invalidating the prefix on every request
        // and costing more than the compaction saves.
        const flow = responderFlow(QWEN, "itest-compress-cache", {
          contextLength: 16_384,
          config: {
            historyCompression: { enabled: true, thresholdRatio: 0.5 },
          },
          systemPrompt: "Antworte extrem knapp auf Deutsch.",
        });
        const chatId = `compress-cache-${Date.now()}`;
        const metrics = createMetrics(true);
        const history = longHistory(24);

        await runFlow(flow, history, { chatId, metrics });
        await runFlow(flow, history, { chatId, metrics });

        const generated = counterTotal(
          metrics,
          "aiperator_history_compaction_total",
          { source: "generated" },
        );
        const fromCache = counterTotal(
          metrics,
          "aiperator_history_compaction_total",
          { source: "cache" },
        );

        expect(generated).toBe(1);
        expect(fromCache).toBe(1);
      },
      MODEL_TIMEOUT_MS * 4,
    );
  },
);
