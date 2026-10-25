"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * StudioInspector: the right-hand property panel of the Studio canvas:
 * subflow group panel, bulk action bar, boundary panel or
 * NodePropertyPanel (with FlowSettings as the empty state).
 * Moved unchanged out of StudioBuilder; the state
 * stays in the parent and comes in through props.
 */

import type React from "react";
import { Button } from "../../lib/ui";
import { ResizeHandle } from "../ResizeHandle";
import { SubflowGroupPanel } from "../SubflowGroupPanel";
import { BoundaryPanel } from "../BoundaryPanel";
import {
  NodePropertyPanel,
  FlowSettingsPanel,
  type EdgeSelection,
} from "../NodePropertyPanel";
import type { NodeState } from "../graph/graphUtils";
import type { FlowBoundaries } from "../../lib/flow-boundaries";
import {
  REQUEST_EVENT_ID,
  RESPONSE_EVENT_ID,
} from "../../lib/flow-boundaries";
import type { RunsContext } from "../FormulaEditor";
import type { NodeTypeCatalog } from "../../lib/node-types";
import type { UseSubflowHistoryResult } from "../../lib/subflow-history";
import type {
  FlowDefinition,
  FlowListEntry,
  FlowNode,
} from "../../types/flow";
import { translate } from "../../lib/i18n";

export interface StudioInspectorProps {
  inspectorCollapsed: boolean;
  hasInspectorSelection: boolean;
  flowSettingsOpen: boolean;
  inspectorWidth: number;
  setInspectorWidth: (next: number) => void;
  handlePanelSelect: (e: React.SyntheticEvent) => void;
  setFocusedField: (field: string | undefined) => void;
  /** onFocusCapture of the panel: reset the focus field and text selection. */
  clearInspectorFocus: () => void;
  /** Flow on the canvas (null = unsaved new flow). */
  base: FlowDefinition;
  flow: FlowListEntry | null;
  setBase: (def: FlowDefinition) => void;
  evaluateVariables: (
    variables: Record<string, unknown>,
  ) => Promise<{
    values: Record<string, unknown>;
    errors: Array<{ name: string; message: string }>;
  }>;
  token: string | undefined;
  // Sub-flow group selection.
  selectedSubflowPath: string | null;
  selectedNodeIds: string[];
  subflowHistory: UseSubflowHistoryResult;
  handleSaveSubflow: (path: string) => Promise<void>;
  handleUndoSubflow: (path: string) => void;
  handleRedoSubflow: (path: string) => void;
  handleResetSubflow: (path: string) => Promise<void>;
  handleDeleteSubflow: (path: string) => void;
  // Bulk actions / sub-flow extraction.
  subflowName: string;
  setSubflowName: (name: string) => void;
  handleExtractSubflow: (name: string) => void;
  handleDuplicateSelected: () => void;
  handleBulkDelete: () => void;
  // Boundary selection.
  selBoundary: "start" | "end" | null;
  boundaries: FlowBoundaries;
  runsCtx: RunsContext | undefined;
  liveStates: Map<string, NodeState> | undefined;
  runExecutionId: string | null;
  selectNodeById: (id: string) => void;
  // Node/edge selection.
  showFileWrite: boolean;
  selectedFlowNode: FlowNode | null;
  nodeOrigins: Record<string, string>;
  setNodeOrigin: (nodeId: string, path: string | null) => void;
  toolFocus: { nodeId: string; tool: string; nonce: number } | null;
  selectedEdge: EdgeSelection | null;
  updateNode: (node: FlowNode) => void;
  deleteNode: (id: string) => void;
  renameNode: (oldId: string, newId: string) => string | null;
  catalog: NodeTypeCatalog | undefined;
  nodeIdList: string[];
  updateEdge: (sel: EdgeSelection) => void;
  deleteEdge: (id: string) => void;
}

