"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /eval — Eval Cases + Runs (Req. 13.5, 16).
 *
 * Two tabs:
 *   - "Cases": eval cases saved from the Studio Playground ("Save as Eval
 *     Case") via GET /eval/cases — the regression DATASET.
 *   - "Runs": results of replaying that dataset against a flow (`bun run
 *     src/eval/run.ts`, typically CI) via GET /admin/eval/runs — see
 *     EvalRunsPanel.
 */

import React from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import {
  Button,
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
} from "../../../lib/ui";
import { EvalRunsPanel } from "../../../components/EvalRunsPanel";

interface EvalCase {
  id: string;
  flowId: string;
  prompt: string;
  expected?: unknown;
  actual?: unknown;
  createdBy: string;
  tenantId: string;
  createdAt: string;
}

function fetchEvalCases(token: string | undefined): Promise<EvalCase[]> {
  return authFetch(backendUrl("/eval/cases"), token).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ cases: EvalCase[] }>;
  }).then((d) => d.cases);
}

function deleteEvalCase(id: string, token: string | undefined): Promise<void> {
  return authFetch(
    backendUrl(`/eval/cases/${encodeURIComponent(id)}`),
    token,
    { method: "DELETE" },
  ).then(async (r) => {
    // 404: someone else already removed it — the list refresh shows the truth.
    if (r.ok || r.status === 404) return;
    const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
  });
}

export default function EvalPage() {
  // isAuthenticated statt !!token: laedt auch bei AUTHN_MODE=disabled (kein
  // Token; Backend bedient die Operator-Plane anonym). authFetch laesst den
  // Authorization-Header bei undefined-Token weg.
  const { token, ready, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState<"cases" | "runs">("cases");

  const {
    data: cases = [],
    isLoading,
    error,
  } = useQuery<EvalCase[], Error>({
    queryKey: ["eval", "cases"],
    queryFn: () => fetchEvalCases(token),
    enabled: ready && isAuthenticated,
  });

  // Two-step delete: the first click arms the row, the second deletes.
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteEvalCase(id, token),
    onSuccess: () => {
      setConfirmId(null);
      return queryClient.invalidateQueries({ queryKey: ["eval", "cases"] });
    },
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold text-foreground">
        Eval
      </h1>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "cases" | "runs")} className="mb-4">
        <TabsList>
          <TabsTrigger value="cases">Cases</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        <TabsContent value="cases" className="mt-4">

      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Loading eval cases…
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load eval cases: {error.message}
        </div>
      )}

      {deleteMutation.error && (
        <div role="alert" className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
          Failed to delete eval case: {deleteMutation.error.message}
        </div>
      )}

      {!isLoading && !error && cases.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          No eval cases found. Save a Playground run as an eval case from
          Studio to build a regression dataset.
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {cases.length > 0 && (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Flow</TableHeaderCell>
                <TableHeaderCell>Prompt</TableHeaderCell>
                <TableHeaderCell>Created by</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {cases.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {c.flowId}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-foreground">
                    {c.prompt}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.createdBy}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(c.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {confirmId === c.id ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => deleteMutation.mutate(c.id)}
                          disabled={deleteMutation.isPending}
                          aria-label={`Confirm delete of eval case ${c.id}`}
                        >
                          {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirmId(null)}
                          disabled={deleteMutation.isPending}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          deleteMutation.reset();
                          setConfirmId(c.id);
                        }}
                        disabled={deleteMutation.isPending}
                        aria-label={`Delete eval case ${c.id}`}
                      >
                        Delete
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
        </TabsContent>
        <TabsContent value="runs" className="mt-4">
          <EvalRunsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
