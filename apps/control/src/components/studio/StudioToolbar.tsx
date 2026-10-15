"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * StudioToolbar: the toolbar above the Studio canvas.
 * Req 9.3 (Task 13.4): moved unchanged out of StudioBuilder; the state
 * stays in the parent and comes in through props.
 */

import type React from "react";
import { Button } from "../../lib/ui";
import { FlowVersionBar } from "../FlowVersionBar";
import { DEFAULT_DRAFT_ID, type LoadedKind } from "../../lib/studio-flow-api";
import type { RFEdge, RFNode } from "../../lib/flow-graph";
import type { FlowDefinition, FlowDraftInfo } from "../../types/flow";
import type { DiffOverlay } from "../../lib/flow-diff-view";
import { Play, Redo2, Settings, Sparkles, Undo2 } from "lucide-react";
import { translate } from "../../lib/i18n";

export interface StudioToolbarProps {
  baseId: string;
  /** Where the selected flow comes from (online flows get the draft switch). */
  flowSource: "file" | "online" | undefined;
  hasDraft: boolean;
  onlineEditing: boolean;
  showFileWrite: boolean;
  dirty: boolean;
  isSaving: boolean;
  viewingLive: boolean;
  activeDraftId: string;
  drafts: FlowDraftInfo[];
  liveDefinition: FlowDefinition | null;
  liveKind: LoadedKind | null;
  loadedKind: LoadedKind;
  onToggleViewLive: () => void;
  onSelectDraft: (draftId: string) => void;
  onCreateDraft: () => void;
  onDeleteDraft: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onTogglePanel?: (panel: "copilot" | "runTrace") => void;
  copilotHidden: boolean;
  runTraceHidden: boolean;
  inspectorCollapsed: boolean;
  hasInspectorSelection: boolean;
  flowSettingsOpen: boolean;
  onToggleFlowSettings: () => void;
  totalErrors: number;
  totalWarnings: number;
  unknownToolsByServer: Map<string, Set<string>>;
  onToggleProblems: () => void;
  token: string | undefined;
  nodes: RFNode[];
  edges: RFEdge[];
  onDiffOverlayChange: (overlay: DiffOverlay | undefined) => void;
  onRolledBack: () => void;
  onDiscard: () => void;
  onSave: () => void;
  onSaveDraft: () => void;
  onPublish: () => void;
}

/** Which revision the canvas shows — badge text, style and tooltip. */
function revisionBadgeOf(
  viewingLive: boolean,
  liveKind: LoadedKind | null,
  loadedKind: LoadedKind,
): { text: string; cls: string; title: string } {
  if (viewingLive) {
    return liveKind?.kind === "published"
      ? {
          text: `live v${liveKind.version}`,
          cls: "bg-success-soft text-success border border-success-border",
          title:
            translate("studioToolbar.viewingTheLivePublishedRevision"),
        }
      : {
          text: "live · file",
          cls: "bg-muted text-muted-foreground",
          title:
            translate("studioToolbar.viewingTheFileRevisionThat"),
        };
  }
  switch (loadedKind.kind) {
    case "new":
      return {
        text: "new · unsaved",
        cls: "bg-muted text-muted-foreground",
        title: translate("studioToolbar.notStoredAnywhereYet"),
      };
    case "file":
      return {
        text: "file",
        cls: "bg-muted text-muted-foreground",
        title:
          translate("studioToolbar.loadedFromFLOWSDIRSave"),
      };
    case "draft":
      return {
        text:
          loadedKind.draftId === DEFAULT_DRAFT_ID
            ? "draft"
            : `draft · ${loadedKind.draftId}`,
        cls: "bg-warning-soft text-warning border border-warning-border",
        title: translate("studioToolbar.editingTheUnpublishedDraftThe"),
      };
    case "published":
      return {
        text: `published v${loadedKind.version}`,
        cls: "bg-success-soft text-success border border-success-border",
        title:
          translate("studioToolbar.editingACopyOfThe"),
      };
  }
}

