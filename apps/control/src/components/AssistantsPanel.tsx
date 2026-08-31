"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * AssistantsPanel — the operator view of the per-user assistant estate.
 *
 * This is an OPERATOR surface, not a user's own assistant settings. The dashboard
 * authenticates a role, not a person (ADR-0013: the OIDC session token carries only
 * the resolved role and never touches the `/v1` plane), so it can neither read nor
 * write anything as a particular user. It therefore talks to `/admin/assistants/*`,
 * which spans users, and it exposes exactly one write class of the soul: the
 * operator's `constraints`.
 *
 * What it deliberately does NOT offer:
 *   - editing a user's `directives` — those are that person's instructions to their
 *     own assistant, and an operator changing them behind their back is not a
 *     capability this product should have.
 *   - applying a learned procedure — approving new behaviour into someone's
 *     assistant is their call. Rejecting is offered, because that only removes.
 *
 * The constraint editor sends the revision hash it read, so two operators editing the
 * same assistant get a conflict instead of one silently overwriting the other.
 */

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
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
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../lib/ui";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type AssistantStatus = "active" | "suspended" | "archived";
type Autonomy = "supervised" | "assisted" | "autonomous";

interface AssistantRow {
  tenantId: string;
  userId: string;
  assistantId: string;
  displayName?: string;
  status: AssistantStatus;
  autonomy: Autonomy;
  updatedAt: string;
  lastActiveAt?: string;
  skillCount: number;
  pendingProposalCount: number;
}

interface AssistantListPage {
  total: number;
  assistants: AssistantRow[];
}

/**
 * Operator constraints as the API returns them.
 *
 * `deniedTools` is a list, not prose: it is enforced by the tool-authz layer, and the
 * prompt copy exists only so the model knows why a tool is absent instead of
 * repeatedly attempting it.
 */
interface ConstraintsView {
  rules?: string;
  compliance?: string;
  deniedTools?: string[];
}

interface SoulView {
  identity: Record<string, string>;
  directives: Record<string, string>;
  constraints: ConstraintsView;
  revision: number;
  revisionHash: string;
}

interface AssistantDetail {
  tenantId: string;
  userId: string;
  assistantId: string;
  displayName?: string;
  status: AssistantStatus;
  autonomy: Autonomy;
  workspacePath: string;
  createdAt: string;
  lastActiveAt?: string;
  soul: SoulView;
  skills: {
    name: string;
    triggerLine: string;
    origin: string;
    status: string;
    version: number;
    useCount: number;
  }[];
  delegations: DelegationView[];
}

interface DelegationView {
  issuer: string;
  consentedScope: string;
  state: string;
}

interface ProposalRow {
  id: string;
  kind: string;
  status: string;
  title?: string;
  triggerLine?: string;
  body?: string;
  autonomousCapture: boolean;
  scanState: string;
  scanFindings?: string[];
  createdAt: string;
}

