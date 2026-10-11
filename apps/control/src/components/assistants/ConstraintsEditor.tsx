"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from AssistantsPanel.tsx: the constraint editor, the
 * only write class of the operator surface (revision hash against silent
 * overwrites). Without behavior change.
 */

import { useState } from "react";
import type React from "react";
import { useMutation } from "@tanstack/react-query";
import { backendUrl } from "../../lib/backend-url";
import { authFetch } from "../../lib/auth-fetch";
import { Button } from "../../lib/ui";
import { detailPath, readJson, type AssistantDetail } from "./assistantShared";

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

export function ConstraintsEditor({
  detail,
  token,
  onSaved,
}: {
  detail: AssistantDetail;
  token: string | undefined;
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
        <div role="alert" className="text-xs text-danger">
          {save.error.message}
        </div>
      )}
    </div>
  );
}
