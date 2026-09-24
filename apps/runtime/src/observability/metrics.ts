// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Metrics registry (`src/observability/metrics.ts`)
 *
 * A tiny, dependency-free metrics layer that supports counters, gauges and
 * histograms with labels, and renders them in the Prometheus text exposition
 * format (for `/metrics`) as well as a compact JSON summary (for the dashboard).
 *
 * Designed so the rest of the codebase depends only on the `Metrics` interface;
 * a no-op implementation is provided for when metrics are disabled or in tests.
 *
 * No `any` at module boundaries.
 */

type Labels = Record<string, string>;

function serializeLabels(labels: Labels | undefined): string {
  if (labels === undefined) return "";
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

// Default latency buckets in milliseconds.
const DEFAULT_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
];

interface HistogramState {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

export interface MetricsSummary {
  requestsTotal: number;
  requestsByStatus: Record<string, number>;
  nodeExecutionsTotal: number;
  nodeErrorsTotal: number;
  llmCallsTotal: number;
  llmErrorsTotal: number;
  llmCallsByProvider?: Record<string, number>;
  llmErrorsByProvider?: Record<string, number>;
  tokensPrompt: number;
  tokensCompletion: number;
  /**
   * Prompt tokens served from a provider prompt cache. A SUBSET of
   * {@link tokensPrompt}, not an addition to it.
   */
  tokensCachedPrompt: number;
  /**
   * `tokensCachedPrompt / tokensPrompt`, rounded to 4 decimals (0 when no
   * prompt tokens were recorded). This is the number to watch when changing
   * anything about how the prompt is assembled — a drop means the cacheable
   * prefix stopped being byte-stable.
   */
  promptCacheHitRatio: number;
  costTotal: number;
  costByModel: Record<string, number>;
  tokensByModel: Record<
    string,
    { prompt: number; completion: number; cachedPrompt?: number }
  >;
  activeExecutions: number;
  queueDepth: number;
  /** Response cache hits and misses (0 when caching disabled). */
  cacheHits: number;
  cacheMisses: number;
  /** Breakdown by cache layer (0 when that layer is disabled). */
  cacheExactHits: number;
  cacheSemanticHits: number;
  /** Groundedness gate outcomes (0 when the gate is disabled). */
  groundednessPassed: number;
  groundednessFailed: number;
  /** Approval gate decisions (0 when the gate is disabled). */
  approvalsApproved: number;
  approvalsDenied: number;
  /** Approximate average node latency in ms over all observations. */
  avgNodeLatencyMs: number;
}

/** Public metrics contract used across the app. */
export interface Metrics {
  recordRequest(route: string, status: number, durationMs: number): void;
  recordNode(
    flow: string,
    node: string,
    status: "completed" | "error",
    latencyMs: number,
  ): void;
  recordLlmCall(
    provider: string,
    model: string,
    status: "ok" | "error",
    promptTokens: number,
    completionTokens: number,
    cost: number,
    /**
     * Subset of `promptTokens` served from the provider's prompt cache. Omit
     * when the provider reports no cache data. Trailing + optional so existing
     * call sites stay valid.
     */
    cachedPromptTokens?: number,
  ): void;
  recordLlmRetry(provider: string, model: string): void;
  recordLlmFallback(provider: string, model: string): void;
  recordRejected(
    reason:
      | "queue_full"
      | "budget_exceeded"
      | "token_limit_exceeded"
      | "rate_limited"
      | "forbidden"
      | "input_guardrail"
      | "compliance_policy",
  ): void;
  /** Records a response-cache lookup outcome (hit avoids a provider call). */
  recordCache(result: "hit" | "miss" | "semantic-hit" | "exact-hit"): void;
  /** Records guardrail redactions by finding type (e.g. "email", "blocked"). */
  recordGuardrail(type: string, count: number): void;
  /**
   * Generic labelled counter — used by the feature modules (groundedness gate,
   * approval gate, canary rollout) so they can emit metrics without expanding
   * this interface for every new dimension.
   */
  recordCounter(
    name: string,
    labels: Record<string, string>,
    by?: number,
  ): void;
  setActiveExecutions(n: number): void;
  setQueueDepth(n: number): void;
  /** Prometheus text exposition format. */
  render(): string;
  /** Compact JSON summary for the dashboard. */
  summary(): MetricsSummary;
}

class MetricsRegistry implements Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, HistogramState>();
  private nodeLatencySum = 0;
  private nodeLatencyCount = 0;