/** Path segment for one assistant. All three parts are named explicitly. */
function detailPath(row: {
  tenantId: string;
  userId: string;
  assistantId: string;
}): string {
  return [
    encodeURIComponent(row.tenantId),
    encodeURIComponent(row.userId),
    encodeURIComponent(row.assistantId),
  ].join("/");
}

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // The body carries the reason the backend refused; surfacing "HTTP 409" alone
    // would leave an operator guessing whether to retry.
    const detail = await response
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: { message?: string } }).error?.message ?? "")
          : "",
      )
      .catch(() => "");
    throw new Error(detail !== "" ? detail : `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function fetchAssistants(
  token: string,
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
// Constraint editor
// ---------------------------------------------------------------------------

/**
 * The prose constraint fields, matching `SoulConstraints` exactly.
 *
 * Kept in step with `SOUL_CONSTRAINT_TEXT_FIELDS` on the backend. The API rejects
 * unknown fields, so a name invented here surfaces as a 400 rather than as a
 * constraint that silently never applies.
 */
const CONSTRAINT_FIELDS = [
  {
    key: "rules",
    label: "Rules",
    hint: 'Non-negotiable rules, e.g. "never send external email".',
  },
  {
    key: "compliance",
    label: "Compliance",
    hint: "Compliance or legal framing the assistant must respect.",
  },
] as const;

function ConstraintsEditor({
  detail,
  token,
  onSaved,
}: {
  detail: AssistantDetail;
  token: string;
  onSaved: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Record<string, string>>(() => ({
    rules: detail.soul.constraints.rules ?? "",
    compliance: detail.soul.constraints.compliance ?? "",
  }));
  // A newline-separated list rather than a tag widget: the value is a list of tool
  // ids, and one id per line is both readable and unambiguous to parse.
  const [deniedTools, setDeniedTools] = useState(() =>
    (detail.soul.constraints.deniedTools ?? []).join("\n"),
  );
  const [reason, setReason] = useState("");

  const save = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        // The hash read before editing. A concurrent change makes this a 409 rather
        // than a silent overwrite of the other operator's constraint.
        expectedRevisionHash: detail.soul.revisionHash,
      };
      for (const field of CONSTRAINT_FIELDS) {
        const value = draft[field.key] ?? "";
        const previous = detail.soul.constraints[field.key] ?? "";
        if (value === previous) continue;
        // An emptied field means "clear", which the API expresses as null. Sending
        // "" would store an empty constraint that still renders into the prompt.
        body[field.key] = value.trim() === "" ? null : value;
      }
      if (deniedTools !== (detail.soul.constraints.deniedTools ?? []).join("\n")) {
        // An empty list already means "nothing denied", so there is no null form.
        body.deniedTools = deniedTools
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
      }
      if (reason.trim() !== "") body.reason = reason.trim();
      return authFetch(
        backendUrl(`/admin/assistants/${detailPath(detail)}/constraints`),
        token,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ).then((r) => readJson<unknown>(r));
    },
    onSuccess: () => {
      setReason("");
      onSaved();
    },
  });

  const dirty =
    CONSTRAINT_FIELDS.some(
      (field) =>
        (draft[field.key] ?? "") !== (detail.soul.constraints[field.key] ?? ""),
    ) ||
    deniedTools !== (detail.soul.constraints.deniedTools ?? []).join("\n");

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Operator constraints. They render last in the assistant&apos;s prompt and are
        never dropped to make room, so they win over both the assistant&apos;s own
        identity and its user&apos;s directives.
      </p>
      {CONSTRAINT_FIELDS.map((field) => (
        <label key={field.key} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">{field.label}</span>
          <span className="text-[11px] text-muted-foreground">{field.hint}</span>
          <textarea
            className="min-h-[64px] rounded-md border border-border bg-background p-2 text-xs text-foreground"
            value={draft[field.key] ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
            aria-label={`${field.label} constraint`}
          />
        </label>
      ))}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">Denied tools</span>
        <span className="text-[11px] text-muted-foreground">
          One tool id per line. Enforced by the authorization layer, not by prompt
          text — the assistant is told why a tool is missing so it stops retrying it.
        </span>
        <textarea
          className="min-h-[48px] rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground"
          value={deniedTools}
          onChange={(event) => setDeniedTools(event.target.value)}
          aria-label="Denied tool ids, one per line"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">
          Reason (recorded in the soul history)
        </span>
        <input
          className="rounded-md border border-border bg-background p-2 text-xs text-foreground"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-label="Reason for the constraint change"
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save constraints"}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          revision {detail.soul.revision}
        </span>
      </div>
      {save.error && (
        <div role="alert" className="text-xs text-red-600">
          {save.error.message}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function ReadOnlySection({
  title,
  note,
  values,
}: {
  title: string;
  note: string;
  values: Record<string, string>;
}): React.JSX.Element {
  const entries = Object.entries(values);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-foreground">{title}</span>
      <span className="text-[11px] text-muted-foreground">{note}</span>
      {entries.length === 0 ? (
        <span className="text-xs text-muted-foreground">Empty.</span>
      ) : (
        <dl className="space-y-1">
          {entries.map(([key, value]) => (
            <div key={key} className="text-xs">
              <dt className="font-mono text-[11px] text-muted-foreground">{key}</dt>
              <dd className="whitespace-pre-wrap text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function AssistantDetailView({
  row,
  token,
}: {
  row: AssistantRow;
  token: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const path = detailPath(row);
  const detailKey = ["assistants", "admin", path];

  const {
    data: detail,
    isLoading,
    error,
  } = useQuery<AssistantDetail, Error>({
    queryKey: detailKey,
    queryFn: () =>
      authFetch(backendUrl(`/admin/assistants/${path}`), token).then((r) =>
        readJson<AssistantDetail>(r),
      ),
  });

  const { data: proposals = [] } = useQuery<ProposalRow[], Error>({
    queryKey: [...detailKey, "proposals"],
    queryFn: () =>
      authFetch(backendUrl(`/admin/assistants/${path}/proposals`), token)
        .then((r) => readJson<{ proposals: ProposalRow[] }>(r))
        .then((d) => d.proposals),
  });

  const setAutonomy = useMutation<unknown, Error, Autonomy>({
    mutationFn: (autonomy) =>
      authFetch(backendUrl(`/admin/assistants/${path}`), token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autonomy }),
      }).then((r) => readJson<unknown>(r)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({ queryKey: ["assistants", "admin", "list"] });
    },
  });

  const setStatus = useMutation<unknown, Error, AssistantStatus>({
    mutationFn: (status) =>
      authFetch(backendUrl(`/admin/assistants/${path}`), token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }).then((r) => readJson<unknown>(r)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({ queryKey: ["assistants", "admin", "list"] });
    },
  });

  const rejectProposal = useMutation<unknown, Error, string>({
    mutationFn: (proposalId) =>
      authFetch(
        backendUrl(
          `/admin/assistants/${path}/proposals/${encodeURIComponent(proposalId)}/reject`,
        ),
        token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Rejected by operator" }),
        },
      ).then((r) => readJson<unknown>(r)),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: [...detailKey, "proposals"] }),
  });

  /**
   * Revokes a delegation grant (Identity Broker Revocation Console).
   *
   * Two things happen server-side on this call, and both matter: the stored
   * grant is marked revoked (so it can no longer be used to mint a NEW access
   * token), and any access token already minted from it and still cached is
   * dropped too — without the second step a revoked assistant would keep
   * acting until that cached token's own short TTL expired on its own.
   */
  const revokeDelegation = useMutation<unknown, Error, string>({
    mutationFn: (issuer) =>
      authFetch(
        backendUrl(
          `/admin/assistants/${path}/delegation?issuer=${encodeURIComponent(issuer)}`,
        ),
        token,
        { method: "DELETE" },
      ).then((r) => readJson<unknown>(r)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({
        queryKey: ["identity-broker", "delegations"],
      });
    },
  });

  if (isLoading) {
    return <div className="text-xs text-muted-foreground">Loading assistant…</div>;
  }
  if (error) {
    return (
      <div role="alert" className="text-xs text-red-600">
        {error.message}
      </div>
    );
  }
  if (detail === undefined) return <></>;

  const pending = proposals.filter((p) => p.status === "pending");
  const quarantined = proposals.filter((p) => p.status === "quarantined");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={detail.status === "active" ? "success" : "warning"}>
          {detail.status}
        </Badge>
        <Badge variant={detail.autonomy === "autonomous" ? "warning" : "secondary"}>
          {detail.autonomy}
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">
          {detail.workspacePath}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Autonomy:</span>
        {(["supervised", "assisted", "autonomous"] as const).map((level) => (
          <Button
            key={level}
            size="sm"
            variant={detail.autonomy === level ? "primary" : "outline"}
            disabled={setAutonomy.isPending}
            onClick={() => setAutonomy.mutate(level)}
          >
            {level}
          </Button>
        ))}
        {detail.status === "active" ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={setStatus.isPending}
            onClick={() => setStatus.mutate("suspended")}
          >
            Suspend
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={setStatus.isPending || detail.status === "archived"}
            onClick={() => setStatus.mutate("active")}
          >
            Reactivate
          </Button>
        )}
      </div>
      {(setAutonomy.error ?? setStatus.error) && (
        <div role="alert" className="text-xs text-red-600">
          {(setAutonomy.error ?? setStatus.error)?.message}
        </div>
      )}

      <ConstraintsEditor
        detail={detail}
        token={token}
        onSaved={() => void queryClient.invalidateQueries({ queryKey: detailKey })}
      />

      <ReadOnlySection
        title="Directives (the user's)"
        note="Read-only here. These are the user's own instructions to their assistant."
        values={detail.soul.directives}
      />
      <ReadOnlySection
        title="Identity (the assistant's)"
        note="Read-only here. The assistant maintains this itself."
        values={detail.soul.identity}
      />

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">
          Learned procedures ({detail.skills.length})
        </span>
        {detail.skills.length === 0 ? (
          <span className="text-xs text-muted-foreground">None.</span>
        ) : (
          <ul className="space-y-1">
            {detail.skills.map((skill) => (
              <li key={skill.name} className="flex items-center gap-2 text-xs">
                <Badge variant="outline">{skill.origin}</Badge>
                <span className="font-medium text-foreground">{skill.name}</span>
                <span className="truncate text-muted-foreground">
                  {skill.triggerLine}
                </span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  used {skill.useCount}×
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">
          Proposal queue — {pending.length} pending, {quarantined.length} quarantined
        </span>
        <span className="text-[11px] text-muted-foreground">
          An operator can reject, not apply: approving new behaviour into someone&apos;s
          assistant is that person&apos;s decision.
        </span>
        {pending.length + quarantined.length === 0 ? (
          <span className="text-xs text-muted-foreground">Nothing awaiting review.</span>
        ) : (
          <ul className="space-y-2">
            {[...quarantined, ...pending].map((proposal) => (
              <li
                key={proposal.id}
                className="rounded border border-border p-2 text-xs"
              >
                <div className="flex items-center gap-2">
                  <Badge
                    variant={proposal.status === "quarantined" ? "destructive" : "secondary"}
                  >
                    {proposal.status}
                  </Badge>
                  <span className="font-medium text-foreground">
                    {proposal.title ?? proposal.kind}
                  </span>
                  {proposal.autonomousCapture && (
                    <Badge variant="warning">captured autonomously</Badge>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    className="ml-auto"
                    disabled={rejectProposal.isPending}
                    onClick={() => rejectProposal.mutate(proposal.id)}
                  >
                    Reject
                  </Button>
                </div>
                {proposal.triggerLine && (
                  <p className="mt-1 text-muted-foreground">{proposal.triggerLine}</p>
                )}
                {proposal.scanFindings !== undefined &&
                  proposal.scanFindings.length > 0 && (
                    <ul className="mt-1 list-inside list-disc text-red-600">
                      {proposal.scanFindings.map((finding) => (
                        <li key={finding}>{finding}</li>
                      ))}
                    </ul>
                  )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">
          Delegated credentials ({detail.delegations.length})
        </span>
        <span className="text-[11px] text-muted-foreground">
          Summaries only — no plane returns the refresh token, operator included.
        </span>
        {detail.delegations.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            None. Background turns run without the user&apos;s authority.
          </span>
        ) : (
          <ul className="space-y-1">
            {detail.delegations.map((grant) => (
              <li key={grant.issuer} className="flex items-center gap-2 text-xs">
                <Badge variant={grant.state === "usable" ? "success" : "warning"}>
                  {grant.state}
                </Badge>
                <span className="truncate font-mono text-muted-foreground">
                  {grant.issuer}
                </span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {grant.consentedScope}
                </span>
                {grant.state !== "revoked" && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={revokeDelegation.isPending}
                    onClick={() => revokeDelegation.mutate(grant.issuer)}
                    aria-label={`Revoke delegation for issuer ${grant.issuer}`}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {revokeDelegation.error && (
          <div role="alert" className="text-xs text-red-600">
            {revokeDelegation.error.message}
          </div>
        )}
      </div>
    </div>
  );
}

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
  token: string,
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
function RevocationConsole(): React.JSX.Element {
  const { token, ready } = useAuth();
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
      fetchDelegations(token as string, {
        ...(state !== undefined ? { state } : {}),
        search,
        offset,
      }),
    enabled: ready && Boolean(token),
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
        <div role="alert" className="text-xs text-red-600">
          Failed to load delegations: {error.message}
        </div>
      )}
      {revoke.error && (
        <div role="alert" className="text-xs text-red-600">
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
                    {new Date(row.grantedAt).toLocaleString()}
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
  token: string,
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
function SkillRegistryConsole(): React.JSX.Element {
  const { token, ready } = useAuth();
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
      fetchOrgSkills(token as string, {
        tenantId,
        ...(status !== undefined ? { status } : {}),
        offset,
      }),
    enabled: ready && Boolean(token) && tenantId.trim() !== "",
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
        <div role="alert" className="text-xs text-red-600">
          Failed to load the catalog: {error.message}
        </div>
      )}
      {deprecate.error && (
        <div role="alert" className="text-xs text-red-600">
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

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function AssistantsEstatePanel(): React.JSX.Element {
  const { token, ready } = useAuth();
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
      fetchAssistants(token as string, {
        ...(status !== undefined ? { status } : {}),
        search,
        offset,
      }),
    enabled: ready && Boolean(token),
  });

  const rows = page?.assistants ?? [];
  const total = page?.total ?? 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Panel heading="Assistants">
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
            placeholder="Filter by user id…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
            aria-label="Filter assistants by user id"
          />
        </div>

        {isLoading && (
          <div className="text-xs text-muted-foreground" aria-busy="true">
            Loading assistants…
          </div>
        )}
        {error && (
          <div role="alert" className="text-xs text-red-600">
            Failed to load assistants: {error.message}
          </div>
        )}
        {!isLoading && !error && rows.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
            No assistants. They are provisioned on a user&apos;s first turn against the{" "}
            <code className="font-mono">assistant</code> flow — set{" "}
            <code className="font-mono">ASSISTANTS_ENABLED=true</code> if that has not
            happened yet.
          </div>
        )}

        {rows.length > 0 && (
          <>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>User</TableHeaderCell>
                  <TableHeaderCell>Assistant</TableHeaderCell>
                  <TableHeaderCell>Autonomy</TableHeaderCell>
                  <TableHeaderCell>Skills</TableHeaderCell>
                  <TableHeaderCell>Pending</TableHeaderCell>
                  <TableHeaderCell>Last active</TableHeaderCell>
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
                        : new Date(row.lastActiveAt).toLocaleString()}
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
      </Panel>

      <Panel
        heading={
          selected === null
            ? "Select an assistant"
            : `${selected.userId} / ${selected.assistantId}`
        }
      >
        {selected === null || token === undefined ? (
          <p className="text-xs text-muted-foreground">
            Pick a row to see its soul, learned procedures, proposal queue and
            delegated credentials — and to set the operator constraints that override
            both the assistant and its user.
          </p>
        ) : (
          <AssistantDetailView row={selected} token={token} />
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level export — Estate + Revocation Console tabs
// ---------------------------------------------------------------------------

/**
 * The operator's per-user assistant estate view, plus the Identity Broker's
 * cross-scope Revocation Console. Two tabs rather than one merged view: the
 * estate tab answers "what does THIS assistant hold" one row at a time, the
 * console tab answers "who holds delegated authority at all" across every
 * tenant/user/assistant — different questions with different filters, and
 * conflating them would make neither filter set make sense.
 */
export function AssistantsPanel(): React.JSX.Element {
  const [tab, setTab] = useState<"estate" | "revocation" | "skill-registry">("estate");
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as "estate" | "revocation" | "skill-registry")}
    >
      <TabsList className="mb-4">
        <TabsTrigger value="estate">Estate</TabsTrigger>
        <TabsTrigger value="revocation">Revocation Console</TabsTrigger>
        <TabsTrigger value="skill-registry">Skill Registry</TabsTrigger>
      </TabsList>
      <TabsContent value="estate">
        <AssistantsEstatePanel />
      </TabsContent>
      <TabsContent value="revocation">
        <RevocationConsole />
      </TabsContent>
      <TabsContent value="skill-registry">
        <SkillRegistryConsole />
      </TabsContent>
    </Tabs>
  );
}
