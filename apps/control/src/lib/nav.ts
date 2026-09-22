// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Navigation metadata — the single source of truth for the dashboard's
 * information architecture (UI-STYLE-GUIDE.md §7). Consumed by the desktop
 * sidebar, the mobile drawer, the ⌘K command palette, and the breadcrumb bar,
 * so grouping, labels, and icons never drift between them.
 */

import type { LucideIcon } from "lucide-react";
import {
  FlaskConical,
  Brain,
  ClipboardCheck,
  Sparkles,
  Bird,
  Bot,
  Workflow,
  Activity,
  History,
  Inbox,
  Shield,
  GitBranch,
  GitCompare,
  Plug,
  ShieldCheck,
  Lock,
  Scale,
  Cable,
  Wallet,
  Gauge,
  Building2,
  Layers,
  Zap,
  Package,
  UserCog,
  ListChecks,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  /** Short description surfaced in the command palette. */
  hint: string;
  icon: LucideIcon;
}

export interface NavGroup {
  /** Section header shown in the sidebar/drawer and used for breadcrumbs. */
  group: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    group: "Recherche & Optimierung",
    items: [
      { href: "/studio", label: "Studio", hint: "Build & test flows", icon: FlaskConical },
      { href: "/memory", label: "Memory", hint: "Agent long-term memory", icon: Brain },
      { href: "/eval", label: "Eval", hint: "Regression eval cases", icon: ClipboardCheck },
      { href: "/optimizer", label: "Optimizer", hint: "Self-optimizing flow loop", icon: Sparkles },
      { href: "/canary", label: "Canary", hint: "Runtime rollout & auto-rollback", icon: Bird },
      { href: "/autopilot", label: "Autopilot", hint: "Continuous safety & quality loop", icon: Bot },
    ],
  },
  {
    group: "Monitoring",
    items: [
      { href: "/graph", label: "Live Graph", hint: "Real-time node execution", icon: Workflow },
      { href: "/traces", label: "Traces", hint: "Per-execution span waterfall", icon: Activity },
      { href: "/history", label: "History", hint: "Past executions", icon: History },
      { href: "/approvals", label: "Approvals", hint: "Human-in-the-loop inbox", icon: Inbox },
      { href: "/shadow", label: "Shadow", hint: "Shadow-mode A/B quality comparisons", icon: Layers },
      { href: "/security", label: "Security", hint: "Red-team posture & tool authz", icon: Shield },
    ],
  },
  {
    group: "Konfiguration",
    items: [
      { href: "/flows", label: "Flows", hint: "Flow registry & editor", icon: GitBranch },
      { href: "/flow-diff", label: "Flow Diff", hint: "Compare flow versions", icon: GitCompare },
      { href: "/triggers", label: "Triggers", hint: "Webhook-triggered flows", icon: Zap },
      { href: "/assistants", label: "Assistants", hint: "Per-user assistants & operator constraints", icon: UserCog },
      { href: "/providers", label: "Providers", hint: "Provider key pool health", icon: Plug },
      { href: "/guardrails", label: "Guardrails", hint: "Input/output/egress policy", icon: ShieldCheck },
      { href: "/pii-vault", label: "PII Vault", hint: "Reversible PII tokenization", icon: Lock },
      { href: "/compliance", label: "Compliance", hint: "Policy & evidentiary dossier", icon: Scale },
      { href: "/mcp", label: "MCP", hint: "Connected MCP servers", icon: Cable },
    ],
  },
  {
    group: "Budgetierung",
    items: [
      { href: "/cost", label: "Cost & Tokens", hint: "Spend & token usage", icon: Wallet },
      { href: "/limits", label: "Limits", hint: "Rate & concurrency overrides", icon: Gauge },
      { href: "/tenants", label: "Tenants", hint: "Tenants, keys & budgets", icon: Building2 },
      { href: "/models", label: "Models", hint: "Available flows/models catalog", icon: Package },
      { href: "/jobs", label: "Jobs", hint: "Async/batch job status lookup", icon: ListChecks },
    ],
  },
];

/** Flat list of every destination (palette search, breadcrumb lookup). */
export const NAV_ITEMS: (NavItem & { group: string })[] = NAV_GROUPS.flatMap(
  (g) => g.items.map((item) => ({ ...item, group: g.group })),
);

/** True when `pathname` is (or is nested under) `href`. */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/** Resolves the nav entry (with its group) that best matches a pathname. */
export function matchNavItem(
  pathname: string,
): (NavItem & { group: string }) | undefined {
  return (
    NAV_ITEMS.find((i) => i.href === pathname) ??
    NAV_ITEMS.find((i) => isActivePath(pathname, i.href))
  );
}
