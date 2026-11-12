"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /overview — operator start page (review follow-up F1).
 *
 * The page a bookmark or the bare host lands on. It answers the two questions
 * an operator asks before choosing a page: is the system up, and does anything
 * need a decision right now?
 *
 * Every tile reads an endpoint that already exists — no aggregate endpoint is
 * introduced:
 *
 * - `GET /health/ready`           readiness of the dependencies and the flow set
 * - `GET /monitoring/approvals`   tool calls waiting for a human decision
 * - `GET /monitoring/posture`     hardening checks behind the operational profile
 * - `GET /monitoring/flow-health` which flow versions are live
 * - `GET /monitoring/providers`   model providers and their breaker state
 * - `GET /mcp/servers`            MCP servers and their tool authorisations
 * - `GET /monitoring/usage`       the most recent executions and their cost
 *
 * A tile whose endpoint answers 401/403 (permission missing), 404 (feature not
 * deployed) or 503 (dependency unavailable) renders an explained `EmptyState`
 * instead of an error banner: on a consolidated deployment not every operator
 * role may read every monitoring surface, and an overview that shouts about it
 * is less useful than one that says what it could not see.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  Activity,
  Coins,
  Cpu,
  Plug,
  ShieldAlert,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type React from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { authFetch } from "../../../lib/auth-fetch";
import { backendUrl } from "../../../lib/backend-url";
import { formatCost } from "../../../lib/currency";
import { translate, type MessageKey } from "../../../lib/i18n";
import type { FlowHealthEntry } from "../../../hooks/useFlowHealth";
import type { PendingApproval } from "../../../types/control";
import type { PostureReport } from "../../../types/posture";
import {
  Badge,
  Card,
  EmptyState,
  SkeletonBlock,
  type BadgeVariant,
} from "../../../lib/ui";

/** How often the tiles refresh — the overview is a watch surface, not a feed. */
const REFRESH_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Wire shapes (mirrored from the runtime responses the tiles consume)
// ---------------------------------------------------------------------------

type DependencyStatus = "ok" | "degraded" | "unavailable" | "unconfigured";

interface DependencyCheck {
  status: DependencyStatus;
  latency_ms?: number;
  detail?: string;
}

/** `GET /health/ready` — see `apps/runtime/src/routes/health.ts`. */
interface ReadinessResponse {
  status: "ready" | "not_ready";
  checks: Record<string, DependencyCheck>;
  auth?: "disabled";
}

interface ProviderMonitor {
  name: string;
  protocol?: string;
  configured: boolean;
  models: string[];
  status?: { state: "closed" | "open"; failure_count: number };
  calls: number;
  errors: number;
  tokens: number;
}

/** `GET /monitoring/providers`. */
interface ProvidersReport {
  providers: ProviderMonitor[];
  pools?: {
    name: string;
    strategy: string;
    providers: string[];
    calls: number;
    errors: number;
    unreachable: number;
  }[];
  global?: { queueDepth: number; activeExecutions: number };
}

interface McpTool {
  name: string;
  description: string;
  authorized: boolean;
}

interface McpServer {
  id: string;
  name: string;
  url: string;
  status: "connected" | "disconnected" | "error";
  error?: string;
  tools: McpTool[];
}

/** A row of `GET /monitoring/usage` — snake_case, as the store returns it. */
interface UsageRow {
  execution_id: string;
  flow_id: string;
  model: string | null;
  total_tokens: number | null;
  cost: number | null;
  created_at: string;
}

/** `GET /monitoring/usage`. */
interface UsageResponse {
  usage: UsageRow[];
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * An endpoint that answered with a non-2xx status. The code is kept so a tile
 * can tell "you may not see this" (401/403) apart from "this deployment does
 * not have it" (404) and "it did not answer" (503 or a transport error).
 */
class EndpointError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EndpointError";
  }
}

