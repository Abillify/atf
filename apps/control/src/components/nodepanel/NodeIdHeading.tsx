"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from NodePropertyPanel.tsx: node id heading with
 * inline rename. Without behavior change.
 */

import { useEffect, useRef, useState } from "react";
import type React from "react";
import { inputCls } from "../form-controls";

export function NodeIdHeading({
  id,
  onRename,
}: {
  id: string;
  onRename?: (next: string) => string | null;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(id);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <h4 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
        Node
        <span className="truncate font-mono text-xs text-muted-foreground">{id}</span>
        {onRename && (
          <button
            type="button"
            onClick={() => {
              setDraft(id);
              setError(null);
              setEditing(true);
            }}
            title="Rename this node — edges and references in other nodes are updated too"
            className="rounded px-1 text-[10px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            rename
          </button>
        )}
      </h4>
    );
  }

  const apply = (): void => {
    const err = onRename?.(draft) ?? null;
    if (err) setError(err);
    else setEditing(false);
  };

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          aria-label="Node id"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
            if (e.key === "Escape") setEditing(false);
          }}
          className={`${inputCls} font-mono text-xs ${error ? "border-danger-border" : ""}`}
        />
        <button
          type="button"
          onClick={apply}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted"
        >
          OK
        </button>
      </div>
      {error && <p className="mt-0.5 text-[10px] text-danger">{error}</p>}
    </div>
  );
}
