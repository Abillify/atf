"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from AssistantsPanel.tsx: the constraint editor, the
 * only write class of the operator surface (revision hash against silent
 * overwrites). Without behavior change.
 */

import { useState } from "react";
import { useCanWrite } from "../../lib/auth/useCanWrite";
import type React from "react";
import { useMutation } from "@tanstack/react-query";
import { backendUrl } from "../../lib/backend-url";
import { authFetch } from "../../lib/auth-fetch";
import { Button } from "../../lib/ui";
import { detailPath, readJson, type AssistantDetail } from "./assistantShared";
import { translate, type MessageKey } from "../../lib/i18n";

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
    label: "constraintsEditor.field.rules",
    hint: "constraintsEditor.field.rulesHint",
  },
  {
    key: "compliance",
    label: "constraintsEditor.field.compliance",
    hint: "constraintsEditor.field.complianceHint",
  },
] as const satisfies ReadonlyArray<{ key: string; label: MessageKey; hint: MessageKey }>;

export function ConstraintsEditor({
  detail,
  token,
  onSaved,
}: {
  detail: AssistantDetail;
  token: string | undefined;
  onSaved: () => void;
}): React.JSX.Element {
  const writeGate = useCanWrite("operator");
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
        {translate("constraintsEditor.operatorConstraintsTheyRenderLast")}
      </p>
      {CONSTRAINT_FIELDS.map((field) => (
        <label key={field.key} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">{translate(field.label)}</span>
          <span className="text-[11px] text-muted-foreground">{translate(field.hint)}</span>
          <textarea
            className="min-h-[64px] rounded-md border border-border bg-background p-2 text-xs text-foreground"
            value={draft[field.key] ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
            aria-label={translate("constraintsEditor.fieldConstraint", { label: translate(field.label) })}
          />
        </label>
      ))}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">{translate("constraintsEditor.deniedTools")}</span>
        <span className="text-[11px] text-muted-foreground">
          {translate("constraintsEditor.oneToolIdPerLine")}
        </span>
        <textarea
          className="min-h-[48px] rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground"
          value={deniedTools}
          onChange={(event) => setDeniedTools(event.target.value)}
          aria-label={translate("constraintsEditor.deniedToolIdsOnePer")}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">
          {translate("constraintsEditor.reasonRecordedInTheSoul")}
        </span>
        <input
          className="rounded-md border border-border bg-background p-2 text-xs text-foreground"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-label={translate("constraintsEditor.reasonForTheConstraintChange")}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || !writeGate.allowed || save.isPending}
          title={writeGate.title}
          onClick={() => save.mutate()}
        >
          {save.isPending ? translate("constraintsEditor.saving") : translate("constraintsEditor.saveConstraints")}
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
