"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /providers — Providers consolidated (Req 9.9).
 *
 * Two tabs: "Monitoring" (live provider/pool health from GET
 * /monitoring/providers — capabilities, per-provider call/error counts,
 * reachability/circuit-breaker state, the global admission queue, plus the
 * configured provider key pool from GET /admin/provider-keys) and "Test bench"
 * (the interactive provider/model test bench formerly at /provider-testing,
 * which now redirects here).
 */

import type React from "react";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { KeyRound } from "lucide-react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery } from "@tanstack/react-query";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import {
  Badge,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  EmptyState,
} from "../../../lib/ui";
import type { BadgeVariant } from "../../../lib/ui";

// Test bench — loaded client-side only, and only when its tab is active
// (Req. 12.3).
const ProviderTestingPanel = dynamic(
  () =>
    import("../../../components/ProviderTestingPanel").then(
      (m) => m.ProviderTestingPanel,
    ),
  { ssr: false },
);

type ProvidersTab = "monitoring" | "testing";

interface ProviderKey {
  id: string;
  provider: string;
  alias: string;
  maskedKey: string;
  status: "active" | "rotated" | "revoked";
  successes?: number;
  failures?: number;
  lastUsed?: string;
  createdAt?: string;
}

interface ProviderCapabilities {
  reasoning: boolean;
  toolCalling: boolean;
  structuredOutput: string;
  visionInput: boolean;
  contextLength?: number;
}

interface ProviderMonitor {
  name: string;
  protocol?: string;
  configured: boolean;
  models: string[];
  capabilities: ProviderCapabilities;
  status: {
    state: "closed" | "open";
    failure_count: number;
    open_until?: number;
  };
  calls: number;
  errors: number;
  tokens: number;
}

interface PoolMonitor {
  name: string;
  strategy: string;
  providers: string[];
  calls: number;
  errors: number;
  unreachable: boolean;
}

interface ProviderMonitoring {
  providers: ProviderMonitor[];
  pools: PoolMonitor[];
  global: { queueDepth: number; activeExecutions: number };
}

function fetchProviderKeys(token: string | undefined): Promise<ProviderKey[]> {
  return authFetch(backendUrl("/admin/provider-keys"), token).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ keys: ProviderKey[] }>;
  }).then((d) => d.keys);
}

function fetchProviderMonitoring(
  token: string | undefined,
): Promise<ProviderMonitoring> {
  return authFetch(backendUrl("/monitoring/providers"), token).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<ProviderMonitoring>;
  });
}

const STATUS_VARIANT: Record<ProviderKey["status"], BadgeVariant> = {
  active: "success",
  rotated: "warning",
  revoked: "destructive",
};

/** Reachability badge shared by the provider and pool tables. */
function StatusBadge({ open }: { open: boolean }) {
  return (
    <Badge variant={open ? "destructive" : "success"}>
      {open ? "unreachable" : "available"}
    </Badge>
  );
}

/**
 * The four capability axes the monitoring plane surfaces: reasoning, tooling,
 * structured output and vision. Enabled axes render as outline badges; the
 * structured-output strategy is shown as its concrete mode.
 */
function CapabilityBadges({ caps }: { caps: ProviderCapabilities }) {
  return (
    <div className="flex flex-wrap gap-1">
      {caps.reasoning && <Badge variant="outline">reasoning</Badge>}
      {caps.toolCalling && <Badge variant="outline">tooling</Badge>}
      {caps.visionInput && <Badge variant="outline">vision</Badge>}
      <Badge variant="secondary">structured: {caps.structuredOutput}</Badge>
      {caps.contextLength !== undefined && (
        <Badge variant="secondary">
          ctx {Math.round(caps.contextLength / 1000)}k
        </Badge>
      )}
    </div>
  );
}

