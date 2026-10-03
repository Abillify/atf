"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /provider-testing — Interactive provider & model test bench.
 *
 * Pick a configured provider, load the models it actually offers, then run the
 * declared-vs-observed capability auto-test, an ad-hoc prompt, or a latency /
 * throughput performance test against a chosen model. Every test runs live
 * against the real provider through the operator plane
 * (GET /monitoring/providers/:name/models and POST /monitoring/providers/test/*),
 * so it incurs real (usually small) cost — the endpoints are gated on
 * monitoring:write.
 */

import { useState } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { backendUrl } from "../../../lib/backend-url";
import { formatCost } from "../../../lib/currency";
import { authFetch } from "../../../lib/auth-fetch";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../../../lib/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderMonitorEntry {
  name: string;
  protocol?: string;
}

interface ListedModel {
  id: string;
  label?: string;
}

interface PromptResult {
  text: string;
  reasoningText?: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  usage: { promptTokens: number; completionTokens: number; cost: number };
  latencyMs: number;
}

interface CapabilityCheck {
  axis: "reasoning" | "toolCalling" | "vision";
  declared: boolean;
  observed: boolean;
  pass: boolean;
  latencyMs: number;
  details: string;
}

interface CapabilityResult {
  declared: {
    reasoning: boolean;
    toolCalling: boolean;
    visionInput: boolean;
    structuredOutput: string;
  };
  checks: CapabilityCheck[];
}

interface PerformanceResult {
  runs: number;
  succeeded: number;
  failures: number;
  firstError?: string;
  latencyMs: { min: number; max: number; avg: number; p50: number; p95: number };
  tokensPerSecond: number;
  totalCompletionTokens: number;
  totalCost: number;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function fetchProviders(
  token: string | undefined,
): Promise<ProviderMonitorEntry[]> {
  return authFetch(backendUrl("/monitoring/providers"), token)
    .then((r) => readJson<{ providers: ProviderMonitorEntry[] }>(r))
    .then((d) => d.providers);
}

function fetchModels(
  token: string | undefined,
  provider: string,
): Promise<ListedModel[]> {
  return authFetch(
    backendUrl(`/monitoring/providers/${encodeURIComponent(provider)}/models`),
    token,
  )
    .then((r) => readJson<{ models: ListedModel[] }>(r))
    .then((d) => d.models);
}

function postTest<T>(
  token: string | undefined,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  return authFetch(backendUrl(path), token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => readJson<T>(r));
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function PassBadge({ pass }: { pass: boolean }) {
  return (
    <Badge variant={pass ? "success" : "destructive"}>
      {pass ? "pass" : "fail"}
    </Badge>
  );
}

function BoolBadge({ value }: { value: boolean }) {
  return (
    <Badge variant={value ? "success" : "outline"}>{value ? "yes" : "no"}</Badge>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProviderTestingPage() {
  // Gate on isAuthenticated (= !authRequired || !!token) rather than !!token,
  // so the bench also works when operator auth is disabled (AUTHN_MODE=disabled):
  // no token is issued then, but the backend serves the operator plane to an
  // anonymous caller. authFetch omits the Authorization header for an undefined
  // token.
  const { token, ready, isAuthenticated } = useAuth();
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [system, setSystem] = useState("");
  const [perfRuns, setPerfRuns] = useState(5);

  const providers = useQuery<ProviderMonitorEntry[], Error>({
    queryKey: ["provider-testing", "providers"],
    queryFn: () => fetchProviders(token),
    enabled: ready && isAuthenticated,
  });

  const models = useQuery<ListedModel[], Error>({
    queryKey: ["provider-testing", "models", provider],
    queryFn: () => fetchModels(token, provider),
    enabled: ready && isAuthenticated && provider !== "",
    retry: false,
  });

  const effectiveModel = model || manualModel;

  const promptTest = useMutation<PromptResult, Error>({
    mutationFn: () =>
      postTest<PromptResult>(token, "/monitoring/providers/test/prompt", {
        provider,
        model: effectiveModel,
        prompt,
        ...(system.trim() !== "" ? { system } : {}),
      }),
  });

  const capabilityTest = useMutation<CapabilityResult, Error>({
    mutationFn: () =>
      postTest<CapabilityResult>(
        token,
        "/monitoring/providers/test/capabilities",
        { provider, model: effectiveModel },
      ),
  });

  const performanceTest = useMutation<PerformanceResult, Error>({
    mutationFn: () =>
      postTest<PerformanceResult>(
        token,
        "/monitoring/providers/test/performance",
        { provider, model: effectiveModel, runs: perfRuns },
      ),
  });

  const canTest = provider !== "" && effectiveModel !== "";
  const selectClass =
    "h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground";

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-1 text-xl font-semibold text-foreground">
        Provider &amp; model testing
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Tests run live against the selected provider and incur real cost.
      </p>

      {/* ── Selection ─────────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Selection</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Provider
              </span>
              <select
                className={selectClass}
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel("");
                  setManualModel("");
                }}
              >
                <option value="">Select a provider…</option>
                {(providers.data ?? []).map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.protocol ? ` (${p.protocol})` : ""}
                  </option>
                ))}
              </select>
              {providers.error && (
                <span className="mt-1 block text-xs text-red-600">
                  {providers.error.message}
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Model
              </span>
              <select
                className={selectClass}
                value={model}
                disabled={provider === "" || models.isLoading}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">
                  {models.isLoading
                    ? "Loading models…"
                    : models.data && models.data.length > 0
                      ? "Select a model…"
                      : "No models listed — enter manually"}
                </option>
                {(models.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.label ? ` — ${m.label}` : ""}
                  </option>
                ))}
              </select>
              {models.error && (
                <span className="mt-1 block text-xs text-amber-600">
                  Could not list models ({models.error.message}). Enter the model
                  id manually below.
                </span>
              )}
              {(model === "" || models.error) && (
                <input
                  className={`${selectClass} mt-2`}
                  placeholder="Or type a model id manually"
                  value={manualModel}
                  disabled={provider === ""}
                  onChange={(e) => setManualModel(e.target.value)}
                />
              )}
            </label>
          </div>
        </CardContent>
      </Card>

      {/* ── Capability auto-test ──────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Capability auto-test</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            Probes reasoning, tool-calling and vision against the live model and
            compares the result with the declared capabilities.
          </p>
          <Button
            variant="primary"
            loading={capabilityTest.isPending}
            disabled={!canTest || capabilityTest.isPending}
            onClick={() => capabilityTest.mutate()}
          >
            Run capability test
          </Button>
          {capabilityTest.error && (
            <div role="alert" className="mt-3 text-sm text-red-600">
              {capabilityTest.error.message}
            </div>
          )}
          {capabilityTest.data && (
            <div className="mt-4 overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Capability</TableHeaderCell>
                    <TableHeaderCell>Declared</TableHeaderCell>
                    <TableHeaderCell>Observed</TableHeaderCell>
                    <TableHeaderCell>Result</TableHeaderCell>
                    <TableHeaderCell className="text-right">
                      Latency
                    </TableHeaderCell>
                    <TableHeaderCell>Details</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {capabilityTest.data.checks.map((c) => (
                    <TableRow key={c.axis}>
                      <TableCell className="font-medium text-foreground">
                        {c.axis}
                      </TableCell>
                      <TableCell>
                        <BoolBadge value={c.declared} />
                      </TableCell>
                      <TableCell>
                        <BoolBadge value={c.observed} />
                      </TableCell>
                      <TableCell>
                        <PassBadge pass={c.pass} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {c.latencyMs} ms
                      </TableCell>
                      <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                        {c.details}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Prompt test ───────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Prompt test</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              System prompt (optional)
            </span>
            <textarea
              className="min-h-[60px] w-full rounded-md border border-border bg-card p-2 text-sm text-foreground"
              value={system}
              onChange={(e) => setSystem(e.target.value)}
            />
          </label>
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Prompt
            </span>
            <textarea
              className="min-h-[100px] w-full rounded-md border border-border bg-card p-2 text-sm text-foreground"
              placeholder="Type a prompt to run against the model…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <Button
            variant="primary"
            loading={promptTest.isPending}
            disabled={!canTest || prompt.trim() === "" || promptTest.isPending}
            onClick={() => promptTest.mutate()}
          >
            Run prompt
          </Button>
          {promptTest.error && (
            <div role="alert" className="mt-3 text-sm text-red-600">
              {promptTest.error.message}
            </div>
          )}
          {promptTest.data && (
            <div className="mt-4 space-y-3">
              {promptTest.data.reasoningText && (
                <div className="rounded-md border border-border bg-muted/40 p-3">
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                    Reasoning
                  </div>
                  <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
                    {promptTest.data.reasoningText}
                  </pre>
                </div>
              )}
              <div className="rounded-md border border-border bg-card p-3">
                <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                  Response
                </div>
                <pre className="whitespace-pre-wrap text-sm text-foreground">
                  {promptTest.data.text}
                </pre>
              </div>
              {promptTest.data.toolCalls.length > 0 && (
                <div className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
                  Tool calls:{" "}
                  {promptTest.data.toolCalls.map((t) => t.name).join(", ")}
                </div>
              )}
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">
                  {promptTest.data.latencyMs} ms
                </Badge>
                <Badge variant="secondary">
                  prompt {promptTest.data.usage.promptTokens} tok
                </Badge>
                <Badge variant="secondary">
                  completion {promptTest.data.usage.completionTokens} tok
                </Badge>
                <Badge variant="secondary">
                  {formatCost(promptTest.data.usage.cost)}
                </Badge>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Performance test ──────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Performance test</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="mb-3 block max-w-[200px]">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Runs (1–20)
            </span>
            <input
              type="number"
              min={1}
              max={20}
              className={selectClass}
              value={perfRuns}
              onChange={(e) =>
                setPerfRuns(
                  Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                )
              }
            />
          </label>
          <Button
            variant="primary"
            loading={performanceTest.isPending}
            disabled={!canTest || performanceTest.isPending}
            onClick={() => performanceTest.mutate()}
          >
            Run performance test
          </Button>
          {performanceTest.error && (
            <div role="alert" className="mt-3 text-sm text-red-600">
              {performanceTest.error.message}
            </div>
          )}
          {performanceTest.data && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <Metric label="Runs" value={`${performanceTest.data.succeeded}/${performanceTest.data.runs}`} />
              <Metric label="Failures" value={String(performanceTest.data.failures)} />
              <Metric label="Latency avg" value={`${performanceTest.data.latencyMs.avg} ms`} />
              <Metric label="Latency p95" value={`${performanceTest.data.latencyMs.p95} ms`} />
              <Metric label="Latency min" value={`${performanceTest.data.latencyMs.min} ms`} />
              <Metric label="Latency max" value={`${performanceTest.data.latencyMs.max} ms`} />
              <Metric label="Throughput" value={`${performanceTest.data.tokensPerSecond} tok/s`} />
              <Metric
                label="Total cost"
                value={formatCost(performanceTest.data.totalCost)}
              />
              {performanceTest.data.firstError && (
                <div className="sm:col-span-3 lg:col-span-4 text-xs text-amber-600">
                  First error: {performanceTest.data.firstError}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}
