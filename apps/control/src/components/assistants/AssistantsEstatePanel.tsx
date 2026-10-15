"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from AssistantsPanel.tsx: the estate panel
 * (assistant list + detail column). Without behavior change.
 */

import { useState } from "react";
import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth/useAuth";
import { backendUrl } from "../../lib/backend-url";
import { authFetch } from "../../lib/auth-fetch";
import {
  Badge,
  Button,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../lib/ui";
import {
  PAGE_SIZE,
  readJson,
  type AssistantListPage,
  type AssistantRow,
  type AssistantStatus,
} from "./assistantShared";
import { AssistantDetailView } from "./AssistantDetailView";
import { translate, formatDateTime } from "../../lib/i18n";

function fetchAssistants(
  token: string | undefined,
  filters: { status?: string; search: string; offset: number },
): Promise<AssistantListPage> {
  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(filters.offset),
  });
  if (filters.status !== undefined) query.set("status", filters.status);
  // A search term filters by user id server-side: the estate can be large, so
  // filtering in the browser would only hide rows the current page happens to hold.
  if (filters.search.trim() !== "") query.set("userId", filters.search.trim());
  return authFetch(backendUrl(`/admin/assistants?${query.toString()}`), token).then(
    (r) => readJson<AssistantListPage>(r),
  );
}
// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function AssistantsEstatePanel(): React.JSX.Element {
  // isAuthenticated instead of !!token: also loads with AUTHN_MODE=disabled.
  const { token, ready, isAuthenticated } = useAuth();
  const [status, setStatus] = useState<AssistantStatus | undefined>("active");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AssistantRow | null>(null);

  const {
    data: page,
    isLoading,
    error,
  } = useQuery<AssistantListPage, Error>({
    queryKey: ["assistants", "admin", "list", status ?? "any", search, offset],
    queryFn: () =>
      fetchAssistants(token ?? undefined, {
        ...(status !== undefined ? { status } : {}),
        search,
        offset,
      }),
    enabled: ready && isAuthenticated,
  });

  const rows = page?.assistants ?? [];
  const total = page?.total ?? 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Panel heading={translate("assistantsEstatePanel.assistants")}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(["active", "suspended", "archived"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={status === value ? "primary" : "outline"}
              onClick={() => {
                setStatus(value);
                setOffset(0);
              }}
            >
              {value}
            </Button>
          ))}
          <Button
            size="sm"
            variant={status === undefined ? "primary" : "outline"}
            onClick={() => {
              setStatus(undefined);
              setOffset(0);
            }}
          >
            all
          </Button>
          <input
            className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            placeholder={translate("assistantsEstatePanel.filterByUserId")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
            aria-label={translate("assistantsEstatePanel.filterAssistantsByUserId")}
          />
        </div>

        {isLoading && (
          <div className="text-xs text-muted-foreground" aria-busy="true">
            {translate("assistantsEstatePanel.loadingAssistants")}
          </div>
        )}
        {error && (
          <div role="alert" className="text-xs text-danger">
            {translate("assistantsEstatePanel.failedToLoadAssistantsMessage", { message: error.message })}
          </div>
        )}
        {!isLoading && !error && rows.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
            {translate("assistantsEstatePanel.noAssistantsTheyAreProvisioned")}{" "}
            <code className="font-mono">assistant</code> {translate("assistantsEstatePanel.flowSet")}{" "}
            <code className="font-mono">ASSISTANTS_ENABLED=true</code> {translate("assistantsEstatePanel.ifThatHasNotHappened")}
          </div>
        )}

        {rows.length > 0 && (
          <>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>{translate("assistantsEstatePanel.user")}</TableHeaderCell>
                  <TableHeaderCell>{translate("assistantsEstatePanel.assistant")}</TableHeaderCell>
                  <TableHeaderCell>{translate("assistantsEstatePanel.autonomy")}</TableHeaderCell>
                  <TableHeaderCell>{translate("assistantsEstatePanel.skills")}</TableHeaderCell>
                  <TableHeaderCell>{translate("assistantsEstatePanel.pending")}</TableHeaderCell>
                  <TableHeaderCell>{translate("assistantsEstatePanel.lastActive")}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={`${row.tenantId}/${row.userId}/${row.assistantId}`}
                    onClick={() => setSelected(row)}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <span className="block truncate">{row.userId}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {row.tenantId}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.displayName ?? row.assistantId}
                      <span className="block font-mono text-[11px] text-muted-foreground">
                        assistant-{row.assistantId}
                      </span>
                    </TableCell>
                    <TableCell>{row.autonomy}</TableCell>
                    <TableCell>{row.skillCount}</TableCell>
                    <TableCell>
                      {row.pendingProposalCount > 0 ? (
                        <Badge variant="warning">{row.pendingProposalCount}</Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.lastActiveAt === undefined
                        ? "never"
                        : formatDateTime(new Date(row.lastActiveAt))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
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
                {translate("assistantsEstatePanel.previous")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + rows.length >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                {translate("assistantsEstatePanel.next")}
              </Button>
            </div>
          </>
        )}
      </Panel>

      <Panel
        heading={
          selected === null
            ? translate("assistantsEstatePanel.selectAnAssistant")
            : `${selected.userId} / ${selected.assistantId}`
        }
      >
        {selected === null || token === undefined ? (
          <p className="text-xs text-muted-foreground">
            {translate("assistantsEstatePanel.pickARowToSee")}
          </p>
        ) : (
          <AssistantDetailView row={selected} token={token} />
        )}
      </Panel>
    </div>
  );
}
