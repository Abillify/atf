// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Persisted execution summary returned by the backend's durable audit log
 * (GET /monitoring/history). Mirrors the backend ExecutionSummary shape.
 */
export interface PersistedExecution {
  execution_id: string;
  flow_id: string | null;
  tenant_id: string | null;
  status: "running" | "completed" | "error";
  node_count: number;
  error_count: number;
  total_latency_ms: number | null;
  /** Total estimated cost of the run (sum of node cost); null if none. */
  total_cost: number | null;
  started_at: string;
  finished_at: string | null;
  /** Display name (or email/id) of the user who triggered the run. */
  user_name: string | null;
  /** The user's prompt text (last user message), truncated. */
  user_prompt: string | null;
  /** Stable identifiers used to group requests into conversation threads. */
  conversation_id?: string | null;
  chat_id?: string | null;
  session_id?: string | null;
}
