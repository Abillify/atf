"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /tenants — Full tenant administration.
 *
 * Covers every backend surface:
 *   CRUD  POST/GET/PATCH/DELETE /admin/tenants
 *   Keys  POST/GET/DELETE       /admin/tenants/:id/keys
 *   Usage GET                   /admin/tenants/:id/usage/summary
 *   BYOK  GET/PUT/DELETE        /admin/tenants/:id/provider-keys
 */

import { useState, } from "react";
import { RequireRole } from "../../../lib/auth/RequireRole";
import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { backendUrl } from "../../../lib/backend-url";
import { formatCost, withCurrency } from "../../../lib/currency";
import { authFetch } from "../../../lib/auth-fetch";
import {
  Button, Badge, Tabs, TabsList, TabsTrigger, TabsContent,
  Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell,
  useConfirm,
} from "../../../lib/ui";
import { formatNumber, formatDate } from "../../../lib/i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Tenant {
  id: string; name: string; plan: string;
  dailyBudget?: number; metadata?: Record<string, unknown>;
  createdAt: string; updatedAt: string;
}
interface ApiKey {
  id: string; name: string; tenantId: string;
  createdAt: string; lastUsedAt?: string; revoked?: boolean;
  rawKey?: string; // only present immediately after creation
}
interface UsageSummary {
  tenantId: string; from: string; to?: string;
  totalRequests: number; totalCost: number; totalTokens: number;
  byModel?: Array<{ provider: string; model: string; requests: number; cost: number; tokens: number }>;
}
interface ProviderKey { provider: string; configured: boolean; }
const BYOK_PROVIDERS = ["openai", "google", "azure", "bedrock"] as const;
type ByokProvider = (typeof BYOK_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const api = {
  tenants: (token: string | undefined) =>
    authFetch(backendUrl("/admin/tenants"), token).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ tenants: Tenant[] }>;
    }).then(d => d.tenants),

  createTenant: (token: string | undefined, body: Partial<Tenant>) =>
    authFetch(backendUrl("/admin/tenants"), token, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async r => { if (!r.ok) throw new Error((await r.json() as { error?: { message?: string } }).error?.message ?? `HTTP ${r.status}`); return (await r.json() as { tenant: Tenant }).tenant; }),

  updateTenant: (token: string | undefined, id: string, body: Partial<Tenant>) =>
    authFetch(backendUrl(`/admin/tenants/${encodeURIComponent(id)}`), token, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async r => { if (!r.ok) throw new Error((await r.json() as { error?: { message?: string } }).error?.message ?? `HTTP ${r.status}`); return (await r.json() as { tenant: Tenant }).tenant; }),

  deleteTenant: (token: string | undefined, id: string) =>
    authFetch(backendUrl(`/admin/tenants/${encodeURIComponent(id)}`), token, { method: "DELETE" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); }),

  keys: (token: string | undefined, tenantId: string) =>
    authFetch(backendUrl(`/admin/tenants/${encodeURIComponent(tenantId)}/keys`), token)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ keys: ApiKey[] }>; }).then(d => d.keys),

  createKey: (token: string | undefined, tenantId: string, name: string) =>
    authFetch(backendUrl(`/admin/tenants/${encodeURIComponent(tenantId)}/keys`), token, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then(async r => { if (!r.ok) throw new Error((await r.json() as { error?: { message?: string } }).error?.message ?? `HTTP ${r.status}`); return (await r.json() as { key: ApiKey }).key; }),

  revokeKey: (token: string | undefined, tenantId: string, kid: string) =>
    authFetch(backendUrl(`/admin/tenants/${encodeURIComponent(tenantId)}/keys/${encodeURIComponent(kid)}`), token, { method: "DELETE" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); }),

  usage: (token: string | undefined, tenantId: string) =>
    authFetch(backendUrl(`/admin/tenants/${encodeURIComponent(tenantId)}/usage/summary`), token)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ summary: UsageSummary }>; }).then(d => d.summary),

  providerKeys: (token: string | undefined, tenantId: string) =>
    authFetch(backendUrl(`/admin/tenants/${encodeURIComponent(tenantId)}/provider-keys`), token)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ providerKeys: ProviderKey[] }>; }).then(d => d.providerKeys),

  setProviderKey: (token: string | undefined, tenantId: string, provider: string, key: string) =>
    authFetch(backendUrl(`/admin/tenants/${encodeURIComponent(tenantId)}/provider-keys/${encodeURIComponent(provider)}`), token, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }).then(async r => { if (!r.ok) throw new Error((await r.json() as { error?: { message?: string } }).error?.message ?? `HTTP ${r.status}`); }),

  deleteProviderKey: (token: string | undefined, tenantId: string, provider: string) =>
    authFetch(backendUrl(`/admin/tenants/${encodeURIComponent(tenantId)}/provider-keys/${encodeURIComponent(provider)}`), token, { method: "DELETE" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); }),
};

