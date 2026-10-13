"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: diff view (before → after), moved out of FormulaEditor.tsx
// without behavior change.

import type React from "react";
import { useMemo } from "react";
import { diffText } from "../../lib/text-diff";

/** Before → after, removed parts struck through in red, added parts in green. */
export function DiffView({
  before,
  after,
  ariaLabel = "Proposed change",
}: {
  before: string;
  after: string;
  ariaLabel?: string;
}): React.JSX.Element {
  const parts = useMemo(() => diffText(before, after), [before, after]);
  return (
    // biome-ignore lint/a11y/useSemanticElements: labelled diff block; <pre> is the semantically correct container for preformatted diff output
    <pre
      aria-label={ariaLabel}
      role="group"
      className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-[11px] leading-relaxed"
    >
      {parts.map((p, i) =>
        p.type === "same" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff segments carry no identity and are replaced atomically whenever the text changes
          <span key={i}>{p.text}</span>
        ) : p.type === "del" ? (
          <del
            // biome-ignore lint/suspicious/noArrayIndexKey: diff segments carry no identity and are replaced atomically whenever the text changes
            key={i}
            className="bg-danger-soft text-danger decoration-danger dark:bg-danger-soft dark:text-danger"
          >
            {p.text}
          </del>
        ) : (
          <ins
            // biome-ignore lint/suspicious/noArrayIndexKey: diff segments carry no identity and are replaced atomically whenever the text changes
            key={i}
            className="bg-success-soft text-success no-underline dark:bg-success-soft dark:text-success"
          >
            {p.text}
          </ins>
        ),
      )}
    </pre>
  );
}
