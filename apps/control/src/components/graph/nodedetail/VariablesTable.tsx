"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Variables table of the request node with copyable reference chips
 * (Req 9.3, Task 13.4). Split out of `graph/NodeDetailPanel.tsx` without
 * behavior change.
 */

import { useState } from "react";

// ---------------------------------------------------------------------------
// Variables table (Request node) — copyable, ready-to-use references
// ---------------------------------------------------------------------------

/** Small clipboard icon. */
function CopyIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 opacity-60">
      <path d="M7 4a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4z" />
      <path d="M4 7a1 1 0 0 0-1 1v7a2 2 0 0 0 2 2h6a1 1 0 0 0 1-1H5a1 1 0 0 1-1-1V7z" />
    </svg>
  );
}

/** A monospace reference chip that copies its text to the clipboard on click. */
function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        /* clipboard unavailable — ignore */
      });
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={`Copy "${text}"`}
      className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-accent hover:bg-muted"
    >
      <span className="break-all">{text}</span>
      {copied ? (
        <span className="text-success">✓</span>
      ) : (
        <CopyIcon />
      )}
    </button>
  );
}

interface VarRow {
  key: string;
  value: string;
  source?: string;
}

/**
 * Parses the __request__ "RESOLVED VARIABLES" section text into its four
 * subsections. The backend (buildVariableOverview) emits identity, parameter,
 * OAuth-scope, and decoded JWT-claim lines as `  <key> = <value>   ← <source>`
 * and JWT claim names as a comma list.
 */
function parseVariablesSection(text: string): {
  identity: VarRow[];
  params: VarRow[];
  scopes: VarRow[];
  claimValues: VarRow[];
  claims: string[];
} {
  const identity: VarRow[] = [];
  const params: VarRow[] = [];
  const scopes: VarRow[] = [];
  const claimValues: VarRow[] = [];
  let claims: string[] = [];
  let sub: "identity" | "params" | "scopes" | "claimValues" | "claims" | null = null;

  for (const line of text.split("\n")) {
    if (/Identity & routing attributes/i.test(line)) { sub = "identity"; continue; }
    if (/Request params/i.test(line)) { sub = "params"; continue; }
    if (/OAuth scopes/i.test(line)) { sub = "scopes"; continue; }
    if (/JWT claim values/i.test(line)) { sub = "claimValues"; continue; }
    if (/JWT claim names/i.test(line)) { sub = "claims"; continue; }
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (sub === "claims") {
      if (trimmed.startsWith("(")) continue; // "(no decodable JWT claims)"
      claims = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (
      sub === "identity" ||
      sub === "params" ||
      sub === "scopes" ||
      sub === "claimValues"
    ) {
      const m = /^(\S[\S ]*?)\s*=\s*(.*)$/.exec(trimmed);
      if (!m) continue; // wrapped header continuation / "(none)"
      const key = m[1].trim();
      let rest = m[2];
      let source: string | undefined;
      const arrow = rest.indexOf("←");
      if (arrow >= 0) {
        source = rest.slice(arrow + 1).trim();
        rest = rest.slice(0, arrow);
      }
      const row: VarRow = { key, value: rest.trim() };
      if (source) row.source = source;
      if (sub === "identity") identity.push(row);
      else if (sub === "params") params.push(row);
      else if (sub === "scopes") scopes.push(row);
      else claimValues.push(row);
    }
  }
  return { identity, params, scopes, claimValues, claims };
}

/** One subsection rendered as a copyable reference / value / source table. */
function VarGroup({
  title,
  rows,
  refPrefix,
}: {
  title: string;
  rows: VarRow[];
  refPrefix: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="divide-y divide-border rounded border border-border">
        {rows.map((r) => {
          const notSet = r.value === "(not set)";
          return (
            <div key={r.key} className="px-2 py-1">
              <div className="flex items-start justify-between gap-2">
                <CopyChip text={`${refPrefix}${r.key}`} />
                <span
                  className={`text-right font-mono text-[11px] break-all ${notSet ? "italic text-muted-foreground" : "text-foreground"}`}
                >
                  {r.value}
                </span>
              </div>
              {r.source && (
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  ← {r.source}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Renders the Variables section as copyable, ready-to-use references. */
export function VariablesTable({ text }: { text: string }) {
  const { identity, params, scopes, claimValues, claims } = parseVariablesSection(text);
  if (
    identity.length === 0 &&
    params.length === 0 &&
    scopes.length === 0 &&
    claimValues.length === 0 &&
    claims.length === 0
  ) {
    // Parsing failed — fall back to the raw text so nothing is lost.
    return (
      <pre className="whitespace-pre-wrap break-words max-h-64 overflow-auto text-xs">
        {text}
      </pre>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[10px] text-muted-foreground">
        Click a reference to copy it. Use in prompts as{" "}
        <span className="font-mono">{"{{context.userName}}"}</span> or in
        conditions directly.
      </p>
      {identity.length > 0 && (
        <VarGroup
          title="Identity & routing — use as context.*"
          rows={identity}
          refPrefix="context."
        />
      )}
      {params.length > 0 && (
        <VarGroup
          title="Request params — use as params.*"
          rows={params}
          refPrefix="params."
        />
      )}
      {scopes.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            OAuth scopes — diagnostic values from the verified JWT
          </div>
          <div className="divide-y divide-border rounded border border-border">
            {scopes.map((scope) => (
              <div key={scope.key} className="px-2 py-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {scope.key}
                  </span>
                  <span className="text-right font-mono text-[11px] break-all text-foreground">
                    {scope.value}
                  </span>
                </div>
                {scope.source && (
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    ← {scope.source}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {claimValues.length > 0 && (
        <VarGroup
          title="JWT claim values — decoded diagnostic data"
          rows={claimValues}
          refPrefix="claims."
        />
      )}
      {claims.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            JWT claims — use as claims.*
          </div>
          <div className="flex flex-wrap gap-1">
            {claims.map((name) => (
              <CopyChip key={name} text={`claims.${name}`} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
