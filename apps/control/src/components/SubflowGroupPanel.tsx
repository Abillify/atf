// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Inspector panel for a whole sub-flow group selected on the canvas: save it
 * to its own file, step its scoped undo/redo, reset it to the version on
 * disk, or remove it from this flow (the file is kept). Shown by StudioBuilder
 * when the selection is exactly one `$include` group.
 */

import type React from "react";
import { Redo2, RotateCcw, Save, Trash2, Undo2 } from "lucide-react";
import { Button } from "../lib/ui";
import { subflowLabel } from "../lib/subflows";

export interface SubflowGroupPanelProps {
  path: string;
  nodeCount: number;
  canUndo: boolean;
  canRedo: boolean;
  /** True when the group differs from the version last saved/loaded. */
  dirty: boolean;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onRemove: () => void;
}

export function SubflowGroupPanel({
  path,
  nodeCount,
  canUndo,
  canRedo,
  dirty,
  onSave,
  onUndo,
  onRedo,
  onReset,
  onRemove,
}: SubflowGroupPanelProps): React.JSX.Element {
  return (
    <div className="space-y-3" data-testid="subflow-group-panel">
      <div>
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          📄 {subflowLabel(path)}
          {dirty && (
            <span
              title="Unsaved changes in this sub-flow"
              className="rounded bg-warning-soft px-1 py-0.5 text-[10px] font-medium text-warning dark:bg-warning-soft dark:text-warning"
            >
              unsaved
            </span>
          )}
        </h4>
        <p className="text-[11px] text-muted-foreground">
          Sub-flow group · {nodeCount} node{nodeCount === 1 ? "" : "s"}. Actions below apply to this
          sub-flow only.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onSave}
          title="Write this sub-flow to its own file (subflows/…), independent of the parent flow"
        >
          <Save size={14} aria-hidden className="mr-1" />
          Save this sub-flow
        </Button>

        <div className="flex gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo the last edit in this sub-flow"
            className="flex-1"
          >
            <Undo2 size={14} aria-hidden className="mr-1" />
            Undo
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo the last undone edit in this sub-flow"
            className="flex-1"
          >
            <Redo2 size={14} aria-hidden className="mr-1" />
            Redo
          </Button>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={onReset}
          disabled={!dirty}
          title="Discard this sub-flow's unsaved changes and reload it from its file"
        >
          <RotateCcw size={14} aria-hidden className="mr-1" />
          Reset to saved
        </Button>

        <Button
          variant="destructive"
          size="sm"
          onClick={onRemove}
          title="Remove this sub-flow from the current flow. Its file is kept; only the include is dropped on save."
        >
          <Trash2 size={14} aria-hidden className="mr-1" />
          Remove from this flow
        </Button>
      </div>
    </div>
  );
}
