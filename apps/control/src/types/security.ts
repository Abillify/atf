// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Types for the Security tab, mirroring the backend `/security/*` endpoints:
 *   GET  /security/red-team/posture        → { enabled, posture, guardrailThreshold }
 *   GET  /security/red-team/runs[?flowId=] → { runs: RedTeamRunSummary[], enabled }
 *   GET  /security/red-team/runs/:runId    → RedTeamRun
 *   POST /security/red-team/:flowId/run    → RedTeamRun
 *   GET  /security/red-team/attacks        → { attacks: AttackInfo[], count }
 *   GET  /security/tool-authz              → ToolAuthzPolicyDescription
 *   GET  /security/mcp                     → { endpoint, transport, flows: McpFlowInfo[] }
 *
 * Mirror the backend shapes (src/security/*, src/graph/tool-authz.ts).
 */

export type AttackCategory =
  | "prompt_injection"
  | "jailbreak"
  | "exfiltration"
  | "pii_extraction"
  | "tool_abuse"
  | "encoding_evasion";

export type TrialVerdict = "blocked" | "bypassed" | "error";

export interface AttackTrial {
  id: string;
  runId: string;
  attackId: string;
  attackCategory: AttackCategory;
  severity: number;
  payload: string;
  verdict: TrialVerdict;
  inputScore: number;
  inputBlocked: boolean;
  response?: string;
  judgeScore?: number;
  reasoning?: string;
  durationMs: number;
  recordedAt: string;
}

export interface RedTeamRun {
  id: string;
  flowId: string;
  triggeredBy: "schedule" | "manual";
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed";
  trials: AttackTrial[];
  bypassRate?: number;
  postureScore?: number;
  thresholdAdjusted?: boolean;
  newThreshold?: number;
  regressionCasesGenerated?: number;
}

export interface RedTeamRunSummary {
  id: string;
  flowId: string;
  triggeredBy: "schedule" | "manual";
  startedAt: string;
  finishedAt?: string;
  status: RedTeamRun["status"];
  bypassRate?: number;
  postureScore?: number;
  trials: number;
  bypasses: number;
  blocks: number;
  errors: number;
  regressionCasesGenerated?: number;
}

export interface AttackInfo {
  id: string;
  category: AttackCategory;
  severity: number;
  description: string;
}

export interface PostureResponse {
  enabled: boolean;
  posture: Record<string, number>;
  guardrailThreshold: number;
}

export interface ToolAuthzRuleView {
  id: string;
  tool: string;
  action: "allow" | "deny";
  match?: Record<string, string>;
  constraints?: Record<
    string,
    { min?: number; max?: number; allowedValues?: unknown[] }
  >;
  reason?: string;
}

export interface ToolAuthzPolicyView {
  active: boolean;
  ruleCount: number;
  defaultAction: "allow" | "deny";
  rules: ToolAuthzRuleView[];
}

export interface McpFlowInfo {
  id: string;
  name: string;
  description: string;
}

export interface McpServerInfo {
  endpoint: string;
  transport: string;
  flows: McpFlowInfo[];
}
