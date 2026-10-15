// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ReceiptsPanel — Decision_Receipt display + export in the trace viewer
 * (Req 15.7).
 *
 * Shows every verifiable receipt issued for one execution: the signed payload
 * summary (flow, model, PII proof, retrieval revisions, approvals, cost), an
 * offline signature check against the tenant JWKS, and — on demand — the
 * Merkle inclusion proof from the transparency log. Receipts can be exported
 * individually or as a bundle (JSON with COSE bytes + proof).
 *
 * All verification runs in the browser via `lib/receipt-verify` (WebCrypto);
 * the panel never trusts the echoed payload JSON — the signature is checked
 * over the COSE bytes.
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button } from "../lib/ui";
import type { BadgeVariant } from "../lib/ui";
import { formatCost } from "../lib/currency";
import { translate, formatTime } from "../lib/i18n";
import {
  downloadAllReceipts,
  downloadReceipt,
  fetchExecutionReceipts,
  fetchReceiptJwks,
  fetchReceiptProof,
  verifyReceiptInclusion,
  verifyReceiptSignature,
  type InclusionCheck,
  type ReceiptListItem,
  type ReceiptProofResponse,
  type ReceiptSignatureCheck,
} from "../lib/receipt-verify";

// ---------------------------------------------------------------------------
// Payload view helpers (the payload is a plain JSON echo — display only)
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface ReceiptSummary {
  receiptId: string;
  kind: string;
  status?: string;
  flowId?: string;
  flowVersion?: string;
  modelList: string;
  piiLabel?: string;
  retrievalCount: number;
  approvalCount: number;
  toolCallCount: number;
  costUsd?: number;
  startedAt?: string;
  finishedAt?: string;
  responseHash?: string;
}

/** Extract the display fields from a receipt payload (defensively typed). */
export function summarizeReceipt(r: ReceiptListItem): ReceiptSummary {
  const p = r.payload;
  const models = Array.isArray(p["models"]) ? p["models"] : [];
  const modelList = models
    .map((m) => (m && typeof m === "object" ? str((m as Record<string, unknown>)["model"]) : undefined))
    .filter((s): s is string => s !== undefined)
    .join(", ");
  const pii = p["pii"];
  const piiLabel =
    pii && typeof pii === "object"
      ? (str((pii as Record<string, unknown>)["method"]) ?? "tokenisiert")
      : undefined;
  return {
    receiptId: r.receipt_id,
    kind: r.kind,
    status: str(p["status"]),
    flowId: str(p["flow_id"]),
    flowVersion: str(p["flow_version"]),
    modelList,
    piiLabel,
    retrievalCount: Array.isArray(p["retrieval_sources"]) ? p["retrieval_sources"].length : 0,
    approvalCount: Array.isArray(p["approvals"]) ? p["approvals"].length : 0,
    toolCallCount: Array.isArray(p["tool_calls"]) ? p["tool_calls"].length : 0,
    costUsd:
      p["cost"] && typeof p["cost"] === "object"
        ? num((p["cost"] as Record<string, unknown>)["usd"])
        : undefined,
    startedAt: str(p["started_at"]),
    finishedAt: str(p["finished_at"]),
    responseHash: str(p["response_hash"]),
  };
}

// ---------------------------------------------------------------------------
// Verification state
// ---------------------------------------------------------------------------

interface VerifyState {
  signature: ReceiptSignatureCheck | undefined;
  inclusion: InclusionCheck | undefined;
  proof: ReceiptProofResponse | undefined;
  loading: boolean;
  error: string | undefined;
}

const IDLE_VERIFY: VerifyState = {
  signature: undefined,
  inclusion: undefined,
  proof: undefined,
  loading: false,
  error: undefined,
};

// ---------------------------------------------------------------------------
// Badge for the combined verification outcome
// ---------------------------------------------------------------------------

