"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Parsers for the structured sections in the NodeDetailPanel (Req 9.3,
 * Task 13.4): request sections, LLM role messages, retrieval answers and
 * JSON/fence helpers. Split out of `graph/NodeDetailPanel.tsx` without
 * behavior change.
 */

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
export function parseRequestSections(
  text: string,
): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = text.split(SECTION_RE);
  // parts[0] is leading text (if any), then alternating: name, content, name, content…
  if (parts[0]?.trim()) {
    sections["Preamble"] = parts[0].trim();
  }
  for (let i = 1; i < parts.length - 1; i += 2) {
    const name = parts[i].trim();
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

export function parseLlmMessages(
  text: string,
): Array<{ role: string; content: string }> | null {
  const matches = [...text.matchAll(ROLE_LINE_RE)];
  // Require the FIRST role marker to sit at the very start of the text.
  // `coreMessagesToText` always begins with `<role>: …`, so a first match at a
  // non-zero index means we matched a role-looking word inside free text (e.g.
  // a prompt that mentions "User:" mid-sentence) — treat that as not-messages.
  if (matches.length >= 1 && matches[0].index === 0) {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < matches.length; i++) {
      const role = matches[i][1]!.toLowerCase();
      const start = matches[i].index! + matches[i][0]!.length;
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
      const role = (altMatches[i][1] ?? altMatches[i][2]!).toLowerCase();
      const start = altMatches[i].index! + altMatches[i][0]!.length;
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
export function parseRetrievalResponse(text: string): {
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
export function isJsonString(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

/** Strips a single leading/trailing markdown code fence (```json … ```). */
export function stripCodeFence(text: string): string {
  const t = text.trim();
  const fence = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/.exec(t);
  return fence ? fence[1].trim() : t;
}
