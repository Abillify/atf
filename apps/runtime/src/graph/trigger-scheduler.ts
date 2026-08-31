// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Trigger Scheduler (`src/graph/trigger-scheduler.ts`)
 *
 * Drives scheduled flow executions. Scans the flow registry for flows that
 * contain a `trigger` node with `config.mode === "schedule"`, registers a timer
 * (interval or cron) for each, and fires the flow via the graph engine when the
 * timer fires.
 *
 * Design decisions:
 *   - Cron parsing uses a minimal built-in evaluator (no external dep) that
 *     supports the standard 5-field cron syntax. It rejects sub-minute fields.
 *   - Scheduled runs use the async-job path: the scheduler submits the flow and
 *     does not wait for the result. Over-run protection (maxConcurrent) is
 *     enforced per-flow via a simple in-memory counter.
 *   - The scheduler is cluster-unaware: in a multi-replica deployment every
 *     replica fires its own timers. For production: set `maxConcurrent: 1` and
 *     use the job-store idempotency key so duplicate fires are de-duplicated.
 *     A distributed leader-election path is tracked but out of scope here.
 *   - Hot-reload: when the flow registry reloads, `sync()` is called which
 *     tears down timers for removed/changed flows and registers new ones.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { FlowRegistry } from "./flow-parser.js";
import type { GraphEngineService } from "./graph-engine.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { Logger } from "../observability/logger.js";
import { nowTokens } from "./exec-runtime.js";
import type { ChatMessage } from "../types/openai.js";
import type { RequestContext } from "../types/monitoring.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import { decideRequiredScopes } from "./flow-authorizer.js";
import type { ExecutionAdmissionService } from "./execution-admission.js";

// ---------------------------------------------------------------------------
// Cron parser (minimal 5-field, no seconds)
// ---------------------------------------------------------------------------

interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
}

function parseRange(field: string, min: number, max: number): number[] {
  if (field === "*") {
    const out: number[] = [];
    for (let i = min; i <= max; i++) out.push(i);
    return out;
  }
  const out: number[] = [];
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = Number(stepStr);
      if (!Number.isFinite(step) || step < 1) continue;
      const [lo, hi] = (range === "*" ? `${min}-${max}` : (range ?? ""))
        .split("-")
        .map(Number);
      for (let i = (lo ?? min); i <= (hi ?? max); i += step) out.push(i);
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      for (let i = (lo ?? min); i <= (hi ?? max); i++) out.push(i);
    } else {
      const n = Number(part);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return [...new Set(out)].filter((n) => n >= min && n <= max).sort((a, b) => a - b);
}

function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (
    minute === undefined ||
    hour === undefined ||
    dom === undefined ||
    month === undefined ||
    dow === undefined
  ) {
    return null; // unreachable given the length check above
  }
  try {
    return {
      minute: parseRange(minute, 0, 59),
      hour: parseRange(hour, 0, 23),
      dom: parseRange(dom, 1, 31),
      month: parseRange(month, 1, 12),
      dow: parseRange(dow, 0, 6),
    };
  } catch {
    return null;
  }
}

/** Returns true when the given Date matches the cron fields. */
function cronMatches(fields: CronFields, d: Date): boolean {
  return (
    fields.minute.includes(d.getMinutes()) &&
    fields.hour.includes(d.getHours()) &&
    fields.dom.includes(d.getDate()) &&
    fields.month.includes(d.getMonth() + 1) &&
    fields.dow.includes(d.getDay())
  );
}

// ---------------------------------------------------------------------------
// ScheduledTrigger descriptor
// ---------------------------------------------------------------------------

interface ScheduledTrigger {
  flowId: string;
  nodeId: string;
  intervalSeconds?: number;
  cron?: string;
  cronFields?: CronFields;
  scheduledMessage: string;
  tenantId?: string;
  /**
   * Assistant this schedule belongs to (`config.assistantId`). Passed to the
   * authority resolver so the run can carry that assistant's delegated
   * credentials instead of none.
   */
  assistantId?: string;
  maxConcurrent: number;
  /** Currently in-flight executions for this trigger. */
  inflight: number;
}

// ---------------------------------------------------------------------------
// TriggerScheduler
// ---------------------------------------------------------------------------

