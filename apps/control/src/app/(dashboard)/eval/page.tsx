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
import { useCanWrite } from "../../../lib/auth/useCanWrite";
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
import { translate, formatDateTime } from "../../../lib/i18n";

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
  const writeGate = useCanWrite("operator");
  // isAuthenticated instead of !!token: also loads with AUTHN_MODE=disabled (no
  // token; the backend serves the operator plane anonymously). authFetch omits
  // the Authorization header for an undefined token.
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
        {translate("eval.eval")}
      </h1>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "cases" | "runs")} className="mb-4">
        <TabsList>
          <TabsTrigger value="cases">{translate("eval.cases")}</TabsTrigger>
          <TabsTrigger value="runs">{translate("eval.runs")}</TabsTrigger>
        </TabsList>
        <TabsContent value="cases" className="mt-4">

      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {translate("eval.loadingEvalCases2")}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md bg-danger-soft p-4 text-sm text-danger"
        >
          {translate("eval.failedToLoadEvalCases", { message: error.message })}
        </div>
      )}

      {deleteMutation.error && (
        <div role="alert" className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
          {translate("eval.failedToDeleteEvalCase", { message: deleteMutation.error.message })}
        </div>
      )}

      {!isLoading && !error && cases.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          {translate("eval.noEvalCasesFoundSave")}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {cases.length > 0 && (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{translate("eval.flow")}</TableHeaderCell>
                <TableHeaderCell>{translate("eval.prompt")}</TableHeaderCell>
                <TableHeaderCell>{translate("eval.createdBy")}</TableHeaderCell>
                <TableHeaderCell>{translate("eval.created")}</TableHeaderCell>
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
                    {formatDateTime(c.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {confirmId === c.id ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => deleteMutation.mutate(c.id)}
                          disabled={deleteMutation.isPending}
                          aria-label={translate("eval.confirmDeleteOfEvalCase", { id: c.id })}
                        >
                          {deleteMutation.isPending ? translate("eval.deleting") : translate("eval.confirmDelete")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirmId(null)}
                          disabled={deleteMutation.isPending}
                        >
                          {translate("eval.cancel")}
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
                        disabled={deleteMutation.isPending || !writeGate.allowed}
                        title={writeGate.title}
                        aria-label={translate("eval.deleteEvalCaseId", { id: c.id })}
                      >
                        {translate("eval.delete")}
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
