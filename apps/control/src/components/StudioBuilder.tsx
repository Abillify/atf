"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * StudioBuilder — ReactFlow-based canvas for the Studio workspace (Req. 14).
 *
 * - Drag nodes from a searchable palette onto the canvas; DnD serializes into
 *   the flow file via the write endpoint (Req. 14.1 / 14.2).
 * - Non-serializable operations are blocked with a reason (Req. 14.5).
 * - External file conflicts (hash/mtime) are detected and warned; never
 *   silently overwritten (Req. 14.6).
 * - Hot-reload updates the view when the file changes (Req. 14.4).
 * - Undo/redo, multi-select + bulk actions, auto-layout, inline validation,
 *   and an in-canvas "Run & Trace" bar round out the SOTA-builder pass.
 *
 * Reuses: FlowCanvas, NodePropertyPanel, FlowNodePalette, FlowRunDrawer.
 *
 * Req 9.3 (Task 13.4): all state and logic live in the composition hook
 * `useStudioBuilder` (hooks/useStudioBuilder.ts) together with
 * useStudioLoad/useStudioHistory/useStudioCopilot; this component only
 * holds props and JSX. Toolbar, problems panel and inspector live under
 * components/studio/.
 */

import type React from "react";
import { createPortal } from "react-dom";
import { FlowCanvas } from "./FlowCanvas";
import { FlowNodePalette } from "./FlowNodePalette";
import { SubflowPalette } from "./SubflowPalette";
import { FlowRunDrawer } from "./FlowRunDrawer";
import { FlowCopilotPanel } from "./FlowCopilotPanel";
import { StudioToolbar } from "./studio/StudioToolbar";
import { StudioProblemsPanel } from "./studio/StudioProblemsPanel";
import { StudioInspector } from "./studio/StudioInspector";
import { FormulaProvider } from "./FormulaEditor";
import { studioStatusColors } from "../hooks/useStudioStatus";
import {
  useStudioBuilder,
  type StudioBuilderPanels,
  type StudioBuilderProps,
} from "../hooks/useStudioBuilder";
import { translate } from "../lib/i18n";

// Req 9.3 (Task 13.4): the props types belong to the composition hook.
export type { StudioBuilderPanels, StudioBuilderProps };

