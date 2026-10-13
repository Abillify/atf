"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";

export interface TableProps
  extends React.TableHTMLAttributes<HTMLTableElement> {
  /** Accessible caption / summary */
  caption?: string;
}

export function Table({
  caption,
  className = "",
  children,
  ...props
}: TableProps): React.JSX.Element {
  return (
    // tabIndex=0 keeps the horizontally-scrollable region keyboard-accessible
    // when the table overflows (WCAG 2.1.1 — scrollable-region-focusable). No
    // role is set: a nameless role="group" only adds SR noise; the table's own
    // semantics (and optional caption) carry the meaning.
    // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must stay keyboard-reachable (WCAG 2.1.1 scrollable-region-focusable)
    <div className="w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" tabIndex={0}>
      <table
        className={["w-full caption-bottom text-sm", className].join(" ")}
        {...props}
      >
        {caption && (
          <caption className="mt-2 text-xs text-muted-foreground">
            {caption}
          </caption>
        )}
        {children}
      </table>
    </div>
  );
}

export interface TableHeadProps
  extends React.HTMLAttributes<HTMLTableSectionElement> {}

export function TableHead({
  className = "",
  children,
  ...props
}: TableHeadProps): React.JSX.Element {
  return (
    <thead
      className={["bg-muted/50 [&_tr]:border-b", className].join(" ")}
      {...props}
    >
      {children}
    </thead>
  );
}

export interface TableBodyProps
  extends React.HTMLAttributes<HTMLTableSectionElement> {}

export function TableBody({
  className = "",
  children,
  ...props
}: TableBodyProps): React.JSX.Element {
  return (
    <tbody
      className={["[&_tr:last-child]:border-0", className].join(" ")}
      {...props}
    >
      {children}
    </tbody>
  );
}

export interface TableRowProps
  extends React.HTMLAttributes<HTMLTableRowElement> {}

export function TableRow({
  className = "",
  children,
  ...props
}: TableRowProps): React.JSX.Element {
  return (
    <tr
      className={[
        "border-b border-border transition-colors hover:bg-muted/50",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </tr>
  );
}

export interface TableHeaderCellProps
  extends React.ThHTMLAttributes<HTMLTableCellElement> {}

export function TableHeaderCell({
  className = "",
  children,
  ...props
}: TableHeaderCellProps): React.JSX.Element {
  return (
    <th
      className={[
        "h-[var(--ui-cell-h)] px-3 text-left align-middle text-xs font-medium text-muted-foreground",
        "[&:has([role=checkbox])]:pr-0",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </th>
  );
}

export interface TableCellProps
  extends React.TdHTMLAttributes<HTMLTableCellElement> {}

export function TableCell({
  className = "",
  children,
  ...props
}: TableCellProps): React.JSX.Element {
  return (
    <td
      className={[
        "px-3 py-[var(--ui-cell-py)] align-middle text-sm",
        "[&:has([role=checkbox])]:pr-0",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </td>
  );
}