export function StudioToolbar({
  baseId,
  flowSource,
  hasDraft,
  onlineEditing,
  showFileWrite,
  dirty,
  isSaving,
  viewingLive,
  activeDraftId,
  drafts,
  liveDefinition,
  liveKind,
  loadedKind,
  onToggleViewLive,
  onSelectDraft,
  onCreateDraft,
  onDeleteDraft,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onTogglePanel,
  copilotHidden,
  runTraceHidden,
  inspectorCollapsed,
  hasInspectorSelection,
  flowSettingsOpen,
  onToggleFlowSettings,
  totalErrors,
  totalWarnings,
  unknownToolsByServer,
  onToggleProblems,
  token,
  nodes,
  edges,
  onDiffOverlayChange,
  onRolledBack,
  onDiscard,
  onSave,
  onSaveDraft,
  onPublish,
}: StudioToolbarProps): React.JSX.Element {
  const revisionBadge = revisionBadgeOf(viewingLive, liveKind, loadedKind);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
      <span className="font-mono text-sm font-semibold text-foreground">
        {baseId}
      </span>
      <span
        className={`rounded px-1.5 text-[10px] uppercase ${revisionBadge.cls}`}
        title={revisionBadge.title}
      >
        {revisionBadge.text}
      </span>

      {/* Draft ↔ Live view switch + named-draft selector (online flows). */}
      {onlineEditing && flowSource === "online" && (
        <div className="flex items-center gap-1">
          <select
            aria-label={translate("studioToolbar.activeDraft")}
            value={viewingLive ? "__live__" : activeDraftId}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__new__") {
                onCreateDraft();
              } else if (v === "__live__") {
                if (!viewingLive) onToggleViewLive();
              } else {
                onSelectDraft(v);
              }
            }}
            className="rounded border border-border bg-card px-1.5 py-1 text-xs text-foreground"
            title={translate("studioToolbar.chooseWhichDraftToEdit")}
          >
            {drafts.length === 0 && (
              <option value={DEFAULT_DRAFT_ID}>{translate("studioToolbar.draftDefault")}</option>
            )}
            {drafts.map((d) => (
              <option key={d.draftId} value={d.draftId}>
                {translate("studioToolbar.draftValue", { value: d.label || d.draftId })}
              </option>
            ))}
            {liveDefinition !== null && (
              <option value="__live__">
                {liveKind?.kind === "published"
                  ? translate("studioToolbar.liveVVersion", { version: liveKind.version })
                  : translate("studioToolbar.liveFile")}
              </option>
            )}
            <option value="__new__">{translate("studioToolbar.newDraft")}</option>
          </select>
          {liveDefinition !== null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleViewLive}
              title={
                viewingLive
                  ? translate("studioToolbar.switchBackToTheActive")
                  : translate("studioToolbar.viewTheLiveRevisionRead")
              }
            >
              {viewingLive ? translate("studioToolbar.draft") : translate("studioToolbar.viewLive")}
            </Button>
          )}
          {!viewingLive && activeDraftId !== DEFAULT_DRAFT_ID && (
            <Button
              variant="ghost"
              size="sm"
              disabled={isSaving}
              onClick={onDeleteDraft}
              title={translate("studioToolbar.deleteDraftActiveDraftIdTheLive", { activeDraftId })}
            >
              {translate("studioToolbar.deleteDraft")}
            </Button>
          )}
        </div>
      )}
      {dirty && (
        <span
          className="rounded bg-info-soft px-1.5 text-[10px] font-medium uppercase text-info border border-info-border"
          title={translate("studioToolbar.theCanvasHasChangesThat")}
        >
          {translate("studioToolbar.unsaved")}
        </span>
      )}

      {/* Undo/redo: a bordered button group with icon + label so it reads
        as controls, not as decoration. */}
      {/* biome-ignore lint/a11y/useSemanticElements: toolbar of toggle buttons, not a form control — <fieldset> would be wrong here */}
      <div
        className="flex items-center overflow-hidden rounded-md border border-border bg-card shadow-sm"
        role="group"
        aria-label={translate("studioToolbar.history")}
      >
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          title={translate("studioToolbar.undoTheLastChangeCmd")}
          aria-label={translate("studioToolbar.undo")}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        >
          <Undo2 size={14} aria-hidden />
          {translate("studioToolbar.undo")}
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          title={translate("studioToolbar.redoTheLastUndoneChange")}
          aria-label={translate("studioToolbar.redo")}
          className="flex items-center gap-1 border-l border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        >
          <Redo2 size={14} aria-hidden />
          {translate("studioToolbar.redo")}
        </button>
      </div>

      {/* Copilot / Run & Trace visibility. Both panels are hidden by default
        and switched on individually here, right next to Undo/Redo. */}
      {onTogglePanel && (
        // biome-ignore lint/a11y/useSemanticElements: toolbar of toggle buttons, not a form control — <fieldset> would be wrong here
        <div
          className="flex items-center overflow-hidden rounded-md border border-border bg-card shadow-sm"
          role="group"
          aria-label={translate("studioToolbar.panels")}
        >
          <button
            type="button"
            onClick={() => onTogglePanel("copilot")}
            aria-pressed={!copilotHidden}
            title={
              copilotHidden ? translate("studioToolbar.showTheCopilotPanel") : translate("studioToolbar.hideTheCopilotPanel")
            }
            className={`flex items-center gap-1 px-2 py-1 text-xs font-medium transition-colors ${
              copilotHidden
                ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                : "bg-muted text-foreground"
            }`}
          >
            <Sparkles size={14} aria-hidden />
            {translate("studioToolbar.copilot")}
          </button>
          <button
            type="button"
            onClick={() => onTogglePanel("runTrace")}
            aria-pressed={!runTraceHidden}
            title={
              runTraceHidden
                ? translate("studioToolbar.showTheRunTracePanel")
                : translate("studioToolbar.hideTheRunTracePanel")
            }
            className={`flex items-center gap-1 border-l border-border px-2 py-1 text-xs font-medium transition-colors ${
              runTraceHidden
                ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                : "bg-muted text-foreground"
            }`}
          >
            <Play size={14} aria-hidden />
            {translate("studioToolbar.runTrace")}
          </button>
        </div>
      )}

      {/* Flow settings: the properties panel only shows with a selection, so
        this opens it for the flow-level fields when nothing is selected. */}
      {!inspectorCollapsed && !hasInspectorSelection && (
        <button
          type="button"
          onClick={onToggleFlowSettings}
          aria-pressed={flowSettingsOpen}
          title={
            flowSettingsOpen
              ? translate("studioToolbar.hideTheFlowSettingsPanel")
              : translate("studioToolbar.showTheFlowSettingsId")
          }
          className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
            flowSettingsOpen
              ? "border-border bg-muted text-foreground"
              : "border-border text-foreground hover:bg-muted"
          }`}
        >
          <Settings size={14} aria-hidden />
          {translate("studioToolbar.flowSettings")}
        </button>
      )}

      {/* Validation summary */}
      {(totalErrors > 0 || totalWarnings > 0) && (
        <button
          type="button"
          onClick={onToggleProblems}
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${
            totalErrors > 0
              ? "bg-danger-soft text-danger border border-danger-border"
              : "bg-warning-soft text-warning border border-warning-border"
          }`}
        >
          {totalErrors > 0
            ? translate("studioToolbar.totalErrorsErrorS", { totalErrors })
            : translate("studioToolbar.totalWarningsWarningS", { totalWarnings })}
        </button>
      )}
      {unknownToolsByServer.size > 0 && (
        <button
          type="button"
          onClick={onToggleProblems}
          title={translate("studioToolbar.toolsOnMCPServersThis", { value: [...unknownToolsByServer.keys()].join(", ") })}
          className="rounded border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {translate("studioToolbar.sizeMCPServerSNot", { size: unknownToolsByServer.size })}
        </button>
      )}

      <FlowVersionBar
        flowId={baseId}
        token={token}
        hasDraft={hasDraft}
        nodes={nodes}
        edges={edges}
        onDiffOverlayChange={onDiffOverlayChange}
        onRolledBack={onRolledBack}
      />

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isSaving}
            onClick={onDiscard}
            title={translate("studioToolbar.reloadTheStoredVersionAnd")}
          >
            {translate("studioToolbar.discard")}
          </Button>
        )}
        {showFileWrite && (
          <Button
            variant={onlineEditing ? "outline" : "primary"}
            size="sm"
            disabled={isSaving}
            onClick={onSave}
            title={translate("studioToolbar.writeStraightIntoTheFlow")}
          >
            {translate("studioToolbar.writeToFile")}
          </Button>
        )}
        {onlineEditing && (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={isSaving}
              onClick={onSaveDraft}
              title={translate("studioToolbar.storeTheCanvasAsAn")}
            >
              {isSaving ? translate("studioToolbar.saving") : translate("studioToolbar.saveDraft")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={isSaving || totalErrors > 0}
              onClick={onPublish}
              title={
                totalErrors > 0
                  ? translate("studioToolbar.fixTheValidationErrorsFirst")
                  : translate("studioToolbar.saveTheDraftAndMake")
              }
            >
              {translate("studioToolbar.publish")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