export function StudioBuilder(props: StudioBuilderProps): React.JSX.Element {
  const {
    flow,
    onlineEditing,
    onTogglePanel,
    paletteContainer,
    subflowsContainer,
    onSaveEvalCase,
    onDeleteEvalCase,
    attachExecutionId,
    onDetachExecution,
    token,
    status,
    setStatus,
    setStatusKind,
    statusKind,
    base,
    setBase,
    nodes,
    setNodes,
    edges,
    setEdges,
    viewport,
    setViewport,
    selBoundary,
    setSelBoundary,
    selectedNodeIds,
    selectedSubflowPath,
    flowSettingsOpen,
    setFlowSettingsOpen,
    isSaving,
    validation,
    setValidation,
    liveStates,
    setLiveStates,
    runExecutionId,
    setRunExecutionId,
    problemsOpen,
    setProblemsOpen,
    diffOverlay,
    setDiffOverlay,
    copilotPrefill,
    setCopilotPrefill,
    nodeOrigins,
    subflowName,
    setSubflowName,
    loadedKind,
    drafts,
    liveDefinition,
    liveKind,
    activeDraftId,
    viewingLive,
    paletteCollapsed,
    inspectorCollapsed,
    inspectorWidth,
    setInspectorWidth,
    copilotHidden,
    runTraceHidden,
    history,
    subflowHistory,
    canvasKey,
    loadFlow,
    currentDefinition,
    dirty,
    handleCopilotAccept,
    handleUndo,
    handleRedo,
    nodeValidation,
    edgeValidation,
    otherWarnings,
    unknownToolsByServer,
    totalErrors,
    totalWarnings,
    addNodeAt,
    updateNode,
    deleteNode,
    renameNode,
    updateEdge,
    deleteEdge,
    handleSelectionChange,
    handleBulkDelete,
    handleDuplicateSelected,
    handleExtractSubflow,
    setNodeOrigin,
    includeSubflow,
    selectSubflowGroup,
    handleDeleteSubflow,
    handleSaveSubflow,
    handleUndoSubflow,
    handleRedoSubflow,
    handleResetSubflow,
    fitViewNonce,
    setFitViewNonce,
    handleAutoLayout,
    referenceEdges,
    rootRef,
    handleSave,
    handleForceOverwrite,
    handleSaveDraft,
    handlePublish,
    handleDiscard,
    handleToggleViewLive,
    handleSelectDraft,
    handleCreateDraft,
    handleDeleteDraft,
    catalog,
    pinFlowId,
    pinRun,
    evaluateVariables,
    runsCtx,
    formulaFlow,
    nodeIdList,
    boundaries,
    boundaryCards,
    setEntry,
    selectNodeById,
    toolFocus,
    handleToolClick,
    selectedFlowNode,
    hasInspectorSelection,
    handlePanelSelect,
    setFocusedField,
    setFieldSelection,
    copilotFocus,
    edgeFlows,
    handleRunFinished,
    selectedEdge,
    showFileWrite,
    subflowActions,
  } = useStudioBuilder(props);

  return (
    <FormulaProvider
      flow={formulaFlow}
      catalog={catalog}
      evaluateVariables={evaluateVariables}
      runs={runsCtx}
    >
      <div ref={rootRef} className="flex h-full flex-col gap-2 overflow-y-auto">
        {/* Toolbar — Req 9.3 (Task 13.4): moved unchanged to studio/StudioToolbar. */}
        <StudioToolbar
          baseId={base.id}
          flowSource={flow?.source}
          hasDraft={flow?.hasDraft ?? false}
          onlineEditing={onlineEditing}
          showFileWrite={showFileWrite}
          dirty={dirty}
          isSaving={isSaving}
          viewingLive={viewingLive}
          activeDraftId={activeDraftId}
          drafts={drafts}
          liveDefinition={liveDefinition}
          liveKind={liveKind}
          loadedKind={loadedKind}
          onToggleViewLive={handleToggleViewLive}
          onSelectDraft={handleSelectDraft}
          onCreateDraft={() => {
            void handleCreateDraft();
          }}
          onDeleteDraft={() => {
            void handleDeleteDraft();
          }}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          {...(onTogglePanel ? { onTogglePanel } : {})}
          copilotHidden={copilotHidden}
          runTraceHidden={runTraceHidden}
          inspectorCollapsed={inspectorCollapsed}
          hasInspectorSelection={hasInspectorSelection}
          flowSettingsOpen={flowSettingsOpen}
          onToggleFlowSettings={() => {
            setFlowSettingsOpen((v) => !v);
          }}
          totalErrors={totalErrors}
          totalWarnings={totalWarnings}
          unknownToolsByServer={unknownToolsByServer}
          onToggleProblems={() => {
            setProblemsOpen((v) => !v);
          }}
          token={token ?? undefined}
          nodes={nodes}
          edges={edges}
          onDiffOverlayChange={setDiffOverlay}
          onRolledBack={() => {
            loadFlow(flow);
          }}
          onDiscard={handleDiscard}
          onSave={() => {
            void handleSave();
          }}
          onSaveDraft={() => {
            void handleSaveDraft();
          }}
          onPublish={() => {
            void handlePublish();
          }}
        />

        {/* Status bar */}
        {status && (
          <div
            className={`flex items-center gap-2 text-xs ${studioStatusColors[statusKind]}`}
          >
            <span>{status}</span>
            {statusKind === "warn" && status.startsWith("⚠ Conflict") && (
              <button
                type="button"
                onClick={() => {
                  void handleForceOverwrite();
                }}
                className="ml-2 rounded bg-warning-soft px-2 py-0.5 text-warning border border-warning-border hover:bg-warning-soft"
              >
                {translate("studioBuilder.overwriteAnyway")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setStatus(null)}
              aria-label={translate("studioBuilder.dismissStatus")}
              className="ml-auto rounded px-1 text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </div>
        )}

        {/* Problems panel — Req 9.3 (Task 13.4): moved unchanged to
            studio/StudioProblemsPanel. */}
        {problemsOpen &&
          (totalErrors > 0 ||
            totalWarnings > 0 ||
            unknownToolsByServer.size > 0) && (
            <StudioProblemsPanel
              validation={validation}
              otherWarnings={otherWarnings}
              unknownToolsByServer={unknownToolsByServer}
              onFixWithCopilot={(message) => {
                setCopilotPrefill({
                  instruction: `Fix this issue: ${message}`,
                  nonce: Date.now(),
                });
              }}
            />
          )}

        {/* Copilot (Phase 3) + Run & Trace (Phase 1) stacked vertically — each
          is toggled on its own from the toolbar next to Undo/Redo and hidden
          by default. Stacking (instead of side-by-side) gives Run & Trace the
          full width and leaves room for a generous reasoning/output area. */}
        {!(copilotHidden && runTraceHidden) && (
          <div className="flex flex-col gap-2">
            {!copilotHidden && (
              <FlowCopilotPanel
                key={`copilot-${canvasKey}`}
                flowId={base.id}
                token={token ?? undefined}
                getDefinition={currentDefinition}
                nodes={nodes}
                edges={edges}
                {...(copilotFocus ? { focus: copilotFocus } : {})}
                onPreviewChange={(overlay) => {
                  setDiffOverlay(overlay);
                  // Proposed nodes may land outside the current view — bring the
                  // whole preview into sight.
                  if (overlay && overlay.ghostNodes.length > 0)
                    setFitViewNonce((v) => v + 1);
                }}
                onAccept={handleCopilotAccept}
                prefill={copilotPrefill}
              />
            )}
            {!runTraceHidden && (
              <FlowRunDrawer
                key={canvasKey}
                flowId={base.id}
                onLiveStatesChange={setLiveStates}
                getDefinition={currentDefinition}
                liveAvailable={
                  flow !== null &&
                  (flow.source === "file" || flow.status === "published")
                }
                canvasIsLive={
                  !dirty &&
                  (loadedKind.kind === "file" ||
                    loadedKind.kind === "published")
                }
                onValidationFailed={(report) => {
                  setValidation(report);
                  setProblemsOpen(true);
                }}
                {...(onSaveEvalCase ? { onSaveEvalCase } : {})}
                {...(onDeleteEvalCase ? { onDeleteEvalCase } : {})}
                {...(pinFlowId ? { onPinRun: pinRun } : {})}
                {...(attachExecutionId ? { attachExecutionId } : {})}
                {...(onDetachExecution ? { onDetach: onDetachExecution } : {})}
                onExecutionChange={setRunExecutionId}
                onRunFinished={handleRunFinished}
              />
            )}
          </div>
        )}

        {/* Palette + canvas + property panel.
          `min-h-[320px]` keeps the graph usable even when the Copilot proposal
          or Problems panel above it expands, and `flex-1` lets it grow to fill
          the remaining Builder height; the parent column scrolls if the stacked
          controls ever exceed the available space. */}
        <div className="flex flex-1 min-h-[320px] gap-3 overflow-hidden">
          {/* The palette lives in the page's sidebar ("Nodes" section) when a
            container is provided — portalled there so its drag-and-drop
            handlers keep working across the DOM. Without a container host it
            falls back to the classic rail left of the canvas. */}
          {paletteContainer === undefined ? (
            <FlowNodePalette
              collapsed={paletteCollapsed}
              onAddNode={(type) => addNodeAt(type)}
              subflows={
                subflowsContainer === undefined ? subflowActions : undefined
              }
            />
          ) : (
            paletteContainer !== null &&
            createPortal(
              <FlowNodePalette
                fullWidth
                onAddNode={(type) => addNodeAt(type)}
                subflows={undefined}
              />,
              paletteContainer,
            )
          )}
          {/* The sub-flow palette gets its own sidebar section when the page
            provides a host; `undefined` keeps it inside the palette above. */}
          {subflowsContainer !== undefined &&
            subflowsContainer !== null &&
            subflowActions &&
            createPortal(
              <SubflowPalette actions={subflowActions} />,
              subflowsContainer,
            )}

          <div className="flex-1 min-h-0 min-w-0">
            <FlowCanvas
              key={canvasKey}
              nodes={nodes}
              edges={edges}
              editable
              onNodesChange={setNodes}
              onEdgesChange={setEdges}
              onSelectionChange={handleSelectionChange}
              onDropNodeType={addNodeAt}
              onDropSubflow={(path, position) => {
                includeSubflow(path, position).then(
                  (msg) => {
                    setStatus(msg);
                    setStatusKind("info");
                  },
                  (e: unknown) => {
                    setStatus(e instanceof Error ? e.message : String(e));
                    setStatusKind("error");
                  },
                );
              }}
              liveStates={liveStates}
              edgeFlows={edgeFlows}
              nodeValidation={nodeValidation}
              edgeValidation={edgeValidation}
              nodeDiff={diffOverlay?.nodeDiff}
              edgeDiff={diffOverlay?.edgeDiff}
              ghostNodes={diffOverlay?.ghostNodes}
              ghostEdges={diffOverlay?.ghostEdges}
              nodeOrigins={nodeOrigins}
              onViewportChange={setViewport}
              referenceEdges={referenceEdges}
              onAutoLayout={handleAutoLayout}
              fitViewNonce={fitViewNonce}
              onInvalidConnection={(reason) => {
                setStatus(`✗ ${reason}`);
                setStatusKind("error");
              }}
              onSelectSubflow={selectSubflowGroup}
              selectedSubflowPath={selectedSubflowPath}
              boundaries={boundaryCards}
              onSelectBoundary={setSelBoundary}
              onSetEntry={setEntry}
              onToolClick={handleToolClick}
              {...(viewport !== undefined ? { defaultViewport: viewport } : {})}
              height="100%"
            />
          </div>

          {/* Node/edge property panel — Req 9.3 (Task 13.4): moved unchanged to
              studio/StudioInspector (bulk/subflow/boundary/node panel
              including ResizeHandle). */}
          <StudioInspector
            inspectorCollapsed={inspectorCollapsed}
            hasInspectorSelection={hasInspectorSelection}
            flowSettingsOpen={flowSettingsOpen}
            inspectorWidth={inspectorWidth}
            setInspectorWidth={setInspectorWidth}
            handlePanelSelect={handlePanelSelect}
            setFocusedField={setFocusedField}
            clearInspectorFocus={() => {
              setFocusedField(undefined);
              setFieldSelection(undefined);
            }}
            base={base}
            flow={flow}
            setBase={setBase}
            evaluateVariables={evaluateVariables}
            token={token ?? undefined}
            selectedSubflowPath={selectedSubflowPath}
            selectedNodeIds={selectedNodeIds}
            subflowHistory={subflowHistory}
            handleSaveSubflow={handleSaveSubflow}
            handleUndoSubflow={handleUndoSubflow}
            handleRedoSubflow={handleRedoSubflow}
            handleResetSubflow={handleResetSubflow}
            handleDeleteSubflow={handleDeleteSubflow}
            subflowName={subflowName}
            setSubflowName={setSubflowName}
            handleExtractSubflow={handleExtractSubflow}
            handleDuplicateSelected={handleDuplicateSelected}
            handleBulkDelete={handleBulkDelete}
            selBoundary={selBoundary}
            boundaries={boundaries}
            runsCtx={runsCtx}
            liveStates={liveStates}
            runExecutionId={runExecutionId}
            selectNodeById={selectNodeById}
            showFileWrite={showFileWrite}
            selectedFlowNode={selectedFlowNode}
            nodeOrigins={nodeOrigins}
            setNodeOrigin={setNodeOrigin}
            toolFocus={toolFocus}
            selectedEdge={selectedEdge}
            updateNode={updateNode}
            deleteNode={deleteNode}
            renameNode={renameNode}
            catalog={catalog}
            nodeIdList={nodeIdList}
            updateEdge={updateEdge}
            deleteEdge={deleteEdge}
          />
        </div>
      </div>
    </FormulaProvider>
  );
}
