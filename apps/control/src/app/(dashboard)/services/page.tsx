"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /services — operator service inventory (review follow-up F2).
 *
 * Shows what the deployment consists of beyond the Runtime itself: the
 * configured `SERVICE_LINKS` (the Fach-Oberflächen — Search, Extract, Gate,
 * anything else an operator works in) with a direct "Open UI" link, plus the
 * live connection status of every configured MCP server.
 *
 * Single endpoint: `GET /monitoring/services` (permission `monitoring:read`).
 * The runtime validates the link schemes at startup — `javascript:`/`data:`
 * URLs can never appear here — but the link is still passed through
 * `safeExternalHref()` before it reaches an anchor, so the Control UI never
 * trusts a stored URL on its own.
 */

import { useQuery } from "@tanstack/react-query";
import {
  Cable,
  ExternalLink,
  LayoutGrid,
  Search,
  ScanText,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type React from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { authFetch } from "../../../lib/auth-fetch";
import { backendUrl } from "../../../lib/backend-url";
import { translate, type MessageKey } from "../../../lib/i18n";
import { safeExternalHref } from "../../../lib/safe-navigation";
import { Badge, Card, EmptyState, SkeletonBlock } from "../../../lib/ui";

/** How often the inventory refreshes — service status is a watch surface. */
const REFRESH_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Wire shape (mirrored from GET /monitoring/services)
// ---------------------------------------------------------------------------

type ServiceLinkKind = "search" | "extract" | "gate" | "other";

interface ServiceLink {
  name: string;
  kind: ServiceLinkKind;
  url: string;
}

interface McpServerStatus {
  name: string;
  url: string;
  transport: "http" | "stdio" | "sse";
  status: "connected" | "error";
  error?: string;
}

interface ServicesResponse {
  services: ServiceLink[];
  mcp: McpServerStatus[];
}

const KIND_ICON: Record<ServiceLinkKind, LucideIcon> = {
  search: Search,
  extract: ScanText,
  gate: ShieldCheck,
  other: LayoutGrid,
};

const KIND_LABEL_KEY: Record<ServiceLinkKind, MessageKey> = {
  search: "services.kind.search",
  extract: "services.kind.extract",
  gate: "services.kind.gate",
  other: "services.kind.other",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ServicesPage(): React.JSX.Element {
  const { token, ready, isAuthenticated } = useAuth();

  const query = useQuery<ServicesResponse>({
    enabled: ready && isAuthenticated,
    refetchInterval: REFRESH_INTERVAL_MS,
    queryKey: ["services"],
    queryFn: async () => {
      const res = await authFetch(backendUrl("/monitoring/services"), token);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as ServicesResponse;
    },
  });

  return (
    <section className="flex flex-col gap-4" aria-labelledby="services-heading">
      <header>
        <h1 id="services-heading" className="text-2xl font-semibold tracking-tight">
          {translate("services.title")}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {translate("services.subtitle")}
        </p>
      </header>

      {query.isPending ? (
        <Card>
          <div aria-busy="true">
            <span className="sr-only">{translate("services.loading")}</span>
            <SkeletonBlock lines={5} />
          </div>
        </Card>
      ) : query.isError ? (
        <Card>
          <EmptyState
            icon={Cable}
            title={translate("services.unreachable")}
            description={translate("services.unreachableHint")}
          />
        </Card>
      ) : (
        <>
          <ServiceLinksCard services={query.data.services ?? []} />
          <McpStatusCard servers={query.data.mcp ?? []} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Service links
// ---------------------------------------------------------------------------

function ServiceLinksCard({
  services,
}: {
  services: ServiceLink[];
}): React.JSX.Element {
  return (
    <Card noPadding data-testid="services-links" aria-labelledby="services-links-heading">
      <h2
        id="services-links-heading"
        className="border-b border-border px-4 py-3 text-sm font-semibold"
      >
        {translate("services.links.heading")}
      </h2>
      {services.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={LayoutGrid}
            title={translate("services.links.empty")}
            description={translate("services.links.emptyHint")}
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {services.map((service) => (
            <ServiceLinkRow key={`${service.kind}:${service.name}`} service={service} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ServiceLinkRow({
  service,
}: {
  service: ServiceLink;
}): React.JSX.Element {
  const Icon = KIND_ICON[service.kind];
  // Defense in depth: the runtime rejects dangerous schemes at startup, the
  // Control UI still refuses to render an anchor for one it cannot vouch for.
  const href = safeExternalHref(service.url);
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{service.name}</p>
          <p className="truncate text-xs text-muted-foreground">{service.url}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Badge variant="secondary">{translate(KIND_LABEL_KEY[service.kind])}</Badge>
        {href !== null ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {translate("services.openUi")}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only"> ({service.name})</span>
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">
            {translate("services.linkRejected")}
          </span>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// MCP status
// ---------------------------------------------------------------------------

function McpStatusCard({
  servers,
}: {
  servers: McpServerStatus[];
}): React.JSX.Element {
  return (
    <Card noPadding data-testid="services-mcp" aria-labelledby="services-mcp-heading">
      <h2
        id="services-mcp-heading"
        className="border-b border-border px-4 py-3 text-sm font-semibold"
      >
        {translate("services.mcp.heading")}
      </h2>
      {servers.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={Cable}
            title={translate("services.mcp.empty")}
            description={translate("services.mcp.emptyHint")}
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {servers.map((server) => (
            <li
              key={server.name}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Cable
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{server.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {server.transport} · {server.url}
                  </p>
                </div>
              </div>
              <Badge variant={server.status === "connected" ? "success" : "warning"}>
                {translate(
                  server.status === "connected"
                    ? "services.mcp.connected"
                    : "services.mcp.error",
                )}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
