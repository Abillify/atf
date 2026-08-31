// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { resolveContextPath, type AuthContext } from "../auth/context.ts";
import type { CompositeStep, CompositeTool } from "../config/schema.ts";
import { logger } from "../logger.ts";
import { nestedToolInvoker } from "../mcp/invocation-context.ts";
import type { ToolDefinition, ToolExecutor, ToolResult } from "./types.ts";

/** Resolves a tool name to its executor (lazy, so reload/order does not matter). */
export type CompositeResolver = (name: string) => ToolExecutor | undefined;

interface Scope {
  param: Record<string, unknown>;
  ctx: AuthContext;
  steps: Record<string, unknown>;
}

/**
 * Composite (workflow) tool.
 *
 * Runs a list of existing tools, with each step's arguments built from the
 * original call arguments (`:param.*`), the caller identity (`:ctx.*`) and the
 * JSON-parsed output of earlier steps (`:steps.<id>.*`). Every step runs with
 * the caller's own AuthContext, so identity-aware behaviour and conditions
 * apply to each underlying tool exactly as if it were called directly.
 *
 * Steps run sequentially in declaration order, EXCEPT that consecutive steps
 * sharing the same non-empty `parallelGroup` are batched and run concurrently
 * (`Promise.all`) once every step before the batch has completed. A step with
 * a `condition` that resolves falsy is skipped (its `:steps.<id>.*` value is
 * `null`) without affecting the rest of the workflow. `timeoutMs`/`retries`
 * apply per step.
 */
export class CompositeToolExecutor implements ToolExecutor {
  readonly definition: ToolDefinition;

  constructor(
    private readonly cfg: CompositeTool,
    private readonly resolve: CompositeResolver,
  ) {
    this.definition = {
      name: cfg.name,
      description: cfg.description,
      inputSchema: cfg.inputSchema as Record<string, unknown>,
      ...(cfg.outputSchema !== undefined
        ? { outputSchema: cfg.outputSchema as Record<string, unknown> }
        : {}),
    };
  }

  async execute(
    args: Record<string, unknown>,
    ctx: AuthContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const scope: Scope = { param: args ?? {}, ctx, steps: {} };
    let last: ToolResult | undefined;

    for (const batch of groupIntoBatches(this.cfg.steps)) {
      const outcomes = await Promise.all(
        batch.map(({ step, ordinal }) => this.runStep(step, ordinal, scope, ctx, signal)),
      );

      for (let i = 0; i < batch.length; i++) {
        const { step } = batch[i]!;
        const outcome = outcomes[i]!;
        if (outcome.skipped) {
          scope.steps[step.id] = null;
          continue;
        }
        last = outcome.result;
        scope.steps[step.id] = parseOutput(outcome.result);
      }

      // Report the first failing step in declaration order, so a partially
      // parallel batch still produces a deterministic error.
      const failedIndex = outcomes.findIndex((o) => !o.skipped && o.result.isError);
      if (failedIndex !== -1) {
        const { step } = batch[failedIndex]!;
        const outcome = outcomes[failedIndex]!;
        const result = outcome.skipped ? undefined : outcome.result;
        if (result) {
          return {
            content: result.content,
            isError: true,
            meta: { source: "composite", failedStep: step.id, ...result.meta },
          };
        }
      }
    }

    if (this.cfg.output) {
      const value = resolveToken(stripLeadingColon(this.cfg.output), scope);
      const structured = toStructuredContent(value);
      return {
        content: [{ type: "text", text: stringify(value) }],
        ...(structured !== undefined ? { structuredContent: structured } : {}),
        meta: { source: "composite", output: this.cfg.output, steps: this.cfg.steps.length },
      };
    }

    return (
      last ?? {
        content: [{ type: "text", text: "Composite tool executed no steps." }],
        isError: true,
        meta: { source: "composite" },
      }
    );
  }

