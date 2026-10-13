"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /triggers — Webhook-triggered flows.
 *
 * Lists all flows that have a webhook trigger node (GET /triggers) and shows
 * their configuration (sampling rate, auth requirement, sync/async mode).
 * Operators can also test-fire a flow synchronously from the dashboard via
 * POST /triggers/:flowId?sync=true with a custom payload.
 *
 * Note: actual webhook payloads are sent by external systems (GitHub, Stripe,
 * etc.) with an HMAC-SHA256 signature. The test-fire form here omits the
 * signature — it only works for flows without a webhookSecret configured.
 */

import { useState, useCallback, useEffect } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import { Badge, Button, } from "../../../lib/ui";

// ---------------------------------------------------------------------------
// Types (mirrors GET /triggers response from src/routes/triggers.ts)
// ---------------------------------------------------------------------------

interface TriggerFlow {
  flowId: string;
  flowName?: string;
  mode: string;
  synchronous: boolean;
  hasSecret: boolean;
  samplingRate?: number;
  tenantId?: string;
}

interface TestFireResult {
  status: "ok" | "error";
  executionId?: string;
  response?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Test-fire panel
// ---------------------------------------------------------------------------

function TestFirePanel({
  flowId,
  token,
  onClose,
}: {
  flowId: string;
  token: string | undefined;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState('{"message": "test"}');
  const [result, setResult] = useState<TestFireResult | null>(null);
  const [loading, setLoading] = useState(false);

  const fire = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await authFetch(
        backendUrl(`/triggers/${encodeURIComponent(flowId)}?sync=true`),
        token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        },
      );
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setResult({ status: "error", error: (data.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}` });
      } else if (res.status === 202) {
        setResult({ status: "ok", executionId: data.execution_id as string });
      } else {
        const content = (data.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content;
        setResult({ status: "ok", executionId: data.execution_id as string, response: content });
      }
    } catch (err) {
      setResult({ status: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, [flowId, token, payload]);

  return (
    <div className="mt-3 rounded border border-border bg-muted p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Test fire — <span className="font-mono">{flowId}</span></span>
        <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
      </div>
      <div>
        <label htmlFor="trigger-test-payload" className="block text-xs font-medium text-muted-foreground mb-1">
          Payload (JSON or plain text)
        </label>
        <textarea
          id="trigger-test-payload"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={4}
          className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
          placeholder='{"event": "test"}'
        />
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void fire()} disabled={loading}>
          {loading ? "Firing…" : "Fire (sync)"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Only works for flows without a webhookSecret. Runs synchronously and returns the response.
        </p>
      </div>
      {result && (
        <div className={`rounded border px-3 py-2 text-sm ${result.status === "error" ? "border-danger-border bg-danger-soft text-danger" : "border-success-border bg-success-soft text-success"}`}>
          {result.status === "error" ? (
            <span>✗ {result.error}</span>
          ) : (
            <div className="space-y-1">
              <div>✓ Accepted {result.executionId && <span className="font-mono text-xs">({result.executionId.slice(0, 8)})</span>}</div>
              {result.response && (
                <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">{result.response}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TriggersPage() {
  const { token, ready, isAuthenticated } = useAuth();
  const [flows, setFlows] = useState<TriggerFlow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [firingId, setFiringId] = useState<string | null>(null);

  const fetchTriggers = useCallback(async () => {
    if (!ready || !isAuthenticated) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(backendUrl("/triggers"), token);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { flows?: TriggerFlow[] };
      setFlows(data.flows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // The flagged "flows" below is `data.flows` (from the `as { flows?: ... }`
    // cast above), not the `flows` state. @babel/eslint-parser has no
    // TypeScript type info, so exhaustive-deps' scope analysis can't tell the
    // cast's property name apart from the same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, ready, isAuthenticated]);

  useEffect(() => {
    if (ready && isAuthenticated) void fetchTriggers();
  }, [ready, isAuthenticated, fetchTriggers]);

  const endpointBase =
    typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}` : "<base-url>";

  return (
    <div className="mx-auto w-full max-w-screen-xl p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Webhook Triggers</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Flows with a <code className="font-mono text-xs">trigger</code> node in webhook mode.
            POST to <code className="font-mono text-xs">{endpointBase}/triggers/:flowId</code> to fire them.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void fetchTriggers()} disabled={loading}>
          {loading ? "Loading…" : "↻ Refresh"}
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded border border-danger-border bg-danger-soft px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Auth note */}
      <div className="rounded border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-foreground">
        <strong>Authentication:</strong> Webhook requests use HMAC-SHA256 signatures, not JWT.
        Send <code className="font-mono text-xs">X-Trigger-Signature: sha256=&lt;hex&gt;</code> with the
        shared secret configured per flow. Flows without a secret accept unsigned requests.
      </div>

      {/* Flow list */}
      {!loading && flows.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-sm text-muted-foreground">
          No webhook-trigger flows found. Add a <code className="font-mono">type: trigger</code> node with{" "}
          <code className="font-mono">config.mode: webhook</code> to a flow YAML to register it here.
        </div>
      )}

      <div className="space-y-3">
        {flows.map((f) => (
          <div key={f.flowId} className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-foreground">{f.flowName ?? f.flowId}</span>
                  {f.flowName && (
                    <span className="font-mono text-xs text-muted-foreground">{f.flowId}</span>
                  )}
                  <Badge variant={f.hasSecret ? "default" : "warning"}>
                    {f.hasSecret ? "signed" : "open"}
                  </Badge>
                  <Badge variant="secondary">{f.synchronous ? "sync" : "async"}</Badge>
                </div>
                <p className="text-xs text-muted-foreground font-mono">
                  POST {endpointBase}/triggers/{f.flowId}
                </p>
                {f.tenantId && (
                  <p className="text-xs text-muted-foreground">Tenant: <span className="font-mono">{f.tenantId}</span></p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFiringId(firingId === f.flowId ? null : f.flowId)}
              >
                {firingId === f.flowId ? "Close test" : "Test fire"}
              </Button>
            </div>
            {firingId === f.flowId && isAuthenticated && (
              <TestFirePanel flowId={f.flowId} token={token} onClose={() => setFiringId(null)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
