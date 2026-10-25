// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * English UI catalog — the source of truth for the key set (Req 9.7).
 *
 * The `de` catalog is typed against this object, so a missing or surplus
 * German string is a compile error. Keys are namespaced by prefix
 * (`nav.*`, `chrome.*`, `common.*`); `nav.*` mirrors `src/lib/nav.ts`.
 */

import { uiEn } from "./ui.en";

export const en = {
  ...uiEn,
  "nav.group.research": "Research & Optimisation",
  "nav.group.monitoring": "Monitoring",
  "nav.group.configuration": "Configuration",
  "nav.group.budgeting": "Budgeting",

  "nav.studio": "Studio",
  "nav.studio.hint": "Build & test flows",
  "nav.memory": "Memory",
  "nav.memory.hint": "Agent long-term memory",
  "nav.eval": "Eval",
  "nav.eval.hint": "Regression eval cases",
  "nav.optimizer": "Optimizer",
  "nav.optimizer.hint": "Self-optimizing flow loop",
  "nav.canary": "Canary",
  "nav.canary.hint": "Runtime rollout & auto-rollback",
  "nav.autopilot": "Autopilot",
  "nav.autopilot.hint": "Continuous safety & quality loop",

  "nav.graph": "Live Graph",
  "nav.graph.hint": "Real-time node execution",
  "nav.traces": "Traces",
  "nav.traces.hint": "Per-execution span waterfall",
  "nav.history": "History",
  "nav.history.hint": "Past executions",
  "nav.approvals": "Approvals",
  "nav.approvals.hint": "Human-in-the-loop inbox",
  "nav.shadow": "Shadow",
  "nav.shadow.hint": "Shadow-mode A/B quality comparisons",
  "nav.security": "Security",
  "nav.security.hint": "Red-team posture & tool authz",
  "nav.providers": "Providers",
  "nav.providers.hint": "Provider health & test bench",

  "nav.flows": "Flows",
  "nav.flows.hint": "Flow registry & version diff",
  "nav.flows.health": "Flow health",
  "nav.flows.health.hint": "Load failures, shadowing, versions & evals",
  "nav.triggers": "Triggers",
  "nav.triggers.hint": "Webhook-triggered flows",
  "nav.assistants": "Assistants",
  "nav.assistants.hint": "Per-user assistants & operator constraints",
  "nav.guardrails": "Guardrails",
  "nav.guardrails.hint": "Input/output/egress policy",
  "nav.pii-vault": "PII Vault",
  "nav.pii-vault.hint": "Reversible PII tokenization",
  "nav.compliance": "Compliance",
  "nav.compliance.hint": "Policy & evidentiary dossier",
  "nav.posture": "Governance posture",
  "nav.posture.hint": "Which controls are active right now",
  "nav.citationImpact": "Citation impact",
  "nav.citationImpact.hint": "Answers whose cited sources changed",
  "nav.mcp": "MCP",
  "nav.mcp.hint": "Connected MCP servers",

  "nav.cost": "Cost & Tokens",
  "nav.cost.hint": "Spend & token usage",
  "nav.limits": "Limits",
  "nav.limits.hint": "Rate & concurrency overrides",
  "nav.tenants": "Tenants",
  "nav.tenants.hint": "Tenants, keys & budgets",
  "nav.models": "Models",
  "nav.models.hint": "Available flows/models catalog",
  "nav.jobs": "Jobs",
  "nav.jobs.hint": "Async/batch job status lookup",

  "chrome.brand": "Aiperator",
  "chrome.navigation": "Navigation",
  "chrome.menu": "Menu",
  "chrome.sections": "Dashboard sections",
  "chrome.breadcrumb": "Breadcrumb",
  "chrome.search": "Search…",
  "chrome.palette": "Command palette",
  "chrome.openMenu": "Open navigation menu",
  "chrome.closeMenu": "Close navigation menu",
  "chrome.collapse": "Collapse",
  "chrome.loading": "Loading",
  "chrome.theme.light": "Switch to light mode",
  "chrome.theme.dark": "Switch to dark mode",
  "chrome.density.comfortable": "Switch to comfortable density",
  "chrome.density.compact": "Switch to compact density",
  "chrome.language": "Switch language",
  "chrome.signOut": "Sign out",
  "chrome.sidebar.collapse": "Collapse sidebar",
  "chrome.sidebar.expand": "Expand sidebar",

  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.close": "Close",
  "common.retry": "Try again",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.tokens": "Tokens",
  "common.notFound": "—",
  "executions.filterPlaceholder": "Filter requests…",
  "executions.filterLabel": "Filter requests by keyword (request ID, prompt, user, flow)",
  "executions.clearKeyword": "Clear keyword",
  "executions.filterButton": "Filter: flows and users",
  "executions.includeFlows": "Include flows",
  "executions.excludeFlows": "Exclude flows",
} as const;

export type MessageKey = keyof typeof en;
export type Catalog = Record<MessageKey, string>;