  /** Run a single step: condition gate, argument interpolation, timeout + retry. */
  private async runStep(
    step: CompositeStep,
    stepOrdinal: number,
    scope: Scope,
    ctx: AuthContext,
    signal?: AbortSignal,
  ): Promise<{ skipped: true } | { skipped: false; result: ToolResult }> {
    if (step.condition) {
      const gate = resolveToken(stripLeadingColon(step.condition), scope);
      if (!gate) {
        logger.debug("composite step skipped", { step: step.id, condition: step.condition });
        return { skipped: true };
      }
    }

    const target = this.resolve(step.tool);
    if (!target) {
      return {
        skipped: false,
        result: {
          content: [
            {
              type: "text",
              text: `Composite '${this.cfg.name}': step '${step.id}' references unknown tool '${step.tool}'.`,
            },
          ],
          isError: true,
        },
      };
    }

    const stepArgs = interpolate(step.arguments, scope) as Record<string, unknown>;
    logger.debug("composite step", { tool: this.cfg.name, step: step.id, target: step.tool });

    const attempts = 1 + Math.max(0, step.retries ?? 0);
    let lastResult: ToolResult | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      lastResult = await this.runOnce(
        target,
        step.tool,
        stepArgs,
        ctx,
        step.timeoutMs,
        step.id,
        stepOrdinal,
        signal,
      );
      if (!lastResult.isError || attempt === attempts || signal?.aborted) break;
      if (step.retryDelayMs > 0) {
        const completed = await abortableSleep(step.retryDelayMs, signal);
        if (!completed) break;
      }
      logger.debug("composite step retry", { step: step.id, attempt: attempt + 1, of: attempts });
    }
    return { skipped: false, result: lastResult! };
  }

  private async runOnce(
    target: ToolExecutor,
    targetName: string,
    stepArgs: Record<string, unknown>,
    ctx: AuthContext,
    timeoutMs: number | undefined,
    stepId: string,
    stepOrdinal: number,
    parentSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Composite step '${stepId}' timed out after ${timeoutMs}ms.`));
        }, timeoutMs)
      : undefined;
    timer?.unref?.();

    const aborted = controller.signal.aborted
      ? Promise.resolve(abortedStepResult(stepId, timedOut, timeoutMs))
      : new Promise<ToolResult>((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => resolve(abortedStepResult(stepId, timedOut, timeoutMs)),
            { once: true },
          );
        });

    try {
      return await Promise.race([
        nestedToolInvoker()?.(
          targetName,
          stepArgs,
          ctx,
          controller.signal,
          {
            logicalActionId: `composite:${JSON.stringify([this.cfg.name, stepOrdinal, stepId])}`,
          },
        ) ?? target.execute(stepArgs, ctx, controller.signal),
        aborted,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  /** Dry-run: return the static plan without running any step. */
  async explain(_args: Record<string, unknown>, _ctx: AuthContext): Promise<ToolResult> {
    const plan = this.cfg.steps.map((s) => ({
      id: s.id,
      tool: s.tool,
      arguments: s.arguments,
      condition: s.condition,
      parallelGroup: s.parallelGroup,
      timeoutMs: s.timeoutMs,
      retries: s.retries,
      resolvable: this.resolve(s.tool) !== undefined,
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ steps: plan, output: this.cfg.output ?? "(last step)" }, null, 2),
        },
      ],
      meta: { dryRun: true, source: "composite" },
    };
  }
}

// ---------------------------------------------------------------------------
// Step batching: consecutive steps sharing a non-empty parallelGroup run
// concurrently; every other step is its own single-step batch.
// ---------------------------------------------------------------------------

interface IndexedStep {
  step: CompositeStep;
  ordinal: number;
}

function groupIntoBatches(steps: CompositeStep[]): IndexedStep[][] {
  const batches: IndexedStep[][] = [];
  for (const [ordinal, step] of steps.entries()) {
    const prevBatch = batches[batches.length - 1];
    const prevStep = prevBatch?.[0]?.step;
    const indexed = { step, ordinal };
    if (step.parallelGroup && prevStep?.parallelGroup === step.parallelGroup) {
      prevBatch?.push(indexed);
    } else {
      batches.push([indexed]);
    }
  }
  return batches;
}

function abortedStepResult(stepId: string, timedOut: boolean, timeoutMs?: number): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: timedOut
          ? `Composite step '${stepId}' timed out after ${timeoutMs}ms.`
          : `Composite step '${stepId}' was aborted.`,
      },
    ],
    isError: true,
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Token interpolation: :param.* / :ctx.* / :steps.<id>.*
// ---------------------------------------------------------------------------

const TOKEN_RE = /:((param|ctx|steps)\.[A-Za-z0-9_.[\]-]+)/g;
const WHOLE_RE = /^:((param|ctx|steps)\.[A-Za-z0-9_.[\]-]+)$/;

function interpolate(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_RE);
    if (whole) {
      const resolved = resolveToken(whole[1]!, scope);
      return resolved ?? null;
    }
    return value.replace(TOKEN_RE, (_, token: string) => {
      const resolved = resolveToken(token, scope);
      if (resolved === undefined || resolved === null) return "";
      return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v, scope);
    }
    return out;
  }
  return value;
}

function resolveToken(token: string, scope: Scope): unknown {
  const dot = token.indexOf(".");
  const ns = token.slice(0, dot);
  const path = token.slice(dot + 1);
  if (ns === "ctx") return resolveContextPath(scope.ctx, path);
  const root = ns === "param" ? scope.param : scope.steps;
  return getByPath(root, path);
}

/** Traverse a dotted path with optional [index] segments (e.g. "rows[0].id"). */
function getByPath(value: unknown, path: string): unknown {
  const parts = path.split(".").flatMap((seg) => {
    const out: Array<string | number> = [];
    const m = seg.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return [seg];
    if (m[1]) out.push(m[1]);
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
    return out;
  });
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
    } else {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function parseOutput(res: ToolResult): unknown {
  const text = res.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stringify(v: unknown): string {
  if (v === undefined) return "null";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function stripLeadingColon(s: string): string {
  return s.startsWith(":") ? s.slice(1) : s;
}

/** Wrap an object/array output value as MCP `structuredContent` (must be an object). */
function toStructuredContent(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return { items: value };
  if (typeof value === "object") return value as Record<string, unknown>;
  return undefined;
}
