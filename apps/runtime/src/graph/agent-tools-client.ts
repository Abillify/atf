// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool naming, the tool-selection meta tool, and the caller's own (client) tools.
 * Split out of `agent-tools.ts` unchanged; that module re-exports the public functions.
 */

import {
  tool,
  jsonSchema,
} from "ai";
import type {
  ToolSet,
  ToolExecutionOptions,
  ToolChoice as AiToolChoice,
} from "ai";
import type { OpenAITool, ToolChoice } from "../types/openai.js";
import type { ToolIndex } from "./tool-index.js";

/**
 * Produces a deterministic, AI-SDK-valid (`^[A-Za-z0-9_-]{1,64}$`) tool key
 * namespaced by server name, disambiguating any collision with a numeric
 * suffix. Exported for unit testing.
 */
export function uniqueToolKey(
  existing: Record<string, unknown>,
  serverName: string,
  bareName: string,
): string {
  const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = `${sanitize(serverName)}__${sanitize(bareName)}`.slice(0, 64);
  if (existing[base] === undefined) return base;
  // Collision (after sanitisation) — append a numeric suffix that still fits 64.
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (existing[candidate] === undefined) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Tool-selection meta-tool (Dynamic Tool Retrieval escape hatch)
// ---------------------------------------------------------------------------

/**
 * Sanitises an arbitrary name into a valid AI SDK tool key
 * (`^[A-Za-z0-9_-]{1,64}$`).
 */
function sanitizeToolName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return s.length > 0 ? s : "select_tools";
}

/**
 * Builds the on-demand `select_tools` meta-tool for a semantic-selection node.
 *
 * The hosting node binds its FULL tool pool but only ADVERTISES a relevant
 * subset (top-K + always-included) initially. This meta-tool lets the model
 * pull in more capabilities on demand: it takes a natural-language `query`,
 * ranks the full pool via the {@link ToolIndex}, and ACTIVATES the best matches
 * by calling `activate` with their AI SDK keys. Because the engine re-reads the
 * active set via `prepareStep` before the next step, the newly-activated tools
 * become callable on the model's next turn.
 *
 * Returns the AI SDK key it should be registered under and the tool itself.
 */
export function buildToolSelectionMetaTool(opts: {
  name: string;
  toolIndex: ToolIndex;
  pool: string[];
  keyByRef: Record<string, string>;
  topK: number;
  minScore?: number;
  /** Caller bearer for token-scoped semantic tool discovery. */
  authToken?: string;
  /**
   * Optional summary of the tool groups NOT already advertised to the model,
   * appended to the tool description so the model knows what it can request.
   */
  groupsSummary?: string;
  /**
   * Looks up the instruction text shown for a server when one of its tools is
   * activated. To keep the activation result lean and avoid leaking large
   * discovery lists (every employee/parking user), callers pass the server's
   * LLM-generated SUMMARY here rather than its full server-level instructions.
   * Returns undefined when no summary is available yet.
   */
  getInstructions?: (server: string) => string | undefined;
  /** Adds the given AI SDK keys to the node's active-tools set. */
  activate: (keys: string[]) => void;
  /**
   * Reports the final arguments this local tool executes with, as key-value
   * JSON — see {@link AgentMediaHooks.onEffectiveArgs} for why local tools
   * must fire it explicitly (no egress DLP, so raw args are effective args).
   */
  onEffectiveArgs?: (
    toolCallId: string,
    toolName: string,
    argsJson: string,
  ) => void | Promise<void>;
}): { key: string; tool: ToolSet[string] } {
  const {
    name,
    toolIndex,
    pool,
    keyByRef,
    topK,
    minScore,
    authToken,
    groupsSummary,
    getInstructions,
    activate,
    onEffectiveArgs,
  } = opts;
  const key = sanitizeToolName(name);

  const baseDescription =
    "Discover and activate additional tools by capability. Call this with a " +
    "precise, action-level description of the single capability you need " +
    "(e.g. 'cancel a parking booking', 'create a vacation request'). " +
    "Be as specific as possible — broad queries activate unrelated tools. " +
    "Only call this when none of the currently available tools fit. " +
    "Activated tools become callable on your next step.";
  const description =
    groupsSummary !== undefined && groupsSummary.trim() !== ""
      ? `${baseDescription}\n\nTool groups you can request (not yet shown to you):\n${groupsSummary}`
      : baseDescription;

  const metaTool = tool<Record<string, unknown>, unknown, never>({
    description,
    inputSchema: jsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language description of the capability you need, e.g. " +
            "'cancel a parking booking' or 'create a vacation day'.",
        },
      },
      required: ["query"],
    }),
    execute: async (
      args: Record<string, unknown>,
      execOpts: ToolExecutionOptions<never>,
    ): Promise<unknown> => {
      const query =
        typeof args.query === "string" ? (args.query as string) : "";
      await onEffectiveArgs?.(
        execOpts.toolCallId,
        key,
        JSON.stringify({ query }),
      );
      if (query.trim() === "") {
        return {
          isError: true,
          error: "missing_query",
          message: "Provide a 'query' describing the capability you need.",
        };
      }
      const hits = await toolIndex.select(query, pool, {
        topK,
        ...(minScore !== undefined ? { minScore } : {}),
        ...(authToken !== undefined ? { authToken } : {}),
      });
      const keys: string[] = [];
      const servers = new Set<string>();
      const activated: Array<{
        name: string;
        description?: string;
        parameters?: unknown;
      }> = [];
      for (const hit of hits) {
        const k = keyByRef[hit.ref];
        if (k === undefined) continue;
        keys.push(k);
        // `name` MUST be the callable AI SDK tool key (e.g. `worktime__status`),
        // NOT the `server/tool` ref — a `/` in a tool name is rejected by some
        // providers (Bedrock: name must match [a-zA-Z0-9_-]+).
        activated.push({
          name: k,
          ...(hit.description !== undefined
            ? { description: hit.description }
            : {}),
          ...(hit.inputSchema !== undefined
            ? { parameters: hit.inputSchema }
            : {}),
        });
        const server = hit.ref.includes("/")
          ? (hit.ref.split("/")[0] ?? "")
          : "";
        if (server !== "") servers.add(server);
      }
      activate(keys);
      if (activated.length === 0) {
        return {
          activated: [],
          message:
            "No additional tools matched. The tools already available to you " +
            "are the most relevant ones.",
        };
      }
      // Return the server-level SUMMARY (not the full instructions, which can
      // contain large discovery lists) for the servers whose tools were
      // activated, so the model gets a lean capability hint for any group it
      // just pulled in.
      const instructions: Record<string, string> = {};
      if (getInstructions !== undefined) {
        for (const server of servers) {
          const instr = getInstructions(server);
          if (instr !== undefined && instr.trim() !== "") {
            instructions[server] = instr;
          }
        }
      }
      return {
        activated,
        ...(Object.keys(instructions).length > 0 ? { instructions } : {}),
        message:
          `Activated ${activated.length} tool(s) — call them by the exact ` +
          `'name' shown above. You can call them on your next step.`,
      };
    },
  });

  return { key, tool: metaTool as ToolSet[string] };
}

