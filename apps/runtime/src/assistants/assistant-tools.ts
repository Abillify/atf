// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assistant-owned tools (`src/assistants/assistant-tools.ts`)
 *
 * The tools an assistant has in addition to whatever MCP tools its flow exposes:
 * reading its own procedures, working in its own workspace, running code, updating
 * its own identity, and messaging a granted peer.
 *
 * ## Gating, not failing
 *
 * A tool that is unavailable is not registered at all. The alternative — register it
 * and refuse at call time — teaches the model that the tool exists and wastes a
 * round trip discovering it does not work. Two consequences follow, and both are
 * deliberate:
 *
 *   - `sandbox_run` is absent entirely when no container runtime is configured;
 *   - `assistant_message` is absent when the assistant holds no outgoing grant.
 *
 * ## Descriptions state capability, not implementation
 *
 * Each description says when to use the tool and what it returns. None of them name
 * another toolset's tools: a description referring to a tool that gating removed is
 * hallucination bait, so cross-references are only made where both tools are
 * registered together (`skill_read` and `skill_search`).
 *
 * ## Every result is written for the next step
 *
 * A tool result is a prompt. A bare acknowledgement ("ok") forces the model to guess
 * what changed; a result that states the outcome and the obvious next move does not.
 * That is why the refusal texts here are long — they are the model's only source of
 * what to do instead.
 *
 * No `any` at module boundaries.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { Logger } from "../observability/logger.js";
import { renderSandboxOutcome } from "../sandbox/sandbox-service.js";
import {
  SANDBOX_INTERPRETERS,
  isSandboxInterpreter,
  type SandboxInterpreter,
} from "../sandbox/policy.js";
import type { AssistantRuntime, AssistantTurnContext } from "./assistant-runtime.js";
import { searchSkills } from "./skill-index.js";
import { CLEAR_FIELD } from "./soul-document.js";
import { SoulRevisionConflictError, SoulWriteClassError } from "./soul-store.js";
import { isGrantActive } from "./messaging-policy.js";
import type { AssistantScope } from "./types.js";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Context every assistant tool closes over. */
export interface AssistantToolContext {
  runtime: AssistantRuntime;
  turn: AssistantTurnContext;
  scope: AssistantScope;
  executionId: string;
  nodeId: string;
  requestedBy?: string;
  signal?: AbortSignal;
  /**
   * Collects skill ids the model actually read, so use counts reflect use rather
   * than mere visibility. Mutated by `skill_read`.
   */
  usedSkillIds: Set<string>;
  logger?: Logger;
}

/**
 * Wraps a tool body so a thrown error becomes a readable result instead of a tool
 * failure.
 *
 * The AI SDK surfaces a thrown error to the model as an opaque tool error, which
 * reads as "the tool is broken" — and models retry broken tools. Returning the
 * message as the result keeps the model informed and stops the retry loop.
 */
