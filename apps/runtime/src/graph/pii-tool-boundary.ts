// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * PII vault at the tool boundary (`src/graph/pii-tool-boundary.ts`, ADR 0036)
 *
 * The vault replaces personal data in the conversation with placeholders, so
 * the model plans tool calls with placeholders too:
 * `ticket_lookup(email="[[PII:EMAIL:…]]")`. A tool that has to look the value
 * up in a real system finds nothing with that. For the tools an operator lists
 * in `PII_VAULT_DETOKENIZE_TOOLS`, this module puts the real values back into
 * the arguments immediately before the call leaves the Runtime.
 *
 * The list IS the security boundary: a listed tool — and whatever it talks
 * to, an MCP server on another host included — receives real personal data.
 * The default is therefore empty, which keeps today's behaviour.
 *
 * Order at the boundary, fixed by the two call sites (`agent-tools.ts`,
 * `handlers/tool.ts`): required-parameter check → egress DLP on the
 * model-supplied arguments → taint and approval → the effective-arguments
 * trace → THIS step → evidence contract, transaction token, `callTool`.
 * Approval prompts, audit records, debug traces, receipts and the tool
 * journal therefore keep the placeholder form; only what goes on the wire
 * (and the hashes that bind it) sees the real values.
 *
 * No `any` at module boundaries.
 */

import { toolRequiresApproval } from "./approval-gate.js";
import { PII_TOKEN_MARKER } from "./pii-vault.js";

/** The one vault capability this boundary needs. */
export interface PiiDetokenizer {
  detokenize(executionId: string, text: string): Promise<string>;
}

/** Narrow metrics sink, structurally satisfied by the app-wide `Metrics`. */
export interface PiiToolBoundaryMetrics {
  recordCounter(name: string, labels: Record<string, string>, by?: number): void;
}

/** Counter of tool calls whose arguments were detokenized, by tool. */
export const PII_TOOL_DETOKENIZED_METRIC =
  "aiperator_pii_vault_tool_detokenized_total";

export interface PiiToolBoundary {
  /** Whether `toolRef` (`server/tool`) is on the allowlist. */
  applies(toolRef: string): boolean;
  /**
   * Returns the arguments to send. For a listed tool every placeholder inside
   * a string value — at any depth of objects and arrays — is replaced by its
   * real value; a placeholder the vault cannot resolve stays as it is. The
   * SAME object is returned when nothing changed, so a caller can tell by
   * identity whether real values were put in.
   */
  detokenizeArgs<T>(toolRef: string, executionId: string, args: T): Promise<T>;
}

/** Depth beyond which arguments are passed through untouched. */
const MAX_DEPTH = 32;

async function mapStrings(
  value: unknown,
  replace: (text: string) => Promise<string>,
  depth: number,
  wants: (text: string) => boolean = (text) => text.includes(PII_TOKEN_MARKER),
): Promise<unknown> {
  if (typeof value === "string") {
    return wants(value) ? replace(value) : value;
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      const mapped = await mapStrings(item, replace, depth + 1, wants);
      if (mapped !== item) changed = true;
      out.push(mapped);
    }
    return changed ? out : value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const mapped = await mapStrings(item, replace, depth + 1, wants);
    if (mapped !== item) changed = true;
    out[key] = mapped;
  }
  return changed ? out : value;
}

/**
 * Builds the boundary, or `undefined` when no tool is listed — the call sites
 * then skip the step entirely.
 */
