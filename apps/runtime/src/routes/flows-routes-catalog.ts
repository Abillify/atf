// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Node-type catalog, variable/expression evaluation and Copilot endpoints (static paths).
 * (Phase 18.4 split of flows.ts, Req. 13.6.)
 */

import { validateFlow } from "../graph/flow-validator.js";
import { validateFlowDefinition } from "../graph/flow-parser.js";
import {
  COMMON_CONFIG_FIELDS,
  LLM_MODEL_FIELDS,
  NODE_TYPE_CATALOG,
} from "../graph/node-type-catalog.js";
import { describeShortcut, loadModelShortcuts } from "../graph/flow-parser/model-shortcuts.js";
import { loadFlowConstants, publicEnv } from "../graph/flow-parser/flow-constants.js";
import { evaluateFlowVariables } from "../graph/flow-parser/variable-values.js";
import { FLOW_REFERENCE } from "../graph/flow-reference-data.js";
import {
  evaluateConditionExpression,
  validateConditionExpression,
} from "../graph/condition-evaluator.js";
import { proposeFlowEdit } from "../graph/flow-copilot.js";
import { type ExpressionCopilotInput, proposeExpression } from "../graph/expression-copilot.js";
import { createLlmProvider } from "../graph/llm-factory.js";
import type { FlowDefinition } from "../types/flow.js";
import type { Hono } from "hono";
import type { FlowsContext } from "./flows-context.js";
import * as flowsShared from "./flows-shared.js";

