"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared building blocks of the NodeDetailPanel (Req 9.3, Task 13.4): chevron
 * icon, collapsible accordion section, key-value grid and JSON tree.
 * Split out of `graph/NodeDetailPanel.tsx` without behavior change.
 */

import React, { useState } from "react";

/** Chevron icon for collapsible sections */
export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path
        fillRule="evenodd"
        d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Collapsible accordion section */
export function AccordionSection({
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-muted hover:bg-muted text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
          {badge && (
            <span className="ml-2 font-normal normal-case text-muted-foreground">
              ({badge})
            </span>
          )}
        </span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="px-3 py-2 bg-card text-xs text-foreground">
          {children}
        </div>
      )}
    </section>
  );
}

/** Key-value grid for structured data */
export function KvGrid({ data }: { data: Array<[string, React.ReactNode]> }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {data.map(([k, v], i) => (
        <React.Fragment key={`${k}-${i}`}>
          <span className="text-muted-foreground font-mono whitespace-nowrap">
            {k}
          </span>
          <span className="break-words overflow-hidden">{v}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

/** JSON tree viewer with collapsible nodes */
export function JsonTree({
  data,
  depth = 0,
  maxDepth = 4,
}: {
  data: unknown;
  depth?: number;
  maxDepth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (data === null || data === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (typeof data === "boolean") {
    return <span className="text-copilot">{String(data)}</span>;
  }
  if (typeof data === "number") {
    return <span className="text-accent">{data}</span>;
  }
  if (typeof data === "string") {
    if (data.length > 200) {
      return (
        <span className="text-success break-all">
          &quot;{data.slice(0, 200)}…&quot;
        </span>
      );
    }
    return (
      <span className="text-success break-all">
        &quot;{data}&quot;
      </span>
    );
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-muted-foreground">[]</span>;
    if (depth >= maxDepth) {
      return <span className="text-muted-foreground">[…{data.length} items]</span>;
    }
    return (
      <div className="ml-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
        >
          {expanded ? "▼" : "▶"} [{data.length}]
        </button>
        {expanded && (
          <div className="ml-3 border-l border-border pl-2 space-y-0.5">
            {data.map((item, i) => (
              <div key={i} className="flex gap-1">
                <span className="text-muted-foreground shrink-0">{i}:</span>
                <JsonTree data={item} depth={depth + 1} maxDepth={maxDepth} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-muted-foreground">{"{}"}</span>;
    if (depth >= maxDepth) {
      return <span className="text-muted-foreground">{"{"} …{entries.length} keys {"}"}</span>;
    }
    return (
      <div className="ml-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
        >
          {expanded ? "▼" : "▶"} {"{"}{entries.length}{"}"}
        </button>
        {expanded && (
          <div className="ml-3 border-l border-border pl-2 space-y-0.5">
            {entries.map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <span className="text-accent font-mono shrink-0">{k}:</span>
                <JsonTree data={v} depth={depth + 1} maxDepth={maxDepth} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return <span>{String(data)}</span>;
}
