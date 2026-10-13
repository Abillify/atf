"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Header table of the request node (Req 9.3, Task 13.4). Split out of
 * `graph/NodeDetailPanel.tsx` without behavior change.
 */

import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../../../lib/ui";

// ---------------------------------------------------------------------------
// Headers table for request node
// ---------------------------------------------------------------------------

/**
 * Parses the HEADERS section text (one header per line: `key: value`) and
 * renders them as a proper table for readability.
 */
export function HeadersTable({ text }: { text: string }) {
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
            // biome-ignore lint/suspicious/noArrayIndexKey: header names can repeat (e.g. Set-Cookie); rows are replaced atomically with the request
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
