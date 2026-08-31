// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { FlowRegistry } from "./flow-parser.js";
import type { GraphEngineService } from "./graph-engine.js";
import {
  decideFlowAccess,
  type FlowAuthorizer,
} from "./flow-authorizer.js";
import type { RequestContext } from "../types/monitoring.js";
import type { BudgetService } from "../observability/cost.js";
import type { TokenLimitEnforcer } from "../observability/token-limits.js";
import type { ByokResolver } from "./tenant-provider-keys.js";
import type { ByokProvider } from "./tenant-provider-keys.js";
import {
  isByokProvider,
  parseBedrockByokCredentials,
} from "./tenant-provider-keys.js";
import {
  isKnownProviderName,
  isLocalProviderName,
  resolveProviderProtocol,
} from "../config/providers.js";
import type { CompliancePolicyLoader } from "../compliance/policy-loader.js";
import { evaluatePolicyForModels } from "../compliance/policy-evaluator.js";
import type { FlowDefinition, LlmConfig } from "../types/flow.js";

/**
 * Recognises an LlmConfig-shaped value. A provider must RESOLVE (named instance
 * or built-in protocol) rather than match a fixed enum, so admission covers
 * named endpoints too — otherwise a flow using them would skip the compliance,
 * token-limit and BYOK checks entirely.
 */
function asLlmConfig(value: unknown): LlmConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.provider !== "string" ||
    !isKnownProviderName(candidate.provider) ||
    typeof candidate.model !== "string" || candidate.model.trim() === ""
  ) return undefined;
  return value as LlmConfig;
}