function safely<T extends unknown[], R>(
  name: string,
  logger: Logger | undefined,
  body: (...args: T) => Promise<R>,
): (...args: T) => Promise<R | string> {
  return async (...args: T) => {
    try {
      return await body(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.debug("Assistant tool failed", { tool: name, error: message });
      return `${name} failed: ${message}`;
    }
  };
}

/** Reads a required string argument, or throws with a useful message. */
function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Tool set
// ---------------------------------------------------------------------------

/**
 * Builds the assistant's own tools for one turn.
 *
 * Returns a `ToolSet` the caller merges with the flow's MCP tools. Keys are
 * prefixed-free plain names because they are stable, platform-owned, and must be
 * memorable enough for a model to call them from a prompt reference.
 */
export async function buildAssistantTools(context: AssistantToolContext): Promise<ToolSet> {
  const tools: ToolSet = {};
  const { runtime, turn, scope } = context;

  // -- Procedures ----------------------------------------------------------
  // Registered only when the assistant has at least one, so a new assistant is not
  // told about a library it does not have.
  if (turn.visibleSkills.length > 0) {
    tools.skill_read = tool<Record<string, unknown>, unknown, never>({
      description:
        "Read the full text of one of your learned procedures. Call this before following a " +
        "procedure listed in your prompt — the list only says when each one applies, not how. " +
        "Returns the complete procedure; there is no way to read part of it, because a partial " +
        "procedure would be followed as if it were complete.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Exact name of the procedure, as shown in your prompt.",
          },
        },
        required: ["name"],
      }),
      execute: safely("skill_read", context.logger, async (input) => {
        const name = requireString(input as Record<string, unknown>, "name");
        const skill = await runtime.stores.skills.getByName(scope, name);
        if (skill === undefined) {
          const suggestions = searchSkills(turn.visibleSkills, name, 3);
          return suggestions.length > 0
            ? `No procedure named "${name}". Closest matches: ${suggestions
                .map((hit) => hit.entry.name)
                .join(", ")}. Use one of those names exactly, or use skill_search.`
            : `No procedure named "${name}", and nothing similar. Proceed without one.`;
        }
        // Recorded as USED, not merely visible: the use count drives which
        // procedures stay in the prompt index when the set exceeds the budget.
        context.usedSkillIds.add(skill.id);
        return [`# ${skill.name}`, `Applies when: ${skill.triggerLine}`, "", skill.body].join("\n");
      }),
    }) as ToolSet[string];

    tools.skill_search = tool<Record<string, unknown>, unknown, never>({
      description:
        "Find one of your learned procedures by describing the task. Use this when the procedures " +
        "listed in your prompt do not obviously cover what you are doing — more may exist than are " +
        "listed. Returns matching names with the situation each applies to; read one with skill_read.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What you are trying to do, in a few words.",
          },
        },
        required: ["query"],
      }),
      execute: safely("skill_search", context.logger, async (input) => {
        const query = requireString(input as Record<string, unknown>, "query");
        // Searches the full set, not just what the prompt listed — finding the
        // unlisted ones is the whole point of this tool.
        const all = await runtime.stores.skills.listForPrompt(scope);
        const hits = searchSkills(all, query, 5);
        if (hits.length === 0) {
          return `No procedure matches "${query}". Work it out directly; there is nothing stored for this.`;
        }
        return hits.map((hit) => `- ${hit.entry.name} — ${hit.entry.triggerLine}`).join("\n");
      }),
    }) as ToolSet[string];
  }

  // -- Workspace -----------------------------------------------------------
  const sandbox = runtime.sandbox;
  if (sandbox !== undefined) {
    tools.workspace_list = tool<Record<string, unknown>, unknown, never>({
      description:
        "List files in your private workspace. Use it to see what you produced earlier or what " +
        "data is available. Only your own workspace is visible; nothing outside it can be reached.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Directory relative to your workspace root, e.g. "data". Omit for the root.',
          },
        },
      }),
      execute: safely("workspace_list", context.logger, async (input) => {
        const record = input as Record<string, unknown>;
        const relativePath = optionalString(record, "path");
        const entries = await sandbox.listFiles({
          scope,
          ...(relativePath !== undefined ? { relativePath } : {}),
        });
        if (entries.length === 0) {
          return `${relativePath ?? "Your workspace root"} is empty.`;
        }
        return entries
          .map((entry) =>
            entry.kind === "directory"
              ? `${entry.name}/`
              : `${entry.name} (${entry.bytes ?? 0} bytes)`,
          )
          .join("\n");
      }),
    }) as ToolSet[string];

    tools.workspace_read = tool<Record<string, unknown>, unknown, never>({
      description:
        "Read a text file from your private workspace. For a file too large to read, write a " +
        "script that processes it and reports a summary instead.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'File relative to your workspace root, e.g. "data/input.csv".',
          },
        },
        required: ["path"],
      }),
      execute: safely("workspace_read", context.logger, async (input) =>
        sandbox.readFile({
          scope,
          relativePath: requireString(input as Record<string, unknown>, "path"),
        }),
      ),
    }) as ToolSet[string];

    tools.workspace_write = tool<Record<string, unknown>, unknown, never>({
      description:
        "Write a file into your private workspace — a script to run later, or data for a script " +
        "to consume. Writing a file does nothing on its own; use sandbox_run to execute a script.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File relative to your workspace root. Scripts belong under "scripts/", data under "data/".',
          },
          content: { type: "string", description: "Full file contents." },
        },
        required: ["path", "content"],
      }),
      execute: safely("workspace_write", context.logger, async (input) => {
        const record = input as Record<string, unknown>;
        const result = await sandbox.writeScript({
          scope,
          relativePath: requireString(record, "path"),
          content: requireString(record, "content"),
        });
        return (
          `${result.replaced ? "Replaced" : "Wrote"} ${result.relativePath} (${result.bytes} bytes). ` +
          "Nothing has run yet."
        );
      }),
    }) as ToolSet[string];

    // Gated on the runtime actually being present. A registered sandbox_run that
    // always refuses would teach the model a capability it does not have.
    if (sandbox.available) {
      tools.sandbox_run = tool<Record<string, unknown>, unknown, never>({
        description:
          "Run a script from your workspace in an isolated container and get its output. The " +
          "container has no network access and can only see your own workspace. Use it for " +
          "computation, data processing, and file transformation. Write the script first with " +
          "workspace_write.",
        inputSchema: jsonSchema<Record<string, unknown>>({
          type: "object",
          properties: {
            interpreter: {
              type: "string",
              enum: [...SANDBOX_INTERPRETERS],
              description: "Which interpreter to run the script with.",
            },
            path: {
              type: "string",
              description: 'Script relative to your workspace, e.g. "scripts/report.py".',
            },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments passed to the script.",
            },
            purpose: {
              type: "string",
              description:
                "One sentence on what this run is for. Shown to your user if they are asked to approve it.",
            },
          },
          required: ["interpreter", "path"],
        }),
        execute: safely("sandbox_run", context.logger, async (input) => {
          const record = input as Record<string, unknown>;
          const interpreter = requireString(record, "interpreter");
          if (!isSandboxInterpreter(interpreter)) {
            return (
              `"${interpreter}" is not an available interpreter. ` +
              `Use one of: ${SANDBOX_INTERPRETERS.join(", ")}.`
            );
          }
          const rawArgs = record.args;
          const args = Array.isArray(rawArgs)
            ? rawArgs.filter((arg): arg is string => typeof arg === "string")
            : [];
          const purpose = optionalString(record, "purpose");
          const outcome = await sandbox.execute({
            context: {
              scope,
              autonomy: turn.assistant.autonomy,
              assistantActive: turn.assistant.status === "active",
              // Enabled per assistant follows the deployment switch here; a
              // per-assistant override lands on the assistant record when an
              // operator adds one, and this is the single place to read it.
              enabledForAssistant: true,
              executionId: context.executionId,
              nodeId: context.nodeId,
              ...(context.requestedBy !== undefined ? { requestedBy: context.requestedBy } : {}),
              ...(context.signal !== undefined ? { signal: context.signal } : {}),
            },
            request: {
              interpreter: interpreter as SandboxInterpreter,
              scriptPath: requireString(record, "path"),
              args,
              ...(purpose !== undefined ? { purpose } : {}),
            },
          });
          return renderSandboxOutcome(outcome);
        }),
      }) as ToolSet[string];
    }
  }

  // -- Identity ------------------------------------------------------------
  tools.soul_update = tool<Record<string, unknown>, unknown, never>({
    description:
      "Update your own self-description: your name, how you come across, what you consider your " +
      "responsibility, and private notes about how you work. Only these fields are yours — your " +
      "user's instructions and your operator's limits are not writable by you. Use it when you " +
      "learn something durable about yourself, not to record task details.",
    inputSchema: jsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        name: { type: "string", description: "What you call yourself." },
        emoji: { type: "string", description: "A single glyph you use as a signature." },
        role: { type: "string", description: "What you consider your responsibility." },
        vibe: { type: "string", description: "How you come across, in a few words." },
        notes: {
          type: "string",
          description:
            "Durable notes about how you work. Replaces the previous notes entirely, so include what you want to keep.",
        },
        clear: {
          type: "array",
          items: { type: "string", enum: ["name", "emoji", "role", "vibe", "notes"] },
          description: "Fields to remove. Omitting a field leaves it unchanged.",
        },
      },
    }),
    execute: safely("soul_update", context.logger, async (input) => {
      const record = input as Record<string, unknown>;
      const identity: Record<string, string> = {};
      for (const field of ["name", "emoji", "role", "vibe", "notes"] as const) {
        const value = optionalString(record, field);
        if (value !== undefined) identity[field] = value;
      }
      const clear = record.clear;
      if (Array.isArray(clear)) {
        for (const field of clear) {
          if (typeof field === "string") identity[field] = CLEAR_FIELD;
        }
      }
      if (Object.keys(identity).length === 0) {
        return "Nothing to change: name a field to set, or list fields in `clear`.";
      }
      // The read supplies the optimistic-lock token. A concurrent edit by the user
      // is then reported rather than silently overwritten.
      const current = await runtime.stores.souls.get(scope);
      try {
        const result = await runtime.stores.souls.mutate({
          scope,
          actorType: "agent",
          actorId: scope.assistantId,
          expectedRevisionHash: current.revisionHash,
          patch: { identity },
        });
        if (!result.changed) {
          return "No change: the values you gave match what is already stored.";
        }
        return (
          `Updated. You are now at revision ${result.record.revision}. ` +
          "The change takes effect from your next turn."
        );
      } catch (err) {
        if (err instanceof SoulRevisionConflictError) {
          return (
            "Your configuration changed while you were editing it (probably your user). " +
            "Nothing was written. Look at your current values and re-apply the change if it still makes sense."
          );
        }
        if (err instanceof SoulWriteClassError) {
          return err.message;
        }
        throw err;
      }
    }),
  }) as ToolSet[string];

  // -- Peer messaging ------------------------------------------------------
  // Registered only when a usable outgoing grant exists. Without one the tool would
  // always refuse, and a tool that always refuses is worse than an absent one.
  const outgoing = await runtime.stores.messaging.listOutgoingGrants(scope).catch(() => []);
  const usableGrants = outgoing.filter((grant) => isGrantActive(grant, Date.now()));
  if (usableGrants.length > 0) {
    const peerList = usableGrants
      .map((grant) => grant.to.assistantId)
      .sort()
      .join(", ");
    tools.assistant_message = tool<Record<string, unknown>, unknown, never>({
      description:
        "Send a short written message to another assistant you have a channel to. The other " +
        `assistant reads it on its own next turn and decides for itself what to do. Available: ${peerList}. ` +
        "You cannot make it act, see its data, or use its permissions — it is a note, not a command.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          to: {
            type: "string",
            enum: usableGrants.map((grant) => grant.to.assistantId).sort(),
            description: "Which assistant to write to.",
          },
          subject: { type: "string", description: "One line summarising the message." },
          body: {
            type: "string",
            description:
              "What you want the other assistant to know. Be brief: it lands in their prompt.",
          },
        },
        required: ["to", "subject", "body"],
      }),
      execute: safely("assistant_message", context.logger, async (input) => {
        const record = input as Record<string, unknown>;
        const target = requireString(record, "to");
        const grant = usableGrants.find((candidate) => candidate.to.assistantId === target);
        if (grant === undefined) {
          return (
            `You have no channel to "${target}". Available: ${peerList}. ` +
            "A channel can only be opened by the receiving assistant's own user."
          );
        }
        const outcome = await runtime.messenger.send({
          from: scope,
          to: grant.to,
          subject: requireString(record, "subject"),
          body: requireString(record, "body"),
          senderActive: turn.assistant.status === "active",
          // Liveness of the receiver is not readable from here without crossing the
          // tenant boundary for a status field. The send policy re-checks the grant,
          // which is the authorisation-relevant part; an inactive receiver simply
          // never collects its inbox.
          receiverActive: true,
        });
        return outcome.sent
          ? `Message queued for "${target}". They will see it on their next turn; there is no reply to wait for.`
          : outcome.detail;
      }),
    }) as ToolSet[string];
  }

  return tools;
}

/**
 * Names of the tools this module can register.
 *
 * Exported so the flow's tool-authorisation policy and the operator UI can reason
 * about them without importing the builder, which needs a live runtime.
 */
export const ASSISTANT_TOOL_NAMES = [
  "skill_read",
  "skill_search",
  "workspace_list",
  "workspace_read",
  "workspace_write",
  "sandbox_run",
  "soul_update",
  "assistant_message",
] as const;
