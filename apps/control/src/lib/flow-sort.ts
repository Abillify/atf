// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/** Alphabetical by name (then id), case-insensitive, numbers in order — the FlowPicker's order. */
export function sortFlowsByName<T extends { id: string; name: string }>(flows: readonly T[]): T[] {
  return [...flows].sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}
