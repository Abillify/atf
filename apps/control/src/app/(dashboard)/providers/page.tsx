"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /providers — Provider Key Pool management (Req. 13.5).
 *
 * Lists configured provider keys via GET /providers/keys.
 */

import React from "react";
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
} from "../../../lib/ui";
import type { BadgeVariant } from "../../../lib/ui";

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

function fetchProviderKeys(token: string): Promise<ProviderKey[]> {
  return authFetch(backendUrl("/admin/provider-keys"), token).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ keys: ProviderKey[] }>;
  }).then((d) => d.keys);
}

const STATUS_VARIANT: Record<ProviderKey["status"], BadgeVariant> = {
  active: "success",
  rotated: "warning",
  revoked: "destructive",
};

export default function ProvidersPage() {
  const { token, ready } = useAuth();

  const {
    data: keys = [],
    isLoading,
    error,
  } = useQuery<ProviderKey[], Error>({
    queryKey: ["providers", "keys"],
    queryFn: () => fetchProviderKeys(token!),
    enabled: ready && !!token,
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold text-foreground">
        Provider Key Pool
      </h1>

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
          className="rounded-md bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load provider keys: {error.message}
        </div>
      )}

      {!isLoading && !error && keys.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          No provider keys configured.
        </div>
      )}

      {keys.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Provider</TableHeaderCell>
                <TableHeaderCell>Key</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell className="text-right">Successes</TableHeaderCell>
                <TableHeaderCell className="text-right">Failures</TableHeaderCell>
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
