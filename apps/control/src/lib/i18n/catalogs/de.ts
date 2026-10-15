// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * German UI catalog (Req 9.7, Task 13.6).
 *
 * Typed as `Catalog` (= `Record<MessageKey, string>` from the English
 * source of truth), so a missing or surplus key fails the typecheck.
 */

import type { Catalog } from "./en";
import { uiDe } from "./ui.de";

export const de: Catalog = {
  ...uiDe,
  "nav.group.research": "Recherche & Optimierung",
  "nav.group.monitoring": "Monitoring",
  "nav.group.configuration": "Konfiguration",
  "nav.group.budgeting": "Budgetierung",

  "nav.studio": "Studio",
  "nav.studio.hint": "Flows bauen & testen",
  "nav.memory": "Memory",
  "nav.memory.hint": "Langzeitgedächtnis der Agenten",
  "nav.eval": "Eval",
  "nav.eval.hint": "Regressions-Eval-Fälle",
  "nav.optimizer": "Optimizer",
  "nav.optimizer.hint": "Selbstoptimierender Flow-Loop",
  "nav.canary": "Canary",
  "nav.canary.hint": "Runtime-Rollout & Auto-Rollback",
  "nav.autopilot": "Autopilot",
  "nav.autopilot.hint": "Kontinuierlicher Safety- & Quality-Loop",

  "nav.graph": "Live-Graph",
  "nav.graph.hint": "Knoten-Ausführung in Echtzeit",
  "nav.traces": "Traces",
  "nav.traces.hint": "Span-Waterfall pro Ausführung",
  "nav.history": "Verlauf",
  "nav.history.hint": "Vergangene Ausführungen",
  "nav.approvals": "Freigaben",
  "nav.approvals.hint": "Human-in-the-loop-Posteingang",
  "nav.shadow": "Shadow",
  "nav.shadow.hint": "Shadow-A/B-Qualitätsvergleiche",
  "nav.security": "Sicherheit",
  "nav.security.hint": "Red-Team-Posture & Tool-Autorisierung",
  "nav.providers": "Provider",
  "nav.providers.hint": "Provider-Gesundheit & Testbank",

  "nav.flows": "Flows",
  "nav.flows.hint": "Flow-Registry & Versions-Diff",
  "nav.triggers": "Trigger",
  "nav.triggers.hint": "Per Webhook ausgelöste Flows",
  "nav.assistants": "Assistenten",
  "nav.assistants.hint": "Assistenten pro Nutzer & Operator-Grenzen",
  "nav.guardrails": "Guardrails",
  "nav.guardrails.hint": "Input-/Output-/Egress-Policy",
  "nav.pii-vault": "PII-Vault",
  "nav.pii-vault.hint": "Reversible PII-Tokenisierung",
  "nav.compliance": "Compliance",
  "nav.compliance.hint": "Policy & Nachweisdossier",
  "nav.mcp": "MCP",
  "nav.mcp.hint": "Verbundene MCP-Server",

  "nav.cost": "Kosten & Tokens",
  "nav.cost.hint": "Ausgaben & Token-Verbrauch",
  "nav.limits": "Limits",
  "nav.limits.hint": "Rate- & Parallelitäts-Overrides",
  "nav.tenants": "Tenants",
  "nav.tenants.hint": "Tenants, Keys & Budgets",
  "nav.models": "Modelle",
  "nav.models.hint": "Katalog verfügbarer Flows/Modelle",
  "nav.jobs": "Jobs",
  "nav.jobs.hint": "Status async-/Batch-Jobs abrufen",

  "chrome.brand": "Aiperator",
  "chrome.navigation": "Navigation",
  "chrome.menu": "Menü",
  "chrome.sections": "Dashboard-Bereiche",
  "chrome.breadcrumb": "Brotkrümelnavigation",
  "chrome.search": "Suchen…",
  "chrome.palette": "Befehlspalette",
  "chrome.openMenu": "Navigationsmenü öffnen",
  "chrome.closeMenu": "Navigationsmenü schließen",
  "chrome.collapse": "Einklappen",
  "chrome.loading": "Wird geladen",
  "chrome.theme.light": "Zu hellem Modus wechseln",
  "chrome.theme.dark": "Zu dunklem Modus wechseln",
  "chrome.density.comfortable": "Zu komfortabler Dichte wechseln",
  "chrome.density.compact": "Zu kompakter Dichte wechseln",
  "chrome.language": "Sprache wechseln",
  "chrome.signOut": "Abmelden",
  "chrome.sidebar.collapse": "Seitenleiste einklappen",
  "chrome.sidebar.expand": "Seitenleiste ausklappen",

  "common.cancel": "Abbrechen",
  "common.confirm": "Bestätigen",
  "common.close": "Schließen",
  "common.retry": "Erneut versuchen",
  "common.save": "Speichern",
  "common.delete": "Löschen",
  "common.tokens": "Tokens",
  "common.notFound": "—",
  "executions.filterPlaceholder": "Requests filtern…",
  "executions.filterLabel": "Requests nach Stichwort filtern (Request-ID, Prompt, Nutzer, Flow)",
  "executions.clearKeyword": "Stichwort löschen",
  "executions.filterButton": "Filter: Flows und User",
  "executions.includeFlows": "Flows einschließen",
  "executions.excludeFlows": "Flows ausschließen",
};
