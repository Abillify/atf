// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
"use client";

/**
 * Save/publish actions of the StudioBuilder (Req 9.3, Task 13.4).
 *
 * Split out of `components/StudioBuilder.tsx`; the code is taken over
 * unchanged, only state and setters are passed through as parameters.
 */

import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  FlowDefinition,
  FlowDraftInfo,
  FlowListEntry,
  FlowValidationReport,
} from "../types/flow";
import {
  DEFAULT_DRAFT_ID,
  publishOnBackend,
  saveDraftToBackend,
  snapshotOf,
  writeFlowToBackend,
  type LoadedKind,
} from "../lib/studio-flow-api";
import type { StudioStatusKind } from "./useStudioStatus";
import { useConfirm } from "../lib/ui";

export function useStudioSave({
  currentDefinition,
  token,
  baseHash,
  fileFormat,
  onSaved,
  setIsSaving,
  setStatus,
  setStatusKind,
  setBaseHash,
  setBaseline,
  setValidation,
  setProblemsOpen,
  activeDraftId,
  drafts,
  setDrafts,
  setLoadedKind,
  setViewingLive,
  setLiveDefinition,
  setLiveKind,
  flow,
  loadFlow,
  dirty,
  loadedKind,
}: {
  currentDefinition: () => FlowDefinition;
  token: string | undefined;
  baseHash: string | undefined;
  fileFormat: "yaml" | "json";
  onSaved?: (id: string) => void;
  setIsSaving: Dispatch<SetStateAction<boolean>>;
  setStatus: (msg: string) => void;
  setStatusKind: (kind: StudioStatusKind) => void;
  setBaseHash: Dispatch<SetStateAction<string | undefined>>;
  setBaseline: Dispatch<SetStateAction<string | null>>;
  setValidation: Dispatch<SetStateAction<FlowValidationReport | null>>;
  setProblemsOpen: Dispatch<SetStateAction<boolean>>;
  activeDraftId: string;
  drafts: FlowDraftInfo[];
  setDrafts: Dispatch<SetStateAction<FlowDraftInfo[]>>;
  setLoadedKind: Dispatch<SetStateAction<LoadedKind>>;
  setViewingLive: Dispatch<SetStateAction<boolean>>;
  setLiveDefinition: Dispatch<SetStateAction<FlowDefinition | null>>;
  setLiveKind: Dispatch<SetStateAction<LoadedKind | null>>;
  flow: FlowListEntry | null;
  loadFlow: (flowToLoad: FlowListEntry | null) => void;
  dirty: boolean;
  loadedKind: LoadedKind;
}): {
  handleSave: () => Promise<void>;
  handleForceOverwrite: () => Promise<void>;
  handleSaveDraft: () => Promise<boolean>;
  handlePublish: () => Promise<void>;
  handleDiscard: () => void;
} {
  // Req 9.5: confirmations through the dialog primitive instead of window.confirm.
  const { confirm: confirmDialog } = useConfirm();

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleSave = useCallback(async (): Promise<void> => {
    const def = currentDefinition();
    if (
      !(await confirmDialog({
        title: "Write to flow file",
        message:
          `Write "${def.id}" directly to its flow file?\n\n` +
          "The runtime hot-reloads flow files, so this goes LIVE immediately — " +
          'there is no draft or review step. Use "Save draft" to stage changes instead.',
        confirmLabel: "Write to file",
        destructive: true,
      }))
    ) {
      return;
    }
    setIsSaving(true);
    setStatus("Writing file…");
    setStatusKind("info");

    const result = await writeFlowToBackend(
      token ?? null,
      def,
      baseHash,
      fileFormat,
    );

    if (result.ok) {
      setBaseHash(result.hash);
      setBaseline(snapshotOf(def));
      setStatus("Written to file — live now.");
      setStatusKind("ok");
      onSaved?.(def.id);
    } else if (result.conflict) {
      setStatus(
        `⚠ Conflict: the flow file was changed externally. Review your changes and save again to overwrite, or reload to get the latest version.`,
      );
      setStatusKind("warn");
    } else if (result.reason) {
      setStatus(`✗ Blocked: ${result.reason}`);
      setStatusKind("error");
    } else {
      setStatus(`✗ Save failed: ${result.error}`);
      setStatusKind("error");
    }
    setIsSaving(false);
  }, [currentDefinition, token, baseHash, fileFormat, onSaved, confirmDialog]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleForceOverwrite = useCallback(async (): Promise<void> => {
    setIsSaving(true);
    setStatus("Overwriting…");
    setStatusKind("info");
    const def = currentDefinition();
    const result = await writeFlowToBackend(
      token ?? null,
      def,
      undefined,
      fileFormat,
    );
    if (result.ok) {
      setBaseHash(result.hash);
      setBaseline(snapshotOf(def));
      setStatus("Overwrite successful.");
      setStatusKind("ok");
      onSaved?.(def.id);
    } else {
      setStatus(`✗ Overwrite failed: ${result.error}`);
      setStatusKind("error");
    }
    setIsSaving(false);
  }, [currentDefinition, token, fileFormat, onSaved]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleSaveDraft = useCallback(async (): Promise<boolean> => {
    const def = currentDefinition();
    setIsSaving(true);
    setStatus("Saving draft…");
    setStatusKind("info");
    const label =
      activeDraftId === DEFAULT_DRAFT_ID
        ? undefined
        : (drafts.find((d) => d.draftId === activeDraftId)?.label ??
          activeDraftId);
    const result = await saveDraftToBackend(
      token ?? null,
      def,
      activeDraftId,
      label,
    );
    setIsSaving(false);
    if (!result.ok) {
      if (result.validation) setValidation(result.validation);
      setStatus(`✗ Draft not saved: ${result.error}`);
      setStatusKind("error");
      return false;
    }
    if (result.validation) setValidation(result.validation);
    setBaseline(snapshotOf(def));
    setLoadedKind({
      kind: "draft",
      version: result.version ?? 0,
      draftId: activeDraftId,
    });
    // Saving from the live view stages the content into the active draft.
    setViewingLive(false);
    // Keep the in-memory draft list in sync so switching doesn't lose this edit.
    setDrafts((prev) => {
      const info: FlowDraftInfo = {
        draftId: activeDraftId,
        label: label ?? activeDraftId,
        definition: def,
      };
      const i = prev.findIndex((d) => d.draftId === activeDraftId);
      if (i === -1) {
        const next = [...prev, info];
        return activeDraftId === DEFAULT_DRAFT_ID
          ? next
          : [
              ...next.filter((d) => d.draftId === DEFAULT_DRAFT_ID),
              ...next.filter((d) => d.draftId !== DEFAULT_DRAFT_ID),
            ];
      }
      const next = [...prev];
      next[i] = info;
      return next;
    });
    const issues = result.validation && !result.validation.valid;
    setStatus(
      issues
        ? "Draft saved (has validation errors — fix them before publishing). The live flow is unchanged."
        : "Draft saved. The live flow is unchanged until you publish.",
    );
    setStatusKind(issues ? "warn" : "ok");
    onSaved?.(def.id);
    return true;
  }, [currentDefinition, token, onSaved, activeDraftId, drafts]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handlePublish = useCallback(async (): Promise<void> => {
    const def = currentDefinition();
    const shadows = flow?.source === "file" || flow?.shadowsFile;
    if (
      !(await confirmDialog({
        title: "Publish flow",
        message:
          `Publish "${def.id}"${activeDraftId === DEFAULT_DRAFT_ID ? "" : ` (draft '${activeDraftId}')`}? It becomes the live version for new requests.` +
          (shadows
            ? "\n\nThis flow also exists as a file — the published online version will take precedence over the file."
            : ""),
        confirmLabel: "Publish",
      }))
    ) {
      return;
    }
    // Publish acts on the stored draft, so store the current canvas first.
    const onActiveDraft =
      loadedKind.kind === "draft" && loadedKind.draftId === activeDraftId;
    if (dirty || !onActiveDraft) {
      const saved = await handleSaveDraft();
      if (!saved) return;
    }
    setIsSaving(true);
    setStatus("Publishing…");
    setStatusKind("info");
    const result = await publishOnBackend(token ?? null, def.id, activeDraftId);
    setIsSaving(false);
    if (!result.ok) {
      if (result.validation) setValidation(result.validation);
      setStatus(`✗ Publish blocked: ${result.error}`);
      setStatusKind("error");
      if (result.validation && !result.validation.valid) setProblemsOpen(true);
      return;
    }
    setLoadedKind({ kind: "published", version: result.version ?? 0 });
    // The published revision is now the live one; keep the draft view in sync.
    setLiveDefinition(def);
    setLiveKind({ kind: "published", version: result.version ?? 0 });
    setStatus(
      `Published${result.version !== undefined ? ` v${result.version}` : ""} — live now.`,
    );
    setStatusKind("ok");
    onSaved?.(def.id);
  }, [
    currentDefinition,
    flow?.source,
    flow?.shadowsFile,
    dirty,
    loadedKind,
    handleSaveDraft,
    token,
    onSaved,
    activeDraftId,
    confirmDialog,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleDiscard = useCallback(async (): Promise<void> => {
    if (
      !(await confirmDialog({
        title: "Discard changes",
        message: "Discard all unsaved changes on the canvas?",
        confirmLabel: "Discard",
        destructive: true,
      }))
    ) {
      return;
    }
    loadFlow(flow);
    setStatus("Changes discarded.");
    setStatusKind("info");
  }, [loadFlow, flow, confirmDialog]);

  return {
    handleSave,
    handleForceOverwrite,
    handleSaveDraft,
    handlePublish,
    handleDiscard,
  };
}