export function registerFlowCatalogRoutes(router: Hono, fc: FlowsContext): void {
  // -------------------------------------------------------------------------
  // GET /flows/node-types — node type catalog for the Studio (forms, docs,
  // Copilot): every built-in type with its config keys, plus the tool ids of
  // connected MCP servers and the model shortcut names, so editors can offer
  // them as choices. Static path: registered before GET /flows/:id.
  // -------------------------------------------------------------------------
  router.get("/flows/node-types", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    const shortcuts =
      fc.sourceDir !== undefined ? loadModelShortcuts(fc.sourceDir) : null;
    return ctx.json({
      common: COMMON_CONFIG_FIELDS,
      types: NODE_TYPE_CATALOG,
      // Inside the node's `llm` field (shortcut/provider/model/parameters/pool)
      // — documented separately since it is not part of `config`.
      llmFields: LLM_MODEL_FIELDS,
      tools: [...(fc.knownToolIds ?? [])].sort(),
      shortcuts: shortcuts ? Object.keys(shortcuts.shortcuts ?? {}).sort() : [],
      // name → "provider · model" / "pool (strategy): …" for pickers.
      shortcutInfo: shortcuts
        ? Object.fromEntries(
            Object.keys(shortcuts.shortcuts ?? {}).map((n) => [
              n,
              describeShortcut(shortcuts, n) ?? "",
            ]),
          )
        : {},
      // Global constants (flows/constants.yaml) and the allowlisted env
      // values — what `{{const.*}}` / `{{env.*}}` in variables can read.
      constants: fc.sourceDir !== undefined ? loadFlowConstants(fc.sourceDir) : {},
      publicEnv: publicEnv(),
      // Placeholders, condition grammar, variable references, calculations —
      // the same data docs/FLOWS.md is generated from.
      reference: FLOW_REFERENCE,
      // Concrete model ids of the central model presets (for `llm.model`).
      models: shortcuts
        ? [
            ...new Set(
              Object.values(shortcuts.modelPresets ?? {}).map((p) => p.model),
            ),
          ].sort()
        : [],
    });
  });

  // -------------------------------------------------------------------------
  // POST /flows/variables/evaluate — the Studio's variables table: evaluates a
  // `variables` map (cross-references, {{const.*}}, {{env.FLOW_PUBLIC_*}},
  // {{= calculations }}) exactly as a flow load does and returns the values.
  //   Body: { variables: object }
  //   200:  { values: object, errors: [{ name, message }] }
  // -------------------------------------------------------------------------
  router.post("/flows/variables/evaluate", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    const body = (await ctx.req.json().catch(() => null)) as {
      variables?: unknown;
    } | null;
    const vars = body?.variables;
    if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
      return ctx.json(
        {
          error: {
            message: "`variables` must be an object.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    return ctx.json(
      evaluateFlowVariables(vars as Record<string, unknown>, undefined, {
        constants: fc.sourceDir !== undefined ? loadFlowConstants(fc.sourceDir) : {},
        env: publicEnv(),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // POST /flows/expressions/evaluate — the Studio's formula editor: checks a
  // routing/condition expression and evaluates it against sample values with
  // the runtime's own evaluator, so the preview is exactly what a run does.
  //   Body: { expression: string, sample?: object }
  //   200:  { valid: true, result: boolean } | { valid: false, error }
  // -------------------------------------------------------------------------
  router.post("/flows/expressions/evaluate", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    let body: { expression?: unknown; sample?: unknown };
    try {
      body = (await ctx.req.json()) as typeof body;
    } catch {
      body = {};
    }
    if (typeof body.expression !== "string") {
      return ctx.json(
        {
          error: {
            message: "Field 'expression' (string) is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const expression = body.expression.slice(0, 4000);
    if (expression.trim() === "")
      return ctx.json({ valid: true, result: true, empty: true });
    const check = validateConditionExpression(expression);
    if (!check.valid) return ctx.json({ valid: false, error: check.error });
    const sample =
      body.sample !== null &&
      typeof body.sample === "object" &&
      !Array.isArray(body.sample)
        ? (body.sample as Record<string, unknown>)
        : {};
    return ctx.json({
      valid: true,
      result: evaluateConditionExpression(
        expression,
        sample as Parameters<typeof evaluateConditionExpression>[1],
      ),
    });
  });

  // -------------------------------------------------------------------------
  // GET /flows/experiments — live A/B experiment stats (static path, must be
  // registered before GET /flows/:id so it is not captured as an id).
  // -------------------------------------------------------------------------
  router.get("/flows/experiments", async (ctx) => {
    if (!(await fc.guard(ctx, "experiments:read"))) return fc.unauthorized(ctx);
    return ctx.json({
      enabled: fc.abManager?.enabled ?? false,
      experiments: fc.abManager?.status() ?? [],
    });
  });

  // -------------------------------------------------------------------------
  // POST /flows/validate — dry-run (Stage 1)
  // -------------------------------------------------------------------------
  router.post("/flows/validate", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:read"))) return fc.unauthorized(ctx);
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Request body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    return ctx.json(validateFlow(fc.expandForValidation(body), fc.knownToolIds));
  });

  // -------------------------------------------------------------------------
  // POST /flows/expressions/copilot — the expression builder's copilot: writes
  // or changes one field value; checked with the engine's own code, never
  // applied (the builder shows a diff to accept). Static path: registered
  // BEFORE /flows/:id/copilot, which would otherwise take it (id "expressions").
  //   Body: { kind, current, instruction, field?, vocabulary, variables?, runtimeAllowed?,
  //           selection?: { start, end } }  (caret/selected range in `current`)
  //   200:  { ok: true, expression, explanation, changed } | 422 { ok: false, message }
  // -------------------------------------------------------------------------
  router.post("/flows/expressions/copilot", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:write"))) return fc.unauthorized(ctx);
    if (fc.appConfig?.defaultLlm === undefined) {
      return ctx.json(
        {
          ok: false,
          message:
            "Copilot is not configured — set DEFAULT_LLM on the backend.",
        },
        501,
      );
    }
    const body = (await ctx.req
      .json()
      .catch(() => null)) as Partial<ExpressionCopilotInput> | null;
    const kinds = ["template", "condition", "vars"];
    if (
      body === null ||
      typeof body.kind !== "string" ||
      !kinds.includes(body.kind) ||
      typeof body.instruction !== "string" ||
      body.instruction.trim() === "" ||
      !Array.isArray(body.vocabulary)
    ) {
      return ctx.json(
        {
          error: {
            message:
              "Required: kind (template|condition|vars), instruction (non-empty), vocabulary (array).",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const result = await proposeExpression(
      {
        kind: body.kind,
        current: typeof body.current === "string" ? body.current : "",
        instruction: body.instruction,
        ...(typeof body.field === "string" ? { field: body.field } : {}),
        vocabulary: body.vocabulary,
        ...(body.variables && typeof body.variables === "object"
          ? { variables: body.variables }
          : {}),
        runtimeAllowed: body.runtimeAllowed === true,
        ...(flowsShared.isSelection(body.selection) ? { selection: body.selection } : {}),
      },
      createLlmProvider(fc.appConfig.defaultLlm, fc.appConfig),
      {
        context: {
          constants:
            fc.sourceDir !== undefined ? loadFlowConstants(fc.sourceDir) : {},
          env: publicEnv(),
        },
      },
    );
    return ctx.json(result, result.ok ? 200 : 422);
  });

  // -------------------------------------------------------------------------
  // POST /flows/:id/copilot — AI-assisted edit proposal (Stage 1; never writes)
  //
  //   Body: { definition: FlowDefinition, instruction: string }
  //   200:  { ok: true, proposed, diff, explanation }
  //   422/501/400: { ok: false, message, validation? }  — no patch is ever
  //   auto-applied; the caller (Studio builder) must explicitly accept it via
  //   the normal /flows/write or /flows/:id/draft path.
  // -------------------------------------------------------------------------
  router.post("/flows/:id/copilot", async (ctx) => {
    if (!(await fc.guard(ctx, "flows:write"))) return fc.unauthorized(ctx);

    if (fc.appConfig?.defaultLlm === undefined) {
      return ctx.json(
        {
          ok: false,
          message:
            "Copilot is not configured — set DEFAULT_LLM (or another provider config) on the backend.",
        },
        501,
      );
    }

    let body: { definition?: unknown; instruction?: unknown; focus?: unknown };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Request body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    if (
      typeof body.instruction !== "string" ||
      body.instruction.trim().length === 0
    ) {
      return ctx.json(
        {
          error: {
            message: "Field 'instruction' (non-empty string) is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const parsed = validateFlowDefinition(fc.expandForValidation(body.definition));
    if (!parsed.success) {
      return ctx.json(
        {
          error: {
            message: `Field 'definition' is not a valid flow: ${parsed.error.reason}`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const model = createLlmProvider(fc.appConfig.defaultLlm, fc.appConfig);
    const focus = flowsShared.parseCopilotFocus(body.focus);
    // Hand the copilot the SOURCE form so an accepted proposal keeps its
    // shortcuts/variables; it validates via `expand`.
    const result = await proposeFlowEdit(
      body.definition as FlowDefinition,
      body.instruction,
      model,
      {
        ...(fc.knownToolIds !== undefined ? { knownToolIds: fc.knownToolIds } : {}),
        expand: (def) => fc.expandForValidation(def),
        shortcuts: Object.keys(
          (fc.sourceDir !== undefined
            ? loadModelShortcuts(fc.sourceDir)?.shortcuts
            : undefined) ?? {},
        ).sort(),
        ...(focus !== undefined ? { focus } : {}),
      },
    );

    if (!result.ok) {
      return ctx.json(
        {
          ok: false,
          message: result.message,
          ...(result.validation !== undefined
            ? { validation: result.validation }
            : {}),
        },
        422,
      );
    }

    return ctx.json({
      ok: true,
      proposed: result.proposed,
      diff: result.diff,
      explanation: result.explanation,
    });
  });
}
