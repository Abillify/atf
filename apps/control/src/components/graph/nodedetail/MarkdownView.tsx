"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Plain Markdown renderer for NodeDetailPanel output (Req 9.3,
 * Task 13.4). Split out of `graph/NodeDetailPanel.tsx` without
 * behavior change.
 */

import type React from "react";
import { safeMarkdownHref } from "../../../lib/safe-navigation";

// ---------------------------------------------------------------------------
// Lightweight markdown renderer (dependency-free)
// ---------------------------------------------------------------------------

/** Renders inline markdown: **bold**, *italic*, `code`, [text](url). */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Tokenize on the supported inline constructs.
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
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
    m = re.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Minimal markdown renderer covering the constructs LLM outputs commonly use:
 * headings, bold/italic, inline code, fenced code blocks, and bullet/numbered
 * lists. Not a full CommonMark implementation — a dependency-free best effort.
 */
export function MarkdownView({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
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
      const level = heading[1].length;
      blocks.push(
        <div
          key={key++}
          className={`font-semibold ${level <= 2 ? "text-sm" : "text-xs"} mt-2 mb-0.5 text-foreground`}
        >
          {renderInline(heading[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    // List (bullet or numbered) — consume consecutive items
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "");
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
