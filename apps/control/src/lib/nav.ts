// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Navigation metadata — the single source of truth for the dashboard's
 * information architecture (UI-STYLE-GUIDE.md §7). Consumed by the desktop
 * sidebar, the mobile drawer, the ⌘K command palette, and the breadcrumb bar,
 * so grouping, labels, and icons never drift between them.
 *
 * Req 9.7: labels, hints and group headers are i18n message keys
 * (`MessageKey`), not literal strings — consumers resolve them through
 * `useI18n().t()` so the same metadata renders in `de` or `en`.
 */

import type { LucideIcon } from "lucide-react";
import type { MessageKey } from "./i18n";
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
  /** i18n key for the destination's display label (Req 9.7). */
  labelKey: MessageKey;
  /** i18n key for the short description surfaced in the command palette. */
  hintKey: MessageKey;
  icon: LucideIcon;
}

export interface NavGroup {
  /** i18n key for the section header (sidebar/drawer/breadcrumbs). */
  groupKey: MessageKey;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    groupKey: "nav.group.research",
    items: [
      {
        href: "/studio",
        labelKey: "nav.studio",
        hintKey: "nav.studio.hint",
        icon: FlaskConical,
      },
      {
        href: "/memory",
        labelKey: "nav.memory",
        hintKey: "nav.memory.hint",
        icon: Brain,
      },
      {
        href: "/eval",
        labelKey: "nav.eval",
        hintKey: "nav.eval.hint",
        icon: ClipboardCheck,
      },
      {
        href: "/optimizer",
        labelKey: "nav.optimizer",
        hintKey: "nav.optimizer.hint",
        icon: Sparkles,
      },
      {
        href: "/canary",
        labelKey: "nav.canary",
        hintKey: "nav.canary.hint",
        icon: Bird,
      },
      {
        href: "/autopilot",
        labelKey: "nav.autopilot",
        hintKey: "nav.autopilot.hint",
        icon: Bot,
      },
    ],
  },
  {
    groupKey: "nav.group.monitoring",
    items: [
      {
        href: "/graph",
        labelKey: "nav.graph",
        hintKey: "nav.graph.hint",
        icon: Workflow,
      },
      {
        href: "/traces",
        labelKey: "nav.traces",
        hintKey: "nav.traces.hint",
        icon: Activity,
      },
      {
        href: "/history",
        labelKey: "nav.history",
        hintKey: "nav.history.hint",
        icon: History,
      },
      {
        href: "/approvals",
        labelKey: "nav.approvals",
        hintKey: "nav.approvals.hint",
        icon: Inbox,
      },
      {
        href: "/shadow",
        labelKey: "nav.shadow",
        hintKey: "nav.shadow.hint",
        icon: Layers,
      },
      {
        href: "/security",
        labelKey: "nav.security",
        hintKey: "nav.security.hint",
        icon: Shield,
      },
      {
        href: "/providers",
        labelKey: "nav.providers",
        hintKey: "nav.providers.hint",
        icon: Plug,
      },
    ],
  },
  {
    groupKey: "nav.group.configuration",
    items: [
      {
        href: "/flows",
        labelKey: "nav.flows",
        hintKey: "nav.flows.hint",
        icon: GitBranch,
      },
      {
        href: "/flows/health",
        labelKey: "nav.flows.health",
        hintKey: "nav.flows.health.hint",
        icon: Activity,
      },
      {
        href: "/triggers",
        labelKey: "nav.triggers",
        hintKey: "nav.triggers.hint",
        icon: Zap,
      },
      {
        href: "/assistants",
        labelKey: "nav.assistants",
        hintKey: "nav.assistants.hint",
        icon: UserCog,
      },
      {
        href: "/guardrails",
        labelKey: "nav.guardrails",
        hintKey: "nav.guardrails.hint",
        icon: ShieldCheck,
      },
      {
        href: "/pii-vault",
        labelKey: "nav.pii-vault",
        hintKey: "nav.pii-vault.hint",
        icon: Lock,
      },
      {
        href: "/compliance",
        labelKey: "nav.compliance",
        hintKey: "nav.compliance.hint",
        icon: Scale,
      },
      {
        href: "/mcp",
        labelKey: "nav.mcp",
        hintKey: "nav.mcp.hint",
        icon: Cable,
      },
    ],
  },
  {
    groupKey: "nav.group.budgeting",
    items: [
      {
        href: "/cost",
        labelKey: "nav.cost",
        hintKey: "nav.cost.hint",
        icon: Wallet,
      },
      {
        href: "/limits",
        labelKey: "nav.limits",
        hintKey: "nav.limits.hint",
        icon: Gauge,
      },
      {
        href: "/tenants",
        labelKey: "nav.tenants",
        hintKey: "nav.tenants.hint",
        icon: Building2,
      },
      {
        href: "/models",
        labelKey: "nav.models",
        hintKey: "nav.models.hint",
        icon: Package,
      },
      {
        href: "/jobs",
        labelKey: "nav.jobs",
        hintKey: "nav.jobs.hint",
        icon: ListChecks,
      },
    ],
  },
];
/** Flat list of every destination (palette search, breadcrumb lookup). */
export const NAV_ITEMS: (NavItem & { groupKey: MessageKey })[] =
  NAV_GROUPS.flatMap((g) =>
    g.items.map((item) => ({ ...item, groupKey: g.groupKey })),
  );

/** True when `pathname` is (or is nested under) `href`. */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/** Resolves the nav entry (with its group) that best matches a pathname. */
export function matchNavItem(
  pathname: string,
): (NavItem & { groupKey: MessageKey }) | undefined {
  return (
    NAV_ITEMS.find((i) => i.href === pathname) ??
    NAV_ITEMS.find((i) => isActivePath(pathname, i.href))
  );
}
