"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /models — Available flows/models catalog.
 *
 * Each loaded flow is exposed as an OpenAI-compatible model object via
 *   GET /v1/models        — list all
 *   GET /v1/models/:id    — single model (detail panel)
 *
 * The page lists every model, shows its capabilities badge, and lets the
 * operator open a detail panel with the full JSON (useful for debugging Open
 * WebUI / API integrations).
 */

import { useState, useCallback, useEffect } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import { Button, Badge } from "../../../lib/ui";
import { translate, formatDate } from "../../../lib/i18n";

// ---------------------------------------------------------------------------
// Types (mirrors src/routes/models.ts ModelObject)
// ---------------------------------------------------------------------------

interface ModelCapabilities {
  reasoning?: boolean;
}

interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name?: string;
  info?: { meta?: { capabilities?: ModelCapabilities } };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function fetchModels(token: string | undefined): Promise<ModelObject[]> {
  return authFetch(backendUrl("/v1/models"), token)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ object: string; data: ModelObject[] }>;
    })
    .then((d) => d.data);
}

function fetchModel(id: string, token: string | undefined): Promise<ModelObject> {
  return authFetch(backendUrl(`/v1/models/${encodeURIComponent(id)}`), token)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<ModelObject>;
    });
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function ModelDetail({
  id,
  token,
  onClose,
}: {
  id: string;
  token: string | undefined;
  onClose: () => void;
}) {
  const [model, setModel] = useState<ModelObject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchModel(id, token)
      .then((m) => setModel(m))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [id, token]);

  return (
    <div className="border-t border-border px-4 py-3 space-y-3 bg-muted/40">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          {translate("models.modelDetail")} <span className="font-mono">{id}</span>
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}>{translate("models.close")}</Button>
      </div>
      {loading && <p className="text-sm text-muted-foreground">{translate("models.loading")}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {model && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            {[
              { label: "ID", value: model.id },
              { label: translate("models.displayName"), value: model.name ?? "—" },
              { label: translate("models.ownedBy"), value: model.owned_by },
              { label: translate("models.created"), value: formatDate(model.created * 1000) },
            ].map(({ label, value }) => (
              <div key={label} className="rounded border border-border bg-background p-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
                <div className="font-mono text-xs text-foreground break-all mt-0.5">{value}</div>
              </div>
            ))}
          </div>
          {/* Capabilities */}
          {model.info?.meta?.capabilities && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">{translate("models.capabilities")}</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(model.info.meta.capabilities).map(([cap, enabled]) => (
                  <Badge key={cap} variant={enabled ? "success" : "secondary"}>
                    {cap}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {/* Raw JSON */}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
              {translate("models.rawJSON")}
            </summary>
            <pre className="mt-2 overflow-auto rounded border border-border bg-background p-3 text-foreground">
              {JSON.stringify(model, null, 2)}
            </pre>
          </details>
          {/* Usage hint */}
          <div className="rounded border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">
            {translate("models.useThisModelInAPI")}{" "}
            <code className="font-mono">&quot;model&quot;: &quot;{model.id}&quot;</code> in{" "}
            <code className="font-mono">POST /v1/chat/completions</code>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ModelsPage() {
  const { token, ready, isAuthenticated } = useAuth();
  const [models, setModels] = useState<ModelObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ready || !isAuthenticated) return;
    setLoading(true);
    setError(null);
    try {
      setModels(await fetchModels(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, ready, isAuthenticated]);

  useEffect(() => {
    if (ready && isAuthenticated) void load();
  }, [ready, isAuthenticated, load]);

  const filtered = models.filter(
    (m) =>
      m.id.toLowerCase().includes(search.toLowerCase()) ||
      (m.name ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="mx-auto w-full max-w-screen-xl p-4 sm:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{translate("models.modelCatalog")}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {translate("models.everyLoadedFlowIsExposed")} <code className="font-mono text-xs">POST /v1/chat/completions</code>.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? translate("models.loading") : translate("models.refresh")}
        </Button>
      </div>

      {/* Search */}
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={translate("models.searchByIdOrName")}
        className="w-full max-w-sm rounded border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      {error && (
        <div role="alert" className="rounded border border-danger-border bg-danger-soft px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {!loading && filtered.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-sm text-muted-foreground">
          {search ? translate("models.noModelsMatchYourSearch") : translate("models.noModelsFoundLoadA")}
        </div>
      )}

      {/* Model cards */}
      <div className="space-y-2">
        {filtered.map((m) => {
          const capabilities = m.info?.meta?.capabilities ?? {};
          const hasReasoning = capabilities.reasoning === true;

          return (
            <div key={m.id} className="rounded-lg border border-border bg-card shadow-sm">
              {/* Row */}
              <button type="button"
                onClick={() => setExpanded(expanded === m.id ? null : m.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted"
                aria-expanded={expanded === m.id}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-medium text-foreground truncate">
                      {m.id}
                    </span>
                    {m.name && m.name !== m.id && (
                      <span className="text-xs text-muted-foreground truncate">{m.name}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {hasReasoning && (
                    <Badge variant="default" title={translate("models.supportsReasoningThinkingBlocks")}>
                      reasoning
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    {m.owned_by}
                  </span>
                  <svg aria-hidden="true" focusable="false"
                    className={`h-4 w-4 text-muted-foreground transition-transform ${expanded === m.id ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {/* Detail panel */}
              {expanded === m.id && isAuthenticated && (
                <ModelDetail id={m.id} token={token} onClose={() => setExpanded(null)} />
              )}
            </div>
          );
        })}
      </div>

      {/* Count footer */}
      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {translate("models.lengthOfLength2ModelS", { length: filtered.length, length2: models.length })}
          {search && translate("models.matchingSearch", { search })}
        </p>
      )}
    </div>
  );
}
