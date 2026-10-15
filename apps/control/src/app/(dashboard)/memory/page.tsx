"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /memory — Memory Session Management (Req. 13.3).
 *
 * Lists memory sessions and their entries via GET /memory/sessions.
 */

import { useState } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useCanWrite } from "../../../lib/auth/useCanWrite";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import { Badge, Button, useConfirm } from "../../../lib/ui";
import { translate } from "../../../lib/i18n";

interface MemoryEntry {
  id: string;
  text: string;
  kind?: string;
  createdAt?: string;
}

interface MemorySession {
  id: string;
  userId: string;
  tenantId?: string;
  entryCount: number;
}

/**
 * Thrown when the backend answers a memory route with 404. That is not a
 * transient network error but a deterministic "feature not mounted" signal:
 * the runtime only registers `/admin/memory/*` when MEMORY_ENABLED=true and an
 * EMBEDDING_MODEL is configured. Retrying it just keeps the spinner up, so we
 * surface it as an explicit, non-retryable state instead.
 */
class MemoryDisabledError extends Error {
  constructor() {
    super("MEMORY_DISABLED");
    this.name = "MemoryDisabledError";
  }
}

function fetchSessions(token: string | undefined): Promise<MemorySession[]> {
  return authFetch(backendUrl("/admin/memory/sessions"), token).then((r) => {
    if (r.status === 404) throw new MemoryDisabledError();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ sessions: MemorySession[] }>;
  }).then((d) => d.sessions);
}

function fetchSessionEntries(
  sessionId: string,
  token: string | undefined,
): Promise<MemoryEntry[]> {
  return authFetch(
    backendUrl(`/admin/memory/sessions/${encodeURIComponent(sessionId)}`),
    token,
  )
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ entries: MemoryEntry[] }>;
    })
    .then((d) => d.entries);
}

function clearSession(
  sessionId: string,
  token: string | undefined,
): Promise<void> {
  return authFetch(
    backendUrl(`/admin/memory/sessions/${encodeURIComponent(sessionId)}`),
    token,
    { method: "DELETE" },
  ).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });
}

function SessionEntries({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string | undefined;
}) {
  const { data: entries = [], isLoading, error } = useQuery<
    MemoryEntry[],
    Error
  >({
    queryKey: ["memory", "sessions", sessionId, "entries"],
    queryFn: () => fetchSessionEntries(sessionId, token),
  });

  if (isLoading) {
    return <div className="text-xs text-muted-foreground">{translate("memory.loadingEntries")}</div>;
  }
  if (error) {
    return <div className="text-xs text-danger">{error.message}</div>;
  }
  if (entries.length === 0) {
    return <div className="text-xs text-muted-foreground">{translate("memory.noEntries")}</div>;
  }
  return (
    <div className="mt-2 space-y-1 border-t border-border pt-2">
      {entries.slice(0, 10).map((entry) => (
        <div key={entry.id} className="flex gap-2 text-xs">
          {entry.kind && (
            <Badge variant="secondary" className="shrink-0">
              {entry.kind}
            </Badge>
          )}
          <span className="truncate text-muted-foreground">{entry.text}</span>
        </div>
      ))}
      {entries.length > 10 && (
        <div className="text-xs text-muted-foreground">
          {translate("memory.valueMoreEntries", { value: entries.length - 10 })}
        </div>
      )}
    </div>
  );
}

export default function MemoryPage() {
  const writeGate = useCanWrite("operator");
  const { confirm: confirmDialog } = useConfirm();
  // isAuthenticated instead of !!token: also loads with AUTHN_MODE=disabled (no
  // token; the backend serves the operator plane anonymously). authFetch omits
  // the Authorization header for an undefined token.
  const { token, ready, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const {
    data: sessions = [],
    isLoading,
    error,
  } = useQuery<MemorySession[], Error>({
    queryKey: ["memory", "sessions"],
    queryFn: () => fetchSessions(token),
    enabled: ready && isAuthenticated,
    // A 404 means the memory API is not mounted (feature disabled). Retrying it
    // only prolongs the spinner, so fail fast for that case and keep the
    // default backoff for genuinely transient errors.
    retry: (failureCount, err) =>
      !(err instanceof MemoryDisabledError) && failureCount < 3,
  });

  const memoryDisabled = error instanceof MemoryDisabledError;

  const clearMutation = useMutation({
    mutationFn: (sessionId: string) => clearSession(sessionId, token),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["memory", "sessions"] }),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold text-foreground">
        {translate("memory.memorySessions")}
      </h1>

      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {translate("memory.loadingSessions")}
        </div>
      )}

      {memoryDisabled && (
        <div
          role="status"
          className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
        >
          {translate("memory.longTermMemoryIsNot")} <code className="font-mono">MEMORY_ENABLED=true</code> {translate("memory.andAConfigured")} <code className="font-mono">EMBEDDING_MODEL</code> {translate("memory.toManageMemorySessionsHere")}
        </div>
      )}

      {error && !memoryDisabled && (
        <div
          role="alert"
          className="rounded-md bg-danger-soft p-4 text-sm text-danger"
        >
          {translate("memory.failedToLoadSessionsMessage", { message: error.message })}
        </div>
      )}

      {!isLoading && !error && sessions.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          {translate("memory.noMemorySessionsFound")}
        </div>
      )}

      <div className="space-y-3">
        {sessions.map((session) => (
          <div
            key={session.id}
            className="rounded-lg border border-border bg-card p-4 shadow-sm"
          >
            <div className="mb-2 flex items-start justify-between">
              <button type="button"
                className="text-left"
                onClick={() =>
                  setExpanded(expanded === session.id ? null : session.id)
                }
              >
                <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
                  <span>{translate("memory.userUserId", { userId: session.userId })}</span>
                  {session.tenantId && <span>{translate("memory.tenantTenantId", { tenantId: session.tenantId })}</span>}
                  <span>{session.entryCount} entries</span>
                </div>
              </button>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: translate("memory.clearSessionMemory"),
                    message: translate("memory.allLongTermMemoriesOf", { userId: session.userId }),
                    confirmLabel: translate("memory.clear"),
                    destructive: true,
                  });
                  if (ok) clearMutation.mutate(session.id);
                }}
                disabled={clearMutation.isPending || !writeGate.allowed}
                title={writeGate.title}
                className="ml-4"
                aria-label={translate("memory.clearSessionForUserId", { userId: session.userId })}
              >
                {translate("memory.clear")}
              </Button>
            </div>

            {expanded === session.id && (
              <SessionEntries sessionId={session.id} token={token} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
