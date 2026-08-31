// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow Dispatcher (`src/graph/flow-dispatcher.ts`)
 *
 * Determines which flow to execute for a request, based on:
 *   1. The requested `model` field (default — no dispatch rules apply)
 *   2. A `dispatch.json` file in `flowsDir` with declarative rules
 *
 * Rules are evaluated top-to-bottom against the RequestContext; the first
 * match wins. If no rule matches, the requested model/flow is used as-is.
 *
 * dispatch.json example:
 * {
 *   "rules": [
 *     { "description": "Admins always get the power flow",
 *       "whenRole": "admin", "targetFlow": "admin-power-flow" },
 *     { "description": "German enterprise users",
 *       "whenGroup": "enterprise", "whenLanguage": "de",
 *       "targetFlow": "de-enterprise-flow" },
 *     { "description": "Free plan → lite flow",
 *       "whenPlan": "free", "targetFlow": "lite-flow" },
 *     { "description": "param-based override",
 *       "whenParam": "channel == 'mobile'", "targetFlow": "mobile-flow" }
 *   ]
 * }
 */

import { z } from "zod";
import type { RequestContext } from "../types/monitoring.js";
import type { FlowDispatchTable, FlowDispatchRule } from "../types/flow.js";
import { parseFlowFile, resolveConfigFile } from "../util/parse-flow-file.js";
import { evaluateConditionExpression } from "./condition-evaluator.js";
import type { Logger } from "../observability/logger.js";

const DISPATCH_FILE = "dispatch";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FlowDispatchRuleSchema = z
  .object({
    description: z.string().optional(),
    whenRole: z.string().min(1).optional(),
    whenGroup: z.string().min(1).optional(),
    whenPlan: z.string().min(1).optional(),
    whenLanguage: z.string().min(1).optional(),
    whenClaim: z.string().min(1).max(1024).optional(),
    whenParam: z.string().min(1).max(1024).optional(),
    whenModel: z.string().min(1).max(512).optional(),
    targetFlow: z.string().min(1),
  })
  .refine(
    (r) =>
      r.whenRole !== undefined ||
      r.whenGroup !== undefined ||
      r.whenPlan !== undefined ||
      r.whenLanguage !== undefined ||
      r.whenClaim !== undefined ||
      r.whenParam !== undefined ||
      r.whenModel !== undefined,
    {
      message: "each dispatch rule must declare at least one 'when…' condition",
    },
  );

const FlowDispatchTableSchema = z.object({
  rules: z.array(FlowDispatchRuleSchema).max(200),
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadDispatchTable(
  flowsDir: string,
  logger?: Logger,
): FlowDispatchTable {
  const filePath = resolveConfigFile(flowsDir, DISPATCH_FILE);
  if (filePath === null) {
    return { rules: [] };
  }
  let raw: unknown;
  try {
    raw = parseFlowFile(filePath);
  } catch (err) {
    logger?.warn("Failed to read/parse dispatch config — dispatch disabled", {
      file: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { rules: [] };
  }

  const result = FlowDispatchTableSchema.safeParse(raw);
  if (!result.success) {
    logger?.warn(
      "dispatch config failed schema validation — dispatch disabled",
      {
        file: filePath,
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    );
    return { rules: [] };
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

function matchesRule(
  rule: FlowDispatchRule,
  requestedModel: string,
  ctx: RequestContext,
): boolean {
  // whenRole
  if (rule.whenRole !== undefined && ctx.role !== rule.whenRole) return false;

  // whenGroup
  if (rule.whenGroup !== undefined && !ctx.groups?.includes(rule.whenGroup))
    return false;

  // whenPlan
  if (rule.whenPlan !== undefined && ctx.plan !== rule.whenPlan) return false;

  // whenLanguage — prefix match
  if (rule.whenLanguage !== undefined) {
    const lang = ctx.language ?? "";
    if (!lang.startsWith(rule.whenLanguage)) return false;
  }

  // whenClaim — safe expression against JWT claims
  if (rule.whenClaim !== undefined) {
    if (!evaluateConditionExpression(rule.whenClaim, ctx.claims ?? {}))
      return false;
  }

  // whenParam — safe expression against requestParams
  if (rule.whenParam !== undefined) {
    if (!evaluateConditionExpression(rule.whenParam, ctx.requestParams ?? {}))
      return false;
  }

  // whenModel — regex match against the requested model name
  if (rule.whenModel !== undefined) {
    try {
      if (!new RegExp(rule.whenModel).test(requestedModel)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface FlowDispatcher {
  /**
   * Resolves the effective flow ID for a request.
   * Returns `requestedModel` unchanged when no rule matches.
   */
  resolveFlow(requestedModel: string, ctx: RequestContext): string;

  /**
   * Reloads the dispatch table from disk (called by hot-reload on dispatch.json change).
   */
  reload(): void;
}

class FlowDispatcherImpl implements FlowDispatcher {
  private table: FlowDispatchTable;

  constructor(
    private readonly flowsDir: string,
    private readonly logger?: Logger,
  ) {
    this.table = loadDispatchTable(flowsDir, logger);
  }

  resolveFlow(requestedModel: string, ctx: RequestContext): string {
    for (const rule of this.table.rules) {
      if (matchesRule(rule, requestedModel, ctx)) {
        this.logger?.debug("Dispatch rule matched", {
          description: rule.description,
          requestedModel,
          targetFlow: rule.targetFlow,
        });
        return rule.targetFlow;
      }
    }
    return requestedModel;
  }

  reload(): void {
    this.table = loadDispatchTable(this.flowsDir, this.logger);
    this.logger?.info("Dispatch table reloaded", {
      ruleCount: this.table.rules.length,
    });
  }
}

export function createFlowDispatcher(
  flowsDir: string,
  logger?: Logger,
): FlowDispatcher {
  return new FlowDispatcherImpl(flowsDir, logger);
}