  private incr(name: string, labels: Labels | undefined, by = 1): void {
    const key = `${name}{${serializeLabels(labels)}}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  private setGauge(name: string, value: number, labels?: Labels): void {
    const key = `${name}{${serializeLabels(labels)}}`;
    this.gauges.set(key, value);
  }

  private observe(name: string, value: number, labels?: Labels): void {
    const key = `${name}{${serializeLabels(labels)}}`;
    let h = this.histograms.get(key);
    if (h === undefined) {
      h = {
        buckets: DEFAULT_BUCKETS_MS,
        counts: new Array(DEFAULT_BUCKETS_MS.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, h);
    }
    h.sum += value;
    h.count += 1;
    let placed = false;
    for (const [i, bucket] of h.buckets.entries()) {
      if (value <= bucket) {
        // `h.counts` always has `h.buckets.length + 1` entries (see the
        // initializer above), so index `i < h.buckets.length` is always
        // in bounds; the `?? 0` is unreachable defensive fallback.
        h.counts[i] = (h.counts[i] ?? 0) + 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const lastIdx = h.counts.length - 1;
      h.counts[lastIdx] = (h.counts[lastIdx] ?? 0) + 1;
    }
  }

  recordRequest(route: string, status: number, durationMs: number): void {
    this.incr("aiperator_requests_total", { route, status: String(status) });
    this.observe("aiperator_request_duration_ms", durationMs, { route });
  }

  recordNode(
    flow: string,
    node: string,
    status: "completed" | "error",
    latencyMs: number,
  ): void {
    this.incr("aiperator_node_executions_total", { flow, node, status });
    if (status === "error")
      this.incr("aiperator_node_errors_total", { flow, node });
    this.observe("aiperator_node_latency_ms", latencyMs, { flow, node });
    this.nodeLatencySum += latencyMs;
    this.nodeLatencyCount += 1;
  }

  recordLlmCall(
    provider: string,
    model: string,
    status: "ok" | "error",
    promptTokens: number,
    completionTokens: number,
    cost: number,
    cachedPromptTokens?: number,
  ): void {
    this.incr("aiperator_llm_calls_total", { provider, model, status });
    if (status === "error")
      this.incr("aiperator_llm_errors_total", { provider, model });
    if (promptTokens > 0)
      this.incr(
        "aiperator_llm_tokens_total",
        { provider, model, type: "prompt" },
        promptTokens,
      );
    // Emitted as its own token `type` so the prompt-cache hit ratio is derivable
    // in PromQL without a second metric family:
    //   sum(...{type="cached_prompt"}) / sum(...{type="prompt"})
    // Recorded only when the provider actually reported cache data (undefined =
    // no data, which must not be conflated with a confirmed 0 cache reads).
    if (cachedPromptTokens !== undefined && cachedPromptTokens > 0)
      this.incr(
        "aiperator_llm_tokens_total",
        { provider, model, type: "cached_prompt" },
        cachedPromptTokens,
      );
    if (completionTokens > 0)
      this.incr(
        "aiperator_llm_tokens_total",
        { provider, model, type: "completion" },
        completionTokens,
      );
    if (cost > 0)
      this.incr("aiperator_llm_cost_total", { provider, model }, cost);
  }

  recordLlmRetry(provider: string, model: string): void {
    this.incr("aiperator_llm_retries_total", { provider, model });
  }

  recordLlmFallback(provider: string, model: string): void {
    this.incr("aiperator_llm_fallbacks_total", { provider, model });
  }

  recordRejected(
    reason:
      | "queue_full"
      | "budget_exceeded"
      | "token_limit_exceeded"
      | "rate_limited"
      | "forbidden"
      | "input_guardrail"
      | "compliance_policy",
  ): void {
    this.incr("aiperator_requests_rejected_total", { reason });
  }

  recordCache(result: "hit" | "miss"): void {
    this.incr("aiperator_response_cache_total", { result });
  }

  recordGuardrail(type: string, count: number): void {
    if (count > 0)
      this.incr("aiperator_guardrail_redactions_total", { type }, count);
  }

  recordCounter(name: string, labels: Record<string, string>, by = 1): void {
    this.incr(name, labels, by);
  }

  setActiveExecutions(n: number): void {
    this.setGauge("aiperator_active_executions", n);
  }

  setQueueDepth(n: number): void {
    this.setGauge("aiperator_queue_depth", n);
  }

  // ----- rendering -------------------------------------------------------

  render(): string {
    const lines: string[] = [];
    const counterNames = new Set<string>();
    for (const key of this.counters.keys()) counterNames.add(baseName(key));
    for (const name of counterNames) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of this.counters) {
        if (key.startsWith(`${name}{`))
          lines.push(`${formatSeries(key)} ${value}`);
      }
    }

    const gaugeNames = new Set<string>();
    for (const key of this.gauges.keys()) gaugeNames.add(baseName(key));
    for (const name of gaugeNames) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [key, value] of this.gauges) {
        if (key.startsWith(`${name}{`))
          lines.push(`${formatSeries(key)} ${value}`);
      }
    }

    const histNames = new Set<string>();
    for (const key of this.histograms.keys()) histNames.add(baseName(key));
    for (const name of histNames) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, h] of this.histograms) {
        if (!key.startsWith(`${name}{`)) continue;
        const baseLabels = key.substring(name.length + 1, key.length - 1); // strip name{ ... }
        let cumulative = 0;
        for (const [i, bucketMs] of h.buckets.entries()) {
          cumulative += h.counts[i] ?? 0;
          lines.push(
            `${name}_bucket{${joinLabels(baseLabels, `le="${bucketMs}"`)}} ${cumulative}`,
          );
        }
        cumulative += h.counts[h.counts.length - 1] ?? 0;
        lines.push(
          `${name}_bucket{${joinLabels(baseLabels, `le="+Inf"`)}} ${cumulative}`,
        );
        lines.push(`${name}_sum{${baseLabels}} ${h.sum}`);
        lines.push(`${name}_count{${baseLabels}} ${h.count}`);
      }
    }

    return `${lines.join("\n")}\n`;
  }

  summary(): MetricsSummary {
    const requestsByStatus: Record<string, number> = {};
    let requestsTotal = 0;
    let nodeExecutionsTotal = 0;
    let nodeErrorsTotal = 0;
    let llmCallsTotal = 0;
    let llmErrorsTotal = 0;
    const llmCallsByProvider: Record<string, number> = {};
    const llmErrorsByProvider: Record<string, number> = {};
    let tokensPrompt = 0;
    let tokensCompletion = 0;
    let tokensCachedPrompt = 0;
    let costTotal = 0;
    const costByModel: Record<string, number> = {};
    const tokensByModel: Record<
      string,
      { prompt: number; completion: number; cachedPrompt?: number }
    > = {};
    let cacheHits = 0;
    let cacheMisses = 0;
    let cacheExactHits = 0;
    let cacheSemanticHits = 0;
    let groundednessPassed = 0;
    let groundednessFailed = 0;
    let approvalsApproved = 0;
    let approvalsDenied = 0;

    for (const [key, value] of this.counters) {
      const name = baseName(key);
      const labels = parseLabels(key);
      if (name === "aiperator_requests_total") {
        requestsTotal += value;
        const s = labels.status ?? "unknown";
        requestsByStatus[s] = (requestsByStatus[s] ?? 0) + value;
      } else if (name === "aiperator_node_executions_total") {
        nodeExecutionsTotal += value;
      } else if (name === "aiperator_node_errors_total") {
        nodeErrorsTotal += value;
      } else if (name === "aiperator_llm_calls_total") {
        llmCallsTotal += value;
        const provider = labels.provider ?? "?";
        llmCallsByProvider[provider] = (llmCallsByProvider[provider] ?? 0) + value;
      } else if (name === "aiperator_llm_errors_total") {
        llmErrorsTotal += value;
        const provider = labels.provider ?? "?";
        llmErrorsByProvider[provider] = (llmErrorsByProvider[provider] ?? 0) + value;
      } else if (name === "aiperator_llm_tokens_total") {
        const m = `${labels.provider ?? "?"}/${labels.model ?? "?"}`;
        const entry = tokensByModel[m] ?? { prompt: 0, completion: 0 };
        // Explicit three-way dispatch: `cached_prompt` is a SUBSET of `prompt`
        // (already counted in the prompt series by the caller), so it must not
        // fall into the completion bucket the way a catch-all `else` would.
        if (labels.type === "prompt") {
          tokensPrompt += value;
          entry.prompt += value;
        } else if (labels.type === "cached_prompt") {
          tokensCachedPrompt += value;
          entry.cachedPrompt = (entry.cachedPrompt ?? 0) + value;
        } else {
          tokensCompletion += value;
          entry.completion += value;
        }
        tokensByModel[m] = entry;
      } else if (name === "aiperator_llm_cost_total") {
        const m = `${labels.provider ?? "?"}/${labels.model ?? "?"}`;
        costTotal += value;
        costByModel[m] = (costByModel[m] ?? 0) + value;
      } else if (name === "aiperator_response_cache_total") {
        if (labels.result === "hit") cacheHits += value;
        else if (labels.result === "miss") cacheMisses += value;
        else if (labels.result === "exact-hit") {
          cacheExactHits += value;
          cacheHits += value;
        } else if (labels.result === "semantic-hit") {
          cacheSemanticHits += value;
          cacheHits += value;
        }
      } else if (name === "aiperator_groundedness_total") {
        if (labels.result === "passed") groundednessPassed += value;
        else groundednessFailed += value;
      } else if (name === "aiperator_approvals_total") {
        if (labels.decision === "approved") approvalsApproved += value;
        else approvalsDenied += value;
      }
    }

    const activeExecutions =
      this.gauges.get("aiperator_active_executions{}") ?? 0;
    const queueDepth = this.gauges.get("aiperator_queue_depth{}") ?? 0;

    return {
      requestsTotal,
      requestsByStatus,
      nodeExecutionsTotal,
      nodeErrorsTotal,
      llmCallsTotal,
      llmErrorsTotal,
      llmCallsByProvider,
      llmErrorsByProvider,
      tokensPrompt,
      tokensCompletion,
      tokensCachedPrompt,
      promptCacheHitRatio:
        tokensPrompt > 0
          ? Math.round((tokensCachedPrompt / tokensPrompt) * 10_000) / 10_000
          : 0,
      costTotal: Math.round(costTotal * 1_000_000) / 1_000_000,
      costByModel,
      tokensByModel,
      activeExecutions,
      queueDepth,
      cacheHits,
      cacheMisses,
      cacheExactHits,
      cacheSemanticHits,
      groundednessPassed,
      groundednessFailed,
      approvalsApproved,
      approvalsDenied,
      avgNodeLatencyMs:
        this.nodeLatencyCount > 0
          ? Math.round((this.nodeLatencySum / this.nodeLatencyCount) * 100) /
            100
          : 0,
    };
  }
}

/** Everything before the first `{` in a `name{labels}` metric key. */
function baseName(key: string): string {
  return key.split("{")[0] ?? key;
}

function formatSeries(key: string): string {
  // key is "name{labels}" — Prometheus wants name{labels}. Empty label set → name.
  const name = baseName(key);
  const labels = key.substring(name.length + 1, key.length - 1);
  return labels.length > 0 ? `${name}{${labels}}` : name;
}

function joinLabels(base: string, extra: string): string {
  return base.length > 0 ? `${base},${extra}` : extra;
}

function parseLabels(key: string): Labels {
  const inner = key.substring(key.indexOf("{") + 1, key.length - 1);
  const out: Labels = {};
  if (inner.length === 0) return out;
  // labels are key="value" comma separated; values have no commas in our usage
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  for (const m of inner.matchAll(re)) {
    const [, k = "", v = ""] = m;
    out[k] = v.replace(/\\"/g, '"');
  }
  return out;
}

class NoopMetrics implements Metrics {
  recordRequest(): void {}
  recordNode(): void {}
  recordLlmCall(): void {}
  recordLlmRetry(): void {}
  recordLlmFallback(): void {}
  recordRejected(): void {}
  recordCache(): void {}
  recordGuardrail(): void {}
  recordCounter(): void {}
  setActiveExecutions(): void {}
  setQueueDepth(): void {}
  render(): string {
    return "";
  }
  summary(): MetricsSummary {
    return {
      requestsTotal: 0,
      requestsByStatus: {},
      nodeExecutionsTotal: 0,
      nodeErrorsTotal: 0,
      llmCallsTotal: 0,
      llmErrorsTotal: 0,
      tokensPrompt: 0,
      tokensCompletion: 0,
      tokensCachedPrompt: 0,
      promptCacheHitRatio: 0,
      costTotal: 0,
      costByModel: {},
      tokensByModel: {},
      activeExecutions: 0,
      queueDepth: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheExactHits: 0,
      cacheSemanticHits: 0,
      groundednessPassed: 0,
      groundednessFailed: 0,
      approvalsApproved: 0,
      approvalsDenied: 0,
      avgNodeLatencyMs: 0,
    };
  }
}

export function createMetrics(enabled = true): Metrics {
  return enabled ? new MetricsRegistry() : new NoopMetrics();
}