/**
 * Resolves the credential a scheduled run should carry.
 *
 * Injected rather than built in, so the scheduler keeps knowing nothing about
 * assistants, delegation grants or OIDC. Returns the token to place in
 * `RequestContext.ssoToken`, plus an optional notice explaining why there is
 * none.
 *
 * Why this hook exists: a scheduled run has no user request, so it has no user
 * token. Without a resolver the scheduler passes a placeholder, and every
 * protected tool call in the fired flow is refused by the MCP wrapper with
 * "Missing required protected parameter value: user_token". Flows that only use
 * unprotected tools are unaffected, which is why the placeholder survived — the
 * failure is invisible until someone schedules a flow that touches a protected
 * tool.
 */
export type ScheduledAuthorityResolver = (params: {
  flowId: string;
  nodeId: string;
  executionId: string;
  tenantId?: string;
  assistantId?: string;
}) => Promise<{ token: string; notice?: string }>;

export interface TriggerSchedulerOptions {
  /** Minimum interval between scheduled executions (seconds). Default 60. */
  minIntervalSeconds?: number;
  /**
   * Supplies credentials for scheduled runs. Absent → the previous behaviour is
   * preserved exactly (a non-credential placeholder), so deployments that
   * schedule only unprotected flows are unchanged.
   */
  resolveAuthority?: ScheduledAuthorityResolver;
  /** Verifier used to decode delegated scheduled-run tokens into trusted claims. */
  jwtVerifier?: JwtVerifier;
  /** JWT claim names used for FlowDefinition.requiredScopes. */
  flowScopeClaims?: readonly string[];
  /** Shared admission gate run immediately before scheduled execution. */
  admission?: ExecutionAdmissionService;
}

export class TriggerScheduler {
  private readonly triggers = new Map<string, ScheduledTrigger>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  /** Shared 1-minute tick for cron evaluation (all cron triggers share one timer). */
  private cronTimer: ReturnType<typeof setInterval> | undefined;
  /** Handle for the one-shot timer that aligns the cron tick to the minute boundary. */
  private cronAlignTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly minInterval: number;
  private readonly resolveAuthority: ScheduledAuthorityResolver | undefined;
  private readonly jwtVerifier: JwtVerifier | undefined;
  private readonly flowScopeClaims: readonly string[] | undefined;
  private readonly admission: ExecutionAdmissionService | undefined;

  constructor(
    private readonly flowRegistry: FlowRegistry,
    private readonly graphEngine: GraphEngineService,
    private readonly monitoring: MonitoringServiceInterface | undefined,
    private readonly logger: Logger | undefined,
    opts: TriggerSchedulerOptions = {},
  ) {
    this.minInterval = Math.max(60, opts.minIntervalSeconds ?? 60);
    this.resolveAuthority = opts.resolveAuthority;
    this.jwtVerifier = opts.jwtVerifier;
    this.flowScopeClaims = opts.flowScopeClaims;
    this.admission = opts.admission;
  }