// ---------------------------------------------------------------------------
// Client-supplied tools (function-calling passthrough)
// ---------------------------------------------------------------------------

/**
 * Builds an AI SDK ToolSet from the caller's `tools` (function-calling
 * passthrough). Unlike MCP/media tools these are declared WITHOUT an `execute`
 * callback: the AI SDK therefore surfaces the model's tool call as a stream
 * part and stops the step instead of running anything. The engine forwards that
 * call straight back to the caller (as OpenAI `tool_calls`), which executes the
 * tool itself and returns the result on the next turn.
 *
 * The AI SDK tool key is the function's own name verbatim — OpenAI already
 * constrains function names to `^[A-Za-z0-9_-]{1,64}$`, which is exactly the AI
 * SDK key grammar, so the name the caller sent round-trips unchanged in the
 * emitted `tool_calls[].function.name`. Returns the built ToolSet plus the set
 * of keys, so the engine can tell a client tool call apart from an internal
 * (executed) MCP tool call.
 *
 * Entries that are malformed (non-`function` type, missing/invalid name) are
 * skipped rather than failing the whole request.
 */
export function buildClientTools(clientTools: OpenAITool[]): {
  tools: ToolSet;
  keys: Set<string>;
} {
  const tools: ToolSet = {};
  const keys = new Set<string>();
  const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

  for (const entry of clientTools) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      entry.type !== "function" ||
      typeof entry.function?.name !== "string" ||
      !VALID_NAME.test(entry.function.name)
    ) {
      continue;
    }
    const name = entry.function.name;
    // Default to an empty object schema when the caller omits parameters, so a
    // zero-argument tool is still callable.
    const params =
      entry.function.parameters !== undefined &&
      entry.function.parameters !== null &&
      typeof entry.function.parameters === "object"
        ? entry.function.parameters
        : { type: "object", properties: {} };

    // No `execute`: the model's tool call is streamed back to the caller, never
    // run server-side. The cast keeps the input type open (the schema is
    // caller-defined JSON Schema validated at runtime by the SDK).
    tools[name] = tool<Record<string, unknown>, never, never>({
      description: entry.function.description ?? `Client tool ${name}`,
      inputSchema: jsonSchema<Record<string, unknown>>(
        params as Record<string, unknown>,
      ),
    }) as ToolSet[string];
    keys.add(name);
  }

  return { tools, keys };
}

/**
 * Maps an OpenAI `tool_choice` to the AI SDK `toolChoice`. Returns undefined
 * when no choice is supplied (the SDK then defaults to `"auto"`).
 */
export function mapToolChoice(
  choice: ToolChoice | undefined,
): AiToolChoice<ToolSet> | undefined {
  if (choice === undefined) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  if (
    typeof choice === "object" &&
    choice.type === "function" &&
    typeof choice.function?.name === "string"
  ) {
    return { type: "tool", toolName: choice.function.name };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Media-generation tools
// ---------------------------------------------------------------------------
