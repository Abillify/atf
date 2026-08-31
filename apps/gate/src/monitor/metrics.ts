// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { MonitorBus, MonitorEvent } from "./events.ts";

/**
 * Lightweight Prometheus metrics, aggregated from the MonitorBus.
 *
 * No external dependency: counters and a simple duration histogram are kept in
 * memory and rendered as Prometheus text exposition on demand. Subscribing to
 * the same event stream the dashboard uses means metrics stay consistent with
 * what operators see live, at negligible cost.
 *
 * Only non-sensitive aggregates are exported (counts, durations, labels for
 * tool name / status) — never arguments, claims or prompts.
 */

const DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export class Metrics {
  private connections = 0;
  private disconnections = 0;
  private authFailures = 0;
  private errors = 0;
  private llmRequests = 0;

  /** tool|status -> count */
  private toolCalls = new Map<string, number>();
  /** tool -> { buckets, sum, count } */
  private toolDurations = new Map<string, { buckets: number[]; sum: number; count: number }>();

  private unsubscribe?: () => void;

  attach(bus: MonitorBus): void {
    this.unsubscribe = bus.subscribe((e) => this.record(e));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private record(e: MonitorEvent): void {
    switch (e.type) {
      case "connection":
        this.connections++;
        break;
      case "disconnection":
        this.disconnections++;
        break;
      case "auth_failure":
        this.authFailures++;
        break;
      case "error":
        this.errors++;
        break;
      case "llm_request":
        this.llmRequests++;
        break;
      case "tool_result": {
        const key = `${e.tool ?? "unknown"}|${e.status ?? "ok"}`;
        this.toolCalls.set(key, (this.toolCalls.get(key) ?? 0) + 1);
        if (typeof e.durationMs === "number") {
          this.observeDuration(e.tool ?? "unknown", e.durationMs);
        }
        break;
      }
    }
  }

  private observeDuration(tool: string, ms: number): void {
    let h = this.toolDurations.get(tool);
    if (!h) {
      h = { buckets: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.toolDurations.set(tool, h);
    }
    h.sum += ms;
    h.count++;
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      if (ms <= DURATION_BUCKETS[i]!) h.buckets[i]!++;
    }
  }

  /** Render the current metrics as Prometheus text exposition. */
  render(): string {
    const lines: string[] = [];

    lines.push("# HELP mcpgate_connections_total MCP sessions established.");
    lines.push("# TYPE mcpgate_connections_total counter");
    lines.push(`mcpgate_connections_total ${this.connections}`);

    lines.push("# HELP mcpgate_disconnections_total MCP sessions closed.");
    lines.push("# TYPE mcpgate_disconnections_total counter");
    lines.push(`mcpgate_disconnections_total ${this.disconnections}`);

    lines.push("# HELP mcpgate_auth_failures_total Failed authentication attempts.");
    lines.push("# TYPE mcpgate_auth_failures_total counter");
    lines.push(`mcpgate_auth_failures_total ${this.authFailures}`);

    lines.push("# HELP mcpgate_errors_total Tool / session errors.");
    lines.push("# TYPE mcpgate_errors_total counter");
    lines.push(`mcpgate_errors_total ${this.errors}`);

    lines.push("# HELP mcpgate_llm_requests_total LLM routing/interpretation requests.");
    lines.push("# TYPE mcpgate_llm_requests_total counter");
    lines.push(`mcpgate_llm_requests_total ${this.llmRequests}`);

    lines.push("# HELP mcpgate_tool_calls_total Tool invocations by tool and status.");
    lines.push("# TYPE mcpgate_tool_calls_total counter");
    for (const [key, count] of this.toolCalls) {
      const [tool, status] = key.split("|");
      lines.push(`mcpgate_tool_calls_total{tool="${escapeLabel(tool ?? "")}",status="${escapeLabel(status ?? "")}"} ${count}`);
    }

    lines.push("# HELP mcpgate_tool_duration_ms Tool execution duration in milliseconds.");
    lines.push("# TYPE mcpgate_tool_duration_ms histogram");
    for (const [tool, h] of this.toolDurations) {
      const label = escapeLabel(tool);
      let cumulative = 0;
      for (let i = 0; i < DURATION_BUCKETS.length; i++) {
        cumulative = h.buckets[i]!; // buckets are already cumulative (le semantics)
        lines.push(`mcpgate_tool_duration_ms_bucket{tool="${label}",le="${DURATION_BUCKETS[i]}"} ${cumulative}`);
      }
      lines.push(`mcpgate_tool_duration_ms_bucket{tool="${label}",le="+Inf"} ${h.count}`);
      lines.push(`mcpgate_tool_duration_ms_sum{tool="${label}"} ${h.sum}`);
      lines.push(`mcpgate_tool_duration_ms_count{tool="${label}"} ${h.count}`);
    }

    return lines.join("\n") + "\n";
  }
}
