"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from AssistantsPanel.tsx: the identity-broker
 * revocation console (cross-scope delegation listing).
 * Without behavior change.
 */

import { useState } from "react";
import type React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth/useAuth";
import { backendUrl } from "../../lib/backend-url";
import { authFetch } from "../../lib/auth-fetch";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../lib/ui";
import { PAGE_SIZE, readJson, type DelegationView } from "./assistantShared";
import { formatDateTime } from "../../lib/i18n";

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Identity Broker — Revocation Console (cross-scope delegation listing)
// ---------------------------------------------------------------------------

/** One row of the cross-scope delegation listing (`GET /admin/identity-broker/delegations`). */
interface DelegationConsoleRow extends DelegationView {
  tenantId: string;
  userId: string;
  assistantId: string;
  grantedAt: string;
  refreshFailures: number;
}

interface DelegationConsolePage {
  total: number;
  delegations: DelegationConsoleRow[];
}

const DELEGATION_STATES = ["usable", "revoked", "broken", "absent"] as const;
type DelegationStateFilter = (typeof DELEGATION_STATES)[number];

function delegationStateBadgeVariant(
  state: string,
): "success" | "warning" | "destructive" | "secondary" {
  if (state === "usable") return "success";
  if (state === "revoked") return "destructive";
  if (state === "broken") return "warning";
  return "secondary";
}

function fetchDelegations(
  token: string | undefined,
  filters: { state?: DelegationStateFilter; search: string; offset: number },
): Promise<DelegationConsolePage> {
  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(filters.offset),
  });
  if (filters.state !== undefined) query.set("state", filters.state);
  // The listing endpoint filters by userId server-side (see the search hint on
  // the assistants list above) — the estate can be large, so filtering only
  // what the current page happens to hold would hide most matches.
  if (filters.search.trim() !== "") query.set("userId", filters.search.trim());
  return authFetch(
    backendUrl(`/admin/identity-broker/delegations?${query.toString()}`),
    token,
  ).then((r) => readJson<DelegationConsolePage>(r));
}

/**
 * Cross-scope Identity Broker console: every delegation grant across every
 * tenant/user/assistant, with a one-click revoke.
 *
 * This is the estate-wide counterpart to the per-assistant "Delegated
 * credentials" section in {@link AssistantDetailView}: that section answers
 * "what does THIS assistant hold", this answers "who holds delegated
 * authority at all, and is any of it broken or stale" — the question an
 * operator investigating a security incident or an IdP migration actually
 * asks first.
 */
export function RevocationConsole(): React.JSX.Element {
  // isAuthenticated instead of !!token: also loads with AUTHN_MODE=disabled.
  const { token, ready, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [state, setState] = useState<DelegationStateFilter | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const queryKey = [
    "identity-broker",
    "delegations",
    state ?? "any",
    search,
    offset,
  ];

  const {
    data: page,
    isLoading,
    error,
  } = useQuery<DelegationConsolePage, Error>({
    queryKey,
    queryFn: () =>
      fetchDelegations(token ?? undefined, {
        ...(state !== undefined ? { state } : {}),
        search,
        offset,
      }),
    enabled: ready && isAuthenticated,
  });

  const revoke = useMutation<unknown, Error, DelegationConsoleRow>({
    mutationFn: (row) => {
      const path = [
        encodeURIComponent(row.tenantId),
        encodeURIComponent(row.userId),
        encodeURIComponent(row.assistantId),
      ].join("/");
      return authFetch(
        backendUrl(
          `/admin/assistants/${path}/delegation?issuer=${encodeURIComponent(row.issuer)}`,
        ),
        token as string,
        { method: "DELETE" },
      ).then((r) => readJson<unknown>(r));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["identity-broker", "delegations"] });
      void queryClient.invalidateQueries({ queryKey: ["assistants", "admin"] });
    },
  });

  const rows = page?.delegations ?? [];
  const total = page?.total ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Every delegated OIDC grant across every tenant and user, in one place.
        Revoking here does two things at once: the stored grant can no longer
        mint a new access token, and any token already minted from it and
        still cached is dropped too — so a revoked assistant stops acting
        immediately rather than at that cached token&apos;s own expiry.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={state === undefined ? "primary" : "outline"}
          onClick={() => {
            setState(undefined);
            setOffset(0);
          }}
        >
          all
        </Button>
        {DELEGATION_STATES.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={state === value ? "primary" : "outline"}
            onClick={() => {
              setState(value);
              setOffset(0);
            }}
          >
            {value}
          </Button>
        ))}
        <input
          className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          placeholder="Filter by user id…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
          aria-label="Filter delegations by user id"
        />
      </div>

      {isLoading && (
        <div className="text-xs text-muted-foreground" aria-busy="true">
          Loading delegations…
        </div>
      )}
      {error && (
        <div role="alert" className="text-xs text-danger">
          Failed to load delegations: {error.message}
        </div>
      )}
      {revoke.error && (
        <div role="alert" className="text-xs text-danger">
          {revoke.error.message}
        </div>
      )}
      {!isLoading && !error && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
          No delegation grants match this filter.
        </div>
      )}

      {rows.length > 0 && (
        <>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell>Assistant</TableHeaderCell>
                <TableHeaderCell>Issuer</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Granted</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.tenantId}/${row.userId}/${row.assistantId}/${row.issuer}`}>
                  <TableCell>
                    <span className="block truncate">{row.userId}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {row.tenantId}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.assistantId}</TableCell>
                  <TableCell className="max-w-xs truncate font-mono text-[11px] text-muted-foreground">
                    {row.issuer}
                  </TableCell>
                  <TableCell>
                    <Badge variant={delegationStateBadgeVariant(row.state)}>
                      {row.state}
                    </Badge>
                    {row.refreshFailures > 0 && (
                      <span className="ml-1 text-[11px] text-muted-foreground">
                        {row.refreshFailures} failure{row.refreshFailures === 1 ? "" : "s"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(new Date(row.grantedAt))}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.state !== "revoked" && (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(row)}
                        aria-label={`Revoke delegation for ${row.userId} / ${row.assistantId} / ${row.issuer}`}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {offset + 1}–{offset + rows.length} of {total}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + rows.length >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