// ---------------------------------------------------------------------------
// TenantForm — create or edit
// ---------------------------------------------------------------------------

function TenantForm({
  initial, token, onSaved, onCancel,
}: {
  initial?: Tenant; token: string | undefined; onSaved: () => void; onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [plan, setPlan] = useState(initial?.plan ?? "free");
  const [budget, setBudget] = useState(initial?.dailyBudget !== undefined ? String(initial.dailyBudget) : "");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        plan: plan.trim() || "free",
        ...(budget !== "" ? { dailyBudget: parseFloat(budget) } : {}),
      };
      if (initial) return api.updateTenant(token, initial.id, body);
      return api.createTenant(token, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
      onSaved();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: "Name *", value: name, onChange: setName, placeholder: "ACME Corp" },
          { label: "Plan", value: plan, onChange: setPlan, placeholder: "free" },
          { label: "Daily budget ($)", value: budget, onChange: setBudget, placeholder: "e.g. 5.00" },
        ].map(({ label, value, onChange, placeholder }) => (
          <div key={label}>
            <label htmlFor={`tenant-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
            <input id={`tenant-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
              className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : initial ? "Save changes" : "Create tenant"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KeysTab
// ---------------------------------------------------------------------------

function KeysTab({ tenantId, token }: { tenantId: string; token: string | undefined }) {
  const { confirm: confirmDialog } = useConfirm();
  const qc = useQueryClient();
  const [newName, setNewName] = useState("default");
  const [revealed, setRevealed] = useState<string | null>(null);

  const { data: keys = [], isLoading } = useQuery<ApiKey[], Error>({
    queryKey: ["admin", "tenants", tenantId, "keys"],
    queryFn: () => api.keys(token, tenantId),
  });

  const createMutation = useMutation({
    mutationFn: () => api.createKey(token, tenantId, newName.trim() || "default"),
    onSuccess: (key) => {
      setRevealed(key.rawKey ?? null);
      void qc.invalidateQueries({ queryKey: ["admin", "tenants", tenantId, "keys"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (kid: string) => api.revokeKey(token, tenantId, kid),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "tenants", tenantId, "keys"] }),
  });

  return (
    <div className="space-y-4">
      {revealed && (
        <div className="rounded border border-success-border bg-success-soft p-3 text-sm text-success">
          <p className="font-medium mb-1">Key created — copy it now, it won&apos;t be shown again.</p>
          <code className="break-all font-mono text-xs">{revealed}</code>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => setRevealed(null)}>Dismiss</Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Key name"
          className="rounded border border-border bg-background px-3 py-1.5 text-sm w-48 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button variant="primary" size="sm" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
          {createMutation.isPending ? "…" : "+ Create key"}
        </Button>
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">No API keys yet.</p>
      ) : (
        <Table>
          <TableHead><TableRow className="uppercase tracking-wide">
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>ID</TableHeaderCell>
            <TableHeaderCell>Created</TableHeaderCell>
            <TableHeaderCell>Last used</TableHeaderCell>
            <TableHeaderCell className="text-center">Status</TableHeaderCell>
            <TableHeaderCell />
          </TableRow></TableHead>
          <TableBody>
            {keys.map(k => (
              <TableRow key={k.id}>
                <TableCell className="font-medium">{k.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{k.id.slice(0, 12)}…</TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(k.createdAt)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{k.lastUsedAt ? formatDate(k.lastUsedAt) : "—"}</TableCell>
                <TableCell className="text-center">
                  <Badge variant={k.revoked ? "destructive" : "success"}>{k.revoked ? "revoked" : "active"}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  {!k.revoked && (
                    <Button variant="destructive" size="sm" disabled={revokeMutation.isPending}
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: "Revoke API key?",
                          message: `Every client using "${k.name}" is rejected immediately. This cannot be undone.`,
                          confirmLabel: "Revoke",
                          destructive: true,
                        });
                        if (ok) revokeMutation.mutate(k.id);
                      }}>Revoke</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UsageTab
// ---------------------------------------------------------------------------

function UsageTab({ tenantId, token }: { tenantId: string; token: string | undefined }) {
  const { data: summary, isLoading, error } = useQuery<UsageSummary, Error>({
    queryKey: ["admin", "tenants", tenantId, "usage"],
    queryFn: () => api.usage(token, tenantId),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-danger">{error.message}</p>;
  if (!summary) return null;

  const fmt = (n: number) => n < 0.01 ? n.toFixed(6) : n.toFixed(4);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Requests", value: String(summary.totalRequests) },
          { label: "Tokens", value: formatNumber(summary.totalTokens) },
          { label: "Cost", value: withCurrency(fmt(summary.totalCost)), green: true },
        ].map(({ label, value, green }) => (
          <div key={label} className="rounded border border-border bg-background p-3 text-center">
            <div className={`text-xl font-bold tabular-nums ${green ? "text-success" : "text-foreground"}`}>{value}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
          </div>
        ))}
      </div>
      {summary.byModel && summary.byModel.length > 0 && (
        <Table>
          <TableHead><TableRow className="uppercase tracking-wide">
            <TableHeaderCell>Model</TableHeaderCell>
            <TableHeaderCell className="text-right">Requests</TableHeaderCell>
            <TableHeaderCell className="text-right">Tokens</TableHeaderCell>
            <TableHeaderCell className="text-right">Cost</TableHeaderCell>
          </TableRow></TableHead>
          <TableBody>
            {summary.byModel.map(m => (
              <TableRow key={`${m.provider}/${m.model}`}>
                <TableCell className="font-mono text-xs">{m.provider}/{m.model}</TableCell>
                <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(m.tokens)}</TableCell>
                <TableCell className="text-right tabular-nums text-success">{withCurrency(fmt(m.cost))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-xs text-muted-foreground">Period: {summary.from}{summary.to ? ` → ${summary.to}` : " (last 30 days)"}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BYOKTab
// ---------------------------------------------------------------------------

function BYOKTab({ tenantId, token }: { tenantId: string; token: string | undefined }) {
  const { confirm: confirmDialog } = useConfirm();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ByokProvider | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [opError, setOpError] = useState<string | null>(null);

  const { data: keys = [], isLoading } = useQuery<ProviderKey[], Error>({
    queryKey: ["admin", "tenants", tenantId, "provider-keys"],
    queryFn: () => api.providerKeys(token, tenantId),
  });

  const setMutation = useMutation({
    mutationFn: ({ provider, key }: { provider: string; key: string }) =>
      api.setProviderKey(token, tenantId, provider, key),
    onSuccess: () => {
      setEditing(null); setKeyValue(""); setOpError(null);
      void qc.invalidateQueries({ queryKey: ["admin", "tenants", tenantId, "provider-keys"] });
    },
    onError: (err) => setOpError(err instanceof Error ? err.message : String(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (provider: string) => api.deleteProviderKey(token, tenantId, provider),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "tenants", tenantId, "provider-keys"] }),
    onError: (err) => setOpError(err instanceof Error ? err.message : String(err)),
  });

  const configuredSet = new Set(keys.filter(k => k.configured).map(k => k.provider));

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Bring-Your-Own-Key (BYOK): override the platform&apos;s shared provider credentials with per-tenant keys.
        Keys are stored encrypted server-side and never returned after setting.
      </p>
      {opError && <p role="alert" className="text-sm text-danger">{opError}</p>}
      {editing && (
        <div className="rounded border border-border bg-muted p-3 space-y-2">
          <p className="text-sm font-medium text-foreground">Set key for <span className="font-mono">{editing}</span></p>
          <input type="password" value={keyValue} onChange={e => setKeyValue(e.target.value)}
            placeholder="Paste API key…" autoComplete="off"
            className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={setMutation.isPending || !keyValue.trim()}
              onClick={() => setMutation.mutate({ provider: editing, key: keyValue.trim() })}>
              {setMutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setEditing(null); setKeyValue(""); }}>Cancel</Button>
          </div>
        </div>
      )}
      <Table>
        <TableHead><TableRow className="uppercase tracking-wide">
          <TableHeaderCell>Provider</TableHeaderCell>
          <TableHeaderCell className="text-center">Status</TableHeaderCell>
          <TableHeaderCell className="text-right">Actions</TableHeaderCell>
        </TableRow></TableHead>
        <TableBody>
          {BYOK_PROVIDERS.map(p => (
            <TableRow key={p}>
              <TableCell className="font-mono">{p}</TableCell>
              <TableCell className="text-center">
                <Badge variant={configuredSet.has(p) ? "success" : "secondary"}>
                  {configuredSet.has(p) ? "configured" : "not set"}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setEditing(p); setKeyValue(""); }}>
                    {configuredSet.has(p) ? "Replace" : "Set key"}
                  </Button>
                  {configuredSet.has(p) && (
                    <Button variant="destructive" size="sm" disabled={deleteMutation.isPending}
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: `Remove the ${p} key?`,
                          message: "This tenant's requests to the provider fall back to the deployment key, or fail when keys are mandatory.",
                          confirmLabel: "Remove",
                          destructive: true,
                        });
                        if (ok) deleteMutation.mutate(p);
                      }}>Remove</Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TenantDetail — tabbed panel shown when a row is expanded
// ---------------------------------------------------------------------------

function TenantDetail({
  tenant, token, onEdited, onDeleted,
}: {
  tenant: Tenant; token: string | undefined; onEdited: () => void; onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteTenant(token, tenant.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
      onDeleted();
    },
  });

  return (
    <div className="border-t border-border px-4 py-4 space-y-4">
      {editing ? (
        <TenantForm initial={tenant} token={token}
          onSaved={() => { setEditing(false); onEdited(); }}
          onCancel={() => setEditing(false)} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          {confirmDelete ? (
            <>
              <span className="text-xs text-danger">Delete &quot;{tenant.name}&quot;?</span>
              <Button variant="destructive" size="sm" disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}>
                {deleteMutation.isPending ? "…" : "Confirm delete"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </>
          ) : (
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>Delete tenant</Button>
          )}
        </div>
      )}

      <Tabs defaultValue="keys">
        <TabsList>
          <TabsTrigger value="keys">API Keys</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="byok">BYOK Keys</TabsTrigger>
        </TabsList>
        <TabsContent value="keys"><KeysTab tenantId={tenant.id} token={token} /></TabsContent>
        <TabsContent value="usage"><UsageTab tenantId={tenant.id} token={token} /></TabsContent>
        <TabsContent value="byok"><BYOKTab tenantId={tenant.id} token={token} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TenantList — main list + create
// ---------------------------------------------------------------------------

function TenantList() {
  // isAuthenticated instead of !!token: also loads with AUTHN_MODE=disabled (no
  // token; the backend serves the operator plane anonymously). authFetch omits
  // the Authorization header for an undefined token.
  const { token, ready, isAuthenticated } = useAuth();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();

  const { data: tenants = [], isLoading, error } = useQuery<Tenant[], Error>({
    queryKey: ["admin", "tenants"],
    queryFn: () =>
      authFetch(backendUrl("/admin/tenants"), token)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ tenants: Tenant[] }>; })
        .then(d => d.tenants),
    enabled: ready && isAuthenticated,
  });

  const filtered = tenants.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.id.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input type="search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or ID…"
          className="rounded border border-border bg-background px-3 py-1.5 text-sm w-64 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button variant="primary" size="sm" onClick={() => { setCreating(v => !v); setExpanded(null); }}>
          {creating ? "Cancel" : "+ New tenant"}
        </Button>
        <span className="text-xs text-muted-foreground">{tenants.length} tenant(s)</span>
      </div>

      {creating && isAuthenticated && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-semibold text-foreground mb-3">Create tenant</p>
          <TenantForm token={token}
            onSaved={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ["admin", "tenants"] }); }}
            onCancel={() => setCreating(false)} />
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading tenants…</p>}
      {error && <p role="alert" className="text-sm text-danger">{error.message}</p>}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card py-10 text-center text-sm text-muted-foreground">
          {search ? "No tenants match your search." : "No tenants yet. Create one above."}
        </div>
      )}

      <div className="space-y-2">
        {filtered.map(t => (
          <div key={t.id} className="rounded-lg border border-border bg-card shadow-sm">
            {/* Row */}
            <button type="button"
              onClick={() => setExpanded(expanded === t.id ? null : t.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted"
              aria-expanded={expanded === t.id}
            >
              <span className="font-medium text-foreground flex-1 truncate">{t.name}</span>
              <span className="text-xs text-muted-foreground font-mono hidden sm:inline">{t.id.slice(0, 10)}…</span>
              <Badge variant="secondary">{t.plan}</Badge>
              {t.dailyBudget !== undefined && (
                <span className="text-xs text-success tabular-nums">
                  {formatCost(t.dailyBudget, 2)}/day
                </span>
              )}
              <span className="text-xs text-muted-foreground hidden md:inline">
                {formatDate(t.createdAt)}
              </span>
              <svg aria-hidden="true" focusable="false" className={`h-4 w-4 text-muted-foreground transition-transform shrink-0 ${expanded === t.id ? "rotate-180" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {expanded === t.id && isAuthenticated && (
              <TenantDetail tenant={t} token={token}
                onEdited={() => void qc.invalidateQueries({ queryKey: ["admin", "tenants"] })}
                onDeleted={() => setExpanded(null)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TenantsPage() {
  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold text-foreground">Tenant Administration</h1>
      <RequireRole minRole="admin" fallback={
        <div role="alert" className="rounded-lg border border-warning-border bg-warning-soft p-6 text-center text-sm text-warning">
          Administrator access required to view tenant management.
        </div>
      }>
        <TenantList />
      </RequireRole>
    </div>
  );
}
