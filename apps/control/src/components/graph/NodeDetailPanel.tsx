"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * NodeDetailPanel — slide-in side panel that shows full execution details for
 * a selected graph node. Each node type gets a structured, type-specific
 * display with collapsible sections for input, evaluation, and output data.
 *
 * Requirements: 11.2
 */

import React, { useState, useEffect, useRef } from "react";
import { safeMarkdownHref } from "../../lib/safe-navigation";
import type { NodeToolCall } from "../../types/monitoring";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../../lib/ui";
import {
  nodeTypeColor,
  nodeTypeLabel,
  statusIndicator,
  formatCost,
  type NodeState,
} from "./graphUtils";

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

/** Chevron icon for collapsible sections */
function ChevronIcon({ open }: { open: boolean }) {
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
function AccordionSection({
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
function KvGrid({ data }: { data: Array<[string, React.ReactNode]> }) {
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
function JsonTree({
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
    return <span className="text-purple-600 dark:text-purple-400">{String(data)}</span>;
  }
  if (typeof data === "number") {
    return <span className="text-accent">{data}</span>;
  }
  if (typeof data === "string") {
    if (data.length > 200) {
      return (
        <span className="text-green-700 dark:text-green-400 break-all">
          &quot;{data.slice(0, 200)}…&quot;
        </span>
      );
    }
    return (
      <span className="text-green-700 dark:text-green-400 break-all">
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

// ---------------------------------------------------------------------------
// Lightweight markdown renderer (dependency-free)
// ---------------------------------------------------------------------------

/** Renders inline markdown: **bold**, *italic*, `code`, [text](url). */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Tokenize on the supported inline constructs.
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[2] !== undefined) {
      nodes.push(<strong key={key}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<em key={key}>{m[3]}</em>);
    } else if (m[4] !== undefined) {
      nodes.push(
        <code key={key} className="rounded bg-muted px-1 font-mono text-[11px]">
          {m[4]}
        </code>,
      );
    } else if (m[5] !== undefined && m[6] !== undefined) {
      const href = safeMarkdownHref(m[6]);
      if (href) {
        const external = /^https?:\/\//i.test(href);
        nodes.push(
          <a
            key={key}
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
            className="text-accent underline"
          >
            {m[5]}
          </a>,
        );
      } else {
        nodes.push(<span key={key}>{m[5]}</span>);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Minimal markdown renderer covering the constructs LLM outputs commonly use:
 * headings, bold/italic, inline code, fenced code blocks, and bullet/numbered
 * lists. Not a full CommonMark implementation — a dependency-free best effort.
 */
function MarkdownView({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre key={key++} className="my-1 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
          {codeLines.join("\n")}
        </pre>,
      );
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(
        <div
          key={key++}
          className={`font-semibold ${level <= 2 ? "text-sm" : "text-xs"} mt-2 mb-0.5 text-foreground`}
        >
          {renderInline(heading[2]!, `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    // List (bullet or numbered) — consume consecutive items
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
        const content = lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, "");
        items.push(<li key={key++}>{renderInline(content, `li${key}`)}</li>);
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-1 ml-4 list-disc space-y-0.5">
          {items}
        </ul>,
      );
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph
    blocks.push(
      <p key={key++} className="my-0.5">
        {renderInline(line, `p${key}`)}
      </p>,
    );
    i++;
  }

  return (
    <div className="max-h-64 overflow-auto break-words text-xs text-foreground">
      {blocks}
    </div>
  );
}

/** Chat-style message bubble for LLM prompt messages */
function MessageBubble({
  role,
  content,
}: {
  role: "system" | "user" | "assistant" | string;
  content: string;
}) {
  const colorMap: Record<string, string> = {
    system: "bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-700",
    user: "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700",
    assistant: "bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-700",
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
function FormattedOrRaw({
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
        <button
          onClick={() => setRaw((v) => !v)}
          className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted"
        >
          {raw ? "Formatted" : "Raw"}
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

// ---------------------------------------------------------------------------
// Section parsers — extract structured data from the raw prompt/response text
// ---------------------------------------------------------------------------

/**
 * Separator the backend uses to delimit sections in the __request__ prompt:
 * a full line of `═══ NAME ═══` (box-drawing U+2550). Anchored to whole lines
 * and restricted to the box-drawing char (NOT ASCII `=`) so that `===` inside
 * a JSON payload / user message is never mistaken for a section header — which
 * would otherwise corrupt the payload and stop it rendering as a tree.
 */
const SECTION_RE = /^[ \t]*═{3,}[ \t]*(.+?)[ \t]*═{3,}[ \t]*$/gm;

/**
 * Parses the __request__ boundary node's prompt text into named sections.
 * The backend uses ═══ SECTION NAME ═══ delimiters.
 */
function parseRequestSections(
  text: string,
): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = text.split(SECTION_RE);
  // parts[0] is leading text (if any), then alternating: name, content, name, content…
  if (parts[0] && parts[0].trim()) {
    sections["Preamble"] = parts[0].trim();
  }
  for (let i = 1; i < parts.length - 1; i += 2) {
    const name = parts[i]!.trim();
    const content = (parts[i + 1] ?? "").trim();
    sections[name] = content;
  }
  return sections;
}

/**
 * Parses the LLM/classifier prompt text into individual messages.
 *
 * The backend's `coreMessagesToText` (src/graph/message-mapping.ts) formats
 * each message as `<role>: <content>` on its own line, joined by newlines.
 * Content itself may span multiple lines, so a new message only begins where a
 * line starts with a known role followed by ": ".
 */
const ROLE_LINE_RE =
  /^(system|user|assistant|tool|developer|function):[ \t]?/gim;

function parseLlmMessages(
  text: string,
): Array<{ role: string; content: string }> | null {
  const matches = [...text.matchAll(ROLE_LINE_RE)];
  // Require the FIRST role marker to sit at the very start of the text.
  // `coreMessagesToText` always begins with `<role>: …`, so a first match at a
  // non-zero index means we matched a role-looking word inside free text (e.g.
  // a prompt that mentions "User:" mid-sentence) — treat that as not-messages.
  if (matches.length >= 1 && matches[0]!.index === 0) {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < matches.length; i++) {
      const role = matches[i]![1]!.toLowerCase();
      const start = matches[i]!.index! + matches[i]![0]!.length;
      const end = matches[i + 1]?.index ?? text.length;
      msgs.push({ role, content: text.slice(start, end).trim() });
    }
    return msgs;
  }

  // Fallbacks for alternative delimiters ("--- role ---" / "[ROLE]").
  const altRe = /^(?:---\s*(\w+)\s*---|\[(\w+)\])$/gm;
  const altMatches = [...text.matchAll(altRe)];
  if (altMatches.length >= 2) {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < altMatches.length; i++) {
      const role = (altMatches[i]![1] ?? altMatches[i]![2]!).toLowerCase();
      const start = altMatches[i]!.index! + altMatches[i]![0]!.length;
      const end = altMatches[i + 1]?.index ?? text.length;
      msgs.push({ role, content: text.slice(start, end).trim() });
    }
    return msgs;
  }
  return null;
}

/**
 * Attempts to parse the retrieval/vectorsearch response to extract findings.
 */
function parseRetrievalResponse(text: string): {
  findings: Array<{ id?: string; title?: string; score?: number }>;
  totalMatches: number;
} | null {
  const toFinding = (c: Record<string, unknown>) => ({
    id: c["id"] as string | undefined,
    title:
      (c["title"] as string) ??
      ((c["metadata"] as Record<string, unknown> | undefined)?.["title"] as
        | string
        | undefined),
    score: (c["score"] ?? c["retrievalScore"]) as number | undefined,
  });

  // A record only counts as a "finding" if it carries at least one of the
  // fields we display — guards against rendering arbitrary JSON arrays/objects
  // (e.g. the MCP `[{type,text}]` wrapper) as an empty findings table.
  const looksLikeFinding = (c: unknown): boolean =>
    c != null &&
    typeof c === "object" &&
    ("id" in c || "title" in c || "score" in c || "retrievalScore" in c);

  try {
    const data = JSON.parse(text) as unknown;
    if (Array.isArray(data)) {
      if (data.length > 0 && data.every(looksLikeFinding)) {
        return {
          findings: data.map((c) => toFinding(c as Record<string, unknown>)),
          totalMatches: data.length,
        };
      }
      return null;
    }
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      // Normalised backend shape: { totalMatches, findings: [...] }
      if (Array.isArray(obj["findings"])) {
        const findings = obj["findings"] as Array<Record<string, unknown>>;
        return {
          findings: findings.map(toFinding),
          totalMatches:
            typeof obj["totalMatches"] === "number"
              ? (obj["totalMatches"] as number)
              : findings.length,
        };
      }
      // Retrieval tool-result shape: { collection, retrieved, chunks: [...] }
      if (Array.isArray(obj["chunks"])) {
        const chunks = obj["chunks"] as Array<Record<string, unknown>>;
        return {
          findings: chunks.map(toFinding),
          totalMatches:
            typeof obj["retrieved"] === "number"
              ? (obj["retrieved"] as number)
              : chunks.length,
        };
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** Try to determine if text is JSON */
function isJsonString(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

/** Strips a single leading/trailing markdown code fence (```json … ```). */
function stripCodeFence(text: string): string {
  const t = text.trim();
  const fence = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/.exec(t);
  return fence ? fence[1]!.trim() : t;
}

/**
 * Renders text as a JSON tree when it parses as JSON (incl. JSON wrapped in a
 * ```json code fence, as LLMs/classifiers often emit), else as preformatted
 * text. Crash-safe: the `JSON.parse` is guarded so malformed-but-bracketed
 * content (e.g. a truncated payload) falls back to raw text instead of throwing
 * during render.
 */
function SmartValue({ text }: { text: string }) {
  const candidate = stripCodeFence(text);
  if (isJsonString(candidate)) {
    try {
      return <JsonTree data={JSON.parse(candidate) as unknown} />;
    } catch {
      /* fall through to preformatted */
    }
  }
  return (
    <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">
      {text}
    </pre>
  );
}

/** Renders a list of RAG/search findings (id, title, score) + total count. */
function FindingsTable({
  findings,
  totalMatches,
}: {
  findings: Array<{ id?: string; title?: string; score?: number }>;
  totalMatches: number;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground font-semibold mb-1">
        Total matches: {totalMatches}
      </div>
      {findings.length === 0 ? (
        <p className="text-[10px] text-muted-foreground italic">No findings.</p>
      ) : (
        <div className="max-h-48 overflow-y-auto space-y-1">
          {findings.map((f, i) => (
            <div
              key={f.id ?? i}
              className="flex items-start gap-2 rounded border border-border px-2 py-1 bg-muted"
            >
              <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                #{i + 1}
              </span>
              <div className="flex-1 min-w-0">
                {f.title && (
                  <div className="text-xs font-medium truncate" title={f.title}>
                    {f.title}
                  </div>
                )}
                {f.id && (
                  <div
                    className="text-[10px] text-muted-foreground font-mono truncate"
                    title={f.id}
                  >
                    {f.id}
                  </div>
                )}
              </div>
              {f.score != null && (
                <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 shrink-0">
                  {(f.score <= 1 ? f.score * 100 : f.score).toFixed(1)}
                  {f.score <= 1 ? "%" : ""}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variables table (Request node) — copyable, ready-to-use references
// ---------------------------------------------------------------------------

/** Small clipboard icon. */
function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 opacity-60">
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
        <span className="text-green-600 dark:text-green-400">✓</span>
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
      const key = m[1]!.trim();
      let rest = m[2]!;
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
function VariablesTable({ text }: { text: string }) {
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

// ---------------------------------------------------------------------------
// Headers table for request node
// ---------------------------------------------------------------------------

/**
 * Parses the HEADERS section text (one header per line: `key: value`) and
 * renders them as a proper table for readability.
 */
function HeadersTable({ text }: { text: string }) {
  const rows: Array<[string, string]> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      rows.push([trimmed.slice(0, colonIdx).trim(), trimmed.slice(colonIdx + 1).trim()]);
    } else {
      rows.push([trimmed, ""]);
    }
  }

  if (rows.length === 0) {
    return (
      <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto text-xs">
        {text}
      </pre>
    );
  }

  return (
    <div className="max-h-64 overflow-auto">
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell className="whitespace-nowrap">
              Header
            </TableHeaderCell>
            <TableHeaderCell>Value</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(([key, value], i) => (
            <TableRow key={`${key}-${i}`}>
              <TableCell className="whitespace-nowrap align-top font-mono text-accent">
                {key}
              </TableCell>
              <TableCell className="break-all font-mono text-foreground">
                {value}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-node-type detail renderers
// ---------------------------------------------------------------------------

/** Request boundary node (__request__): variables, payload, headers, token */
function RequestNodeDetail({ state }: { state: NodeState }) {
  const sections = state.prompt ? parseRequestSections(state.prompt) : {};
  const sectionNames = Object.keys(sections);

  // Map section names to user-friendly tab labels
  const labelMap: Record<string, string> = {
    "RESOLVED VARIABLES (set + usable downstream)": "Variables",
    "PAYLOAD (request body)": "Payload",
    HEADERS: "Headers",
    "DECODED TOKEN (JWT claims)": "JWT Claims",
    "RAW TOKEN": "Raw Token",
    Preamble: "Info",
  };

  // Filter out "RAW TOKEN" section entirely — only a masked value is shown
  const filteredSectionNames = sectionNames.filter(
    (name) => name !== "RAW TOKEN",
  );

  if (filteredSectionNames.length === 0 && !state.prompt) {
    return (
      <p className="text-xs text-muted-foreground italic">No request data available.</p>
    );
  }

  // If we couldn't parse sections, show fallback
  if (filteredSectionNames.length === 0 && state.prompt) {
    return (
      <AccordionSection title="Request Data" defaultOpen badge={`${state.prompt.length} chars`}>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-foreground">
          {state.prompt}
        </pre>
      </AccordionSection>
    );
  }

  return (
    <div className="space-y-2">
      {filteredSectionNames.map((name) => (
        <AccordionSection
          key={name}
          title={labelMap[name] ?? name}
          defaultOpen={name.includes("VARIABLE")}
          badge={`${sections[name]!.length} chars`}
        >
          {name.includes("VARIABLE") ? (
            <FormattedOrRaw
              text={sections[name]!}
              renderFormatted={() => <VariablesTable text={sections[name]!} />}
            />
          ) : name === "HEADERS" ? (
            <HeadersTable text={sections[name]!} />
          ) : isJsonString(sections[name]!) ? (
            <FormattedOrRaw
              text={sections[name]!}
              renderFormatted={() => <SmartValue text={sections[name]!} />}
            />
          ) : (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
              {sections[name]}
            </pre>
          )}
        </AccordionSection>
      ))}
    </div>
  );
}

/** LLM node: messages as dialog bubbles, structured response */
function LlmNodeDetail({ state }: { state: NodeState }) {
  const messages = state.prompt ? parseLlmMessages(state.prompt) : null;

  return (
    <div className="space-y-2">
      {/* Prompt / Messages */}
      {state.prompt && (
        <AccordionSection
          title="Prompt (Messages)"
          defaultOpen
          badge={messages ? `${messages.length} messages` : `${state.prompt.length} chars`}
        >
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() =>
              messages ? (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {messages.map((m, i) => (
                    <MessageBubble key={i} role={m.role} content={m.content} />
                  ))}
                </div>
              ) : (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                  {state.prompt}
                </pre>
              )
            }
          />
        </AccordionSection>
      )}

      {/* Response */}
      {state.response && (
        <AccordionSection
          title="Response"
          defaultOpen
          badge={`${state.response.length} chars`}
        >
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => {
              if (isJsonString(state.response!)) {
                try {
                  return <JsonTree data={JSON.parse(state.response!)} />;
                } catch {
                  /* fall through to markdown */
                }
              }
              // Treat as markdown
              return <MarkdownView text={state.response!} />;
            }}
          />
        </AccordionSection>
      )}
    </div>
  );
}

/** Retrieval / vectorsearch node: input query + structured findings output */
function RetrievalNodeDetail({ state }: { state: NodeState }) {
  // The prompt for retrieval nodes is typically the search query
  // The response is the JSON result (or from tool_calls)
  const responseText = state.response ?? "";
  const findings = parseRetrievalResponse(responseText);

  // Also surface the underlying search tool call (retrieval/… or
  // vectorsearch/search) so its resolved args (collection, limit, …) are visible.
  const retrievalToolCall = state.tool_calls?.find((tc) =>
    /^retrieval\/|vectorsearch|search/i.test(tc.name),
  );

  return (
    <div className="space-y-2">
      {/* Input: search query or tool args */}
      {state.prompt && (
        <AccordionSection title="Input (Query / Args)" defaultOpen>
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() => <SmartValue text={state.prompt!} />}
          />
        </AccordionSection>
      )}

      {/* Output: findings table */}
      {findings && (
        <AccordionSection
          title="Output (Findings)"
          defaultOpen
          badge={`${findings.totalMatches} matches`}
        >
          <FindingsTable
            findings={findings.findings}
            totalMatches={findings.totalMatches}
          />
        </AccordionSection>
      )}

      {/* Fallback: raw response if no structured findings */}
      {!findings && responseText && (
        <AccordionSection title="Output (Raw)" defaultOpen badge={`${responseText.length} chars`}>
          <FormattedOrRaw
            text={responseText}
            renderFormatted={() => <SmartValue text={responseText} />}
          />
        </AccordionSection>
      )}

      {/* Tool call detail */}
      {retrievalToolCall && (
        <AccordionSection title="Tool Call" badge={retrievalToolCall.name}>
          <ToolCallEntry tc={retrievalToolCall} />
        </AccordionSection>
      )}
    </div>
  );
}

/** Parallel node (context-assembler): shows collected inputs and assembled output */
function ParallelNodeDetail({ state }: { state: NodeState }) {
  const findings = state.response ? parseRetrievalResponse(state.response) : null;

  return (
    <div className="space-y-2">
      {/* Input: which children / RAG sources ran this turn */}
      {state.prompt && (
        <AccordionSection title="Input (Sources & Query)" defaultOpen>
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() => <SmartValue text={state.prompt!} />}
          />
        </AccordionSection>
      )}

      {/* Output: assembled findings (id/title/score + total) */}
      {findings && (
        <AccordionSection
          title="Output (Assembled Findings)"
          defaultOpen
          badge={`${findings.totalMatches} matches`}
        >
          <FindingsTable
            findings={findings.findings}
            totalMatches={findings.totalMatches}
          />
        </AccordionSection>
      )}

      {/* Output: raw assembled result (summary counts) */}
      {state.response && (
        <AccordionSection
          title="Output (Summary)"
          defaultOpen={!findings}
          badge={`${state.response.length} chars`}
        >
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => <SmartValue text={state.response!} />}
          />
        </AccordionSection>
      )}

      {/* If no data at all, show a hint */}
      {!state.prompt && !state.response && (
        <p className="text-xs text-muted-foreground italic">
          No I/O data captured for this node. The parallel node collects results
          from child nodes and passes the assembled context downstream.
        </p>
      )}
    </div>
  );
}

/** Router node: shows routing decision with candidates */
function RouterNodeDetail({ state }: { state: NodeState }) {
  return (
    <div className="space-y-2">
      {state.routing_decision && (
        <AccordionSection title="Routing Decision" defaultOpen>
          <div className="space-y-2">
            <KvGrid
              data={[
                [
                  "Chosen",
                  <span key="t" className="font-mono font-semibold text-foreground">
                    {state.routing_decision.target === "__end__"
                      ? "— (no match → end)"
                      : state.routing_decision.target}
                  </span>,
                ],
                ...(state.routing_decision.matched_label
                  ? [["Branch", state.routing_decision.matched_label] as [string, React.ReactNode]]
                  : []),
                ...(state.routing_decision.matched_condition
                  ? [
                      [
                        "Condition",
                        <span key="c" className="font-mono">{state.routing_decision.matched_condition}</span>,
                      ] as [string, React.ReactNode],
                    ]
                  : []),
              ]}
            />
            {state.routing_decision.candidates.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase">
                  Candidates
                </div>
                {state.routing_decision.candidates.map((c, i) => (
                  <div
                    key={`${c.target}-${i}`}
                    className={`rounded border px-2 py-1 text-xs ${
                      c.matched
                        ? "border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/30"
                        : "border-border bg-muted opacity-70"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono break-all">
                        {c.matched ? "→ " : ""}{c.target}
                      </span>
                      {c.matched && (
                        <span className="text-[10px] font-semibold text-green-700 dark:text-green-400">
                          taken
                        </span>
                      )}
                    </div>
                    {c.label && (
                      <div className="text-muted-foreground break-words">{c.label}</div>
                    )}
                    {c.condition && (
                      <div className="font-mono text-[11px] text-muted-foreground break-all">
                        {c.condition}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </AccordionSection>
      )}

      {/* Input / Output fallback */}
      {state.prompt && (
        <AccordionSection title="Input" badge={`${state.prompt.length} chars`}>
          <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">{state.prompt}</pre>
        </AccordionSection>
      )}
      {state.response && (
        <AccordionSection title="Output" badge={`${state.response.length} chars`}>
          <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">{state.response}</pre>
        </AccordionSection>
      )}
    </div>
  );
}

/** Classifier node: shows prompt messages + classification output */
function ClassifierNodeDetail({ state }: { state: NodeState }) {
  const messages = state.prompt ? parseLlmMessages(state.prompt) : null;

  return (
    <div className="space-y-2">
      {state.prompt && (
        <AccordionSection
          title="Input (Classifier Prompt)"
          defaultOpen
          badge={messages ? `${messages.length} messages` : `${state.prompt.length} chars`}
        >
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() =>
              messages ? (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {messages.map((m, i) => (
                    <MessageBubble key={i} role={m.role} content={m.content} />
                  ))}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">{state.prompt}</pre>
              )
            }
          />
        </AccordionSection>
      )}

      {state.response && (
        <AccordionSection title="Output (Classification)" defaultOpen badge={`${state.response.length} chars`}>
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => <SmartValue text={state.response!} />}
          />
        </AccordionSection>
      )}
    </div>
  );
}

/** Generic node: shows input + output in structured collapsible sections.
 * Output auto-detects findings (id/title/score) and renders a findings table
 * so tool, memory and any other node returning that shape display uniformly. */
function GenericNodeDetail({ state }: { state: NodeState }) {
  const findings = state.response ? parseRetrievalResponse(state.response) : null;

  return (
    <div className="space-y-2">
      {state.prompt && (
        <AccordionSection title="Input" defaultOpen badge={`${state.prompt.length} chars`}>
          <FormattedOrRaw
            text={state.prompt}
            renderFormatted={() => <SmartValue text={state.prompt!} />}
          />
        </AccordionSection>
      )}

      {findings && (
        <AccordionSection
          title="Output (Findings)"
          defaultOpen
          badge={`${findings.totalMatches} matches`}
        >
          <FindingsTable
            findings={findings.findings}
            totalMatches={findings.totalMatches}
          />
        </AccordionSection>
      )}

      {state.response && !findings && (
        <AccordionSection title="Output" defaultOpen badge={`${state.response.length} chars`}>
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => <SmartValue text={state.response!} />}
          />
        </AccordionSection>
      )}

      {!state.prompt && !state.response && (
        <p className="text-xs text-muted-foreground italic">No I/O data captured for this node.</p>
      )}
    </div>
  );
}

/** Response boundary node (__response__): shows payload */
function ResponseNodeDetail({ state }: { state: NodeState }) {
  return (
    <div className="space-y-2">
      {state.response && (
        <AccordionSection title="Response Payload" defaultOpen badge={`${state.response.length} chars`}>
          <FormattedOrRaw
            text={state.response}
            renderFormatted={() => <SmartValue text={state.response!} />}
          />
        </AccordionSection>
      )}
      {state.prompt && (
        <AccordionSection title="Input" badge={`${state.prompt.length} chars`}>
          <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">{state.prompt}</pre>
        </AccordionSection>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call entry (shared)
// ---------------------------------------------------------------------------

function ToolCallEntry({ tc }: { tc: NodeToolCall }) {
  const [expanded, setExpanded] = useState(false);
  let args: Record<string, unknown> | null = null;
  try {
    args = JSON.parse(tc.args_json) as Record<string, unknown>;
  } catch {
    /* raw */
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-muted hover:bg-muted text-left"
      >
        <div>
          <span className="font-mono text-xs font-semibold text-accent">
            {tc.name}
          </span>
          {tc.exec_time_seconds != null && (
            <span className="ml-2 text-[10px] text-muted-foreground">
              {(tc.exec_time_seconds * 1000).toFixed(0)}ms
            </span>
          )}
        </div>
        <ChevronIcon open={expanded} />
      </button>
      {expanded && (
        <div className="px-3 py-2 bg-card">
          {args !== null ? (
            <dl className="space-y-1">
              {Object.entries(args).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
                  <dt className="text-muted-foreground font-mono">{k}:</dt>
                  <dd className="font-mono break-all text-foreground">
                    {typeof v === "string" ? v : JSON.stringify(v)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <pre className="text-xs text-muted-foreground break-all whitespace-pre-wrap">
              {tc.args_json}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error recording (debug-trace backed)
// ---------------------------------------------------------------------------

const DIAG_LEVEL_CLASS: Record<string, string> = {
  info: "text-sky-600 dark:text-sky-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
};

/**
 * Full error recording for one node. The monitoring event stream only
 * carries a bare `error_message`; when the execution's debug trace is still
 * in the runtime's in-memory buffer, the node additionally carries the
 * machine-readable error type, structured error details, the in-node
 * diagnostics timeline (retries, fallbacks, tool errors), and — for a failed
 * synthetic tool node — the failing call's full result payload. Everything
 * the trace did not provide simply is not rendered, so an evicted trace
 * degrades to the plain message exactly as before.
 */
function ErrorRecording({ state }: { state: NodeState }) {
  const hasError =
    state.error_message !== undefined ||
    state.error_type !== undefined ||
    state.error_details !== undefined ||
    state.tool_error_result !== undefined;
  const diagnostics = state.diagnostics ?? [];
  if (!hasError && diagnostics.length === 0) return null;

  return (
    <>
      {hasError && (
        <section
          className="border border-red-200 dark:border-red-800 rounded-lg overflow-hidden"
          data-testid="node-error-recording"
        >
          <div className="px-3 py-2 bg-red-50 dark:bg-red-900/30 space-y-2">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
                Error
              </h4>
              {state.error_type && (
                <span className="rounded bg-red-600/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-red-700 dark:text-red-300">
                  {state.error_type}
                </span>
              )}
            </div>
            {state.error_message && (
              <pre className="text-xs text-red-700 dark:text-red-300 break-words whitespace-pre-wrap">
                {state.error_message}
              </pre>
            )}
            {state.tool_error_result !== undefined && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-red-600/80 dark:text-red-400/80">
                  Tool result
                </div>
                <div className="mt-1 max-h-48 overflow-auto rounded border border-red-200 dark:border-red-800 bg-card p-2 font-mono text-[11px] text-foreground">
                  <JsonTree data={state.tool_error_result} maxDepth={6} />
                </div>
              </div>
            )}
            {state.error_details !== undefined && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-red-600/80 dark:text-red-400/80">
                  Details
                </div>
                <div className="mt-1 max-h-48 overflow-auto rounded border border-red-200 dark:border-red-800 bg-card p-2 font-mono text-[11px] text-foreground">
                  <JsonTree data={state.error_details} maxDepth={6} />
                </div>
              </div>
            )}
          </div>
        </section>
      )}
      {diagnostics.length > 0 && (
        <AccordionSection
          title={`Diagnostics (${diagnostics.length})`}
          defaultOpen={state.status === "error"}
        >
          <ol className="space-y-1.5" data-testid="node-diagnostics">
            {diagnostics.map((d, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no id and may repeat at/code; the list is append-only
                key={`${d.at}-${d.code}-${i}`}
                className="rounded border border-border bg-muted/50 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span
                    className={`font-mono text-[10px] font-bold uppercase ${DIAG_LEVEL_CLASS[d.level] ?? DIAG_LEVEL_CLASS.info}`}
                  >
                    {d.level}
                  </span>
                  <span className="font-mono text-xs font-semibold text-foreground">
                    {d.code}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {d.at ? new Date(d.at).toLocaleTimeString() : ""}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-foreground break-words whitespace-pre-wrap">
                  {d.message}
                </div>
                {d.details !== undefined &&
                  Object.keys(d.details).length > 0 && (
                    <div className="mt-1 max-h-40 overflow-auto rounded border border-border bg-card p-1.5 font-mono text-[10px] text-foreground">
                      <JsonTree data={d.details} maxDepth={5} />
                    </div>
                  )}
              </li>
            ))}
          </ol>
        </AccordionSection>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export interface NodeDetailPanelProps {
  state: NodeState;
  onClose: () => void;
}

/**
 * NodeDetailContent — renders node detail body content without a wrapper.
 * Used by the combined sidebar panel (Details tab).
 */
export function NodeDetailContent({ state }: { state: NodeState }) {
  const fmt = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleTimeString() : "—";

  function renderTypeDetail() {
    if (state.id === "__request__") return <RequestNodeDetail state={state} />;
    if (state.id === "__response__") return <ResponseNodeDetail state={state} />;
    switch (state.nodeType) {
      case "llm":
        return <LlmNodeDetail state={state} />;
      case "retrieval":
        return <RetrievalNodeDetail state={state} />;
      case "parallel":
        return <ParallelNodeDetail state={state} />;
      case "router":
        return <RouterNodeDetail state={state} />;
      case "classifier":
        return <ClassifierNodeDetail state={state} />;
      case "tool":
      case "memory":
      default:
        return <GenericNodeDetail state={state} />;
    }
  }

  return (
    <div className="space-y-3 text-sm text-foreground">
      {/* Timing — always shown */}
      <AccordionSection title="Timing" defaultOpen>
        <KvGrid
          data={[
            ["Start", fmt(state.start_time)],
            ["End", fmt(state.end_time)],
            [
              "Latency",
              state.latency_ms != null ? `${state.latency_ms} ms` : "—",
            ],
            ...(state.sequence != null
              ? [
                  ["Sequence", `#${state.sequence}`] as [
                    string,
                    React.ReactNode,
                  ],
                ]
              : []),
          ]}
        />
      </AccordionSection>

      {/* Model, Tokens & Cost — when applicable */}
      {(state.model ||
        state.input_tokens != null ||
        state.output_tokens != null ||
        state.cost != null) && (
        <AccordionSection title={"Model, Tokens & Cost"} defaultOpen>
          <KvGrid
            data={[
              ...(state.model
                ? [
                    [
                      "Model",
                      <span key="m" className="font-mono">
                        {state.model}
                      </span>,
                    ] as [string, React.ReactNode],
                  ]
                : []),
              ...(state.input_tokens != null
                ? [
                    ["Input tokens", state.input_tokens.toLocaleString()] as [
                      string,
                      React.ReactNode,
                    ],
                  ]
                : []),
              ...(state.output_tokens != null
                ? [
                    ["Output tokens", state.output_tokens.toLocaleString()] as [
                      string,
                      React.ReactNode,
                    ],
                  ]
                : []),
              ...(state.input_tokens != null && state.output_tokens != null
                ? [
                    [
                      "Total tokens",
                      (
                        state.input_tokens + state.output_tokens
                      ).toLocaleString(),
                    ] as [string, React.ReactNode],
                  ]
                : []),
              ...(state.cost != null
                ? [
                    [
                      "Est. cost",
                      <span key="c" className="font-semibold text-emerald-600">
                        {formatCost(state.cost)}
                      </span>,
                    ] as [string, React.ReactNode],
                  ]
                : []),
            ]}
          />
        </AccordionSection>
      )}

      {/* User info — when present */}
      {(state.user_name != null || state.user_prompt != null) && (
        <AccordionSection title="User">
          <div className="space-y-1">
            {state.user_name && <KvGrid data={[["Name", state.user_name]]} />}
            {state.user_prompt && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted p-2 text-xs">
                {state.user_prompt}
              </pre>
            )}
          </div>
        </AccordionSection>
      )}

      {/* Type-specific detail */}
      {renderTypeDetail()}

      {/* Tool Calls — generic (non-retrieval nodes that have tool calls) */}
      {state.tool_calls &&
        state.tool_calls.length > 0 &&
        state.nodeType !== "retrieval" && (
          <AccordionSection title={`Tool Calls (${state.tool_calls.length})`}>
            <div className="space-y-2">
              {state.tool_calls.map((tc, i) => (
                <ToolCallEntry key={tc.id ?? i} tc={tc} />
              ))}
            </div>
          </AccordionSection>
        )}

      {/* Error — full recording (type, details, tool result, diagnostics) */}
      <ErrorRecording state={state} />
    </div>
  );
}

export function NodeDetailPanel({ state, onClose }: NodeDetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const fmt = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleTimeString() : "—";

  /** Selects the appropriate type-specific detail renderer */
  function renderTypeDetail() {
    // Boundary nodes
    if (state.id === "__request__") return <RequestNodeDetail state={state} />;
    if (state.id === "__response__") return <ResponseNodeDetail state={state} />;

    // By node type
    switch (state.nodeType) {
      case "llm":
        return <LlmNodeDetail state={state} />;
      case "retrieval":
        return <RetrievalNodeDetail state={state} />;
      case "parallel":
        return <ParallelNodeDetail state={state} />;
      case "router":
        return <RouterNodeDetail state={state} />;
      case "classifier":
        return <ClassifierNodeDetail state={state} />;
      // tool, memory, agent-harness, transform, trigger, unknown … all use the
      // findings-aware generic renderer (auto-detects findings vs JSON vs text).
      case "tool":
      case "memory":
      default:
        return <GenericNodeDetail state={state} />;
    }
  }

  return (
    <div
      ref={panelRef}
      className="absolute top-2 right-2 z-20 w-96 rounded-xl border border-border bg-card shadow-xl overflow-hidden"
      role="dialog"
      aria-label={`Node details: ${state.label}`}
    >
      {/* Header */}
      <div
        className={`px-4 py-3 flex items-center justify-between text-white ${nodeTypeColor(state.nodeType)}`}
      >
        <div>
          <div className="font-semibold text-sm truncate max-w-[260px]">
            {state.label}
          </div>
          <div className="flex items-center gap-1.5 text-xs opacity-90">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full border ${statusIndicator(state.status).dot}`}
              aria-hidden
            />
            <span className="capitalize">
              {nodeTypeLabel(state.nodeType)} · {state.status}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-full p-1 hover:bg-white/20 focus:outline-none focus:ring-1 focus:ring-white"
          aria-label="Close detail panel"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto text-sm text-foreground">
        {/* Timing — always shown */}
        <AccordionSection title="Timing" defaultOpen>
          <KvGrid
            data={[
              ["Start", fmt(state.start_time)],
              ["End", fmt(state.end_time)],
              [
                "Latency",
                state.latency_ms != null ? `${state.latency_ms} ms` : "—",
              ],
              ...(state.sequence != null
                ? [
                    ["Sequence", `#${state.sequence}`] as [
                      string,
                      React.ReactNode,
                    ],
                  ]
                : []),
            ]}
          />
        </AccordionSection>

        {/* Model, Tokens & Cost — when applicable */}
        {(state.model ||
          state.input_tokens != null ||
          state.output_tokens != null ||
          state.cost != null) && (
          <AccordionSection title={"Model, Tokens & Cost"} defaultOpen>
            <KvGrid
              data={[
                ...(state.model
                  ? [
                      [
                        "Model",
                        <span key="m" className="font-mono">
                          {state.model}
                        </span>,
                      ] as [string, React.ReactNode],
                    ]
                  : []),
                ...(state.input_tokens != null
                  ? [
                      ["Input tokens", state.input_tokens.toLocaleString()] as [
                        string,
                        React.ReactNode,
                      ],
                    ]
                  : []),
                ...(state.output_tokens != null
                  ? [
                      [
                        "Output tokens",
                        state.output_tokens.toLocaleString(),
                      ] as [string, React.ReactNode],
                    ]
                  : []),
                ...(state.input_tokens != null && state.output_tokens != null
                  ? [
                      [
                        "Total tokens",
                        (
                          state.input_tokens + state.output_tokens
                        ).toLocaleString(),
                      ] as [string, React.ReactNode],
                    ]
                  : []),
                ...(state.cost != null
                  ? [
                      [
                        "Est. cost",
                        <span
                          key="c"
                          className="font-semibold text-emerald-600"
                        >
                          {formatCost(state.cost)}
                        </span>,
                      ] as [string, React.ReactNode],
                    ]
                  : []),
              ]}
            />
          </AccordionSection>
        )}

        {/* User info — when present */}
        {(state.user_name != null || state.user_prompt != null) && (
          <AccordionSection title="User">
            <div className="space-y-1">
              {state.user_name && <KvGrid data={[["Name", state.user_name]]} />}
              {state.user_prompt && (
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted p-2 text-xs">
                  {state.user_prompt}
                </pre>
              )}
            </div>
          </AccordionSection>
        )}

        {/* Type-specific detail */}
        {renderTypeDetail()}

        {/* Tool Calls — generic (non-retrieval nodes that have tool calls) */}
        {state.tool_calls &&
          state.tool_calls.length > 0 &&
          state.nodeType !== "retrieval" && (
            <AccordionSection title={`Tool Calls (${state.tool_calls.length})`}>
              <div className="space-y-2">
                {state.tool_calls.map((tc, i) => (
                  <ToolCallEntry key={tc.id ?? i} tc={tc} />
                ))}
              </div>
            </AccordionSection>
          )}

        {/* Error — full recording (type, details, tool result, diagnostics) */}
        <ErrorRecording state={state} />
      </div>
    </div>
  );
}
