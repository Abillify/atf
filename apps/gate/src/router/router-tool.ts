// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AuthContext } from "../auth/context.ts";
import type { CacheConfig } from "../config/schema.ts";
import type { ILlmClient, RoutingDecision } from "../llm/client.ts";
import type { MonitorBus } from "../monitor/events.ts";
import type { ToolDefinition, ToolExecutor, ToolResult } from "../tools/types.ts";
import { validateArgs } from "../tools/validate.ts";
import { TtlCache, identityScopeKey } from "../cache.ts";
import type { SystemPromptProvider } from "./system-prompt.ts";
import { logger } from "../logger.ts";
import { nestedToolInvoker } from "../mcp/invocation-context.ts";

export interface RouterTargets {
  definitions(): ToolDefinition[];
  get(name: string): ToolExecutor | undefined;
}

export interface RouterToolSpec {
  name: string;
  description: string;
}

/**
 * An abstract, LLM-driven entry point. Takes a natural-language `prompt`,
 * asks the configured model to pick a tool and fill its arguments, then
 * executes that tool with the caller's AuthContext (identity bind variables apply).
 */
export class RouterToolExecutor implements ToolExecutor {
  readonly definition: ToolDefinition;
  private readonly decisionCache?: TtlCache<RoutingDecision>;

  constructor(
    private readonly spec: RouterToolSpec,
    private readonly targets: RouterTargets,
    private readonly prompts: SystemPromptProvider,
    private readonly llm: ILlmClient,
    private readonly bus: MonitorBus,
    private readonly interpretResults: boolean = false,
    private readonly cache?: CacheConfig,
  ) {
    if (cache?.enabled) this.decisionCache = new TtlCache<RoutingDecision>(cache.maxEntries);
    this.definition = {
      name: spec.name,
      description: spec.description,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Describe in natural language what you want to do.",
          },
        },
        required: ["prompt"],
      },
    };
  }

  async execute(
    args: Record<string, unknown>,
    ctx: AuthContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt.trim()) {
      return { content: [{ type: "text", text: "Missing 'prompt'." }], isError: true };
    }

    const sessionId = ctx.sessionId;
    const systemPrompt = this.prompts.get(ctx);

    // Cache the routing decision (which tool + arguments) for identical prompts
    // to skip the LLM call. The tool still executes with fresh data every time.
    const cacheKey = this.decisionCache
      ? `${this.spec.name}|${this.cache?.scope === "identity" ? identityScopeKey(ctx) : "*"}|${prompt.trim()}`
      : undefined;

    let decision = cacheKey ? this.decisionCache?.get(cacheKey) : undefined;
    if (decision) {
      logger.debug("router decision cache hit", { router: this.spec.name });
    } else {
      decision = await this.llm.route(
        prompt,
        systemPrompt,
        this.targets.definitions(),
        ctx,
        sessionId,
        signal,
      );
      if (cacheKey && this.decisionCache && this.cache) {
        this.decisionCache.set(cacheKey, decision, this.cache.ttlSeconds * 1000);
      }
    }

    if (decision.kind === "text") {
      this.bus.publish({
        type: "router",
        sessionId,
        username: ctx.username,
        status: "ok",
        message: "no tool selected",
        meta: { prompt },
      });
      return { content: [{ type: "text", text: decision.text || "No suitable tool found." }] };
    }

    const target = this.targets.get(decision.tool);
    this.bus.publish({
      type: "router",
      sessionId,
      username: ctx.username,
      tool: decision.tool,
      status: target ? "ok" : "error",
      message: target ? "tool selected" : `model chose unknown tool '${decision.tool}'`,
      meta: { prompt, arguments: decision.arguments },
    });

    if (!target) {
      return {
        content: [{ type: "text", text: `The model selected an unknown tool: ${decision.tool}` }],
        isError: true,
      };
    }

    const validation = validateArgs(target.definition.inputSchema, decision.arguments);
    if (!validation.ok) {
      const message = `The model selected '${decision.tool}' with invalid arguments: ${validation.errors.join("; ")}`;
      this.bus.publish({
        type: "router",
        sessionId,
        username: ctx.username,
        tool: decision.tool,
        status: "error",
        message,
        meta: { prompt, arguments: decision.arguments },
      });
      return { content: [{ type: "text", text: message }], isError: true };
    }

    const result = await (nestedToolInvoker()?.(
      decision.tool,
      decision.arguments,
      ctx,
      signal,
      { logicalActionId: `router:${JSON.stringify(this.spec.name)}` },
    ) ?? target.execute(decision.arguments, ctx, signal));

    if (this.interpretResults && !result.isError) {
      try {
        const toolOutput = result.content?.[0]?.text ?? "";
        const interpretation = await this.llm.interpret(
          prompt,
          decision.tool,
          toolOutput,
          systemPrompt,
          ctx,
          sessionId,
          signal,
        );
        return {
          content: [{ type: "text", text: interpretation }],
          meta: {
            ...result.meta,
            routedTo: decision.tool,
            routedArguments: decision.arguments,
            rawToolOutput: toolOutput,
            interpreted: true,
          },
        };
      } catch (err) {
        logger.warn("router interpretation failed, returning raw result", {
          tool: decision.tool,
          error: (err as Error).message,
        });
        this.bus.publish({
          type: "error",
          sessionId,
          status: "error",
          message: `Failed to interpret tool result: ${(err as Error).message}`,
        });
      }
    }

    return {
      ...result,
      meta: { ...result.meta, routedTo: decision.tool, routedArguments: decision.arguments },
    };
  }
}