function ProviderMonitoringPanel(): React.JSX.Element {
  const { token, ready, isAuthenticated } = useAuth();

  // Gate on isAuthenticated (= !authRequired || !!token) rather than !!token,
  // so the page also loads when operator auth is disabled (AUTHN_MODE=disabled):
  // in that mode the AuthProvider never obtains a token, but the backend serves
  // /monitoring/providers and /admin/provider-keys to an anonymous caller. With
  // an `enabled: ready && !!token` gate these queries would never fire and the
  // tables stayed empty. authFetch tolerates an undefined token (it simply omits
  // the Authorization header).
  const {
    data: keys = [],
    isLoading,
    error,
  } = useQuery<ProviderKey[], Error>({
    queryKey: ["providers", "keys"],
    queryFn: () => fetchProviderKeys(token),
    enabled: ready && isAuthenticated,
  });
  const monitoring = useQuery<ProviderMonitoring, Error>({
    queryKey: ["providers", "monitoring"],
    queryFn: () => fetchProviderMonitoring(token),
    enabled: ready && isAuthenticated,
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">
        Provider Monitoring
      </h2>

      {monitoring.error && (
        <div
          role="alert"
          className="mb-4 rounded-md bg-danger-soft p-4 text-sm text-danger"
        >
          Failed to load provider monitoring: {monitoring.error.message}
        </div>
      )}
      {monitoring.data && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Global queue depth
              </div>
              <div className="mt-1 text-2xl font-semibold text-foreground">
                {monitoring.data.global.queueDepth}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Active executions
              </div>
              <div className="mt-1 text-2xl font-semibold text-foreground">
                {monitoring.data.global.activeExecutions}
              </div>
            </div>
          </div>

          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Providers
          </h2>
          <div className="mb-8 overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Provider</TableHeaderCell>
                  <TableHeaderCell>Capabilities</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell className="text-right">
                    Calls
                  </TableHeaderCell>
                  <TableHeaderCell className="text-right">
                    Errors
                  </TableHeaderCell>
                  <TableHeaderCell className="text-right">
                    Tokens
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {monitoring.data.providers.length === 0 && (
                  <TableRow>
                    <TableCell className="text-sm text-muted-foreground">
                      No providers configured or observed yet.
                    </TableCell>
                  </TableRow>
                )}
                {monitoring.data.providers.map((provider) => (
                  <TableRow key={provider.name}>
                    <TableCell>
                      <div className="font-medium text-foreground">
                        {provider.name}
                        {!provider.configured && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            (not configured)
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {provider.protocol ?? "unknown protocol"} ·{" "}
                        {provider.models.join(", ") || "no calls yet"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <CapabilityBadges caps={provider.capabilities} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge open={provider.status.state === "open"} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {provider.calls}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {provider.errors}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {provider.tokens}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <h2 className="mb-3 text-lg font-semibold text-foreground">
            Configured pools
          </h2>
          {monitoring.data.pools.length === 0 && (
            <p className="mb-8 text-sm text-muted-foreground">
              No model-shortcut pools are configured.
            </p>
          )}
          {monitoring.data.pools.length > 0 && (
            <div className="mb-8 overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Pool</TableHeaderCell>
                    <TableHeaderCell>Strategy</TableHeaderCell>
                    <TableHeaderCell>Providers</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell className="text-right">
                      Calls
                    </TableHeaderCell>
                    <TableHeaderCell className="text-right">
                      Errors
                    </TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {monitoring.data.pools.map((pool) => (
                    <TableRow key={pool.name}>
                      <TableCell className="font-medium text-foreground">
                        {pool.name}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{pool.strategy}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {pool.providers.join(", ") || "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge open={pool.unreachable} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {pool.calls}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {pool.errors}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      <h2 className="mb-3 text-lg font-semibold text-foreground">
        Provider key pool
      </h2>

      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Loading provider keys…
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md bg-danger-soft p-4 text-sm text-danger"
        >
          Failed to load provider keys: {error.message}
        </div>
      )}

      {!isLoading && !error && keys.length === 0 && (
        <EmptyState
          icon={KeyRound}
          title="No provider keys configured."
          description="Add a provider key so ATF can call model APIs. Keys are stored server-side and shown masked here."
        />
      )}

      {keys.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Provider</TableHeaderCell>
                <TableHeaderCell>Key</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell className="text-right">
                  Successes
                </TableHeaderCell>
                <TableHeaderCell className="text-right">
                  Failures
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium text-foreground">
                    {k.provider}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {k.maskedKey}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[k.status]}>{k.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {k.successes ?? "—"}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {k.failures ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function ProvidersPage() {
  const [tab, setTab] = useState<ProvidersTab>("monitoring");

  // Deep-link support: /providers?tab=testing opens the Test bench tab
  // (used by the /provider-testing redirect, Req. 9.9).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const param = new URLSearchParams(window.location.search).get("tab");
    if (param === "testing") setTab("testing");
  }, []);

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <Tabs value={tab} onValueChange={(v) => setTab(v as ProvidersTab)}>
        <TabsList className="mb-4">
          <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
          <TabsTrigger value="testing">Test bench</TabsTrigger>
        </TabsList>
        {/* Panels are wrapped in TabsContent so the tabs expose real
            role="tabpanel" targets (valid aria-controls); the heavy, code-split
            panels still only mount for the active tab. */}
        <TabsContent value="monitoring">
          {tab === "monitoring" && <ProviderMonitoringPanel />}
        </TabsContent>
        <TabsContent value="testing">
          {tab === "testing" && <ProviderTestingPanel />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
