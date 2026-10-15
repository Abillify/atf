"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Chat bubble for prompt messages and the formatted/raw toggle (Req 9.3,
 * Task 13.4). Split out of `graph/NodeDetailPanel.tsx` without
 * behavior change.
 */

import { useState } from "react";
import type React from "react";
import { translate } from "../../../lib/i18n";

/** Chat-style message bubble for LLM prompt messages */
export function MessageBubble({
  role,
  content,
}: {
  role: "system" | "user" | "assistant" | string;
  content: string;
}) {
  const colorMap: Record<string, string> = {
    system: "bg-warning-soft border-warning-border",
    user: "bg-info-soft border-info-border",
    assistant: "bg-success-soft border-success-border",
  };
  const labelMap: Record<string, string> = {
    system: "🔧 System",
    user: "👤 User",
    assistant: "🤖 Assistant",
  };
  const cls = colorMap[role] ?? "bg-muted/30 border-border";
  const label = labelMap[role] ?? role;

  return (
    <div className={`rounded-lg border p-2 ${cls}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
        {label}
      </div>
      <div className="text-xs whitespace-pre-wrap break-words text-foreground max-h-48 overflow-y-auto">
        {content}
      </div>
    </div>
  );
}

/** Toggle between formatted and raw view */
export function FormattedOrRaw({
  text,
  renderFormatted,
}: {
  text: string;
  renderFormatted: () => React.ReactNode;
}) {
  const [raw, setRaw] = useState(false);
  return (
    <div>
      <div className="flex justify-end mb-1">
        <button type="button"
          onClick={() => setRaw((v) => !v)}
          className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted"
        >
          {raw ? translate("messageBubble.formatted") : translate("messageBubble.raw")}
        </button>
      </div>
      {raw ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted p-2 text-xs text-foreground">
          {text}
        </pre>
      ) : (
        renderFormatted()
      )}
    </div>
  );
}
