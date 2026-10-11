"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: Extracted from AssistantsPanel.tsx — org skill registry
 * (cross-tenant browse + deprecate). No behavior change.
 */

import { useState } from "react";
import type React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth/useAuth";
import { backendUrl } from "../../lib/backend-url";
import { authFetch } from "../../lib/auth-fetch";
import { Badge, Button } from "../../lib/ui";
import { PAGE_SIZE, readJson } from "./assistantShared";

// ---------------------------------------------------------------------------
// Org Skill Registry — cross-tenant browse + deprecate
// ---------------------------------------------------------------------------

/** One row of the tenant-wide skill catalog (`GET /admin/org-skills`). */
interface OrgSkillRow {
  id: string;
  tenantId: string;
  name: string;
  triggerLine: string;
  body: string;
  status: "published" | "deprecated";
  summary?: string;
  evidence?: string;
  installCount: number;
  publishedBy: string;
  sourceUserId: string;
  sourceAssistantId: string;
  createdAt: string;
  updatedAt: string;
}

interface OrgSkillListPage {
  total: number;
  skills: OrgSkillRow[];
}

function fetchOrgSkills(
  token: string | undefined,
  filters: { tenantId: string; status?: "published" | "deprecated"; offset: number },
): Promise<OrgSkillListPage> {
  const query = new URLSearchParams({
    tenantId: filters.tenantId,
    limit: String(PAGE_SIZE),
    offset: String(filters.offset),
  });
  if (filters.status !== undefined) query.set("status", filters.status);
  return authFetch(backendUrl(`/admin/org-skills?${query.toString()}`), token).then((r) =>
    readJson<OrgSkillListPage>(r),
  );
}

/**
 * Cross-tenant view of the Org Skill Registry catalog (`org-skill-registry.ts`).
 *
 * This mirrors the Revocation Console's role over delegations: operator
 * VISIBILITY plus exactly one moderation action, `deprecate`. There is
 * deliberately no operator-publish or operator-install here — publishing is
 * the source assistant's own user's decision and installing is the
 * destination assistant's own user's decision (both reached via `/v1/*`, not
 * this dashboard), consistent with the "an operator never applies a user's
 * proposal" boundary the Estate tab's proposal queue already documents.
 * `deprecate` only hides an entry from future browsing/installing — it never
 * touches an assistant that already installed from it, because installing
 * copied the content into that assistant's OWN proposal pipeline rather than
 * keeping a live reference (see the module doc comment on
 * `org-skill-registry.ts`).
 */
export function SkillRegistryConsole(): React.JSX.Element {
  // isAuthenticated instead of !!token: also loads with AUTHN_MODE=disabled.
  const { token, ready, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [tenantId, setTenantId] = useState("");
  const [status, setStatus] = useState<"published" | "deprecated" | undefined>(
    "published",
  );
  const [offset, setOffset] = useState(0);

  const queryKey = ["org-skills", "admin", tenantId, status ?? "any", offset];

  const {
    data: page,
    isLoading,
    error,
  } = useQuery<OrgSkillListPage, Error>({
    queryKey,
    queryFn: () =>
      fetchOrgSkills(token ?? undefined, {
        tenantId,
        ...(status !== undefined ? { status } : {}),
        offset,
      }),
    enabled: ready && isAuthenticated && tenantId.trim() !== "",
  });

  const deprecate = useMutation<unknown, Error, OrgSkillRow>({
    mutationFn: (row) =>
      authFetch(
        backendUrl(
          `/admin/org-skills/${encodeURIComponent(row.id)}/deprecate?tenantId=${encodeURIComponent(row.tenantId)}`,
        ),
        token as string,
        { method: "POST" },
      ).then((r) => readJson<unknown>(r)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["org-skills", "admin"] }),
  });

  const rows = page?.skills ?? [];
  const total = page?.total ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        The tenant-wide catalog of learned skills a user published from their
        own assistant for reuse by others. Installing a catalog entry never
        writes a live skill directly — it creates an ordinary proposal in the
        installing assistant&apos;s own queue, re-scanned and subject to that
        assistant&apos;s own consent path exactly like a self-learned
        proposal.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          placeholder="Tenant id…"
          value={tenantId}
          onChange={(event) => {
            setTenantId(event.target.value);
            setOffset(0);
          }}
          aria-label="Tenant id to browse"
        />
        <Button
          size="sm"
          variant={status === "published" ? "primary" : "outline"}
          onClick={() => {
            setStatus("published");
            setOffset(0);
          }}
        >
          published
        </Button>
        <Button
          size="sm"
          variant={status === "deprecated" ? "primary" : "outline"}
          onClick={() => {
            setStatus("deprecated");
            setOffset(0);
          }}
        >
          deprecated
        </Button>
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
      </div>

      {tenantId.trim() === "" && (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
          Enter a tenant id to browse its skill catalog.
        </div>
      )}
      {isLoading && (
        <div className="text-xs text-muted-foreground" aria-busy="true">
          Loading catalog…
        </div>
      )}
      {error && (
        <div role="alert" className="text-xs text-danger">
          Failed to load the catalog: {error.message}
        </div>
      )}
      {deprecate.error && (
        <div role="alert" className="text-xs text-danger">
          {deprecate.error.message}
        </div>
      )}
      {!isLoading && !error && tenantId.trim() !== "" && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
          No catalog entries match this filter.
        </div>
      )}

      {rows.length > 0 && (
        <>
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.id} className="rounded border border-border p-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge variant={row.status === "published" ? "success" : "secondary"}>
                    {row.status}
                  </Badge>
                  <span className="font-medium text-foreground">{row.name}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    installed {row.installCount}×
                  </span>
                  {row.status === "published" && (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={deprecate.isPending}
                      onClick={() => deprecate.mutate(row)}
                    >
                      Deprecate
                    </Button>
                  )}
                </div>
                <p className="mt-1 text-muted-foreground">{row.triggerLine}</p>
                {row.summary !== undefined && (
                  <p className="mt-1 text-foreground">{row.summary}</p>
                )}
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  published by {row.publishedBy} · from {row.sourceUserId}/
                  {row.sourceAssistantId}
                </p>
              </li>
            ))}
          </ul>
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