  /** Scan the registry and register/update triggers. */
  sync(): void {
    const active = new Set<string>();

    for (const flow of this.flowRegistry.list()) {
      for (const node of flow.nodes) {
        if (node.type !== "trigger") continue;
        const cfg = (node.config ?? {}) as Record<string, unknown>;
        if (cfg.mode !== "schedule") continue;

        const key = `${flow.id}::${node.id}`;
        active.add(key);

        const intervalSeconds = typeof cfg.intervalSeconds === "number"
          ? Math.max(this.minInterval, cfg.intervalSeconds as number)
          : undefined;
        const cronExpr = typeof cfg.cron === "string" ? cfg.cron : undefined;
        const scheduledMessage = typeof cfg.scheduledMessage === "string"
          ? cfg.scheduledMessage
          : "Run scheduled flow.";
        const tenantId = typeof cfg.tenantId === "string" ? cfg.tenantId : undefined;
        const assistantId =
          typeof cfg.assistantId === "string" && cfg.assistantId.trim() !== ""
            ? cfg.assistantId.trim()
            : undefined;
        const maxConcurrent = typeof cfg.maxConcurrent === "number"
          ? Math.max(1, cfg.maxConcurrent as number)
          : 1;

        if (intervalSeconds === undefined && cronExpr === undefined) {
          this.logger?.warn("Trigger node has no intervalSeconds or cron — skipping", {
            flowId: flow.id, nodeId: node.id,
          });
          continue;
        }

        // Check if the existing trigger is unchanged
        const existing = this.triggers.get(key);
        const unchanged =
          existing !== undefined &&
          existing.intervalSeconds === intervalSeconds &&
          existing.cron === cronExpr &&
          existing.scheduledMessage === scheduledMessage &&
          existing.tenantId === tenantId &&
          existing.assistantId === assistantId &&
          existing.maxConcurrent === maxConcurrent;

        if (unchanged) continue;

        // Tear down the old timer for this key
        const oldTimer = this.timers.get(key);
        if (oldTimer !== undefined) clearInterval(oldTimer);

        const descriptor: ScheduledTrigger = {
          flowId: flow.id,
          nodeId: node.id,
          intervalSeconds,
          cron: cronExpr,
          ...(cronExpr !== undefined ? { cronFields: parseCron(cronExpr) ?? undefined } : {}),
          scheduledMessage,
          tenantId,
          assistantId,
          maxConcurrent,
          inflight: 0,
        };
        this.triggers.set(key, descriptor);

        if (intervalSeconds !== undefined) {
          const timer = setInterval(() => {
            void this.fire(descriptor);
          }, intervalSeconds * 1000);
          (timer as unknown as { unref?: () => void }).unref?.();
          this.timers.set(key, timer);
          this.logger?.info("Scheduled trigger registered (interval)", {
            flowId: flow.id, nodeId: node.id, intervalSeconds,
          });
        }
        // Cron triggers are driven by the shared cronTimer started in start()
      }
    }

    // Tear down triggers for flows/nodes no longer in the registry. Iterate
    // over the trigger set (not just timers) because cron triggers have no
    // per-key interval timer — they share the cron tick — and would otherwise
    // never be removed and keep firing after their flow is deleted.
    for (const key of [...this.triggers.keys()]) {
      if (!active.has(key)) {
        const timer = this.timers.get(key);
        if (timer !== undefined) {
          clearInterval(timer);
          this.timers.delete(key);
        }
        this.triggers.delete(key);
        this.logger?.info("Scheduled trigger removed (flow no longer in registry)", { key });
      }
    }

    // Ensure cron triggers have a shared tick if any cron trigger exists.
    // Guard on BOTH the running interval and the pending alignment timer so a
    // rapid double-sync() before the minute boundary cannot start two ticks.
    const hasCron = [...this.triggers.values()].some((t) => t.cron !== undefined);
    if (hasCron && this.cronTimer === undefined && this.cronAlignTimer === undefined) {
      this._startCronTick();
    } else if (!hasCron) {
      if (this.cronTimer !== undefined) {
        clearInterval(this.cronTimer);
        this.cronTimer = undefined;
      }
      if (this.cronAlignTimer !== undefined) {
        clearTimeout(this.cronAlignTimer);
        this.cronAlignTimer = undefined;
      }
    }
  }

  /** Initial start — scan the registry and set up timers. */
  start(): void {
    this.sync();
    this.logger?.info("Trigger scheduler started", {
      total: this.triggers.size,
      interval: [...this.triggers.values()].filter((t) => t.intervalSeconds !== undefined).length,
      cron: [...this.triggers.values()].filter((t) => t.cron !== undefined).length,
    });
  }

