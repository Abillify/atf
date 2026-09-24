import { Hono, type Context } from "hono";
import { generateText, tool as aiTool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { deflateSync } from "node:zlib";
import type { AppConfig } from "../config/index.js";
import {
  getProviderInstance,
  resolveProviderProtocol,
  type ProviderProtocol,
} from "../config/providers.js";
import { createLlmProvider } from "../graph/llm-factory.js";
import { getModelCapabilities } from "../graph/model-capabilities.js";
import { estimateCost } from "../observability/cost.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface ProviderTestingRouterDeps {
  config: AppConfig;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

/**
 * Hard ceiling on the output tokens ANY test call may request. The playground
 * runs against real (potentially paid) providers, so a bounded generation keeps
 * an accidental or hostile prompt from running up cost or latency. The prompt
 * test may lower this via `maxOutputTokens`, never raise it.
 */
const MAX_OUTPUT_TOKENS = 1024;
/** Ceiling on the number of iterations a performance test may run. */
const MAX_PERF_RUNS = 20;

// ---------------------------------------------------------------------------
// Live model listing
// ---------------------------------------------------------------------------

interface ListedModel {
  id: string;
  /** Optional free-form label the provider attaches (family, size, …). */
  label?: string;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new Error(`upstream responded ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Lists the models a provider actually OFFERS, live, per wire protocol.
 * Endpoints and credentials come from the named PROVIDERS instance. Bedrock is
 * intentionally not probed here (ListFoundationModels needs the AWS SDK's
 * signed control-plane client, not a bearer fetch) — its models are entered
 * manually, which the frontend allows as a fallback for every provider.
 */
async function listProviderModels(
  provider: string,
  signal: AbortSignal,
): Promise<ListedModel[]> {
  const protocol: ProviderProtocol | undefined =
    resolveProviderProtocol(provider);
  if (protocol === undefined) {
    throw new Error(`Unknown provider "${provider}".`);
  }
  const instance = getProviderInstance(provider);

  switch (protocol) {
    case "openai":
    case "azure": {
      const base = (instance?.url ?? "https://api.openai.com/v1").replace(
        /\/$/,
        "",
      );
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (instance?.apiKey !== undefined) {
        headers.authorization = `Bearer ${instance.apiKey}`;
      }
      const body = (await fetchJson(`${base}/models`, headers, signal)) as {
        data?: Array<{ id?: string; owned_by?: string }>;
      };
      return (body.data ?? [])
        .filter((m): m is { id: string; owned_by?: string } =>
          typeof m.id === "string",
        )
        .map((m) => ({
          id: m.id,
          ...(m.owned_by !== undefined ? { label: m.owned_by } : {}),
        }));
    }

    case "ollama": {
      // Ollama's native tag list is /api/tags; the base may be written with a
      // trailing /api or /v1 which is normalised away (mirrors llm-factory).
      const rawBase = instance?.url ?? "http://localhost:11434";
      const host = rawBase.replace(/\/(api|v1)\/?$/, "").replace(/\/$/, "");
      const body = (await fetchJson(`${host}/api/tags`, {}, signal)) as {
        models?: Array<{ name?: string; model?: string; details?: { parameter_size?: string } }>;
      };
      return (body.models ?? [])
        .map((m) => {
          const id = m.name ?? m.model;
          if (typeof id !== "string") return undefined;
          const size = m.details?.parameter_size;
          return { id, ...(size !== undefined ? { label: size } : {}) };
        })
        .filter((m): m is ListedModel => m !== undefined);
    }

    case "google": {
      const key = instance?.apiKey;
      if (key === undefined) {
        throw new Error(
          `Provider "${provider}" has no API key configured for model listing.`,
        );
      }
      const body = (await fetchJson(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { "x-goog-api-key": key },
        signal,
      )) as {
        models?: Array<{ name?: string; displayName?: string }>;
      };
      return (body.models ?? [])
        .filter((m): m is { name: string; displayName?: string } =>
          typeof m.name === "string",
        )
        .map((m) => ({
          id: m.name,
          ...(m.displayName !== undefined ? { label: m.displayName } : {}),
        }));
    }

    case "anthropic": {
      const key = instance?.apiKey;
      if (key === undefined) {
        throw new Error(
          `Provider "${provider}" has no API key configured for model listing.`,
        );
      }
      const base = (instance?.url ?? "https://api.anthropic.com").replace(
        /\/$/,
        "",
      );
      const body = (await fetchJson(
        `${base}/v1/models`,
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal,
      )) as { data?: Array<{ id?: string; display_name?: string }> };
      return (body.data ?? [])
        .filter((m): m is { id: string; display_name?: string } =>
          typeof m.id === "string",
        )
        .map((m) => ({
          id: m.id,
          ...(m.display_name !== undefined ? { label: m.display_name } : {}),
        }));
    }

    case "bedrock": {
      throw new Error(
        "Bedrock does not expose a bearer-listable model endpoint here; enter the model id manually.",
      );
    }

    default: {
      const exhaustive: never = protocol;
      throw new Error(`Unsupported protocol "${String(exhaustive)}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ad-hoc inference helpers
// ---------------------------------------------------------------------------

interface RunResult {
  text: string;
  reasoningText?: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  latencyMs: number;
}

/**
 * A single isolated generateText call against (provider, model). Deliberately
 * bypasses the flow admission/guardrail pipeline (there is no flow), so it is
 * gated on `monitoring:write` and hard-capped on output tokens by the caller.
 */
async function runOnce(
  provider: string,
  model: string,
  messages: ModelMessage[],
  appConfig: AppConfig,
  opts: {
    maxOutputTokens: number;
    temperature?: number;
    tools?: ToolSet;
    signal: AbortSignal;
  },
): Promise<RunResult & { toolCalls: Array<{ name: string; args: unknown }> }> {
  const languageModel = createLlmProvider({ provider, model }, appConfig);
  const started = Date.now();
  const result = await generateText({
    model: languageModel,
    messages,
    maxOutputTokens: opts.maxOutputTokens,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    abortSignal: opts.signal,
  });
  const latencyMs = Date.now() - started;
  const promptTokens = result.usage?.inputTokens ?? 0;
  const completionTokens = result.usage?.outputTokens ?? 0;
  const cost = estimateCost(
    provider,
    model,
    { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    appConfig.llmPricing,
  );
  const toolCalls = (result.toolCalls ?? []).map((call) => ({
    name: call.toolName,
    args: call.input,
  }));
  return {
    text: result.text,
    ...(result.reasoningText !== undefined && result.reasoningText.length > 0
      ? { reasoningText: result.reasoningText }
      : {}),
    promptTokens,
    completionTokens,
    cost,
    latencyMs,
    toolCalls,
  };
}

// ---------------------------------------------------------------------------
// Capability auto-test
// ---------------------------------------------------------------------------

/** A 64×32 PNG split red (left) / blue (right), for the vision probe. */
let cachedVisionPng: string | undefined;
function splitColorPngBase64(): string {
  if (cachedVisionPng !== undefined) return cachedVisionPng;
  let crcTable: number[] | undefined;
  const crc32 = (buffer: Buffer): number => {
    crcTable ??= Array.from({ length: 256 }, (_, n) => {
      let value = n;
      for (let i = 0; i < 8; i++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    });
    let crc = 0xffffffff;
    for (const byte of buffer) {
      const entry = crcTable[(crc ^ byte) & 0xff];
      if (entry === undefined) throw new Error("CRC table lookup failed");
      crc = entry ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const pngChunk = (type: string, data: Buffer): Buffer => {
    const name = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  };
  const width = 64;
  const height = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const row = y * rowSize;
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 3;
      if (x < width / 2) raw[pixel] = 255;
      else raw[pixel + 2] = 255;
    }
  }
  cachedVisionPng = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
  return cachedVisionPng;
}

interface CapabilityCheck {
  axis: "reasoning" | "toolCalling" | "vision";
  declared: boolean;
  observed: boolean;
  pass: boolean;
  latencyMs: number;
  details: string;
}

/** Reasoning probe: a math word problem whose only correct answer is 703. */
async function checkReasoning(
  provider: string,
  model: string,
  appConfig: AppConfig,
  declared: boolean,
  signal: AbortSignal,
): Promise<CapabilityCheck> {
  const started = Date.now();
  try {
    const result = await runOnce(
      provider,
      model,
      [
        {
          role: "user",
          content:
            "Multiply 37 by 19 and think step by step. End your answer with the final number.",
        },
      ],
      appConfig,
      { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0, signal },
    );
    const observed =
      (result.reasoningText?.trim().length ?? 0) > 0 ||
      /<think>[\s\S]*?<\/think>/i.test(result.text);
    const correct = /\b703\b/.test(result.text);
    return {
      axis: "reasoning",
      declared,
      observed,
      pass: correct,
      latencyMs: result.latencyMs,
      details: `answer=${correct ? "703" : "unexpected"}, reasoning=${observed ? "present" : "absent"}`,
    };
  } catch (err) {
    return {
      axis: "reasoning",
      declared,
      observed: false,
      pass: false,
      latencyMs: Date.now() - started,
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Tool-calling probe: the model must call `capability_probe({ value: "ok" })`. */
async function checkToolCalling(
  provider: string,
  model: string,
  appConfig: AppConfig,
  declared: boolean,
  signal: AbortSignal,
): Promise<CapabilityCheck> {
  const started = Date.now();
  try {
    const result = await runOnce(
      provider,
      model,
      [
        {
          role: "user",
          content:
            "Call the capability_probe tool with value set to ok. Do not answer in prose.",
        },
      ],
      appConfig,
      {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        signal,
        tools: {
          capability_probe: aiTool({
            description: "Technical capability probe.",
            inputSchema: z.object({ value: z.literal("ok") }),
          }),
        },
      },
    );
    const call = result.toolCalls[0];
    const observed = call?.name === "capability_probe";
    return {
      axis: "toolCalling",
      declared,
      observed,
      pass: observed,
      latencyMs: result.latencyMs,
      details: `toolCalls=${result.toolCalls.length}, tool=${call?.name ?? "none"}`,
    };
  } catch (err) {
    return {
      axis: "toolCalling",
      declared,
      observed: false,
      pass: false,
      latencyMs: Date.now() - started,
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Vision probe: a synthetic red/blue image; the model must read both halves. */
async function checkVision(
  provider: string,
  model: string,
  appConfig: AppConfig,
  declared: boolean,
  signal: AbortSignal,
): Promise<CapabilityCheck> {
  const started = Date.now();
  try {
    const result = await runOnce(
      provider,
      model,
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Look only at the image. What colour is the left half and what colour is the right half? Answer exactly: LEFT=<colour>; RIGHT=<colour>.",
            },
            {
              type: "file",
              mediaType: "image/png",
              data: `data:image/png;base64,${splitColorPngBase64()}`,
            },
          ],
        },
      ],
      appConfig,
      { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0, signal },
    );
    const text = result.text.toLowerCase();
    const observed = /red/.test(text) && /blue/.test(text);
    return {
      axis: "vision",
      declared,
      observed,
      pass: observed,
      latencyMs: result.latencyMs,
      details: `answer=${JSON.stringify(result.text.slice(0, 120))}`,
    };
  } catch (err) {
    return {
      axis: "vision",
      declared,
      observed: false,
      pass: false,
      latencyMs: Date.now() - started,
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const PromptTestSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().min(1).max(16_000),
  system: z.string().max(16_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS).optional(),
});

const CapabilityTestSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const PerformanceTestSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().min(1).max(16_000).optional(),
  runs: z.number().int().min(1).max(MAX_PERF_RUNS).optional(),
});

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)] ?? 0;
}

export function createProviderTestingRouter(
  deps: ProviderTestingRouterDeps,
): Hono {
  const router = new Hono();
  const auth =
    deps.operatorAuth ??
    createOperatorAuthorizer({ authRequired: deps.authRequired ?? false });

  const guard = async (
    ctx: Context,
    permission: "monitoring:read" | "monitoring:write",
  ): Promise<boolean> => {
    const authorized = await auth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      permission,
    );
    return authorized.ok;
  };

  // ── Live model listing ─────────────────────────────────────────────────
  router.get("/monitoring/providers/:name/models", async (ctx) => {
    if (!(await guard(ctx, "monitoring:read"))) {
      return ctx.json({ error: { message: "Unauthorized operator access." } }, 401);
    }
    const provider = ctx.req.param("name");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const models = await listProviderModels(provider, controller.signal);
      models.sort((a, b) => a.id.localeCompare(b.id));
      return ctx.json({ provider, models });
    } catch (err) {
      return ctx.json(
        {
          error: {
            message:
              err instanceof Error ? err.message : "Failed to list models.",
          },
        },
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  });

  // ── Ad-hoc prompt test ─────────────────────────────────────────────────
  router.post("/monitoring/providers/test/prompt", async (ctx) => {
    if (!(await guard(ctx, "monitoring:write"))) {
      return ctx.json({ error: { message: "Unauthorized operator access." } }, 401);
    }
    const parsed = PromptTestSchema.safeParse(await ctx.req.json().catch(() => null));
    if (!parsed.success) {
      return ctx.json({ error: { message: "Invalid request body." } }, 400);
    }
    const { provider, model, prompt, system, temperature, maxOutputTokens } =
      parsed.data;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const messages: ModelMessage[] = [
        ...(system !== undefined ? [{ role: "system" as const, content: system }] : []),
        { role: "user", content: prompt },
      ];
      const result = await runOnce(provider, model, messages, deps.config, {
        maxOutputTokens: maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        ...(temperature !== undefined ? { temperature } : {}),
        signal: controller.signal,
      });
      return ctx.json({
        provider,
        model,
        text: result.text,
        ...(result.reasoningText !== undefined
          ? { reasoningText: result.reasoningText }
          : {}),
        toolCalls: result.toolCalls,
        usage: {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          cost: result.cost,
        },
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      return ctx.json(
        { error: { message: err instanceof Error ? err.message : "Prompt test failed." } },
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  });

  // ── Capability auto-test ───────────────────────────────────────────────
  router.post("/monitoring/providers/test/capabilities", async (ctx) => {
    if (!(await guard(ctx, "monitoring:write"))) {
      return ctx.json({ error: { message: "Unauthorized operator access." } }, 401);
    }
    const parsed = CapabilityTestSchema.safeParse(
      await ctx.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return ctx.json({ error: { message: "Invalid request body." } }, 400);
    }
    const { provider, model } = parsed.data;
    const declared = getModelCapabilities(provider, model);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      // Each probe runs against the live model; declared flags come from the
      // static registry so the operator sees declared-vs-observed side by side.
      const checks = await Promise.all([
        checkReasoning(provider, model, deps.config, declared.reasoning, controller.signal),
        checkToolCalling(provider, model, deps.config, declared.toolCalling, controller.signal),
        checkVision(provider, model, deps.config, declared.visionInput, controller.signal),
      ]);
      return ctx.json({ provider, model, declared, checks });
    } finally {
      clearTimeout(timeout);
    }
  });

  // ── Performance test ───────────────────────────────────────────────────
  router.post("/monitoring/providers/test/performance", async (ctx) => {
    if (!(await guard(ctx, "monitoring:write"))) {
      return ctx.json({ error: { message: "Unauthorized operator access." } }, 401);
    }
    const parsed = PerformanceTestSchema.safeParse(
      await ctx.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return ctx.json({ error: { message: "Invalid request body." } }, 400);
    }
    const { provider, model } = parsed.data;
    const runs = parsed.data.runs ?? 5;
    const prompt =
      parsed.data.prompt ??
      "Write a single concise sentence about reliable software systems.";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);
    const latencies: number[] = [];
    const throughputs: number[] = [];
    let failures = 0;
    let totalCost = 0;
    let totalCompletionTokens = 0;
    let firstError: string | undefined;
    try {
      for (let i = 0; i < runs; i++) {
        try {
          const result = await runOnce(
            provider,
            model,
            [{ role: "user", content: prompt }],
            deps.config,
            { maxOutputTokens: 256, temperature: 0, signal: controller.signal },
          );
          latencies.push(result.latencyMs);
          totalCost += result.cost;
          totalCompletionTokens += result.completionTokens;
          if (result.latencyMs > 0 && result.completionTokens > 0) {
            throughputs.push(
              result.completionTokens / (result.latencyMs / 1000),
            );
          }
        } catch (err) {
          failures += 1;
          firstError ??= err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const avg =
      latencies.length > 0
        ? latencies.reduce((s, v) => s + v, 0) / latencies.length
        : 0;
    const avgThroughput =
      throughputs.length > 0
        ? throughputs.reduce((s, v) => s + v, 0) / throughputs.length
        : 0;
    return ctx.json({
      provider,
      model,
      runs,
      succeeded: latencies.length,
      failures,
      ...(firstError !== undefined ? { firstError } : {}),
      latencyMs: {
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        avg: Math.round(avg),
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
      },
      tokensPerSecond: Math.round(avgThroughput * 10) / 10,
      totalCompletionTokens,
      totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    });
  });

  return router;
}
