import { Hono } from "hono";
import type { AppConfig } from "../config/index.js";
import type { Metrics } from "../observability/metrics.js";
import type { ProviderCircuitBreaker } from "../graph/provider-circuit-breaker.js";
import {
  configuredProviderNames,
  getProviderInstance,
  resolveProviderProtocol,
} from "../config/providers.js";
import { getModelCapabilities } from "../graph/model-capabilities.js";
import {
  loadModelShortcuts,
  type ModelShortcutsData,
} from "../graph/flow-parser/model-shortcuts.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface ProviderMonitoringRouterDeps {
  metrics: Metrics;
  config: AppConfig;
  providerCircuitBreaker: ProviderCircuitBreaker;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

/**
 * The four capability axes the operator monitoring plane surfaces per provider:
 * reasoning, tool-calling, structured output and vision. Derived from the same
 * {@link getModelCapabilities} registry the engine routes with, so what the
 * dashboard shows is exactly what the runtime enforces.
 */
interface CapabilityView {
  reasoning: boolean;
  toolCalling: boolean;
  structuredOutput: string;
  visionInput: boolean;
  contextLength?: number;
}

function capabilityView(provider: string, model: string): CapabilityView {
  const caps = getModelCapabilities(provider, model);
  return {
    reasoning: caps.reasoning,
    toolCalling: caps.toolCalling,
    structuredOutput: caps.structuredOutput,
    visionInput: caps.visionInput,
    ...(caps.contextLength !== undefined
      ? { contextLength: caps.contextLength }
      : {}),
  };
}

/**
 * Collects every provider a pool shortcut routes to, following `shortcut`
 * references into nested sub-pools. Cycle-guarded via `seen` so a
 * self-referential or mutually-referential shortcut file degrades gracefully
 * instead of recursing forever.
 */
function collectPoolProviders(
  shortcutName: string,
  data: ModelShortcutsData,
  seen: Set<string>,
): string[] {
  if (seen.has(shortcutName)) return [];
  seen.add(shortcutName);
  const shortcut = data.shortcuts[shortcutName];
  if (shortcut === undefined) return [];
  if (!("members" in shortcut)) {
    const engine = data.engines[shortcut.engine];
    return engine === undefined ? [] : [engine.provider];
  }
  return shortcut.members.flatMap((member) => {
    if (member.shortcut !== undefined) {
      return collectPoolProviders(member.shortcut, data, seen);
    }
    if (member.engine === undefined) return [];
    const engine = data.engines[member.engine];
    return engine === undefined ? [] : [engine.provider];
  });
}

export function createProviderMonitoringRouter(
  deps: ProviderMonitoringRouterDeps,
): Hono {
  const router = new Hono();
  const auth =
    deps.operatorAuth ??
    createOperatorAuthorizer({ authRequired: deps.authRequired ?? false });

  router.get("/monitoring/providers", async (ctx) => {
    const authorized = await auth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!authorized.ok) {
      return ctx.json(
        { error: { message: "Unauthorized operator access." } },
        401,
      );
    }

    const summary = deps.metrics.summary();
    const calls = summary.llmCallsByProvider ?? {};
    const errors = summary.llmErrorsByProvider ?? {};

    // Union of provider names: those explicitly configured via PROVIDERS, plus
    // any that only show up as the `<provider>/<model>` prefix in the recorded
    // token/cost metrics (so a provider that was called via a bare-protocol
    // reference still appears even when it is not a named instance).
    const modelKeys = new Set([
      ...Object.keys(summary.tokensByModel),
      ...Object.keys(summary.costByModel),
    ]);
    const providerFromKey = (key: string): string | undefined => {
      const slash = key.indexOf("/");
      return slash > 0 ? key.slice(0, slash) : undefined;
    };
    const names = [
      ...new Set([
        ...configuredProviderNames(),
        ...[...modelKeys].flatMap((key) => {
          const provider = providerFromKey(key);
          return provider === undefined ? [] : [provider];
        }),
        ...Object.keys(calls),
      ]),
    ];

    const providers = names.map((provider) => {
      const providerModels = [...modelKeys]
        .filter((key) => key.startsWith(`${provider}/`))
        .map((key) => key.slice(provider.length + 1));
      // Capabilities are a property of the (protocol, model) pair. Use the first
      // observed model, else the configured default, else "unknown" (fails
      // closed to the global-default capabilities).
      const model =
        providerModels[0] ?? deps.config.defaultLlm?.model ?? "unknown";
      const tokens = providerModels.reduce((total, name) => {
        const row = summary.tokensByModel[`${provider}/${name}`];
        return total + (row?.prompt ?? 0) + (row?.completion ?? 0);
      }, 0);
      const protocol = resolveProviderProtocol(provider);
      return {
        name: provider,
        ...(protocol !== undefined ? { protocol } : {}),
        configured: getProviderInstance(provider) !== undefined,
        models: providerModels,
        capabilities: capabilityView(provider, model),
        // Circuit-breaker state is the reachability signal: `open` means the
        // provider tripped the transport-failure threshold and is currently
        // treated as unreachable.
        status: deps.providerCircuitBreaker.getState(provider),
        calls: calls[provider] ?? 0,
        errors: errors[provider] ?? 0,
        tokens,
      };
    });

    const shortcuts = loadModelShortcuts(deps.config.flowsDir);
    const pools =
      shortcuts === null
        ? []
        : Object.entries(shortcuts.shortcuts).flatMap(([name, shortcut]) => {
            if (!("members" in shortcut)) return [];
            const poolProviders = [
              ...new Set(collectPoolProviders(name, shortcuts, new Set())),
            ];
            return [
              {
                name,
                strategy: shortcut.strategy,
                providers: poolProviders,
                // Pool-level aggregates use exactly the same per-provider
                // metrics summed over the pool's members.
                calls: poolProviders.reduce(
                  (total, provider) => total + (calls[provider] ?? 0),
                  0,
                ),
                errors: poolProviders.reduce(
                  (total, provider) => total + (errors[provider] ?? 0),
                  0,
                ),
                // A pool is unreachable only when EVERY member's breaker is open
                // (any reachable member can still serve the pool).
                unreachable:
                  poolProviders.length > 0 &&
                  poolProviders.every(
                    (provider) =>
                      deps.providerCircuitBreaker.getState(provider).state ===
                      "open",
                  ),
              },
            ];
          });

    return ctx.json({
      pools,
      providers,
      // Queue depth and active executions are process-wide (a single shared
      // admission semaphore), so they are reported once at the global level
      // rather than faked per-provider.
      global: {
        queueDepth: summary.queueDepth,
        activeExecutions: summary.activeExecutions,
      },
    });
  });
  return router;
}