  /** Stop all timers. */
  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    if (this.cronTimer !== undefined) {
      clearInterval(this.cronTimer);
      this.cronTimer = undefined;
    }
    if (this.cronAlignTimer !== undefined) {
      clearTimeout(this.cronAlignTimer);
      this.cronAlignTimer = undefined;
    }
    this.logger?.info("Trigger scheduler stopped");
  }

  /** Returns a read-only snapshot of registered triggers for the dashboard. */
  status(): Array<{
    flowId: string;
    nodeId: string;
    mode: "interval" | "cron";
    intervalSeconds?: number;
    cron?: string;
    inflight: number;
    maxConcurrent: number;
  }> {
    return [...this.triggers.values()].map((t) => ({
      flowId: t.flowId,
      nodeId: t.nodeId,
      mode: t.cron !== undefined ? "cron" : "interval",
      ...(t.intervalSeconds !== undefined ? { intervalSeconds: t.intervalSeconds } : {}),
      ...(t.cron !== undefined ? { cron: t.cron } : {}),
      inflight: t.inflight,
      maxConcurrent: t.maxConcurrent,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _startCronTick(): void {
    // Fire every minute, on the minute boundary.
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    this.cronAlignTimer = setTimeout(() => {
      this.cronAlignTimer = undefined;
      this.cronTimer = setInterval(() => {
        const now = new Date();
        for (const trigger of this.triggers.values()) {
          if (trigger.cronFields === undefined) continue;
          if (cronMatches(trigger.cronFields, now)) {
            void this.fire(trigger);
          }
        }
      }, 60_000);
      (this.cronTimer as unknown as { unref?: () => void }).unref?.();
    }, msToNextMinute);
    (this.cronAlignTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async fire(trigger: ScheduledTrigger): Promise<void> {
    if (trigger.inflight >= trigger.maxConcurrent) {
      this.logger?.warn("Scheduled trigger skipped — max concurrent executions reached", {
        flowId: trigger.flowId, inflight: trigger.inflight,
      });
      return;
    }
    trigger.inflight++;

    const now = new Date();
    const tokens = nowTokens(now);
    const message = trigger.scheduledMessage.replace(
      /\{\{\s*now\.([\w]+)\s*\}\}/g,
      (_m, field: string) => tokens[field] ?? "",
    );

    const executionId = crypto.randomUUID();

    // A scheduled run has no user request and therefore no user token. When an
    // authority resolver is wired (assistant deployments), it supplies the
    // assistant's delegated credential — or an empty token plus a stated reason
    // when the user granted none. An empty token is deliberate: the MCP wrapper
    // then refuses protected calls locally with a clear message instead of
    // sending a non-credential to the identity provider.
    let scheduledToken = `scheduled:${executionId}`;
    let authorityNotice: string | undefined;
    if (this.resolveAuthority !== undefined) {
      try {
        const resolved = await this.resolveAuthority({
          flowId: trigger.flowId,
          nodeId: trigger.nodeId,
          executionId,
          ...(trigger.tenantId !== undefined ? { tenantId: trigger.tenantId } : {}),
          ...(trigger.assistantId !== undefined
            ? { assistantId: trigger.assistantId }
            : {}),
        });
        scheduledToken = resolved.token;
        authorityNotice = resolved.notice;
      } catch (err) {
        // Credential resolution must not stop the schedule: the flow may not need
        // protected tools at all. Fail to NO authority (empty token), never to the
        // placeholder, so a protected call is refused rather than misdirected.
        scheduledToken = "";
        authorityNotice =
          "Credentials for this scheduled run could not be resolved, so tools acting on a user's behalf are unavailable.";
        this.logger?.warn("Scheduled trigger authority resolution failed", {
          flowId: trigger.flowId,
          nodeId: trigger.nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const claims = this.jwtVerifier?.decodePayload(scheduledToken) ?? undefined;
    const ctx: RequestContext = {
      ssoToken: scheduledToken,
      executionId,
      ...(claims !== undefined ? { claims } : {}),
      ...(trigger.tenantId !== undefined ? { clientId: trigger.tenantId } : {}),
      ...(trigger.assistantId !== undefined || authorityNotice !== undefined
        ? {
            requestParams: {
              ...(trigger.assistantId !== undefined
                ? { assistant_id: trigger.assistantId }
                : {}),
              ...(authorityNotice !== undefined
                ? { authority_notice: authorityNotice }
                : {}),
            },
          }
        : {}),
    };

    const flow = this.flowRegistry.get(trigger.flowId);
    const scopeDecision =
      flow === undefined
        ? { allowed: false, reason: "Flow is no longer available." }
        : decideRequiredScopes(
            flow.requiredScopes,
            ctx,
            this.flowScopeClaims,
          );
    if (!scopeDecision.allowed) {
      trigger.inflight--;
      this.logger?.warn("Scheduled trigger denied by flow scope policy", {
        flowId: trigger.flowId,
        executionId,
      });
      return;
    }

    if (this.admission !== undefined) {
      const admitted = await this.admission.admit(trigger.flowId, ctx);
      if (!admitted.allowed) {
        trigger.inflight--;
        this.logger?.warn("Scheduled trigger denied by execution admission", {
          flowId: trigger.flowId,
          executionId,
          reason: admitted.failure.code,
        });
        return;
      }
    }

    const messages: ChatMessage[] = [{ role: "user", content: message }];

    this.logger?.info("Scheduled trigger firing", {
      flowId: trigger.flowId,
      executionId,
      message: message.slice(0, 120),
    });

    try {
      await this.graphEngine.executeFlow(
        trigger.flowId,
        messages,
        ctx,
        async () => {},   // discard streaming tokens
        async () => {},   // discard usage
        this.monitoring,
      );
    } catch (err) {
      this.logger?.error("Scheduled trigger execution failed", {
        flowId: trigger.flowId,
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      trigger.inflight--;
    }
  }
}

export function createTriggerScheduler(
  flowRegistry: FlowRegistry,
  graphEngine: GraphEngineService,
  monitoring: MonitoringServiceInterface | undefined,
  logger: Logger | undefined,
  opts?: TriggerSchedulerOptions,
): TriggerScheduler {
  return new TriggerScheduler(flowRegistry, graphEngine, monitoring, logger, opts);
}