async function getJson<T>(path: string, token: string | undefined): Promise<T> {
  const res = await authFetch(backendUrl(path), token);
  if (!res.ok) throw new EndpointError(res.status, `HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Tile frame — one card, one endpoint, one link to the detail page
// ---------------------------------------------------------------------------

interface TileProps<T> {
  /** Stable identifier for the e2e hooks: `data-testid="tile-<testId>"`. */
  testId: string;
  titleKey: MessageKey;
  icon: LucideIcon;
  href: string;
  linkLabelKey: MessageKey;
  /** Shown when the endpoint answered successfully with nothing to show. */
  emptyKey: MessageKey;
  query: UseQueryResult<T, Error>;
  render: (data: T) => React.ReactNode;
}

function Tile<T>({
  testId,
  titleKey,
  icon: Icon,
  href,
  linkLabelKey,
  emptyKey,
  query,
  render,
}: TileProps<T>): React.JSX.Element {
  return (
    <Card noPadding className="flex h-full flex-col" data-testid={`tile-${testId}`}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{translate(titleKey)}</span>
        </h2>
        <Link
          href={href}
          className="shrink-0 text-xs font-medium text-primary hover:underline"
        >
          {translate(linkLabelKey)}
        </Link>
      </div>
      <div className="flex-1 px-4 py-3">
        <TileState query={query} emptyKey={emptyKey} render={render} />
      </div>
    </Card>
  );
}

function TileState<T>({
  query,
  emptyKey,
  render,
}: {
  query: UseQueryResult<T, Error>;
  emptyKey: MessageKey;
  render: (data: T) => React.ReactNode;
}): React.JSX.Element {
  if (query.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only">{translate("overview.loading")}</span>
        <SkeletonBlock lines={3} />
      </div>
    );
  }
  if (query.isError) {
    return <TileUnavailable status={endpointStatus(query.error)} />;
  }
  const data = query.data as T;
  if (isEmptyResult(data)) {
    return <EmptyState title={translate(emptyKey)} />;
  }
  return <>{render(data)}</>;
}

function endpointStatus(error: Error): number {
  return error instanceof EndpointError ? error.status : 0;
}

/** Lists and `{ usage: [] }` style payloads count as empty. */
function isEmptyResult(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  const usage = (data as { usage?: unknown } | null | undefined)?.usage;
  if (Array.isArray(usage)) return usage.length === 0;
  return data === undefined || data === null;
}

function TileUnavailable({ status }: { status: number }): React.JSX.Element {
  const titleKey: MessageKey =
    status === 401 || status === 403
      ? "overview.unauthorized"
      : status === 404
        ? "overview.notDeployed"
        : "overview.unreachable";
  return (
    <EmptyState
      title={translate(titleKey)}
      description={translate("overview.unavailableHint", {
        status:
          status === 0 ? translate("overview.unavailableNoStatus") : String(status),
      })}
    />
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OverviewPage(): React.JSX.Element {
  const { token, ready, isAuthenticated } = useAuth();
  const base = {
    enabled: ready && isAuthenticated,
    refetchInterval: REFRESH_INTERVAL_MS,
  };

  const readiness = useQuery<ReadinessResponse>({
    ...base,
    queryKey: ["overview", "readiness"],
    queryFn: () => getJson<ReadinessResponse>("/health/ready", token),
  });
  const approvals = useQuery<PendingApproval[]>({
    ...base,
    queryKey: ["overview", "approvals"],
    queryFn: () =>
      getJson<{ pending: PendingApproval[] }>("/monitoring/approvals", token).then(
        (d) => d.pending ?? [],
      ),
  });
  const posture = useQuery<PostureReport>({
    ...base,
    queryKey: ["overview", "posture"],
    queryFn: () => getJson<PostureReport>("/monitoring/posture", token),
  });
  const flowHealth = useQuery<FlowHealthEntry[]>({
    ...base,
    queryKey: ["overview", "flowHealth"],
    queryFn: () =>
      getJson<{ flows: FlowHealthEntry[] }>("/monitoring/flow-health", token).then(
        (d) => d.flows ?? [],
      ),
  });
  const providers = useQuery<ProvidersReport>({
    ...base,
    queryKey: ["overview", "providers"],
    queryFn: () => getJson<ProvidersReport>("/monitoring/providers", token),
  });
  const mcp = useQuery<McpServer[]>({
    ...base,
    queryKey: ["overview", "mcp"],
    queryFn: () =>
      getJson<{ servers: McpServer[] }>("/mcp/servers", token).then(
        (d) => d.servers ?? [],
      ),
  });
  const usage = useQuery<UsageResponse>({
    ...base,
    queryKey: ["overview", "usage"],
    queryFn: () => getJson<UsageResponse>("/monitoring/usage?limit=5", token),
  });

  return (
    <section className="flex flex-col gap-4" aria-labelledby="overview-heading">
      <header>
        <h1 id="overview-heading" className="text-2xl font-semibold tracking-tight">
          {translate("overview.title")}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {translate("overview.subtitle")}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ReadinessTile query={readiness} />
        <ApprovalsTile query={approvals} />
        <PostureTile query={posture} />
        <FlowHealthTile query={flowHealth} />
        <ProvidersTile query={providers} />
        <McpTile query={mcp} />
      </div>

      <UsageTile query={usage} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

const DEPENDENCY_VARIANT: Record<DependencyStatus, BadgeVariant> = {
  ok: "success",
  degraded: "warning",
  unavailable: "destructive",
  unconfigured: "secondary",
};

function ReadinessTile({
  query,
}: {
  query: UseQueryResult<ReadinessResponse, Error>;
}): React.JSX.Element {
  return (
    <Tile
      testId="readiness"
      titleKey="overview.readiness.title"
      icon={Activity}
      href="/flows/health"
      linkLabelKey="overview.readiness.link"
      emptyKey="overview.readiness.empty"
      query={query}
      render={(data) => {
        const entries = Object.entries(data.checks ?? {});
        const failing = entries.filter(
          ([, check]) =>
            check.status === "unavailable" || check.status === "degraded",
        );
        return (
          <div className="flex flex-col gap-2">
            <div>
              <Badge variant={data.status === "ready" ? "success" : "destructive"}>
                {translate(
                  data.status === "ready"
                    ? "overview.readiness.ready"
                    : "overview.readiness.notReady",
                )}
              </Badge>
            </div>
            {entries.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {entries.map(([name, check]) => (
                  <li key={name}>
                    <Badge variant={DEPENDENCY_VARIANT[check.status] ?? "secondary"}>
                      {name}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            {failing.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {translate("overview.readiness.failedHint", { count: failing.length })}
              </p>
            ) : null}
          </div>
        );
      }}
    />
  );
}

function ApprovalsTile({
  query,
}: {
  query: UseQueryResult<PendingApproval[], Error>;
}): React.JSX.Element {
  return (
    <Tile
      testId="approvals"
      titleKey="overview.approvals.title"
      icon={ShieldAlert}
      href="/approvals"
      linkLabelKey="overview.approvals.link"
      emptyKey="overview.approvals.empty"
      query={query}
      render={(pending) => (
        <div className="flex flex-col gap-2">
          <div>
            <Badge variant={pending.length > 0 ? "warning" : "success"}>
              {translate("overview.approvals.count", { count: pending.length })}
            </Badge>
          </div>
          <ul className="flex flex-col gap-1.5">
            {pending.slice(0, 4).map((approval) => (
              <li
                key={approval.id}
                data-testid="approval-row"
                className="flex items-baseline justify-between gap-2"
              >
                <code className="truncate text-xs">{approval.tool}</code>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatAge(approval.requestedAt)}
                </span>
              </li>
            ))}
          </ul>
          {pending.length > 4 ? (
            <p className="text-xs text-muted-foreground">
              {translate("overview.more", { count: pending.length - 4 })}
            </p>
          ) : null}
        </div>
      )}
    />
  );
}

const POSTURE_VARIANT: Record<PostureReport["status"], BadgeVariant> = {
  ok: "success",
  warn: "warning",
  fail: "destructive",
};

function PostureTile({
  query,
}: {
  query: UseQueryResult<PostureReport, Error>;
}): React.JSX.Element {
  return (
    <Tile
      testId="posture"
      titleKey="overview.posture.title"
      icon={ShieldCheck}
      href="/posture"
      linkLabelKey="overview.posture.link"
      emptyKey="overview.posture.empty"
      query={query}
      render={(report) => (
        <div className="flex flex-col gap-2">
          <div>
            <Badge variant={POSTURE_VARIANT[report.status] ?? "secondary"}>
              {translate(`overview.posture.state.${report.status}`)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {translate("overview.posture.summary", {
              ok: report.summary?.ok ?? 0,
              warn: report.summary?.warn ?? 0,
              fail: report.summary?.fail ?? 0,
            })}
          </p>
          {report.operationalProfile ? (
            <p className="text-xs text-muted-foreground">
              {translate("overview.posture.profile", {
                profile: report.operationalProfile,
              })}
            </p>
          ) : null}
        </div>
      )}
    />
  );
}

function FlowHealthTile({
  query,
}: {
  query: UseQueryResult<FlowHealthEntry[], Error>;
}): React.JSX.Element {
  return (
    <Tile
      testId="flow-health"
      titleKey="overview.flowHealth.title"
      icon={Workflow}
      href="/flows/health"
      linkLabelKey="overview.flowHealth.link"
      emptyKey="overview.flowHealth.empty"
      query={query}
      render={(flows) => (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1.5">
            {flows.slice(0, 5).map((flow) => (
              <li
                key={`${flow.source}-${flow.id}`}
                data-testid="flow-row"
                className="flex items-baseline justify-between gap-2"
              >
                <span className="truncate">
                  {flow.id}
                  {flow.version ? (
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      · v{flow.version}
                    </span>
                  ) : null}
                </span>
                <Badge variant={flow.shadowsFile ? "warning" : "secondary"}>
                  {translate(`overview.flowHealth.source.${flow.source}`)}
                </Badge>
              </li>
            ))}
          </ul>
          {flows.length > 5 ? (
            <p className="text-xs text-muted-foreground">
              {translate("overview.more", { count: flows.length - 5 })}
            </p>
          ) : null}
        </div>
      )}
    />
  );
}

function ProvidersTile({
  query,
}: {
  query: UseQueryResult<ProvidersReport, Error>;
}): React.JSX.Element {
  return (
    <Tile
      testId="providers"
      titleKey="overview.providers.title"
      icon={Cpu}
      href="/providers"
      linkLabelKey="overview.providers.link"
      emptyKey="overview.providers.empty"
      query={query}
      render={(report) => {
        const providers = report.providers ?? [];
        if (providers.length === 0) {
          return <EmptyState title={translate("overview.providers.empty")} />;
        }
        return (
          <div className="flex flex-col gap-2">
            <ul className="flex flex-col gap-1.5">
              {providers.slice(0, 5).map((provider) => {
                const variant: BadgeVariant = !provider.configured
                  ? "secondary"
                  : provider.status?.state === "open"
                    ? "destructive"
                    : "success";
                const stateKey = !provider.configured
                  ? "overview.providers.state.notConfigured"
                  : provider.status?.state === "open"
                    ? "overview.providers.state.open"
                    : "overview.providers.state.available";
                return (
                  <li
                    key={provider.name}
                    data-testid="provider-row"
                    className="flex items-baseline justify-between gap-2"
                  >
                    <span className="truncate">{provider.name}</span>
                    <Badge variant={variant}>{translate(stateKey)}</Badge>
                  </li>
                );
              })}
            </ul>
            {report.global ? (
              <p className="text-xs text-muted-foreground">
                {translate("overview.providers.global", {
                  active: report.global.activeExecutions,
                  queued: report.global.queueDepth,
                })}
              </p>
            ) : null}
          </div>
        );
      }}
    />
  );
}

const MCP_VARIANT: Record<McpServer["status"], BadgeVariant> = {
  connected: "success",
  disconnected: "secondary",
  error: "destructive",
};

function McpTile({
  query,
}: {
  query: UseQueryResult<McpServer[], Error>;
}): React.JSX.Element {
  return (
    <Tile
      testId="mcp"
      titleKey="overview.mcp.title"
      icon={Plug}
      href="/mcp"
      linkLabelKey="overview.mcp.link"
      emptyKey="overview.mcp.empty"
      query={query}
      render={(servers) => (
        <ul className="flex flex-col gap-1.5">
          {servers.slice(0, 5).map((server) => (
            <li
              key={server.id}
              data-testid="mcp-row"
              className="flex items-baseline justify-between gap-2"
            >
              <span className="truncate">{server.name}</span>
              <Badge variant={MCP_VARIANT[server.status] ?? "secondary"}>
                {translate(`overview.mcp.state.${server.status}`)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    />
  );
}

function UsageTile({
  query,
}: {
  query: UseQueryResult<UsageResponse, Error>;
}): React.JSX.Element {
  return (
    <Tile
      testId="usage"
      titleKey="overview.usage.title"
      icon={Coins}
      href="/cost"
      linkLabelKey="overview.usage.link"
      emptyKey="overview.usage.empty"
      query={query}
      render={(report) => (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {translate("overview.usage.col.flow")}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {translate("overview.usage.col.model")}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {translate("overview.usage.col.tokens")}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {translate("overview.usage.col.cost")}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {translate("overview.usage.col.when")}
                </th>
              </tr>
            </thead>
            <tbody>
              {(report.usage ?? []).map((row) => (
                <tr key={row.execution_id} data-testid="usage-row">
                  <td className="max-w-[16rem] truncate py-1 pr-3">
                    <Link
                      href={`/traces?execution=${encodeURIComponent(row.execution_id)}`}
                      className="hover:underline"
                      title={row.flow_id}
                    >
                      {row.flow_id}
                    </Link>
                  </td>
                  <td className="py-1 pr-3 text-muted-foreground">
                    {row.model ?? "—"}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {row.total_tokens ?? 0}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {formatCost(row.cost ?? 0)}
                  </td>
                  <td className="py-1 text-right text-muted-foreground tabular-nums">
                    {formatAge(row.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    />
  );
}

/** Compact "3 minutes ago" style age, following the active locale. */
function formatAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 60) return rtf.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}