function VerifyBadge({ state }: { state: VerifyState }) {
  if (state.loading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-[11px] font-semibold text-accent animate-pulse">
        {translate("receiptsPanel.verifying")}
      </span>
    );
  }
  if (state.error !== undefined) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger"
        title={state.error}
      >
        ✕ {state.error}
      </span>
    );
  }
  if (state.signature === undefined) return null;
  if (!state.signature.signatureValid) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger"
        title={state.signature.error ?? translate("receiptsPanel.signatureInvalid2")}
      >
        {translate("receiptsPanel.signatureInvalid")}
      </span>
    );
  }
  if (state.inclusion === undefined) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success">
        {translate("receiptsPanel.signatureValid")}
      </span>
    );
  }
  if (state.inclusion.inclusionValid && state.inclusion.headSignatureValid) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success">
        {translate("receiptsPanel.signatureInclusionValid")}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning"
      title={state.inclusion.error ?? translate("receiptsPanel.inclusionInvalid")}
    >
      {translate("receiptsPanel.inclusionUnverified")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One receipt row
// ---------------------------------------------------------------------------

interface ReceiptRowProps {
  receipt: ReceiptListItem;
  token: string | undefined;
  jwksReady: boolean;
}

function ReceiptRow({ receipt, token, jwksReady }: ReceiptRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [verify, setVerify] = useState<VerifyState>(IDLE_VERIFY);
  const summary = useMemo(() => summarizeReceipt(receipt), [receipt]);

  const verifyNow = useCallback(async () => {
    setVerify({ ...IDLE_VERIFY, loading: true });
    try {
      const keys = await fetchReceiptJwks();
      const signature = await verifyReceiptSignature(receipt.cose_base64, keys);
      let inclusion: InclusionCheck | undefined;
      let proof: ReceiptProofResponse | undefined;
      try {
        proof = await fetchReceiptProof(receipt.receipt_id, token);
        inclusion = await verifyReceiptInclusion(receipt.cose_base64, proof, keys);
      } catch {
        // No proof available (log disabled / not yet sealed) — the signature
        // result still stands on its own.
      }
      setVerify({ signature, inclusion, proof, loading: false, error: undefined });
    } catch (err) {
      setVerify({
        ...IDLE_VERIFY,
        error: err instanceof Error ? err.message : "verification failed",
      });
    }
  }, [receipt.cose_base64, receipt.receipt_id, token]);

  const kindVariant: BadgeVariant =
    receipt.kind === "chat_completion" ? "secondary" : "outline";

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <Badge variant={kindVariant}>{receipt.kind}</Badge>
          <span className="font-mono text-xs text-foreground" title={summary.receiptId}>
            {summary.receiptId}
          </span>
          {summary.flowId && (
            <span className="text-xs text-muted-foreground">
              {summary.flowId}
              {summary.flowVersion ? `@${summary.flowVersion}` : ""}
            </span>
          )}
        </button>
        <VerifyBadge state={verify} />
        <Button
          variant="outline"
          size="sm"
          onClick={verifyNow}
          disabled={!jwksReady || verify.loading}
          title={translate("receiptsPanel.verifySignatureAndMerkleInclusion")}
        >
          {translate("receiptsPanel.verify")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadReceipt(receipt, verify.proof)}
          title={translate("receiptsPanel.downloadThisReceiptJSONWith")}
        >
          {translate("receiptsPanel.export")}
        </Button>
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-border px-3 py-2 text-xs">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-3">
            <Field label="status" value={summary.status} />
            <Field label="model" value={summary.modelList} />
            <Field label="PII" value={summary.piiLabel} />
            <Field label="retrieval" value={String(summary.retrievalCount)} />
            <Field label="approvals" value={String(summary.approvalCount)} />
            <Field label={translate("receiptsPanel.toolCalls")} value={String(summary.toolCallCount)} />
            <Field
              label="cost"
              value={summary.costUsd !== undefined ? formatCost(summary.costUsd) : undefined}
            />
            <Field
              label="started"
              value={summary.startedAt ? formatTime(summary.startedAt) : undefined}
            />
            <Field
              label="finished"
              value={summary.finishedAt ? formatTime(summary.finishedAt) : undefined}
            />
          </div>
          {summary.responseHash && (
            <div className="font-mono text-[11px] text-muted-foreground">
              response_hash {summary.responseHash}
            </div>
          )}
          {verify.inclusion !== undefined && (
            <div className="rounded bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
              <div>
                {translate("receiptsPanel.leafLeafIndexTreeTreeSizeHead", { leafIndex: verify.inclusion.leafIndex, treeSize: verify.inclusion.treeSize })}{" "}
                {verify.inclusion.headSignatureValid ? translate("receiptsPanel.signed") : translate("receiptsPanel.signed2")}
              </div>
              {verify.inclusion.rootHash && <div>root {verify.inclusion.rootHash}</div>}
              {verify.inclusion.headTimestamp && (
                <div>sealed {formatTime(verify.inclusion.headTimestamp)}</div>
              )}
            </div>
          )}
          {verify.signature?.kid && (
            <div className="font-mono text-[11px] text-muted-foreground">
              kid {verify.signature.kid}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | undefined }) {
  if (value === undefined) return null;
  return (
    <div className="truncate" title={`${label}: ${value}`}>
      <span className="font-medium">{label}</span> {value}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface ReceiptsPanelProps {
  executionId: string;
  token: string | undefined;
  enabled: boolean;
}

/**
 * Receipt tab body: lists all receipts for the execution, verifies them
 * client-side on demand, and exports them. Hidden content when the feature is
 * off (the runtime returns 404/empty) so operators without receipts see a
 * neutral empty state.
 */
export function ReceiptsPanel({ executionId, token, enabled }: ReceiptsPanelProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["execution-receipts", executionId],
    queryFn: () => fetchExecutionReceipts(executionId, token),
    enabled: enabled && executionId !== "",
    retry: false,
  });

  const receipts = data?.receipts ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        {translate("receiptsPanel.loadingReceipts")}
      </div>
    );
  }

  if (error !== null && error !== undefined) {
    return (
      <div className="rounded-lg border border-border bg-card py-10 text-center text-sm text-muted-foreground">
        {translate("receiptsPanel.receiptsAreNotAvailableFor")}
        <span className="ml-1 text-xs">({error.message})</span>.
      </div>
    );
  }

  if (receipts.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card py-10 text-center text-sm text-muted-foreground">
        {translate("receiptsPanel.noDecisionReceiptsForThis")}
        <div className="mt-2 text-xs">
          {translate("receiptsPanel.receiptsAreIssuedWhenDECISION")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {receipts.length} receipt{receipts.length !== 1 ? "s" : ""} ·{" "}
          <code className="font-mono">{executionId}</code>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => downloadAllReceipts(executionId, receipts)}
        >
          {translate("receiptsPanel.exportAll")}
        </Button>
      </div>
      <div className="space-y-2">
        {receipts.map((r) => (
          <ReceiptRow
            key={r.receipt_id}
            receipt={r}
            token={token}
            jwksReady={enabled}
          />
        ))}
      </div>
    </div>
  );
}
