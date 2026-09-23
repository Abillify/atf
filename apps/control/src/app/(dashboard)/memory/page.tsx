"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /memory — Memory Session Management (Req. 13.3).
 *
 * Lists memory sessions and their entries via GET /memory/sessions.
 */

import React, { useState } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import { Badge, Button } from "../../../lib/ui";

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

function fetchSessions(token: string | undefined): Promise<MemorySession[]> {
  return authFetch(backendUrl("/admin/memory/sessions"), token).then((r) => {
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
    return <div className="text-xs text-muted-foreground">Loading entries…</div>;
  }
  if (error) {
    return <div className="text-xs text-red-600">{error.message}</div>;
  }
  if (entries.length === 0) {
    return <div className="text-xs text-muted-foreground">No entries.</div>;
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
          +{entries.length - 10} more entries…
        </div>
      )}
    </div>
  );
}

export default function MemoryPage() {
  // isAuthenticated statt !!token: laedt auch bei AUTHN_MODE=disabled (kein
  // Token; Backend bedient die Operator-Plane anonym). authFetch laesst den
  // Authorization-Header bei undefined-Token weg.
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
  });

  const clearMutation = useMutation({
    mutationFn: (sessionId: string) => clearSession(sessionId, token),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["memory", "sessions"] }),
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold text-foreground">
        Memory Sessions
      </h1>

      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Loading sessions…
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load sessions: {error.message}
        </div>
      )}

      {!isLoading && !error && sessions.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          No memory sessions found.
        </div>
      )}

      <div className="space-y-3">
        {sessions.map((session) => (
          <div
            key={session.id}
            className="rounded-lg border border-border bg-card p-4 shadow-sm"
          >
            <div className="mb-2 flex items-start justify-between">
              <button
                className="text-left"
                onClick={() =>
                  setExpanded(expanded === session.id ? null : session.id)
                }
              >
                <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
                  <span>User: {session.userId}</span>
                  {session.tenantId && <span>Tenant: {session.tenantId}</span>}
                  <span>{session.entryCount} entries</span>
                </div>
              </button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => clearMutation.mutate(session.id)}
                disabled={clearMutation.isPending}
                className="ml-4"
                aria-label={`Clear session for ${session.userId}`}
              >
                Clear
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