export function StudioInspector({
  inspectorCollapsed,
  hasInspectorSelection,
  flowSettingsOpen,
  inspectorWidth,
  setInspectorWidth,
  handlePanelSelect,
  setFocusedField,
  clearInspectorFocus,
  base,
  flow,
  setBase,
  evaluateVariables,
  token,
  selectedSubflowPath,
  selectedNodeIds,
  subflowHistory,
  handleSaveSubflow,
  handleUndoSubflow,
  handleRedoSubflow,
  handleResetSubflow,
  handleDeleteSubflow,
  subflowName,
  setSubflowName,
  handleExtractSubflow,
  handleDuplicateSelected,
  handleBulkDelete,
  selBoundary,
  boundaries,
  runsCtx,
  liveStates,
  runExecutionId,
  selectNodeById,
  showFileWrite,
  selectedFlowNode,
  nodeOrigins,
  setNodeOrigin,
  toolFocus,
  selectedEdge,
  updateNode,
  deleteNode,
  renameNode,
  catalog,
  nodeIdList,
  updateEdge,
  deleteEdge,
}: StudioInspectorProps): React.JSX.Element | null {
  // Node/edge property panel, or bulk-action bar when multiple nodes are
  // selected. Only rendered while something is selected — or while the
  // toolbar's "Flow settings" button pinned the flow-level fields open.
  if (inspectorCollapsed || !(hasInspectorSelection || flowSettingsOpen)) {
    return null;
  }
  return (
    <>
      <ResizeHandle
        side="left"
        width={inspectorWidth}
        onWidth={setInspectorWidth}
        min={240}
        max={640}
        initial={320}
        label={translate("studioInspector.resizeThePropertiesPanel")}
      />
      {/* tabIndex=0 so the scrollable region is keyboard-accessible even when
        it holds no focusable children (empty state) — WCAG 2.1.1. */}
      <aside
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must stay keyboard-reachable (WCAG 2.1.1 scrollable-region-focusable)
        tabIndex={0}
        aria-label={translate("studioInspector.nodeProperties")}
        style={{ width: inspectorWidth }}
        className="shrink-0 overflow-auto rounded-lg border border-border bg-card p-3 text-sm"
        onSelect={handlePanelSelect}
        // Runs before the field's own onFocus, which reports its name again —
        // so a field that doesn't report one isn't mistaken for the last.
        onFocusCapture={clearInspectorFocus}
      >
        {selectedSubflowPath !== null ? (
          <SubflowGroupPanel
            path={selectedSubflowPath}
            nodeCount={selectedNodeIds.length}
            canUndo={subflowHistory.canUndo(selectedSubflowPath)}
            canRedo={subflowHistory.canRedo(selectedSubflowPath)}
            dirty={subflowHistory.isDirty(selectedSubflowPath)}
            onSave={() => void handleSaveSubflow(selectedSubflowPath)}
            onUndo={() => handleUndoSubflow(selectedSubflowPath)}
            onRedo={() => handleRedoSubflow(selectedSubflowPath)}
            onReset={() => void handleResetSubflow(selectedSubflowPath)}
            onRemove={() => handleDeleteSubflow(selectedSubflowPath)}
          />
        ) : selectedNodeIds.length > 1 ? (
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-foreground">
              {translate("studioInspector.lengthNodesSelected", { length: selectedNodeIds.length })}
            </h4>
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDuplicateSelected}
              >
                {translate("studioInspector.duplicateCmdCtrlD")}
              </Button>
              <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
                {translate("studioInspector.deleteSelected")}
              </Button>
            </div>

            <div className="border-t border-border pt-3">
              <label
                htmlFor="subflow-name"
                className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {translate("studioInspector.extractToSubFlow")}
              </label>
              <div className="flex gap-1.5">
                <input
                  id="subflow-name"
                  value={subflowName}
                  onChange={(e) => setSubflowName(e.target.value)}
                  placeholder="name"
                  className="min-w-0 flex-1 rounded border border-border px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={() => {
                    handleExtractSubflow(subflowName);
                    setSubflowName("");
                  }}
                  disabled={!subflowName.trim()}
                  className="rounded bg-subflow-soft px-2 py-1 text-xs font-medium text-subflow border border-subflow-border hover:bg-subflow-soft disabled:opacity-40"
                >
                  {translate("studioInspector.extract")}
                </button>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {translate("studioInspector.writesToSubflows")}{subflowName.trim() || "name"}{translate("studioInspector.yamlOnNextSaveNodes")}
              </p>
            </div>
          </div>
        ) : selBoundary !== null ? (
          <BoundaryPanel
            kind={selBoundary}
            boundaries={boundaries}
            {...(runsCtx ? { runs: runsCtx } : {})}
            {...(liveStates?.get(
              selBoundary === "start" ? REQUEST_EVENT_ID : RESPONSE_EVENT_ID,
            )
              ? {
                  current: liveStates.get(
                    selBoundary === "start"
                      ? REQUEST_EVENT_ID
                      : RESPONSE_EVENT_ID,
                  ),
                }
              : {})}
            runExecutionId={
              liveStates && liveStates.size > 0 ? runExecutionId : null
            }
            token={token}
            onSelectNode={selectNodeById}
          />
        ) : (
          <NodePropertyPanel
            {...(showFileWrite && selectedFlowNode
              ? {
                  origin: nodeOrigins[selectedFlowNode.id],
                  originOptions: [...new Set(Object.values(nodeOrigins))],
                  onOriginChange: (path: string | null) =>
                    setNodeOrigin(selectedFlowNode.id, path),
                }
              : {})}
            node={selectedFlowNode}
            {...(toolFocus && toolFocus.nodeId === selectedFlowNode?.id
              ? {
                  focusTool: {
                    tool: toolFocus.tool,
                    nonce: toolFocus.nonce,
                  },
                }
              : {})}
            edge={selectedEdge}
            onNodeChange={updateNode}
            onDeleteNode={deleteNode}
            onRenameNode={renameNode}
            {...(catalog ? { catalog } : {})}
            nodeIds={nodeIdList}
            onFocusField={setFocusedField}
            authToken={token}
            onEdgeChange={updateEdge}
            onDeleteEdge={deleteEdge}
            emptyContent={
              <FlowSettingsPanel
                flow={base}
                idEditable={flow === null}
                onChange={setBase}
                {...(catalog ? { catalog } : {})}
                evaluateVariables={evaluateVariables}
              />
            }
          />
        )}
      </aside>
    </>
  );
}
