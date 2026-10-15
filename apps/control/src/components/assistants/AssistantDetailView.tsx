"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from AssistantsPanel.tsx: detail view of an
 * assistant (autonomy, status, constraints, skills, proposal queue,
 * delegations). Without behavior change.
 */

import type React from "react";
import { useCanWrite } from "../../lib/auth/useCanWrite";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backendUrl } from "../../lib/backend-url";
import { authFetch } from "../../lib/auth-fetch";
import { Badge, Button, useConfirm } from "../../lib/ui";
import {
  detailPath,
  readJson,
  type AssistantDetail,
  type AssistantRow,
  type AssistantStatus,
  type Autonomy,
  type ProposalRow,
} from "./assistantShared";
import { ConstraintsEditor } from "./ConstraintsEditor";
import { translate } from "../../lib/i18n";

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
        <span className="text-xs text-muted-foreground">{translate("assistantDetailView.empty")}</span>
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

export function AssistantDetailView({
  row,
  token,
}: {
  row: AssistantRow;
  token: string | undefined;
}): React.JSX.Element {
  const writeGate = useCanWrite("operator");
  const queryClient = useQueryClient();
  const { confirm: confirmDialog } = useConfirm();
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
    return <div className="text-xs text-muted-foreground">{translate("assistantDetailView.loadingAssistant")}</div>;
  }
  if (error) {
    return (
      <div role="alert" className="text-xs text-danger">
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
        <span className="text-xs text-muted-foreground">{translate("assistantDetailView.autonomy")}</span>
        {(["supervised", "assisted", "autonomous"] as const).map((level) => (
          <Button
            key={level}
            size="sm"
            variant={detail.autonomy === level ? "primary" : "outline"}
            disabled={setAutonomy.isPending || !writeGate.allowed}
            title={writeGate.title}
            onClick={() => setAutonomy.mutate(level)}
          >
            {level}
          </Button>
        ))}
        {detail.status === "active" ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={setStatus.isPending || !writeGate.allowed}
            title={writeGate.title}
            onClick={() => setStatus.mutate("suspended")}
          >
            {translate("assistantDetailView.suspend")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={setStatus.isPending || !writeGate.allowed || detail.status === "archived"}
            title={writeGate.title}
            onClick={() => setStatus.mutate("active")}
          >
            {translate("assistantDetailView.reactivate")}
          </Button>
        )}
      </div>
      {(setAutonomy.error ?? setStatus.error) && (
        <div role="alert" className="text-xs text-danger">
          {(setAutonomy.error ?? setStatus.error)?.message}
        </div>
      )}

      <ConstraintsEditor
        detail={detail}
        token={token}
        onSaved={() => void queryClient.invalidateQueries({ queryKey: detailKey })}
      />

      <ReadOnlySection
        title={translate("assistantDetailView.directivesTheUserS")}
        note="Read-only here. These are the user's own instructions to their assistant."
        values={detail.soul.directives}
      />
      <ReadOnlySection
        title={translate("assistantDetailView.identityTheAssistantS")}
        note="Read-only here. The assistant maintains this itself."
        values={detail.soul.identity}
      />

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">
          {translate("assistantDetailView.learnedProceduresLength", { length: detail.skills.length })}
        </span>
        {detail.skills.length === 0 ? (
          <span className="text-xs text-muted-foreground">{translate("assistantDetailView.none")}</span>
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
          {translate("assistantDetailView.proposalQueueLengthPendingLength2", { length: pending.length, length2: quarantined.length })}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {translate("assistantDetailView.anOperatorCanRejectNot")}
        </span>
        {pending.length + quarantined.length === 0 ? (
          <span className="text-xs text-muted-foreground">{translate("assistantDetailView.nothingAwaitingReview")}</span>
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
                    <Badge variant="warning">{translate("assistantDetailView.capturedAutonomously")}</Badge>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    className="ml-auto"
                    disabled={rejectProposal.isPending || !writeGate.allowed}
                    title={writeGate.title}
                    onClick={() => rejectProposal.mutate(proposal.id)}
                  >
                    {translate("assistantDetailView.reject")}
                  </Button>
                </div>
                {proposal.triggerLine && (
                  <p className="mt-1 text-muted-foreground">{proposal.triggerLine}</p>
                )}
                {proposal.scanFindings !== undefined &&
                  proposal.scanFindings.length > 0 && (
                    <ul className="mt-1 list-inside list-disc text-danger">
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
          {translate("assistantDetailView.delegatedCredentialsLength", { length: detail.delegations.length })}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {translate("assistantDetailView.summariesOnlyNoPlaneReturns")}
        </span>
        {detail.delegations.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {translate("assistantDetailView.noneBackgroundTurnsRunWithout")}
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
                    disabled={revokeDelegation.isPending || !writeGate.allowed}
                    title={writeGate.title}
                    onClick={async () => {
                      const ok = await confirmDialog({
                        title: translate("assistantDetailView.revokeDelegation"),
                        message: translate("assistantDetailView.theAssistantLosesItsIssuer", { issuer: grant.issuer }),
                        confirmLabel: translate("assistantDetailView.revoke"),
                        destructive: true,
                      });
                      if (ok) revokeDelegation.mutate(grant.issuer);
                    }}
                    aria-label={translate("assistantDetailView.revokeDelegationForIssuerIssuer", { issuer: grant.issuer })}
                  >
                    {translate("assistantDetailView.revoke")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {revokeDelegation.error && (
          <div role="alert" className="text-xs text-danger">
            {revokeDelegation.error.message}
          </div>
        )}
      </div>
    </div>
  );
}
