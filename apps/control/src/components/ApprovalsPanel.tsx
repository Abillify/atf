"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useState } from "react";
import { Inbox } from "lucide-react";
import type { PendingApproval } from "../types/control";
import { Badge, Button, EmptyState } from "../lib/ui";
import { RequireRole } from "../lib/auth";
import { translate } from "../lib/i18n";

export interface ApprovalsPanelProps {
  pending: PendingApproval[];
  isLoading?: boolean;
  error?: string | null;
  // The panel awaits the call but never inspects the result, so the return
  // type stays `void`: both `() => Promise<boolean>` (the hook) and plain
  // void callbacks (tests) are assignable.
  onResolve: (
    id: string,
    approved: boolean,
    opts?: { reason?: string; by?: string },
  ) => void;
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

function ApprovalCard({
  item,
  onResolve,
}: {
  item: PendingApproval;
  onResolve: ApprovalsPanelProps["onResolve"];
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const act = async (approved: boolean): Promise<void> => {
    setBusy(true);
    try {
      await onResolve(item.id, approved, { by: "dashboard" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-warning-border bg-warning-soft p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge variant="warning">{translate("approvalsPanel.awaitingApproval")}</Badge>
            <span className="font-mono text-sm font-semibold text-foreground">
              {item.tool}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            node <span className="font-mono">{item.nodeId}</span>
            {item.tenantId ? (
              <>
                {translate("approvalsPanel.tenant")}
                <span className="font-mono">{item.tenantId}</span>
              </>
            ) : null}
            {" · "}
            {age(item.requestedAt)}
          </div>
        </div>
        {/* Deciding needs `approvals:write`, which starts at operator. */}
        <RequireRole
          minRole="operator"
          fallback={
            <span className="shrink-0 text-xs text-muted-foreground">
              {translate("approvalsPanel.anOperatorDecidesThisRequest")}
            </span>
          }
        >
          <div className="flex shrink-0 gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void act(true)}
            >
              {translate("approvalsPanel.approve")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void act(false)}
            >
              {translate("approvalsPanel.deny")}
            </Button>
          </div>
        </RequireRole>
      </div>
      {Object.keys(item.args).length > 0 && (
        <pre className="mt-3 max-h-40 overflow-auto rounded bg-card/70 p-2 text-xs text-foreground">
          {JSON.stringify(item.args, null, 2)}
        </pre>
      )}
    </div>
  );
}

/**
 * Reviewer inbox for human-in-the-loop tool approvals. A consequential tool call
 * pauses until approved here; on timeout the backend auto-denies (fail-closed).
 */
export function ApprovalsPanel({
  pending,
  isLoading,
  error,
  onResolve,
}: ApprovalsPanelProps): React.JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {translate("approvalsPanel.pendingApprovals")}{" "}
          <span className="font-normal text-muted-foreground">
            ({pending.length})
          </span>
        </h3>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      {isLoading && pending.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {translate("approvalsPanel.loading")}
        </p>
      ) : pending.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={translate("approvalsPanel.noToolCallsAreAwaiting")}
          description={translate("approvalsPanel.flaggedConsequentialToolsWillAppear")}
        />
      ) : (
        <div className="space-y-3">
          {pending.map((p) => (
            <ApprovalCard key={p.id} item={p} onResolve={onResolve} />
          ))}
        </div>
      )}
    </section>
  );
}