function collectExecutionLlmConfigs(
  flow: FlowDefinition,
  defaults: { defaultLlm?: LlmConfig; fallbackLlm?: LlmConfig; fallbackChain?: readonly LlmConfig[] },
): LlmConfig[] {
  const configs: LlmConfig[] = [];
  const seen = new Set<string>();
  const add = (candidate: unknown): void => {
    const llm = asLlmConfig(candidate);
    if (llm === undefined) return;
    const key = `${llm.provider}/${llm.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      configs.push(llm);
    }
  };
  const walk = (value: unknown): void => {
    add(value);
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
    } else if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) walk(entry);
    }
  };
  for (const node of flow.nodes) walk(node);

  const needsDefault = flow.nodes.some((node) => {
    if ((node.type === "llm" || node.type === "classifier") && node.llm === undefined) return true;
    if (node.type !== "agent-harness" || node.config?.plannerless === true) return false;
    return node.llm === undefined && asLlmConfig(node.config?.plannerLlm) === undefined;
  });
  if (needsDefault) add(defaults.defaultLlm);

  // The LLM handler can move to deployment-wide fallback candidates after a
  // provider failure. Admission must cover those candidates before execution.
  if (flow.nodes.some((node) => node.type === "llm")) {
    add(defaults.fallbackLlm);
    for (const fallback of defaults.fallbackChain ?? []) add(fallback);
  }
  return configs;
}

export type ByokMode = "disabled" | "optional" | "required";

export interface AdmissionFailure {
  status: 402 | 403 | 404 | 503;
  code: "not_found" | "forbidden" | "compliance" | "capacity" | "budget" | "token_limit" | "byok";
  message: string;
}

export type AdmissionResult = { allowed: true } | { allowed: false; failure: AdmissionFailure };

/** Raised when a non-HTTP execution is denied before it reaches the engine. */
export class ExecutionAdmissionError extends Error {
  constructor(readonly failure: AdmissionFailure) {
    super(failure.message);
    this.name = "ExecutionAdmissionError";
  }
}

/** Enforces the shared admission policy immediately before engine execution. */
export async function requireExecutionAdmission(
  admission: Pick<ExecutionAdmissionService, "admit">,
  flowId: string,
  requestCtx: RequestContext,
): Promise<void> {
  const result = await admission.admit(flowId, requestCtx);
  if (!result.allowed) throw new ExecutionAdmissionError(result.failure);
}

/**
 * Transport-neutral admission gate. Every non-HTTP engine entry point must call
 * this immediately before executeFlow; HTTP routes retain their response
 * formatting but use the same underlying policy inputs.
 */
export class ExecutionAdmissionService {
  constructor(
    private readonly opts: {
      flowRegistry: FlowRegistry;
      graphEngine: GraphEngineService;
      authorizationEnabled?: boolean;
      authorizer?: FlowAuthorizer;
      flowScopeClaims?: readonly string[];
      compliancePolicyLoader?: Pick<CompliancePolicyLoader, "policy">;
      providerRegions?: Record<string, string>;
      failClosedUnknownRegion?: boolean;
      costTracker?: BudgetService;
      budgetDailyPerTenant?: number;
      limitEnforcer?: TokenLimitEnforcer;
      byokResolver?: ByokResolver;
      byokMode?: ByokMode;
      defaultLlm?: LlmConfig;
      fallbackLlm?: LlmConfig;
      fallbackChain?: readonly LlmConfig[];
    },
  ) {}

  async admit(flowId: string, requestCtx: RequestContext): Promise<AdmissionResult> {
    const flow = this.opts.flowRegistry.get(flowId);
    if (flow === undefined) {
      return this.deny(404, "not_found", `Flow '${flowId}' not found.`);
    }
    const access = decideFlowAccess(
      flow,
      requestCtx,
      this.opts.authorizer,
      this.opts.flowScopeClaims,
      this.opts.authorizationEnabled ?? true,
    );
    if (!access.allowed) return this.deny(403, "forbidden", access.reason ?? "You are not permitted to use this flow.");

    const llmConfigs = collectExecutionLlmConfigs(flow, this.opts);
    const policy = this.opts.authorizationEnabled === false
      ? undefined
      : this.opts.compliancePolicyLoader?.policy;
    for (const llmConfig of llmConfigs) {
      const isLocal = llmConfig.provider === "ollama";
      const region = isLocal ? "local" : this.opts.providerRegions?.[llmConfig.provider];
      if (
        this.opts.authorizationEnabled !== false &&
        this.opts.failClosedUnknownRegion === true &&
        region === undefined
      ) {
        return this.deny(
          403,
          "compliance",
          `Request denied: provider region for '${llmConfig.provider}' is not verified.`,
        );
      }
      if (policy === undefined) continue;
      const result = evaluatePolicyForModels(policy, [llmConfig], {
        ...(requestCtx.clientId !== undefined ? { tenantId: requestCtx.clientId } : {}),
        ...(requestCtx.role !== undefined ? { role: requestCtx.role } : {}),
        ...(flow.dataClasses !== undefined ? { dataClasses: flow.dataClasses } : {}),
        flowId,
        ...(region !== undefined ? { region } : {}),
      });
      const unknownRegion = this.opts.failClosedUnknownRegion === true && result.violations.some(
        (v) => v.blocking === false && v.message.includes("no region context"),
      );
      if (result.decision === "deny" || unknownRegion) {
        return this.deny(403, "compliance", "Request denied by compliance policy.");
      }
    }

    if (!this.opts.graphEngine.hasCapacity()) {
      return this.deny(503, "capacity", "Server is at capacity. Please retry shortly.");
    }
    if (this.opts.costTracker !== undefined && (this.opts.budgetDailyPerTenant ?? 0) > 0) {
      const budget = await this.opts.costTracker.check(requestCtx.clientId);
      if (!budget.allowed) return this.deny(402, "budget", "Daily budget has been exhausted.");
    }
    if (this.opts.limitEnforcer !== undefined) {
      try {
        const violation = await this.opts.limitEnforcer.check({
          userId: requestCtx.userId,
          flowId,
          models: llmConfigs.map((config) => config.model),
        });
        if (violation !== null) return this.deny(402, "token_limit", "Token limit has been exhausted.");
      } catch {
        // Preserve the existing token-limit availability behavior.
      }
    }

    const byokMode = this.opts.byokMode ?? "optional";
    if (byokMode === "disabled") {
      delete requestCtx.providerKeyOverrides;
    } else {
      // BYOK is keyed by PROTOCOL (a tenant supplies one credential per provider
      // account, not per named endpoint), and local endpoints need no tenant key.
      const requiredProviders = [
        ...new Set(
          llmConfigs
            .filter((config) => !isLocalProviderName(config.provider))
            .map((config) => resolveProviderProtocol(config.provider))
            .filter((protocol): protocol is ByokProvider =>
              protocol !== undefined && isByokProvider(protocol),
            ),
        ),
      ];
      if (this.opts.byokResolver === undefined || requestCtx.clientId === undefined) {
        if (byokMode === "required" && requiredProviders.length > 0) {
          return this.deny(403, "byok", "Tenant BYOK credentials are required for every LLM provider used by this flow.");
        }
      } else {
        try {
          const overrides = await this.opts.byokResolver.resolve(requestCtx.clientId);
          if (byokMode === "required") {
            const missing = requiredProviders.filter((provider) => {
              const value = overrides[provider];
              if (typeof value !== "string" || value.trim() === "") return true;
              return provider === "bedrock" && parseBedrockByokCredentials(value) === undefined;
            });
            if (missing.length > 0) {
              return this.deny(
                403,
                "byok",
                `Tenant BYOK credentials are missing for: ${missing.join(", ")}.`,
              );
            }
          }
          requestCtx.providerKeyOverrides = overrides;
        } catch {
          if (byokMode === "required") return this.deny(503, "byok", "Tenant BYOK key resolution failed.");
        }
      }
    }
    return { allowed: true };
  }

  private deny(status: AdmissionFailure["status"], code: AdmissionFailure["code"], message: string): AdmissionResult {
    return { allowed: false, failure: { status, code, message } };
  }
}