export function createPiiToolBoundary(
  vault: PiiDetokenizer,
  patterns: readonly string[],
  metrics?: PiiToolBoundaryMetrics,
): PiiToolBoundary | undefined {
  const list = patterns.map((p) => p.trim()).filter((p) => p !== "");
  if (list.length === 0) return undefined;
  // Same pattern grammar as `APPROVAL_REQUIRE_TOOLS`: full ref, bare tool
  // name, `server/*`, `*`.
  const applies = (toolRef: string): boolean =>
    toolRequiresApproval(toolRef, undefined, list);
  return {
    applies,
    async detokenizeArgs<T>(
      toolRef: string,
      executionId: string,
      args: T,
    ): Promise<T> {
      if (!applies(toolRef)) return args;
      const mapped = await mapStrings(
        args,
        (text) => vault.detokenize(executionId, text),
        0,
      );
      if (mapped !== args) {
        metrics?.recordCounter(PII_TOOL_DETOKENIZED_METRIC, { tool: toolRef });
      }
      return mapped as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Process-wide registration
// ---------------------------------------------------------------------------
//
// The vault wraps the engine from the outside (ADR 0007), so the tool call
// sites deep inside it have no reference to it. Like the transaction
// orchestrator (`getTransactionOrchestrator`), the boundary is registered once
// at bootstrap and read where a tool call is dispatched.

let active: PiiToolBoundary | undefined;

/** Registers (or, with `undefined`, clears) the boundary for this process. */
export function setPiiToolBoundary(boundary: PiiToolBoundary | undefined): void {
  active = boundary;
}

/** The registered boundary, or `undefined` when no tool is listed. */
export function getPiiToolBoundary(): PiiToolBoundary | undefined {
  return active;
}

// ---------------------------------------------------------------------------
// Tool results and retrieved content (ADR 0036, step 4)
// ---------------------------------------------------------------------------
//
// `PII_VAULT_SCOPE=messages+context` extends the vault from the inbound
// messages to the text that enters the model context during a run: tool
// results (LLM tool loop and `tool` nodes) and the chunks a `retrieval` node
// injects. The call sites tokenize AFTER the injection scan, the taint
// labels, citation registration and ref-handle masking have taken their copy,
// so the citations streamed to the caller keep the real titles and snippets,
// and BEFORE the text is stored as a tool result or put into a message. The
// tool-result copy that the groundedness gate scores is the tokenized one as
// well: with consistent placeholders (step 2) the answer and its sources then
// carry the same token for the same value, so lexical support still matches.

/** The one vault capability the context scope needs. */
export interface PiiTokenizer extends PiiDetokenizer {
  tokenize(
    executionId: string,
    tenantId: string | undefined,
    text: string,
    flowId?: string,
  ): Promise<string>;
}

export interface PiiContextScope {
  /**
   * Returns `value` with every string leaf tokenized. The SAME object comes
   * back when nothing was detected. Throws when detection fails under
   * `PII_DETECTOR_FAIL_MODE=closed`, so plaintext never reaches the model
   * silently; the caller treats that like a failed tool call.
   */
  tokenizeValue<T>(
    ctx: { executionId: string; clientId?: string; flowId?: string },
    value: T,
  ): Promise<T>;
  /**
   * The inverse for values that go to the CALLER rather than the model —
   * citations built from an already tokenized result — so the sources list a
   * user sees carries the real text. Unresolvable placeholders stay as they are.
   */
  restoreValue<T>(ctx: { executionId: string }, value: T): Promise<T>;
}

/** Strings shorter than this cannot hold a detectable value; skip them. */
const MIN_TOKENIZE_LENGTH = 5;

export function createPiiContextScope(vault: PiiTokenizer): PiiContextScope {
  return {
    async tokenizeValue<T>(
      ctx: { executionId: string; clientId?: string; flowId?: string },
      value: T,
    ): Promise<T> {
      const mapped = await mapStrings(
        value,
        (text) => vault.tokenize(ctx.executionId, ctx.clientId, text, ctx.flowId),
        0,
        (text) => text.length >= MIN_TOKENIZE_LENGTH,
      );
      return mapped as T;
    },
    async restoreValue<T>(ctx: { executionId: string }, value: T): Promise<T> {
      const mapped = await mapStrings(
        value,
        (text) => vault.detokenize(ctx.executionId, text),
        0,
      );
      return mapped as T;
    },
  };
}

let activeContextScope: PiiContextScope | undefined;

/** Registers (or clears) the context scope for this process. */
export function setPiiContextScope(scope: PiiContextScope | undefined): void {
  activeContextScope = scope;
}

/** The registered context scope, or `undefined` with `PII_VAULT_SCOPE=messages`. */
export function getPiiContextScope(): PiiContextScope | undefined {
  return activeContextScope;
}
